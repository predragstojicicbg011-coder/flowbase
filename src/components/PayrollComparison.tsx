import React, { useEffect, useMemo, useState } from 'react'
import { supabase } from '../supabase'
import { fetchRuns, fetchRunLines, type SavedRun, type SavedRunLine } from '../services/payroll/savedRuns'
import type { PayrollRun } from '../services/payroll/runs'
import {
  previousMonth, lastRegular, compareRuns, percentChange, peopleDifference,
  type Figures, type PersonDelta,
} from '../services/payroll/comparison'
import {
  COMPARISON_TITLE, ONE_COMPANY, NO_LAST_REGULAR, PEOPLE_JOINED, PEOPLE_LEFT, PEOPLE_CHANGED,
  NOT_COMPARED, COMPARISON_READING, SHOW_PEOPLE, HIDE_PEOPLE,
} from '../services/payroll/preliminaryText'
import { fmtNum } from '../utils/formatters'

const FIGURES: { key: keyof Figures; label: string }[] = [
  { key: 'totalCost', label: 'Ukupan trošak meseca' },
  { key: 'net', label: 'Neto' },
  { key: 'taxAndContributions', label: 'Porez i doprinosi' },
]

/**
 * The running month, while preliminary, against last month's regular payroll.
 *
 * This month is the live calculation; last month is what was kept for it,
 * and only when every run kept for it is regular. Both sides are in dinars.
 * Who makes the difference is closed until opened, as every other
 * per-person figure on the page is.
 */
export default function PayrollComparison({ companyId, month, live, missing }: {
  companyId: string
  /** `YYYY-MM`, the running month. */
  month: string
  live: PayrollRun[]
  /**
   * How many people are not in this month's calculation (the page's own
   * blocking problems). A total missing people compared with last month's is
   * every run down and everybody "no longer on it", so it is not drawn.
   */
  missing: number
}) {
  const [kept, setKept] = useState<SavedRun[] | null>(null)
  const [lines, setLines] = useState<SavedRunLine[]>([])
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [open, setOpen] = useState(false)

  useEffect(() => {
    let cancelled = false
    setKept(null); setLines([]); setError(null); setOpen(false)
    if (!companyId || missing > 0) return
    setLoading(true)
    ;(async () => {
      const runs = lastRegular(await fetchRuns(supabase, companyId, previousMonth(month)))
      const all: SavedRunLine[] = []
      for (const r of runs ?? []) all.push(...await fetchRunLines(supabase, r.id))
      if (!cancelled) { setKept(runs ?? []); setLines(all) }
    })()
      .catch(e => { if (!cancelled) setError(e.message || String(e)) })
      .finally(() => { if (!cancelled) setLoading(false) })
    return () => { cancelled = true }
  }, [companyId, month, missing])

  const runs = useMemo(() => (kept && kept.length > 0 ? compareRuns(live, kept) : null), [live, kept])
  const people = useMemo(
    () => (kept && kept.length > 0 ? peopleDifference(live, lines) : null), [live, kept, lines])

  const money = (n: number) => fmtNum(n)
  const pct = (now: number, then: number) => {
    const p = percentChange(now, then)
    return p === null ? '—' : `${p > 0 ? '+' : ''}${p.toLocaleString('sr-RS', { minimumFractionDigits: 1, maximumFractionDigits: 1 })}%`
  }

  return (
    <section style={s.panel} aria-labelledby="payroll-comparison-title">
      <h3 id="payroll-comparison-title" style={s.title}>{COMPARISON_TITLE}</h3>
      {missing > 0 ? (
        <div style={s.hint}>{NOT_COMPARED(missing)}</div>
      ) : !companyId ? (
        <div style={s.hint}>{ONE_COMPANY}</div>
      ) : error ? (
        <div style={s.error}>{error}</div>
      ) : loading || kept === null ? (
        <div style={s.hint}>{COMPARISON_READING}</div>
      ) : !runs ? (
        <div style={s.hint}>{NO_LAST_REGULAR}</div>
      ) : (
        <>
          <div style={{ overflowX: 'auto' as const }}>
            <table style={s.table}>
              <thead>
                <tr>
                  <th style={s.th} scope="col">Obračun</th>
                  <th style={s.thRight} scope="col">Ovaj mesec, preliminarno</th>
                  <th style={s.thRight} scope="col">Prošli mesec</th>
                  <th style={s.thRight} scope="col">Razlika</th>
                  <th style={s.thRight} scope="col">Procenat</th>
                </tr>
              </thead>
              <tbody>
                {[...runs.runs, { key: 'total', label: 'Ukupno', now: runs.total.now, then: runs.total.then }]
                  .map(r => FIGURES.map((f, i) => {
                    const now = r.now[f.key]
                    const then = r.then ? r.then[f.key] : null
                    return (
                      <tr key={`${r.key}-${f.key}`} style={r.key === 'total' ? s.totalRow : undefined}>
                        <td style={s.td}>
                          {i === 0 && <b>{r.label}</b>}
                          <div style={s.small}>{f.label}</div>
                        </td>
                        <td style={s.tdRight}>{money(now)}</td>
                        <td style={s.tdRight}>{then === null ? 'nije sačuvano' : money(then)}</td>
                        <td style={s.tdRight}>{then === null ? '—' : money(now - then)}</td>
                        <td style={s.tdRight}>{then === null ? '—' : pct(now, then)}</td>
                      </tr>
                    )
                  }))}
              </tbody>
            </table>
          </div>

          <button type="button" style={s.ghost} aria-expanded={open}
            onClick={() => setOpen(v => !v)}>
            {open ? HIDE_PEOPLE : SHOW_PEOPLE}
          </button>
          {open && people && (
            <div>
              <PeopleList title={PEOPLE_JOINED} people={people.joined} money={money} />
              <PeopleList title={PEOPLE_LEFT} people={people.left} money={money} />
              <PeopleList title={PEOPLE_CHANGED} people={people.changed} money={money} />
            </div>
          )}
        </>
      )}
    </section>
  )
}

function PeopleList({ title, people, money }: {
  title: string; people: PersonDelta[]; money: (n: number) => string
}) {
  return (
    <div style={{ marginTop: '10px' }}>
      <div style={s.listTitle}>{title} ({people.length})</div>
      {people.length === 0 ? <div style={s.small}>Niko.</div> : people.map(p => (
        <div key={p.key} style={s.personRow}>
          <span style={s.personName}>{p.name}{p.code ? ` · ${p.code}` : ''}</span>
          <span style={s.small}>{money(p.then)} → {money(p.now)}</span>
          <span style={s.personDiff}>{p.difference > 0 ? '+' : ''}{money(p.difference)}</span>
        </div>
      ))}
    </div>
  )
}

const s: Record<string, React.CSSProperties> = {
  panel: { background: '#0D1B2C', border: '1px solid rgba(255,255,255,0.075)', borderRadius: '10px', padding: '14px 16px', marginBottom: '16px', boxShadow: '0 4px 20px rgba(0,0,0,0.4)' },
  title: { fontSize: '14px', fontWeight: '600', color: '#DCE9F6', margin: '0 0 8px' },
  hint: { fontSize: '12px', color: '#7A9BB8', lineHeight: 1.55 },
  error: { background: 'rgba(255,91,90,0.10)', border: '1px solid rgba(255,91,90,0.30)', color: '#FF8E8D', borderRadius: '9px', padding: '9px 12px', fontSize: '12px', lineHeight: 1.55 },
  table: { width: '100%', borderCollapse: 'collapse' as const, fontSize: '12px', marginBottom: '10px' },
  th: { padding: '8px 10px', textAlign: 'left' as const, fontSize: '10px', fontWeight: '600', color: 'rgba(255,255,255,0.40)', textTransform: 'uppercase' as const, letterSpacing: '0.06em', borderBottom: '1px solid rgba(255,255,255,0.075)' },
  thRight: { padding: '8px 10px', textAlign: 'right' as const, fontSize: '10px', fontWeight: '600', color: 'rgba(255,255,255,0.40)', textTransform: 'uppercase' as const, letterSpacing: '0.06em', borderBottom: '1px solid rgba(255,255,255,0.075)', whiteSpace: 'nowrap' as const },
  td: { padding: '6px 10px', color: '#DCE9F6', verticalAlign: 'top' as const },
  tdRight: { padding: '6px 10px', textAlign: 'right' as const, color: '#9BB3CC', fontVariantNumeric: 'tabular-nums', whiteSpace: 'nowrap' as const },
  totalRow: { background: '#060E1A' },
  small: { fontSize: '11px', color: '#7A9BB8' },
  ghost: { background: 'none', color: '#9BB3CC', border: '1px solid rgba(255,255,255,0.14)', borderRadius: '7px', padding: '6px 12px', fontSize: '12px', cursor: 'pointer' },
  listTitle: { fontSize: '12px', fontWeight: '600', color: '#DCE9F6', marginBottom: '4px' },
  personRow: { display: 'flex', gap: '12px', alignItems: 'baseline', padding: '2px 0' },
  personName: { fontSize: '12px', color: '#DCE9F6', minWidth: '200px' },
  personDiff: { fontSize: '12px', color: '#D8B96A', fontVariantNumeric: 'tabular-nums', marginLeft: 'auto' },
}
