import { api } from '../apiClient'

export type ModelCfg = {
  providerId?: string
  name: string
  provider: string
  id: string
  url?: string
  status: 'connected' | 'untested' | 'failed'
  def: boolean
}
export type UserInfo = { name: string; email: string; org: string; field: string }

type BackendProvider = {
  provider_id?: string
  name: string
  provider: string
  id?: string
  model_id?: string
  url?: string
  base_url?: string
  status?: ModelCfg['status']
  def?: boolean
  is_default?: boolean
}

export const STATUS_META: Record<ModelCfg['status'], { badge: string; label: string; dot: boolean }> = {
  connected: { badge: 'badge-ok', label: '已连接', dot: true },
  untested: { badge: 'badge-muted', label: '未测试', dot: false },
  failed: { badge: 'badge-danger', label: '连接失败', dot: true },
}

export const PROVIDERS = ['OpenAI', 'Anthropic', 'DeepSeek', 'Qwen', 'Local', 'Custom']

function normalizeProvider(item: BackendProvider): ModelCfg {
  return {
    providerId: item.provider_id,
    name: item.name,
    provider: item.provider,
    id: item.model_id || item.id || '',
    url: item.base_url || item.url || '',
    status: item.status || 'untested',
    def: Boolean(item.is_default ?? item.def),
  }
}

export const settingsRepo = {
  async listModels(): Promise<ModelCfg[]> {
    const data = await api.get<BackendProvider[]>('/api/settings/llm-providers')
    return Array.isArray(data) ? data.map(normalizeProvider) : []
  },

  async defaultModel(): Promise<ModelCfg | undefined> {
    const list = await this.listModels()
    return list.find(m => m.def) ?? list[0]
  },

  async createModel(input: { name: string; provider: string; id: string; url: string; key?: string; def: boolean }): Promise<ModelCfg> {
    const data = await api.post<BackendProvider>('/api/settings/llm-providers', {
      name: input.name,
      provider: input.provider,
      model_id: input.id,
      base_url: input.url,
      api_key: input.key,
      def: input.def,
    })
    return normalizeProvider(data)
  },

  async updateModel(model: ModelCfg, input: { name: string; provider: string; id: string; url: string; key?: string; def: boolean }): Promise<ModelCfg> {
    if (!model.providerId) throw new Error('Missing provider id')
    const data = await api.put<BackendProvider>(`/api/settings/llm-providers/${encodeURIComponent(model.providerId)}`, {
      name: input.name,
      provider: input.provider,
      model_id: input.id,
      base_url: input.url,
      api_key: input.key || undefined,
      def: input.def,
    })
    return normalizeProvider(data)
  },

  async removeModel(model: ModelCfg): Promise<void> {
    if (!model.providerId) throw new Error('Missing provider id')
    await api.del(`/api/settings/llm-providers/${encodeURIComponent(model.providerId)}`)
  },

  async setDefault(model: ModelCfg): Promise<ModelCfg> {
    if (!model.providerId) throw new Error('Missing provider id')
    const data = await api.post<BackendProvider>(`/api/settings/llm-providers/${encodeURIComponent(model.providerId)}/default`, {})
    return normalizeProvider(data)
  },

  async getUser(): Promise<UserInfo> {
    return api.get<UserInfo>('/api/settings/user')
  },

  async saveUser(user: UserInfo): Promise<UserInfo> {
    return api.put<UserInfo>('/api/settings/user', user)
  },
}
