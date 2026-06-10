export type ToolRisk = 'control' | 'read' | 'write' | 'execute'

export interface ToolCall {
  id: string
  name: string
  input: unknown
}

export type AgentMessage =
  | { role: 'system' | 'user'; content: string; hidden?: boolean }
  | { role: 'assistant'; content: string; toolCalls?: ToolCall[] }
  | { role: 'tool'; content: string; toolCallId: string; isError?: boolean }

export interface ModelToolDefinition {
  name: string
  description: string
  inputSchema: Record<string, unknown>
}

export interface ModelRequest {
  messages: readonly AgentMessage[]
  tools: readonly ModelToolDefinition[]
  signal?: AbortSignal
}

export interface ModelResponse {
  content: string
  toolCalls?: ToolCall[]
}

// ── Streaming ────────────────────────────────────────────────────────────────

export type StreamChunk =
  | { type: 'text'; text: string }
  | { type: 'tool_call_start'; id: string; name: string }
  | { type: 'tool_call_delta'; id: string; argumentsDelta: string }
  | { type: 'done' }

export interface ModelAdapter {
  complete(request: ModelRequest): Promise<ModelResponse>
  /** Optional streaming variant. Falls back to complete() if not implemented. */
  completeStreaming?(request: ModelRequest): AsyncIterable<StreamChunk>
}

// ── Tool Progress ────────────────────────────────────────────────────────────

export interface ToolProgressEvent {
  message: string
  percentage?: number
}

export interface GoalState {
  objective: string
  status: 'active' | 'completed' | 'blocked' | 'failed'
  turnCount: number
  maxTurns: number
  progress?: string
  nextStep?: string
  finalSummary?: string
  evidence: string[]
  remainingIssues: string[]
  startedAt: string
}

export interface SkillScope {
  name: string
  allowedTools: Set<string>
  activatedAtTurn: number
}

export type ArtifactCreator = 'user' | 'agent' | 'tool'

export interface Artifact<T = unknown> {
  id: string
  type: string
  version: number
  createdAt: string
  createdBy: ArtifactCreator
  data: T
  metadata?: Record<string, unknown>
  // ── Evidence Ledger ──
  /**
   * Stable identity of the logical entity this artifact represents. Two
   * artifacts with the same logicalKey are versions of the same thing — a
   * newer one supersedes the older, regardless of which turn produced it.
   * Defaults to `id` when not set. scopeKey is NOT part of identity.
   */
  logicalKey?: string
  /** Scope key "turn:N" or "turn:N:skill:name". Provenance only. Injected by runtime. */
  scopeKey?: string
  /** ID of the artifact this one supersedes (version chain). */
  supersedes?: string
  /** True when a newer artifact has superseded this one. */
  superseded?: boolean
}

export interface ArtifactInput<T = unknown> {
  id?: string
  type: string
  version?: number
  createdAt?: string
  createdBy: ArtifactCreator
  data: T
  metadata?: Record<string, unknown>
  /** See Artifact.logicalKey. Defaults to `id` when omitted. */
  logicalKey?: string
  scopeKey?: string
  supersedes?: string
  /**
   * Set on rehydration (restoring a persisted ledger): preserve the
   * artifact's superseded flag verbatim instead of recomputing supersedes.
   */
  superseded?: boolean
}

export type DomainState = Record<string, unknown>
export type DomainStatePatch = Record<string, unknown>

export interface Diagnostic {
  code: string
  message: string
  severity: 'info' | 'warning' | 'error'
  relatedArtifactIds?: string[]
}

export interface AgentActionEvent {
  runId: string
  turn: number
  eventType:
    | 'run.started'
    | 'model.responded'
    | 'model.streaming'
    | 'tool.started'
    | 'tool.progress'
    | 'tool.completed'
    | 'tool.deferred'
    | 'tool.failed'
    | 'state.changed'
    | 'artifact.created'
    | 'diagnostic.created'
    | 'loop.detected'
    | 'run.paused'
    | 'run.completed'
    | 'run.failed'
  summary: string
  status: 'started' | 'waiting' | 'completed' | 'failed'
  toolCallId?: string
  data?: Record<string, unknown>
  durationMs?: number
  timestamp: string
}

export interface AgentEventSink {
  emit(event: AgentActionEvent): Promise<void>
}

export interface ArtifactRepository {
  create<T>(input: ArtifactInput<T>): Artifact<T>
  createMany(inputs: readonly ArtifactInput[]): Artifact[]
  get<T = unknown>(id: string): Artifact<T> | undefined
  list(type?: string, options?: { scopeKey?: string; includeSuperseded?: boolean }): Artifact[]
  /** Set by the runtime at the start of each turn for scope-aware writes. */
  currentScopeKey: string
  /** @deprecated Use scope-aware supersession. */
  delete(id: string): boolean
}

export interface DomainStateRepository {
  snapshot<T extends DomainState = DomainState>(): T
  applyPatch(patch: DomainStatePatch): DomainState
}

export interface AgentContext {
  workspace: string
  goal: GoalState
  artifacts: ArtifactRepository
  domainState: DomainStateRepository
  skillScope?: SkillScope
  signal?: AbortSignal
  /** Set by the worker when it consumes a user confirmation; read by tools
   *  that mint user-authored artifacts (confirmation-record, disambiguation)
   *  so the artifact carries a cryptographic binding to the specific
   *  confirmation, not just the tool's risk profile. */
  lastConsumedConfirmationId?: string
}

export interface AgentToolResult {
  content: string
  artifacts?: ArtifactInput[]
  statePatch?: DomainStatePatch
  diagnostics?: Diagnostic[]
  hiddenMessages?: AgentMessage[]
  activateSkill?: { name: string; allowedTools: string[] }
  goalUpdate?: Partial<
    Pick<
      GoalState,
      | 'status'
      | 'progress'
      | 'nextStep'
      | 'finalSummary'
      | 'evidence'
      | 'remainingIssues'
    >
  >
}

export interface AgentTool {
  name: string
  description: string
  inputSchema: Record<string, unknown>
  risk: ToolRisk
  /**
   * When true, this tool may execute concurrently with other safe tools.
   * Must ONLY be true when the tool has zero side-effects: no state patches,
   * no artifact writes, no backend mutations.  Defaults to false.
   * Do NOT derive this from `risk` — a 'read' tool may still mutate domain state.
   */
  isConcurrencySafe?: boolean
  /** If set and result.content exceeds this many bytes, the full content is
   *  persisted as a `tool-result` artifact and only a compact pointer is
   *  returned to the model. Keeps the context window lean for large outputs. */
  persistResultAboveBytes?: number
  execute(input: unknown, context: AgentContext, onProgress?: (event: ToolProgressEvent) => void): Promise<AgentToolResult>
}

export interface TranscriptEvent {
  timestamp: string
  type:
    | 'message'
    | 'tool_call'
    | 'tool_result'
    | 'permission'
    | 'goal'
    | 'artifact'
    | 'state'
    | 'diagnostic'
  data: unknown
}

export interface AgentRunResult {
  goal: GoalState
  messages: AgentMessage[]
  transcript: TranscriptEvent[]
  /** Active evidence set (superseded artifacts excluded). For gates/reports. */
  artifacts: Artifact[]
  /**
   * Full append-only ledger including superseded artifacts. Persisted at
   * checkpoint so the version history survives a resume; rehydrated via
   * ArtifactStore.createMany (entries carry scopeKey → rehydration path).
   */
  artifactLedger: Artifact[]
  domainState: DomainState
  diagnostics: Diagnostic[]
}
