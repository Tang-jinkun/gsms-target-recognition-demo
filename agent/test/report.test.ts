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

  const report = buildInvestReport({
    goal: goal(),
    state: { modelId: 'carbon', sceneId: 'scene-1', jobId: 'job-1', jobStatus: 'succeeded' },
    artifacts: artifacts.list(),
    resultSummary: 'The run produced a baseline carbon-storage raster.',
    keyFindings: ['A carbon-storage output was produced.'],
    limitations: ['No alternate scenario was evaluated.'],
  })

  assert.match(report, /# InVEST Assessment Report/)
  assert.match(report, /lulc-current/)
  assert.match(report, /Review unused codes/)
  assert.match(report, /c_storage_bas\.tif/)
  assert.match(report, /model estimates, not direct observations/)
})

test('writes the final report only after interpretation is ready', async () => {
  const workspace = await mkdtemp(join(tmpdir(), 'gsms-report-'))
  try {
    const context: AgentContext = {
      workspace,
      goal: goal(),
      artifacts: new ArtifactStore(),
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
        resultSummary: 'The model run completed and exposed one raster output.',
        keyFindings: ['The expected raster output is available.'],
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
      writeInvestReportTool.execute({ resultSummary: 'No report should be written.' }, context),
      /not safe for a report path/,
    )
  } finally {
    await rm(workspace, { recursive: true, force: true })
  }
})
