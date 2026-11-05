// ─── What the home page counts ──────────────────────────────────────────────
//
// The ledger books every movement of money; the home page is asked what the
// company EARNED, and two kinds of row answer a different question.
//
//   A loan drawdown is booked as revenue under the stream 'Krediti'. It is
//   money borrowed: counted, it makes the month it arrives look like the best
//   month the company ever had.
//
//   Its repayment is the mirror image. The principal is the loan going back,
//   not a cost — while the INTEREST on it is a real cost and stays.
//
// Only the home page reads the ledger this way. Budgeting, Cash Flow, P&L and
// Reports keep the whole instalment as an expense, as before.
//
// THE PRINCIPAL IS FOUND BY THE OWNER'S OWN HEADING, NEVER BY A NAME WRITTEN
// HERE. Each company maps the system role `credit_principal` to one of its P&L
// headings (Podešavanja → Sistemske kategorije); that heading — category and,
// where the mapping has one, subcategory — is what a principal row carries. A
// company with no mapping is NOT guessed at: its expenses stay whole and the
// page names it, because a guess that swept up the interest would flatter the
// profit by exactly the cost of the debt.
//
// Both exclusions are reported as figures. "Some was left out" reassures only
// when it says how much.
//
// Pure: no React, no Supabase.

import { pickAmount, type DisplayCurrency } from '../contexts/DisplayCurrencyContext'
import { REVENUE_STREAM, normaliseRevenueStream } from './revenueStreams'
import type { SystemCategoryMap } from './systemCategories'
import { round2 } from './bookAmounts'

/** A `v_pl_entries` row, narrowed to what this reads. */
export interface PlRow {
  company_id?: string | null
  tx_type: string | null
  /** `numeric` may reach the client as text. */
  amount_rsd: number | string | null
  amount_eur: number | string | null
  pl_date: string | null
  pl_category: string | null
  pl_subcategory: string | null
  revenue_stream: string | null
}

/** Where a company books loan principal: the P&L heading of `credit_principal`. */
export interface PrincipalHeading {
  pl_category: string
  /** Null when the mapping names a category only; then the category decides. */
  pl_subcategory: string | null
}

export interface HomeLedgerMonth {
  month: string
  revenue: number
  expenses: number
  net: number
}

export interface HomeLedgerFigures {
  /** Revenue without loan drawdowns. */
  revenue: number
  /** Expenses without loan principal; interest is in. */
  expenses: number
  net: number
  /** Drawdowns the ledger booked as revenue (stream 'Krediti'). */
  loansDrawn: number
  /** Principal repayments the ledger booked as expense. */
  principalRepaid: number
  /** One per month asked for, in that order. */
  months: HomeLedgerMonth[]
  /** Expenses on the same basis, by P&L category, largest first. */
  expenseByCategory: { label: string; value: number }[]
  /** Companies whose principal could not be told apart: no mapping. In first-seen order. */
  unmappedCompanies: string[]
  /**
   * Companies whose principal and interest headings cannot be told apart —
   * principal mapped to a whole category that also holds the interest, or the
   * two mapped alike. Read as unmapped (expenses whole), named separately
   * because the fix is a subcategory, not a mapping.
   */
  ambiguousCompanies: string[]
}

const filled = (v: string | null | undefined): v is string => !!(v && v.trim())

/**
 * The heading of the `credit_principal` role, or null when it has no category.
 *
 * Deliberately more lenient than `isRoleSet`, which a WRITE needs: a mapping
 * whose department is still blank has nevertheless said where principal goes,
 * and that is all a reader needs to recognise it.
 */
export function principalHeadingOf(map: SystemCategoryMap | null | undefined): PrincipalHeading | null {
  return roleHeadingOf(map, 'credit_principal')
}

/** The same for any role — the home page also reads `credit_interest`. */
export function roleHeadingOf(
  map: SystemCategoryMap | null | undefined, role: 'credit_principal' | 'credit_interest',
): PrincipalHeading | null {
  const c = map?.[role]
  if (!c || !filled(c.pl_category)) return null
  return {
    pl_category: c.pl_category.trim(),
    pl_subcategory: filled(c.pl_subcategory) ? c.pl_subcategory.trim() : null,
  }
}

const isPrincipal = (row: PlRow, h: PrincipalHeading): boolean =>
  (row.pl_category ?? '').trim() === h.pl_category
  && (h.pl_subcategory === null || (row.pl_subcategory ?? '').trim() === h.pl_subcategory)

/** Whether every row under `interest` would also match `principal`, or the reverse. */
function overlaps(principal: PrincipalHeading, interest: PrincipalHeading | null | undefined): boolean {
  if (!interest || interest.pl_category !== principal.pl_category) return false
  return principal.pl_subcategory === null || interest.pl_subcategory === null
    || principal.pl_subcategory === interest.pl_subcategory
}

const isRevenue = (t: string | null) => t === 'revenue' || t === 'invoice_revenue'
const isExpense = (t: string | null) => t === 'expense' || t === 'invoice_expense'

/**
 * One pass over the period's rows.
 *
 * `principalByCompany` holds every company in scope: a heading, or null for a
 * company with no mapping. A row from a company it does not mention is read as
 * unmapped too. Rows dated outside `months` still count in the totals (they
 * are in the fetched period); they land in no month.
 */
export function homeLedgerFigures(rows: readonly PlRow[], opts: {
  months: readonly string[]
  currency: DisplayCurrency
  principalByCompany: Readonly<Record<string, PrincipalHeading | null>>
  /** Each company's `credit_interest` heading: a row under it is never principal. */
  interestByCompany?: Readonly<Record<string, PrincipalHeading | null>>
}): HomeLedgerFigures {
  const byMonth = new Map<string, HomeLedgerMonth>()
  for (const month of opts.months) byMonth.set(month, { month, revenue: 0, expenses: 0, net: 0 })

  let revenue = 0
  let expenses = 0
  let loansDrawn = 0
  let principalRepaid = 0
  const categories = new Map<string, number>()
  const unmapped: string[] = []
  const ambiguous: string[] = []
  const interestOf = (id: string) => opts.interestByCompany?.[id] ?? null

  /** The heading to take principal out by, or null when there is none to trust. */
  const usable = new Map<string, PrincipalHeading | null>()
  for (const [id, h] of Object.entries(opts.principalByCompany)) {
    if (h === null) {
      if (!unmapped.includes(id)) unmapped.push(id)
      usable.set(id, null)
    } else if (overlaps(h, interestOf(id))) {
      ambiguous.push(id)
      usable.set(id, null)
    } else {
      usable.set(id, h)
    }
  }

  for (const row of rows) {
    const amount = pickAmount(row, opts.currency) ?? 0
    const month = byMonth.get((row.pl_date || '').slice(0, 7))

    if (isRevenue(row.tx_type)) {
      if (normaliseRevenueStream(row.revenue_stream) === REVENUE_STREAM.loans) {
        loansDrawn += amount
        continue
      }
      revenue += amount
      if (month) month.revenue += amount
      continue
    }

    if (!isExpense(row.tx_type)) continue

    const company = row.company_id ?? ''
    const known = usable.has(company)
    const heading = known ? usable.get(company)! : null
    if (!known && company && !unmapped.includes(company)) unmapped.push(company)

    const interest = interestOf(company)
    if (heading && isPrincipal(row, heading) && !(interest && isPrincipal(row, interest))) {
      principalRepaid += amount
      continue
    }
    expenses += amount
    if (month) month.expenses += amount
    const cat = row.pl_category || 'Ostalo'
    categories.set(cat, (categories.get(cat) || 0) + amount)
  }

  const months = opts.months.map(m => {
    const x = byMonth.get(m)!
    return { month: m, revenue: round2(x.revenue), expenses: round2(x.expenses), net: round2(x.revenue - x.expenses) }
  })

  return {
    revenue: round2(revenue),
    expenses: round2(expenses),
    net: round2(revenue - expenses),
    loansDrawn: round2(loansDrawn),
    principalRepaid: round2(principalRepaid),
    months,
    expenseByCategory: Array.from(categories.entries())
      .map(([label, value]) => ({ label, value: round2(value) }))
      .sort((a, b) => b.value - a.value),
    unmappedCompanies: unmapped,
    ambiguousCompanies: ambiguous,
  }
}
