export type ModelSchema = {
  id: string
  name: string
  family?: string
  description?: string
  status?: string
  runner?: string | null
  inputs?: ModelInputSpec[]
  outputs?: Array<{ name: string; type: string; map_default?: boolean }>
}

export type ModelInputSpec = {
  id: string
  invest_arg?: string
  label: string
  help?: string
  kind?: 'asset' | 'boolean' | 'number' | 'string'
  asset_type?: 'raster' | 'table' | 'geojson' | 'document' | 'unknown'
  group?: string
  required?: boolean
  required_if?: string
  allowed_if?: string
  default?: string | number | boolean
  placeholder?: string | number
  hidden?: boolean
}

export type ModelInputValue = string | boolean | number | undefined
export type ModelInputValues = Record<string, ModelInputValue>

export type CarbonSampleImportResponse = {
  imported?: Array<{ id: string; name: string; sample_role?: string }>
  roles?: {
    baseline_lulc?: string
    carbon_pools?: string
    alternate_lulc?: string
  }
}

export type InputCheckResult = {
  status: 'ok' | 'warning' | 'error'
  errors: string[]
  warnings: string[]
  info: string[]
  details?: Record<string, unknown>
}

export function isInputAllowed(input: ModelInputSpec, values: ModelInputValues) {
  if (!input.allowed_if) return true
  return Boolean(values[input.allowed_if])
}

export function isInputRequired(input: ModelInputSpec, values: ModelInputValues) {
  return Boolean(input.required || (input.required_if && values[input.required_if]))
}

export function areRequiredInputsSatisfied(inputs: ModelInputSpec[], values: ModelInputValues) {
  return inputs
    .filter(input => !input.hidden && isInputAllowed(input, values))
    .filter(input => isInputRequired(input, values))
    .every(input => {
      const value = values[input.id]
      if (input.kind === 'boolean') return true
      return value !== undefined && String(value).trim() !== ''
    })
}

export function normalizeInputsForSubmit(values: ModelInputValues) {
  const normalized: Record<string, string | boolean | number | undefined> = {
    ...values,
    n_workers: values.n_workers ?? -1,
  }
  const booleanKeys = new Set(['calc_sequestration', 'do_valuation'])
  const numberKeys = new Set([
    'lulc_bas_year',
    'lulc_alt_year',
    'price_per_metric_ton_of_c',
    'discount_rate',
    'rate_change',
    'n_workers',
  ])

  Object.entries(normalized).forEach(([key, value]) => {
    if (value === '') {
      normalized[key] = undefined
      return
    }
    if (booleanKeys.has(key)) {
      normalized[key] = Boolean(value)
      return
    }
    if (numberKeys.has(key) && value !== undefined) {
      normalized[key] = Number(value)
    }
  })

  if (!normalized.calc_sequestration) {
    normalized.lulc_alt_asset_id = undefined
    normalized.do_valuation = false
  }
  if (!normalized.do_valuation) {
    normalized.lulc_bas_year = undefined
    normalized.lulc_alt_year = undefined
    normalized.price_per_metric_ton_of_c = undefined
    normalized.discount_rate = undefined
    normalized.rate_change = undefined
  }

  if (!normalized.results_suffix || typeof normalized.results_suffix !== 'string') {
    normalized.results_suffix = 'mvp'
  } else {
    normalized.results_suffix = normalized.results_suffix.trim() || 'mvp'
  }

  return normalized
}
