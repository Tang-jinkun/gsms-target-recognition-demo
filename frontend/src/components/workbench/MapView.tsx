import React from 'react'
import maplibregl from 'maplibre-gl'

const DEFAULT_BASEMAP_TILE_URL = 'https://tile.openstreetmap.org/{z}/{x}/{y}.png'
const BASEMAP_TILE_URL = process.env.NEXT_PUBLIC_BASEMAP_TILE_URL || DEFAULT_BASEMAP_TILE_URL

export type WbLayer = {
  id: string
  name: string
  type: 'raster' | 'vector'
  visible: boolean
  opacity: number // 0-100
  rasterUrl?: string
  geojsonUrl?: string
  bounds?: number[] | null // [w,s,e,n] WGS84
  role?: 'target-highlight'
  style?: {
    circleColor?: string
    circleRadius?: number
    circleStrokeColor?: string
  }
}

/**
 * Real MapLibre map driven by props (adapted from the existing MapCanvas).
 * Replaces the prototype's gridded placeholder; the surrounding chrome stays
 * the prototype's. `active` triggers a resize when the Map/Split view is shown.
 */
export default function MapView({ layers, fitNonce, active }: { layers: WbLayer[]; fitNonce?: number; active: boolean }) {
  const containerRef = React.useRef<HTMLDivElement | null>(null)
  const mapRef = React.useRef<maplibregl.Map | null>(null)
  const added = React.useRef<Record<string, boolean>>({})
  const [ready, setReady] = React.useState(false)

  React.useEffect(() => {
    if (typeof window === 'undefined' || mapRef.current || !containerRef.current) return
    const map = new maplibregl.Map({
      container: containerRef.current,
      style: {
        version: 8,
        sources: {
          osm: {
            type: 'raster',
            tiles: [BASEMAP_TILE_URL],
            tileSize: 256,
            attribution: '&copy; OpenStreetMap contributors',
          },
        },
        layers: [
          { id: 'bg', type: 'background', paint: { 'background-color': '#dbe4ee' } },
          { id: 'osm-basemap', type: 'raster', source: 'osm' },
        ],
      },
      center: [113, 30.6],
      zoom: 5.5,
      attributionControl: false,
    })
    map.addControl(new maplibregl.NavigationControl({ showCompass: false }), 'top-right')
    map.addControl(new maplibregl.ScaleControl({ maxWidth: 120, unit: 'metric' }), 'bottom-left')
    map.addControl(new maplibregl.AttributionControl({ compact: true }), 'bottom-right')
    map.on('load', () => setReady(true))
    mapRef.current = map
    const ro = new ResizeObserver(() => map.resize())
    ro.observe(containerRef.current)
    return () => { ro.disconnect(); map.remove(); mapRef.current = null; added.current = {} }
  }, [])

  // resize when the panel becomes visible (Map/Split tabs)
  React.useEffect(() => { if (active && mapRef.current) window.setTimeout(() => mapRef.current?.resize(), 60) }, [active])

  React.useEffect(() => {
    const map = mapRef.current
    if (!map || !ready) return
    layers.forEach(layer => {
      const srcId = `src-${layer.id}`
      if (!added.current[layer.id]) {
        if (layer.type === 'raster' && layer.rasterUrl && layer.bounds?.length === 4) {
          const [w, s, e, n] = layer.bounds
          map.addSource(srcId, { type: 'image', url: layer.rasterUrl, coordinates: [[w, n], [e, n], [e, s], [w, s]] } as maplibregl.ImageSourceSpecification)
          map.addLayer({ id: layer.id, type: 'raster', source: srcId, paint: { 'raster-opacity': layer.opacity / 100 } })
          added.current[layer.id] = true
        } else if (layer.type === 'vector' && layer.geojsonUrl) {
          map.addSource(srcId, { type: 'geojson', data: layer.geojsonUrl })
          map.addLayer({ id: `${layer.id}-fill`, type: 'fill', source: srcId, paint: { 'fill-color': '#14b8a6', 'fill-opacity': (layer.opacity / 100) * 0.22 } })
          map.addLayer({ id: layer.id, type: 'line', source: srcId, paint: { 'line-color': '#0f766e', 'line-width': 2, 'line-opacity': layer.opacity / 100 } })
          map.addLayer({
            id: `${layer.id}-circle`,
            type: 'circle',
            source: srcId,
            paint: {
              'circle-color': layer.style?.circleColor ?? (layer.role === 'target-highlight' ? '#ef4444' : '#14b8a6'),
              'circle-radius': layer.style?.circleRadius ?? (layer.role === 'target-highlight' ? 8 : 5),
              'circle-stroke-color': layer.style?.circleStrokeColor ?? '#ffffff',
              'circle-stroke-width': 2,
              'circle-opacity': layer.opacity / 100,
            },
          })
          map.on('click', `${layer.id}-circle`, event => {
            const feature = event.features?.[0]
            if (!feature) return
            const rows = Object.entries(feature.properties ?? {})
              .filter(([key]) => !key.startsWith('_'))
              .map(([key, value]) => `<div><strong>${escapeHtml(key)}</strong>: ${escapeHtml(String(value ?? ''))}</div>`)
              .join('')
            new maplibregl.Popup({ maxWidth: '360px' })
              .setLngLat(event.lngLat)
              .setHTML(`<div style="max-height:260px;overflow:auto">${rows}</div>`)
              .addTo(map)
          })
          map.on('mouseenter', `${layer.id}-circle`, () => { map.getCanvas().style.cursor = 'pointer' })
          map.on('mouseleave', `${layer.id}-circle`, () => { map.getCanvas().style.cursor = '' })
          added.current[layer.id] = true
        }
      }
      const vis = layer.visible ? 'visible' : 'none'
      if (map.getLayer(layer.id)) map.setLayoutProperty(layer.id, 'visibility', vis)
      if (map.getLayer(`${layer.id}-fill`)) map.setLayoutProperty(`${layer.id}-fill`, 'visibility', vis)
      if (map.getLayer(`${layer.id}-circle`)) map.setLayoutProperty(`${layer.id}-circle`, 'visibility', vis)
      if (layer.type === 'raster' && map.getLayer(layer.id)) map.setPaintProperty(layer.id, 'raster-opacity', layer.opacity / 100)
      if (layer.type === 'vector') {
        if (map.getLayer(layer.id)) map.setPaintProperty(layer.id, 'line-opacity', layer.opacity / 100)
        if (map.getLayer(`${layer.id}-fill`)) map.setPaintProperty(`${layer.id}-fill`, 'fill-opacity', (layer.opacity / 100) * 0.22)
        if (map.getLayer(`${layer.id}-circle`)) map.setPaintProperty(`${layer.id}-circle`, 'circle-opacity', layer.opacity / 100)
      }
    })
    // remove layers no longer present
    Object.keys(added.current).forEach(id => {
      if (layers.some(l => l.id === id)) return
      if (map.getLayer(id)) map.removeLayer(id)
      if (map.getLayer(`${id}-fill`)) map.removeLayer(`${id}-fill`)
      if (map.getLayer(`${id}-circle`)) map.removeLayer(`${id}-circle`)
      if (map.getSource(`src-${id}`)) { try { map.removeSource(`src-${id}`) } catch { /* locked */ } }
      delete added.current[id]
    })
  }, [layers, ready])

  // fit to most-recently-added layer bounds
  React.useEffect(() => {
    const map = mapRef.current
    if (!map || !ready || !fitNonce) return
    const withBounds = layers.filter(l => l.bounds?.length === 4)
    const b = withBounds[0]?.bounds
    if (!b) return
    const [w, s, e, n] = b
    if (![w, s, e, n].every(Number.isFinite)) return
    map.fitBounds([[w, s], [e, n]], { padding: 64, duration: 600, maxZoom: 12 })
  }, [fitNonce, ready, layers])

  return <div ref={containerRef} style={{ width: '100%', height: '100%' }} />
}

function escapeHtml(value: string): string {
  return value.replace(/[&<>"']/g, character => ({
    '&': '&amp;',
    '<': '&lt;',
    '>': '&gt;',
    '"': '&quot;',
    "'": '&#039;',
  }[character] ?? character))
}
