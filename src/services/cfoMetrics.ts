// ─── cfoMetrics ─────────────────────────────────────────────────────────────
//
// The arithmetic behind the six simulation panels. No React, no Supabase, so
// every figure on those charts can be checked with numbers rather than by
// looking at a bar and believing it.
//
// The six, and what each is for:
//
//   trend          twelve months of in and out, because nobody judges a
//                  company from one month
//   burn           what a month costs when it goes wrong, and how long that
//                  can go on
//   concentration  how much of the revenue is one brand — a risk figure that
//                  appears nowhere else
//   cost structure what the base costs whatever happens, and what revenue has
//                  to clear it
//   sensitivity    what moves the result most, ranked
//   receivables    money earned and not yet collected, and how old it is
//
// ── One rule runs through all of them ───────────────────────────────────────
//
// A figure that cannot be computed is NOT computed to zero. Runway with no
// cash position, a fixed/variable split with two months of history, DSO with
// no revenue — each returns null and says why, because a zero on a CFO panel
// is read as a measurement and acted on.

const cents = (n: number): number => Math.round(n * 100) / 100

// ─── 1. Twelve months of in and out ─────────────────────────────────────────

export interface MonthPoint {
  month: string
  revenue: number
  expenses: number
  /** Revenue less expenses. Negative is a loss. */
  result: number
  /** Result over revenue, 0–1. Null where there was no revenue to divide by. */
  margin: number | null
  /** False where the month is still running, so a dip is not read as a fall. */
  complete: boolean
}

export interface TrendEntry {
  pl_date: string
  amount_usd: number | null
  tx_type: string | null
}

const REVENUE_TYPES = ['revenue', 'invoice_revenue']
const EXPENSE_TYPES = ['expense', 'invoice_expense']

/** `n` months ending with `last`, oldest first. */
export function monthsEndingAt(last: string, n: number): string[] {
  const [y, m] = last.split('-').map(Number)
  const out: string[] = []
  for (let i = n - 1; i >= 0; i--) {
    const t = y * 12 + (m - 1) - i
    out.push(`${String(Math.floor(t / 12)).padStart(4, '0')}-${String((t % 12) + 1).padStart(2, '0')}`)
  }
  return out
}

/**
 * What each month actually booked, in and out.
 *
 * `currentMonth` is marked incomplete rather than left out. Dropping it hides
 * the month everyone is actually in; including it silently makes the last
 * column a partial month that reads as a collapse. Marked, the chart can draw
 * it differently and the arithmetic below can skip it.
 */
export function monthlyTrend(
  entries: TrendEntry[], months: string[], currentMonth?: string,
): MonthPoint[] {
  const rev = new Map<string, number>()
  const exp = new Map<string, number>()

  for (const e of entries) {
    const mk = (e.pl_date || '').slice(0, 7)
    const amount = Number(e.amount_usd) || 0
    if (!amount) continue
    if (REVENUE_TYPES.includes(e.tx_type || '')) rev.set(mk, (rev.get(mk) || 0) + amount)
    else if (EXPENSE_TYPES.includes(e.tx_type || '')) exp.set(mk, (exp.get(mk) || 0) + Math.abs(amount))
  }

  return months.map(month => {
    const revenue = cents(rev.get(month) || 0)
    const expenses = cents(exp.get(month) || 0)
    const result = cents(revenue - expenses)
    return {
      month, revenue, expenses, result,
      margin: revenue > 0 ? result / revenue : null,
      complete: !currentMonth || month < currentMonth,
    }
  })
}

// ─── 2. Burn, and how long it can go on ─────────────────────────────────────

export interface Runway {
  /** Average monthly loss across the complete months that lost money. */
  burn: number
  /** Months of cash at that burn. Null where it cannot be known. */
  months: number | null
  /** Why it cannot be known, for the panel to print instead of a number. */
  unknown: string | null
  /** How many complete months the burn was averaged over. */
  monthsUsed: number
}

/**
 * Burn, and runway if there is a cash position to divide.
 *
 * BURN IS THE AVERAGE OF THE LOSING MONTHS, not of all of them. A company that
 * loses 200k in one month and makes 190k the next is not burning 5k; it is
 * burning 200k and happens to have had a good month. Averaging the profitable
 * months in is how a runway figure comes out four times too long, and runway
 * is read for exactly one purpose — deciding when to act — so the direction of
 * its error matters more than its precision.
 *
 * `cashOnHand` null is answered with null and a sentence. There is no cash
 * balance anywhere in this application; it is a figure somebody reports. A
 * runway computed from a cash position nobody entered is a number invented on
 * a screen that exists to be trusted.
 */
export function burnAndRunway(points: MonthPoint[], cashOnHand: number | null): Runway {
  const complete = points.filter(p => p.complete)
  const losing = complete.filter(p => p.result < 0)
  const burn = losing.length > 0
    ? cents(losing.reduce((s, p) => s + Math.abs(p.result), 0) / losing.length)
    : 0

  if (complete.length === 0) {
    return { burn: 0, months: null, unknown: 'No complete month to measure a burn from.', monthsUsed: 0 }
  }
  if (burn === 0) {
    return {
      burn: 0, months: null, monthsUsed: complete.length,
      unknown: `No complete month in the last ${complete.length} lost money, so there is no burn to divide cash by.`,
    }
  }
  if (cashOnHand === null || !Number.isFinite(cashOnHand)) {
    return {
      burn, months: null, monthsUsed: losing.length,
      unknown: 'No cash position has been entered, and there is none anywhere in the ledger to read.',
    }
  }
  return {
    burn, monthsUsed: losing.length, unknown: null,
    months: Math.round((cashOnHand / burn) * 10) / 10,
  }
}

// ─── 3. How much of it is one brand ─────────────────────────────────────────

export interface ConcentrationShare {
  label: string
  amount: number
  /** Of the total, 0–1. */
  share: number
}

export interface Concentration {
  shares: ConcentrationShare[]
  total: number
  /** The largest single share, 0–1. Null when there is nothing to rank. */
  topShare: number | null
  topLabel: string | null
  /**
   * Herfindahl index: the sum of the squared shares, 0–1.
   *
   * One brand carrying everything is 1; ten equal brands are 0.1. It is the
   * figure that distinguishes "one big brand and eight small" from "three
   * medium ones", which a top-share alone cannot — and those are different
   * companies to run.
   */
  hhi: number | null
  /** How many brands it takes to reach half the revenue. */
  brandsToHalf: number | null
}

export function concentration(
  items: { label: string; amount: number }[],
): Concentration {
  const kept = items.filter(i => i.amount > 0)
  const total = cents(kept.reduce((s, i) => s + i.amount, 0))
  if (total <= 0) {
    return { shares: [], total: 0, topShare: null, topLabel: null, hhi: null, brandsToHalf: null }
  }

  const shares = [...kept]
    .sort((a, b) => b.amount - a.amount || a.label.localeCompare(b.label))
    .map(i => ({ label: i.label, amount: cents(i.amount), share: i.amount / total }))

  let running = 0
  let toHalf = shares.length
  for (let i = 0; i < shares.length; i++) {
    running += shares[i].share
    if (running >= 0.5) { toHalf = i + 1; break }
  }

  return {
    shares, total,
    topShare: shares[0].share,
    topLabel: shares[0].label,
    hhi: shares.reduce((s, i) => s + i.share * i.share, 0),
    brandsToHalf: toHalf,
  }
}

// ─── 4. What the base costs, and what clears it ─────────────────────────────

export type CostBehaviour = 'fixed' | 'variable' | 'unknown'

export interface CategoryBehaviour {
  label: string
  /** The month being planned. */
  amount: number
  behaviour: CostBehaviour
  /** Standard deviation over mean across the months seen, or null. */
  variation: number | null
  monthsSeen: number
}

export interface CostStructure {
  categories: CategoryBehaviour[]
  fixed: number
  variable: number
  unknown: number
  /**
   * Revenue needed to cover the fixed base once the variable costs have taken
   * their share of it. Null where the variable share is 100% or more, at which
   * point no amount of revenue clears the base and saying so is the answer.
   */
  breakEven: number | null
  /** Variable cost as a fraction of the revenue it was measured against. */
  variableRatio: number | null
  /** What is left of a marginal dollar after the variable costs, 0–1. */
  contributionMargin: number | null
}

/** Below this, a cost is behaving like a fixed one. */
export const FIXED_BELOW_VARIATION = 0.25
/** Fewer months than this and nothing can be said about behaviour. */
export const MONTHS_TO_JUDGE = 3

/**
 * Which costs are fixed, which move, and what revenue clears the base.
 *
 * MEASURED, NOT LISTED. The obvious implementation is a list of category names
 * somebody decides are fixed, which is wrong within a quarter of being written
 * and wrong silently. What makes a cost fixed is that it does not move, and
 * whether it moves is in the ledger: the coefficient of variation across the
 * months of history, which is comparable between a 200k payroll and a 2k
 * software bill precisely because it is a ratio.
 *
 * A category with fewer than `MONTHS_TO_JUDGE` months is `unknown` and is
 * reported as its own total rather than being quietly filed with one or the
 * other. It is the honest answer, and it shrinks as history accrues.
 */
export function costStructure(
  history: Record<string, Record<string, number>>,
  planned: { label: string; amount: number }[],
  revenueAgainstVariable: number,
): CostStructure {
  const categories: CategoryBehaviour[] = planned.map(p => {
    const byMonth = history[p.label] || {}
    const values = Object.values(byMonth).filter(v => Number.isFinite(v))
    const monthsSeen = values.length

    if (monthsSeen < MONTHS_TO_JUDGE) {
      return { label: p.label, amount: cents(p.amount), behaviour: 'unknown', variation: null, monthsSeen }
    }
    const mean = values.reduce((s, v) => s + v, 0) / monthsSeen
    if (mean === 0) {
      return { label: p.label, amount: cents(p.amount), behaviour: 'unknown', variation: null, monthsSeen }
    }
    const variance = values.reduce((s, v) => s + (v - mean) ** 2, 0) / monthsSeen
    const variation = Math.sqrt(variance) / Math.abs(mean)
    return {
      label: p.label, amount: cents(p.amount), monthsSeen,
      variation: Math.round(variation * 1000) / 1000,
      behaviour: variation <= FIXED_BELOW_VARIATION ? 'fixed' : 'variable',
    }
  })

  const sum = (b: CostBehaviour) =>
    cents(categories.filter(c => c.behaviour === b).reduce((s, c) => s + c.amount, 0))
  const fixed = sum('fixed')
  const variable = sum('variable')
  const unknown = sum('unknown')

  const variableRatio = revenueAgainstVariable > 0 ? variable / revenueAgainstVariable : null
  // Anything not classified is carried on the fixed side of the break-even.
  // It has to go somewhere, and treating an unmeasured cost as variable makes
  // the break-even lower — which is the direction that gets believed.
  const base = fixed + unknown
  const contributionMargin = variableRatio === null ? null : 1 - variableRatio

  return {
    categories, fixed, variable, unknown, variableRatio, contributionMargin,
    breakEven: contributionMargin !== null && contributionMargin > 0
      ? cents(base / contributionMargin)
      : null,
  }
}

// ─── 5. What moves the result most ──────────────────────────────────────────

export interface Driver {
  id: string
  label: string
  /** What a move in this driver does to the result, in dollars. */
  effect: (pct: number) => number
}

export interface TornadoBar {
  id: string
  label: string
  /** The effect of moving this driver DOWN by the step, on the result. */
  down: number
  /** The effect of moving it UP by the step. */
  up: number
  /**
   * The worse of the two outcomes, and the better one — never the down and up
   * moves as such.
   *
   * THE AXIS OF A TORNADO IS THE RESULT, NOT THE DRIVER, and conflating them
   * is a live fault rendering caught. Less revenue is worse; less payroll is
   * better. Put the `down` move on the left for every row and three rows in
   * five have a green bar on the side the legend calls "result falls" — the
   * position says one thing and the colour says the other, and the reader
   * believes whichever they read first.
   *
   * So the side is the RESULT's side. `worse` is drawn left in red and
   * `better` right in green, always, and the tooltip says which way the
   * driver had to move to get there.
   */
  worse: number
  better: number
  /** Which way the driver moved to produce the worse outcome: -1 or +1. */
  worseDirection: -1 | 1
  /** The bigger of the two absolute effects — what the bars are ranked on. */
  swing: number
}

/**
 * Each driver's effect on the result, ranked by how much it can move it.
 *
 * The CFO's question is not "what is the result" but "what would have to be
 * true for it to be different", and the answer is an ordering: the driver at
 * the top is where the attention goes. A 10% move in the biggest cost line
 * beats a 10% move in the smallest by the ratio of the two, and that ratio is
 * the whole content of the chart.
 *
 * Each row comes back as `worse` and `better` rather than as down and up —
 * see `TornadoBar`, where the reason is the one thing about this chart that
 * can be silently wrong.
 */
export function tornado(drivers: Driver[], pct: number): TornadoBar[] {
  return drivers
    .map(d => {
      const down = cents(d.effect(-pct))
      const up = cents(d.effect(pct))
      const downIsWorse = down <= up
      return {
        id: d.id, label: d.label, down, up,
        worse: Math.min(down, up),
        better: Math.max(down, up),
        worseDirection: (downIsWorse ? -1 : 1) as -1 | 1,
        swing: Math.max(Math.abs(down), Math.abs(up)),
      }
    })
    .filter(b => b.swing > 0)
    .sort((a, b) => b.swing - a.swing)
}

// ─── 6. Money earned and not yet collected ──────────────────────────────────

export interface AgeingBucket {
  label: string
  /** Days overdue, low end. `-Infinity` for the not-yet-due bucket. */
  from: number
  amount: number
  count: number
}

export interface Receivables {
  buckets: AgeingBucket[]
  total: number
  /** What is past its due date. */
  overdue: number
  /**
   * Days sales outstanding: receivables over revenue per day.
   *
   * Null where there is no revenue in the window to divide by — a DSO of
   * infinity is not a large DSO, it is an undefined one, and printing a huge
   * number where the denominator was zero is how a panel loses its reader.
   */
  dso: number | null
  /** The window revenue per day was measured over. */
  overDays: number
}

export interface OpenInvoice {
  due_date: string | null
  remaining_usd: number | null
  type?: string | null
}

export const AGEING_BUCKETS: { label: string; from: number }[] = [
  { label: 'Not yet due', from: -Infinity },
  { label: '1–30 days', from: 1 },
  { label: '31–60 days', from: 31 },
  { label: '61–90 days', from: 61 },
  { label: 'Over 90 days', from: 91 },
]

const daysBetween = (a: string, b: string): number =>
  Math.round((Date.parse(b + 'T00:00:00Z') - Date.parse(a + 'T00:00:00Z')) / 86400000)

/**
 * What is owed, how old it is, and how long it takes to collect.
 *
 * An invoice with no due date sits in "Not yet due" rather than being dropped.
 * It is money owed either way, and a receivables total that quietly omits the
 * rows with a missing field is a total that is wrong in the one direction
 * nobody checks.
 */
export function receivables(
  invoices: OpenInvoice[], today: string, revenueInWindow: number, overDays = 90,
): Receivables {
  const buckets: AgeingBucket[] = AGEING_BUCKETS.map(b => ({ ...b, amount: 0, count: 0 }))
  let total = 0
  let overdue = 0

  for (const inv of invoices) {
    const amount = Number(inv.remaining_usd) || 0
    if (amount <= 0) continue
    total += amount

    const late = inv.due_date ? daysBetween(inv.due_date, today) : 0
    if (late > 0) overdue += amount

    let idx = 0
    for (let i = buckets.length - 1; i >= 0; i--) {
      if (late >= buckets[i].from) { idx = i; break }
    }
    buckets[idx].amount += amount
    buckets[idx].count += 1
  }

  const perDay = revenueInWindow > 0 ? revenueInWindow / overDays : 0
  return {
    buckets: buckets.map(b => ({ ...b, amount: cents(b.amount) })),
    total: cents(total),
    overdue: cents(overdue),
    dso: perDay > 0 ? Math.round((total / perDay) * 10) / 10 : null,
    overDays,
  }
}
