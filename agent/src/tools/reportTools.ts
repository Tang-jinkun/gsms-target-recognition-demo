import { lstat, mkdir, realpath, writeFile } from 'node:fs/promises'
import { isAbsolute, relative, resolve, sep } from 'node:path'
import { z } from 'zod'
import type { AgentTool } from '@gsms/agent-core'
import { buildInvestReport } from '../report/buildInvestReport.ts'

const writeReportSchema = z.object({
  resultSummary: z.string().min(1).max(8_000),
  keyFindings: z.array(z.string().min(1).max(1_000)).max(20).default([]),
  limitations: z.array(z.string().min(1).max(1_000)).max(20).default([]),
})

export const writeInvestReportTool: AgentTool = {
  name: 'write_invest_report',
  description: 'Write an evidence-backed Markdown report for the current completed InVEST run',
  risk: 'write',
  inputSchema: {
    type: 'object',
    additionalProperties: false,
    required: ['resultSummary'],
    properties: {
      resultSummary: { type: 'string' },
      keyFindings: { type: 'array', items: { type: 'string' } },
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
