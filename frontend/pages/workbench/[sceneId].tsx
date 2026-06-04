import React from 'react'
import Head from 'next/head'
import Link from 'next/link'
import { useRouter } from 'next/router'
import TopNav from '../../src/components/shell/TopNav'
import Icon from '../../src/components/shell/Icon'
import Modal from '../../src/components/shell/Modal'
import MapView, { type WbLayer } from '../../src/components/workbench/MapView'
import { toast } from '../../src/lib/toast'
import { scenesRepo } from '../../src/lib/repos/scenesRepo'
import { settingsRepo, type ModelCfg } from '../../src/lib/repos/settingsRepo'
import { workbenchRepo, type WbFile, type WbModel, type WbOutput } from '../../src/lib/repos/workbenchRepo'
import { fmtBytes, type AssetType } from '../../src/lib/apiClient'

type View = 'agent' | 'map' | 'split'
type LeftTab = 'layers' | 'files' | 'invest'
type TaskState = 'idle' | 'run' | 'done' | 'fail'
type ChatMsg = { role: 'user' | 'agent'; html: string; att: string[] }

const TYPE_LABEL: Record<string, string> = { raster: '鏍呮牸', vector: '鐭㈤噺', table: '琛ㄦ牸', text: '鏂囨湰', folder: '鏂囦欢澶?, other: '鍏朵粬' }
const TYPE_ICON: Record<string, string> = { raster: 'image', vector: 'map', table: 'table', text: 'file-text', other: 'file' }

/* fallback seeds (used when backend offline) 鈥?mirror prototype */
const SEED_FILES: WbFile[] = [
  { id: 'landuse_2020.tif', name: 'landuse_2020.tif', type: 'raster', size: 184 * 1024 * 1024 },
  { id: 'study_boundary.shp', name: 'study_boundary.shp', type: 'vector', size: 2.1 * 1024 * 1024 },
  { id: 'carbon_pools.csv', name: 'carbon_pools.csv', type: 'table', size: 6 * 1024 },
  { id: 'dem_30m.tif', name: 'dem_30m.tif', type: 'raster', size: 92 * 1024 * 1024 },
]
const SEED_MODELS: WbModel[] = [
  { id: 'carbon', name: 'Carbon Storage', status: 'ready', description: '纰冲偍閲忎笌鍥虹⒊ 路 浼扮畻鐮旂┒鍖哄湴涓?鍦颁笅/鍦熷￥/鏋惤鐗╃⒊搴?, inputs: [{ id: 'lulc_bas_asset_id', label: '鍦熷湴鍒╃敤鏁版嵁', kind: 'asset', asset_type: 'raster', required: true }, { id: 'carbon_pools_asset_id', label: '纰冲瘑搴﹁〃', kind: 'asset', asset_type: 'table', required: true }, { id: 'aoi_asset_id', label: '鐮旂┒鍖鸿竟鐣?, kind: 'asset', asset_type: 'geojson' }] },
  { id: 'habitat_quality', name: 'Habitat Quality', status: 'ready', description: '鐢熷璐ㄩ噺 路 鍩轰簬濞佽儊鍥犲瓙璇勪及鐢熷閫€鍖栦笌璐ㄩ噺', inputs: [{ id: 'lulc_cur_asset_id', label: '鍦熷湴鍒╃敤鏁版嵁', kind: 'asset', asset_type: 'raster', required: true }] },
  { id: 'water_yield', name: 'Water Yield', status: 'planned', description: '浜ф按閲?路 娴佸煙灏哄害骞村潎浜ф按閲忎及绠?, inputs: [] },
  { id: 'sdr', name: 'Sediment Delivery Ratio', status: 'planned', description: '娉ユ矙杈撶Щ姣?路 鍦熷￥渚佃殌涓庢偿娌欒緭绉伙紙瑙勫垝涓級', inputs: [] },
  { id: 'ndr', name: 'Nutrient Delivery Ratio', status: 'planned', description: '鍏诲垎杈撶Щ姣?路 姘７璐熻嵎涓庤緭绉伙紙瑙勫垝涓級', inputs: [] },
]

const backendType = (uiType: AssetType): string => (uiType === 'vector' ? 'geojson' : uiType)
const uiFromBackendAssetType = (bt?: string): AssetType => (bt === 'geojson' ? 'vector' : (bt as AssetType) || 'other')

export default function WorkbenchPage() {
  const router = useRouter()
  const sceneId = typeof router.query.sceneId === 'string' ? router.query.sceneId : ''
  const [sceneName, setSceneName] = React.useState('鍦烘櫙')
  const [region, setRegion] = React.useState('')

  const [view, setView] = React.useState<View>('agent')
  const [leftTab, setLeftTab] = React.useState<LeftTab>('layers')
  const [files, setFiles] = React.useState<WbFile[]>(SEED_FILES)
  const [hubFiles, setHubFiles] = React.useState<WbFile[]>([])
  const [importOpen, setImportOpen] = React.useState(false)
  const [importSel, setImportSel] = React.useState<Record<string, boolean>>({})
  const [models, setModels] = React.useState<WbModel[]>(SEED_MODELS)
  const [layers, setLayers] = React.useState<WbLayer[]>([])
  const [fitNonce, setFitNonce] = React.useState(0)

  // chat
  const [msgs, setMsgs] = React.useState<ChatMsg[]>([
    { role: 'user', html: '甯垜鐪嬬湅褰撳墠椤圭洰閲屾湁鍝簺鏁版嵁鍙互鐢ㄦ潵璺戠⒊鍌ㄩ噺妯″瀷锛?, att: [] },
    { role: 'agent', html: '褰撳墠椤圭洰鍖呭惈 <code>landuse_2020.tif</code>锛堝湡鍦板埄鐢ㄦ爡鏍硷級銆?code>study_boundary.shp</code>锛堢爺绌跺尯杈圭晫锛夊拰 <code>carbon_pools.csv</code>锛堢⒊瀵嗗害琛級銆傝繖涓夐」姝ｅソ瀵瑰簲 Carbon Storage 妯″瀷鐨勫叏閮ㄥ繀闇€杈撳叆锛屽彲浠ョ洿鎺ュ湪宸︽爮 InVEST 鏍囩閲屾墜鍔ㄩ厤缃繍琛屻€?, att: [] },
    { role: 'user', html: '濂界殑锛屽厛鎶婅繖浠藉湡鍦板埄鐢ㄦ暟鎹綔涓轰笂涓嬫枃銆?, att: ['landuse_2020.tif'] },
    { role: 'agent', html: '宸茶褰曡繖浠藉湡鍦板埄鐢ㄦ暟鎹綔涓哄璇濅笂涓嬫枃銆傞渶瑕佹垜瀵瑰畠鐨勫垎绫讳綋绯绘垨鏃剁浉鍋氳繘涓€姝ヨ鏄庡悧锛?, att: [] },
  ])
  const [atts, setAtts] = React.useState<string[]>([])
  const [draft, setDraft] = React.useState('')
  const [streaming, setStreaming] = React.useState(false)
  const [attOpen, setAttOpen] = React.useState(false)
  const chatScrollRef = React.useRef<HTMLDivElement | null>(null)
  const [defaultModel, setDefaultModel] = React.useState<ModelCfg | undefined>(undefined)

  // task + log
  const [task, setTask] = React.useState<TaskState>('idle')
  const [curModel, setCurModel] = React.useState('Carbon Storage')
  const [logLines, setLogLines] = React.useState<{ cls: string; text: string }[]>([{ cls: 'l-dim', text: '绛夊緟浠诲姟鈥?杩愯妯″瀷鍚庢棩蹇楀皢鏄剧ず鍦ㄦ銆? }])
  const [outputs, setOutputs] = React.useState<WbOutput[]>([])
  const [outputsJobId, setOutputsJobId] = React.useState('')
  const [outputsLoading, setOutputsLoading] = React.useState(false)
  const logRef = React.useRef<HTMLDivElement | null>(null)
  const pollRef = React.useRef<number | null>(null)

  // invest modal
  const [modalModel, setModalModel] = React.useState<WbModel | null>(null)
  const [modelSearch, setModelSearch] = React.useState('')
  const [inputSel, setInputSel] = React.useState<Record<string, string>>({})
  const [runName, setRunName] = React.useState('')
  const [checkResult, setCheckResult] = React.useState<React.ReactNode>(null)

  React.useEffect(() => {
    if (!sceneId) return
    let cancelled = false
    scenesRepo.get(sceneId).then(s => {
      if (cancelled) return
      if (s) {
        setSceneName(s.name)
        setRegion(s.region)
      } else {
        setSceneName(sceneId)
        setRegion('')
        toast('鏈壘鍒板悗绔満鏅紝璇蜂粠鍦烘櫙椤佃繘鍏ョ湡瀹炲満鏅?)
      }
    })
    return () => { cancelled = true }
  }, [sceneId])

  React.useEffect(() => {
    let cancelled = false
    settingsRepo.defaultModel().then(model => { if (!cancelled) setDefaultModel(model) }).catch(() => {})
    return () => { cancelled = true }
  }, [])

  const refreshSceneFiles = React.useCallback(async () => {
    const next = await workbenchRepo.listFiles(sceneId || undefined)
    setFiles(sceneId ? next : (next.length ? next : SEED_FILES))
  }, [sceneId])

  React.useEffect(() => {
    let cancelled = false
    workbenchRepo.listFiles(sceneId || undefined).then(f => { if (!cancelled) setFiles(sceneId ? f : (f.length ? f : SEED_FILES)) }).catch(() => { if (!cancelled && sceneId) setFiles([]) })
    workbenchRepo.listModels().then(m => { if (!cancelled && m.length) setModels(m) }).catch(() => {})
    return () => { cancelled = true }
  }, [sceneId])

  React.useEffect(() => { const el = chatScrollRef.current; if (el) el.scrollTop = el.scrollHeight }, [msgs, view])
  React.useEffect(() => { const el = logRef.current; if (el) el.scrollTop = el.scrollHeight }, [logLines])
  React.useEffect(() => () => { if (pollRef.current) window.clearInterval(pollRef.current) }, [])

  /* ---- layers ---- */
  function addToMap(f: WbFile) {
    if (f.type !== 'raster' && f.type !== 'vector') { toast('璇ョ被鍨嬩笉鏀寔鍔犲叆鍦板浘'); return }
    const id = 'ly_' + f.id.replace(/[^a-zA-Z0-9_-]/g, '_')
    if (layers.some(l => l.id === id)) { toast('鍥惧眰宸插湪鍦板浘涓?); return }
    setLayers(prev => [{ id, name: f.name, type: f.type === 'raster' ? 'raster' : 'vector', visible: true, opacity: f.type === 'raster' ? 64 : 82, rasterUrl: f.previewUrl, geojsonUrl: f.geojsonUrl, bounds: f.bounds }, ...prev])
    setFitNonce(n => n + 1)
    setLeftTab('layers')
    toast('宸插姞鍏ュ湴鍥撅細' + f.name)
  }
  const setLayer = (id: string, patch: Partial<WbLayer>) => setLayers(prev => prev.map(l => (l.id === id ? { ...l, ...patch } : l)))
  const removeLayer = (id: string) => { setLayers(prev => prev.filter(l => l.id !== id)); toast('宸茬Щ闄ゅ浘灞?) }

  async function openImportFiles() {
    if (!sceneId) { toast('璇峰厛杩涘叆涓€涓湡瀹炲満鏅?, 'error'); return }
    try {
      const all = await workbenchRepo.listDataHubFiles()
      const imported = new Set(files.map(f => f.id))
      setHubFiles(all.filter(f => !imported.has(f.id)))
      setImportSel({})
      setImportOpen(true)
    } catch {
      toast('Data Hub 鏂囦欢鍔犺浇澶辫触锛岃妫€鏌ュ悗绔湇鍔?, 'error')
    }
  }

  async function importSelectedFiles() {
    const fileIds = Object.keys(importSel).filter(id => importSel[id])
    if (!sceneId || !fileIds.length) return
    try {
      const result = await workbenchRepo.importFiles(sceneId, fileIds)
      toast(`宸插鍏?${result.imported} 涓枃浠禶)
      setImportOpen(false)
      await refreshSceneFiles()
    } catch {
      toast('瀵煎叆澶辫触锛岃妫€鏌ュ悗绔湇鍔?, 'error')
    }
  }

  async function removeImportedFile(fileId: string) {
    if (!sceneId) return
    try {
      await workbenchRepo.removeFileImport(sceneId, fileId)
      toast('宸蹭粠鍦烘櫙绉婚櫎鏂囦欢寮曠敤')
      await refreshSceneFiles()
    } catch {
      toast('绉婚櫎澶辫触锛岃妫€鏌ュ悗绔湇鍔?, 'error')
    }
  }

  function outputToFile(o: WbOutput): WbFile {
    const type = uiFromBackendAssetType(o.type)
    return {
      id: `${outputsJobId}:${o.name}`,
      folderName: 'Outputs',
      name: o.name,
      type,
      size: o.size,
      previewUrl: o.previewUrl,
      geojsonUrl: o.geojsonUrl,
      bounds: o.bounds,
    }
  }

  async function loadOutputs(jobId: string) {
    setOutputsJobId(jobId)
    setOutputsLoading(true)
    try {
      setOutputs(await workbenchRepo.getOutputs(jobId, sceneId || undefined))
    } catch {
      setOutputs([])
      pushLog('l-warn', 'Outputs API request failed.')
    } finally {
      setOutputsLoading(false)
    }
  }

  /* ---- chat ---- */
  const escapeHtml = (s: string) => s.replace(/[&<>]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;' }[c] as string))
  function addAtt(name: string) { setAtts(prev => (prev.includes(name) ? prev : [...prev, name])); setAttOpen(false) }
  function send() {
    const text = draft.trim()
    if (!text || streaming) return
    const userMsg: ChatMsg = { role: 'user', html: escapeHtml(text), att: atts.slice() }
    setDraft(''); setAtts([])
    setStreaming(true)
    const reply = '鏀跺埌銆傛垜浼氬熀浜庡綋鍓嶉」鐩殑鏁版嵁鍥炵瓟鈥斺€斾綘鍙互鍦ㄥ乏鏍?InVEST 鏍囩閫夋嫨妯″瀷銆侀厤缃緭鍏ュ悗鎵嬪姩杩愯锛岃繍琛岀姸鎬佷笌鏃ュ織浼氭樉绀哄湪鍙充晶闈㈡澘銆?
    setMsgs(prev => [...prev, userMsg, { role: 'agent', html: '<span class="cursor-blink"></span>', att: [] }])
    let i = 0
    const tick = () => {
      i += 2
      const done = i >= reply.length
      setMsgs(prev => {
        const next = prev.slice()
        next[next.length - 1] = { role: 'agent', html: escapeHtml(reply.slice(0, i)) + (done ? '' : '<span class="cursor-blink"></span>'), att: [] }
        return next
      })
      if (done) { setStreaming(false) } else { window.setTimeout(tick, 18) }
    }
    window.setTimeout(tick, 18)
  }

  /* ---- run model (real backend for ready models; simulate on failure/offline) ---- */
  function pushLog(cls: string, text: string) { setLogLines(prev => [...prev, { cls, text }]) }
  function classifyLog(line: string): string {
    const l = line.toLowerCase()
    if (l.includes('error') || l.includes('failed') || l.includes('traceback')) return 'l-err'
    if (l.includes('warn')) return 'l-warn'
    if (l.includes('completed') || l.includes('success') || l.includes('finished')) return 'l-ok'
    return 'l-dim'
  }

  function simulateRun(name: string) {
    setLogLines([{ cls: 'l-dim', text: `$ invest run ${name.toLowerCase().replace(/ /g, '-')}` }])
    const steps: [string, string][] = [
      ['l-ok', '宸插姞杞借緭鍏ワ細鍦熷湴鍒╃敤鏁版嵁銆佺⒊瀵嗗害琛ㄣ€佺爺绌跺尯杈圭晫'],
      ['l-dim', '鏍￠獙鏍呮牸瀵归綈涓庡潗鏍囩郴 EPSG:4326 鈥?閫氳繃'],
      ['l-dim', '璁＄畻纰冲簱锛氬湴涓?/ 鍦颁笅 / 鍦熷￥ / 鏋惤鐗?鈥?],
      ['l-warn', '璀﹀憡锛?.2% 鍍忓厓缂哄け纰冲瘑搴︼紝宸叉寜閭诲煙鍧囧€煎～鍏?],
      ['l-dim', '姹囨€荤爺绌跺尯鎬荤⒊鍌ㄩ噺 鈥?],
      ['l-ok', '杈撳嚭宸插啓鍏?outputs/carbon_storage/  鈫? tot_c_cur.tif'],
    ]
    let i = 0
    const next = () => {
      if (i < steps.length) { pushLog(steps[i][0], steps[i][1]); i++; window.setTimeout(next, 520) }
      else { pushLog('l-ok', '鉁?杩愯瀹屾垚锛岀敤鏃?9.4s'); setTask('done'); toast('杩愯瀹屾垚锛? + name) }
    }
    window.setTimeout(next, 420)
  }

  async function realRun(model: WbModel): Promise<boolean> {
    const inputs: Record<string, unknown> = {}
    ;(model.inputs || []).forEach(inp => { if (inputSel[inp.id]) inputs[inp.id] = inputSel[inp.id] })
    if (model.id === 'carbon') { inputs.results_suffix = 'gsms'; inputs.calc_sequestration = false }
    try {
      const { job_id } = await workbenchRepo.createJob(model.id, inputs, 'auto', sceneId || undefined)
      pushLog('l-dim', `$ job ${job_id} created (run_mode=auto)`)
      let lastLen = 0
      pollRef.current = window.setInterval(async () => {
        try {
          const txt = await workbenchRepo.getLogs(job_id, sceneId || undefined)
          if (txt.length > lastLen) {
            txt.slice(lastLen).split('\n').filter(Boolean).forEach(line => pushLog(classifyLog(line), line))
            lastLen = txt.length
          }
          const st = await workbenchRepo.getJob(job_id, sceneId || undefined)
          if (st.status === 'succeeded' || st.status === 'failed') {
            if (pollRef.current) window.clearInterval(pollRef.current)
            setTask(st.status === 'succeeded' ? 'done' : 'fail')
            if (st.status === 'succeeded') {
              void loadOutputs(job_id)
              void refreshSceneFiles()
            }
            toast(st.status === 'succeeded' ? '杩愯瀹屾垚锛? + model.name : '杩愯澶辫触锛? + model.name, st.status === 'failed' ? 'error' : 'ok')
          }
        } catch { /* keep polling */ }
      }, 1000)
      return true
    } catch {
      return false
    }
  }

  async function runModel(model: WbModel) {
    setModalModel(null)
    setCurModel(model.name)
    setTask('run')
    setLogLines([])
    setOutputs([])
    setOutputsJobId('')
    const ok = await realRun(model)
    if (!ok) { pushLog('l-dim', '鍚庣涓嶅彲鐢紝杩涘叆婕旂ず妯″紡銆?); simulateRun(model.name) }
  }

  /* ---- invest modal ---- */
  function openInvest(m: WbModel) {
    if (m.status === 'planned') { toast('璇ユā鍨嬭鍒掍腑锛屾殏涓嶅彲杩愯'); return }
    setModalModel(m); setInputSel({}); setRunName(m.name.toLowerCase().replace(/ /g, '_') + '_run'); setCheckResult(null)
  }
  function assetOptionsFor(uiType: AssetType) { return files.filter(f => f.type === uiType) }
  async function checkInputs(m: WbModel) {
    const inputs: Record<string, unknown> = {}
    ;(m.inputs || []).forEach(inp => { if (inputSel[inp.id]) inputs[inp.id] = inputSel[inp.id] })
    try {
      const r = await workbenchRepo.checkInputs(m.id, inputs, sceneId || undefined)
      setCheckResult(
        <>
          {r.info?.map((t, i) => <div key={'i' + i} className="notice notice-info" style={{ marginBottom: 7 }}><Icon name="info" cls="ic-sm" /><div>{t}</div></div>)}
          {r.warnings?.map((t, i) => <div key={'w' + i} className="notice notice-warn" style={{ marginBottom: 7 }}><Icon name="alert-triangle" cls="ic-sm" /><div>{t}</div></div>)}
          {r.errors?.map((t, i) => <div key={'e' + i} className="notice notice-error" style={{ marginBottom: 7 }}><Icon name="alert-circle" cls="ic-sm" /><div>{t}</div></div>)}
          {!r.info?.length && !r.warnings?.length && !r.errors?.length && <div className="notice notice-ok"><Icon name="check-circle" cls="ic-sm" /><div>妫€鏌ラ€氳繃锛屽彲缁х画杩愯銆?/div></div>}
        </>,
      )
    } catch {
      setCheckResult(
        <>
          <div className="notice notice-ok" style={{ marginBottom: 7 }}><Icon name="check-circle" cls="ic-sm" /><div>鐮旂┒鍖鸿竟鐣屻€佸湡鍦板埄鐢ㄦ暟鎹?鈥?閫氳繃</div></div>
          <div className="notice notice-warn" style={{ marginBottom: 7 }}><Icon name="alert-triangle" cls="ic-sm" /><div>纰冲瘑搴﹁〃 鈥?璀﹀憡锛氱己灏?3 涓湡鍦板埄鐢ㄧ被鍒殑纰冲€硷紝灏嗘寜 0 澶勭悊</div></div>
          <div className="notice notice-info"><Icon name="info" cls="ic-sm" /><div>妫€鏌ュ畬鎴愶細1 椤硅鍛婏紝0 椤归敊璇紝鍙户缁繍琛屻€?/div></div>
        </>,
      )
    }
  }

  const TASK_META: Record<TaskState, { ic: string; icn: string; title: string; badge: React.ReactNode }> = {
    idle: { ic: 'idle', icn: 'box', title: '褰撳墠鏃犺繍琛屼换鍔?, badge: null },
    run: { ic: 'run', icn: 'refresh-cw', title: 'InVEST 姝ｅ湪杩愯', badge: <span className="badge badge-warn"><span className="bdot" />杩愯涓?/span> },
    done: { ic: 'done', icn: 'check-circle', title: '杩愯瀹屾垚', badge: <span className="badge badge-ok"><span className="bdot" />瀹屾垚</span> },
    fail: { ic: 'fail', icn: 'alert-circle', title: '杩愯澶辫触锛岃鏌ョ湅鏃ュ織', badge: <span className="badge badge-danger"><span className="bdot" />澶辫触</span> },
  }
  const tm = TASK_META[task]
  const filteredModels = models.filter(m => {
    const q = modelSearch.trim().toLowerCase()
    if (!q) return true
    return `${m.name} ${m.id}`.toLowerCase().includes(q)
  })
  const fileGroups = Array.from(files.reduce((map, file) => {
    const key = file.folderName || '鏈垎绫?
    const group = map.get(key) || []
    group.push(file)
    map.set(key, group)
    return map
  }, new Map<string, WbFile[]>()))

  function ChatList({ pad }: { pad: string }) {
    return (
      <div className="chat-inner" style={{ padding: pad }}>
        {msgs.map((m, i) => (
          <div className={`msg ${m.role}`} key={i}>
            <span className="who">{m.role === 'user' ? '鎴? : 'AI'}</span>
            <div className="bubble"><div className="body">
              <p dangerouslySetInnerHTML={{ __html: m.html }} />
              {m.att.length > 0 && <div className="att-tags">{m.att.map(a => <span className="att-chip" key={a} style={{ height: 24 }}><Icon name="paperclip" cls="ic-sm" />{a}</span>)}</div>}
            </div></div>
          </div>
        ))}
      </div>
    )
  }

  return (
    <>
      <Head><title>{`${sceneName} 路 宸ヤ綔鍙?路 GSMS`}</title></Head>
      <div className="app">
        <TopNav active="workbench" />

        <div className="scene-bar">
          <div className="breadcrumb">
            <Link href="/scenes"><Icon name="arrow-left" cls="ic-sm" />宸ヤ綔鍙?/Link>
            <Icon name="chevron-right" cls="ic-sm" />
            <b>{sceneName}</b>
          </div>
          <span style={{ flex: 1 }} />
          {region && <span className="region"><Icon name="map" cls="ic-sm" />鐮旂┒鍖猴細{region}</span>}
        </div>

        <div className="work">
          {/* LEFT */}
          <aside className="col c-left">
            <div className="tabs">
              <button className={leftTab === 'layers' ? 'on' : ''} onClick={() => setLeftTab('layers')}><Icon name="layers" cls="ic-sm" />鍥惧眰</button>
              <button className={leftTab === 'files' ? 'on' : ''} onClick={() => setLeftTab('files')}><Icon name="file" cls="ic-sm" />鏂囦欢</button>
              <button className={leftTab === 'invest' ? 'on' : ''} onClick={() => setLeftTab('invest')}><Icon name="box" cls="ic-sm" />InVEST</button>
            </div>

            {leftTab === 'layers' && (
              <div className="col-body">
                {layers.length === 0 ? (
                  <div className="state-empty"><Icon name="layers" /><b>鍦板浘涓婅繕娌℃湁鍥惧眰</b>浠庛€屾枃浠躲€嶆爣绛炬妸鏁版嵁鍔犲叆鍦板浘锛屾垨杩愯妯″瀷鐢熸垚杈撳嚭銆?/div>
                ) : layers.map(l => (
                  <div className="layer" key={l.id}>
                    <div className="layer-top">
                      <span className={`fchip ${l.type}`} style={{ width: 26, height: 26 }}><Icon name={l.type === 'raster' ? 'image' : 'map'} cls="ic-sm" /></span>
                      <span className="layer-name" title={l.name}>{l.name}</span>
                      <span className="badge badge-muted">{l.type === 'raster' ? '鏍呮牸' : '鐭㈤噺'}</span>
                      <label className="switch" title="鏄鹃殣"><input type="checkbox" checked={l.visible} onChange={e => setLayer(l.id, { visible: e.target.checked })} /><span className="track" /></label>
                    </div>
                    <div className="layer-ctl">
                      <input className="range" type="range" min={0} max={100} value={l.opacity} aria-label="閫忔槑搴? onChange={e => setLayer(l.id, { opacity: +e.target.value })} />
                      <span className="pct">{l.opacity}%</span>
                      <span className="hideact">
                        <button className="icon-btn sm" title="缂╂斁鍒板浘灞? aria-label="缂╂斁鍒板浘灞? onClick={() => setFitNonce(n => n + 1)}><Icon name="maximize" cls="ic-sm" /></button>
                        <button className="icon-btn sm" title="绉婚櫎" aria-label="绉婚櫎" onClick={() => removeLayer(l.id)}><Icon name="trash" cls="ic-sm" /></button>
                      </span>
                    </div>
                  </div>
                ))}
              </div>
            )}

            {leftTab === 'files' && (
              <div className="col-body">
                <div className="pad" style={{ borderBottom: '1px solid var(--border)' }}>
                  <button className="btn btn-sm" onClick={openImportFiles}><Icon name="download" cls="ic-sm" />瀵煎叆 Data Hub 鏂囦欢</button>
                </div>
                {files.length === 0 ? (
                  <div className="state-empty"><Icon name="file" /><b>褰撳墠鍦烘櫙杩樻病鏈夋枃浠?/b>浠?Data Hub 瀵煎叆鏂囦欢鍚庯紝鍐嶉厤缃ā鍨嬭緭鍏ャ€?/div>
                ) : fileGroups.map(([folderName, group]) => (
                  <div className="file-folder" key={folderName}>
                    <div className="file-folder-head"><Icon name="folder" cls="ic-sm" /><span>{folderName}</span><span className="tree-count">{group.length}</span></div>
                    {group.map(f => (
                      <div className="row file-in-folder" key={f.id}>
                        <span className={`fchip ${f.type}`}><Icon name={TYPE_ICON[f.type] || 'file'} cls="ic-sm" /></span>
                        <div style={{ minWidth: 0 }}>
                          <div className="ftitle" style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{f.name}</div>
                          <div className="fsub">{TYPE_LABEL[f.type] || '鍏朵粬'} 路 {fmtBytes(f.size)}</div>
                        </div>
                        <span className="actions">
                          <button className="icon-btn sm" title="鍔犲叆鍦板浘" aria-label="鍔犲叆鍦板浘" onClick={() => addToMap(f)}><Icon name="map" cls="ic-sm" /></button>
                          <button className="icon-btn sm" title="浣滀负闄勪欢寮曠敤" aria-label="浣滀负闄勪欢" onClick={() => { addAtt(f.name); toast('宸蹭綔涓洪檮浠跺紩鐢?) }}><Icon name="paperclip" cls="ic-sm" /></button>
                          {sceneId && <button className="icon-btn sm" title="浠庡満鏅Щ闄ゅ紩鐢? aria-label="浠庡満鏅Щ闄ゅ紩鐢? onClick={() => removeImportedFile(f.id)}><Icon name="trash" cls="ic-sm" /></button>}
                        </span>
                      </div>
                    ))}
                  </div>
                ))}
              </div>
            )}

            {leftTab === 'invest' && (
              <div className="col-body">
                <div className="pad model-search">
                  <Icon name="search" cls="ic-sm" />
                  <input value={modelSearch} onChange={e => setModelSearch(e.target.value)} placeholder="鎼滅储妯″瀷" />
                </div>
                <div>
                  {filteredModels.map(m => {
                    const ready = m.status !== 'planned'
                    return (
                      <div className={`model-row ${ready ? '' : 'disabled'}`} key={m.id} onClick={() => openInvest(m)}>
                        <span className="fchip" style={{ background: ready ? 'var(--accent-soft)' : 'var(--inset)', color: ready ? 'var(--accent-ink)' : 'var(--faint)' }}><Icon name="box" cls="ic-sm" /></span>
                        <div style={{ flex: 1, minWidth: 0 }}>
                          <div className="ftitle">{m.name}</div>
                        </div>
                        <span className={`badge ${ready ? 'badge-ok' : 'badge-muted'}`}>{ready ? '鍙繍琛? : '瑙勫垝涓?}</span>
                      </div>
                    )
                  })}
                </div>
                <div className="pad meta" style={{ borderTop: '1px solid var(--border)' }}>鐐瑰嚮妯″瀷鎵撳紑閰嶇疆寮圭獥锛岃缃緭鍏ヤ笌鍙傛暟鍚庢墜鍔ㄨ繍琛屻€?/div>
              </div>
            )}
          </aside>

          {/* CENTER */}
          <main className="col c-center">
            <div className="col-head" style={{ padding: '0 14px', height: 46, background: 'var(--surface)' }}>
              <div className="seg">
                <button className={view === 'agent' ? 'on' : ''} onClick={() => setView('agent')}><Icon name="message-square" cls="ic-sm" />Agent</button>
                <button className={view === 'map' ? 'on' : ''} onClick={() => setView('map')}><Icon name="map" cls="ic-sm" />Map</button>
                <button className={view === 'split' ? 'on' : ''} onClick={() => setView('split')}><Icon name="columns" cls="ic-sm" />Split</button>
              </div>
              <div className="right" style={{ marginLeft: 'auto', display: 'flex', alignItems: 'center', gap: 8 }}>
                <span className="meta">鍦烘櫙锛?b style={{ color: 'var(--fg)', fontWeight: 600 }}>{sceneName}</b></span>
              </div>
            </div>

            <div style={{ flex: 1, minHeight: 0, display: 'flex' }}>
              {/* agent */}
              <div className="chat-wrap" style={{ flex: 1, minWidth: 0, display: view === 'agent' ? 'flex' : 'none' }}>
                <div className="chat-scroll" ref={chatScrollRef}><ChatList pad="0 24px" /></div>
                <div className="composer">
                  <div className="composer-inner">
                    {atts.length > 0 && (
                      <div className="att-strip">
                        {atts.map(a => <span className="att-chip" key={a}><Icon name="paperclip" cls="ic-sm" />{a}<button aria-label="绉婚櫎" onClick={() => setAtts(prev => prev.filter(x => x !== a))}><Icon name="x" cls="ic-sm" /></button></span>)}
                      </div>
                    )}
                    <div className="card-box">
                      <textarea rows={1} placeholder="鎻忚堪浣犵殑鍦扮悊鍒嗘瀽浠诲姟锛屾垨璇㈤棶褰撳墠椤圭洰鏁版嵁涓庢ā鍨嬬粨鏋?.." value={draft}
                        onChange={e => setDraft(e.target.value)}
                        onKeyDown={e => { if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); send() } }} />
                      <div className="composer-bar">
                        <div style={{ position: 'relative' }}>
                          <button className="icon-btn" title="娣诲姞闄勪欢" aria-label="娣诲姞闄勪欢" onClick={e => { e.stopPropagation(); setAttOpen(v => !v) }}><Icon name="paperclip" /></button>
                          {attOpen && (
                            <div className="pop open" onClick={e => e.stopPropagation()}>
                              <div className="head">娣诲姞闄勪欢</div>
                              <button onClick={() => addAtt('鏈湴鏂囦欢_' + Math.floor(Math.random() * 1000) + '.tif')}><Icon name="upload" cls="ic-sm" />浠庢湰鍦颁笂浼?/button>
                              <div className="head">褰撳墠椤圭洰鏂囦欢</div>
                              {files.slice(0, 4).map(f => <button key={f.id} onClick={() => addAtt(f.name)}><Icon name={TYPE_ICON[f.type] || 'file'} cls="ic-sm" />{f.name}</button>)}
                            </div>
                          )}
                        </div>
                        <span className="grow" />
                        <div className="mini-select" title="瀵硅瘽妯″瀷" onClick={() => toast('瀵硅瘽妯″瀷鍦ㄣ€岃缃?路 妯″瀷閰嶇疆銆嶄腑绠＄悊')}>
                          <Icon name="sparkles" cls="ic-sm" />
                          <span>{defaultModel ? `${defaultModel.name}${defaultModel.def ? ' 路 榛樿' : ''}` : '鏈厤缃ā鍨?}</span>
                          <Icon name="chevron-down" cls="ic-sm" />
                        </div>
                        <button className="send-btn" title="鍙戦€? aria-label="鍙戦€? disabled={streaming || !draft.trim()} onClick={send}><Icon name="send" cls="ic-sm" /></button>
                      </div>
                    </div>
                    {!defaultModel && <div className="meta" style={{ marginTop: 7, color: 'var(--warn)' }}>鏈厤缃璇濇ā鍨嬶紝璇峰厛鍒拌缃〉閰嶇疆鍚庡啀鍙戦€併€?/div>}
                  </div>
                </div>
              </div>

              {/* map */}
              <div style={{ flex: 1, minWidth: 0, display: view === 'map' ? 'block' : 'none' }}>
                <MapView layers={layers} fitNonce={fitNonce} active={view === 'map'} />
              </div>

              {/* split */}
              <div style={{ flex: 1, minWidth: 0, display: view === 'split' ? 'block' : 'none', height: '100%' }}>
                <div className="split">
                  <div className="half" style={{ display: 'flex', flexDirection: 'column' }}>
                    <div className="chat-scroll" style={{ padding: '16px 0' }}><ChatList pad="0 18px" /></div>
                  </div>
                  <div className="half">
                    <MapView layers={layers} fitNonce={fitNonce} active={view === 'split'} />
                  </div>
                </div>
              </div>
            </div>
          </main>

          {/* RIGHT */}
          <aside className="col c-right">
            <div className="col-head"><h2>杩愯淇℃伅</h2></div>
            <div className="task-card">
              <div className="glabel" style={{ marginBottom: 9 }}>浠诲姟鐘舵€?/div>
              <div className="task-state">
                <span className={`ti ${tm.ic}`}>{task === 'run' ? <span className="spinner" /> : <Icon name={tm.icn} />}</span>
                <div style={{ flex: 1, minWidth: 0 }}>
                  <div style={{ fontSize: 13, fontWeight: 600, color: 'var(--fg-strong)' }}>{tm.title}</div>
                  <div className="meta" style={{ marginTop: 1 }}>{task === 'idle' ? '閰嶇疆骞惰繍琛屼竴涓?InVEST 妯″瀷鍚庯紝鐘舵€佷細鏄剧ず鍦ㄨ繖閲? : '妯″瀷锛? + curModel}</div>
                </div>
                {tm.badge}
              </div>
            </div>
            <div className="col-head" style={{ borderTop: '1px solid var(--border)' }}>
              <h2 style={{ fontSize: 12 }}>杩愯鏃ュ織</h2>
              <div className="right"><button className="icon-btn sm" title="澶嶅埗鏃ュ織" aria-label="澶嶅埗鏃ュ織" onClick={() => { navigator.clipboard?.writeText(logLines.map(l => l.text).join('\n')).then(() => toast('鏃ュ織宸插鍒?), () => toast('澶嶅埗澶辫触', 'error')) }}><Icon name="copy" cls="ic-sm" /></button></div>
            </div>
            <div className="log">
              <div className="log-out" ref={logRef}>
                {logLines.map((l, i) => <div key={i}><span className={l.cls}>{l.text}</span></div>)}
              </div>
            </div>
          </aside>
        </div>
      </div>

      <Modal open={importOpen} title="瀵煎叆 Data Hub 鏂囦欢" sub="閫夋嫨鍏ㄥ眬 Data Hub 鏂囦欢寮曠敤鍒板綋鍓嶅満鏅紱涓嶄細澶嶅埗鎴栧垹闄ゅ師濮嬫枃浠躲€? onClose={() => setImportOpen(false)}
        footer={<>
          <span className="grow" />
          <button className="btn" onClick={() => setImportOpen(false)}>鍙栨秷</button>
          <button className="btn btn-primary" disabled={!Object.values(importSel).some(Boolean)} onClick={importSelectedFiles}>瀵煎叆</button>
        </>}>
        <div style={{ maxHeight: 360, overflowY: 'auto', border: '1px solid var(--border)', borderRadius: 'var(--r)' }}>
          {hubFiles.length === 0 ? (
            <div className="state-empty" style={{ margin: 20 }}><Icon name="file" /><b>娌℃湁鍙鍏ユ枃浠?/b>Data Hub 涓虹┖锛屾垨鎵€鏈夋枃浠堕兘宸插鍏ュ綋鍓嶅満鏅€?/div>
          ) : hubFiles.map(f => (
            <label className="row" key={f.id} style={{ cursor: 'pointer' }}>
              <input type="checkbox" checked={Boolean(importSel[f.id])} onChange={e => setImportSel(prev => ({ ...prev, [f.id]: e.target.checked }))} />
              <span className={`fchip ${f.type}`}><Icon name={TYPE_ICON[f.type] || 'file'} cls="ic-sm" /></span>
              <div style={{ minWidth: 0 }}>
                <div className="ftitle" style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{f.name}</div>
                <div className="fsub">{TYPE_LABEL[f.type] || '鍏朵粬'} 路 {fmtBytes(f.size)}</div>
              </div>
            </label>
          ))}
        </div>
      </Modal>

      {/* InVEST modal */}
      <Modal open={!!modalModel} title={`${modalModel?.name || ''} 路 妯″瀷閰嶇疆`} sub={modalModel?.description} onClose={() => setModalModel(null)}
        footer={<>
          <button className="btn btn-sm" onClick={() => modalModel && checkInputs(modalModel)}><Icon name="check-circle" cls="ic-sm" />妫€鏌ヨ緭鍏?/button>
          <span className="grow" />
          <button className="btn" onClick={() => setModalModel(null)}>鍙栨秷</button>
          <button className="btn btn-primary" onClick={() => modalModel && runModel(modalModel)}><Icon name="play" cls="ic-sm" />杩愯妯″瀷</button>
        </>}>
        <div className="glabel" style={{ marginBottom: 9 }}>杈撳叆鏁版嵁</div>
        <div>
          {(modalModel?.inputs || []).filter(inp => inp.kind === 'asset').map(inp => {
            const uiType = uiFromBackendAssetType(inp.asset_type)
            return (
              <div className="field" key={inp.id}>
                <label>{inp.label} <span style={{ color: 'var(--faint)', fontWeight: 400 }}>路 {TYPE_LABEL[uiType]}</span></label>
                <select className="select" value={inputSel[inp.id] || ''} onChange={e => setInputSel(prev => ({ ...prev, [inp.id]: e.target.value }))}>
                  <option value="">浠庨」鐩祫浜т腑閫夋嫨鈥?/option>
                  {assetOptionsFor(uiType).map(a => <option key={a.id} value={a.id}>{a.name}</option>)}
                </select>
              </div>
            )
          })}
        </div>
        <div className="sec-divider" style={{ margin: '16px 0 14px' }} />
        <div className="glabel" style={{ marginBottom: 9 }}>鍙傛暟璁剧疆</div>
        <div className="field"><label>杩愯鍚嶇О</label><input className="input" value={runName} onChange={e => setRunName(e.target.value)} /></div>
        <div className="field" style={{ marginBottom: 6 }}><label>杈撳嚭鐩綍</label><input className="input" defaultValue="outputs/carbon_storage/" /></div>
        <details className="collapse">
          <summary><span className="chev" style={{ display: 'inline-flex' }}><Icon name="chevron-right" cls="ic-sm" /></span>楂樼骇閫夐」</summary>
          <div className="field" style={{ marginTop: 10 }}>
            <label>杩愯妯″紡</label>
            <select className="select"><option>鏍囧噯锛堝畬鏁磋绠楋級</option><option>蹇€熼瑙堬紙闄嶉噰鏍凤級</option></select>
          </div>
        </details>
        {checkResult && <div style={{ marginTop: 14 }}>{checkResult}</div>}
      </Modal>

      <style jsx global>{`
        .app { overflow-x: auto; }
        .scene-bar { height: 46px; flex: none; display: flex; align-items: center; gap: 10px; padding: 0 18px; background: var(--surface); border-bottom: 1px solid var(--border); }
        .scene-bar .breadcrumb { display: flex; align-items: center; gap: 8px; font-size: 13.5px; color: var(--muted); }
        .scene-bar .breadcrumb a { color: var(--accent-ink); font-weight: 500; cursor: pointer; display: inline-flex; align-items: center; gap: 5px; }
        .scene-bar .breadcrumb a:hover { text-decoration: underline; }
        .scene-bar .breadcrumb b { color: var(--fg-strong); font-weight: 650; }
        .scene-bar .region { display: inline-flex; align-items: center; gap: 5px; font-size: 11.5px; color: var(--faint); }
        .scene-bar .region .ic { width: 13px; height: 13px; }
        .work { min-width: 1240px; flex: 1; min-height: 0; display: flex; }
        .c-left { width: 276px; flex: none; border-right: 1px solid var(--border); }
        .c-right { width: 312px; flex: none; border-left: 1px solid var(--border); }
        .c-center { flex: 1; min-width: 560px; background: var(--bg); display: flex; flex-direction: column; }
        .layer { padding: 10px 12px; border-bottom: 1px solid var(--border); }
        .layer-top { display: flex; align-items: center; gap: 9px; }
        .layer-name { font-size: 12.5px; font-weight: 500; color: var(--fg-strong); flex: 1; min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
        .layer-ctl { display: flex; align-items: center; gap: 8px; margin-top: 8px; padding-left: 39px; }
        .layer-ctl .range { flex: 1; }
        .layer-ctl .pct { font-size: 11px; color: var(--faint); width: 30px; text-align: right; font-family: var(--mono); }
        .layer .hideact { opacity: 0; transition: opacity .12s; display: flex; gap: 1px; }
        .layer:hover .hideact, .layer:focus-within .hideact { opacity: 1; }
        .file-folder { border-bottom: 1px solid var(--border); }
        .file-folder-head { display: flex; align-items: center; gap: 7px; height: 32px; padding: 0 12px; color: var(--fg-strong); background: var(--surface-2); font-size: 12px; font-weight: 650; }
        .file-folder-head .tree-count { margin-left: auto; font-family: var(--mono); color: var(--faint); font-size: 11px; }
        .file-in-folder { padding-left: 20px; }
        .model-row { display: flex; align-items: center; gap: 10px; padding: 11px 12px; border-bottom: 1px solid var(--border); cursor: pointer; transition: background .1s; }
        .model-row:hover { background: var(--surface-2); }
        .model-row.disabled { cursor: not-allowed; }
        .model-row.disabled:hover { background: transparent; }
        .model-search { position: relative; border-bottom: 1px solid var(--border); }
        .model-search .ic { position: absolute; left: 21px; top: 50%; transform: translateY(-50%); color: var(--faint); pointer-events: none; }
        .model-search input { width: 100%; height: 32px; border: 1px solid var(--border); border-radius: var(--r-sm); background: var(--surface); color: var(--fg); font: inherit; font-size: 12.5px; outline: none; padding: 0 10px 0 30px; }
        .model-search input:focus { border-color: var(--accent-line); box-shadow: 0 0 0 3px var(--accent-soft); }
        .chat-wrap { height: 100%; display: flex; flex-direction: column; }
        .chat-scroll { flex: 1; min-height: 0; overflow-y: auto; padding: 20px 0 8px; }
        .chat-inner { width: 100%; max-width: none; margin: 0; padding: 0 24px; display: flex; flex-direction: column; gap: 16px; }
        .msg { display: flex; align-items: flex-end; gap: 9px; }
        .msg.agent { justify-content: flex-start; }
        .msg.user { flex-direction: row-reverse; justify-content: flex-start; }
        .msg .who { width: 28px; height: 28px; border-radius: 50%; flex: none; display: grid; place-items: center; font-size: 10.5px; font-weight: 700; }
        .msg.user .who { background: var(--accent-soft); color: var(--accent-ink); border: 1px solid var(--accent-line); }
        .msg.agent .who { background: var(--accent); color: #fff; }
        .msg .bubble { max-width: 76%; min-width: 0; }
        .msg .body { font-size: 13.5px; line-height: 1.62; padding: 9px 13px; border-radius: 14px; }
        .msg.agent .body { background: var(--surface); border: 1px solid var(--border); color: var(--fg); border-bottom-left-radius: 4px; }
        .msg.user .body { background: var(--accent); color: #fff; border-bottom-right-radius: 4px; }
        .msg .body p { margin: 0; }
        .msg .body p + .att-tags { margin-top: 8px; }
        .msg.agent .body code { font-family: var(--mono); font-size: 12px; background: var(--inset); padding: 1px 5px; border-radius: 4px; }
        .msg.user .body code { font-family: var(--mono); font-size: 12px; background: rgba(255,255,255,.18); padding: 1px 5px; border-radius: 4px; }
        .msg .att-tags { display: flex; flex-wrap: wrap; gap: 6px; }
        .msg.user .att-chip { background: rgba(255,255,255,.16); border-color: rgba(255,255,255,.28); color: #fff; }
        .cursor-blink { display: inline-block; width: 7px; height: 15px; background: var(--accent); vertical-align: -2px; animation: blink 1s step-end infinite; border-radius: 1px; }
        @keyframes blink { 50% { opacity: 0; } }
        .composer { flex: none; padding: 0 24px 18px; }
        .composer-inner { max-width: 760px; margin: 0 auto; }
        .att-strip { display: flex; flex-wrap: wrap; gap: 6px; margin-bottom: 8px; }
        .att-chip { display: inline-flex; align-items: center; gap: 6px; height: 26px; padding: 0 6px 0 9px; background: var(--surface); border: 1px solid var(--border-strong); border-radius: 6px; font-size: 12px; font-family: var(--mono); color: var(--fg); }
        .att-chip button { border: 0; background: transparent; color: var(--faint); cursor: pointer; display: grid; place-items: center; padding: 2px; border-radius: 4px; }
        .att-chip button:hover { background: var(--inset); color: var(--danger); }
        .card-box { background: var(--surface); border: 1px solid var(--border-strong); border-radius: var(--r-lg); box-shadow: var(--shadow-float); transition: border-color .12s, box-shadow .12s; }
        .card-box:focus-within { border-color: var(--accent-line); box-shadow: 0 0 0 3px var(--accent-soft); }
        .composer textarea { width: 100%; border: 0; outline: none; resize: none; font-family: inherit; font-size: 13.5px; line-height: 1.55; color: var(--fg); background: transparent; padding: 13px 15px 4px; max-height: 160px; }
        .composer textarea::placeholder { color: var(--faint); }
        .composer-bar { display: flex; align-items: center; gap: 8px; padding: 7px 9px 9px; }
        .composer-bar .grow { flex: 1; }
        .mini-select { display: inline-flex; align-items: center; gap: 6px; height: 30px; padding: 0 9px; border-radius: var(--r-sm); border: 1px solid var(--border); background: var(--surface); font-size: 12.5px; color: var(--fg); cursor: pointer; }
        .mini-select:hover { background: var(--inset); }
        .send-btn { width: 32px; height: 32px; border-radius: var(--r-sm); border: 0; background: var(--accent); color: #fff; display: grid; place-items: center; cursor: pointer; transition: background .12s; }
        .send-btn:hover { background: var(--accent-ink); }
        .send-btn:disabled { background: var(--border-strong); cursor: not-allowed; }
        .pop { position: absolute; bottom: 42px; left: 0; min-width: 190px; background: var(--surface); border: 1px solid var(--border); border-radius: var(--r); box-shadow: var(--shadow-pop); padding: 5px; z-index: 30; }
        .pop button { width: 100%; display: flex; align-items: center; gap: 9px; padding: 8px 9px; border: 0; background: transparent; border-radius: var(--r-sm); font-size: 12.5px; color: var(--fg); cursor: pointer; text-align: left; }
        .pop button:hover { background: var(--inset); }
        .pop .head { font-size: 10.5px; font-weight: 600; letter-spacing: .06em; text-transform: uppercase; color: var(--faint); padding: 6px 9px 3px; }
        .split { display: flex; height: 100%; }
        .split .half { flex: 1; min-width: 0; }
        .split .half:first-child { border-right: 1px solid var(--border); background: var(--bg); }
        .log { flex: 1; min-height: 0; display: flex; flex-direction: column; }
        .log-out { flex: 1; min-height: 0; overflow-y: auto; background: oklch(26% 0.02 255); color: oklch(85% 0.02 230); font-family: var(--mono); font-size: 11.5px; line-height: 1.7; padding: 12px 13px; }
        .log-out .l-ok { color: oklch(72% 0.13 165); }
        .log-out .l-warn { color: oklch(78% 0.13 80); }
        .log-out .l-err { color: oklch(70% 0.16 25); }
        .log-out .l-dim { color: oklch(55% 0.02 230); }
        .task-card { padding: 13px 14px; border-bottom: 1px solid var(--border); }
        .task-state { display: flex; align-items: center; gap: 9px; }
        .task-state .ti { width: 30px; height: 30px; border-radius: 8px; display: grid; place-items: center; flex: none; }
        .ti.idle { background: var(--inset); color: var(--faint); }
        .ti.run { background: var(--warn-soft); color: oklch(55% 0.12 65); }
        .ti.done { background: var(--ok-soft); color: var(--ok); }
        .ti.fail { background: var(--danger-soft); color: var(--danger); }
      `}</style>
    </>
  )
}
