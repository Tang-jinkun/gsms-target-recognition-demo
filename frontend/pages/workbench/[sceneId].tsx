import React from 'react'
import ReactMarkdown from 'react-markdown'
import remarkGfm from 'remark-gfm'
import Head from 'next/head'
import Link from 'next/link'
import { useRouter } from 'next/router'
import TopNav from '../../src/components/shell/TopNav'
import Icon from '../../src/components/shell/Icon'
import Modal from '../../src/components/shell/Modal'
import Select from '../../src/components/shell/Select'
import MapView, { type WbLayer } from '../../src/components/workbench/MapView'
import { toast } from '../../src/lib/toast'
import { scenesRepo } from '../../src/lib/repos/scenesRepo'
import { settingsRepo, type ModelCfg } from '../../src/lib/repos/settingsRepo'
import { workbenchRepo, type DataHubImportSelection, type WbFile, type WbModel } from '../../src/lib/repos/workbenchRepo'
import { agentSessionsRepo, type AgentConfirmation, type AgentEvent, type AgentMessage, type AgentSession } from '../../src/lib/repos/agentSessionsRepo'
import { useAgentEventSource } from '../../src/lib/useAgentEventSource'
import { applyEventToBlocks, buildTurnsFromMessagesAndRuns, type RunStatus, type Turn, type TurnBlock } from '../../src/lib/activityBlocks'
import { dataImportProposalFromPayload } from '../../src/lib/confirmationPayload'
import { fmtBytes, type AssetType } from '../../src/lib/apiClient'

type View = 'agent' | 'map' | 'split'
type LeftTab = 'layers' | 'files' | 'invest'
type TaskState = 'idle' | 'run' | 'done' | 'fail'
type ChatMsg = { role: 'user' | 'agent'; html: string; text: string; att: string[] }

// TurnBlock/Turn types and the event-folding logic (applyEventToBlocks,
// finalizeBlocks) live in src/lib/activityBlocks.ts — a pure, framework-free
// module so the SSE-vs-polling folding invariant can be unit-tested.

const TYPE_LABEL: Record<string, string> = { raster: '栅格', vector: '矢量', table: '表格', text: '文本', folder: '文件夹', other: '其他' }
const TYPE_ICON: Record<string, string> = { raster: 'image', vector: 'map', table: 'table', text: 'file-text', other: 'file' }

/* Human-readable Chinese labels for agent tool names shown in the thinking timeline. */
const TOOL_LABEL: Record<string, string> = {
  list_invest_models: '列出可用模型',
  get_invest_model_schema: '加载模型输入要求',
  list_scene_data_cards: '读取场景数据',
  discover_data_hub_candidates: '探测 Data Hub 候选',
  import_data_hub_files_to_scene: '导入推荐文件',
  retrieve_input_candidates: '匹配候选数据',
  retrieve_required_input_candidates: '匹配必需输入',
  check_data_relation: '校验数据关系',
  finalize_data_matching: '生成绑定方案',
  finalize_sufficiency_assessment: '评估数据充分性',
  assess_scene_runnable_models: '普查可运行模型',
  assess_scene_model_readiness: '评估模型就绪度',
  list_invest_model_schemas: '列出模型输入规格',
  list_workspace_files: '列出工作区文件',
  read: '读取文件',
  submit_binding_report: '提交绑定方案',
  run_reconnaissance: '深度侦察',
  validate_binding_report: '验证绑定方案',
  confirm_validation_snapshot: '请求用户确认',
  execute_validated_snapshot: '执行模型计算',
  get_invest_job_status: '查询任务状态',
  get_job_status: '查询任务状态',
  get_job_logs: '获取任务日志',
  get_invest_job_outputs: '获取模型输出',
  collect_invest_outputs: '收集模型产出',
  export_invest_job_logs: '导出任务日志',
  inspect_invest_job_outputs: '检视输出清单',
  analyze_invest_results: '分析栅格统计',
  interpret_invest_results: '解释计算结果',
  write_invest_report: '撰写分析报告',
  finish: '完成',
  update_goal: '更新目标',
  skill: '调用技能',
}
const toolLabel = (name: string) => TOOL_LABEL[name] ?? name

/* fallback seeds (used when backend offline) — mirror prototype */
const SEED_FILES: WbFile[] = [
  { id: 'landuse_2020.tif', name: 'landuse_2020.tif', type: 'raster', size: 184 * 1024 * 1024 },
  { id: 'study_boundary.shp', name: 'study_boundary.shp', type: 'vector', size: 2.1 * 1024 * 1024 },
  { id: 'carbon_pools.csv', name: 'carbon_pools.csv', type: 'table', size: 6 * 1024 },
  { id: 'dem_30m.tif', name: 'dem_30m.tif', type: 'raster', size: 92 * 1024 * 1024 },
]
const SEED_MODELS: WbModel[] = [
  { id: 'carbon', name: 'Carbon Storage', status: 'ready', description: '碳储量与固碳 · 估算研究区地上/地下/土壤/枯落物碳库', inputs: [{ id: 'lulc_bas_asset_id', label: '土地利用数据', kind: 'asset', asset_type: 'raster', required: true }, { id: 'carbon_pools_asset_id', label: '碳密度表', kind: 'asset', asset_type: 'table', required: true }, { id: 'aoi_asset_id', label: '研究区边界', kind: 'asset', asset_type: 'geojson' }] },
  { id: 'habitat_quality', name: 'Habitat Quality', status: 'ready', description: '生境质量 · 基于威胁因子评估生境退化与质量', inputs: [{ id: 'lulc_cur_asset_id', label: '土地利用数据', kind: 'asset', asset_type: 'raster', required: true }] },
  { id: 'water_yield', name: 'Water Yield', status: 'planned', description: '产水量 · 流域尺度年均产水量估算', inputs: [] },
  { id: 'sdr', name: 'Sediment Delivery Ratio', status: 'planned', description: '泥沙输移比 · 土壤侵蚀与泥沙输移（规划中）', inputs: [] },
  { id: 'ndr', name: 'Nutrient Delivery Ratio', status: 'planned', description: '养分输移比 · 氮磷负荷与输移（规划中）', inputs: [] },
]

const backendType = (uiType: AssetType): string => (uiType === 'vector' ? 'geojson' : uiType)
const uiFromBackendAssetType = (bt?: string): AssetType => (bt === 'geojson' ? 'vector' : (bt as AssetType) || 'other')
const escapeHtml = (s: string) => s.replace(/[&<>]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;' }[c] as string))
const isAgentActionEvent = (type: string) =>
  /^(run|model|tool|state|artifact|diagnostic|loop|confirmation)\./.test(type)

// Events that fold into a run's activity blocks (think card timeline).
const isStreamFoldEvent = (type: string) =>
  type === 'model.streaming' || type === 'tool.started' ||
  type === 'tool.progress' || type === 'tool.completed' ||
  type === 'tool.failed' || type === 'tool.deferred' ||
  type === 'artifact.created' || type === 'diagnostic.created' ||
  type === 'confirmation.requested' || type === 'confirmation.resolved' ||
  type === 'confirmation.consumed' ||
  type === 'run.paused' || type === 'run.completed' ||
  type === 'run.failed'

// Events that change session/message/confirmation state and warrant a meta refresh.
const isMetaEvent = (type: string) =>
  type === 'session.status' || type === 'confirmation.requested' ||
  type === 'confirmation.resolved' || type === 'message.created' ||
  type === 'message.queued' || type === 'session.checkpoint' ||
  type === 'run.paused'

export default function WorkbenchPage() {
  const router = useRouter()
  const sceneId = typeof router.query.sceneId === 'string' ? router.query.sceneId : ''
  const [sceneName, setSceneName] = React.useState('场景')
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
  const [prototypeMsgs] = React.useState<ChatMsg[]>([
    { role: 'user', html: '帮我看看当前项目里有哪些数据可以用来跑碳储量模型？', text: '帮我看看当前项目里有哪些数据可以用来跑碳储量模型？', att: [] },
    { role: 'agent', html: '当前项目包含 <code>landuse_2020.tif</code>（土地利用栅格）、<code>study_boundary.shp</code>（研究区边界）和 <code>carbon_pools.csv</code>（碳密度表）。这三项正好对应 Carbon Storage 模型的全部必需输入，可以直接在左栏 InVEST 标签里手动配置运行。', text: '当前项目包含 landuse_2020.tif（土地利用栅格）、study_boundary.shp（研究区边界）和 carbon_pools.csv（碳密度表）。这三项正好对应 Carbon Storage 模型的全部必需输入，可以直接在左栏 InVEST 标签里手动配置运行。', att: [] },
    { role: 'user', html: '好的，先把这份土地利用数据作为上下文。', text: '好的，先把这份土地利用数据作为上下文。', att: ['landuse_2020.tif'] },
    { role: 'agent', html: '已记录这份土地利用数据作为对话上下文。需要我对它的分类体系或时相做进一步说明吗？', text: '已记录这份土地利用数据作为对话上下文。需要我对它的分类体系或时相做进一步说明吗？', att: [] },
  ])
  const [msgs, setMsgs] = React.useState<ChatMsg[]>([])
  const [turns, setTurns] = React.useState<Turn[]>([])
  const [atts, setAtts] = React.useState<string[]>([])
  const [draft, setDraft] = React.useState('')
  const [streaming, setStreaming] = React.useState(false)
  const [agentSession, setAgentSession] = React.useState<AgentSession | null>(null)
  const [pendingConfirmation, setPendingConfirmation] = React.useState<AgentConfirmation | null>(null)
  const pendingConfirmationRef = React.useRef<AgentConfirmation | null>(null)
  const [agentError, setAgentError] = React.useState('')
  const [agentEvents, setAgentEvents] = React.useState<AgentEvent[]>([])
  const agentEventCursorRef = React.useRef({ sessionId: '', afterId: 0 })
  const [attOpen, setAttOpen] = React.useState(false)
  const chatScrollRef = React.useRef<HTMLDivElement | null>(null)
  const [defaultModel, setDefaultModel] = React.useState<ModelCfg | undefined>(undefined)

  // task + log
  const [task, setTask] = React.useState<TaskState>('idle')
  const [curModel, setCurModel] = React.useState('Carbon Storage')
  const [logLines, setLogLines] = React.useState<{ cls: string; text: string }[]>([{ cls: 'l-dim', text: '等待任务… 运行模型后日志将显示在此。' }])
  const logRef = React.useRef<HTMLDivElement | null>(null)
  const pollRef = React.useRef<number | null>(null)

  // invest modal
  const [modalModel, setModalModel] = React.useState<WbModel | null>(null)
  const [modelSearch, setModelSearch] = React.useState('')
  const [inputSel, setInputSel] = React.useState<Record<string, string>>({})
  const [uiRunMode, setUiRunMode] = React.useState('standard')
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
        toast('未找到后端场景，请从场景页进入真实场景')
      }
    })
    return () => { cancelled = true }
  }, [sceneId])

  React.useEffect(() => {
    let cancelled = false
    settingsRepo.defaultModel().then(model => { if (!cancelled) setDefaultModel(model) }).catch(() => {})
    return () => { cancelled = true }
  }, [])

  // Durable per-run activity (reasoning text + tool calls), keyed by run_id and
  // accumulated from the event stream. Survives polls AND the moment the final
  // message is persisted, so the think card never disappears. Runs are ordered
  // by first-seen so they map onto assistant messages chronologically.
  const runBlocksRef = React.useRef<Map<string, TurnBlock[]>>(new Map())
  const runOrderRef = React.useRef<string[]>([])
  const runStatusRef = React.useRef<Map<string, RunStatus>>(new Map())
  const confirmationRunRef = React.useRef<Map<string, string>>(new Map())
  // Guard against overlapping refreshes: two in-flight calls would both read the
  // same event cursor and fold the same streaming deltas, duplicating text N times.
  const refreshInFlightRef = React.useRef(false)

  // Latest persisted messages, kept in a ref so the turn rebuild (driven by both
  // SSE folds and meta refreshes) reads current values without re-subscribing.
  const messagesRef = React.useRef<AgentMessage[]>([])

  // Rebuild the visible turns from persisted messages + accumulated run blocks.
  // Pure projection over the refs; safe to call after any event fold or refresh.
  const rebuildTurns = React.useCallback(() => {
    setTurns(buildTurnsFromMessagesAndRuns({
      messages: messagesRef.current,
      runOrder: runOrderRef.current,
      runBlocks: runBlocksRef.current,
      runStatuses: runStatusRef.current,
      pendingConfirmation: Boolean(pendingConfirmationRef.current),
    }))
  }, [])

  // Fold one event into its run's activity blocks. Returns true if the event was
  // an activity (stream-fold) event so the caller can decide to rebuild turns.
  const foldEvent = React.useCallback((ev: AgentEvent) => {
    if (isAgentActionEvent(ev.type)) {
      setAgentEvents(previous => [...previous, ev].slice(-500))
    }
    if (!isStreamFoldEvent(ev.type)) return false
    const confirmationId = typeof ev.data.confirmation_id === 'string' ? ev.data.confirmation_id : undefined
    const runId =
      (ev.data.run_id as string | undefined) ??
      (confirmationId ? confirmationRunRef.current.get(confirmationId) : undefined) ??
      runOrderRef.current.at(-1) ??
      'run'
    let blocks = runBlocksRef.current.get(runId)
    if (!blocks) {
      blocks = []
      runBlocksRef.current.set(runId, blocks)
      runOrderRef.current.push(runId)
      runStatusRef.current.set(runId, 'active')
    }
    if (ev.type === 'confirmation.requested' && confirmationId) {
      confirmationRunRef.current.set(confirmationId, runId)
    }
    applyEventToBlocks(blocks, ev)
    if (ev.type === 'run.paused') runStatusRef.current.set(runId, 'paused')
    if (ev.type === 'run.completed') runStatusRef.current.set(runId, 'completed')
    if (ev.type === 'run.failed') runStatusRef.current.set(runId, 'failed')
    return true
  }, [])

  const ensurePendingConfirmationBlock = React.useCallback((confirmation: AgentConfirmation | null) => {
    if (!confirmation) return
    if (confirmationRunRef.current.has(confirmation.id)) return
    const runId = [...runOrderRef.current].reverse().find(id =>
      runStatusRef.current.get(id) === 'paused' || runBlocksRef.current.get(id)?.some(block => block.type === 'tool' && block.name === confirmation.kind),
    ) ?? runOrderRef.current.at(-1)
    if (!runId) return
    let blocks = runBlocksRef.current.get(runId)
    if (!blocks) {
      blocks = []
      runBlocksRef.current.set(runId, blocks)
      runOrderRef.current.push(runId)
    }
    if (!blocks.some(block => block.type === 'confirmation' && block.id === confirmation.id)) {
      blocks.push({
        type: 'confirmation',
        id: confirmation.id,
        kind: confirmation.kind,
        status: confirmation.status,
        prompt: confirmation.prompt,
        payload: confirmation.payload,
      })
    }
    confirmationRunRef.current.set(confirmation.id, runId)
  }, [])

  const updateConfirmationBlockStatus = React.useCallback((confirmationId: string, status: AgentConfirmation['status']) => {
    for (const blocks of runBlocksRef.current.values()) {
      const block = blocks.find(item => item.type === 'confirmation' && item.id === confirmationId)
      if (block && block.type === 'confirmation') block.status = status
    }
  }, [])

  const syncConfirmationBlockStatuses = React.useCallback((confirmations: AgentConfirmation[]) => {
    for (const confirmation of confirmations) {
      updateConfirmationBlockStatus(confirmation.id, confirmation.status)
    }
  }, [updateConfirmationBlockStatus])

  // Reset all per-session accumulation when switching sessions.
  const resetSessionState = React.useCallback((sessionId: string) => {
    agentEventCursorRef.current = { sessionId, afterId: 0 }
    setAgentEvents([])
    runBlocksRef.current = new Map()
    runOrderRef.current = []
    runStatusRef.current = new Map()
    confirmationRunRef.current = new Map()
    messagesRef.current = []
  }, [])

  // Refresh session metadata (status, messages, confirmations). Used on init,
  // on meta SSE events, and on the lightweight fallback timer. Does NOT fetch
  // events — those arrive via SSE (or the full polling fallback).
  const refreshMeta = React.useCallback(async (session: AgentSession) => {
    const [current, messages, confirmations] = await Promise.all([
      agentSessionsRepo.get(session.id),
      agentSessionsRepo.messages(session.id),
      agentSessionsRepo.confirmations(session.id),
    ])
    setAgentSession(current)
    const isRunning = current.status === 'queued' || current.status === 'running'
    setStreaming(isRunning)
    messagesRef.current = messages
    const pending = [...confirmations].reverse().find(item => item.status === 'pending') ?? null
    pendingConfirmationRef.current = pending
    setPendingConfirmation(pending)
    ensurePendingConfirmationBlock(pending)
    syncConfirmationBlockStatuses(confirmations)
    setAgentError(current.last_error ?? '')
    rebuildTurns()
  }, [ensurePendingConfirmationBlock, rebuildTurns, syncConfirmationBlockStatuses])

  // Full polling refresh (fallback path when SSE is unavailable): also fetches
  // events and folds them, replicating the original single-loop behavior.
  const runRefresh = React.useCallback(async (session: AgentSession) => {
    if (agentEventCursorRef.current.sessionId !== session.id) {
      resetSessionState(session.id)
    }
    const [current, messages, confirmations, events] = await Promise.all([
      agentSessionsRepo.get(session.id),
      agentSessionsRepo.messages(session.id),
      agentSessionsRepo.confirmations(session.id),
      agentSessionsRepo.events(session.id, agentEventCursorRef.current.afterId),
    ])
    setAgentSession(current)
    const isRunning = current.status === 'queued' || current.status === 'running'
    setStreaming(isRunning)
    messagesRef.current = messages
    const pending = [...confirmations].reverse().find(item => item.status === 'pending') ?? null
    pendingConfirmationRef.current = pending
    setPendingConfirmation(pending)
    ensurePendingConfirmationBlock(pending)
    setAgentError(current.last_error ?? '')
    if (events.length) {
      agentEventCursorRef.current.afterId = events.at(-1)!.id
      for (const ev of events) foldEvent(ev)
    }
    syncConfirmationBlockStatuses(confirmations)
    rebuildTurns()
  }, [resetSessionState, foldEvent, ensurePendingConfirmationBlock, rebuildTurns, syncConfirmationBlockStatuses])

  const refreshAgentSession = React.useCallback(async (session: AgentSession) => {
    if (refreshInFlightRef.current) return
    refreshInFlightRef.current = true
    try {
      await runRefresh(session)
    } finally {
      refreshInFlightRef.current = false
    }
  }, [runRefresh])

  // After a user action (send / confirm): when SSE is live only refresh metadata
  // (the stream delivers events — fetching them here would double-fold); when SSE
  // has fallen back to polling, do a full refresh that also folds events.
  const sseFailedRef = React.useRef(false)
  const refreshAfterAction = React.useCallback(async (session: AgentSession) => {
    if (sseFailedRef.current) await refreshAgentSession(session)
    else await refreshMeta(session)
  }, [refreshAgentSession, refreshMeta])

  // The active session, once resolved, drives both SSE and fallback polling.
  const [activeSession, setActiveSession] = React.useState<AgentSession | null>(null)
  const [sseFailed, setSseFailed] = React.useState(false)
  React.useEffect(() => { sseFailedRef.current = sseFailed }, [sseFailed])
  const pollSessionRef = React.useRef<AgentSession | null>(null)
  const streamingRef = React.useRef(false)
  React.useEffect(() => { streamingRef.current = streaming }, [streaming])

  // Resolve (or create) the session for this scene, then prime initial state.
  React.useEffect(() => {
    if (!sceneId) return
    let cancelled = false
    const start = async () => {
      try {
        const sessions = await agentSessionsRepo.list(sceneId)
        const session = sessions[0] ?? await agentSessionsRepo.create(sceneId, `${sceneName} Agent`)
        if (cancelled) return
        pollSessionRef.current = session
        resetSessionState(session.id)
        // Prime events once so history before the SSE connection is present.
        // Only then activate SSE — it resumes from the primed cursor, so the
        // initial fetch's events are never re-delivered (no duplicate text).
        await refreshAgentSession(session)
        if (cancelled) return
        setActiveSession(session)
      } catch {
        if (!cancelled) setAgentError('Agent session service is unavailable.')
      }
    }
    start()
    return () => { cancelled = true }
  }, [sceneId, refreshAgentSession, resetSessionState])

  // SSE: real-time event stream. Folds activity events immediately; for meta
  // events (status/message/confirmation changes) it triggers a metadata refresh.
  const handleSseEvent = React.useCallback((ev: AgentEvent) => {
    if (ev.id && ev.id > agentEventCursorRef.current.afterId) {
      agentEventCursorRef.current.afterId = ev.id
    }
    const folded = foldEvent(ev)
    if (folded) {
      rebuildTurns()
    }
    if (isMetaEvent(ev.type)) {
      const session = pollSessionRef.current
      if (session) refreshMeta(session).catch(() => {})
    }
  }, [foldEvent, rebuildTurns, refreshMeta])

  useAgentEventSource({
    sessionId: sseFailed ? null : activeSession?.id ?? null,
    onEvent: handleSseEvent,
    onError: () => setSseFailed(true),
    enabled: !sseFailed,
    initialCursor: agentEventCursorRef.current.afterId,
  })

  // Lightweight safety-net refresh while SSE is active: catches any meta drift
  // (e.g. a status event missed during a reconnect gap). Cheap — no events fetch.
  React.useEffect(() => {
    if (sseFailed || !activeSession) return
    const id = window.setInterval(() => {
      if (pollSessionRef.current) refreshMeta(pollSessionRef.current).catch(() => {})
    }, 5000)
    return () => window.clearInterval(id)
  }, [sseFailed, activeSession, refreshMeta])

  // Fallback polling loop: only runs if SSE failed. Mirrors the original
  // self-scheduling single loop with adaptive cadence.
  React.useEffect(() => {
    if (!sseFailed || !activeSession) return
    let cancelled = false
    let timer: number | undefined
    const poll = () => {
      if (cancelled || !pollSessionRef.current) return
      refreshAgentSession(pollSessionRef.current).catch(() => {})
      timer = window.setTimeout(poll, streamingRef.current ? 500 : 1500)
    }
    poll()
    return () => {
      cancelled = true
      if (timer) window.clearTimeout(timer)
    }
  }, [sseFailed, activeSession, refreshAgentSession])

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

  const autoScrollRef = React.useRef(true)
  React.useEffect(() => {
    const el = chatScrollRef.current
    if (!el) return
    const handleScroll = () => {
      const atBottom = el.scrollHeight - el.scrollTop - el.clientHeight < 60
      autoScrollRef.current = atBottom
    }
    el.addEventListener('scroll', handleScroll, { passive: true })
    return () => el.removeEventListener('scroll', handleScroll)
  }, [view])
  React.useEffect(() => {
    const el = chatScrollRef.current
    if (el && autoScrollRef.current) el.scrollTop = el.scrollHeight
  }, [msgs, turns, view])
  React.useEffect(() => { const el = logRef.current; if (el) el.scrollTop = el.scrollHeight }, [logLines])
  React.useEffect(() => () => { if (pollRef.current) window.clearInterval(pollRef.current) }, [])

  /* ---- layers ---- */
  function addToMap(f: WbFile) {
    if (f.type !== 'raster' && f.type !== 'vector') { toast('该类型不支持加入地图'); return }
    const id = 'ly_' + f.id.replace(/[^a-zA-Z0-9_-]/g, '_')
    if (layers.some(l => l.id === id)) { toast('图层已在地图中'); return }
    setLayers(prev => [{ id, name: f.name, type: f.type === 'raster' ? 'raster' : 'vector', visible: true, opacity: f.type === 'raster' ? 64 : 82, rasterUrl: f.previewUrl, geojsonUrl: f.geojsonUrl, bounds: f.bounds }, ...prev])
    setFitNonce(n => n + 1)
    setLeftTab('layers')
    toast('已加入地图：' + f.name)
  }
  const setLayer = (id: string, patch: Partial<WbLayer>) => setLayers(prev => prev.map(l => (l.id === id ? { ...l, ...patch } : l)))
  const removeLayer = (id: string) => { setLayers(prev => prev.filter(l => l.id !== id)); toast('已移除图层') }

  async function openImportFiles() {
    if (!sceneId) { toast('请先进入一个真实场景', 'error'); return }
    try {
      const all = await workbenchRepo.listDataHubFiles()
      const imported = new Set(files.map(f => f.id))
      setHubFiles(all.filter(f => !imported.has(f.id)))
      setImportSel({})
      setImportOpen(true)
    } catch {
      toast('Data Hub 文件加载失败，请检查后端服务', 'error')
    }
  }

  async function importSelectedFiles() {
    const fileIds = Object.keys(importSel).filter(id => importSel[id])
    if (!sceneId || !fileIds.length) return
    try {
      const result = await workbenchRepo.importFiles(sceneId, fileIds)
      toast(`已导入 ${result.imported} 个文件`)
      setImportOpen(false)
      await refreshSceneFiles()
    } catch {
      toast('导入失败，请检查后端服务', 'error')
    }
  }

  async function removeImportedFile(fileId: string) {
    if (!sceneId) return
    try {
      await workbenchRepo.removeFileImport(sceneId, fileId)
      toast('已从场景移除文件引用')
      await refreshSceneFiles()
    } catch {
      toast('移除失败，请检查后端服务', 'error')
    }
  }

  /* ---- chat ---- */
  function addAtt(name: string) { setAtts(prev => (prev.includes(name) ? prev : [...prev, name])); setAttOpen(false) }
  async function send() {
    const text = draft.trim()
    if (!text || streaming || !agentSession) return
    autoScrollRef.current = true
    const attachmentContext = atts.length ? `\n\nReferenced scene files: ${atts.join(', ')}` : ''
    try {
      setDraft(''); setAtts([])
      setStreaming(true)
      setAgentError('')
      const result = await agentSessionsRepo.send(agentSession.id, text + attachmentContext)
      await refreshAfterAction(result.session)
    } catch {
      setStreaming(false)
      setAgentError('Could not send the message. The session may still be busy.')
    }
  }

  async function resolveAgentConfirmation(approved: boolean, confirmationId = pendingConfirmation?.id) {
    if (!agentSession || !confirmationId) return
    try {
      updateConfirmationBlockStatus(confirmationId, approved ? 'approved' : 'rejected')
      rebuildTurns()
      const result = await agentSessionsRepo.resolveConfirmation(agentSession.id, confirmationId, approved)
      setPendingConfirmation(null)
      await refreshAfterAction(result.session)
    } catch {
      setAgentError('Could not resolve the Agent confirmation.')
    }
  }

  function pendingDataHubImport() {
    if (!pendingConfirmation) return null
    return dataImportProposalFromPayload(pendingConfirmation.kind, pendingConfirmation.payload)
  }

  async function importPartialRecommendation(fileIds: string[], confirmationId = pendingConfirmation?.id) {
    if (!agentSession || !confirmationId || !sceneId || fileIds.length === 0) return
    try {
      const result = await workbenchRepo.importFiles(sceneId, fileIds)
      toast(`已导入 ${result.imported} 个推荐文件`)
      await refreshSceneFiles()
      await resolveAgentConfirmation(false, confirmationId)
    } catch {
      setAgentError('Could not import the selected Data Hub files.')
    }
  }

  function AgentConfirmationCard(props: { confirmation?: AgentConfirmation | null; compact?: boolean }) {
    const confirmation = props.confirmation ?? pendingConfirmation
    const proposal = confirmation
      ? dataImportProposalFromPayload(confirmation.kind, confirmation.payload)
      : pendingDataHubImport()
    const [selected, setSelected] = React.useState<Record<string, boolean>>({})
    React.useEffect(() => {
      if (!proposal) return
      setSelected(Object.fromEntries(proposal.fileIds.map(id => [id, true])))
    }, [confirmation?.id, proposal?.fileIds.join('|')])
    if (!confirmation) return null
    const isPending = confirmation.status === 'pending'
    const statusText =
      confirmation.status === 'pending'
        ? '等待确认'
        : confirmation.status === 'approved'
          ? '已确认，正在执行'
          : confirmation.status === 'consumed'
            ? '已确认并执行'
            : '已取消'
    if (!proposal) {
      return (
        <div className="agent-confirm">
          <div><b>Agent confirmation required</b><p>{confirmation.prompt}</p></div>
          {isPending
            ? <>
                <button className="btn btn-sm" onClick={() => resolveAgentConfirmation(false, confirmation.id)}>Reject</button>
                <button className="btn btn-sm btn-primary" onClick={() => resolveAgentConfirmation(true, confirmation.id)}>Approve</button>
              </>
            : <span className="confirm-status">{statusText}</span>}
        </div>
      )
    }
    const rows: DataHubImportSelection[] = proposal.selections.length
      ? proposal.selections
      : proposal.fileIds.map(fileId => ({ slot: 'input', fileId }))
    const selectedIds = proposal.fileIds.filter(id => selected[id])
    const allSelected = selectedIds.length === proposal.fileIds.length
    return (
      <div className="agent-confirm import-proposal">
        <div className="confirm-main">
          <b>{proposal.title ?? '推荐导入 Data Hub 文件'}</b>
          <p>{proposal.description ?? 'Agent 找到这些文件可能适合当前模型输入。确认后只会把 Data Hub 文件引用写入当前场景，不复制文件。'}</p>
          <div className="proposal-list">
            {rows.map(row => (
              <label className="proposal-row" key={`${row.slot}:${row.fileId}`}>
                <input type="checkbox" disabled={!isPending} checked={selected[row.fileId] !== false} onChange={e => setSelected(prev => ({ ...prev, [row.fileId]: e.target.checked }))} />
                <span className="slot-pill">{row.slot}</span>
                <div className="proposal-copy">
                  <div className="ftitle">{row.name || row.fileId}</div>
                  <div className="fsub">
                    {row.confidence || 'candidate'}{typeof row.score === 'number' ? ` · ${(row.score * 100).toFixed(0)}%` : ''}
                  </div>
                  {!!row.reasons?.length && <div className="reason">{row.reasons.slice(0, 2).join('；')}</div>}
                  {!!row.risks?.length && <div className="risk">{row.risks.slice(0, 1).join('；')}</div>}
                </div>
              </label>
            ))}
          </div>
        </div>
        <div className="confirm-actions">
          {isPending
            ? <>
                <button className="btn btn-sm" onClick={() => resolveAgentConfirmation(false, confirmation.id)}>{proposal.rejectLabel ?? '取消'}</button>
                {proposal.allowPartial !== false && !allSelected && <button className="btn btn-sm" disabled={!selectedIds.length} onClick={() => importPartialRecommendation(selectedIds, confirmation.id)}>只导入所选</button>}
                <button className="btn btn-sm btn-primary" disabled={!selectedIds.length || !allSelected} onClick={() => resolveAgentConfirmation(true, confirmation.id)}>{proposal.approveLabel ?? '全部导入'}</button>
              </>
            : <span className="confirm-status">{statusText}</span>}
        </div>
      </div>
    )
  }

  function sendPrototype() {
    const text = draft.trim()
    if (!text || streaming) return
    autoScrollRef.current = true
    const userMsg: ChatMsg = { role: 'user', html: escapeHtml(text), text, att: atts.slice() }
    setDraft(''); setAtts([])
    setStreaming(true)
    const reply = '收到。我会基于当前项目的数据回答——你可以在左栏 InVEST 标签选择模型、配置输入后手动运行，运行状态与日志会显示在右侧面板。'
    setMsgs(prev => [...prev, userMsg, { role: 'agent', html: '<span class="cursor-blink"></span>', text: '', att: [] }])
    let i = 0
    const tick = () => {
      i += 2
      const done = i >= reply.length
      setMsgs(prev => {
        const next = prev.slice()
        next[next.length - 1] = { role: 'agent', html: escapeHtml(reply.slice(0, i)) + (done ? '' : '<span class="cursor-blink"></span>'), text: reply.slice(0, i), att: [] }
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

  function agentEventClass(event: AgentEvent): string {
    if (event.data.status === 'failed' || event.type === 'loop.detected' || event.type === 'run.failed') return 'l-err'
    if (event.type === 'run.completed' || event.type === 'tool.completed') return 'l-ok'
    if (event.data.status === 'started' || event.data.status === 'waiting') return 'l-warn'
    return 'l-dim'
  }

  function agentEventText(event: AgentEvent): string {
    const turn = typeof event.data.turn === 'number' ? `turn ${event.data.turn} ` : ''
    const duration = typeof event.data.duration_ms === 'number' ? ` (${event.data.duration_ms}ms)` : ''
    return `${turn}${event.data.summary ?? event.type}${duration}`
  }

  function simulateRun(name: string) {
    setLogLines([{ cls: 'l-dim', text: `$ invest run ${name.toLowerCase().replace(/ /g, '-')}` }])
    const steps: [string, string][] = [
      ['l-ok', '已加载输入：土地利用数据、碳密度表、研究区边界'],
      ['l-dim', '校验栅格对齐与坐标系 EPSG:4326 … 通过'],
      ['l-dim', '计算碳库：地上 / 地下 / 土壤 / 枯落物 …'],
      ['l-warn', '警告：3.2% 像元缺失碳密度，已按邻域均值填充'],
      ['l-dim', '汇总研究区总碳储量 …'],
      ['l-ok', '输出已写入 outputs/carbon_storage/  →  tot_c_cur.tif'],
    ]
    let i = 0
    const next = () => {
      if (i < steps.length) { pushLog(steps[i][0], steps[i][1]); i++; window.setTimeout(next, 520) }
      else { pushLog('l-ok', '✓ 运行完成，用时 9.4s'); setTask('done'); toast('运行完成：' + name) }
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
              void refreshSceneFiles()
            }
            toast(st.status === 'succeeded' ? '运行完成：' + model.name : '运行失败：' + model.name, st.status === 'failed' ? 'error' : 'ok')
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
    const ok = await realRun(model)
    if (!ok) { pushLog('l-dim', '后端不可用，进入演示模式。'); simulateRun(model.name) }
  }

  /* ---- invest modal ---- */
  function openInvest(m: WbModel) {
    if (m.status === 'planned') { toast('该模型规划中，暂不可运行'); return }
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
          {!r.info?.length && !r.warnings?.length && !r.errors?.length && <div className="notice notice-ok"><Icon name="check-circle" cls="ic-sm" /><div>检查通过，可继续运行。</div></div>}
        </>,
      )
    } catch {
      setCheckResult(
        <>
          <div className="notice notice-ok" style={{ marginBottom: 7 }}><Icon name="check-circle" cls="ic-sm" /><div>研究区边界、土地利用数据 — 通过</div></div>
          <div className="notice notice-warn" style={{ marginBottom: 7 }}><Icon name="alert-triangle" cls="ic-sm" /><div>碳密度表 — 警告：缺少 3 个土地利用类别的碳值，将按 0 处理</div></div>
          <div className="notice notice-info"><Icon name="info" cls="ic-sm" /><div>检查完成：1 项警告，0 项错误，可继续运行。</div></div>
        </>,
      )
    }
  }

  const TASK_META: Record<TaskState, { ic: string; icn: string; title: string; badge: React.ReactNode }> = {
    idle: { ic: 'idle', icn: 'box', title: '当前无运行任务', badge: null },
    run: { ic: 'run', icn: 'refresh-cw', title: 'InVEST 正在运行', badge: <span className="badge badge-warn"><span className="bdot" />运行中</span> },
    done: { ic: 'done', icn: 'check-circle', title: '运行完成', badge: <span className="badge badge-ok"><span className="bdot" />完成</span> },
    fail: { ic: 'fail', icn: 'alert-circle', title: '运行失败，请查看日志', badge: <span className="badge badge-danger"><span className="bdot" />失败</span> },
  }
  const tm = TASK_META[task]
  const filteredModels = models.filter(m => {
    const q = modelSearch.trim().toLowerCase()
    if (!q) return true
    return `${m.name} ${m.id}`.toLowerCase().includes(q)
  })
  const fileGroups = Array.from(files.reduce((map, file) => {
    const key = file.folderName || '未分类'
    const group = map.get(key) || []
    group.push(file)
    map.set(key, group)
    return map
  }, new Map<string, WbFile[]>()))

  function fallbackCopy(text: string): boolean {
    const ta = document.createElement('textarea')
    ta.value = text
    ta.style.cssText = 'position:fixed;left:-9999px;opacity:0'
    document.body.appendChild(ta)
    ta.select()
    const ok = document.execCommand('copy')
    document.body.removeChild(ta)
    return ok
  }

  function ChatList({ pad }: { pad: string }) {
    const [copiedIdx, setCopiedIdx] = React.useState<number | null>(null)
    const [collapsedCards, setCollapsedCards] = React.useState<Set<number>>(new Set())
    function copyText(text: string, idx: number) {
      if (!text) return
      const done = () => { setCopiedIdx(idx); setTimeout(() => setCopiedIdx(null), 1500) }
      if (navigator.clipboard?.writeText) {
        navigator.clipboard.writeText(text).then(done).catch(() => fallbackCopy(text) && done())
      } else {
        fallbackCopy(text) && done()
      }
    }
    function toggleCard(turnIdx: number) {
      setCollapsedCards(prev => {
        const next = new Set(prev)
        if (next.has(turnIdx)) next.delete(turnIdx); else next.add(turnIdx)
        return next
      })
    }

    if (turns.length > 0) {
      return (
        <div className="chat-inner" style={{ padding: pad }}>
          {turns.map((turn, i) => {
            if (turn.role === 'user') {
              const text = turn.blocks.map(b => b.type === 'text' ? b.text : '').join('')
              return (
                <div className="msg user" key={i}>
                  <span className="who">我</span>
                  <div className="bubble">
                    <div className="body md-body"><ReactMarkdown remarkPlugins={[remarkGfm]}>{text}</ReactMarkdown></div>
                    <button className="copy-btn" title="复制" onClick={() => copyText(text, i)}>
                      <Icon name={copiedIdx === i ? 'check' : 'copy'} cls="ic-sm" />
                    </button>
                  </div>
                </div>
              )
            }

            // Assistant turn: a finished turn carries [...activity, finalAnswerText].
            // A live streaming turn carries activity only (the answer is not yet
            // persisted) — so all of its blocks are thinking activity, never answer.
            const isStreaming = !!turn.streaming
            const responseIdx = isStreaming ? -1 : turn.blocks.length - 1
            const activityBlocks = isStreaming ? turn.blocks : turn.blocks.slice(0, responseIdx)
            const responseBlock = responseIdx >= 0 ? turn.blocks[responseIdx] : null
            const hasActivity = activityBlocks.length > 0
            const isDone = !isStreaming
            const isCollapsed = isDone && hasActivity && collapsedCards.has(i)
            const toolCount = activityBlocks.filter(b => b.type === 'tool').length

            return (
              <div className="msg agent" key={i}>
                <span className="who">AI</span>
                <div className="bubble">
                  <div className="turn">
                    {/* Think block: timeline of thinking steps + tool calls */}
                    {hasActivity && (
                      <div className={`think ${isDone ? '' : 'running'} ${!isCollapsed ? 'open' : ''}`}>
                        <button className="think-head" onClick={() => toggleCard(i)}>
                          <Icon name="chevron-right" cls="chev ic-sm" />
                          <span className="tlabel"><Icon name="brain" cls="ic-sm" />思考过程</span>
                          <span className="tsum">
                            {isStreaming
                              ? <><span className="spinner" />思考中…</>
                              : `已思考 · ${toolCount} 步`}
                          </span>
                        </button>
                        <div className="think-body">
                          <div className="timeline">
                            {activityBlocks.map((block, j) => {
                              if (block.type === 'text') {
                                // The model emits newlines as sentence boundaries (e.g.
                                // '。\n', ':\n\n'). Splitting on \n produces 1-3 char
                                // fragments ("final / ize / _s / ufficiency"). Collapse
                                // all newlines into spaces so the thinking text reads as
                                // one continuous paragraph — the way it's meant to.
                                const text = block.text.replace(/\n+/g, ' ').trim()
                                return (
                                  <div className={`tl-step ${block.status === 'streaming' ? 'run' : 'done'}`} key={j}>
                                    <span className="tl-dot">
                                      {block.status === 'streaming'
                                        ? <span className="spinner" style={{ width: 9, height: 9, borderWidth: 1.5 }} />
                                        : <Icon name="check" cls="ic-sm" />}
                                    </span>
                                    <div className="tl-lines">
                                      <div className="tl-line" dangerouslySetInnerHTML={{ __html: escapeHtml(text) }} />
                                    </div>
                                  </div>
                                )
                              }
                              if (block.type === 'tool') {
                                return (
                                  <div className={`tl-step ${block.status === 'running' ? 'run' : block.status === 'completed' ? 'done' : 'pending'}`} key={j}>
                                    <span className="tl-dot">
                                      {block.status === 'running'
                                        ? <span className="spinner" style={{ width: 9, height: 9, borderWidth: 1.5 }} />
                                        : block.status === 'completed'
                                          ? <Icon name="check" cls="ic-sm" />
                                          : <Icon name="alert-circle" cls="ic-sm" />}
                                    </span>
                                    <div className="tl-title">{toolLabel(block.name)}</div>
                                    <div className="tl-lines">
                                      <div className="tool-chip">
                                        <span className="tk"><Icon name="cpu" cls="ic-sm" />{block.name}</span>
                                        {block.message && <span className="arg">{block.message}</span>}
                                        {block.archived && <span className="arg" title="完整结果已存档，模型可按需取回"><Icon name="box" cls="ic-sm" />结果已存档</span>}
                                        {block.status === 'completed' && <span className="ok"><Icon name="check" cls="ic-sm" /></span>}
                                      </div>
                                    </div>
                                  </div>
                                )
                              }
                              if (block.type === 'confirmation') {
                                const active = pendingConfirmation?.id === block.id ? pendingConfirmation : null
                                const confirmation: AgentConfirmation = active ?? {
                                  id: block.id,
                                  session_id: agentSession?.id ?? '',
                                  kind: block.kind,
                                  status: block.status,
                                  prompt: block.prompt ?? '需要用户确认',
                                  payload: block.payload ?? {},
                                }
                                const isPending = confirmation.status === 'pending'
                                return (
                                  <div className={`tl-step ${isPending ? 'run' : confirmation.status === 'rejected' ? 'pending' : 'done'}`} key={j}>
                                    <span className="tl-dot">
                                      {isPending
                                        ? <Icon name="help-circle" cls="ic-sm" />
                                        : confirmation.status === 'rejected'
                                          ? <Icon name="x" cls="ic-sm" />
                                          : <Icon name="check" cls="ic-sm" />}
                                    </span>
                                    <div className="tl-title">用户确认</div>
                                    <div className="tl-lines">
                                      <AgentConfirmationCard confirmation={confirmation} compact />
                                    </div>
                                  </div>
                                )
                              }
                              if (block.type === 'notice') {
                                return (
                                  <div className={`tl-step ${block.level === 'stop' ? 'pending' : 'run'}`} key={j}>
                                    <span className="tl-dot"><Icon name="alert-circle" cls="ic-sm" /></span>
                                    <div className="tl-lines">
                                      <div className="tl-line" style={{ color: 'var(--warn, #b45309)' }}>{block.text}</div>
                                    </div>
                                  </div>
                                )
                              }
                              return null
                            })}
                          </div>
                        </div>
                      </div>
                    )}

                    {/* Answer: plain text response */}
                    {responseBlock && responseBlock.type === 'text' && (responseBlock.text || responseBlock.status === 'streaming') && (
                      <div className="answer md-body">
                        <ReactMarkdown remarkPlugins={[remarkGfm]}>{responseBlock.text}</ReactMarkdown>
                        {responseBlock.status === 'streaming' && <span className="cursor-blink" />}
                      </div>
                    )}

                    {/* Turn actions (visible on hover) */}
                    {isDone && responseBlock && responseBlock.type === 'text' && responseBlock.text && (
                      <div className="turn-actions">
                        <button className="icon-btn sm" title="复制回答" onClick={() => copyText(responseBlock.text, i)}>
                          <Icon name={copiedIdx === i ? 'check' : 'copy'} cls="ic-sm" />
                        </button>
                      </div>
                    )}
                  </div>
                </div>
              </div>
            )
          })}
        </div>
      )
    }

    // Prototype/fallback mode
    return (
      <div className="chat-inner" style={{ padding: pad }}>
        {msgs.map((m, i) => (
          <div className={`msg ${m.role}`} key={i}>
            <span className="who">{m.role === 'user' ? '我' : 'AI'}</span>
            <div className="bubble">
              <div className="body">
                <p dangerouslySetInnerHTML={{ __html: m.html }} />
                {m.att.length > 0 && <div className="att-tags">{m.att.map(a => <span className="att-chip" key={a} style={{ height: 24 }}><Icon name="paperclip" cls="ic-sm" />{a}</span>)}</div>}
              </div>
              <button className="copy-btn" title="复制" aria-label="复制消息" onClick={() => copyText(m.text, i)}>
                <Icon name={copiedIdx === i ? 'check' : 'copy'} cls="ic-sm" />
              </button>
            </div>
          </div>
        ))}
      </div>
    )
  }

  return (
    <>
      <Head><title>{`${sceneName} · 工作台 · GSMS`}</title></Head>
      <div className="app">
        <TopNav active="workbench" />

        <div className="scene-bar">
          <div className="breadcrumb">
            <Link href="/scenes"><Icon name="arrow-left" cls="ic-sm" />工作台</Link>
            <Icon name="chevron-right" cls="ic-sm" />
            <b>{sceneName}</b>
          </div>
          <span style={{ flex: 1 }} />
          {region && <span className="region"><Icon name="map" cls="ic-sm" />研究区：{region}</span>}
        </div>

        <div className="work">
          {/* LEFT */}
          <aside className="col c-left">
            <div className="tabs">
              <button className={leftTab === 'layers' ? 'on' : ''} onClick={() => setLeftTab('layers')}><Icon name="layers" cls="ic-sm" />图层</button>
              <button className={leftTab === 'files' ? 'on' : ''} onClick={() => setLeftTab('files')}><Icon name="file" cls="ic-sm" />文件</button>
              <button className={leftTab === 'invest' ? 'on' : ''} onClick={() => setLeftTab('invest')}><Icon name="box" cls="ic-sm" />InVEST</button>
            </div>

            {leftTab === 'layers' && (
              <div className="col-body">
                {layers.length === 0 ? (
                  <div className="state-empty"><Icon name="layers" /><b>地图上还没有图层</b>从「文件」标签把数据加入地图，或运行模型生成输出。</div>
                ) : layers.map(l => (
                  <div className="layer" key={l.id}>
                    <div className="layer-top">
                      <span className={`fchip ${l.type}`} style={{ width: 26, height: 26 }}><Icon name={l.type === 'raster' ? 'image' : 'map'} cls="ic-sm" /></span>
                      <span className="layer-name" title={l.name}>{l.name}</span>
                      <span className="badge badge-muted">{l.type === 'raster' ? '栅格' : '矢量'}</span>
                      <label className="switch" title="显隐"><input type="checkbox" checked={l.visible} onChange={e => setLayer(l.id, { visible: e.target.checked })} /><span className="track" /></label>
                    </div>
                    <div className="layer-ctl">
                      <input className="range" type="range" min={0} max={100} value={l.opacity} aria-label="透明度" onChange={e => setLayer(l.id, { opacity: +e.target.value })} />
                      <span className="pct">{l.opacity}%</span>
                      <span className="hideact">
                        <button className="icon-btn sm" title="缩放到图层" aria-label="缩放到图层" onClick={() => setFitNonce(n => n + 1)}><Icon name="maximize" cls="ic-sm" /></button>
                        <button className="icon-btn sm" title="移除" aria-label="移除" onClick={() => removeLayer(l.id)}><Icon name="trash" cls="ic-sm" /></button>
                      </span>
                    </div>
                  </div>
                ))}
              </div>
            )}

            {leftTab === 'files' && (
              <div className="col-body">
                <div className="pad" style={{ borderBottom: '1px solid var(--border)' }}>
                  <button className="btn btn-sm" onClick={openImportFiles}><Icon name="download" cls="ic-sm" />导入 Data Hub 文件</button>
                </div>
                {files.length === 0 ? (
                  <div className="state-empty"><Icon name="file" /><b>当前场景还没有文件</b>从 Data Hub 导入文件后，再配置模型输入。</div>
                ) : fileGroups.map(([folderName, group]) => (
                  <div className="file-folder" key={folderName}>
                    <div className="file-folder-head"><Icon name="folder" cls="ic-sm" /><span>{folderName}</span><span className="tree-count">{group.length}</span></div>
                    {group.map(f => (
                      <div className="row file-in-folder" key={f.id}>
                        <span className={`fchip ${f.type}`}><Icon name={TYPE_ICON[f.type] || 'file'} cls="ic-sm" /></span>
                        <div style={{ minWidth: 0 }}>
                          <div className="ftitle" style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{f.name}</div>
                          <div className="fsub">{TYPE_LABEL[f.type] || '其他'} · {fmtBytes(f.size)}</div>
                        </div>
                        <span className="actions">
                          <button className="icon-btn sm" title="加入地图" aria-label="加入地图" onClick={() => addToMap(f)}><Icon name="map" cls="ic-sm" /></button>
                          <button className="icon-btn sm" title="作为附件引用" aria-label="作为附件" onClick={() => { addAtt(f.name); toast('已作为附件引用') }}><Icon name="paperclip" cls="ic-sm" /></button>
                          {sceneId && <button className="icon-btn sm" title="从场景移除引用" aria-label="从场景移除引用" onClick={() => removeImportedFile(f.id)}><Icon name="trash" cls="ic-sm" /></button>}
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
                  <input value={modelSearch} onChange={e => setModelSearch(e.target.value)} placeholder="搜索模型" />
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
                        <span className={`badge ${ready ? 'badge-ok' : 'badge-muted'}`}>{ready ? '可运行' : '规划中'}</span>
                      </div>
                    )
                  })}
                </div>
                <div className="pad meta" style={{ borderTop: '1px solid var(--border)' }}>点击模型打开配置弹窗，设置输入与参数后手动运行。</div>
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
                <span className="meta">场景：<b style={{ color: 'var(--fg)', fontWeight: 600 }}>{sceneName}</b></span>
              </div>
            </div>

            <div style={{ flex: 1, minHeight: 0, display: 'flex' }}>
              {/* agent */}
              <div className="chat-wrap" style={{ flex: 1, minWidth: 0, display: view === 'agent' ? 'flex' : 'none' }}>
                <div className="chat-scroll" ref={chatScrollRef}><ChatList pad="0 24px" /></div>
                <div className="composer">
                  <div className="composer-inner">
                    {agentSession && <div className="meta agent-status">Agent session: {agentSession.status}</div>}
                    {agentError && <div className="meta agent-error">{agentError}</div>}
                    {atts.length > 0 && (
                      <div className="att-strip">
                        {atts.map(a => <span className="att-chip" key={a}><Icon name="paperclip" cls="ic-sm" />{a}<button aria-label="移除" onClick={() => setAtts(prev => prev.filter(x => x !== a))}><Icon name="x" cls="ic-sm" /></button></span>)}
                      </div>
                    )}
                    <div className="card-box">
                      <textarea rows={1} placeholder="描述你的地理分析任务，或询问当前项目数据与模型结果..." value={draft}
                        onChange={e => setDraft(e.target.value)}
                        onKeyDown={e => { if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); send() } }} />
                      <div className="composer-bar">
                        <div style={{ position: 'relative' }}>
                          <button className="icon-btn" title="添加附件" aria-label="添加附件" onClick={e => { e.stopPropagation(); setAttOpen(v => !v) }}><Icon name="paperclip" /></button>
                          {attOpen && (
                            <div className="pop open" onClick={e => e.stopPropagation()}>
                              <div className="head">添加附件</div>
                              <button onClick={() => addAtt('本地文件_' + Math.floor(Math.random() * 1000) + '.tif')}><Icon name="upload" cls="ic-sm" />从本地上传</button>
                              <div className="head">当前项目文件</div>
                              {files.slice(0, 4).map(f => <button key={f.id} onClick={() => addAtt(f.name)}><Icon name={TYPE_ICON[f.type] || 'file'} cls="ic-sm" />{f.name}</button>)}
                            </div>
                          )}
                        </div>
                        <span className="grow" />
                        <div className="mini-select" title="对话模型" onClick={() => toast('对话模型在「设置 · 模型配置」中管理')}>
                          <Icon name="sparkles" cls="ic-sm" />
                          <span>{defaultModel ? `${defaultModel.name}${defaultModel.def ? ' · 默认' : ''}` : '未配置模型'}</span>
                          <Icon name="chevron-down" cls="ic-sm" />
                        </div>
                        <button className="send-btn" title="发送" aria-label="发送" disabled={streaming || !draft.trim()} onClick={send}><Icon name="send" cls="ic-sm" /></button>
                      </div>
                    </div>
                    {!defaultModel && <div className="meta" style={{ marginTop: 7, color: 'var(--warn)' }}>未配置对话模型，请先到设置页配置后再发送。</div>}
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
            <div className="col-head"><h2>Agent Activity</h2></div>
            <div className="agent-activity">
              <div className="log-out">
                {agentEvents.length ? agentEvents.map(event => (
                  <div key={event.id} title={event.type}><span className={agentEventClass(event)}>{agentEventText(event)}</span></div>
                )) : <div><span className="l-dim">Waiting for Agent actions...</span></div>}
              </div>
            </div>
            <div className="col-head" style={{ borderTop: '1px solid var(--border)' }}><h2>运行信息</h2></div>
            <div className="task-card">
              <div className="glabel" style={{ marginBottom: 9 }}>任务状态</div>
              <div className="task-state">
                <span className={`ti ${tm.ic}`}>{task === 'run' ? <span className="spinner" /> : <Icon name={tm.icn} />}</span>
                <div style={{ flex: 1, minWidth: 0 }}>
                  <div style={{ fontSize: 13, fontWeight: 600, color: 'var(--fg-strong)' }}>{tm.title}</div>
                  <div className="meta" style={{ marginTop: 1 }}>{task === 'idle' ? '配置并运行一个 InVEST 模型后，状态会显示在这里' : '模型：' + curModel}</div>
                </div>
                {tm.badge}
              </div>
            </div>
            <div className="col-head" style={{ borderTop: '1px solid var(--border)' }}>
              <h2 style={{ fontSize: 12 }}>运行日志</h2>
              <div className="right"><button className="icon-btn sm" title="复制日志" aria-label="复制日志" onClick={() => { navigator.clipboard?.writeText(logLines.map(l => l.text).join('\n')).then(() => toast('日志已复制'), () => toast('复制失败', 'error')) }}><Icon name="copy" cls="ic-sm" /></button></div>
            </div>
            <div className="log">
              <div className="log-out" ref={logRef}>
                {logLines.map((l, i) => <div key={i}><span className={l.cls}>{l.text}</span></div>)}
              </div>
            </div>
          </aside>
        </div>
      </div>

      <Modal open={importOpen} title="导入 Data Hub 文件" sub="选择全局 Data Hub 文件引用到当前场景；不会复制或删除原始文件。" onClose={() => setImportOpen(false)}
        footer={<>
          <span className="grow" />
          <button className="btn" onClick={() => setImportOpen(false)}>取消</button>
          <button className="btn btn-primary" disabled={!Object.values(importSel).some(Boolean)} onClick={importSelectedFiles}>导入</button>
        </>}>
        <div style={{ maxHeight: 360, overflowY: 'auto', border: '1px solid var(--border)', borderRadius: 'var(--r)' }}>
          {hubFiles.length === 0 ? (
            <div className="state-empty" style={{ margin: 20 }}><Icon name="file" /><b>没有可导入文件</b>Data Hub 为空，或所有文件都已导入当前场景。</div>
          ) : hubFiles.map(f => (
            <label className="row" key={f.id} style={{ cursor: 'pointer' }}>
              <input type="checkbox" checked={Boolean(importSel[f.id])} onChange={e => setImportSel(prev => ({ ...prev, [f.id]: e.target.checked }))} />
              <span className={`fchip ${f.type}`}><Icon name={TYPE_ICON[f.type] || 'file'} cls="ic-sm" /></span>
              <div style={{ minWidth: 0 }}>
                <div className="ftitle" style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{f.name}</div>
                <div className="fsub">{TYPE_LABEL[f.type] || '其他'} · {fmtBytes(f.size)}</div>
              </div>
            </label>
          ))}
        </div>
      </Modal>

      {/* InVEST modal */}
      <Modal open={!!modalModel} title={`${modalModel?.name || ''} · 模型配置`} sub={modalModel?.description} onClose={() => setModalModel(null)}
        footer={<>
          <button className="btn btn-sm" onClick={() => modalModel && checkInputs(modalModel)}><Icon name="check-circle" cls="ic-sm" />检查输入</button>
          <span className="grow" />
          <button className="btn" onClick={() => setModalModel(null)}>取消</button>
          <button className="btn btn-primary" onClick={() => modalModel && runModel(modalModel)}><Icon name="play" cls="ic-sm" />运行模型</button>
        </>}>
        <div className="glabel" style={{ marginBottom: 9 }}>输入数据</div>
        <div>
          {(modalModel?.inputs || []).filter(inp => inp.kind === 'asset').map(inp => {
            const uiType = uiFromBackendAssetType(inp.asset_type)
            return (
              <div className="field" key={inp.id}>
                <label>{inp.label} <span style={{ color: 'var(--faint)', fontWeight: 400 }}>· {TYPE_LABEL[uiType]}</span></label>
                <Select
                  value={inputSel[inp.id] || ''}
                  placeholder="从项目资产中选择…"
                  options={[{ value: '', label: '从项目资产中选择…' }, ...assetOptionsFor(uiType).map(a => ({ value: a.id, label: a.name }))]}
                  onChange={value => setInputSel(prev => ({ ...prev, [inp.id]: value }))}
                />
              </div>
            )
          })}
        </div>
        <div className="sec-divider" style={{ margin: '16px 0 14px' }} />
        <div className="glabel" style={{ marginBottom: 9 }}>参数设置</div>
        <div className="field"><label>运行名称</label><input className="input" value={runName} onChange={e => setRunName(e.target.value)} /></div>
        <div className="field" style={{ marginBottom: 6 }}><label>输出目录</label><input className="input" defaultValue="outputs/carbon_storage/" /></div>
        <details className="collapse">
          <summary><span className="chev" style={{ display: 'inline-flex' }}><Icon name="chevron-right" cls="ic-sm" /></span>高级选项</summary>
          <div className="field" style={{ marginTop: 10 }}>
            <label>运行模式</label>
            <Select
              value={uiRunMode}
              options={[{ value: 'standard', label: '标准（完整计算）' }, { value: 'preview', label: '快速预览（降采样）' }]}
              onChange={setUiRunMode}
            />
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
        .c-left .tabs { padding: 0; }
        .c-left .tabs button { flex: 1; justify-content: center; }
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
        .chat-inner { width: 100%; max-width: none; margin: 0; padding: 0 24px; display: flex; flex-direction: column; gap: 26px; }
        .msg { display: flex; align-items: flex-start; gap: 11px; }
        .msg.agent { justify-content: flex-start; }
        .msg.user { flex-direction: row-reverse; justify-content: flex-start; align-items: flex-end; }
        .msg .who { width: 28px; height: 28px; border-radius: 50%; flex: none; display: grid; place-items: center; font-size: 10.5px; font-weight: 700; margin-top: 2px; }
        .msg.user .who { background: var(--accent-soft); color: var(--accent-ink); border: 1px solid var(--accent-line); }
        .msg.agent .who { background: var(--accent); color: #fff; }
        .msg .bubble { min-width: 0; max-width: calc(100% - 40px); }
        /* The agent bubble must FILL the row. Without flex:1 it defaults to
         * flex-grow:0 + content-based basis, so with min-width:0 the flex
         * algorithm shrinks it to the think card's min-content width — which,
         * once .tl-line allows word-break, collapses to ~2 chars per line. */
        .msg.agent .bubble { flex: 1 1 auto; }
        .msg.user .bubble { max-width: 72%; }
        .msg .body { font-size: 13.5px; line-height: 1.62; padding: 9px 13px; border-radius: 14px; }
        .msg.agent .body { background: var(--surface); border: 1px solid var(--border); color: var(--fg); border-bottom-left-radius: 4px; }
        .msg.user .body { background: var(--accent); color: #fff; border-bottom-right-radius: 4px; }
        .msg .body p { margin: 0; }
        .msg .body p + .att-tags { margin-top: 8px; }
        .msg.agent .body code { font-family: var(--mono); font-size: 12px; background: var(--inset); padding: 1px 5px; border-radius: 4px; }
        .msg.user .body code { font-family: var(--mono); font-size: 12px; background: rgba(255,255,255,.18); padding: 1px 5px; border-radius: 4px; }
        .msg .att-tags { display: flex; flex-wrap: wrap; gap: 6px; }
        .msg .bubble { position: relative; }
        .msg .copy-btn { display: flex; align-items: center; justify-content: center; position: absolute; bottom: -28px; width: 26px; height: 26px; border: 0; border-radius: 4px; background: transparent; color: var(--faint); cursor: pointer; opacity: 0; transition: opacity .15s, color .1s, background .1s; padding: 0; }
        .msg.user .copy-btn { right: 0; }
        .msg.agent .copy-btn { left: 0; }
        .msg:hover .copy-btn, .msg .copy-btn:focus { opacity: 1; }
        .msg .copy-btn:hover { color: var(--fg-strong); background: var(--inset); }
        .msg.user .att-chip { background: rgba(255,255,255,.16); border-color: rgba(255,255,255,.28); color: #fff; }
        .cursor-blink { display: inline-block; width: 7px; height: 15px; background: var(--accent); vertical-align: -2px; animation: blink 1s step-end infinite; border-radius: 1px; }
        @keyframes blink { 50% { opacity: 0; } }
        /* turn wrapper */
        .turn { min-width: 0; width: 100%; display: flex; flex-direction: column; gap: 12px; }
        /* think block */
        .think { border: 1px solid var(--border); border-radius: var(--r); background: var(--surface); overflow: hidden; }
        .think.running { border-color: var(--accent-line); box-shadow: 0 0 0 3px var(--accent-soft); }
        .think-head { display: flex; align-items: center; gap: 9px; width: 100%; border: 0; background: transparent; cursor: pointer; padding: 10px 12px; text-align: left; color: var(--fg); transition: background .1s; }
        .think-head:hover { background: var(--surface-2); }
        .think-head .chev { color: var(--faint); transition: transform .18s; }
        .think.open .think-head .chev { transform: rotate(90deg); }
        .think-head .tlabel { font-size: 12.5px; font-weight: 600; color: var(--fg-strong); display: inline-flex; align-items: center; gap: 7px; }
        .think-head .tlabel .ic { color: var(--accent); }
        .think-head .tsum { font-size: 12px; color: var(--faint); margin-left: auto; font-variant-numeric: tabular-nums; display: inline-flex; align-items: center; gap: 7px; }
        .think-body { display: none; border-top: 1px solid var(--border); padding: 6px 14px 14px; }
        .think.open .think-body { display: block; }
        /* timeline */
        .timeline { position: relative; margin-top: 8px; }
        .tl-step { position: relative; padding: 0 0 16px 26px; }
        .tl-step:last-child { padding-bottom: 2px; }
        .tl-step::before { content: ""; position: absolute; left: 7px; top: 18px; bottom: 0; width: 1.5px; background: var(--border); }
        .tl-step:last-child::before { display: none; }
        .tl-dot { position: absolute; left: 0; top: 2px; width: 15px; height: 15px; border-radius: 50%; display: grid; place-items: center; background: var(--surface); border: 2px solid var(--border-strong); }
        .tl-step.done .tl-dot { border-color: var(--ok); background: var(--ok); color: #fff; }
        .tl-step.done .tl-dot .ic { width: 9px; height: 9px; stroke-width: 3; }
        .tl-step.run .tl-dot { border-color: var(--accent); padding: 0; }
        .tl-step.pending .tl-dot { border-style: dashed; }
        .tl-title { font-size: 12.5px; font-weight: 600; color: var(--fg-strong); display: flex; align-items: center; gap: 8px; min-height: 16px; }
        .tl-step.pending .tl-title { color: var(--faint); font-weight: 500; }
        .tl-lines { margin-top: 6px; display: flex; flex-direction: column; gap: 3px; width: 100%; min-width: 0; }
        .tl-line { font-size: 12.5px; line-height: 1.6; color: var(--muted); overflow-wrap: anywhere; }
        .tl-line code { font-family: var(--mono); font-size: 11.5px; background: var(--inset); padding: 1px 5px; border-radius: 4px; color: var(--accent-ink); }
        /* tool-chip inside a step */
        .tool-chip { display: inline-flex; align-items: center; gap: 7px; margin-top: 7px; padding: 5px 9px 5px 7px; border: 1px solid var(--border); border-radius: var(--r-sm); background: var(--surface-2); font-size: 11.5px; color: var(--fg); font-family: var(--mono); }
        .tool-chip .tk { display: inline-flex; align-items: center; gap: 5px; color: var(--accent-ink); font-weight: 600; }
        .tool-chip .tk .ic { width: 13px; height: 13px; }
        .tool-chip .arg { color: var(--muted); }
        .tool-chip .ok { color: var(--ok); margin-left: 2px; display: inline-flex; align-items: center; gap: 3px; }
        .tool-chip .ok .ic { width: 12px; height: 12px; }
        /* answer */
        .answer { font-size: 13.8px; line-height: 1.68; color: var(--fg); }
        .answer p { margin: 0 0 11px; } .answer p:last-child { margin-bottom: 0; }
        .answer strong { color: var(--fg-strong); font-weight: 650; }
        .answer code { font-family: var(--mono); font-size: 12px; background: var(--inset); padding: 1px 5px; border-radius: 4px; color: var(--accent-ink); }
        .answer ul { margin: 0 0 11px; padding-left: 18px; } .answer li { margin: 3px 0; }
        /* markdown body (ReactMarkdown) */
        .md-body p { margin: 0 0 10px; line-height: 1.62; } .md-body p:last-child { margin-bottom: 0; }
        .md-body strong { color: var(--fg-strong); font-weight: 650; }
        .md-body em { font-style: italic; }
        .md-body h1 { font-size: 17px; font-weight: 700; margin: 18px 0 8px; color: var(--fg-strong); }
        .md-body h2 { font-size: 15px; font-weight: 700; margin: 16px 0 7px; color: var(--fg-strong); }
        .md-body h3 { font-size: 13.8px; font-weight: 650; margin: 14px 0 6px; color: var(--fg-strong); }
        .md-body h4, .md-body h5, .md-body h6 { font-size: 13px; font-weight: 600; margin: 12px 0 5px; color: var(--fg-strong); }
        .md-body code { font-family: var(--mono); font-size: 12px; background: var(--inset); padding: 1px 5px; border-radius: 4px; color: var(--accent-ink); }
        .md-body pre { margin: 0 0 11px; padding: 11px 13px; border-radius: var(--r); background: var(--inset); border: 1px solid var(--border); overflow-x: auto; }
        .md-body pre code { background: transparent; padding: 0; border-radius: 0; color: var(--fg); font-size: 12.5px; line-height: 1.55; }
        .md-body ul, .md-body ol { margin: 0 0 11px; padding-left: 22px; }
        .md-body li { margin: 3px 0; line-height: 1.6; }
        .md-body li > ul, .md-body li > ol { margin: 3px 0 0; }
        .md-body blockquote { margin: 0 0 11px; padding: 6px 12px; border-left: 3px solid var(--accent-line); background: var(--surface); color: var(--muted); border-radius: 0 var(--r-sm) var(--r-sm) 0; }
        .md-body table { margin: 0 0 11px; border-collapse: collapse; width: 100%; font-size: 12.5px; }
        .md-body th, .md-body td { padding: 6px 10px; border: 1px solid var(--border); text-align: left; }
        .md-body th { background: var(--surface-2); font-weight: 600; color: var(--fg-strong); }
        .md-body a { color: var(--accent); text-decoration: underline; text-underline-offset: 2px; }
        .md-body a:hover { color: var(--accent-ink); }
        .md-body hr { border: 0; border-top: 1px solid var(--border); margin: 14px 0; }
        .md-body img { max-width: 100%; border-radius: var(--r-sm); }
        .msg.user .md-body code { background: rgba(255,255,255,.18); color: #fff; }
        /* turn actions */
        .turn-actions { display: flex; align-items: center; gap: 4px; opacity: 0; transition: opacity .12s; }
        .turn:hover .turn-actions, .turn:focus-within .turn-actions { opacity: 1; }
        .turn-actions .icon-btn { color: var(--faint); } .turn-actions .icon-btn:hover { color: var(--accent-ink); }
        .composer { flex: none; padding: 0 24px 18px; }
        .composer-inner { max-width: 760px; margin: 0 auto; }
        .agent-status { margin-bottom: 7px; text-align: right; }
        .agent-confirm { display: flex; align-items: center; gap: 8px; margin-bottom: 9px; padding: 10px 11px; border: 1px solid var(--warn); border-radius: var(--r); background: var(--warn-soft); color: var(--fg); }
        .agent-confirm > div:first-child { flex: 1; min-width: 0; font-size: 12.5px; }
        .agent-confirm p { margin: 3px 0 0; color: var(--muted); }
        .agent-error { margin-bottom: 8px; color: var(--danger); }
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
        .agent-activity { height: 38%; min-height: 150px; display: flex; flex-direction: column; }
        .agent-activity .log-out { flex: 1; overflow-y: auto; }
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
        .agent-confirm.import-proposal { align-items: stretch; gap: 10px; }
        .agent-confirm.import-proposal div { font-size: 12.5px; }
        .confirm-main { flex: 1; min-width: 0; }
        .confirm-actions { display: flex; align-items: center; gap: 8px; flex-wrap: wrap; justify-content: flex-end; }
        .proposal-list { display: grid; gap: 7px; margin-top: 8px; max-height: 178px; overflow: auto; }
        .proposal-row { display: grid; grid-template-columns: auto auto minmax(0, 1fr); gap: 8px; align-items: flex-start; padding: 8px; border: 1px solid var(--border); border-radius: 8px; background: var(--surface); cursor: pointer; }
        .slot-pill { max-width: 132px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; border: 1px solid var(--border); border-radius: 999px; padding: 2px 7px; font-size: 11px; color: var(--muted); background: var(--inset); }
        .proposal-copy { min-width: 0; }
        .proposal-copy .reason { margin-top: 3px; font-size: 12px; line-height: 1.35; color: var(--fg); }
        .proposal-copy .risk { margin-top: 3px; font-size: 12px; line-height: 1.35; color: var(--warn); }
      `}</style>
    </>
  )
}
