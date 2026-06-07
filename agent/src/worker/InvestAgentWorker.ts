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
import { registerSessionControlTools } from '../cli/InvestAgentSession.ts'
import {
  AgentSessionApiClient,
  type PersistedAgentSession,
  type PersistedConfirmation,
} from './AgentSessionApiClient.ts'

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
    const sessionWorkspace = resolve(this.options.workspace, 'sessions', session.id)
    await mkdir(sessionWorkspace, { recursive: true })
    const registry = new ToolRegistry()
    const domainTools: AgentTool[] = [
      ...createGsmsTools(new GsmsClient({ baseUrl: this.options.gsmsUrl })),
      ...createMatchingTools(),
      ...createReportTools(),
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
      permissions: new PermissionManager({
        approve: (tool, input) => this.#approveOrDefer(session.id, confirmations, tool, input),
      }),
    })
    const result = await runtime.run(
      [
        `Current GSMS scene ID: ${session.scene_id}`,
        `Current user request: ${latestUser.content}`,
        'The current user request overrides persisted planning state. If it names or implies a different InVEST model, call get_invest_model_schema for that model before matching or validation.',
        `Persisted domain state from earlier turns: ${JSON.stringify(session.domain_state)}`,
        buildWorkflowResumeContext(session.domain_state, session.artifacts),
      ].join('\n\n'),
    )
    if (result.goal.status === 'blocked') {
      const current = await this.#sessionApi.getConfirmations(session.id)
      if (current.some(confirmation => confirmation.status === 'pending')) return
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
    await this.#sessionApi.checkpoint(session.id, {
      action: result.goal.status === 'failed' ? 'fail' : 'complete',
      domain_state: result.domainState,
      artifacts: result.artifacts,
      assistant_message:
        result.goal.finalSummary ??
        result.goal.progress ??
        `${result.goal.status}: ${result.goal.remainingIssues.join('; ')}`,
      error: result.goal.status === 'failed' ? result.goal.remainingIssues.join('; ') : undefined,
    })
  }

  async #approveOrDefer(
    sessionId: string,
    confirmations: PersistedConfirmation[],
    tool: AgentTool,
    input: unknown,
  ): Promise<'allow' | 'defer'> {
    const approved = confirmations.find(
      confirmation =>
        confirmation.status === 'approved' &&
        confirmation.payload.tool === tool.name &&
        canonical(confirmation.payload.input) === canonical(input),
    )
    if (approved) {
      await this.#sessionApi.consumeConfirmation(sessionId, approved.id)
      return 'allow'
    }
    await this.#sessionApi.requestConfirmation(sessionId, {
      kind: tool.name,
      prompt: `Allow ${tool.risk} tool "${tool.name}"?`,
      payload: { tool: tool.name, risk: tool.risk, input },
    })
    return 'defer'
  }
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
  const currentRows = rows.filter(
    artifact => !artifact.metadata?.modelId || artifact.metadata.modelId === modelId,
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
  const directive = workflowDirective(phase, modelId, currentCounts)
  return [
    `Persisted workflow evidence: ${JSON.stringify({ phase, modelId, counts, currentCounts, currentArtifacts })}`,
    `Required continuation: ${directive}`,
    'Do not repeat completed workflow stages unless the user explicitly changes the model, bindings, or parameters.',
    'Do not stop with a progress-only update. Use finish with a factual final summary, or invoke the next required tool.',
  ].join('\n')
}

function workflowDirective(phase: string, modelId: string, counts: Record<string, number>): string {
  if (phase === 'ready-for-validation' && counts['binding-report']) {
    return `A ${modelId} Binding Report already exists. Call validate_binding_report directly; do not reload schemas, retrieve candidates, or submit another report.`
  }
  if (phase === 'awaiting-user-confirmation') {
    return 'Validation already passed. Call confirm_validation_snapshot once to request explicit user confirmation; do not validate again.'
  }
  if (phase === 'confirmed-for-execution') {
    return 'The exact validation snapshot is confirmed. Execute it only if execution is part of the current user request.'
  }
  if (phase === 'matching-slots' && counts['candidate-set']) {
    return 'Reuse the persisted candidate sets and relation checks, then submit the Binding Report. Do not restart discovery.'
  }
  if (phase === 'validation-failed') {
    return 'Explain the persisted validation errors and stop unless the user changed bindings or parameters.'
  }
  return 'Continue from the persisted phase and reuse existing evidence where applicable.'
}

function isArtifact(value: unknown): value is {
  id?: string
  type: string
  metadata?: Record<string, unknown>
} {
  return Boolean(value && typeof value === 'object' && typeof (value as { type?: unknown }).type === 'string')
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
