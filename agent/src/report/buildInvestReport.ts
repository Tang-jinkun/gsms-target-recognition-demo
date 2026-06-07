import type { Artifact, GoalState } from '@gsms/agent-core'

export interface InvestReportInput {
  goal: GoalState
  state: Record<string, unknown>
  artifacts: Artifact[]
  highlightMetricIds: string[]
  contextualExplanation: string
  limitations: string[]
}

export function buildInvestReport(input: InvestReportInput): string {
  const binding = latest(input.artifacts, 'binding-report')
  const validation = latest(input.artifacts, 'validation-report')
  const confirmation = latest(input.artifacts, 'confirmation-record')
  const job = latest(input.artifacts, 'model-job')
  const status = latest(input.artifacts, 'job-status')
  const inventory = latest(input.artifacts, 'job-output-inventory')
  const analysis = latest(input.artifacts, 'result-analysis')
  const interpretation = latest(input.artifacts, 'result-interpretation-context')
  const outputs = Array.isArray(inventory) ? inventory : []
  const bindings = recordArray(binding, 'bindings')
  const validationRecord = asRecord(validation)
  const validationDetails = asRecord(validationRecord.validation)
  const warnings = stringArray(validationDetails.warnings)
  const errors = stringArray(validationDetails.errors)

  const analysisRecord = asRecord(analysis)
  const analysisRasters = arrayField(analysisRecord, 'rasters')
  const analysisComparisons = arrayField(analysisRecord, 'comparisons')
  const analysisWarnings = stringArray(analysisRecord.warnings)
  const fingerprints = asRecord(analysisRecord.outputFingerprints)

  return [
    '# InVEST Assessment Report',
    '',
    '## Assessment',
    '',
    `- Objective: ${inline(input.goal.objective)}`,
    `- Model: ${inline(input.state.modelId)}`,
    `- Scene: ${inline(input.state.sceneId)}`,
    `- Validation snapshot: ${inline(input.state.validationSnapshotId)}`,
    `- Job: ${inline(input.state.jobId)}`,
    `- Job status: ${inline(input.state.jobStatus)}`,
    '',
    '## Input Bindings',
    '',
    bindings.length
      ? table(
          ['Input slot', 'Selected asset', 'Confidence', 'Reasoning'],
          bindings.map(item => [
            inline(item.slot),
            inline(item.selectedAssetId),
            inline(item.confidence),
            inline(item.agentReasoning),
          ]),
        )
      : 'No persisted Binding Report was available.',
    '',
    '## Validation And Confirmation',
    '',
    `- Validation status: ${inline(validationDetails.status ?? input.state.validationStatus)}`,
    `- User confirmation: ${inline(asRecord(confirmation).status ?? input.state.confirmationStatus)}`,
    `- Validation errors: ${errors.length ? errors.map(inline).join('; ') : 'None recorded'}`,
    `- Validation warnings: ${warnings.length ? warnings.map(inline).join('; ') : 'None recorded'}`,
    '',
    '## Execution',
    '',
    `- Job record: ${inline(asRecord(job).job_id ?? input.state.jobId)}`,
    `- Final status: ${inline(asRecord(status).status ?? input.state.jobStatus)}`,
    `- Output count: ${outputs.length}`,
    '',
    '## Outputs',
    '',
    outputs.length
      ? table(
          ['Name', 'Type', 'Size', 'Download'],
          outputs.map(output => {
            const item = asRecord(output)
            return [
              inline(item.name),
              inline(item.type),
              inline(item.size),
              inline(item.download_url),
            ]
          }),
        )
      : 'No outputs were exposed by GSMS.',
    '',
    ...buildAnalysisSection(analysisRasters, analysisComparisons, analysisWarnings, fingerprints, input.highlightMetricIds),
    '',
    '## Result Interpretation',
    '',
    input.contextualExplanation.trim(),
    '',
    '## Limitations',
    '',
    bullets(input.limitations, 'No additional limitations were supplied.'),
    '',
    '- InVEST outputs are model estimates, not direct observations.',
    '- Ecological causality must not be inferred from model outputs alone.',
    '- All numerical statistics above are deterministic reads from GeoTIFF pixel values, not LLM estimates.',
    '',
    '## Audit Evidence',
    '',
    `- Result analysis available: ${analysis ? 'Yes' : 'No'}`,
    `- Interpretation context persisted: ${interpretation ? 'Yes' : 'No'}`,
    `- Report artifact types used: ${[
      'binding-report',
      'validation-report',
      'confirmation-record',
      'model-job',
      'job-status',
      'job-output-inventory',
      'result-analysis',
      'result-interpretation-context',
    ].join(', ')}`,
    '',
  ].join('\n')
}

function buildAnalysisSection(
  rasters: Record<string, unknown>[],
  comparisons: Record<string, unknown>[],
  analysisWarnings: string[],
  fingerprints: Record<string, unknown>,
  highlightMetricIds: string[],
): string[] {
  if (!rasters.length) {
    return ['## Result Analysis', '', 'No result analysis was available.']
  }

  const lines: string[] = ['## Result Analysis', '']

  // Raster statistics table
  lines.push('### Raster Statistics')
  lines.push('')
  lines.push(table(
    ['Output', 'Role', 'Quantity', 'Valid Pixels', 'Min', 'Max', 'Mean', 'Total', 'P05', 'Median', 'P95'],
    rasters.map(r => {
      const stats = asRecord(r.statistics)
      const highlighted = isHighlighted(r, highlightMetricIds)
      const prefix = highlighted ? '**' : ''
      const suffix = highlighted ? '**' : ''
      return [
        `${prefix}${inline(r.filename)}${suffix}`,
        inline(r.role),
        inline(r.quantity),
        formatNumber(stats.validPixels),
        formatNumber(stats.minimum),
        formatNumber(stats.maximum),
        formatNumber(stats.mean),
        formatNumber(stats.total),
        formatNumber(stats.p05),
        formatNumber(stats.median),
        formatNumber(stats.p95),
      ]
    }),
  ))
  lines.push('')

  // Carbon change details
  const changeRaster = rasters.find(r => r.role === 'carbon-change')
  if (changeRaster) {
    const stats = asRecord(changeRaster.statistics)
    if (typeof stats.positivePixels === 'number') {
      lines.push('### Carbon Change Distribution')
      lines.push('')
      lines.push(`- Positive change pixels: ${formatNumber(stats.positivePixels)}`)
      lines.push(`- Negative change pixels: ${formatNumber(stats.negativePixels)}`)
      lines.push(`- Zero change pixels: ${formatNumber(stats.zeroPixels)}`)
      lines.push(`- Positive change total: ${formatNumber(stats.positiveTotal)}`)
      lines.push(`- Negative change total: ${formatNumber(stats.negativeTotal)}`)
      lines.push('')
    }
  }

  // Consistency checks
  if (comparisons.length) {
    lines.push('### Consistency Checks')
    lines.push('')
    for (const comp of comparisons) {
      const status = comp.status === 'passed' ? '✅' : comp.status === 'warning' ? '⚠️' : '➖'
      lines.push(`- **${inline(comp.kind)}**: ${status} ${inline(comp.explanation)}`)
    }
    lines.push('')
  }

  // Spatial metadata
  lines.push('### Spatial Metadata')
  lines.push('')
  lines.push(table(
    ['Output', 'CRS', 'Width', 'Height', 'Nodata'],
    rasters.map(r => {
      const stats = asRecord(r.statistics)
      const spatial = asRecord(stats.spatial)
      return [
        inline(r.filename),
        inline(spatial.crs),
        formatNumber(spatial.width),
        formatNumber(spatial.height),
        formatNumber(spatial.nodata),
      ]
    }),
  ))
  lines.push('')

  // Output fingerprints
  const fingerprintEntries = Object.entries(fingerprints)
  if (fingerprintEntries.length) {
    lines.push('### Output Fingerprints')
    lines.push('')
    for (const [name, hash] of fingerprintEntries) {
      lines.push(`- ${inline(name)}: \`${String(hash).slice(0, 16)}…\``)
    }
    lines.push('')
  }

  // Analysis warnings
  if (analysisWarnings.length) {
    lines.push('### Analysis Warnings')
    lines.push('')
    lines.push(bullets(analysisWarnings, ''))
    lines.push('')
  }

  return lines
}

function isHighlighted(raster: Record<string, unknown>, highlightMetricIds: string[]): boolean {
  if (!highlightMetricIds.length) return false
  const role = String(raster.role ?? '')
  return highlightMetricIds.some(id => id.startsWith(`${role}.`))
}

function formatNumber(value: unknown): string {
  if (value === undefined || value === null) return 'N/A'
  if (typeof value === 'number') {
    if (Number.isInteger(value)) return value.toLocaleString()
    return value.toLocaleString(undefined, { maximumFractionDigits: 4 })
  }
  return String(value)
}

function latest(artifacts: Artifact[], type: string): unknown {
  return artifacts.filter(artifact => artifact.type === type).at(-1)?.data
}

function asRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {}
}

function arrayField(record: Record<string, unknown>, key: string): Record<string, unknown>[] {
  const items = record[key]
  return Array.isArray(items) ? items.map(asRecord) : []
}

function recordArray(value: unknown, key: string): Record<string, unknown>[] {
  const items = asRecord(value)[key]
  return Array.isArray(items) ? items.map(asRecord) : []
}

function stringArray(value: unknown): string[] {
  return Array.isArray(value) ? value.map(String) : []
}

function inline(value: unknown): string {
  if (value === undefined || value === null || value === '') return 'Not recorded'
  return String(value).replaceAll('|', '\\|').replaceAll(/\r?\n/g, ' ')
}

function bullets(items: string[], empty: string): string {
  return items.length ? items.map(item => `- ${item.trim()}`).join('\n') : empty
}

function table(headers: string[], rows: string[][]): string {
  return [
    `| ${headers.join(' | ')} |`,
    `| ${headers.map(() => '---').join(' | ')} |`,
    ...rows.map(row => `| ${row.join(' | ')} |`),
  ].join('\n')
}
