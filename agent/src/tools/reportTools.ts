import { lstat, mkdir, realpath, writeFile } from 'node:fs/promises'
import { isAbsolute, relative, resolve, sep } from 'node:path'
import { z } from 'zod'
import type { AgentTool } from '@gsms/agent-core'
import { buildInvestReport } from '../report/buildInvestReport.ts'

const writeReportSchema = z.object({
  highlightMetricIds: z.array(z.string().min(1)).max(50).default([]),
  contextualExplanation: z.string().min(1).max(8_000),
  limitations: z.array(z.string().min(1).max(1_000)).max(20).default([]),
})

export const writeInvestReportTool: AgentTool = {
  name: 'write_invest_report',
  description: 'Write an evidence-backed Markdown report for the current completed InVEST run',
  risk: 'write',
  inputSchema: {
    type: 'object',
    additionalProperties: false,
    required: ['contextualExplanation'],
    properties: {
      highlightMetricIds: { type: 'array', items: { type: 'string' } },
      contextualExplanation: { type: 'string' },
      limitations: { type: 'array', items: { type: 'string' } },
    },
  },
  async execute(input, context) {
    const parsed = writeReportSchema.parse(input)
    const state = context.domainState.snapshot()
    if (state.phase !== 'results-ready-for-interpretation') {
      throw new Error('Prepare the current job results for interpretation before writing a report')
    }
    const jobId = String(state.jobId ?? '')
    if (!/^[A-Za-z0-9_-]+$/.test(jobId)) throw new Error('Current job ID is not safe for a report path')

    // Validate that highlightMetricIds reference real metrics in the analysis
    const analysis = [...context.artifacts.list('result-analysis')]
      .reverse()
      .find(a => a.metadata?.jobId === jobId)
    if (!analysis) {
      throw new Error('A result-analysis artifact for the current job is required before writing a report')
    }
    assertNoUnsupportedNumbers(parsed.contextualExplanation, 'contextualExplanation')
    parsed.limitations.forEach((limitation, index) =>
      assertNoUnsupportedNumbers(limitation, `limitations[${index}]`))

    const analysisData = analysis.data as Record<string, unknown>
    const validMetricIds = new Set<string>()
    const rasters = Array.isArray(analysisData.rasters)
      ? (analysisData.rasters as Record<string, unknown>[])
      : []
    for (const raster of rasters) {
      const stats = (raster.statistics ?? {}) as Record<string, unknown>
      for (const key of Object.keys(stats)) {
        if (key !== 'spatial') validMetricIds.add(`${raster.role}.${key}`)
      }
    }
    const comparisons = Array.isArray(analysisData.comparisons)
      ? (analysisData.comparisons as Record<string, unknown>[])
      : []
    for (const comp of comparisons) {
      for (const key of Object.keys((comp.metrics ?? {}) as Record<string, unknown>)) {
        validMetricIds.add(`${comp.kind}.${key}`)
      }
    }
    for (const id of parsed.highlightMetricIds) {
      if (!validMetricIds.has(id)) {
        throw new Error(`Unknown metric ID: ${id}. Valid IDs: ${[...validMetricIds].sort().join(', ')}`)
      }
    }

    const root = await realpath(context.workspace)
    const reportDir = resolve(root, 'runs', jobId)
    assertInside(root, reportDir)
    await mkdir(reportDir, { recursive: true })
    await assertNoSymlink(resolve(root, 'runs'))
    await assertNoSymlink(reportDir)
    assertInside(root, await realpath(reportDir))
    const reportPath = resolve(reportDir, 'report.md')
    assertInside(root, reportPath)
    await assertNoSymlink(reportPath, true)
    const markdown = buildInvestReport({
      goal: context.goal,
      state,
      artifacts: context.artifacts.list(),
      ...parsed,
    })
    await writeFile(reportPath, markdown, 'utf8')
    const relativePath = relative(root, reportPath).replaceAll('\\', '/')
    return {
      content: `Wrote InVEST report to ${relativePath}`,
      artifacts: [{
        type: 'invest-report',
        createdBy: 'agent',
        data: { path: relativePath, markdown },
        metadata: { jobId, sceneId: state.sceneId, modelId: state.modelId },
      }],
      statePatch: { phase: 'report-written', reportPath: relativePath },
    }
  },
}

export function createReportTools(): AgentTool[] {
  return [writeInvestReportTool]
}

function assertInside(root: string, candidate: string): void {
  const rel = relative(root, candidate)
  if (rel === '' || (!rel.startsWith(`..${sep}`) && rel !== '..' && !isAbsolute(rel))) return
  throw new Error(`Report path escapes workspace: ${candidate}`)
}

async function assertNoSymlink(path: string, allowMissing = false): Promise<void> {
  try {
    if ((await lstat(path)).isSymbolicLink()) throw new Error(`Symbolic links are not allowed: ${path}`)
  } catch (error) {
    if (allowMissing && isMissing(error)) return
    throw error
  }
}

function isMissing(error: unknown): boolean {
  return typeof error === 'object' && error !== null && 'code' in error && error.code === 'ENOENT'
}

function assertNoUnsupportedNumbers(value: string, field: string): void {
  if (/\d/.test(value)) {
    throw new Error(
      `${field} must not introduce numerical values; select result-analysis metrics with highlightMetricIds instead`,
    )
  }
}
