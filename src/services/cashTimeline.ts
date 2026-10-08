// ─── cashTimeline ───────────────────────────────────────────────────────────
//
// One line through the year: what actually moved up to today, what is expected
// to move after it, and the bank balance walked through both.
//
// No React and no Supabase, so the balance — which is the only figure on that
// page anybody acts on — is checked with numbers.
//
// ── Why one line and not two ────────────────────────────────────────────────
//
// History and forecast on separate screens is how a reader ends up comparing
// them by scrolling. The question a cash flow is opened for is "when does the
// balance get low", and that question crosses today: it is answered by the
// shape of the line either side of it. So the months are one series, each
// marked with where its figures came from, and the balance is carried
// straight through.
//
// ── The anchor ──────────────────────────────────────────────────────────────
//
// A cash position is a READING at a date, not a property of a month. It is
// the only fixed point on the line, so the balance is walked outward from it
// in both directions: forward by adding each month's net, backward by
// subtracting it. Anchoring at the start of the series instead and walking
// forward would put the one measured figure at the end of a chain of
// estimates, where it corrects nothing.
//
// With no reading there is no balance column at all. Not a zero, and not a
// balance starting from zero — those read as measurements. The flows are
// still worth showing, and they are shown.

// ── Which currency ──────────────────────────────────────────────────────────
//
// Every figure here is in the viewer's display currency (RSD or EUR). The
// loader reads each row's own amount_rsd / amount_eur; nothing is converted
// after it has been summed.

import { fmtMoney } from '../utils/formatters'
import { monthLongLabel, srDate } from '../utils/months'
import { pickAmount, type DisplayCurrency } from '../contexts/DisplayCurrencyContext'

export type MonthKey = string

export interface CashMonth {
  month: MonthKey
  /** Money in, from whichever source this month's figures come from. */
  inflow: number
  outflow: number
  /** Inflow less outflow. */
  net: number
  /**
   * Where the figures came from. `actual` is posted transactions, `projected`
   * is what the forecast expects. The month in progress is `partial`: some of
   * it has happened and the rest has not, which is neither.
   */
  basis: 'actual' | 'partial' | 'projected'
  /**
   * The bank balance at the end of the month, or null where no cash position
   * has been entered to walk from.
   */
  closing: number | null
}

export interface CashTimeline {
  months: CashMonth[]
  /** The month the reading anchors, or null where there is none. */
  anchorMonth: MonthKey | null
  /** The reading itself, for the page to print with its date. */
  position: CashPosition | null
  /** The lowest closing balance across the series, and when. Null with no balance. */
  trough: { month: MonthKey; amount: number } | null
  /** Everything a reader has to know before acting on the line. */
  problems: string[]
}

export interface CashPosition {
  amount: number
  /** ISO date the balance was read. */
  asOf: string
}

export interface CashInput {
  months: MonthKey[]
  /** `YYYY-MM` of the month in progress. Everything before it is settled. */
  currentMonth: MonthKey
  /** month -> what actually moved, from posted transactions. */
  actual: Record<MonthKey, { inflow: number; outflow: number }>
  /** month -> what is expected to move. Read for the current month onward. */
  projected: Record<MonthKey, { inflow: number; outflow: number }>
  position: CashPosition | null
  /**
   * What was posted in the anchor month AFTER the reading was taken.
   *
   * The reading is a point inside a month; the balance column is month-end.
   * Without this the anchor month's closing is the reading plus the whole
   * month's flows, counting again everything that had already happened when
   * the balance was read.
   */
  postedAfterReading?: { inflow: number; outflow: number }
  /** The currency every figure above is in — for the words, not the sums. */
  currency: DisplayCurrency
}

const cents = (n: number): number => Math.round(n * 100) / 100

/** `n` months ending at `last`, oldest first. */
export function monthsEndingAt(last: MonthKey, n: number): MonthKey[] {
  const [y, m] = last.split('-').map(Number)
  const out: MonthKey[] = []
  for (let i = n - 1; i >= 0; i--) {
    const t = y * 12 + (m - 1) - i
    out.push(`${String(Math.floor(t / 12)).padStart(4, '0')}-${String((t % 12) + 1).padStart(2, '0')}`)
  }
  return out
}

/** The `YYYY-MM` before this one. */
export function previousMonth(month: MonthKey): MonthKey {
  return monthsEndingAt(month, 2)[0]
}

/** `back` months before `anchor`, the anchor itself, and `forward` after it. */
export function monthsAround(anchor: MonthKey, back: number, forward: number): MonthKey[] {
  const [y, m] = anchor.split('-').map(Number)
  const out: MonthKey[] = []
  for (let i = -back; i <= forward; i++) {
    const t = y * 12 + (m - 1) + i
    out.push(`${String(Math.floor(t / 12)).padStart(4, '0')}-${String((t % 12) + 1).padStart(2, '0')}`)
  }
  return out
}

/**
 * The year as one line, with the balance walked out from the reading.
 *
 * A month before `currentMonth` reads its actuals; a month after it reads the
 * projection; the current month reads BOTH — what has already been posted plus
 * what the forecast still expects of it. That last one is the case a simpler
 * rule gets wrong in whichever direction it picks: take only the actuals and
 * the month in progress looks like a collapse three weeks in, take only the
 * projection and the money already spent is invisible.
 */
export function cashTimeline(input: CashInput): CashTimeline {
  const { months, currentMonth, actual, projected, position } = input
  const problems: string[] = []

  const rows: CashMonth[] = months.map(month => {
    const a = actual[month] || { inflow: 0, outflow: 0 }
    const p = projected[month] || { inflow: 0, outflow: 0 }

    let inflow: number
    let outflow: number
    let basis: CashMonth['basis']

    if (month < currentMonth) {
      inflow = a.inflow; outflow = a.outflow; basis = 'actual'
    } else if (month === currentMonth) {
      // What has happened plus what is still expected of the rest of it.
      // `remaining` never goes below zero: a month that has already outspent
      // its own forecast has nothing left to expect, and subtracting past it
      // would give the month a negative outflow.
      inflow = cents(a.inflow + Math.max(0, p.inflow - a.inflow))
      outflow = cents(a.outflow + Math.max(0, p.outflow - a.outflow))
      basis = 'partial'
    } else {
      inflow = p.inflow; outflow = p.outflow; basis = 'projected'
    }

    return {
      month,
      inflow: cents(inflow),
      outflow: cents(outflow),
      net: cents(inflow - outflow),
      basis,
      closing: null,
    }
  })

  const anchorMonth = position ? position.asOf.slice(0, 7) : null
  const anchorIndex = anchorMonth ? months.indexOf(anchorMonth) : -1

  if (!position) {
    problems.push(
      'Stanje novca nije uneto, pa nema stanja koje bi se pratilo — prikazani su samo '
      + 'prilivi i odlivi. Unesite stanje na računima i pojaviće se i stanje.')
  } else if (anchorIndex === -1) {
    problems.push(
      `Stanje novca je uneto na dan ${srDate(position.asOf)}, što je van prikazanih meseci, `
      + 'pa stanje ne može da se veže za njega.')
  } else {
    // The reading is a point inside its month; the column is month-end.
    const after = input.postedAfterReading || { inflow: 0, outflow: 0 }
    rows[anchorIndex].closing = cents(position.amount + after.inflow - after.outflow)

    for (let i = anchorIndex + 1; i < rows.length; i++) {
      rows[i].closing = cents((rows[i - 1].closing as number) + rows[i].net)
    }
    // Backwards: the close of the month before is this month's close less what
    // this month moved.
    for (let i = anchorIndex - 1; i >= 0; i--) {
      rows[i].closing = cents((rows[i + 1].closing as number) - rows[i + 1].net)
    }
  }

  const withBalance = rows.filter(r => r.closing !== null)
  const trough = withBalance.length > 0
    ? withBalance.reduce((low, r) =>
      (r.closing as number) < (low.closing as number) ? r : low)
    : null

  if (trough && (trough.closing as number) < 0) {
    problems.push(
      `Na ovoj liniji stanje prelazi u minus u mesecu ${monthLongLabel(trough.month)} i dostiže `
      + `${fmtMoney(trough.closing as number, input.currency)}.`)
  }

  return {
    months: rows,
    anchorMonth: anchorIndex === -1 ? null : anchorMonth,
    position,
    trough: trough ? { month: trough.month, amount: trough.closing as number } : null,
    problems,
  }
}

// ─── What is dated, and what is only expected ───────────────────────────────

export interface DatedOutflow {
  /** `YYYY-MM-DD`. */
  date: string
  label: string
  /** In the display currency. */
  amount: number
  kind: 'instalment' | 'invoice'
}

/**
 * The outflows that carry a date of their own, by month.
 *
 * Credit instalments and unpaid invoices are the two things this application
 * knows the timing of exactly rather than by estimate. They are summed here
 * for the projection AND kept as a list, because "October is heavy" is a
 * different statement from "October is heavy because the Intesa instalment and
 * the Cognant invoice both fall in it", and only the second one can be acted
 * on.
 */
export function datedByMonth(
  items: DatedOutflow[], months: MonthKey[],
): Record<MonthKey, { total: number; items: DatedOutflow[] }> {
  const horizon = new Set(months)
  const out: Record<MonthKey, { total: number; items: DatedOutflow[] }> = {}
  for (const i of items) {
    const month = (i.date || '').slice(0, 7)
    if (!month || !horizon.has(month)) continue
    if (!out[month]) out[month] = { total: 0, items: [] }
    out[month].total = cents(out[month].total + i.amount)
    out[month].items.push(i)
  }
  for (const m of Object.keys(out)) {
    out[m].items.sort((a, b) => a.date.localeCompare(b.date) || b.amount - a.amount)
  }
  return out
}


// ─── What counts as money moving ────────────────────────────────────────────

export interface CashTx {
  type?: string | null
  tx_subtype?: string | null
  amount_rsd?: number | null
  amount_eur?: number | null
}

/**
 * A transaction's contribution to a month's inflow and outflow.
 *
 * AN ALLOWLIST, AND THAT IS THE WHOLE POINT. Three shapes count: a direct
 * revenue receipt, a direct expense payment, and a payment against an invoice.
 * Anything else contributes nothing — not because every other shape has been
 * enumerated, but because a rule written the other way round counts whatever
 * is added to the ledger next.
 *
 * A TRANSFER BETWEEN OUR OWN ACCOUNTS IS NOT CASH FLOW. Money leaving one
 * account and arriving in another is the same money, and counting both legs
 * inflates the inflow and the outflow by the same amount — the net is
 * untouched, so nothing looks wrong, and both totals are simply too big.
 * Those live in `passthrough`, a table this never reads, and the allowlist is
 * the second guard in case one ever reaches `transactions`.
 *
 * The amount is taken at its size whichever sign it arrives with: the ledger
 * books expenses positive in some places and negative in others, and adding a
 * negative to an outflow makes the month look cheaper than it was.
 *
 * `currency` picks which book figure is read; a row with none is no movement.
 */
export function cashMovement(tx: CashTx, currency: DisplayCurrency): { inflow: number; outflow: number } {
  const amount = Math.abs(pickAmount(tx, currency) ?? 0)
  if (!amount) return { inflow: 0, outflow: 0 }
  const dir = cashDirection(tx)
  if (dir === 'in') return { inflow: amount, outflow: 0 }
  if (dir === 'out') return { inflow: 0, outflow: amount }
  return { inflow: 0, outflow: 0 }
}

/**
 * Which way a transaction moves cash, or null when it is not cash flow.
 *
 * THE DIRECTION OF AN INVOICE PAYMENT IS ITS `tx_subtype`. Every dialog
 * writes the linked invoice's type there ('expense' — we paid a supplier;
 * 'revenue' — an investor or tenant paid us). A receipt against a revenue
 * invoice is an INFLOW; counting every invoice payment as an outflow, as
 * this once did, turned each collected billing into a payment of the same
 * size.
 *
 * An invoice payment with NO subtype is treated as an outflow — every one of
 * those was written before revenue invoices existed, when the only invoices
 * paid were suppliers'. A row that is really a receipt and still carries
 * null will read the wrong way until it is re-saved.
 *
 * An advance (is_advance) is a direct revenue receipt and reads as an inflow
 * here: it is cash in, whatever the P&L makes of it.
 */
export function cashDirection(tx: Pick<CashTx, 'type' | 'tx_subtype'>): 'in' | 'out' | null {
  if (tx.type === 'direct') {
    if (tx.tx_subtype === 'revenue') return 'in'
    if (tx.tx_subtype === 'expense') return 'out'
    return null
  }
  if (tx.type === 'invoice_payment') return tx.tx_subtype === 'revenue' ? 'in' : 'out'
  return null
}


// ─── What is expected to come in ────────────────────────────────────────────

export interface DatedInflow {
  /** `YYYY-MM-DD` the money is expected. */
  date: string
  label: string
  /** In the display currency. */
  amount: number
  /**
   * `invoice` — an issued revenue invoice still owed (exact: it has a due
   * date); `plan` / `rent` — a billing not yet issued, from revenue_plan or a
   * lease (an estimate).
   */
  kind: 'invoice' | 'plan' | 'rent'
  /** An invoice already past its due date, moved to the month in progress. */
  overdue?: boolean
}

/** The part of a v_invoice_status row the receivables inflow reads. */
export interface ReceivableRow {
  type?: string | null
  calculated_status?: string | null
  partner_name?: string | null
  invoice_number?: string | null
  invoice_date?: string | null
  due_date?: string | null
  remaining_rsd?: number | string | null
  remaining_eur?: number | string | null
}

/**
 * Open revenue invoices as dated inflows: what each investor or tenant still
 * owes (`remaining_*`, which already nets out the advance deducted and what
 * was paid), on its due date — its invoice date when it has none. One
 * already overdue is money expected NOW: it is dated to the first of the
 * month in progress and flagged, rather than dropped behind the line.
 *
 * Read from the row's own figure in `currency`; a row with none is counted
 * in `unconverted`, never converted here.
 */
export function receivableInflows(
  rows: readonly ReceivableRow[], currentMonth: MonthKey, currency: DisplayCurrency,
): { items: DatedInflow[]; unconverted: number; overdue: number } {
  const items: DatedInflow[] = []
  let unconverted = 0
  let overdue = 0
  const start = `${currentMonth}-01`
  for (const r of rows) {
    if (r.type !== 'revenue') continue
    if (r.calculated_status !== 'unpaid' && r.calculated_status !== 'partial') continue
    const remaining = pickAmount(r, currency, 'remaining')
    if (remaining === null) { unconverted++; continue }
    if (!(remaining > 0)) continue
    const due = String(r.due_date || r.invoice_date || '').slice(0, 10)
    if (!due) continue
    const late = due < start
    if (late) overdue++
    items.push({
      date: late ? start : due,
      label: [r.partner_name || '—', r.invoice_number].filter(Boolean).join(' · '),
      amount: cents(remaining),
      kind: 'invoice',
      ...(late ? { overdue: true } : {}),
    })
  }
  return { items, unconverted, overdue }
}

/**
 * Dated inflows by month, like `datedByMonth` for outflows: summed for the
 * projection and kept as a list, so a heavy month can say why.
 */
export function inflowsByMonthDated(
  items: readonly DatedInflow[], months: MonthKey[],
): Record<MonthKey, { total: number; items: DatedInflow[] }> {
  const horizon = new Set(months)
  const out: Record<MonthKey, { total: number; items: DatedInflow[] }> = {}
  for (const i of items) {
    const month = (i.date || '').slice(0, 7)
    if (!month || !horizon.has(month)) continue
    if (!out[month]) out[month] = { total: 0, items: [] }
    out[month].total = cents(out[month].total + i.amount)
    out[month].items.push(i)
  }
  for (const m of Object.keys(out)) {
    out[m].items.sort((a, b) => a.date.localeCompare(b.date) || b.amount - a.amount)
  }
  return out
}
