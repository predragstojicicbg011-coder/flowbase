import React, { useEffect, useMemo, useState } from 'react'
import { supabase } from '../supabase'
import {
  proposeFromCalendar, templateProblem, templateTotal, TEMPLATE_FIELDS,
  type PreliminaryHoursRow, type TemplateField,
} from '../services/payroll/preliminaryHours'
import { savePreliminaryHours, removePreliminaryHours } from '../services/payroll/preliminaryHoursStore'
import { label } from '../services/payroll/timesheets'
import type { MonthFund } from '../services/payroll/holidays'
import {
  TEMPLATE_PANEL_TITLE, SAVE_TEMPLATE, REMOVE_TEMPLATE, TEMPLATE_READ_ONLY,
  onTemplateCount, FILL_IS_DIFFERENT, TEMPLATE_UNSAVED, templateHint, templateTotalLine,
} from '../services/payroll/preliminaryText'

/**
 * The preliminary hours of the running month, above the timesheet grid.
 *
 * A TEMPLATE, NOT TIMESHEETS. "Somebody who worked the whole month has these
 * hours": Payroll applies it, in memory, to whoever has no timesheet yet, and
 * the grid below keeps showing them as having none. It starts from the
 * calendar's proposal and must add up to the month's fund, as a timesheet
 * must. Only administrators and the owner save it.
 */
export default function TimesheetPreliminaryPanel({
  month, fund, saved, canSave, missing, onChanged,
}: {
  /** `YYYY-MM`, the running month. */
  month: string
  fund: MonthFund
  /** What is saved for the month, or null. */
  saved: PreliminaryHoursRow | null
  canSave: boolean
  /** How many people on the roster have no timesheet. */
  missing: number
  onChanged: () => void
}) {
  // A saved template that no longer matches the fund is not loaded: the
  // calendar's proposal for the fund as it is now is, so "save them again" is
  // one click.
  const savedProblem = saved ? templateProblem(saved, fund) : null
  const start = useMemo(
    () => (saved && !templateProblem(saved, fund) ? saved : proposeFromCalendar(month, fund)),
    [saved, month, fund])
  const [draft, setDraft] = useState<Record<TemplateField, string>>(() => asText(start))
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)

  useEffect(() => { setDraft(asText(start)); setError(null) }, [start])

  const row: PreliminaryHoursRow = useMemo(() => {
    const r = { ...start, note: start.note ?? null } as PreliminaryHoursRow
    for (const f of TEMPLATE_FIELDS) r[f] = hoursOf(draft[f])
    return r
  }, [start, draft])

  const total = templateTotal(row)
  const problem = templateProblem(row, fund)

  const save = async () => {
    setBusy(true); setError(null)
    try { await savePreliminaryHours(supabase, row); onChanged() }
    catch (e: any) { setError(e.message) }
    setBusy(false)
  }
  const remove = async () => {
    setBusy(true); setError(null)
    try { await removePreliminaryHours(supabase, month); onChanged() }
    catch (e: any) { setError(e.message) }
    setBusy(false)
  }

  const saveDisabled = busy || !canSave || problem !== null

  return (
    <section style={s.panel} aria-labelledby="preliminary-hours-title">
      <h3 id="preliminary-hours-title" style={s.title}>{TEMPLATE_PANEL_TITLE}</h3>
      <div style={s.hint}>{templateHint(fund.monthHours)}</div>

      {savedProblem && <div style={s.warn}>{savedProblem}</div>}
      {!saved && <div style={s.note}>{TEMPLATE_UNSAVED}</div>}
      {error && <div style={s.error}>{error}</div>}

      <div style={s.fields}>
        {TEMPLATE_FIELDS.map(f => (
          <div key={f} style={s.field}>
            <label htmlFor={`preliminary-${f}`} style={s.label}>{label(f)}</label>
            <input id={`preliminary-${f}`} style={s.input} inputMode="decimal"
              value={draft[f]} readOnly={!canSave}
              onChange={e => setDraft(d => ({ ...d, [f]: e.target.value }))} />
          </div>
        ))}
      </div>

      <div style={s.bar}>
        <span style={s.total}>{templateTotalLine(total, fund.monthHours)}</span>
        {problem && problem !== savedProblem && <span style={s.problem}>{problem}</span>}
        <button type="button" style={saveDisabled ? s.disabled : s.primary}
          disabled={saveDisabled} onClick={save}>
          {SAVE_TEMPLATE}
        </button>
        {saved && canSave && (
          <button type="button" style={s.ghost} disabled={busy} onClick={remove}>
            {REMOVE_TEMPLATE}
          </button>
        )}
      </div>
      {!canSave && <div style={s.hint}>{TEMPLATE_READ_ONLY}</div>}

      {/* Said only when it is true: a template saved AND matching the fund. */}
      {saved && !savedProblem && <div style={s.hint}>{onTemplateCount(missing)}</div>}
      <div style={s.hint}>{FILL_IS_DIFFERENT}</div>
    </section>
  )
}

/** Hours as typed: a decimal comma is a decimal point; anything else is nought. */
function hoursOf(text: string): number {
  const n = Number(String(text ?? '').trim().replace(',', '.'))
  return Number.isFinite(n) ? n : 0
}

function asText(t: PreliminaryHoursRow): Record<TemplateField, string> {
  const out = {} as Record<TemplateField, string>
  for (const f of TEMPLATE_FIELDS) out[f] = String(t[f] ?? 0)
  return out
}

const s: Record<string, React.CSSProperties> = {
  panel: { background: '#0D1B2C', border: '1px solid rgba(255,255,255,0.075)', borderRadius: '10px', padding: '14px 16px', marginBottom: '14px', boxShadow: '0 4px 20px rgba(0,0,0,0.4)' },
  title: { fontSize: '14px', fontWeight: '600', color: '#DCE9F6', margin: 0 },
  hint: { fontSize: '11px', color: '#7A9BB8', marginTop: '6px', marginBottom: '6px', lineHeight: 1.55 },
  fields: { display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(170px, 1fr))', gap: '8px 12px', margin: '10px 0' },
  field: { display: 'flex', flexDirection: 'column' as const, gap: '3px' },
  label: { fontSize: '11px', color: '#7A9BB8' },
  input: { boxSizing: 'border-box' as const, textAlign: 'right' as const, fontSize: '13px', fontVariantNumeric: 'tabular-nums', border: '1px solid rgba(255,255,255,0.12)', borderRadius: '6px', padding: '6px 8px', background: '#060E1A', color: '#DCE9F6' },
  bar: { display: 'flex', alignItems: 'center', gap: '14px', flexWrap: 'wrap' as const },
  total: { fontSize: '12px', color: '#7A9BB8' },
  problem: { fontSize: '11px', color: '#FF8E8D', maxWidth: '520px', lineHeight: 1.45 },
  primary: { background: '#00D47E', color: '#060E1A', border: 'none', borderRadius: '7px', padding: '6px 14px', fontSize: '12px', fontWeight: '500', cursor: 'pointer', marginLeft: 'auto' },
  disabled: { background: 'rgba(255,255,255,0.06)', color: '#5C7894', border: 'none', borderRadius: '7px', padding: '6px 14px', fontSize: '12px', cursor: 'not-allowed', marginLeft: 'auto' },
  ghost: { background: 'none', color: '#7A9BB8', border: '1px solid rgba(255,255,255,0.10)', borderRadius: '7px', padding: '6px 14px', fontSize: '12px', cursor: 'pointer' },
  error: { background: 'rgba(255,91,90,0.10)', border: '1px solid rgba(255,91,90,0.30)', color: '#FF8E8D', borderRadius: '9px', padding: '9px 12px', fontSize: '12px', lineHeight: 1.55, margin: '8px 0' },
  warn: { background: 'rgba(200,162,74,0.10)', border: '1px solid rgba(200,162,74,0.30)', color: '#D8B96A', borderRadius: '9px', padding: '9px 12px', fontSize: '12px', lineHeight: 1.55, margin: '8px 0' },
  note: { background: 'rgba(78,168,255,0.07)', border: '1px solid rgba(78,168,255,0.20)', color: '#9BC4EC', borderRadius: '9px', padding: '9px 12px', fontSize: '12px', lineHeight: 1.55, margin: '8px 0' },
}
