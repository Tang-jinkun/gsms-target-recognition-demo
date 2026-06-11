import { z } from 'zod'
import type { AgentTool } from '@gsms/agent-core'
import { buildTool } from './buildTool.ts'
import { GsmsClient } from '../gsms/GsmsClient.ts'
import { adaptGsmsModelSchema } from '../gsms/modelSchemaAdapter.ts'
import {
  dataCardSchema,
  modelInputSchemaSchema,
  relationCheckSchema,
  type DataCard,
} from '../domain/schemas.ts'
import { computeMatchingContextId, computeSceneDataContextId } from './matchingTools.ts'
import { retrieveCandidates } from '../matching/primitives.ts'
import { checkDataMatchingGate } from '../gates/dataMatchingGate.ts'

const modelSchema = z.object({ modelId: z.string().min(1) })
const sceneSchema = z.object({ sceneId: z.string().min(1) })
const discoverDataHubSchema = z.object({
  sceneId: z.string().min(1),
  modelId: z.string().min(1),
  query: z.string().default(''),
  folderId: z.string().min(1).optional(),
  studyAreaBounds: z.array(z.number()).length(4).optional(),
  limitPerSlot: z.number().int().min(1).max(10).default(3),
})
const importDataHubSchema = z.object({
  sceneId: z.string().min(1),
  fileIds: z.array(z.string().min(1)).min(1),
  selections: z.array(z.object({
    slot: z.string().min(1),
    fileId: z.string().min(1),
    name: z.string().optional(),
    confidence: z.string().optional(),
    score: z.number().optional(),
    reasons: z.array(z.string()).optional(),
    risks: z.array(z.string()).optional(),
  })).default([]),
})
const relationSchema = z.object({
  kind: z.string().min(1),
  leftAssetId: z.string().min(1),
  rightAssetId: z.string().min(1),
  field: z.string().min(1).optional(),
})
const validateBindingsSchema = z.object({
  modelId: z.string().min(1),
  sceneId: z.string().min(1),
  parameters: z.record(z.string(), z.unknown()).default({}),
})
const confirmSnapshotSchema = z.object({
  snapshotId: z.string().min(1),
  confirmed: z.boolean(),
})
const executeSnapshotSchema = z.object({
  snapshotId: z.string().min(1),
  runMode: z.enum(['auto', 'real']).default('real'),
})
const jobSchema = z.object({
  sceneId: z.string().min(1),
  jobId: z.string().min(1),
})

function requireCurrentSnapshot(
  context: Parameters<AgentTool['execute']>[1],
  snapshotId: string,
): Record<string, unknown> {
  const state = context.domainState.snapshot()
  if (state.validationSnapshotId !== snapshotId) {
    throw new Error('Snapshot does not match the latest validated plan')
  }
  return state
}

function requireCurrentJob(
  context: Parameters<AgentTool['execute']>[1],
  sceneId: string,
  jobId: string,
): Record<string, unknown> {
  const state = context.domainState.snapshot()
  if (state.sceneId !== sceneId || state.jobId !== jobId) {
    throw new Error('Job does not match the current Agent run')
  }
  return state
}

function normalizeDataCards(result: unknown): DataCard[] {
  if (!result || typeof result !== 'object') return []
  const cards = (result as { data_cards?: unknown }).data_cards
  if (!Array.isArray(cards)) return []
  return cards.flatMap(raw => {
    if (!raw || typeof raw !== 'object') return []
    const source = raw as Record<string, unknown>
    const metadata =
      source.metadata && typeof source.metadata === 'object'
        ? (source.metadata as Record<string, unknown>)
        : {}
    const assetType = source.asset_type === 'table'
      ? 'csv'
      : source.asset_type === 'geojson'
        ? 'vector'
        : source.asset_type
    if (!['raster', 'vector', 'csv'].includes(String(assetType))) return []
    const columns = Array.isArray(metadata.columns) ? metadata.columns.map(String) : []
    const rows = Array.isArray(metadata.sample_rows) ? metadata.sample_rows : []
    const card = {
      assetId: String(source.asset_id),
      path: String(source.path),
      assetType,
      filename: String(source.filename),
      semanticHints: Array.isArray(source.semantic_hints)
        ? source.semantic_hints.map(String)
        : [],
      spatial:
        metadata.crs || metadata.bounds || metadata.width || metadata.height
          ? {
              crs: metadata.crs ? String(metadata.crs) : undefined,
              bounds: Array.isArray(metadata.bounds) ? metadata.bounds : undefined,
              width: typeof metadata.width === 'number' ? metadata.width : undefined,
              height: typeof metadata.height === 'number' ? metadata.height : undefined,
            }
          : undefined,
      tabular:
        assetType === 'csv'
          ? {
              fields: columns.map((name, index) => ({
                name,
                sampledValues: rows
                  .filter(Array.isArray)
                  .map(row => row[index])
                  .filter(value =>
                    ['string', 'number', 'boolean'].includes(typeof value) || value === null,
                  ),
              })),
              rowCount: typeof metadata.row_count === 'number' ? metadata.row_count : undefined,
            }
          : undefined,
      raster:
        assetType === 'raster'
          ? {
              bands: typeof metadata.band_count === 'number' ? metadata.band_count : 1,
              dataType: Array.isArray(metadata.dtypes) ? String(metadata.dtypes[0]) : undefined,
              nodata: typeof metadata.nodata === 'number' ? metadata.nodata : undefined,
            }
          : undefined,
      provenance: {
        source: 'user-local',
        fingerprint: JSON.stringify(source.provenance ?? { path: source.path }),
      },
    }
    return [dataCardSchema.parse(card)]
  })
}

export function createGsmsTools(client: GsmsClient): AgentTool[] {
  return [
    buildTool({
      name: 'list_invest_models',
      description: 'List model schemas registered by the GSMS scientific runtime',
      persistResultAboveBytes: 8_000,
      inputSchema: { type: 'object', additionalProperties: false },
      async execute() {
        const models = await client.listModels()
        return {
          content: JSON.stringify(models),
          artifacts: [{ type: 'gsms-model-list', logicalKey: 'gsms-model-list', createdBy: 'tool', data: models }],
        }
      },
    }),
    buildTool({
      name: 'get_invest_model_schema',
      description: 'Select the current InVEST model, load its authoritative GSMS schema, and reset stale state from any previously selected model',
      persistResultAboveBytes: 8_000,
      inputSchema: {
        type: 'object',
        additionalProperties: false,
        required: ['modelId'],
        properties: { modelId: { type: 'string' } },
      },
      async execute(input, context) {
        const { modelId } = modelSchema.parse(input)
        const schema = await client.getModelSchema(modelId)
        const adapted = adaptGsmsModelSchema(schema)

        // Data cards are keyed by sceneDataContextId (model-independent), so they
        // survive model switches. Compute matchingContextId (model-specific) for
        // candidate-set / binding-report scoping, using existing data cards if loaded.
        const existingCards = context.artifacts.list('data-card')
        const sceneId = context.domainState.snapshot().sceneId
        let matchingContextId: string | null = null
        if (existingCards.length && typeof sceneId === 'string') {
          const cards = existingCards
            .filter(a => a.metadata?.sceneId === sceneId)
            .map(a => dataCardSchema.safeParse(a.data))
            .filter(r => r.success)
            .map(r => r.data)
          if (cards.length) {
            matchingContextId = computeMatchingContextId(sceneId, adapted, cards)
          }
        }

        return {
          content: JSON.stringify(schema),
          artifacts: [
            {
              type: 'gsms-model-schema',
              logicalKey: `gsms-model-schema:${modelId}`,
              createdBy: 'tool',
              data: schema,
              metadata: { modelId },
            },
            {
              type: 'model-input-schema',
              logicalKey: `model-input-schema:${modelId}`,
              createdBy: 'tool',
              data: adapted,
              metadata: { modelId, source: 'gsms' },
            },
          ],
          statePatch: {
            modelId,
            phase: 'discovering-data',
            matchingContextId,
            slots: null,
            bindingStatus: null,
            validationStatus: null,
            validationSnapshotId: null,
            confirmationStatus: null,
            jobId: null,
            jobStatus: null,
            outputCount: null,
            reportPath: null,
          },
        }
      },
    }),
    buildTool({
      name: 'list_scene_data_cards',
      description: 'Load factual data cards for files imported into a GSMS scene',
      persistResultAboveBytes: 6_000,
      inputSchema: {
        type: 'object',
        additionalProperties: false,
        required: ['sceneId'],
        properties: { sceneId: { type: 'string' } },
      },
      async execute(input, context) {
        const { sceneId } = sceneSchema.parse(input)
        const result = await client.listSceneDataCards(sceneId)
        const cards = normalizeDataCards(result)
        // Data cards are keyed by sceneDataContextId (model-independent) so they
        // survive model switches. matchingContextId is still computed for backward
        // compat (e.g. old artifacts in flight) but NOT used to filter data cards.
        const schemaArtifact = tryContextModelSchema(context)
        const sceneDataContextId = computeSceneDataContextId(sceneId, cards)
        const matchingContextId = computeMatchingContextId(sceneId, schemaArtifact, cards)
        const refreshesDataHubImport = context.artifacts
          .list()
          .some(artifact =>
            (artifact.type === 'scene-import-record' ||
              artifact.metadata?.mutationTool === 'import_data_hub_files_to_scene') &&
            artifact.metadata?.sceneId === sceneId,
          )
        const refreshMetadata = refreshesDataHubImport
          ? { refreshedAfterMutation: true, refreshedAfterImport: true }
          : {}
        return {
          content: JSON.stringify(result),
          artifacts: [
            {
              type: 'gsms-scene-data-cards',
              logicalKey: `gsms-scene-data-cards:${sceneDataContextId}`,
              createdBy: 'tool',
              data: result,
              metadata: { sceneId, modelId: schemaArtifact?.modelId, sceneDataContextId, ...refreshMetadata },
            },
            ...cards.map(card => ({
              type: 'data-card',
              logicalKey: `data-card:${sceneDataContextId}:${card.assetId}`,
              createdBy: 'tool' as const,
              data: card,
              metadata: {
                sceneId,
                modelId: schemaArtifact?.modelId,
                sceneDataContextId,
                assetId: card.assetId,
                ...refreshMetadata,
              },
            })),
          ],
          statePatch: {
            sceneId,
            assetIds: cards.map(card => card.assetId),
            sceneDataContextId,
            matchingContextId,
          },
        }
      },
    }),
    buildTool({
      name: 'discover_data_hub_candidates',
      description: 'Search global Data Hub metadata for model input candidates when the current scene has missing data; returns an import proposal and does not modify the scene',
      persistResultAboveBytes: 8_000,
      inputSchema: {
        type: 'object',
        additionalProperties: false,
        required: ['sceneId', 'modelId'],
        properties: {
          sceneId: { type: 'string' },
          modelId: { type: 'string' },
          query: { type: 'string' },
          folderId: { type: 'string' },
          studyAreaBounds: { type: 'array', minItems: 4, maxItems: 4, items: { type: 'number' } },
          limitPerSlot: { type: 'number', minimum: 1, maximum: 10 },
        },
      },
      async execute(input, context) {
        const parsed = discoverDataHubSchema.parse(input)
        const state = context.domainState.snapshot()
        if (state.modelId && state.modelId !== parsed.modelId) {
          throw new Error(`Discovery model ${parsed.modelId} does not match selected model ${String(state.modelId)}`)
        }
        const result = await client.discoverDataHubCandidates(parsed)
        const source = result as {
          recommended_file_ids?: unknown
          slots?: unknown
          missing_slots?: unknown
          ambiguous_slots?: unknown
        }
        const recommendedFileIds = Array.isArray(source.recommended_file_ids)
          ? source.recommended_file_ids.map(String)
          : []
        const proposedFileIds = Array.isArray(source.slots)
          ? source.slots.flatMap(slot => {
              if (!slot || typeof slot !== 'object') return []
              const candidates = (slot as { candidates?: unknown }).candidates
              if (!Array.isArray(candidates)) return []
              return candidates.flatMap(candidate => {
                if (!candidate || typeof candidate !== 'object') return []
                const fileId = (candidate as Record<string, unknown>).file_id
                return typeof fileId === 'string' ? [fileId] : []
              })
            })
          : []
        const selections = Array.isArray(source.slots)
          ? source.slots.flatMap(slot => {
              if (!slot || typeof slot !== 'object') return []
              const slotRecord = slot as { slot?: unknown; ambiguous?: unknown; candidates?: unknown }
              if (!Array.isArray(slotRecord.candidates)) return []
              const first = slotRecord.candidates[0]
              if (!first || typeof first !== 'object') return []
              const candidate = first as Record<string, unknown>
              const fileId = candidate.file_id
              if (typeof fileId !== 'string') return []
              return [{
                slot: String(slotRecord.slot ?? ''),
                fileId,
                name: typeof candidate.name === 'string' ? candidate.name : undefined,
                score: typeof candidate.score === 'number' ? candidate.score : undefined,
                confidence: typeof candidate.confidence === 'string' ? candidate.confidence : undefined,
                reasons: Array.isArray(candidate.reasons) ? candidate.reasons.map(String) : [],
                risks: Array.isArray(candidate.risks) ? candidate.risks.map(String) : [],
              }]
            })
          : []
        const proposalKey = `data-hub-import-proposal:${parsed.sceneId}:${parsed.modelId}`
        const confirmationProposalKey = `confirmation-proposal:import_data_hub_files_to_scene:${parsed.sceneId}:${parsed.modelId}`
        const discoveryReportKey = `data-source-discovery-report:data-hub:${parsed.sceneId}:${parsed.modelId}`
        const commonMetadata = {
          sceneId: parsed.sceneId,
          modelId: parsed.modelId,
          providerId: 'data-hub',
          discoveryTool: 'discover_data_hub_candidates',
          actionTool: 'import_data_hub_files_to_scene',
          recommendedFileIds,
          proposedFileIds: [...new Set(proposedFileIds)],
          missingSlots: Array.isArray(source.missing_slots) ? source.missing_slots.map(String) : [],
          ambiguousSlots: Array.isArray(source.ambiguous_slots) ? source.ambiguous_slots.map(String) : [],
        }
        return {
          content: JSON.stringify(result),
          artifacts: [
            {
              type: 'data-source-discovery-report',
              logicalKey: discoveryReportKey,
              createdBy: 'tool',
              data: {
                providerId: 'data-hub',
                providerName: 'Data Hub',
                sceneId: parsed.sceneId,
                modelId: parsed.modelId,
                query: parsed.query,
                folderId: parsed.folderId ?? null,
                studyAreaBounds: parsed.studyAreaBounds ?? null,
                slots: source.slots,
                recommendedFileIds,
                proposedFileIds: [...new Set(proposedFileIds)],
                missingSlots: commonMetadata.missingSlots,
                ambiguousSlots: commonMetadata.ambiguousSlots,
              },
              metadata: { ...commonMetadata },
            },
            {
              type: 'confirmation-proposal',
              logicalKey: confirmationProposalKey,
              createdBy: 'tool',
              data: {
                kind: 'data-import-proposal',
                actionTool: 'import_data_hub_files_to_scene',
                providerId: 'data-hub',
                sceneId: parsed.sceneId,
                modelId: parsed.modelId,
                fileIds: [...new Set(proposedFileIds)],
                selections,
                slots: source.slots,
                ui: {
                  type: 'data-import-proposal',
                  title: '推荐导入 Data Hub 文件',
                  description: 'Agent 找到这些文件可能适合当前模型输入。确认后只会把 Data Hub 文件引用写入当前场景，不复制文件。',
                  fileIds: [...new Set(proposedFileIds)],
                  rows: selections.map(selection => ({
                    id: selection.fileId,
                    slot: selection.slot,
                    fileId: selection.fileId,
                    label: selection.name ?? selection.fileId,
                    confidence: selection.confidence,
                    score: selection.score,
                    reasons: selection.reasons,
                    risks: selection.risks,
                  })),
                  actions: {
                    approveLabel: '全部导入',
                    rejectLabel: '取消',
                    allowPartial: true,
                  },
                },
              },
              metadata: { ...commonMetadata },
            },
            {
              type: 'data-hub-import-proposal',
              logicalKey: proposalKey,
              createdBy: 'tool',
              data: {
                ...(result as Record<string, unknown>),
                selections,
              },
              metadata: { ...commonMetadata },
            },
          ],
          statePatch: {
            sceneId: parsed.sceneId,
            modelId: parsed.modelId,
            phase: proposedFileIds.length ? 'awaiting-data-import-confirmation' : 'discovering-data',
            dataHubRecommendedFileIds: recommendedFileIds,
          },
          hiddenMessages: [{
            role: 'user',
            hidden: true,
            content: proposedFileIds.length
              ? `Data Hub discovery found import candidates for ${parsed.modelId}. Ask the user to confirm importing these Data Hub file references before calling import_data_hub_files_to_scene. Do not claim the scene has no data.`
              : `Data Hub discovery found no complete import recommendation. Explain missing slots or ambiguities and ask the user to narrow the search or choose candidates.`,
          }],
        }
      },
    }),
    {
      name: 'import_data_hub_files_to_scene',
      description: 'Import selected Data Hub file references into the current scene after explicit user confirmation; does not copy files',
      risk: 'write',
      policy: {
        confirmation: {
          approvedAction: 'execute-approved-input',
          summary(input) {
            if (!input || typeof input !== 'object') return undefined
            const source = input as {
              sceneId?: unknown
              fileIds?: unknown
              selections?: unknown
            }
            return {
              kind: 'data-hub-import-proposal',
              sceneId: typeof source.sceneId === 'string' ? source.sceneId : undefined,
              fileIds: Array.isArray(source.fileIds) ? source.fileIds.map(String) : [],
              selections: Array.isArray(source.selections) ? source.selections : [],
            }
          },
          ui(input) {
            if (!input || typeof input !== 'object') return undefined
            const source = input as {
              fileIds?: unknown
              selections?: unknown
            }
            const fileIds = Array.isArray(source.fileIds) ? source.fileIds.map(String) : []
            const selections = Array.isArray(source.selections)
              ? source.selections.flatMap(item => {
                  if (!item || typeof item !== 'object') return []
                  const row = item as Record<string, unknown>
                  if (typeof row.slot !== 'string' || typeof row.fileId !== 'string') return []
                  return [{
                    id: row.fileId,
                    slot: row.slot,
                    fileId: row.fileId,
                    label: typeof row.name === 'string' ? row.name : row.fileId,
                    confidence: typeof row.confidence === 'string' ? row.confidence : undefined,
                    score: typeof row.score === 'number' ? row.score : undefined,
                    reasons: Array.isArray(row.reasons) ? row.reasons.map(String) : [],
                    risks: Array.isArray(row.risks) ? row.risks.map(String) : [],
                  }]
                })
              : []
            return {
              type: 'data-import-proposal',
              title: '推荐导入 Data Hub 文件',
              description: 'Agent 找到这些文件可能适合当前模型输入。确认后只会把 Data Hub 文件引用写入当前场景，不复制文件。',
              fileIds,
              rows: selections.length
                ? selections
                : fileIds.map(fileId => ({ id: fileId, slot: 'input', fileId, label: fileId })),
              actions: {
                approveLabel: '全部导入',
                rejectLabel: '取消',
                allowPartial: true,
              },
            }
          },
          successMessage() {
            return [
              '已按用户确认将 Data Hub 文件引用导入当前场景，并刷新了场景数据卡片。',
              '现在可以继续重新评估 Carbon 的输入匹配；后续判断必须基于导入后的场景数据。',
            ].join('\n')
          },
        },
        mutation: {
          refreshesArtifacts: ['gsms-scene-data-cards', 'data-card'],
        },
      },
      inputSchema: {
        type: 'object',
        additionalProperties: false,
        required: ['sceneId', 'fileIds'],
        properties: {
          sceneId: { type: 'string' },
          fileIds: { type: 'array', minItems: 1, items: { type: 'string' } },
          selections: {
            type: 'array',
            items: {
              type: 'object',
              additionalProperties: false,
              required: ['slot', 'fileId'],
              properties: {
                slot: { type: 'string' },
                fileId: { type: 'string' },
                name: { type: 'string' },
                confidence: { type: 'string' },
                score: { type: 'number' },
                reasons: { type: 'array', items: { type: 'string' } },
                risks: { type: 'array', items: { type: 'string' } },
              },
            },
          },
        },
      },
      async execute(input, context) {
        const parsed = importDataHubSchema.parse(input)
        const state = context.domainState.snapshot()
        const modelId = typeof state.modelId === 'string' ? state.modelId : undefined
        const proposal = [...context.artifacts.list('confirmation-proposal')]
          .reverse()
          .find(artifact =>
            artifact.metadata?.sceneId === parsed.sceneId &&
            artifact.metadata?.actionTool === 'import_data_hub_files_to_scene' &&
            (!modelId || artifact.metadata?.modelId === modelId)) ??
          [...context.artifacts.list('data-hub-import-proposal')]
            .reverse()
            .find(artifact =>
              artifact.metadata?.sceneId === parsed.sceneId &&
              (!modelId || artifact.metadata?.modelId === modelId))
        if (!proposal) {
          throw new Error('Discover import candidates before importing files into the scene.')
        }
        const recommended = new Set(
          Array.isArray(proposal.metadata?.proposedFileIds)
            ? proposal.metadata.proposedFileIds.map(String)
            : Array.isArray(proposal.metadata?.recommendedFileIds)
              ? proposal.metadata.recommendedFileIds.map(String)
              : [],
        )
        const proposalData = proposal.data as { slots?: unknown }
        if (Array.isArray(proposalData.slots)) {
          for (const slot of proposalData.slots) {
            if (!slot || typeof slot !== 'object') continue
            const candidates = (slot as { candidates?: unknown }).candidates
            if (!Array.isArray(candidates)) continue
            for (const candidate of candidates) {
              if (!candidate || typeof candidate !== 'object') continue
              const fileId = (candidate as Record<string, unknown>).file_id
              if (typeof fileId === 'string') recommended.add(fileId)
            }
          }
        }
        const unproposed = parsed.fileIds.filter(fileId => !recommended.has(fileId))
        if (unproposed.length) {
          throw new Error(`Import includes files not present in the latest Data Hub proposal: ${unproposed.join(', ')}`)
        }
        const result = await client.importDataHubFilesToScene(parsed)
        const refreshed = await client.listSceneDataCards(parsed.sceneId)
        const cards = normalizeDataCards(refreshed)
        if (cards.length === 0) {
          throw new Error(
            `Data Hub import did not produce scene data cards. Import result: ${JSON.stringify(result)}. Stop and report this as an import/scene_imports persistence problem; do not answer that Data Hub had no candidates.`,
          )
        }
        const schemaArtifact = tryContextModelSchema(context)
        const sceneDataContextId = computeSceneDataContextId(parsed.sceneId, cards)
        const matchingContextId = computeMatchingContextId(parsed.sceneId, schemaArtifact, cards)
        return {
          content: JSON.stringify({
            import: result,
            refreshed_scene_data: refreshed,
            instruction: 'Import completed and scene data was refreshed. Continue with retrieve_required_input_candidates once using the refreshed scene data; do not use pre-import missing-data conclusions.',
          }),
          artifacts: [
            {
              type: 'scene-import-record',
              logicalKey: `scene-import-record:${parsed.sceneId}:${parsed.fileIds.sort().join(',')}`,
              createdBy: 'user',
              data: result,
              metadata: {
                sceneId: parsed.sceneId,
                modelId,
                fileIds: parsed.fileIds,
                proposalId: proposal.id,
                confirmationId: context.lastConsumedConfirmationId,
                mutationTool: 'import_data_hub_files_to_scene',
              },
            },
            {
              type: 'gsms-scene-data-cards',
              logicalKey: `gsms-scene-data-cards:${sceneDataContextId}`,
              createdBy: 'tool',
              data: refreshed,
              metadata: {
                sceneId: parsed.sceneId,
                modelId,
                sceneDataContextId,
                refreshedAfterMutation: true,
                refreshedAfterImport: true,
              },
            },
            ...cards.map(card => ({
              type: 'data-card',
              logicalKey: `data-card:${sceneDataContextId}:${card.assetId}`,
              createdBy: 'tool' as const,
              data: card,
              metadata: {
                sceneId: parsed.sceneId,
                modelId,
                sceneDataContextId,
                assetId: card.assetId,
                refreshedAfterMutation: true,
                refreshedAfterImport: true,
              },
            })),
          ],
          statePatch: {
            phase: 'discovering-data',
            assetIds: cards.map(card => card.assetId),
            sceneDataContextId,
            matchingContextId,
            slots: null,
          },
          hiddenMessages: [{
            role: 'user',
            hidden: true,
            content: `Data Hub files were imported by reference and scene data cards were refreshed. You must ignore any pre-import missing-data conclusion. Continue by calling retrieve_required_input_candidates once for model "${modelId ?? 'the current model'}" using matchingContextId "${matchingContextId}". Do not invent *_asset_id slot names and do not call retrieve_input_candidates in parallel.`,
          }],
        }
      },
    },
    {
      name: 'check_data_relation',
      description: 'Ask GSMS to deterministically check a relation between two data assets',
      risk: 'read',
      inputSchema: {
        type: 'object',
        additionalProperties: false,
        required: ['kind', 'leftAssetId', 'rightAssetId'],
        properties: {
          kind: { type: 'string' },
          leftAssetId: { type: 'string' },
          rightAssetId: { type: 'string' },
          field: { type: 'string' },
        },
      },
      async execute(input, context) {
        const parsed = relationSchema.parse(input)
        const modelId = context.domainState.snapshot().modelId
        const matchingContextId = context.domainState.snapshot().matchingContextId
        if (typeof modelId !== 'string') {
          throw new Error('Select an InVEST model before checking data relations')
        }
        if (typeof matchingContextId !== 'string') {
          throw new Error('Load current scene data before checking data relations')
        }
        const result = await client.checkRelation(parsed)
        const source = result as Record<string, unknown>
        const check = relationCheckSchema.parse({
          id:
            source.id ??
            `${parsed.kind}:${parsed.leftAssetId}:${parsed.rightAssetId}:${parsed.field ?? 'lucode'}`,
          kind: source.kind ?? parsed.kind,
          leftAssetId: source.left_asset_id ?? parsed.leftAssetId,
          rightAssetId: source.right_asset_id ?? parsed.rightAssetId,
          status: source.status,
          facts: source.facts ?? [],
          missingValues: source.missing_values,
        })
        const relationArtifactId = `relation-check:${matchingContextId}:${check.id}`
        const existing = context.artifacts.get(relationArtifactId)
        if (existing) {
          const existingCheck = relationCheckSchema.parse(existing.data)
          if (canonical(existingCheck) !== canonical(check)) {
            throw new Error(
              `Relation check result changed for ${check.id}; rebuild the binding evidence before proceeding`,
            )
          }
          return {
            content: JSON.stringify({
              ...(result as Record<string, unknown>),
              evidence_reused: true,
              evidence_artifact_id: relationArtifactId,
            }),
            hiddenMessages: [{
              role: 'user',
              hidden: true,
              content:
                `The relation was freshly checked and matches persisted evidence "${relationArtifactId}". Treat status "${check.status}" as current; do not call check_data_relation again for the same assets.`,
            }],
          }
        }
        return {
          content: JSON.stringify(result),
          artifacts: [
            {
              type: 'gsms-relation-check',
              logicalKey: `gsms-relation-check:${matchingContextId}:${check.id}`,
              createdBy: 'tool',
              data: result,
              metadata: {
                modelId,
                sceneId: context.domainState.snapshot().sceneId,
                matchingContextId,
              },
            },
            {
              id: relationArtifactId,
              type: 'relation-check',
              createdBy: 'tool',
              data: check,
              metadata: {
                modelId,
                sceneId: context.domainState.snapshot().sceneId,
                matchingContextId,
              },
            },
          ],
        }
      },
    },
    {
      name: 'validate_binding_report',
      description: 'Validate the latest Binding Report once using authoritative GSMS checks; after success, request user confirmation instead of repeating validation',
      risk: 'read',
      inputSchema: {
        type: 'object',
        additionalProperties: false,
        required: ['modelId', 'sceneId'],
        properties: {
          modelId: { type: 'string' },
          sceneId: { type: 'string' },
          parameters: { type: 'object' },
        },
      },
      async execute(input, context) {
        const parsed = validateBindingsSchema.parse(input)
        const state = context.domainState.snapshot()
        if (state.modelId !== parsed.modelId) {
          throw new Error(
            `Validation model ${parsed.modelId} does not match the selected model ${String(state.modelId ?? 'none')}`,
          )
        }
        if (
          state.phase === 'awaiting-user-confirmation' &&
          typeof state.validationSnapshotId === 'string'
        ) {
          return {
            content: JSON.stringify({
              status: 'already-validated',
              snapshot_id: state.validationSnapshotId,
              next_action: 'call confirm_validation_snapshot to request explicit user approval',
            }),
            hiddenMessages: [{
              role: 'user',
              hidden: true,
              content:
                `Do not validate again. Call confirm_validation_snapshot with snapshotId "${state.validationSnapshotId}" and confirmed true. The permission system will pause and ask the user before recording approval.`,
            }],
          }
        }
        const report = [...context.artifacts.list('binding-report')]
          .reverse()
          .find(artifact =>
            artifact.metadata?.modelId === parsed.modelId &&
            artifact.metadata?.matchingContextId === state.matchingContextId)
        if (!report) throw new Error('Submit a Binding Report before validation')

        // DataMatchingGate: check the gate result stored in binding report metadata.
        // The gate ran inside finalize_data_matching; we just verify the status.
        // If no gate result exists (older reports), allow validation to proceed.
        const gatePassed = report.metadata?.gatePassed
        if (gatePassed === false) {
          // Re-run the gate against current evidence to get precise, actionable
          // reasons (the report only stores a coarse status in metadata).
          const gate = checkDataMatchingGate(context)
          const ambiguousSlots = gate.slotStatuses
            .filter(s => s.required && s.decisionStatus === 'ambiguous')
            .map(s => s.slot)
          const needsUserChoice = gate.status === 'needs_review' || ambiguousSlots.length > 0

          // Guide the model toward the SINGLE correct next action instead of
          // letting it loop validate → finalize → sufficiency. When the block is
          // an unresolved ambiguity, the only way forward is a user decision.
          const guidance = needsUserChoice
            ? `Cannot validate: ${gate.blockingReasons.join('; ') || 'matching has unresolved ambiguity'}. Stop validating. Ask the user to choose for the ambiguous slot(s): ${ambiguousSlots.join(', ') || '(see reasons)'}. Do not call validate_binding_report, confirm_validation_snapshot, or finalize_sufficiency_assessment again until the user answers.`
            : `Cannot validate: ${gate.blockingReasons.join('; ') || `gate status is '${gate.status}'`}. Gather the missing evidence (retrieve candidates / run the required relation checks), then re-finalize. Do not re-validate unchanged.`

          return {
            content: JSON.stringify({
              status: 'gate-blocked',
              gateStatus: gate.status,
              blockingReasons: gate.blockingReasons,
              ambiguousSlots,
              instruction: guidance,
            }),
            diagnostics: [{
              code: 'DATA_MATCHING_GATE_BLOCKED',
              message: `Binding report gate status is '${gate.status}' — must be 'ready_for_validation' to validate.`,
              severity: 'error' as const,
            }],
            hiddenMessages: [{
              role: 'user',
              hidden: true,
              content: needsUserChoice
                ? `Validation is blocked by an unresolved ambiguity in slot(s) ${ambiguousSlots.join(', ') || '(see reasons)'}. Present the competing candidates to the user and ask which one to use. Then re-run finalize_data_matching for that slot with the chosen asset and userConfirmed:true. Do NOT validate, confirm, or run sufficiency until the user has chosen.`
                : `Validation is blocked: ${gate.blockingReasons.join('; ')}. Collect the missing evidence and re-finalize before validating again. Do not repeat validation unchanged.`,
            }],
          }
        }
        const result = await client.validateBindings({
          ...parsed,
          bindingReport: report.data,
        })
        const source = result as {
          can_proceed?: unknown
          snapshot_id?: unknown
          validation?: { errors?: unknown; warnings?: unknown }
        }
        const canProceed = source.can_proceed === true
        const errors = Array.isArray(source.validation?.errors)
          ? source.validation.errors.map(String)
          : []
        const warnings = Array.isArray(source.validation?.warnings)
          ? source.validation.warnings.map(String)
          : []
        return {
          content: JSON.stringify(result),
          artifacts: [{
            type: 'validation-report',
            logicalKey: `validation-report:${typeof state.matchingContextId === 'string' ? state.matchingContextId : parsed.modelId}`,
            createdBy: 'tool',
            data: result,
            metadata: {
              modelId: parsed.modelId,
              sceneId: parsed.sceneId,
              matchingContextId: typeof state.matchingContextId === 'string' ? state.matchingContextId : undefined,
            },
          }],
          statePatch: {
            phase: canProceed ? 'awaiting-user-confirmation' : 'validation-failed',
            validationStatus: canProceed ? 'passed' : 'failed',
            validationSnapshotId:
              typeof source.snapshot_id === 'string' ? source.snapshot_id : undefined,
          },
          diagnostics: [
            ...errors.map(message => ({
              code: 'GSMS_VALIDATION_ERROR',
              message,
              severity: 'error' as const,
            })),
            ...warnings.map(message => ({
              code: 'GSMS_VALIDATION_WARNING',
              message,
              severity: 'warning' as const,
            })),
          ],
          hiddenMessages: [{
            role: 'user',
            hidden: true,
            content: canProceed
              ? `Validation passed for snapshot "${String(source.snapshot_id)}". To prepare execution, call confirm_validation_snapshot with this snapshotId and confirmed true now. The permission system will pause and ask the user; do not repeat validation and do not claim the user already approved.`
              : 'Validation failed. Do not repeat validation unchanged. Finish as blocked and explain the validation errors to the user.',
          }],
        }
      },
    },
    {
      name: 'confirm_validation_snapshot',
      description: 'Request explicit user approval for the latest validated snapshot; the permission system pauses before approval is recorded',
      risk: 'write',
      inputSchema: {
        type: 'object',
        additionalProperties: false,
        required: ['snapshotId', 'confirmed'],
        properties: {
          snapshotId: { type: 'string' },
          confirmed: { type: 'boolean' },
        },
      },
      async execute(input, context) {
        const parsed = confirmSnapshotSchema.parse(input)
        const state = requireCurrentSnapshot(context, parsed.snapshotId)
        // Gate on validation-report artifact, not phase — phase is a workflow hint,
        // artifacts are the source of truth for what has been done.
        const hasValidationReport = context.artifacts.list('validation-report').some(
          (a: any) => a.metadata?.matchingContextId === state.matchingContextId ||
            !a.metadata?.matchingContextId,
        )
        if (!hasValidationReport) {
          throw new Error('No validation report found. Run validate_binding_report first.')
        }
        if (state.validationStatus === 'failed') {
          throw new Error('Validation failed. Fix the issues and re-validate before confirming.')
        }
        const result = await client.confirmValidationSnapshot(parsed.snapshotId, parsed.confirmed)
        return {
          content: JSON.stringify(result),
          artifacts: [{
            type: 'confirmation-record',
            logicalKey: `confirmation-record:${parsed.snapshotId}`,
            createdBy: 'user',
            data: result,
            metadata: {
              confirmationId: context.lastConsumedConfirmationId,
              snapshotId: parsed.snapshotId,
            },
          }],
          statePatch: {
            phase: parsed.confirmed ? 'confirmed-for-execution' : 'confirmation-rejected',
            confirmationStatus: parsed.confirmed ? 'confirmed' : 'rejected',
          },
        }
      },
    },
    {
      name: 'execute_validated_snapshot',
      description: 'Create one GSMS model job from the exact confirmed validation snapshot',
      risk: 'execute',
      inputSchema: {
        type: 'object',
        additionalProperties: false,
        required: ['snapshotId'],
        properties: {
          snapshotId: { type: 'string' },
          runMode: { enum: ['auto', 'real'] },
        },
      },
      async execute(input, context) {
        const parsed = executeSnapshotSchema.parse(input)
        const state = requireCurrentSnapshot(context, parsed.snapshotId)
        // Gate on confirmation-record artifact, not phase — phase is a workflow hint,
        // artifacts are the source of truth for what has been done.
        const hasConfirmationRecord = context.artifacts.list('confirmation-record').some(
          (a: any) => a.data?.snapshot_id === parsed.snapshotId || !a.data?.snapshot_id,
        )
        if (!hasConfirmationRecord) {
          throw new Error('No confirmation record found. Call confirm_validation_snapshot first.')
        }
        const result = await client.createJobFromValidationSnapshot(parsed.snapshotId, parsed.runMode)
        const source = result as { job_id?: unknown }
        return {
          content: JSON.stringify(result),
          artifacts: [{ type: 'model-job', logicalKey: `model-job:${parsed.snapshotId}`, createdBy: 'tool', data: result }],
          statePatch: {
            phase: 'job-running',
            jobId: typeof source.job_id === 'string' ? source.job_id : undefined,
          },
        }
      },
    },
    {
      name: 'get_invest_job_status',
      description: 'Refresh the status of the current GSMS InVEST job',
      risk: 'read',
      inputSchema: {
        type: 'object',
        additionalProperties: false,
        required: ['sceneId', 'jobId'],
        properties: {
          sceneId: { type: 'string' },
          jobId: { type: 'string' },
        },
      },
      async execute(input, context) {
        const parsed = jobSchema.parse(input)
        requireCurrentJob(context, parsed.sceneId, parsed.jobId)
        const result = await client.getSceneJob(parsed.sceneId, parsed.jobId)
        const source = result as { status?: unknown }
        const status = typeof source.status === 'string' ? source.status : 'unknown'
        const phase =
          status === 'succeeded'
            ? 'job-succeeded'
            : status === 'failed'
              ? 'job-failed'
              : 'job-running'
        return {
          content: JSON.stringify(result),
          artifacts: [{
            type: 'job-status',
            logicalKey: `job-status:${parsed.jobId}`,
            createdBy: 'tool',
            data: result,
            metadata: { sceneId: parsed.sceneId, jobId: parsed.jobId, status },
          }],
          statePatch: { phase, jobStatus: status },
          diagnostics:
            status === 'failed'
              ? [{
                  code: 'GSMS_JOB_FAILED',
                  message: `GSMS job ${parsed.jobId} failed`,
                  severity: 'error' as const,
                }]
              : [],
        }
      },
    },
    {
      name: 'inspect_invest_job_outputs',
      description: 'Inspect the structured output inventory of a completed GSMS InVEST job',
      risk: 'read',
      inputSchema: {
        type: 'object',
        additionalProperties: false,
        required: ['sceneId', 'jobId'],
        properties: {
          sceneId: { type: 'string' },
          jobId: { type: 'string' },
        },
      },
      async execute(input, context) {
        const parsed = jobSchema.parse(input)
        const state = requireCurrentJob(context, parsed.sceneId, parsed.jobId)
        if (state.jobStatus !== 'succeeded' && state.phase !== 'job-succeeded') {
          throw new Error('Inspect outputs only after the current job succeeds')
        }
        const outputs = await client.listSceneJobOutputs(parsed.sceneId, parsed.jobId)
        const list = Array.isArray(outputs) ? outputs : []
        const published = await client.publishGeneratedFile({
          sceneId: parsed.sceneId,
          jobId: parsed.jobId,
          artifactType: 'job-output-inventory',
          name: 'job-output-inventory.json',
          content: JSON.stringify(outputs, null, 2),
          fileFormat: 'json',
          note: 'Agent output inventory for a completed InVEST job',
        })
        return {
          content: JSON.stringify(outputs),
          artifacts: [{
            type: 'job-output-inventory',
            logicalKey: `job-output-inventory:${parsed.jobId}`,
            createdBy: 'tool',
            data: outputs,
            metadata: {
              sceneId: parsed.sceneId,
              jobId: parsed.jobId,
              outputCount: list.length,
              dataHubFile: published,
            },
          }],
          statePatch: { phase: 'outputs-inspected', outputCount: list.length },
          diagnostics:
            list.length === 0
              ? [{
                  code: 'GSMS_JOB_HAS_NO_OUTPUTS',
                  message: `GSMS job ${parsed.jobId} succeeded but exposed no outputs`,
                  severity: 'warning' as const,
                }]
              : [],
        }
      },
    },
    {
      name: 'analyze_invest_results',
      description: 'Request deterministic raster statistics from GSMS for the current job outputs; the backend reads real GeoTIFF values',
      risk: 'read',
      inputSchema: {
        type: 'object',
        additionalProperties: false,
        required: ['sceneId', 'jobId'],
        properties: {
          sceneId: { type: 'string' },
          jobId: { type: 'string' },
        },
      },
      async execute(input, context) {
        const parsed = jobSchema.parse(input)
        const state = requireCurrentJob(context, parsed.sceneId, parsed.jobId)
        if (state.phase !== 'outputs-inspected') {
          throw new Error('Inspect the current job outputs before requesting result analysis')
        }
        const result = await client.analyzeInvestResults(parsed.sceneId, parsed.jobId)
        const source = result as { outputFingerprints?: unknown; jobId?: unknown }
        const published = await client.publishGeneratedFile({
          sceneId: parsed.sceneId,
          jobId: parsed.jobId,
          artifactType: 'result-analysis',
          name: 'result-analysis.json',
          content: JSON.stringify(result, null, 2),
          fileFormat: 'json',
          note: 'Deterministic raster statistics computed from real InVEST GeoTIFF outputs',
        })
        return {
          content: JSON.stringify(result),
          artifacts: [{
            type: 'result-analysis',
            logicalKey: `result-analysis:${parsed.jobId}`,
            createdBy: 'tool',
            data: result,
            metadata: {
              sceneId: parsed.sceneId,
              jobId: parsed.jobId,
              modelId: state.modelId,
              outputFingerprints: source.outputFingerprints,
              dataHubFile: published,
            },
          }],
          statePatch: { phase: 'results-analyzed' },
        }
      },
    },
    buildTool({
      name: 'interpret_invest_results',
      description: 'Build an evidence-backed interpretation context from the current job outputs, logs, and result analysis',
      persistResultAboveBytes: 12_000,
      inputSchema: {
        type: 'object',
        additionalProperties: false,
        required: ['sceneId', 'jobId'],
        properties: {
          sceneId: { type: 'string' },
          jobId: { type: 'string' },
        },
      },
      async execute(input, context) {
        const parsed = jobSchema.parse(input)
        const state = requireCurrentJob(context, parsed.sceneId, parsed.jobId)
        if (state.phase !== 'results-analyzed') {
          throw new Error('Run result analysis before interpreting results')
        }
        const analysis = [...context.artifacts.list('result-analysis')]
          .reverse()
          .find(artifact =>
            artifact.metadata?.sceneId === parsed.sceneId &&
            artifact.metadata?.jobId === parsed.jobId)
        if (!analysis) {
          throw new Error('A result-analysis artifact for the current job is required before interpretation')
        }
        const inventory = context.artifacts.list('job-output-inventory').at(-1)
        if (!inventory) throw new Error('Current job output inventory is missing')
        const logs = await client.getSceneJobLogs(parsed.sceneId, parsed.jobId)
        const maxLogCharacters = 20_000
        const executionLogTail =
          logs.length > maxLogCharacters ? logs.slice(-maxLogCharacters) : logs
        const interpretation = {
          sceneId: parsed.sceneId,
          jobId: parsed.jobId,
          modelId: state.modelId,
          outputs: inventory.data,
          resultAnalysis: analysis.data,
          executionLogTail,
          executionLogTruncated: logs.length > maxLogCharacters,
          guidance: [
            'Explain only conclusions supported by the result analysis, output inventory, and execution log.',
            'All numerical values in the report must come from the result-analysis artifact.',
            'State model assumptions, validation warnings, and missing outputs explicitly.',
            'Do not infer ecological causality from model outputs alone.',
            'Do not claim to have analyzed individual carbon pools; the current outputs represent total carbon storage.',
          ],
        }
        const published = await client.publishGeneratedFile({
          sceneId: parsed.sceneId,
          jobId: parsed.jobId,
          artifactType: 'result-interpretation-context',
          name: 'result-interpretation-context.json',
          content: JSON.stringify(interpretation, null, 2),
          fileFormat: 'json',
          note: 'Agent interpretation context grounded in output inventory, result analysis, and logs',
        })
        return {
          content: JSON.stringify(interpretation),
          artifacts: [{
            type: 'result-interpretation-context',
            logicalKey: `result-interpretation-context:${parsed.jobId}`,
            createdBy: 'tool',
            data: interpretation,
            metadata: { sceneId: parsed.sceneId, jobId: parsed.jobId, dataHubFile: published },
          }],
          statePatch: { phase: 'results-ready-for-interpretation' },
        }
      },
    }),
    {
      name: 'finalize_sufficiency_assessment',
      description: 'Generate a deterministic sufficiency report: can this scene run this model? Reports available/missing/ambiguous slots with evidence.',
      risk: 'read',
      inputSchema: {
        type: 'object',
        additionalProperties: false,
        required: ['modelId', 'sceneId', 'slotAssessments'],
        properties: {
          modelId: { type: 'string' },
          sceneId: { type: 'string' },
          slotAssessments: {
            type: 'array',
            items: {
              type: 'object',
              required: ['slot', 'status', 'reasoning'],
              properties: {
                slot: { type: 'string' },
                status: { type: 'string', enum: ['available', 'missing', 'ambiguous'] },
                selectedAssetIds: { type: 'array', items: { type: 'string' } },
                reasoning: { type: 'string' },
                confidence: { type: 'number', minimum: 0, maximum: 1 },
              },
            },
          },
        },
      },
      async execute(input, context) {
        const parsed = z.object({
          modelId: z.string().min(1),
          sceneId: z.string().min(1),
          slotAssessments: z.array(z.object({
            slot: z.string(),
            status: z.enum(['available', 'missing', 'ambiguous']),
            selectedAssetIds: z.array(z.string()).optional(),
            reasoning: z.string(),
            confidence: z.number().min(0).max(1).optional(),
          })),
        }).parse(input)

        const allAvailable = parsed.slotAssessments.every(s => s.status === 'available')
        const hasMissing = parsed.slotAssessments.some(s => s.status === 'missing')
        const hasAmbiguous = parsed.slotAssessments.some(s => s.status === 'ambiguous')

        const overallStatus = allAvailable ? 'all-available' : hasMissing ? 'has-missing' : 'has-ambiguous'

        const report = {
          modelId: parsed.modelId,
          sceneId: parsed.sceneId,
          slotAssessments: parsed.slotAssessments,
          overallStatus,
          runnable: allAvailable,
          summary: allAvailable
            ? `All required inputs for ${parsed.modelId} are available in scene ${parsed.sceneId}.`
            : hasMissing
              ? `Missing required inputs for ${parsed.modelId}: ${parsed.slotAssessments.filter(s => s.status === 'missing').map(s => s.slot).join(', ')}.`
              : `Some inputs for ${parsed.modelId} have ambiguous matches and need user decision.`,
          timestamp: new Date().toISOString(),
        }

        return {
          content: JSON.stringify(report, null, 2),
          artifacts: [{
            type: 'sufficiency-report',
            logicalKey: `sufficiency-report:${parsed.sceneId}:${parsed.modelId}`,
            createdBy: 'tool',
            data: report,
            metadata: { modelId: parsed.modelId, sceneId: parsed.sceneId },
          }],
          statePatch: { phase: 'sufficiency-assessed' },
        }
      },
    },
    buildTool({
      name: 'assess_scene_model_readiness',
      description: 'One-shot assessment: for each registered InVEST model, determine the highest readiness level this scene can prove. Asserts up to data-sufficiency only — does NOT claim validation, user confirmation, or runnability.',
      persistResultAboveBytes: 8_000,
      inputSchema: {
        type: 'object',
        additionalProperties: false,
        required: ['sceneId'],
        properties: { sceneId: { type: 'string' } },
      },
      async execute(input) {
        const { sceneId } = sceneSchema.parse(input)
        const [rawModels, rawCards] = await Promise.all([
          client.listModels(),
          client.listSceneDataCards(sceneId),
        ])
        const models = z.array(z.object({
          id: z.string(),
          name: z.string(),
          status: z.string().optional(),
          runner: z.string().nullable().optional(),
          inputs: z.array(z.unknown()).optional(),
        })).parse(rawModels)
        const cards = normalizeDataCards(rawCards)

        // Readiness ladder (ascending). This tool may only assert up to
        // 'preliminary_data_sufficient'. Higher levels require relation checks,
        // official InVEST validation, or user confirmation — none of which
        // this tool performs.
        type ReadinessLevel =
          | 'runner_available'
          | 'preliminary_data_sufficient'
          // --- the following are NOT assertable by this tool ---
          // | 'ready_for_validation'
          // | 'validated'
          // | 'confirmed'
          // | 'runnable_now'

        const assessments: Array<{
          modelId: string
          displayName: string
          runnerAvailable: boolean
          runnerStatus: string
          dataSufficient: boolean
          slots: Array<{ slot: string; required: boolean; status: 'available' | 'missing'; candidateCount: number }>
          readinessLevel?: ReadinessLevel
        }> = []

        for (const model of models) {
          const runnerStatus = model.status ?? 'unknown'
          const runnerAvailable = runnerStatus !== 'planned' && model.runner != null

          // planned models have no inputs — can't assess data sufficiency
          if (runnerStatus === 'planned' || !model.inputs?.length) {
            assessments.push({
              modelId: model.id,
              displayName: model.name,
              runnerAvailable,
              runnerStatus,
              dataSufficient: false,
              slots: [],
            })
            continue
          }

          let adapted
          try {
            adapted = adaptGsmsModelSchema((rawModels as Array<{ id: string }>).find(m => m.id === model.id))
          } catch {
            assessments.push({
              modelId: model.id,
              displayName: model.name,
              runnerAvailable,
              runnerStatus,
              dataSufficient: false,
              slots: [],
            })
            continue
          }

          const slotResults = adapted.slots
            .filter(s => s.required)
            .map(slot => {
              const candidates = retrieveCandidates(slot, cards)
              return {
                slot: slot.name,
                required: true,
                status: candidates.candidates.length > 0 ? 'available' as const : 'missing' as const,
                candidateCount: candidates.candidates.length,
              }
            })

          const dataSufficient = slotResults.every(s => s.status === 'available')
          const readinessLevel: ReadinessLevel | undefined =
            !runnerAvailable ? undefined :
            dataSufficient ? 'preliminary_data_sufficient' :
            'runner_available'

          assessments.push({
            modelId: model.id,
            displayName: model.name,
            runnerAvailable,
            runnerStatus,
            dataSufficient,
            slots: slotResults,
            readinessLevel,
          })
        }

        const preliminaryReadyModels = assessments.filter(a => a.readinessLevel === 'preliminary_data_sufficient')
        const summary = preliminaryReadyModels.length
          ? `Preliminarily data-sufficient models: ${preliminaryReadyModels.map(a => a.displayName).join(', ')}.`
          : 'No models are preliminarily data-sufficient with the available scene data.'

        return {
          content: JSON.stringify({ summary, sceneId, assessments }, null, 2),
          artifacts: [{
            type: 'scene-model-readiness',
            logicalKey: `scene-model-readiness:${sceneId}`,
            createdBy: 'tool',
            data: { sceneId, assessments, preliminaryReadyModels: preliminaryReadyModels.map(a => a.modelId) },
            metadata: { sceneId },
          }],
        }
      },
    }),
  ]
}

function contextModelSchema(context: Parameters<AgentTool['execute']>[1]) {
  const modelId = context.domainState.snapshot().modelId
  const artifact = [...context.artifacts.list('model-input-schema')]
    .reverse()
    .find(candidate => !modelId || candidate.metadata?.modelId === modelId)
  if (!artifact) throw new Error('Load a GSMS model schema before loading scene data')
  return modelInputSchemaSchema.parse(artifact.data)
}

function tryContextModelSchema(context: Parameters<AgentTool['execute']>[1]) {
  const modelId = context.domainState.snapshot().modelId
  const artifact = [...context.artifacts.list('model-input-schema')]
    .reverse()
    .find(candidate => !modelId || candidate.metadata?.modelId === modelId)
  return artifact ? modelInputSchemaSchema.parse(artifact.data) : undefined
}

function canonical(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`
  if (value && typeof value === 'object') {
    return `{${Object.entries(value as Record<string, unknown>)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([key, item]) => `${JSON.stringify(key)}:${canonical(item)}`)
      .join(',')}}`
  }
  return JSON.stringify(value)
}
