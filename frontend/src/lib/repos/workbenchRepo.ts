import { api, apiUrl, type AssetType } from '../apiClient'

/** Real backend (FastAPI) — assets / models / jobs. */

export type BackendAsset = {
  id: string
  name: string
  type: string // backend: raster|table|geojson|document|unknown
  size?: number
  format?: string
  crs?: string | null
  bounds?: number[] | null
  bounds_wgs84?: number[] | null
  preview_url?: string
}

export type WbFile = {
  id: string
  name: string
  type: AssetType // ui category
  size?: number
  previewUrl?: string
  geojsonUrl?: string
  bounds?: number[] | null
}

export type WbModel = {
  id: string
  name: string
  status?: string
  description?: string
  inputs?: Array<{ id: string; label: string; kind?: string; asset_type?: string; required?: boolean }>
}

const BACKEND_TO_UI: Record<string, AssetType> = {
  raster: 'raster',
  geojson: 'vector',
  table: 'table',
  document: 'text',
  unknown: 'other',
}

/**
 * Scene isolation hook: the workbench is scoped to /workbench/[sceneId]. We pass
 * the scene id to scene-scoped backend calls (assets, asset content, job create)
 * as `scene_id` so the backend can filter by scene once it implements isolation.
 * The current backend ignores the extra param/body field, so this is a forward-
 * compatible no-op today. Model registry & per-job status are global → not scoped.
 */
function withScene(path: string, sceneId?: string) {
  if (!sceneId) return path
  return `${path}${path.includes('?') ? '&' : '?'}scene_id=${encodeURIComponent(sceneId)}`
}

export const workbenchRepo = {
  async listFiles(sceneId?: string): Promise<WbFile[]> {
    const data = await api.get<BackendAsset[]>(withScene('/api/assets', sceneId))
    if (!Array.isArray(data)) return []
    return data.map(a => ({
      id: a.id,
      name: a.name,
      type: BACKEND_TO_UI[a.type] ?? 'other',
      size: a.size,
      previewUrl: a.preview_url ? apiUrl(withScene(a.preview_url, sceneId)) : undefined,
      geojsonUrl: a.type === 'geojson' ? apiUrl(withScene(`/api/assets/${encodeURIComponent(a.id)}/geojson`, sceneId)) : undefined,
      bounds: a.bounds_wgs84 ?? a.bounds,
    }))
  },

  async listModels(): Promise<WbModel[]> {
    const data = await api.get<WbModel[]>('/api/models')
    return Array.isArray(data) ? data : []
  },

  getSchema: (modelId: string) => api.get<WbModel>(`/api/models/${modelId}/schema`),

  checkInputs: (modelId: string, inputs: Record<string, unknown>, sceneId?: string) =>
    api.post<{ status: string; errors: string[]; warnings: string[]; info: string[] }>(
      `/api/models/${modelId}/check-inputs`,
      { inputs, scene_id: sceneId },
    ),

  createJob: (modelId: string, inputs: Record<string, unknown>, runMode: 'auto' | 'real' = 'auto', sceneId?: string) =>
    api.post<{ job_id: string; status: string }>('/api/jobs', { modelId, run_mode: runMode, inputs, scene_id: sceneId }),

  getJob: (jobId: string) => api.get<{ job_id: string; status: string }>(`/api/jobs/${jobId}`),
  getLogs: (jobId: string) => api.text(`/api/jobs/${jobId}/logs`),
  getOutputs: (jobId: string) =>
    api.get<Array<{ name: string; type: string; preview_url?: string; download_url?: string }>>(`/api/jobs/${jobId}/outputs`),
}
