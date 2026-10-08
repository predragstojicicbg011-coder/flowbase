// ─── Projects: construction sites and rental buildings ──────────────────────
//
// MCFlow's replacement for Mintflow's Aimfox / Social Growth allocation.
// Schema: supabase/migrations/20261008170000_projects.sql.
//
// ── THE CONTRACT ────────────────────────────────────────────────────────────
//
//   A project is a construction site (kind 'construction', "gradilište") or a
//   rental building (kind 'rental', "objekat u zakupu").
//
//   `project_id` sits on transactions, invoices, pl_splits,
//   budget_adjustments (and the unused budget_entries), and revenue_plan and
//   rental_leases point at a project (20261008180000_accrual_revenue.sql). It is ONE project, or
//   null. Null means company overhead — "Opšti troškovi" (OVERHEAD_LABEL).
//   A document shared by several projects is split with pl_splits, one line
//   per project; the split line's project is what counts, not the parent's.
//
//   There are no allocation keys. A project's profitability is its revenue
//   less its own direct costs (`projectProfitability` below); overhead is
//   reported on its own row and is never spread over projects.
//
//   Payroll reaches projects by hours: `payroll_timesheet_projects` holds an
//   employee's hours per project per month (month = first of the month, as on
//   payroll_timesheets). Hours on no project are overhead.
//
//   v_pl_entries exposes `project_id` and `project_name` on every leg, and
//   `tx_type` ('revenue' | 'expense') tells income from cost.
//
//   In a form, "no project" is the empty string (SearchableSelect's empty
//   value); in the database it is null. `projectIdFromInput` and
//   `projectIdToInput` convert, and nothing else should.
//
// The contract value is stored as written (contract_value + contract_currency,
// RSD or EUR) and booked like every other money row: contract_value_rsd and
// contract_value_eur at the NBS rate on contract_date — the contract's date if
// the user gives one, otherwise the day the project is entered. See
// ./bookAmounts.ts. `contractBookFigures` does the conversion.

import { fetchAllPages } from '../utils/fetchAllPages'
import { pickAmount, type DisplayCurrency } from '../contexts/DisplayCurrencyContext'
import { round2, toBookAmounts } from './bookAmounts'

export type ProjectKind = 'construction' | 'rental'
export const PROJECT_KINDS: readonly ProjectKind[] = ['construction', 'rental']

export const PROJECT_KIND_LABEL: Readonly<Record<ProjectKind, string>> = {
  construction: 'Gradilište',
  rental: 'Objekat u zakupu',
}

export type ContractCurrency = 'RSD' | 'EUR'
export const CONTRACT_CURRENCIES: readonly ContractCurrency[] = ['RSD', 'EUR']

/** What a row with no project is called in every report. */
export const OVERHEAD_LABEL = 'Opšti troškovi'
/** The same, in a picker, where "no project" must read as a deliberate choice. */
export const OVERHEAD_OPTION_LABEL = 'Opšti troškovi (bez projekta)'

export interface Project {
  id: string
  company_id: string
  name: string
  code: string | null
  kind: ProjectKind
  investor_partner_id: string | null
  contract_value: number | null
  contract_currency: ContractCurrency | null
  contract_date: string | null
  contract_value_rsd: number | null
  contract_value_eur: number | null
  /**
   * The investor's payment term in days (default 45). Planned billings reach
   * the cash forecast this many days after their month — see revenuePlan.ts.
   */
  payment_days: number
  active: boolean
  note: string | null
  created_at?: string
  updated_at?: string
}

// ── Reading ─────────────────────────────────────────────────────────────────

/**
 * Every project, ordered by name (and id, so paging is stable). Pass a
 * company to narrow; `activeOnly` for pickers. Throws on a failed read.
 */
export async function fetchProjects(
  client: any, companyId?: string | null, opts: { activeOnly?: boolean } = {},
): Promise<Project[]> {
  const rows = await fetchAllPages<Project>((from, to) => {
    let q = client.from('projects').select('*')
    if (companyId) q = q.eq('company_id', companyId)
    if (opts.activeOnly) q = q.eq('active', true)
    return q.order('name').order('id').range(from, to)
  }).catch((e: any) => { throw new Error(`Projekti nisu učitani: ${e?.message || e}`) })
  return rows.map(normaliseProject)
}

/** Numeric columns can arrive as strings from PostgREST. */
function num(v: unknown): number | null {
  if (v === null || v === undefined || v === '') return null
  const n = typeof v === 'number' ? v : Number(v)
  return Number.isFinite(n) ? n : null
}

export function normaliseProject(r: any): Project {
  return {
    ...r,
    code: r.code ?? null,
    kind: r.kind === 'rental' ? 'rental' : 'construction',
    investor_partner_id: r.investor_partner_id ?? null,
    contract_value: num(r.contract_value),
    contract_currency: r.contract_currency === 'RSD' || r.contract_currency === 'EUR' ? r.contract_currency : null,
    contract_date: r.contract_date ?? null,
    contract_value_rsd: num(r.contract_value_rsd),
    contract_value_eur: num(r.contract_value_eur),
    payment_days: normalisePaymentDays(r.payment_days),
    active: r.active !== false,
    note: r.note ?? null,
  }
}

/** The default payment term, as the column default says. */
export const DEFAULT_PAYMENT_DAYS = 45

/** A stored or typed payment term; anything unusable is the default. */
export function normalisePaymentDays(v: unknown): number {
  const n = num(v)
  return n !== null && Number.isInteger(n) && n >= 0 && n <= 365 ? n : DEFAULT_PAYMENT_DAYS
}

// ── Labels ──────────────────────────────────────────────────────────────────

/**
 * How a project is named everywhere: "CODE · Name", or just the name.
 * No project at all is overhead.
 */
export function projectLabel(p: Pick<Project, 'name'> & { code?: string | null } | null | undefined): string {
  if (!p) return OVERHEAD_LABEL
  const code = (p.code || '').trim()
  return code ? `${code} · ${p.name}` : p.name
}

/**
 * The label for an id. Null/empty is overhead; an id not in the list (a
 * project in another company, or deleted from under a stale screen) is shown
 * as `fallback` when given — v_pl_entries carries `project_name` for this —
 * and otherwise as "Nepoznat projekat", never silently as overhead.
 */
export function projectLabelById(
  projects: readonly Project[], id: string | null | undefined, fallback?: string | null,
): string {
  if (!id) return OVERHEAD_LABEL
  const p = projects.find(x => x.id === id)
  if (p) return projectLabel(p)
  return (fallback || '').trim() || 'Nepoznat projekat'
}

/** Form value → column value. '' (and whitespace) is overhead, stored as null. */
export function projectIdFromInput(v: string | null | undefined): string | null {
  const t = (v ?? '').trim()
  return t ? t : null
}

/** Column value → form value. */
export function projectIdToInput(v: string | null | undefined): string {
  return v ?? ''
}

// ── Editing ─────────────────────────────────────────────────────────────────

export interface ProjectDraft {
  id?: string
  name: string
  code: string
  kind: ProjectKind
  investor_partner_id: string
  /** As typed. Empty means no contract value. */
  contract_value: string
  contract_currency: ContractCurrency
  /** yyyy-mm-dd; empty means "today" at save time. */
  contract_date: string
  /** As typed; digits only. Empty means the default (45). */
  payment_days: string
  active: boolean
  note: string
}

export function emptyDraft(): ProjectDraft {
  return {
    name: '', code: '', kind: 'construction', investor_partner_id: '',
    contract_value: '', contract_currency: 'RSD', contract_date: '', payment_days: String(DEFAULT_PAYMENT_DAYS),
    active: true, note: '',
  }
}

export function draftFromProject(p: Project): ProjectDraft {
  return {
    id: p.id,
    name: p.name,
    code: p.code || '',
    kind: p.kind,
    investor_partner_id: p.investor_partner_id || '',
    contract_value: p.contract_value === null ? '' : String(p.contract_value),
    contract_currency: p.contract_currency || 'RSD',
    contract_date: p.contract_date || '',
    payment_days: String(p.payment_days ?? DEFAULT_PAYMENT_DAYS),
    active: p.active,
    note: p.note || '',
  }
}

/** "1.234.567,89", "1234567.89", "1 234 567,89" → 1234567.89; empty → null; junk → NaN. */
export function parseContractValue(s: string): number | null {
  const t = (s || '').trim().replace(/\s/g, '')
  if (!t) return null
  let n: string
  if (t.includes(',') && t.includes('.')) {
    // Whichever comes last is the decimal separator.
    n = t.lastIndexOf(',') > t.lastIndexOf('.')
      ? t.replace(/\./g, '').replace(',', '.')
      : t.replace(/,/g, '')
  } else if (t.includes(',')) {
    n = t.replace(',', '.')
  } else {
    n = t
  }
  const v = Number(n)
  return Number.isFinite(v) ? v : NaN
}

/**
 * Why a draft cannot be saved, in Serbian, or null. `existing` is the
 * company's projects, for the duplicate-name and duplicate-code checks the
 * database would otherwise refuse with an index name.
 *
 * Investor and contract value are expected on a construction site and
 * optional on a rental building — but only the investor is enforced: a site
 * is often entered before its contract is signed.
 */
export function validateProject(draft: ProjectDraft, existing: readonly Project[]): string | null {
  const name = draft.name.trim()
  if (!name) return 'Naziv projekta je obavezan.'
  // The P&L groups by project name, and costs with no project already sit
  // under this one; a project of the same name would be merged into them.
  if (name.toLowerCase() === OVERHEAD_LABEL.toLowerCase()) {
    return `„${OVERHEAD_LABEL}" je rezervisan naziv za troškove bez projekta.`
  }
  const others = existing.filter(p => p.id !== draft.id)
  if (others.some(p => p.name.trim().toLowerCase() === name.toLowerCase())) {
    return `Projekat „${name}" već postoji.`
  }
  const code = draft.code.trim()
  if (code && others.some(p => (p.code || '').trim().toLowerCase() === code.toLowerCase())) {
    return `Šifra „${code}" je već dodeljena drugom projektu.`
  }
  if (!PROJECT_KINDS.includes(draft.kind)) return 'Izaberite vrstu projekta.'
  if (draft.kind === 'construction' && !draft.investor_partner_id) {
    return 'Gradilište mora imati investitora.'
  }
  const value = parseContractValue(draft.contract_value)
  if (value !== null) {
    if (Number.isNaN(value)) return 'Vrednost ugovora nije ispravan broj.'
    if (value < 0) return 'Vrednost ugovora ne može biti negativna.'
    if (!CONTRACT_CURRENCIES.includes(draft.contract_currency)) return 'Izaberite valutu ugovora.'
  }
  if (draft.contract_date && !/^\d{4}-\d{2}-\d{2}$/.test(draft.contract_date)) {
    return 'Datum ugovora nije ispravan.'
  }
  const days = (draft.payment_days ?? '').trim()
  if (days && (!/^\d+$/.test(days) || Number(days) > 365)) {
    return 'Rok plaćanja mora biti ceo broj dana, od 0 do 365.'
  }
  return null
}

export interface ContractBook {
  contract_date: string
  contract_value_rsd: number
  contract_value_eur: number
}

/**
 * The book figures for a contract value: NBS rates on `date`, through
 * bookAmounts. Throws RateUnavailableError rather than guess.
 */
export async function contractBookFigures(
  value: number, currency: ContractCurrency, date: string,
): Promise<ContractBook> {
  const b = await toBookAmounts(value, currency, date)
  return { contract_date: date, contract_value_rsd: b.amount_rsd, contract_value_eur: b.amount_eur }
}

/**
 * The row to insert or update. `book` is required when the draft has a
 * contract value (from `contractBookFigures`) and ignored otherwise.
 */
export function projectRow(
  draft: ProjectDraft, companyId: string, book: ContractBook | null,
): Omit<Project, 'id' | 'created_at'> {
  const value = parseContractValue(draft.contract_value)
  const hasValue = value !== null && !Number.isNaN(value)
  if (hasValue && !book) throw new Error('Vrednost ugovora nije preračunata u RSD i EUR.')
  return {
    company_id: companyId,
    name: draft.name.trim(),
    code: draft.code.trim() || null,
    kind: draft.kind,
    investor_partner_id: draft.investor_partner_id || null,
    contract_value: hasValue ? round2(value as number) : null,
    contract_currency: hasValue ? draft.contract_currency : null,
    contract_date: hasValue ? book!.contract_date : (draft.contract_date || null),
    contract_value_rsd: hasValue ? book!.contract_value_rsd : null,
    contract_value_eur: hasValue ? book!.contract_value_eur : null,
    payment_days: normalisePaymentDays((draft.payment_days ?? '').trim() || DEFAULT_PAYMENT_DAYS),
    active: draft.active,
    note: draft.note.trim() || null,
    updated_at: new Date().toISOString(),
  }
}

// ── Profitability ───────────────────────────────────────────────────────────

/** The part of a v_pl_entries row the profitability reads. */
export interface PlEntryForProject {
  project_id: string | null
  project_name?: string | null
  /** 'revenue' or 'expense'. Anything else is ignored. */
  tx_type: string | null
  amount_rsd: number | string | null
  amount_eur: number | string | null
}

export interface ProjectProfit {
  /** Null is the overhead bucket; '' never appears. */
  projectId: string | null
  label: string
  revenue: number
  directCost: number
  /** revenue − directCost. */
  margin: number
  /** margin / revenue × 100, or null when there is no revenue to divide by. */
  marginPct: number | null
  /** Rows that had no figure in the chosen currency and were counted as 0. */
  unconverted: number
}

export interface Profitability {
  /** One per project passed in (in that order), then any project the rows name that the list did not. */
  projects: ProjectProfit[]
  /** Rows with no project. */
  overhead: ProjectProfit
  /** Projects and overhead together: the company. */
  total: ProjectProfit
}

function bucket(projectId: string | null, label: string): ProjectProfit {
  return { projectId, label, revenue: 0, directCost: 0, margin: 0, marginPct: null, unconverted: 0 }
}

function finish(b: ProjectProfit): ProjectProfit {
  const revenue = round2(b.revenue)
  const directCost = round2(b.directCost)
  const margin = round2(revenue - directCost)
  const marginPct = revenue !== 0 ? Math.round((margin / revenue) * 1000) / 10 : null
  return { ...b, revenue, directCost, margin, marginPct }
}

/**
 * Revenue, direct cost and margin per project in `currency`, plus overhead.
 *
 * Amounts are summed as stored, so a credit note (negative) reduces its side.
 * Every project in `projects` gets a row, even with nothing booked; a project
 * id the rows name that is not in the list still gets one, labelled from the
 * row's `project_name`. Overhead is never spread over projects.
 */
export function projectProfitability(
  rows: readonly PlEntryForProject[],
  currency: DisplayCurrency,
  projects: readonly Project[] = [],
): Profitability {
  const byId = new Map<string, ProjectProfit>()
  for (const p of projects) byId.set(p.id, bucket(p.id, projectLabel(p)))
  const overhead = bucket(null, OVERHEAD_LABEL)
  const total = bucket(null, 'Ukupno')

  for (const r of rows) {
    const isRevenue = r.tx_type === 'revenue'
    const isExpense = r.tx_type === 'expense'
    if (!isRevenue && !isExpense) continue

    const id = projectIdFromInput(r.project_id)
    let b = overhead
    if (id) {
      b = byId.get(id) ?? bucket(id, projectLabelById(projects, id, r.project_name))
      byId.set(id, b)
    }

    const amount = pickAmount(r, currency)
    const n = amount ?? 0
    for (const t of [b, total]) {
      if (amount === null) t.unconverted++
      if (isRevenue) t.revenue += n
      else t.directCost += n
    }
  }

  return {
    projects: Array.from(byId.values()).map(finish),
    overhead: finish(overhead),
    total: finish(total),
  }
}
