import type { AgentTool, ArtifactRepository } from '@gsms/agent-core'

export function permissionPayloadSummary(
  tool: AgentTool,
  input: unknown,
  state: Record<string, unknown>,
): Record<string, unknown> | undefined {
  return tool.policy?.confirmation?.summary?.(input, state)
}

export function permissionPayloadUi(
  tool: AgentTool,
  input: unknown,
  state: Record<string, unknown>,
  artifacts?: ArtifactRepository,
): Record<string, unknown> | undefined {
  const base = tool.policy?.confirmation?.ui?.(input, state)
  if (tool.name !== 'import_data_hub_files_to_scene' || !artifacts) return base
  return enrichDataHubImportConfirmationUi(base, input, state, artifacts)
}

export function enrichDataHubImportConfirmationUi(
  base: Record<string, unknown> | undefined,
  input: unknown,
  state: Record<string, unknown>,
  artifacts: ArtifactRepository,
): Record<string, unknown> | undefined {
  const proposal = latestDataHubConfirmationProposal(input, state, artifacts)
  const proposalUi = proposalUiPayload(proposal?.data)
  if (!proposalUi) return base
  const hasSlotProposal = Array.isArray(proposalUi.slots) && proposalUi.slots.length > 0
  const inputFileIds = input && typeof input === 'object' && Array.isArray((input as { fileIds?: unknown }).fileIds)
    ? (input as { fileIds: unknown[] }).fileIds.map(String)
    : []
  const baseRows = Array.isArray(base?.rows) ? base.rows : []
  const proposalRows = Array.isArray(proposalUi.rows) ? proposalUi.rows : []
  return {
    ...proposalUi,
    ...base,
    type: 'data-import-proposal',
    title: typeof proposalUi.title === 'string' ? proposalUi.title : base?.title,
    description: typeof proposalUi.description === 'string' ? proposalUi.description : base?.description,
    fileIds: hasSlotProposal
      ? Array.isArray(proposalUi.fileIds)
        ? proposalUi.fileIds.map(String)
        : []
      : inputFileIds.length
        ? inputFileIds
        : Array.isArray(proposalUi.fileIds)
          ? proposalUi.fileIds.map(String)
          : [],
    rows: mergeDataImportRows(proposalRows, baseRows),
    actions: {
      ...(proposalUi.actions && typeof proposalUi.actions === 'object' ? proposalUi.actions as Record<string, unknown> : {}),
      ...(base?.actions && typeof base.actions === 'object' ? base.actions as Record<string, unknown> : {}),
      approveLabel: '导入所选',
      rejectLabel: '取消',
      allowPartial: true,
    },
  }
}

function latestDataHubConfirmationProposal(
  input: unknown,
  state: Record<string, unknown>,
  artifacts: ArtifactRepository,
) {
  const sceneId = input && typeof input === 'object' && typeof (input as { sceneId?: unknown }).sceneId === 'string'
    ? (input as { sceneId: string }).sceneId
    : typeof state.sceneId === 'string'
      ? state.sceneId
      : undefined
  const modelId = typeof state.modelId === 'string' ? state.modelId : undefined
  return [...artifacts.list('confirmation-proposal')]
    .reverse()
    .find(artifact =>
      artifact.metadata?.actionTool === 'import_data_hub_files_to_scene' &&
      (!sceneId || artifact.metadata?.sceneId === sceneId) &&
      (!modelId || artifact.metadata?.modelId === modelId))
}

function proposalUiPayload(data: unknown): Record<string, unknown> | undefined {
  if (!data || typeof data !== 'object') return undefined
  const ui = (data as { ui?: unknown }).ui
  if (!ui || typeof ui !== 'object') return undefined
  return (ui as { type?: unknown }).type === 'data-import-proposal'
    ? ui as Record<string, unknown>
    : undefined
}

function mergeDataImportRows(
  proposalRows: readonly unknown[],
  baseRows: readonly unknown[],
): unknown[] {
  const byKey = new Map<string, unknown>()
  for (const row of [...proposalRows, ...baseRows]) {
    if (!row || typeof row !== 'object') continue
    const record = row as Record<string, unknown>
    const fileId = typeof record.fileId === 'string'
      ? record.fileId
      : typeof record.id === 'string'
        ? record.id
        : ''
    const slot = typeof record.slot === 'string' ? record.slot : 'input'
    if (!fileId) continue
    byKey.set(`${slot}:${fileId}`, row)
  }
  return [...byKey.values()]
}
