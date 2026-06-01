import React from 'react'
import {
  Download,
  Eye,
  EyeOff,
  FileText,
  Info,
  Layers,
  LocateFixed,
  MapPinned,
  Plus,
  RefreshCw,
  Trash2,
  Upload,
} from 'lucide-react'
import {
  useAssetsStore,
  useJobsStore,
  useLayersStore,
  type Asset,
  type AssetMetadata,
  type AssetType,
  type JobOutput,
} from '../stores/useStores'
import { Button, SegmentedTabs } from './ui'
import { formatBytes } from '../lib/format'

function typeLabel(type: AssetType) {
  const labels: Record<AssetType, string> = {
    raster: 'Raster',
    geojson: 'Vector',
    table: 'Table',
    document: 'Document',
    unknown: 'Unknown',
  }
  return labels[type]
}

export default function LeftPanel() {
  const [tab, setTab] = React.useState<'files' | 'layers'>('files')
  const [uploadError, setUploadError] = React.useState<string>()
  const [expandedAssetId, setExpandedAssetId] = React.useState<string>()
  const fileInputRef = React.useRef<HTMLInputElement | null>(null)
  const {
    assets,
    assetsStatus,
    assetsError,
    assetMetadata,
    metadataStatus,
    metadataError,
    loadAssets,
    uploadAsset,
    uploadAssets,
    loadAssetMetadata,
    deleteAsset,
  } = useAssetsStore()
  const { outputs, activeJobId } = useJobsStore()
  const { layers, addLayer, addOutputLayer, updateLayer, removeLayer, zoomToLayer } = useLayersStore()

  const canMap = (asset: Asset) => asset.type === 'raster' || asset.type === 'geojson'

  const handleUpload = async (event: React.ChangeEvent<HTMLInputElement>) => {
    const files = Array.from(event.target.files ?? [])
    if (files.length === 0) return
    setUploadError(undefined)
    try {
      if (files.length === 1) {
        await uploadAsset(files[0])
      } else {
        await uploadAssets(files)
      }
      setTab('files')
    } catch (error) {
      setUploadError(error instanceof Error ? error.message : 'Upload failed')
    } finally {
      event.target.value = ''
    }
  }

  const toggleMetadata = (asset: Asset) => {
    const nextId = expandedAssetId === asset.id ? undefined : asset.id
    setExpandedAssetId(nextId)
    if (nextId && !assetMetadata[asset.id] && metadataStatus[asset.id] !== 'loading') {
      void loadAssetMetadata(asset.id)
    }
  }

  const handleDeleteAsset = async (asset: Asset) => {
    setUploadError(undefined)
    try {
      await deleteAsset(asset.id)
      if (expandedAssetId === asset.id) setExpandedAssetId(undefined)
    } catch (error) {
      setUploadError(error instanceof Error ? error.message : 'Delete failed')
    }
  }

  return (
    <div className="flex h-full min-h-0 flex-col">
      <div className="border-b border-slate-200 p-3">
        <SegmentedTabs<'files' | 'layers'>
          value={tab}
          onChange={setTab}
          items={[
            { value: 'files', label: 'Files', icon: <FileText aria-hidden="true" className="size-4" /> },
            { value: 'layers', label: 'Layers', icon: <Layers aria-hidden="true" className="size-4" /> },
          ]}
        />
      </div>

      {tab === 'files' ? (
        <div className="flex min-h-0 flex-1 flex-col">
          <div className="flex items-center justify-between border-b border-slate-200 px-3 py-2">
            <div>
              <h2 className="text-sm font-semibold">Project files</h2>
              <p className="text-xs text-slate-500">{assetsStatus === 'error' ? 'Using local sample rows' : 'Backend asset index'}</p>
            </div>
            <div className="flex items-center gap-1">
              <Button variant="ghost" size="icon" aria-label="Refresh assets" onClick={() => void loadAssets()}>
                <RefreshCw aria-hidden="true" className={assetsStatus === 'loading' ? 'animate-spin' : ''} />
              </Button>
              <Button variant="outline" size="icon" aria-label="Upload assets" title="Upload one or more assets" onClick={() => fileInputRef.current?.click()}>
                <Upload aria-hidden="true" />
              </Button>
              <input
                ref={fileInputRef}
                type="file"
                className="hidden"
                multiple
                accept=".tif,.tiff,.geojson,.json,.zip,.csv,.html,.txt"
                onChange={handleUpload}
              />
            </div>
          </div>

          {(assetsError || uploadError) && (
            <div className="border-b border-amber-200 bg-amber-50 px-3 py-2 text-xs text-amber-800">
              {uploadError ?? assetsError}
            </div>
          )}

          <div className="min-h-0 flex-1 overflow-auto p-2">
            <div className="flex flex-col gap-4">
              <FileGroup
                title="Project inputs"
                count={assets.length}
                description="Uploaded or imported assets available for model inputs."
              >
                {assets.length === 0 ? (
                  <EmptyFileGroup label="No project input assets" />
                ) : (
                  assets.map(asset => (
                    <AssetCard
                      key={asset.id}
                      asset={asset}
                      expanded={expandedAssetId === asset.id}
                      metadata={assetMetadata[asset.id]}
                      metadataStatus={metadataStatus[asset.id]}
                      metadataError={metadataError[asset.id]}
                      canMap={canMap(asset)}
                      onToggleMetadata={() => toggleMetadata(asset)}
                      onAddToMap={() => addLayer(asset)}
                      onDelete={() => void handleDeleteAsset(asset)}
                    />
                  ))
                )}
              </FileGroup>

              <FileGroup
                title="Selected job outputs"
                count={outputs.length}
                description={activeJobId ? `Outputs from ${activeJobId}` : 'Select or run a job to inspect outputs.'}
              >
                {outputs.length === 0 ? (
                  <EmptyFileGroup label="No selected job outputs" />
                ) : (
                  outputs.map(output => (
                    <OutputCard
                      key={output.id}
                      output={output}
                      onAddToMap={() => addOutputLayer(output)}
                      onDownload={() => window.open(output.downloadUrl, '_blank')}
                    />
                  ))
                )}
              </FileGroup>
            </div>
          </div>
        </div>
      ) : (
        <div className="flex min-h-0 flex-1 flex-col">
          <div className="border-b border-slate-200 px-3 py-2">
            <h2 className="text-sm font-semibold">Map layers</h2>
            <p className="text-xs text-slate-500">{layers.length} visible workspace layers</p>
          </div>

          <div className="min-h-0 flex-1 overflow-auto p-2">
            {layers.length === 0 ? (
              <div className="flex h-full flex-col items-center justify-center gap-3 rounded-md border border-dashed border-slate-300 bg-slate-50 p-6 text-center text-sm text-slate-500">
                <MapPinned aria-hidden="true" className="size-8 text-slate-400" />
                <span>No layers on the map</span>
              </div>
            ) : (
              <div className="flex flex-col gap-2">
                {layers.map(layer => (
                  <div key={layer.id} className="group rounded-md border border-slate-200 bg-white p-3 transition hover:border-slate-300">
                    <div className="flex items-start justify-between gap-2">
                      <div className="min-w-0">
                        <div className="truncate text-sm font-medium">{layer.name}</div>
                        <div className="mt-1 text-xs text-slate-500">{layer.type === 'raster' ? 'Raster preview' : 'GeoJSON preview'}</div>
                      </div>
                      <div className="flex items-center gap-1 opacity-0 transition group-hover:opacity-100 focus-within:opacity-100">
                        <Button
                          variant="ghost"
                          size="icon"
                          aria-label={layer.visible ? 'Hide layer' : 'Show layer'}
                          onClick={() => updateLayer(layer.id, { visible: !layer.visible })}
                        >
                          {layer.visible ? <Eye aria-hidden="true" /> : <EyeOff aria-hidden="true" />}
                        </Button>
                        <Button
                          variant="ghost"
                          size="icon"
                          aria-label={`Zoom to ${layer.name}`}
                          disabled={!layer.bounds}
                          onClick={() => zoomToLayer(layer.id)}
                        >
                          <LocateFixed aria-hidden="true" />
                        </Button>
                        <Button variant="ghost" size="icon" aria-label="Remove layer" onClick={() => removeLayer(layer.id)}>
                          <Trash2 aria-hidden="true" />
                        </Button>
                      </div>
                    </div>
                    <label className="mt-3 flex items-center gap-3 text-xs text-slate-500">
                      <span className="w-12">Opacity</span>
                      <input
                        className="h-2 flex-1 accent-slate-900"
                        type="range"
                        min="0"
                        max="1"
                        step="0.05"
                        value={layer.opacity}
                        onChange={event => updateLayer(layer.id, { opacity: Number(event.target.value) })}
                      />
                      <span className="w-8 text-right">{Math.round(layer.opacity * 100)}%</span>
                    </label>
                  </div>
                ))}
              </div>
            )}
          </div>
        </div>
      )}
    </div>
  )
}

function FileGroup({
  title,
  count,
  description,
  children,
}: {
  title: string
  count: number
  description: string
  children: React.ReactNode
}) {
  return (
    <section>
      <div className="mb-2 flex items-start justify-between gap-3 px-1">
        <div className="min-w-0">
          <h3 className="text-xs font-semibold uppercase tracking-wide text-slate-600">{title}</h3>
          <p className="mt-0.5 truncate text-[11px] text-slate-500" title={description}>
            {description}
          </p>
        </div>
        <span className="rounded bg-slate-100 px-1.5 py-0.5 text-[11px] text-slate-500">{count}</span>
      </div>
      <div className="flex flex-col gap-2">{children}</div>
    </section>
  )
}

function EmptyFileGroup({ label }: { label: string }) {
  return (
    <div className="rounded-md border border-dashed border-slate-300 bg-slate-50 px-3 py-4 text-center text-xs text-slate-500">
      {label}
    </div>
  )
}

function AssetCard({
  asset,
  expanded,
  metadata,
  metadataStatus,
  metadataError,
  canMap,
  onToggleMetadata,
  onAddToMap,
  onDelete,
}: {
  asset: Asset
  expanded: boolean
  metadata?: AssetMetadata
  metadataStatus?: 'loading' | 'ready' | 'error'
  metadataError?: string
  canMap: boolean
  onToggleMetadata: () => void
  onAddToMap: () => void
  onDelete: () => void
}) {
  return (
    <div className="group rounded-md border border-slate-200 bg-white p-3 transition hover:border-slate-300">
      <div className="flex items-start justify-between gap-3">
        <div className="min-w-0">
          <div className="truncate text-sm font-medium text-slate-900">{asset.name}</div>
          <div className="mt-1 flex items-center gap-2 text-xs text-slate-500">
            <span className="rounded bg-slate-100 px-1.5 py-0.5 font-medium text-slate-600">{typeLabel(asset.type)}</span>
            <span>{formatBytes(asset.size)}</span>
          </div>
        </div>
        <div className={`flex items-center gap-1 transition focus-within:opacity-100 group-hover:opacity-100 ${expanded ? '' : 'opacity-0'}`}>
          <Button variant="ghost" size="icon" aria-label={`View metadata for ${asset.name}`} onClick={onToggleMetadata}>
            <Info aria-hidden="true" />
          </Button>
          <Button
            variant={canMap ? 'secondary' : 'ghost'}
            size="icon"
            aria-label={`Add ${asset.name} to map`}
            disabled={!canMap}
            onClick={onAddToMap}
          >
            <Plus aria-hidden="true" />
          </Button>
          <Button variant="ghost" size="icon" aria-label={`Delete ${asset.name}`} onClick={onDelete}>
            <Trash2 aria-hidden="true" />
          </Button>
        </div>
      </div>
      {expanded && <MetadataDetails metadata={metadata} status={metadataStatus} error={metadataError} />}
    </div>
  )
}

function OutputCard({
  output,
  onAddToMap,
  onDownload,
}: {
  output: JobOutput
  onAddToMap: () => void
  onDownload: () => void
}) {
  const canMapOutput = Boolean((output.type === 'geojson' && output.geojsonUrl) || (output.type === 'raster' && output.previewUrl))

  return (
    <div className="group rounded-md border border-emerald-200 bg-emerald-50/60 p-3 transition hover:border-emerald-300">
      <div className="flex items-start justify-between gap-3">
        <div className="min-w-0">
          <div className="truncate text-sm font-medium text-slate-900">{output.name}</div>
          <div className="mt-1 flex items-center gap-2 text-xs text-slate-500">
            <span className="rounded bg-white px-1.5 py-0.5 font-medium text-emerald-700">{typeLabel(output.type)}</span>
            <span>{formatBytes(output.size)}</span>
          </div>
        </div>
        <div className="flex items-center gap-1 opacity-0 transition focus-within:opacity-100 group-hover:opacity-100">
          <Button
            variant={canMapOutput ? 'secondary' : 'ghost'}
            size="icon"
            aria-label={`Add output ${output.name} to map`}
            disabled={!canMapOutput}
            onClick={onAddToMap}
          >
            <Plus aria-hidden="true" />
          </Button>
          <Button variant="ghost" size="icon" aria-label={`Download ${output.name}`} onClick={onDownload}>
            <Download aria-hidden="true" />
          </Button>
        </div>
      </div>
    </div>
  )
}

function MetadataDetails({
  metadata,
  status,
  error,
}: {
  metadata?: AssetMetadata
  status?: 'loading' | 'ready' | 'error'
  error?: string
}) {
  if (status === 'loading') {
    return <div className="mt-3 rounded-md bg-slate-50 px-3 py-2 text-xs text-slate-500">Loading metadata...</div>
  }

  if (status === 'error') {
    return <div className="mt-3 rounded-md border border-amber-200 bg-amber-50 px-3 py-2 text-xs text-amber-800">{error}</div>
  }

  if (!metadata) {
    return <div className="mt-3 rounded-md bg-slate-50 px-3 py-2 text-xs text-slate-500">No metadata loaded.</div>
  }

  const rows = [
    ['Format', metadata.format],
    ['CRS', metadata.crs],
    ['Bounds (WGS84)', metadata.boundsWgs84?.map(value => Number(value).toFixed(4)).join(', ')],
    ['Bounds', metadata.bounds?.map(value => Number(value).toFixed(4)).join(', ')],
    ['Raster size', metadata.width && metadata.height ? `${metadata.width} x ${metadata.height}` : undefined],
    ['Bands', metadata.band_count ? String(metadata.band_count) : undefined],
    ['Columns', metadata.columns?.join(', ')],
    ['Rows', metadata.row_count !== undefined ? String(metadata.row_count) : undefined],
    ['Features', metadata.feature_count !== undefined ? String(metadata.feature_count) : undefined],
    ['Note', metadata.note],
    ['Error', metadata.metadata_error],
  ].filter(([, value]) => value !== undefined && value !== null && value !== '')

  return (
    <div className="mt-3 rounded-md border border-slate-200 bg-slate-50 p-3">
      <div className="flex flex-col gap-1.5">
        {rows.map(([label, value]) => (
          <div key={label} className="grid grid-cols-[72px_minmax(0,1fr)] gap-2 text-xs">
            <span className="text-slate-500">{label}</span>
            <span className="truncate font-medium text-slate-700" title={String(value)}>
              {value}
            </span>
          </div>
        ))}
      </div>
      {metadata.preview && (
        <pre className="mt-3 max-h-24 overflow-auto rounded bg-white p-2 text-[11px] leading-4 text-slate-600">
          {metadata.preview}
        </pre>
      )}
    </div>
  )
}
