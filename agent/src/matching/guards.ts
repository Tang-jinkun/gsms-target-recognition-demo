import type { BindingReport, ModelInputSchema, RelationCheck } from '../domain/schemas.ts'

export function assertReportCanProceed(
  report: BindingReport,
  modelSchema: ModelInputSchema,
  persistedChecks: readonly RelationCheck[],
): void {
  if (report.recommendedNextAction !== 'proceed-to-validation') return

  const decisions = new Map(report.bindings.map(binding => [binding.slot, binding]))
  for (const slot of modelSchema.slots.filter(candidate => candidate.required)) {
    const decision = decisions.get(slot.name)
    if (!decision || decision.status !== 'matched' || !decision.selectedAssetId) {
      throw new Error(`Required slot is not matched: ${slot.name}`)
    }
  }

  for (const decision of report.bindings) {
    if (
      decision.selectedAssetId &&
      !decision.candidateAssetIds.includes(decision.selectedAssetId)
    ) {
      throw new Error(`Selected asset is not a candidate for slot: ${decision.slot}`)
    }
  }

  if (report.conflicts.length) throw new Error('Cannot proceed while matching conflicts remain')
  if (report.unresolvedQuestions.length) {
    throw new Error('Cannot proceed while unresolved questions remain')
  }

  const persistedById = new Map(persistedChecks.map(check => [check.id, check]))
  for (const check of report.relationChecks) {
    const persisted = persistedById.get(check.id)
    if (!persisted) throw new Error(`Relation check is not persisted: ${check.id}`)
    if (persisted.status !== 'passed') throw new Error(`Relation check did not pass: ${check.id}`)
  }

  for (const slot of modelSchema.slots) {
    const leftAssetId = decisions.get(slot.name)?.selectedAssetId
    if (!leftAssetId) continue
    for (const constraint of slot.relationConstraints) {
      const rightAssetId = decisions.get(constraint.otherSlot)?.selectedAssetId
      if (!rightAssetId) continue
      const check = persistedChecks.find(
        candidate =>
          candidate.kind === constraint.kind &&
          candidate.leftAssetId === leftAssetId &&
          candidate.rightAssetId === rightAssetId &&
          candidate.status === 'passed',
      )
      if (!check || !report.relationChecks.some(candidate => candidate.id === check.id)) {
        throw new Error(`Missing passed ${constraint.kind} check for slot: ${slot.name}`)
      }
    }
  }
}
