import React from 'react'
import { CheckCircle2, Clock3, ListChecks, Play, TriangleAlert } from 'lucide-react'
import { useAssetsStore, useJobsStore, type Asset, type JobStatus, type RunMode } from '../stores/useStores'
import { SegmentedTabs } from './ui'
import RunTab from './right/RunTab'
import ResultsTab from './right/ResultsTab'
import {
  areRequiredInputsSatisfied,
  isInputAllowed,
  normalizeInputsForSubmit,
  type CarbonSampleImportResponse,
  type InputCheckResult,
  type ModelInputValue,
  type ModelInputValues,
  type ModelSchema,
} from './right/types'

const API_BASE_URL = process.env.NEXT_PUBLIC_API_URL ?? 'http://localhost:8000'

type RightTab = 'run' | 'results'

export default function RightPanel() {
  const { assets, loadAssets } = useAssetsStore()
  const { activeJobStatus, outputs, runModelJob } = useJobsStore()

  const [tab, setTab] = React.useState<RightTab>('run')
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
  const [checkingInputs, setCheckingInputs] = React.useState(false)
  const [checkResult, setCheckResult] = React.useState<InputCheckResult>()

  const selectedModel = modelSchema ?? models.find(model => model.id === selectedModelId)
  const schemaInputs = React.useMemo(() => selectedModel?.inputs ?? [], [selectedModel])

  // Switch to the Results tab as soon as a job starts running so the user
  // immediately watches logs/outputs instead of staring at the form.
  React.useEffect(() => {
    if (activeJobStatus === 'running') setTab('results')
  }, [activeJobStatus])

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
    let cancelled = false
    fetch(`${API_BASE_URL}/api/models`)
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

    fetch(`${API_BASE_URL}/api/models/${selectedModelId}/schema`)
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
  const selectedModelPreparable = selectedModelId === 'habitat_quality' && selectedModel?.status === 'schema'
  const requiredInputsSatisfied = areRequiredInputsSatisfied(schemaInputs, formValues)
  const canCheck = Boolean(schemaInputs.length > 0 && requiredInputsSatisfied && activeJobStatus !== 'running')
  const canRun = Boolean((selectedModelRunnable || selectedModelPreparable) && requiredInputsSatisfied && activeJobStatus !== 'running')

  const buildModelInputs = () => normalizeInputsForSubmit(formValues)

  const handleSelectModel = (modelId: string) => {
    setSelectedModelId(modelId)
    setModelSchema(undefined)
    setCheckResult(undefined)
    setFormError(undefined)
  }

  const handleImportSample = async () => {
    setImportSampleError(undefined)
    setImportingSample(true)
    try {
      const response = await fetch(`${API_BASE_URL}/api/sample-data/carbon/import`, { method: 'POST' })
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

  const handleCheckInputs = async () => {
    setFormError(undefined)
    setCheckResult(undefined)
    setCheckingInputs(true)
    try {
      const response = await fetch(`${API_BASE_URL}/api/models/${selectedModelId}/check-inputs`, {
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
    if (!selectedModelRunnable && !selectedModelPreparable) {
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

  const resultsBadge = activeJobStatus === 'running'
    ? <span aria-hidden="true" className="size-1.5 rounded-full bg-amber-500" />
    : outputs.length > 0
      ? <span className="rounded bg-slate-200 px-1 text-[10px] font-semibold text-slate-600">{outputs.length}</span>
      : undefined

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
        <SegmentedTabs<RightTab>
          className="mt-3"
          value={tab}
          onChange={setTab}
          items={[
            { value: 'run', label: 'Run', icon: <Play aria-hidden="true" className="size-4" /> },
            { value: 'results', label: 'Results', icon: <ListChecks aria-hidden="true" className="size-4" />, badge: resultsBadge },
          ]}
        />
      </div>

      <div className="min-h-0 flex-1 overflow-auto">
        {tab === 'run' ? (
          <RunTab
            models={models}
            selectedModelId={selectedModelId}
            selectedModel={selectedModel}
            modelSchemaError={modelSchemaError}
            schemaInputs={schemaInputs}
            formValues={formValues}
            assets={assets}
            runMode={runMode}
            selectedModelRunnable={selectedModelRunnable}
            selectedModelPreparable={selectedModelPreparable}
            importingSample={importingSample}
            importSampleError={importSampleError}
            formError={formError}
            canCheck={canCheck}
            checkingInputs={checkingInputs}
            checkResult={checkResult}
            canRun={canRun}
            activeJobStatus={activeJobStatus}
            onSelectModel={handleSelectModel}
            onChangeField={setFormValue}
            onChangeRunMode={setRunMode}
            onImportSample={() => void handleImportSample()}
            onCheckInputs={() => void handleCheckInputs()}
            onRun={() => void handleRun()}
          />
        ) : (
          <ResultsTab />
        )}
      </div>
    </div>
  )
}

function StatusBadge({ status }: { status: JobStatus }) {
  const styles: Record<JobStatus, string> = {
    idle: 'bg-slate-100 text-slate-600',
    running: 'bg-amber-100 text-amber-700',
    succeeded: 'bg-emerald-100 text-emerald-700',
    failed: 'bg-red-100 text-red-700',
  }
  const Icon = status === 'succeeded' ? CheckCircle2 : status === 'failed' ? TriangleAlert : Clock3
  return (
    <span className={`inline-flex items-center gap-1.5 rounded px-2 py-1 text-xs font-medium ${styles[status]}`}>
      <Icon aria-hidden="true" className="size-3.5" />
      {status}
    </span>
  )
}
