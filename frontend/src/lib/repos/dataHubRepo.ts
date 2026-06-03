/** Static seed mirroring open_design/data-hub.html (read-only browse). */
export type HubFile = {
  name: string
  type: 'raster' | 'vector' | 'table' | 'text'
  size: string
  fmt: string
  created: string
  modified: string
  enc: string
  note: string
  spatial?: { crs: string; geom: string | number; feat: string | number; extent: string; res: string; bands: string | number }
}

export type HubDir = { name: string; count: number }

export const tree: HubDir[] = [
  { name: 'raw', count: 4 },
  { name: 'processed', count: 3 },
  { name: 'outputs', count: 2 },
  { name: 'documents', count: 1 },
  { name: 'temp', count: 0 },
]

export const filesByDir: Record<string, HubFile[]> = {
  raw: [
    { name: 'landuse_2020.tif', type: 'raster', size: '184 MB', fmt: 'GeoTIFF', created: '2024-03-12 09:21', modified: '2024-03-12 09:21', enc: '—', note: '2020 年土地利用分类', spatial: { crs: 'EPSG:4326', geom: '—', feat: '—', extent: '111.2,29.4 — 114.6,31.8', res: '30 m', bands: 1 } },
    { name: 'dem_30m.tif', type: 'raster', size: '92 MB', fmt: 'GeoTIFF', created: '2024-03-10 14:02', modified: '2024-03-10 14:02', enc: '—', note: 'SRTM 数字高程', spatial: { crs: 'EPSG:4326', geom: '—', feat: '—', extent: '111.2,29.4 — 114.6,31.8', res: '30 m', bands: 1 } },
    { name: 'study_boundary.shp', type: 'vector', size: '2.1 MB', fmt: 'ESRI Shapefile', created: '2024-02-28 11:40', modified: '2024-03-01 08:15', enc: 'UTF-8', note: '研究区边界', spatial: { crs: 'EPSG:4326', geom: 'Polygon', feat: 12, extent: '111.6,29.8 — 114.1,31.4', res: '—', bands: '—' } },
    { name: 'carbon_pools.csv', type: 'table', size: '6 KB', fmt: 'CSV', created: '2024-03-05 16:30', modified: '2024-03-11 10:05', enc: 'UTF-8', note: '各地类碳密度（t/ha）' },
  ],
  processed: [
    { name: 'landuse_reclass.tif', type: 'raster', size: '171 MB', fmt: 'GeoTIFF', created: '2024-03-13 09:00', modified: '2024-03-13 09:00', enc: '—', note: '重分类后土地利用', spatial: { crs: 'EPSG:4326', geom: '—', feat: '—', extent: '111.2,29.4 — 114.6,31.8', res: '30 m', bands: 1 } },
    { name: 'watershed.shp', type: 'vector', size: '3.4 MB', fmt: 'ESRI Shapefile', created: '2024-03-13 10:20', modified: '2024-03-13 10:20', enc: 'UTF-8', note: '提取流域边界', spatial: { crs: 'EPSG:4326', geom: 'Polygon', feat: 5, extent: '111.5,29.7 — 114.2,31.5', res: '—', bands: '—' } },
    { name: 'precip_annual.tif', type: 'raster', size: '44 MB', fmt: 'GeoTIFF', created: '2024-03-14 08:11', modified: '2024-03-14 08:11', enc: '—', note: '年降水量栅格', spatial: { crs: 'EPSG:4326', geom: '—', feat: '—', extent: '111.2,29.4 — 114.6,31.8', res: '1 km', bands: 1 } },
  ],
  outputs: [
    { name: 'tot_c_cur.tif', type: 'raster', size: '168 MB', fmt: 'GeoTIFF', created: '2024-03-15 15:42', modified: '2024-03-15 15:42', enc: '—', note: 'Carbon Storage 总碳储量输出', spatial: { crs: 'EPSG:4326', geom: '—', feat: '—', extent: '111.2,29.4 — 114.6,31.8', res: '30 m', bands: 1 } },
    { name: 'carbon_summary.csv', type: 'table', size: '3 KB', fmt: 'CSV', created: '2024-03-15 15:42', modified: '2024-03-15 15:42', enc: 'UTF-8', note: '碳储量分区汇总' },
  ],
  documents: [
    { name: '研究区说明.md', type: 'text', size: '12 KB', fmt: 'Markdown', created: '2024-02-20 09:00', modified: '2024-03-02 17:30', enc: 'UTF-8', note: '项目背景与数据来源说明' },
  ],
  temp: [],
}

export const TYPE_ICON: Record<string, string> = { raster: 'image', vector: 'map', table: 'table', text: 'file-text', folder: 'folder' }
export const TYPE_LABEL: Record<string, string> = { raster: '栅格', vector: '矢量', table: '表格', text: '文本', folder: '文件夹' }
