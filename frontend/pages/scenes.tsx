import React from 'react'
import Head from 'next/head'
import { useRouter } from 'next/router'
import TopNav from '../src/components/shell/TopNav'
import Icon from '../src/components/shell/Icon'
import Modal from '../src/components/shell/Modal'
import { toast } from '../src/lib/toast'
import { scenesRepo, type Scene } from '../src/lib/repos/scenesRepo'

const PAGE_SIZE = 8

function pageNumbers(page: number, pages: number): (number | '…')[] {
  const nums: (number | '…')[] = []
  for (let i = 1; i <= pages; i++) {
    if (i === 1 || i === pages || Math.abs(i - page) <= 1) nums.push(i)
    else if (nums[nums.length - 1] !== '…') nums.push('…')
  }
  return nums
}

export default function ScenesPage() {
  const router = useRouter()
  const [scenes, setScenes] = React.useState<Scene[]>([])
  const [loading, setLoading] = React.useState(true)
  const [query, setQuery] = React.useState('')
  const [page, setPage] = React.useState(1)
  const scrollRef = React.useRef<HTMLDivElement | null>(null)

  // create/edit modal
  const [modalOpen, setModalOpen] = React.useState(false)
  const [editingId, setEditingId] = React.useState<string | null>(null)
  const [form, setForm] = React.useState({ name: '', desc: '', region: '', note: '' })
  const [formErr, setFormErr] = React.useState('')
  // delete modal
  const [delId, setDelId] = React.useState<string | null>(null)

  const reload = React.useCallback(() => setScenes(scenesRepo.list()), [])
  React.useEffect(() => {
    const t = setTimeout(() => { reload(); setLoading(false) }, 260)
    return () => clearTimeout(t)
  }, [reload])

  const filtered = scenes.filter(s => !query || s.name.includes(query) || s.desc.includes(query))
  const pages = Math.max(1, Math.ceil(filtered.length / PAGE_SIZE))
  const curPage = Math.min(page, pages)
  const slice = filtered.slice((curPage - 1) * PAGE_SIZE, curPage * PAGE_SIZE)

  function enterScene(id: string) {
    router.push(`/workbench/${encodeURIComponent(id)}`)
  }
  function openCreate() {
    setEditingId(null); setForm({ name: '', desc: '', region: '', note: '' }); setFormErr(''); setModalOpen(true)
  }
  function openEdit(s: Scene) {
    setEditingId(s.id); setForm({ name: s.name, desc: s.desc, region: s.region, note: s.note }); setFormErr(''); setModalOpen(true)
  }
  function save() {
    const name = form.name.trim()
    if (!name) { setFormErr('请填写场景名称。'); return }
    if (scenesRepo.nameExists(name, editingId ?? undefined)) { setFormErr('已存在同名场景，请换一个名称。'); return }
    if (editingId) { scenesRepo.update(editingId, { name, desc: form.desc.trim(), region: form.region.trim(), note: form.note.trim() }); toast('场景信息已更新') }
    else { scenesRepo.create({ name, desc: form.desc.trim(), region: form.region.trim(), note: form.note.trim() }); toast('已创建场景') }
    setModalOpen(false); reload()
  }
  function confirmDelete() {
    if (delId) { scenesRepo.remove(delId); toast('已删除场景'); reload() }
    setDelId(null)
  }

  const delScene = delId ? scenes.find(s => s.id === delId) : null

  return (
    <>
      <Head><title>场景 · GSMS</title></Head>
      <div className="app">
        <TopNav active="workbench" />
        <div style={{ flex: 1, minHeight: 0, display: 'flex', flexDirection: 'column' }}>
          <div className="page-head">
            <div className="crumb"><h1>场景</h1></div>
            <span style={{ flex: 1 }} />
            <div className="search">
              <Icon name="search" cls="ic-sm" />
              <input placeholder="搜索场景名称或描述…" value={query} onChange={e => { setQuery(e.target.value); setPage(1) }} />
            </div>
            <button className="btn btn-primary" onClick={openCreate}><Icon name="plus" cls="ic-sm" />新建场景</button>
          </div>

          <div className="scroll" ref={scrollRef}>
            <div className="scene-list">
              {loading ? (
                <div className="loading-row"><span className="spin" />正在加载场景…</div>
              ) : slice.length === 0 ? (
                <div className="state-empty">
                  <Icon name={scenes.length ? 'search' : 'compass'} />
                  <b>{scenes.length ? '无匹配场景' : '还没有场景'}</b>
                  {scenes.length ? '换个关键词，或新建一个场景。' : '点“新建场景”开始你的第一次地理分析。'}
                </div>
              ) : (
                slice.map(s => (
                  <div className="scene-card" key={s.id} tabIndex={0}
                    onClick={() => enterScene(s.id)}
                    onKeyDown={e => { if (e.key === 'Enter') enterScene(s.id) }}>
                    <span className="scene-ico"><Icon name="compass" /></span>
                    <div className="scene-main">
                      <h3>{s.name}</h3>
                      <p>{s.desc || '（暂无描述）'}</p>
                      <div className="scene-meta">
                        <span className="m"><Icon name="map" cls="ic-sm" />研究区：<b>{s.region || '—'}</b></span>
                        <span className="m"><Icon name="refresh-cw" cls="ic-sm" />更新于 {s.updated}</span>
                        {s.note && <span className="m"><Icon name="info" cls="ic-sm" />{s.note}</span>}
                      </div>
                    </div>
                    <span className="acts">
                      <button className="btn btn-sm" title="进入场景" onClick={e => { e.stopPropagation(); enterScene(s.id) }}><Icon name="corner-down-right" cls="ic-sm" />进入</button>
                      <button className="icon-btn sm" title="编辑场景" aria-label="编辑" onClick={e => { e.stopPropagation(); openEdit(s) }}><Icon name="settings" cls="ic-sm" /></button>
                      <button className="icon-btn sm" title="删除场景" aria-label="删除" onClick={e => { e.stopPropagation(); setDelId(s.id) }}><Icon name="trash" cls="ic-sm" /></button>
                    </span>
                  </div>
                ))
              )}
            </div>
          </div>

          {pages > 1 && (
            <div className="pager">
              <div className="pager-info">共 <b>{filtered.length}</b> 个场景 · 第 <b>{curPage}</b>/<b>{pages}</b> 页</div>
              <div className="pager-ctrl">
                <button className="pg-btn" disabled={curPage === 1} aria-label="上一页" onClick={() => { setPage(curPage - 1); scrollRef.current && (scrollRef.current.scrollTop = 0) }}>
                  <span style={{ display: 'inline-flex', transform: 'rotate(180deg)' }}><Icon name="chevron-right" cls="ic-sm" /></span>
                </button>
                {pageNumbers(curPage, pages).map((n, i) => n === '…'
                  ? <span className="pg-ellipsis" key={'e' + i}>…</span>
                  : <button key={n} className={`pg-num ${n === curPage ? 'active' : ''}`} onClick={() => setPage(n)}>{n}</button>)}
                <button className="pg-btn" disabled={curPage === pages} aria-label="下一页" onClick={() => { setPage(curPage + 1); scrollRef.current && (scrollRef.current.scrollTop = 0) }}>
                  <Icon name="chevron-right" cls="ic-sm" />
                </button>
              </div>
            </div>
          )}
        </div>
      </div>

      <Modal open={modalOpen} title={editingId ? '编辑场景' : '新建场景'}
        sub={editingId ? '只修改场景基本信息，不影响已生成的数据、日志或模型结果。' : '场景用于组织一次具体的地理分析：研究区、数据、图层、对话与运行上下文。'}
        onClose={() => setModalOpen(false)}
        footer={<><span className="grow" /><button className="btn" onClick={() => setModalOpen(false)}>取消</button><button className="btn btn-primary" onClick={save}>保存</button></>}>
        <div className="form-grid">
          <div className="field full"><label>场景名称</label><input className="input" autoComplete="off" placeholder="如：南京市碳储量评估" value={form.name} onChange={e => setForm({ ...form, name: e.target.value })} onKeyDown={e => { if (e.key === 'Enter') save() }} /></div>
          <div className="field full"><label>场景描述</label><textarea className="input" rows={2} placeholder="一句话说明这次分析的目标与方法。" value={form.desc} onChange={e => setForm({ ...form, desc: e.target.value })} /></div>
          <div className="field"><label>研究区名称</label><input className="input" autoComplete="off" placeholder="如：南京市" value={form.region} onChange={e => setForm({ ...form, region: e.target.value })} /></div>
          <div className="field"><label>备注</label><input className="input" autoComplete="off" placeholder="可选" value={form.note} onChange={e => setForm({ ...form, note: e.target.value })} /></div>
        </div>
        {formErr && <div style={{ marginTop: 4 }}><div className="notice notice-error"><Icon name="alert-circle" cls="ic-sm" /><div>{formErr}</div></div></div>}
      </Modal>

      <Modal open={!!delId} title="删除场景" width={400} onClose={() => setDelId(null)}
        footer={<><span className="grow" /><button className="btn" onClick={() => setDelId(null)}>取消</button><button className="btn btn-primary" style={{ background: 'var(--danger)', borderColor: 'var(--danger)' }} onClick={confirmDelete}>删除</button></>}>
        <p className="confirm-text">确定删除场景 <b>{delScene?.name}</b> 吗？</p>
        <p className="confirm-note">删除后该场景的工作台上下文（图层、对话、运行日志）将不再显示。是否连带删除已生成的输出文件，留作后续策略。</p>
      </Modal>

      <style jsx global>{`
        .app { overflow-x: auto; }
        .page-head { height: 56px; flex: none; display: flex; align-items: center; gap: 12px; padding: 0 18px; background: var(--surface); border-bottom: 1px solid var(--border); }
        .page-head .crumb { display: flex; align-items: baseline; gap: 8px; }
        .page-head h1 { margin: 0; font-size: 15px; font-weight: 650; color: var(--fg-strong); }
        .search { display: flex; align-items: center; gap: 7px; height: 32px; padding: 0 10px; border: 1px solid var(--border-strong); border-radius: var(--r-sm); background: var(--surface); width: 240px; color: var(--faint); }
        .search input { border: 0; outline: none; font-family: inherit; font-size: 13px; width: 100%; background: transparent; color: var(--fg); }
        .scroll { flex: 1; overflow-y: auto; }
        .scene-list { padding: 18px; display: grid; grid-template-columns: repeat(auto-fill, minmax(360px, 1fr)); gap: 14px; align-content: start; }
        .scene-card { display: flex; gap: 14px; align-items: flex-start; padding: 16px; border: 1px solid var(--border); border-radius: var(--r-lg); background: var(--surface); cursor: pointer; transition: background .1s, border-color .12s, box-shadow .14s, transform .14s; }
        .scene-card:hover { border-color: var(--accent-line); box-shadow: var(--shadow-float); transform: translateY(-1px); }
        .scene-ico { width: 40px; height: 40px; border-radius: 10px; flex: none; display: grid; place-items: center; background: var(--accent-soft); color: var(--accent-ink); }
        .scene-main { min-width: 0; flex: 1; }
        .scene-main h3 { margin: 0 0 4px; font-size: 14.5px; font-weight: 650; color: var(--fg-strong); }
        .scene-main p { margin: 0 0 8px; font-size: 12.5px; line-height: 1.55; color: var(--muted); }
        .scene-meta { display: flex; align-items: center; gap: 14px; flex-wrap: wrap; }
        .scene-meta .m { display: inline-flex; align-items: center; gap: 5px; font-size: 11.5px; color: var(--faint); }
        .scene-meta .m .ic { width: 13px; height: 13px; }
        .scene-meta .m b { color: var(--muted); font-weight: 600; }
        .scene-card .acts { align-self: center; display: flex; align-items: center; gap: 4px; opacity: 0; transition: opacity .12s; flex: none; }
        .scene-card:hover .acts, .scene-card:focus-within .acts { opacity: 1; }
        .form-grid { display: grid; grid-template-columns: 1fr 1fr; gap: 0 16px; }
        .form-grid .full { grid-column: 1 / -1; }
        .confirm-text { font-size: 13.5px; line-height: 1.65; color: var(--fg); margin: 0; }
        .confirm-text b { color: var(--fg-strong); }
        .confirm-note { font-size: 12px; color: var(--faint); margin: 10px 0 0; line-height: 1.6; }
        .loading-row { display: flex; align-items: center; gap: 10px; padding: 18px 14px; color: var(--muted); font-size: 12.5px; }
        .spin { width: 16px; height: 16px; border: 2px solid var(--border-strong); border-top-color: var(--accent); border-radius: 50%; animation: spin .7s linear infinite; }
      `}</style>
    </>
  )
}
