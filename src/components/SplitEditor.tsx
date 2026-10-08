import React, { useMemo, useRef, useState } from 'react'
import SearchableSelect from './SearchableSelect'
import ProjectSelect from './ProjectSelect'
import type { Project } from '../services/projects'
import SplitScriptBuilder, { type ClassificationOptions } from './SplitScriptBuilder'
import { DIALOG } from './dialogTheme'
import { fmtMoney, fmtNum } from '../utils/formatters'
import {
  emptyLine, splitInHalf, sumOf, remainderOf, isBalanced, whySplitNotSavable,
  absorbRemainder, applyScript, scriptMatching,
  type SplitLine, type SplitParent, type ScriptLike,
} from '../services/expenseSplit'

// ── Splitting a payment across several costs ────────────────────────────────
//
// One control, used by every dialog that books an expense, so the arithmetic
// and the wording are the same wherever somebody meets them. A dialog gives it
// the payment, the scripts and the lines; it gives back the lines.
//
// ── A line is a script and a figure ─────────────────────────────────────────
//
// Six classification fields per line, three lines, is eighteen dropdowns
// on a form whose whole point was to be unobtrusive. A quick-fill script
// carries all six and is what people actually think in — "this half is
// Figma, that half is the laptop".
//
// ── Each line has its own project ──────────────────────────────────────────
//
// Splitting is also how one document is shared between several construction
// sites: one line per project, each with its own picker (null = company
// overhead). A template carries no project, so picking one leaves the line's
// project alone. While lines exist the parent document carries NO project of
// its own — the dialogs clear and hide theirs — because the lines are what
// the P&L reads.
//
// ── The sum is on screen at all times ───────────────────────────────────────
//
// Not on save. A split 50 short announces itself nowhere afterwards: the
// payment is right, the bank reconciles, and the P&L is quietly 50 light in
// one category and 50 heavy in none. So the running total, the payment and
// the difference between them are always visible, and the difference has a
// button that puts it on a line rather than leaving the person to subtract.

export interface SplitEditorProps {
  parent: SplitParent
  lines: SplitLine[]
  onChange: (lines: SplitLine[]) => void
  scripts: ScriptLike[]
  disabled?: boolean
  /** Shown when there is no split yet, to say what the button is for. */
  hint?: string
  /**
   * The lookup lists, so a template can be made without leaving the split.
   *
   * Optional: where a dialog has not passed them the line is template-only,
   * which is how this shipped and is still a working control. Where they are
   * passed, each line gets a `+`.
   */
  classification?: ClassificationOptions
  /** The client the new template is written with. Required with `options`. */
  client?: any
  /** Called after one is saved, so the dialog can refetch its list. */
  onScriptsChanged?: () => void
  /** Narrow each line's project picker to one company's projects. */
  companyId?: string | null
  /** Override the project list (tests). Defaults to useProjects(). */
  projects?: readonly Project[]
}

const money = (n: number, currency?: string | null) =>
  currency ? fmtMoney(n, currency) : fmtNum(n)

export default function SplitEditor({
  parent, lines, onChange, scripts, disabled = false, hint,
  classification, client, onScriptsChanged, companyId, projects,
}: SplitEditorProps) {
  /** The line whose `+` is open, if any. One at a time: two half-filled
   *  template forms on one screen is two chances to save the wrong one. */
  const [building, setBuilding] = useState<string | null>(null)
  // A counter rather than the array length: removing the middle line of three
  // and adding another would reuse a key, and React would carry the removed
  // line's input state into the new one.
  const nextKey = useRef(0)
  const makeKey = () => `line-${nextKey.current++}`

  /**
   * What is in each amount box, as typed.
   *
   * A controlled input that renders `String(Number(text))` cannot be typed
   * into: `653401.` parses to `653401`, the state goes back as `653401`, and
   * the full stop vanishes from under the cursor. So the box holds TEXT and
   * the model holds the number, and they are only reconciled when the text
   * parses to something.
   *
   * Keyed by line, and a line with no entry falls back to its stored amount —
   * which is what makes a recalculated line update on screen without the
   * person having touched its box.
   */
  const [typed, setTyped] = useState<Record<string, string>>({})

  /**
   * What the box shows: the text as typed, but only while it still means the
   * figure the line holds.
   *
   * The draft has to lose to the model whenever something else moves a line —
   * the balancing recalculation, or "put it on line N". Without that test the
   * button changed the amount and the box went on showing what had been typed
   * into it, so the figure on screen and the figure being saved disagreed and
   * only one of them was visible.
   */
  const shown = (l: SplitLine) => {
    const draft = typed[l.key]
    if (draft === undefined) return l.amount == null ? '' : String(l.amount)
    const cleaned = draft.replace(',', '.').trim()
    const parsed = cleaned === '' ? null : Number(cleaned)
    const means = parsed != null && Number.isFinite(parsed) ? parsed : null
    return means === l.amount ? draft : (l.amount == null ? '' : String(l.amount))
  }

  const total = sumOf(lines)
  const left = remainderOf(parent, lines)
  const balanced = isBalanced(parent, lines)
  const why = whySplitNotSavable(parent, lines)

  const options = useMemo(
    () => scripts.map(s => ({ value: s.id, label: `${s.icon || '⚡'} ${s.name}` })),
    [scripts])

  const set = (i: number, next: Partial<SplitLine>) =>
    onChange(lines.map((l, j) => (j === i ? { ...l, ...next } : l)))

  /**
   * One line's amount changed, so the LAST line takes up the difference.
   *
   * The last one, always, rather than "the next one" or "spread across the
   * rest": a rule that moves depending on which box was touched is a rule
   * nobody can predict, and spreading a difference makes every line slightly
   * wrong instead of one line exactly right. The last line is labelled as the
   * one that balances, so the behaviour is stated rather than discovered.
   *
   * Editing the last line itself recalculates nothing. Somebody typing into
   * the balancing line means it, and the split simply reads as unbalanced
   * until they fix another line — which is the honest answer and not a fight
   * over the cursor.
   */
  const setAmount = (i: number, raw: string) => {
    setTyped(t => ({ ...t, [lines[i].key]: raw }))
    const cleaned = raw.replace(',', '.').trim()
    const n = cleaned === '' ? null : Number(cleaned)
    const amount = n != null && Number.isFinite(n) ? n : null

    const isLast = i === lines.length - 1
    const next = lines.map((l, j) => (j === i ? { ...l, amount } : l))

    if (isLast || amount == null) { onChange(next); return }

    // Everything but the last line, against the payment.
    const others = next.slice(0, -1).reduce((sum, l) => sum + (l.amount || 0), 0)
    const balance = Math.round(((parent.amount || 0) - others) * 100) / 100
    const lastKey = lines[lines.length - 1].key
    // The balancing box is no longer showing what was typed into it, so its
    // draft is dropped and it falls back to the figure just worked out.
    setTyped(t => { const { [lastKey]: _drop, ...rest } = t; return rest })
    onChange(next.map((l, j) => (j === next.length - 1 ? { ...l, amount: balance } : l)))
  }

  if (lines.length === 0) {
    return (
      <div style={s.empty}>
        <button type="button" style={s.start} disabled={disabled}
          onClick={() => onChange(splitInHalf(parent, () => makeKey()))}>
          ＋ Split across several costs
        </button>
        <span style={s.hint}>
          {hint || 'One payment, two or more expenses — each with its own classification.'}
        </span>
      </div>
    )
  }

  return (
    <div style={s.wrap}>
      <div style={s.head}>
        <span style={s.title}>Split across {lines.length} costs</span>
        <button type="button" style={s.ghost} disabled={disabled}
          title="Remove the split and book this as one expense again"
          onClick={() => onChange([])}>
          Remove the split
        </button>
      </div>

      {lines.map((line, i) => {
        const matched = scriptMatching(line, scripts)
        return (
          <div key={line.key} style={s.row}>
            <span style={s.num}>{i + 1}</span>

            <div style={{ flex: 1, minWidth: 0 }}>
              <div style={{ display: 'flex', gap: '6px', alignItems: 'flex-start' }}>
              <SearchableSelect
                value={matched?.id || ''}
                onChange={id => {
                  const script = scripts.find(x => x.id === id)
                  if (script) set(i, applyScript(line, script))
                }}
                options={options}
                allLabel="— pick what this part is for —"
                searchPlaceholder="Type to find a template…"
                emptyMessage="No template of that name"
                disabled={disabled}
                style={{ ...s.input, flex: 1 }}
              />
              {/* A COST WITH NO TEMPLATE YET.
                  Without this the only way on is to abandon the split, make
                  one in Settings, and come back — three steps for something
                  that should be one. */}
              {classification && client && (
                <button type="button" style={s.newScript} disabled={disabled}
                  title="Make a template for this cost"
                  onClick={() => setBuilding(building === line.key ? null : line.key)}>
                  {building === line.key ? '×' : '+'}
                </button>
              )}
              </div>

              {building === line.key && classification && client && (
                <SplitScriptBuilder
                  options={classification}
                  scripts={scripts}
                  client={client}
                  onClose={() => setBuilding(null)}
                  onSaved={saved => {
                    // The line takes the classification straight away. The
                    // id it was given is not needed for that — `applyScript`
                    // copies the six fields and nothing else — and the
                    // picker will show it by name once the dialog refetches.
                    set(i, applyScript(line, saved))
                    setBuilding(null)
                    onScriptsChanged?.()
                  }}
                />
              )}

              {/* Which site or building this part belongs to. */}
              <div style={{ marginTop: '6px' }} data-testid={`split-project-${i}`}>
                <ProjectSelect
                  value={line.project_id}
                  onChange={project_id => set(i, { project_id })}
                  companyId={companyId}
                  projects={projects}
                  disabled={disabled}
                  title="Projekat ovog dela"
                  style={s.input}
                />
              </div>

              {/* What the line will actually be filed as. A template name is
                  not a classification, and the two can drift. */}
              <div style={s.filed}>
                {line.pl_category
                  ? [line.pl_category, line.pl_subcategory, line.department, line.expense_description]
                      .filter(Boolean).join(' › ')
                  : <span style={{ color: DIALOG.amber }}>nothing picked yet</span>}
              </div>
            </div>

            <div style={{ flexShrink: 0 }}>
              <input
                style={{ ...s.input, ...s.amount }}
                inputMode="decimal"
                disabled={disabled}
                value={shown(line)}
                placeholder="0.00"
                title={i === lines.length - 1
                  ? 'This line takes up whatever the others leave'
                  : 'Changing this adjusts the last line'}
                onChange={e => setAmount(i, e.target.value)} />
              {i === lines.length - 1 && lines.length > 1 && (
                <div style={s.balancer}>takes the balance</div>
              )}
            </div>

            <button type="button" style={s.remove} disabled={disabled || lines.length <= 1}
              title={lines.length <= 1
                ? 'A split of one is not a split — use “Remove the split”'
                : 'Remove this line'}
              onClick={() => onChange(lines.filter((_, j) => j !== i))}>
              ✕
            </button>
          </div>
        )
      })}

      <div style={s.foot}>
        <button type="button" style={s.add} disabled={disabled}
          onClick={() => onChange([
            ...lines,
            // The new line opens holding whatever is unaccounted for, which is
            // the amount it is about to be given nine times out of ten.
            { ...emptyLine(makeKey()), amount: left > 0 ? left : null },
          ])}>
          ＋ Add a line
        </button>

        <div style={s.sums}>
          <span>
            Lines <b style={{ color: DIALOG.text }}>{money(total, parent.currency)}</b>
          </span>
          <span style={{ color: DIALOG.dim }}>of</span>
          <span>
            <b style={{ color: DIALOG.text }}>{money(parent.amount || 0, parent.currency)}</b>
          </span>
          <span style={{
            fontWeight: 700,
            color: balanced ? DIALOG.accent : DIALOG.amber,
          }}>
            {balanced
              ? '✓ balanced'
              : left > 0
                ? `${money(left, parent.currency)} left`
                : `${money(Math.abs(left), parent.currency)} over`}
          </span>
          {!balanced && (
            <button type="button" style={s.ghost} disabled={disabled}
              title="Put the difference on the last line"
              onClick={() => onChange(absorbRemainder(parent, lines))}>
              Put it on line {lines.length}
            </button>
          )}
        </div>
      </div>

      {/* The sentence, not just the colour. A reader who has not noticed the
          amber figure above has still been told what is wrong and where. */}
      {why && <div style={s.problem}>{why}</div>}
    </div>
  )
}

const s: Record<string, React.CSSProperties> = {
  empty: { display: 'flex', alignItems: 'center', gap: '10px', flexWrap: 'wrap', margin: '4px 0 2px' },
  start: {
    fontFamily: "'Inter', system-ui, sans-serif", fontSize: '12px', fontWeight: 600,
    padding: '6px 13px', borderRadius: '8px', cursor: 'pointer',
    border: `1px solid ${DIALOG.border}`, background: 'transparent', color: DIALOG.dim,
  },
  hint: { fontSize: '11px', color: DIALOG.faint },
  wrap: {
    border: `1px solid ${DIALOG.border}`, borderRadius: '10px',
    padding: '12px 13px', background: DIALOG.raised, margin: '4px 0 2px',
  },
  head: { display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: '10px' },
  title: {
    fontSize: '10px', fontWeight: 600, color: DIALOG.faint,
    textTransform: 'uppercase', letterSpacing: '0.09em',
  },
  row: { display: 'flex', alignItems: 'flex-start', gap: '8px', marginBottom: '8px' },
  num: {
    fontSize: '11px', color: DIALOG.faint, width: '14px', flexShrink: 0,
    lineHeight: '34px', fontFamily: "'DM Mono', monospace",
  },
  input: {
    width: '100%', boxSizing: 'border-box', fontFamily: "'Inter', sans-serif",
    fontSize: '13px', padding: '8px 11px', border: `1px solid ${DIALOG.border}`,
    borderRadius: '8px', background: DIALOG.panel, color: DIALOG.text, outline: 'none',
  },
  amount: {
    width: '140px', flexShrink: 0, textAlign: 'right',
    fontFamily: "'DM Mono', 'Fira Mono', monospace",
  },
  balancer: {
    fontSize: '9.5px', color: DIALOG.faint, textAlign: 'right',
    marginTop: '3px', paddingRight: '2px',
  },
  filed: { fontSize: '10.5px', color: DIALOG.dim, marginTop: '3px', paddingLeft: '2px' },
  newScript: {
    flexShrink: 0, width: '32px', height: '34px', borderRadius: '8px', cursor: 'pointer',
    border: `1px solid ${DIALOG.accent}55`, background: `${DIALOG.accent}1A`,
    color: DIALOG.accent, fontSize: '15px', lineHeight: 1,
    fontFamily: "'Inter', system-ui, sans-serif",
  },
  remove: {
    background: 'transparent', border: `1px solid ${DIALOG.border}`, borderRadius: '7px',
    color: DIALOG.dim, cursor: 'pointer', fontSize: '12px', padding: '7px 9px', flexShrink: 0,
  },
  foot: {
    display: 'flex', alignItems: 'center', gap: '12px', flexWrap: 'wrap',
    borderTop: `1px solid ${DIALOG.border}`, paddingTop: '10px', marginTop: '2px',
  },
  add: {
    fontFamily: "'Inter', system-ui, sans-serif", fontSize: '12px', fontWeight: 600,
    padding: '6px 13px', borderRadius: '8px', cursor: 'pointer',
    border: `1px solid ${DIALOG.accent}55`, background: `${DIALOG.accent}1A`, color: DIALOG.accent,
  },
  sums: {
    marginLeft: 'auto', display: 'flex', alignItems: 'center', gap: '8px',
    fontSize: '12px', color: DIALOG.dim, fontFamily: "'DM Mono', monospace", flexWrap: 'wrap',
  },
  ghost: {
    background: 'transparent', border: `1px solid ${DIALOG.border}`, borderRadius: '7px',
    color: DIALOG.dim, fontSize: '10.5px', padding: '3px 9px', cursor: 'pointer',
    fontFamily: "'Inter', system-ui, sans-serif",
  },
  problem: {
    marginTop: '9px', fontSize: '11.5px', color: DIALOG.amber, lineHeight: 1.55,
  },
}
