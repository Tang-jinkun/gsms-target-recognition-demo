import { api } from '../apiClient'

export type Scene = {
  id: string
  name: string
  desc: string
  region: string
  note: string
  updated: string
}

type SceneInput = Omit<Scene, 'id' | 'updated'>

export const scenesRepo = {
  async list(): Promise<Scene[]> {
    const data = await api.get<Scene[]>('/api/scenes')
    return Array.isArray(data) ? data : []
  },

  async get(id: string): Promise<Scene | undefined> {
    try {
      return await api.get<Scene>(`/api/scenes/${encodeURIComponent(id)}`)
    } catch {
      return undefined
    }
  },

  async create(input: SceneInput): Promise<Scene> {
    return api.post<Scene>('/api/scenes', {
      name: input.name,
      description: input.desc,
      study_area: input.region,
      note: input.note,
    })
  },

  async update(id: string, patch: Partial<SceneInput>): Promise<Scene> {
    const current = await this.get(id)
    const next = {
      name: patch.name ?? current?.name ?? '',
      description: patch.desc ?? current?.desc ?? '',
      study_area: patch.region ?? current?.region ?? '',
      note: patch.note ?? current?.note ?? '',
    }
    return api.put<Scene>(`/api/scenes/${encodeURIComponent(id)}`, next)
  },

  async remove(id: string): Promise<void> {
    await api.del(`/api/scenes/${encodeURIComponent(id)}`)
  },

  async nameExists(name: string, exceptId?: string): Promise<boolean> {
    const list = await this.list()
    return list.some(s => s.name.toLowerCase() === name.toLowerCase() && s.id !== exceptId)
  },
}
