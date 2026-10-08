import React, { useEffect, useMemo, useState } from 'react'
import { supabase } from '../supabase'
import { DIALOG, chrome } from './dialogTheme'
import InlineCategoryAdd from './InlineCategoryAdd'
import BudgetChangeDialog from './BudgetChangeDialog'
import { classificationFor } from '../services/budgetKeys'
import ProjectSelect from './ProjectSelect'
import { useProjects } from '../contexts/ProjectsContext'
import { projectLabelById } from '../services/projects'
import type { Level } from '../services/budgetForecast'

// ─── Adding a budget line that has never been spent on ───────────────────────
//
// The tree is built from classifications that already appear in `v_pl_entries`
// or in the change ledger — money already spent, or already budgeted. There was
// no way in to a line that has neither, which is precisely what planning ahead
// is: "we will sponsor a conference in November" is a figure against a
// description nobody has ever paid for.
//
// This dialog is the way in. It does NOT write a budget figure itself: it picks
// the classification and the month, and hands both to `BudgetChangeDialog`,
// which is still the only thing in the app that appends to `budget_adjustments`.
// Two dialogs writing budget rows is two chances for one of them to forget the
// reason, or the delta, or the scope the row is recorded at.
//
// ── The half that is easy to leave out ──────────────────────────────────────
//
// A new name has to reach the LOOKUP TABLE, not only the ledger. A description
// that exists only as a budget line cannot be picked when the real invoice
// arrives three months later: the spend is classified to something else, the
// budgeted row sits at zero actual for ever, and the variance column quietly
// lies in both places. `InlineCategoryAdd` writes the lookup row and hands back
// `{id, name}` — it is beside every level here, not only the last one, for that
// reason.
//
// ── There is no company to ask for ──────────────────────────────────────────
//
// A budget line is the GROUP's: the ledger row carries `company_id: null` and
// this dialog asks nothing about companies. It briefly did — a required
// Company field above everything else — and that field was wrong on its own
// terms. The five tables it picks a line out of (`departments`,
// `dept_subcategories`, `expense_descriptions`, `pl_categories`,
// `pl_subcategories`) have no `company_id` at all: one chart of accounts for
// every company. A new expense description was never a per-company thing, so
// demanding a company before the `+` beside a level would write anything was
// refusing on behalf of a column those tables do not have.

type LookupTable =
  | 'pl_categories' | 'pl_subcategories'
  | 'departments' | 'dept_subcategories' | 'expense_descriptions'

interface Lookup {
  id: string
  name: string
  /** `pl_categories` only: revenue categories are not budgeted here. */
  type?: string
  category_id?: string
  department_id?: string
  dept_subcategory_id?: string
}

const TABLE_FOR: Record<Level, LookupTable> = {
  pl_category: 'pl_categories',
  pl_subcategory: 'pl_subcategories',
  department: 'departments',
  dept_subcategory: 'dept_subcategories',
  expense_description: 'expense_descriptions',
}

const LABEL_FOR: Record<Level, string> = {
  pl_category: 'P&L category',
  pl_subcategory: 'P&L sub-category',
  department: 'Department',
  dept_subcategory: 'Dept. sub-category',
  expense_description: 'Expense description',
}

/**
 * Which level OWNS each lookup table, in the database rather than in a branch.
 *
 * The two branches are an arrangement of the five classification levels; the
 * lookup tables are a fixed hierarchy, and the two do not line up everywhere.
 * `expense_descriptions.dept_subcategory_id` points at a department
 * sub-category whichever branch is open — so in the P&L branch, where the level
 * above a description is a P&L sub-category, there is no parent id to insert a
 * new description under. It is offered unfiltered there and cannot be added;
 * see `specs`.
 */
const OWNED_BY: Partial<Record<Level, { parent: Level; field: string }>> = {
  pl_subcategory: { parent: 'pl_category', field: 'category_id' },
  dept_subcategory: { parent: 'department', field: 'department_id' },
  expense_description: { parent: 'dept_subcategory', field: 'dept_subcategory_id' },
}

const EMPTY: Record<LookupTable, Lookup[]> = {
  pl_categories: [], pl_subcategories: [],
  departments: [], dept_subcategories: [], expense_descriptions: [],
}

/**
 * Where a new line will actually sit, said before it is saved.
 *
 * A line records at the deepest level filled in, so stopping one short puts the
 * budget on the parent — where it shows as its own row rather than on any of
 * the lines under it. That is a supported thing to do and often the point
 * ("Marketing: 8.000.000 RSD, without itemising sixty lines"), but it surprised the
 * owner once already from the change dialog, where two identical figures sat
 * one above the other and nothing said which one was about to move.
 *
 * So the two cases read differently. A leaf says so quietly; a parent says what
 * it means and how to aim lower. Both say something: an absent notice is not a
 * statement, and silence is what caused the surprise in the first place.
 *
 * The sentence continues the path shown above it, so it does not repeat the
 * label the path already ends with.
 */
export function scopeOfNewLine(
  pathLabels: string[],
  levelLabels: string[],
): { onParent: boolean; text: string } | null {
  if (pathLabels.length === 0 || levelLabels.length === 0) return null
  const landsOn = levelLabels[Math.min(pathLabels.length, levelLabels.length) - 1].toLowerCase()
  if (pathLabels.length >= levelLabels.length) {
    return { onParent: false, text: `a ${landsOn} line, the deepest there is.` }
  }
  const next = levelLabels[pathLabels.length].toLowerCase()
  return {
    onParent: true,
    text: `the ${landsOn} itself, not on any ${next} under it. It will show as its own row `
      + `beneath them — pick a ${next} below if you meant one in particular.`,
  }
}

/**
 * A path of LABELS, as the tree shows it, turned back into lookup rows.
 *
 * The `+` beside a sub-category in the table knows the row it was clicked on
 * as three words — "Development Expenses › Outsourcing services and
 * Associates" — and the dialog works in rows with ids. This is the join
 * between them, and it is the whole of what "pre-filled" means here.
 *
 * It walks DOWN, using each resolved pick to filter the next level exactly as
 * the dropdowns do. Two departments may each have a sub-category called
 * `General`, and matching on the name alone would put the new description
 * under whichever of them happened to be stored first — a mistake that writes
 * a correct-looking budget line onto the wrong department.
 *
 * A label the lookup tables do not hold stops the walk. A node can exist in
 * the tree and not in the tables: the tree is built from what has been SPENT,
 * and a description can be removed from the lookup after an invoice used it.
 * Everything resolved so far is kept, the rest is left for the user to pick,
 * and nothing is guessed — a half-filled form is honest, a wrong one is not.
 */
export function resolveSeed(
  levels: Level[],
  lookups: Record<LookupTable, Lookup[]>,
  seed: string[],
): (Lookup | null)[] {
  const out: (Lookup | null)[] = levels.map(() => null)
  const same = (a: string, b: string) =>
    a.trim().toLowerCase() === b.trim().toLowerCase()

  for (let i = 0; i < levels.length && i < seed.length; i++) {
    const level = levels[i]
    const owner = OWNED_BY[level]
    const ownedByPrevious = !!owner && i > 0 && levels[i - 1] === owner.parent
    const parent = i > 0 ? out[i - 1] : null

    // The level above resolved to nothing, so this one cannot be filtered and
    // must not be matched on its name alone.
    if (i > 0 && !parent) break

    const found = lookups[TABLE_FOR[level]].find(o =>
      same(o.name, seed[i])
      && (!ownedByPrevious || !owner || !parent
        || (o as any)[owner.field] === parent.id))
    if (!found) break
    out[i] = found
  }
  return out
}

export default function AddBudgetLineDialog({
  levels, months, currentFor, seedFor, seedEurFor, seedPath, projectId = null, projectLocked = false,
  onClose, onSaved,
}: {
  /** The open branch's levels, outermost first. */
  levels: Level[]
  /** The months on screen. A line budgeted outside them would show nowhere. */
  months: { key: string; label: string }[]
  /**
   * What the chosen line already reads in the chosen month.
   *
   * Zero for a line that is genuinely new, and NOT assumed to be: the user may
   * pick a classification that already carries a seed, and `BudgetChangeDialog`
   * asks for the figure the line should read. Handed the wrong current figure
   * it would record a delta that lands somewhere else entirely.
   */
  currentFor: (pathLabels: string[], month: string) => number
  /**
   * What the benchmark month seeds that same path with — the row's own seed,
   * not the rolled-up figure.
   *
   * Recorded with the entry so the figure holds still when the benchmark month
   * rolls over. Usually zero here, since this dialog is for a line nothing has
   * been spent on; usually is not always, and a line that does carry a seed
   * would drift exactly like any other. See `pinnedBase`.
   */
  seedFor: (pathLabels: string[], month: string, projectId: string | null) => number
  /**
   * The same seed in EUR, or null where the page has no EUR reading of the
   * budget. Recorded beside the RSD seed; see `BudgetChangeDialog`.
   */
  seedEurFor?: (pathLabels: string[], month: string, projectId: string | null) => number | null
  /** The project the line is for, to start with; null is an overhead line. */
  projectId?: string | null
  /** True when the page is narrowed to one scope: the project is named, not picked. */
  projectLocked?: boolean
  /**
   * The tree row this was opened from, as labels — empty from the page's own
   * button, filled from the `+` beside a sub-category.
   */
  seedPath?: string[]
  onClose: () => void
  onSaved: () => void
}) {
  const [lookups, setLookups] = useState<Record<LookupTable, Lookup[]>>(EMPTY)
  const [loading, setLoading] = useState(true)
  const [loadError, setLoadError] = useState('')
  const [picks, setPicks] = useState<(Lookup | null)[]>(() => levels.map(() => null))
  const [month, setMonth] = useState(months[0]?.key || '')
  const [step, setStep] = useState<'pick' | 'figure'>('pick')
  const [project, setProject] = useState<string | null>(projectId)
  const { projects } = useProjects()
  const [error, setError] = useState('')

  useEffect(() => {
    let cancelled = false
    Promise.all([
      supabase.from('pl_categories').select('id,name,type,sort_order').order('sort_order'),
      supabase.from('pl_subcategories').select('id,name,category_id,sort_order').order('sort_order'),
      supabase.from('departments').select('id,name,sort_order').order('sort_order'),
      supabase.from('dept_subcategories').select('id,name,department_id,sort_order').order('sort_order'),
      supabase.from('expense_descriptions').select('id,name,dept_subcategory_id,sort_order').order('sort_order'),
    ]).then((res: any[]) => {
      if (cancelled) return
      // Said rather than swallowed. An empty dropdown reads as "there are no
      // departments", which is a statement about the company, not about a
      // failed fetch.
      const failed = res.find(r => r.error)
      if (failed) {
        setLoadError(failed.error.message || String(failed.error))
        setLoading(false)
        return
      }
      const loaded = {
        pl_categories: res[0].data || [],
        pl_subcategories: res[1].data || [],
        departments: res[2].data || [],
        dept_subcategories: res[3].data || [],
        expense_descriptions: res[4].data || [],
      }
      setLookups(loaded)
      // Only now: the seed is labels, and there is nothing to match them
      // against until the tables are here.
      if (seedPath && seedPath.length > 0) {
        setPicks(resolveSeed(levels, loaded, seedPath))
      }
      setLoading(false)
    })
    return () => { cancelled = true }
    // Deliberately once. Re-resolving on a later render would undo the picks
    // the user has made since, including a name they just created.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  /** Everything each level offers, and whether a new one can be added there. */
  const specs = useMemo(() => levels.map((level, i) => {
    const table = TABLE_FOR[level]
    const owner = OWNED_BY[level]
    // The level above this one in the OPEN BRANCH also owns it in the database.
    // When it does not — a description under a P&L sub-category — there is no
    // parent id, so nothing can be inserted and nothing can be filtered.
    const ownedByPrevious = !!owner && i > 0 && levels[i - 1] === owner.parent
    const parent = i > 0 ? picks[i - 1] : null

    let options = lookups[table]
    if (level === 'pl_category') options = options.filter(c => c.type !== 'revenue')
    if (ownedByPrevious && owner) {
      options = parent
        ? options.filter(o => (o as any)[owner.field] === parent.id)
        : []
    }

    return {
      level,
      label: LABEL_FOR[level],
      table,
      options,
      /** A level is only reachable once the one above it has been chosen. */
      enabled: i === 0 || !!parent,
      addable: i === 0 || (ownedByPrevious && !!parent),
      parentId: ownedByPrevious && parent ? parent.id : undefined,
      parentField: ownedByPrevious && owner ? owner.field : undefined,
      /** Why this level cannot take a new name, when it cannot. */
      addNote: !ownedByPrevious && i > 0 && owner
        ? 'A new ' + LABEL_FOR[level].toLowerCase() + ' belongs to a '
          + LABEL_FOR[owner.parent].toLowerCase()
          + ', which this branch does not ask for. Switch to the Department branch to add one.'
        : '',
    }
  }), [levels, picks, lookups])

  /** The deepest level the user actually filled in. */
  const deepest = picks.reduce((d, p, i) => (p ? i : d), -1)
  const pathLabels = deepest >= 0 ? picks.slice(0, deepest + 1).map(p => p?.name || '') : []
  const complete = deepest >= 0 && pathLabels.every(Boolean)
  const monthMeta = months.find(m => m.key === month)

  const pick = (i: number, id: string) => {
    setError('')
    const chosen = specs[i].options.find(o => o.id === id) || null
    // Every level below is cleared, because it was a child of the old choice.
    setPicks(prev => prev.map((p, j) => (j < i ? p : j === i ? chosen : null)))
  }

  /** A name just created in the lookup table, selected where it was created. */
  const added = (i: number, item: { id: string; name: string }) => {
    const spec = specs[i]
    const row: Lookup = {
      ...item,
      ...(spec.parentField && spec.parentId ? { [spec.parentField]: spec.parentId } : {}),
      ...(spec.level === 'pl_category' ? { type: 'expense' } : {}),
    }
    setLookups(prev => ({ ...prev, [spec.table]: [...prev[spec.table], row] }))
    setPicks(prev => prev.map((p, j) => (j < i ? p : j === i ? row : null)))
    setError('')
  }

  /**
   * Why the figure step cannot be reached yet, or `null` when it can.
   *
   * Only what the form itself has not been told. A path that already reads a
   * figure is NOT refused any more: that figure is the group's, and so is the
   * change about to be made to it, so `BudgetChangeDialog` is handed it as the
   * current figure and works the delta out from it exactly as a cell click
   * does.
   */
  const whyNotReady = (): string | null => {
    if (!month) return 'Pick the month this budget is for.'
    if (!complete) {
      return 'Pick at least a ' + LABEL_FOR[levels[0]].toLowerCase()
        + ' — a budget line has to name the line it is for.'
    }
    return null
  }

  const proceed = () => {
    const refusal = whyNotReady()
    if (refusal) { setError(refusal); return }
    setStep('figure')
  }

  if (step === 'figure' && complete && monthMeta) {
    const level = levels[deepest]
    return (
      <BudgetChangeDialog
        // The ledger row is still written by `BudgetChangeDialog` and only by
        // it — including its `company_id: null`, which is what makes a line
        // added here a group line like every other.
        month={monthMeta.key}
        monthLabel={monthMeta.label}
        level={level}
        // The same shape an existing row builds, from the same function, so a
        // line added here lands on the node the user chose rather than beside
        // it. The levels this branch does not show stay null: nothing has been
        // said about them, and guessing would put the money on a department
        // that is not paying it.
        classification={classificationFor(pathLabels, level, [], levels)}
        rowLabel={pathLabels.join(' → ')}
        current={currentFor(pathLabels, monthMeta.key)}
        seed={seedFor(pathLabels, monthMeta.key, project)}
        seedEur={seedEurFor ? seedEurFor(pathLabels, monthMeta.key, project) : null}
        // Chosen here, so the change dialog names it rather than asking again.
        projectId={project}
        projectLocked
        onClose={onClose}
        onSaved={onSaved}
      />
    )
  }

  const refusal = whyNotReady()

  return (
    <div style={chrome.overlay}>
      <div style={s.dialog}>
        <div style={chrome.header}>
          <div>
            <div style={chrome.headerTitle}>Add a budget line</div>
            <div style={chrome.headerSub}>A line nothing has been spent on yet</div>
          </div>
          <button style={chrome.closeBtn} onClick={onClose} aria-label="Close">×</button>
        </div>

        <div style={{ padding: '1.5rem', display: 'flex', flexDirection: 'column', gap: '14px' }}>
          {loadError && (
            <div style={s.problem}>⚠️ The classifications could not be loaded: {loadError}</div>
          )}

          {loading ? (
            <div style={{ fontSize: '13px', color: DIALOG.dim }}>Loading classifications…</div>
          ) : specs.map((spec, i) => (
            <div key={spec.level}>
              <div style={s.lbl}>
                {spec.label}
                {i === 0 && <span style={{ color: DIALOG.red }}> *</span>}
              </div>
              <div style={{ display: 'flex', gap: '6px', alignItems: 'flex-start' }}>
                <select
                  style={{ ...s.input, flex: 1 }}
                  aria-label={spec.label}
                  value={picks[i]?.id || ''}
                  disabled={!spec.enabled}
                  onChange={e => pick(i, e.target.value)}
                >
                  <option value="">
                    {spec.enabled ? 'Select ' + spec.label.toLowerCase() + '…' : 'Pick the level above first'}
                  </option>
                  {spec.options.map(o => <option key={o.id} value={o.id}>{o.name}</option>)}
                </select>
                {/* Beside EVERY level, not only the last. A name that reaches
                    the ledger and not the lookup table cannot be picked when
                    the real spend arrives. */}
                {spec.addable ? (
                  <InlineCategoryAdd
                    table={spec.table}
                    parentId={spec.parentId}
                    parentField={spec.parentField}
                    currentCount={spec.options.length}
                    disabled={!spec.enabled}
                    placeholder={'New ' + spec.label.toLowerCase() + '…'}
                    onAdded={item => added(i, item)}
                  />
                ) : null}
              </div>
              {spec.addNote && (
                <div style={{ fontSize: '11px', color: DIALOG.faint, marginTop: '4px' }}>{spec.addNote}</div>
              )}
            </div>
          ))}

          <div>
            <div style={s.lbl}>Project</div>
            {projectLocked
              ? <div style={{ fontSize: '13px', color: DIALOG.text }}>{projectLabelById(projects, project)}</div>
              : <ProjectSelect value={project} onChange={setProject} title="Project" />}
          </div>

          <div>
            <div style={s.lbl}>Month <span style={{ color: DIALOG.red }}>*</span></div>
            <select style={s.input} aria-label="Month" value={month}
              onChange={e => { setMonth(e.target.value); setError('') }}>
              {months.map(m => <option key={m.key} value={m.key}>{m.label}</option>)}
            </select>
          </div>

          {/* What is actually being recorded, said before it is recorded — and
              whether it is about to land on a parent, which is the thing that
              surprises people. */}
          {complete ? (() => {
            const scope = scopeOfNewLine(pathLabels, levels.map(l => LABEL_FOR[l]))
            return (
              <div style={scope?.onParent
                ? { fontSize: '12px', lineHeight: 1.5, color: DIALOG.amber, background: DIALOG.amberFill, border: '0.5px solid ' + DIALOG.amber, borderRadius: '8px', padding: '9px 12px' }
                : { fontSize: '12px', lineHeight: 1.5, color: DIALOG.dim }}>
                Recorded on <span style={{ color: scope?.onParent ? DIALOG.amber : DIALOG.text, fontWeight: '500' }}>{pathLabels.join(' → ')}</span>
                {' — '}{scope?.text}
              </div>
            )
          })() : (
            <div style={{ fontSize: '12px', color: DIALOG.dim, lineHeight: 1.5 }}>
              A line is recorded at the deepest level you fill in. Leave a level blank and the budget sits on the one above it.
            </div>
          )}

          {/* Who it lands on, said beside the button that saves it: the group,
              which is the only thing a budget line is recorded against. */}
          <div style={{ fontSize: '12px', color: DIALOG.dim, lineHeight: 1.5 }}>
            Recorded for <span style={{ color: DIALOG.text }}>the group</span> — budgets are
            set consolidated, not per company.
          </div>

          {/* A refusal that the required markers do not explain by themselves:
              every field is filled in and Continue is still dead. Said here,
              because a disabled button never delivers the click that would
              otherwise say it. */}
          {complete && refusal
            ? <div style={s.problem}>⚠️ {refusal}</div>
            : error ? <div style={s.problem}>⚠️ {error}</div> : null}
        </div>

        <div style={{ padding: '1rem 1.5rem', borderTop: '0.5px solid ' + DIALOG.border, display: 'flex', justifyContent: 'flex-end', gap: '8px', background: DIALOG.raised }}>
          <button style={s.ghost} onClick={onClose}>Cancel</button>
          <button
            style={{ ...s.primary, opacity: refusal ? 0.5 : 1 }}
            disabled={!!refusal}
            onClick={proceed}
          >
            Continue
          </button>
        </div>
      </div>
    </div>
  )
}

const s: Record<string, React.CSSProperties> = {
  dialog: { background: DIALOG.panel, borderRadius: '16px', width: '480px', maxWidth: '95vw', maxHeight: '92vh', overflowY: 'auto', display: 'flex', flexDirection: 'column', boxShadow: DIALOG.shadow },
  lbl: { fontSize: '10px', fontWeight: '500', color: DIALOG.dim, textTransform: 'uppercase', letterSpacing: '0.07em', marginBottom: '5px' },
  input: { fontFamily: 'system-ui,sans-serif', fontSize: '13px', padding: '8px 10px', border: '0.5px solid ' + DIALOG.border, borderRadius: '8px', background: DIALOG.raised, color: DIALOG.text, outline: 'none', width: '100%', boxSizing: 'border-box' },
  problem: { background: DIALOG.redFill, border: '0.5px solid ' + DIALOG.redSoft, borderRadius: '8px', padding: '9px 12px', fontSize: '12px', color: DIALOG.red },
  ghost: { fontFamily: 'system-ui,sans-serif', fontSize: '13px', padding: '8px 16px', borderRadius: '8px', border: '0.5px solid ' + DIALOG.border, background: 'transparent', color: DIALOG.dim, cursor: 'pointer' },
  primary: { fontFamily: 'system-ui,sans-serif', fontSize: '13px', padding: '8px 18px', borderRadius: '8px', border: 'none', background: DIALOG.accent, color: DIALOG.onAccent, cursor: 'pointer', fontWeight: '500' },
}
