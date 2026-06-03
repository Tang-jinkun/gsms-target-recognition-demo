import { iconHtml } from '../components/shell/Icon'

/** Mirrors open_design/assets/app.js `toast()` — transient bottom pill. Client-only. */
export function toast(msg: string, kind?: 'error' | 'ok') {
  if (typeof document === 'undefined') return
  let t = document.querySelector<HTMLDivElement & { _t?: number }>('.toast')
  if (!t) {
    t = document.createElement('div') as HTMLDivElement & { _t?: number }
    t.className = 'toast'
    document.body.appendChild(t)
  }
  t.innerHTML = iconHtml(kind === 'error' ? 'alert-circle' : 'check') + '<span>' + msg + '</span>'
  const ic = t.querySelector<SVGElement>('.ic')
  if (ic) ic.style.color = kind === 'error' ? 'var(--danger)' : 'var(--ok)'
  requestAnimationFrame(() => t!.classList.add('show'))
  window.clearTimeout(t._t)
  t._t = window.setTimeout(() => t!.classList.remove('show'), 2200)
}
