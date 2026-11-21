// ─── Saving a calculated month ──────────────────────────────────────────────
//
// A run used to exist only as something computed on the fly. That is fine
// while nothing has happened to it and useless once something has: a posted
// month must reproduce exactly as it was posted, "recalculate" needs a
// previous calculation to replace, and a derivation cannot be locked.
//
// So the calculation is written down, line by line, with every figure the
// payslip and the posting need — and the LINE is the record. It keeps its own
// hours, its own rate, its own contracted amount rather than a reference to
// the timesheet it came from, because that timesheet may be corrected next
// week and a payroll that changed underneath a posted invoice would be worse
// than no payroll at all.
//
// THE FREEZE IS IN THE DATABASE. A disabled button is a courtesy; a second
// tab, a stale page or a direct call goes straight past it. A trigger refuses
// to touch the lines of a posted run, and everything here is written expecting
// that refusal rather than trying to be the only thing preventing it.

import { fetchAllPages } from '../../utils/fetchAllPages'
import { firstOfMonth } from './timesheets'
import { plural } from '../../utils/plural'
import type { PayrollRun } from './runs'
import type { EmployeeForMonth } from './employees'
import {
  PRELIMINARY, KEPT_KIND_DIFFERS, KEPT_RUN_EMPTY, RUN_HAS_POSTING, RUN_NOT_REMOVED,
  type RunKind,
} from './preliminaryText'

export type RunStatus = 'draft' | 'posted'

export interface SavedRun {
  id: string
  company_id: string
  period_month: string
  run_key: string
  label: string
  status: RunStatus
  exchange_rate: number | null
  eur_rate: number | null
  month_hours: number | null
  gross: number
  net: number
  income_tax: number
  contributions_employee: number
  contributions_employer: number
  total_cost: number
  deductions_third_party: number
  deductions_employer: number
  calculated_at: string
  posted_at: string | null
  note: string | null
  /**
   * Preliminary or regular (20261121090000). A row read before the column
   * existed has none, and reads as regular — which every one of them was.
   */
  kind?: RunKind
}

export interface SavedRunLine {
  id?: string
  run_id?: string
  employee_id: string | null
  employee_code: string | null
  employee_name: string
  department: string | null
  line_kind: 'salary' | 'other'
  label: string | null
  hours: number
  month_hours: number
  contracted_net: number
  seniority_net: number
  additional_net: number
  service_years: number | null
  gross: number
  contribution_base: number
  tax_free: number
  tax_base: number
  income_tax: number
  pension_employee: number
  health_employee: number
  unemployment_employee: number
  pension_employer: number
  health_employer: number
  unemployment_employer: number
  net: number
  total_cost: number
  deductions_third_party: number
  deductions_employer: number
  detail: unknown
}

export interface SaveContext {
  companyId: string
  month: string
  exchangeRate: number | null
  /** RSD per 1 EUR, for the eur_rate the posted rows carry. */
  eurRate: number | null
  monthHours: number
  /** The roster, for the department each line posts to. */
  people: Record<string, EmployeeForMonth>
  /** The month's kind, the same for every run of it. */
  kind: RunKind
}

/** Every line a run would save, from what was just calculated. */
export function linesOf(run: PayrollRun, context: SaveContext): SavedRunLine[] {
  const out: SavedRunLine[] = []

  for (const s of run.salaries) {
    const p = context.people[s.employeeId]
    out.push({
      employee_id: s.employeeId,
      employee_code: s.code,
      employee_name: s.name,
      department: p?.allocation?.department ?? null,
      line_kind: 'salary',
      label: null,
      hours: s.hours,
      month_hours: s.monthHours,
      contracted_net: s.contractedNet,
      seniority_net: s.seniorityNet,
      additional_net: s.line.additionalNet,
      service_years: p?.serviceYears ?? null,
      gross: s.line.gross,
      contribution_base: s.line.contributionBase,
      tax_free: s.line.taxFreeForPeriod,
      tax_base: s.line.taxBase,
      income_tax: s.line.incomeTax,
      pension_employee: s.line.pensionEmployee,
      health_employee: s.line.healthEmployee,
      unemployment_employee: s.line.unemploymentEmployee,
      pension_employer: s.line.pensionEmployer,
      health_employer: s.line.healthEmployer,
      unemployment_employer: s.line.unemploymentEmployer,
      net: s.line.net,
      total_cost: s.line.totalCost,
      deductions_third_party: s.deductions.thirdParty,
      deductions_employer: s.deductions.employer,
      // Everything the payslip prints that is not one number on this row.
      detail: {
        categories: s.categories,
        additions: s.additions.map(a => ({
          label: a.label, kind: a.kind, treatment: a.treatment,
          amount: a.amount, currency: a.currency,
        })),
        deductions: (p?.deductions ?? []).map(d => ({
          label: d.label, goes_to: d.goes_to, payee: d.payee,
          amount: d.amount, currency: d.currency, percent_of_net: d.percent_of_net,
        })),
        meal_allowance: s.line.mealAllowance,
        holiday_allowance: s.line.holidayAllowance,
      },
    })
  }

  for (const o of run.otherIncome) {
    out.push({
      ...emptyLine(),
      employee_id: o.employeeId,
      employee_code: o.code,
      employee_name: o.name,
      line_kind: 'other',
      label: 'Ostala primanja',
      hours: 0,
      month_hours: 0,
      gross: o.line.gross,
      contribution_base: 0,
      tax_base: o.line.taxableNet,
      income_tax: o.line.incomeTax,
      net: o.line.net,
      total_cost: o.line.totalCost,
    })
  }

  return out
}

function emptyLine(): SavedRunLine {
  return {
    employee_id: null, employee_code: null, employee_name: '',
    department: null, line_kind: 'other', label: null,
    hours: 0, month_hours: 0, contracted_net: 0, seniority_net: 0,
    additional_net: 0, service_years: null,
    gross: 0, contribution_base: 0, tax_free: 0, tax_base: 0, income_tax: 0,
    pension_employee: 0, health_employee: 0, unemployment_employee: 0,
    pension_employer: 0, health_employer: 0, unemployment_employer: 0,
    net: 0, total_cost: 0,
    deductions_third_party: 0, deductions_employer: 0, detail: null,
  }
}

/** The header a run would save. */
export function headerOf(run: PayrollRun, context: SaveContext) {
  return {
    company_id: context.companyId,
    period_month: firstOfMonth(context.month),
    run_key: run.key,
    label: run.label,
    exchange_rate: context.exchangeRate,
    eur_rate: context.eurRate,
    month_hours: context.monthHours,
    gross: run.totals.gross,
    net: run.totals.net,
    income_tax: run.totals.incomeTax,
    contributions_employee: run.totals.employeeContributions,
    contributions_employer: run.totals.employerContributions,
    total_cost: run.totals.totalCost,
    deductions_third_party: run.totals.deductionsThirdParty,
    deductions_employer: run.totals.deductionsEmployer,
    kind: context.kind,
    calculated_at: new Date().toISOString(),
    updated_at: new Date().toISOString(),
  }
}

export function alreadyPostedMessage(label: string, month: string): string {
  return `Obračun „${label}“ za ${month} je proknjižen, pa ne može ponovo da se obračuna. `
    + 'Iz tih iznosa su napisane fakture u glavnoj knjizi, a izmena bi ostavila obračun '
    + 'i knjiženje u neslaganju. Prvo obrišite knjiženje na ovoj strani — tako se '
    + 'obračun vraća u nacrt.'
}

// ─── Whether the kept run is the one on screen ──────────────────────────────

/** How far a kept total may sit from the calculation: rounding, nothing more. */
export const KEPT_TOLERANCE = 0.02

export const NOT_KEPT = 'Ovaj obračun još nije izračunat i sačuvan. Kliknite „Ponovo obračunaj“ '
  + 'iznad — knjiži se sačuvani obračun, a ne iznos izračunat usput.'

export const KEPT_DIFFERS = (kept: string, now: string): string =>
  `Sačuvani obračun iznosi ${kept}, a sada iznosi ${now}. Nešto se u međuvremenu promenilo; `
  + 'ponovo obračunajte pre knjiženja da bi se knjiga i obračun slagali.'

/**
 * A posted run whose inputs have moved since. Recalculate is locked on it, so
 * telling somebody to recalculate would send them to a button that refuses;
 * the way back is undoing the posting first.
 */
export const POSTED_DIFFERS = (posted: string, now: string): string =>
  `Proknjiženo je ${posted}, a sa današnjim podacima obračun iznosi ${now}. `
  + 'Da biste ponovo obračunali, prvo poništite knjiženje.'

/** The run card's line for a kept draft whose total no longer agrees. */
export const KEPT_TOTAL_DIFFERS = (kept: string, now: string): string =>
  `Sačuvani obračun iznosi ${kept}, a mesec sada iznosi ${now}. Nešto se u međuvremenu `
  + 'promenilo — ponovo obračunajte pre knjiženja.'

/** A kept run's kind; a row older than the column is regular. */
export const kindOf = (r: Pick<SavedRun, 'kind'>): RunKind => r.kind ?? 'regular'

/**
 * How what is kept for a run stands against what is calculated now.
 *
 * In step needs the same total AND the same kind: a run kept as preliminary
 * is not what a regular month would post, however the totals compare. A
 * draft nobody falls into any more is `empty` rather than in step, so it can
 * be removed instead of marking the month for ever. One tolerance for the
 * page and the posting panel, so they cannot disagree at the edge.
 */
export type KeptState = 'none' | 'posted' | 'in_step' | 'stale_total' | 'stale_kind' | 'empty'

export function keptState(
  kept: SavedRun | null | undefined, run: PayrollRun, kind: RunKind,
): KeptState {
  if (!kept) return 'none'
  if (kept.status === 'posted') return 'posted'
  if (run.salaries.length + run.otherIncome.length === 0) return 'empty'
  if (driftOf(kept, run) > KEPT_TOLERANCE) return 'stale_total'
  if (kindOf(kept) !== kind) return 'stale_kind'
  return 'in_step'
}

const driftOf = (kept: SavedRun, run: PayrollRun): number =>
  Math.abs(Number(kept.total_cost) - run.totals.totalCost)

/**
 * What the posting panel says about a run's kept calculation, or `null` when
 * there is nothing to say. WHAT LANDS IN THE LEDGER HAS TO BE THE THING THAT
 * WAS KEPT: a draft that no longer agrees with the inputs — in total or in
 * kind — is recalculated before posting, and a posted one that no longer
 * agrees is undone first.
 */
export function keptWhy(
  kept: SavedRun | null | undefined, run: PayrollRun, kind: RunKind,
  money: (n: number) => string,
): string | null {
  const state = keptState(kept, run, kind)
  if (state === 'none' || !kept) return NOT_KEPT
  const was = money(Number(kept.total_cost))
  const now = money(run.totals.totalCost)
  if (state === 'posted') return driftOf(kept, run) > KEPT_TOLERANCE ? POSTED_DIFFERS(was, now) : null
  if (state === 'empty') return KEPT_RUN_EMPTY
  if (state === 'stale_total') return KEPT_DIFFERS(was, now)
  if (state === 'stale_kind') return KEPT_KIND_DIFFERS(kindOf(kept), kind)
  return null
}

/**
 * Remove a kept run that nobody is in any more. Only a draft, and only while
 * no posting row exists for it — by its id or by (company, month, run) —
 * because between a posting's claim and its run's freeze the run is still a
 * draft. The database refuses the same delete (`payroll_runs_delete_guard`).
 */
export async function removeRun(
  client: any,
  run: Pick<SavedRun, 'id' | 'company_id' | 'period_month' | 'run_key'>,
): Promise<void> {
  const byId = await client.from('payroll_postings').select('id')
    .eq('run_id', run.id).limit(1)
  const byKey = await client.from('payroll_postings').select('id')
    .eq('company_id', run.company_id).eq('period_month', run.period_month)
    .eq('run_key', run.run_key).limit(1)
  if (byId.error || byKey.error) throw new Error(RUN_NOT_REMOVED)
  if ((byId.data ?? []).length > 0 || (byKey.data ?? []).length > 0) {
    throw new Error(RUN_HAS_POSTING)
  }
  const { data, error } = await client
    .from('payroll_runs').delete().eq('id', run.id).eq('status', 'draft').select('id')
  if (error || !data || data.length === 0) throw new Error(RUN_NOT_REMOVED)
}

/**
 * Write a calculated run, replacing whatever was there.
 *
 * THE HEADER IS CLAIMED FIRST and the lines go in after, which is the same
 * order the posting uses and for the same reason: the unique index on
 * (company, month, run) is what stops two runs for one month, and it has to
 * be taken before anything else exists to be orphaned.
 *
 * Refuses a posted run before touching anything. The trigger would refuse it
 * too, but a message about a check constraint is not what somebody pressing
 * Recalculate needs to read.
 */
export async function saveRun(
  client: any, run: PayrollRun, context: SaveContext,
): Promise<SavedRun> {
  const month = firstOfMonth(context.month)

  const { data: existing, error: readErr } = await client
    .from('payroll_runs').select('*')
    .eq('company_id', context.companyId)
    .eq('period_month', month)
    .eq('run_key', run.key)
    .maybeSingle()
  if (readErr) throw new Error(`Sačuvani obračun nije učitan: ${readErr.message}`)

  if (existing?.status === 'posted') {
    throw new Error(alreadyPostedMessage(run.label, context.month.slice(0, 7)))
  }

  let saved: SavedRun
  if (existing) {
    const { data, error } = await client
      .from('payroll_runs').update(headerOf(run, context))
      .eq('id', existing.id).select('*').single()
    if (error) throw new Error(`Obračun nije sačuvan: ${error.message}`)
    saved = data

    // The old lines go only once the header is safely updated. A failure
    // here leaves the previous calculation intact, which is the right way
    // round: out of date beats absent.
    const { error: clearErr } = await client
      .from('payroll_run_lines').delete().eq('run_id', existing.id)
    if (clearErr) {
      throw new Error(`Prethodne stavke nisu obrisane (${clearErr.message}). `
        + 'Ništa nije zamenjeno; sačuvan je i dalje raniji obračun. Pokušajte ponovo.')
    }
  } else {
    const { data, error } = await client
      .from('payroll_runs').insert({ ...headerOf(run, context), status: 'draft' })
      .select('*').single()
    if (error) throw new Error(`Obračun nije sačuvan: ${error.message}`)
    saved = data
  }

  const lines = linesOf(run, context).map(l => ({ ...l, run_id: saved.id }))
  if (lines.length > 0) {
    const { data, error } = await client.from('payroll_run_lines').insert(lines).select('id')
    if (error) throw new Error(`Stavke nisu sačuvane: ${error.message}`)
    if (!data || data.length !== lines.length) {
      throw new Error(`Upisano je ${data?.length ?? 0} od ${lines.length} `
        + `${plural(lines.length, 'stavke', 'stavke', 'stavki')}. `
        + 'Sačuvani obračun je nepotpun; ponovo obračunajte pre nego što ga koristite.')
    }
  }

  return saved
}

export async function fetchRuns(
  client: any, companyId: string, month?: string,
): Promise<SavedRun[]> {
  return fetchAllPages<SavedRun>((from, to) => {
    let q = client.from('payroll_runs').select('*')
      .eq('company_id', companyId)
      .order('period_month', { ascending: false }).order('run_key').range(from, to)
    if (month) q = q.eq('period_month', firstOfMonth(month))
    return q
  }).catch((e: any) => { throw new Error(`Sačuvani obračuni nisu učitani: ${e.message || e}`) })
}

export async function fetchRunLines(client: any, runId: string): Promise<SavedRunLine[]> {
  return fetchAllPages<SavedRunLine>((from, to) =>
    client.from('payroll_run_lines').select('*')
      .eq('run_id', runId).order('employee_name').order('id').range(from, to),
  ).catch((e: any) => { throw new Error(`Stavke obračuna nisu učitane: ${e.message || e}`) })
}

/** A month, grouped, for a list of everything that has been calculated. */
export interface RunMonth {
  month: string
  runs: SavedRun[]
  posted: number
  draft: number
  /** Runs kept as preliminary. */
  preliminary: number
  totalCost: number
}

export function byMonth(runs: SavedRun[]): RunMonth[] {
  const map = new Map<string, SavedRun[]>()
  for (const r of runs) {
    const key = r.period_month.slice(0, 7)
    map.set(key, [...(map.get(key) ?? []), r])
  }
  return [...map.entries()]
    .map(([month, rs]) => ({
      month,
      runs: rs,
      posted: rs.filter(r => r.status === 'posted').length,
      draft: rs.filter(r => r.status === 'draft').length,
      preliminary: rs.filter(r => kindOf(r) === 'preliminary').length,
      totalCost: round2(rs.reduce((s, r) => s + Number(r.total_cost || 0), 0)),
    }))
    .sort((a, b) => b.month.localeCompare(a.month))
}

/**
 * What the months list says of a month: posted, how many of its runs are, and
 * — said as well, never instead — that a run of it is kept as preliminary.
 */
export function monthBadge(m: RunMonth): string {
  if (m.draft === 0 && m.posted > 0) return 'Proknjiženo'
  const posted = m.posted > 0 ? `Proknjiženo ${m.posted} od ${m.runs.length}` : null
  const preliminary = m.preliminary > 0 ? PRELIMINARY : null
  if (posted && preliminary) return `${posted} · ${preliminary}`
  return posted ?? preliminary ?? 'Nacrt'
}

const round2 = (n: number): number => Math.round(n * 100) / 100
