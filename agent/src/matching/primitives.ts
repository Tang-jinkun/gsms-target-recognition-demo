import { basename, extname } from 'node:path'
import {
  bindingReportSchema,
  candidateSetSchema,
  type BindingReport,
  type Candidate,
  type CandidateSet,
  type DataCard,
  type Evidence,
  type InputSlot,
} from '../domain/schemas.ts'

const assetTypeByValueType: Partial<Record<InputSlot['valueType'], DataCard['assetType']>> = {
  raster: 'raster',
  vector: 'vector',
  csv: 'csv',
}

function normalizedTerms(value: string): string[] {
  return value
    .toLowerCase()
    .replace(extname(value).toLowerCase(), '')
    .split(/[^a-z0-9]+/)
    .filter(Boolean)
}

function fieldNames(card: DataCard): Set<string> {
  return new Set(card.tabular?.fields.map(field => field.name.toLowerCase()) ?? [])
}

export function scoreCandidate(slot: InputSlot, card: DataCard): Candidate {
  const evidence: Evidence[] = []
  const rejectionReasons: string[] = []
  const expectedType = assetTypeByValueType[slot.valueType]

  if (expectedType && card.assetType !== expectedType) {
    rejectionReasons.push(`Expected ${expectedType}, received ${card.assetType}`)
  } else if (expectedType) {
    evidence.push({
      kind: 'asset-type',
      message: `Asset type ${card.assetType} matches slot`,
      weight: 0.45,
      source: 'tool',
    })
  }

  const filenameTerms = new Set(normalizedTerms(basename(card.filename)))
  const hintText = card.semanticHints.join(' ').toLowerCase()
  const matchedFilenameTerms = slot.semanticTerms.filter(term =>
    normalizedTerms(term).some(token => filenameTerms.has(token)),
  )
  if (matchedFilenameTerms.length) {
    evidence.push({
      kind: 'filename',
      message: `Filename matches semantic terms: ${matchedFilenameTerms.join(', ')}`,
      weight: Math.min(0.2, matchedFilenameTerms.length * 0.05),
      source: 'tool',
    })
  }

  const matchedHints = slot.semanticTerms.filter(term => hintText.includes(term.toLowerCase()))
  if (matchedHints.length) {
    evidence.push({
      kind: 'semantic-hint',
      message: `Data card hints match: ${matchedHints.join(', ')}`,
      weight: Math.min(0.2, matchedHints.length * 0.05),
      source: 'tool',
    })
  }

  const fields = fieldNames(card)
  const missingFields = slot.requiredFields.filter(field => !fields.has(field.toLowerCase()))
  if (missingFields.length) {
    rejectionReasons.push(`Missing required fields: ${missingFields.join(', ')}`)
  } else if (slot.requiredFields.length) {
    evidence.push({
      kind: 'required-field',
      message: `Contains required fields: ${slot.requiredFields.join(', ')}`,
      weight: 0.35,
      source: 'tool',
    })
  }

  const score = rejectionReasons.length
    ? 0
    : Math.min(1, evidence.reduce((total, item) => total + item.weight, 0))
  return {
    assetId: card.assetId,
    score,
    evidence,
    rejected: rejectionReasons.length > 0,
    rejectionReasons,
  }
}

export function retrieveCandidates(slot: InputSlot, cards: readonly DataCard[]): CandidateSet {
  return candidateSetSchema.parse({
    slot: slot.name,
    candidates: cards
      .map(card => scoreCandidate(slot, card))
      .filter(candidate => !candidate.rejected)
      .sort((left, right) => right.score - left.score || left.assetId.localeCompare(right.assetId)),
  })
}

export function buildBindingReport(report: BindingReport): BindingReport {
  return bindingReportSchema.parse(report)
}
