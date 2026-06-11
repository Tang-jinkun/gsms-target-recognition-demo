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
  type ArtifactRepository,
  type ModelAdapter,
} from '@gsms/agent-core'
import { SkillRegistry } from '@gsms/skills-core'
import { GsmsClient } from '../gsms/GsmsClient.ts'
import { createGsmsTools } from '../tools/gsmsTools.ts'
import { createMatchingTools } from '../tools/matchingTools.ts'
import { createReportTools } from '../tools/reportTools.ts'
import { createReconTool } from '../tools/reconTools.ts'
import { createTargetRecognitionTools } from '../tools/targetRecognitionTools.ts'
import { TurnIntentRouter, summarizeTurnPlan } from '../intent/TurnIntentRouter.ts'
import { registerSessionControlTools } from '../cli/InvestAgentSession.ts'
import { workflowRunStartTransition } from '../policies/workflowPolicy.ts'
import {
  AgentSessionApiClient,
  type PersistedAgentSession,
  type PersistedConfirmation,
} from './AgentSessionApiClient.ts'
import {
  approvedConfirmationForDirectExecution,
  canonical,
  executeApprovedConfirmation,
  permissionAuthorizationKey,
} from './ApprovedConfirmationExecutor.ts'
import {
  permissionPayloadSummary,
  permissionPayloadUi,
} from './ConfirmationPayload.ts'
import { buildWorkflowResumeContext } from './WorkflowResumeContext.ts'
import {
  buildTurnBoundary,
  workflowPhaseFilter,
  workflowTurnBoundaryTransition,
} from '../workflowBoundary.ts'
import { enforceWorkflowPhaseTransitions } from '../workflowToolGuards.ts'

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
    const turnBoundary = buildTurnBoundary(plan.workflow?.action)
    if (plan.intent === 'invest-workflow' || plan.intent === 'target-workflow' || plan.intent === 'workflow-continue') {
      prepareWorkflowState(session, domainState, artifacts, turnBoundary)
    }
    const coreTools: AgentTool[] = [
      ...createGsmsTools(gsmsClient),
      ...createMatchingTools(),
      ...createReportTools(gsmsClient),
      ...createTargetRecognitionTools(gsmsClient),
    ]
    const domainTools: AgentTool[] = coreTools.map(enforceWorkflowPhaseTransitions)
    if (this.options.experimentalRecon) {
      domainTools.push(enforceWorkflowPhaseTransitions(createReconTool(coreTools, () => model)))
    }
    const directConfirmation = approvedConfirmationForDirectExecution(confirmations, domainTools, turnBoundary)
    let approvedContinuationContext = ''
    if (directConfirmation) {
      const directResult = await executeApprovedConfirmation({
        session,
        confirmation: directConfirmation,
        tools: domainTools,
        artifacts,
        domainState,
        workspace: sessionWorkspace,
        sessionApi: this.#sessionApi,
      })
      if (!directResult) return
      approvedContinuationContext = directResult
      confirmations = await this.#sessionApi.getConfirmations(session.id)
    }
    const forceWorkflowRuntime = approvedContinuationContext.length > 0
    const registry = new ToolRegistry()
    let runtimeArtifacts = artifacts
    let runtimeDomainState = domainState
    let runtimeSkills = this.options.skills
    let toolFilter: InvestAgentWorkerRuntimeFilter | undefined = workflowPhaseFilter(domainTools, turnBoundary)
    let objective: string
    if (!plan.toolPolicy.exposeGsmsTools && !forceWorkflowRuntime) {
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
        turnBoundary
          ? `Hard turn boundary: ${JSON.stringify(turnBoundary)}. Tools outside this boundary are not visible and cannot satisfy this turn.`
          : '',
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
      !plan.toolPolicy.exposeGsmsTools && !forceWorkflowRuntime
        ? domainState.snapshot()
        : result.domainState
    const persistedArtifacts =
      !plan.toolPolicy.exposeGsmsTools && !forceWorkflowRuntime
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
    context?: { artifacts?: ArtifactRepository; lastConsumedConfirmationId?: string },
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
        ui: permissionPayloadUi(tool, input, state, context?.artifacts),
      },
    })
    return 'defer'
  }

}

type InvestAgentWorkerRuntimeFilter = NonNullable<ConstructorParameters<typeof AgentRuntime>[0]['toolFilter']>

function prepareWorkflowState(
  session: PersistedAgentSession,
  domainState: DomainStateStore,
  artifacts: ArtifactStore,
  turnBoundary?: ReturnType<typeof buildTurnBoundary>,
): void {
  const transition = workflowRunStartTransition({
    phase: session.domain_state.phase,
    previousSceneId: typeof session.domain_state.sceneId === 'string' ? session.domain_state.sceneId : undefined,
    currentSceneId: session.scene_id,
  })
  if (transition.shouldReset) {
    if (transition.statePatch) domainState.applyPatch(transition.statePatch)

    for (const type of transition.staleArtifactTypes) {
      for (const a of artifacts.list(type)) {
        artifacts.delete(a.id)
      }
    }
  }

  const boundaryTransition = workflowTurnBoundaryTransition(turnBoundary, domainState.snapshot())
  if (boundaryTransition.statePatch) domainState.applyPatch(boundaryTransition.statePatch)
  for (const type of boundaryTransition.staleArtifactTypes) {
    for (const a of artifacts.list(type)) {
      artifacts.delete(a.id)
    }
  }
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
