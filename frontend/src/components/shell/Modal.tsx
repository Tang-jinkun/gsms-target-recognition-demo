import React from 'react'
import Icon from './Icon'

/** Mirrors open_design `.modal-scrim/.modal` structure. */
export default function Modal({
  open,
  title,
  sub,
  onClose,
  children,
  footer,
  width,
}: {
  open: boolean
  title: string
  sub?: string
  onClose: () => void
  children: React.ReactNode
  footer?: React.ReactNode
  width?: number
}) {
  if (!open) return null
  return (
    <div className="modal-scrim open" onMouseDown={e => { if (e.target === e.currentTarget) onClose() }}>
      <div className="modal" style={width ? { width: `min(${width}px, calc(100vw - 40px))` } : undefined}>
        <div className="modal-head">
          <div>
            <h3>{title}</h3>
            {sub && <div className="sub">{sub}</div>}
          </div>
          <button className="icon-btn" style={{ marginLeft: 'auto' }} aria-label="关闭" onClick={onClose}>
            <Icon name="x" />
          </button>
        </div>
        <div className="modal-body">{children}</div>
        {footer && <div className="modal-foot">{footer}</div>}
      </div>
    </div>
  )
}
