export interface GsmsScene {
  id: string
  name: string
  desc?: string
  region?: string
}

export class GsmsBootstrapClient {
  constructor(
    readonly baseUrl: string,
    readonly fetch: typeof globalThis.fetch = globalThis.fetch,
  ) {}

  async health(): Promise<void> {
    let response: Response
    try {
      response = await this.fetch(`${this.baseUrl}/health`)
    } catch (error) {
      throw new Error(
        `GSMS backend is not reachable at ${this.baseUrl}: ${
          error instanceof Error ? error.message : String(error)
        }`,
      )
    }
    if (!response.ok) throw new Error(`GSMS health check failed: HTTP ${response.status}`)
    const body = (await response.json()) as { status?: unknown }
    if (body.status !== 'ok') throw new Error('GSMS health check did not return status=ok')
  }

  async listScenes(): Promise<GsmsScene[]> {
    const response = await this.fetch(`${this.baseUrl}/api/scenes`)
    if (!response.ok) throw new Error(`Could not list GSMS scenes: HTTP ${response.status}`)
    const body = (await response.json()) as unknown
    if (!Array.isArray(body)) throw new Error('GSMS scenes response is not an array')
    return body.flatMap(item => {
      if (!item || typeof item !== 'object') return []
      const source = item as Record<string, unknown>
      if (typeof source.id !== 'string' || typeof source.name !== 'string') return []
      return [{
        id: source.id,
        name: source.name,
        desc: typeof source.desc === 'string' ? source.desc : undefined,
        region: typeof source.region === 'string' ? source.region : undefined,
      }]
    })
  }
}
