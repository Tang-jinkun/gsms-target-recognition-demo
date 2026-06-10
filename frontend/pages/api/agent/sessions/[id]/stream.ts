import type { NextApiRequest, NextApiResponse } from 'next'

// SSE proxy: Next.js rewrites() buffer text/event-stream responses (they wait
// for the upstream to close, which an infinite SSE generator never does), so a
// rewrite-proxied EventSource receives nothing until the connection drops. This
// API route instead connects to the backend itself and forwards each chunk the
// moment it arrives, with buffering disabled — giving the browser true real-time
// events while keeping the backend on the internal network (not exposed).
export const config = {
  api: {
    // Don't let Next parse/buffer the request or response body.
    bodyParser: false,
    responseLimit: false,
    externalResolver: true,
  },
}

const BACKEND = process.env.INTERNAL_API_URL || 'http://backend:8000'

export default async function handler(req: NextApiRequest, res: NextApiResponse) {
  const { id } = req.query
  if (typeof id !== 'string') {
    res.status(400).end('Missing session id')
    return
  }

  const lastEventId = req.headers['last-event-id']
  const qs = typeof req.query.last_event_id === 'string' ? req.query.last_event_id : ''
  const search = qs ? `?last_event_id=${encodeURIComponent(qs)}` : ''
  const target = `${BACKEND}/api/agent/sessions/${encodeURIComponent(id)}/stream${search}`

  // Abort the upstream fetch when the browser disconnects.
  const controller = new AbortController()
  req.on('close', () => controller.abort())

  let upstream: Response
  try {
    upstream = await fetch(target, {
      headers: {
        accept: 'text/event-stream',
        ...(typeof lastEventId === 'string' ? { 'last-event-id': lastEventId } : {}),
      },
      signal: controller.signal,
    })
  } catch {
    res.status(502).end('SSE upstream unavailable')
    return
  }

  if (!upstream.ok || !upstream.body) {
    res.status(upstream.status || 502).end('SSE upstream error')
    return
  }

  // SSE response headers. x-accel-buffering:no disables proxy buffering;
  // flushHeaders sends them immediately so the browser opens the stream.
  res.writeHead(200, {
    'content-type': 'text/event-stream; charset=utf-8',
    'cache-control': 'no-cache, no-transform',
    connection: 'keep-alive',
    'x-accel-buffering': 'no',
  })
  res.flushHeaders?.()

  const reader = upstream.body.getReader()
  try {
    for (;;) {
      const { done, value } = await reader.read()
      if (done) break
      if (value) {
        res.write(value)
        // Flush past any Node/compression buffering so each SSE frame is sent live.
        ;(res as unknown as { flush?: () => void }).flush?.()
      }
    }
  } catch {
    // Upstream aborted or errored — fall through to cleanup.
  } finally {
    reader.releaseLock()
    res.end()
  }
}
