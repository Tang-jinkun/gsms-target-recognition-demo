import { api } from '../apiClient'

export type Skill = { id: string; name: string; desc: string; updated: string }
export type SkillFileNode = {
  name: string
  type: 'file' | 'dir'
  kind?: 'md' | 'code' | 'json' | 'bin'
  size?: string
  modified?: string
  children?: SkillFileNode[]
}
export type SkillContent =
  | { kind: 'md'; html: string }
  | { kind: 'code' | 'json'; code: string }
  | { kind: 'bin'; size: string }

export const skillsRepo = {
  async list(): Promise<Skill[]> {
    const data = await api.get<Skill[]>('/api/skills')
    return Array.isArray(data) ? data : []
  },

  async get(id: string): Promise<Skill | undefined> {
    try {
      return await api.get<Skill>(`/api/skills/${encodeURIComponent(id)}`)
    } catch {
      return undefined
    }
  },

  async nameExists(name: string, exceptId?: string): Promise<boolean> {
    const list = await this.list()
    return list.some(s => s.name.toLowerCase() === name.toLowerCase() && s.id !== exceptId)
  },

  async treeFor(id: string): Promise<SkillFileNode[]> {
    const data = await api.get<SkillFileNode[]>(`/api/skills/${encodeURIComponent(id)}/tree`)
    return Array.isArray(data) ? data : []
  },

  async contentFor(id: string, fileName: string): Promise<SkillContent | undefined> {
    try {
      return await api.get<SkillContent>(`/api/skills/${encodeURIComponent(id)}/content?path=${encodeURIComponent(fileName)}`)
    } catch {
      return undefined
    }
  },

  async create(input: { name: string; desc: string }): Promise<Skill> {
    return api.post<Skill>('/api/skills', input)
  },

  async update(id: string, patch: { name: string; desc: string }): Promise<Skill> {
    return api.put<Skill>(`/api/skills/${encodeURIComponent(id)}`, patch)
  },

  async remove(id: string): Promise<void> {
    await api.del(`/api/skills/${encodeURIComponent(id)}`)
  },
}

export function flattenTree(nodes: SkillFileNode[]): SkillFileNode[] {
  let r: SkillFileNode[] = []
  nodes.forEach(n => { if (n.type === 'dir' && n.children) r = r.concat(flattenTree(n.children)); else r.push(n) })
  return r
}
