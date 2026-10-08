// ─── budgetTree ─────────────────────────────────────────────────────────────
//
// Assembling the budget: what it is seeded from, what has been recorded
// against it, what is already committed, and the tree all of that hangs on.
//
// This was four hundred lines inside the Budgeting page, which was fine while
// the page was the only thing that wanted it. The Simulation tab wants the
// same tree for one month on the P&L branch while the budget table is showing
// the department branch for twelve — and the choice was between forcing the
// page's own toggle, writing the queries a second time, or moving the
// assembly somewhere both can ask. This is the third.
//
// NOTHING HERE WAS REWRITTEN. The body is the page's own `run()`, moved line
// for line: the closure variables became parameters and `supabase` became a
// client that is handed in. The arithmetic it calls — `seedFromEntries`,
// `applyLedger`, `rollUp`, `creditScheduleByMonth` — was already in
// `budgetForecast` and is untouched.
//
// Taking the client as an argument is what makes it testable at all. The page
// passes the real one; a test passes something that answers like PostgREST.

import { fetchAllPages } from '../utils/fetchAllPages'
import {
  makeClassKey, valueAt, placeEntry, seedForEntry,
} from './budgetKeys'
import { getRatesForDate } from './currencyService'
import {
  seedFromEntries, creditScheduleByMonth, applyLedger, rollUp,
  type Adjustment, type Installment,
  type ForecastNode, type RolledNode, type Level,
} from './budgetForecast'

/** Which way the same money is read. */
export type BranchId = 'department' | 'pl'

/**
 * The levels each branch walks, in order.
 *
 * Here rather than in the page because the tree is built from them: a caller
 * asking for the P&L branch is asking for these three levels, and the page
 * that draws the answer should not be the thing that defines it.
 */
export const LEVELS: Record<BranchId, Level[]> = {
  department: ['department', 'dept_subcategory', 'expense_description'],
  pl: ['pl_category', 'pl_subcategory', 'expense_description'],
}

export interface BudgetRow {
  key: string
  label: string
  level: Level
  parent?: string
  hasChildren: boolean
  /**
   * The first classification key that landed on this node. It is one arbitrary
   * member of `classKeys` and nothing that has to be right may read it — a
   * node is summed from many keys, so one of them can never stand for it.
   */
  classKey?: string
  /** Every classification key summed into this node. The drill reads these. */
  classKeys: string[]
  /**
   * The labels walked down `LEVELS[branch]` to reach this node — `['Sales',
   * 'Salaries']` and so on.
   *
   * This, not `classKey`, is what a node IS. A change recorded against a node
   * has to name the path, because the node's own figure is summed from every
   * classification key matching that path and no single key identifies it.
   */
  pathLabels: string[]
}

/** Enough of a Supabase client for the queries below. */
export interface QueryClient {
  from: (table: string) => any
}

export interface BudgetTreeRequest {
  /** The horizon, in order, as `YYYY-MM`. */
  monthKeys: string[]
  /** The month the seed is carried forward from. */
  benchmark: string
  /** Every company in scope. Empty means the effect should not have run. */
  companyIds: string[]
  /** One company, or `''` for the consolidated group. Scopes the ledger. */
  companyId: string
  branch: BranchId
}

export interface BudgetTree {
  /** Depth-first, parents before children, siblings alphabetical. */
  rows: BudgetRow[]
  /** month -> nodeKey -> the rolled-up figures. */
  rolled: Record<string, Record<string, RolledNode>>
  /** Benchmark spend that carries into no month at all. */
  notCarried: number
  /** nodeKey -> month -> the change ledger, exactly as the cell reads it. */
  ledgerByNode: Record<string, Record<string, Adjustment[]>>
  /**
   * What the credit schedule put into the horizon, in dollars.
   *
   * Only so the page can say whether a fallback exchange rate is actually
   * pricing anything. Zero instalments and an unreachable NBS is not a
   * warning worth showing.
   */
  creditScheduled: number
  /** True when the credit schedule is priced at a rate NBS could not give. */
  ratesAreFallback: boolean
}

/**
 * Everything the budget table and the simulation both need, for one branch
 * over one set of months.
 *
 * Throws rather than returning an empty tree: every query goes through
 * `fetchAllPages`, which throws on a PostgREST error instead of handing back
 * an empty page, and a budget that reads as zero because a fetch failed is the
 * exact fault this was rebuilt to remove.
 */
export async function loadBudgetTree(
  client: QueryClient, req: BudgetTreeRequest,
): Promise<BudgetTree> {
  const { monthKeys, benchmark, companyIds, companyId, branch } = req
  const firstMonth = monthKeys[0]
  const lastMonth = monthKeys[monthKeys.length - 1]

  // The benchmark sits before the horizon, so one fetch covers both and the
  // benchmark column is built from the same rows as every month column.
  const fetchFrom = benchmark < firstMonth ? benchmark : firstMonth

  // Cells are built for the benchmark as well as the horizon; the month
  // columns are still the horizon alone.
  const cellMonths = [benchmark, ...monthKeys]

  const lastDayOfMonth = (mk: string) => {
    const [y, m] = mk.split('-').map(Number)
    return `${mk}-${String(new Date(y, m, 0).getDate()).padStart(2, '0')}`
  }

  // v_pl_entries is transactions and invoices together — the same universe
  // Expense Analysis and the Dashboard report on. Reading `transactions` alone
  // left every invoice-driven expense, payroll included, out of these actuals.
  // Paged, because PostgREST caps a response at 1000 rows without saying so.
  const actuals = await fetchAllPages<any>((from, to) => {
    let q = client.from('v_pl_entries')
      // cf_type and cf_frequency ride along: the seed is built from these
      // same rows, so the forecast and the actuals cannot disagree about
      // which universe they describe.
      .select('id, amount_usd, pl_category, pl_subcategory, department, dept_subcategory, expense_description, pl_date, company_id, source, cf_type, cf_frequency')
      // The view carries revenue as well: its tx_type is the transaction's
      // tx_subtype. Without this filter revenue lands in an expense budget.
      .eq('tx_type', 'expense')
      .gte('pl_date', `${fetchFrom}-01`)
      .lte('pl_date', lastDayOfMonth(lastMonth))
    // Skipped rather than passed empty: `.in(col, [])` matches nothing.
    // Skipping it matches everything, which is only safe because the effect
    // returns early while `companyIds` is empty. Do not copy the check
    // without that early return — DrillModal had to grow its own.
    if (companyIds.length > 0) q = q.in('company_id', companyIds)
    return q.order('pl_date').order('id').range(from, to)
  })

  // The page stops estimating. The benchmark month's own rows, carried
  // forward by the cash-flow classification already on them, are the seed;
  // anything that carries into no month at all comes back as `notCarried`
  // rather than being dropped in silence.
  // `seeds` is every selected company merged, which is what the TREE is
  // built from: consolidated, the group's Sales line is both companies'
  // Sales spend. `seedsByCompany` is the same money kept apart, and it is
  // what a carried-over `set` is measured against — a figure recorded on
  // one company's line says nothing about another's. See `seedForEntry`.
  const {
    byKey: seeds, byCompany: seedsByCompany, notCarried: shortfall,
  } = seedFromEntries(actuals, monthKeys, benchmark)

  // The change ledger. Append-only, so this is every change ever recorded
  // against these months, replayed in `created_at` order by `applyLedger`.
  const adjustments = await fetchAllPages<any>((from, to) => {
    let q = client.from('budget_adjustments')
      // `company_id` still rides along, and is still not decoration: a
      // `set` is resolved against the seed of the company it was recorded
      // on. Every row this app writes now carries null there, meaning the
      // group; the rows that name a company came from the carry-across of
      // `budget_entries` and are resolved against that company's seed.
      // `seed_usd` is what stops a typed figure moving when the benchmark
      // month rolls over. Left out of this list, every cell on the page goes
      // back to drifting and nothing says so. See `pinnedBase`.
      .select('id, company_id, budget_month, level, pl_category, pl_subcategory, department, dept_subcategory, expense_description, kind, amount_usd, reason, created_at, seed_usd')
      .gte('budget_month', `${firstMonth}-01`)
      .lte('budget_month', `${lastMonth}-01`)
    // NO company filter on the consolidated view, deliberately. The budget
    // is the group's, so the group's ledger is every row: the null ones
    // this app writes AND the carried-over ones that still name a company.
    // `.in('company_id', everyCompany)` would look equivalent and is not —
    // `in` never matches NULL, so it would drop every line the owner has
    // set since budgeting became group-level. Filtered only where one
    // company is selected, and that view does not draw a budget at all.
    if (companyId) q = q.in('company_id', [companyId])
    return q.order('created_at').order('id').range(from, to)
  })

  const ledger: Record<string, Record<string, Adjustment[]>> = {}
  /** nodeKey -> its path labels, for entries whose node the tree may lack. */
  const ledgerPaths = new Map<string, string[]>()
  for (const a of adjustments) {
    // Every entry is placed. NOTHING is skipped.
    //
    // An adjustment stores the classification it was made on and the level
    // it sits at; `placeEntry` walks this branch's levels down to it, so an
    // entry lands on the node it was recorded against and not on some
    // ancestor. An entry recorded at a level this branch does not show — a
    // P&L sub-category while the department branch is open — is placed at
    // the deepest level this branch does carry a value for, under
    // `Unassigned` when it carries none.
    //
    // Skipping it, which is what this used to do, left the amount out of
    // one branch's total and in the other's: the two then disagreed by
    // exactly the amount skipped, and the spec's core invariant — the same
    // money in two orders — was broken by the page that displays it.
    const placed = placeEntry(a, LEVELS[branch])
    const nodeKey = `${branch}:${placed.key}`
    // Sliced, not parsed: `budget_month` is a date-only string, so
    // `new Date()` reads it as UTC midnight while `getMonth()` reports
    // local time. West of UTC that files the entry a month early.
    const mk = String(a.budget_month).slice(0, 7)

    // A `set` is resolved into a delta before it reaches `applyLedger`.
    //
    // Nothing this app writes is a `set`: `BudgetChangeDialog` only ever
    // inserts `adjust`. Every `set` row in existence came from
    // 20260917130000_budget_adjustments.sql, which carried each row of the
    // old `budget_entries` table across as one opening `set` so the figures
    // from the previous budget screen were not lost.
    //
    // Read literally, those rows break the page's central invariant. A
    // `set` means "this line reads X", and the line it lands on is seeded
    // differently in the two branches — 1000 on `Sales → Reps → Base pay`,
    // 3000 on `Payroll → Salaries → Base pay`, which holds Engineering's
    // salaries too. Replacing a per-node base therefore moved the two
    // totals by different amounts and the branches disagreed. Rewriting the
    // entry as the amount less the seed of its OWN classification gives a
    // figure that does not depend on branch ordering, so a budget carried
    // over from the old screen can no longer make the two branches
    // disagree. See `seedForEntry`.
    //
    // Scoped to the entry's OWN company, which is the other half of the
    // same rule. Consolidated, the tree merges the companies under one
    // classification key; the base this is measured against may not merge
    // with them, or a +200 on one company's Sales line becomes a -800 the
    // moment a second company is selected and the group total stops being
    // the sum of the companies in it.
    const entry: Adjustment = a.kind !== 'set' ? a : {
      ...a,
      kind: 'adjust',
      amount_usd: a.amount_usd - seedForEntry(a, seedsByCompany, mk),
    }

    if (!ledger[nodeKey]) ledger[nodeKey] = {}
    if (!ledger[nodeKey][mk]) ledger[nodeKey][mk] = []
    ledger[nodeKey][mk].push(entry)
    // The labels as walked, not re-split out of the key: a classification
    // value containing a `|` would come back as more labels than levels.
    ledgerPaths.set(nodeKey, placed.pathLabels)
  }

  // ── What is already owed ──────────────────────────────────────────────
  //
  // Not estimates and not seeded from history: an instalment has a dated
  // schedule and an unpaid invoice has a due date. They are kept apart from
  // the seeded base and listed one by one, so a budget can never quietly
  // absorb one.
  //
  // Both PAGED. PostgREST caps a response at 1000 rows and says nothing,
  // so an unpaged commitments query is short by everything past the cap:
  // with 1,050 open invoices, fifty vanish, the Committed row and the page
  // total are short by their value, and without a deterministic `.order()`
  // it is a DIFFERENT fifty on every reload. This is the exact fault the
  // rebuild exists to remove; it must not be reintroduced in a query the
  // rebuild itself added.
  const [installmentRows] = await Promise.all([
    fetchAllPages<any>((from, to) => client.from('credit_installments')
      .select('id, installment_no, due_date, principal_amount, interest_amount, status, credits(name, company_id)')
      // EVERY instalment in the horizon, paid or not. One paid on the 3rd
      // cost the month exactly what one still due on the 30th will, and a
      // schedule that counts only what is outstanding melts away as the month
      // is paid: the estimate falls to nothing while the actual rises, and the
      // variance reads as an overspend of the whole amount. There are only two
      // statuses, so this is the schedule and nothing else.
      .gte('due_date', `${firstMonth}-01`)
      .lte('due_date', lastDayOfMonth(lastMonth))
      // An instalment's company hangs off `credits`, so the scope is
      // settled in JavaScript below by `inScope`. That is only safe
      // BECAUSE this is paged: an unpaged join filter would have let one
      // company's instalments consume the whole cap.
      .order('due_date').order('id').range(from, to)),
  ])

  // One rate for the horizon is honest here in a way it is not in the
  // ledger: this is a forecast of a future payment, and nobody knows the
  // rate on a date that has not arrived.
  const rates = await getRatesForDate(new Date().toISOString().slice(0, 10))
  const eurUsd = rates.eurRsdRate / rates.usdRsdRate

  const inScope = (cid: any) => companyIds.length === 0 || companyIds.includes(cid)

  // ── The credit schedule, onto the rows it is classified to ────────────
  //
  // Not a commitment and not a seed: the one expense whose future is stated
  // exactly. It used to land in the Committed row, which has no category, so
  // the biggest single outflow of the month was the only one a reader could
  // not look up — while the credit rows above it estimated nothing at all.
  const schedule = creditScheduleByMonth(
    installmentRows
      .filter((i: any) => inScope((i.credits as any)?.company_id))
      .map((i: any): Installment => ({
        id: i.id, credit_name: (i.credits as any)?.name || 'Credit',
        installment_no: i.installment_no, due_date: i.due_date,
        principal_amount: i.principal_amount || 0, interest_amount: i.interest_amount || 0,
        status: i.status, eurUsd,
      })),
    monthKeys,
  )

  // nodeKey -> month -> actual recorded against this node itself, before
  // any roll-up. `rollUp` does the adding; handing it pre-rolled figures
  // would count every child twice.
  const actualByNode: Record<string, Record<string, number>> = {}
  const actualMap: Record<string, Record<string, number>> = {}
  for (const tx of actuals) {
    const mk = tx.pl_date.slice(0, 7)
    const ck = makeClassKey(tx)
    if (!actualMap[ck]) actualMap[ck] = {}
    actualMap[ck][mk] = (actualMap[ck][mk] || 0) + (tx.amount_usd || 0)
  }

  // The schedule is merged into the seed rather than carried beside it: a
  // budget cell is seed + ledger + children, and a third source would be a
  // third thing `rollUp` has to know about. What it replaces is the estimate
  // those two rows never had.
  for (const [ck, byMonth] of Object.entries(schedule.byKey)) {
    if (!seeds[ck]) seeds[ck] = {}
    for (const [mk, amount] of Object.entries(byMonth)) {
      seeds[ck][mk] = Math.round(((seeds[ck][mk] || 0) + amount) * 100) / 100
    }
  }

  const allKeys = new Set<string>([
    ...Object.keys(actualMap),
    ...Object.keys(seeds),
  ])

  const rowMap: Record<string, BudgetRow> = {}
  // nodeKey -> every classification key that passed through it. A node in a
  // three-level branch is summed from every key matching those three
  // levels, so it holds a set, not one key.
  const keySets: Record<string, Set<string>> = {}

  const ensureRow = (
    key: string, label: string, level: Level, pathLabels: string[],
    parent: string | null, classKey?: string,
  ) => {
    if (!rowMap[key]) {
      rowMap[key] = {
        key, label, level, parent: parent || undefined,
        hasChildren: false, classKey, classKeys: [], pathLabels,
      }
      if (parent && rowMap[parent]) rowMap[parent].hasChildren = true
    }
    if (classKey) {
      if (!keySets[key]) keySets[key] = new Set()
      keySets[key].add(classKey)
    }
  }

  // Every key walks its branch's levels in full. Nothing is skipped for a
  // missing value and nothing is dropped for an unclassified row — a level
  // with no value becomes `Unassigned`, which is what keeps the two
  // branches totalling the same. The old walk returned early on a key with
  // neither a P&L category nor a department, so that money was in neither.
  // nodeKey -> month -> the seed carried onto this node itself.
  //
  // Accumulated across every key that ENDS here, never looked up by one.
  // A branch shows three of the five levels, so one node is the sum of
  // every key matching those three — Sales salaries and Engineering
  // salaries are a single leaf in the P&L branch, and reading one key's
  // seed would show one department's cost as the whole company's.
  //
  // Only a key's final node is credited. `ensureRow` deliberately records
  // the key on every ancestor too, because the drill has to list them all,
  // but seeding an ancestor from that set as well would count every
  // descendant twice once `rollUp` adds the children in.
  const seedByNode: Record<string, Record<string, number>> = {}

  for (const ck of allKeys) {
    const parts = ck.split('|')
    let parentKey: string | null = null
    let nodeKey = ''
    const labels: string[] = []
    for (const level of LEVELS[branch]) {
      const label = valueAt(parts, level)
      labels.push(label)
      nodeKey = `${branch}:${labels.join('|')}`
      ensureRow(nodeKey, label, level, [...labels], parentKey, ck)
      parentKey = nodeKey
    }

    const row = rowMap[nodeKey]
    if (!row) continue

    for (const mk of cellMonths) {
      const a = actualMap[ck]?.[mk] || 0
      if (a) {
        if (!actualByNode[nodeKey]) actualByNode[nodeKey] = {}
        actualByNode[nodeKey][mk] = (actualByNode[nodeKey][mk] || 0) + a
      }
      const s = seeds[ck]?.[mk] || 0
      if (s) {
        if (!seedByNode[nodeKey]) seedByNode[nodeKey] = {}
        seedByNode[nodeKey][mk] = (seedByNode[nodeKey][mk] || 0) + s
      }
    }
  }

  // A figure budgeted against a line that has neither spend nor a seed still
  // needs a row, or its money is in the total with nothing on screen
  // accounting for it. Built from the entry's own path rather than from a
  // synthetic classification key, so it creates exactly the node the entry
  // sits on and no empty `Unassigned` descendants beneath it.
  for (const [nodeKey, labels] of Array.from(ledgerPaths.entries())) {
    if (rowMap[nodeKey]) continue
    let parentKey: string | null = null
    for (let i = 0; i < labels.length; i++) {
      const key = `${branch}:${labels.slice(0, i + 1).join('|')}`
      ensureRow(key, labels[i], LEVELS[branch][i], labels.slice(0, i + 1), parentKey)
      parentKey = key
    }
  }

  for (const key of Object.keys(rowMap)) {
    rowMap[key].classKeys = Array.from(keySets[key] || [])
  }

  // ── The arithmetic, once per month, all of it in budgetForecast ───────
  //
  // `applyLedger` is given the seed and the difference taken back out, so
  // every entry reaches `rollUp` as a delta — which keeps `rollUp`'s single
  // rule, budget = seed + ledger + every child, intact for every node
  // alike. By the time the ledger gets here that is all there is: the
  // assembly loop above has already resolved each carried-over `set` into
  // its own branch-independent delta.
  const rolledByMonth: Record<string, Record<string, RolledNode>> = {}
  for (const mk of cellMonths) {
    const nodes: ForecastNode[] = Object.values(rowMap).map(r => {
      const seed = seedByNode[r.key]?.[mk] || 0
      return {
        key: r.key, label: r.label, level: r.level, parent: r.parent ?? null,
        seed,
        ledger: applyLedger(seed, ledger[r.key]?.[mk] || []) - seed,
        actual: actualByNode[r.key]?.[mk] || 0,
      }
    })
    rolledByMonth[mk] = Object.fromEntries(rollUp(nodes).map(n => [n.key, n]))
  }

  const finalRows = Object.values(rowMap)
  const ordered: BudgetRow[] = []
  const visited = new Set<string>()

  const addRow = (key: string) => {
    if (visited.has(key)) return
    visited.add(key)
    const row = rowMap[key]
    if (!row) return
    ordered.push(row)
    const children = finalRows.filter(r => r.parent === key)
    children.sort((a, b) => a.label.localeCompare(b.label))
    for (const child of children) addRow(child.key)
  }

  const roots = finalRows.filter(r => !r.parent)
  roots.sort((a, b) => a.label.localeCompare(b.label))
  for (const root of roots) addRow(root.key)

  return {
    rows: ordered,
    rolled: rolledByMonth,
    notCarried: shortfall,
    creditScheduled: schedule.total,
    ledgerByNode: ledger,
    ratesAreFallback: rates.isFallback,
  }
}
