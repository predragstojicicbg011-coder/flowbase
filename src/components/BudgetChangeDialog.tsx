import React, { useState } from 'react'
import { supabase } from '../supabase'
import { DIALOG, chrome } from './dialogTheme'
import { deltaForTarget } from '../services/budgetForecast'
import { getBookRates, rsdToEur } from '../services/bookAmounts'
import { fmtRSD } from '../utils/formatters'
import { countOf } from '../utils/plural'
import ProjectSelect from './ProjectSelect'
import { useProjects } from '../contexts/ProjectsContext'
import { projectLabelById } from '../services/projects'

// ─── The budget change dialog ────────────────────────────────────────────────
//
// Records one change to one budget figure.
//
// It asks for the figure the cell should read, not the difference, and works
// the difference out itself. Nothing here overwrites anything: the row it
// writes is appended to `budget_adjustments`, which has no update and no delete
// privilege, and a mistake is undone with a counter-entry that leaves both
// halves of the story on the record.
//
// ── The change is the group's ───────────────────────────────────────────────
//
// It writes `company_id: null`, which the table reads as "the group", and it
// does not ask which company. Budgeting is done consolidated: the figure the
// cell shows IS the budget, not one company's share of it. There is nothing
// here for a company picker to answer, and the refusal that used to stand in
// its place — "pick one in the selector before changing a budget" — was
// refusing on behalf of a per-company budget that no longer exists.
//
// ── For one project, or for overhead ────────────────────────────────────────
//
// A budget line may target a project (`project_id`; null is an overhead line,
// Opšti troškovi). The page hands over the project the change is for and
// whether it is fixed: narrowed to one project — or to overhead — the change
// is for that scope and the dialog only names it; on the all-projects view
// the user picks, starting from the project the line's own keys agree on.
//
// The seed recorded is THAT project's seed on the row (`seedForProject`), not
// the row's whole seed: the ledger is replayed per project, and pinning a
// site's entry to the seed of every project on the row would carry the others'
// money under the site's base. The delta is still taken against the figure the
// cell shows, so the cell reads back what was typed whichever project it is.
//
// ── In dinars, with euros beside them ───────────────────────────────────────
//
// A budget is planned in RSD, so the figure is typed in RSD and the change is
// stored as `amount_rsd` against `seed_rsd`. The EUR reading of the same
// entry is stored beside it: `amount_eur` is the RSD change at the NBS rate
// of the day it is recorded, and `seed_eur` is the row's own EUR seed, read
// off the EUR actuals. When either cannot be had — NBS unreachable, or the
// page itself not readable in EUR — both are left null rather than guessed,
// and the budget then reads in RSD only, which the page says.

/** The five classification columns a ledger row files a change under. */
export interface BudgetClassification {
  pl_category: string | null
  pl_subcategory: string | null
  department: string | null
  dept_subcategory: string | null
  expense_description: string | null
}

/**
 * The figure typed into "Change to", or `null` when the box holds nothing that
 * reads as one.
 *
 * An empty box means "I have not typed anything". It does NOT mean zero, and
 * `parseFloat('') || 0` — which is what this replaces — turned it into a target
 * of zero, i.e. a delta of minus the whole current figure. A user who genuinely
 * wants zero types `0`.
 */
export function parseTarget(raw: string): number | null {
  const trimmed = raw.trim()
  if (trimmed === '') return null
  const n = Number(trimmed)
  return Number.isFinite(n) ? n : null
}

/**
 * Why this change cannot be recorded, or `null` when it can.
 *
 * Pulled out of the component and exported so the refusals that matter can be
 * tested without rendering anything: a change with no stated reason, and a
 * change with no figure typed at all.
 *
 * There is no longer a refusal about the company. A budget line is the
 * group's, the row carries `company_id: null`, and nothing about the selector
 * can stop a change being recorded.
 *
 * The reason is checked before the delta, because a reason is required even of
 * a change the user is still typing the amount of.
 *
 * `delta` is `null` when the amount box is empty or unreadable, which is a
 * different thing from a delta of zero and gets a different answer.
 */
export function whyNotRecordable(
  { reason, delta }: { reason: string; delta: number | null },
): string | null {
  // Whitespace is not a reason. The database agrees (`btrim(reason) <> ''`),
  // but a figure that reaches the database before being refused has already
  // cost the user the form they typed.
  if (!reason.trim()) return 'Navedite razlog izmene. Zbog toga se izmena i beleži.'
  // An empty box is not a target of zero. Reading it as one would record a
  // delta of minus the whole current figure, which is the opposite of what
  // clearing a field means.
  if (delta === null) return 'Unesite iznos koji ova stavka treba da ima. Prazno polje nije nula — unesite 0 ako želite nulu.'
  if (delta === 0) return 'To je već postojeći iznos. Nema šta da se sačuva.'
  return null
}

/**
 * What this change is about to land on, said in words.
 *
 * The header names the row. Naming the row is not enough: a parent with one
 * child shows the SAME figure as that child, one line above it, both green and
 * both clickable, and "Change budget — SaaS expenses" is read past by anyone
 * who believes they clicked Figma. What the header cannot say, and this can,
 * is that the money will sit on the parent and NOT on the line under it.
 *
 * `childLabels` is the row's direct children, handed over by the caller which
 * holds the tree:
 *
 *   - a non-empty list — a parent. Say where the change lands and what it does
 *     not land on, naming the children while there are few of them to name and
 *     counting them once there are not.
 *   - `[]` — a leaf. Say that too, briefly. The two have to READ differently
 *     at a glance, or the presence of a notice is the only signal and its
 *     absence says nothing.
 *   - `undefined` — the caller does not know. Say nothing rather than guess;
 *     `AddBudgetLineDialog` builds a path rather than picking a row off a tree.
 *
 * This is deliberately not a refusal and not a confirmation step. Budgeting on
 * a parent is a supported, deliberate act — "Marketing: 8.000.000 RSD without
 * itemising sixty lines". The fault was that it happened silently.
 */
export interface ChangeScope {
  /** `parent` earns the amber notice; `leaf` is a quiet line of text. */
  tone: 'parent' | 'leaf'
  text: string
}

/** How many children get named before the notice starts counting instead. */
const NAME_AT_MOST = 3

export function scopeOfChange(rowLabel: string, childLabels?: string[] | null): ChangeScope | null {
  if (!childLabels) return null
  const n = childLabels.length
  if (n === 0) {
    return { tone: 'leaf', text: `${rowLabel} nema stavki ispod sebe — izmena se beleži na ${rowLabel}.` }
  }
  const named = childLabels.slice(0, NAME_AT_MOST).join(', ')
  const lines = countOf(n, 'stavku', 'stavke', 'stavki')
  const has = n === 1
    ? `ima jednu stavku ispod sebe — ${named}`
    : n <= NAME_AT_MOST
      ? `ima ${lines} ispod sebe — ${named}`
      : `ima ${lines} ispod sebe, između ostalih ${named}`
  const notOn = n === 1 ? named : 'stavkama ispod nje'
  const toChange = n === 1 ? named : 'neku od njih'
  return {
    tone: 'parent',
    text: `${rowLabel} ${has}. Ova izmena se beleži na samoj stavci ${rowLabel}, ne na ${notOn}`
      + `, i prikazuje se kao zaseban red ispod nje. Da biste izmenili ${toChange}, zatvorite ovaj prozor i kliknite iznos u tom redu.`,
  }
}

export default function BudgetChangeDialog({
  month, monthLabel, level, classification, rowLabel, current, seed, seedEur = null, childLabels,
  projectId = null, projectLocked = false, seedForProject,
  onClose, onSaved, onExplain,
}: {
  month: string
  monthLabel: string
  level: string
  classification: BudgetClassification
  rowLabel: string
  current: number
  /**
   * What the benchmark month seeds this row with, in this month, right now.
   *
   * Recorded alongside the delta, and it is the whole of why a budgeted figure
   * holds still. The benchmark is the month before today, so it changes by
   * itself on the 1st and every seed changes with it; a delta stored against a
   * seed nobody wrote down therefore read one number in October and another in
   * November, untouched. See `pinnedBase` in `budgetForecast`.
   *
   * It is the row's OWN seed, not the rolled-up figure in `current`: the cell
   * is its own line plus its children's totals, and the children go on rolling
   * up live — which is right, since a new line appearing under a parent must
   * not vanish into a figure pinned above it.
   */
  seed: number
  /**
   * The same seed in EUR, from the EUR actuals; null where the page has no
   * EUR reading of this budget. Recorded as `seed_eur`.
   */
  seedEur?: number | null
  /** The project the change is for, to start with; null is an overhead line. */
  projectId?: string | null
  /** True when the page is narrowed to one scope: the project is named, not picked. */
  projectLocked?: boolean
  /**
   * The row's own seed for one project (RSD, and EUR or null). When given it
   * replaces `seed` / `seedEur` for whichever project is chosen.
   */
  seedForProject?: (projectId: string | null) => { seed: number; seedEur: number | null }
  /**
   * The labels of the row's direct children, or omitted where the caller has
   * no tree to read them from. An empty array is a leaf and says so; omitting
   * it says nothing. See `scopeOfChange`.
   */
  childLabels?: string[] | null
  onClose: () => void
  onSaved: () => void
  /** Opens the drill that says what the current figure is made of. */
  onExplain?: () => void
}) {
  const [target, setTarget] = useState(current.toFixed(2))
  const [project, setProject] = useState<string | null>(projectId)
  const { projects } = useProjects()
  const pinned = seedForProject ? seedForProject(project) : { seed, seedEur }
  const [reason, setReason] = useState('')
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState('')

  // Said above the amount box, before the figure is typed rather than after
  // it is recorded — the consequence of clicking the wrong one of two
  // identical figures is otherwise invisible until it is done.
  const scope = scopeOfChange(rowLabel, childLabels)

  const parsed = parseTarget(target)
  const delta = parsed === null ? null : deltaForTarget(current, parsed)

  const save = async () => {
    const refusal = whyNotRecordable({ reason, delta })
    if (refusal) { setError(refusal); return }
    // `whyNotRecordable` has already refused a null delta; this is what tells
    // the compiler so, and what would catch it if that check ever moved.
    if (delta === null) return
    setSaving(true); setError('')

    // The EUR reading, both halves or neither. See the note at the top.
    let eur: { amount_eur: number; seed_eur: number } | { amount_eur: null; seed_eur: null } =
      { amount_eur: null, seed_eur: null }
    const pinnedEur = pinned.seedEur
    if (pinnedEur !== null && pinnedEur !== undefined && Number.isFinite(pinnedEur)) {
      try {
        const rates = await getBookRates(new Date().toISOString().slice(0, 10))
        eur = { amount_eur: rsdToEur(delta, rates.eurRate), seed_eur: pinnedEur }
      } catch {
        // Not a reason to refuse a budget planned in dinars.
      }
    }

    const { error: insErr } = await supabase.from('budget_adjustments').insert({
      // The group's. Null is the budget's own scope, not a missing value: the
      // owner budgets consolidated, and the classification tables this line is
      // named from carry no company either.
      company_id: null,
      budget_month: `${month}-01`,
      level,
      ...classification,
      // Null is an overhead line, as on every other table with the column.
      project_id: project,
      kind: 'adjust',
      amount_rsd: delta,
      // See the prop. Without this the figure typed above drifts the moment
      // the month turns over.
      seed_rsd: pinned.seed,
      ...eur,
      reason: reason.trim(),
    })
    if (insErr) { setError(`Izmena nije sačuvana: ${insErr.message}. Pokušajte ponovo.`); setSaving(false); return }
    onSaved()
    onClose()
  }

  return (
    <div style={chrome.overlay}>
      <div style={{ ...s.dialog }}>
        <div style={chrome.header}>
          <div>
            <div style={chrome.headerTitle}>Izmena budžeta — {rowLabel}</div>
            <div style={chrome.headerSub}>{monthLabel}</div>
          </div>
          <button style={chrome.closeBtn} onClick={onClose} aria-label="Zatvori">×</button>
        </div>

        <div style={{ padding: '1.5rem', display: 'flex', flexDirection: 'column', gap: '14px' }}>
          {scope && (scope.tone === 'parent'
            ? (
              <div style={{ background: DIALOG.amberFill, border: '0.5px solid ' + DIALOG.amber, borderRadius: '8px', padding: '9px 12px', fontSize: '12px', color: DIALOG.amber, lineHeight: 1.5 }}>
                {scope.text}
              </div>
            )
            : (
              <div style={{ fontSize: '12px', color: DIALOG.faint, lineHeight: 1.5 }}>
                {scope.text}
              </div>
            ))}

          <div>
            <div style={s.lbl}>Projekat</div>
            {projectLocked
              ? <div style={{ fontSize: '13px', color: DIALOG.text }} data-testid="budget-change-project">{projectLabelById(projects, project)}</div>
              : <ProjectSelect value={project} onChange={setProject} title="Projekat" />}
          </div>

          <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '12px' }}>
            <div>
              <div style={s.lbl}>Trenutno</div>
              <div style={{ fontSize: '18px', color: DIALOG.dim }}>{fmtRSD(current)}</div>
            </div>
            <div>
              <div style={s.lbl}>Novi iznos (RSD)</div>
              <input style={s.input} type="number" value={target} autoFocus
                aria-label="Novi iznos"
                onChange={e => setTarget(e.target.value)} />
            </div>
          </div>

          {/* What is missing, said live, rather than only after a click that
              cannot land. */}
          <div style={{ fontSize: '13px', color: delta === null ? DIALOG.amber : delta > 0 ? DIALOG.red : DIALOG.accent }}>
            {delta === null
              ? 'Iznos nije unet. Prazno polje nije nula — unesite 0 ako želite nulu.'
              : delta === 0
                ? 'Još nema izmene.'
                : delta > 0 ? `+${fmtRSD(delta)} više` : `-${fmtRSD(Math.abs(delta))} manje`}
          </div>

          <div>
            <div style={s.lbl}>Razlog <span style={{ color: DIALOG.red }}>*</span></div>
            <textarea style={{ ...s.input, minHeight: '70px', resize: 'vertical' }}
              value={reason} onChange={e => setReason(e.target.value)}
              aria-label="Razlog"
              placeholder="Novi ugovor od oktobra, cena veća za 8%" />
          </div>

          {/* What the ledger promises, said once where the change is made: this
              is an entry, not an overwrite, and the way back is another entry.
              The second sentence is the contract that used not to hold. */}
          <div style={{ fontSize: '11px', color: DIALOG.faint, lineHeight: 1.5 }}>
            Beleži se kao datirani unos sa vašim razlogom. Iznos se ne prepisuje —
            da poništite izmenu, unesite izmenu u suprotnom smeru. Jednom sačuvan, iznos
            ostaje kako je unet: promena referentnog meseca ga neće pomeriti.
          </div>

          {error && (
            <div style={{ background: DIALOG.redFill, border: '0.5px solid ' + DIALOG.redSoft, borderRadius: '8px', padding: '9px 12px', fontSize: '12px', color: DIALOG.red }}>
              ⚠️ {error}
            </div>
          )}
        </div>

        <div style={{ padding: '1rem 1.5rem', borderTop: '0.5px solid ' + DIALOG.border, display: 'flex', alignItems: 'center', gap: '8px', background: DIALOG.raised }}>
          {onExplain && (
            <button style={s.link} onClick={onExplain}>Kako je dobijen ovaj iznos</button>
          )}
          <div style={{ marginLeft: 'auto', display: 'flex', gap: '8px' }}>
            <button style={s.ghost} onClick={onClose}>Otkaži</button>
            {/* Disabled while the amount box holds nothing readable: there is
                no figure to record, and the one thing this must never do is
                read an empty box as a target of zero. */}
            <button style={{ ...s.primary, opacity: saving || delta === null ? 0.5 : 1 }}
              disabled={saving || delta === null} onClick={save}>
              {saving ? 'Čuvanje…' : 'Sačuvaj izmenu'}
            </button>
          </div>
        </div>
      </div>
    </div>
  )
}

const s: Record<string, React.CSSProperties> = {
  dialog: { background: DIALOG.panel, borderRadius: '16px', width: '480px', maxWidth: '95vw', display: 'flex', flexDirection: 'column', overflow: 'hidden', boxShadow: DIALOG.shadow },
  lbl: { fontSize: '10px', fontWeight: '500', color: DIALOG.dim, textTransform: 'uppercase', letterSpacing: '0.07em', marginBottom: '5px' },
  input: { fontFamily: 'system-ui,sans-serif', fontSize: '13px', padding: '8px 10px', border: '0.5px solid ' + DIALOG.border, borderRadius: '8px', background: DIALOG.raised, color: DIALOG.text, outline: 'none', width: '100%', boxSizing: 'border-box' },
  ghost: { fontFamily: 'system-ui,sans-serif', fontSize: '13px', padding: '8px 16px', borderRadius: '8px', border: '0.5px solid ' + DIALOG.border, background: 'transparent', color: DIALOG.dim, cursor: 'pointer' },
  link: { fontFamily: 'system-ui,sans-serif', fontSize: '12px', padding: 0, border: 'none', background: 'transparent', color: DIALOG.blue, cursor: 'pointer', textDecoration: 'underline', textUnderlineOffset: '3px' },
  primary: { fontFamily: 'system-ui,sans-serif', fontSize: '13px', padding: '8px 18px', borderRadius: '8px', border: 'none', background: DIALOG.accent, color: DIALOG.onAccent, cursor: 'pointer', fontWeight: '500' },
}
