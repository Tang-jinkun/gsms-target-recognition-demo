export interface GsmsClientOptions {
  baseUrl: string
  fetch?: typeof globalThis.fetch
}

export class GsmsClient {
  readonly #baseUrl: string
  readonly #fetch: typeof globalThis.fetch

  constructor(options: GsmsClientOptions) {
    this.#baseUrl = options.baseUrl.replace(/\/+$/, '')
    this.#fetch = options.fetch ?? globalThis.fetch
  }

  listModels(): Promise<unknown> {
    return this.#request('/api/models')
  }

  getModelSchema(modelId: string): Promise<unknown> {
    return this.#request(`/api/models/${encodeURIComponent(modelId)}/schema`)
  }

  listSceneDataCards(sceneId: string): Promise<unknown> {
    return this.#request(`/api/scenes/${encodeURIComponent(sceneId)}/data-cards`)
  }

  checkRelation(input: {
    kind: string
    leftAssetId: string
    rightAssetId: string
    field?: string
  }): Promise<unknown> {
    return this.#request('/api/matching/check-relation', {
      method: 'POST',
      body: JSON.stringify({
        kind: input.kind,
        left_asset_id: input.leftAssetId,
        right_asset_id: input.rightAssetId,
        field: input.field ?? 'lucode',
      }),
    })
  }

  validateBindings(input: {
    modelId: string
    sceneId: string
    bindingReport: unknown
    parameters?: Record<string, unknown>
  }): Promise<unknown> {
    return this.#request(`/api/models/${encodeURIComponent(input.modelId)}/validate-bindings`, {
      method: 'POST',
      body: JSON.stringify({
        scene_id: input.sceneId,
        binding_report: input.bindingReport,
        parameters: input.parameters ?? {},
      }),
    })
  }

  confirmValidationSnapshot(snapshotId: string, confirmed: boolean): Promise<unknown> {
    return this.#request(`/api/validation-snapshots/${encodeURIComponent(snapshotId)}/confirm`, {
      method: 'POST',
      body: JSON.stringify({ confirmed }),
    })
  }

  createJobFromValidationSnapshot(snapshotId: string, runMode = 'real'): Promise<unknown> {
    return this.#request(`/api/validation-snapshots/${encodeURIComponent(snapshotId)}/jobs`, {
      method: 'POST',
      body: JSON.stringify({ run_mode: runMode }),
    })
  }

  getSceneJob(sceneId: string, jobId: string): Promise<unknown> {
    return this.#request(
      `/api/scenes/${encodeURIComponent(sceneId)}/jobs/${encodeURIComponent(jobId)}`,
    )
  }

  listSceneJobOutputs(sceneId: string, jobId: string): Promise<unknown> {
    return this.#request(
      `/api/scenes/${encodeURIComponent(sceneId)}/jobs/${encodeURIComponent(jobId)}/outputs`,
    )
  }

  getSceneJobLogs(sceneId: string, jobId: string): Promise<string> {
    return this.#requestText(
      `/api/scenes/${encodeURIComponent(sceneId)}/jobs/${encodeURIComponent(jobId)}/logs`,
    )
  }

  analyzeInvestResults(sceneId: string, jobId: string): Promise<unknown> {
    return this.#request(
      `/api/scenes/${encodeURIComponent(sceneId)}/jobs/${encodeURIComponent(jobId)}/analyze-results`,
      { method: 'POST' },
    )
  }

  getResultAnalysis(sceneId: string, jobId: string): Promise<unknown> {
    return this.#request(
      `/api/scenes/${encodeURIComponent(sceneId)}/jobs/${encodeURIComponent(jobId)}/result-analysis`,
    )
  }

  publishGeneratedFile(input: {
    sceneId: string
    jobId: string
    artifactType: string
    name: string
    content: string
    fileFormat: string
    note?: string
  }): Promise<unknown> {
    return this.#request('/api/data/files/generated', {
      method: 'POST',
      body: JSON.stringify({
        sceneId: input.sceneId,
        jobId: input.jobId,
        artifactType: input.artifactType,
        name: input.name,
        content: input.content,
        fileFormat: input.fileFormat,
        note: input.note ?? '',
      }),
    })
  }

  async #request(path: string, init?: RequestInit): Promise<unknown> {
    const response = await this.#fetch(`${this.#baseUrl}${path}`, {
      ...init,
      headers: { 'content-type': 'application/json', ...init?.headers },
    })
    if (!response.ok) {
      const detail = await response.text()
      throw new Error(`GSMS API ${response.status}: ${detail}`)
    }
    return response.json()
  }

  async #requestText(path: string): Promise<string> {
    const response = await this.#fetch(`${this.#baseUrl}${path}`)
    if (!response.ok) {
      const detail = await response.text()
      throw new Error(`GSMS API ${response.status}: ${detail}`)
    }
    return response.text()
  }
}
