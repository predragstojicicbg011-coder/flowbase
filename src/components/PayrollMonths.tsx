import React, { useCallback, useEffect, useState } from 'react'
import { supabase } from '../supabase'
import { fetchRuns, byMonth, type RunMonth } from '../services/payroll/savedRuns'
import { RUN_LABELS, type RunKey } from '../services/payroll/runs'
import { fmtNum } from '../utils/formatters'
import { countOf } from '../utils/plural'
import { monthShortLabel } from '../utils/months'

/**
 * Every month that has been calculated, newest first.
 *
 * A PAYROLL IS FOUND AGAIN MONTHS LATER, usually from a bank statement, by
 * somebody who was not there when it was made. Until now the only way to look
 * at August was to know it existed and type it into a month picker; a month
 * that was never calculated and a month nobody remembered looked identical.
 *
 * It reads the headers alone. Each one carries its own totals precisely so a
 * list of two years needs no lines and no arithmetic — a screen that had to
 * add up every line of every month to draw itself would be slow in the year it
 * matters and unusable in the year after.
 */
export default function PayrollMonths({ companyId, current, onPick }: {
  companyId: string
  /** `YYYY-MM`, so the month being looked at is marked. */
  current: string
  onPick: (month: string) => void
}) {
  const [months, setMonths] = useState<RunMonth[]>([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const [open, setOpen] = useState(false)

  const load = useCallback(async () => {
    if (!companyId) { setMonths([]); setLoading(false); return }
    setLoading(true); setError(null)
    try { setMonths(byMonth(await fetchRuns(supabase, companyId))) }
    catch (e: any) { setError(e.message) }
    setLoading(false)
  }, [companyId])

  useEffect(() => { load() }, [load])

  const money = (n: number) => fmtNum(n)

  if (!companyId || loading) return null
  if (error) return <div style={s.error}>{error}</div>
  if (months.length === 0) return null

  const shown = open ? months : months.slice(0, 6)

  return (
    <div style={s.panel}>
      <button style={s.head} onClick={() => setOpen(v => !v)}>
        <div>
          <div style={s.title}>Obračunati meseci</div>
          <div style={s.hint}>
            Sačuvano: {countOf(months.length, 'mesec', 'meseca', 'meseci')}.
            {' '}Proknjiženo u glavnu knjigu: {months.filter(m => m.posted > 0).length}.
          </div>
        </div>
        <span style={s.chevron}>{open ? 'Prikaži manje' : `Prikaži sve (${months.length})`}</span>
      </button>

      <div style={s.rows}>
        {shown.map(m => {
          const isCurrent = m.month === current.slice(0, 7)
          const allPosted = m.draft === 0 && m.posted > 0
          return (
            <button key={m.month}
              style={{ ...s.row, ...(isCurrent ? s.rowCurrent : {}) }}
              onClick={() => onPick(m.month)}>
              <span style={s.month}>{monthShortLabel(m.month)}</span>
              <span style={{
                ...s.badge,
                background: allPosted ? 'rgba(0,212,126,0.12)'
                  : m.posted > 0 ? 'rgba(200,162,74,0.13)' : 'rgba(255,255,255,0.06)',
                color: allPosted ? '#00D47E' : m.posted > 0 ? '#D8B96A' : '#7A9BB8',
              }}>
                {allPosted ? 'Proknjiženo'
                  : m.posted > 0 ? `Proknjiženo ${m.posted} od ${m.runs.length}`
                  : 'Nacrt'}
              </span>
              <span style={s.runs}>
                {m.runs.map(r => RUN_LABELS[r.run_key as RunKey] ?? r.label).join(' · ')}
              </span>
              <span style={s.cost}>{money(m.totalCost)}</span>
            </button>
          )
        })}
      </div>
    </div>
  )
}

const s: Record<string, React.CSSProperties> = {
  panel: { background: '#0D1B2C', border: '1px solid rgba(255,255,255,0.075)', borderRadius: '10px', marginBottom: '16px', overflow: 'hidden', boxShadow: '0 4px 20px rgba(0,0,0,0.4)' },
  head: { width: '100%', display: 'flex', justifyContent: 'space-between', alignItems: 'baseline', gap: '16px', background: 'none', border: 'none', padding: '13px 18px 10px', cursor: 'pointer', textAlign: 'left' as const },
  title: { fontSize: '14px', fontWeight: '600', color: '#DCE9F6' },
  hint: { fontSize: '11px', color: '#7A9BB8', marginTop: '3px' },
  chevron: { fontSize: '11px', color: '#4EA8FF', whiteSpace: 'nowrap' as const },
  rows: { borderTop: '1px solid rgba(255,255,255,0.06)' },
  row: { width: '100%', display: 'flex', alignItems: 'center', gap: '12px', background: 'none', border: 'none', borderBottom: '0.5px solid rgba(255,255,255,0.05)', padding: '9px 18px', cursor: 'pointer', textAlign: 'left' as const },
  rowCurrent: { background: 'rgba(0,212,126,0.05)', borderLeft: '2px solid #00D47E' },
  month: { fontFamily: "'DM Mono', monospace", fontSize: '13px', color: '#DCE9F6', minWidth: '72px' },
  badge: { fontSize: '10px', fontWeight: '600', padding: '2px 9px', borderRadius: '20px', whiteSpace: 'nowrap' as const, minWidth: '64px', textAlign: 'center' as const },
  runs: { fontSize: '11px', color: '#5C7894', flex: 1, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' as const },
  cost: { fontSize: '13px', color: '#DCE9F6', fontVariantNumeric: 'tabular-nums', whiteSpace: 'nowrap' as const },
  error: { background: 'rgba(255,91,90,0.10)', border: '1px solid rgba(255,91,90,0.30)', color: '#FF8E8D', borderRadius: '9px', padding: '10px 13px', fontSize: '12px', marginBottom: '14px' },
}
