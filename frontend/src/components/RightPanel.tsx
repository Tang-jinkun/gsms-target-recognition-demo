import React from 'react'
import { CheckCircle2, Clipboard, Clock3, Database, Download, FileSearch, FileText, Layers3, Loader2, Play, Plus, TriangleAlert } from 'lucide-react'
import { useAssetsStore, useJobsStore, useLayersStore, type Asset, type AssetType, type RunMode } from '../stores/useStores'
import { Button } from './ui'
import Input from './ui/Input'

type ModelSchema = {
  id: string
  name: string
  family?: string
  description?: string
  status?: string
  runner?: string | null
  inputs?: ModelInputSpec[]
  outputs?: Array<{ name: string; type: string; map_default?: boolean }>
}

type ModelInputSpec = {
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

type ModelInputValue = string | boolean | number | undefined
type ModelInputValues = Record<string, ModelInputValue>

type CarbonSampleImportResponse = {
  imported?: Array<{ id: string; name: string; sample_role?: string }>
  roles?: {
    baseline_lulc?: string
    carbon_pools?: string
    alternate_lulc?: string
  }
}

type InputCheckResult = {
  status: 'ok' | 'warning' | 'error'
  errors: string[]
  warnings: string[]
  info: string[]
  details?: Record<string, unknown>
}

export default function RightPanel() {
  const { assets, loadAssets } = useAssetsStore()
  const { activeJobId, activeJobStatus, logs, outputs, jobHistory, runModelJob, selectJob } = useJobsStore()
  const { addOutputLayer } = useLayersStore()
  const [models, setModels] = React.useState<ModelSchema[]>([])
  const [selectedModelId, setSelectedModelId] = React.useState('carbon')
  const [formValues, setFormValues] = React.useState<ModelInputValues>({
    calc_sequestration: false,
    do_valuation: false,
    results_suffix: 'mvp',
    n_workers: -1,
  })
  const [formError, setFormError] = React.useState<string>()
  const [modelSchema, setModelSchema] = React.useState<ModelSchema>()
  const [modelSchemaError, setModelSchemaError] = React.useState<string>()
  const [importingSample, setImportingSample] = React.useState(false)
  const [importSampleError, setImportSampleError] = React.useState<string>()
  const [runMode, setRunMode] = React.useState<RunMode>('auto')
  const [logsCopied, setLogsCopied] = React.useState(false)
  const [checkingInputs, setCheckingInputs] = React.useState(false)
  const [checkResult, setCheckResult] = React.useState<InputCheckResult>()
  const logsRef = React.useRef<HTMLPreElement | null>(null)
  const selectedModel = modelSchema ?? models.find(model => model.id === selectedModelId)
  const schemaInputs = React.useMemo(() => selectedModel?.inputs ?? [], [selectedModel])
  const visibleInputCount = schemaInputs.filter(input => !input.hidden).length
  const requiredInputCount = schemaInputs.filter(input => input.required || input.required_if).length

  const setFormValue = React.useCallback((inputId: string, value: ModelInputValue) => {
    setFormValues(prev => {
      const next = { ...prev, [inputId]: value }
      if (inputId === 'calc_sequestration' && value === false) {
        next.do_valuation = false
        next.lulc_alt_asset_id = undefined
      }
      if (inputId === 'do_valuation' && value === true) {
        next.calc_sequestration = true
      }
      if (inputId === 'include_future' && value === false) {
        next.lulc_fut_asset_id = undefined
      }
      if (inputId === 'include_baseline' && value === false) {
        next.lulc_hq_bas_asset_id = undefined
      }
      return next
    })
    setCheckResult(undefined)
    setFormError(undefined)
  }, [])

  React.useEffect(() => {
    setFormValues(prev => {
      const next = { ...prev }
      let changed = false
      schemaInputs.forEach(input => {
        if (input.default !== undefined && next[input.id] === undefined) {
          next[input.id] = input.default
          changed = true
        }
      })
      return changed ? next : prev
    })
  }, [schemaInputs])

  React.useEffect(() => {
    const assetsByType = assets.reduce<Record<string, Asset[]>>((acc, asset) => {
      acc[asset.type] = [...(acc[asset.type] ?? []), asset]
      return acc
    }, {})

    setFormValues(prev => {
      const next = { ...prev }
      let changed = false

      schemaInputs
        .filter(input => input.kind === 'asset' && isInputAllowed(input, next))
        .forEach(input => {
          const candidates = assetsByType[input.asset_type ?? 'unknown'] ?? []
          const currentValue = String(next[input.id] ?? '')
          const currentIsValid = candidates.some(asset => asset.id === currentValue)
          if (currentIsValid || candidates.length === 0) return

          const disallowedIds = new Set<string>()
          if (input.id === 'lulc_alt_asset_id' && next.lulc_bas_asset_id) {
            disallowedIds.add(String(next.lulc_bas_asset_id))
          }
          if ((input.id === 'lulc_fut_asset_id' || input.id === 'lulc_hq_bas_asset_id') && next.lulc_cur_asset_id) {
            disallowedIds.add(String(next.lulc_cur_asset_id))
          }

          const fallback = candidates.find(asset => !disallowedIds.has(asset.id)) ?? candidates[0]
          next[input.id] = fallback.id
          changed = true
        })

      return changed ? next : prev
    })
  }, [assets, schemaInputs])

  React.useEffect(() => {
    const apiBaseUrl = process.env.NEXT_PUBLIC_API_URL ?? 'http://localhost:8000'
    let cancelled = false
    fetch(`${apiBaseUrl}/api/models`)
      .then(response => {
        if (!response.ok) throw new Error(`Models API returned ${response.status}`)
        return response.json()
      })
      .then((modelList: ModelSchema[]) => {
        if (!cancelled) setModels(Array.isArray(modelList) ? modelList : [])
      })
      .catch(error => {
        if (!cancelled) setModelSchemaError(error instanceof Error ? error.message : 'Unable to load model registry')
      })

    fetch(`${apiBaseUrl}/api/models/${selectedModelId}/schema`)
      .then(response => {
        if (!response.ok) throw new Error(`Model schema API returned ${response.status}`)
        return response.json()
      })
      .then((schema: ModelSchema) => {
        if (!cancelled) setModelSchema(schema)
      })
      .catch(error => {
        if (!cancelled) setModelSchemaError(error instanceof Error ? error.message : 'Unable to load model schema')
      })
    return () => {
      cancelled = true
    }
  }, [selectedModelId])

  const selectedModelRunnable = selectedModelId === 'carbon' && selectedModel?.status !== 'planned'
  const requiredInputsSatisfied = areRequiredInputsSatisfied(schemaInputs, formValues)
  const canCheck = Boolean(schemaInputs.length > 0 && requiredInputsSatisfied && activeJobStatus !== 'running')
  const canRun = Boolean(selectedModelRunnable && requiredInputsSatisfied && activeJobStatus !== 'running')

  React.useEffect(() => {
    const logPanel = logsRef.current
    if (!logPanel) return
    logPanel.scrollTop = logPanel.scrollHeight
  }, [logs])

  const handleImportSample = async () => {
    setImportSampleError(undefined)
    setImportingSample(true)
    const apiBaseUrl = process.env.NEXT_PUBLIC_API_URL ?? 'http://localhost:8000'
    try {
      const response = await fetch(`${apiBaseUrl}/api/sample-data/carbon/import`, { method: 'POST' })
      if (!response.ok) throw new Error(`Sample import returned ${response.status}`)
      const data = (await response.json()) as CarbonSampleImportResponse
      await loadAssets()
      const baselineId = data.roles?.baseline_lulc ?? data.imported?.find(asset => asset.sample_role === 'baseline_lulc')?.id
      const poolsId = data.roles?.carbon_pools ?? data.imported?.find(asset => asset.sample_role === 'carbon_pools')?.id
      const alternateId = data.roles?.alternate_lulc ?? data.imported?.find(asset => asset.sample_role === 'alternate_lulc')?.id
      setFormValues(prev => ({
        ...prev,
        lulc_bas_asset_id: baselineId ?? prev.lulc_bas_asset_id,
        carbon_pools_asset_id: poolsId ?? prev.carbon_pools_asset_id,
        lulc_alt_asset_id: alternateId ?? prev.lulc_alt_asset_id,
        results_suffix: baselineId && poolsId ? 'sample_real' : prev.results_suffix,
        lulc_bas_year: prev.lulc_bas_year ?? '2020',
        lulc_alt_year: prev.lulc_alt_year ?? '2030',
        price_per_metric_ton_of_c: prev.price_per_metric_ton_of_c ?? '43',
        discount_rate: prev.discount_rate ?? '7',
        rate_change: prev.rate_change ?? '0',
      }))
    } catch (error) {
      setImportSampleError(error instanceof Error ? error.message : 'Unable to import sample data')
    } finally {
      setImportingSample(false)
    }
  }

  const buildModelInputs = () => normalizeInputsForSubmit(formValues)

  const handleCheckInputs = async () => {
    setFormError(undefined)
    setCheckResult(undefined)
    setCheckingInputs(true)
    const apiBaseUrl = process.env.NEXT_PUBLIC_API_URL ?? 'http://localhost:8000'
    try {
      const response = await fetch(`${apiBaseUrl}/api/models/${selectedModelId}/check-inputs`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ inputs: buildModelInputs() }),
      })
      if (!response.ok) throw new Error(`Input check returned ${response.status}`)
      setCheckResult((await response.json()) as InputCheckResult)
    } catch (error) {
      setFormError(error instanceof Error ? error.message : 'Unable to check inputs')
    } finally {
      setCheckingInputs(false)
    }
  }

  const handleRun = async () => {
    setFormError(undefined)
    if (!selectedModelRunnable) {
      setFormError(`${selectedModel?.name ?? 'This model'} does not have a runnable backend yet.`)
      return
    }
    if (!areRequiredInputsSatisfied(schemaInputs, formValues)) {
      setFormError('Required model inputs are missing.')
      return
    }
    if (
      formValues.calc_sequestration &&
      (!formValues.lulc_alt_asset_id || formValues.lulc_alt_asset_id === formValues.lulc_bas_asset_id)
    ) {
      setFormError('A distinct alternate LULC raster is required when sequestration is enabled.')
      return
    }
    if (formValues.do_valuation) {
      const values = [
        ['Baseline LULC year', formValues.lulc_bas_year],
        ['Alternate LULC year', formValues.lulc_alt_year],
        ['Price per metric ton of carbon', formValues.price_per_metric_ton_of_c],
        ['Annual discount rate', formValues.discount_rate],
        ['Annual price change', formValues.rate_change],
      ]
      const missing = values.find(([, value]) => !String(value).trim())
      if (missing) {
        setFormError(`${missing[0]} is required when valuation is enabled.`)
        return
      }
      if (Number(formValues.lulc_bas_year) >= Number(formValues.lulc_alt_year)) {
        setFormError('Alternate LULC year must be greater than baseline LULC year.')
        return
      }
    }
    try {
      await runModelJob({
        modelId: selectedModelId,
        runMode,
        inputs: buildModelInputs(),
      })
    } catch (error) {
      setFormError(error instanceof Error ? error.message : 'Unable to create job')
    }
  }

  const handleCopyLogs = async () => {
    try {
      await navigator.clipboard.writeText(logs)
      setLogsCopied(true)
      window.setTimeout(() => setLogsCopied(false), 1400)
    } catch {
      setLogsCopied(false)
    }
  }

  return (
    <div className="flex h-full min-h-0 flex-col">
      <div className="border-b border-slate-200 p-4">
        <div className="flex items-center justify-between">
          <div>
            <h2 className="text-sm font-semibold">Model run</h2>
            <p className="text-xs text-slate-500">{selectedModel?.name ?? 'InVEST model workbench'}</p>
          </div>
          <StatusBadge status={activeJobStatus} />
        </div>
      </div>

      <div className="min-h-0 flex-1 overflow-auto">
        <section className="border-b border-slate-200 p-4">
          <label className="flex flex-col gap-1.5 text-sm font-medium">
            Model
            <select
              className="h-9 rounded-md border border-slate-200 bg-white px-3 text-sm shadow-sm outline-none focus:border-slate-400 focus:ring-2 focus:ring-slate-200"
              value={selectedModelId}
              onChange={event => {
                setSelectedModelId(event.target.value)
                setModelSchema(undefined)
                setCheckResult(undefined)
                setFormError(undefined)
              }}
            >
              {(models.length ? models : [{ id: 'carbon', name: 'Carbon Storage and Sequestration', status: 'auto' }]).map(model => (
                <option key={model.id} value={model.id}>
                  {model.name}{model.status === 'planned' ? ' (planned)' : ''}
                </option>
              ))}
            </select>
          </label>
          <div className="mt-3 rounded-md border border-slate-200 bg-slate-50 p-3 text-xs text-slate-600">
            <div className="flex items-center justify-between gap-3">
              <span className="font-medium text-slate-800">{selectedModel?.status ?? 'stub'} runner</span>
              <span>{requiredInputCount || 2} required / {visibleInputCount || 0} visible inputs</span>
            </div>
            <p className="mt-1 leading-5">
              {selectedModel?.description ?? modelSchemaError ?? 'Backend model schema will appear when the API is available.'}
            </p>
            {selectedModel?.runner && <p className="mt-1 font-mono text-[11px] text-slate-500">{selectedModel.runner}</p>}
          </div>

          {selectedModelId === 'carbon' ? (
            <Button variant="outline" className="mt-3 w-full" disabled={importingSample} onClick={() => void handleImportSample()}>
              {importingSample ? <Loader2 aria-hidden="true" className="animate-spin" /> : <Plus aria-hidden="true" />}
              Import sample Carbon data
            </Button>
          ) : (
            <div className="mt-3 flex gap-2 rounded-md border border-slate-200 bg-white px-3 py-2 text-xs leading-5 text-slate-600">
              <Layers3 aria-hidden="true" className="mt-0.5 size-4 shrink-0" />
              <span>
                {selectedModel?.status === 'schema'
                  ? 'This model has schema-driven parameters and input checks, but its real runner is not wired yet.'
                  : 'This model is registered for the workbench roadmap but its runnable schema is not implemented yet.'}
              </span>
            </div>
          )}

          {importSampleError && (
            <div className="mt-3 flex gap-2 rounded-md border border-amber-200 bg-amber-50 px-3 py-2 text-xs text-amber-800">
              <TriangleAlert aria-hidden="true" className="mt-0.5 size-4 shrink-0" />
              <span>{importSampleError}</span>
            </div>
          )}

          <div className="mt-4 flex flex-col gap-4">
            <ModelFormRenderer
              assets={assets}
              inputs={schemaInputs}
              values={formValues}
              onChange={setFormValue}
            />
            <label className="flex flex-col gap-1.5 text-sm font-medium">
              Runner mode
              <select
                className="h-9 rounded-md border border-slate-200 bg-white px-3 text-sm shadow-sm outline-none focus:border-slate-400 focus:ring-2 focus:ring-slate-200"
                value={runMode}
                onChange={event => setRunMode(event.target.value as RunMode)}
              >
                <option value="auto">Auto - use InVEST when available</option>
                <option value="real">Real - require natcap.invest</option>
              </select>
            </label>
            {runMode === 'real' && (
              <div className="rounded-md border border-sky-200 bg-sky-50 px-3 py-2 text-xs leading-5 text-sky-800">
                Real mode requires the backend to run inside the gsms-invest conda environment.
              </div>
            )}
          </div>

          {formError && (
            <div className="mt-4 flex gap-2 rounded-md border border-red-200 bg-red-50 px-3 py-2 text-xs text-red-700">
              <TriangleAlert aria-hidden="true" className="mt-0.5 size-4 shrink-0" />
              <span>{formError}</span>
            </div>
          )}

          <div className="mt-4 grid grid-cols-2 gap-2">
            <Button variant="outline" disabled={!canCheck || checkingInputs} onClick={() => void handleCheckInputs()}>
              {checkingInputs ? <Loader2 aria-hidden="true" className="animate-spin" /> : <FileSearch aria-hidden="true" />}
              Check inputs
            </Button>
            <Button disabled={!canRun} onClick={() => void handleRun()}>
            {activeJobStatus === 'running' ? <Loader2 aria-hidden="true" className="animate-spin" /> : <Play aria-hidden="true" />}
            {activeJobStatus === 'running' ? 'Running' : selectedModelRunnable ? `Run ${selectedModel?.name ?? 'model'}` : 'Not runnable'}
            </Button>
          </div>

          {checkResult && <InputCheckPanel result={checkResult} />}
        </section>

        <section className="border-b border-slate-200 p-4">
          <h3 className="text-sm font-semibold">Job status</h3>
          <div className="mt-3 rounded-md border border-slate-200 bg-slate-50 p-3">
            <div className="flex items-center justify-between text-sm">
              <span className="text-slate-500">Status</span>
              <span className="font-medium capitalize">{activeJobStatus}</span>
            </div>
            <div className="mt-2 flex items-center justify-between text-sm">
              <span className="text-slate-500">Job ID</span>
              <span className="max-w-[210px] truncate font-mono text-xs text-slate-700">{activeJobId ?? 'none'}</span>
            </div>
          </div>
          {activeJobStatus === 'succeeded' && (
            <div className="mt-3 rounded-md border border-emerald-200 bg-emerald-50 px-3 py-2 text-xs leading-5 text-emerald-800">
              Carbon job completed. Outputs are available below; the primary raster is added to the map automatically when possible.
            </div>
          )}
          {activeJobStatus === 'failed' && (
            <div className="mt-3 flex gap-2 rounded-md border border-red-200 bg-red-50 px-3 py-2 text-xs leading-5 text-red-700">
              <TriangleAlert aria-hidden="true" className="mt-0.5 size-4 shrink-0" />
              <span>Job failed. Check the log tail for the first ERROR entry and verify inputs or the InVEST environment.</span>
            </div>
          )}
        </section>

        <section className="border-b border-slate-200 p-4">
          <div className="flex items-center justify-between">
            <h3 className="text-sm font-semibold">Recent jobs</h3>
            <span className="rounded bg-slate-100 px-2 py-1 text-xs text-slate-500">{jobHistory.length}</span>
          </div>
          <div className="mt-3 flex max-h-48 flex-col gap-2 overflow-auto">
            {jobHistory.length === 0 ? (
              <div className="rounded-md border border-dashed border-slate-300 bg-slate-50 px-3 py-4 text-center text-xs text-slate-500">
                No job history yet.
              </div>
            ) : (
              jobHistory.map(job => (
                <button
                  key={job.jobId}
                  className={`rounded-md border p-3 text-left transition ${
                    activeJobId === job.jobId
                      ? 'border-slate-900 bg-slate-100'
                      : 'border-slate-200 bg-white hover:border-slate-300 hover:bg-slate-50'
                  }`}
                  onClick={() => void selectJob(job.jobId)}
                >
                  <div className="flex items-center justify-between gap-3">
                    <span className="truncate font-mono text-xs text-slate-700">{job.jobId}</span>
                    <span className="shrink-0 rounded bg-slate-100 px-1.5 py-0.5 text-[11px] capitalize text-slate-600">
                      {job.status}
                    </span>
                  </div>
                  <div className="mt-1 flex items-center justify-between gap-3 text-xs text-slate-500">
                    <span>{job.runMode} / {job.resultsSuffix ?? 'no suffix'}</span>
                    <span>{job.outputsCount} outputs</span>
                  </div>
                </button>
              ))
            )}
          </div>
        </section>

        <section className="border-b border-slate-200 p-4">
          <div className="flex items-center justify-between">
            <h3 className="text-sm font-semibold">Outputs</h3>
            <span className="rounded bg-slate-100 px-2 py-1 text-xs text-slate-500">{outputs.length} files</span>
          </div>

          <div className="mt-3 flex flex-col gap-2">
            {outputs.length === 0 ? (
              <div className="rounded-md border border-dashed border-slate-300 bg-slate-50 px-3 py-4 text-center text-xs text-slate-500">
                Outputs will appear after a successful run.
              </div>
            ) : (
              outputs.map(output => (
                <div key={output.id} className="flex items-center justify-between gap-3 rounded-md border border-slate-200 bg-white p-3">
                  <div className="min-w-0">
                    <div className="truncate text-sm font-medium text-slate-900">{output.name}</div>
                    <div className="mt-1 text-xs text-slate-500">{formatBytes(output.size)} | {output.type}</div>
                  </div>
                  <div className="flex items-center gap-1">
                    <Button
                      variant="outline"
                      size="icon"
                      aria-label={`Add output ${output.name} to map`}
                      disabled={!((output.type === 'geojson' && output.geojsonUrl) || (output.type === 'raster' && output.previewUrl))}
                      onClick={() => addOutputLayer(output)}
                    >
                      <Plus aria-hidden="true" />
                    </Button>
                    <Button variant="outline" size="icon" aria-label={`Download ${output.name}`} onClick={() => window.open(output.downloadUrl, '_blank')}>
                      <Download aria-hidden="true" />
                    </Button>
                  </div>
                </div>
              ))
            )}
          </div>
        </section>

        <section className="p-4">
          <div className="mb-3 flex items-center justify-between">
            <h3 className="text-sm font-semibold">Logs</h3>
            <div className="flex items-center gap-2">
              <span className="rounded bg-slate-100 px-2 py-1 text-xs text-slate-500">polling</span>
              <Button variant="outline" size="icon" aria-label="Copy logs" onClick={() => void handleCopyLogs()}>
                <Clipboard aria-hidden="true" />
              </Button>
            </div>
          </div>
          {logsCopied && <div className="mb-2 text-xs text-slate-500">Logs copied.</div>}
          <pre
            ref={logsRef}
            className={`h-72 overflow-auto rounded-md p-3 font-mono text-xs leading-5 shadow-inner ${
              activeJobStatus === 'failed'
                ? 'border border-red-400 bg-red-950 text-red-50'
                : 'bg-slate-950 text-slate-100'
            }`}
          >
            {logs}
          </pre>
        </section>
      </div>
    </div>
  )
}

function formatBytes(size?: number) {
  if (!size) return 'size unknown'
  if (size < 1024) return `${size} B`
  if (size < 1024 * 1024) return `${(size / 1024).toFixed(1)} KB`
  return `${(size / 1024 / 1024).toFixed(1)} MB`
}

type SelectAsset = {
  id: string
  name: string
}

function normalizeInputsForSubmit(values: ModelInputValues) {
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

function isInputAllowed(input: ModelInputSpec, values: ModelInputValues) {
  if (!input.allowed_if) return true
  return Boolean(values[input.allowed_if])
}

function areRequiredInputsSatisfied(inputs: ModelInputSpec[], values: ModelInputValues) {
  return inputs
    .filter(input => !input.hidden && isInputAllowed(input, values))
    .filter(input => input.required || (input.required_if && values[input.required_if]))
    .every(input => {
      const value = values[input.id]
      if (input.kind === 'boolean') return true
      return value !== undefined && String(value).trim() !== ''
    })
}

function assetIcon(assetType?: AssetType) {
  if (assetType === 'table') return <FileText aria-hidden="true" className="size-4" />
  return <Database aria-hidden="true" className="size-4" />
}

function ModelFormRenderer({
  inputs,
  values,
  assets,
  onChange,
}: {
  inputs: ModelInputSpec[]
  values: ModelInputValues
  assets: Asset[]
  onChange: (inputId: string, value: ModelInputValue) => void
}) {
  const visibleInputs = inputs.filter(input => !input.hidden && isInputAllowed(input, values))
  if (visibleInputs.length === 0) {
    return (
      <div className="rounded-md border border-dashed border-slate-300 bg-slate-50 px-3 py-4 text-center text-xs text-slate-500">
        No runnable parameters are available for this model yet.
      </div>
    )
  }

  const groups = visibleInputs.reduce<Record<string, ModelInputSpec[]>>((acc, input) => {
    const group = input.group ?? 'Parameters'
    acc[group] = [...(acc[group] ?? []), input]
    return acc
  }, {})

  return (
    <div className="flex flex-col gap-4">
      <SchemaSummary inputs={inputs} />
      {Object.entries(groups).map(([group, groupInputs]) => (
        <section key={group} className="rounded-md border border-slate-200 bg-white p-3">
          <div className="mb-3 text-xs font-semibold uppercase tracking-wide text-slate-500">{group}</div>
          <div className="flex flex-col gap-3">
            {groupInputs.map(input => (
              <ModelInputControl
                key={input.id}
                input={input}
                value={values[input.id]}
                values={values}
                assets={assets}
                onChange={onChange}
              />
            ))}
          </div>
        </section>
      ))}
    </div>
  )
}

function ModelInputControl({
  input,
  value,
  values,
  assets,
  onChange,
}: {
  input: ModelInputSpec
  value: ModelInputValue
  values: ModelInputValues
  assets: Asset[]
  onChange: (inputId: string, value: ModelInputValue) => void
}) {
  const required = Boolean(input.required || (input.required_if && values[input.required_if]))
  const label = (
    <span className="flex flex-col gap-0.5">
      <span>
        {input.label}
        {required && <span className="text-red-500"> *</span>}
      </span>
      {input.help && <span className="text-xs font-normal leading-4 text-slate-500">{input.help}</span>}
    </span>
  )

  if (input.kind === 'asset') {
    const assetType = input.asset_type ?? 'unknown'
    const matchingAssets = assets
      .filter(asset => asset.type === assetType)
      .filter(asset => {
        if (input.id === 'lulc_alt_asset_id') return asset.id !== values.lulc_bas_asset_id
        if (input.id === 'lulc_fut_asset_id' || input.id === 'lulc_hq_bas_asset_id') return asset.id !== values.lulc_cur_asset_id
        return true
      })

    return (
      <AssetSelect
        label={input.label}
        help={input.help}
        icon={assetIcon(assetType)}
        value={String(value ?? '')}
        assets={matchingAssets}
        emptyLabel={`No ${assetType} assets`}
        required={required}
        onChange={nextValue => onChange(input.id, nextValue)}
      />
    )
  }

  if (input.kind === 'boolean') {
    return (
      <label className="flex items-center justify-between gap-3 rounded-md border border-slate-200 bg-white px-3 py-2 text-sm font-medium shadow-sm">
        {label}
        <input
          className="size-4 accent-slate-900"
          type="checkbox"
          checked={Boolean(value)}
          onChange={event => onChange(input.id, event.target.checked)}
        />
      </label>
    )
  }

  if (input.kind === 'number') {
    return (
      <NumberField
        label={input.label}
        help={input.help}
        required={required}
        value={value === undefined ? '' : String(value)}
        placeholder={input.default === undefined ? String(input.placeholder ?? '') : String(input.default)}
        onChange={nextValue => onChange(input.id, nextValue)}
      />
    )
  }

  return (
    <label className="flex flex-col gap-1.5 text-sm font-medium">
      {label}
      <Input
        value={value === undefined ? '' : String(value)}
        placeholder={input.default === undefined ? undefined : String(input.default)}
        onChange={event => onChange(input.id, event.target.value)}
      />
    </label>
  )
}

function AssetSelect({
  label,
  help,
  icon,
  value,
  assets,
  emptyLabel,
  required,
  onChange,
}: {
  label: string
  help?: string
  icon: React.ReactNode
  value: string
  assets: SelectAsset[]
  emptyLabel: string
  required?: boolean
  onChange: (value: string) => void
}) {
  return (
    <label className="flex flex-col gap-1.5 text-sm font-medium">
      <span className="flex items-start gap-2">
        <span className="mt-0.5">{icon}</span>
        <span>
          {label}
          {required && <span className="text-red-500"> *</span>}
          {help && <span className="mt-0.5 block text-xs font-normal leading-4 text-slate-500">{help}</span>}
        </span>
      </span>
      <select
        className="h-9 rounded-md border border-slate-200 bg-white px-3 text-sm shadow-sm outline-none focus:border-slate-400 focus:ring-2 focus:ring-slate-200 disabled:bg-slate-50 disabled:text-slate-500"
        value={value}
        disabled={assets.length === 0}
        onChange={event => onChange(event.target.value)}
      >
        {assets.length === 0 ? (
          <option value="">{emptyLabel}</option>
        ) : (
          assets.map(asset => (
            <option key={asset.id} value={asset.id}>
              {asset.name}
            </option>
          ))
        )}
      </select>
    </label>
  )
}

function NumberField({
  label,
  help,
  required,
  value,
  placeholder,
  onChange,
}: {
  label: string
  help?: string
  required?: boolean
  value: string
  placeholder?: string
  onChange: (value: string) => void
}) {
  return (
    <label className="flex flex-col gap-1.5 text-sm font-medium text-slate-700">
      <span>
        {label}
        {required && <span className="text-red-500"> *</span>}
        {help && <span className="mt-0.5 block text-xs font-normal leading-4 text-slate-500">{help}</span>}
      </span>
      <Input
        type="number"
        value={value}
        placeholder={placeholder}
        onChange={event => onChange(event.target.value)}
      />
    </label>
  )
}

function SchemaSummary({ inputs }: { inputs: ModelInputSpec[] }) {
  const visibleInputs = inputs.filter(input => !input.hidden)
  if (visibleInputs.length === 0) return null

  const groups = visibleInputs.reduce<Record<string, ModelInputSpec[]>>((acc, input) => {
    const group = input.group ?? 'Parameters'
    acc[group] = [...(acc[group] ?? []), input]
    return acc
  }, {})

  return (
    <div className="rounded-md border border-slate-200 bg-white p-3 text-xs text-slate-600">
      <div className="mb-2 font-semibold text-slate-800">Schema-driven parameter map</div>
      <div className="space-y-2">
        {Object.entries(groups).map(([group, groupInputs]) => (
          <div key={group}>
            <div className="text-[11px] font-semibold uppercase tracking-wide text-slate-500">{group}</div>
            <div className="mt-1 flex flex-wrap gap-1.5">
              {groupInputs.map(input => (
                <span
                  key={input.id}
                  className="rounded border border-slate-200 bg-slate-50 px-1.5 py-0.5"
                  title={input.help}
                >
                  {input.label}
                  {(input.required || input.required_if) && <span className="text-red-500"> *</span>}
                </span>
              ))}
            </div>
          </div>
        ))}
      </div>
    </div>
  )
}

function InputCheckPanel({ result }: { result: InputCheckResult }) {
  const hasErrors = result.errors.length > 0
  const hasWarnings = result.warnings.length > 0
  const styles = hasErrors
    ? 'border-red-200 bg-red-50 text-red-700'
    : hasWarnings
      ? 'border-amber-200 bg-amber-50 text-amber-800'
      : 'border-emerald-200 bg-emerald-50 text-emerald-800'

  return (
    <div className={`mt-4 rounded-md border px-3 py-3 text-xs leading-5 ${styles}`}>
      <div className="flex items-center gap-2 font-semibold">
        {hasErrors ? <TriangleAlert aria-hidden="true" className="size-4" /> : <CheckCircle2 aria-hidden="true" className="size-4" />}
        Input check: {result.status}
      </div>
      <CheckList title="Errors" items={result.errors} />
      <CheckList title="Warnings" items={result.warnings} />
      <CheckList title="Info" items={result.info} />
    </div>
  )
}

function CheckList({ title, items }: { title: string; items: string[] }) {
  if (items.length === 0) return null
  return (
    <div className="mt-2">
      <div className="font-medium">{title}</div>
      <ul className="mt-1 list-disc space-y-1 pl-4">
        {items.map(item => (
          <li key={item}>{item}</li>
        ))}
      </ul>
    </div>
  )
}

function StatusBadge({ status }: { status: 'idle' | 'running' | 'succeeded' | 'failed' }) {
  const styles = {
    idle: 'bg-slate-100 text-slate-600',
    running: 'bg-amber-100 text-amber-700',
    succeeded: 'bg-emerald-100 text-emerald-700',
    failed: 'bg-red-100 text-red-700',
  }
  const Icon = status === 'running' ? Clock3 : status === 'succeeded' ? CheckCircle2 : status === 'failed' ? TriangleAlert : Clock3
  return (
    <span className={`inline-flex items-center gap-1.5 rounded px-2 py-1 text-xs font-medium ${styles[status]}`}>
      <Icon aria-hidden="true" className="size-3.5" />
      {status}
    </span>
  )
}
