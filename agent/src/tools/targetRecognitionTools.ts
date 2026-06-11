import { createHash } from 'node:crypto'
import { z } from 'zod'
import type { AgentContext, AgentTool, Artifact } from '@gsms/agent-core'
import { GsmsClient } from '../gsms/GsmsClient.ts'

const conditionSchema = z.object({
  field: z.string().min(1),
  operator: z.enum([
    'equals',
    'in',
    'contains',
    'greater-than',
    'greater-than-or-equal',
    'less-than',
    'less-than-or-equal',
  ]),
  value: z.union([
    z.string(),
    z.number(),
    z.boolean(),
    z.array(z.union([z.string(), z.number(), z.boolean()])),
  ]),
})

const datasetSelectionSchema = z.object({
  sceneId: z.string().min(1),
  timeIntent: z.enum(['latest', 'specific-date', 'all']),
  requestedDate: z.string().min(1).optional(),
  candidates: z.array(z.object({
    assetId: z.string().min(1),
    interpretedDate: z.string().date(),
    confidence: z.number().min(0).max(1),
    reasoning: z.string().min(1),
  })).min(1),
})

const targetQuerySchema = z.object({
  sceneId: z.string().min(1),
  selectedAssetIds: z.array(z.string().min(1)).min(1),
  targetDescription: z.string().min(1),
  conditions: z.array(conditionSchema).min(1),
  reasoning: z.string().min(1),
  unresolvedQuestions: z.array(z.string()).default([]),
})

const analysisContextSchema = z.object({ analysisContextId: z.string().min(1) })

type VectorProfile = {
  assetId: string
  filename: string
  profile?: {
    feature_count?: number
    geometry_types?: Record<string, number>
    fields?: Array<{
      name: string
      inferred_type: string
      distinct_count?: number
      sampled_values?: unknown[]
      sampled_values_complete?: boolean
      numeric_stats?: { minimum?: number; maximum?: number }
    }>
  }
  fingerprint?: Record<string, unknown>
}

export function createTargetRecognitionTools(client: GsmsClient): AgentTool[] {
  return [
    {
      name: 'request_target_clarification',
      description: 'Persist one blocking clarification question when time scope or target semantics are unresolved',
      risk: 'control',
      inputSchema: {
        type: 'object',
        additionalProperties: false,
        required: ['sceneId', 'question', 'reason'],
        properties: {
          sceneId: { type: 'string' },
          question: { type: 'string' },
          reason: { type: 'string' },
        },
      },
      async execute(input) {
        const parsed = z.object({
          sceneId: z.string().min(1),
          question: z.string().min(1),
          reason: z.string().min(1),
        }).parse(input)
        return {
          content: JSON.stringify(parsed),
          artifacts: [{
            type: 'target-clarification',
            createdBy: 'agent',
            logicalKey: `target-clarification:${parsed.sceneId}`,
            data: parsed,
            metadata: { sceneId: parsed.sceneId, sourceAssetIds: [] },
          }],
          statePatch: { sceneId: parsed.sceneId, phase: 'awaiting-target-clarification' },
        }
      },
    },
    {
      name: 'inspect_scene_vector_data',
      description: 'Inspect current-scene GeoJSON candidates and factual property profiles before planning a spatial target query',
      risk: 'read',
      inputSchema: {
        type: 'object',
        additionalProperties: false,
        required: ['sceneId'],
        properties: { sceneId: { type: 'string' } },
      },
      async execute(input, context) {
        const sceneId = z.object({ sceneId: z.string().min(1) }).parse(input).sceneId
        const result = await client.listSceneVectorProfiles(sceneId)
        const candidates = vectorCandidates(result)
        return {
          content: JSON.stringify(result),
          artifacts: [
            {
              type: 'vector-property-profile',
              createdBy: 'tool',
              logicalKey: `vector-property-profile:${sceneId}`,
              data: result,
              metadata: { sceneId, sourceAssetIds: candidates.map(candidate => candidate.assetId) },
            },
          ],
          statePatch: { sceneId, phase: 'target-data-inspected' },
        }
      },
    },
    {
      name: 'finalize_dataset_selection',
      description: 'Validate the LLM interpretation of dataset dates and persist the selected latest, specific-date, or all datasets',
      risk: 'control',
      inputSchema: {
        type: 'object',
        additionalProperties: false,
        required: ['sceneId', 'timeIntent', 'candidates'],
        properties: {
          sceneId: { type: 'string' },
          timeIntent: { type: 'string', enum: ['latest', 'specific-date', 'all'] },
          requestedDate: { type: 'string' },
          candidates: {
            type: 'array',
            items: {
              type: 'object',
              additionalProperties: false,
              required: ['assetId', 'interpretedDate', 'confidence', 'reasoning'],
              properties: {
                assetId: { type: 'string' },
                interpretedDate: { type: 'string' },
                confidence: { type: 'number' },
                reasoning: { type: 'string' },
              },
            },
          },
        },
      },
      async execute(input, context) {
        const parsed = datasetSelectionSchema.parse(input)
        const profiles = currentProfiles(context, parsed.sceneId)
        const expectedIds = new Set(profiles.map(profile => profile.assetId))
        const submittedIds = new Set(parsed.candidates.map(candidate => candidate.assetId))
        const missing = [...expectedIds].filter(assetId => !submittedIds.has(assetId))
        const unknown = [...submittedIds].filter(assetId => !expectedIds.has(assetId))
        if (missing.length || unknown.length) {
          throw new Error(`Dataset interpretation must cover every current GeoJSON candidate. Missing: ${missing.join(', ') || 'none'}; unknown: ${unknown.join(', ') || 'none'}`)
        }
        const filenameById = new Map(profiles.map(profile => [profile.assetId, profile.filename]))
        const candidates = parsed.candidates.map(candidate => ({
          ...candidate,
          filename: filenameById.get(candidate.assetId),
        }))
        const selectedAssetIds = selectAssetIds(parsed.timeIntent, parsed.requestedDate, candidates)
        const data = { ...parsed, candidates, selectedAssetIds }
        return {
          content: JSON.stringify(data),
          artifacts: [{
            type: 'dataset-selection',
            createdBy: 'agent',
            logicalKey: `dataset-selection:${parsed.sceneId}`,
            data,
            metadata: { sceneId: parsed.sceneId, sourceAssetIds: selectedAssetIds },
          }],
          statePatch: {
            sceneId: parsed.sceneId,
            phase: 'target-dataset-selected',
            selectedAssetIds,
            timeIntent: parsed.timeIntent,
          },
        }
      },
    },
    {
      name: 'finalize_target_query',
      description: 'Validate a natural-language target as an evidence-backed AND query over selected GeoJSON property profiles',
      risk: 'control',
      inputSchema: {
        type: 'object',
        additionalProperties: false,
        required: ['sceneId', 'selectedAssetIds', 'targetDescription', 'conditions', 'reasoning'],
        properties: {
          sceneId: { type: 'string' },
          selectedAssetIds: { type: 'array', items: { type: 'string' } },
          targetDescription: { type: 'string' },
          conditions: { type: 'array', items: conditionJsonSchema() },
          reasoning: { type: 'string' },
          unresolvedQuestions: { type: 'array', items: { type: 'string' } },
        },
      },
      async execute(input, context) {
        const parsed = targetQuerySchema.parse(input)
        if (parsed.unresolvedQuestions.length) {
          throw new Error(`Target query has unresolved questions: ${parsed.unresolvedQuestions.join('; ')}`)
        }
        const selection = latestArtifact(context, 'dataset-selection', parsed.sceneId)
        const selected = new Set((selection.data as { selectedAssetIds?: string[] }).selectedAssetIds ?? [])
        if (parsed.selectedAssetIds.some(assetId => !selected.has(assetId)) || parsed.selectedAssetIds.length !== selected.size) {
          throw new Error('Target query must use the exact current dataset selection')
        }
        validateTargetConditions(currentProfiles(context, parsed.sceneId), parsed.selectedAssetIds, parsed.conditions)
        const analysisContextId = hash({
          sceneId: parsed.sceneId,
          fingerprints: Object.fromEntries(
            currentProfiles(context, parsed.sceneId)
              .filter(profile => selected.has(profile.assetId))
              .sort((left, right) => left.assetId.localeCompare(right.assetId))
              .map(profile => [profile.assetId, profile.fingerprint]),
          ),
          conditions: parsed.conditions,
          version: '1',
        })
        const data = { ...parsed, analysisContextId }
        const existingQuery = context.artifacts.get(targetQueryArtifactId(analysisContextId))
        return {
          content: JSON.stringify({
            ...data,
            evidenceReused: Boolean(existingQuery),
            nextAction: {
              tool: 'execute_target_query',
              input: { analysisContextId },
            },
          }),
          artifacts: existingQuery ? [] : [{
            id: targetQueryArtifactId(analysisContextId),
            type: 'target-query',
            createdBy: 'agent',
            logicalKey: `target-query:${analysisContextId}`,
            data,
            metadata: { sceneId: parsed.sceneId, analysisContextId, sourceAssetIds: parsed.selectedAssetIds },
          }],
          statePatch: { phase: 'target-query-planned', analysisContextId, targetDescription: parsed.targetDescription },
        }
      },
    },
    {
      name: 'execute_target_query',
      description: 'Deterministically execute the current validated target query and publish the matched Point GeoJSON into the scene',
      risk: 'control',
      inputSchema: {
        type: 'object',
        additionalProperties: false,
        required: ['analysisContextId'],
        properties: { analysisContextId: { type: 'string' } },
      },
      async execute(input, context) {
        const { analysisContextId } = analysisContextSchema.parse(input)
        const artifact = context.artifacts.get(targetQueryArtifactId(analysisContextId))
        if (!artifact || artifact.type !== 'target-query') throw new Error('Target query artifact not found')
        const query = artifact.data as {
          sceneId: string
          selectedAssetIds: string[]
          targetDescription: string
          conditions: Array<{ field: string; operator: string; value: unknown }>
          analysisContextId: string
        }
        const existingAnalysis = context.artifacts.get(targetAnalysisArtifactId(query.analysisContextId))
        if (existingAnalysis) {
          return {
            content: JSON.stringify({
              ...(existingAnalysis.data as Record<string, unknown>),
              evidenceReused: true,
              nextAction: {
                tool: 'present_target_result',
                input: { analysisContextId: query.analysisContextId },
              },
            }),
          }
        }
        const result = await client.runTargetQuery({
          sceneId: query.sceneId,
          sourceAssetIds: query.selectedAssetIds,
          targetDescription: query.targetDescription,
          conditions: query.conditions,
        }) as Record<string, unknown>
        if (result.analysisContextId !== query.analysisContextId) {
          throw new Error('Backend analysis context does not match the validated target query')
        }
        const publishedQuery = await client.publishGeneratedFile({
          sceneId: query.sceneId,
          jobId: query.analysisContextId,
          artifactType: 'target-query',
          name: 'target-query.json',
          content: JSON.stringify(query, null, 2),
          fileFormat: 'json',
          note: `Validated target query for ${query.targetDescription}`,
        })
        const publishedAnalysis = await client.publishGeneratedFile({
          sceneId: query.sceneId,
          jobId: query.analysisContextId,
          artifactType: 'target-analysis',
          name: 'target-analysis.json',
          content: JSON.stringify(result, null, 2),
          fileFormat: 'json',
          note: `Deterministic target analysis for ${query.targetDescription}`,
        })
        const outputAsset = result.outputAsset as { id?: string } | undefined
        return {
          content: JSON.stringify({
            ...result,
            nextAction: {
              tool: 'present_target_result',
              input: { analysisContextId: query.analysisContextId },
            },
          }),
          artifacts: [
            {
              id: targetAnalysisArtifactId(query.analysisContextId),
              type: 'target-analysis',
              createdBy: 'tool',
              logicalKey: `target-analysis:${query.analysisContextId}`,
              data: result,
              metadata: {
                sceneId: query.sceneId,
                analysisContextId: query.analysisContextId,
                sourceAssetIds: query.selectedAssetIds,
              outputAssetId: outputAsset?.id,
              publishedQuery,
              publishedAnalysis,
            },
            },
            {
              type: 'generated-target-geojson',
              createdBy: 'tool',
              logicalKey: `generated-target-geojson:${query.analysisContextId}`,
              data: outputAsset,
              metadata: {
                sceneId: query.sceneId,
                analysisContextId: query.analysisContextId,
                sourceAssetIds: query.selectedAssetIds,
                outputAssetId: outputAsset?.id,
              },
            },
          ],
          statePatch: {
            phase: 'target-analysis-complete',
            analysisContextId: query.analysisContextId,
            outputAssetId: outputAsset?.id,
            matchedFeatureCount: result.matchedFeatureCount,
          },
        }
      },
    },
    {
      name: 'present_target_result',
      description: 'Create a map presentation artifact that tells the frontend to highlight and fit the generated target result',
      risk: 'control',
      inputSchema: {
        type: 'object',
        additionalProperties: false,
        required: ['analysisContextId'],
        properties: { analysisContextId: { type: 'string' } },
      },
      async execute(input, context) {
        const { analysisContextId } = analysisContextSchema.parse(input)
        const analysis = context.artifacts.get(targetAnalysisArtifactId(analysisContextId))
        if (!analysis || analysis.type !== 'target-analysis') throw new Error('Target analysis artifact not found')
        const data = analysis.data as Record<string, unknown>
        const outputAsset = data.outputAsset as { id?: string } | undefined
        if (!outputAsset?.id) throw new Error('Target analysis did not publish an output GeoJSON asset')
        const existingPresentation = context.artifacts.get(mapPresentationArtifactId(analysisContextId))
        if (existingPresentation) {
          return {
            content: JSON.stringify({
              ...(existingPresentation.data as Record<string, unknown>),
              evidenceReused: true,
            }),
            statePatch: { phase: 'target-presented' },
          }
        }
        const presentation = {
          sceneId: data.sceneId,
          analysisContextId: data.analysisContextId,
          view: 'split',
          fitBounds: true,
          title: data.targetDescription,
          layers: [{
            assetId: outputAsset.id,
            role: 'target-highlight',
            visible: true,
            style: { circleColor: '#ef4444', circleRadius: 8, circleStrokeColor: '#991b1b' },
          }],
        }
        return {
          content: JSON.stringify(presentation),
          artifacts: [{
            id: mapPresentationArtifactId(String(data.analysisContextId)),
            type: 'map-presentation',
            createdBy: 'tool',
            logicalKey: `map-presentation:${String(data.analysisContextId)}`,
            data: presentation,
            metadata: {
              sceneId: data.sceneId,
              analysisContextId: data.analysisContextId,
              sourceAssetIds: data.sourceAssetIds,
              outputAssetId: outputAsset.id,
            },
          }],
          statePatch: { phase: 'target-presented' },
        }
      },
    },
  ]
}

function vectorCandidates(value: unknown): VectorProfile[] {
  if (!value || typeof value !== 'object') return []
  const candidates = (value as { candidates?: unknown }).candidates
  return Array.isArray(candidates) ? candidates as VectorProfile[] : []
}

function targetQueryArtifactId(analysisContextId: string): string {
  return `target-query:${analysisContextId}`
}

function targetAnalysisArtifactId(analysisContextId: string): string {
  return `target-analysis:${analysisContextId}`
}

function mapPresentationArtifactId(analysisContextId: string): string {
  return `map-presentation:${analysisContextId}`
}

function currentProfiles(context: AgentContext, sceneId: string): VectorProfile[] {
  const artifact = [...context.artifacts.list('vector-property-profile')]
    .reverse()
    .find(item => item.metadata?.sceneId === sceneId)
  if (!artifact) throw new Error('Inspect current scene vector data before selecting or planning a target')
  return vectorCandidates(artifact.data)
}

function latestArtifact(context: AgentContext, type: string, sceneId?: string): Artifact {
  const artifact = [...context.artifacts.list(type)]
    .reverse()
    .find(item => !sceneId || item.metadata?.sceneId === sceneId)
  if (!artifact) throw new Error(`Required artifact is missing: ${type}`)
  return artifact
}

function selectAssetIds(
  timeIntent: 'latest' | 'specific-date' | 'all',
  requestedDate: string | undefined,
  candidates: Array<{ assetId: string; interpretedDate: string }>,
): string[] {
  if (timeIntent === 'all') return candidates.map(candidate => candidate.assetId)
  if (timeIntent === 'specific-date') {
    if (!requestedDate) throw new Error('specific-date selection requires requestedDate')
    const selected = candidates.filter(candidate => candidate.interpretedDate === requestedDate)
    if (!selected.length) throw new Error(`No dataset was interpreted as date ${requestedDate}`)
    return selected.map(candidate => candidate.assetId)
  }
  const latestDate = [...candidates].sort((left, right) => right.interpretedDate.localeCompare(left.interpretedDate))[0]?.interpretedDate
  const selected = candidates.filter(candidate => candidate.interpretedDate === latestDate)
  if (selected.length !== 1) throw new Error(`Latest dataset is ambiguous for date ${latestDate}; ask the user to choose`)
  return [selected[0].assetId]
}

function validateTargetConditions(
  profiles: VectorProfile[],
  selectedAssetIds: string[],
  conditions: Array<z.infer<typeof conditionSchema>>,
): void {
  const selected = new Set(selectedAssetIds)
  const fields = new Map<string, { types: Set<string>; samples: Set<unknown>; samplesComplete: boolean }>()
  for (const profile of profiles.filter(item => selected.has(item.assetId))) {
    for (const field of profile.profile?.fields ?? []) {
      const entry = fields.get(field.name) ?? { types: new Set(), samples: new Set(), samplesComplete: true }
      entry.types.add(field.inferred_type)
      for (const sample of field.sampled_values ?? []) entry.samples.add(sample)
      entry.samplesComplete &&= field.sampled_values_complete === true
      fields.set(field.name, entry)
    }
  }
  for (const condition of conditions) {
    const field = fields.get(condition.field)
    if (!field) throw new Error(`Unknown target field: ${condition.field}`)
    if (
      ['greater-than', 'greater-than-or-equal', 'less-than', 'less-than-or-equal'].includes(condition.operator) &&
      (!field.types.has('number') || typeof condition.value !== 'number')
    ) {
      throw new Error(`Numeric comparison is incompatible with field ${condition.field}`)
    }
    if (condition.operator === 'in' && !Array.isArray(condition.value)) {
      throw new Error(`Operator in requires an array for field ${condition.field}`)
    }
    if (condition.operator === 'contains' && typeof condition.value !== 'string') {
      throw new Error(`Operator contains requires a string for field ${condition.field}`)
    }
    const exactValues = condition.operator === 'in'
      ? condition.value as Array<string | number | boolean>
      : condition.operator === 'equals'
        ? [condition.value as string | number | boolean]
        : []
    if (exactValues.length && field.samplesComplete) {
      const unsupported = exactValues.filter(value => !field.samples.has(value))
      if (unsupported.length) {
        throw new Error(`Values are not present in the selected data profile for ${condition.field}: ${unsupported.join(', ')}`)
      }
    }
    if (exactValues.length && field.types.size === 1 && !field.types.has('mixed') && !field.types.has('null')) {
      const expectedType = [...field.types][0]
      const incompatible = exactValues.filter(value => propertyType(value) !== expectedType)
      if (incompatible.length) {
        throw new Error(`Values are type-incompatible with field ${condition.field}: ${incompatible.join(', ')}`)
      }
    }
    if (condition.operator === 'contains' && !field.types.has('string')) {
      throw new Error(`Operator contains requires a string field: ${condition.field}`)
    }
  }
}

function conditionJsonSchema(): Record<string, unknown> {
  return {
    type: 'object',
    additionalProperties: false,
    required: ['field', 'operator', 'value'],
    properties: {
      field: { type: 'string' },
      operator: {
        type: 'string',
        enum: ['equals', 'in', 'contains', 'greater-than', 'greater-than-or-equal', 'less-than', 'less-than-or-equal'],
      },
      value: {
        anyOf: [
          { type: 'string' },
          { type: 'number' },
          { type: 'boolean' },
          { type: 'array', items: { anyOf: [{ type: 'string' }, { type: 'number' }, { type: 'boolean' }] } },
        ],
      },
    },
  }
}

function hash(value: unknown): string {
  return createHash('sha256').update(stableStringify(value)).digest('hex')
}

function propertyType(value: unknown): string {
  if (typeof value === 'number') return 'number'
  if (typeof value === 'string') return 'string'
  if (typeof value === 'boolean') return 'boolean'
  return 'mixed'
}

function stableStringify(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stableStringify).join(',')}]`
  if (value && typeof value === 'object') {
    return `{${Object.entries(value as Record<string, unknown>)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([key, item]) => `${JSON.stringify(key)}:${stableStringify(item)}`)
      .join(',')}}`
  }
  return JSON.stringify(value)
}
