import React from 'react'
import maplibregl from 'maplibre-gl'
import { Crosshair, Layers3, LocateFixed, MousePointer2, Ruler, X } from 'lucide-react'
import { useLayersStore } from '../stores/useStores'
import { Button } from './ui'

const demoGeoJson = {
  type: 'FeatureCollection',
  features: [
    {
      type: 'Feature',
      properties: { name: 'AOI boundary' },
      geometry: {
        type: 'Polygon',
        coordinates: [[[-92, 35], [-77, 35], [-77, 44], [-92, 44], [-92, 35]]],
      },
    },
  ],
} as GeoJSON.FeatureCollection

type SelectedFeature = {
  layerId: string
  layerName: string
  lngLat: [number, number]
  properties: Record<string, unknown>
}

export default function MapCanvas() {
  const mapRef = React.useRef<maplibregl.Map | null>(null)
  const containerRef = React.useRef<HTMLDivElement | null>(null)
  const addedLayers = React.useRef<Record<string, boolean>>({})
  const [ready, setReady] = React.useState(false)
  const [cursor, setCursor] = React.useState('--, --')
  const [zoom, setZoom] = React.useState('1.00')
  const [selectedFeature, setSelectedFeature] = React.useState<SelectedFeature>()
  const { layers, zoomRequest } = useLayersStore()

  React.useEffect(() => {
    if (typeof window === 'undefined' || mapRef.current || !containerRef.current) return

    const map = new maplibregl.Map({
      container: containerRef.current,
      style: {
        version: 8,
        sources: {},
        layers: [
          {
            id: 'workspace-background',
            type: 'background',
            paint: {
              'background-color': '#dbe4ee',
            },
          },
        ],
      },
      center: [-84, 39],
      zoom: 3.2,
      attributionControl: false,
    })

    map.addControl(new maplibregl.NavigationControl({ showCompass: false }), 'top-right')
    map.addControl(new maplibregl.ScaleControl({ maxWidth: 120, unit: 'metric' }), 'bottom-left')
    map.on('load', () => setReady(true))
    map.on('mousemove', event => setCursor(`${event.lngLat.lng.toFixed(4)}, ${event.lngLat.lat.toFixed(4)}`))
    map.on('zoom', () => setZoom(map.getZoom().toFixed(2)))
    mapRef.current = map

    const resize = () => map.resize()
    const resizeObserver = new ResizeObserver(resize)
    resizeObserver.observe(containerRef.current)
    window.requestAnimationFrame(resize)
    window.setTimeout(resize, 250)

    return () => {
      resizeObserver.disconnect()
      map.remove()
      mapRef.current = null
      addedLayers.current = {}
    }
  }, [])

  React.useEffect(() => {
    const map = mapRef.current
    if (!map || !ready) return

    layers.forEach(layer => {
      const sourceId = `src-${layer.id}`
      if (!addedLayers.current[layer.id]) {
        let didAdd = false
        if (layer.type === 'raster') {
          if (layer.rasterUrl && layer.bounds && layer.bounds.length === 4) {
            const [west, south, east, north] = layer.bounds
            map.addSource(sourceId, {
              type: 'image',
              url: layer.rasterUrl,
              coordinates: [
                [west, north],
                [east, north],
                [east, south],
                [west, south],
              ],
            } as maplibregl.ImageSourceSpecification)
            map.addLayer({
              id: layer.id,
              type: 'raster',
              source: sourceId,
              paint: { 'raster-opacity': layer.opacity },
            })
            didAdd = true
          }
        } else {
          map.addSource(sourceId, { type: 'geojson', data: layer.geojsonUrl ?? demoGeoJson })
          map.addLayer({
            id: `${layer.id}-fill`,
            type: 'fill',
            source: sourceId,
            paint: {
              'fill-color': '#14b8a6',
              'fill-opacity': layer.opacity * 0.22,
            },
          })
          map.addLayer({
            id: layer.id,
            type: 'line',
            source: sourceId,
            paint: {
              'line-color': '#0f766e',
              'line-width': 2,
              'line-opacity': layer.opacity,
            },
          })

          const selectFeature = (event: maplibregl.MapLayerMouseEvent) => {
            const feature = event.features?.[0]
            if (!feature) return
            setSelectedFeature({
              layerId: layer.id,
              layerName: layer.name,
              lngLat: [event.lngLat.lng, event.lngLat.lat],
              properties: { ...(feature.properties ?? {}) },
            })
          }

          const setPointer = () => {
            map.getCanvas().style.cursor = 'pointer'
          }
          const clearPointer = () => {
            map.getCanvas().style.cursor = ''
          }

          map.on('click', layer.id, selectFeature)
          map.on('click', `${layer.id}-fill`, selectFeature)
          map.on('mouseenter', layer.id, setPointer)
          map.on('mouseenter', `${layer.id}-fill`, setPointer)
          map.on('mouseleave', layer.id, clearPointer)
          map.on('mouseleave', `${layer.id}-fill`, clearPointer)

          didAdd = true
        }
        if (didAdd) {
          addedLayers.current[layer.id] = true
        }
      }

      const visibility = layer.visible ? 'visible' : 'none'
      if (map.getLayer(layer.id)) {
        map.setLayoutProperty(layer.id, 'visibility', visibility)
      }
      if (map.getLayer(`${layer.id}-fill`)) {
        map.setLayoutProperty(`${layer.id}-fill`, 'visibility', visibility)
      }
      if (layer.type === 'raster' && map.getLayer(layer.id)) {
        map.setPaintProperty(layer.id, 'raster-opacity', layer.opacity)
      }
      if (layer.type === 'geojson') {
        if (map.getLayer(layer.id)) map.setPaintProperty(layer.id, 'line-opacity', layer.opacity)
        if (map.getLayer(`${layer.id}-fill`)) map.setPaintProperty(`${layer.id}-fill`, 'fill-opacity', layer.opacity * 0.22)
      }
    })

    Object.keys(addedLayers.current).forEach(existingId => {
      if (layers.some(layer => layer.id === existingId)) return

      setSelectedFeature(current => (current?.layerId === existingId ? undefined : current))
      if (map.getLayer(existingId)) map.removeLayer(existingId)
      if (map.getLayer(`${existingId}-fill`)) map.removeLayer(`${existingId}-fill`)
      const sourceId = `src-${existingId}`
      if (map.getSource(sourceId)) {
        try {
          map.removeSource(sourceId)
        } catch {
          // Source can be temporarily locked while MapLibre is finalizing layer removal.
        }
      }
      delete addedLayers.current[existingId]
    })
  }, [layers, ready])

  React.useEffect(() => {
    if (!selectedFeature) return
    const layer = layers.find(item => item.id === selectedFeature.layerId)
    if (!layer || !layer.visible) {
      setSelectedFeature(undefined)
    }
  }, [layers, selectedFeature])

  React.useEffect(() => {
    const map = mapRef.current
    if (!map || !ready || !zoomRequest) return
    const [west, south, east, north] = zoomRequest.bounds
    if (![west, south, east, north].every(Number.isFinite)) return

    const minSpan = 0.01
    const adjustedWest = west === east ? west - minSpan : west
    const adjustedEast = west === east ? east + minSpan : east
    const adjustedSouth = south === north ? south - minSpan : south
    const adjustedNorth = south === north ? north + minSpan : north

    map.fitBounds(
      [
        [adjustedWest, adjustedSouth],
        [adjustedEast, adjustedNorth],
      ],
      { padding: 80, duration: 650, maxZoom: 12 },
    )
  }, [ready, zoomRequest])

  const fitWorkspace = () => {
    mapRef.current?.fitBounds(
      [
        [-94, 34],
        [-75, 45],
      ],
      { padding: 72, duration: 600 },
    )
  }

  return (
    <div className="relative h-full min-h-0 overflow-hidden bg-slate-200">
      <div ref={containerRef} className="h-full w-full" />

      <div className="absolute left-4 top-4 flex items-center gap-2 rounded-md border border-white/70 bg-white/95 px-3 py-2 shadow-sm backdrop-blur">
        <Crosshair aria-hidden="true" className="size-4 text-teal-700" />
        <div>
          <div className="text-xs font-semibold text-slate-900">Map canvas</div>
          <div className="text-[11px] text-slate-500">{layers.length} active layers</div>
        </div>
      </div>

      <div className="absolute right-4 top-4 flex flex-col gap-2">
        <Button variant="outline" size="icon" aria-label="Fit workspace" onClick={fitWorkspace}>
          <LocateFixed aria-hidden="true" />
        </Button>
      </div>

      {selectedFeature && (
        <div className="absolute right-4 top-20 w-72 rounded-md border border-white/70 bg-white/95 p-3 text-xs shadow-lg backdrop-blur">
          <div className="mb-2 flex items-start justify-between gap-3">
            <div className="min-w-0">
              <div className="truncate text-sm font-semibold text-slate-900">{selectedFeature.layerName}</div>
              <div className="mt-0.5 text-[11px] text-slate-500">
                {selectedFeature.lngLat[0].toFixed(4)}, {selectedFeature.lngLat[1].toFixed(4)}
              </div>
            </div>
            <button
              className="rounded p-1 text-slate-500 hover:bg-slate-100 hover:text-slate-900"
              aria-label="Close feature properties"
              onClick={() => setSelectedFeature(undefined)}
            >
              <X aria-hidden="true" className="size-4" />
            </button>
          </div>
          <div className="max-h-48 overflow-auto rounded border border-slate-200 bg-slate-50">
            {Object.keys(selectedFeature.properties).length === 0 ? (
              <div className="p-2 text-slate-500">No properties</div>
            ) : (
              Object.entries(selectedFeature.properties).map(([key, value]) => (
                <div key={key} className="grid grid-cols-[88px_minmax(0,1fr)] border-b border-slate-200 last:border-b-0">
                  <div className="truncate px-2 py-1.5 font-medium text-slate-500" title={key}>
                    {key}
                  </div>
                  <div className="truncate px-2 py-1.5 text-slate-800" title={String(value)}>
                    {String(value)}
                  </div>
                </div>
              ))
            )}
          </div>
        </div>
      )}

      <div className="absolute bottom-3 left-3 right-3 flex items-center justify-between gap-3 rounded-md border border-white/70 bg-white/95 px-3 py-2 text-xs text-slate-600 shadow-sm backdrop-blur">
        <span className="inline-flex min-w-0 items-center gap-2">
          <MousePointer2 aria-hidden="true" className="size-4 text-slate-500" />
          <span className="truncate">{cursor}</span>
        </span>
        <span className="hidden items-center gap-2 md:inline-flex">
          <Layers3 aria-hidden="true" className="size-4 text-slate-500" />
          {layers.filter(layer => layer.visible).length} shown
        </span>
        <span className="inline-flex items-center gap-2">
          <Ruler aria-hidden="true" className="size-4 text-slate-500" />
          Zoom {zoom}
        </span>
      </div>
    </div>
  )
}
