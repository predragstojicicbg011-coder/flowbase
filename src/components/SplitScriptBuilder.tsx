import React, { useMemo, useState } from 'react'
import SearchableSelect from './SearchableSelect'
import InlineCategoryAdd from './InlineCategoryAdd'
import { DIALOG } from './dialogTheme'
import { saveScript, whyNotSavable, type ScriptDraft } from '../services/quickFillStore'
import type { ScriptLike } from '../services/expenseSplit'

// ── Making a template from inside a split ───────────────────────────────────
//
// A split line is a template and a figure, which works until the cost in front
// of you has no template yet — and then the only way forward is to abandon the
// split, go to Settings, make one, and come back. That is three steps for
// something that should be one.
//
// ── Why pickers and not free text ───────────────────────────────────────────
//
// A template's classification has to name headings the ledger already has. One
// character out creates a second heading beside the real one and the P&L shows
// both, each holding part of the month, and neither looking wrong — which is
// the fault `checkPlan` exists to catch in the payroll and the same one that
// put `Salary Expenses Domestic` beside `Salary expenses domestic`.
//
// So every field is a picker over the real lookup tables, with the same `+`
// beside it the entry dialogs use, so a genuinely new heading can still be
// added — deliberately, and once.

export interface ClassificationOptions {
  plCategories: { id: string; name: string; type?: string }[]
  plSubcategories: { id: string; name: string; category_id?: string }[]
  departments: { id: string; name: string }[]
  deptSubcategories: { id: string; name: string; department_id?: string }[]
  expenseDescriptions: { id: string; name: string; dept_subcategory_id?: string }[]
}

export interface SplitScriptBuilderProps {
  options: ClassificationOptions
  /** Every template there is, so a clashing name is refused by name. */
  scripts: ScriptLike[]
  client: any
  onClose: () => void
  /** The template as saved, so the line can take it straight away. */
  onSaved: (script: ScriptLike) => void
}

export default function SplitScriptBuilder({
  options, scripts, client, onClose, onSaved,
}: SplitScriptBuilderProps) {
  const [name, setName] = useState('')
  const [icon, setIcon] = useState('⚡')
  const [plCat, setPlCat] = useState('')
  const [plSub, setPlSub] = useState('')
  const [dept, setDept] = useState('')
  const [deptSub, setDeptSub] = useState('')
  const [expDesc, setExpDesc] = useState('')
  const [revAlloc, setRevAlloc] = useState('shared')
  const [opexType, setOpexType] = useState('opex')
  const [cfType, setCfType] = useState('recurring')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')

  // Local copies, so a heading added through one of the `+` buttons is
  // selectable immediately rather than after the dialog is reopened.
  const [cats, setCats] = useState(options.plCategories)
  const [subs, setSubs] = useState(options.plSubcategories)
  const [depts, setDepts] = useState(options.departments)
  const [deptSubs, setDeptSubs] = useState(options.deptSubcategories)
  const [descs, setDescs] = useState(options.expenseDescriptions)

  const nameOf = (list: { id: string; name: string }[], id: string) =>
    list.find(x => x.id === id)?.name || ''

  // Narrowed by the parent above them, the way the entry dialogs narrow them:
  // a sub-category belongs to one category, and offering all of them is how
  // one ends up filed under a parent it does not belong to.
  const subsHere = useMemo(
    () => subs.filter(x => !plCat || !x.category_id || x.category_id === plCat), [subs, plCat])
  const deptSubsHere = useMemo(
    () => deptSubs.filter(x => !dept || !x.department_id || x.department_id === dept), [deptSubs, dept])
  const descsHere = useMemo(
    () => descs.filter(x => !deptSub || !x.dept_subcategory_id || x.dept_subcategory_id === deptSub),
    [descs, deptSub])

  const draft: ScriptDraft = {
    name: name.trim(), icon,
    pl_category: nameOf(cats, plCat),
    pl_subcategory: nameOf(subs, plSub),
    department: nameOf(depts, dept),
    dept_subcategory: nameOf(deptSubs, deptSub),
    expense_description: nameOf(descs, expDesc),
    rev_alloc: revAlloc, opex_type: opexType, cf_type: cfType,
  }

  /**
   * Why it cannot be saved.
   *
   * The name rule is the store's own — it is what the unique index compares —
   * and the category is required here because a template that classifies
   * nothing is a template that puts a line in Unassigned while looking like it
   * did something.
   */
  const why = whyNotSavable(draft, scripts)
    || (!draft.pl_category ? 'Pick a P&L category — a template that classifies nothing files a line under Unassigned.' : null)

  const save = async () => {
    if (why) { setError(why); return }
    setBusy(true); setError('')
    const { ok, message } = await saveScript(client, draft)
    setBusy(false)
    if (!ok) { setError(message); return }
    onSaved({ id: '', ...draft } as unknown as ScriptLike)
  }

  const field = (label: string, node: React.ReactNode) => (
    <div style={{ flex: 1, minWidth: '180px' }}>
      <div style={s.lbl}>{label}</div>
      {node}
    </div>
  )

  return (
    <div style={s.wrap}>
      <div style={s.head}>
        <span style={s.title}>New template</span>
        <button type="button" style={s.ghost} onClick={onClose}>Cancel</button>
      </div>

      {error && <div style={s.problem}>{error}</div>}

      <div style={s.row}>
        {field('Name', (
          <input style={s.input} value={name} autoFocus
            placeholder="e.g. Lease — garage spaces"
            onChange={e => setName(e.target.value)} />
        ))}
        {field('Icon', (
          <input style={{ ...s.input, width: '70px' }} value={icon} maxLength={2}
            onChange={e => setIcon(e.target.value)} />
        ))}
      </div>

      <div style={s.row}>
        {field('P&L category *', (
          <div style={s.withAdd}>
            <div style={s.grow}><SearchableSelect value={plCat}
              onChange={v => { setPlCat(v); setPlSub('') }}
              options={cats.filter(c => c.type !== 'revenue').map(c => ({ value: c.id, label: c.name }))}
              allLabel="Select…" style={s.input} /></div>
            <InlineCategoryAdd table="pl_categories" currentCount={cats.length}
              onAdded={item => { setCats(p => [...p, { ...item, type: 'expense' }]); setPlCat(item.id) }} />
          </div>
        ))}
        {field('P&L sub-category', (
          <div style={s.withAdd}>
            <div style={s.grow}><SearchableSelect value={plSub} onChange={setPlSub}
              options={subsHere.map(c => ({ value: c.id, label: c.name }))}
              allLabel="Select…" disabled={!plCat} style={s.input} /></div>
            <InlineCategoryAdd table="pl_subcategories" parentId={plCat} parentField="category_id"
              currentCount={subsHere.length} disabled={!plCat}
              onAdded={item => { setSubs(p => [...p, { ...item, category_id: plCat }]); setPlSub(item.id) }} />
          </div>
        ))}
      </div>

      <div style={s.row}>
        {field('Department', (
          <div style={s.withAdd}>
            <div style={s.grow}><SearchableSelect value={dept}
              onChange={v => { setDept(v); setDeptSub(''); setExpDesc('') }}
              options={depts.map(c => ({ value: c.id, label: c.name }))}
              allLabel="Select…" style={s.input} /></div>
            <InlineCategoryAdd table="departments" currentCount={depts.length}
              onAdded={item => { setDepts(p => [...p, item]); setDept(item.id) }} />
          </div>
        ))}
        {field('Dept. sub-category', (
          <div style={s.withAdd}>
            <div style={s.grow}><SearchableSelect value={deptSub}
              onChange={v => { setDeptSub(v); setExpDesc('') }}
              options={deptSubsHere.map(c => ({ value: c.id, label: c.name }))}
              allLabel="Select…" disabled={!dept} style={s.input} /></div>
            <InlineCategoryAdd table="dept_subcategories" parentId={dept} parentField="department_id"
              currentCount={deptSubsHere.length} disabled={!dept}
              onAdded={item => { setDeptSubs(p => [...p, { ...item, department_id: dept }]); setDeptSub(item.id) }} />
          </div>
        ))}
      </div>

      <div style={s.row}>
        {field('Expense description', (
          <div style={s.withAdd}>
            <div style={s.grow}><SearchableSelect value={expDesc} onChange={setExpDesc}
              options={descsHere.map(c => ({ value: c.id, label: c.name }))}
              allLabel="Select…" disabled={!deptSub} style={s.input} /></div>
            <InlineCategoryAdd table="expense_descriptions" parentId={deptSub}
              parentField="dept_subcategory_id" currentCount={descsHere.length} disabled={!deptSub}
              onAdded={item => { setDescs(p => [...p, { ...item, dept_subcategory_id: deptSub }]); setExpDesc(item.id) }} />
          </div>
        ))}
        {field('Revenue stream', (
          <select style={s.input} value={revAlloc} onChange={e => setRevAlloc(e.target.value)}>
            <option value="shared">Shared</option>
            <option value="sg100">100% Social Growth</option>
            <option value="af100">100% Aimfox</option>
          </select>
        ))}
      </div>

      <div style={s.row}>
        {field('Expense type', (
          <select style={s.input} value={opexType} onChange={e => setOpexType(e.target.value)}>
            <option value="opex">OPEX</option>
            <option value="performance">Performance</option>
          </select>
        ))}
        {field('Cash flow', (
          <select style={s.input} value={cfType} onChange={e => setCfType(e.target.value)}>
            <option value="recurring">Recurring</option>
            <option value="one_off">One-off</option>
            <option value="seasonal">Seasonal</option>
          </select>
        ))}
      </div>

      <div style={{ display: 'flex', alignItems: 'center', gap: '10px', marginTop: '10px' }}>
        <button type="button" style={{ ...s.save, opacity: busy || why ? 0.55 : 1 }}
          onClick={save} disabled={busy || !!why} title={why || undefined}>
          {busy ? 'Saving…' : 'Save and use it'}
        </button>
        <span style={s.hint}>
          Saved for everyone, and available in every dialog from now on.
        </span>
      </div>
    </div>
  )
}

const s: Record<string, React.CSSProperties> = {
  wrap: {
    border: `1px solid ${DIALOG.accent}44`, borderRadius: '10px',
    padding: '12px 13px', background: 'rgba(0,212,126,0.04)', margin: '2px 0 10px',
  },
  head: { display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: '10px' },
  title: {
    fontSize: '10px', fontWeight: 600, color: DIALOG.accent,
    textTransform: 'uppercase', letterSpacing: '0.09em',
  },
  row: { display: 'flex', gap: '10px', marginBottom: '9px', flexWrap: 'wrap' },
  lbl: {
    fontSize: '9.5px', fontWeight: 600, color: DIALOG.faint,
    textTransform: 'uppercase', letterSpacing: '0.08em', marginBottom: '4px',
  },
  withAdd: { display: 'flex', gap: '6px', alignItems: 'flex-start' },
  /** The picker's own `flex` lands on its button, not its root, so the root
   *  is given one of its own or the control stays as narrow as its label. */
  grow: { flex: 1, minWidth: 0 },
  input: {
    width: '100%', boxSizing: 'border-box', fontFamily: "'Inter', sans-serif",
    fontSize: '12.5px', padding: '7px 10px', border: `1px solid ${DIALOG.border}`,
    borderRadius: '8px', background: DIALOG.panel, color: DIALOG.text, outline: 'none',
  },
  save: {
    fontFamily: "'Inter', system-ui, sans-serif", fontSize: '12px', fontWeight: 600,
    padding: '7px 15px', borderRadius: '8px', border: 'none',
    background: DIALOG.accent, color: '#060E1A', cursor: 'pointer',
  },
  ghost: {
    background: 'transparent', border: `1px solid ${DIALOG.border}`, borderRadius: '7px',
    color: DIALOG.dim, fontSize: '10.5px', padding: '3px 9px', cursor: 'pointer',
    fontFamily: "'Inter', system-ui, sans-serif",
  },
  hint: { fontSize: '11px', color: DIALOG.faint },
  problem: {
    marginBottom: '9px', fontSize: '11.5px', color: DIALOG.amber, lineHeight: 1.55,
  },
}
