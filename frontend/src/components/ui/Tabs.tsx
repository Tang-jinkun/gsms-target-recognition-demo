import React from 'react'

function clsx(...parts: Array<string | undefined | false | null>) {
  return parts.filter(Boolean).join(' ')
}

export type TabItem<T extends string> = {
  value: T
  label: string
  icon?: React.ReactNode
  /** Small dot/count rendered next to the label, e.g. a running indicator. */
  badge?: React.ReactNode
}

type SegmentedTabsProps<T extends string> = {
  items: TabItem<T>[]
  value: T
  onChange: (value: T) => void
  className?: string
}

/**
 * Segmented control used for the left panel (Files/Layers) and right panel
 * (Run/Results). Replaces the inline markup that used to live in LeftPanel.
 */
export default function SegmentedTabs<T extends string>({ items, value, onChange, className }: SegmentedTabsProps<T>) {
  return (
    <div className={clsx('flex rounded-md bg-slate-100 p-1', className)}>
      {items.map(item => {
        const active = item.value === value
        return (
          <button
            key={item.value}
            type="button"
            className={clsx(
              'flex h-8 flex-1 items-center justify-center gap-1.5 rounded text-sm font-medium transition',
              active ? 'bg-white text-slate-950 shadow-sm' : 'text-slate-500 hover:text-slate-800',
            )}
            onClick={() => onChange(item.value)}
          >
            {item.icon}
            {item.label}
            {item.badge}
          </button>
        )
      })}
    </div>
  )
}
