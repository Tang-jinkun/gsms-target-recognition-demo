/** @type {import('next').NextConfig} */
const nextConfig = {
  async rewrites() {
    const backendUrl = process.env.INTERNAL_API_URL
    if (!backendUrl) return []
    return [
      // Proxy every /api/* path to the backend EXCEPT the SSE stream endpoint.
      // rewrites() returns afterFiles rewrites, which Next checks BEFORE dynamic
      // routes — so a plain `/api/:path*` catch-all would shadow our dynamic API
      // route pages/api/agent/sessions/[id]/stream.ts and proxy SSE through the
      // rewrite (which buffers text/event-stream → no live updates). The negative
      // lookahead excludes that one path so it falls through to the API route,
      // which forwards each chunk unbuffered for true real-time streaming.
      {
        source: '/api/:path((?!agent/sessions/[^/]+/stream).+)',
        destination: `${backendUrl}/api/:path`,
      },
      {
        source: '/health',
        destination: `${backendUrl}/health`,
      },
    ]
  },
}

module.exports = nextConfig
