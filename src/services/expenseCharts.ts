// ─── Chart geometry for the expense report ──────────────────────────────────
//
// Pure derivation: turns the expense tree into the series each chart needs.
// No React, no SVG — so the shapes that carry the meaning can be tested.
//
// Each series answers a question a static total cannot:
//
//   monthlySeries  is the mix changing, or just the size          (trend)
//   bridgeSteps    which lines caused the change, and by how much (bridge)
//   paretoSeries   how few lines are worth arguing about          (concentration)

import { TreeNode, ComparedNode } from './expenseTree'
import { FIXED_BELOW_VARIATION, MONTHS_TO_JUDGE, type CostBehaviour } from './cfoMetrics'
import type { BranchNode } from './branchTree'
import { MONTHS_SHORT_SR } from '../utils/months'

export const OTHER = 'Ostalo'

// ── Trend and mix ───────────────────────────────────────────────────────────

export interface MonthlyPoint {
  month: string
  values: Record<string, number>
  total: number
}

export interface MonthlySeries {
  keys: string[]              // stacking order, largest first, OTHER last
  points: MonthlyPoint[]
  max: number                 // largest monthly total — the y-axis needs it
}

/**
 * Monthly composition from the top `topN` roots, everything else folded into
 * one Other band.
 *
 * Folding matters: nine colours of five-dinar categories is noise, and it
 * hides whether the big bands are moving. Other is kept rather than dropped so
 * the columns still add up to the real monthly total.
 */
export function monthlySeries(
  nodes: TreeNode[], months: string[], topN = 6,
): MonthlySeries {
  const ranked = [...nodes].sort((a, b) => b.amount - a.amount)
  const top = ranked.slice(0, topN)
  const rest = ranked.slice(topN)

  const keys = top.map(n => n.label)
  if (rest.length > 0) keys.push(OTHER)

  const points: MonthlyPoint[] = months.map(month => {
    const values: Record<string, number> = {}
    for (const n of top) values[n.label] = n.monthly[month] || 0
    if (rest.length > 0) {
      values[OTHER] = rest.reduce((s, n) => s + (n.monthly[month] || 0), 0)
    }
    const total = Object.values(values).reduce((s, v) => s + v, 0)
    return { month, values, total }
  })

  return { keys, points, max: Math.max(0, ...points.map(p => p.total)) }
}

// ── Period-over-period bridge ───────────────────────────────────────────────

export type BridgeKind = 'start' | 'up' | 'down' | 'other' | 'end'

export interface BridgeStep {
  label: string
  kind: BridgeKind
  delta: number               // 0 for the start and end anchors
  start: number               // bar bottom, in value units
  end: number                 // bar top
  key?: string                // tree key, so a step can be clicked through
}

/**
 * Prior total → the lines that moved → current total.
 *
 * This is the chart a management report is actually read for: not "expenses
 * are 2.1m" but "they are 180k higher, and here is who did that". Movers
 * beyond `limit` are summed into one Other step so the bars always close on
 * the current total — a bridge that does not close is worse than no bridge.
 */
export function bridgeSteps(compared: ComparedNode[], limit = 6): BridgeStep[] {
  const priorTotal = compared.reduce((s, n) => s + n.priorAmount, 0)
  const currentTotal = compared.reduce((s, n) => s + n.amount, 0)

  const moved = compared
    .filter(n => n.delta !== 0)
    .sort((a, b) => Math.abs(b.delta) - Math.abs(a.delta))

  const shown = moved.slice(0, limit)
  const restDelta = moved.slice(limit).reduce((s, n) => s + n.delta, 0)

  const steps: BridgeStep[] = [
    { label: 'Prethodno', kind: 'start', delta: 0, start: 0, end: priorTotal },
  ]

  let running = priorTotal
  for (const n of shown) {
    const next = running + n.delta
    steps.push({
      label: n.label,
      key: n.key,
      kind: n.delta > 0 ? 'up' : 'down',
      delta: n.delta,
      start: Math.min(running, next),
      end: Math.max(running, next),
    })
    running = next
  }

  if (Math.abs(restDelta) > 0.005) {
    const next = running + restDelta
    steps.push({
      label: OTHER,
      kind: 'other',
      delta: restDelta,
      start: Math.min(running, next),
      end: Math.max(running, next),
    })
    running = next
  }

  steps.push({ label: 'Tekuće', kind: 'end', delta: 0, start: 0, end: currentTotal })
  return steps
}

// ── Concentration ───────────────────────────────────────────────────────────

export interface ParetoPoint {
  label: string
  key: string
  amount: number
  cumulative: number
  cumulativePct: number
}

/** Leaves ranked by size with their running share — a real Pareto curve. */
export function paretoSeries(nodes: TreeNode[], limit = 20): ParetoPoint[] {
  const leaves: TreeNode[] = []
  const walk = (ns: TreeNode[]) => ns.forEach(n => {
    if (n.children.length === 0) leaves.push(n); else walk(n.children)
  })
  walk(nodes)

  leaves.sort((a, b) => b.amount - a.amount)
  const total = leaves.reduce((s, n) => s + n.amount, 0)
  if (total <= 0) return []

  let running = 0
  return leaves.slice(0, limit).map(n => {
    running += n.amount
    return {
      label: n.label,
      key: n.key,
      amount: n.amount,
      cumulative: running,
      cumulativePct: (running / total) * 100,
    }
  })
}

// ── Axis helpers ────────────────────────────────────────────────────────────

/** Rounds an axis maximum up to a readable 1/2/5 × 10ⁿ step. */
export function niceMax(value: number): number {
  if (!(value > 0)) return 1
  const exp = Math.floor(Math.log10(value))
  const pow = Math.pow(10, exp)
  const norm = value / pow
  const step = norm <= 1 ? 1 : norm <= 2 ? 2 : norm <= 5 ? 5 : 10
  return step * pow
}

/** Rounds an axis floor down to a readable half-decade step. */
export function niceFloor(value: number): number {
  if (!(value > 0)) return 0
  const pow = Math.pow(10, Math.floor(Math.log10(value)))
  const step = pow / 2
  return Math.floor(value / step) * step
}

/**
 * Axis range for a bridge.
 *
 * A bridge measured from zero is useless whenever the movement is small
 * against the level — $10k steps on a $500k axis are invisible lines, and the
 * chart that is supposed to explain the change explains nothing. So when the
 * walk sits far above zero the axis starts below the walk instead, which is
 * what a hand-drawn management bridge does. The baseline is labelled, so the
 * truncation is stated rather than hidden.
 *
 * Zero is kept whenever the movement is large enough to read from it, because
 * a zero baseline is the honest default when it works.
 */
export function bridgeScale(lo: number, hi: number, tickCount = 4): {
  floor: number; top: number; ticks: number[]; zoomed: boolean
} {
  const span = hi - lo
  const fromZero = () => {
    const top = niceMax(hi > 0 ? hi : 1)
    return { floor: 0, top, ticks: axisTicks(hi > 0 ? hi : 1, tickCount), zoomed: false }
  }
  if (!(span > 0) || lo <= span * 1.5) return fromZero()

  const pad = span * 0.35
  let step = niceMax((hi + pad - (lo - pad)) / tickCount)
  let floor = Math.max(Math.floor((lo - pad) / step) * step, 0)
  // niceMax rounds up, so one widening is always enough — the guard is there
  // to make that a fact rather than a belief.
  for (let i = 0; i < 8 && floor + step * tickCount < hi; i++) step = niceMax(step * 1.5)
  floor = Math.max(Math.floor((lo - pad) / step) * step, 0)
  if (floor === 0) return fromZero()

  const top = floor + step * tickCount
  return {
    floor, top,
    ticks: Array.from({ length: tickCount + 1 }, (_, i) => floor + step * i),
    zoomed: true,
  }
}

/** `count` evenly spaced ticks from 0 to a nice maximum, inclusive. */
export function axisTicks(max: number, count = 4): number[] {
  const top = niceMax(max)
  return Array.from({ length: count + 1 }, (_, i) => (top / count) * i)
}

/**
 * Compact money for axis labels and bar values, in the Serbian scale the
 * shared formatters use: `850`, `1,2 hilj.`, `67 hilj.`, `2,1 mil.`,
 * `1,5 mlrd.` — one decimal below ten of a unit, none above.
 *
 * `currency` appends the code (`2,1 mil. RSD`); axis ticks leave it out
 * because the chart's heading already names the currency, and the code on
 * every tick would crowd the axis.
 */
export function shortMoney(n: number, currency?: string): string {
  const a = Math.abs(n)
  const sign = n < 0 ? '-' : ''
  const fix = (v: number, d: number) =>
    v.toLocaleString('sr-RS', { minimumFractionDigits: d, maximumFractionDigits: d })
  const scaled = (div: number, unit: string) =>
    `${fix(a / div, a >= 10 * div ? 0 : 1)} ${unit}`
  const body =
    a >= 1_000_000_000 ? scaled(1_000_000_000, 'mlrd.')
    : a >= 1_000_000 ? scaled(1_000_000, 'mil.')
    : a >= 1_000 ? scaled(1_000, 'hilj.')
    : fix(Math.round(a), 0)
  return `${sign}${body}${currency ? ` ${currency}` : ''}`
}

/** 'YYYY-MM' → 'Aug' / 'Aug ’25' when the series crosses a year boundary. */
export function monthLabel(month: string, withYear = false): string {
  const [y, m] = month.split('-').map(Number)
  const name = MONTHS_SHORT_SR[(m || 1) - 1] || month
  return withYear ? `${name} ’${String(y).slice(-2)}` : name
}

// ── What moved ──────────────────────────────────────────────────────────────
//
// The bridge answers the change at the top level, in six bars, and that is
// where its usefulness ends: on a branch with two roots it has two bars, and
// on any branch the line that actually moved is three levels down.
//
// This ranks by the SIZE of the movement regardless of direction, which is the
// question being asked — "what do I need to explain this month" — and keeps
// the direction as the sign so the chart can put rises one way and falls the
// other. A line that appeared and a line that stopped both qualify: an
// $18,000 cost that vanished is at least as interesting as one that arrived.

export interface MoverBar {
  key: string
  label: string
  /** The ancestry above the label, for the second line and the tooltip. */
  parent: string[]
  path: string[]
  current: number
  prior: number
  delta: number
  /** null when there is no prior base to divide by — a line that is new. */
  deltaPct: number | null
  node: ComparedNode
}

/** The movers at one depth, largest movement first. */
export function moverBars(
  compared: ComparedNode[], depth = 0, limit = 10,
): MoverBar[] {
  const at: ComparedNode[] = []
  const walk = (ns: ComparedNode[]) => ns.forEach(n => {
    if (n.depth === depth) at.push(n)
    walk(n.children)
  })
  walk(compared)

  return at
    .filter(n => Math.abs(n.delta) > 0.005)
    .sort((a, b) => Math.abs(b.delta) - Math.abs(a.delta))
    .slice(0, limit)
    .map(n => ({
      key: n.key,
      label: n.label,
      parent: n.path.slice(0, -1),
      path: n.path,
      current: n.amount,
      prior: n.priorAmount,
      delta: n.delta,
      deltaPct: n.deltaPct,
      node: n,
    }))
}

export interface MoverAxis {
  /** Dollars reaching left of the zero line, and right of it. */
  down: number
  up: number
  /** Pixels per unit of money — ONE number, which is the whole point. */
  perDollar: number
  /** Where the zero line sits, in pixels from the plot's left edge. */
  zeroX: number
}

/**
 * The layout for a tornado: ONE ruler, with the zero line where the data
 * puts it and room at each end for the figure printed on the bar.
 *
 * A single scale for both sides is not negotiable — an axis fitted to each
 * side separately makes a $2,000 fall the same length as a $40,000 rise,
 * which is the one thing this chart exists to prevent.
 *
 * WHERE ZERO SITS is a different question, and pinning it to the middle was
 * wrong. Rendered against a month in which everything rose, half the canvas
 * was empty and every bar was squeezed into the other half — the chart gave
 * up half its resolution to draw a symmetry the data did not have. So each
 * side gets the width its own extent asks for.
 *
 * The end allowance is in PIXELS and not in money, because what it holds is
 * a piece of text. Rounding the money span up and hoping the slack landed on
 * the right side put the longest bar's label outside the frame on a one-sided
 * chart — it only ever had slack on the side the rounding happened to favour.
 */
export function moverScale(
  bars: MoverBar[], plotW = 600, endRoom = 76,
): MoverAxis {
  const up = Math.max(0, ...bars.map(b => b.delta))
  const down = Math.max(0, ...bars.map(b => -b.delta))
  const span = up + down

  // A plot too narrow to hold two captions gives them a share rather than a
  // fixed size; the bars stay drawable instead of collapsing to nothing.
  const room = Math.min(endRoom, plotW * 0.2)
  const leftRoom = down > 0 ? room : 0
  const rightRoom = up > 0 ? room : 0
  const usable = Math.max(plotW - leftRoom - rightRoom, 1)

  const perDollar = span > 0 ? usable / span : 0
  return { up, down, perDollar, zeroX: leftRoom + down * perDollar }
}

// ── The heatmap ─────────────────────────────────────────────────────────────
//
// A stacked column can hold six bands before it turns to mush, and an expense
// report has forty lines. The grid holds all of them: one row per line, one
// cell per month, colour carrying the amount. Seasonality, a one-off spike and
// a line that quietly stopped are all visible in the same glance, and none of
// them are visible in a stack.
//
// ── Why the bins are quantiles and not equal slices ─────────────────────────
//
// Spend is heavily skewed: one payroll line is bigger than thirty others put
// together. Cut the range into five equal slices and thirty-eight rows sit in
// the bottom slice — one colour, no information, a picture of the skew rather
// than of the data.
//
// Quantiles put roughly the same number of cells in each colour, so the grid
// has something to say at every level. The price is that colour is no longer
// proportional to value, and that price is paid openly: the legend prints the
// money edge of every bin, so a reader can see what a shade is worth instead
// of guessing.
//
// The per-row scale answers the other question. Against the whole grid a
// $400 line that quadrupled is invisible; scaled to its own biggest month it
// is as loud as payroll. Which of the two you want depends on whether you are
// asking "where is the money" or "what changed" — so it is a switch, not a
// decision taken here.

export interface HeatRow {
  key: string
  label: string
  parent: string[]
  path: string[]
  values: number[]
  total: number
  /** The row's own biggest month — the denominator of the per-row scale. */
  max: number
  node: TreeNode | null
}

export interface HeatGrid {
  rows: HeatRow[]
  months: string[]
  /** Bin edges over every non-zero cell, ascending. `bins.length` is steps-1. */
  bins: number[]
  max: number
  /** How many lines were folded into the Other row; 0 when none were. */
  folded: number
}

/**
 * Quantile edges over a set of values.
 *
 * Returns `steps - 1` cut points, so `binOf` can place a value in one of
 * `steps` bins. Duplicate edges are kept rather than collapsed: a column of
 * identical values genuinely has no spread, and inventing one would put cells
 * in bins the data does not support.
 */
export function quantileEdges(values: number[], steps = 5): number[] {
  const sorted = values.filter(v => v > 0).sort((a, b) => a - b)
  if (sorted.length === 0) return []
  const out: number[] = []
  for (let i = 1; i < steps; i++) {
    const at = (sorted.length - 1) * (i / steps)
    const lo = Math.floor(at), hi = Math.ceil(at)
    out.push(sorted[lo] + (sorted[hi] - sorted[lo]) * (at - lo))
  }
  return out
}

/** Which bin a value falls in: -1 for nothing at all, then 0…edges.length. */
export function binOf(value: number, edges: number[]): number {
  if (!(value > 0)) return -1
  let i = 0
  while (i < edges.length && value > edges[i]) i++
  return i
}

/** The same, for a value read against its own row's maximum. */
export function rowBin(value: number, rowMax: number, steps = 5): number {
  if (!(value > 0)) return -1
  if (!(rowMax > 0)) return 0
  return Math.min(steps - 1, Math.floor((value / rowMax) * steps))
}

/**
 * One row per node at `depth`, one column per month.
 *
 * Rows beyond `limit` are summed into a single Other row rather than dropped,
 * so the columns still add to the month — the same rule the stacked chart
 * follows, for the same reason.
 */
export function heatGrid(
  nodes: TreeNode[], months: string[], depth = 1, limit = 14,
): HeatGrid {
  const at: TreeNode[] = []
  const walk = (ns: TreeNode[]) => ns.forEach(n => {
    if (n.depth === depth) at.push(n)
    walk(n.children)
  })
  walk(nodes)

  // A branch shallower than the requested depth has nothing there; fall back
  // to the deepest level it does have rather than drawing an empty grid.
  let source = at
  if (source.length === 0) {
    const all: TreeNode[] = []
    const collect = (ns: TreeNode[]) => ns.forEach(n => { all.push(n); collect(n.children) })
    collect(nodes)
    const deepest = Math.max(0, ...all.map(n => n.depth))
    source = all.filter(n => n.depth === deepest)
  }

  const ranked = [...source].sort((a, b) => b.amount - a.amount)
  const kept = ranked.slice(0, limit)
  const rest = ranked.slice(limit)

  const rowOf = (n: TreeNode): HeatRow => {
    const values = months.map(m => n.monthly[m] || 0)
    return {
      key: n.key, label: n.label, parent: n.path.slice(0, -1), path: n.path,
      values, total: n.amount, max: Math.max(...values, 0), node: n,
    }
  }

  const rows = kept.map(rowOf)

  if (rest.length > 0) {
    const values = months.map(m => rest.reduce((sum, n) => sum + (n.monthly[m] || 0), 0))
    rows.push({
      key: `__other__`, label: OTHER, parent: [], path: [],
      values, total: rest.reduce((sum, n) => sum + n.amount, 0),
      max: Math.max(...values, 0), node: null,
    })
  }

  const cells = rows.flatMap(r => r.values)
  return {
    rows, months,
    bins: quantileEdges(cells, 5),
    max: Math.max(...cells, 0),
    folded: rest.length,
  }
}

// ── The branching tree ──────────────────────────────────────────────────────
//
// The same picture the Budgeting simulation draws: the period on the left,
// splitting into categories, into sub-categories, into the lines themselves,
// each branch as thick as the money it carries.
//
// It needs one thing the tree does not already hold — whether a cost MOVES —
// and this is where that is worked out. `TreeNode.monthly` already carries
// every node's month-by-month amount, so it is measured per node rather than
// inherited from a parent the way the simulation has to do it.
//
// ── Absent months count as zero ─────────────────────────────────────────────
//
// `costStructure` measures variation over the months a category APPEARS in,
// because its input is a history map with no month axis of its own. Here the
// period's months are known, so a line that spent in three of nine is
// measured over nine. That is the honest reading: a cost that is there a
// third of the time is not a fixed cost, and averaging over only the months
// it showed up in would call it one.

/**
 * Whether a cost is fixed, moves, or has too little history to say.
 *
 * Coefficient of variation, and the same threshold the simulation uses, so a
 * line does not read as fixed on one page and variable on the other.
 */
export function behaviourOf(
  monthly: Record<string, number>, months: string[],
): CostBehaviour {
  if (months.length < MONTHS_TO_JUDGE) return 'unknown'
  const values = months.map(m => monthly[m] || 0)
  const mean = values.reduce((s, v) => s + v, 0) / values.length
  if (mean === 0) return 'unknown'
  const variance = values.reduce((s, v) => s + (v - mean) ** 2, 0) / values.length
  return Math.sqrt(variance) / Math.abs(mean) <= FIXED_BELOW_VARIATION ? 'fixed' : 'variable'
}

/**
 * The expense tree in the shape the branch picture wants.
 *
 * A node whose amount is zero is dropped rather than drawn: a branch of no
 * thickness is a line to a box saying $0, which is a question the picture
 * cannot answer and the table already can.
 */
export function branchRoots(
  nodes: TreeNode[], months: string[],
): (BranchNode & { behaviour: CostBehaviour })[] {
  return nodes
    .filter(n => n.amount > 0)
    .map(n => {
      const children = branchRoots(n.children, months)
      return {
        key: n.key,
        label: n.label,
        amount: n.amount,
        behaviour: behaviourOf(n.monthly, months),
        children: children.length > 0 ? children : undefined,
      }
    })
}
