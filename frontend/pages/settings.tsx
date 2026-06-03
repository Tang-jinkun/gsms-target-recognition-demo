import React from 'react'
import Head from 'next/head'
import TopNav from '../src/components/shell/TopNav'
import Icon from '../src/components/shell/Icon'
import Modal from '../src/components/shell/Modal'
import { toast } from '../src/lib/toast'
import { settingsRepo, STATUS_META, PROVIDERS, type ModelCfg, type UserInfo } from '../src/lib/repos/settingsRepo'

type TestState = '' | 'testing' | 'ok' | 'fail'

export default function SettingsPage() {
  const [menu, setMenu] = React.useState<'user' | 'model'>('model')
  const [models, setModels] = React.useState<ModelCfg[]>([])
  const [user, setUser] = React.useState<UserInfo>({ name: '', email: '', org: '', field: '' })

  const [modalOpen, setModalOpen] = React.useState(false)
  const [editIdx, setEditIdx] = React.useState<number | null>(null)
  const [form, setForm] = React.useState({ name: '', provider: 'OpenAI', key: 'sk-xxxxxxxxxxxxxxxxxxxx', url: 'https://api.openai.com/v1', id: 'gpt-4o', def: false })
  const [showKey, setShowKey] = React.useState(false)
  const [test, setTest] = React.useState<TestState>('')

  const reload = React.useCallback(async () => {
    try {
      const [nextModels, nextUser] = await Promise.all([settingsRepo.listModels(), settingsRepo.getUser()])
      setModels(nextModels)
      setUser(nextUser)
    } catch {
      toast('设置加载失败，请检查后端服务')
    }
  }, [])
  React.useEffect(() => { reload() }, [reload])

  function openAdd() {
    setEditIdx(null); setForm({ name: '', provider: 'OpenAI', key: '', url: 'https://api.openai.com/v1', id: 'gpt-4o', def: false }); setShowKey(false); setTest(''); setModalOpen(true)
  }
  function openEdit(i: number) {
    const m = models[i]
    setEditIdx(i); setForm({ name: m.name, provider: m.provider, key: '', url: m.url || '', id: m.id, def: m.def }); setShowKey(false); setTest(''); setModalOpen(true)
  }
  async function saveModel() {
    const name = form.name.trim() || '未命名模型'
    try {
      const payload = { name, provider: form.provider, id: form.id.trim() || 'model', url: form.url.trim(), key: form.key.trim(), def: form.def }
      if (editIdx != null) await settingsRepo.updateModel(models[editIdx], payload)
      else await settingsRepo.createModel(payload)
      setModalOpen(false); toast('模型已保存'); await reload()
    } catch {
      toast('模型保存失败，请检查后端服务', 'error')
    }
  }
  async function setDefault(i: number) {
    try { await settingsRepo.setDefault(models[i]); toast('已设为默认模型'); await reload() }
    catch { toast('设置默认模型失败，请检查后端服务', 'error') }
  }
  async function del(i: number) {
    try { await settingsRepo.removeModel(models[i]); toast('已删除模型'); await reload() }
    catch { toast('删除模型失败，请检查后端服务', 'error') }
  }
  function runTest() {
    setTest('testing')
    window.setTimeout(() => setTest(form.url.trim() && form.id.trim() ? 'ok' : 'fail'), 900)
  }

  return (
    <>
      <Head><title>设置 · GSMS</title></Head>
      <div className="app">
        <TopNav active="settings" />
        <div className="work">
          <aside className="col c-menu">
            <div className="col-head"><h2>设置</h2></div>
            <div className="col-body">
              <div className={`menu-item ${menu === 'user' ? 'sel' : ''}`} onClick={() => setMenu('user')}><Icon name="user" cls="ic-sm" /><span>用户信息</span></div>
              <div className={`menu-item ${menu === 'model' ? 'sel' : ''}`} onClick={() => setMenu('model')}><Icon name="sparkles" cls="ic-sm" /><span>模型配置</span></div>
            </div>
          </aside>

          <section className="col c-content">
            <div className="col-body">
              {menu === 'model' ? (
                <div className="content-pad">
                  <h1>模型配置</h1>
                  <p className="lead">管理工作台 Agent 使用的<strong>对话大模型</strong>（非 InVEST 模型）。可设置一个默认模型，供 Agent 输入框默认选中。</p>
                  <div className="panel">
                    <div style={{ display: 'flex', alignItems: 'center', marginBottom: 6 }}>
                      <span className="glabel">已配置模型</span>
                      <button className="btn btn-primary btn-sm" style={{ marginLeft: 'auto' }} onClick={openAdd}><Icon name="plus" cls="ic-sm" />添加模型</button>
                    </div>
                    <div>
                      {models.length === 0 ? (
                        <div className="state-empty"><Icon name="sparkles" /><b>还没有配置对话模型</b>添加一个模型后，工作台 Agent 才能发送消息。</div>
                      ) : models.map((m, i) => {
                        const s = STATUS_META[m.status]
                        return (
                          <div className="mrow" key={i}>
                            <span className="mi"><Icon name="sparkles" cls="ic-sm" /></span>
                            <div style={{ minWidth: 0 }}>
                              <div style={{ fontSize: 13.5, fontWeight: 600, color: 'var(--fg-strong)', display: 'flex', alignItems: 'center', gap: 8 }}>
                                {m.name} {m.def && <span className="badge badge-accent"><span className="bdot" />默认</span>}
                              </div>
                              <div className="meta">{m.provider} · {m.id}</div>
                            </div>
                            <span className={`badge ${s.badge}`} style={{ marginLeft: 14 }}>{s.dot && <span className="bdot" />}{s.label}</span>
                            <span className="acts">
                              {!m.def && <button className="btn btn-sm" onClick={() => setDefault(i)}>设为默认</button>}
                              <button className="icon-btn sm" title="编辑" aria-label="编辑" onClick={() => openEdit(i)}><Icon name="settings" cls="ic-sm" /></button>
                              <button className="icon-btn sm" title="删除" aria-label="删除" onClick={() => del(i)}><Icon name="trash" cls="ic-sm" /></button>
                            </span>
                          </div>
                        )
                      })}
                    </div>
                  </div>
                </div>
              ) : (
                <div className="content-pad">
                  <h1>用户信息</h1>
                  <p className="lead">这些信息用于标识与署名，不影响模型运行。</p>
                  <div className="panel">
                    <div className="form-grid">
                      <div className="field"><label>用户名</label><input className="input" value={user.name} onChange={e => setUser({ ...user, name: e.target.value })} /></div>
                      <div className="field"><label>邮箱</label><input className="input" value={user.email} onChange={e => setUser({ ...user, email: e.target.value })} /></div>
                      <div className="field"><label>机构</label><input className="input" value={user.org} onChange={e => setUser({ ...user, org: e.target.value })} /></div>
                      <div className="field"><label>研究方向</label><input className="input" value={user.field} onChange={e => setUser({ ...user, field: e.target.value })} /></div>
                    </div>
                    <div style={{ display: 'flex', alignItems: 'center', gap: 12, marginTop: 6 }}>
                      <button className="btn btn-primary" onClick={async () => { try { setUser(await settingsRepo.saveUser(user)); toast('设置已保存') } catch { toast('保存失败，请检查后端服务', 'error') } }}><Icon name="check" cls="ic-sm" />保存</button>
                      <span className="meta">配置保存在本地浏览器</span>
                    </div>
                  </div>
                </div>
              )}
            </div>
          </section>
        </div>
      </div>

      <Modal open={modalOpen} title={editIdx != null ? '编辑对话模型' : '添加对话模型'} onClose={() => setModalOpen(false)}
        footer={<>
          <button className="btn btn-sm" disabled={test === 'testing'} onClick={runTest}><Icon name="link" cls="ic-sm" />测试连接</button>
          <span className="grow" />
          <button className="btn" onClick={() => setModalOpen(false)}>取消</button>
          <button className="btn btn-primary" onClick={saveModel}>保存</button>
        </>}>
        <div className="form-grid">
          <div className="field"><label>模型名称</label><input className="input" placeholder="如：GPT-4o" value={form.name} onChange={e => setForm({ ...form, name: e.target.value })} /></div>
          <div className="field"><label>供应商</label>
            <select className="select" value={form.provider} onChange={e => setForm({ ...form, provider: e.target.value })}>
              {PROVIDERS.map(p => <option key={p}>{p}</option>)}
            </select>
          </div>
          <div className="field full"><label>API Key</label>
            <div className="pwd-wrap">
              <input className="input" type={showKey ? 'text' : 'password'} placeholder="••••••••" value={form.key} onChange={e => setForm({ ...form, key: e.target.value })} />
              <button className="icon-btn sm" title="显示/隐藏" aria-label="显示或隐藏" onClick={() => setShowKey(v => !v)}><Icon name={showKey ? 'eye-off' : 'eye'} cls="ic-sm" /></button>
            </div>
          </div>
          <div className="field full"><label>Base URL</label><input className="input" placeholder="https://api.openai.com/v1" value={form.url} onChange={e => setForm({ ...form, url: e.target.value })} /></div>
          <div className="field full"><label>模型 ID</label><input className="input" placeholder="gpt-4o" value={form.id} onChange={e => setForm({ ...form, id: e.target.value })} /></div>
        </div>
        <div style={{ display: 'flex', alignItems: 'center', gap: 10, padding: '4px 0 2px' }}>
          <label className="switch"><input type="checkbox" checked={form.def} onChange={e => setForm({ ...form, def: e.target.checked })} /><span className="track" /></label>
          <span style={{ fontSize: 13, color: 'var(--fg)' }}>设为默认模型</span>
        </div>
        <div style={{ marginTop: 14 }}>
          {test === 'testing' && <div className="notice notice-info"><Icon name="refresh-cw" cls="ic-sm" /><div>正在测试连接…</div></div>}
          {test === 'ok' && <div className="notice notice-ok"><Icon name="check-circle" cls="ic-sm" /><div>连接成功</div></div>}
          {test === 'fail' && <div className="notice notice-error"><Icon name="alert-circle" cls="ic-sm" /><div>连接失败，请检查 API Key、Base URL 或模型 ID</div></div>}
        </div>
      </Modal>

      <style jsx global>{`
        .app { overflow-x: auto; }
        .work { min-width: 980px; flex: 1; min-height: 0; display: flex; }
        .c-menu { width: 220px; flex: none; border-right: 1px solid var(--border); }
        .c-content { flex: 1; min-width: 540px; background: var(--bg); }
        .menu-item { display: flex; align-items: center; gap: 9px; padding: 9px 14px; font-size: 13px; color: var(--fg); cursor: pointer; transition: background .1s; }
        .menu-item:hover { background: var(--surface-2); }
        .menu-item.sel { background: var(--accent-soft); color: var(--accent-ink); font-weight: 600; box-shadow: inset 2px 0 0 var(--accent); }
        .content-pad { max-width: 680px; padding: 26px 30px; }
        .content-pad h1 { font-size: 18px; font-weight: 700; color: var(--fg-strong); margin: 0 0 3px; }
        .content-pad .lead { font-size: 13px; color: var(--muted); margin: 0 0 22px; }
        .panel { background: var(--surface); border: 1px solid var(--border); border-radius: var(--r-lg); padding: 20px 22px; }
        .form-grid { display: grid; grid-template-columns: 1fr 1fr; gap: 0 18px; }
        .form-grid .full { grid-column: 1 / -1; }
        .pwd-wrap { position: relative; }
        .pwd-wrap .icon-btn { position: absolute; right: 4px; top: 50%; transform: translateY(-50%); }
        .mrow { display: flex; align-items: center; gap: 12px; padding: 13px 0; border-bottom: 1px solid var(--border); }
        .mrow:last-child { border-bottom: 0; }
        .mrow .mi { width: 34px; height: 34px; border-radius: 8px; background: var(--accent-soft); color: var(--accent-ink); display: grid; place-items: center; flex: none; }
        .mrow .acts { margin-left: auto; display: flex; gap: 2px; opacity: 0; transition: opacity .12s; }
        .mrow:hover .acts, .mrow:focus-within .acts { opacity: 1; }
      `}</style>
    </>
  )
}
