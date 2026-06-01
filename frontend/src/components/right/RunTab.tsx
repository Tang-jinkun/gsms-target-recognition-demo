import React from 'react'
import { CheckCircle2, ChevronDown, FileSearch, Layers3, Loader2, Play, Plus, TriangleAlert } from 'lucide-react'
import type { Asset, JobStatus, RunMode } from '../../stores/useStores'
import { Button } from '../ui'
import { ModelFieldList, partitionInputs } from './ModelForm'
import type { InputCheckResult, ModelInputSpec, ModelInputValue, ModelInputValues, ModelSchema } from './types'

type RunTabProps = {
  models: ModelSchema[]
  selectedModelId: string
  selectedModel?: ModelSchema
  modelSchemaError?: string
  schemaInputs: ModelInputSpec[]
  formValues: ModelInputValues
  assets: Asset[]
  runMode: RunMode
  selectedModelRunnable: boolean
  selectedModelPreparable: boolean
  importingSample: boolean
  importSampleError?: string
  formError?: string
  canCheck: boolean
  checkingInputs: boolean
  checkResult?: InputCheckResult
  canRun: boolean
  activeJobStatus: JobStatus
  onSelectModel: (modelId: string) => void
  onChangeField: (inputId: string, value: ModelInputValue) => void
  onChangeRunMode: (mode: RunMode) => void
  onImportSample: () => void
  onCheckInputs: () => void
  onRun: () => void
}

export default function RunTab({
  models,
  selectedModelId,
  selectedModel,
  modelSchemaError,
  schemaInputs,
  formValues,
  assets,
  runMode,
  selectedModelRunnable,
  selectedModelPreparable,
  importingSample,
  importSampleError,
  formError,
  canCheck,
  checkingInputs,
  checkResult,
  canRun,
  activeJobStatus,
  onSelectModel,
  onChangeField,
  onChangeRunMode,
  onImportSample,
  onCheckInputs,
  onRun,
}: RunTabProps) {
  const [advancedOpen, setAdvancedOpen] = React.useState(false)
  const { primary, advanced } = partitionInputs(schemaInputs, formValues)
  const hasAdvanced = advanced.length > 0
  const runnerLabel = selectedModelRunnable
    ? `Run ${selectedModel?.name ?? 'model'}`
    : selectedModelPreparable
      ? 'Prepare Habitat Job'
      : 'Not runnable'

  return (
    <div className="flex flex-col gap-5 p-4">
      <label className="flex flex-col gap-1.5 text-sm font-medium text-slate-700">
        Model
        <select
          className="h-9 rounded-md border border-slate-200 bg-white px-3 text-sm shadow-sm outline-none focus:border-slate-400 focus:ring-2 focus:ring-slate-200"
          value={selectedModelId}
          onChange={event => onSelectModel(event.target.value)}
        >
          {(models.length ? models : [{ id: 'carbon', name: 'Carbon Storage and Sequestration', status: 'auto' }]).map(model => (
            <option key={model.id} value={model.id}>
              {model.name}{model.status === 'planned' ? ' (planned)' : ''}
            </option>
          ))}
        </select>
        <span className="text-xs leading-5 text-slate-500">
          {selectedModel?.description ?? modelSchemaError ?? 'Backend model schema will appear when the API is available.'}
        </span>
      </label>

      {selectedModelId === 'carbon' ? (
        <Button variant="outline" disabled={importingSample} onClick={onImportSample}>
          {importingSample ? <Loader2 aria-hidden="true" className="animate-spin" /> : <Plus aria-hidden="true" />}
          Import sample Carbon data
        </Button>
      ) : (
        <div className="flex gap-2 rounded-md border border-slate-200 bg-slate-50 px-3 py-2 text-xs leading-5 text-slate-600">
          <Layers3 aria-hidden="true" className="mt-0.5 size-4 shrink-0" />
          <span>
            {selectedModel?.status === 'schema'
              ? 'This model has schema-driven parameters and input checks, but its real runner is not wired yet.'
              : 'This model is registered for the workbench roadmap but its runnable schema is not implemented yet.'}
          </span>
        </div>
      )}

      {importSampleError && (
        <div className="flex gap-2 rounded-md border border-amber-200 bg-amber-50 px-3 py-2 text-xs text-amber-800">
          <TriangleAlert aria-hidden="true" className="mt-0.5 size-4 shrink-0" />
          <span>{importSampleError}</span>
        </div>
      )}

      {primary.length > 0 ? (
        <ModelFieldList inputs={primary} values={formValues} assets={assets} onChange={onChangeField} />
      ) : (
        <div className="rounded-md border border-dashed border-slate-300 bg-slate-50 px-3 py-4 text-center text-xs text-slate-500">
          No required parameters for this model yet.
        </div>
      )}

      <div className="rounded-md border border-slate-200">
        <button
          type="button"
          className="flex w-full items-center justify-between gap-2 px-3 py-2 text-sm font-medium text-slate-700 hover:bg-slate-50"
          onClick={() => setAdvancedOpen(open => !open)}
          aria-expanded={advancedOpen}
        >
          <span>Advanced options</span>
          <ChevronDown aria-hidden="true" className={`size-4 text-slate-400 transition-transform ${advancedOpen ? 'rotate-180' : ''}`} />
        </button>
        {advancedOpen && (
          <div className="flex flex-col gap-4 border-t border-slate-200 p-3">
            {hasAdvanced && <ModelFieldList inputs={advanced} values={formValues} assets={assets} onChange={onChangeField} />}
            <label className="flex flex-col gap-1.5 text-sm font-medium text-slate-700">
              Runner mode
              <select
                className="h-9 rounded-md border border-slate-200 bg-white px-3 text-sm shadow-sm outline-none focus:border-slate-400 focus:ring-2 focus:ring-slate-200"
                value={runMode}
                onChange={event => onChangeRunMode(event.target.value as RunMode)}
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
        )}
      </div>

      {formError && (
        <div className="flex gap-2 rounded-md border border-red-200 bg-red-50 px-3 py-2 text-xs text-red-700">
          <TriangleAlert aria-hidden="true" className="mt-0.5 size-4 shrink-0" />
          <span>{formError}</span>
        </div>
      )}

      <div className="grid grid-cols-2 gap-2">
        <Button variant="outline" disabled={!canCheck || checkingInputs} onClick={onCheckInputs}>
          {checkingInputs ? <Loader2 aria-hidden="true" className="animate-spin" /> : <FileSearch aria-hidden="true" />}
          Check inputs
        </Button>
        <Button disabled={!canRun} onClick={onRun}>
          {activeJobStatus === 'running' ? <Loader2 aria-hidden="true" className="animate-spin" /> : <Play aria-hidden="true" />}
          {activeJobStatus === 'running' ? 'Running' : runnerLabel}
        </Button>
      </div>

      {checkResult && <InputCheckPanel result={checkResult} />}
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
    <div className={`rounded-md border px-3 py-3 text-xs leading-5 ${styles}`}>
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
