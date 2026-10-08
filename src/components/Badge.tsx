import React from 'react'

// ── Badge types ───────────────────────────────────────────
type StatusType = 'paid' | 'unpaid' | 'partial' | 'overdue'
type TxType     = 'direct' | 'invoice_payment' | 'passthrough'
type AlertLevel = 'ok' | 'warn' | 'info'

// ── Status Badge ──────────────────────────────────────────
export function StatusBadge({ status }: { status: StatusType }) {
  const map: Record<StatusType, { bg: string; color: string; label: string }> = {
    paid:    { bg: '#E1F5EE', color: '#085041', label: 'paid' },
    unpaid:  { bg: '#F0F0EE', color: '#666666', label: 'unpaid' },
    partial: { bg: 'rgba(186,117,23,0.12)', color: '#633806', label: 'partial' },
    overdue: { bg: '#FCEBEB', color: '#A32D2D', label: 'overdue' },
  }
  const v = map[status] ?? map.unpaid
  return <Pill bg={v.bg} color={v.color}>{v.label}</Pill>
}

// ── Transaction Type Badge ────────────────────────────────
export function TxBadge({ type }: { type: TxType }) {
  const map: Record<TxType, { bg: string; color: string; label: string }> = {
    direct:          { bg: '#E1F5EE', color: '#085041', label: 'direct' },
    invoice_payment: { bg: '#E6F1FB', color: '#0C447C', label: 'inv. pay' },
    passthrough:     { bg: 'rgba(124,58,237,0.10)', color: '#5B21B6', label: 'pass-through' },
  }
  const v = map[type] ?? map.direct
  return <Pill bg={v.bg} color={v.color}>{v.label}</Pill>
}

// ── Alert Dot ─────────────────────────────────────────────
export function AlertDot({ level }: { level: AlertLevel }) {
  const colors: Record<AlertLevel, string> = {
    ok:   '#1D9E75',
    warn: '#BA7517',
    info: '#185FA5',
  }
  return (
    <div style={{
      width: '6px', height: '6px', borderRadius: '50%',
      background: colors[level], flexShrink: 0, marginTop: '5px',
    }}/>
  )
}

// ── Trend Badge ───────────────────────────────────────────
export function TrendBadge({ pct, up }: { pct: number; up: boolean }) {
  return (
    <span style={{
      fontSize: '10px', fontWeight: '600', padding: '2px 7px', borderRadius: '9999px',
      background: up ? '#E1F5EE' : '#FCEBEB',
      color: up ? '#0B5E49' : '#A32D2D',
    }}>
      {up ? '↑' : '↓'} {Math.abs(pct)}%
    </span>
  )
}

// ── Portal Badge ──────────────────────────────────────────
export function PortalBadge({ children }: { children: React.ReactNode }) {
  return (
    <div style={{
      display: 'inline-flex', alignItems: 'center', gap: '6px',
      background: '#E1F5EE', color: '#0F6E56', fontSize: '11px',
      fontWeight: '500', padding: '4px 12px', borderRadius: '9999px',
      letterSpacing: '0.06em', textTransform: 'uppercase',
    }}>
      <div style={{ width: '6px', height: '6px', borderRadius: '50%', background: '#1D9E75' }}/>
      {children}
    </div>
  )
}

// ── Shared pill primitive ─────────────────────────────────
function Pill({ bg, color, children }: { bg: string; color: string; children: React.ReactNode }) {
  return (
    <span style={{
      fontSize: '10px', fontWeight: '500', padding: '2px 9px',
      borderRadius: '9999px', background: bg, color, whiteSpace: 'nowrap',
    }}>
      {children}
    </span>
  )
}
