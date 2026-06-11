import type { ArtifactLike } from './dataAvailabilityPolicy.ts'

export interface DataSourceProvider {
  id: string
  displayName: string
  discoveryTool: string
  discoveryArtifactTypes: readonly string[]
  matchesDiscoveryArtifact?: (artifact: ArtifactLike) => boolean
}

export const DATA_HUB_PROVIDER: DataSourceProvider = {
  id: 'data-hub',
  displayName: 'Data Hub',
  discoveryTool: 'discover_data_hub_candidates',
  discoveryArtifactTypes: ['data-hub-import-proposal'],
  matchesDiscoveryArtifact: artifact =>
    artifact.type === 'data-source-discovery-report' &&
    artifact.metadata?.providerId === 'data-hub',
}

export const GENERIC_DISCOVERY_PROVIDER: DataSourceProvider = {
  id: 'generic-data-source',
  displayName: 'external data source',
  discoveryTool: 'discover_data_source_candidates',
  discoveryArtifactTypes: [],
  matchesDiscoveryArtifact: artifact =>
    artifact.type === 'data-source-discovery-report' &&
    artifact.metadata?.providerId === 'generic-data-source',
}

export const DEFAULT_DATA_SOURCE_PROVIDERS: readonly DataSourceProvider[] = [
  DATA_HUB_PROVIDER,
  GENERIC_DISCOVERY_PROVIDER,
]

export function providerMatchesArtifact(
  provider: DataSourceProvider,
  artifact: ArtifactLike,
): boolean {
  if (provider.discoveryArtifactTypes.includes(artifact.type)) return true
  return provider.matchesDiscoveryArtifact?.(artifact) ?? false
}
