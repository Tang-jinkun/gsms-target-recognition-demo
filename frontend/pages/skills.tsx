import React from 'react'
import Head from 'next/head'
import TopNav from '../src/components/shell/TopNav'
import Icon from '../src/components/shell/Icon'
import Modal from '../src/components/shell/Modal'
import { toast } from '../src/lib/toast'
import { skillsRepo, flattenTree, type Skill, type SkillContent, type SkillFileNode } from '../src/lib/repos/skillsRepo'

const PAGE_SIZE = 6

function pageNumbers(page: number, pages: number): (number | '…')[] {
  const nums: (number | '…')[] = []
  for (let i = 1; i <= pages; i++) {
    if (i === 1 || i === pages || Math.abs(i - page) <= 1) nums.push(i)
    else if (nums[nums.length - 1] !== '…') nums.push('…')
  }
  return nums
}
function fileIcon(kind?: string) {
  return kind === 'md' ? 'file-text' : kind === 'code' ? 'code' : kind === 'json' ? 'hash' : kind === 'bin' ? 'image' : 'file'
}

export default function SkillsPage() {
  const [skills, setSkills] = React.useState<Skill[]>([])
  const [query, setQuery] = React.useState('')
  const [page, setPage] = React.useState(1)
  const [curSkill, setCurSkill] = React.useState<string | null>(null)
  const [skill, setSkill] = React.useState<Skill | null>(null)
  const [treeNodes, setTreeNodes] = React.useState<SkillFileNode[]>([])
  const [curFile, setCurFile] = React.useState<string | null>(null)
  const [content, setContent] = React.useState<SkillContent | undefined>(undefined)

  const [modalOpen, setModalOpen] = React.useState(false)
  const [editingId, setEditingId] = React.useState<string | null>(null)
  const [form, setForm] = React.useState({ name: '', desc: '' })
  const [formErr, setFormErr] = React.useState('')
  const [delId, setDelId] = React.useState<string | null>(null)

  const reload = React.useCallback(async () => {
    try {
      setSkills(await skillsRepo.list())
    } catch {
      toast('Skills 加载失败，请检查后端服务')
    }
  }, [])
  React.useEffect(() => { reload() }, [reload])

  const filtered = skills.filter(s => !query || s.name.includes(query) || s.desc.includes(query))
  const pages = Math.max(1, Math.ceil(filtered.length / PAGE_SIZE))
  const curPage = Math.min(page, pages)
  const slice = filtered.slice((curPage - 1) * PAGE_SIZE, curPage * PAGE_SIZE)

  async function openSkill(id: string) {
    setCurSkill(id)
    const [nextSkill, nextTree] = await Promise.all([skillsRepo.get(id), skillsRepo.treeFor(id)])
    setSkill(nextSkill || null)
    setTreeNodes(nextTree)
    const flat = flattenTree(nextTree)
    const pick = flat.find(f => f.name === 'SKILL.md') || flat.find(f => f.name === 'README.md')
    setCurFile(pick ? pick.name : null)
  }
  async function saveSkill() {
    const name = form.name.trim()
    if (!name) { setFormErr('请填写名称。'); return }
    try {
      if (await skillsRepo.nameExists(name, editingId ?? undefined)) { setFormErr('已存在同名 Skill，请换一个名称。'); return }
      if (editingId) { await skillsRepo.update(editingId, { name, desc: form.desc.trim() }); toast('源信息已更新') }
      else { await skillsRepo.create({ name, desc: form.desc.trim() }); toast('已创建 Skill') }
      setModalOpen(false); await reload()
    } catch {
      setFormErr('保存失败，请检查后端服务。')
    }
  }
  async function confirmDelete() {
    if (delId) {
      try {
        await skillsRepo.remove(delId); toast('已删除 Skill')
        if (curSkill === delId) { setCurSkill(null); setSkill(null); setTreeNodes([]); setCurFile(null); setContent(undefined) }
        await reload()
      } catch {
        toast('删除失败，请检查后端服务')
      }
    }
    setDelId(null)
  }

  const delSkill = delId ? skills.find(s => s.id === delId) : null
  const fileMeta = curSkill && curFile ? flattenTree(treeNodes).find(f => f.name === curFile) : null

  React.useEffect(() => {
    if (!curSkill || !curFile) { setContent(undefined); return }
    let cancelled = false
    skillsRepo.contentFor(curSkill, curFile).then(next => { if (!cancelled) setContent(next) })
    return () => { cancelled = true }
  }, [curSkill, curFile])

  return (
    <>
      <Head><title>Skills · GSMS</title></Head>
      <div className="app">
        <TopNav active="skills" />

        {!curSkill ? (
          <div style={{ flex: 1, minHeight: 0, display: 'flex', flexDirection: 'column' }}>
            <div className="page-head">
              <h1>Skills</h1>
              <span style={{ flex: 1 }} />
              <div className="search"><Icon name="search" cls="ic-sm" /><input placeholder="搜索名称或描述…" value={query} onChange={e => { setQuery(e.target.value); setPage(1) }} /></div>
              <button className="btn" onClick={() => toast('导入功能开发中')}><Icon name="download" cls="ic-sm" />导入</button>
              <button className="btn btn-primary" onClick={() => { setEditingId(null); setForm({ name: '', desc: '' }); setFormErr(''); setModalOpen(true) }}><Icon name="plus" cls="ic-sm" />新建 Skill</button>
            </div>
            <div className="scroll" style={{ flex: 1, overflowY: 'auto' }}>
              <div className="skill-grid">
                {slice.length === 0 ? (
                  <div className="state-empty"><Icon name="search" /><b>无匹配 Skill</b>换个关键词，或导入新的 Skill。</div>
                ) : slice.map(s => (
                  <div className="skill-card" key={s.id} onClick={() => openSkill(s.id)}>
                    <span className="skill-ico"><Icon name="box" /></span>
                    <div style={{ minWidth: 0, flex: 1 }}>
                      <h3>{s.name}</h3>
                      <p>{s.desc}</p>
                      <span className="meta">更新于 {s.updated}</span>
                    </div>
                    <span className="acts">
                      <button className="icon-btn sm" title="编辑源信息" aria-label="编辑" onClick={e => { e.stopPropagation(); setEditingId(s.id); setForm({ name: s.name, desc: s.desc }); setFormErr(''); setModalOpen(true) }}><Icon name="settings" cls="ic-sm" /></button>
                      <button className="icon-btn sm" title="删除" aria-label="删除" onClick={e => { e.stopPropagation(); setDelId(s.id) }}><Icon name="trash" cls="ic-sm" /></button>
                    </span>
                  </div>
                ))}
              </div>
            </div>
            {pages > 1 && (
              <div className="pager">
                <div className="pager-info">共 <b>{filtered.length}</b> 个 Skill · 第 <b>{curPage}</b>/<b>{pages}</b> 页</div>
                <div className="pager-ctrl">
                  <button className="pg-btn" disabled={curPage === 1} aria-label="上一页" onClick={() => setPage(curPage - 1)}><span style={{ display: 'inline-flex', transform: 'rotate(180deg)' }}><Icon name="chevron-right" cls="ic-sm" /></span></button>
                  {pageNumbers(curPage, pages).map((n, i) => n === '…' ? <span className="pg-ellipsis" key={'e' + i}>…</span> : <button key={n} className={`pg-num ${n === curPage ? 'active' : ''}`} onClick={() => setPage(n)}>{n}</button>)}
                  <button className="pg-btn" disabled={curPage === pages} aria-label="下一页" onClick={() => setPage(curPage + 1)}><Icon name="chevron-right" cls="ic-sm" /></button>
                </div>
              </div>
            )}
          </div>
        ) : (
          <div style={{ flex: 1, minHeight: 0, display: 'flex', flexDirection: 'column' }}>
            <div className="page-head">
              <div className="breadcrumb"><a onClick={() => { setCurSkill(null); setCurFile(null) }}>Skills</a><Icon name="chevron-right" cls="ic-sm" /><b>{skill?.name}</b></div>
            </div>
            <div className="work" style={{ flex: 1, minHeight: 0 }}>
              <aside className="col c-files">
                <div className="col-head"><h2>文件结构</h2></div>
                <div className="col-body">
                  {treeNodes.map((n, i) => n.type === 'dir' ? (
                    <React.Fragment key={i}>
                      <div className="fnode dir"><span className="chev"><Icon name="chevron-down" cls="ic-sm" /></span><Icon name="folder-open" cls="ic-sm" /><span>{n.name}</span></div>
                      {(n.children || []).map(c => (
                        <div key={c.name} className={`fnode indent ${curFile === c.name ? 'sel' : ''}`} onClick={() => setCurFile(c.name)}><Icon name={fileIcon(c.kind)} cls="ic-sm" /><span>{c.name}</span></div>
                      ))}
                    </React.Fragment>
                  ) : (
                    <div key={n.name} className={`fnode ${curFile === n.name ? 'sel' : ''}`} onClick={() => setCurFile(n.name)}><Icon name={fileIcon(n.kind)} cls="ic-sm" /><span>{n.name}</span></div>
                  ))}
                </div>
              </aside>
              <section className="col c-fdetail">
                <div className="col-head"><h2>{curFile || '文件详情'}</h2><span className="right meta">{fileMeta ? `${fileMeta.size} · ${fileMeta.modified}` : ''}</span></div>
                <div className="col-body">
                  {!curFile ? (
                    <div className="state-empty" style={{ marginTop: 60 }}><Icon name="file-text" /><b>请选择一个文件查看详情</b>从左侧文件结构中选择文件。</div>
                  ) : !content ? (
                    <div className="doc"><p className="meta">（无内容）</p></div>
                  ) : content.kind === 'md' ? (
                    <div className="doc" dangerouslySetInnerHTML={{ __html: content.html }} />
                  ) : content.kind === 'bin' ? (
                    <div className="state-empty" style={{ marginTop: 60 }}><Icon name="image" /><b>{curFile}</b>二进制文件（{content.size}）· 该文件暂不支持内容预览</div>
                  ) : (
                    <div style={{ padding: 16 }}><pre className="codeblock" dangerouslySetInnerHTML={{ __html: content.code }} /></div>
                  )}
                </div>
              </section>
            </div>
          </div>
        )}
      </div>

      <Modal open={modalOpen} title={editingId ? '编辑源信息' : '新建 Skill'}
        sub={editingId ? '修改名称与描述，文件内容不受影响。' : '创建后会生成一个含 SKILL.md 的资源包。'}
        onClose={() => setModalOpen(false)}
        footer={<><span className="grow" /><button className="btn" onClick={() => setModalOpen(false)}>取消</button><button className="btn btn-primary" onClick={saveSkill}>保存</button></>}>
        <div className="field"><label>名称</label><input className="input" autoComplete="off" placeholder="如：carbon-storage-skill" value={form.name} onChange={e => setForm({ ...form, name: e.target.value })} onKeyDown={e => { if (e.key === 'Enter') saveSkill() }} />
          <span className="hint">建议使用小写连字符命名，作为资源包目录名。</span></div>
        <div className="field"><label>描述</label><textarea className="input" rows={3} placeholder="一句话说明该 Skill 的用途与适用模型。" value={form.desc} onChange={e => setForm({ ...form, desc: e.target.value })} /></div>
        {formErr && <div style={{ marginTop: 4 }}><div className="notice notice-error"><Icon name="alert-circle" cls="ic-sm" /><div>{formErr}</div></div></div>}
      </Modal>

      <Modal open={!!delId} title="删除 Skill" width={380} onClose={() => setDelId(null)}
        footer={<><span className="grow" /><button className="btn" onClick={() => setDelId(null)}>取消</button><button className="btn btn-primary" style={{ background: 'var(--danger)', borderColor: 'var(--danger)' }} onClick={confirmDelete}>删除</button></>}>
        <p className="confirm-text">确定删除 <b>{delSkill?.name}</b> 吗？该 Skill 的所有文件将一并移除，此操作不可撤销。</p>
      </Modal>

      <style jsx global>{`
        .app { overflow-x: auto; }
        .page-head { height: 56px; flex: none; display: flex; align-items: center; gap: 12px; padding: 0 18px; background: var(--surface); border-bottom: 1px solid var(--border); }
        .page-head h1 { margin: 0; font-size: 15px; font-weight: 650; color: var(--fg-strong); }
        .search { display: flex; align-items: center; gap: 7px; height: 32px; padding: 0 10px; border: 1px solid var(--border-strong); border-radius: var(--r-sm); background: var(--surface); width: 240px; color: var(--faint); }
        .search input { border: 0; outline: none; font-family: inherit; font-size: 13px; width: 100%; background: transparent; color: var(--fg); }
        .breadcrumb { display: flex; align-items: center; gap: 7px; font-size: 13.5px; color: var(--muted); }
        .breadcrumb a { color: var(--accent-ink); font-weight: 500; cursor: pointer; }
        .breadcrumb b { color: var(--fg-strong); font-weight: 650; }
        .skill-grid { padding: 18px; display: grid; grid-template-columns: repeat(auto-fill, minmax(340px, 1fr)); gap: 14px; align-content: start; }
        .skill-card { padding: 16px; border: 1px solid var(--border); border-radius: var(--r-lg); background: var(--surface); cursor: pointer; display: flex; gap: 13px; transition: background .1s, border-color .12s, box-shadow .14s, transform .14s; }
        .skill-card:hover { border-color: var(--accent-line); box-shadow: var(--shadow-float); transform: translateY(-1px); }
        .skill-ico { width: 38px; height: 38px; border-radius: 9px; flex: none; display: grid; place-items: center; background: var(--accent-soft); color: var(--accent-ink); }
        .skill-card h3 { margin: 0 0 3px; font-size: 14px; font-weight: 600; color: var(--fg-strong); }
        .skill-card p { margin: 0 0 6px; font-size: 12.5px; color: var(--muted); line-height: 1.5; }
        .skill-card .acts { align-self: flex-start; display: flex; gap: 2px; opacity: 0; transition: opacity .12s; flex: none; }
        .skill-card:hover .acts, .skill-card:focus-within .acts { opacity: 1; }
        .work { min-width: 1080px; display: flex; }
        .c-files { width: 280px; flex: none; border-right: 1px solid var(--border); }
        .c-fdetail { flex: 1; min-width: 460px; }
        .fnode { display: flex; align-items: center; gap: 7px; padding: 6px 12px; font-size: 12.5px; color: var(--fg); cursor: pointer; transition: background .1s; }
        .fnode:hover { background: var(--surface-2); }
        .fnode.sel { background: var(--accent-soft); color: var(--accent-ink); font-weight: 600; box-shadow: inset 2px 0 0 var(--accent); }
        .fnode.dir { font-weight: 500; }
        .fnode.indent { padding-left: 30px; }
        .fnode .chev { color: var(--faint); display: inline-flex; }
        .doc { padding: 22px 26px; max-width: 760px; }
        .doc h1 { font-size: 22px; margin: 0 0 4px; color: var(--fg-strong); font-weight: 700; }
        .doc h2 { font-size: 15px; margin: 22px 0 8px; color: var(--fg-strong); font-weight: 650; }
        .doc p { font-size: 13.5px; line-height: 1.7; color: var(--fg); margin: 0 0 10px; }
        .doc ul { margin: 0 0 12px; padding-left: 20px; }
        .doc li { font-size: 13.5px; line-height: 1.7; color: var(--fg); margin-bottom: 3px; }
        .doc code { font-family: var(--mono); font-size: 12px; background: var(--inset); padding: 1px 5px; border-radius: 4px; }
        .codeblock { background: oklch(26% 0.02 255); color: oklch(86% 0.02 230); font-family: var(--mono); font-size: 12px; line-height: 1.7; padding: 14px 16px; border-radius: var(--r); overflow-x: auto; margin: 0; }
        .codeblock .k { color: oklch(72% 0.13 290); } .codeblock .s { color: oklch(74% 0.12 145); } .codeblock .c { color: oklch(58% 0.02 230); }
      `}</style>
    </>
  )
}
