// ─── Revenue plan and rent: what each project is expected to bill ──────────
//
// Schema: supabase/migrations/20261008180000_accrual_revenue.sql.
//
// Two sources of expected billings, neither of them stored as a forecast:
//
//   revenue_plan    typed by hand, one figure per project per month, with
//                   book figures at the NBS rate of the day it was typed
//                   (`planBookFigures`): a month not yet come has no rate of
//                   its own, and a plan is an estimate that is never
//                   revalued.
//   rental_leases   a tenant's monthly rent from start_date to end_date (or
//                   on, for an open-ended lease). Worked out here every time,
//                   to the end of each lease.
//
// ── PRECEDENCE, so no month is counted twice ───────────────────────────────
//
//   1. A rent invoice already issued for a lease and month (invoices.lease_id
//      + service_month) removes that lease's forecast for the month. It is a
//      receivable now, and the cash line has it from v_invoice_status.
//   2. A plan row for a project and month REPLACES the lease forecast of that
//      project for that month — on a rental building it is the deliberate
//      override (a vacancy, a rent review, a one-off).
//   3. Revenue invoices of the project dated in that month are deducted from
//      the plan row, floored at zero: the plan is the month's whole expected
//      billing, and what has been billed of it is no longer a plan.
//
// ── WHEN THE CASH COMES ────────────────────────────────────────────────────
//
//   A planned billing is dated the LAST day of its month — progress is
//   billed on the month's work, at its end — and expected `projects.
//   payment_days` later (45 by default). Rent is dated on the lease's
//   invoice_day and expected lease.payment_days later. `cashInflowsFromPlan`
//   turns the lines into dated inflows for the cash timeline.
//
// ── CURRENCY ────────────────────────────────────────────────────────────────
//
//   Plan rows are read from their own amount_rsd / amount_eur. Rent has no
//   book figure until it is invoiced; a lease in the other currency is
//   converted at the rate the caller passes (the latest NBS list), and left
//   out with a note when there is none.

import { bookAmounts, getBookRates, round2, type BookRates } from './bookAmounts'
import { DEFAULT_PAYMENT_DAYS, type Project } from './projects'
import { REVENUE_STREAM } from './revenueStreams'
import { countOf, plural } from '../utils/plural'
import { pickAmount, type DisplayCurrency } from '../contexts/DisplayCurrencyContext'

export type LeaseCurrency = 'RSD' | 'EUR'

export interface RentalLease {
  id: string
  company_id?: string
  project_id: string
  tenant_partner_id: string
  monthly_rent: number | string
  currency: LeaseCurrency
  /** `YYYY-MM-DD`. */
  start_date: string
  end_date: string | null
  /** 1..28. */
  invoice_day: number
  payment_days: number
  active: boolean
  note?: string | null
}

export interface RevenuePlanRow {
  id?: string
  company_id?: string
  project_id: string
  /** First of the month, `YYYY-MM-01`. */
  month: string
  amount: number | string
  currency: LeaseCurrency
  amount_rsd: number | string | null
  amount_eur: number | string | null
  eur_rate?: number | string | null
  rate_date?: string | null
  note?: string | null
}

/** The invoice columns the plan and rent logic read (from invoices or v_invoice_status). */
export interface PlanInvoice {
  project_id: string | null
  type: string | null
  invoice_date: string
  amount_rsd?: number | string | null
  amount_eur?: number | string | null
  lease_id?: string | null
  service_month?: string | null
  deleted_at?: string | null
}

// ── Dates ───────────────────────────────────────────────────────────────────

const pad = (n: number) => String(n).padStart(2, '0')

/** `YYYY-MM` of a date or month. */
export function monthKey(d: string): string {
  return (d || '').slice(0, 7)
}

/** `YYYY-MM-01`, the form `month` / `service_month` are stored in. */
export function firstOfMonth(month: string): string {
  return `${monthKey(month)}-01`
}

export function daysInMonth(month: string): number {
  const [y, m] = monthKey(month).split('-').map(Number)
  return new Date(Date.UTC(y, m, 0)).getUTCDate()
}

export function lastOfMonth(month: string): string {
  return `${monthKey(month)}-${pad(daysInMonth(month))}`
}

/** `YYYY-MM-DD` plus `days`. */
export function addDays(date: string, days: number): string {
  const [y, m, d] = date.slice(0, 10).split('-').map(Number)
  const t = new Date(Date.UTC(y, m - 1, d + days))
  return `${t.getUTCFullYear()}-${pad(t.getUTCMonth() + 1)}-${pad(t.getUTCDate())}`
}

/** Numeric columns can arrive as strings from PostgREST. */
function num(v: unknown): number {
  const n = typeof v === 'number' ? v : Number(v)
  return Number.isFinite(n) ? n : 0
}

// ── Rent ────────────────────────────────────────────────────────────────────

/**
 * The rent a lease earns for `month`, in the lease's currency.
 *
 * A month the lease covers in full is the monthly rent. A month it covers in
 * part — it starts on the 16th, or ends on the 10th — is prorated by calendar
 * days and rounded to the para. An inactive lease, or a month outside its
 * dates, earns nothing.
 */
export function leaseMonthRent(lease: RentalLease, month: string): number {
  if (!lease.active) return 0
  const first = firstOfMonth(month)
  const last = lastOfMonth(month)
  const from = lease.start_date > first ? lease.start_date.slice(0, 10) : first
  const to = lease.end_date && lease.end_date < last ? lease.end_date.slice(0, 10) : last
  if (from > to) return 0
  const covered = Number(to.slice(8, 10)) - Number(from.slice(8, 10)) + 1
  const full = daysInMonth(month)
  const rent = num(lease.monthly_rent)
  return covered >= full ? round2(rent) : round2((rent * covered) / full)
}

const day = (n: unknown): number => {
  const d = Math.trunc(num(n))
  return d >= 1 && d <= 28 ? d : 1
}

/** The date a lease's rent invoice for `month` carries. */
export function rentInvoiceDate(lease: RentalLease, month: string): string {
  return `${monthKey(month)}-${pad(day(lease.invoice_day))}`
}

const hasRentInvoice = (invoices: readonly PlanInvoice[], leaseId: string, month: string) =>
  invoices.some(i => !i.deleted_at && i.lease_id === leaseId && monthKey(i.service_month || '') === monthKey(month))

/** A rent invoice the app proposes, ready for toBookAmounts and an insert. */
export interface RentInvoiceProposal {
  lease_id: string
  project_id: string
  partner_id: string
  type: 'revenue'
  revenue_stream: typeof REVENUE_STREAM.rental
  /** `YYYY-MM-01`. */
  service_month: string
  invoice_date: string
  due_date: string
  amount: number
  currency: LeaseCurrency
}

/**
 * The rent invoices still to issue for `month`: one per active lease that
 * earns rent in the month and has no rent invoice for it yet (deleted ones
 * do not count, matching the unique index). In the order of `leases`.
 */
export function rentInvoicesDue(
  leases: readonly RentalLease[], month: string, existingInvoices: readonly PlanInvoice[],
): RentInvoiceProposal[] {
  const out: RentInvoiceProposal[] = []
  for (const lease of leases) {
    const amount = leaseMonthRent(lease, month)
    if (!(amount > 0)) continue
    if (hasRentInvoice(existingInvoices, lease.id, month)) continue
    const invoice_date = rentInvoiceDate(lease, month)
    out.push({
      lease_id: lease.id,
      project_id: lease.project_id,
      partner_id: lease.tenant_partner_id,
      type: 'revenue',
      revenue_stream: REVENUE_STREAM.rental,
      service_month: firstOfMonth(month),
      invoice_date,
      due_date: addDays(invoice_date, Math.max(0, Math.trunc(num(lease.payment_days)))),
      amount,
      currency: lease.currency === 'EUR' ? 'EUR' : 'RSD',
    })
  }
  return out
}

export interface RentForecastLine {
  lease_id: string
  project_id: string
  /** `YYYY-MM`. */
  month: string
  /** In the lease's currency. */
  amount: number
  currency: LeaseCurrency
  invoice_date: string
  payment_days: number
}

/**
 * The rent each lease is expected to bill over `months`, up to its end
 * (an open-ended lease, through the last month asked). A lease-month that
 * already has a rent invoice is not forecast: it is a receivable.
 */
export function rentForecast(
  leases: readonly RentalLease[], months: readonly string[], existingInvoices: readonly PlanInvoice[] = [],
): RentForecastLine[] {
  const out: RentForecastLine[] = []
  for (const m of months.map(monthKey)) {
    for (const lease of leases) {
      const amount = leaseMonthRent(lease, m)
      if (!(amount > 0) || hasRentInvoice(existingInvoices, lease.id, m)) continue
      out.push({
        lease_id: lease.id, project_id: lease.project_id, month: m, amount,
        currency: lease.currency === 'EUR' ? 'EUR' : 'RSD',
        invoice_date: rentInvoiceDate(lease, m),
        payment_days: Math.max(0, Math.trunc(num(lease.payment_days))),
      })
    }
  }
  return out
}

// ── Plan and rent together ──────────────────────────────────────────────────

export interface PlannedRevenue {
  project_id: string
  /** `YYYY-MM`. */
  month: string
  /** In the display currency. */
  amount: number
  source: 'plan' | 'rent'
  lease_id?: string
  /** The date the billing is expected to be issued. */
  billing_date: string
  /** Days from billing_date to the money. */
  payment_days: number
}

export interface PlannedRevenueResult {
  lines: PlannedRevenue[]
  /** month → total, display currency. Every month asked is present. */
  byMonth: Record<string, number>
  /** project → month → total. */
  byProjectMonth: Record<string, Record<string, number>>
  /** What was left out, and why. */
  notes: string[]
}

export interface PlannedRevenueOptions {
  currency: DisplayCurrency
  /** RSD per 1 EUR, for rent in the other currency — the latest NBS rate. */
  eurRate?: number | null
  /** Invoices of these projects (revenue ones are read; deleted ones ignored). */
  invoices?: readonly PlanInvoice[]
}

/**
 * Expected billings per project per month over `months`, with the
 * precedence at the top of this file: issued rent invoices drop their
 * lease-month, a plan row replaces the project's rent forecast for its
 * month, and revenue invoices issued in a month reduce that month's plan.
 */
export function plannedRevenueByMonth(
  projects: readonly Pick<Project, 'id' | 'payment_days'>[],
  plan: readonly RevenuePlanRow[],
  leases: readonly RentalLease[],
  months: readonly string[],
  opts: PlannedRevenueOptions,
): PlannedRevenueResult {
  const cur = opts.currency
  const keys = months.map(monthKey)
  const horizon = new Set(keys)
  const invoices = (opts.invoices || []).filter(i => i.type === 'revenue' && !i.deleted_at)
  const paymentDays = new Map(projects.map(p => [p.id, p.payment_days ?? DEFAULT_PAYMENT_DAYS]))
  const notes: string[] = []
  const lines: PlannedRevenue[] = []

  // Plan rows, less what the project has already billed in the month.
  const planned = new Set<string>()
  let planUnconverted = 0
  for (const row of plan) {
    const m = monthKey(row.month)
    if (!horizon.has(m)) continue
    planned.add(`${row.project_id}|${m}`)
    const amount = pickAmount(row, cur)
    if (amount === null) { planUnconverted++; continue }
    let billed = 0
    for (const i of invoices) {
      if (i.project_id === row.project_id && monthKey(i.invoice_date) === m) billed += pickAmount(i, cur) ?? 0
    }
    const left = round2(Math.max(0, amount - billed))
    if (!(left > 0)) continue
    lines.push({
      project_id: row.project_id, month: m, amount: left, source: 'plan',
      billing_date: lastOfMonth(m),
      payment_days: paymentDays.get(row.project_id) ?? DEFAULT_PAYMENT_DAYS,
    })
  }
  if (planUnconverted) {
    notes.push(`${countOf(planUnconverted, 'stavka plana', 'stavke plana', 'stavki plana')} ${plural(planUnconverted, 'nema', 'nemaju', 'nema')} iznos u ${cur} i ${plural(planUnconverted, 'nije uračunata', 'nisu uračunate', 'nije uračunato')}.`)
  }

  // Rent, where no plan row speaks for the project and month.
  let rentUnconverted = 0
  for (const r of rentForecast(leases, keys, opts.invoices || [])) {
    if (planned.has(`${r.project_id}|${r.month}`)) continue
    let amount: number | null = r.amount
    if (r.currency !== cur) {
      const rate = opts.eurRate && opts.eurRate > 0 ? opts.eurRate : null
      amount = rate === null ? null : round2(cur === 'RSD' ? r.amount * rate : r.amount / rate)
    }
    if (amount === null) { rentUnconverted++; continue }
    lines.push({
      project_id: r.project_id, month: r.month, amount, source: 'rent', lease_id: r.lease_id,
      billing_date: r.invoice_date, payment_days: r.payment_days,
    })
  }
  if (rentUnconverted) {
    notes.push(`${countOf(rentUnconverted, 'mesec', 'meseca', 'meseci')} zakupa u drugoj valuti ${plural(rentUnconverted, 'nije uračunat', 'nisu uračunata', 'nije uračunato')}: kurs nije dostupan.`)
  }

  const byMonth: Record<string, number> = Object.fromEntries(keys.map(k => [k, 0]))
  const byProjectMonth: Record<string, Record<string, number>> = {}
  for (const l of lines) {
    byMonth[l.month] = round2(byMonth[l.month] + l.amount)
    if (!byProjectMonth[l.project_id]) byProjectMonth[l.project_id] = {}
    const p = byProjectMonth[l.project_id]
    p[l.month] = round2((p[l.month] || 0) + l.amount)
  }
  return { lines, byMonth, byProjectMonth, notes }
}

export interface DatedInflow {
  /** `YYYY-MM-DD` the money is expected. */
  date: string
  amount: number
  project_id: string
  source: 'plan' | 'rent'
  lease_id?: string
}

/**
 * Planned billings as cash: each line on its billing date plus its payment
 * term. Sorted by date. Feed `byMonth`-style totals to the timeline's
 * projected inflow, or bucket with cashTimeline.datedByMonth.
 */
export function cashInflowsFromPlan(lines: readonly PlannedRevenue[]): DatedInflow[] {
  return lines
    .map(l => ({
      date: addDays(l.billing_date, l.payment_days),
      amount: l.amount, project_id: l.project_id, source: l.source,
      ...(l.lease_id ? { lease_id: l.lease_id } : {}),
    }))
    .sort((a, b) => a.date.localeCompare(b.date) || b.amount - a.amount)
}

/** Dated inflows summed by `YYYY-MM`, for the months asked. */
export function inflowsByMonth(inflows: readonly DatedInflow[], months: readonly string[]): Record<string, number> {
  const out: Record<string, number> = Object.fromEntries(months.map(m => [monthKey(m), 0]))
  for (const i of inflows) {
    const m = monthKey(i.date)
    if (m in out) out[m] = round2(out[m] + i.amount)
  }
  return out
}

// ── Saving a plan row ───────────────────────────────────────────────────────

export interface PlanBook {
  eur_rate: number
  rate_date: string
  amount_rsd: number
  amount_eur: number
}

/** The book figures of a plan amount at rates in hand. Pure. */
export function planBookFiguresAtRates(
  amount: number, currency: LeaseCurrency, rates: Pick<BookRates, 'date' | 'eurRate' | 'usdRate'>,
): PlanBook {
  const b = bookAmounts(amount, currency, rates)
  return { eur_rate: b.eur_rate, rate_date: rates.date, amount_rsd: b.amount_rsd, amount_eur: b.amount_eur }
}

/**
 * The book figures for a plan amount typed on `today`: the latest NBS list
 * on that day, whatever month the plan is for. Throws RateUnavailableError.
 */
export async function planBookFigures(amount: number, currency: LeaseCurrency, today: string): Promise<PlanBook> {
  return planBookFiguresAtRates(amount, currency, await getBookRates(today))
}
