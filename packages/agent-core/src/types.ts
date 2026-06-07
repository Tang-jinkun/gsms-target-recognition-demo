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

export interface ModelAdapter {
  complete(request: ModelRequest): Promise<ModelResponse>
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
}

export interface ArtifactInput<T = unknown> {
  id?: string
  type: string
  version?: number
  createdAt?: string
  createdBy: ArtifactCreator
  data: T
  metadata?: Record<string, unknown>
}

export type DomainState = Record<string, unknown>
export type DomainStatePatch = Record<string, unknown>

export interface Diagnostic {
  code: string
  message: string
  severity: 'info' | 'warning' | 'error'
  relatedArtifactIds?: string[]
}

export interface ArtifactRepository {
  create<T>(input: ArtifactInput<T>): Artifact<T>
  createMany(inputs: readonly ArtifactInput[]): Artifact[]
  get<T = unknown>(id: string): Artifact<T> | undefined
  list(type?: string): Artifact[]
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
  execute(input: unknown, context: AgentContext): Promise<AgentToolResult>
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
  artifacts: Artifact[]
  domainState: DomainState
  diagnostics: Diagnostic[]
}
