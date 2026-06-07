import assert from 'node:assert/strict'
import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import {
  AgentRuntime,
  FakeModelAdapter,
  PermissionManager,
  ToolRegistry,
  createSkillAgentTool,
  finishTool,
} from '@gsms/agent-core'
import { SkillRegistry, SkillTool } from '@gsms/skills-core'
import { GsmsClient, createGsmsTools, createMatchingTools, createReportTools } from '../src/index.ts'
import { gsmsCarbonSchema } from './fixtures.ts'

test('agent uses the authoritative GSMS schema to produce a Carbon Binding Report', async () => {
  const fetch = async (input: string | URL | Request) => {
    const url = String(input)
    let payload: unknown
    if (url.endsWith('/api/models/carbon/schema')) {
      payload = gsmsCarbonSchema
    } else if (url.endsWith('/api/scenes/scene-1/data-cards')) {
      payload = {
        scene_id: 'scene-1',
        data_cards: [
          {
            asset_id: 'lulc-current',
            path: 'lulc_current.tif',
            filename: 'lulc_current.tif',
            asset_type: 'raster',
            semantic_hints: ['current land cover'],
            metadata: { band_count: 1 },
            provenance: { size: 100 },
          },
          {
            asset_id: 'carbon-pools',
            path: 'carbon_pools.csv',
            filename: 'carbon_pools.csv',
            asset_type: 'table',
            semantic_hints: ['carbon pools'],
            metadata: {
              columns: ['lucode', 'c_above', 'c_below', 'c_soil', 'c_dead'],
              sample_rows: [[1, 10, 10, 10, 10]],
            },
            provenance: { size: 100 },
          },
        ],
        diagnostics: [],
      }
    } else if (url.endsWith('/api/matching/check-relation')) {
      payload = {
        id: 'code-coverage:lulc-current:carbon-pools:lucode',
        kind: 'code-coverage',
        left_asset_id: 'lulc-current',
        right_asset_id: 'carbon-pools',
        status: 'passed',
        facts: ['All sampled codes are covered'],
        missing_values: [],
      }
    } else if (url.endsWith('/api/models/carbon/validate-bindings')) {
      payload = {
        model_id: 'carbon',
        scene_id: 'scene-1',
        snapshot_id: 'validated-carbon-snapshot',
        can_proceed: true,
        inputs: {
          lulc_bas_asset_id: 'lulc_current.tif',
          carbon_pools_asset_id: 'carbon_pools.csv',
        },
        validation: { status: 'ok', errors: [], warnings: [], info: ['Inputs passed'] },
      }
    } else if (url.endsWith('/api/validation-snapshots/validated-carbon-snapshot/confirm')) {
      payload = {
        snapshot_id: 'validated-carbon-snapshot',
        status: 'confirmed',
        can_proceed: true,
      }
    } else if (url.endsWith('/api/scenes/scene-1/jobs/job-from-snapshot/outputs')) {
      payload = [
        {
          id: 'job-from-snapshot:c_storage_bas_mvp.tif',
          job_id: 'job-from-snapshot',
          name: 'c_storage_bas_mvp.tif',
          type: 'raster',
          size: 4096,
          download_url: '/api/scenes/scene-1/jobs/job-from-snapshot/outputs/c_storage_bas_mvp.tif/download',
        },
      ]
    } else if (url.endsWith('/api/scenes/scene-1/jobs/job-from-snapshot/logs')) {
      return new Response('=== job runner finished ===', { status: 200 })
    } else if (url.endsWith('/api/scenes/scene-1/jobs/job-from-snapshot/analyze-results')) {
      payload = {
        sceneId: 'scene-1',
        jobId: 'job-from-snapshot',
        modelId: 'carbon',
        outputFingerprints: { 'c_storage_bas_mvp.tif': 'abc123' },
        rasters: [
          {
            id: 'c_storage_bas_mvp.tif',
            filename: 'c_storage_bas_mvp.tif',
            role: 'baseline-carbon-storage',
            quantity: 'carbon storage',
            unit: 'Mg C/pixel',
            statistics: {
              validPixels: 1000,
              nodataPixels: 0,
              minimum: 0.0,
              maximum: 150.0,
              mean: 45.5,
              total: 45500.0,
              p05: 5.0,
              median: 40.0,
              p95: 120.0,
              spatial: { crs: 'EPSG:4326', bounds: [0, 0, 1, 1], width: 100, height: 100 },
            },
          },
        ],
        comparisons: [],
        warnings: [],
      }
    } else if (url.endsWith('/api/scenes/scene-1/jobs/job-from-snapshot')) {
      payload = {
        job_id: 'job-from-snapshot',
        scene_id: 'scene-1',
        model_id: 'carbon',
        status: 'succeeded',
        outputs_count: 1,
      }
    } else {
      payload = {
        job_id: 'job-from-snapshot',
        status: 'running',
        scene_id: 'scene-1',
        source_snapshot_id: 'validated-carbon-snapshot',
      }
    }
    return new Response(JSON.stringify(payload), {
      status: 200,
      headers: { 'content-type': 'application/json' },
    })
  }

  const skills = new SkillRegistry()
  const allowedTools = [
    'get_invest_model_schema',
    'list_scene_data_cards',
    'retrieve_input_candidates',
    'check_data_relation',
    'finalize_data_matching',
    'validate_binding_report',
    'confirm_validation_snapshot',
    'execute_validated_snapshot',
    'get_invest_job_status',
    'inspect_invest_job_outputs',
    'interpret_invest_results',
  ]
  skills.replace([
    {
      name: 'data-matching',
      description: 'Match GSMS scene assets to InVEST model inputs',
      instructions: 'Load GSMS facts, inspect candidates, check relations, and submit a report.',
      source: 'builtin',
      allowedTools,
      userInvocable: true,
      modelInvocable: true,
      execution: 'inline',
    },
    {
      name: 'interpret-invest-results',
      description: 'Monitor and interpret the current GSMS InVEST job',
      instructions: 'Wait for success, inspect outputs, then build an evidence-backed interpretation.',
      source: 'builtin',
      allowedTools: [
        'get_invest_job_status',
        'inspect_invest_job_outputs',
        'analyze_invest_results',
        'interpret_invest_results',
        'write_invest_report',
      ],
      userInvocable: true,
      modelInvocable: true,
      execution: 'inline',
    },
  ])

  const report = {
    taskSpecId: 'task-carbon-1',
    modelSchemaId: 'carbon-runtime',
    bindings: [
      {
        slot: 'lulc_bas_path',
        selectedAssetId: 'lulc-current',
        candidateAssetIds: ['lulc-current'],
        confidence: 0.9,
        status: 'matched',
        facts: [],
        agentReasoning: 'Only compatible baseline LULC candidate.',
      },
      {
        slot: 'carbon_pools_path',
        selectedAssetId: 'carbon-pools',
        candidateAssetIds: ['carbon-pools'],
        confidence: 0.95,
        status: 'matched',
        facts: [],
        agentReasoning: 'Only table containing all fields required by the GSMS schema.',
      },
    ],
    relationChecks: [
      {
        id: 'code-coverage:lulc-current:carbon-pools:lucode',
        kind: 'code-coverage',
        leftAssetId: 'lulc-current',
        rightAssetId: 'carbon-pools',
        status: 'passed',
        facts: ['All sampled codes are covered'],
      },
    ],
    conflicts: [],
    unresolvedQuestions: [],
    recommendedNextAction: 'proceed-to-validation',
  }
  const model = new FakeModelAdapter([
    { content: '', toolCalls: [{ id: '1', name: 'skill', input: { skill: 'data-matching' } }] },
    { content: '', toolCalls: [{ id: '2', name: 'get_invest_model_schema', input: { modelId: 'carbon' } }] },
    { content: '', toolCalls: [{ id: '3', name: 'list_scene_data_cards', input: { sceneId: 'scene-1' } }] },
    {
      content: '',
      toolCalls: [
        { id: '4', name: 'retrieve_input_candidates', input: { slot: 'lulc_bas_path' } },
        { id: '5', name: 'retrieve_input_candidates', input: { slot: 'carbon_pools_path' } },
      ],
    },
    {
      content: '',
      toolCalls: [
        { id: '4a', name: 'retrieve_input_candidates', input: { slot: 'lulc_bas_path' } },
        { id: '4b', name: 'retrieve_input_candidates', input: { slot: 'carbon_pools_path' } },
      ],
    },
    {
      content: '',
      toolCalls: [
        {
          id: '6',
          name: 'check_data_relation',
          input: {
            kind: 'code-coverage',
            leftAssetId: 'lulc-current',
            rightAssetId: 'carbon-pools',
            field: 'lucode',
          },
        },
      ],
    },
    {
      content: '',
      toolCalls: [{
        id: '7',
        name: 'finalize_data_matching',
        input: {
          modelId: 'carbon',
          decisions: report.bindings.map(binding => ({
            slot: binding.slot,
            selectedAssetId: binding.selectedAssetId,
            status: binding.status,
            confidence: binding.confidence,
            reasoning: binding.agentReasoning,
          })),
          unresolvedQuestions: [],
        },
      }],
    },
    {
      content: '',
      toolCalls: [
        {
          id: '8',
          name: 'validate_binding_report',
          input: { modelId: 'carbon', sceneId: 'scene-1', parameters: { calc_sequestration: false } },
        },
      ],
    },
    {
      content: '',
      toolCalls: [
        {
          id: '9',
          name: 'confirm_validation_snapshot',
          input: { snapshotId: 'validated-carbon-snapshot', confirmed: true },
        },
      ],
    },
    {
      content: '',
      toolCalls: [
        {
          id: '10',
          name: 'execute_validated_snapshot',
          input: { snapshotId: 'validated-carbon-snapshot', runMode: 'real' },
        },
      ],
    },
    {
      content: '',
      toolCalls: [
        {
          id: '11',
          name: 'skill',
          input: { skill: 'interpret-invest-results' },
        },
      ],
    },
    {
      content: '',
      toolCalls: [
        {
          id: '12',
          name: 'get_invest_job_status',
          input: { sceneId: 'scene-1', jobId: 'job-from-snapshot' },
        },
      ],
    },
    {
      content: '',
      toolCalls: [
        {
          id: '13',
          name: 'inspect_invest_job_outputs',
          input: { sceneId: 'scene-1', jobId: 'job-from-snapshot' },
        },
      ],
    },
    {
      content: '',
      toolCalls: [
        {
          id: '13a',
          name: 'analyze_invest_results',
          input: { sceneId: 'scene-1', jobId: 'job-from-snapshot' },
        },
      ],
    },
    {
      content: '',
      toolCalls: [
        {
          id: '14',
          name: 'interpret_invest_results',
          input: { sceneId: 'scene-1', jobId: 'job-from-snapshot' },
        },
      ],
    },
    {
      content: '',
      toolCalls: [
        {
          id: '15',
          name: 'write_invest_report',
          input: {
            highlightMetricIds: ['baseline-carbon-storage.total'],
            contextualExplanation: 'The Carbon run completed and produced its expected baseline output with a total of 45,500 Mg C.',
            limitations: ['The output is a model estimate and has not been field validated.'],
          },
        },
      ],
    },
    {
      content: '',
      toolCalls: [
        {
          id: '16',
          name: 'finish',
          input: {
            summary: 'Matched, validated, executed, and prepared results for interpretation',
            evidence: ['job-from-snapshot', 'c_storage_bas_mvp.tif'],
          },
        },
      ],
    },
  ])
  const domainTools = [
    ...createGsmsTools(new GsmsClient({ baseUrl: 'http://gsms', fetch })),
    ...createMatchingTools(),
    ...createReportTools(),
  ]
  const tools = new ToolRegistry([...domainTools, finishTool])
  tools.register(
    createSkillAgentTool(new SkillTool(skills), {
      availableTools: () => domainTools.map(tool => tool.name),
    }),
  )

  const workspace = await mkdtemp(join(tmpdir(), 'gsms-agent-workflow-'))
  const result = await new AgentRuntime({
    model,
    tools,
    skills,
    workspace,
    permissions: new PermissionManager({ approve: () => 'allow' }),
  }).run('Match scene-1 data for Carbon')

  assert.equal(result.goal.status, 'completed')
  assert.equal(result.artifacts.filter(artifact => artifact.type === 'model-input-schema').length, 1)
  assert.equal(result.artifacts.filter(artifact => artifact.type === 'candidate-set').length, 2)
  assert.equal(result.artifacts.filter(artifact => artifact.type === 'relation-check').length, 1)
  assert.equal(result.artifacts.filter(artifact => artifact.type === 'binding-report').length, 1)
  assert.equal(result.artifacts.filter(artifact => artifact.type === 'validation-report').length, 1)
  assert.equal(result.artifacts.filter(artifact => artifact.type === 'confirmation-record').length, 1)
  assert.equal(result.artifacts.filter(artifact => artifact.type === 'model-job').length, 1)
  assert.equal(result.artifacts.filter(artifact => artifact.type === 'job-status').length, 1)
  assert.equal(result.artifacts.filter(artifact => artifact.type === 'job-output-inventory').length, 1)
  assert.equal(result.artifacts.filter(artifact => artifact.type === 'result-analysis').length, 1)
  assert.equal(result.artifacts.filter(artifact => artifact.type === 'result-interpretation-context').length, 1)
  assert.equal(result.artifacts.filter(artifact => artifact.type === 'invest-report').length, 1)
  assert.equal(result.domainState.phase, 'report-written')
  assert.equal(result.domainState.validationStatus, 'passed')
  assert.equal(result.domainState.validationSnapshotId, 'validated-carbon-snapshot')
  assert.equal(result.domainState.jobId, 'job-from-snapshot')
  assert.equal(result.domainState.jobStatus, 'succeeded')
  assert.equal(result.domainState.outputCount, 1)
  assert.equal(result.domainState.reportPath, 'runs/job-from-snapshot/report.md')
  const reportContent = await readFile(join(workspace, 'runs', 'job-from-snapshot', 'report.md'), 'utf8')
  assert.match(reportContent, /45,500/)
  assert.match(reportContent, /Result Analysis/)
  await rm(workspace, { recursive: true, force: true })
})
