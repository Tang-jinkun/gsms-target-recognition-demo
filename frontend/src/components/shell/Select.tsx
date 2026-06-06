import React from 'react'
import Icon from './Icon'

export type SelectOption = {
  value: string
  label: string
  disabled?: boolean
}

export default function Select({
  value,
  options,
  onChange,
  placeholder = '请选择',
}: {
  value: string
  options: SelectOption[]
  onChange: (value: string) => void
  placeholder?: string
}) {
  const [open, setOpen] = React.useState(false)
  const ref = React.useRef<HTMLDivElement | null>(null)
  const current = options.find(option => option.value === value)

  React.useEffect(() => {
    if (!open) return
    const onPointerDown = (event: PointerEvent) => {
      if (!ref.current?.contains(event.target as Node)) setOpen(false)
    }
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') setOpen(false)
    }
    document.addEventListener('pointerdown', onPointerDown)
    document.addEventListener('keydown', onKeyDown)
    return () => {
      document.removeEventListener('pointerdown', onPointerDown)
      document.removeEventListener('keydown', onKeyDown)
    }
  }, [open])

  return (
    <div className={`select-ui ${open ? 'open' : ''}`} ref={ref}>
      <button type="button" className="select-trigger" aria-haspopup="listbox" aria-expanded={open} onClick={() => setOpen(v => !v)}>
        <span className={current ? '' : 'placeholder'}>{current?.label || placeholder}</span>
        <Icon name="chevron-down" cls="ic-sm" />
      </button>
      {open && (
        <div className="select-menu" role="listbox">
          {options.map(option => (
            <button
              type="button"
              key={option.value}
              className={option.value === value ? 'selected' : ''}
              disabled={option.disabled}
              role="option"
              aria-selected={option.value === value}
              onClick={() => {
                if (option.disabled) return
                onChange(option.value)
                setOpen(false)
              }}
            >
              <span>{option.label}</span>
              {option.value === value && <Icon name="check" cls="ic-sm" />}
            </button>
          ))}
        </div>
      )}
    </div>
  )
}
