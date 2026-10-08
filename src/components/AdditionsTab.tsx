import React, { useCallback, useEffect, useMemo, useState } from 'react'
import { supabase } from '../supabase'
import {
  fetchAdditions, amountInDinars, totalsFor, treatmentLabel, kindLabel,
  KINDS, TREATMENTS, type AdditionRow,
} from '../services/payroll/additions'
import { firstOfMonth } from '../services/payroll/timesheets'
import type { EmployeeForMonth } from '../services/payroll/employees'
import { fmtNum } from '../utils/formatters'

/**
 * Bonuses and the rest, for one month.
 *
 * A MONTH AND NOT A CONTRACT. A bonus paid in September is not a term of
 * employment; putting it on the contract or in the settings would pay it again
 * in October, every October, until somebody noticed.
 *
 * THE TREATMENT IS THE FIELD THAT MATTERS and it is never defaulted. Fifty
 * thousand as salary costs about seventy; as other income about fifty-six;
 * untaxed, fifty. The wrong choice changes what is owed to the state and the
 * line looks ordinary either way, so every addition says which it is and the
 * screen says what each one means.
 */
export default function AdditionsTab({ month, people, eurRate }: {
  month: string
  people: EmployeeForMonth[]
  /** The middle rate on the 20th, for a euro addition. */
  eurRate: number | null
}) {
  const [rows, setRows] = useState<AdditionRow[]>([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)

  const blank = {
    id: '', employee_id: '', kind: 'bonus' as AdditionRow['kind'], label: '',
    treatment: '' as AdditionRow['treatment'] | '', amount: '', currency: 'RSD', note: '',
  }
  const [draft, setDraft] = useState(blank)
  const [busy, setBusy] = useState(false)

  const load = useCallback(async () => {
    setLoading(true); setError(null)
    try { setRows(await fetchAdditions(supabase, month)) }
    catch (e: any) { setError(e.message) }
    setLoading(false)
  }, [month])

  useEffect(() => { load() }, [load])

  const rates = useMemo((): Record<string, number> => {
    const out: Record<string, number> = {}
    if (eurRate) out.EUR = eurRate
    return out
  }, [eurRate])
  const totals = useMemo(() => totalsFor(rows, rates), [rows, rates])

  const nameOf = (id: string) =>
    people.find(p => p.employee.id === id)?.employee.full_name ?? '(not on this month)'

  const save = async () => {
    if (!draft.employee_id) { setError('Choose who it is for.'); return }
    if (!draft.label.trim()) { setError('Give it a name — it appears on the payslip.'); return }
    if (!draft.treatment) {
      setError('Choose how it is taxed. There is no default on purpose: the three '
        + 'treatments cost noticeably different amounts and the line looks the same '
        + 'whichever one is wrong.')
      return
    }
    const amount = Number(draft.amount)
    if (!Number.isFinite(amount) || amount <= 0) { setError('Enter the amount.'); return }

    setBusy(true); setError(null)
    const row = {
      employee_id: draft.employee_id,
      month: firstOfMonth(month),
      kind: draft.kind,
      label: draft.label.trim(),
      treatment: draft.treatment,
      amount,
      currency: draft.currency,
      note: draft.note.trim() || null,
    }
    const { data, error: err } = draft.id
      ? await supabase.from('payroll_additions').update(row).eq('id', draft.id).select('id')
      : await supabase.from('payroll_additions').insert(row).select('id')
    setBusy(false)
    if (err) { setError(`It could not be saved: ${err.message}`); return }
    if (!data || data.length === 0) { setError('The write was refused.'); return }
    setDraft(blank)
    load()
  }

  const remove = async (a: AdditionRow) => {
    if (!window.confirm(`Delete "${a.label}" for ${nameOf(a.employee_id)}?`)) return
    const { error: err } = await supabase.from('payroll_additions')
      .delete().eq('id', a.id).select('id')
    if (err) { setError(`It could not be deleted: ${err.message}`); return }
    load()
  }

  const money = (n: number) => fmtNum(n)

  const chosen = TREATMENTS.find(t => t.value === draft.treatment)

  if (loading) return <div style={s.empty}>Loading…</div>

  return (
    <div>
      {error && <div style={s.error}>{error}</div>}

      <div style={s.note}>
        Additions belong to <b>{month}</b> and to no other month. A bonus entered here is
        paid once; nothing carries it into the next one.
      </div>

      <div style={s.bar}>
        <div style={s.stat}>Part of the salary <b>{money(totals.salary)}</b></div>
        <div style={s.stat}>Other income <b>{money(totals.otherIncome)}</b></div>
        <div style={s.stat}>Not taxed <b>{money(totals.nonTaxable)}</b></div>
        {!eurRate && rows.some(a => a.currency !== 'RSD') && (
          <div style={{ ...s.stat, color: '#FF8E8D' }}>
            A euro addition cannot be converted — no rate for this month
          </div>
        )}
      </div>

      <div style={s.tableWrap}>
        {rows.length === 0 ? (
          <div style={s.empty}>Nothing added to any salary this month.</div>
        ) : (
          <table style={s.table}>
            <thead>
              <tr style={s.thead}>
                <th style={s.th}>Employee</th>
                <th style={s.th}>What</th>
                <th style={s.th}>How it is taxed</th>
                <th style={s.thRight}>Amount</th>
                <th style={s.thRight}>In dinars</th>
                <th style={s.th}></th>
              </tr>
            </thead>
            <tbody>
              {rows.map((a, i) => (
                <tr key={a.id} style={{ ...s.tr, background: i % 2 === 0 ? '#0D1B2C' : '#111F30' }}>
                  <td style={s.td}>
                    <div style={{ color: '#00D47E', fontWeight: '600' }}>{nameOf(a.employee_id)}</div>
                  </td>
                  <td style={s.td}>
                    <div style={{ color: '#DCE9F6' }}>{a.label}</div>
                    <div style={s.small}>{kindLabel(a.kind)}</div>
                  </td>
                  <td style={s.td}>
                    <span style={{
                      ...s.badge,
                      background: a.treatment === 'salary' ? 'rgba(0,212,126,0.12)'
                        : a.treatment === 'other_income' ? 'rgba(78,168,255,0.13)'
                        : 'rgba(255,255,255,0.06)',
                      color: a.treatment === 'salary' ? '#00D47E'
                        : a.treatment === 'other_income' ? '#4EA8FF' : '#7A9BB8',
                    }}>
                      {treatmentLabel(a.treatment)}
                    </span>
                  </td>
                  <td style={s.tdRight}>{money(a.amount)} {a.currency}</td>
                  <td style={s.tdRight}>
                    {a.currency === 'RSD' ? '—'
                      : amountInDinars(a, rates) > 0 ? money(amountInDinars(a, rates))
                      : <span style={{ color: '#FF8E8D' }}>no rate</span>}
                  </td>
                  <td style={s.td}>
                    <div style={{ display: 'flex', gap: '6px' }}>
                      <button style={s.ghostSmall} onClick={() => setDraft({
                        id: a.id, employee_id: a.employee_id, kind: a.kind, label: a.label,
                        treatment: a.treatment, amount: String(a.amount),
                        currency: a.currency, note: a.note || '',
                      })}>Edit</button>
                      <button style={s.deleteBtn} onClick={() => remove(a)}>🗑</button>
                    </div>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </div>

      <div style={s.sectionLabel}>{draft.id ? 'Editing an addition' : `Add to a salary in ${month}`}</div>
      <div style={s.grid}>
        <Field label="Employee">
          <select style={s.input} value={draft.employee_id}
            onChange={e => setDraft({ ...draft, employee_id: e.target.value })}>
            <option value="">— choose —</option>
            {people.map(p => (
              <option key={p.employee.id} value={p.employee.id}>{p.employee.full_name}</option>
            ))}
          </select>
        </Field>
        <Field label="Kind">
          <select style={s.input} value={draft.kind}
            onChange={e => setDraft({ ...draft, kind: e.target.value as AdditionRow['kind'] })}>
            {KINDS.map(k => <option key={k.value} value={k.value}>{k.label}</option>)}
          </select>
        </Field>
        <Field label="Name" hint="This is the line on the payslip">
          <input style={s.input} value={draft.label}
            onChange={e => setDraft({ ...draft, label: e.target.value })} />
        </Field>
        <Field label="Amount">
          <div style={{ display: 'flex', gap: '6px' }}>
            <input style={s.input} inputMode="decimal" value={draft.amount}
              onChange={e => setDraft({ ...draft, amount: e.target.value })} />
            <select style={{ ...s.input, width: '88px' }} value={draft.currency}
              onChange={e => setDraft({ ...draft, currency: e.target.value })}>
              <option value="RSD">RSD</option>
              <option value="EUR">EUR</option>
              {/* A payroll converts contract terms at the EUR rate only; USD stays for a term written before. */}

              {draft.currency === 'USD' && <option value="USD">USD</option>}
            </select>
          </div>
        </Field>
        <div style={{ gridColumn: '1 / -1' }}>
          <Field label="How it is taxed">
            <select style={s.input} value={draft.treatment}
              onChange={e => setDraft({ ...draft, treatment: e.target.value as any })}>
              <option value="">— choose, there is no default —</option>
              {TREATMENTS.map(t => <option key={t.value} value={t.value}>{t.label}</option>)}
            </select>
            {chosen && <div style={s.treatmentDetail}>{chosen.detail}</div>}
          </Field>
        </div>
        <div style={{ gridColumn: '1 / -1' }}>
          <Field label="Note">
            <input style={s.input} value={draft.note}
              onChange={e => setDraft({ ...draft, note: e.target.value })} />
          </Field>
        </div>
      </div>
      <div style={{ marginTop: '12px', display: 'flex', gap: '8px' }}>
        <button style={s.primary} onClick={save} disabled={busy}>
          {busy ? 'Saving…' : draft.id ? 'Save changes' : 'Add'}
        </button>
        {draft.id && (
          <button style={s.ghost} onClick={() => { setDraft(blank); setError(null) }}>Cancel</button>
        )}
      </div>
    </div>
  )
}

function Field({ label, hint, children }: { label: string; hint?: string; children: React.ReactNode }) {
  return (
    <div>
      <div style={s.label}>{label}</div>
      {children}
      {hint && <div style={s.hint}>{hint}</div>}
    </div>
  )
}

const s: Record<string, React.CSSProperties> = {
  empty: { padding: '2rem', textAlign: 'center' as const, color: '#7A9BB8', fontSize: '13px' },
  note: { background: 'rgba(78,168,255,0.07)', border: '1px solid rgba(78,168,255,0.20)', color: '#9BC4EC', borderRadius: '9px', padding: '10px 13px', fontSize: '12px', lineHeight: 1.55, marginBottom: '12px' },
  error: { background: 'rgba(255,91,90,0.10)', border: '1px solid rgba(255,91,90,0.30)', color: '#FF8E8D', borderRadius: '9px', padding: '10px 13px', fontSize: '12px', lineHeight: 1.55, marginBottom: '12px' },
  bar: { display: 'flex', gap: '18px', marginBottom: '12px', flexWrap: 'wrap' as const },
  stat: { fontSize: '12px', color: '#7A9BB8' },
  tableWrap: { background: '#0D1B2C', border: '1px solid rgba(255,255,255,0.075)', borderRadius: '10px', overflow: 'hidden', marginBottom: '6px' },
  table: { width: '100%', borderCollapse: 'collapse' as const, fontSize: '13px' },
  thead: { background: '#060E1A' },
  th: { padding: '9px 11px', textAlign: 'left' as const, fontSize: '10px', fontWeight: '600', color: 'rgba(255,255,255,0.30)', textTransform: 'uppercase' as const, letterSpacing: '0.08em', borderBottom: '1px solid rgba(255,255,255,0.075)' },
  thRight: { padding: '9px 11px', textAlign: 'right' as const, fontSize: '10px', fontWeight: '600', color: 'rgba(255,255,255,0.30)', textTransform: 'uppercase' as const, letterSpacing: '0.08em', borderBottom: '1px solid rgba(255,255,255,0.075)' },
  tr: { borderBottom: '0.5px solid rgba(255,255,255,0.05)' },
  td: { padding: '8px 11px', verticalAlign: 'middle' as const },
  tdRight: { padding: '8px 11px', textAlign: 'right' as const, color: '#7A9BB8', fontVariantNumeric: 'tabular-nums' },
  small: { fontSize: '10.5px', color: '#5C7894', marginTop: '1px' },
  badge: { fontSize: '11px', fontWeight: '500', padding: '3px 9px', borderRadius: '20px', whiteSpace: 'nowrap' as const },
  sectionLabel: { fontSize: '10px', fontWeight: '600', color: 'rgba(255,255,255,0.30)', textTransform: 'uppercase' as const, letterSpacing: '0.08em', margin: '18px 0 8px' },
  grid: { display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '12px 16px' },
  label: { fontSize: '10px', fontWeight: '600', color: 'rgba(255,255,255,0.30)', textTransform: 'uppercase' as const, letterSpacing: '0.08em', marginBottom: '5px' },
  hint: { fontSize: '11px', color: '#5C7894', marginTop: '4px' },
  treatmentDetail: { fontSize: '11px', color: '#9BC4EC', marginTop: '6px', lineHeight: 1.5 },
  input: { width: '100%', boxSizing: 'border-box' as const, fontFamily: 'system-ui,sans-serif', fontSize: '13px', border: '1px solid rgba(255,255,255,0.075)', borderRadius: '8px', padding: '8px 10px', background: '#060E1A', color: '#DCE9F6', outline: 'none' },
  primary: { background: '#00D47E', color: '#060E1A', border: 'none', borderRadius: '8px', padding: '9px 18px', fontSize: '13px', fontWeight: '500', cursor: 'pointer' },
  ghost: { background: 'none', color: '#7A9BB8', border: '1px solid rgba(255,255,255,0.10)', borderRadius: '8px', padding: '9px 16px', fontSize: '13px', cursor: 'pointer' },
  ghostSmall: { background: 'none', color: '#7A9BB8', border: '1px solid rgba(255,255,255,0.10)', borderRadius: '6px', padding: '3px 10px', fontSize: '11px', cursor: 'pointer' },
  deleteBtn: { background: 'none', border: 'none', cursor: 'pointer', fontSize: '13px', opacity: 0.35 },
}
