import type { DataHubImportSelection, DataHubImportSlotGroup } from './repos/workbenchRepo'

export type DataImportProposal = {
  fileIds: string[]
  selections: DataHubImportSelection[]
  slots: DataHubImportSlotGroup[]
  title?: string
  description?: string
  approveLabel?: string
  rejectLabel?: string
  allowPartial?: boolean
}

export function dataImportProposalFromPayload(
  kind: string,
  payload: Record<string, unknown> | undefined,
): DataImportProposal | null {
  const uiProposal = dataImportProposalFromUi(payload?.ui)
  if (uiProposal) return uiProposal
  return dataHubImportFallbackFromPayload(kind, payload)
}

function dataImportProposalFromUi(value: unknown): DataImportProposal | null {
  if (!value || typeof value !== 'object') return null
  const source = value as Record<string, unknown>
  if (source.type !== 'data-import-proposal') return null
  const fileIds = Array.isArray(source.fileIds) ? source.fileIds.map(String) : []
  const rows = Array.isArray(source.rows) ? source.rows : []
  const selections = rows.flatMap(item => {
    if (!item || typeof item !== 'object') return []
    const row = item as Record<string, unknown>
    const fileId = typeof row.fileId === 'string'
      ? row.fileId
      : typeof row.id === 'string'
        ? row.id
        : ''
    if (!fileId) return []
    const selection: DataHubImportSelection = {
      slot: typeof row.slot === 'string' ? row.slot : 'input',
      fileId,
      name: typeof row.name === 'string'
        ? row.name
        : typeof row.label === 'string'
          ? row.label
          : undefined,
      confidence: typeof row.confidence === 'string' ? row.confidence : undefined,
      score: typeof row.score === 'number' ? row.score : undefined,
      reasons: Array.isArray(row.reasons) ? row.reasons.map(String) : [],
      risks: Array.isArray(row.risks) ? row.risks.map(String) : [],
    }
    if (typeof row.recommended === 'boolean') selection.recommended = row.recommended
    if (typeof row.ambiguous === 'boolean') selection.ambiguous = row.ambiguous
    if (typeof row.required === 'boolean') selection.required = row.required
    return [selection]
  })
  const normalizedFileIds = fileIds.length
    ? fileIds
    : selections.map(selection => selection.fileId)
  const slots = Array.isArray(source.slots) ? parseImportSlots(source.slots) : []
  if (!normalizedFileIds.length && !slots.length) return null
  const actions = source.actions && typeof source.actions === 'object'
    ? source.actions as Record<string, unknown>
    : {}
  return {
    fileIds: normalizedFileIds,
    selections,
    slots,
    title: typeof source.title === 'string' ? source.title : undefined,
    description: typeof source.description === 'string' ? source.description : undefined,
    approveLabel: typeof actions.approveLabel === 'string' ? actions.approveLabel : undefined,
    rejectLabel: typeof actions.rejectLabel === 'string' ? actions.rejectLabel : undefined,
    allowPartial: typeof actions.allowPartial === 'boolean' ? actions.allowPartial : undefined,
  }
}

function dataHubImportFallbackFromPayload(
  kind: string,
  payload: Record<string, unknown> | undefined,
): DataImportProposal | null {
  if (kind !== 'import_data_hub_files_to_scene') return null
  const summary = payload?.summary
  const input = payload?.input
  const source = summary && typeof summary === 'object'
    ? summary as Record<string, unknown>
    : input && typeof input === 'object'
      ? input as Record<string, unknown>
      : {}
  const fileIds = Array.isArray(source.fileIds) ? source.fileIds.map(String) : []
  const selections = Array.isArray(source.selections)
    ? source.selections.flatMap(item => {
        if (!item || typeof item !== 'object') return []
        const row = item as Record<string, unknown>
        if (typeof row.slot !== 'string' || typeof row.fileId !== 'string') return []
        const selection: DataHubImportSelection = {
          slot: row.slot,
          fileId: row.fileId,
          name: typeof row.name === 'string' ? row.name : undefined,
          confidence: typeof row.confidence === 'string' ? row.confidence : undefined,
          score: typeof row.score === 'number' ? row.score : undefined,
          reasons: Array.isArray(row.reasons) ? row.reasons.map(String) : [],
          risks: Array.isArray(row.risks) ? row.risks.map(String) : [],
        }
        if (typeof row.recommended === 'boolean') selection.recommended = row.recommended
        if (typeof row.ambiguous === 'boolean') selection.ambiguous = row.ambiguous
        if (typeof row.required === 'boolean') selection.required = row.required
        return [selection]
      })
    : []
  return fileIds.length ? { fileIds, selections, slots: [] } : null
}

function parseImportSlots(items: unknown[]): DataHubImportSlotGroup[] {
  return items.flatMap(item => {
    if (!item || typeof item !== 'object') return []
    const source = item as Record<string, unknown>
    if (typeof source.slot !== 'string') return []
    const slotName = source.slot
    const status = source.status === 'auto_selected' || source.status === 'needs_user_choice' || source.status === 'missing'
      ? source.status
      : undefined
    if (!status) return []
    const candidates = Array.isArray(source.candidates)
      ? source.candidates.flatMap(candidate => {
          if (!candidate || typeof candidate !== 'object') return []
          const row = candidate as Record<string, unknown>
          if (typeof row.fileId !== 'string') return []
          const selection: DataHubImportSelection = {
            slot: typeof row.slot === 'string' ? row.slot : slotName,
            fileId: row.fileId,
            name: typeof row.name === 'string' ? row.name : undefined,
            confidence: typeof row.confidence === 'string' ? row.confidence : undefined,
            score: typeof row.score === 'number' ? row.score : undefined,
            reasons: Array.isArray(row.reasons) ? row.reasons.map(String) : [],
            risks: Array.isArray(row.risks) ? row.risks.map(String) : [],
          }
          if (typeof row.recommended === 'boolean') selection.recommended = row.recommended
          if (typeof row.ambiguous === 'boolean') selection.ambiguous = row.ambiguous
          if (typeof row.required === 'boolean') selection.required = row.required
          return [selection]
        })
      : []
    return [{
      slot: slotName,
      label: typeof source.label === 'string' ? source.label : undefined,
      required: typeof source.required === 'boolean' ? source.required : undefined,
      status,
      selectedFileId: typeof source.selectedFileId === 'string' ? source.selectedFileId : undefined,
      candidates,
      diagnostics: Array.isArray(source.diagnostics) ? source.diagnostics.map(String) : [],
    }]
  })
}
