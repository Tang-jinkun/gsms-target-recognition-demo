import { OpenAICompatibleAdapter, type ModelAdapter } from '@gsms/agent-core'

export interface IntentClassifierConfig {
  model?: string
  baseUrl?: string
  apiKey?: string
}

export function createIntentClassifier(config: IntentClassifierConfig): ModelAdapter | undefined {
  const model = text(config.model)
  if (!model) return undefined
  return new OpenAICompatibleAdapter({
    model,
    baseUrl: config.baseUrl ? trimSlash(config.baseUrl) : undefined,
    apiKey: config.apiKey ?? '',
  })
}

export function intentClassifierConfigFromEnv(
  env: NodeJS.ProcessEnv,
  fallback: IntentClassifierConfig = {},
): IntentClassifierConfig {
  if (
    env.INVEST_AGENT_DISABLE_INTENT_CLASSIFIER === '1' ||
    env.INVEST_AGENT_INTENT_CLASSIFIER === 'off'
  ) {
    return {}
  }
  const model =
    env.INVEST_AGENT_INTENT_CLASSIFIER_MODEL ??
    env.INVEST_AGENT_CLASSIFIER_MODEL ??
    fallback.model
  if (!text(model)) return {}
  return {
    model,
    baseUrl: text(env.INVEST_AGENT_INTENT_CLASSIFIER_BASE_URL) ?? fallback.baseUrl,
    apiKey: text(env.INVEST_AGENT_INTENT_CLASSIFIER_API_KEY) ?? fallback.apiKey,
  }
}

function text(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim() ? value.trim() : undefined
}

function trimSlash(value: string): string {
  return value.replace(/\/+$/, '')
}
