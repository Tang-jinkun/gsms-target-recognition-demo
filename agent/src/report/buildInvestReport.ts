import type { Artifact, GoalState } from '@gsms/agent-core'

export interface InvestReportInput {
  goal: GoalState
  state: Record<string, unknown>
  artifacts: Artifact[]
  resultSummary: string
  keyFindings: string[]
  limitations: string[]
}

export function buildInvestReport(input: InvestReportInput): string {
  const binding = latest(input.artifacts, 'binding-report')
  const validation = latest(input.artifacts, 'validation-report')
  const confirmation = latest(input.artifacts, 'confirmation-record')
  const job = latest(input.artifacts, 'model-job')
  const status = latest(input.artifacts, 'job-status')
  const inventory = latest(input.artifacts, 'job-output-inventory')
  const interpretation = latest(input.artifacts, 'result-interpretation-context')
  const outputs = Array.isArray(inventory) ? inventory : []
  const bindings = recordArray(binding, 'bindings')
  const validationRecord = asRecord(validation)
  const validationDetails = asRecord(validationRecord.validation)
  const warnings = stringArray(validationDetails.warnings)
  const errors = stringArray(validationDetails.errors)

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
    '## Result Interpretation',
    '',
    input.resultSummary.trim(),
    '',
    '### Key Findings',
    '',
    bullets(input.keyFindings, 'No evidence-backed findings were supplied.'),
    '',
    '## Limitations',
    '',
    bullets(input.limitations, 'No additional limitations were supplied.'),
    '',
    '- InVEST outputs are model estimates, not direct observations.',
    '- Ecological causality must not be inferred from model outputs alone.',
    '',
    '## Audit Evidence',
    '',
    `- Interpretation context persisted: ${interpretation ? 'Yes' : 'No'}`,
    `- Report artifact types used: ${[
      'binding-report',
      'validation-report',
      'confirmation-record',
      'model-job',
      'job-status',
      'job-output-inventory',
      'result-interpretation-context',
    ].join(', ')}`,
    '',
  ].join('\n')
}

function latest(artifacts: Artifact[], type: string): unknown {
  return artifacts.filter(artifact => artifact.type === type).at(-1)?.data
}

function asRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {}
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
