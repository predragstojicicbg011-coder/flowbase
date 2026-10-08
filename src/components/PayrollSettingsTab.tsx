import React, { useCallback, useEffect, useMemo, useState } from 'react'
import { supabase } from '../supabase'
import { runWrite } from '../services/writeOrder'
import {
  fetchSettings, missingFor, monthStart, whyNotSavable,
  type SettingRow,
} from '../services/payroll/settings'

// ── Payroll settings ────────────────────────────────────────────────────────
//
// Fifty-two figures, each shown with the dates it was in force rather than as
// a single current value. That is the whole point of the screen: a payroll run
// for last August has to use last August's tax-free amount, so the history is
// not an audit trail bolted on, it is the data.
//
// Which is why a change here does not edit a row. Entering a new value ENDS
// the current one on the day the new one starts and inserts a successor —
// editing in place would rewrite what last year cost and nothing would say so.
// Correcting a typo is a separate, explicit action, and it says what it is.
//
// EVERY SETTING IS SHOWN IN ENGLISH, with MPP's own Cyrillic wording under it.
// Both, because they answer different questions: the English says what the
// setting DOES, and the Cyrillic is what somebody types into the accountant's
// search box while holding the two screens side by side. Showing only the
// Cyrillic made the rest of the application bilingual for no gain; showing only
// the English would take away the one string that matches MPP.
//
// TEN OF THEM ARE CHOICES, NOT AMOUNTS, and those get a dropdown. Typed into a
// text box they are a spelling test — "сати редовног рада" and "сати редовног
// рада без службеног пута" differ by three words, both look right, and the
// wrong one changes what a month costs with nothing on screen to show for it.
// The value STORED stays the Serbian one, because that is what MPP means by it.

type Row = SettingRow & { id: string }

/** One of the named alternatives a choice-valued setting allows. */
interface Option { value: string; label: string }

function optionsOf(row: Row): Option[] | null {
  const raw = row.options
  if (!raw) return null
  const list = typeof raw === 'string' ? safeParse(raw) : raw
  return Array.isArray(list) && list.length > 0 ? list as Option[] : null
}

function safeParse(text: string): unknown {
  // A malformed list must not take the whole tab down with it; the setting
  // falls back to a plain text box, which still works.
  try { return JSON.parse(text) } catch { return null }
}

/** What to call a setting. English where there is any, MPP wording otherwise. */
function titleOf(row: Row): string {
  return row.label_en || row.label
}

/**
 * The value as it is STORED, which is what the editor must start from.
 *
 * Not `displayValue`: for a choice that returns the English wording, and a
 * dropdown handed "Yes" where its options are "да" and "не" matches nothing,
 * quietly falls back to the first option, and saves that instead. The setting
 * would change because somebody opened the editor.
 */
function storedValue(row: Row): string {
  if (row.value_numeric !== null) return String(row.value_numeric)
  return row.value_text || ''
}

/** The English for a stored value, where the setting is a choice. */
function displayValue(row: Row): string {
  if (row.value_numeric !== null) return String(row.value_numeric)
  const text = row.value_text || ''
  const found = optionsOf(row)?.find(o => o.value === text)
  return found ? found.label : (text || '—')
}

const GROUP_TITLES: Record<string, string> = {
  hours: 'Hour fund',
  configuration: 'How a salary is composed',
  coefficients: 'Coefficients',
  rates: 'Tax and contribution rates',
  bases: 'Bases and thresholds',
}

const GROUP_ORDER = ['rates', 'bases', 'hours', 'coefficients', 'configuration']

/** The month whose figures the page is showing. */
const thisMonth = () => new Date().toISOString().slice(0, 7)

export default function PayrollSettingsTab({ canEdit }: { canEdit: boolean }) {
  const [rows, setRows] = useState<Row[]>([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState('')
  const [notice, setNotice] = useState('')
  const [month, setMonth] = useState(thisMonth)
  const [search, setSearch] = useState('')
  const [showHistory, setShowHistory] = useState<string | null>(null)

  /** The setting being given a new value, and from when. */
  const [changing, setChanging] = useState<{ row: Row; value: string; from: string } | null>(null)

  const load = useCallback(async () => {
    setLoading(true)
    try {
      setRows(await fetchSettings(supabase))
      setError('')
    } catch (e: any) {
      setError(e.message)
    }
    setLoading(false)
  }, [])

  useEffect(() => { load() }, [load])

  const asOf = monthStart(month)

  /** One row per setting: the value in force for the chosen month. */
  const current = useMemo(() => {
    const byKey = new Map<string, Row>()
    for (const r of rows) {
      if (r.valid_from > asOf) continue
      if (r.valid_to && r.valid_to <= asOf) continue
      if (!byKey.has(r.setting_key)) byKey.set(r.setting_key, r)
    }
    const q = search.trim().toLowerCase()
    return Array.from(byKey.values())
      .filter(r => !q
        || titleOf(r).toLowerCase().includes(q)
        || r.label.toLowerCase().includes(q)
        || r.setting_key.includes(q))
      .sort((a, b) =>
        GROUP_ORDER.indexOf(a.group_key) - GROUP_ORDER.indexOf(b.group_key)
        || titleOf(a).localeCompare(titleOf(b)))
  }, [rows, asOf, search])

  /** What the engine is missing for this month, said before a run is attempted. */
  const missing = useMemo(() => missingFor(rows, asOf), [rows, asOf])

  const historyFor = (key: string) =>
    rows.filter(r => r.setting_key === key)
      .sort((a, b) => b.valid_from.localeCompare(a.valid_from))

  const saveChange = async () => {
    if (!changing) return
    const { row, value, from } = changing
    const isNumeric = row.value_numeric !== null

    if (isNumeric && !Number.isFinite(parseFloat(value))) {
      setError('That is not a number.'); return
    }
    const why = whyNotSavable(
      { setting_key: row.setting_key, valid_from: from, valid_to: null }, rows)
    if (why) { setError(why); return }

    setError(''); setNotice('')

    // The old value is ENDED, not edited. Rewriting it in place would change
    // what an already-calculated month cost, silently.
    const closed = await runWrite('End the current value',
      supabase.from('payroll_settings')
        .update({ valid_to: from, updated_at: new Date().toISOString() })
        .eq('id', row.id).select('id'))
    if (!closed.ok) { window.alert(closed.message); return }

    const added = await runWrite('Add the new value',
      supabase.from('payroll_settings').insert({
        group_key: row.group_key,
        setting_key: row.setting_key,
        label: row.label,
        value_numeric: isNumeric ? parseFloat(value) : null,
        value_text: isNumeric ? null : value,
        valid_from: from,
        valid_to: null,
        note: `Replaces the value in force from ${row.valid_from}.`,
      }).select('id'))
    if (!added.ok) {
      // The close landed and the insert did not, which leaves the setting with
      // no value from that date. Say exactly that rather than "failed".
      window.alert(
        `${added.message}\n\nThe previous value was ended on ${from} but the new one was `
        + 'not saved, so this setting now has no value from that date. Add it, or reopen '
        + 'the old one by clearing its end date.')
      await load()
      return
    }

    setNotice(`${row.label} — new value in force from ${from}. The previous one keeps its dates.`)
    setChanging(null)
    await load()
  }

  const show = (r: Row) => displayValue(r)

  return (
    <div style={s.wrap}>
      <div style={s.head}>
        <div>
          <div style={s.title}>Payroll settings</div>
          <div style={s.sub}>
            Every figure a payroll run needs, and the dates it was in force. A run for an
            earlier month uses that month's figures, not today's — so a new value never
            replaces an old one, it succeeds it.
          </div>
        </div>
        <div style={s.field}>
          <label style={s.label}>Showing figures for</label>
          <input type="month" style={s.input} value={month}
            onChange={e => setMonth(e.target.value)} />
        </div>
      </div>

      {error && <div style={s.error}>{error}</div>}
      {notice && <div style={s.notice}>{notice}</div>}

      {!loading && missing.length > 0 && (
        <div style={s.error}>
          No value covers {asOf} for: {missing.join(', ')}. A payroll run for this month
          will be refused rather than calculated from whatever figures are nearest —
          a plausible total for a month whose rates nobody knows is worse than none.
        </div>
      )}

      {changing && (
        <div style={s.editor}>
          <div style={s.editorTitle}>{titleOf(changing.row)}</div>
          {changing.row.label_en && (
            <div style={s.original}>{changing.row.label}</div>
          )}
          <div style={s.editorNote}>
            In force since {changing.row.valid_from}: <strong>{show(changing.row)}</strong>.
            Saving ends that on the date below and starts the new value there. Months
            already calculated keep the old figure.
          </div>
          <div style={{ display: 'flex', gap: '10px', alignItems: 'flex-end', marginTop: '10px', flexWrap: 'wrap' }}>
            <div style={s.field}>
              <label style={s.label}>New value</label>
              {optionsOf(changing.row) ? (
                <select style={s.input} autoFocus value={changing.value}
                  onChange={e => setChanging({ ...changing, value: e.target.value })}>
                  {optionsOf(changing.row)!.map(o => (
                    <option key={o.value} value={o.value}>{o.label}</option>
                  ))}
                </select>
              ) : (
              <input style={s.input} autoFocus value={changing.value}
                onChange={e => setChanging(c => c ? { ...c, value: e.target.value } : c)} />
              )}
            </div>
            <div style={s.field}>
              <label style={s.label}>In force from</label>
              <input type="date" style={s.input} value={changing.from}
                onChange={e => setChanging(c => c ? { ...c, from: e.target.value } : c)} />
            </div>
            <button style={s.primary} onClick={saveChange}>Save</button>
            <button style={s.ghost} onClick={() => { setChanging(null); setError('') }}>Cancel</button>
          </div>
        </div>
      )}

      <input style={{ ...s.input, marginBottom: '10px' }} placeholder="Search settings…"
        value={search} onChange={e => setSearch(e.target.value)} />

      {loading ? (
        <div style={s.empty}>Loading…</div>
      ) : current.length === 0 ? (
        <div style={s.empty}>
          {rows.length === 0 ? 'No payroll settings yet.' : `Nothing matches that, or nothing was in force in ${month}.`}
        </div>
      ) : (
        GROUP_ORDER.filter(g => current.some(r => r.group_key === g)).map(group => (
          <div key={group} style={{ marginBottom: '16px' }}>
            <div style={s.groupTitle}>{GROUP_TITLES[group] || group}</div>
            {current.filter(r => r.group_key === group).map(r => {
              const history = historyFor(r.setting_key)
              const open = showHistory === r.setting_key
              return (
                <div key={r.id} style={s.row}>
                  <div style={{ flex: 1, minWidth: 0 }}>
                    <div style={s.name}>{titleOf(r)}</div>
                    {r.label_en && (
                      <div style={s.original} title="MPP wording, for searching their screen">
                        {r.label}
                      </div>
                    )}
                    <div style={s.meta}>
                      <code style={s.key}>{r.setting_key}</code>
                      {' · in force from '}{r.valid_from}
                      {r.valid_to ? ` to ${r.valid_to}` : ''}
                      {history.length > 1 && (
                        <button style={s.linkBtn}
                          onClick={() => setShowHistory(open ? null : r.setting_key)}>
                          {open ? 'hide' : `${history.length} values over time`}
                        </button>
                      )}
                    </div>
                    {open && (
                      <div style={s.history}>
                        {history.map(h => (
                          <div key={h.id} style={{ ...s.historyRow, opacity: h.id === r.id ? 1 : 0.65 }}>
                            <span style={s.historyValue}>{show(h)}</span>
                            <span>{h.valid_from} → {h.valid_to || 'still in force'}</span>
                            {h.id === r.id && <span style={s.inForce}>shown above</span>}
                          </div>
                        ))}
                      </div>
                    )}
                    {r.note && !open && <div style={s.noteText}>{r.note}</div>}
                  </div>
                  <div style={s.value}>{show(r)}</div>
                  {canEdit && (
                    <button style={s.ghost}
                      title="Give this setting a new value from a date. The current one keeps its own."
                      onClick={() => {
                        setError('')
                        setChanging({ row: r, value: storedValue(r), from: asOf })
                      }}>
                      New value
                    </button>
                  )}
                </div>
              )
            })}
          </div>
        ))
      )}
    </div>
  )
}

const s: Record<string, React.CSSProperties> = {
  wrap: { background: '#0D1B2C', border: '1px solid rgba(255,255,255,0.075)', borderRadius: '10px', padding: '1.25rem' },
  head: { display: 'flex', alignItems: 'flex-start', justifyContent: 'space-between', gap: '16px', marginBottom: '14px', flexWrap: 'wrap' },
  title: { fontSize: '15px', fontWeight: '500', color: '#DCE9F6', marginBottom: '4px' },
  sub: { fontSize: '12px', color: '#7A9BB8', lineHeight: 1.5, maxWidth: '640px' },
  groupTitle: { fontSize: '10px', color: 'rgba(255,255,255,0.35)', textTransform: 'uppercase', letterSpacing: '0.09em', margin: '0 0 6px 2px' },
  row: { display: 'flex', alignItems: 'center', gap: '12px', padding: '9px 12px', borderRadius: '8px', border: '1px solid rgba(255,255,255,0.06)', background: 'rgba(255,255,255,0.02)', marginBottom: '5px' },
  name: { fontSize: '12.5px', color: '#DCE9F6', lineHeight: 1.4 },
  original: { fontSize: '10.5px', color: 'rgba(255,255,255,0.32)', marginTop: '1px', lineHeight: 1.35 },
  meta: { fontSize: '10.5px', color: '#7A9BB8', marginTop: '3px', display: 'flex', alignItems: 'center', gap: '6px', flexWrap: 'wrap' },
  key: { fontFamily: "'DM Mono', monospace", fontSize: '10px', color: 'rgba(255,255,255,0.35)' },
  value: { fontFamily: "'DM Mono', monospace", fontSize: '13px', color: '#00D47E', whiteSpace: 'nowrap', textAlign: 'right', minWidth: '110px' },
  noteText: { fontSize: '10.5px', color: 'rgba(255,255,255,0.3)', marginTop: '3px', lineHeight: 1.4 },
  history: { marginTop: '6px', paddingLeft: '10px', borderLeft: '2px solid rgba(255,255,255,0.08)' },
  historyRow: { display: 'flex', alignItems: 'center', gap: '10px', fontSize: '11px', color: '#7A9BB8', padding: '2px 0' },
  historyValue: { fontFamily: "'DM Mono', monospace", color: '#DCE9F6', minWidth: '90px' },
  inForce: { fontSize: '10px', color: '#00D47E' },
  linkBtn: { fontFamily: 'system-ui,sans-serif', fontSize: '10.5px', padding: 0, border: 'none', background: 'transparent', color: '#4EA8FF', cursor: 'pointer' },
  editor: { border: '1px solid rgba(0,212,126,0.3)', borderRadius: '10px', padding: '14px', marginBottom: '14px', background: 'rgba(0,212,126,0.03)' },
  editorTitle: { fontSize: '13px', fontWeight: '500', color: '#DCE9F6' },
  editorNote: { fontSize: '11.5px', color: '#7A9BB8', lineHeight: 1.5, marginTop: '5px' },
  field: { display: 'flex', flexDirection: 'column', gap: '4px' },
  label: { fontSize: '10.5px', color: '#7A9BB8', textTransform: 'uppercase', letterSpacing: '0.06em' },
  input: { fontFamily: 'system-ui,sans-serif', fontSize: '13px', padding: '8px 10px', border: '1px solid rgba(255,255,255,0.10)', borderRadius: '8px', background: '#111F30', color: '#DCE9F6', outline: 'none', boxSizing: 'border-box' },
  primary: { fontFamily: 'system-ui,sans-serif', fontSize: '12.5px', padding: '8px 14px', border: 'none', borderRadius: '8px', background: '#00D47E', color: '#06231A', fontWeight: '600', cursor: 'pointer' },
  ghost: { fontFamily: 'system-ui,sans-serif', fontSize: '12px', padding: '7px 12px', borderRadius: '7px', border: '1px solid rgba(255,255,255,0.12)', background: 'transparent', color: '#7A9BB8', cursor: 'pointer', whiteSpace: 'nowrap' },
  error: { fontSize: '12.5px', color: '#FF5B5A', background: 'rgba(255,91,90,0.10)', border: '0.5px solid rgba(255,91,90,0.35)', borderRadius: '8px', padding: '9px 12px', marginBottom: '10px', lineHeight: 1.5 },
  notice: { fontSize: '12.5px', color: '#00D47E', background: 'rgba(0,212,126,0.08)', border: '0.5px solid rgba(0,212,126,0.3)', borderRadius: '8px', padding: '9px 12px', marginBottom: '10px', lineHeight: 1.5 },
  empty: { padding: '28px', textAlign: 'center', color: '#7A9BB8', fontSize: '13px' },
}
