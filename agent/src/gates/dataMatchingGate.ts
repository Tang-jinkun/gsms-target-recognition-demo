import type { AgentContext } from '@gsms/agent-core'
import {
  bindingReportSchema,
  candidateSetSchema,
  dataCardSchema,
  modelInputSchemaSchema,
  relationCheckSchema,
  type BindingReport,
  type CandidateSet,
  type ModelInputSchema,
} from '../domain/schemas.ts'

export type GateStatus = 'ready_for_validation' | 'missing_input' | 'needs_review' | 'not_attempted'

/** Float tolerance for treating two candidate scores as equal. */
const SCORE_TIE_EPSILON = 1e-6

/**
 * True when the candidate set has no unique best candidate: at least two
 * non-rejected candidates share the top score (within {@link SCORE_TIE_EPSILON}).
 * Such a slot cannot be matched deterministically — a user decision is required.
 */
export function hasTopScoreTie(candidateSet: CandidateSet | undefined): boolean {
  if (!candidateSet) return false
  const live = candidateSet.candidates.filter(c => !c.rejected)
  if (live.length < 2) return false
  const max = Math.max(...live.map(c => c.score))
  const tied = live.filter(c => c.score >= max - SCORE_TIE_EPSILON)
  return tied.length >= 2
}

export interface DataMatchingGateResult {
  passed: boolean
  status: GateStatus
  blockingReasons: string[]
  slotStatuses: SlotStatus[]
}

export interface SlotStatus {
  slot: string
  required: boolean
  decisionStatus: string
  selectedAssetId?: string
  inCandidateSet: boolean
  issue?: string
}

/**
 * DataMatchingGate validates a Binding Report against current evidence.
 *
 * It checks:
 * 1. Binding Report exists and belongs to current matching context
 * 2. Every required slot has an explicit status
 * 3. Selected assets exist in the current scene's data cards
 * 4. Selected assets belong to the persisted candidate set
 * 5. No required input is silently missing
 * 6. No unresolved ambiguity is presented as a certain match
 * 7. No blocking relation check has failed
 * 8. Unchecked required relations → needs_review, not ready
 * 9. recommendedNextAction is consistent with the gate result
 *
 * The Gate does NOT require a fixed tool-call sequence.
 * The LLM can investigate in any order; the Gate only validates the final report.
 *
 * @param context - The agent context with artifacts and domain state
 * @param reportOverride - Optional pre-built BindingReport (used when the report hasn't been persisted yet)
 */
export function checkDataMatchingGate(context: AgentContext, reportOverride?: BindingReport): DataMatchingGateResult {
  const state = context.domainState.snapshot()
  const artifacts = context.artifacts.list()
  const modelId = typeof state.modelId === 'string' ? state.modelId : undefined
  const matchingContextId =
    typeof state.matchingContextId === 'string' ? state.matchingContextId : undefined

  // ── Check 1: Binding Report exists ────────────────────────────────────────
  let report: BindingReport
  if (reportOverride) {
    report = reportOverride
  } else {
    const reportArtifact = [...artifacts]
      .reverse()
      .find(a => a.type === 'binding-report')

    if (!reportArtifact) {
      return { passed: false, status: 'not_attempted', blockingReasons: ['No binding report found'], slotStatuses: [] }
    }

    const parsed = bindingReportSchema.safeParse(reportArtifact.data)
    if (!parsed.success) {
      return { passed: false, status: 'not_attempted', blockingReasons: ['Binding report has invalid format'], slotStatuses: [] }
    }
    report = parsed.data
  }

  // ── Load current-context evidence ─────────────────────────────────────────
  // Data cards are keyed by sceneDataContextId (model-independent) — they describe
  // factual scene data and survive model switches.
  // Candidate sets and relation checks are keyed by matchingContextId (model-specific).
  const sceneDataContextId =
    typeof state.sceneDataContextId === 'string' ? state.sceneDataContextId : undefined
  const sceneDataFilter = (a: { metadata?: Record<string, unknown> }) =>
    sceneDataContextId && a.metadata?.sceneDataContextId === sceneDataContextId

  // Strict: artifact must have matchingContextId AND it must match current context.
  // Artifacts without matchingContextId are stale/unscoped and cannot satisfy the gate.
  const ctxFilter = (a: { metadata?: Record<string, unknown> }) =>
    matchingContextId && a.metadata?.matchingContextId === matchingContextId

  const schemaArtifact = [...artifacts]
    .reverse()
    .find(a => a.type === 'model-input-schema' && (!modelId || a.metadata?.modelId === modelId))
  const schema = schemaArtifact ? modelInputSchemaSchema.safeParse(schemaArtifact.data) : undefined

  const dataCards = artifacts
    .filter(a => a.type === 'data-card' && sceneDataFilter(a))
    .map(a => dataCardSchema.safeParse(a.data))
    .filter(r => r.success)
    .map(r => r.data)

  const candidateSets = artifacts
    .filter(a => a.type === 'candidate-set' && ctxFilter(a))
    .map(a => candidateSetSchema.safeParse(a.data))
    .filter(r => r.success)
    .map(r => r.data)

  const relationChecks = artifacts
    .filter(a => a.type === 'relation-check' && ctxFilter(a))
    .map(a => relationCheckSchema.safeParse(a.data))
    .filter(r => r.success)
    .map(r => r.data)

  const dataCardAssetIds = new Set(dataCards.map(c => c.assetId))
  const candidateMap = new Map(candidateSets.map(cs => [cs.slot, cs]))

  // ── Check 3-8: Per-slot validation ───────────────────────────────────────
  const slotStatuses: SlotStatus[] = []
  const blockingReasons: string[] = []
  let hasMissing = false
  let hasAmbiguous = false
  let hasFailedRelation = false

  // Determine required slots from schema
  const requiredSlots = schema?.success
    ? schema.data.slots.filter(s => s.required).map(s => s.name)
    : []

  for (const binding of report.bindings) {
    const isRequired = requiredSlots.includes(binding.slot)
    const candidateSet = candidateMap.get(binding.slot)
    const selectedInCandidates = binding.selectedAssetId
      ? candidateSet?.candidates.some(c => c.assetId === binding.selectedAssetId && !c.rejected) ?? false
      : false
    const selectedInScene = binding.selectedAssetId
      ? dataCardAssetIds.has(binding.selectedAssetId)
      : false

    let issue: string | undefined

    // Check 3: required slot must have explicit status
    if (isRequired && binding.status === 'missing') {
      issue = `Required slot '${binding.slot}' has no selected asset`
      hasMissing = true
    }

    // Check 4: selected asset must exist in current scene
    if (binding.selectedAssetId && !selectedInScene) {
      issue = `Selected asset '${binding.selectedAssetId}' for slot '${binding.slot}' does not exist in current scene`
      hasMissing = true
    }

    // Check 5: selected asset must belong to candidate set
    if (binding.selectedAssetId && !selectedInCandidates) {
      issue = `Selected asset '${binding.selectedAssetId}' for slot '${binding.slot}' is not in the persisted candidate set`
      hasMissing = true
    }

    // Check 7: no unresolved ambiguity as certain match
    if (binding.status === 'ambiguous' && isRequired) {
      issue = `Required slot '${binding.slot}' has ambiguous matches that need user decision`
      hasAmbiguous = true
    }

    // Check 7b: deterministic tie-break guard. A required slot claimed as a certain
    // 'matched' is not justified when its candidate set has no unique best (top
    // score tied). Authoritative here — the gate does not trust a self-reported
    // 'matched' over the evidence, unless the user explicitly disambiguated.
    if (isRequired && binding.status === 'matched' && !binding.userConfirmed && hasTopScoreTie(candidateSet)) {
      issue = `Required slot '${binding.slot}' has multiple equally-scored candidates; a user decision is required`
      hasAmbiguous = true
    }

    if (issue) blockingReasons.push(issue)

    slotStatuses.push({
      slot: binding.slot,
      required: isRequired,
      decisionStatus: binding.status,
      selectedAssetId: binding.selectedAssetId,
      inCandidateSet: selectedInCandidates,
      issue,
    })
  }

  // Check 6: required slots not in the report at all
  const reportedSlots = new Set(report.bindings.map(b => b.slot))
  for (const slot of requiredSlots) {
    if (!reportedSlots.has(slot)) {
      blockingReasons.push(`Required slot '${slot}' is missing from the binding report`)
      hasMissing = true
      slotStatuses.push({
        slot,
        required: true,
        decisionStatus: 'missing',
        inCandidateSet: false,
        issue: 'Not included in binding report',
      })
    }
  }

  // Check 8: relation checks
  if (schema?.success) {
    for (const slot of schema.data.slots) {
      for (const constraint of slot.relationConstraints) {
        // Look up the selected asset IDs from the bindings (not slot names)
        const leftAssetId = report.bindings.find(b => b.slot === slot.name)?.selectedAssetId
        const rightAssetId = report.bindings.find(b => b.slot === constraint.otherSlot)?.selectedAssetId
        if (!leftAssetId || !rightAssetId) continue

        const check = relationChecks.find(
          rc => rc.kind === constraint.kind &&
            rc.leftAssetId === leftAssetId &&
            rc.rightAssetId === rightAssetId
        )
        if (!check) {
          // Unchecked required relation → needs_review
          if (isRequiredSlot(slot.name, requiredSlots)) {
            blockingReasons.push(`Relation '${constraint.kind}' for slot '${slot.name}' was not checked — cannot mark as ready`)
            hasAmbiguous = true
          }
        } else if (check.status === 'failed') {
          hasFailedRelation = true
          blockingReasons.push(`Relation check '${constraint.kind}' for slot '${slot.name}' failed`)
        }
      }
    }
  }

  // ── Determine final status ────────────────────────────────────────────────
  let status: GateStatus
  if (hasMissing || hasFailedRelation) {
    status = 'missing_input'
  } else if (hasAmbiguous) {
    status = 'needs_review'
  } else {
    status = 'ready_for_validation'
  }

  // Check 9: recommendedNextAction consistency
  if (status === 'ready_for_validation' && report.recommendedNextAction !== 'proceed-to-validation') {
    blockingReasons.push(`Gate result is 'ready_for_validation' but report recommends '${report.recommendedNextAction}'`)
    status = 'needs_review'
  }

  return {
    passed: status === 'ready_for_validation',
    status,
    blockingReasons,
    slotStatuses,
  }
}

function isRequiredSlot(slotName: string, requiredSlots: string[]): boolean {
  return requiredSlots.includes(slotName)
}
