// ─── Expense analysis tree ──────────────────────────────────────────────────
//
// Pure logic — no UI, no database — so the numbers can be tested.
//
// FOUR branches over the same rows:
//
//   pl          P&L Category → P&L Sub-category        "what kind of cost"
//   department  Department → Sub-category → Expense    "who spends it"
//   stream      Revenue stream → P&L Cat → Sub-cat     "which business pays"
//   type        OPEX / Performance → P&L Cat → Sub-cat "fixed, or bought growth"
//
// All four MUST total the same. Rows missing a level are placed under an
// explicit Unassigned node rather than dropped, so the totals always tie and
// the unclassified amount is a visible item to fix instead of a silent
// shortfall. On 2026 data that is $146k sitting outside the department branch.
//
// ── Why a row is a set of contributions and not a path ──────────────────────
//
// The first two branches FILE a row: one invoice belongs to one category and
// one department, so its whole amount goes down one path. The last two
// ALLOCATE it: a $1,000 bill can be 60% Social Growth and 40% Aimfox, and
// there is no single path it belongs to. Forcing it down one would either
// hand a stream money it did not spend or drop $400 on the floor.
//
// So `contributionsFor` returns a LIST — one entry for the filing branches,
// up to two for the allocating ones — and the tree adds each of them where it
// belongs. That is what keeps the four totals equal: the shares of a row sum
// to the row, by the arithmetic in services/allocation.ts.
//
// The consequence to remember when reading the screen: in an allocated branch
// a transaction appears under BOTH halves, at part of its value each. The
// drill-down says so rather than letting the reader try to add the list up.
//
// `side` exists so the revenue half can be added later without reshaping any
// of this; today every caller passes 'expense'.

import { allocAmount, opexAlloc, type AllocEntry } from './allocation'

export type Branch = 'pl' | 'department' | 'stream' | 'type'
export type Side = 'expense' | 'revenue'

export const UNASSIGNED = 'Unassigned'

/** Branch roots that are a share of each row rather than a home for it. */
export const SOCIAL_GROWTH = 'Social Growth'
export const AIMFOX = 'Aimfox'
export const OPEX = 'OPEX'
export const PERFORMANCE = 'Performance'

/** Whether a branch splits rows by value. Drives the drill-down's wording. */
export function isAllocated(branch: Branch): boolean {
  return branch === 'stream' || branch === 'type'
}

export const BRANCH_LABEL: Record<Branch, string> = {
  pl: 'By P&L category',
  department: 'By department',
  stream: 'By revenue stream',
  type: 'Performance vs OPEX',
}

/** Column heading over the tree's first column, per branch. */
export const BRANCH_COLUMNS: Record<Branch, string> = {
  pl: 'Category / sub-category',
  department: 'Department / sub-category / description',
  stream: 'Revenue stream / category / sub-category',
  type: 'Cost type / category / sub-category',
}

export interface PlEntry extends AllocEntry {
  id?: string
  tx_type?: string | null
  amount_usd: number | null
  pl_category: string | null
  pl_subcategory: string | null
  department: string | null
  dept_subcategory: string | null
  expense_description: string | null
  pl_date: string                 // 'YYYY-MM-DD'
  company_id?: string | null
  source?: string | null
}

export interface TreeNode {
  key: string                     // full path, joined — stable id for hide/expand
  label: string
  path: string[]
  depth: number
  amount: number
  count: number
  monthly: Record<string, number> // 'YYYY-MM' → amount, for sparklines
  children: TreeNode[]
}

export interface ComparedNode extends TreeNode {
  priorAmount: number
  delta: number
  deltaPct: number | null         // null when there is no prior base to divide by
  children: ComparedNode[]
}

/**
 * What counts as an expense.
 *
 * Deliberately the same definition the P&L page uses, so the two pages can be
 * put side by side without an argument about which total is right. Anything
 * that only moves cash — passthrough, credit_payment, invoice_payment — is out:
 * it is a bank transfer, not a cost.
 */
export const EXPENSE_TX_TYPES: readonly string[] = ['expense', 'invoice_expense']
export const REVENUE_TX_TYPES: readonly string[] = ['revenue', 'invoice_revenue']

export function isExpenseRow(e: PlEntry): boolean {
  return EXPENSE_TX_TYPES.includes(e.tx_type || '')
}

export function isRevenueRow(e: PlEntry): boolean {
  return REVENUE_TX_TYPES.includes(e.tx_type || '')
}

export function rowsFor(entries: PlEntry[], side: Side): PlEntry[] {
  return entries.filter(side === 'expense' ? isExpenseRow : isRevenueRow)
}

/**
 * Newest first, by the date the money moved.
 *
 * That is `transaction_date` / `invoice_date` — the business date — never the
 * row's created_at. When an invoice was typed in says nothing about the period
 * it belongs to, and a list ordered by entry date reads as shuffled to anyone
 * who knows the underlying business.
 *
 * ISO dates compare correctly as strings, so no Date objects are built for what
 * can be several hundred rows. Equal dates fall back to the larger amount, so
 * the order is stable rather than whatever the source happened to return.
 */
export function byDateDesc<T extends { date?: string | null; pl_date?: string | null; amountUsd?: number | null; amount_usd?: number | null }>(
  a: T, b: T,
): number {
  const da = a.date ?? a.pl_date ?? ''
  const db = b.date ?? b.pl_date ?? ''
  if (da !== db) return db < da ? -1 : 1
  return Math.abs(b.amountUsd ?? b.amount_usd ?? 0) - Math.abs(a.amountUsd ?? a.amount_usd ?? 0)
}

const SEP = ' › '            // › — will not occur inside a category name

const norm = (v: string | null | undefined): string => {
  const s = (v || '').trim()
  return s || UNASSIGNED
}

/**
 * Path of a row within a FILING branch. Missing levels collapse to Unassigned.
 *
 * Only `pl` and `department` have one. An allocated branch puts a row in two
 * places at once, so asking it for "the" path is a question with no answer —
 * which is why the type refuses it rather than returning a half-truth.
 */
export function pathFor(e: PlEntry, branch: 'pl' | 'department'): string[] {
  return branch === 'pl'
    ? [norm(e.pl_category), norm(e.pl_subcategory)]
    : [norm(e.department), norm(e.dept_subcategory), norm(e.expense_description)]
}

/** A row's amount under one path. A row may have several. */
export interface Contribution {
  path: string[]
  amount: number
}

/**
 * Everywhere a row belongs in a branch, and for how much.
 *
 * The filing branches give one contribution carrying the whole row. The
 * allocating ones give two, whose amounts come from services/allocation.ts —
 * the same functions the old P&L page's two analytic columns were printed
 * from, including the currency factor that stops a 220,996 RSD split being
 * read as dollars.
 *
 * `Math.abs` for the same reason the rest of this file uses it: an expense is
 * shown as a positive cost whichever sign it was stored with. Applied to each
 * share rather than to the row, so a 60/40 split of an $800 credit note is
 * $480 and $320 — and still adds back to $800.
 *
 * Zero-value contributions are returned rather than filtered: `buildTree`
 * skips them, and a caller asking "does this row touch Aimfox" gets a truthful
 * zero instead of a missing entry it has to interpret.
 */
export function contributionsFor(e: PlEntry, branch: Branch): Contribution[] {
  const whole = Math.abs(e.amount_usd || 0)

  if (branch === 'pl' || branch === 'department') {
    return [{ path: pathFor(e, branch), amount: whole }]
  }

  // Both allocated branches then break down the same way the P&L itself did:
  // by cost category. "Aimfox spent $12k" is a fact; "Aimfox spent $12k, of
  // which $9k on ads" is the one that can be acted on.
  const tail = [norm(e.pl_category), norm(e.pl_subcategory)]

  if (branch === 'stream') {
    return [
      { path: [SOCIAL_GROWTH, ...tail], amount: Math.abs(allocAmount(e, 'sg')) },
      { path: [AIMFOX, ...tail], amount: Math.abs(allocAmount(e, 'af')) },
    ]
  }
  return [
    { path: [OPEX, ...tail], amount: Math.abs(opexAlloc(e, 'opex')) },
    { path: [PERFORMANCE, ...tail], amount: Math.abs(opexAlloc(e, 'performance')) },
  ]
}

/** Whether a row puts any money under `path` — the drill-down's predicate. */
export function contributesTo(e: PlEntry, branch: Branch, path: string[]): boolean {
  return contributionsFor(e, branch).some(
    c => c.amount > 0 && path.every((seg, i) => c.path[i] === seg))
}

/** How much of a row sits under `path`. Equals the row in a filing branch. */
export function contributionTo(e: PlEntry, branch: Branch, path: string[]): number {
  return contributionsFor(e, branch)
    .filter(c => path.every((seg, i) => c.path[i] === seg))
    .reduce((sum, c) => sum + c.amount, 0)
}

export function buildTree(entries: PlEntry[], branch: Branch): TreeNode[] {
  const roots: TreeNode[] = []
  const index = new Map<string, TreeNode>()

  for (const e of entries) {
    const month = (e.pl_date || '').slice(0, 7)

    for (const { path, amount } of contributionsFor(e, branch)) {
      if (!amount) continue

      let siblings = roots
      const acc: string[] = []
      for (let depth = 0; depth < path.length; depth++) {
        acc.push(path[depth])
        const key = acc.join(SEP)
        let node = index.get(key)
        if (!node) {
          node = {
            key, label: path[depth], path: [...acc], depth,
            amount: 0, count: 0, monthly: {}, children: [],
          }
          index.set(key, node)
          siblings.push(node)
        }
        node.amount += amount
        node.count += 1
        if (month) node.monthly[month] = (node.monthly[month] || 0) + amount
        siblings = node.children
      }
    }
  }

  const sortDeep = (nodes: TreeNode[]) => {
    nodes.sort((a, b) => b.amount - a.amount)
    nodes.forEach(n => sortDeep(n.children))
  }
  sortDeep(roots)
  return roots
}

export function totalOf(nodes: TreeNode[]): number {
  return nodes.reduce((s, n) => s + n.amount, 0)
}

export function flatten(nodes: TreeNode[]): TreeNode[] {
  const out: TreeNode[] = []
  const walk = (ns: TreeNode[]) => ns.forEach(n => { out.push(n); walk(n.children) })
  walk(nodes)
  return out
}

export function findNode(nodes: TreeNode[], key: string): TreeNode | undefined {
  return flatten(nodes).find(n => n.key === key)
}

/**
 * Amount of a node that is still visible.
 *
 * Every row walks its full path, so a parent's amount is exactly the sum of
 * its children. That makes the visible amount simply the sum of visible
 * children — and hiding a child of an already-hidden parent cannot subtract
 * twice, because the hidden parent short-circuits first.
 */
function visibleAmount(node: TreeNode, hidden: Set<string>): number {
  if (hidden.has(node.key)) return 0
  if (node.children.length === 0) return node.amount
  return node.children.reduce((s, c) => s + visibleAmount(c, hidden), 0)
}

/**
 * Total with hidden subtrees removed.
 *
 * Hiding excludes from the total on purpose — it is what makes "how much do we
 * spend excluding one-offs" answerable, rather than just tidying the screen.
 */
export function adjustedTotal(nodes: TreeNode[], hidden: Set<string>): number {
  return nodes.reduce((s, n) => s + visibleAmount(n, hidden), 0)
}

export function excludedTotal(nodes: TreeNode[], hidden: Set<string>): number {
  return totalOf(nodes) - adjustedTotal(nodes, hidden)
}

/** Merges a prior-period tree onto the current one so nodes present in only
 *  one period still appear — a line that stopped spending is as interesting
 *  as one that started. */
export function withComparison(current: TreeNode[], prior: TreeNode[]): ComparedNode[] {
  const priorIndex = new Map(flatten(prior).map(n => [n.key, n]))
  const seen = new Set<string>()

  const decorate = (nodes: TreeNode[]): ComparedNode[] =>
    nodes.map(n => {
      seen.add(n.key)
      const p = priorIndex.get(n.key)
      const priorAmount = p?.amount || 0
      const delta = n.amount - priorAmount
      return {
        ...n,
        priorAmount,
        delta,
        deltaPct: priorAmount > 0 ? (delta / priorAmount) * 100 : null,
        children: decorate(n.children),
      }
    })

  const out = decorate(current)

  // Nodes that existed only in the prior period, grafted in at zero.
  const addMissing = (priorNodes: TreeNode[], target: ComparedNode[]) => {
    for (const p of priorNodes) {
      if (seen.has(p.key)) {
        const match = target.find(t => t.key === p.key)
        if (match) addMissing(p.children, match.children)
        continue
      }
      target.push({
        ...p, amount: 0, count: 0, monthly: {},
        priorAmount: p.amount, delta: -p.amount, deltaPct: -100,
        children: [],
      })
    }
  }
  addMissing(prior, out)

  const sortDeep = (ns: ComparedNode[]) => {
    ns.sort((a, b) => b.amount - a.amount || b.priorAmount - a.priorAmount)
    ns.forEach(n => sortDeep(n.children))
  }
  sortDeep(out)
  return out
}

/** Biggest contributors to the period-over-period change, at a given depth.
 *  Depth 0 answers "which category moved"; deeper answers "which line". */
export function topMovers(nodes: ComparedNode[], depth = 0, limit = 5): ComparedNode[] {
  const all: ComparedNode[] = []
  const walk = (ns: ComparedNode[]) => ns.forEach(n => {
    if (n.depth === depth) all.push(n)
    walk(n.children)
  })
  walk(nodes)
  return all
    .filter(n => n.delta !== 0)
    .sort((a, b) => Math.abs(b.delta) - Math.abs(a.delta))
    .slice(0, limit)
}

/**
 * How concentrated spend is: how many leaves make up `pct` of the total.
 *
 * With 410 expense descriptions the useful question is not "what did we spend"
 * but "which handful of lines is worth arguing about".
 */
export function paretoCut(nodes: TreeNode[], pct = 80): {
  leaves: TreeNode[]
  cutoff: number
  total: number
  sharePct: number
} {
  const leaves = flatten(nodes).filter(n => n.children.length === 0)
  leaves.sort((a, b) => b.amount - a.amount)
  const total = leaves.reduce((s, n) => s + n.amount, 0)
  const target = total * (pct / 100)
  let running = 0
  let cutoff = 0
  for (const l of leaves) {
    running += l.amount
    cutoff++
    if (running >= target) break
  }
  return {
    leaves: leaves.slice(0, cutoff),
    cutoff,
    total,
    sharePct: total > 0 ? (running / total) * 100 : 0,
  }
}

/** Months covered by a set of entries, ascending — drives the sparkline axis. */
export function monthsIn(entries: PlEntry[]): string[] {
  return [...new Set(entries.map(e => (e.pl_date || '').slice(0, 7)).filter(Boolean))].sort()
}
