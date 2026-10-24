import type { Cell, CellFormat } from './types.js'

const NBSP = '\u00a0'

export function fmtInt(value: number): string {
  return Math.round(value).toLocaleString('en-US')
}

export function fmt1(value: number): string {
  return value.toFixed(1)
}

export function fmt2(value: number): string {
  return value.toFixed(2)
}

/** Percentage from an already-multiplied-by-100 value. */
export function fmtPct1(value: number): string {
  return `${value.toFixed(1)}%`
}

/** Rate per thousand flights, one decimal. */
export function fmtPer1k(value: number): string {
  return `${value.toFixed(1)}/1k`
}

export function fmtBytes(bytes: number): string {
  if (!Number.isFinite(bytes) || bytes <= 0) return '0 B'
  if (bytes < 1024) return `${bytes} B`
  const kib = bytes / 1024
  if (kib < 1024) return `${kib < 10 ? kib.toFixed(1) : Math.round(kib)}${NBSP}KiB`
  const mib = kib / 1024
  return `${mib < 10 ? mib.toFixed(2) : mib.toFixed(1)}${NBSP}MiB`
}

export function fmtMs(ms: number): string {
  if (!Number.isFinite(ms)) return '—'
  if (ms < 1) return `${ms.toFixed(2)}${NBSP}ms`
  if (ms < 100) return `${ms.toFixed(1)}${NBSP}ms`
  return `${Math.round(ms)}${NBSP}ms`
}

export function fmtCompact(value: number): string {
  const abs = Math.abs(value)
  if (abs >= 1_000_000_000) return `${(value / 1_000_000_000).toFixed(1)}B`
  if (abs >= 1_000_000) return `${(value / 1_000_000).toFixed(abs >= 10_000_000 ? 0 : 1)}M`
  if (abs >= 1_000) return `${(value / 1_000).toFixed(abs >= 10_000 ? 0 : 1)}k`
  if (abs >= 10) return `${Math.round(value)}`
  if (abs >= 1) return value.toFixed(1)
  return abs === 0 ? '0' : value.toFixed(2)
}

/** `2024-01-05` -> `Jan 5`. Used for chart axis labels; full dates stay in tables. */
export function fmtShortDate(iso: string): string {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(iso)
  if (!m) return iso
  const months = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec']
  return `${months[Number(m[2]) - 1] ?? m[2]} ${Number(m[3])}`
}

export function fmtCell(value: Cell, format: CellFormat = 'text'): string {
  if (value == null) return '—'
  if (typeof value === 'string') return value
  switch (format) {
    case 'int':
      return fmtInt(value)
    case 'num1':
      return fmt1(value)
    case 'pct1':
      return fmtPct1(value)
    case 'per1k':
      return fmtPer1k(value)
    default:
      return fmtCompact(value)
  }
}
