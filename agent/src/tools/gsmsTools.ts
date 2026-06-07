import { z } from 'zod'
import type { AgentTool } from '@gsms/agent-core'
import { GsmsClient } from '../gsms/GsmsClient.ts'
import { adaptGsmsModelSchema } from '../gsms/modelSchemaAdapter.ts'
import { dataCardSchema, relationCheckSchema, type DataCard } from '../domain/schemas.ts'

const modelSchema = z.object({ modelId: z.string().min(1) })
const sceneSchema = z.object({ sceneId: z.string().min(1) })
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
    {
      name: 'list_invest_models',
      description: 'List model schemas registered by the GSMS scientific runtime',
      risk: 'read',
      inputSchema: { type: 'object', additionalProperties: false },
      async execute() {
        const models = await client.listModels()
        return {
          content: JSON.stringify(models),
          artifacts: [{ type: 'gsms-model-list', createdBy: 'tool', data: models }],
        }
      },
    },
    {
      name: 'get_invest_model_schema',
      description: 'Load one authoritative model schema from GSMS',
      risk: 'read',
      inputSchema: {
        type: 'object',
        additionalProperties: false,
        required: ['modelId'],
        properties: { modelId: { type: 'string' } },
      },
      async execute(input) {
        const { modelId } = modelSchema.parse(input)
        const schema = await client.getModelSchema(modelId)
        const adapted = adaptGsmsModelSchema(schema)
        return {
          content: JSON.stringify(schema),
          artifacts: [
            {
              type: 'gsms-model-schema',
              createdBy: 'tool',
              data: schema,
              metadata: { modelId },
            },
            {
              type: 'model-input-schema',
              createdBy: 'tool',
              data: adapted,
              metadata: { modelId, source: 'gsms' },
            },
          ],
          statePatch: { modelId, phase: 'discovering-data' },
        }
      },
    },
    {
      name: 'list_scene_data_cards',
      description: 'Load factual data cards for files imported into a GSMS scene',
      risk: 'read',
      inputSchema: {
        type: 'object',
        additionalProperties: false,
        required: ['sceneId'],
        properties: { sceneId: { type: 'string' } },
      },
      async execute(input) {
        const { sceneId } = sceneSchema.parse(input)
        const result = await client.listSceneDataCards(sceneId)
        const cards = normalizeDataCards(result)
        return {
          content: JSON.stringify(result),
          artifacts: [
            {
              type: 'gsms-scene-data-cards',
              createdBy: 'tool',
              data: result,
              metadata: { sceneId },
            },
            ...cards.map(card => ({
              type: 'data-card',
              createdBy: 'tool' as const,
              data: card,
              metadata: { sceneId, assetId: card.assetId },
            })),
          ],
          statePatch: {
            sceneId,
            phase: 'matching-slots',
            assetIds: cards.map(card => card.assetId),
          },
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
      async execute(input) {
        const parsed = relationSchema.parse(input)
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
        return {
          content: JSON.stringify(result),
          artifacts: [
            { type: 'gsms-relation-check', createdBy: 'tool', data: result },
            {
              id: `relation-check:${check.id}`,
              type: 'relation-check',
              createdBy: 'tool',
              data: check,
            },
          ],
        }
      },
    },
    {
      name: 'validate_binding_report',
      description: 'Validate the latest Binding Report using the authoritative GSMS model checks',
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
        const report = context.artifacts.list('binding-report').at(-1)
        if (!report) throw new Error('Submit a Binding Report before validation')
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
          artifacts: [{ type: 'validation-report', createdBy: 'tool', data: result }],
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
        }
      },
    },
    {
      name: 'confirm_validation_snapshot',
      description: 'Record the user approval or rejection of the latest validated input snapshot',
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
        if (state.phase !== 'awaiting-user-confirmation') {
          throw new Error('The latest validation snapshot is not awaiting user confirmation')
        }
        const result = await client.confirmValidationSnapshot(parsed.snapshotId, parsed.confirmed)
        return {
          content: JSON.stringify(result),
          artifacts: [{ type: 'confirmation-record', createdBy: 'user', data: result }],
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
        if (state.phase !== 'confirmed-for-execution' || state.confirmationStatus !== 'confirmed') {
          throw new Error('The validation snapshot has not been confirmed for execution')
        }
        const result = await client.createJobFromValidationSnapshot(parsed.snapshotId, parsed.runMode)
        const source = result as { job_id?: unknown }
        return {
          content: JSON.stringify(result),
          artifacts: [{ type: 'model-job', createdBy: 'tool', data: result }],
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
        return {
          content: JSON.stringify(outputs),
          artifacts: [{
            type: 'job-output-inventory',
            createdBy: 'tool',
            data: outputs,
            metadata: { sceneId: parsed.sceneId, jobId: parsed.jobId, outputCount: list.length },
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
      name: 'interpret_invest_results',
      description: 'Build an evidence-backed interpretation context from the current job outputs and logs',
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
          throw new Error('Inspect the current job outputs before interpreting results')
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
          executionLogTail,
          executionLogTruncated: logs.length > maxLogCharacters,
          guidance: [
            'Explain only conclusions supported by the output inventory and execution log.',
            'State model assumptions, validation warnings, and missing outputs explicitly.',
            'Do not infer ecological causality from model outputs alone.',
          ],
        }
        return {
          content: JSON.stringify(interpretation),
          artifacts: [{
            type: 'result-interpretation-context',
            createdBy: 'tool',
            data: interpretation,
            metadata: { sceneId: parsed.sceneId, jobId: parsed.jobId },
          }],
          statePatch: { phase: 'results-ready-for-interpretation' },
        }
      },
    },
  ]
}
