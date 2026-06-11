import { modelInputSchemaSchema } from '../domain/schemas.ts'
import { evaluateDataAvailabilityPolicy } from '../policies/dataAvailabilityPolicy.ts'
import { workflowEvidenceInstruction } from '../policies/workflowPolicy.ts'

export function buildWorkflowResumeContext(
  state: Record<string, unknown>,
  artifacts: readonly unknown[],
): string {
  const rows = artifacts.filter(isArtifact)
  const counts = rows.reduce<Record<string, number>>((result, artifact) => {
    result[artifact.type] = (result[artifact.type] ?? 0) + 1
    return result
  }, {})
  const modelId = typeof state.modelId === 'string' ? state.modelId : 'none'
  const phase = typeof state.phase === 'string' ? state.phase : 'unknown'
  const matchingContextId =
    typeof state.matchingContextId === 'string' ? state.matchingContextId : undefined
  const currentRows = rows.filter(
    artifact =>
      (!artifact.metadata?.modelId || artifact.metadata.modelId === modelId) &&
      (!artifact.metadata?.matchingContextId ||
        artifact.metadata.matchingContextId === matchingContextId),
  )
  const currentCounts = currentRows.reduce<Record<string, number>>((result, artifact) => {
    result[artifact.type] = (result[artifact.type] ?? 0) + 1
    return result
  }, {})
  const currentArtifacts = currentRows
    .slice(-12)
    .map(artifact => ({
      type: artifact.type,
      modelId: artifact.metadata?.modelId,
      slot: artifact.metadata?.slot,
      id: artifact.id,
    }))
  const directive = workflowDirective(state, phase, modelId, currentCounts, currentRows)
  return [
    `Persisted workflow evidence: ${JSON.stringify({ phase, modelId, counts, currentCounts, currentArtifacts })}`,
    `Required continuation: ${directive}`,
    'Do not repeat completed workflow stages unless the user explicitly changes the model, bindings, or parameters.',
    'Do not stop with a progress-only update. Use finish with a factual final summary, or invoke the next required tool.',
  ].join('\n')
}

function workflowDirective(
  state: Record<string, unknown>,
  phase: string,
  modelId: string,
  counts: Record<string, number>,
  artifacts: readonly ReturnType<typeof normalizeArtifact>[],
): string {
  const definedArtifacts = artifacts.filter((artifact): artifact is NonNullable<typeof artifact> => Boolean(artifact))
  const schemaArtifact = [...definedArtifacts].reverse().find(artifact => artifact.type === 'model-input-schema')
  const schema = schemaArtifact ? modelInputSchemaSchema.safeParse(schemaArtifact.data) : undefined
  const candidateSlots = new Set(
    definedArtifacts
      .filter(artifact => artifact.type === 'candidate-set')
      .map(artifact => artifact.metadata?.slot),
  )
  const missingRequiredSlots = schema?.success
    ? schema.data.slots.filter(slot => slot.required && !candidateSlots.has(slot.name)).map(slot => slot.name)
    : []
  const dataAvailability = evaluateDataAvailabilityPolicy(state, definedArtifacts)
  const pendingImportFileIds = latestPendingImportFileIds(definedArtifacts)

  return workflowEvidenceInstruction({
    phase,
    modelId,
    counts,
    missingRequiredSlots,
    pendingImportFileIds,
    dataAvailabilityInstruction: dataAvailability.instruction,
  })
}

function latestPendingImportFileIds(
  artifacts: readonly NonNullable<ReturnType<typeof normalizeArtifact>>[],
): string[] {
  const proposal = [...artifacts]
    .reverse()
    .find(artifact =>
      (artifact.type === 'confirmation-proposal' || artifact.type === 'data-hub-import-proposal') &&
      (!artifact.metadata?.actionTool || artifact.metadata.actionTool === 'import_data_hub_files_to_scene') &&
      Array.isArray(artifact.metadata?.proposedFileIds) &&
      artifact.metadata.proposedFileIds.length > 0,
    )
  return Array.isArray(proposal?.metadata?.proposedFileIds)
    ? proposal.metadata.proposedFileIds.map(String)
    : []
}

function isArtifact(value: unknown): value is {
  id?: string
  type: string
  data?: unknown
  metadata?: Record<string, unknown>
} {
  return Boolean(value && typeof value === 'object' && typeof (value as { type?: unknown }).type === 'string')
}

function normalizeArtifact(value: unknown) {
  return isArtifact(value) ? value : undefined
}
