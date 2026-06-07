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

export const agentSessionsRepo = {
  list: (sceneId: string) =>
    api.get<AgentSession[]>(`/api/agent/sessions?scene_id=${encodeURIComponent(sceneId)}&limit=20`),

  create: (sceneId: string, title?: string) =>
    api.post<AgentSession>('/api/agent/sessions', { scene_id: sceneId, title: title ?? '' }),

  get: (sessionId: string) =>
    api.get<AgentSession>(`/api/agent/sessions/${encodeURIComponent(sessionId)}`),

  messages: (sessionId: string) =>
    api.get<AgentMessage[]>(`/api/agent/sessions/${encodeURIComponent(sessionId)}/messages`),

  send: (sessionId: string, content: string) =>
    api.post<{ session: AgentSession; message: AgentMessage }>(
      `/api/agent/sessions/${encodeURIComponent(sessionId)}/messages`,
      { content },
    ),

  confirmations: (sessionId: string) =>
    api.get<AgentConfirmation[]>(`/api/agent/sessions/${encodeURIComponent(sessionId)}/confirmations`),

  resolveConfirmation: (sessionId: string, confirmationId: string, approved: boolean) =>
    api.post<{ session: AgentSession; confirmation: AgentConfirmation }>(
      `/api/agent/sessions/${encodeURIComponent(sessionId)}/confirmations/${encodeURIComponent(confirmationId)}`,
      { approved },
    ),
}
