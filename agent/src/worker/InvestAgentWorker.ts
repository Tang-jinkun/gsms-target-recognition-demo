import { mkdir } from 'node:fs/promises'
import { resolve } from 'node:path'
import {
  AgentRuntime,
  ArtifactStore,
  DomainStateStore,
  OpenAICompatibleAdapter,
  PermissionManager,
  ToolRegistry,
  type AgentTool,
  type ArtifactInput,
  type ModelAdapter,
} from '@gsms/agent-core'
import { SkillRegistry } from '@gsms/skills-core'
import { GsmsClient } from '../gsms/GsmsClient.ts'
import { createGsmsTools } from '../tools/gsmsTools.ts'
import { createMatchingTools } from '../tools/matchingTools.ts'
import { createReportTools } from '../tools/reportTools.ts'
import { modelInputSchemaSchema } from '../domain/schemas.ts'
import { registerSessionControlTools } from '../cli/InvestAgentSession.ts'
import {
  AgentSessionApiClient,
  type PersistedAgentSession,
  type PersistedConfirmation,
} from './AgentSessionApiClient.ts'
import { isExecutionPhase, workflowPhaseFilter } from '../workflowBoundary.ts'

export interface InvestAgentWorkerOptions {
  gsmsUrl: string
  proxyToken: string
  workspace: string
  skills: SkillRegistry
  maxTurns?: number
  sessionApi?: AgentSessionApiClient
  modelFactory?: (session: PersistedAgentSession) => ModelAdapter
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
    const confirmations = await this.#sessionApi.getConfirmations(session.id)
    const artifacts = new ArtifactStore()
    if (session.artifacts.length) artifacts.createMany(session.artifacts as ArtifactInput[])
    const domainState = new DomainStateStore(session.domain_state)
    const currentPhase = typeof session.domain_state.phase === 'string' ? session.domain_state.phase : ''
    // Phases that must persist across runs (user interaction in progress)
    const WAITING_PHASES = new Set([
      'awaiting-user-confirmation',
      'validation-failed',
      'confirmation-rejected',
      'ready-for-validation',
    ])
    if (!isExecutionPhase(currentPhase) && !WAITING_PHASES.has(currentPhase)) {
      // Preserve matchingContextId if scene hasn't changed — allows "继续" / "验证刚才的绑定" to work
      const previousSceneId = typeof session.domain_state.sceneId === 'string' ? session.domain_state.sceneId : undefined
      if (previousSceneId && previousSceneId !== session.scene_id) {
        // Scene changed — full reset
        domainState.applyPatch({ phase: 'discovering-data', matchingContextId: null, slots: null, bindingStatus: null })
      } else {
        // Same scene — preserve context, just reset phase for re-discovery
        domainState.applyPatch({ phase: 'discovering-data' })
      }
    }
    const sessionWorkspace = resolve(this.options.workspace, 'sessions', session.id)
    await mkdir(sessionWorkspace, { recursive: true })
    const registry = new ToolRegistry()
    const gsmsClient = new GsmsClient({ baseUrl: this.options.gsmsUrl })
    const domainTools: AgentTool[] = [
      ...createGsmsTools(gsmsClient),
      ...createMatchingTools(),
      ...createReportTools(gsmsClient),
    ]
    for (const tool of domainTools) registry.register(tool)
    registerSessionControlTools(registry, this.options.skills, () => domainTools.map(tool => tool.name))

    const runtime = new AgentRuntime({
      model:
        this.options.modelFactory?.(session) ??
        new OpenAICompatibleAdapter({
          apiKey: this.options.proxyToken,
          model: String(session.model_config.model_id ?? 'gsms-default'),
          baseUrl: `${this.options.gsmsUrl.replace(/\/+$/, '')}/api/agent`,
        }),
      tools: registry,
      skills: this.options.skills,
      workspace: sessionWorkspace,
      artifacts,
      domainState,
      maxTurns: this.options.maxTurns ?? 30,
      toolFilter: workflowPhaseFilter(),
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
          this.#approveOrDefer(session.id, confirmations, tool, input, context.domainState.snapshot()),
      }),
    })
    const resumedState = domainState.snapshot()
    const result = await runtime.run(
      [
        `Current GSMS scene ID: ${session.scene_id}`,
        `Current user request: ${latestUser.content}`,
        `Current phase: ${String(domainState.snapshot().phase ?? 'conversation-ready')}. ` +
        `Execution phases enforce strict sequential order; matching phases allow rollback and revision.`,
        'The current user request overrides persisted planning state. If it names or implies a different InVEST model, call get_invest_model_schema for that model before matching or validation.',
        `Persisted domain state from earlier turns, adjusted for the current request boundary: ${JSON.stringify(resumedState)}`,
        buildWorkflowResumeContext(resumedState, session.artifacts),
      ].join('\n\n'),
    )
    if (result.goal.status === 'blocked') {
      const current = await this.#sessionApi.getConfirmations(session.id)
      if (current.some(confirmation => confirmation.status === 'pending')) {
        await this.#sessionApi.checkpoint(session.id, {
          action: 'pause',
          domain_state: result.domainState,
          artifacts: result.artifacts,
        })
        return
      }
      if (!result.goal.finalSummary) {
        const issue =
          result.goal.remainingIssues.join('; ') ||
          'Agent stopped before completing the current workflow action.'
        await this.#sessionApi.checkpoint(session.id, {
          action: 'fail',
          domain_state: result.domainState,
          artifacts: result.artifacts,
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
      domain_state: result.domainState,
      artifacts: result.artifacts,
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
      return 'allow'
    }
    await this.#sessionApi.requestConfirmation(sessionId, {
      kind: tool.name,
      prompt: `Allow ${tool.risk} tool "${tool.name}"?`,
      payload: { tool: tool.name, risk: tool.risk, input, authorizationKey },
    })
    return 'defer'
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
  const directive = workflowDirective(phase, modelId, currentCounts, currentRows)
  return [
    `Persisted workflow evidence: ${JSON.stringify({ phase, modelId, counts, currentCounts, currentArtifacts })}`,
    `Required continuation: ${directive}`,
    'Do not repeat completed workflow stages unless the user explicitly changes the model, bindings, or parameters.',
    'Do not stop with a progress-only update. Use finish with a factual final summary, or invoke the next required tool.',
  ].join('\n')
}

function workflowDirective(
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
      return `Retrieve candidates for these required slots before finalizing: ${missing.join(', ')}.`
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

    if (hasSufficiencyReport || hasBindingReport) {
      return 'Assessment or matching complete. Call finish with the findings.'
    }
    if (hasSchema && hasDataCards && hasCandidates) {
      return 'Schema, data cards, and candidates are loaded. If assessing sufficiency, call finalize_sufficiency_assessment. If matching, call finalize_data_matching.'
    }
    if (hasSchema && hasDataCards) {
      return 'Schema and data cards loaded. Call retrieve_input_candidates for required slots to check data availability.'
    }
    if (hasDataCards) {
      return 'Data cards loaded. Call get_invest_model_schema for the target model, then retrieve_input_candidates.'
    }
    if (hasSchema) {
      return 'Schema loaded. Call list_scene_data_cards to load scene data, then retrieve_input_candidates.'
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
