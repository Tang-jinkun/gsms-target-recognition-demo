import React from 'react'
import { Activity, Database, FolderUp, Map, Settings } from 'lucide-react'
import LeftPanel from './LeftPanel'
import MapCanvas from './MapCanvas'
import RightPanel from './RightPanel'
import { Button } from './ui'
import { useAssetsStore, useJobsStore, useLayersStore } from '../stores/useStores'

export default function Layout() {
  const { assets, useSampleData } = useAssetsStore()
  const { layers } = useLayersStore()
  const { activeJobStatus } = useJobsStore()

  return (
    <div className="flex h-screen min-h-0 overflow-x-auto bg-slate-100 text-slate-950">
      <div className="flex min-w-[1180px] flex-1 flex-col">
        <header className="flex h-14 shrink-0 items-center justify-between border-b border-slate-200 bg-white px-4">
          <div className="flex items-center gap-3">
            <div className="flex size-9 items-center justify-center rounded-md bg-slate-950 text-white">
              <Map aria-hidden="true" />
            </div>
            <div className="leading-tight">
              <h1 className="text-sm font-semibold tracking-tight">InVEST WebGIS Workbench</h1>
              <p className="text-xs text-slate-500">Default project</p>
            </div>
          </div>

          <div className="hidden items-center gap-2 text-xs text-slate-500 md:flex">
            <span className="inline-flex items-center gap-1">
              <Database aria-hidden="true" className="size-3.5" />
              {assets.length} assets
            </span>
            <span className="h-4 w-px bg-slate-200" />
            <span>{layers.length} layers</span>
            <span className="h-4 w-px bg-slate-200" />
            <span className="inline-flex items-center gap-1">
              <Activity aria-hidden="true" className="size-3.5" />
              {activeJobStatus}
            </span>
          </div>

          <div className="flex items-center gap-2">
            <Button
              variant="ghost"
              size="sm"
              className="text-slate-500"
              title="Fill the workbench with offline placeholder rows (no backend files; not runnable)"
              onClick={useSampleData}
            >
              <FolderUp aria-hidden="true" data-icon="inline-start" />
              Demo data
            </Button>
            <Button variant="ghost" size="icon" aria-label="Settings">
              <Settings aria-hidden="true" />
            </Button>
          </div>
        </header>

        <main className="grid min-h-0 flex-1 grid-cols-[320px_minmax(460px,1fr)_400px] overflow-hidden">
          <aside className="min-h-0 border-r border-slate-200 bg-white">
            <LeftPanel />
          </aside>
          <section className="min-h-0 bg-slate-200">
            <MapCanvas />
          </section>
          <aside className="min-h-0 border-l border-slate-200 bg-white">
            <RightPanel />
          </aside>
        </main>
      </div>
    </div>
  )
}
