import { mkdir } from 'node:fs/promises'
import { resolve } from 'node:path'
import {
  AgentRuntime,
  ArtifactStore,
  DomainStateStore,
  OpenAICompatibleAdapter,
  PermissionManager,
  ToolRegistry,
  finishTool,
  updateGoalTool,
  type AgentTool,
  type ArtifactInput,
  type AgentContext,
  type AgentToolResult,
  type ModelAdapter,
  type ToolProgressEvent,
} from '@gsms/agent-core'
import { SkillRegistry } from '@gsms/skills-core'
import { GsmsClient } from '../gsms/GsmsClient.ts'
import { createGsmsTools } from '../tools/gsmsTools.ts'
import { createMatchingTools } from '../tools/matchingTools.ts'
import { createReportTools } from '../tools/reportTools.ts'
import { createReconTool } from '../tools/reconTools.ts'
import { modelInputSchemaSchema } from '../domain/schemas.ts'
import { TurnIntentRouter, summarizeTurnPlan } from '../intent/TurnIntentRouter.ts'
import { registerSessionControlTools } from '../cli/InvestAgentSession.ts'
import { evaluateDataAvailabilityPolicy } from '../policies/dataAvailabilityPolicy.ts'
import {
  AgentSessionApiClient,
  type PersistedAgentSession,
  type PersistedConfirmation,
} from './AgentSessionApiClient.ts'
import { isExecutionPhase, WAITING_PHASES, workflowPhaseFilter } from '../workflowBoundary.ts'

export interface InvestAgentWorkerOptions {
  gsmsUrl: string
  proxyToken: string
  workspace: string
  skills: SkillRegistry
  maxTurns?: number
  sessionApi?: AgentSessionApiClient
  modelFactory?: (session: PersistedAgentSession) => ModelAdapter
  intentClassifierFactory?: (session: PersistedAgentSession) => ModelAdapter | undefined
  /** Enable run_reconnaissance sub-agent (experimental). Off by default. */
  experimentalRecon?: boolean
}

export class InvestAgentWorker {
  readonly #sessionApi: AgentSessionApiClient

  constructor(readonly options: InvestAgentWorkerOptions) {
    this.#sessionApi = options.sessionApi ?? new AgentSessionApiClient(options.gsmsUrl)
  }

  async runOnce(): Promise<boolean> {
    const queued = await this.#sessionApi.listQueuedSessions()
    const session = queued[0]
    if (!session) return false
    let claimed = false
    try {
      const claimedSession = await this.#sessionApi.checkpoint(session.id, { action: 'start' })
      claimed = true
      await this.#runClaimed(claimedSession)
    } catch (error) {
      if (claimed) {
        try {
          await this.#sessionApi.checkpoint(session.id, {
            action: 'fail',
            error: error instanceof Error ? error.message : String(error),
          })
        } catch {
          // The claimed session may already be paused or completed.
        }
      }
    }
    return true
  }

  async #runClaimed(session: PersistedAgentSession): Promise<void> {
    const messages = await this.#sessionApi.getMessages(session.id)
    const latestUser = [...messages].reverse().find(message => message.role === 'user')
    if (!latestUser) throw new Error('Queued Agent session has no user message.')
    let confirmations = await this.#sessionApi.getConfirmations(session.id)
    const artifacts = new ArtifactStore()
    if (session.artifacts.length) artifacts.createMany(session.artifacts as ArtifactInput[])
    const domainState = new DomainStateStore(session.domain_state)
    const sessionWorkspace = resolve(this.options.workspace, 'sessions', session.id)
    await mkdir(sessionWorkspace, { recursive: true })
    const gsmsClient = new GsmsClient({ baseUrl: this.options.gsmsUrl, fetch: this.#sessionApi.fetch })
    const model = this.options.modelFactory?.(session) ??
      new OpenAICompatibleAdapter({
        apiKey: this.options.proxyToken,
        model: String(session.model_config.model_id ?? 'gsms-default'),
        baseUrl: `${this.options.gsmsUrl.replace(/\/+$/, '')}/api/agent`,
      })
    const plan = await new TurnIntentRouter({
      classifierModel: this.options.intentClassifierFactory?.(session),
    }).route({
      userMessage: latestUser.content,
      domainState: session.domain_state,
      artifacts: session.artifacts,
      skillSummaries: this.options.skills.listForModel(),
    })
    await this.#sessionApi.appendEvent(session.id, 'turn.planned', summarizeTurnPlan(plan))
    if (plan.intent === 'invest-workflow' || plan.intent === 'workflow-continue') {
      prepareWorkflowState(session, domainState, artifacts)
    }
    const coreTools: AgentTool[] = [
      ...createGsmsTools(gsmsClient),
      ...createMatchingTools(),
      ...createReportTools(gsmsClient),
    ]
    const domainTools: AgentTool[] = [...coreTools]
    if (this.options.experimentalRecon) {
      domainTools.push(createReconTool(coreTools, () => model))
    }
    const directConfirmation = approvedConfirmationForDirectExecution(confirmations, domainTools)
    let approvedContinuationContext = ''
    if (directConfirmation) {
      const directResult = await this.#executeApprovedConfirmation(session, directConfirmation, domainTools, artifacts, domainState, sessionWorkspace)
      if (!directResult) return
      approvedContinuationContext = directResult
      confirmations = await this.#sessionApi.getConfirmations(session.id)
    }
    const registry = new ToolRegistry()
    let runtimeArtifacts = artifacts
    let runtimeDomainState = domainState
    let runtimeSkills = this.options.skills
    let toolFilter: InvestAgentWorkerRuntimeFilter | undefined = workflowPhaseFilter(domainTools)
    let objective: string
    if (!plan.toolPolicy.exposeGsmsTools) {
      registry.register(updateGoalTool)
      registry.register(finishTool)
      runtimeArtifacts = new ArtifactStore()
      runtimeDomainState = new DomainStateStore()
      runtimeSkills = new SkillRegistry()
      toolFilter = undefined
      objective = [
        `Current user request:\n${latestUser.content}`,
        `Top-level turn plan: ${JSON.stringify(summarizeTurnPlan(plan))}.`,
        plan.intent === 'ambiguous'
          ? plan.promptContext.clarificationQuestion ?? 'Ask one concise clarifying question. Do not assume the user wants an InVEST workflow.'
          : 'Answer directly. Do not use GSMS scene context, InVEST workflow tools, skills, artifacts, or domain state.',
      ].join('\n\n')
    } else {
      for (const tool of domainTools) registry.register(tool)
      registerSessionControlTools(registry, this.options.skills, () => domainTools.map(tool => tool.name))
      const resumedState = domainState.snapshot()
      objective = [
        `Current GSMS scene ID: ${session.scene_id}`,
        `Current user request: ${latestUser.content}`,
        `Top-level turn plan: ${JSON.stringify(summarizeTurnPlan(plan))}.`,
        `Current phase: ${String(domainState.snapshot().phase ?? 'conversation-ready')}. ` +
        `Execution phases enforce strict sequential order; matching phases allow rollback and revision.`,
        'The current user request overrides persisted planning state. If it names or implies a different InVEST model, call get_invest_model_schema for that model before matching or validation.',
        `Persisted domain state from earlier turns, adjusted for the current request boundary: ${JSON.stringify(resumedState)}`,
        approvedContinuationContext,
        buildWorkflowResumeContext(resumedState, artifacts.list(undefined, { includeSuperseded: true })),
      ].join('\n\n')
    }

    const runtime = new AgentRuntime({
      model,
      tools: registry,
      skills: runtimeSkills,
      workspace: sessionWorkspace,
      artifacts: runtimeArtifacts,
      domainState: runtimeDomainState,
      maxTurns: this.options.maxTurns ?? 30,
      toolFilter,
      eventSink: {
        emit: event =>
          this.#sessionApi.appendEvent(session.id, event.eventType, {
            run_id: event.runId,
            turn: event.turn,
            summary: event.summary,
            status: event.status,
            tool_call_id: event.toolCallId,
            duration_ms: event.durationMs,
            ...event.data,
          }).then(() => undefined),
      },
      permissions: new PermissionManager({
        approve: (tool, input, context) =>
          this.#approveOrDefer(session.id, confirmations, tool, input, context.domainState.snapshot(), context),
      }),
    })
    const result = await runtime.run(objective)
    const persistedDomainState =
      !plan.toolPolicy.exposeGsmsTools
        ? domainState.snapshot()
        : result.domainState
    const persistedArtifacts =
      !plan.toolPolicy.exposeGsmsTools
        ? artifacts.list(undefined, { includeSuperseded: true })
        : result.artifactLedger
    if (result.goal.status === 'blocked') {
      const current = await this.#sessionApi.getConfirmations(session.id)
      if (current.some(confirmation => confirmation.status === 'pending')) {
        await this.#sessionApi.checkpoint(session.id, {
          action: 'pause',
          domain_state: persistedDomainState,
          artifacts: persistedArtifacts,
        })
        return
      }
      if (!result.goal.finalSummary) {
        const issue =
          result.goal.remainingIssues.join('; ') ||
          'Agent stopped before completing the current workflow action.'
        await this.#sessionApi.checkpoint(session.id, {
          action: 'fail',
          domain_state: persistedDomainState,
          artifacts: persistedArtifacts,
          assistant_message: `Agent stopped before completing the requested action: ${issue}`,
          error: issue,
        })
        return
      }
    }
    const failureSummary = buildFailureSummary(result.goal.remainingIssues, result.diagnostics)
    if (result.goal.status === 'failed') {
      console.error(`[agent-session:${session.id}] ${failureSummary}`)
    }
    await this.#sessionApi.checkpoint(session.id, {
      action: result.goal.status === 'failed' ? 'fail' : 'complete',
      domain_state: persistedDomainState,
      artifacts: persistedArtifacts,
      assistant_message:
        result.goal.finalSummary ??
        (result.goal.status === 'failed'
          ? `failed: ${failureSummary}`
          : result.goal.progress ??
            `${result.goal.status}: ${result.goal.remainingIssues.join('; ')}`),
      error: result.goal.status === 'failed' ? failureSummary : undefined,
    })
  }

  async #approveOrDefer(
    sessionId: string,
    confirmations: PersistedConfirmation[],
    tool: AgentTool,
    input: unknown,
    state: Record<string, unknown>,
    context?: { lastConsumedConfirmationId?: string },
  ): Promise<'allow' | 'defer'> {
    const authorizationKey = permissionAuthorizationKey(tool, input, state)
    const approved = confirmations.find(
      confirmation =>
        confirmation.status === 'approved' &&
        confirmation.payload.tool === tool.name &&
        (
          confirmation.payload.authorizationKey === authorizationKey ||
          (tool.name === 'write_invest_report' && !confirmation.payload.authorizationKey) ||
          (!confirmation.payload.authorizationKey &&
            canonical(confirmation.payload.input) === canonical(input))
        ),
    )
    if (approved) {
      await this.#sessionApi.consumeConfirmation(sessionId, approved.id)
      // Bind the consumed confirmation to the context so tools that mint
      // createdBy:'user' artifacts can carry confirmationId + approvedInputHash.
      if (context) {
        context.lastConsumedConfirmationId = approved.id
      }
      return 'allow'
    }
    await this.#sessionApi.requestConfirmation(sessionId, {
      kind: tool.name,
      prompt: `Allow ${tool.risk} tool "${tool.name}"?`,
      payload: {
        tool: tool.name,
        risk: tool.risk,
        input,
        authorizationKey,
        summary: permissionPayloadSummary(tool, input, state),
        ui: permissionPayloadUi(tool, input, state),
      },
    })
    return 'defer'
  }

  async #executeApprovedConfirmation(
    session: PersistedAgentSession,
    confirmation: PersistedConfirmation,
    tools: readonly AgentTool[],
    artifacts: ArtifactStore,
    domainState: DomainStateStore,
    workspace: string,
  ): Promise<string | undefined> {
    const toolName = typeof confirmation.payload.tool === 'string' ? confirmation.payload.tool : ''
    const tool = tools.find(candidate => candidate.name === toolName)
    if (!tool) {
      throw new Error(`Approved confirmation references an unknown tool: ${toolName || '(missing)'}`)
    }
    if (tool.risk !== 'write' && tool.risk !== 'execute') {
      throw new Error(`Approved confirmation references a non-mutating tool: ${tool.name}`)
    }
    const input = confirmation.payload.input
    const expectedAuthorizationKey = permissionAuthorizationKey(tool, input, domainState.snapshot())
    const payloadAuthorizationKey = confirmation.payload.authorizationKey
    if (typeof payloadAuthorizationKey === 'string' && payloadAuthorizationKey !== expectedAuthorizationKey) {
      throw new Error(`Approved confirmation no longer matches current workflow state for ${tool.name}`)
    }

    const runId = createRunId()
    const toolCallId = `approved:${confirmation.id}:${tool.name}`
    const startedAt = Date.now()
    const context: AgentContext = {
      workspace,
      goal: {
        objective: `Execute approved confirmation ${confirmation.id} for ${tool.name}`,
        status: 'active',
        turnCount: 1,
        maxTurns: 1,
        evidence: [],
        remainingIssues: [],
        startedAt: new Date().toISOString(),
      },
      artifacts,
      domainState,
      lastConsumedConfirmationId: confirmation.id,
    }

    await this.#sessionApi.appendEvent(session.id, 'run.started', {
      run_id: runId,
      turn: 0,
      summary: `Resuming approved confirmation for ${tool.name}`,
      status: 'started',
    })
    await this.#sessionApi.consumeConfirmation(session.id, confirmation.id)
    await this.#sessionApi.appendEvent(session.id, 'tool.started', {
      run_id: runId,
      turn: 1,
      summary: `Started ${tool.name}`,
      status: 'started',
      tool_call_id: toolCallId,
      tool: tool.name,
      input: sanitizeForEvent(input),
    })

    try {
      const result = await tool.execute(input, context, (event: ToolProgressEvent) => {
        void this.#sessionApi.appendEvent(session.id, 'tool.progress', {
          run_id: runId,
          turn: 1,
          summary: event.message,
          status: 'completed',
          tool_call_id: toolCallId,
          message: event.message,
          percentage: event.percentage,
        })
      })
      await this.#applyDirectToolResult(session.id, runId, toolCallId, tool, result, context)
      await this.#sessionApi.appendEvent(session.id, 'tool.completed', {
        run_id: runId,
        turn: 1,
        summary: `Completed ${tool.name}`,
        status: 'completed',
        tool_call_id: toolCallId,
        tool: tool.name,
        duration_ms: Date.now() - startedAt,
      })
      await this.#sessionApi.appendEvent(session.id, 'run.completed', {
        run_id: runId,
        turn: 1,
        summary: `${tool.name} completed after user approval`,
        status: 'completed',
        goalStatus: 'completed',
      })
      return approvedToolFinalSummary(tool, result)
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      await this.#sessionApi.appendEvent(session.id, 'tool.failed', {
        run_id: runId,
        turn: 1,
        summary: `Failed ${tool.name}: ${message}`,
        status: 'failed',
        tool_call_id: toolCallId,
        tool: tool.name,
        duration_ms: Date.now() - startedAt,
      })
      await this.#sessionApi.appendEvent(session.id, 'run.failed', {
        run_id: runId,
        turn: 1,
        summary: message,
        status: 'failed',
        goalStatus: 'failed',
      })
      await this.#sessionApi.checkpoint(session.id, {
        action: 'fail',
        domain_state: domainState.snapshot(),
        artifacts: artifacts.list(undefined, { includeSuperseded: true }),
        assistant_message: `已确认执行 ${tool.name}，但工具执行失败：${message}`,
        error: message,
      })
      return undefined
    }
  }

  async #applyDirectToolResult(
    sessionId: string,
    runId: string,
    toolCallId: string,
    tool: AgentTool,
    result: AgentToolResult,
    context: AgentContext,
  ): Promise<void> {
    if (result.artifacts?.length) {
      for (const artifact of result.artifacts) {
        if (artifact.createdBy === 'user') {
          const hasConfirmationBinding =
            typeof artifact.metadata?.confirmationId === 'string' &&
            artifact.metadata.confirmationId.length > 0
          if (!hasConfirmationBinding) artifact.createdBy = 'tool'
        }
      }
      const created = context.artifacts.createMany(result.artifacts)
      for (const artifact of created) {
        await this.#sessionApi.appendEvent(sessionId, 'artifact.created', {
          run_id: runId,
          turn: 1,
          summary: `Created ${artifact.type} artifact`,
          status: 'completed',
          artifactId: artifact.id,
          artifactType: artifact.type,
        })
      }
    }

    if (result.statePatch) {
      const state = context.domainState.applyPatch(result.statePatch)
      await this.#sessionApi.appendEvent(sessionId, 'state.changed', {
        run_id: runId,
        turn: 1,
        summary: `Updated workflow state${typeof state.phase === 'string' ? ` to ${state.phase}` : ''}`,
        status: 'completed',
        patch: result.statePatch,
      })
    }

    if (result.diagnostics?.length) {
      for (const diagnostic of result.diagnostics) {
        await this.#sessionApi.appendEvent(sessionId, 'diagnostic.created', {
          run_id: runId,
          turn: 1,
          summary: diagnostic.message,
          status: diagnostic.severity === 'error' ? 'failed' : 'completed',
          code: diagnostic.code,
          severity: diagnostic.severity,
          tool: tool.name,
          tool_call_id: toolCallId,
        })
      }
    }
  }
}

type InvestAgentWorkerRuntimeFilter = NonNullable<ConstructorParameters<typeof AgentRuntime>[0]['toolFilter']>

function prepareWorkflowState(
  session: PersistedAgentSession,
  domainState: DomainStateStore,
  artifacts: ArtifactStore,
): void {
  const currentPhase = typeof session.domain_state.phase === 'string' ? session.domain_state.phase : ''
  // Execution phases that must persist across runs:
  //   - Active: job-running (polling), confirmed-for-execution (user confirmed, ready to run)
  //   - Terminal: results-ready-for-interpretation, report-written (execution complete,
  //     user may ask to write/revise the report)
  // Earlier execution phases (job-succeeded, outputs-inspected, results-analyzed) are
  // mid-execution and reset so the model doesn't skip steps on a fresh request.
  const PERSISTED_EXECUTION_PHASES = new Set([
    'job-running', 'confirmed-for-execution',
    'results-ready-for-interpretation', 'report-written',
  ])
  const shouldResetPhase =
    !WAITING_PHASES.has(currentPhase) &&
    (!isExecutionPhase(currentPhase) || !PERSISTED_EXECUTION_PHASES.has(currentPhase))
  if (!shouldResetPhase) return

  // Preserve matchingContextId if scene hasn't changed — allows "继续" / "验证刚才的绑定" to work
  const previousSceneId = typeof session.domain_state.sceneId === 'string' ? session.domain_state.sceneId : undefined
  if (previousSceneId && previousSceneId !== session.scene_id) {
    // Scene changed — full reset
    domainState.applyPatch({ phase: 'discovering-data', matchingContextId: null, slots: null, bindingStatus: null })
  } else {
    // Same scene — preserve context, just reset phase for re-discovery
    domainState.applyPatch({ phase: 'discovering-data' })
  }
  // Clear stale execution artifacts from previous completed run so the model
  // does not skip execution steps when the user requests a fresh run.
  // Matching artifacts (schema, candidates, bindings, data cards) are preserved.
  const staleExecutionTypes = [
    // job lifecycle
    'model-job', 'job-status',
    // validation & confirmation
    'validation-report', 'confirmation-record',
    // results & interpretation
    'job-output-inventory', 'result-analysis', 'result-interpretation-context',
    'invest-report', 'raster-statistics', 'job-execution-log', 'output-inventory',
  ]
  for (const type of staleExecutionTypes) {
    for (const a of artifacts.list(type)) {
      artifacts.delete(a.id)
    }
  }
}

function permissionAuthorizationKey(
  tool: AgentTool,
  input: unknown,
  state: Record<string, unknown>,
): string {
  if (tool.name === 'write_invest_report') {
    return canonical({
      tool: tool.name,
      sceneId: state.sceneId,
      jobId: state.jobId,
    })
  }
  return canonical({ tool: tool.name, input })
}

function permissionPayloadSummary(
  tool: AgentTool,
  input: unknown,
  state: Record<string, unknown>,
): Record<string, unknown> | undefined {
  return tool.policy?.confirmation?.summary?.(input, state)
}

function permissionPayloadUi(
  tool: AgentTool,
  input: unknown,
  state: Record<string, unknown>,
): Record<string, unknown> | undefined {
  return tool.policy?.confirmation?.ui?.(input, state)
}

function buildFailureSummary(
  remainingIssues: readonly string[],
  diagnostics: readonly { code: string; message: string; severity: string }[],
): string {
  const issues = remainingIssues.join('; ') || 'Agent run failed without a reported issue.'
  const diagnosticCodes = diagnostics
    .filter(diagnostic => diagnostic.severity === 'error')
    .map(diagnostic => diagnostic.code)
  return diagnosticCodes.length ? `${issues} [diagnostics: ${diagnosticCodes.join(', ')}]` : issues
}

export function buildWorkflowResumeContext(
  state: Record<string, unknown>,
  artifacts: readonly unknown[],
): string {
  const rows = artifacts.filter(isArtifact)
  const counts = rows.reduce<Record<string, number>>((result, artifact) => {
    result[artifact.type] = (result[artifact.type] ?? 0) + 1
    return result
  }, {})
  const modelId = typeof state.modelId === 'string' ? state.modelId : 'none'
  const phase = typeof state.phase === 'string' ? state.phase : 'unknown'
  const matchingContextId =
    typeof state.matchingContextId === 'string' ? state.matchingContextId : undefined
  const currentRows = rows.filter(
    artifact =>
      (!artifact.metadata?.modelId || artifact.metadata.modelId === modelId) &&
      (!artifact.metadata?.matchingContextId ||
        artifact.metadata.matchingContextId === matchingContextId),
  )
  const currentCounts = currentRows.reduce<Record<string, number>>((result, artifact) => {
    result[artifact.type] = (result[artifact.type] ?? 0) + 1
    return result
  }, {})
  const currentArtifacts = currentRows
    .slice(-12)
    .map(artifact => ({
      type: artifact.type,
      modelId: artifact.metadata?.modelId,
      slot: artifact.metadata?.slot,
      id: artifact.id,
    }))
  const directive = workflowDirective(state, phase, modelId, currentCounts, currentRows)
  return [
    `Persisted workflow evidence: ${JSON.stringify({ phase, modelId, counts, currentCounts, currentArtifacts })}`,
    `Required continuation: ${directive}`,
    'Do not repeat completed workflow stages unless the user explicitly changes the model, bindings, or parameters.',
    'Do not stop with a progress-only update. Use finish with a factual final summary, or invoke the next required tool.',
  ].join('\n')
}

function workflowDirective(
  state: Record<string, unknown>,
  phase: string,
  modelId: string,
  counts: Record<string, number>,
  artifacts: readonly ReturnType<typeof normalizeArtifact>[],
): string {
  if (phase === 'ready-for-validation' && counts['binding-report']) {
    return `A ${modelId} Binding Report already exists. Call validate_binding_report directly; do not reload schemas, retrieve candidates, or submit another report.`
  }
  if (phase === 'awaiting-user-confirmation') {
    return 'Validation already passed. Call confirm_validation_snapshot once to request explicit user confirmation; do not validate again.'
  }
  if (phase === 'confirmed-for-execution') {
    return 'The validation snapshot is confirmed for execution. Call execute_validated_snapshot immediately to start the InVEST model run. Do not load skills, inspect outputs, or call any other tool.'
  }
  if (phase === 'job-running') {
    return 'Refresh the current job with get_invest_job_status. Do not invent alternate status or output tools.'
  }
  if (phase === 'job-succeeded') {
    return 'The current job succeeded. Call inspect_invest_job_outputs once; do not invent output or workspace tools.'
  }
  if (phase === 'outputs-inspected') {
    return 'The current output inventory is persisted. Call analyze_invest_results directly to request deterministic raster statistics. Do not inspect outputs again or invent log/read tools.'
  }
  if (phase === 'results-analyzed') {
    return 'The result analysis is persisted. Call interpret_invest_results directly; it reads the execution log internally. Do not inspect outputs again, do not analyze results again, and do not invent log/read tools.'
  }
  if (phase === 'results-ready-for-interpretation') {
    return 'The output inventory and interpretation context are persisted. Call write_invest_report directly; do not inspect outputs, read logs, or rebuild interpretation.'
  }
  if (phase === 'report-written') {
    return 'A previous report exists. If the current user asks for real result analysis or a new report, call get_invest_job_status and rebuild the interpretation chain from deterministic outputs; otherwise finish with the persisted report path.'
  }
  if (phase === 'matching-slots' && counts['candidate-set']) {
    const schemaArtifact = [...artifacts].reverse().find(artifact => artifact?.type === 'model-input-schema')
    const schema = schemaArtifact ? modelInputSchemaSchema.safeParse(schemaArtifact.data) : undefined
    const candidateSlots = new Set(
      artifacts
        .filter(artifact => artifact?.type === 'candidate-set')
        .map(artifact => artifact?.metadata?.slot),
    )
    const missing = schema?.success
      ? schema.data.slots.filter(slot => slot.required && !candidateSlots.has(slot.name)).map(slot => slot.name)
      : []
    if (missing.length) {
      return `Retrieve candidates for these required slots before finalizing: ${missing.join(', ')}. Prefer one call to retrieve_required_input_candidates for model "${modelId}" instead of parallel per-slot calls.`
    }
    return 'Reuse the persisted candidate sets and relation checks, then call finalize_data_matching. Do not construct a Binding Report manually.'
  }
  if (phase === 'sufficiency-assessed') {
    return 'Sufficiency assessment is complete. Call finish with the report findings.'
  }
  if (phase === 'validation-failed') {
    return 'Explain the persisted validation errors and stop unless the user changed bindings or parameters.'
  }
  if (phase === 'discovering-data' || phase === 'matching-slots') {
    const hasSchema = counts['model-input-schema']
    const hasDataCards = counts['gsms-scene-data-cards']
    const hasCandidates = counts['candidate-set']
    const hasSufficiencyReport = counts['sufficiency-report']
    const hasBindingReport = counts['binding-report']
    const dataAvailability = evaluateDataAvailabilityPolicy(
      state,
      artifacts.filter((artifact): artifact is NonNullable<typeof artifact> => Boolean(artifact)),
    )

    if (dataAvailability.instruction) return dataAvailability.instruction
    if (hasSufficiencyReport || hasBindingReport) {
      return 'Assessment or matching complete. Call finish with the findings.'
    }
    if (hasSchema && hasDataCards && hasCandidates) {
      return 'Schema, data cards, and candidates are loaded. If assessing sufficiency, call finalize_sufficiency_assessment. If matching, call finalize_data_matching.'
    }
    if (hasSchema && hasDataCards) {
      return `Schema and data cards loaded. Call retrieve_required_input_candidates once for model "${modelId}" to check all required slots. Do not invent *_asset_id slot names and do not call retrieve_input_candidates in parallel.`
    }
    if (hasDataCards) {
      return 'Data cards loaded. Call get_invest_model_schema for the target model, then retrieve_required_input_candidates once.'
    }
    if (hasSchema) {
      return 'Schema loaded. Call list_scene_data_cards to load scene data, then retrieve_required_input_candidates once.'
    }
    return 'Start by calling list_scene_data_cards and/or get_invest_model_schema to gather evidence.'
  }
  return 'If the user question is answered by available evidence, call finish. Otherwise continue gathering evidence.'
}

function isArtifact(value: unknown): value is {
  id?: string
  type: string
  data?: unknown
  metadata?: Record<string, unknown>
} {
  return Boolean(value && typeof value === 'object' && typeof (value as { type?: unknown }).type === 'string')
}

function normalizeArtifact(value: unknown) {
  return isArtifact(value) ? value : undefined
}

export function approvedConfirmationForDirectExecution(
  confirmations: readonly PersistedConfirmation[],
  tools: readonly AgentTool[],
): PersistedConfirmation | undefined {
  const writeToolNames = new Set(
    tools
      .filter(tool =>
        tool.policy?.confirmation?.approvedAction === 'execute-approved-input' &&
        (tool.risk === 'write' || tool.risk === 'execute'),
      )
      .map(tool => tool.name),
  )
  return confirmations.find(confirmation =>
    confirmation.status === 'approved' &&
    typeof confirmation.payload.tool === 'string' &&
    writeToolNames.has(confirmation.payload.tool) &&
    Object.prototype.hasOwnProperty.call(confirmation.payload, 'input'),
  )
}

function approvedToolFinalSummary(tool: AgentTool, result: AgentToolResult): string {
  const policyMessage = tool.policy?.confirmation?.successMessage?.(result)
  if (policyMessage) return policyMessage
  return result.content || `${tool.name} completed after user approval.`
}

function createRunId(): string {
  return `run_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`
}

function sanitizeForEvent(value: unknown, depth = 0): unknown {
  if (depth > 3) return '[truncated]'
  if (Array.isArray(value)) return value.slice(0, 20).map(item => sanitizeForEvent(item, depth + 1))
  if (value && typeof value === 'object') {
    return Object.fromEntries(
      Object.entries(value as Record<string, unknown>)
        .slice(0, 30)
        .map(([key, item]) => [
          key,
          key.toLowerCase().includes('token') || key.toLowerCase().includes('secret')
            ? '[redacted]'
            : sanitizeForEvent(item, depth + 1),
        ]),
    )
  }
  if (typeof value === 'string' && value.length > 1000) return `${value.slice(0, 1000)}…`
  return value
}

function canonical(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`
  if (value && typeof value === 'object') {
    return `{${Object.entries(value as Record<string, unknown>)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([key, item]) => `${JSON.stringify(key)}:${canonical(item)}`)
      .join(',')}}`
  }
  return JSON.stringify(value)
}
