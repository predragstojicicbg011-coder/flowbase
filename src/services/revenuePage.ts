// ─── The Prihodi page: the arithmetic and the rows it writes ────────────────
//
// Everything the page (src/pages/Revenue.tsx and src/components/revenue/*)
// decides that is not layout: the period totals, the per-project table with
// overhead and totals, the invoice filters and status labels, the plan grid's
// cells and what a typed cell means, the lease form, and the rent invoice row.
// Pure; the page does the reading and the writing.
//
// The figures themselves come from ./revenue.ts (projectRevenueSummary,
// receivablesAging) and ./revenuePlan.ts (rentForecast, rentInvoicesDue,
// plannedRevenueByMonth, planBookFigures). This module only arranges them.

import { round2, type BookAmounts } from './bookAmounts'
import {
  projectRevenueSummary, type AdvanceReceipt, type RevenueInvoiceRow, type RevenueSummary,
} from './revenue'
import {
  firstOfMonth, monthKey, type LeaseCurrency, type RentalLease, type RentForecastLine,
  type RentInvoiceProposal, type RevenuePlanRow,
} from './revenuePlan'
import {
  OVERHEAD_LABEL, parseContractValue, projectLabel, type Project,
} from './projects'
import { pickAmount, type DisplayCurrency } from '../contexts/DisplayCurrencyContext'

/** A v_invoice_status row as the page reads it. */
export interface RevenueListRow extends RevenueInvoiceRow {
  partner_id?: string | null
  project_name?: string | null
  revenue_stream?: string | null
  amount_due?: number | string | null
  amount_due_rsd?: number | string | null
  amount_due_eur?: number | string | null
  paid_amount?: number | string | null
  lease_id?: string | null
  service_month?: string | null
  company_id?: string | null
}

const pad = (n: number) => String(n).padStart(2, '0')

// ── Months ──────────────────────────────────────────────────────────────────

/** `n` months as `YYYY-MM`, starting with the month of `today`. */
export function nextMonths(today: string, n: number): string[] {
  const [y, m] = today.slice(0, 7).split('-').map(Number)
  const out: string[] = []
  for (let i = 0; i < n; i++) {
    const t = new Date(Date.UTC(y, m - 1 + i, 1))
    out.push(`${t.getUTCFullYear()}-${pad(t.getUTCMonth() + 1)}`)
  }
  return out
}

/** The months from `today`'s through December of the same year. */
export function monthsToYearEnd(today: string): string[] {
  const m = Number(today.slice(5, 7))
  return nextMonths(today, 13 - m)
}

const MONTHS_SR = ['jan', 'feb', 'mar', 'apr', 'maj', 'jun', 'jul', 'avg', 'sep', 'okt', 'nov', 'dec']
const MONTHS_SR_LONG = ['januar', 'februar', 'mart', 'april', 'maj', 'jun', 'jul', 'avgust', 'septembar', 'oktobar', 'novembar', 'decembar']

/** `2026-10` → `okt 2026`. */
export function monthLabel(month: string): string {
  const [y, m] = monthKey(month).split('-').map(Number)
  return `${MONTHS_SR[m - 1] ?? '?'} ${y}`
}

/** `2026-10` → `oktobar 2026`. */
export function monthLabelLong(month: string): string {
  const [y, m] = monthKey(month).split('-').map(Number)
  return `${MONTHS_SR_LONG[m - 1] ?? '?'} ${y}`
}

/** `2026-10-08` → `08.10.2026.`; empty is a dash. */
export function srDateShort(d: string | null | undefined): string {
  const m = /^(\d{4})-(\d{2})-(\d{2})/.exec(d || '')
  return m ? `${m[3]}.${m[2]}.${m[1]}.` : '—'
}

// ── Status ──────────────────────────────────────────────────────────────────

export type RevenueStatus = 'paid' | 'partial' | 'unpaid'

export const STATUS_LABEL: Readonly<Record<RevenueStatus, string>> = {
  paid: 'Plaćeno',
  partial: 'Delimično',
  unpaid: 'Neplaćeno',
}

/** v_invoice_status.calculated_status as one of the three; anything else is unpaid. */
export function revenueStatus(s: string | null | undefined): RevenueStatus {
  return s === 'paid' || s === 'partial' ? s : 'unpaid'
}

// ── Period totals (summary cards) ───────────────────────────────────────────

export interface RevenueTotals {
  /** Revenue invoices dated in the period: the work billed. */
  billed: number
  /** Cash received against those invoices (allocations; the advance not counted). */
  collected: number
  /** What is still owed today on every revenue invoice, whatever its date. */
  outstanding: number
  /** Advance received and not yet deducted, every project. */
  advancesRemaining: number
  unconverted: number
}

const live = (r: RevenueListRow) => r.type === 'revenue' && !r.deleted_at
const inPeriod = (d: string, from: string, to: string) => (!from || d >= from) && (!to || d <= to)

/**
 * The cards' figures in `currency`. `advancesRemaining` is summed per project
 * from projectRevenueSummary, so it is the same number the table shows.
 */
export function revenueTotals(
  rows: readonly RevenueListRow[],
  advanceRemaining: readonly number[],
  from: string, to: string, currency: DisplayCurrency,
): RevenueTotals {
  let unconverted = 0
  const pick = (row: object, base = 'amount') => {
    const v = pickAmount(row, currency, base)
    if (v === null) { unconverted++; return 0 }
    return v
  }
  let billed = 0
  let collected = 0
  let outstanding = 0
  for (const r of rows) {
    if (!live(r)) continue
    if (inPeriod((r.invoice_date || '').slice(0, 10), from, to)) {
      billed += pick(r)
      collected += pick(r, 'paid_amount')
    }
    outstanding += pick(r, 'remaining')
  }
  return {
    billed: round2(billed),
    collected: round2(collected),
    outstanding: round2(outstanding),
    advancesRemaining: round2(advanceRemaining.reduce((s, n) => s + n, 0)),
    unconverted,
  }
}

// ── Per project ─────────────────────────────────────────────────────────────

export interface ProjectRevenueRow {
  /** Null for overhead and for the totals row. */
  projectId: string | null
  label: string
  kind: 'project' | 'overhead' | 'total'
  contractValue: number | null
  billed: number
  billedPct: number | null
  advanceReceived: number
  advanceDeducted: number
  advanceRemaining: number
  collected: number
  outstanding: number
  unconverted: number
}

function fromSummary(p: Project, s: RevenueSummary): ProjectRevenueRow {
  return {
    projectId: p.id, label: projectLabel(p), kind: 'project',
    contractValue: s.contractValue, billed: s.billedToDate, billedPct: s.billedPct,
    advanceReceived: s.advanceReceived, advanceDeducted: s.advanceDeducted, advanceRemaining: s.advanceRemaining,
    collected: s.collected, outstanding: s.outstanding, unconverted: s.unconverted,
  }
}

/**
 * One row per project (in the order given) — a closed project only when it
 * has billings or advances — then overhead (revenue invoices with no project:
 * split ones and company-level income) when there is any, then the total.
 * A revenue invoice on a project not in the list (another company, deleted
 * from under the screen) gets its own row from the view's project_name.
 */
export function projectRevenueRows(
  projects: readonly Project[],
  rows: readonly RevenueListRow[],
  advances: readonly AdvanceReceipt[],
  currency: DisplayCurrency,
): { projects: ProjectRevenueRow[]; overhead: ProjectRevenueRow | null; total: ProjectRevenueRow } {
  const live_ = rows.filter(live)
  const out: ProjectRevenueRow[] = []
  const seen = new Set<string>()
  const consider = (p: Project) => {
    seen.add(p.id)
    const s = projectRevenueSummary(p, live_, advances, currency)
    const any = s.billedToDate !== 0 || s.advanceReceived !== 0 || s.advanceDeducted !== 0
    if (p.active || any) out.push(fromSummary(p, s))
  }
  projects.forEach(consider)
  // Projects named by rows but missing from the list.
  const strays = new Map<string, string>()
  for (const r of live_) if (r.project_id && !seen.has(r.project_id)) strays.set(r.project_id, r.project_name || 'Nepoznat projekat')
  for (const a of advances) if (a.project_id && !seen.has(a.project_id) && !strays.has(a.project_id)) strays.set(a.project_id, 'Nepoznat projekat')
  strays.forEach((name, id) => {
    const p: Project = {
      id, company_id: '', name, code: null, kind: 'construction', investor_partner_id: null,
      contract_value: null, contract_currency: null, contract_date: null, contract_value_rsd: null,
      contract_value_eur: null, payment_days: 45, active: false, note: null,
    }
    const s = projectRevenueSummary(p, live_, advances, currency)
    out.push({ ...fromSummary(p, s), label: name })
  })

  // Overhead: revenue invoices on no project.
  const none = live_.filter(r => !r.project_id)
  let overhead: ProjectRevenueRow | null = null
  if (none.length) {
    let unconverted = 0
    const pick = (row: object, base = 'amount') => {
      const v = pickAmount(row, currency, base)
      if (v === null) { unconverted++; return 0 }
      return v
    }
    overhead = {
      projectId: null, label: OVERHEAD_LABEL, kind: 'overhead', contractValue: null,
      billed: round2(none.reduce((s, r) => s + pick(r), 0)), billedPct: null,
      advanceReceived: 0, advanceDeducted: 0, advanceRemaining: 0,
      collected: round2(none.reduce((s, r) => s + pick(r, 'paid_amount'), 0)),
      outstanding: round2(none.reduce((s, r) => s + pick(r, 'remaining'), 0)),
      unconverted,
    }
  }

  const all = overhead ? [...out, overhead] : out
  const sum = (f: (r: ProjectRevenueRow) => number) => round2(all.reduce((s, r) => s + f(r), 0))
  const contracts = out.filter(r => r.contractValue !== null)
  const contractTotal = contracts.length ? sum(r => r.contractValue ?? 0) : null
  const billed = sum(r => r.billed)
  // The total's % is over the projects that HAVE a contract, so a site with
  // no contract yet does not push it past 100.
  const billedOnContracts = round2(contracts.reduce((s, r) => s + r.billed, 0))
  const total: ProjectRevenueRow = {
    projectId: null, label: 'Ukupno', kind: 'total',
    contractValue: contractTotal,
    billed,
    billedPct: contractTotal ? Math.round((billedOnContracts / contractTotal) * 1000) / 10 : null,
    advanceReceived: sum(r => r.advanceReceived),
    advanceDeducted: sum(r => r.advanceDeducted),
    advanceRemaining: sum(r => r.advanceRemaining),
    collected: sum(r => r.collected),
    outstanding: sum(r => r.outstanding),
    unconverted: all.reduce((s, r) => s + r.unconverted, 0),
  }
  return { projects: out, overhead, total }
}

// ── The invoice list ────────────────────────────────────────────────────────

export interface InvoiceFilter {
  /** '' all; OVERHEAD_FILTER for no project; otherwise a project id. */
  projectId: string
  /** '' all; otherwise a revenue_stream value. */
  stream: string
  /** '' all; otherwise a RevenueStatus. */
  status: '' | RevenueStatus
  from: string
  to: string
  search?: string
}

/** The project filter's value for "no project". */
export const OVERHEAD_FILTER = '__overhead__'

/** Revenue invoices that pass the filter, newest first. */
export function filterRevenueInvoices(rows: readonly RevenueListRow[], f: InvoiceFilter): RevenueListRow[] {
  const q = (f.search || '').trim().toLowerCase()
  return rows
    .filter(live)
    .filter(r => !f.projectId || (f.projectId === OVERHEAD_FILTER ? !r.project_id : r.project_id === f.projectId))
    .filter(r => !f.stream || (r.revenue_stream || '') === f.stream)
    .filter(r => !f.status || revenueStatus(r.calculated_status) === f.status)
    .filter(r => inPeriod((r.invoice_date || '').slice(0, 10), f.from, f.to))
    .filter(r => !q
      || (r.invoice_number || '').toLowerCase().includes(q)
      || (r.partner_name || '').toLowerCase().includes(q))
    .sort((a, b) => (b.invoice_date || '').localeCompare(a.invoice_date || '') || (b.invoice_number || '').localeCompare(a.invoice_number || ''))
}

// ── The plan grid ───────────────────────────────────────────────────────────

/** What a plan cell shows. */
export interface PlanCell {
  /** The manual plan row for the project and month, if any. */
  plan: RevenuePlanRow | null
  /** The rent forecast for the month (lease currency totals), shown when there is no plan row. */
  rent: { amount: number; currency: LeaseCurrency }[]
}

/** project → month (`YYYY-MM`) → cell. */
export function planGrid(
  projectIds: readonly string[], months: readonly string[],
  plan: readonly RevenuePlanRow[], rent: readonly RentForecastLine[],
): Record<string, Record<string, PlanCell>> {
  const out: Record<string, Record<string, PlanCell>> = {}
  for (const id of projectIds) {
    out[id] = {}
    for (const m of months) out[id][monthKey(m)] = { plan: null, rent: [] }
  }
  for (const row of plan) {
    const c = out[row.project_id]?.[monthKey(row.month)]
    if (c) c.plan = row
  }
  for (const r of rent) {
    const c = out[r.project_id]?.[monthKey(r.month)]
    if (!c) continue
    const same = c.rent.find(x => x.currency === r.currency)
    if (same) same.amount = round2(same.amount + r.amount)
    else c.rent.push({ amount: r.amount, currency: r.currency })
  }
  return out
}

/**
 * The currency a project's plan is typed in: the currency of its plan rows
 * when they agree, else its contract's, else RSD.
 */
export function defaultPlanCurrency(
  project: Pick<Project, 'id' | 'contract_currency'>, plan: readonly RevenuePlanRow[],
): LeaseCurrency {
  const own = new Set(plan.filter(p => p.project_id === project.id).map(p => p.currency))
  if (own.size === 1) return Array.from(own)[0] === 'EUR' ? 'EUR' : 'RSD'
  return project.contract_currency === 'EUR' ? 'EUR' : 'RSD'
}

export type PlanCellAction =
  | { kind: 'none' }
  | { kind: 'delete'; id: string }
  | { kind: 'upsert'; amount: number; currency: LeaseCurrency }
  | { kind: 'error'; message: string }

/**
 * What typing `input` into a cell means. Empty clears the cell (a delete when
 * there is a row); the same amount in the same currency is nothing to do; a
 * number is an upsert in `currency`. Negative or junk is an error in Serbian.
 */
export function planCellAction(
  existing: Pick<RevenuePlanRow, 'id' | 'amount' | 'currency'> | null,
  input: string, currency: LeaseCurrency,
): PlanCellAction {
  const v = parseContractValue(input)
  if (v === null) {
    return existing?.id ? { kind: 'delete', id: existing.id } : { kind: 'none' }
  }
  if (Number.isNaN(v)) return { kind: 'error', message: `„${input.trim()}" nije ispravan iznos.` }
  if (v < 0) return { kind: 'error', message: 'Planirani iznos ne može biti negativan.' }
  const amount = round2(v)
  if (existing && round2(Number(existing.amount)) === amount && existing.currency === currency) return { kind: 'none' }
  return { kind: 'upsert', amount, currency }
}

/** The revenue_plan row to upsert on (project_id, month). */
export function planUpsertRow(
  companyId: string, projectId: string, month: string, amount: number, currency: LeaseCurrency,
  book: { eur_rate: number; rate_date: string; amount_rsd: number; amount_eur: number },
  nowIso: string,
) {
  return {
    company_id: companyId, project_id: projectId, month: firstOfMonth(month),
    amount: round2(amount), currency,
    eur_rate: book.eur_rate, rate_date: book.rate_date,
    amount_rsd: book.amount_rsd, amount_eur: book.amount_eur,
    updated_at: nowIso,
  }
}

/** A number for an input: `1234.5` → `1234,50`; plain, no thousands dots, so it parses back. */
export function amountToInput(v: number | string | null | undefined): string {
  if (v === null || v === undefined || v === '') return ''
  const n = Number(v)
  if (!Number.isFinite(n)) return ''
  return n.toFixed(2).replace('.', ',').replace(/,00$/, '')
}

// ── Leases ──────────────────────────────────────────────────────────────────

export interface LeaseDraft {
  id?: string
  project_id: string
  tenant_partner_id: string
  monthly_rent: string
  currency: LeaseCurrency
  start_date: string
  end_date: string
  invoice_day: string
  payment_days: string
  active: boolean
  note: string
}

export function emptyLeaseDraft(projectId: string, today: string): LeaseDraft {
  return {
    project_id: projectId, tenant_partner_id: '', monthly_rent: '', currency: 'RSD',
    start_date: today, end_date: '', invoice_day: '1', payment_days: '15', active: true, note: '',
  }
}

export function leaseDraftFromLease(l: RentalLease): LeaseDraft {
  return {
    id: l.id, project_id: l.project_id, tenant_partner_id: l.tenant_partner_id,
    monthly_rent: amountToInput(l.monthly_rent), currency: l.currency === 'EUR' ? 'EUR' : 'RSD',
    start_date: (l.start_date || '').slice(0, 10), end_date: (l.end_date || '').slice(0, 10),
    invoice_day: String(l.invoice_day ?? 1), payment_days: String(l.payment_days ?? 15),
    active: l.active !== false, note: l.note || '',
  }
}

const isDate = (s: string) => /^\d{4}-\d{2}-\d{2}$/.test(s)

/** Why a lease cannot be saved, in Serbian, or null. Mirrors the table's CHECKs. */
export function validateLease(d: LeaseDraft): string | null {
  if (!d.project_id) return 'Izaberite objekat u zakupu.'
  if (!d.tenant_partner_id) return 'Izaberite zakupca.'
  const rent = parseContractValue(d.monthly_rent)
  if (rent === null) return 'Mesečna zakupnina je obavezna.'
  if (Number.isNaN(rent)) return 'Mesečna zakupnina nije ispravan broj.'
  if (!(rent > 0)) return 'Mesečna zakupnina mora biti veća od nule.'
  if (d.currency !== 'RSD' && d.currency !== 'EUR') return 'Izaberite valutu.'
  if (!isDate(d.start_date)) return 'Datum početka zakupa je obavezan.'
  if (d.end_date && !isDate(d.end_date)) return 'Datum završetka nije ispravan.'
  if (d.end_date && d.end_date < d.start_date) return 'Zakup ne može da se završi pre nego što počne.'
  const day = d.invoice_day.trim()
  if (!/^\d+$/.test(day) || Number(day) < 1 || Number(day) > 28) return 'Dan fakturisanja mora biti od 1 do 28.'
  const pd = d.payment_days.trim()
  if (!/^\d+$/.test(pd) || Number(pd) > 365) return 'Rok plaćanja mora biti ceo broj dana, od 0 do 365.'
  return null
}

/** The rental_leases row. Call validateLease first. */
export function leaseRow(d: LeaseDraft, companyId: string, nowIso: string) {
  return {
    company_id: companyId,
    project_id: d.project_id,
    tenant_partner_id: d.tenant_partner_id,
    monthly_rent: round2(parseContractValue(d.monthly_rent) as number),
    currency: d.currency,
    start_date: d.start_date,
    end_date: d.end_date || null,
    invoice_day: Number(d.invoice_day.trim()),
    payment_days: Number(d.payment_days.trim()),
    active: d.active,
    note: d.note.trim() || null,
    updated_at: nowIso,
  }
}

/** Why a lease cannot end on `date`, or null. */
export function validateLeaseEnd(lease: Pick<RentalLease, 'start_date'>, date: string): string | null {
  if (!isDate(date)) return 'Unesite datum završetka zakupa.'
  if (date < (lease.start_date || '').slice(0, 10)) return 'Zakup ne može da se završi pre nego što počne.'
  return null
}

// ── Rent invoices ───────────────────────────────────────────────────────────
//
// Invoice numbers are typed by hand in InvoiceDialog and may be left empty
// (invoices.invoice_number is nullable, with no sequence). A proposed rent
// invoice therefore gets a PROVISIONAL number, `ZAK-<lease>-<YYYY-MM>`, that
// says which lease and month it bills; the real number from the invoicing
// software is typed over it in InvoiceDialog.

/** `ZAK-1A2B3C4D-2026-10`: the first eight characters of the lease id, upper case. */
export function provisionalRentNumber(leaseId: string, month: string): string {
  const short = (leaseId || '').replace(/-/g, '').slice(0, 8).toUpperCase()
  return `ZAK-${short}-${monthKey(month)}`
}

/** The invoices row for a proposal, with its book figures at the invoice date. */
export function rentInvoiceRow(
  p: RentInvoiceProposal, book: BookAmounts, companyId: string,
) {
  return {
    company_id: companyId,
    partner_id: p.partner_id,
    project_id: p.project_id,
    lease_id: p.lease_id,
    service_month: p.service_month,
    invoice_number: provisionalRentNumber(p.lease_id, p.service_month),
    invoice_date: p.invoice_date,
    due_date: p.due_date,
    type: 'revenue' as const,
    revenue_stream: p.revenue_stream,
    currency: p.currency,
    amount: p.amount,
    exchange_rate: book.exchange_rate,
    eur_rate: book.eur_rate,
    amount_rsd: book.amount_rsd,
    amount_eur: book.amount_eur,
    pl_impact: true,
    status: 'unpaid',
    dept_split_type: 'none',
    note: `Zakup za ${monthLabelLong(p.service_month)}`,
  }
}

/** Whether a refused insert is the one-rent-invoice-per-lease-and-month index. */
export function isDuplicateRentError(err: { code?: string | null; message?: string | null } | null | undefined): boolean {
  if (!err) return false
  if (err.code === '23505') return true
  return /invoices_lease_month_key|duplicate key/i.test(err.message || '')
}

/** `1 faktura`, `3 fakture`, `5 faktura`, `21 faktura`… — Serbian plural. */
export function invoiceCount(n: number): string {
  const last = n % 10
  const lastTwo = n % 100
  const word = last >= 2 && last <= 4 && !(lastTwo >= 12 && lastTwo <= 14) ? 'fakture' : 'faktura'
  return `${n} ${word}`
}
