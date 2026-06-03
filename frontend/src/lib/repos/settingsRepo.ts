import { loadSeeded, save } from '../localStore'

export type ModelCfg = {
  name: string
  provider: string
  id: string
  status: 'connected' | 'untested' | 'failed'
  def: boolean
}
export type UserInfo = { name: string; email: string; org: string; field: string }

const MODELS_KEY = 'gsms.llmModels'
const USER_KEY = 'gsms.user'

const SEED_MODELS: ModelCfg[] = [
  { name: 'GPT-4o', provider: 'OpenAI', id: 'gpt-4o', status: 'connected', def: true },
  { name: 'Claude 3.5 Sonnet', provider: 'Anthropic', id: 'claude-3-5-sonnet', status: 'connected', def: false },
  { name: 'DeepSeek-V2', provider: 'DeepSeek', id: 'deepseek-chat', status: 'untested', def: false },
  { name: '本地 Qwen2-72B', provider: 'Local', id: 'qwen2-72b', status: 'failed', def: false },
]
const SEED_USER: UserInfo = { name: '李泽', email: 'lize@geosci.edu.cn', org: '地理科学与生态研究院', field: '湿地碳汇与生态系统服务' }

export const STATUS_META: Record<ModelCfg['status'], { badge: string; label: string; dot: boolean }> = {
  connected: { badge: 'badge-ok', label: '已连接', dot: true },
  untested: { badge: 'badge-muted', label: '未测试', dot: false },
  failed: { badge: 'badge-danger', label: '连接失败', dot: true },
}

export const PROVIDERS = ['OpenAI', 'Anthropic', 'DeepSeek', 'Qwen', 'Local', 'Custom']

export const settingsRepo = {
  listModels: () => loadSeeded(MODELS_KEY, SEED_MODELS),
  saveModels: (m: ModelCfg[]) => save(MODELS_KEY, m),
  defaultModel(): ModelCfg | undefined {
    const list = loadSeeded(MODELS_KEY, SEED_MODELS)
    return list.find(m => m.def) ?? list[0]
  },
  getUser: () => loadSeeded(USER_KEY, SEED_USER),
  saveUser: (u: UserInfo) => save(USER_KEY, u),
}
