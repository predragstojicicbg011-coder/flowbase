// ─── Revenue: billings, advances, what the investor still owes ─────────────
//
// Schema: supabase/migrations/20261008180000_accrual_revenue.sql.
//
// ── THE CONTRACT ────────────────────────────────────────────────────────────
//
//   Revenue is a REVENUE INVOICE — a progress billing ("situacija") or a
//   month's rent — recognised on its invoice date, on its project. The
//   receipt that settles it is an 'invoice_payment' with pl_impact false:
//   cash, never P&L. A direct revenue transaction tied to no invoice (interest,
//   a VAT refund) is still P&L revenue by itself.
//
//   An ADVANCE (avans) is a direct revenue receipt with `is_advance` true,
//   pl_impact false, on a project: a liability. A billing deducts part of it
//   (`invoices.advance_deducted`, in the invoice's currency, with
//   `advance_deducted_rsd` / `_eur` at the invoice's stored rates). The P&L
//   takes the whole billing; the investor owes `amount − advance_deducted`,
//   and v_invoice_status counts the deduction as settled.
//
//   Per project: received − deducted = remaining. A deduction may not take
//   more than remains (`validateAdvanceDeduction`, which the invoice dialog
//   runs before saving). v_project_advances is the same balance in SQL, for
//   reading; this module is the one that can say no before a write.
//
// ── CURRENCY ────────────────────────────────────────────────────────────────
//
//   Totals are in the viewer's display currency, read from each row's own
//   `_rsd` / `_eur` column and summed — never a sum converted at one rate.
//   The advance balance is also kept in the ONE document currency when every
//   advance and every deducting billing of the project is in it: a euro
//   advance used up by euro billings at different rates leaves a few dinars
//   of RSD "remainder" that is an exchange difference, not advance, and the
//   check must not be fooled by it either way.
//
// Functions:
//
//   advanceDeductionBook(deducted, invoice)          → the three stored columns
//   projectAdvanceBalance(projectId, advances, deductions) → AdvanceBalance
//   validateAdvanceDeduction(req)                    → Serbian error | null
//   projectRevenueSummary(project, invoices, advances, currency, opts)
//                                                    → RevenueSummary
//   receivablesAging(rows, today, currency)          → Aging

import { partBookAmounts, round2, type RatedRow } from './bookAmounts'
import { PAID_WITHIN_RSD } from './settleInvoice'
import { pickAmount, type DisplayCurrency } from '../contexts/DisplayCurrencyContext'
import { fmtMoney } from '../utils/formatters'
import type { Project } from './projects'

/** Numeric columns can arrive as strings from PostgREST. */
function num(v: unknown): number | null {
  if (v === null || v === undefined || v === '') return null
  const n = typeof v === 'number' ? v : Number(v)
  return Number.isFinite(n) ? n : null
}
const n0 = (v: unknown): number => num(v) ?? 0

// ── Advances ────────────────────────────────────────────────────────────────

/** A transaction with is_advance — the columns the balance reads. */
export interface AdvanceReceipt {
  project_id: string | null
  currency?: string | null
  amount: number | string | null
  amount_rsd: number | string | null
  amount_eur: number | string | null
  status?: string | null
  deleted_at?: string | null
}

/** A revenue invoice that deducts an advance — the columns the balance reads. */
export interface AdvanceDeduction {
  id?: string
  project_id: string | null
  currency?: string | null
  advance_deducted?: number | string | null
  advance_deducted_rsd?: number | string | null
  advance_deducted_eur?: number | string | null
  deleted_at?: string | null
}

export interface AdvanceBalance {
  projectId: string
  /** The one currency every advance and deduction is in, or null when mixed (or none). */
  currency: string | null
  /** In `currency`; null when it is null. */
  received: number | null
  deducted: number | null
  remaining: number | null
  received_rsd: number
  received_eur: number
  deducted_rsd: number
  deducted_eur: number
  remaining_rsd: number
  remaining_eur: number
}

export interface AdvanceDeductionBook {
  advance_deducted: number
  advance_deducted_rsd: number
  advance_deducted_eur: number
}

/**
 * The stored columns for a deduction, at the invoice's STORED rates — a
 * part of the invoice, like an allocation (`partBookAmounts`). Zero is three
 * zeros, with no rate needed. Throws RateUnavailableError when the invoice
 * carries no usable rate.
 */
export function advanceDeductionBook(deducted: number, invoice: RatedRow): AdvanceDeductionBook {
  const own = round2(n0(deducted))
  if (own === 0) return { advance_deducted: 0, advance_deducted_rsd: 0, advance_deducted_eur: 0 }
  const b = partBookAmounts(own, invoice)
  return { advance_deducted: own, advance_deducted_rsd: b.amount_rsd, advance_deducted_eur: b.amount_eur }
}

const isLiveAdvance = (a: AdvanceReceipt) => !a.deleted_at && a.status !== 'draft'
const isLiveDeduction = (d: AdvanceDeduction) => !d.deleted_at && n0(d.advance_deducted) > 0

/**
 * Received, deducted and remaining advance for one project. Draft and deleted
 * receipts and deleted invoices are left out, as in v_project_advances.
 */
export function projectAdvanceBalance(
  projectId: string,
  advances: readonly AdvanceReceipt[],
  deductions: readonly AdvanceDeduction[],
): AdvanceBalance {
  const a = advances.filter(x => x.project_id === projectId && isLiveAdvance(x))
  const d = deductions.filter(x => x.project_id === projectId && isLiveDeduction(x))
  const currencies = new Set([...a, ...d].map(x => (x.currency || 'RSD').toUpperCase()))
  const currency = currencies.size === 1 ? Array.from(currencies)[0] : null

  const sum = <T>(rows: readonly T[], f: (r: T) => unknown) => round2(rows.reduce((s, r) => s + n0(f(r)), 0))
  const received_rsd = sum(a, x => x.amount_rsd)
  const received_eur = sum(a, x => x.amount_eur)
  const deducted_rsd = sum(d, x => x.advance_deducted_rsd)
  const deducted_eur = sum(d, x => x.advance_deducted_eur)
  const received = currency ? sum(a, x => x.amount) : null
  const deducted = currency ? sum(d, x => x.advance_deducted) : null

  return {
    projectId, currency, received, deducted,
    remaining: received !== null && deducted !== null ? round2(received - deducted) : null,
    received_rsd, received_eur, deducted_rsd, deducted_eur,
    remaining_rsd: round2(received_rsd - deducted_rsd),
    remaining_eur: round2(received_eur - deducted_eur),
  }
}

export interface AdvanceDeductionRequest {
  /** The billing being saved. `id` when editing, so its own old deduction is not counted against it. */
  invoice: RatedRow & {
    id?: string
    type: string | null
    project_id: string | null
    amount: number | string | null
  }
  /** As typed, in the invoice's currency. */
  advanceDeducted: number | null | undefined
  /** Every is_advance transaction of the project (more is fine; filtered by project). */
  advances: readonly AdvanceReceipt[]
  /** Every revenue invoice of the project that deducts (this one may be among them). */
  deductions: readonly AdvanceDeduction[]
}

/**
 * Why a deduction cannot be saved, in Serbian, or null.
 *
 * Compared in the document currency when the advances, the other deductions
 * and this billing all share one — exactly, to the para. Otherwise in dinars:
 * the deduction at this invoice's stored rate against the RSD remainder,
 * with the one-dinar slack v_invoice_status allows a bill.
 */
export function validateAdvanceDeduction(req: AdvanceDeductionRequest): string | null {
  const raw = req.advanceDeducted
  if (raw === null || raw === undefined || raw === 0) return null
  if (typeof raw !== 'number' || !Number.isFinite(raw)) return 'Odbitak avansa nije ispravan broj.'
  if (raw < 0) return 'Odbitak avansa ne može biti negativan.'
  const deduction = round2(raw)
  if (deduction === 0) return null

  const inv = req.invoice
  if (inv.type !== 'revenue') return 'Avans se odbija samo na izlaznoj fakturi.'
  if (!inv.project_id) return 'Avans se odbija samo na fakturi koja je na jednom projektu.'
  const amount = n0(inv.amount)
  if (deduction > round2(amount)) return 'Odbitak avansa ne može biti veći od iznosa fakture.'

  const others = req.deductions.filter(d => !inv.id || d.id !== inv.id)
  const balance = projectAdvanceBalance(inv.project_id, req.advances, others)
  const hasAdvance = req.advances.some(a => a.project_id === inv.project_id && isLiveAdvance(a))
  if (!hasAdvance) return 'Na ovom projektu nije primljen avans.'

  const invCurrency = (inv.currency || 'RSD').toUpperCase()
  if (balance.currency === invCurrency && balance.remaining !== null) {
    if (deduction > balance.remaining) {
      return `Odbitak avansa (${fmtMoney(deduction, invCurrency)}) je veći od preostalog avansa (${fmtMoney(Math.max(0, balance.remaining), invCurrency)}).`
    }
    return null
  }

  const { amount_rsd } = partBookAmounts(deduction, inv)
  if (amount_rsd > round2(balance.remaining_rsd + PAID_WITHIN_RSD)) {
    return `Odbitak avansa (${fmtMoney(amount_rsd, 'RSD')}) je veći od preostalog avansa (${fmtMoney(Math.max(0, balance.remaining_rsd), 'RSD')}).`
  }
  return null
}

// ── Per project ─────────────────────────────────────────────────────────────

/** The part of a v_invoice_status row the revenue figures read. */
export interface RevenueInvoiceRow {
  id: string
  type: string | null
  project_id: string | null
  partner_name?: string | null
  invoice_number?: string | null
  invoice_date: string
  due_date?: string | null
  currency?: string | null
  amount: number | string | null
  amount_rsd: number | string | null
  amount_eur: number | string | null
  paid_amount_rsd?: number | string | null
  paid_amount_eur?: number | string | null
  remaining_rsd?: number | string | null
  remaining_eur?: number | string | null
  advance_deducted?: number | string | null
  advance_deducted_rsd?: number | string | null
  advance_deducted_eur?: number | string | null
  calculated_status?: string | null
  deleted_at?: string | null
}

/** A revenue_plan row, as far as the summary reads it. */
export interface PlanAmountRow {
  project_id: string
  /** First of the month, `YYYY-MM-01`. */
  month: string
  amount_rsd: number | string | null
  amount_eur: number | string | null
}

export interface RevenueSummary {
  projectId: string
  currency: DisplayCurrency
  /** The contract in the display currency (its own book figure), or null with none. */
  contractValue: number | null
  /** Revenue invoices issued on the project: the work billed so far. */
  billedToDate: number
  /** billed / contract × 100, one decimal; null without a contract value. */
  billedPct: number | null
  advanceReceived: number
  advanceDeducted: number
  advanceRemaining: number
  /** Cash received against the billings (allocations), not counting the advance. */
  collected: number
  /** What the investor still owes on the billings: amount − advance − collected. */
  outstanding: number
  /** contract − billed, floored at 0; null without a contract value. */
  unbilled: number | null
  /** Planned billings from `opts.fromMonth` on. */
  planned: number
  /** Rows with no figure in the display currency, counted as 0. */
  unconverted: number
}

/**
 * The project's revenue position in `currency`.
 *
 * `invoices` are v_invoice_status rows (any project; filtered here to this
 * one's revenue invoices). A split revenue invoice has no project of its own
 * and is not counted here — its lines reach the P&L through v_pl_entries.
 * billed = advance deducted on billings + collected + outstanding, to the
 * one-dinar slack a paid bill may carry.
 *
 * billedPct is worked in the contract's own currency when every billing is
 * in it, so a euro contract billed in euros reads 50 % at half, whatever the
 * rate did in between; otherwise from the display-currency book figures.
 */
export function projectRevenueSummary(
  project: Pick<Project, 'id' | 'contract_value' | 'contract_currency' | 'contract_value_rsd' | 'contract_value_eur'>,
  invoices: readonly RevenueInvoiceRow[],
  advances: readonly AdvanceReceipt[],
  currency: DisplayCurrency,
  opts: { plan?: readonly PlanAmountRow[]; fromMonth?: string } = {},
): RevenueSummary {
  const rows = invoices.filter(i => i.project_id === project.id && i.type === 'revenue' && !i.deleted_at)
  let unconverted = 0
  const pick = (row: object, base = 'amount'): number => {
    const v = pickAmount(row, currency, base)
    if (v === null) { unconverted++; return 0 }
    return v
  }

  const billedToDate = round2(rows.reduce((s, r) => s + pick(r), 0))
  const collected = round2(rows.reduce((s, r) => s + pick(r, 'paid_amount'), 0))
  const outstanding = round2(rows.reduce((s, r) => s + pick(r, 'remaining'), 0))

  const balance = projectAdvanceBalance(project.id, advances, rows)
  const advanceReceived = currency === 'RSD' ? balance.received_rsd : balance.received_eur
  const advanceDeducted = currency === 'RSD' ? balance.deducted_rsd : balance.deducted_eur
  const advanceRemaining = currency === 'RSD' ? balance.remaining_rsd : balance.remaining_eur

  const contractValue = num(currency === 'RSD' ? project.contract_value_rsd : project.contract_value_eur)
  let billedPct: number | null = null
  const contractOwn = num(project.contract_value)
  const contractCurrency = project.contract_currency
  if (contractOwn && contractCurrency && rows.every(r => (r.currency || 'RSD').toUpperCase() === contractCurrency)) {
    billedPct = Math.round((rows.reduce((s, r) => s + n0(r.amount), 0) / contractOwn) * 1000) / 10
  } else if (contractValue) {
    billedPct = Math.round((billedToDate / contractValue) * 1000) / 10
  }

  const from = opts.fromMonth ? monthOf(opts.fromMonth) : ''
  const planned = round2((opts.plan || [])
    .filter(p => p.project_id === project.id && monthOf(p.month) >= from)
    .reduce((s, p) => s + pick(p), 0))

  return {
    projectId: project.id, currency,
    contractValue,
    billedToDate, billedPct,
    advanceReceived, advanceDeducted, advanceRemaining,
    collected, outstanding,
    unbilled: contractValue === null ? null : round2(Math.max(0, contractValue - billedToDate)),
    planned,
    unconverted,
  }
}

/** `YYYY-MM` of a date or month string. */
function monthOf(d: string): string {
  return (d || '').slice(0, 7)
}

// ── Receivables aging ───────────────────────────────────────────────────────

export type AgingBucket = 'notDue' | 'd0_30' | 'd31_60' | 'd61_90' | 'd90plus'

export const AGING_BUCKETS: readonly AgingBucket[] = ['notDue', 'd0_30', 'd31_60', 'd61_90', 'd90plus']

export const AGING_LABEL: Readonly<Record<AgingBucket, string>> = {
  notDue: 'Nije dospelo',
  d0_30: '0–30 dana',
  d31_60: '31–60 dana',
  d61_90: '61–90 dana',
  d90plus: 'Preko 90 dana',
}

export interface AgingItem {
  id: string
  partnerName: string
  projectId: string | null
  invoiceNumber: string | null
  /** The due date used — the invoice date when the bill has none. */
  due: string
  /** Negative while not yet due. */
  daysPastDue: number
  bucket: AgingBucket
  /** Remaining, in the display currency. */
  amount: number
}

export interface Aging {
  buckets: Record<AgingBucket, { total: number; count: number }>
  total: number
  /** Oldest first. */
  items: AgingItem[]
  unconverted: number
}

/** Whole days from `a` to `b` (both `YYYY-MM-DD`), b − a. */
export function daysBetween(a: string, b: string): number {
  const t = (s: string) => {
    const [y, m, d] = s.slice(0, 10).split('-').map(Number)
    return Date.UTC(y, m - 1, d)
  }
  return Math.round((t(b) - t(a)) / 86400000)
}

export function agingBucket(daysPastDue: number): AgingBucket {
  if (daysPastDue < 0) return 'notDue'
  if (daysPastDue <= 30) return 'd0_30'
  if (daysPastDue <= 60) return 'd31_60'
  if (daysPastDue <= 90) return 'd61_90'
  return 'd90plus'
}

/**
 * What investors and tenants owe, by how late it is, from v_invoice_status
 * rows. Only revenue invoices still unpaid or partial with something left;
 * the remainder already nets out the advance deducted. Due today is 0 days
 * past due (the 0–30 bucket); a bill with no due date is due on its date.
 */
export function receivablesAging(
  rows: readonly RevenueInvoiceRow[], today: string, currency: DisplayCurrency,
): Aging {
  const buckets = Object.fromEntries(AGING_BUCKETS.map(b => [b, { total: 0, count: 0 }])) as Aging['buckets']
  const items: AgingItem[] = []
  let unconverted = 0
  for (const r of rows) {
    if (r.type !== 'revenue' || r.deleted_at) continue
    if (r.calculated_status !== 'unpaid' && r.calculated_status !== 'partial') continue
    const remaining = pickAmount(r, currency, 'remaining')
    if (remaining === null) { unconverted++; continue }
    if (!(remaining > 0)) continue
    const due = (r.due_date || r.invoice_date || '').slice(0, 10)
    if (!due) continue
    const daysPastDue = daysBetween(due, today)
    const bucket = agingBucket(daysPastDue)
    buckets[bucket].total = round2(buckets[bucket].total + remaining)
    buckets[bucket].count++
    items.push({
      id: r.id, partnerName: r.partner_name || '—', projectId: r.project_id,
      invoiceNumber: r.invoice_number ?? null, due, daysPastDue, bucket, amount: remaining,
    })
  }
  items.sort((a, b) => b.daysPastDue - a.daysPastDue || b.amount - a.amount)
  return {
    buckets,
    total: round2(items.reduce((s, i) => s + i.amount, 0)),
    items,
    unconverted,
  }
}
