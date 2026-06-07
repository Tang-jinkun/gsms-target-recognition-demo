export interface PersistedAgentSession {
  id: string
  scene_id: string
  status: string
  domain_state: Record<string, unknown>
  artifacts: unknown[]
  model_config: Record<string, unknown>
}

export interface PersistedAgentMessage {
  id: string
  role: string
  content: string
}

export interface PersistedConfirmation {
  id: string
  status: string
  payload: Record<string, unknown>
}

export interface PersistedAgentEvent {
  id: number
  session_id: string
  type: string
  data: Record<string, unknown>
  created_at?: string
}

export class AgentSessionApiClient {
  readonly #baseUrl: string

  constructor(
    baseUrl: string,
    readonly fetch: typeof globalThis.fetch = globalThis.fetch,
  ) {
    this.#baseUrl = baseUrl.replace(/\/+$/, '')
  }

  listQueuedSessions(): Promise<PersistedAgentSession[]> {
    return this.#json('/api/agent/sessions?status=queued&limit=20')
  }

  getMessages(sessionId: string): Promise<PersistedAgentMessage[]> {
    return this.#json(`/api/agent/sessions/${encodeURIComponent(sessionId)}/messages`)
  }

  getConfirmations(sessionId: string): Promise<PersistedConfirmation[]> {
    return this.#json(`/api/agent/sessions/${encodeURIComponent(sessionId)}/confirmations`)
  }

  checkpoint(
    sessionId: string,
    payload: {
      action: string
      domain_state?: Record<string, unknown>
      artifacts?: unknown[]
      assistant_message?: string
      error?: string
    },
  ): Promise<PersistedAgentSession> {
    return this.#json(`/api/agent/sessions/${encodeURIComponent(sessionId)}/checkpoint`, {
      method: 'POST',
      body: JSON.stringify(payload),
    })
  }

  appendEvent(
    sessionId: string,
    eventType: string,
    data: Record<string, unknown>,
  ): Promise<PersistedAgentEvent> {
    return this.#json(`/api/agent/sessions/${encodeURIComponent(sessionId)}/events`, {
      method: 'POST',
      body: JSON.stringify({ event_type: eventType, data }),
    })
  }

  requestConfirmation(
    sessionId: string,
    payload: { kind: string; prompt: string; payload: Record<string, unknown> },
  ): Promise<PersistedConfirmation> {
    return this.#json(`/api/agent/sessions/${encodeURIComponent(sessionId)}/confirmations`, {
      method: 'POST',
      body: JSON.stringify(payload),
    })
  }

  consumeConfirmation(sessionId: string, confirmationId: string): Promise<PersistedConfirmation> {
    return this.#json(
      `/api/agent/sessions/${encodeURIComponent(sessionId)}/confirmations/${encodeURIComponent(confirmationId)}/consume`,
      { method: 'POST', body: '{}' },
    )
  }

  async #json<T>(path: string, init?: RequestInit): Promise<T> {
    const response = await this.fetch(`${this.#baseUrl}${path}`, {
      ...init,
      headers: { 'content-type': 'application/json', ...init?.headers },
    })
    if (!response.ok) throw new Error(`GSMS Agent Session API ${response.status}: ${await response.text()}`)
    return response.json() as Promise<T>
  }
}
