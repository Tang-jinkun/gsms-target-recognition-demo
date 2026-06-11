import { api } from '../apiClient'

export type AgentSessionStatus = 'idle' | 'queued' | 'running' | 'awaiting_confirmation' | 'failed'

export type AgentSession = {
  id: string
  scene_id: string
  title: string
  status: AgentSessionStatus
  last_error?: string | null
  pending_confirmation_id?: string | null
  updated_at?: string | null
  domain_state?: Record<string, unknown>
  artifacts?: Array<{
    id: string
    type: string
    data: unknown
    metadata?: Record<string, unknown>
    superseded?: boolean
  }>
}

export type AgentMessage = {
  id: string
  session_id: string
  role: 'user' | 'assistant'
  content: string
  metadata: Record<string, unknown>
  created_at?: string | null
}

export type AgentConfirmation = {
  id: string
  session_id: string
  kind: string
  status: 'pending' | 'approved' | 'rejected' | 'consumed'
  prompt: string
  payload: Record<string, unknown>
}

export type AgentEvent = {
  id: number
  session_id: string
  type: string
  data: {
    run_id?: string
    turn?: number
    summary?: string
    status?: 'started' | 'waiting' | 'completed' | 'failed'
    duration_ms?: number
    text?: string
    message?: string
    percentage?: number
    tool?: string
    tool_call_id?: string
    [key: string]: unknown
  }
  created_at?: string | null
}

export const agentSessionsRepo = {
  list: (sceneId: string) =>
    api.get<AgentSession[]>(`/api/agent/sessions?scene_id=${encodeURIComponent(sceneId)}&limit=20`),

  create: (sceneId: string, title?: string) =>
    api.post<AgentSession>('/api/agent/sessions', { scene_id: sceneId, title: title ?? '' }),

  get: (sessionId: string) =>
    api.get<AgentSession>(`/api/agent/sessions/${encodeURIComponent(sessionId)}`),

  messages: (sessionId: string) =>
    api.get<AgentMessage[]>(`/api/agent/sessions/${encodeURIComponent(sessionId)}/messages`),

  events: (sessionId: string, afterId = 0) =>
    api.get<AgentEvent[]>(
      `/api/agent/sessions/${encodeURIComponent(sessionId)}/events?after_id=${afterId}&limit=500`,
    ),

  send: (sessionId: string, content: string) =>
    api.post<{ session: AgentSession; message: AgentMessage }>(
      `/api/agent/sessions/${encodeURIComponent(sessionId)}/messages`,
      { content },
    ),

  confirmations: (sessionId: string) =>
    api.get<AgentConfirmation[]>(`/api/agent/sessions/${encodeURIComponent(sessionId)}/confirmations`),

  resolveConfirmation: (
    sessionId: string,
    confirmationId: string,
    approved: boolean,
    payloadOverride?: Record<string, unknown>,
  ) =>
    api.post<{ session: AgentSession; confirmation: AgentConfirmation }>(
      `/api/agent/sessions/${encodeURIComponent(sessionId)}/confirmations/${encodeURIComponent(confirmationId)}`,
      payloadOverride ? { approved, payload_override: payloadOverride } : { approved },
    ),
}
