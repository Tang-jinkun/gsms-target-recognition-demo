import { api, apiUrl, fmtBytes } from '../apiClient'

export type HubType = 'raster' | 'vector' | 'table' | 'text' | 'other'

export type HubFile = {
  id: string
  name: string
  type: HubType
  size: string
  fmt: string
  created: string
  modified: string
  enc: string
  note: string
  spatial?: { crs: string; geom: string | number; feat: string | number; extent: string; res: string; bands: string | number } | null
}

export type HubDir = { name: string; label: string; count: number; type?: HubType }

type BackendHubFile = Omit<HubFile, 'type' | 'size'> & {
  type: HubType
  size?: number | string
}

const DIRS: Array<Omit<HubDir, 'count'>> = [
  { name: 'all', label: 'all' },
  { name: 'raster', label: 'raster', type: 'raster' },
  { name: 'vector', label: 'vector', type: 'vector' },
  { name: 'table', label: 'table', type: 'table' },
  { name: 'text', label: 'text', type: 'text' },
  { name: 'other', label: 'other', type: 'other' },
]

export const TYPE_ICON: Record<string, string> = { raster: 'image', vector: 'map', table: 'table', text: 'file-text', other: 'file', folder: 'folder' }
export const TYPE_LABEL: Record<string, string> = { raster: '栅格', vector: '矢量', table: '表格', text: '文本', other: '其他', folder: '文件夹' }

function normalize(file: BackendHubFile): HubFile {
  return {
    ...file,
    type: file.type || 'other',
    size: typeof file.size === 'number' ? fmtBytes(file.size) : file.size || '—',
    fmt: file.fmt || 'unknown',
    created: file.created || '—',
    modified: file.modified || '—',
    enc: file.enc || '—',
    note: file.note || '',
    spatial: file.spatial || null,
  }
}

export function buildTree(files: HubFile[]): HubDir[] {
  return DIRS.map(dir => ({
    ...dir,
    count: dir.type ? files.filter(file => file.type === dir.type).length : files.length,
  }))
}

export function filesForDir(files: HubFile[], dirName: string): HubFile[] {
  const dir = DIRS.find(item => item.name === dirName)
  if (!dir?.type) return files
  return files.filter(file => file.type === dir.type)
}

export const dataHubRepo = {
  async list(q = ''): Promise<HubFile[]> {
    const data = await api.get<BackendHubFile[]>(`/api/data/files${q ? `?q=${encodeURIComponent(q)}` : ''}`)
    return Array.isArray(data) ? data.map(normalize) : []
  },

  async upload(file: File): Promise<HubFile> {
    const body = new FormData()
    body.append('file', file)
    const res = await fetch(apiUrl('/api/data/files/upload'), { method: 'POST', body })
    if (!res.ok) throw new Error(`/api/data/files/upload -> ${res.status}`)
    return normalize(await res.json())
  },

  async remove(id: string): Promise<void> {
    await api.del(`/api/data/files/${encodeURIComponent(id)}`)
  },
}
