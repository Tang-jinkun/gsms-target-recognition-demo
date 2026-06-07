import { adaptGsmsModelSchema, type DataCard } from '../src/index.ts'

export function raster(
  assetId: string,
  filename: string,
  semanticHints: string[],
  sampledCodes: number[],
): DataCard {
  return {
    assetId,
    path: `data/${filename}`,
    assetType: 'raster',
    filename,
    semanticHints,
    raster: { bands: 1, sampledCodes },
    provenance: { source: 'user-local', fingerprint: `fp-${assetId}` },
  }
}

export function csv(
  assetId: string,
  filename: string,
  fields: Array<{ name: string; sampledValues?: Array<string | number | boolean | null> }>,
): DataCard {
  return {
    assetId,
    path: `data/${filename}`,
    assetType: 'csv',
    filename,
    semanticHints: [],
    tabular: { fields },
    provenance: { source: 'user-local', fingerprint: `fp-${assetId}` },
  }
}

export const carbonFields = [
  { name: 'lucode', sampledValues: [1, 2, 3] },
  { name: 'c_above' },
  { name: 'c_below' },
  { name: 'c_soil' },
  { name: 'c_dead' },
]

export const gsmsCarbonSchema = {
  id: 'carbon',
  invest_version: '3.19.0',
  name: 'Carbon Storage and Sequestration',
  inputs: [
    {
      id: 'lulc_bas_asset_id',
      invest_arg: 'lulc_bas_path',
      label: 'Baseline LULC raster',
      kind: 'asset',
      asset_type: 'raster',
      required: true,
      semantic_terms: ['lulc', 'land cover', 'baseline', 'current'],
    },
    {
      id: 'carbon_pools_asset_id',
      invest_arg: 'carbon_pools_path',
      label: 'Carbon pools table',
      kind: 'asset',
      asset_type: 'table',
      required: true,
      semantic_terms: ['carbon pools', 'carbon'],
      required_fields: ['lucode', 'c_above', 'c_below', 'c_soil', 'c_dead'],
    },
  ],
  matching_relations: [
    {
      kind: 'code-coverage',
      left_slot: 'lulc_bas_path',
      right_slot: 'carbon_pools_path',
      field: 'lucode',
    },
  ],
}

export const testCarbonModelSchema = adaptGsmsModelSchema(gsmsCarbonSchema)

export function testCarbonSlot(name: string) {
  const slot = testCarbonModelSchema.slots.find(candidate => candidate.name === name)
  if (!slot) throw new Error(`Unknown test slot: ${name}`)
  return slot
}
