// ─── loadCashTimeline ───────────────────────────────────────────────────────
//
// Everything the cash line needs, from the places it lives.
//
// It is a loader and nothing else: every decision about what a figure MEANS is
// in `cashTimeline` and `budgetTree`, which are tested with numbers. This fetches, shapes and hands over.
//
// ── Where each half comes from ──────────────────────────────────────────────
//
//   past      posted transactions, on the cash basis — the same filter the
//             period view below uses, so the two halves of this page cannot
//             disagree about what a month did
//   ahead     the budget's own estimate for the outflow; the inflow is empty
//             until the construction-revenue forecast exists
//   anchor    the cash position, a reading somebody took
//   dated     credit instalments and unpaid invoices, which carry their own
//             dates and are the only outflows whose timing is known rather
//             than assumed
//
// ── The assumption, stated ──────────────────────────────────────────────────
//
// The outflow of a future month is the BUDGET for that month, which is an
// accrual: what the month costs, not what leaves the bank in it. Where a
// supplier is paid thirty days after invoicing, the cash is a month behind the
// cost. That is a real difference and it is not modelled here — it is said on
// screen instead, because a lag invented in code is a lag nobody can check.
// The dated items are exact, and they are listed separately for that reason.
//
// ── Currency ────────────────────────────────────────────────────────────────
//
// Everything is read in `req.currency`, the viewer's display currency: each
// transaction's, invoice's and cash reading's own amount_rsd / amount_eur.
// A credit instalment is the exception — it is a future payment in the
// credit's own currency with no booked rate yet, so one in the other
// currency is converted at today's NBS rate, and the page is told so. If no
// rate can be had, those instalments are left out and that is said too.
// The budget is asked for in `req.currency` too; when it can only be read in
// RSD and the line is in EUR, the projected outflow is left out and said so.

import { fetchAllPages } from '../utils/fetchAllPages'
import { CASH_ONLY_FILTER } from './cashBasis'
import { loadBudgetTree } from './budgetTree'
import { bookAmounts, getBookRates, type BookRates } from './bookAmounts'
import { pickAmount, type DisplayCurrency } from '../contexts/DisplayCurrencyContext'
import {
  cashMovement, cashTimeline, datedByMonth, monthsAround,
  type CashPosition, type CashTimeline, type DatedOutflow, type MonthKey,
} from './cashTimeline'

export interface QueryClient { from: (table: string) => any }

export interface CashRequest {
  /** `YYYY-MM` of the month in progress. */
  currentMonth: MonthKey
  /** ISO date of today. Unused until the revenue forecast reads it. */
  today: string
  /** The benchmark month the budget is seeded from. */
  benchmark: string
  companyIds: string[]
  /** How many settled months to show behind today, and how many ahead. */
  back?: number
  forward?: number
  /** The viewer's display currency; every figure returned is in it. */
  currency: DisplayCurrency
}

export interface LoadedCashTimeline {
  timeline: CashTimeline
  dated: Record<MonthKey, { total: number; items: DatedOutflow[] }>
  months: MonthKey[]
}

const cents = (n: number): number => Math.round(n * 100) / 100
const lastDayOf = (month: MonthKey): string => {
  const [y, m] = month.split('-').map(Number)
  return `${month}-${String(new Date(Date.UTC(y, m, 0)).getUTCDate()).padStart(2, '0')}`
}

const withNotes = (t: CashTimeline, notes: string[]): CashTimeline =>
  notes.length > 0 ? { ...t, problems: [...t.problems, ...notes] } : t

export async function loadCashTimeline(
  client: QueryClient, req: CashRequest,
): Promise<LoadedCashTimeline> {
  const cur = req.currency
  const back = req.back ?? 5
  const forward = req.forward ?? 6
  const months = monthsAround(req.currentMonth, back, forward)
  const first = months[0]
  const last = months[months.length - 1]
  const future = months.filter(m => m >= req.currentMonth)

  const scoped = (q: any, col = 'company_id') =>
    req.companyIds.length > 0 ? q.in(col, req.companyIds) : q

  const [txRows, instRows, invRows, { data: cashRow }, budget] =
    await Promise.all([
      // The same cash-basis filter the period view uses. A currency gain is in
      // the P&L and never touched the bank.
      fetchAllPages<any>((lo, hi) => scoped(
        client.from('transactions')
          .select('transaction_date, amount_rsd, amount_eur, type, tx_subtype')
          .gte('transaction_date', `${first}-01`)
          .lte('transaction_date', lastDayOf(last))
          .eq('status', 'posted')
          .or(CASH_ONLY_FILTER))
        .order('transaction_date').order('id').range(lo, hi)),

      fetchAllPages<any>((lo, hi) => client.from('credit_installments')
        .select('id, installment_no, due_date, principal_amount, interest_amount, status, credits(name, company_id, currency)')
        .gte('due_date', `${req.currentMonth}-01`)
        .lte('due_date', lastDayOf(last))
        .order('due_date').order('id').range(lo, hi)),

      fetchAllPages<any>((lo, hi) => scoped(
        client.from('v_invoice_status')
          .select('id, partner_name, due_date, remaining_rsd, remaining_eur, type, calculated_status, company_id')
          .in('calculated_status', ['unpaid', 'partial'])
          .lte('due_date', lastDayOf(last)))
        .order('due_date').order('id').range(lo, hi)),

      client.from('v_cash_position_latest').select('as_of, amount_rsd, amount_eur').maybeSingle(),

      loadBudgetTree(client as any, {
        monthKeys: future, benchmark: req.benchmark,
        companyIds: req.companyIds, companyId: '', branch: 'pl',
        currency: cur,
      }),
    ])

  // ── What actually moved ────────────────────────────────────────────────
  const actual: Record<MonthKey, { inflow: number; outflow: number }> = {}
  for (const t of txRows) {
    const m = (t.transaction_date || '').slice(0, 7)
    if (!m) continue
    if (!actual[m]) actual[m] = { inflow: 0, outflow: 0 }
    // The allowlist, once. A transfer between our own accounts is the same
    // money twice and is not cash flow — see `cashMovement`.
    const moved = cashMovement(t, cur)
    actual[m].inflow += moved.inflow
    actual[m].outflow += moved.outflow
  }
  for (const m of Object.keys(actual)) {
    actual[m].inflow = cents(actual[m].inflow)
    actual[m].outflow = cents(actual[m].outflow)
  }

  // ── What is expected to move ───────────────────────────────────────────
  const projected: Record<MonthKey, { inflow: number; outflow: number }> = {}
  for (const m of future) projected[m] = { inflow: 0, outflow: 0 }

  // Out: the budget's own total for the month, summed from the roots the way
  // the Budgeting page sums it, so the two pages state the same figure.
  //
  // Only in the timeline's own currency. A budget that could not be read in
  // EUR comes back in RSD (`eurUnavailable`); adding dinars to a euro line
  // would be wrong by a factor of 117, so the projected outflow is left out
  // and the page is told why.
  const notes: string[] = []
  const budgetInCurrency = budget.currency === cur
  if (!budgetInCurrency) {
    notes.push(
      `The budget could not be read in ${cur}, so future months show no projected outflow`
      // The budget's own reason, less its "It is shown in RSD." — here it is not shown.
      + (budget.eurUnavailable ? `: ${budget.eurUnavailable.replace(/\s*It is shown in RSD\.\s*$/, '')}` : '.'))
  }
  for (const m of future) {
    if (!budgetInCurrency) continue
    const rolled = budget.rolled[m] || {}
    projected[m].outflow = cents(
      budget.rows.filter(r => !r.parent)
        .reduce((s, r) => s + (rolled[r.key]?.budget || 0), 0))
  }

  // In: nothing yet. The manual construction-revenue forecast (progress
  // billings and rentals) feeds this in a later phase; until then a future
  // month's inflow is zero rather than a guess.

  // ── The outflows that carry a date of their own ────────────────────────
  const inScope = (cid: any) => req.companyIds.length === 0 || req.companyIds.includes(cid)
  const instalments = instRows.filter((i: any) => inScope((i.credits as any)?.company_id))

  // An instalment in the other currency needs a rate; today's NBS list is the
  // only honest one for a payment that has not happened. Fetched only when
  // some instalment needs it.
  const creditCurrency = (i: any): string => String((i.credits as any)?.currency || 'RSD').toUpperCase()
  let rates: BookRates | null = null
  if (instalments.some((i: any) => creditCurrency(i) !== cur)) {
    try {
      rates = await getBookRates(req.today)
      notes.push(
        `Credit instalments not in ${cur} are converted at the NBS rate of ${rates.date}; `
        + 'they are future payments and have no booked rate yet.')
    } catch {
      notes.push(
        `No NBS rate could be read for ${req.today}, so credit instalments not in ${cur} `
        + 'are left out of the dated outflows.')
    }
  }
  const instalmentAmount = (i: any): number | null => {
    const own = cents((Number(i.principal_amount) || 0) + (Number(i.interest_amount) || 0))
    const c = creditCurrency(i)
    if (c === cur) return own
    if (!rates) return null
    try {
      const b = bookAmounts(own, c, rates)
      return cur === 'RSD' ? b.amount_rsd : b.amount_eur
    } catch {
      return null
    }
  }

  const dated = datedByMonth([
    ...instalments.flatMap((i: any): DatedOutflow[] => {
      const amount = instalmentAmount(i)
      return amount === null ? [] : [{
        date: i.due_date,
        label: `${(i.credits as any)?.name || 'Credit'} #${i.installment_no}`,
        amount,
        kind: 'instalment',
      }]
    }),
    ...invRows
      .filter((v: any) => v.type === 'expense' && v.due_date)
      .map((v: any): DatedOutflow => ({
        // An invoice already overdue is money owed NOW, so it is dated to the
        // first day of the month in progress rather than to a month this line
        // does not draw.
        date: v.due_date < `${req.currentMonth}-01` ? `${req.currentMonth}-01` : v.due_date,
        label: v.partner_name || '—',
        amount: Math.abs(pickAmount(v, cur, 'remaining') ?? 0),
        kind: 'invoice',
      })),
  ], months)

  const position: CashPosition | null = cashRow
    ? { amount: pickAmount(cashRow, cur) ?? 0, asOf: cashRow.as_of }
    : null
  if (cashRow && pickAmount(cashRow, cur) === null) {
    notes.push(`The cash position of ${cashRow.as_of} has no ${cur} figure, so it is read as zero.`)
  }

  // Posted after the reading, inside its own month: the reading is a point and
  // the balance column is month-end.
  let postedAfterReading = { inflow: 0, outflow: 0 }
  if (position) {
    for (const t of txRows) {
      const d = t.transaction_date || ''
      if (d <= position.asOf || d.slice(0, 7) !== position.asOf.slice(0, 7)) continue
      const moved = cashMovement(t, cur)
      postedAfterReading.inflow += moved.inflow
      postedAfterReading.outflow += moved.outflow
    }
    postedAfterReading = {
      inflow: cents(postedAfterReading.inflow),
      outflow: cents(postedAfterReading.outflow),
    }
  }

  return {
    months,
    dated,
    timeline: withNotes(cashTimeline({
      months, currentMonth: req.currentMonth, actual, projected, position,
      postedAfterReading, currency: cur,
    }), notes),
  }
}
