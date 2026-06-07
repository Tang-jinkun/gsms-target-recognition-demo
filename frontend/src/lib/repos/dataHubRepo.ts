import { api, apiUrl, fmtBytes } from '../apiClient'

export type HubType = 'raster' | 'vector' | 'table' | 'text' | 'other'

export type HubFile = {
  id: string
  folderId?: string | null
  folderName?: string | null
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
export type HubFolder = { id: string; name: string; count: number }

type BackendHubFile = Omit<HubFile, 'type' | 'size'> & {
  folder_id?: string | null
  folder_name?: string | null
  type: HubType
  size?: number | string
}

export const TYPE_ICON: Record<string, string> = { raster: 'image', vector: 'map', table: 'table', text: 'file-text', other: 'file', folder: 'folder' }
export const TYPE_LABEL: Record<string, string> = { raster: '栅格', vector: '矢量', table: '表格', text: '文本', other: '其他', folder: '文件夹' }

function normalize(file: BackendHubFile): HubFile {
  return {
    ...file,
    folderId: file.folder_id ?? file.folderId,
    folderName: file.folder_name ?? file.folderName,
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
  const counts = files.reduce((map, file) => {
    const key = file.folderId || 'uncategorized'
    map.set(key, (map.get(key) || 0) + 1)
    return map
  }, new Map<string, number>())
  const folders = Array.from(files.reduce((map, file) => {
    const id = file.folderId || 'uncategorized'
    if (!map.has(id)) map.set(id, file.folderName || '未分类')
    return map
  }, new Map<string, string>()))
  return folders.map(([id, name]) => ({ name: id, label: name, count: counts.get(id) || 0 }))
}

export function filesForDir(files: HubFile[], dirName: string): HubFile[] {
  if (dirName === 'all') return files
  return files.filter(file => (file.folderId || 'uncategorized') === dirName)
}

export const dataHubRepo = {
  downloadUrl(id: string): string {
    return apiUrl(`/api/data/files/${encodeURIComponent(id)}/download`)
  },

  async listFolders(): Promise<HubFolder[]> {
    const data = await api.get<Array<{ id: string; name: string; count: number }>>('/api/data/folders')
    return Array.isArray(data) ? data : []
  },

  async list(q = ''): Promise<HubFile[]> {
    const data = await api.get<BackendHubFile[]>(`/api/data/files${q ? `?q=${encodeURIComponent(q)}` : ''}`)
    return Array.isArray(data) ? data.map(normalize) : []
  },

  async upload(file: File, folderId?: string): Promise<HubFile> {
    const body = new FormData()
    body.append('file', file)
    const qs = folderId ? `?folder_id=${encodeURIComponent(folderId)}` : ''
    const res = await fetch(apiUrl(`/api/data/files/upload${qs}`), { method: 'POST', body })
    if (!res.ok) throw new Error(`/api/data/files/upload -> ${res.status}`)
    return normalize(await res.json())
  },

  async createFolder(name: string): Promise<HubFolder> {
    return api.post<HubFolder>('/api/data/folders', { name })
  },

  async renameFolder(id: string, name: string): Promise<void> {
    await api.put(`/api/data/folders/${encodeURIComponent(id)}`, { name })
  },

  async deleteFolder(id: string): Promise<void> {
    await api.del(`/api/data/folders/${encodeURIComponent(id)}`)
  },

  async moveFiles(fileIds: string[], folderId: string): Promise<void> {
    await api.post('/api/data/files/move', { fileIds, folderId })
  },

  async deleteFiles(fileIds: string[]): Promise<void> {
    await api.post('/api/data/files/delete', { fileIds })
  },

  async remove(id: string): Promise<void> {
    await api.del(`/api/data/files/${encodeURIComponent(id)}`)
  },
}
