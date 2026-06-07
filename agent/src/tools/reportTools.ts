import { lstat, mkdir, realpath, writeFile } from 'node:fs/promises'
import { isAbsolute, relative, resolve, sep } from 'node:path'
import { z } from 'zod'
import type { AgentTool } from '@gsms/agent-core'
import { buildInvestReport } from '../report/buildInvestReport.ts'

interface GeneratedFilePublisher {
  publishGeneratedFile(input: {
    sceneId: string
    jobId: string
    artifactType: string
    name: string
    content: string
    fileFormat: string
    note?: string
  }): Promise<unknown>
}

const writeReportSchema = z.object({
  highlightMetricIds: z.array(z.string().min(1)).max(50).default([]),
  contextualExplanation: z.string().min(1).max(8_000),
  limitations: z.array(z.string().min(1).max(1_000)).max(20).default([]),
})

export const writeInvestReportTool = createWriteInvestReportTool()

export function createWriteInvestReportTool(publisher?: GeneratedFilePublisher): AgentTool {
  return {
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
      const sceneId = String(state.sceneId ?? '')
      if (!/^[A-Za-z0-9_-]+$/.test(sceneId)) throw new Error('Current scene ID is not safe for report publication')

    // Validate that highlightMetricIds reference real metrics in the analysis
    const analysis = [...context.artifacts.list('result-analysis')]
      .reverse()
      .find(a => a.metadata?.jobId === jobId)
    if (!analysis) {
      throw new Error('A result-analysis artifact for the current job is required before writing a report')
    }
    const analysisData = analysis.data as Record<string, unknown>
    const allowedNumbers = collectAllowedNumbers(analysisData)
    const explanationUnsupported = findUnsupportedNumbers(parsed.contextualExplanation, allowedNumbers)
    const limitationChecks = parsed.limitations.map(limitation => ({
      limitation,
      unsupported: findUnsupportedNumbers(limitation, allowedNumbers),
    }))
    const unsupportedNumbers = [
      ...explanationUnsupported,
      ...limitationChecks.flatMap(item => item.unsupported),
    ]
    const contextualExplanation = explanationUnsupported.length
      ? 'The deterministic result-analysis tables above provide the authoritative numerical findings for this InVEST run. Interpretive conclusions are limited to those persisted statistics, output inventory, and execution log.'
      : parsed.contextualExplanation
    const limitations = limitationChecks.flatMap(item =>
      item.unsupported.length
        ? ['A limitation containing unsupported numeric values was omitted because it was not directly backed by result-analysis.']
        : [item.limitation])
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
    const highlightMetricIds = parsed.highlightMetricIds.flatMap(id => {
      if (validMetricIds.has(id)) return [id]
      const raster = rasters.find(item => item.filename === id || item.id === id)
      const mapped = raster ? `${raster.role}.total` : undefined
      return mapped && validMetricIds.has(mapped) ? [mapped] : []
    })
    const ignoredHighlightMetricIds = parsed.highlightMetricIds.filter(id => {
      if (validMetricIds.has(id)) return false
      const raster = rasters.find(item => item.filename === id || item.id === id)
      return !raster || !validMetricIds.has(`${raster.role}.total`)
    })

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
      highlightMetricIds,
      contextualExplanation,
      limitations,
    })
    await writeFile(reportPath, markdown, 'utf8')
    const relativePath = relative(root, reportPath).replaceAll('\\', '/')
    const published = publisher
      ? await publisher.publishGeneratedFile({
          sceneId,
          jobId,
          artifactType: 'invest-report',
          name: 'report.md',
          content: markdown,
          fileFormat: 'markdown',
          note: 'Evidence-backed InVEST report generated by the Agent',
        })
      : undefined
      return {
        content: `Wrote InVEST report to ${relativePath}`,
        artifacts: [{
          type: 'invest-report',
          createdBy: 'agent',
          data: { path: relativePath, markdown },
          metadata: { jobId, sceneId, modelId: state.modelId, dataHubFile: published },
        }],
        statePatch: { phase: 'report-written', reportPath: relativePath },
        diagnostics: [
          ...(unsupportedNumbers.length ? [{
              code: 'UNSUPPORTED_REPORT_NUMBERS_OMITTED',
              message:
                `Omitted unsupported numeric prose from the report: ${[...new Set(unsupportedNumbers)].slice(0, 20).join(', ')}`,
              severity: 'warning' as const,
            }] : []),
          ...(ignoredHighlightMetricIds.length ? [{
            code: 'UNKNOWN_REPORT_HIGHLIGHTS_IGNORED',
            message: `Ignored unknown report highlights: ${ignoredHighlightMetricIds.join(', ')}`,
            severity: 'warning' as const,
          }] : []),
        ],
      }
    },
  }
}

export function createReportTools(publisher?: GeneratedFilePublisher): AgentTool[] {
  return [createWriteInvestReportTool(publisher)]
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

function findUnsupportedNumbers(value: string, allowed: Set<string>): string[] {
  return [...value.matchAll(/-?\d[\d,]*(?:\.\d+)?/g)]
    .map(match => normalizeNumber(match[0]))
    .filter(number => !allowed.has(number))
}

function collectAllowedNumbers(value: unknown, result = new Set<string>()): Set<string> {
  if (typeof value === 'number' && Number.isFinite(value)) {
    result.add(normalizeNumber(String(value)))
    result.add(normalizeNumber(value.toLocaleString('en-US', { maximumFractionDigits: 20 })))
    return result
  }
  if (Array.isArray(value)) {
    for (const item of value) collectAllowedNumbers(item, result)
    return result
  }
  if (value && typeof value === 'object') {
    for (const item of Object.values(value)) collectAllowedNumbers(item, result)
  }
  return result
}

function normalizeNumber(value: string): string {
  const parsed = Number(value.replaceAll(',', ''))
  return Number.isFinite(parsed) ? String(parsed) : value
}
