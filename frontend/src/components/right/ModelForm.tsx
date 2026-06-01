import React from 'react'
import { Database, FileText } from 'lucide-react'
import type { Asset, AssetType } from '../../stores/useStores'
import { Input } from '../ui'
import {
  isInputAllowed,
  isInputRequired,
  type ModelInputSpec,
  type ModelInputValue,
  type ModelInputValues,
} from './types'

type SelectAsset = {
  id: string
  name: string
}

/**
 * Split the visible inputs into a primary segment (required, always shown) and
 * an advanced segment (everything else, shown behind a disclosure). This is the
 * core of the de-cluttered form: users only see the two or three fields they
 * must fill before running.
 */
export function partitionInputs(inputs: ModelInputSpec[], values: ModelInputValues) {
  const visible = inputs.filter(input => !input.hidden && isInputAllowed(input, values))
  const primary: ModelInputSpec[] = []
  const advanced: ModelInputSpec[] = []
  visible.forEach(input => {
    if (isInputRequired(input, values)) primary.push(input)
    else advanced.push(input)
  })
  return { primary, advanced, visibleCount: visible.length }
}

function assetIcon(assetType?: AssetType) {
  if (assetType === 'table') return <FileText aria-hidden="true" className="size-4" />
  return <Database aria-hidden="true" className="size-4" />
}

/**
 * Flat list of fields with light group labels. No card-in-card nesting:
 * fields are label + control, separated by spacing only.
 */
export function ModelFieldList({
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
  if (inputs.length === 0) return null

  const groups = inputs.reduce<Record<string, ModelInputSpec[]>>((acc, input) => {
    const group = input.group ?? 'Parameters'
    acc[group] = [...(acc[group] ?? []), input]
    return acc
  }, {})
  const groupNames = Object.keys(groups)
  const showGroupLabels = groupNames.length > 1

  return (
    <div className="flex flex-col gap-4">
      {groupNames.map(group => (
        <div key={group} className="flex flex-col gap-3">
          {showGroupLabels && (
            <div className="text-[11px] font-semibold uppercase tracking-wide text-slate-400">{group}</div>
          )}
          {groups[group].map(input => (
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
  const required = isInputRequired(input, values)

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
      <label className="flex items-center justify-between gap-3 text-sm font-medium text-slate-700">
        <span className="flex flex-col gap-0.5">
          <span>{input.label}</span>
          {input.help && <span className="text-xs font-normal leading-4 text-slate-500">{input.help}</span>}
        </span>
        <input
          className="size-4 shrink-0 accent-slate-900"
          type="checkbox"
          checked={Boolean(value)}
          onChange={event => onChange(input.id, event.target.checked)}
        />
      </label>
    )
  }

  if (input.kind === 'number') {
    return (
      <FieldShell label={input.label} help={input.help} required={required}>
        <Input
          type="number"
          value={value === undefined ? '' : String(value)}
          placeholder={input.default === undefined ? String(input.placeholder ?? '') : String(input.default)}
          onChange={event => onChange(input.id, event.target.value)}
        />
      </FieldShell>
    )
  }

  return (
    <FieldShell label={input.label} help={input.help} required={required}>
      <Input
        value={value === undefined ? '' : String(value)}
        placeholder={input.default === undefined ? undefined : String(input.default)}
        onChange={event => onChange(input.id, event.target.value)}
      />
    </FieldShell>
  )
}

function FieldShell({
  label,
  help,
  required,
  children,
}: {
  label: string
  help?: string
  required?: boolean
  children: React.ReactNode
}) {
  return (
    <label className="flex flex-col gap-1.5 text-sm font-medium text-slate-700">
      <span>
        {label}
        {required && <span className="text-red-500"> *</span>}
        {help && <span className="mt-0.5 block text-xs font-normal leading-4 text-slate-500">{help}</span>}
      </span>
      {children}
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
    <label className="flex flex-col gap-1.5 text-sm font-medium text-slate-700">
      <span className="flex items-start gap-2">
        <span className="mt-0.5 text-slate-400">{icon}</span>
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
