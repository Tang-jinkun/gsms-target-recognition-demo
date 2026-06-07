import type { ArtifactRepository, ArtifactInput } from '@gsms/agent-core'
import {
  bindingReportSchema,
  candidateSetSchema,
  dataCardSchema,
  relationCheckSchema,
  type BindingReport,
  type CandidateSet,
  type DataCard,
  type RelationCheck,
} from '../domain/schemas.ts'

export class MatchingWorkspace {
  constructor(readonly artifacts: ArtifactRepository) {}

  addDataCards(cards: readonly DataCard[]): void {
    this.artifacts.createMany(
      cards.map(
        card =>
          ({
            id: `data-card:${card.assetId}`,
            type: 'data-card',
            createdBy: 'tool',
            data: dataCardSchema.parse(card),
          }) satisfies ArtifactInput,
      ),
    )
  }

  dataCards(): DataCard[] {
    return this.artifacts
      .list('data-card')
      .map(artifact => dataCardSchema.parse(artifact.data))
  }

  addCandidateSet(candidateSet: CandidateSet): void {
    const parsed = candidateSetSchema.parse(candidateSet)
    this.artifacts.create({
      type: 'candidate-set',
      createdBy: 'tool',
      data: parsed,
      metadata: { slot: parsed.slot },
    })
  }

  addRelationCheck(check: RelationCheck): void {
    this.artifacts.create({
      id: `relation-check:${check.id}`,
      type: 'relation-check',
      createdBy: 'tool',
      data: relationCheckSchema.parse(check),
    })
  }

  addBindingReport(report: BindingReport): void {
    this.artifacts.create({
      type: 'binding-report',
      createdBy: 'agent',
      data: bindingReportSchema.parse(report),
    })
  }
}
