import React, { useState, useEffect, useMemo, useRef } from 'react'
import { supabase } from '../supabase'
import { useCompanies } from '../contexts/CompaniesContext'
import { SkeletonRows } from '../components/motion'
import { fmtMoneyCompact, fmtMoneyWhole, type BudgetFigureFormat } from '../utils/formatters'
import { countOf, plural } from '../utils/plural'
import { capitalize, monthLongLabel, monthShortLabel } from '../utils/months'
import { useDisplayCurrency } from '../contexts/DisplayCurrencyContext'
import {
  classKeysUnder, nodeKeysUnder, classificationFor, agreedProject,
} from '../services/budgetKeys'
import { useProjects } from '../contexts/ProjectsContext'
import { OVERHEAD_LABEL, projectLabel } from '../services/projects'
import { PROJECT_FILTER_OVERHEAD } from '../services/ledgerFilters'
import {
  inLedgerOrder, variance,
  type Adjustment, type RolledNode, type BudgetCurrency,
} from '../services/budgetForecast'
import {
  loadBudgetTree, LEVELS,
  type BranchId, type BudgetRow,
} from '../services/budgetTree'
import BudgetDrillModal, { type DrillState } from '../components/BudgetDrillModal'
import { DIALOG } from '../components/dialogTheme'
import BudgetChangeDialog from '../components/BudgetChangeDialog'
import AddBudgetLineDialog from '../components/AddBudgetLineDialog'

// ─── Types ───────────────────────────────────────────────────────────────────



interface MonthMeta {
  key: string
  label: string
  isPast: boolean
}

/**
 * How many months of the twelve the table draws.
 *
 * It decides how much room a figure gets and therefore how a figure is
 * printed: at three months the columns are wide enough for `3.097.828 RSD`,
 * beyond that there is no room for anything but `3,1 mil. RSD`. See
 * `figureFormat`, which holds that rule.
 *
 * It does NOT decide what is fetched or rolled up. Twelve months are loaded at
 * every horizon, because the Year column totals twelve months at every
 * horizon — a Year column that silently meant "the three months on screen"
 * would be worse than no Year column. The horizon is a view over data that is
 * already in hand, which is also why changing it does not re-query anything.
 */
type Horizon = 3 | 6 | 12

const HORIZONS: Horizon[] = [3, 6, 12]

/**
 * The table's width, and the three columns whose width is stated rather than
 * shared out.
 *
 * `tableLayout: fixed` divides whatever `minWidth` leaves over the month
 * columns equally, so these four numbers settle every column:
 *
 *   3 months   (1160 - 210 - 100 - 112) / 9  = 82px a column
 *   6 months   (1740 - 220 - 104 - 118) / 18 = 72px a column
 *   12 months  (3000 - 240 - 110 - 120) / 36 = 70px a column
 *
 * `col` is that same figure written down, because the single-company view has
 * to compute a width rather than read one: it draws one column a month instead
 * of three and no Year column at all, so its `minWidth` is the label plus the
 * benchmark plus `col` per month. A figure there is the same width as the same
 * figure on the consolidated view, which is the point of deriving it from this
 * table rather than picking three more numbers.
 *
 * 82px carries a full figure at 12px monospace with the cell's own padding
 * taken off; 70px carries `-3,1 mil. RSD`. The old table asked 36 columns to
 * share 2,130px — 59px apiece — which is where truncated figures came from:
 * not an abbreviation, the text being cut off. Widening the twelve-month table costs nothing that was
 * not already lost, since it scrolls either way.
 */
const LAYOUT: Record<Horizon, {
  minWidth: number; label: number; benchmark: number; year: number; col: number
}> = {
  3: { minWidth: 1204, label: 254, benchmark: 100, year: 112, col: 82 },
  6: { minWidth: 1784, label: 264, benchmark: 104, year: 118, col: 72 },
  12: { minWidth: 3044, label: 284, benchmark: 110, year: 120, col: 70 },
}

/**
 * Room kept at the right of the label cell for the `+` on a sub-category row.
 *
 * Every label width above is 44px wider than it was, and this is where those
 * 44 go. Taking the space out of the name instead would have been the obvious
 * cheap version and the wrong one: the names in that column are already
 * ellipsised — `Outsourcing services and A…` — so the button would have been
 * paid for by the one thing the column exists to show. Each `minWidth` moved
 * by the same 44, which leaves the per-column figures exactly as they were.
 */
const ADD_SLOT = 44

// ─── Helpers ─────────────────────────────────────────────────────────────────

function monthKey(date: Date): string {
  return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}`
}

/** 'YYYY-MM' → 'Okt 2026': a column header, so it starts with a capital. */
function monthLabel(key: string): string {
  return capitalize(monthShortLabel(key))
}

/** '3 meseca', '6 meseci', '12 meseci'. */
const monthsCount = (n: number) => countOf(n, 'mesec', 'meseca', 'meseci')

function addMonths(key: string, n: number): string {
  const [y, m] = key.split('-').map(Number)
  const d = new Date(y, m - 1 + n, 1)
  return monthKey(d)
}

// ─── The two branches ────────────────────────────────────────────────────────
//
// The same five classification levels, read in two orders. The department
// branch answers "who spends it", the P&L branch "what kind of cost it is" —
// and because they are the same money arranged differently, a month's total
// must not move when the toggle flips.
//
// That holds only if neither branch can drop a row. A row with no department
// is not missing from the department branch: it goes under an explicit
// `Unassigned` node, exactly as `ExpenseAnalysis` does it, so nothing the P&L
// branch counts is money the department branch has quietly lost.
//
// At module scope because the tree is not the only thing that walks them.

/**
 * The one rule for how a budget figure is printed: full figures when the
 * horizon is three months, compact beyond it — in the currency the table is
 * read in, its code always written beside it.
 *
 * Decided here rather than at each call site. The budget table prints a figure
 * in a dozen places — actual, estimate, variance, direct, the totals row, the
 * Year column and the drill-down under any of them — and a page where each of
 * those picks its own formatter is a page where two of them eventually
 * disagree about what a figure is.
 */
export function figureFormat(horizonMonths: number, currency: BudgetCurrency): BudgetFigureFormat {
  return horizonMonths <= 3
    ? (n: number, showSign?: boolean) => fmtMoneyWhole(n, currency, showSign)
    : (n: number, showSign?: boolean) => fmtMoneyCompact(n, currency, showSign)
}

function varianceColor(variance: number): string {
  if (variance > 0) return '#00D47E'
  if (variance < 0) return '#FF5B5A'
  return '#7A9BB8'
}

// ─── Main component ──────────────────────────────────────────────────────────

export default function Budgeting() {
  const { companies, defaultCompany, showPicker, error: companiesError } = useCompanies()
  const [companyId, setCompanyId] = useState('')
  /**
   * Which project's budget: '' every project and overhead together (the
   * default, and exactly the page as it was before projects), a project id,
   * or PROJECT_FILTER_OVERHEAD for overhead lines alone. See `loadBudgetTree`.
   */
  const [projectFilter, setProjectFilter] = useState('')
  const { projects } = useProjects()
  const [loading, setLoading] = useState(false)
  const [rows, setRows] = useState<BudgetRow[]>([])
  const [months, setMonths] = useState<MonthMeta[]>([])
  const [collapsed, setCollapsed] = useState<Set<string>>(new Set())
  /** What the last collapse-everything was done for — see the load effect. */
  const shapeRef = useRef('')
  const [refreshTick, setRefreshTick] = useState(0)
  /** month -> nodeKey -> the rolled-up figures budgetForecast returned, in RSD. */
  const [rolledRsd, setRolledRsd] = useState<Record<string, Record<string, RolledNode>>>({})
  /**
   * The same tree read in EUR — from the EUR actuals and each ledger entry's
   * EUR figure — or null where the ledger cannot be read in EUR.
   */
  const [rolledEur, setRolledEur] = useState<Record<string, Record<string, RolledNode>> | null>(null)
  /** Each row's own seed per project, per currency — what a change pins. */
  const [seedByNodeProject, setSeedByNodeProject] = useState<
    Record<BudgetCurrency, Record<string, Record<string, Record<string, number>>>>>({ RSD: {}, EUR: {} })
  /** Why the budget has no EUR reading, said when EUR is asked for. */
  const [eurUnavailable, setEurUnavailable] = useState<string | null>(null)
  /**
   * Benchmark-month spend that carries into no month at all. Shown under the
   * table: a forecast that leaves this out is not short by a knowable amount,
   * it is short by an unknown one.
   */
  const [notCarriedByCurrency, setNotCarriedByCurrency] = useState<Record<BudgetCurrency, number>>({ RSD: 0, EUR: 0 })
  const [drill, setDrill] = useState<DrillState | null>(null)
  /**
   * nodeKey -> month -> the change ledger, exactly as the cell read it.
   *
   * Kept so the drill is handed the entries `applyLedger` moved the figure
   * with, rather than fetching the ledger a second time with a filter of its
   * own — two readings of one ledger is two chances to disagree.
   *
   * "Exactly as the cell read it" is literal, and it is why a carried-over
   * `set` shows here as the `adjust` it was resolved into: the drill lists the
   * movement the cell actually made, not the stored `set to X`, which is a
   * number the cell never moved by.
   *
   * Keyed by the node an entry was RECORDED on, which is not the same as the
   * node whose cell it moved. A parent's figure rolls up its descendants', so
   * the movement behind a parent's cell is its own ledger plus theirs — see
   * `ledgerUnder`, which is what the drill is handed.
   */
  const [ledgerByNode, setLedgerByNode] = useState<Record<string, Record<string, Adjustment[]>>>({})
  /**
   * Credit instalments in the horizon the schedule could not price — a credit
   * in a currency NBS gave no rate for today. Left out of the budget rather
   * than priced at a guess, and counted here so the page can say so.
   */
  const [creditUnpriced, setCreditUnpriced] = useState<Record<BudgetCurrency, number>>({ RSD: 0, EUR: 0 })
  /**
   * The budget cell a change is being made to, and which of the two things the
   * cell offers is open: the dialog that records a change, or the drill that
   * says what the current figure is made of.
   */
  const [budgetCell, setBudgetCell] = useState<
    { row: BudgetRow; m: MonthMeta; current: number; seed: number; seedEur: number | null } | null>(null)
  const [budgetView, setBudgetView] = useState<'change' | 'explain'>('change')
  /**
   * Whether the add-a-line dialog is open.
   *
   * The tree is built from classifications that already carry spend or a
   * ledger entry, so until this existed there was no way to budget for
   * something nobody has paid for yet — which is what planning ahead means.
   * Nothing new is needed to DRAW such a row: `ledgerPaths` above already
   * creates a row for a node that exists only because something was budgeted
   * against it. What was missing was a way to write that entry.
   */
  /**
   * The Add-a-line dialog, and the tree row it was opened from.
   *
   * `null` is closed. `{ seed: [] }` is the page's own button — nothing
   * pre-chosen. `{ seed: [...] }` is the `+` on a sub-category row, which is
   * the same dialog arriving with its first two levels already answered.
   */
  const [addingLine, setAddingLine] = useState<{ seed: string[] } | null>(null)
  const [branch, setBranch] = useState<BranchId>('department')
  const [horizon, setHorizon] = useState<Horizon>(3)
  const [benchmark, setBenchmark] = useState<string>('')
  /**
   * What went wrong on the last load, shown above the table.
   *
   * A budget page that answers a failed fetch with a zero is worse than one
   * that answers with nothing: zero is a figure someone will act on. The only
   * honest thing a failed load can put on screen is what failed.
   */
  const [loadError, setLoadError] = useState('')
  const refresh = () => setRefreshTick(t => t + 1)

  useEffect(() => {
    const cur = monthKey(new Date())
    // The last closed month. A budget is set against what actually happened,
    // and the current month has not happened yet.
    //
    // It is ONE column, not one per month. A per-month "previous month actual"
    // reads empty exactly where it is needed: budgeting October, the previous
    // month is September, which has no actual yet.
    setBenchmark(addMonths(cur, -1))
    // TWELVE, whatever the horizon is. The horizon narrows what is DRAWN; it
    // does not narrow what is loaded, because the Year column totals all
    // twelve months at every horizon and cannot total months nobody fetched.
    // Keeping this at twelve is also what keeps the horizon out of the load
    // effect's dependencies: switching it redraws, it does not re-query.
    setMonths(Array.from({ length: 12 }, (_, i) => {
      const key = addMonths(cur, i)
      return { key, label: monthLabel(key), isPast: false }
    }))
  }, [])

  useEffect(() => {
    // Dropped, this failure reads as "Loading companies…" for ever.
    if (companiesError) setLoadError(companiesError)
  }, [companiesError])

  /** What the whole-group view is called: the company itself, when it is the only one. */
  const groupLabel = showPicker ? 'Sve firme (konsolidovano)' : (defaultCompany?.name || 'Sve firme')

  /**
   * The companies in scope: the one selected, or every company for the
   * consolidated view.
   *
   * MEMOISED, and the memo is load-bearing twice over.
   *
   * The load effect depends on this, because it early-returns while the list
   * is empty and the list is empty until the companies fetch resolves. Left
   * out of the deps — which is what it was — the effect's last run on mount
   * happened before that fetch came back and nothing re-triggered it, so the
   * default consolidated view sat on "No expense data yet" until the user
   * picked a company or hit Refresh.
   *
   * And depending on the array without the memo is the opposite failure: a new
   * array on every render, so the effect sets state, the state re-renders, the
   * array is a different object, the effect runs again, for ever.
   */
  const companyIds = useMemo(
    () => (companyId ? [companyId] : companies.map(c => c.id)),
    [companyId, companies],
  )

  useEffect(() => {
    if (months.length === 0 || companyIds.length === 0 || !benchmark) return
    let cancelled = false

    const run = async () => {
      const tree = await loadBudgetTree(supabase, {
        monthKeys: months.map(m => m.key),
        benchmark, companyIds, companyId, branch, project: projectFilter,
      })
      if (cancelled) return
      setRows(tree.rows)

      // ── Everything collapsed, but only when the tree is a different tree ──
      //
      // The table opens to several hundred rows of leaf detail, and the
      // question it is read for — where is the month landing — is answered by
      // the eleven category rows above them. Collapsing every row that has
      // children leaves exactly those, and opening one then shows its children
      // collapsed in turn rather than its whole subtree at once.
      //
      // NOT ON EVERY LOAD. `refreshTick` bumps after a figure is changed, and
      // re-collapsing then would throw the user back to the top of the table
      // in the middle of the run of edits they were making — the load they are
      // least able to afford losing their place in. So it happens when the
      // shape changes: a different branch, a different company. Same tree,
      // same folds.
      const shape = `${branch}|${companyId}|${companyIds.join(',')}|${projectFilter}`
      if (shapeRef.current !== shape) {
        shapeRef.current = shape
        setCollapsed(new Set(tree.rows.filter(r => r.hasChildren).map(r => r.key)))
      }
      setRolledRsd(tree.rolledRsd)
      setRolledEur(tree.rolledEur)
      setSeedByNodeProject(tree.seedByNodeProject)
      setEurUnavailable(tree.eurUnavailable)
      setNotCarriedByCurrency({ RSD: tree.notCarried, EUR: tree.notCarriedEur })
      setLedgerByNode(tree.ledgerByNode)
      setCreditUnpriced(tree.creditUnpriced)
    }
    // Every query `run` makes reaches the database through `fetchAllPages`,
    // which throws on `error` rather than handing back an empty page — so a
    // failed commitments fetch can no longer render as a clean zero the way it
    // did while `instRes.error` and `invRes.error` went unread, and the throw
    // lands here instead.
    //
    // `run` used to be called bare. A throw out of it skipped
    // `setLoading(false)` altogether and the page showed its loading bar
    // indefinitely with nothing said. `finally` is what makes that impossible;
    // the `catch` is what makes it legible.
    const guarded = async () => {
      setLoading(true)
      setLoadError('')
      try {
        await run()
      } catch (e: any) {
        if (cancelled) return
        setLoadError(e?.message || String(e))
        // Cleared, not left standing. A figure from the last good load sitting
        // under an error message is read as the current one.
        setRows([])
        setRolledRsd({})
        setRolledEur(null)
        setSeedByNodeProject({ RSD: {}, EUR: {} })
        setNotCarriedByCurrency({ RSD: 0, EUR: 0 })
        setLedgerByNode({})
      } finally {
        if (!cancelled) setLoading(false)
      }
    }
    guarded()
    return () => { cancelled = true }
  }, [companyId, companyIds, months, benchmark, branch, refreshTick, projectFilter])

  const toggleCollapse = (key: string) => {
    setCollapsed(prev => {
      const next = new Set(prev)
      next.has(key) ? next.delete(key) : next.add(key)
      return next
    })
  }

  const isVisible = (row: BudgetRow): boolean => {
    if (!row.parent) return true
    const rowByKey = Object.fromEntries(rows.map(r => [r.key, r]))
    const ancestors: string[] = []
    let cur = row.parent
    while (cur) {
      ancestors.push(cur)
      cur = rowByKey[cur]?.parent || ''
    }
    return ancestors.every(a => !collapsed.has(a))
  }

  // The inline estimate editor is gone with `budget_entries`. It upserted on
  // five nullable columns, which in Postgres never matches its own previous
  // row, so every save inserted a duplicate and no save left a record of who
  // changed the figure or why. Nothing now writes a budget figure; the change
  // dialog, which records one ledger entry with a stated reason, takes over.

  const openDrill = (row: BudgetRow, m: MonthMeta, mode: 'actual' | 'estimate') => {
    setDrill({
      rowKey: row.key,
      rowLabel: row.label,
      month: m.key,
      monthLabel: m.label,
      mode,
      // The keys, resolved here against the tree the cell was drawn from. The
      // modal gets a settled set rather than a row key it would have to walk
      // the tree to interpret. A node carries every key summed into it, so a
      // branch that shows three of the five levels still drills to the whole
      // set its total was built from.
      classKeys: classKeysUnder(rows, row.key),
    })
  }


  // ── Which currency the table is read in ─────────────────────────────────
  //
  // The display currency where the budget has it. Budgets are planned in RSD
  // and every figure carries EUR beside it, so EUR is a different column read,
  // not a conversion — except where the ledger holds an entry recorded in
  // dinars only. Then the whole table is read in RSD and says so: a table half
  // in one currency and half in the other would add the two together, and an
  // RSD figure printed as EUR is a wrong number, not a formatting choice.
  const { currency: displayCurrency } = useDisplayCurrency()
  const shownCurrency: BudgetCurrency = displayCurrency === 'EUR' && rolledEur ? 'EUR' : 'RSD'
  const rolled = shownCurrency === 'EUR' && rolledEur ? rolledEur : rolledRsd
  const notCarried = notCarriedByCurrency[shownCurrency]

  /** A node's figures for a month, or zeroes while the tree is being rebuilt. */
  const at = (rowKey: string, mk: string) => rolled[mk]?.[rowKey]
  /** The same in RSD, whatever the table shows: a budget is changed in RSD. */
  const atRsd = (rowKey: string, mk: string) => rolledRsd[mk]?.[rowKey]
  /** The row's own EUR seed, recorded beside the RSD one; null without a EUR reading. */
  const seedEurAt = (rowKey: string, mk: string): number | null =>
    rolledEur ? (rolledEur[mk]?.[rowKey]?.seed || 0) : null

  /**
   * Every ledger entry the drilled cell's figure actually moved by.
   *
   * Scoped like the seeded list beside it. The seeded section drills the whole
   * subtree, via `classKeysUnder`, because `rollUp` makes a cell the sum of
   * what sits on its node plus every descendant's total. The ledger section
   * read one node's own entries, so drilling a parent whose CHILD had been
   * adjusted said "Never changed" beside a cell that had plainly changed, and
   * the entries listed did not add up to the difference between the seed shown
   * above them and the figure the drill was opened from.
   *
   * Sorted by `inLedgerOrder` — the order `applyLedger` replayed them in, read
   * from the same comparator rather than restated here.
   */
  const ledgerUnder = (rowKey: string, month: string): Adjustment[] =>
    nodeKeysUnder(rows, rowKey)
      .flatMap(k => ledgerByNode[k]?.[month] || [])
      .sort(inLedgerOrder)

  /**
   * The classification columns a ledger row stores for this node.
   *
   * Built from the node's own path down the branch, NOT from `row.classKey`.
   * A branch shows three of the five levels, so a node is summed from many keys
   * — Sales and Engineering salaries are one leaf in the P&L branch — and
   * `classKey` is merely whichever of them reached the node first. Reading it
   * would record a change to the whole line against one arbitrary department,
   * and the figure typed would not be the figure that came back.
   *
   * The path is the labels, which are exactly what the node represents.
   *
   * The levels the branch does NOT show are filled in from the node's
   * `classKeys` where every one of them agrees, and left null where they
   * differ — so a P&L node that happens to hold only Sales salaries records
   * `department: 'Sales'` and lands on the Sales row in the other branch, while
   * one spanning Sales and Engineering records `department: null` and lands
   * under `Unassigned`, which is the truthful place for money that belongs to
   * no single department.
   */
  const classificationOf = (row: BudgetRow) =>
    classificationFor(row.pathLabels, row.level, row.classKeys, LEVELS[branch])

  // ── Which project a change is for ───────────────────────────────────────
  //
  // Narrowed to a project — or to overhead — a change is for that scope and
  // the dialogs only name it. On the all-projects view the user picks,
  // starting from the project every key under the row agrees on (overhead
  // where they disagree or name none).
  const scopedProject: string | null | undefined =
    projectFilter === '' ? undefined
      : projectFilter === PROJECT_FILTER_OVERHEAD ? null
        : projectFilter
  const projectLocked = scopedProject !== undefined
  const projectFor = (row?: BudgetRow): string | null =>
    projectLocked ? (scopedProject as string | null) : (row ? agreedProject(row.classKeys) : null)

  /** A row's own seed for ONE project's lines, in RSD and (where readable) EUR. */
  const seedOfProject = (rowKey: string, mk: string, projectId: string | null) => {
    const pk = projectId || ''
    return {
      seed: seedByNodeProject.RSD[rowKey]?.[mk]?.[pk] || 0,
      seedEur: rolledEur ? (seedByNodeProject.EUR[rowKey]?.[mk]?.[pk] || 0) : null,
    }
  }

  /**
   * The labels of a row's direct children, in the order the tree draws them.
   *
   * Read here, where the tree is, and handed to the change dialog — which has
   * no tree and must not go looking for one. It is what lets the dialog say
   * that a change to `SaaS expenses` will NOT land on `Figma`, which is the
   * whole of the trap: a parent with exactly one child prints the same figure
   * as that child, one row above it, in the same green, and the header naming
   * the row is read past.
   *
   * `rows` is already in tree order, so no sort is needed here — `addRow`
   * sorted the children by label on the way in.
   */
  const childLabelsOf = (row: BudgetRow) =>
    rows.filter(r => r.parent === row.key).map(r => r.label)

  /**
   * Whether the page is showing the group rather than one company.
   *
   * This is what decides whether there is a budget on screen at all. The owner
   * budgets consolidated and only consolidated, so the group view is the whole
   * budget and a single company's view is its actuals — see the table header.
   */
  const consolidated = companyId === ''

  /**
   * Clicking a budget figure opens the dialog that records a change to it.
   *
   * The figure handed over is the rolled-up one the cell shows, so the number
   * typed into the dialog is the number the cell will read back — the delta is
   * worked out from the same figure the user was looking at.
   *
   * There is no refusal in front of this any more. It used to return early on
   * the consolidated view, on the grounds that a delta against a multi-company
   * sum was nobody's delta — true while a budget belonged to one company, and
   * false now: the consolidated figure IS the budget, and a change to it is a
   * group line. The budget cell is only drawn on that view, so nothing else
   * reaches here.
   */
  const openBudgetCell = (row: BudgetRow, m: MonthMeta) => {
    // Both figures, and they are not the same one. `current` is what the cell
    // READS — this row plus everything rolled up under it — and is what the
    // delta is taken against. `seed` is what the benchmark month puts on this
    // row ALONE, and is recorded so the figure stops moving when the benchmark
    // does. See `pinnedBase`.
    //
    // Both in RSD whatever the table is showing: budgets are planned in
    // dinars, so the dialog takes the figure in dinars and measures it against
    // the dinar figure. The EUR seed goes along to be recorded beside it.
    setBudgetCell({
      row, m,
      current: atRsd(row.key, m.key)?.budget || 0,
      seed: atRsd(row.key, m.key)?.seed || 0,
      seedEur: seedEurAt(row.key, m.key),
    })
    setBudgetView('change')
  }

  /**
   * What a path down the open branch already reads in a month.
   *
   * Zero for a line nothing has touched, which is the case the add-a-line
   * dialog exists for — but NOT assumed to be zero. The same dialog can be
   * pointed at a classification that already carries a seed, and the change
   * dialog behind it asks for the figure the line should READ. Told the
   * current figure is zero when it is 1.000 RSD, a target of 4.000 RSD would
   * record a delta of +4.000 and the line would come back reading 5.000 RSD.
   *
   * In RSD, for the same reason `openBudgetCell` hands over RSD.
   *
   * The same lookup `openBudgetCell` does, keyed the same way the tree keys
   * its nodes, so a line added here and a cell clicked there agree about what
   * the figure currently is.
   */
  const currentForPath = (pathLabels: string[], mk: string) =>
    atRsd(`${branch}:${pathLabels.join('|')}`, mk)?.budget || 0

  /**
   * What the benchmark month seeds that path with, on that row alone.
   *
   * The other half of what an entry records: `currentForPath` is the figure the
   * delta is measured from, this is the moving part it has to be anchored
   * against. Zero for a line nothing has spent on, which is the usual case
   * here — but read rather than assumed, for the same reason the figure above
   * it is.
   */
  //
  // For one project's lines on that path: the seed a change pins is its own
  // project's, see `seedOfProject`. With no projects on the path that is the
  // path's whole seed, as it always was.
  const seedForPath = (pathLabels: string[], mk: string, projectId: string | null) =>
    seedOfProject(`${branch}:${pathLabels.join('|')}`, mk, projectId).seed
  const seedEurForPath = (pathLabels: string[], mk: string, projectId: string | null) =>
    seedOfProject(`${branch}:${pathLabels.join('|')}`, mk, projectId).seedEur

  /**
   * The drill that is open: an actual cell's, or the explanation behind the
   * budget cell a change is being made to.
   *
   * Memoised because the modal re-reads its month whenever this object's
   * identity changes. Rebuilt inline it would be a new object on every render,
   * and the modal's own `setLoading` would make render and fetch each other's
   * cause.
   */
  const drillOpen = useMemo<DrillState | null>(() => {
    if (drill) return drill
    if (!budgetCell || budgetView !== 'explain') return null
    return {
      rowKey: budgetCell.row.key,
      rowLabel: budgetCell.row.label,
      month: budgetCell.m.key,
      monthLabel: budgetCell.m.label,
      mode: 'estimate',
      classKeys: classKeysUnder(rows, budgetCell.row.key),
    }
  }, [drill, budgetCell, budgetView, rows])

  // Totals. Summed over the roots, which is every node with no parent — not
  // `level === 0`, which no longer means anything now that a level is a column
  // name and the branch decides which one comes first.
  const rootRows = rows.filter(r => !r.parent)
  const sumRoots = (mk: string, pick: (n: RolledNode) => number) =>
    rootRows.reduce((s, r) => {
      const n = at(r.key, mk)
      return s + (n ? pick(n) : 0)
    }, 0)

  const totals: Record<string, { actual: number; budget: number }> = {}
  for (const mk of [benchmark, ...months.map(m => m.key)]) {
    totals[mk] = {
      actual: sumRoots(mk, n => n.actualTotal),
      budget: sumRoots(mk, n => n.budget),
    }
  }

  /**
   * A row's depth: the position of its level in the open branch.
   *
   * Indentation and type styling are a function of depth, never of the level
   * itself — `expense_description` is the third level in both branches, but
   * `department` is the first in one and the third in the other.
   */
  const depthOf = (row: BudgetRow) => Math.max(0, LEVELS[branch].indexOf(row.level))

  /**
   * The months the table draws. `months` — all twelve — is what it totals.
   *
   * Every Year figure on this page reduces over `months`, every month column
   * maps over `visibleMonths`, and the two are deliberately different arrays
   * so that the difference cannot be lost in a rename.
   */
  const visibleMonths = useMemo(() => months.slice(0, horizon), [months, horizon])

  /**
   * How many budgeted figures, in the months on screen, still move with the
   * benchmark.
   *
   * Every entry written from now on records the seed it was measured against
   * and therefore holds still. Entries written before that column existed
   * carry none, and nothing can be invented for them: what the seed was on the
   * afternoon somebody typed a figure is not in this database, and a guess
   * would move money nobody typed. See `pinnedBase`.
   *
   * So they are COUNTED and named instead. A line read again fixes itself —
   * recording the figure a second time anchors it — but only if the owner
   * knows which lines are still loose, and a silently drifting budget is
   * exactly the fault this whole change exists to end.
   *
   * Counted over the months DRAWN rather than all twelve: a warning about a
   * figure in a month the table is not showing has nothing on screen to act
   * on.
   */
  const driftingCount = useMemo(() => {
    const drawn = new Set(visibleMonths.map(m => m.key))
    let n = 0
    for (const byMonth of Object.values(ledgerByNode)) {
      for (const [mk, entries] of Object.entries(byMonth)) {
        if (!drawn.has(mk)) continue
        // One loose line, however many entries are on it: the newest recorded
        // base anchors the whole replay, so a line whose LAST entry carries
        // one is already anchored however many older ones do not.
        const last = [...entries].sort(inLedgerOrder).pop()
        if (last && (last.seed_rsd === null || last.seed_rsd === undefined)) n++
      }
    }
    return n
  }, [ledgerByNode, visibleMonths])

  /**
   * How a figure is printed, decided once from the horizon and used by every
   * cell in the table and by the drill-down under any of them.
   *
   * Not chosen per call site. The drill has to print the same number the same
   * way as the cell it was opened from, which is why it is handed this rather
   * than importing a formatter of its own.
   */
  const fmtFigure = figureFormat(horizon, shownCurrency)

  const layout = LAYOUT[horizon]

  /**
   * How wide the table insists on being.
   *
   * The consolidated widths are the stated ones in `LAYOUT`. A single company
   * draws one column a month instead of three and no Year column, so holding
   * it to the same `minWidth` would stretch nine columns across 1,160px for no
   * reason; it is measured from the same per-column figure instead.
   */
  const tableMinWidth = consolidated
    ? layout.minWidth
    : layout.label + layout.benchmark + horizon * layout.col

  /**
   * The column that is "now".
   *
   * Read off the first month rather than recomputed from the clock: the
   * horizon starts at the current month by construction, so this is the same
   * month the table was built around even if midnight on the first of the
   * month passes while the page is open.
   */
  const nowKey = months[0]?.key ?? ''
  const isNow = (mk: string) => mk !== '' && mk === nowKey

  /**
   * The tint down the current month's three columns.
   *
   * Translucent on purpose: a body cell has the ROW's background behind it —
   * a level-0 row is lighter than a leaf, the totals row is darker — and an
   * opaque tint would flatten all of that into one band.
   */
  const nowCell = (mk: string) => (isNow(mk) ? { background: DIALOG.accentTint } : null)

  /**
   * The same tint over the sub-header band, which has a fill of its own.
   *
   * Stacked rather than replaced: `thSub` is `panelDeep`, and letting the
   * translucent tint stand alone would drop that fill and show the panel
   * behind it, so the current month's ACTUAL / ESTIMATE / VAR strip would sit
   * a shade lighter than every other month's.
   */
  const nowSubCell = (mk: string) => (isNow(mk)
    ? { background: `linear-gradient(${DIALOG.accentTint}, ${DIALOG.accentTint}), ${DIALOG.panelDeep}` }
    : null)

  /**
   * What the budget cell's hover says, which differs by what clicking it will
   * do. On a parent it names the consequence — the change lands here, not on
   * the lines under it — because the figure a parent shows is mostly THEIR
   * money and the instinct is that clicking it edits them.
   *
   * Opens with the same words on both, so the tooltip is recognisable rather
   * than two unrelated sentences.
   */
  const budgetCellTitle = (row: BudgetRow) => {
    const base = 'Kliknite da izmenite ovaj iznos — ili da vidite kako je dobijen'
    if (!row.hasChildren) return base + '.'
    // The same count the dialog will state, from the same reading of the tree.
    const n = childLabelsOf(row).length
    return `${base}. Izmena se beleži na samoj stavci ${row.label}, ne na ${n === 1 ? 'stavci' : countOf(n, 'stavci', 'stavke', 'stavki')} ispod nje.`
  }

  const levelIndent = [0, 20, 36, 50]
  const levelStyles = [
    { fontWeight: '600', fontSize: '12px', color: '#DCE9F6', background: 'rgba(255,255,255,0.025)' },
    { fontWeight: '500', fontSize: '12px', color: '#DCE9F6', background: 'transparent' },
    { fontWeight: '400', fontSize: '12px', color: '#7A9BB8', background: 'transparent' },
    { fontWeight: '400', fontSize: '11px', color: '#7A9BB8', background: 'transparent' },
  ] as const

  return (
    <div style={pg.page} className="app-surface">
      {/* Header */}
      <div style={pg.pageHeader}>
        <div>
          <div style={pg.pageTitle}>Budžet i prognoza</div>
          <div style={pg.pageSub}>
            Prognoza troškova · {monthsCount(horizon)} unapred · referentni mesec: {benchmark ? monthLabel(benchmark) : '—'}
            {companyId === '' && showPicker && (
              <span style={{ marginLeft: '10px', color: '#F5A623', fontWeight: '500' }}>
                · Sve firme
              </span>
            )}
          </div>
        </div>
        <div style={{ display: 'flex', gap: '8px', alignItems: 'center' }}>
          {/* The same money, read two ways. The total must not move. */}
          <div style={pg.toggle}>
            {([['department', 'Sektor'], ['pl', 'P&L']] as const).map(([id, label]) => (
              <button key={id}
                style={{ ...pg.toggleBtn, ...(branch === id ? pg.toggleBtnOn : null) }}
                aria-pressed={branch === id}
                onClick={() => setBranch(id)}>{label}</button>
            ))}
          </div>
          {/* How far ahead to draw.

              Three by default, because three months of full figures is what
              the page is actually read for — this month and the next one or
              two — and twelve columns of compact figures was the reason the figures
              were squeezed until they truncated. Six and twelve are still
              there, still compact, because there is no room for anything
              else at that width. */}
          <div style={pg.toggle}>
            {HORIZONS.map(h => (
              <button key={h}
                style={{ ...pg.toggleBtn, ...(horizon === h ? pg.toggleBtnOn : null) }}
                aria-pressed={horizon === h}
                title={`Prikaži ${plural(h, 'naredni', 'naredna', 'narednih')} ${monthsCount(h)}`}
                onClick={() => setHorizon(h)}>{h}m</button>
            ))}
          </div>
          {/* Which project's budget. "All projects" is the whole budget; one
              project, or overhead, narrows the actuals, the seed and the
              ledger to that scope, and a change made there is for it. */}
          <select
            style={pg.companySelect}
            value={projectFilter}
            aria-label="Projekat"
            title="Projekat"
            onChange={e => setProjectFilter(e.target.value)}
          >
            <option value="">Svi projekti</option>
            <option value={PROJECT_FILTER_OVERHEAD}>{OVERHEAD_LABEL}</option>
            {projects
              .filter(p => !companyId || p.company_id === companyId)
              .map(p => <option key={p.id} value={p.id}>{projectLabel(p)}{p.active ? '' : ' (zatvoren)'}</option>)}
          </select>
          {showPicker && (
            <select
              style={pg.companySelect}
              aria-label="Firme"
              value={companyId}
              onChange={e => setCompanyId(e.target.value)}
            >
              <option value="">{groupLabel}</option>
              {companies.map(c => <option key={c.id} value={c.id}>{c.name}</option>)}
            </select>
          )}
          {/* The way in to a line nothing has been spent on yet. Every other
              row on this page arrives because money already moved; this is
              the only control that can put a row here first.

              Group view only, like the budget columns it writes into: the line
              it adds is the group's, so offering it beside one company's
              actuals would promise a per-company budget that is not a thing. */}
          {consolidated && companies.length > 0 && (
            <button style={pg.addLineBtn} onClick={() => setAddingLine({ seed: [] })}
              title="Budžetirajte nešto na šta još ništa nije potrošeno">
              + Dodaj budžetsku stavku
            </button>
          )}
          {(companyId !== '' || companies.length > 0) && (
            <button style={pg.refreshBtn} onClick={refresh}>↻ Osveži</button>
          )}
        </div>
      </div>

      {/* EUR asked for and not available: said, and the table read in RSD
          with RSD on every figure, rather than RSD figures called EUR. */}
      {displayCurrency === 'EUR' && shownCurrency === 'RSD' && !loading && !loadError && rows.length > 0 && (
        <div role="note" style={{
          marginBottom: '14px', padding: '10px 14px',
          background: 'rgba(245,166,35,0.12)', border: '0.5px solid rgba(245,166,35,0.3)',
          borderRadius: '8px', fontSize: '12px', color: '#F5A623',
        }}>
          ⚠ {eurUnavailable || 'Ovaj budžet ne može da se prikaže u EUR, pa je prikazan u RSD.'}
        </div>
      )}

      {/* What failed. Above the table, not below it, because the thing it is
          warning about is the absence of the table. */}
      {loadError && (
        <div style={{
          marginBottom: '14px', padding: '10px 14px',
          background: 'rgba(255,91,90,0.12)', border: '0.5px solid rgba(255,91,90,0.35)',
          borderRadius: '8px', fontSize: '12px', color: '#FF5B5A',
        }}>
          ⚠ Budžet nije učitan: {loadError}
        </div>
      )}

      {/* One line where the budget, variance and Year columns were.

          A single company's spend against the GROUP's budget is not a
          comparison, so it is not drawn — and a column that is simply absent
          invites the reading that this company has no budget. It says which it
          is, and where the per-company question is actually answered. */}
      {!consolidated && !loadError && (
        <div style={pg.groupNote}>
          Budžeti se postavljaju za grupu, ne po firmi — izaberite <strong style={{ color: '#DCE9F6', fontWeight: '600' }}>{groupLabel}</strong> da
          biste videli kolone budžeta, odstupanja i godine. Troškove po firmama raščlanjuje P&amp;L analiza.
        </div>
      )}

      {loadError && !loading ? null : companies.length === 0 && !loading ? (
        <div style={pg.empty}>
          {/* `pg.empty` centres its children, so the placeholder needs a
            width of its own or it collapses to nothing. */}
        <div style={{ width: '100%', maxWidth: '420px' }}>
          <SkeletonRows rows={3} height={16} gap={14} widths={[64, 48, 56]} />
        </div>
        </div>
      ) : loading ? (
        <div style={pg.empty}>
          <div style={{ width: '100%', maxWidth: '760px' }}>
            <SkeletonRows rows={8} height={16} gap={14}
              widths={[82, 60, 90, 52, 78, 46, 86, 64]} />
          </div>
        </div>
      ) : rows.length === 0 ? (
        <div style={pg.empty}>
          <div style={{ fontSize: '15px', fontWeight: '500', color: '#DCE9F6', marginBottom: '8px' }}>Još nema podataka o troškovima</div>
          <div style={{ fontSize: '13px', color: '#7A9BB8' }}>Klasifikujte transakcije po novčanom toku i budžet će se popuniti</div>
        </div>
      ) : (
        <div style={pg.tableWrap}>
          <table style={{ ...pg.table, minWidth: `${tableMinWidth}px` }}>
            <thead>
              <tr>
                <th style={{ ...pg.th, textAlign: 'left', width: `${layout.label}px`, paddingLeft: '16px', background: '#0A1525' }}>
                  {branch === 'department' ? 'Sektor' : 'Kategorija troška'}
                </th>
                {/* One benchmark column, left of the horizon: the last closed
                    month's actual, the figure every budget to its right is set
                    against. */}
                <th style={{
                  ...pg.th, textAlign: 'right', width: `${layout.benchmark}px`, background: '#070F1C',
                  borderRight: '0.5px solid rgba(255,255,255,0.10)',
                  fontSize: '12px', fontWeight: '500', textTransform: 'none', letterSpacing: '0',
                }}>
                  {benchmark ? monthLabel(benchmark) : '—'}
                  <div style={{ fontSize: '10px', fontWeight: '400', color: '#7A9BB8' }}>ostvareno</div>
                </th>
                {/* The month we are in, in the foreground: the header carries
                    the accent and says so in words, and the three columns
                    under it are tinted the whole way down. Nothing here is a
                    new colour — it is the accent the page already uses, at the
                    two strengths named in `dialogTheme`. */}
                {visibleMonths.map(m => (
                  <th key={m.key} colSpan={consolidated ? 3 : 1} style={{
                    ...pg.th, textAlign: 'center',
                    color: isNow(m.key) ? DIALOG.accent : m.isPast ? 'rgba(255,255,255,0.30)' : '#DCE9F6',
                    fontSize: '12px', fontWeight: isNow(m.key) ? '700' : '500',
                    textTransform: 'none', letterSpacing: '0',
                    background: isNow(m.key) ? DIALOG.accentFill : m.isPast ? '#070F1C' : '#0A1525',
                    borderLeft: '1px solid rgba(255,255,255,0.06)',
                  }}>
                    {m.isPast ? `← ${m.label}` : m.label}
                    {isNow(m.key) && (
                      <div style={{ fontSize: '9px', fontWeight: '500', letterSpacing: '0.08em', color: DIALOG.accent }}>
                        OVAJ MESEC
                      </div>
                    )}
                  </th>
                ))}
                {/* The Year column is the same twelve months at every
                    horizon, and its header says which twelve. A "Year" column
                    that quietly meant "the three months on screen" would be
                    worse than no Year column at all.

                    It totals the BUDGET, so it goes with the budget: on one
                    company there is none to total. */}
                {consolidated && (
                  <th style={{
                    ...pg.th, textAlign: 'right', width: `${layout.year}px`, background: '#0A1525',
                    borderLeft: '0.5px solid rgba(255,255,255,0.10)',
                    fontSize: '12px', fontWeight: '500', textTransform: 'none', letterSpacing: '0',
                  }}>
                    Godina
                    <div style={{ fontSize: '10px', fontWeight: '400', color: '#7A9BB8' }}>svih 12 meseci</div>
                  </th>
                )}
              </tr>
              <tr>
                <th style={{ ...pg.thSub, paddingLeft: '16px', textAlign: 'left' }}>
                  {companyId === '' ? groupLabel : companies.find(c => c.id === companyId)?.name}
                </th>
                <th style={{ ...pg.thSub, color: 'rgba(255,255,255,0.45)', textAlign: 'right', paddingRight: '8px', background: '#070F1C', borderRight: '0.5px solid rgba(255,255,255,0.10)' }}>
                  REFERENCA
                </th>
                {visibleMonths.map(m => (
                  <React.Fragment key={m.key}>
                    <th style={{ ...pg.thSub, ...nowSubCell(m.key), color: m.isPast ? 'rgba(255,255,255,0.20)' : 'rgba(255,255,255,0.45)', textAlign: 'right', paddingRight: consolidated ? '8px' : '12px', borderLeft: '1px solid rgba(255,255,255,0.05)' }}>OSTVARENO</th>
                    {consolidated && (
                      <>
                        <th style={{ ...pg.thSub, ...nowSubCell(m.key), color: m.isPast ? 'rgba(255,255,255,0.20)' : '#5DCAA5', textAlign: 'right', paddingRight: '8px' }}>PROCENA</th>
                        <th style={{ ...pg.thSub, ...nowSubCell(m.key), color: m.isPast ? 'rgba(255,255,255,0.20)' : 'rgba(255,255,255,0.30)', textAlign: 'right', paddingRight: '12px' }}>ODST.</th>
                      </>
                    )}
                  </React.Fragment>
                ))}
                {consolidated && (
                  <th style={{ ...pg.thSub, color: '#5DCAA5', textAlign: 'right', paddingRight: '12px', borderLeft: '0.5px solid rgba(255,255,255,0.10)' }}>BUDŽET</th>
                )}
              </tr>
            </thead>

            <tbody>
              {rows.filter(isVisible).map(row => {
                const depth = depthOf(row)
                const style = levelStyles[depth]
                const isCollapsible = row.hasChildren
                const isCollapsed = collapsed.has(row.key)
                const benchActual = at(row.key, benchmark)?.actualTotal || 0
                // What sits on this node itself rather than on a child. On a
                // parent it has to be shown as its own row: folded into the
                // subtotal it would be invisible, which is precisely what the
                // additive rule — a parent is the sum of what is under it, plus
                // what was entered on it — exists to prevent.
                // Over all twelve, not the window. The direct row exists so a
                // parent's figure is accounted for, and the parent's Year cell
                // is twelve months — a direct amount falling in month eight
                // would otherwise be in the Year total with no row explaining
                // it the moment the horizon is three.
                // Consolidated only, because `direct` is the part of a
                // parent's BUDGET that sits on the parent itself — on one
                // company there is no budget column for it to account for.
                const showDirect = consolidated && isCollapsible && !isCollapsed
                  && months.some(m => (at(row.key, m.key)?.direct || 0) !== 0)

                return (
                  <React.Fragment key={row.key}>
                  <tr style={{ background: style.background, borderBottom: depth === 0 ? '1px solid rgba(255,255,255,0.06)' : '0.5px solid rgba(255,255,255,0.03)' }}>
                    <td style={{
                      ...pg.td,
                      paddingLeft: `${16 + levelIndent[depth]}px`,
                      fontWeight: style.fontWeight,
                      fontSize: style.fontSize,
                      color: style.color,
                      cursor: isCollapsible ? 'pointer' : 'default',
                      userSelect: 'none',
                    }}
                    // The label column is the one thing the narrower horizon
                    // takes width FROM, and a long expense description still
                    // ends in an ellipsis. The full label is at least
                    // readable on hover rather than lost.
                    title={row.label}
                    onClick={() => isCollapsible && toggleCollapse(row.key)}>
                      <div style={{ display: 'flex', alignItems: 'center', gap: '6px' }}>
                        {isCollapsible
                          ? <span style={{ fontSize: '9px', color: '#7A9BB8', width: '12px', flexShrink: 0 }}>{isCollapsed ? '▶' : '▼'}</span>
                          : <span style={{ width: '12px', flexShrink: 0 }} />
                        }
                        <span style={{ flex: 1, minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis' }}>
                          {row.label}
                        </span>

                        {/* ADD A LINE UNDER THIS SUB-CATEGORY.
                            Only here, and not because it is tidier: an expense
                            description belongs to a dept. sub-category in the
                            database — `expense_descriptions.dept_subcategory_id`
                            — so this is the only node in either branch that can
                            own a new child. Offering the same `+` on a P&L
                            sub-category would open a dialog that cannot insert
                            what it appears to be asking for.

                            It stops the click: the cell itself folds the row,
                            and a button that folds what it just opened is a
                            button nobody trusts twice. */}
                        {row.level === 'dept_subcategory' && (
                          <button
                            className="mf-add-under"
                            style={pg.addUnder}
                            title={`Budžetirajte opis troška pod ${row.label} na koji još ništa nije potrošeno`}
                            aria-label={`Dodaj budžetsku stavku pod ${row.label}`}
                            onClick={ev => {
                              ev.stopPropagation()
                              setAddingLine({ seed: row.pathLabels })
                            }}>
                            +
                          </button>
                        )}
                      </div>
                    </td>

                    {/* BENCHMARK — the last closed month's actual. It drills
                        exactly as a month's actual does: same row, same
                        `classKeysUnder`, so the list matches the number. */}
                    <td style={{
                      ...pg.td, textAlign: 'right', paddingRight: '8px', background: 'rgba(0,0,0,0.18)',
                      borderRight: '0.5px solid rgba(255,255,255,0.10)',
                      fontVariantNumeric: 'tabular-nums', fontFamily: "'DM Mono', 'Fira Mono', monospace",
                    }}>
                      {benchActual > 0 ? (
                        <span
                          style={{ color: '#4EA8FF', cursor: 'pointer', textDecoration: 'underline', textDecorationStyle: 'dotted', textDecorationColor: 'rgba(78,168,255,0.4)', textUnderlineOffset: '3px' }}
                          title="Kliknite da vidite transakcije referentnog meseca"
                          onClick={() => openDrill(row, { key: benchmark, label: monthLabel(benchmark), isPast: true }, 'actual')}
                        >
                          {fmtFigure(benchActual)}
                        </span>
                      ) : <span style={{ color: 'rgba(255,255,255,0.15)' }}>—</span>}
                    </td>

                    {visibleMonths.map(m => {
                      const node = at(row.key, m.key)
                      const actual = node?.actualTotal || 0
                      const budget = node?.budget || 0
                      const edited = (node?.ledger || 0) !== 0
                      const varAmt = variance(budget, actual)

                      return (
                        <React.Fragment key={m.key}>
                          {/* ACTUAL */}
                          <td style={{ ...pg.td, ...nowCell(m.key), textAlign: 'right', paddingRight: consolidated ? '8px' : '12px', borderLeft: '1px solid rgba(255,255,255,0.04)', fontVariantNumeric: 'tabular-nums', fontFamily: "'DM Mono', 'Fira Mono', monospace" }}>
                            {actual > 0 ? (
                              <span
                                style={{ color: '#FF8080', cursor: 'pointer', textDecoration: 'underline', textDecorationStyle: 'dotted', textDecorationColor: 'rgba(255,128,128,0.4)', textUnderlineOffset: '3px' }}
                                title="Kliknite da vidite transakcije"
                                onClick={() => openDrill(row, m, 'actual')}
                              >
                                {fmtFigure(actual)}
                              </span>
                            ) : <span style={{ color: 'rgba(255,255,255,0.15)' }}>—</span>}
                          </td>

                          {/* BUDGET — seed plus ledger plus every child.
                              Clickable again: the figure it shows is the group's
                              budget and a change to it is a group line. */}
                          {consolidated && (
                            <td style={{ ...pg.td, ...nowCell(m.key), textAlign: 'right', paddingRight: '8px', fontVariantNumeric: 'tabular-nums', fontFamily: "'DM Mono', 'Fira Mono', monospace" }}>
                              <span
                                style={{
                                  color: edited ? '#4EA8FF' : (budget !== 0 ? '#00D47E' : 'rgba(255,255,255,0.15)'),
                                  cursor: 'pointer', display: 'inline-flex', alignItems: 'center', gap: '4px',
                                  // A parent's figure is a subtotal and a leaf's
                                  // is a figure. A parent with one child prints
                                  // the SAME number as that child directly above
                                  // it, and two identical numbers in one column
                                  // are what made the wrong one clickable by
                                  // mistake. Weight, not colour: the colours in
                                  // this column already mean seeded / edited /
                                  // empty and a fourth would say nothing.
                                  fontWeight: isCollapsible ? '600' : '400',
                                }}
                                title={budgetCellTitle(row)}
                                onClick={() => openBudgetCell(row, m)}
                              >
                                {budget !== 0 ? fmtFigure(budget) : '—'}
                                {edited && <span style={{ fontSize: '8px', color: '#4EA8FF' }}>✎</span>}
                              </span>
                            </td>
                          )}

                          {/* VARIANCE */}
                          {consolidated && (
                            <td style={{ ...pg.td, ...nowCell(m.key), textAlign: 'right', paddingRight: '12px', fontVariantNumeric: 'tabular-nums', fontFamily: "'DM Mono', 'Fira Mono', monospace" }}>
                              {(actual > 0 || budget !== 0)
                                ? <span style={{ color: varianceColor(varAmt), fontSize: '11px', fontWeight: '500' }}>{varAmt === 0 ? '—' : fmtFigure(varAmt, true)}</span>
                                : <span style={{ color: 'rgba(255,255,255,0.15)' }}>—</span>}
                            </td>
                          )}
                        </React.Fragment>
                      )
                    })}

                    {/* YEAR */}
                    {consolidated && (
                      <td style={{ ...pg.td, textAlign: 'right', paddingRight: '12px', borderLeft: '0.5px solid rgba(255,255,255,0.10)', fontWeight: '500', color: '#00D47E', fontVariantNumeric: 'tabular-nums', fontFamily: "'DM Mono', 'Fira Mono', monospace" }}>
                        {fmtFigure(months.reduce((s, m) => s + (at(row.key, m.key)?.budget || 0), 0))}
                      </td>
                    )}
                  </tr>

                  {showDirect && (
                    <tr style={{ borderBottom: '0.5px solid rgba(255,255,255,0.03)' }}>
                      {/* The label leads with what this money IS, because the
                          label column truncates and the tail is what goes.
                          `direct — not attributed to a sub-line` truncated to
                          `direct — not attributed to a...`, which reads as
                          "uncategorised" — and it is nothing of the kind: it is
                          the part of the parent's own budget that was entered
                          on the parent. The first three words now carry it, and
                          the full sentence is on hover. */}
                      <td
                        style={{ ...pg.td, paddingLeft: `${16 + levelIndent[Math.min(depth + 1, levelIndent.length - 1)]}px`, fontSize: '11px', color: '#7A9BB8', fontStyle: 'italic' }}
                        title={`Budžetirano na samoj stavci ${row.label}, a ne na nekoj od stavki ispod nje. Nije nerazvrstano i nije greška: iznos nadređene stavke je zbir svega ispod nje plus onoga što je uneto na nju samu, a ovaj red je taj drugi deo.`}
                      >
                        na samoj stavci {row.label} — ne na stavci ispod nje
                      </td>
                      <td style={{ ...pg.td, background: 'rgba(0,0,0,0.18)', borderRight: '0.5px solid rgba(255,255,255,0.10)' }} />
                      {visibleMonths.map(m => (
                        <React.Fragment key={m.key}>
                          <td style={{ ...pg.td, ...nowCell(m.key), borderLeft: '1px solid rgba(255,255,255,0.04)' }} />
                          <td style={{ ...pg.td, ...nowCell(m.key), textAlign: 'right', paddingRight: '8px', fontSize: '11px', color: '#7A9BB8', fontVariantNumeric: 'tabular-nums', fontFamily: "'DM Mono', 'Fira Mono', monospace" }}>
                            {fmtFigure(at(row.key, m.key)?.direct || 0)}
                          </td>
                          <td style={{ ...pg.td, ...nowCell(m.key) }} />
                        </React.Fragment>
                      ))}
                      <td style={{ ...pg.td, textAlign: 'right', paddingRight: '12px', borderLeft: '0.5px solid rgba(255,255,255,0.10)', fontSize: '11px', color: '#7A9BB8', fontVariantNumeric: 'tabular-nums', fontFamily: "'DM Mono', 'Fira Mono', monospace" }}>
                        {fmtFigure(months.reduce((s, m) => s + (at(row.key, m.key)?.direct || 0), 0))}
                      </td>
                    </tr>
                  )}
                  </React.Fragment>
                )
              })}


              {/* TOTALS */}
              <tr style={{ background: '#0A1525', borderTop: '2px solid #00D47E' }}>
                <td style={{ ...pg.td, paddingLeft: '16px', fontWeight: '700', fontSize: '11px', color: '#DCE9F6', letterSpacing: '0.1em', textTransform: 'uppercase' }}>
                  Ukupni troškovi
                </td>
                <td style={{ ...pg.td, textAlign: 'right', paddingRight: '8px', background: 'rgba(0,0,0,0.18)', borderRight: '0.5px solid rgba(255,255,255,0.10)', color: (totals[benchmark]?.actual || 0) > 0 ? '#4EA8FF' : 'rgba(255,255,255,0.20)', fontWeight: '600', fontVariantNumeric: 'tabular-nums', fontFamily: "'DM Mono', monospace" }}>
                  {(totals[benchmark]?.actual || 0) > 0 ? fmtFigure(totals[benchmark].actual) : '—'}
                </td>
                {visibleMonths.map(m => {
                  const cell = totals[m.key] || { actual: 0, budget: 0, committed: 0 }
                  // The budget AND what is already owed. A total that showed
                  // only the budget would read lower than the month costs.
                  const forecast = cell.budget
                  const varAmt = variance(forecast, cell.actual)
                  return (
                    <React.Fragment key={m.key}>
                      <td style={{ ...pg.td, ...nowCell(m.key), textAlign: 'right', paddingRight: consolidated ? '8px' : '12px', color: cell.actual > 0 ? '#FF8080' : 'rgba(255,255,255,0.20)', fontWeight: '600', fontVariantNumeric: 'tabular-nums', fontFamily: "'DM Mono', monospace", borderLeft: '1px solid rgba(255,255,255,0.06)' }}>
                        {cell.actual > 0 ? fmtFigure(cell.actual) : '—'}
                      </td>
                      {consolidated && (
                        <>
                          <td style={{ ...pg.td, ...nowCell(m.key), textAlign: 'right', paddingRight: '8px', color: '#00D47E', fontWeight: '600', fontVariantNumeric: 'tabular-nums', fontFamily: "'DM Mono', monospace" }}>
                            {forecast !== 0 ? fmtFigure(forecast) : '—'}
                          </td>
                          <td style={{ ...pg.td, ...nowCell(m.key), textAlign: 'right', paddingRight: '12px', fontWeight: '600', fontVariantNumeric: 'tabular-nums', fontFamily: "'DM Mono', monospace" }}>
                            <span style={{ color: varianceColor(varAmt) }}>
                              {(cell.actual > 0 || forecast !== 0) ? fmtFigure(varAmt, true) : '—'}
                            </span>
                          </td>
                        </>
                      )}
                    </React.Fragment>
                  )
                })}
                {consolidated && (
                  <td style={{ ...pg.td, textAlign: 'right', paddingRight: '12px', borderLeft: '0.5px solid rgba(255,255,255,0.10)', color: '#00D47E', fontWeight: '700', fontVariantNumeric: 'tabular-nums', fontFamily: "'DM Mono', monospace" }}>
                    {fmtFigure(months.reduce((s, m) => s + (totals[m.key]?.budget || 0), 0))}
                  </td>
                )}
              </tr>
            </tbody>
          </table>
        </div>
      )}

      {/* What the forecast does NOT carry. A seeded budget always looks
          complete, so the one line that says how short it is has to be on the
          screen beside it — an omission nobody is told about is worse than no
          forecast at all. */}
      {!loading && notCarried > 0 && (
        <div style={{
          marginTop: '14px', padding: '10px 14px',
          background: 'rgba(245,166,35,0.12)', border: '0.5px solid rgba(245,166,35,0.3)',
          borderRadius: '8px', fontSize: '12px', color: '#F5A623',
        }}>
          ⚠ {fmtFigure(notCarried)} potrošnje iz referentnog meseca{benchmark ? ` (${monthLongLabel(benchmark)})` : ''} ne
          prenosi se dalje — jednokratno, kapitalno ili nerazvrstano. Naredni meseci su potcenjeni najmanje za toliko.
        </div>
      )}

      {/* Figures recorded before a budget stopped being a moving target.
          Named rather than silently fixed: nothing in this database says what
          the seed was when they were typed, so they cannot be anchored for the
          owner — only by the owner, by recording the figure again. */}
      {consolidated && !loading && driftingCount > 0 && (
        <div style={{
          marginTop: '14px', padding: '10px 14px',
          background: 'rgba(245,166,35,0.12)', border: '0.5px solid rgba(245,166,35,0.3)',
          borderRadius: '8px', fontSize: '12px', color: '#F5A623', lineHeight: 1.6,
        }}>
          ⚠ {countOf(driftingCount, 'budžetski iznos', 'budžetska iznosa', 'budžetskih iznosa')} {plural(driftingCount, 'je unet', 'su uneta', 'je uneto')} pre
          nego što su budžeti fiksirani, pa se još {plural(driftingCount, 'pomera', 'pomeraju', 'pomera')} sa
          referentnim mesecom i više {plural(driftingCount, 'nije', 'nisu', 'nije')} ono što je uneto.
          Kliknite svaki zeleni iznos i unesite koliki treba da bude — jedan unos ga trajno fiksira.
        </div>
      )}

      {/* Credit instalments the schedule could not price. There is no
          fallback rate any more — a made-up rate prices every instalment at a
          plausible figure on a page that looks completely normal — so an
          instalment with no rate is left out, and this says how many. */}
      {consolidated && !loading && creditUnpriced[shownCurrency] > 0 && (
        <div style={{
          marginTop: '14px', padding: '10px 14px',
          background: 'rgba(245,166,35,0.12)', border: '0.5px solid rgba(245,166,35,0.3)',
          borderRadius: '8px', fontSize: '12px', color: '#F5A623',
        }}>
          ⚠ Kurs NBS nije dostupan, pa {countOf(creditUnpriced[shownCurrency], 'rata kredita', 'rate kredita', 'rata kredita')}{' '}
          {plural(creditUnpriced[shownCurrency], 'nije uračunata', 'nisu uračunate', 'nije uračunato')} u procene
          za kredite — naredni meseci su za toliko potcenjeni. Pokušajte ponovo kasnije.
        </div>
      )}

      {/* Legend */}
      {rows.length > 0 && (
        <div style={pg.legend}>
          <div style={pg.legendItem}><span style={{ ...pg.legendDot, background: '#FF8080' }} /> Ostvareno — kliknite da vidite transakcije</div>
          {/* The rest of the legend explains columns that are only drawn for
              the group. Left standing on one company it would name three
              colours that are not on screen. */}
          {consolidated && <>
            <div style={pg.legendItem}><span style={{ ...pg.legendDot, background: '#00D47E' }} /> Budžet — preuzet iz referentnog meseca, kliknite da ga izmenite</div>
            <div style={pg.legendItem}><span style={{ ...pg.legendDot, background: '#4EA8FF' }} /> <span style={{ fontSize: '9px' }}>✎</span> Promenjeno izmenom budžeta</div>
            <div style={pg.legendItem}><span style={{ color: '#00D47E', fontWeight: '600' }}>+</span> Ispod budžeta · <span style={{ color: '#FF5B5A', fontWeight: '600' }}>−</span> Iznad budžeta</div>
          </>}
        </div>
      )}

      {drillOpen && (
        <BudgetDrillModal
          drill={drillOpen}
          companyIds={companyIds}
          benchmark={benchmark}
          benchmarkLabel={benchmark ? monthLabel(benchmark) : '—'}
          // The ledger the cell itself read, not a second query for it —
          // this node's own entries and every descendant's, because the cell
          // is the sum of them.
          ledgerEntries={ledgerUnder(drillOpen.rowKey, drillOpen.month)}
          currency={shownCurrency}
          // The horizon's formatter, so the drill prints the figure it was
          // opened from exactly as the cell printed it.
          format={fmtFigure}
          onChange={budgetCell ? () => setBudgetView('change') : undefined}
          onClose={() => { setDrill(null); setBudgetCell(null) }}
          onEditDone={() => { setDrill(null); setBudgetCell(null); refresh() }}
        />
      )}

      {/* A change is an entry in an append-only ledger, so this dialog is the
          only thing on the page that writes a budget figure — and it writes a
          difference with a reason, never a value over a value. */}
      {budgetCell && budgetView === 'change' && (
        <BudgetChangeDialog
          month={budgetCell.m.key}
          monthLabel={budgetCell.m.label}
          level={budgetCell.row.level}
          classification={classificationOf(budgetCell.row)}
          rowLabel={budgetCell.row.label}
          current={budgetCell.current}
          seed={budgetCell.seed}
          seedEur={budgetCell.seedEur}
          projectId={projectFor(budgetCell.row)}
          projectLocked={projectLocked}
          seedForProject={pid => seedOfProject(budgetCell.row.key, budgetCell.m.key, pid)}
          // The dialog says what the change is about to land ON, not merely
          // which row was clicked. It needs the children to do that, and the
          // tree is here.
          childLabels={childLabelsOf(budgetCell.row)}
          onExplain={() => setBudgetView('explain')}
          onClose={() => setBudgetCell(null)}
          onSaved={refresh}
        />
      )}

      {/* Adding a line is picking a classification and a month; the figure and
          the reason are still taken by `BudgetChangeDialog`, which this hands
          off to. One writer of `budget_adjustments`, not two.

          The months offered are the ones DRAWN, not all twelve: a figure
          budgeted into a month the table is not showing would appear to have
          done nothing but move the Year total. Widening the horizon widens
          this too. */}
      {addingLine && (
        <AddBudgetLineDialog
          levels={LEVELS[branch]}
          months={visibleMonths}
          currentFor={currentForPath}
          seedFor={seedForPath}
          seedEurFor={seedEurForPath}
          seedPath={addingLine.seed}
          projectId={projectFor()}
          projectLocked={projectLocked}
          onClose={() => setAddingLine(null)}
          // The row itself needs nothing new to appear: `ledgerPaths` builds a
          // row for any node the ledger names, so a reload is the whole of it.
          onSaved={refresh}
        />
      )}

      <style>{`
        @keyframes bgtpulse { 0%,100%{opacity:1} 50%{opacity:.4} }
        tbody tr:hover { background: rgba(255,255,255,0.03) !important; }
      `}</style>
    </div>
  )
}

// ─── Styles (Obsidian) ───────────────────────────────────────────────────────

const pg: Record<string, React.CSSProperties> = {
  page: {
    padding: '24px 28px',
    fontFamily: "'Inter', system-ui, sans-serif",
    minHeight: '100vh',
    // The background lives in `.app-surface`: an inline colour would
    // paint straight over it.
    color: '#DCE9F6',
  },
  pageHeader: {
    display: 'flex', alignItems: 'flex-start', justifyContent: 'space-between',
    marginBottom: '1.25rem',
  },
  pageTitle: {
    fontFamily: "'DM Serif Display', Georgia, serif",
    fontSize: '24px',
    fontWeight: '400',
    color: '#DCE9F6',
    letterSpacing: '-0.01em',
    marginBottom: '4px',
  },
  pageSub: {
    fontSize: '13px',
    color: '#7A9BB8',
  },
  companySelect: {
    fontFamily: "'Inter', sans-serif",
    fontSize: '13px',
    padding: '7px 12px',
    border: '1px solid rgba(255,255,255,0.075)',
    borderRadius: '8px',
    background: '#0D1B2C',
    color: '#DCE9F6',
    outline: 'none',
    minWidth: '240px',
    cursor: 'pointer',
  },
  // Lifted out of the branch toggle, which had it inline, so the horizon
  // selector beside it is the same control rather than a copy of it.
  toggle: {
    display: 'flex',
    border: `0.5px solid ${DIALOG.border}`,
    borderRadius: '8px',
    overflow: 'hidden' as const,
  },
  toggleBtn: {
    fontFamily: "'Inter', system-ui, sans-serif",
    fontSize: '12px',
    padding: '7px 14px',
    border: 'none',
    cursor: 'pointer',
    background: 'transparent',
    color: DIALOG.dim,
  },
  toggleBtnOn: {
    background: DIALOG.accentFill,
    color: DIALOG.accent,
  },
  // The same shape as Refresh beside it, in the blue the page already uses for
  // "this figure has a ledger entry behind it" — which is exactly what adding
  // a line creates. No new colour, no new control.
  addLineBtn: {
    fontFamily: "'Inter', sans-serif",
    fontSize: '12px',
    padding: '7px 14px',
    border: '1px solid rgba(78,168,255,0.4)',
    borderRadius: '8px',
    background: 'rgba(78,168,255,0.08)',
    color: '#4EA8FF',
    cursor: 'pointer',
    fontWeight: '500',
  },
  refreshBtn: {
    fontFamily: "'Inter', sans-serif",
    fontSize: '12px',
    padding: '7px 14px',
    border: '1px solid rgba(0,212,126,0.4)',
    borderRadius: '8px',
    background: 'rgba(0,212,126,0.08)',
    color: '#00D47E',
    cursor: 'pointer',
    fontWeight: '500',
  },
  empty: {
    display: 'flex', flexDirection: 'column' as const,
    alignItems: 'center', justifyContent: 'center',
    minHeight: '400px',
    color: '#7A9BB8',
    textAlign: 'center' as const,
    background: '#0D1B2C',
    border: '1px solid rgba(255,255,255,0.06)',
    borderRadius: '12px',
  },
  // The line that stands where the budget columns are not. Blue, like every
  // other "this is how this page works" note on screen, rather than amber:
  // nothing is wrong and nothing is missing.
  groupNote: {
    marginBottom: '14px',
    padding: '10px 14px',
    background: 'rgba(78,168,255,0.08)',
    border: '0.5px solid rgba(78,168,255,0.28)',
    borderRadius: '8px',
    fontSize: '12px',
    color: '#7A9BB8',
    lineHeight: 1.5,
  },
  tableWrap: {
    borderRadius: '12px',
    // Six months is 19 columns beside the label and twelve is 37. They scroll
    // rather than being squeezed until a figure reads as an ellipsis — which
    // is what the three-month horizon exists to avoid having to do at all.
    overflowX: 'auto' as const,
    overflowY: 'hidden' as const,
    boxShadow: '0 4px 20px rgba(0,0,0,0.4)',
    background: '#0D1B2C',
    border: '1px solid rgba(255,255,255,0.06)',
  },
  // `minWidth` is NOT here: it is the horizon's, from `LAYOUT`, and a default
  // left behind in this object would be the width the table falls back to the
  // day someone forgets to pass one.
  table: {
    width: '100%',
    borderCollapse: 'collapse' as const,
    tableLayout: 'fixed' as const,
  },
  th: {
    padding: '11px 8px',
    fontSize: '10px',
    fontWeight: '600',
    letterSpacing: '0.08em',
    textTransform: 'uppercase' as const,
    color: '#DCE9F6',
    whiteSpace: 'nowrap' as const,
    borderBottom: '1px solid rgba(255,255,255,0.08)',
  },
  thSub: {
    padding: '7px 8px',
    fontSize: '9.5px',
    fontWeight: '600',
    letterSpacing: '0.1em',
    background: '#0A1525',
    borderBottom: '1px solid rgba(0,212,126,0.25)',
    whiteSpace: 'nowrap' as const,
  },
  /**
   * The `+` on a sub-category row.
   *
   * Always visible — the owner asked to be able to SEE it, and a control that
   * appears only on hover is a control nobody finds. Quiet, though: forty of
   * these at full strength would read as a column of buttons with the account
   * names in between. `.mf-add-under` in index.css does the brightening.
   */
  addUnder: {
    flexShrink: 0,
    width: `${ADD_SLOT - 14}px`,
    height: '20px',
    lineHeight: '17px',
    padding: 0,
    border: '1px solid rgba(255,255,255,0.14)',
    borderRadius: '6px',
    background: 'rgba(255,255,255,0.04)',
    color: '#7A9BB8',
    fontSize: '14px',
    cursor: 'pointer',
    fontFamily: "'Inter', system-ui, sans-serif",
  },
  td: {
    padding: '9px 8px',
    fontSize: '12px',
    color: '#DCE9F6',
    whiteSpace: 'nowrap' as const,
    overflow: 'hidden',
    textOverflow: 'ellipsis',
  },
  legend: {
    display: 'flex',
    gap: '20px',
    marginTop: '14px',
    flexWrap: 'wrap' as const,
    padding: '10px 14px',
    background: '#0D1B2C',
    border: '1px solid rgba(255,255,255,0.06)',
    borderRadius: '10px',
  },
  legendItem: {
    display: 'flex',
    alignItems: 'center',
    gap: '6px',
    fontSize: '11px',
    color: '#7A9BB8',
  },
  legendDot: {
    width: '8px',
    height: '8px',
    borderRadius: '50%',
    display: 'inline-block',
    flexShrink: 0,
  },
}

