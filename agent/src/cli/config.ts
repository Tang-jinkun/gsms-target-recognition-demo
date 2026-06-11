export interface CliArguments {
  gsmsUrl?: string
  sceneId?: string
  workspace?: string
  model?: string
  baseUrl?: string
  apiKey?: string
  intentClassifierModel?: string
  intentClassifierBaseUrl?: string
  intentClassifierApiKey?: string
  disableIntentClassifier?: boolean
  maxTurns?: number
  yes: boolean
  help: boolean
}

export interface AgentCliConfig {
  gsmsUrl: string
  sceneId?: string
  workspace: string
  model: string
  modelBaseUrl: string
  apiKey: string
  intentClassifierModel?: string
  intentClassifierBaseUrl?: string
  intentClassifierApiKey?: string
  maxTurns: number
  yes: boolean
  /** Enable run_reconnaissance sub-agent (experimental). Off by default. */
  experimentalRecon?: boolean
}

interface ProviderMetadata {
  name?: unknown
  provider?: unknown
  model_id?: unknown
  id?: unknown
  base_url?: unknown
  url?: unknown
  is_default?: unknown
  def?: unknown
  has_api_key?: unknown
}

export function parseCliArguments(argv: string[]): CliArguments {
  const result: CliArguments = { yes: false, help: false, disableIntentClassifier: false }
  for (let index = 0; index < argv.length; index++) {
    const arg = argv[index]!
    if (arg === '--yes' || arg === '-y') {
      result.yes = true
      continue
    }
    if (arg === '--help' || arg === '-h') {
      result.help = true
      continue
    }
    if (arg === '--disable-intent-classifier') {
      result.disableIntentClassifier = true
      continue
    }
    const [name, inlineValue] = arg.split('=', 2)
    const value = inlineValue ?? argv[++index]
    if (!value) throw new Error(`Missing value for ${name}`)
    if (name === '--gsms-url') result.gsmsUrl = value
    else if (name === '--scene') result.sceneId = value
    else if (name === '--workspace') result.workspace = value
    else if (name === '--model') result.model = value
    else if (name === '--base-url') result.baseUrl = value
    else if (name === '--api-key') result.apiKey = value
    else if (name === '--intent-classifier-model') result.intentClassifierModel = value
    else if (name === '--intent-classifier-base-url') result.intentClassifierBaseUrl = value
    else if (name === '--intent-classifier-api-key') result.intentClassifierApiKey = value
    else if (name === '--max-turns') result.maxTurns = positiveInteger(value, name)
    else throw new Error(`Unknown argument: ${name}`)
  }
  return result
}

export async function resolveCliConfig(
  args: CliArguments,
  options: { env?: NodeJS.ProcessEnv; fetch?: typeof globalThis.fetch } = {},
): Promise<AgentCliConfig> {
  const env = options.env ?? process.env
  const fetch = options.fetch ?? globalThis.fetch
  const gsmsUrl = trimSlash(args.gsmsUrl ?? env.GSMS_URL ?? 'http://127.0.0.1:8000')
  const provider = await loadDefaultProvider(gsmsUrl, fetch)
  const model = args.model ?? env.INVEST_AGENT_MODEL ?? env.OPENAI_MODEL ?? text(provider.model_id ?? provider.id)
  const explicitBaseUrl = args.baseUrl ?? env.INVEST_AGENT_BASE_URL ?? env.OPENAI_BASE_URL
  let modelBaseUrl = trimSlash(
    explicitBaseUrl ?? text(provider.base_url ?? provider.url) ?? 'https://api.openai.com/v1',
  )
  let apiKey =
    args.apiKey ??
    env.INVEST_AGENT_API_KEY ??
    env.OPENAI_API_KEY ??
    env.GSMS_LLM_API_KEY ??
    ''
  if (!model) {
    throw new Error(
      'No model configured. Set a default GSMS LLM Provider or pass --model / INVEST_AGENT_MODEL.',
    )
  }
  const proxyToken = env.GSMS_AGENT_PROXY_TOKEN ?? ''
  if (!apiKey && !explicitBaseUrl && provider.has_api_key === true && proxyToken) {
    modelBaseUrl = `${gsmsUrl}/api/agent`
    apiKey = proxyToken
  }
  if (!apiKey && env.INVEST_AGENT_ALLOW_NO_API_KEY !== 'true') {
    throw new Error(
      'No API key configured. Set INVEST_AGENT_API_KEY or OPENAI_API_KEY. ' +
        'For a trusted local endpoint, set INVEST_AGENT_ALLOW_NO_API_KEY=true.',
    )
  }
  const disableIntentClassifier =
    args.disableIntentClassifier ||
    env.INVEST_AGENT_DISABLE_INTENT_CLASSIFIER === '1' ||
    env.INVEST_AGENT_INTENT_CLASSIFIER === 'off'
  const intentClassifierModel = disableIntentClassifier
    ? undefined
    : args.intentClassifierModel ??
      env.INVEST_AGENT_INTENT_CLASSIFIER_MODEL ??
      env.INVEST_AGENT_CLASSIFIER_MODEL ??
      model
  const intentClassifierBaseUrl = intentClassifierModel
    ? trimSlash(args.intentClassifierBaseUrl ?? text(env.INVEST_AGENT_INTENT_CLASSIFIER_BASE_URL) ?? modelBaseUrl)
    : undefined
  const intentClassifierApiKey = intentClassifierModel
    ? args.intentClassifierApiKey ?? text(env.INVEST_AGENT_INTENT_CLASSIFIER_API_KEY) ?? apiKey
    : undefined
  return {
    gsmsUrl,
    sceneId: args.sceneId ?? env.GSMS_SCENE_ID,
    workspace: args.workspace ?? env.INVEST_AGENT_WORKSPACE ?? process.cwd(),
    model,
    modelBaseUrl,
    apiKey,
    intentClassifierModel,
    intentClassifierBaseUrl,
    intentClassifierApiKey,
    maxTurns: args.maxTurns ?? positiveInteger(env.INVEST_AGENT_MAX_TURNS ?? '30', 'max turns'),
    yes: args.yes,
    experimentalRecon: env.INVEST_AGENT_EXPERIMENTAL_RECON === '1',
  }
}

async function loadDefaultProvider(
  gsmsUrl: string,
  fetch: typeof globalThis.fetch,
): Promise<ProviderMetadata> {
  try {
    const response = await fetch(`${gsmsUrl}/api/settings/llm-providers`)
    if (!response.ok) return {}
    const providers = (await response.json()) as unknown
    if (!Array.isArray(providers)) return {}
    return (
      providers.find(item => {
        const provider = item as ProviderMetadata
        return provider.is_default === true || provider.def === true
      }) ??
      providers[0] ??
      {}
    ) as ProviderMetadata
  } catch {
    return {}
  }
}

function text(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim() ? value.trim() : undefined
}

function trimSlash(value: string): string {
  return value.replace(/\/+$/, '')
}

function positiveInteger(value: string, name: string): number {
  const parsed = Number(value)
  if (!Number.isInteger(parsed) || parsed <= 0) throw new Error(`${name} must be a positive integer`)
  return parsed
}
