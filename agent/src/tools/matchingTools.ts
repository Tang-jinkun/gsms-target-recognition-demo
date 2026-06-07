import { z } from 'zod'
import type { AgentContext, AgentTool } from '@gsms/agent-core'
import {
  bindingReportSchema,
  dataCardSchema,
  modelInputSchemaSchema,
  relationCheckSchema,
  type BindingReport,
  type DataCard,
  type ModelInputSchema,
} from '../domain/schemas.ts'
import { assertReportCanProceed } from '../matching/guards.ts'
import { buildBindingReport, retrieveCandidates } from '../matching/primitives.ts'

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
  return context.artifacts.list('data-card').map(artifact => dataCardSchema.parse(artifact.data))
}

const retrieveSchema = z.object({ slot: z.string().min(1) })

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
    const inputSlot = schema.slots.find(candidate => candidate.name === slot)
    if (!inputSlot) throw new Error(`Unknown input slot for ${schema.modelId}: ${slot}`)
    const candidates = retrieveCandidates(inputSlot, dataCards(context))
    return {
      content: JSON.stringify(candidates),
      artifacts: [
        {
          type: 'candidate-set',
          createdBy: 'tool',
          data: candidates,
          metadata: { slot, modelId: schema.modelId },
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

export const submitBindingReportTool: AgentTool = {
  name: 'submit_binding_report',
  description: 'Validate and persist an agent-authored binding report against the loaded GSMS schema',
  risk: 'control',
  inputSchema: { type: 'object', description: 'A BindingReport object' },
  async execute(input, context) {
    const report: BindingReport = buildBindingReport(bindingReportSchema.parse(input))
    const schema = latestModelSchema(context)
    const checks = context.artifacts
      .list('relation-check')
      .filter(artifact => artifact.metadata?.modelId === schema.modelId)
      .map(artifact => relationCheckSchema.parse(artifact.data))
    assertReportCanProceed(report, schema, checks)
    const completed = report.recommendedNextAction === 'proceed-to-validation'
    return {
      content: `Binding report accepted; next action: ${report.recommendedNextAction}`,
      artifacts: [{
        type: 'binding-report',
        createdBy: 'agent',
        data: report,
        metadata: { modelId: schema.modelId },
      }],
      statePatch: {
        phase: completed ? 'ready-for-validation' : 'resolving-ambiguity',
        bindingStatus: completed ? 'ready-for-validation' : report.recommendedNextAction,
      },
    }
  },
}

export function createMatchingTools(): AgentTool[] {
  return [retrieveInputCandidatesTool, submitBindingReportTool]
}
