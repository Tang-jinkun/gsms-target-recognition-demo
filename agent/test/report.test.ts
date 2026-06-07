import assert from 'node:assert/strict'
import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import { ArtifactStore, DomainStateStore, type AgentContext, type GoalState } from '@gsms/agent-core'
import { buildInvestReport, writeInvestReportTool } from '../src/index.ts'

function goal(): GoalState {
  return {
    objective: 'Estimate current carbon storage',
    status: 'active',
    turnCount: 1,
    maxTurns: 10,
    evidence: [],
    remainingIssues: [],
    startedAt: new Date().toISOString(),
  }
}

test('builds an evidence-backed Markdown report from persisted artifacts', () => {
  const artifacts = new ArtifactStore()
  artifacts.create({
    type: 'binding-report',
    createdBy: 'agent',
    data: {
      bindings: [{
        slot: 'lulc_bas_path',
        selectedAssetId: 'lulc-current',
        confidence: 0.95,
        agentReasoning: 'Only compatible baseline raster.',
      }],
    },
  })
  artifacts.create({
    type: 'validation-report',
    createdBy: 'tool',
    data: { validation: { status: 'warning', errors: [], warnings: ['Review unused codes'] } },
  })
  artifacts.create({
    type: 'job-output-inventory',
    createdBy: 'tool',
    data: [{ name: 'c_storage_bas.tif', type: 'raster', size: 4096 }],
  })
  artifacts.create({
    type: 'result-analysis',
    createdBy: 'tool',
    data: {
      sceneId: 'scene-1',
      jobId: 'job-1',
      modelId: 'carbon',
      outputFingerprints: { 'c_storage_bas.tif': 'abc123' },
      rasters: [
        {
          id: 'c_storage_bas.tif',
          filename: 'c_storage_bas.tif',
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
            spatial: { crs: 'EPSG:4326', bounds: [0, 0, 1, 1], width: 100, height: 100, nodata: -9999 },
          },
        },
      ],
      comparisons: [],
      warnings: [],
    },
    metadata: { jobId: 'job-1' },
  })

  const report = buildInvestReport({
    goal: goal(),
    state: { modelId: 'carbon', sceneId: 'scene-1', jobId: 'job-1', jobStatus: 'succeeded' },
    artifacts: artifacts.list(),
    highlightMetricIds: ['baseline-carbon-storage.total'],
    contextualExplanation: 'The run produced a baseline carbon-storage raster with a total of 45,500 Mg C.',
    limitations: ['No alternate scenario was evaluated.'],
  })

  assert.match(report, /# InVEST Assessment Report/)
  assert.match(report, /lulc-current/)
  assert.match(report, /Review unused codes/)
  assert.match(report, /c_storage_bas\.tif/)
  assert.match(report, /model estimates, not direct observations/)
  assert.match(report, /45,500/)
  assert.match(report, /Result Analysis/)
  assert.match(report, /baseline-carbon-storage/)
})

test('writes the final report only after interpretation is ready', async () => {
  const workspace = await mkdtemp(join(tmpdir(), 'gsms-report-'))
  try {
    const artifacts = new ArtifactStore()
    artifacts.create({
      type: 'result-analysis',
      createdBy: 'tool',
      data: {
        sceneId: 'scene-1',
        jobId: 'job-1',
        modelId: 'carbon',
        outputFingerprints: {},
        rasters: [],
        comparisons: [],
        warnings: [],
      },
      metadata: { jobId: 'job-1' },
    })
    const context: AgentContext = {
      workspace,
      goal: goal(),
      artifacts,
      domainState: new DomainStateStore({
        phase: 'results-ready-for-interpretation',
        modelId: 'carbon',
        sceneId: 'scene-1',
        jobId: 'job-1',
        jobStatus: 'succeeded',
      }),
    }
    const result = await writeInvestReportTool.execute(
      {
        contextualExplanation: 'The model run completed and exposed one raster output.',
        limitations: ['The output has not been compared with field observations.'],
      },
      context,
    )
    const reportPath = join(workspace, 'runs', 'job-1', 'report.md')
    const markdown = await readFile(reportPath, 'utf8')

    assert.match(markdown, /field observations/)
    assert.equal(result.statePatch?.phase, 'report-written')
    assert.equal(result.artifacts?.[0]?.type, 'invest-report')
  } finally {
    await rm(workspace, { recursive: true, force: true })
  }
})

test('rejects an unsafe current job ID before writing a report', async () => {
  const workspace = await mkdtemp(join(tmpdir(), 'gsms-report-'))
  try {
    const context: AgentContext = {
      workspace,
      goal: goal(),
      artifacts: new ArtifactStore(),
      domainState: new DomainStateStore({
        phase: 'results-ready-for-interpretation',
        jobId: '../outside',
      }),
    }
    await assert.rejects(
      writeInvestReportTool.execute({ contextualExplanation: 'No report should be written.' }, context),
      /not safe for a report path/,
    )
  } finally {
    await rm(workspace, { recursive: true, force: true })
  }
})

test('rejects unknown highlightMetricIds', async () => {
  const workspace = await mkdtemp(join(tmpdir(), 'gsms-report-'))
  try {
    const artifacts = new ArtifactStore()
    artifacts.create({
      type: 'result-analysis',
      createdBy: 'tool',
      data: {
        sceneId: 'scene-1',
        jobId: 'job-1',
        modelId: 'carbon',
        outputFingerprints: {},
        rasters: [
          {
            id: 'test.tif',
            filename: 'test.tif',
            role: 'baseline-carbon-storage',
            quantity: 'carbon storage',
            statistics: { validPixels: 10, total: 100 },
          },
        ],
        comparisons: [],
        warnings: [],
      },
      metadata: { jobId: 'job-1' },
    })
    const context: AgentContext = {
      workspace,
      goal: goal(),
      artifacts,
      domainState: new DomainStateStore({
        phase: 'results-ready-for-interpretation',
        modelId: 'carbon',
        sceneId: 'scene-1',
        jobId: 'job-1',
        jobStatus: 'succeeded',
      }),
    }
    await assert.rejects(
      writeInvestReportTool.execute(
        {
          highlightMetricIds: ['nonexistent.metric'],
          contextualExplanation: 'Testing invalid metric.',
        },
        context,
      ),
      /Unknown metric ID: nonexistent\.metric/,
    )
  } finally {
    await rm(workspace, { recursive: true, force: true })
  }
})

test('rejects report text that introduces unverified numerical values', async () => {
  const workspace = await mkdtemp(join(tmpdir(), 'gsms-report-'))
  try {
    const artifacts = new ArtifactStore()
    artifacts.create({
      type: 'result-analysis',
      createdBy: 'tool',
      data: {
        sceneId: 'scene-1',
        jobId: 'job-1',
        modelId: 'carbon',
        outputFingerprints: {},
        rasters: [{
          id: 'c_storage_bas.tif',
          filename: 'c_storage_bas.tif',
          role: 'baseline-carbon-storage',
          quantity: 'carbon storage',
          statistics: { total: 45500, validPixels: 1000 },
        }],
        comparisons: [],
        warnings: [],
      },
      metadata: { jobId: 'job-1' },
    })
    const context: AgentContext = {
      workspace,
      goal: goal(),
      artifacts,
      domainState: new DomainStateStore({
        phase: 'results-ready-for-interpretation',
        sceneId: 'scene-1',
        jobId: 'job-1',
      }),
    }

    await assert.rejects(
      writeInvestReportTool.execute(
        { contextualExplanation: 'Carbon storage increased by 12 percent.' },
        context,
      ),
      /not found in result-analysis: 12/,
    )
  } finally {
    await rm(workspace, { recursive: true, force: true })
  }
})

test('allows report text to cite numbers present in result-analysis', async () => {
  const workspace = await mkdtemp(join(tmpdir(), 'gsms-report-'))
  try {
    const artifacts = new ArtifactStore()
    artifacts.create({
      type: 'result-analysis',
      createdBy: 'tool',
      data: {
        sceneId: 'scene-1',
        jobId: 'job-1',
        modelId: 'carbon',
        outputFingerprints: {},
        rasters: [{
          id: 'c_storage_bas.tif',
          filename: 'c_storage_bas.tif',
          role: 'baseline-carbon-storage',
          quantity: 'carbon storage',
          statistics: { total: 45500, validPixels: 1000 },
        }],
        comparisons: [],
        warnings: [],
      },
      metadata: { jobId: 'job-1' },
    })
    const context: AgentContext = {
      workspace,
      goal: goal(),
      artifacts,
      domainState: new DomainStateStore({
        phase: 'results-ready-for-interpretation',
        sceneId: 'scene-1',
        jobId: 'job-1',
      }),
    }

    const result = await writeInvestReportTool.execute(
      {
        contextualExplanation: 'The deterministic analysis reports total carbon storage of 45,500.',
        highlightMetricIds: ['baseline-carbon-storage.total'],
      },
      context,
    )
    assert.equal(result.statePatch?.phase, 'report-written')
  } finally {
    await rm(workspace, { recursive: true, force: true })
  }
})
