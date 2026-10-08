import React, { useCallback, useEffect, useMemo, useState } from 'react'
import { supabase } from '../supabase'
import { runWrite } from '../services/writeOrder'
import {
  sortScripts, toRow, whyNotSavable,
  type ScriptDraft,
} from '../services/quickFillStore'

// ── Classification templates ────────────────────────────────────────────────
//
// One place to see and change the shortcuts that fill in a classification.
// They used to live in `localStorage` and be edited from inside whichever
// entry dialog you happened to be in, which meant there was no list of them
// anywhere and no way to fix one without starting to post something.
//
// 20260922140000 moved them into the database, organisation-wide. This is the
// tab that reads and writes that table.
//
// The classification fields are plain text on purpose. A template names a
// category rather than pointing at its id — that is how the dialogs apply it,
// by writing the NAME onto the entry — so validating against the current
// chart of accounts here would refuse templates that are merely ahead of it.
// The list shows which of them no longer match anything instead.

const BLANK: ScriptDraft = {
  name: '', icon: '⚡', pl_category: '', pl_subcategory: '', department: '',
  dept_subcategory: '', expense_description: '', rev_alloc: 'shared',
  opex_type: 'opex', cf_type: '',
}

const REV_ALLOC = [
  { value: 'sg100', label: '100% Social Growth' },
  { value: 'af100', label: '100% Aimfox' },
  { value: 'shared', label: 'Shared 50/50' },
  { value: 'byval', label: 'By value' },
]
const OPEX = [
  { value: 'opex', label: '100% OPEX' },
  { value: 'performance', label: '100% Performance' },
  { value: 'split', label: 'Split by value' },
]
const CF = [
  { value: '', label: '— none —' },
  { value: 'recurring', label: 'Recurring' },
  { value: 'one_time', label: 'One-time' },
  { value: 'accrual', label: 'Accrual' },
  { value: 'capex', label: 'CapEx' },
  { value: 'reimbursable', label: 'Reimbursable' },
]

export default function QuickFillTab({ canEdit }: { canEdit: boolean }) {
  const [scripts, setScripts] = useState<any[]>([])
  const [loading, setLoading] = useState(true)
  const [draft, setDraft] = useState<ScriptDraft | null>(null)
  const [error, setError] = useState('')
  const [notice, setNotice] = useState('')
  const [search, setSearch] = useState('')

  /** What the chart of accounts currently has, to flag a template that names something retired. */
  const [knownCategories, setKnownCategories] = useState<Set<string>>(new Set())
  const [knownDepartments, setKnownDepartments] = useState<Set<string>>(new Set())

  const load = useCallback(async () => {
    setLoading(true)
    const [{ data, error: err }, { data: cats }, { data: depts }] = await Promise.all([
      supabase.from('quick_fill_scripts').select('*'),
      supabase.from('pl_categories').select('name'),
      supabase.from('departments').select('name'),
    ])
    if (err) setError(`The templates could not be read: ${err.message}`)
    setScripts(sortScripts(data || []))
    setKnownCategories(new Set((cats || []).map((c: any) => c.name)))
    setKnownDepartments(new Set((depts || []).map((d: any) => d.name)))
    setLoading(false)
  }, [])

  useEffect(() => { load() }, [load])

  const visible = useMemo(() => {
    const q = search.trim().toLowerCase()
    if (!q) return scripts
    return scripts.filter(sc => [sc.name, sc.pl_category, sc.pl_subcategory, sc.department,
      sc.dept_subcategory, sc.expense_description]
      .some((v: string) => (v || '').toLowerCase().includes(q)))
  }, [scripts, search])

  const save = async () => {
    if (!draft) return
    const why = whyNotSavable(draft, scripts)
    if (why) { setError(why); return }
    setError(''); setNotice('')

    const row = toRow(draft)
    const ok = draft.id
      ? await reportWrite('Save the template', supabase.from('quick_fill_scripts')
          .update({ ...row, updated_at: new Date().toISOString() }).eq('id', draft.id).select('id'))
      : await reportWrite('Add the template', supabase.from('quick_fill_scripts')
          .insert(row).select('id'))
    if (!ok) return
    setDraft(null)
    await load()
  }

  const remove = async (sc: any) => {
    if (!window.confirm(
      `Delete the template "${sc.name}"?\n\n`
      + 'Entries already classified with it keep their classification — a template '
      + 'is copied onto an entry, not referenced by it. Only the shortcut goes.')) return
    setError(''); setNotice('')
    const ok = await reportWrite('Delete the template',
      supabase.from('quick_fill_scripts').delete().eq('id', sc.id).select('id'))
    if (ok) await load()
  }

  const field = (label: string, key: keyof ScriptDraft, placeholder = '') => (
    <div style={s.field}>
      <label style={s.label}>{label}</label>
      <input style={s.input} placeholder={placeholder}
        value={(draft?.[key] as string) || ''}
        onChange={e => setDraft(d => d ? { ...d, [key]: e.target.value } : d)} />
    </div>
  )

  const choice = (label: string, key: keyof ScriptDraft, options: { value: string; label: string }[]) => (
    <div style={s.field}>
      <label style={s.label}>{label}</label>
      <select style={s.input} value={(draft?.[key] as string) ?? ''}
        onChange={e => setDraft(d => d ? { ...d, [key]: e.target.value } : d)}>
        {options.map(o => <option key={o.value} value={o.value}>{o.label}</option>)}
      </select>
    </div>
  )

  return (
    <div style={s.wrap}>
      <div style={s.head}>
        <div>
          <div style={s.title}>Classification templates</div>
          <div style={s.sub}>
            Shortcuts that fill in a whole classification at once. Shared with everyone —
            they are the chart of accounts written as a shortcut, not a personal setting.
          </div>
        </div>
        {canEdit && (
          <button style={s.primary} onClick={() => { setDraft({ ...BLANK }); setError('') }}>
            + New template
          </button>
        )}
      </div>

      {error && <div style={s.error}>{error}</div>}
      {notice && <div style={s.notice}>{notice}</div>}

      {draft && (
        <div style={s.editor}>
          <div style={s.editorTitle}>{draft.id ? 'Edit template' : 'New template'}</div>
          <div style={s.grid}>
            {field('Name', 'name', 'e.g. Bank fee — domestic')}
            {field('Icon', 'icon', '⚡')}
            {field('P&L category', 'pl_category')}
            {field('P&L sub-category', 'pl_subcategory')}
            {field('Department', 'department')}
            {field('Dept. sub-category', 'dept_subcategory')}
            {field('Expense description', 'expense_description')}
            {choice('Revenue allocation', 'rev_alloc', REV_ALLOC)}
            {choice('Expense type', 'opex_type', OPEX)}
            {choice('Cash flow type', 'cf_type', CF)}
          </div>
          <div style={s.editorFoot}>
            <span style={s.hint}>
              A level left blank is left blank on the entry. The name is the only thing required.
            </span>
            <div style={{ display: 'flex', gap: '8px' }}>
              <button style={s.ghost} onClick={() => { setDraft(null); setError('') }}>Cancel</button>
              <button style={s.primary} onClick={save}>Save</button>
            </div>
          </div>
        </div>
      )}

      <input style={{ ...s.input, marginBottom: '10px' }} placeholder="Search templates…"
        value={search} onChange={e => setSearch(e.target.value)} />

      {loading ? (
        <div style={s.empty}>Loading…</div>
      ) : visible.length === 0 ? (
        <div style={s.empty}>
          {scripts.length === 0
            ? 'No templates yet. Create one, or import what this browser still holds.'
            : 'No template matches that.'}
        </div>
      ) : (
        <div style={s.list}>
          {visible.map(sc => {
            const staleCat = sc.pl_category && !knownCategories.has(sc.pl_category)
            const staleDept = sc.department && !knownDepartments.has(sc.department)
            return (
              <div key={sc.id} style={s.row}>
                <span style={s.icon}>{sc.icon || '⚡'}</span>
                <div style={{ flex: 1, minWidth: 0 }}>
                  <div style={s.name}>{sc.name}</div>
                  <div style={s.path}>
                    {[sc.pl_category, sc.pl_subcategory].filter(Boolean).join(' / ') || '—'}
                    {' · '}
                    {[sc.department, sc.dept_subcategory, sc.expense_description].filter(Boolean).join(' / ') || '—'}
                  </div>
                  {(staleCat || staleDept) && (
                    <div style={s.stale}>
                      Names {staleCat && !staleDept ? 'a P&L category' : staleDept && !staleCat ? 'a department' : 'a category and a department'} that
                      no longer exists — entries made with it will carry a classification nothing else uses.
                    </div>
                  )}
                </div>
                {canEdit && (
                  <div style={{ display: 'flex', gap: '6px' }}>
                    <button style={s.ghost} onClick={() => { setDraft({ ...sc }); setError('') }}>Edit</button>
                    <button style={s.danger} onClick={() => remove(sc)}>Delete</button>
                  </div>
                )}
              </div>
            )
          })}
        </div>
      )}
    </div>
  )
}

/** Same shape as the other tabs: run the write, and say why if it is refused. */
async function reportWrite(label: string, q: any): Promise<boolean> {
  const { ok, message } = await runWrite(label, q)
  if (!ok) window.alert(message)
  return ok
}

const s: Record<string, React.CSSProperties> = {
  wrap: { background: '#0D1B2C', border: '1px solid rgba(255,255,255,0.075)', borderRadius: '10px', padding: '1.25rem' },
  head: { display: 'flex', alignItems: 'flex-start', justifyContent: 'space-between', gap: '16px', marginBottom: '14px' },
  title: { fontSize: '15px', fontWeight: '500', color: '#DCE9F6', marginBottom: '4px' },
  sub: { fontSize: '12px', color: '#7A9BB8', lineHeight: 1.5, maxWidth: '640px' },
  primary: { fontFamily: 'system-ui,sans-serif', fontSize: '12.5px', padding: '8px 14px', border: 'none', borderRadius: '8px', background: '#00D47E', color: '#06231A', fontWeight: '600', cursor: 'pointer', whiteSpace: 'nowrap' },
  ghost: { fontFamily: 'system-ui,sans-serif', fontSize: '12px', padding: '7px 12px', borderRadius: '7px', border: '1px solid rgba(255,255,255,0.12)', background: 'transparent', color: '#7A9BB8', cursor: 'pointer' },
  danger: { fontFamily: 'system-ui,sans-serif', fontSize: '12px', padding: '7px 12px', borderRadius: '7px', border: '1px solid rgba(255,91,90,0.3)', background: 'transparent', color: '#FF5B5A', cursor: 'pointer' },
  error: { fontSize: '12.5px', color: '#FF5B5A', background: 'rgba(255,91,90,0.10)', border: '0.5px solid rgba(255,91,90,0.35)', borderRadius: '8px', padding: '9px 12px', marginBottom: '10px', lineHeight: 1.5 },
  notice: { fontSize: '12.5px', color: '#00D47E', background: 'rgba(0,212,126,0.08)', border: '0.5px solid rgba(0,212,126,0.3)', borderRadius: '8px', padding: '9px 12px', marginBottom: '10px', lineHeight: 1.5 },
  editor: { border: '1px solid rgba(0,212,126,0.3)', borderRadius: '10px', padding: '14px', marginBottom: '14px', background: 'rgba(0,212,126,0.03)' },
  editorTitle: { fontSize: '13px', fontWeight: '500', color: '#DCE9F6', marginBottom: '12px' },
  grid: { display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(220px, 1fr))', gap: '10px' },
  editorFoot: { display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: '16px', marginTop: '14px' },
  hint: { fontSize: '11px', color: '#7A9BB8', lineHeight: 1.4 },
  field: { display: 'flex', flexDirection: 'column', gap: '4px' },
  label: { fontSize: '10.5px', color: '#7A9BB8', textTransform: 'uppercase', letterSpacing: '0.06em' },
  input: { fontFamily: 'system-ui,sans-serif', fontSize: '13px', padding: '8px 10px', border: '1px solid rgba(255,255,255,0.10)', borderRadius: '8px', background: '#111F30', color: '#DCE9F6', outline: 'none', width: '100%', boxSizing: 'border-box' },
  list: { display: 'flex', flexDirection: 'column', gap: '6px' },
  row: { display: 'flex', alignItems: 'center', gap: '12px', padding: '10px 12px', borderRadius: '8px', border: '1px solid rgba(255,255,255,0.06)', background: 'rgba(255,255,255,0.02)' },
  icon: { fontSize: '16px', width: '22px', textAlign: 'center' },
  name: { fontSize: '13px', fontWeight: '500', color: '#DCE9F6' },
  path: { fontSize: '11px', color: '#7A9BB8', marginTop: '2px' },
  stale: { fontSize: '11px', color: '#F5A623', marginTop: '3px', lineHeight: 1.4 },
  empty: { padding: '28px', textAlign: 'center', color: '#7A9BB8', fontSize: '13px' },
}
