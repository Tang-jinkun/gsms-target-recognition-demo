import {
  DATA_HUB_PROVIDER,
  DEFAULT_DATA_SOURCE_PROVIDERS,
  providerMatchesArtifact,
  type DataSourceProvider,
} from './dataSourceProviders.ts'

export interface ArtifactLike {
  id?: string
  type: string
  data?: unknown
  metadata?: Record<string, unknown>
}

export interface DataAvailabilityPolicyDecision {
  requiresExternalDiscovery: boolean
  allowedTools: ReadonlySet<string>
  provider?: DataSourceProvider
  discoveryTool?: string
  instruction?: string
}

const BASE_EXTERNAL_DATA_DISCOVERY_ALLOWED_TOOLS = [
  'list_invest_models',
  'get_invest_model_schema',
  'list_scene_data_cards',
] as const

export const EXTERNAL_DATA_DISCOVERY_ALLOWED_TOOLS = new Set([
  ...BASE_EXTERNAL_DATA_DISCOVERY_ALLOWED_TOOLS,
  ...DEFAULT_DATA_SOURCE_PROVIDERS.map(provider => provider.discoveryTool),
])

export function evaluateDataAvailabilityPolicy(
  state: Record<string, unknown>,
  artifacts: readonly ArtifactLike[],
  providers: readonly DataSourceProvider[] = DEFAULT_DATA_SOURCE_PROVIDERS,
): DataAvailabilityPolicyDecision {
  const availableProviders = providers.length ? providers : [DATA_HUB_PROVIDER]
  const providerTools = new Set(availableProviders.map(provider => provider.discoveryTool))
  const allowedTools = new Set([
    ...BASE_EXTERNAL_DATA_DISCOVERY_ALLOWED_TOOLS,
    ...providerTools,
  ])
  const modelId = typeof state.modelId === 'string' ? state.modelId : undefined
  const matchingContextId = typeof state.matchingContextId === 'string' ? state.matchingContextId : undefined
  const currentArtifacts = artifacts
    .filter(artifact => artifact.type !== 'goal-progress')
    .filter(artifact =>
      (!modelId || !artifact.metadata?.modelId || artifact.metadata.modelId === modelId) &&
      (!matchingContextId ||
        !artifact.metadata?.matchingContextId ||
        artifact.metadata.matchingContextId === matchingContextId),
    )
  const matchesModel = (artifact: ArtifactLike) =>
    !modelId || !artifact.metadata?.modelId || artifact.metadata.modelId === modelId
  const hasSchema = currentArtifacts.some(
    artifact => artifact.type === 'model-input-schema' && matchesModel(artifact),
  )
  const hasEmptySceneDataCards = currentArtifacts.some(
    artifact =>
      artifact.type === 'gsms-scene-data-cards' &&
      matchesModel(artifact) &&
      sceneDataCardCount(artifact) === 0,
  )
  const hasExternalDiscovery = currentArtifacts.some(
    artifact =>
      matchesModel(artifact) &&
      availableProviders.some(provider => providerMatchesArtifact(provider, artifact)),
  )

  const requiresExternalDiscovery = hasSchema && hasEmptySceneDataCards && !hasExternalDiscovery
  const provider = availableProviders[0]
  return {
    requiresExternalDiscovery,
    allowedTools,
    provider,
    discoveryTool: provider.discoveryTool,
    instruction: requiresExternalDiscovery
      ? `Scene data cards are empty for model "${modelId ?? 'the current model'}". Call ${provider.discoveryTool} (${provider.displayName}) before retrieving candidates, assessing readiness, finalizing sufficiency, or saying data is missing.`
      : undefined,
  }
}

function sceneDataCardCount(artifact: ArtifactLike): number | undefined {
  if (!artifact.data || typeof artifact.data !== 'object') return undefined
  const cards = (artifact.data as { data_cards?: unknown }).data_cards
  return Array.isArray(cards) ? cards.length : undefined
}
