// ─── Expense analysis tree ──────────────────────────────────────────────────
//
// Pure logic — no UI, no database — so the numbers can be tested.
//
// THREE branches over the same rows:
//
//   pl          P&L Category → P&L Sub-category        "what kind of cost"
//   department  Department → Sub-category → Expense    "who spends it"
//   project     Project → P&L Cat → Sub-cat            "which site pays"
//
// All three MUST total the same. Rows missing a level are placed under an
// explicit Unassigned node rather than dropped, so the totals always tie and
// the unclassified amount is a visible item to fix instead of a silent
// shortfall.
//
// ── Every branch FILES a row ────────────────────────────────────────────────
//
// Mintflow had two branches that ALLOCATED a row by value between two
// businesses. FlowBase has no allocation keys (see services/projects.ts): a row
// belongs to one project or to none, and a document shared by several sites
// is split with pl_splits, which v_pl_entries already returns as one row per
// split line, each carrying its OWN project. So a split bill lands under each
// of its projects (and under overhead, for a line without one) for exactly
// that line's amount, and nothing here has to divide anything.
//
// A row with no project goes under OVERHEAD_LABEL ("Opšti troškovi"), never
// spread over the projects.
//
// `contributionsFor` still returns a list — always of one — so the drill-down
// and the charts read every branch through the same three functions.
//
// ── Which figure ────────────────────────────────────────────────────────────
//
// Every row carries amount_rsd and amount_eur. The tree sums the one for the
// viewer's display currency (`currency`, passed in by the page) — never a
// total converted afterwards at one rate. A row with no EUR figure counts as
// zero in the EUR view.

import { pickAmount, type DisplayCurrency } from '../contexts/DisplayCurrencyContext'
import { OVERHEAD_LABEL } from './projects'

export type Branch = 'pl' | 'department' | 'project'
export type Side = 'expense' | 'revenue'

export const UNASSIGNED = 'Nedodeljeno'

/** What a project-branch root is called when the row names a project id the view gave no name for. */
export const UNKNOWN_PROJECT = 'Nepoznat projekat'

export const BRANCHES: readonly Branch[] = ['pl', 'department', 'project']

export const BRANCH_LABEL: Record<Branch, string> = {
  pl: 'Po P&L kategoriji',
  department: 'Po sektoru',
  project: 'Po projektu',
}

/** Column heading over the tree's first column, per branch. */
export const BRANCH_COLUMNS: Record<Branch, string> = {
  pl: 'Kategorija / potkategorija',
  department: 'Sektor / podsektor / opis',
  project: 'Projekat / kategorija / potkategorija',
}

export interface PlEntry {
  id?: string
  amount?: number | null
  tx_type?: string | null
  amount_rsd: number | null
  amount_eur?: number | null
  pl_category: string | null
  pl_subcategory: string | null
  department: string | null
  dept_subcategory: string | null
  expense_description: string | null
  pl_date: string                 // 'YYYY-MM-DD'
  company_id?: string | null
  source?: string | null
  /** The row's own project (a split line's, not its document's); null is overhead. */
  project_id?: string | null
  project_name?: string | null
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
export function byDateDesc<T extends { date?: string | null; pl_date?: string | null; amount_rsd?: number | null }>(
  a: T, b: T,
): number {
  const da = a.date ?? a.pl_date ?? ''
  const db = b.date ?? b.pl_date ?? ''
  if (da !== db) return db < da ? -1 : 1
  // The book figure, so the order is the same whichever currency is on screen.
  return Math.abs(b.amount_rsd ?? 0) - Math.abs(a.amount_rsd ?? 0)
}

const SEP = ' › '            // › — will not occur inside a category name

const norm = (v: string | null | undefined): string => {
  const s = (v || '').trim()
  return s || UNASSIGNED
}

/** The row's book figure in `currency`; a missing figure (no EUR yet) is 0. */
export function bookAmount(e: Pick<PlEntry, 'amount_rsd' | 'amount_eur'>, currency: DisplayCurrency): number {
  return pickAmount(e, currency) ?? 0
}

/**
 * The project-branch root a row goes under: its project's name, or
 * OVERHEAD_LABEL when it has none. A project id without a name (a project the
 * view could not join) is UNKNOWN_PROJECT — never silently overhead.
 */
export function projectRootOf(e: Pick<PlEntry, 'project_id' | 'project_name'>): string {
  const id = (e.project_id || '').trim()
  if (!id) return OVERHEAD_LABEL
  return (e.project_name || '').trim() || UNKNOWN_PROJECT
}

/** Path of a row within a branch. Missing levels collapse to Unassigned. */
export function pathFor(e: PlEntry, branch: Branch): string[] {
  if (branch === 'pl') return [norm(e.pl_category), norm(e.pl_subcategory)]
  if (branch === 'department') return [norm(e.department), norm(e.dept_subcategory), norm(e.expense_description)]
  // Under each project, the same breakdown the P&L itself uses: by category.
  return [projectRootOf(e), norm(e.pl_category), norm(e.pl_subcategory)]
}

/** A row's amount under one path. */
export interface Contribution {
  path: string[]
  amount: number
}

/**
 * Everywhere a row belongs in a branch, and for how much: one contribution
 * carrying the whole row, on every branch.
 *
 * `Math.abs`: an expense is shown as a positive cost whichever sign it was
 * stored with.
 */
export function contributionsFor(e: PlEntry, branch: Branch, currency: DisplayCurrency): Contribution[] {
  return [{ path: pathFor(e, branch), amount: Math.abs(bookAmount(e, currency)) }]
}

/** Whether a row puts any money under `path` — the drill-down's predicate. */
export function contributesTo(e: PlEntry, branch: Branch, path: string[], currency: DisplayCurrency): boolean {
  return contributionsFor(e, branch, currency).some(
    c => c.amount > 0 && path.every((seg, i) => c.path[i] === seg))
}

/** How much of a row sits under `path`: the whole row, or nothing. */
export function contributionTo(e: PlEntry, branch: Branch, path: string[], currency: DisplayCurrency): number {
  return contributionsFor(e, branch, currency)
    .filter(c => path.every((seg, i) => c.path[i] === seg))
    .reduce((sum, c) => sum + c.amount, 0)
}

export function buildTree(entries: PlEntry[], branch: Branch, currency: DisplayCurrency): TreeNode[] {
  const roots: TreeNode[] = []
  const index = new Map<string, TreeNode>()

  for (const e of entries) {
    const month = (e.pl_date || '').slice(0, 7)

    for (const { path, amount } of contributionsFor(e, branch, currency)) {
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
