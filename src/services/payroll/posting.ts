// ─── Turning a run into ledger entries ──────────────────────────────────────
//
// A plan first, and the writing second. Everything here is a pure function
// that says what WOULD be written, so the arithmetic can be checked without a
// database and shown to somebody before anything lands. A payroll posted wrong
// is not a wrong number — it is a second complete set of invoices that
// reconciles against nothing and gets unpicked by hand months later.
//
// THE SHAPE IS THE ONE THE DATA INPUT PAGE ALREADY USES, deliberately, so the
// P&L and the department report do not have to learn a second convention:
//
//   Net salary          one expense invoice per employee, `pl_impact: true`,
//                       for what they are actually paid
//   Third-party         one invoice per deduction forwarded on, to the payee
//   Employer-retained   a NEGATIVE transaction against the expense the company
//                       already booked when it bought the thing
//   Tax & contributions one parent payable with `pl_impact: false` that the
//                       bank payment matches, and a child per employee with
//                       `pl_impact: true` that carries the department
//
// WHY THE NET INVOICE IS NET OF THIRD-PARTY DEDUCTIONS AND NOT OF RETAINED
// ONES, which is the single easiest thing to get wrong here. Salary expense is
// the whole net whatever happens to it afterwards. A third-party deduction
// splits that expense between two payables — the employee and the bank — so
// the two invoices add back to the net. A retained one does not: the company
// already expensed the membership when it bought it, and withholding it from
// a salary REDUCES that other expense rather than adding to this one. Book
// both the same way and the month is overstated by every retained deduction in
// it, on lines that each look perfectly ordinary.
//
// `checkPlan` exists because that argument is easy to write and easy to get
// backwards. It adds the plan up and refuses to let it be written unless it
// equals what the run said the month costs.

import type { PayrollRun, RunKey } from './runs'
import type { HoursAtRate } from './timesheets'
import type { EmployeeForMonth } from './employees'
import { deductionAmount } from './employees'
import { countOf } from '../../utils/plural'
import { obligationRows, obligationTotal, type ObligationClasses } from '../payrollAllocation'
import {
  classificationFor, plPartFor, SystemCategoryMissing,
  type SystemCategoryMap, type SystemRole,
} from '../systemCategories'
import {
  projectShares, distributeAmount, totalsByProject,
  type DistributedLine, type HoursBasis, type ProjectShare,
} from './projectHours'
import {
  cashFlowTypeFor, endOfMonth, unknownNames, type LedgerNames,
} from './booking'

export interface UnitMapping {
  organisational_unit: string
  department: string
  dept_subcategory: string | null
}

export interface PlannedInvoice {
  kind: 'net' | 'third_party' | 'obligation_parent' | 'obligation_child' | 'other_income'
  employeeId: string | null
  employeeName: string
  partnerId: string | null
  pl_category: string
  pl_subcategory: string
  department: string | null
  dept_subcategory: string | null
  /**
   * How this invoice's amount falls over projects, by the employee's hours.
   *
   * One line (or none) is written as the invoice's own `project_id`; two or
   * more are written as pl_splits lines under it, and the invoice's own
   * project is then null. Always adds up to `amount` exactly. Empty on the
   * obligation parent, which is not in the P&L.
   */
  projects: DistributedLine[]
  /** Recurring while they are still employed; one-off for a final month. */
  cf_type: 'recurring' | 'one_time'
  expense_description: string
  amount: number
  pl_impact: boolean
  /** Set on a child, resolved to the parent's real id at write time. */
  parentRef?: 'obligation'
  note: string
}

export interface PlannedTransaction {
  kind: 'retained_storno'
  employeeName: string
  pl_category: string
  pl_subcategory: string
  department: string | null
  dept_subcategory: string | null
  cf_type: 'recurring' | 'one_time'
  expense_description: string
  /** Negative — it cancels part of an expense already booked. */
  amount: number
  note: string
}

export interface PostingPlan {
  runKey: RunKey
  month: string
  invoices: PlannedInvoice[]
  transactions: PlannedTransaction[]
  /** What the run said the month costs. The plan has to come to this. */
  expectedTotalCost: number
  /**
   * People whose project hours cannot be used, by message. A plan with any
   * of these is refused by `checkPlan`: posting them to overhead instead would
   * be a guess about which site they were on.
   */
  projectErrors: string[]
  /**
   * System categories this plan needed and found unset, by message. A plan
   * with any of these is refused by `checkPlan` — first, before anything
   * else: its rows would carry an empty heading.
   */
  classificationErrors?: string[]
}

export interface PlanInput {
  run: PayrollRun
  month: string
  people: Record<string, EmployeeForMonth>
  mapping: UnitMapping[]
  /** Partner for the tax authority, if one has been chosen. */
  taxPartnerId?: string | null
  /** Partner per deduction id, where the payee is a known partner. */
  deductionPartners?: Record<string, string | null>
  /**
   * Partner per employee id — who the salary is owed to.
   *
   * A posted salary is an expense owed to a person, and the ledger has a
   * Partner column for exactly that. It was left empty on every row payroll
   * wrote, so the same cost entered by hand and entered by the module looked
   * like two different kinds of thing.
   *
   * Only where the match is CERTAIN; see `matchEmployeesToPartners`, which
   * leaves an ambiguous name null rather than choosing. A missing partner is
   * a blank to fill in; a wrong one is somebody else's salary on somebody
   * else's account.
   */
  employeePartners?: Record<string, string | null>
  /** The month's rates, for euro deductions. */
  currencyRates?: Record<string, number>
  /**
   * Where each component posts — the owner's own headings, from
   * `system_categories`. Only the roles this run actually needs are read; one
   * that is unset lands in `classificationErrors` and the plan is refused.
   */
  system: SystemCategoryMap
  /** Where a retained deduction's storno goes, by deduction label. */
  retainedCategories?: Record<string, { pl_category: string; pl_subcategory: string }>
  /**
   * Hours on each project this month, by employee id
   * (payroll_timesheet_projects). Somebody missing has no project hours, and
   * their whole cost is overhead.
   */
  projectHours?: Record<string, readonly { project_id: string | null; hours: number }[]>
  /**
   * Worked and paid hours by employee id — see `hoursBasisFromRuns`. Somebody
   * missing has no paid hours this month, and their cost is overhead.
   */
  hoursBasis?: Record<string, HoursBasis>
}

/**
 * Retained deductions whose heading is a system category of its own, by the
 * start of the label (case-insensitive — the register spells it "Fitpass
 * mesečna članarina").
 *
 * The storno has to land where the expense was booked when the company
 * bought the thing: a FitPass withholding cancelled anywhere else would leave
 * the FitPass expense standing with the reversal sitting beside it under
 * another heading. Anything not listed goes to `payroll_retained_fallback`,
 * and the note on the entry names the deduction, so it can be found and moved.
 */
export const KNOWN_RETAINED: { prefix: string; role: SystemRole }[] = [
  { prefix: 'fitpass', role: 'payroll_fitpass' },
  // "Privatno zdravstveno osiguranje <person>" and "Osigurani članovi
  // porodice …" — both cover somebody's family.
  { prefix: 'privatno zdravstveno', role: 'payroll_health_insurance' },
  { prefix: 'osigurani članovi', role: 'payroll_health_insurance' },
]

/** The role a retained deduction's storno posts under, by its label. */
export function retainedRoleFor(label: string): SystemRole {
  const lower = label.trim().toLowerCase()
  return KNOWN_RETAINED.find(k => lower.startsWith(k.prefix))?.role ?? 'payroll_retained_fallback'
}

/**
 * Where a retained deduction's storno goes: an explicit override by label,
 * else its role. Throws `SystemCategoryMissing` when that role is unset.
 */
export function retainedCategoryFor(
  label: string,
  system: SystemCategoryMap,
  overrides: Record<string, { pl_category: string; pl_subcategory: string }> = {},
): { pl_category: string; pl_subcategory: string } {
  if (overrides[label]) return overrides[label]
  return plPartFor(retainedRoleFor(label), system)
}

export interface Placement {
  department: string | null
  dept_subcategory: string | null
}

const UNPLACED: Placement = { department: null, dept_subcategory: null }

export function departmentFor(
  unit: string | null, mapping: UnitMapping[],
): UnitMapping | null {
  if (!unit) return null
  return mapping.find(m => m.organisational_unit === unit) ?? null
}

/**
 * Where one person's cost belongs this month.
 *
 * THE EMPLOYEE'S OWN ALLOCATION WINS, and the unit mapping is only the
 * fallback. The mapping says where a whole team's costs go; the allocation is
 * a decision about one person, made on a date, and the whole reason it exists
 * is that those two are sometimes different. Letting the team's answer
 * override an individual's would make the record of that decision a thing that
 * changed nothing.
 *
 * Which PROJECT the cost goes to is not decided here: that is the hours, in
 * payroll_timesheet_projects, and `projectShares`.
 */
export function placementFor(person: EmployeeForMonth | undefined, mapping: UnitMapping[]): Placement {
  if (person?.allocation) {
    const a = person.allocation
    return { department: a.department, dept_subcategory: a.dept_subcategory }
  }
  const unit = departmentFor(person?.employee.organisational_unit ?? null, mapping)
  if (!unit) return UNPLACED
  return { department: unit.department, dept_subcategory: unit.dept_subcategory }
}

/**
 * Organisational units used this month that nothing maps to a department.
 *
 * Returned rather than defaulted, because the default that suggests itself —
 * leave the department empty — is exactly the bug the payroll import already
 * had: one forgotten dropdown put a person's salary and their whole share of
 * the tax filing into Unassigned, and nothing on screen looked wrong.
 */
export function unmappedUnits(run: PayrollRun, people: Record<string, EmployeeForMonth>, mapping: UnitMapping[]): string[] {
  const missing = new Set<string>()
  const consider = (employeeId: string) => {
    const p = people[employeeId]
    // Somebody with their own allocation needs no mapping at all.
    if (p?.allocation) return
    const unit = p?.employee.organisational_unit
    if (!unit) { missing.add('(bez organizacione jedinice)'); return }
    if (!departmentFor(unit, mapping)) missing.add(unit)
  }
  for (const line of run.salaries) consider(line.employeeId)
  for (const line of run.otherIncome) consider(line.employeeId)
  return [...missing].sort()
}

/** Everything that would be written for one run. */
export function planFor(input: PlanInput): PostingPlan {
  const { run, month, people, mapping } = input
  const rates = input.currencyRates ?? {}
  const monthEnd = endOfMonth(month)
  const partners = input.deductionPartners ?? {}
  const staffPartners = input.employeePartners ?? {}
  const retained = input.retainedCategories ?? {}
  const system = input.system ?? {}

  // ── The headings, from the system categories ─────────────────────────
  // Resolved only when something in the run needs them, so a month with no
  // other income does not refuse over an unset other-income role. An unset
  // one is collected, the row gets an empty heading, and `checkPlan` refuses
  // the whole plan before any of it could be written.
  const classificationErrors = new Set<string>()
  const NONE = { pl_category: '', pl_subcategory: '' }
  const unset = (e: unknown) => {
    if (e instanceof SystemCategoryMissing) { classificationErrors.add(e.message); return }
    throw e
  }
  const headingOf = (role: SystemRole) => {
    try { return plPartFor(role, system) } catch (e) { unset(e); return NONE }
  }
  const retainedHeading = (label: string) => {
    try { return retainedCategoryFor(label, system, retained) } catch (e) { unset(e); return NONE }
  }
  /** The salary podsektor when the person's allocation names none. */
  const defaultDeptSub = (): string => {
    try {
      return classificationFor('payroll_salary_dept_subcategory', system).dept_subcategory || ''
    } catch (e) { unset(e); return '' }
  }

  const invoices: PlannedInvoice[] = []
  const transactions: PlannedTransaction[] = []
  const obligations: Parameters<typeof obligationRows>[0] = []
  /** Every retained deduction in this run, for the expected total below. */
  let retainedAcrossRun = 0

  const tag = `Zarade ${month} — ${run.label}`

  // ── Projects, by hours ───────────────────────────────────────────────
  // One set of shares per person, measured once and applied to every
  // invoice of theirs, so their net, their forwarded deductions and their
  // share of the filing all fall over the same sites in the same proportion.
  const hours = input.projectHours ?? {}
  const basis = input.hoursBasis ?? {}
  const sharesOf = new Map<string, ProjectShare[]>()
  const projectErrors: string[] = []
  const sharesFor = (employeeId: string, name: string): ProjectShare[] => {
    const known = sharesOf.get(employeeId)
    if (known) return known
    const r = projectShares(hours[employeeId] ?? [], basis[employeeId] ?? null, name)
    if (r.error) projectErrors.push(r.error)
    const shares = r.error ? [{ project_id: null, hours: 0, share: 1 }] : r.shares
    sharesOf.set(employeeId, shares)
    return shares
  }
  const spread = (employeeId: string, name: string, amount: number): DistributedLine[] =>
    distributeAmount(round2(amount), sharesFor(employeeId, name.split(' — ')[0]))

  for (const line of run.salaries) {
    const p = people[line.employeeId]
    const where = placementFor(p, mapping)
    const department = where.department
    // Every salary lands under the one sub-category, whichever department
    // carries it. The allocation may name another, and then it is theirs.
    const deptSub = where.dept_subcategory || defaultDeptSub()
    const cf = cashFlowTypeFor(p?.employee ?? {}, monthEnd)

    // Only the deductions this run carries. `runsFor` puts a person's whole
    // month of deductions on one run, so this is all of them or none.
    const carries = line.deductions.total > 0
    const theirDeductions = carries ? (p?.deductions ?? []) : []

    let thirdPartyTotal = 0
    /**
     * What the employer keeps out of this salary.
     *
     * It leaves the obligation to the employee the same way a third-party
     * deduction does — they are not owed it — and it also cancels an expense
     * the company already booked when it bought the thing being withheld for.
     * Both, which is what makes the circle close: a 1,000 FitPass invoice
     * booked as a cost, 1,000 kept out of a 301,000 net salary, and a 1,000
     * storno against the invoice. The employee is owed 300,000, the company
     * is out 300,000, and the FitPass bill cost it nothing because the
     * employee paid for it.
     */
    let retainedTotal = 0
    for (const d of theirDeductions) {
      // Against the FULL month's contracted net, which is what `runsFor`
      // used. A percentage deduction worked out against this run's prorated
      // net instead would come to less than the figure the run already showed,
      // and the plan would quietly stop matching the page above it.
      const amount = deductionAmount(d, p.net.total, rates)
      if (!(amount > 0)) continue

      if (d.goes_to === 'third_party') {
        thirdPartyTotal += amount
        invoices.push({
          kind: 'third_party',
          employeeId: line.employeeId,
          employeeName: line.name,
          partnerId: partners[d.id] ?? null,
          ...headingOf('payroll_net_salary'),
          department, dept_subcategory: deptSub,
          cf_type: cf,
          expense_description: line.name,
          amount: round2(amount),
          projects: spread(line.employeeId, line.name, amount),
          pl_impact: true,
          note: `${tag} — Prosleđena obustava: ${d.label} — ${line.name}`,
        })
      } else {
        // Taken off the salary AND cancelling part of an expense the company
        // already booked when it bought the thing being withheld for.
        //
        // It used to be only the second of those: the storno was written and
        // the net invoice was left at the full amount, so the ledger said the
        // employee was owed 301,000 when 300,000 was going to be paid, and
        // the month's expense carried a FitPass bill the employee had in fact
        // bought themselves.
        retainedTotal += amount
        retainedAcrossRun += amount
        const retainedWhere = retainedHeading(d.label)
        transactions.push({
          kind: 'retained_storno',
          employeeName: line.name,
          pl_category: retainedWhere.pl_category,
          pl_subcategory: retainedWhere.pl_subcategory,
          department, dept_subcategory: deptSub,
          cf_type: cf,
          expense_description: d.label,
          amount: round2(-amount),
          note: `${tag} — Zadržana obustava (storno): ${d.label} — ${line.name}`,
        })
      }
    }

    // Neither half of what was withheld is owed to the employee: one goes to
    // a third party and one stays with the employer.
    const toEmployee = round2(line.line.net - thirdPartyTotal - retainedTotal)
    if (toEmployee > 0) {
      invoices.push({
        kind: 'net',
        employeeId: line.employeeId,
        employeeName: line.name,
        partnerId: staffPartners[line.employeeId] ?? null,
        ...headingOf('payroll_net_salary'),
        department, dept_subcategory: deptSub,
        cf_type: cf,
        expense_description: line.name,
        amount: toEmployee,
        projects: spread(line.employeeId, line.name, toEmployee),
        pl_impact: true,
        note: `${tag} — Neto zarada — ${line.name}`
          + (thirdPartyTotal > 0 ? `, nakon prosleđenih ${round2(thirdPartyTotal)}` : ''),
      })
    }

    obligations.push({
      employee_id: line.employeeId,
      employee_name: line.name,
      department_name: department,
      dept_subcategory_name: deptSub,
      tax: round2(line.line.incomeTax),
      contributionsEmployee: round2(line.line.employeeContributions),
      contributionsEmployer: round2(line.line.employerContributions),
    })
  }

  for (const line of run.otherIncome) {
    const p = people[line.employeeId]
    const where = placementFor(p, mapping)
    const deptSub = where.dept_subcategory || defaultDeptSub()
    // Under the person's own department, like their salary, but not among
    // the net salaries: an addition paid outside the salary is not one.
    invoices.push({
      kind: 'other_income',
      employeeId: line.employeeId,
      employeeName: line.name,
      partnerId: staffPartners[line.employeeId] ?? null,
      ...headingOf('payroll_other_income'),
      department: where.department,
      dept_subcategory: deptSub,
      cf_type: cashFlowTypeFor(p?.employee ?? {}, monthEnd),
      expense_description: line.name,
      amount: round2(line.line.net),
      projects: spread(line.employeeId, line.name, line.line.net),
      pl_impact: true,
      note: `${tag} — Ostala primanja — ${line.name}`,
    })
    obligations.push({
      employee_id: line.employeeId,
      employee_name: line.name,
      department_name: where.department,
      dept_subcategory_name: deptSub,
      tax: round2(line.line.incomeTax),
      contributionsEmployee: 0,
      contributionsEmployer: 0,
    })
  }

  // Every child row belongs to one employee, so it follows that person's
  // hours over the projects, like their salary does.
  const cfByName = new Map<string, 'recurring' | 'one_time'>()
  for (const line of [...run.salaries, ...run.otherIncome]) {
    const p = people[line.employeeId]
    cfByName.set(line.name, cashFlowTypeFor(p?.employee ?? {}, monthEnd))
  }

  const classes: ObligationClasses | null = obligations.length === 0 ? null : {
    tax: headingOf('payroll_income_tax'),
    employee: headingOf('payroll_employee_contributions'),
    employer: headingOf('payroll_employer_contributions'),
  }
  const children = classes ? obligationRows(obligations, classes) : []
  const owed = obligationTotal(children)
  if (owed > 0) {
    invoices.push({
      kind: 'obligation_parent',
      employeeId: null,
      employeeName: '',
      partnerId: input.taxPartnerId ?? null,
      // The payable carries the tax heading; it is pl_impact false, so the
      // heading is for finding it, not for the P&L.
      ...classes!.tax,
      department: null, dept_subcategory: null,
      cf_type: 'recurring',
      expense_description: `Porez i doprinosi — ${month} ${run.label}`,
      amount: owed,
      projects: [],
      // The payable the bank payment matches. Its children carry the P&L, so
      // counting it too would double every filing.
      pl_impact: false,
      note: `${tag} — Porez i doprinosi`,
    })
    for (const r of children) {
      invoices.push({
        kind: 'obligation_child',
        employeeId: null,
        employeeName: r.employee_name,
        partnerId: input.taxPartnerId ?? null,
        pl_category: r.pl_category,
        pl_subcategory: r.pl_subcategory,
        department: r.department,
        dept_subcategory: r.dept_subcategory,
        cf_type: cfByName.get(r.employee_name) ?? 'recurring',
        expense_description: r.expense_description,
        amount: r.amount,
        projects: r.employee_id
          ? spread(r.employee_id, r.employee_name, r.amount)
          : [{ project_id: null, amount: r.amount }],
        pl_impact: true,
        parentRef: 'obligation',
        note: `${tag} — ${r.pl_subcategory} — ${r.employee_name}`,
      })
    }
  }

  return {
    runKey: run.key,
    month,
    invoices,
    transactions,
    // ── Net of what the employer retained ─────────────────────────────
    //
    // `checkPlan` insists the invoices add up to this, and the invoices are
    // now smaller by every retained deduction. Left as the run's own total
    // the check would refuse every payroll that has one — correctly, because
    // the two really would disagree.
    //
    // The run's figure is unchanged and still what the Payroll page reports:
    // the cost of employing people. This is what is POSTED, which is that
    // cost less the part of it the employee paid for themselves.
    expectedTotalCost: round2(run.totals.totalCost - retainedAcrossRun),
    projectErrors,
    classificationErrors: [...classificationErrors],
  }
}

/**
 * Worked and paid hours per employee, from the salary lines of the runs.
 *
 * Paid is `line.hours` — every paid hour at its coefficient, exactly what the
 * salary was prorated on. Worked is the `regular_hours` category. An employee
 * with no salary line (a month wholly unpaid, or additions only) is left out:
 * there are no paid hours to share their cost over, so it is overhead.
 */
export function hoursBasisFromRuns(runs: readonly PayrollRun[]): Record<string, HoursBasis> {
  const out: Record<string, HoursBasis> = {}
  for (const run of runs) {
    for (const s of run.salaries) {
      const worked = (s.categories as HoursAtRate[])
        .filter(c => c.field === 'regular_hours')
        .reduce((sum, c) => sum + c.hours, 0)
      out[s.employeeId] = { worked: round2(worked), paid: round2(s.hours) }
    }
  }
  return out
}

/** What the plan puts on each project (null = overhead), P&L rows only. */
export function planProjectTotals(plan: PostingPlan): DistributedLine[] {
  return totalsByProject(plan.invoices.filter(i => i.pl_impact).flatMap(i => i.projects))
}

/**
 * What the plan adds up to in the P&L.
 *
 * `pl_impact: false` rows are left out, which is the whole reason the parent
 * carries it: the payable exists so a bank payment has something to match,
 * and its children are what reaches the P&L.
 */
export function planTotal(plan: PostingPlan): number {
  // Stornos are NOT in this sum. They cancel a different expense, booked
  // elsewhere when the company bought the thing being withheld for, so adding
  // them here would make the total disagree with the run by exactly what was
  // withheld. `stornoTotal` is what they come to, for a page that wants to
  // show it.
  return round2(plan.invoices
    .filter(i => i.pl_impact)
    .reduce((sum, i) => sum + i.amount, 0))
}

/** What the retained deductions cancel elsewhere. Negative, or zero. */
export function stornoTotal(plan: PostingPlan): number {
  return round2(plan.transactions.reduce((sum, t) => sum + t.amount, 0))
}

/**
 * Why this plan must not be written, or `null`.
 *
 * THE ARITHMETIC CHECK IS THE POINT. Everything above is an argument about
 * which way round two conventions go, and an argument is exactly the kind of
 * thing that is easy to write convincingly and get backwards. So the plan is
 * added up and refused unless it equals what the run said the month costs.
 *
 * Retained stornos are excluded from that sum on purpose: they cancel a
 * DIFFERENT expense, booked elsewhere when the company bought the thing, and
 * counting them here would make the total disagree with the run by exactly
 * the amount that was withheld.
 */
export function checkPlan(plan: PostingPlan, known?: LedgerNames): string | null {
  // First of all: a heading that is not set. Every row it touches would be
  // written under an empty category, and every other check below would be
  // reasoning about rows that must not exist.
  if (plan.classificationErrors && plan.classificationErrors.length > 0) {
    return `${plan.classificationErrors.join(' ')} Ništa nije upisano.`
  }
  // And whatever built the plan: no row goes out without its P&L heading.
  const headless = [...plan.invoices, ...plan.transactions]
    .find(r => !(r.pl_category || '').trim() || !(r.pl_subcategory || '').trim())
  if (headless) {
    return `„${headless.expense_description}“ nema P&L kategoriju ili potkategoriju. `
      + 'Ništa nije upisano. Podesite sistemske kategorije u Podešavanja → Sistemske kategorije.'
  }

  // Before anything else: does the ledger recognise every heading this would
  // post to? A near miss is the worst outcome available — one character out
  // creates a second heading beside the real one and the P&L shows both, each
  // holding part of the payroll, and neither looking wrong.
  if (known) {
    const unknown = unknownNames([
      ...plan.invoices.map(i => ({
        pl_subcategory: i.pl_subcategory,
        department: i.department,
        dept_subcategory: i.dept_subcategory,
      })),
      ...plan.transactions.map(t => ({
        pl_subcategory: t.pl_subcategory,
        department: t.department,
        dept_subcategory: t.dept_subcategory,
      })),
    ], known)
    if (unknown.length > 0) {
      return `Glavna knjiga nema: ${unknown.join(', ')}. Ništa nije upisano. `
        + 'Knjiženje na naziv koji ne postoji napravilo bi drugi naslov pored pravog, '
        + 'pa bi P&L prikazao oba sa delom zarada u svakom. Dodajte ih u Podešavanjima '
        + 'ili ispravite raspodelu.'
    }
  }

  if (plan.projectErrors.length > 0) {
    return `Sati po projektima ne odgovaraju mesecu. Ništa nije upisano. `
      + plan.projectErrors.join(' ')
  }

  // The specific faults first. Each of them ALSO throws the total out, so
  // reporting the total first would answer "it does not add up" to somebody
  // whose actual problem is a named employee with no department.
  const negative = plan.invoices.find(i => i.amount < 0)
  if (negative) {
    return `„${negative.expense_description}“ bi bila proknjižena kao negativna faktura `
      + `(${negative.amount.toFixed(2)}). Negativna obaveza ne postoji; to znači da su `
      + 'obustave veće od zarade iz koje se odbijaju. Proverite obustave zaposlenog.'
  }

  const undept = plan.invoices.filter(i => i.pl_impact && !i.department)
  if (undept.length > 0) {
    const names = [...new Set(undept.map(i => i.expense_description))].slice(0, 5)
    return `${countOf(undept.length, 'stavka bi ostala', 'stavke bi ostale', 'stavki bi ostalo')} `
      + `bez sektora (${names.join(', ')}). Sve bi završile u „Nedodeljeno“, gde zarada `
      + 'izgleda kao običan trošak bez nosioca. Prvo povežite organizacione jedinice sa sektorima.'
  }

  // Every invoice's project lines must come to the invoice, to the para:
  // the database refuses a split that does not, and a single project line
  // that did not would move cost between sites without anybody choosing to.
  const unbalanced = plan.invoices.find(i => i.pl_impact && Math.round(
    i.projects.reduce((s, l) => s + l.amount, 0) * 100) !== Math.round(i.amount * 100))
  if (unbalanced) {
    return `„${unbalanced.expense_description}“ (${unbalanced.amount.toFixed(2)}) se ne `
      + 'slaže sa zbirom po projektima. Ništa nije upisano.'
  }

  const total = planTotal(plan)
  const expected = round2(plan.expectedTotalCost)
  if (Math.abs(total - expected) > 0.02) {
    return `Stavke iznose ${total.toFixed(2)}, a prema obračunu mesec košta `
      + `${expected.toFixed(2)} — razlika je ${(total - expected).toFixed(2)}. `
      + 'Ništa nije upisano. Obračun koji se ne slaže sam sa sobom neće se složiti ni '
      + 'sa knjigovođom. Ponovo obračunajte mesec pa proknjižite.'
  }
  return null
}

const round2 = (n: number): number => Math.round(n * 100) / 100
