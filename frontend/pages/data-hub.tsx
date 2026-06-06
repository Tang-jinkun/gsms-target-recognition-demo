import React from 'react'
import Head from 'next/head'
import TopNav from '../src/components/shell/TopNav'
import Icon from '../src/components/shell/Icon'
import Modal from '../src/components/shell/Modal'
import Select from '../src/components/shell/Select'
import { toast } from '../src/lib/toast'
import { dataHubRepo, filesForDir, TYPE_ICON, TYPE_LABEL, type HubFile, type HubFolder } from '../src/lib/repos/dataHubRepo'

type FolderDialog =
  | { kind: 'create'; name: string }
  | { kind: 'rename'; folder: HubFolder; name: string }
  | { kind: 'delete'; folder: HubFolder }
  | { kind: 'move'; file: HubFile; folderId: string }
  | null

export default function DataHubPage() {
  const [dir, setDir] = React.useState('all')
  const [folders, setFolders] = React.useState<HubFolder[]>([])
  const [files, setFiles] = React.useState<HubFile[]>([])
  const [file, setFile] = React.useState<HubFile | null>(null)
  const [query, setQuery] = React.useState('')
  const [loading, setLoading] = React.useState(true)
  const [folderDialog, setFolderDialog] = React.useState<FolderDialog>(null)
  const inputRef = React.useRef<HTMLInputElement | null>(null)

  const reload = React.useCallback(async () => {
    try {
      setLoading(true)
      const [nextFolders, next] = await Promise.all([dataHubRepo.listFolders(), dataHubRepo.list(query)])
      setFolders(nextFolders)
      setFiles(next)
      setFile(prev => prev ? next.find(item => item.id === prev.id) || null : null)
    } catch {
      toast('数据加载失败，请检查后端服务')
    } finally {
      setLoading(false)
    }
  }, [query])

  React.useEffect(() => { reload() }, [reload])

  const tree = [{ name: 'all', label: '全部', count: files.length }, ...folders.map(folder => ({ name: folder.id, label: folder.name, count: folder.count }))]
  const arr = filesForDir(files, dir).filter(f => !query || f.name.toLowerCase().includes(query.toLowerCase()))

  function selectDir(d: string) { setDir(d); setFile(null) }
  async function uploadFiles(list: FileList | null) {
    if (!list?.length) return
    try {
      setLoading(true)
      for (const item of Array.from(list)) await dataHubRepo.upload(item, dir === 'all' ? undefined : dir)
      toast(`已上传 ${list.length} 个文件`)
      await reload()
    } catch {
      toast('上传失败，请检查后端服务', 'error')
    } finally {
      setLoading(false)
      if (inputRef.current) inputRef.current.value = ''
    }
  }
  async function deleteFile(target: HubFile) {
    try {
      await dataHubRepo.remove(target.id)
      toast('已删除文件')
      setFile(null)
      await reload()
    } catch {
      toast('删除失败，请检查后端服务', 'error')
    }
  }

  function openCreateFolder() {
    setFolderDialog({ kind: 'create', name: '' })
  }

  function openRenameFolder(folder: HubFolder) {
    setFolderDialog({ kind: 'rename', folder, name: folder.name })
  }

  function openDeleteFolder(folder: HubFolder) {
    setFolderDialog({ kind: 'delete', folder })
  }

  function openMoveFile(target: HubFile) {
    const targetFolder = folders.find(item => item.id !== target.folderId) || folders[0]
    if (!targetFolder) { toast('暂无可移动的目标文件夹', 'error'); return }
    setFolderDialog({ kind: 'move', file: target, folderId: targetFolder.id })
  }

  async function submitFolderDialog() {
    if (!folderDialog) return
    try {
      if (folderDialog.kind === 'create') {
        const name = folderDialog.name.trim()
        if (!name) return
        const folder = await dataHubRepo.createFolder(name)
        toast('已新建文件夹')
        setDir(folder.id)
      } else if (folderDialog.kind === 'rename') {
        const name = folderDialog.name.trim()
        if (!name || name === folderDialog.folder.name) return
        await dataHubRepo.renameFolder(folderDialog.folder.id, name)
        toast('已重命名文件夹')
      } else if (folderDialog.kind === 'delete') {
        await dataHubRepo.deleteFolder(folderDialog.folder.id)
        toast('已删除文件夹')
        setDir('all')
      } else {
        await dataHubRepo.moveFiles([folderDialog.file.id], folderDialog.folderId)
        toast('已移动文件')
      }
      setFolderDialog(null)
      await reload()
    } catch {
      const message =
        folderDialog.kind === 'create' ? '新建文件夹失败，请检查是否重名' :
        folderDialog.kind === 'rename' ? '重命名失败，请检查是否重名' :
        folderDialog.kind === 'delete' ? '删除文件夹失败' :
        '移动失败，请检查后端服务'
      toast(message, 'error')
    }
  }

  function updateDialogName(name: string) {
    setFolderDialog(prev => {
      if (!prev || (prev.kind !== 'create' && prev.kind !== 'rename')) return prev
      return { ...prev, name }
    })
  }

  function updateMoveFolder(folderId: string) {
    setFolderDialog(prev => prev?.kind === 'move' ? { ...prev, folderId } : prev)
  }

  const dialogTitle =
    folderDialog?.kind === 'create' ? '新建文件夹' :
    folderDialog?.kind === 'rename' ? '重命名文件夹' :
    folderDialog?.kind === 'delete' ? '删除文件夹' :
    folderDialog?.kind === 'move' ? '移动文件' :
    ''

  const canSubmitDialog =
    !folderDialog ? false :
    folderDialog.kind === 'create' ? Boolean(folderDialog.name.trim()) :
    folderDialog.kind === 'rename' ? Boolean(folderDialog.name.trim()) && folderDialog.name.trim() !== folderDialog.folder.name :
    folderDialog.kind === 'move' ? Boolean(folderDialog.folderId) :
    true

  return (
    <>
      <Head><title>数据管理 / Data Hub · GSMS</title></Head>
      <div className="app">
        <TopNav active="data" />
        <div className="hub-head">
          <h1>数据管理 / Data Hub</h1>
          <span style={{ flex: 1 }} />
          <div className="search"><Icon name="search" cls="ic-sm" /><input placeholder="搜索文件名…" value={query} onChange={e => setQuery(e.target.value)} /></div>
          <input ref={inputRef} type="file" multiple style={{ display: 'none' }} onChange={e => uploadFiles(e.target.files)} />
          <button className="btn btn-primary" onClick={() => inputRef.current?.click()}><Icon name="upload" cls="ic-sm" />上传数据</button>
          <button className="btn" onClick={openCreateFolder}><Icon name="folder-plus" cls="ic-sm" />新建文件夹</button>
          <button className="btn" onClick={() => toast('导入功能开发中')}><Icon name="download" cls="ic-sm" />导入</button>
        </div>

        <div className="work">
          <aside className="col c-tree">
            <div className="col-head"><h2>数据目录</h2></div>
            <div className="col-body">
              {tree.map(t => (
                <div key={t.name} className={`tree-node open ${t.name === dir ? 'sel' : ''}`} onClick={() => selectDir(t.name)}>
                  <span className="chev"><Icon name="chevron-right" cls="ic-sm" /></span><Icon name="folder" cls="ic-sm" /><span>{t.label}</span>
                  <span className="tree-count">{t.count}</span>
                  {t.name !== 'all' && t.name !== 'uncategorized' && (
                    <span className="tree-actions">
                      <button className="icon-btn sm" title="重命名" aria-label="重命名" onClick={e => { e.stopPropagation(); const folder = folders.find(item => item.id === t.name); if (folder) openRenameFolder(folder) }}><Icon name="edit-3" cls="ic-sm" /></button>
                      <button className="icon-btn sm" title="删除文件夹" aria-label="删除文件夹" onClick={e => { e.stopPropagation(); const folder = folders.find(item => item.id === t.name); if (folder) openDeleteFolder(folder) }}><Icon name="trash" cls="ic-sm" /></button>
                    </span>
                  )}
                </div>
              ))}
            </div>
          </aside>

          <section className="col c-list">
            <div className="col-head"><h2>{tree.find(t => t.name === dir)?.label || dir}</h2><span className="right meta">{!loading && arr.length ? `${arr.length} 项` : ''}</span></div>
            <div className="col-body">
              {loading ? (
                <div className="pad">{[1, 2, 3].map(i => <div key={i} className="skeleton" style={{ height: 40, marginBottom: 8 }} />)}</div>
              ) : arr.length === 0 ? (
                <div className="state-empty"><Icon name="folder-open" /><b>{query ? '无匹配文件' : '该目录为空'}</b>{query ? '换个关键词试试' : '上传数据或从其他目录移动文件到这里'}</div>
              ) : (
                arr.map(f => (
                  <div key={f.id} className={`row ${file?.id === f.id ? 'sel' : ''}`} onClick={() => setFile(f)}>
                    <span className={`fchip ${f.type}`}><Icon name={TYPE_ICON[f.type]} cls="ic-sm" /></span>
                    <div style={{ minWidth: 0 }}>
                      <div className="ftitle" style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{f.name}</div>
                      <div className="fsub">{TYPE_LABEL[f.type]} · {f.size}</div>
                    </div>
                    <span className="actions">
                      <button className="icon-btn sm" title="移动" aria-label="移动" onClick={e => { e.stopPropagation(); openMoveFile(f) }}><Icon name="folder-input" cls="ic-sm" /></button>
                      <button className="icon-btn sm" title="删除" aria-label="删除" onClick={e => { e.stopPropagation(); deleteFile(f) }}><Icon name="trash" cls="ic-sm" /></button>
                    </span>
                  </div>
                ))
              )}
            </div>
          </section>

          <section className="col c-detail">
            <div className="col-head"><h2>文件详情</h2></div>
            <div className="col-body">
              {!file ? (
                <div className="state-empty" style={{ marginTop: 60 }}><Icon name="file-text" /><b>未选中文件</b>从中间列表选择一个文件查看其元数据。</div>
              ) : (
                <>
                  <div className="pad" style={{ display: 'flex', alignItems: 'center', gap: 12 }}>
                    <span className={`fchip ${file.type}`} style={{ width: 40, height: 40 }}><Icon name={TYPE_ICON[file.type]} /></span>
                    <div style={{ minWidth: 0 }}>
                      <div style={{ fontSize: 15, fontWeight: 650, color: 'var(--fg-strong)', wordBreak: 'break-all' }}>{file.name}</div>
                      <div className="meta" style={{ marginTop: 2 }}>{TYPE_LABEL[file.type]} · {file.fmt} · {file.size}</div>
                    </div>
                  </div>
                  <div className="sec-divider" />
                  <div className="pad">
                    <div className="glabel" style={{ marginBottom: 11 }}>基本信息</div>
                    <dl className="kv">
                      <dt>类型</dt><dd>{TYPE_LABEL[file.type]}</dd>
                      <dt>格式</dt><dd>{file.fmt}</dd>
                      <dt>大小</dt><dd className="mono">{file.size}</dd>
                      <dt>创建时间</dt><dd className="mono">{file.created}</dd>
                      <dt>修改时间</dt><dd className="mono">{file.modified}</dd>
                      <dt>路径</dt><dd className="mono" style={{ fontSize: 11.5 }}>data/project/files/{file.name}</dd>
                      <dt>所属目录</dt><dd>{file.folderName || '未分类'}</dd>
                      <dt>编码</dt><dd>{file.enc}</dd>
                      <dt>备注</dt><dd>{file.note}</dd>
                    </dl>
                  </div>
                  {file.spatial && (
                    <>
                      <div className="sec-divider" />
                      <div className="pad">
                        <div className="glabel" style={{ marginBottom: 11 }}>空间信息</div>
                        <dl className="kv">
                          <dt>CRS</dt><dd className="mono">{file.spatial.crs}</dd>
                          <dt>几何类型</dt><dd>{file.spatial.geom}</dd>
                          <dt>要素数量</dt><dd className="mono">{file.spatial.feat}</dd>
                          <dt>空间范围</dt><dd className="mono">{file.spatial.extent}</dd>
                          <dt>分辨率</dt><dd className="mono">{file.spatial.res}</dd>
                          <dt>波段数量</dt><dd className="mono">{file.spatial.bands}</dd>
                        </dl>
                      </div>
                    </>
                  )}
                </>
              )}
            </div>
          </section>
        </div>
      </div>

      <Modal
        open={Boolean(folderDialog)}
        title={dialogTitle}
        onClose={() => setFolderDialog(null)}
        width={500}
        footer={(
          <>
            <span className="grow" />
            <button className="btn" onClick={() => setFolderDialog(null)}>取消</button>
            <button className={`btn ${folderDialog?.kind === 'delete' ? 'btn-danger' : 'btn-primary'}`} disabled={!canSubmitDialog} onClick={submitFolderDialog}>
              {folderDialog?.kind === 'delete' ? '删除' : '确定'}
            </button>
          </>
        )}
      >
        {folderDialog?.kind === 'create' && (
          <div className="field">
            <label>文件夹名称</label>
            <input className="input" value={folderDialog.name} autoFocus onChange={e => updateDialogName(e.target.value)} onKeyDown={e => { if (e.key === 'Enter') void submitFolderDialog() }} />
          </div>
        )}
        {folderDialog?.kind === 'rename' && (
          <div className="field">
            <label>文件夹名称</label>
            <input className="input" value={folderDialog.name} autoFocus onChange={e => updateDialogName(e.target.value)} onKeyDown={e => { if (e.key === 'Enter') void submitFolderDialog() }} />
          </div>
        )}
        {folderDialog?.kind === 'delete' && (
          <div className="notice notice-error">
            <Icon name="alert-triangle" cls="ic-sm" />
            <div>
              确认删除文件夹「{folderDialog.folder.name}」
              {folderDialog.folder.count > 0 ? `及其中的 ${folderDialog.folder.count} 个文件` : ''}？
              文件、场景引用和预览数据将被永久删除，无法恢复。
            </div>
          </div>
        )}
        {folderDialog?.kind === 'move' && (
          <>
            <div className="field">
              <label>文件</label>
              <input className="input" value={folderDialog.file.name} readOnly />
            </div>
            <div className="field">
              <label>目标文件夹</label>
              <Select
                value={folderDialog.folderId}
                options={folders.map(folder => ({ value: folder.id, label: folder.name }))}
                onChange={updateMoveFolder}
              />
            </div>
          </>
        )}
      </Modal>

      <style jsx global>{`
        .app { overflow-x: auto; }
        .hub-head { height: 56px; flex: none; display: flex; align-items: center; gap: 12px; padding: 0 18px; background: var(--surface); border-bottom: 1px solid var(--border); }
        .hub-head h1 { margin: 0; font-size: 15px; font-weight: 650; color: var(--fg-strong); }
        .search { display: flex; align-items: center; gap: 7px; height: 32px; padding: 0 10px; border: 1px solid var(--border-strong); border-radius: var(--r-sm); background: var(--surface); width: 240px; color: var(--faint); }
        .search input { border: 0; outline: none; font-family: inherit; font-size: 13px; width: 100%; background: transparent; color: var(--fg); }
        .work { min-width: 1180px; flex: 1; min-height: 0; display: flex; }
        .c-tree { width: 240px; flex: none; border-right: 1px solid var(--border); }
        .c-list { width: 360px; flex: none; border-right: 1px solid var(--border); }
        .c-detail { flex: 1; min-width: 380px; }
        .tree-node { display: flex; align-items: center; gap: 7px; padding: 7px 12px; cursor: pointer; font-size: 13px; color: var(--fg); transition: background .1s; }
        .tree-node:hover { background: var(--surface-2); }
        .tree-node.sel { background: var(--accent-soft); color: var(--accent-ink); font-weight: 600; box-shadow: inset 2px 0 0 var(--accent); }
        .tree-node .chev { color: var(--faint); display: inline-flex; transition: transform .12s; }
        .tree-node.open .chev { transform: rotate(90deg); }
        .tree-count { margin-left: auto; font-size: 11px; color: var(--faint); font-family: var(--mono); }
        .tree-actions { display: none; align-items: center; gap: 1px; margin-left: 2px; }
        .tree-node:hover .tree-actions { display: inline-flex; }
        .tree-node:hover .tree-count { display: none; }
      `}</style>
    </>
  )
}
