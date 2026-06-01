import React from 'react'
import { Clipboard, Download, Plus, TriangleAlert } from 'lucide-react'
import { useJobsStore, useLayersStore } from '../../stores/useStores'
import { formatBytes } from '../../lib/format'
import { Button } from '../ui'

export default function ResultsTab() {
  const { activeJobId, activeJobStatus, logs, outputs, jobHistory, selectJob } = useJobsStore()
  const { addOutputLayer } = useLayersStore()

  return (
    <div className="flex flex-col">
      <section className="border-b border-slate-200 p-4">
        <h3 className="text-sm font-semibold">Job status</h3>
        <div className="mt-3 rounded-md border border-slate-200 bg-slate-50 p-3">
          <div className="flex items-center justify-between text-sm">
            <span className="text-slate-500">Status</span>
            <span className="font-medium capitalize">{activeJobStatus}</span>
          </div>
          <div className="mt-2 flex items-center justify-between text-sm">
            <span className="text-slate-500">Job ID</span>
            <span className="max-w-[210px] truncate font-mono text-xs text-slate-700">{activeJobId ?? 'none'}</span>
          </div>
        </div>
        {activeJobStatus === 'succeeded' && (
          <div className="mt-3 rounded-md border border-emerald-200 bg-emerald-50 px-3 py-2 text-xs leading-5 text-emerald-800">
            Carbon job completed. Outputs are available below; the primary raster is added to the map automatically when possible.
          </div>
        )}
        {activeJobStatus === 'failed' && (
          <div className="mt-3 flex gap-2 rounded-md border border-red-200 bg-red-50 px-3 py-2 text-xs leading-5 text-red-700">
            <TriangleAlert aria-hidden="true" className="mt-0.5 size-4 shrink-0" />
            <span>Job failed. Check the log tail for the first ERROR entry and verify inputs or the InVEST environment.</span>
          </div>
        )}
      </section>

      <section className="border-b border-slate-200 p-4">
        <div className="flex items-center justify-between">
          <h3 className="text-sm font-semibold">Recent jobs</h3>
          <span className="rounded bg-slate-100 px-2 py-1 text-xs text-slate-500">{jobHistory.length}</span>
        </div>
        <div className="mt-3 flex max-h-48 flex-col gap-2 overflow-auto">
          {jobHistory.length === 0 ? (
            <div className="rounded-md border border-dashed border-slate-300 bg-slate-50 px-3 py-4 text-center text-xs text-slate-500">
              No job history yet.
            </div>
          ) : (
            jobHistory.map(job => (
              <button
                key={job.jobId}
                className={`rounded-md border p-3 text-left transition ${
                  activeJobId === job.jobId
                    ? 'border-slate-900 bg-slate-100'
                    : 'border-slate-200 bg-white hover:border-slate-300 hover:bg-slate-50'
                }`}
                onClick={() => void selectJob(job.jobId)}
              >
                <div className="flex items-center justify-between gap-3">
                  <span className="truncate font-mono text-xs text-slate-700">{job.jobId}</span>
                  <span className="shrink-0 rounded bg-slate-100 px-1.5 py-0.5 text-[11px] capitalize text-slate-600">
                    {job.status}
                  </span>
                </div>
                <div className="mt-1 flex items-center justify-between gap-3 text-xs text-slate-500">
                  <span>{job.runMode} / {job.resultsSuffix ?? 'no suffix'}</span>
                  <span>{job.outputsCount} outputs</span>
                </div>
              </button>
            ))
          )}
        </div>
      </section>

      <section className="border-b border-slate-200 p-4">
        <div className="flex items-center justify-between">
          <h3 className="text-sm font-semibold">Outputs</h3>
          <span className="rounded bg-slate-100 px-2 py-1 text-xs text-slate-500">{outputs.length} files</span>
        </div>
        <div className="mt-3 flex flex-col gap-2">
          {outputs.length === 0 ? (
            <div className="rounded-md border border-dashed border-slate-300 bg-slate-50 px-3 py-4 text-center text-xs text-slate-500">
              Outputs will appear after a successful run.
            </div>
          ) : (
            outputs.map(output => {
              const canMapOutput = Boolean(
                (output.type === 'geojson' && output.geojsonUrl) || (output.type === 'raster' && output.previewUrl),
              )
              return (
                <div
                  key={output.id}
                  className="group flex items-center justify-between gap-3 rounded-md border border-slate-200 bg-white p-3 transition hover:border-slate-300"
                >
                  <div className="min-w-0">
                    <div className="truncate text-sm font-medium text-slate-900">{output.name}</div>
                    <div className="mt-1 text-xs text-slate-500">{formatBytes(output.size)} | {output.type}</div>
                  </div>
                  <div className="flex items-center gap-1 opacity-0 transition group-hover:opacity-100 focus-within:opacity-100">
                    <Button
                      variant="outline"
                      size="icon"
                      aria-label={`Add output ${output.name} to map`}
                      disabled={!canMapOutput}
                      onClick={() => addOutputLayer(output)}
                    >
                      <Plus aria-hidden="true" />
                    </Button>
                    <Button
                      variant="outline"
                      size="icon"
                      aria-label={`Download ${output.name}`}
                      onClick={() => window.open(output.downloadUrl, '_blank', 'noopener')}
                    >
                      <Download aria-hidden="true" />
                    </Button>
                  </div>
                </div>
              )
            })
          )}
        </div>
      </section>

      <LogConsole logs={logs} failed={activeJobStatus === 'failed'} />
    </div>
  )
}

function LogConsole({ logs, failed }: { logs: string; failed: boolean }) {
  const logsRef = React.useRef<HTMLPreElement | null>(null)
  const [copied, setCopied] = React.useState(false)

  React.useEffect(() => {
    const panel = logsRef.current
    if (panel) panel.scrollTop = panel.scrollHeight
  }, [logs])

  const handleCopy = async () => {
    try {
      await navigator.clipboard.writeText(logs)
      setCopied(true)
      window.setTimeout(() => setCopied(false), 1400)
    } catch {
      setCopied(false)
    }
  }

  return (
    <section className="p-4">
      <div className="mb-3 flex items-center justify-between">
        <h3 className="text-sm font-semibold">Logs</h3>
        <div className="flex items-center gap-2">
          {copied && <span className="text-xs text-slate-500">Copied</span>}
          <Button variant="outline" size="icon" aria-label="Copy logs" onClick={() => void handleCopy()}>
            <Clipboard aria-hidden="true" />
          </Button>
        </div>
      </div>
      <pre
        ref={logsRef}
        className={`h-72 overflow-auto rounded-md p-3 font-mono text-xs leading-5 shadow-inner ${
          failed ? 'border border-red-400 bg-red-950 text-red-50' : 'bg-slate-950 text-slate-100'
        }`}
      >
        {logs}
      </pre>
    </section>
  )
}
