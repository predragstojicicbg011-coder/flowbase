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
      'No cash position has been entered, so there is no balance to walk — only the '
      + 'flows. Enter what is in the accounts and the balance appears.')
  } else if (anchorIndex === -1) {
    problems.push(
      `The cash position was read on ${position.asOf}, which is outside the months drawn `
      + 'here, so the balance cannot be anchored to it.')
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
      `On this line the balance goes negative in ${trough.month}, reaching `
      + `${(trough.closing as number).toFixed(2)}.`)
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
  amountUsd: number
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
    out[month].total = cents(out[month].total + i.amountUsd)
    out[month].items.push(i)
  }
  for (const m of Object.keys(out)) {
    out[m].items.sort((a, b) => a.date.localeCompare(b.date) || b.amountUsd - a.amountUsd)
  }
  return out
}


// ─── What counts as money moving ────────────────────────────────────────────

export interface CashTx {
  type?: string | null
  tx_subtype?: string | null
  amount_usd?: number | null
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
 */
export function cashMovement(tx: CashTx): { inflow: number; outflow: number } {
  const amount = Math.abs(Number(tx.amount_usd) || 0)
  if (!amount) return { inflow: 0, outflow: 0 }
  if (tx.type === 'direct' && tx.tx_subtype === 'revenue') return { inflow: amount, outflow: 0 }
  if (tx.type === 'direct' && tx.tx_subtype === 'expense') return { inflow: 0, outflow: amount }
  if (tx.type === 'invoice_payment') return { inflow: 0, outflow: amount }
  return { inflow: 0, outflow: 0 }
}
