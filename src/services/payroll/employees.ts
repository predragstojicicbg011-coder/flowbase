// ─── Employees, as a payroll run sees them ──────────────────────────────────
//
// The tables hold a person, their contracts with the dates each was in force,
// and their deductions. A run needs none of that shape — it needs, for one
// month, what each person was owed. This is the piece in between.
//
// EVERYTHING HERE IS ASKED "AS AT A DATE". `employeesForMonth` is the only way
// in, and there is deliberately no function that returns "the current
// contract": once that existed, a recalculation of August run in December
// would quietly use December's salary, and the figure would look exactly like
// a verified one. Which is the whole failure this module exists to catch.
//
// It refuses rather than guesses, in the same two places settings.ts does: a
// person with no contract covering the month is reported by name, and a euro
// contract with no rate for the month is refused outright.

import {
  splitContractedNet, contractInDinars, wholeYearsBetween, type ContractedNet,
} from './engine'
import { coversDate, overlaps } from './settings'
import { fetchAllPages } from '../../utils/fetchAllPages'
import { monthLongLabel } from '../../utils/months'

/** `YYYY-MM-DD` → `01.08.2026.`, the way the interface writes a date. */
const srIso = (iso: string): string =>
  `${iso.slice(8, 10)}.${iso.slice(5, 7)}.${iso.slice(0, 4)}.`

export interface EmployeeRow {
  id: string
  company_id: string
  code: string | null
  full_name: string
  organisational_unit: string | null
  hired_on: string | null
  /** Датум почетка последњег ангажовања — what seniority counts from. */
  seniority_from?: string | null
  left_on: string | null
  note: string | null
  deleted_at?: string | null
}

export interface ContractRow {
  id: string
  employee_id: string
  valid_from: string
  valid_to: string | null
  currency: string
  /** НЕТО, including seniority. See the migration header. */
  net_amount: number
  /** An override. Null means derive it from the employee's seniority date. */
  service_years: number | null
  note: string | null
}

/**
 * A period where somebody is employed but not ours to calculate or pay.
 *
 * Maternity leave above all: the state works it out and pays it, so a month
 * that included them would be wrong by a whole person in a direction nobody
 * would question — the figure would simply be there.
 */
export interface AbsenceRow {
  id: string
  employee_id: string
  reason: 'maternity' | 'parental' | 'sick_leave_fund' | 'unpaid_leave' | 'suspension' | 'other'
  valid_from: string
  /** Null while they have not come back. */
  valid_to: string | null
  note: string | null
}

export const ABSENCE_REASONS: { value: AbsenceRow['reason']; label: string }[] = [
  { value: 'maternity', label: 'Porodiljsko odsustvo — isplaćuje država' },
  { value: 'parental', label: 'Odsustvo radi nege deteta' },
  { value: 'sick_leave_fund', label: 'Bolovanje na teret fonda' },
  { value: 'unpaid_leave', label: 'Neplaćeno odsustvo' },
  { value: 'suspension', label: 'Udaljen sa rada' },
  { value: 'other', label: 'Drugo' },
]

export function absenceLabel(reason: AbsenceRow['reason']): string {
  return ABSENCE_REASONS.find(r => r.value === reason)?.label ?? reason
}

/**
 * Which department and sub-category a salary posts to, over a period. Which
 * project it goes to is decided by the hours, not here.
 */
export interface CostAllocationRow {
  id: string
  employee_id: string
  department: string
  dept_subcategory: string | null
  valid_from: string
  valid_to: string | null
  note: string | null
}

export interface DeductionRow {
  id: string
  employee_id: string
  label: string
  goes_to: 'third_party' | 'employer'
  /** What the arrangement calls the payee. Shown, and matched where no id. */
  payee: string | null
  /**
   * Which partner it is forwarded to, where one was chosen.
   *
   * Preferred over `payee` by the posting. A name has to be matched, and the
   * rule that bridges `Generali Osiguranje` to `Generali Osiguranje a.d.o.`
   * also bridges `Generali` to `Generali Investments` — reported rather than
   * guessed, and still a deduction posted with no partner. An id is neither
   * ambiguous nor broken by the partner being renamed.
   */
  payee_partner_id?: string | null
  /** In `currency`. Null when the deduction is a share of net instead. */
  amount: number | null
  currency?: string
  percent_of_net: number | null
  valid_from: string
  valid_to: string | null
  /** Switched off rather than ended while an arrangement is suspended. */
  is_active?: boolean
  note: string | null
}

/** One person, one month: what they were owed and under which terms. */
export interface EmployeeForMonth {
  employee: EmployeeRow
  contract: ContractRow
  /** The contracted net in dinars, split into base and seniority. */
  net: ContractedNet
  /** The deductions running that month. */
  deductions: DeductionRow[]
  /** Where this month's cost posts to. Null when nobody has said. */
  allocation: CostAllocationRow | null
  /** Године стажа for this month, and where the figure came from. */
  serviceYears: number
  serviceYearsDerived: boolean
}

/**
 * The years of service to use for a month.
 *
 * Derived from the employee's seniority date unless the contract overrides it.
 * Storing the number instead would be true for one month and silently wrong
 * from that person's next anniversary — wrong in the direction that underpays
 * them, in a column nobody would think to look at. The override exists for the
 * case where MPP disagrees, since MPP is what these figures are checked
 * against.
 */
export function serviceYearsFor(
  employee: EmployeeRow, contract: ContractRow, date: string,
): { years: number; derived: boolean } {
  if (contract.service_years !== null && contract.service_years !== undefined) {
    return { years: contract.service_years, derived: false }
  }
  return { years: wholeYearsBetween(employee.seniority_from || '', date), derived: true }
}

/** The last day of a month, from any date inside it. */
export function endOfMonthFor(date: string): string {
  const [y, m] = date.slice(0, 7).split('-').map(Number)
  const day = new Date(Date.UTC(y, m, 0)).getUTCDate()
  return `${date.slice(0, 7)}-${String(day).padStart(2, '0')}`
}

/**
 * Whether somebody was on the payroll at any point in a month.
 *
 * ANY POINT, not on the first of it. This asked about the first day and so
 * dropped anybody hired mid-month out of their own first month entirely:
 * Vučinić Bojana joined on the 7th of September, worked 144 hours, and was
 * not on September's payroll at all. Their salary is prorated by the hours
 * they actually worked, so a part month is an ordinary thing that arrives with
 * the timesheet — there is nothing to decide, only somebody to include.
 *
 * `left_on` is the last day worked, so the month containing it still counts,
 * which is what the overlap says too.
 */
export function employedDuring(e: EmployeeRow, from: string, to: string): boolean {
  if (e.deleted_at) return false
  if (e.hired_on && e.hired_on > to) return false
  if (e.left_on && e.left_on < from) return false
  return true
}

/** The same question about a single date, for a caller that has only one. */
export function employedOn(e: EmployeeRow, date: string): boolean {
  return employedDuring(e, date, endOfMonthFor(date))
}

/** The contract in force on a date, or `null`. At most one — see the constraint. */
export function contractOn(contracts: ContractRow[], employeeId: string, date: string): ContractRow | null {
  return contracts.find(c =>
    c.employee_id === employeeId
    && coversDate(c as any, date)) ?? null
}

/**
 * Every dated record of a kind that touches a month.
 *
 * The same reason as `employedDuring`. A contract or a cost allocation that
 * begins mid-month applies to that month — a person hired on the 7th has both
 * starting on the 7th, and asking about the 1st finds
 * none of them and reports them as unconfigured.
 *
 * It returns ALL of them rather than picking one. Two contracts inside one
 * month is a pay rise partway through, and choosing between them quietly is
 * choosing between two salaries; the caller reports it instead.
 */
export function coveringMonth<T extends { valid_from: string; valid_to: string | null }>(
  rows: T[], from: string, to: string,
): T[] {
  return rows.filter(r =>
    r.valid_from <= to && (r.valid_to === null || r.valid_to > from))
}

/**
 * The deductions running for somebody in a month.
 *
 * A switched-off deduction is left out here rather than zeroed later, so it
 * never reaches a total by any path. Suspending one is how they are actually
 * managed — ending it would lose that it is the same arrangement when it
 * resumes, and deleting it would lose the months it did run.
 */
/** The off-payroll period covering a date, or `null`. At most one. */
export function absenceOn(
  rows: AbsenceRow[], employeeId: string, date: string,
): AbsenceRow | null {
  return rows.find(r => r.employee_id === employeeId && coversDate(r as any, date)) ?? null
}

/** The cost allocation covering a date, or `null`. At most one. */
export function allocationOn(
  rows: CostAllocationRow[], employeeId: string, date: string,
): CostAllocationRow | null {
  return rows.find(r => r.employee_id === employeeId && coversDate(r as any, date)) ?? null
}

export function deductionsOn(deductions: DeductionRow[], employeeId: string, date: string): DeductionRow[] {
  return deductions.filter(d =>
    d.employee_id === employeeId
    && d.is_active !== false
    && coversDate(d as any, date))
}

/**
 * What a deduction comes to in dinars, for a given net.
 *
 * A percentage deduction is of the net actually payable, not of the contracted
 * figure, because that is what a court order or a loan agreement means by it.
 *
 * A euro deduction is converted at the month being calculated, exactly as a
 * euro contract is — the register carries a converted dinar figure against one
 * rate, and taking that would freeze that month's rate into every month after
 * it. Where the rate for the month is unknown it comes to NOTHING rather than
 * to a guess, and `deductionIsUnconvertible` is how a caller finds out so it
 * can say so instead of quietly under-deducting.
 */
export function deductionAmount(
  d: DeductionRow, net: number, rates: Record<string, number> = {},
): number {
  if (d.amount === null || d.amount === undefined) {
    const raw = (d.percent_of_net ?? 0) * net
    return clampToNet(raw, net)
  }
  const currency = d.currency || 'RSD'
  if (currency === 'RSD') return clampToNet(d.amount, net)
  const rate = rates[currency]
  if (!(rate > 0)) return 0
  return clampToNet(d.amount * rate, net)
}

/**
 * What is wrong with a deduction, said in the words of what it will do.
 *
 * Three ways a row can be filled in so that it quietly does the wrong thing,
 * and none of them is a refusal — every one goes through the month and comes
 * out the other side looking settled:
 *
 *   a third party with nobody named        `goes_to` decides whether the
 *                                          amount becomes a payable, and a
 *                                          payable owed to nobody is a figure
 *                                          in the ledger with no creditor
 *
 *   neither an amount nor a percentage     `deductionAmount` returns 0, so the
 *                                          person is simply paid more and
 *                                          nothing anywhere says why
 *
 *   both an amount and a percentage        the amount wins and the percentage
 *                                          is ignored, which is fine until
 *                                          somebody edits the percentage and
 *                                          nothing changes
 *
 * Returns null when there is nothing to say. The wording names the
 * consequence rather than the field, because the field is already on screen
 * and the consequence is not.
 */
// The leading word boundary and the "not followed by a letter" are both
// load-bearing: without them `a.d.` matches the `ad` inside "Beograd" and
// the comparison starts mangling the very names it is meant to line up.
const LEGAL_FORMS = /\b(d\.?o\.?o\.?|a\.?d\.?|llc|ltd|inc|gmbh)(?!\p{L})/giu

/**
 * Whether two names on a page of money are plainly the same party.
 *
 * Deliberately crude: legal forms and punctuation come off, and one name has
 * to contain what is left of the other. "Example LLC" and
 * "EXAMPLE D.O.O., Beograd" are the same company written two ways, and
 * no exact comparison will ever say so.
 *
 * It is used only to RAISE A QUESTION, never to refuse or to decide anything,
 * which is why a crude rule is the right one here — a false match costs a
 * sentence on screen, and a missed one costs a payable booked to the wrong
 * party.
 */
export function looksLikeSameParty(a: string | null | undefined, b: string | null | undefined): boolean {
  const bare = (v: string | null | undefined) => (v || '')
    .replace(LEGAL_FORMS, ' ')
    .replace(/[^\p{L}\p{N}]+/gu, ' ')
    .trim().toLowerCase()
  const x = bare(a), y = bare(b)
  if (!x || !y) return false
  return x.includes(y) || y.includes(x)
}

export function deductionWarning(d: DeductionRow, payerName?: string | null): string | null {
  const hasAmount = d.amount !== null && d.amount !== undefined
  const hasPercent = d.percent_of_net !== null && d.percent_of_net !== undefined

  if (!hasAmount && !hasPercent) {
    return 'Nije unet ni iznos ni procenat, pa se ništa ne obustavlja. Unesite jedno od ta dva.'
  }
  if (hasAmount && hasPercent) {
    return 'Uneti su i iznos i procenat. Koristi se iznos, a procenat se zanemaruje.'
  }
  if (d.goes_to === 'third_party' && !(d.payee || '').trim()) {
    return 'Obustava se prosleđuje trećem licu, ali primalac nije naveden, pa bi se proknjižila kao obaveza prema nikome. Navedite primaoca.'
  }
  if (d.goes_to === 'third_party' && looksLikeSameParty(d.payee, payerName)) {
    // The seven health policies came out of the register naming
    // THE EMPLOYER, because the register records who PAYS. Reclassified as
    // forwarded on, the payee has to become whoever actually receives it, or
    // the ledger carries a payable from this company to itself.
    return `Obustava se prosleđuje trećem licu, ali je kao primalac naveden ${payerName} — firma koja je isplaćuje. `
      + 'Navedite onoga ko zaista prima novac, inače se knjiži obaveza firme prema samoj sebi.'
  }
  return null
}

/** Whether a deduction cannot be turned into dinars for this month. */
export function deductionIsUnconvertible(d: DeductionRow, rates: Record<string, number>): boolean {
  if (d.amount === null || d.amount === undefined) return false
  const currency = d.currency || 'RSD'
  return currency !== 'RSD' && !(rates[currency] > 0)
}

function clampToNet(raw: number, net: number): number {
  return Math.round(Math.min(raw, Math.max(0, net)) * 100) / 100
}

/** Deductions split the way they are booked: out of the company, or not. */
export function splitDeductions(
  deductions: DeductionRow[], net: number, rates: Record<string, number> = {},
): {
  thirdParty: number
  employer: number
  total: number
  /** Named so a caller can say which ones it could not convert. */
  unconvertible: DeductionRow[]
} {
  let thirdParty = 0
  let employer = 0
  const unconvertible: DeductionRow[] = []
  for (const d of deductions) {
    if (deductionIsUnconvertible(d, rates)) unconvertible.push(d)
    const amount = deductionAmount(d, net, rates)
    if (d.goes_to === 'third_party') thirdParty += amount
    else employer += amount
  }
  const r = (n: number) => Math.round(n * 100) / 100
  return {
    thirdParty: r(thirdParty), employer: r(employer),
    total: r(thirdParty + employer), unconvertible,
  }
}

export interface MonthInput {
  /** `YYYY-MM-DD`, the first of the month. */
  date: string
  /** The seniority coefficient per year, from the settings. */
  seniorityCoefficient: number
  /** The middle rate on the 20th, per currency. Only what is needed. */
  rates: Record<string, number>
}

export interface MonthRoster {
  people: EmployeeForMonth[]
  /**
   * Employed this month, and deliberately not on it.
   *
   * NAMED RATHER THAN DROPPED. Somebody quietly absent from a payroll is
   * precisely the error this module exists to catch, and an excluded person
   * who is invisible on screen is indistinguishable from a forgotten one.
   * They are not in `problems` either: nothing is wrong, and a complaint that
   * cannot be acted on teaches people to ignore the panel it sits in.
   */
  offPayroll: { employee: EmployeeRow; absence: AbsenceRow }[]
  /**
   * Why somebody on the payroll is not in `people`.
   *
   * Returned rather than thrown, so a run can show fourteen people and one
   * complaint instead of nothing at all — but the caller must not post a run
   * while this has anything in it. Someone silently missing from a payroll is
   * exactly the error a check against the accountant is meant to catch, and
   * the check would agree with itself.
   */
  problems: { employee: EmployeeRow; why: string }[]
}

export function employeesForMonth(
  employees: EmployeeRow[],
  contracts: ContractRow[],
  deductions: DeductionRow[],
  input: MonthInput,
  allocations: CostAllocationRow[] = [],
  absences: AbsenceRow[] = [],
): MonthRoster {
  const people: EmployeeForMonth[] = []
  const problems: { employee: EmployeeRow; why: string }[] = []
  const offPayroll: { employee: EmployeeRow; absence: AbsenceRow }[] = []
  const monthEnd = endOfMonthFor(input.date)

  const only = <T extends { valid_from: string; valid_to: string | null }>(
    rows: T[], employeeId: string,
  ): { row: T | null; tooMany: T[] } => {
    const mine = coveringMonth(
      rows.filter(r => (r as any).employee_id === employeeId), input.date, monthEnd)
    if (mine.length === 1) return { row: mine[0], tooMany: [] }
    if (mine.length === 0) return { row: null, tooMany: [] }
    return { row: null, tooMany: mine }
  }

  for (const employee of employees) {
    if (!employedDuring(employee, input.date, monthEnd)) continue

    // Checked BEFORE the contract, because somebody on maternity leave whose
    // contract has lapsed should be reported as on leave, not as missing a
    // contract. The second is a thing to go and fix; the first is not.
    const absence = absenceOn(absences, employee.id, input.date)
    if (absence) {
      offPayroll.push({ employee, absence })
      continue
    }

    const found = only(contracts, employee.id)
    if (found.tooMany.length > 0) {
      problems.push({
        employee,
        why: `${found.tooMany.length} ugovora pokrivaju delove ovog meseca `
          + `(${found.tooMany.map(c => srIso(c.valid_from)).join(', ')}). Izbor između njih `
          + 'bio bi izbor između dve zarade, pa se ništa ne obračunava dok se jedan od njih '
          + 'ne završi prvog dana u mesecu.',
      })
      continue
    }
    const contract = found.row
    if (!contract) {
      problems.push({
        employee,
        why: `Nijedan ugovor ne pokriva ${monthLongLabel(input.date)}. Dodajte ugovor za taj mesec.`,
      })
      continue
    }

    const dinars = amountInDinars(contract, input.rates)
    if (dinars === null) {
      problems.push({
        employee,
        why: `Nema kursa za ${contract.currency} na dan ${srIso(input.date)}. `
          + 'Ugovor ne može da se preračuna u dinare, a zarada obračunata '
          + 'po pretpostavljenom kursu izgledala bi kao proverena.',
      })
      continue
    }

    const { years, derived } = serviceYearsFor(employee, contract, input.date)
    // Found the same way as the contract, so somebody hired on the 7th
    // arrives fully configured rather than with a department nobody set.
    people.push({
      employee,
      contract,
      net: splitContractedNet(dinars, years, input.seniorityCoefficient),
      deductions: deductionsOn(deductions, employee.id, input.date),
      allocation: only(allocations, employee.id).row,
      serviceYears: years,
      serviceYearsDerived: derived,
    })
  }

  return { people, problems, offPayroll }
}

/** A contract's net in dinars, or `null` when the rate for the month is unknown. */
export function amountInDinars(contract: ContractRow, rates: Record<string, number>): number | null {
  if (contract.currency === 'RSD') return contract.net_amount
  const rate = rates[contract.currency]
  if (!(rate > 0)) return null
  return contractInDinars(contract.net_amount, rate)
}

/**
 * The date whose exchange rate a month is converted at: the 20th.
 *
 * The company's rule, not a regulation — it is what the payslips say and
 * what the accountant used, which is the standard this module is held to. The
 * NBS publishes on business days, so a 20th that falls at a weekend is moved
 * by the rate lookup itself rather than here.
 */
export function rateDateFor(month: string): string {
  return `${month.slice(0, 7)}-20`
}

// ─── Editing ────────────────────────────────────────────────────────────────

/**
 * Why a contract cannot be saved, or `null`.
 *
 * The overlap rule is the database's, which is where it belongs — but a
 * violation arrives as a message about a gist index, and the person reading it
 * is trying to record a pay rise.
 */
export function whyContractNotSavable(
  draft: { id?: string; valid_from: string; valid_to: string | null; net_amount: number | string },
  existing: ContractRow[],
): string | null {
  if (!draft.valid_from) return 'Unesite datum od kog ugovor važi.'
  if (draft.valid_to && draft.valid_to <= draft.valid_from) {
    return 'Datum završetka mora biti posle datuma početka.'
  }
  const amount = Number(draft.net_amount)
  if (!Number.isFinite(amount) || amount <= 0) {
    return 'Unesite ugovoreni neto iznos.'
  }
  const clash = existing.find(c =>
    c.id !== draft.id && overlaps(c.valid_from, c.valid_to, draft.valid_from, draft.valid_to))
  if (clash) {
    return 'Drugi ugovor ovog zaposlenog već pokriva taj period '
      + `(${srIso(clash.valid_from)} → ${clash.valid_to ? srIso(clash.valid_to) : 'i dalje važi'}). `
      + 'Dva ugovora za isti mesec dala bi dve zarade, a koju god da obračun uzme, '
      + 'izgledala bi sasvim obično. Prvo završite stari ugovor.'
  }
  return null
}

/** Closing a contract so a new one can start. The old row is never edited. */
export function supersedeContract(current: ContractRow, newFrom: string): { id: string; valid_to: string } {
  return { id: current.id, valid_to: newFrom }
}

// ─── Reading them out of the database ───────────────────────────────────────

export async function fetchEmployees(client: any, companyId?: string): Promise<EmployeeRow[]> {
  return fetchAllPages<EmployeeRow>((from, to) => {
    let q = client.from('employees').select('*').is('deleted_at', null)
      .order('full_name').order('id').range(from, to)
    if (companyId) q = q.eq('company_id', companyId)
    return q
  }).catch((e: any) => { throw new Error(`Zaposleni nisu učitani: ${e.message || e}. Osvežite stranu.`) })
}

// Paged rather than read in one go, and ordered by a unique column as well as
// the sort key. Fourteen people are nowhere near PostgREST's thousand-row cap
// today — but contracts and deductions accumulate a row per change forever,
// and the cap does not announce itself. It shows up as somebody's history
// quietly ending, which on this page reads as an employee who has no contract.

export async function fetchContracts(client: any, employeeIds?: string[]): Promise<ContractRow[]> {
  if (employeeIds && employeeIds.length === 0) return []
  return fetchAllPages<ContractRow>((from, to) => {
    let q = client.from('employee_contracts').select('*')
      .order('valid_from', { ascending: false }).order('id').range(from, to)
    if (employeeIds) q = q.in('employee_id', employeeIds)
    return q
  }).catch((e: any) => { throw new Error(`Ugovori nisu učitani: ${e.message || e}. Osvežite stranu.`) })
}

export async function fetchAllocations(client: any, employeeIds?: string[]): Promise<CostAllocationRow[]> {
  if (employeeIds && employeeIds.length === 0) return []
  return fetchAllPages<CostAllocationRow>((from, to) => {
    let q = client.from('employee_cost_allocation').select('*')
      .order('valid_from', { ascending: false }).order('id').range(from, to)
    if (employeeIds) q = q.in('employee_id', employeeIds)
    return q
  }).catch((e: any) => {
    throw new Error(`Raspodela troškova nije učitana: ${e.message || e}. Osvežite stranu.`)
  })
}

export async function fetchAbsences(client: any, employeeIds?: string[]): Promise<AbsenceRow[]> {
  if (employeeIds && employeeIds.length === 0) return []
  return fetchAllPages<AbsenceRow>((from, to) => {
    let q = client.from('employee_payroll_absence').select('*')
      .order('valid_from', { ascending: false }).order('id').range(from, to)
    if (employeeIds) q = q.in('employee_id', employeeIds)
    return q
  }).catch((e: any) => {
    throw new Error(`Periodi van obračuna nisu učitani: ${e.message || e}. Osvežite stranu.`)
  })
}

export async function fetchDeductions(client: any, employeeIds?: string[]): Promise<DeductionRow[]> {
  if (employeeIds && employeeIds.length === 0) return []
  return fetchAllPages<DeductionRow>((from, to) => {
    let q = client.from('employee_deductions').select('*')
      .order('valid_from', { ascending: false }).order('id').range(from, to)
    if (employeeIds) q = q.in('employee_id', employeeIds)
    return q
  }).catch((e: any) => { throw new Error(`Obustave nisu učitane: ${e.message || e}. Osvežite stranu.`) })
}


/**
 * The one company every employee belongs to, or null if it is not one.
 *
 * The Payroll page opens on "All companies", which is the page nobody wants:
 * only one company here files a payroll, so the first thing anybody does is
 * choose it. This chooses it for them — by MEASURING rather than by name.
 *
 * Naming the company in the code would be right today and wrong, silently,
 * the morning a second company starts filing: the selector would keep pointing
 * at the first one and a whole company's payroll would be a click nobody knew
 * to make. Asked of the employees, it answers "one" while that is true and
 * `null` the moment it stops being.
 *
 * Employees with no company are ignored rather than counted as a second one —
 * a missing field is not a company.
 */
export function soleCompanyOf(employees: { company_id?: string | null }[]): string | null {
  const distinct = new Set(
    employees.map(e => e.company_id).filter((c): c is string => !!c))
  return distinct.size === 1 ? Array.from(distinct)[0] : null
}

// ── Correcting a contract that was entered wrongly ──────────────────────────
//
// A pay rise is a new contract; it ends the old one and does not overwrite it,
// and that stays the ordinary path. But a figure typed wrongly is not a pay
// rise. Adding a second contract from today to fix a typo in August leaves
// August wrong for ever, and adding one dated August collides with the row it
// was meant to replace.
//
// So a contract can be corrected — and the two things that go quietly wrong
// when one is, are said out loud before it is saved.

/** A stretch of days with no contract covering them. `[from, to)`. */
export interface ContractGap {
  from: string
  to: string
}

/**
 * Days between one contract ending and the next beginning.
 *
 * The intervals are half-open, so contracts butt up exactly: one ends on the
 * day the next begins. Anything else is a gap, and a person with a gap drops
 * out of every payroll run that falls in it — silently, because a run reports
 * the people it found.
 */
export function contractGaps(contracts: ContractRow[]): ContractGap[] {
  const ordered = [...contracts]
    .filter(c => !!c.valid_from)
    .sort((a, b) => a.valid_from.localeCompare(b.valid_from))
  const out: ContractGap[] = []
  for (let i = 0; i + 1 < ordered.length; i++) {
    const end = ordered[i].valid_to
    // An open-ended contract followed by another is an overlap, not a gap;
    // `whyContractNotSavable` is what refuses that.
    if (end && end < ordered[i + 1].valid_from) {
      out.push({ from: end, to: ordered[i + 1].valid_from })
    }
  }
  return out
}

/**
 * What an edit will leave behind, in sentences, before it is saved.
 *
 * Warnings and not refusals: every one of them is a thing somebody may
 * genuinely mean to do — ending a contract because the person left, moving a
 * start date because the first one was mistyped. What they must not be is
 * invisible.
 */
export function editingContractLeaves(
  contracts: ContractRow[],
  edited: Pick<ContractRow, 'id' | 'valid_from' | 'valid_to'>,
  onDate: string,
): string[] {
  const after = contracts.map(c =>
    c.id === edited.id ? { ...c, valid_from: edited.valid_from, valid_to: edited.valid_to } : c)

  const notes: string[] = []

  const covering = after.find(c => coversDate(c as any, onDate))
  if (!covering) {
    notes.push(
      `Posle ove izmene nijedan ugovor ne pokriva ${srIso(onDate)}, pa ovaj zaposleni ispada iz `
      + 'svakog obračuna zarade od tog dana — a obračun prikazuje one koje je našao, '
      + 'ne one koje nije.')
  }

  for (const gap of contractGaps(after)) {
    notes.push(`Nijedan ugovor ne pokriva period od ${srIso(gap.from)} do ${srIso(gap.to)}.`)
  }

  const before = contracts.find(c => c.id === edited.id)
  if (before && before.valid_from !== edited.valid_from) {
    notes.push(
      `Početak ovog ugovora pomera se sa ${srIso(before.valid_from)} na ${srIso(edited.valid_from)}. `
      + 'Nijedan mesec već obračunat po njemu više neće dati isti rezultat.')
  }

  return notes
}
