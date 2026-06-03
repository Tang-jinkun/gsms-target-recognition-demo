import React from 'react'
import Link from 'next/link'

/** Mirrors open_design/assets/app.js `renderTopnav()` markup/classes. */
const NAV = [
  { id: 'workbench', label: '场景', href: '/scenes' },
  { id: 'data', label: '数据管理', href: '/data-hub' },
  { id: 'skills', label: 'Skills', href: '/skills' },
  { id: 'settings', label: '设置', href: '/settings' },
] as const

export type NavId = (typeof NAV)[number]['id']

export default function TopNav({ active, online = true }: { active?: NavId; online?: boolean }) {
  return (
    <div className="topnav" data-topnav="">
      <Link className="brand" href="/">
        <span className="logo">G</span>GSMS
      </Link>
      <nav className="nav-links">
        {NAV.map(n => (
          <Link key={n.id} href={n.href} className={n.id === active ? 'active' : undefined}>
            {n.label}
          </Link>
        ))}
      </nav>
      <div className="nav-right">
        <span className={`status-dot${online ? '' : ' off'}`} title={online ? '后端在线' : '后端离线'}>
          <span className="dot" />
          {online ? '后端在线' : '后端离线'}
        </span>
        <span className="user-chip">
          <span className="avatar">LZ</span>
          <span className="uname">李泽 · 研究员</span>
        </span>
      </div>
    </div>
  )
}
