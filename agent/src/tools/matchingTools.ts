import { createHash } from 'node:crypto'
import { z } from 'zod'
import type { AgentContext, AgentTool } from '@gsms/agent-core'
import {
  bindingReportSchema,
  bindingStatusSchema,
  candidateSetSchema,
  dataCardSchema,
  modelInputSchemaSchema,
  relationCheckSchema,
  type BindingReport,
  type DataCard,
  type ModelInputSchema,
} from '../domain/schemas.ts'
import { assertReportCanProceed } from '../matching/guards.ts'
import { buildBindingReport, retrieveCandidates } from '../matching/primitives.ts'
import { checkDataMatchingGate } from '../gates/dataMatchingGate.ts'

function latestModelSchema(context: AgentContext): ModelInputSchema {
  const modelId = context.domainState.snapshot().modelId
  const artifacts = context.artifacts.list('model-input-schema')
  const artifact = typeof modelId === 'string'
    ? [...artifacts].reverse().find(candidate => candidate.metadata?.modelId === modelId)
    : artifacts.at(-1)
  if (!artifact) throw new Error('Load a GSMS model schema before matching data')
  return modelInputSchemaSchema.parse(artifact.data)
}

function dataCards(context: AgentContext): DataCard[] {
  const matchingContextId = currentMatchingContext(context)
  return context.artifacts
    .list('data-card')
    .filter(artifact => artifact.metadata?.matchingContextId === matchingContextId)
    .map(artifact => dataCardSchema.parse(artifact.data))
}

const retrieveSchema = z.object({ slot: z.string().min(1) })
const finalizeSchema = z.object({
  modelId: z.string().min(1),
  decisions: z.array(z.object({
    slot: z.string().min(1),
    selectedAssetId: z.string().min(1).optional(),
    status: bindingStatusSchema,
    confidence: z.number().min(0).max(1),
    reasoning: z.string().min(1),
  })),
  unresolvedQuestions: z.array(z.string()).default([]),
})

function currentMatchingContext(context: AgentContext): string {
  const value = context.domainState.snapshot().matchingContextId
  if (typeof value !== 'string') {
    throw toolFailure('MATCHING_CONTEXT_MISSING', 'Load the model schema and current scene data before matching.', {
      nextAction: { tool: 'list_scene_data_cards', input: {} },
    })
  }
  return value
}

function contextualArtifacts(context: AgentContext, type: string) {
  const matchingContextId = currentMatchingContext(context)
  return context.artifacts
    .list(type)
    .filter(artifact => artifact.metadata?.matchingContextId === matchingContextId)
}

export const retrieveInputCandidatesTool: AgentTool = {
  name: 'retrieve_input_candidates',
  description: 'Retrieve evidence-backed candidates for one slot from the loaded GSMS model schema',
  risk: 'read',
  inputSchema: {
    type: 'object',
    additionalProperties: false,
    required: ['slot'],
    properties: { slot: { type: 'string' } },
  },
  async execute(input, context) {
    const { slot } = retrieveSchema.parse(input)
    const schema = latestModelSchema(context)
    const matchingContextId = currentMatchingContext(context)
    const inputSlot = schema.slots.find(candidate => candidate.name === slot)
    if (!inputSlot) throw new Error(`Unknown input slot for ${schema.modelId}: ${slot}`)
    const candidates = retrieveCandidates(inputSlot, dataCards(context))
    const artifactId = `candidate-set:${matchingContextId}:${slot}`
    const existing = context.artifacts.get(artifactId)
    return {
      content: JSON.stringify(candidates),
      artifacts: existing ? [] : [
        {
          id: artifactId,
          type: 'candidate-set',
          createdBy: 'tool',
          data: candidates,
          metadata: {
            slot,
            modelId: schema.modelId,
            sceneId: context.domainState.snapshot().sceneId,
            matchingContextId,
          },
        },
      ],
      statePatch: {
        phase: 'matching-slots',
        slots: {
          [slot]: {
            candidateAssetIds: candidates.candidates.map(candidate => candidate.assetId),
            status: candidates.candidates.length ? 'candidates-found' : 'missing',
          },
        },
      },
    }
  },
}

export const finalizeDataMatchingTool: AgentTool = {
  name: 'finalize_data_matching',
  description: 'Finalize matching decisions; the tool deterministically builds the complete Binding Report from persisted evidence',
  risk: 'control',
  inputSchema: {
    type: 'object',
    additionalProperties: false,
    required: ['modelId', 'decisions'],
    properties: {
      modelId: { type: 'string' },
      decisions: {
        type: 'array',
        items: {
          type: 'object',
          additionalProperties: false,
          required: ['slot', 'status', 'confidence', 'reasoning'],
          properties: {
            slot: { type: 'string' },
            selectedAssetId: { type: 'string' },
            status: { enum: ['matched', 'ambiguous', 'missing', 'rejected'] },
            confidence: { type: 'number', minimum: 0, maximum: 1 },
            reasoning: { type: 'string' },
          },
        },
      },
      unresolvedQuestions: { type: 'array', items: { type: 'string' } },
    },
  },
  async execute(input, context) {
    const parsed = finalizeSchema.parse(input)
    const schema = latestModelSchema(context)
    if (parsed.modelId !== schema.modelId) {
      throw toolFailure('MODEL_MISMATCH', `Matching model ${parsed.modelId} does not match ${schema.modelId}.`)
    }
    const matchingContextId = currentMatchingContext(context)
    const candidateSets = contextualArtifacts(context, 'candidate-set')
      .map(artifact => candidateSetSchema.parse(artifact.data))
    const candidateBySlot = new Map(candidateSets.map(set => [set.slot, set]))
    const missingPrerequisites = schema.slots
      .filter(slot => slot.required && !candidateBySlot.has(slot.name))
      .map(slot => `candidate-set:${slot.name}`)
    if (missingPrerequisites.length) {
      const slot = missingPrerequisites[0]!.slice('candidate-set:'.length)
      throw toolFailure(
        'MATCHING_EVIDENCE_INCOMPLETE',
        'Retrieve candidates for every required slot before finalizing matching.',
        {
          missingPrerequisites,
          nextAction: { tool: 'retrieve_input_candidates', input: { slot } },
        },
      )
    }
    const decisionsBySlot = new Map(parsed.decisions.map(decision => [decision.slot, decision]))
    const bindings = schema.slots.map(slot => {
      const decision = decisionsBySlot.get(slot.name)
      const candidateSet = candidateBySlot.get(slot.name)
      if (!decision) {
        return {
          slot: slot.name,
          candidateAssetIds: candidateSet?.candidates.map(candidate => candidate.assetId) ?? [],
          confidence: 0,
          status: 'missing' as const,
          facts: [],
          agentReasoning: 'No matching decision was supplied for this slot.',
        }
      }
      const candidateAssetIds = candidateSet?.candidates.map(candidate => candidate.assetId) ?? []
      if (decision.selectedAssetId && !candidateAssetIds.includes(decision.selectedAssetId)) {
        throw toolFailure(
          'SELECTED_ASSET_NOT_CANDIDATE',
          `Selected asset ${decision.selectedAssetId} is not a persisted candidate for ${slot.name}.`,
          { invalidFields: [`decisions:${slot.name}:selectedAssetId`] },
        )
      }
      const selected = candidateSet?.candidates.find(candidate => candidate.assetId === decision.selectedAssetId)
      return {
        slot: slot.name,
        selectedAssetId: decision.selectedAssetId,
        candidateAssetIds,
        confidence: decision.confidence,
        status: decision.status,
        facts: selected?.evidence ?? [],
        agentReasoning: decision.reasoning,
      }
    })
    const persistedChecks = contextualArtifacts(context, 'relation-check')
      .map(artifact => relationCheckSchema.parse(artifact.data))
    const missingRelation = schema.slots.flatMap(slot => {
      const leftAssetId = bindings.find(binding => binding.slot === slot.name)?.selectedAssetId
      if (!leftAssetId) return []
      return slot.relationConstraints.flatMap(constraint => {
        const rightAssetId = bindings.find(binding => binding.slot === constraint.otherSlot)?.selectedAssetId
        if (!rightAssetId) return []
        const exists = persistedChecks.some(check =>
          check.kind === constraint.kind &&
          check.leftAssetId === leftAssetId &&
          check.rightAssetId === rightAssetId)
        return exists ? [] : [{
          slot: slot.name,
          kind: constraint.kind,
          leftAssetId,
          rightAssetId,
          field: constraint.field,
        }]
      })
    })[0]
    if (missingRelation) {
      throw toolFailure(
        'MATCHING_RELATION_CHECK_MISSING',
        `Run the required ${missingRelation.kind} relation check before finalizing matching.`,
        {
          missingPrerequisites: [
            `relation-check:${missingRelation.kind}:${missingRelation.leftAssetId}:${missingRelation.rightAssetId}`,
          ],
          nextAction: {
            tool: 'check_data_relation',
            input: {
              kind: missingRelation.kind,
              leftAssetId: missingRelation.leftAssetId,
              rightAssetId: missingRelation.rightAssetId,
              field: missingRelation.field,
            },
          },
        },
      )
    }
    const checks = persistedChecks.filter(check =>
      schema.slots.some(slot => {
        const left = bindings.find(binding => binding.slot === slot.name)?.selectedAssetId
        return slot.relationConstraints.some(constraint => {
          const right = bindings.find(binding => binding.slot === constraint.otherSlot)?.selectedAssetId
          return check.kind === constraint.kind && check.leftAssetId === left && check.rightAssetId === right
        })
      }),
    )
    const conflicts = [
      ...bindings
        .filter(binding => schema.slots.find(slot => slot.name === binding.slot)?.required && binding.status !== 'matched')
        .map(binding => ({
          code: 'REQUIRED_SLOT_UNRESOLVED',
          message: `Required slot ${binding.slot} is ${binding.status}.`,
          relatedSlots: [binding.slot],
          relatedAssetIds: binding.selectedAssetId ? [binding.selectedAssetId] : [],
        })),
      ...checks
        .filter(check => check.status !== 'passed')
        .map(check => ({
          code: 'RELATION_CHECK_NOT_PASSED',
          message: `Relation check ${check.id} is ${check.status}.`,
          relatedSlots: [],
          relatedAssetIds: [check.leftAssetId, check.rightAssetId],
        })),
    ]
    const requiredMatched = schema.slots
      .filter(slot => slot.required)
      .every(slot => bindings.find(binding => binding.slot === slot.name)?.status === 'matched')
    const requiredRelationsPassed = schema.slots.every(slot =>
      slot.relationConstraints.every(constraint => {
        const left = bindings.find(binding => binding.slot === slot.name)?.selectedAssetId
        const right = bindings.find(binding => binding.slot === constraint.otherSlot)?.selectedAssetId
        if (!left || !right) return false
        return checks.some(check =>
          check.kind === constraint.kind &&
          check.leftAssetId === left &&
          check.rightAssetId === right &&
          check.status === 'passed')
      }),
    )
    const recommendedNextAction =
      requiredMatched && requiredRelationsPassed && !parsed.unresolvedQuestions.length
        ? 'proceed-to-validation'
        : conflicts.some(conflict => conflict.code === 'REQUIRED_SLOT_UNRESOLVED') || parsed.unresolvedQuestions.length
          ? 'request-user-input'
          : 'collect-more-evidence'
    const report: BindingReport = buildBindingReport(bindingReportSchema.parse({
      taskSpecId: `matching:${matchingContextId}`,
      modelSchemaId: `${schema.modelId}:${schema.version}`,
      bindings,
      relationChecks: checks,
      conflicts,
      unresolvedQuestions: parsed.unresolvedQuestions,
      recommendedNextAction,
    }))
    assertReportCanProceed(report, schema, checks)
    const artifactId = `binding-report:${matchingContextId}:${createHash('sha256')
      .update(JSON.stringify(report.bindings))
      .digest('hex')
      .slice(0, 12)}`
    const existing = context.artifacts.get(artifactId)

    // Run DataMatchingGate with the report passed directly (not yet persisted to context)
    const gate = checkDataMatchingGate(context, report)

    // Persist the artifact with gate result in metadata
    const artifactResult = existing ? [] : [{
      id: artifactId,
      type: 'binding-report',
      createdBy: 'agent' as const,
      data: report,
      metadata: {
        modelId: schema.modelId,
        sceneId: context.domainState.snapshot().sceneId,
        matchingContextId,
        gateStatus: gate.status,
        gatePassed: gate.passed,
      },
    }]

    const phase = gate.status === 'ready_for_validation' ? 'ready-for-validation'
      : gate.status === 'needs_review' ? 'resolving-ambiguity'
      : 'resolving-ambiguity'

    return {
      content: JSON.stringify({
        status: 'matching-finalized',
        gate: {
          status: gate.status,
          passed: gate.passed,
          blockingReasons: gate.blockingReasons,
          slotStatuses: gate.slotStatuses,
        },
        recommendedNextAction,
        bindingReport: report,
        instruction: gate.passed
          ? 'Matching is complete and gate passed. Finish with the result, or validate if the user asked for it.'
          : `Matching finalized but gate status is '${gate.status}'. Explain the issues and ask the user how to proceed.`,
      }),
      artifacts: artifactResult,
      statePatch: {
        phase,
        bindingStatus: gate.status,
      },
      hiddenMessages: [{
        role: 'user',
        hidden: true,
        content: gate.passed
          ? 'Matching is finalized and passed the evidence gate. Finish now with candidates, evidence, confidence, missing items, risks, and the recommended next step. Do not validate unless the current request explicitly asks for validation.'
          : `Matching is finalized but the gate found issues: ${gate.blockingReasons.join('; ')}. Explain these to the user and ask how to proceed.`,
      }],
    }
  },
}

export function createMatchingTools(): AgentTool[] {
  return [retrieveInputCandidatesTool, finalizeDataMatchingTool]
}

function toolFailure(
  code: string,
  message: string,
  details: Record<string, unknown> = {},
): Error {
  return new Error(JSON.stringify({ code, message, ...details }))
}

export function computeMatchingContextId(
  sceneId: string,
  schema: ModelInputSchema | undefined,
  cards: readonly DataCard[],
): string {
  const payload = {
    sceneId,
    modelId: schema?.modelId ?? 'none',
    version: schema?.version ?? '0',
    assets: cards
      .map(card => ({ assetId: card.assetId, fingerprint: card.provenance.fingerprint }))
      .sort((left, right) => left.assetId.localeCompare(right.assetId)),
  }
  return createHash('sha256').update(JSON.stringify(payload)).digest('hex').slice(0, 24)
}
