import React from 'react'
import { apiUrl } from './apiClient'
import type { AgentEvent } from './repos/agentSessionsRepo'

/** Event types the backend pushes over SSE that the workbench cares about. */
const SSE_EVENT_TYPES = [
  'model.streaming', 'tool.started', 'tool.progress',
  'tool.completed', 'tool.failed', 'artifact.created',
  'diagnostic.created', 'session.status', 'confirmation.requested',
  'confirmation.resolved', 'message.queued', 'message.created',
  'session.created', 'session.checkpoint', 'run.started',
  'run.completed', 'run.failed', 'model.responded',
] as const

type UseAgentEventSourceOptions = {
  sessionId: string | null
  onEvent: (event: AgentEvent) => void
  /** Called when SSE is unsupported or repeatedly fails — caller falls back to polling. */
  onError?: () => void
  enabled?: boolean
  /**
   * Event id already consumed before this connection opens. The stream resumes
   * strictly after it, so events folded during the initial priming fetch are not
   * re-delivered (which would duplicate streaming text). Read once at connect.
   */
  initialCursor?: number
}

/**
 * Subscribe to the backend SSE event stream for an agent session. Each frame is
 * delivered to `onEvent`. EventSource auto-reconnects (resuming via Last-Event-ID
 * on the server side); repeated failures trigger `onError` so the caller can fall
 * back to HTTP polling. Returns nothing — the effect owns the connection lifecycle.
 */
export function useAgentEventSource({
  sessionId,
  onEvent,
  onError,
  enabled = true,
  initialCursor = 0,
}: UseAgentEventSourceOptions): void {
  // Keep callbacks in refs so the effect doesn't re-subscribe on every render.
  const onEventRef = React.useRef(onEvent)
  const onErrorRef = React.useRef(onError)
  const initialCursorRef = React.useRef(initialCursor)
  React.useEffect(() => { onEventRef.current = onEvent }, [onEvent])
  React.useEffect(() => { onErrorRef.current = onError }, [onError])
  React.useEffect(() => { initialCursorRef.current = initialCursor }, [initialCursor])

  React.useEffect(() => {
    if (!sessionId || !enabled) return
    if (typeof EventSource === 'undefined') {
      onErrorRef.current?.()
      return
    }

    const cursor = initialCursorRef.current
    const base = apiUrl(`/api/agent/sessions/${encodeURIComponent(sessionId)}/stream`)
    const url = cursor > 0 ? `${base}?last_event_id=${cursor}` : base
    const es = new EventSource(url)
    // After this many consecutive errors with no successful message, give up
    // and let the caller fall back to polling.
    let consecutiveErrors = 0

    const handle = (ev: MessageEvent) => {
      consecutiveErrors = 0
      let data: AgentEvent['data']
      try {
        data = JSON.parse(ev.data)
      } catch {
        return
      }
      onEventRef.current({
        id: Number(ev.lastEventId) || 0,
        session_id: sessionId,
        type: ev.type === 'message' ? 'message' : ev.type,
        data,
      })
    }

    for (const type of SSE_EVENT_TYPES) es.addEventListener(type, handle as EventListener)
    es.onmessage = handle

    es.onerror = () => {
      // EventSource reconnects automatically; only bail after sustained failure.
      consecutiveErrors += 1
      if (consecutiveErrors >= 3) {
        es.close()
        onErrorRef.current?.()
      }
    }

    return () => { es.close() }
  }, [sessionId, enabled])
}
