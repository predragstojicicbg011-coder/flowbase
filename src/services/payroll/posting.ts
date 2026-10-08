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
import type { EmployeeForMonth } from './employees'
import { deductionAmount } from './employees'
import { obligationRows, obligationTotal } from '../payrollAllocation'
import {
  PL_CATEGORY, SUBCATEGORY, OTHER_INCOME_SUBCATEGORY, SALARY_DEPT_SUBCATEGORY,
  cashFlowTypeFor, endOfMonth, unknownNames, type LedgerNames,
} from './booking'

export const NET_SUBCATEGORY = SUBCATEGORY.net

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
  /** Which revenue stream carries it, and how. From the employee's allocation. */
  rev_alloc_type: string
  opex_type: string
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
  rev_alloc_type: string
  opex_type: string
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
  /** Where a retained deduction's storno goes, by deduction label. */
  retainedCategories?: Record<string, { pl_category: string; pl_subcategory: string }>
}

/**
 * The default home for a retained deduction whose label nobody has mapped.
 *
 * It used to be 'Other labour related expenses', which does not exist —
 * every unmapped deduction would have been refused by the ledger check, and
 * before that check existed it would have created the heading. This one is
 * real, and generic enough to be honest about being a default. The note on
 * the entry names the deduction, so it can be found and moved.
 */
export const RETAINED_FALLBACK = {
  pl_category: 'Employee and Labour',
  pl_subcategory: 'Renumeration, allowances and other benefits',
}

/**
 * Retained deductions whose category this ledger already has.
 *
 * Only labels that are certain. The manual payroll dialog books FitPass
 * withholdings to 'FitPass expenses', so a storno that went anywhere else
 * would leave the expense standing and the reversal sitting beside it. Matched
 * case-insensitively on the start of the label, because the register spells it
 * "Fitpass mesečna članarina".
 */
export const KNOWN_RETAINED: { prefix: string; pl_category: string; pl_subcategory: string }[] = [
  // Thirteen of the twenty deductions.
  { prefix: 'fitpass', pl_category: 'Employee and Labour', pl_subcategory: 'FitPass expenses' },
  // The other seven: six named "Privatno zdravstveno osiguranje <person>" and
  // one "Osigurani članovi porodice …", all cover for somebody's family.
  { prefix: 'privatno zdravstveno', pl_category: 'Employee and Labour', pl_subcategory: 'Private Health insurance' },
  { prefix: 'osigurani članovi', pl_category: 'Employee and Labour', pl_subcategory: 'Private Health insurance' },
]

export function retainedCategoryFor(
  label: string,
  overrides: Record<string, { pl_category: string; pl_subcategory: string }> = {},
): { pl_category: string; pl_subcategory: string } {
  if (overrides[label]) return overrides[label]
  const lower = label.trim().toLowerCase()
  const known = KNOWN_RETAINED.find(k => lower.startsWith(k.prefix))
  return known
    ? { pl_category: known.pl_category, pl_subcategory: known.pl_subcategory }
    : RETAINED_FALLBACK
}

export interface Placement {
  department: string | null
  dept_subcategory: string | null
  rev_alloc_type: string
  opex_type: string
}

const UNPLACED: Placement = {
  department: null, dept_subcategory: null, rev_alloc_type: 'sg100', opex_type: 'opex',
}

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
 * The allocation also carries the revenue-stream codes, which the mapping has
 * no opinion about — those used to be hard-coded as 'sg100' / 'opex' on every
 * entry, which was one allocation for twenty-five different people.
 */
export function placementFor(person: EmployeeForMonth | undefined, mapping: UnitMapping[]): Placement {
  if (person?.allocation) {
    const a = person.allocation
    return {
      department: a.department,
      dept_subcategory: a.dept_subcategory,
      rev_alloc_type: a.rev_alloc_type,
      opex_type: a.opex_type,
    }
  }
  const unit = departmentFor(person?.employee.organisational_unit ?? null, mapping)
  if (!unit) return UNPLACED
  return {
    department: unit.department,
    dept_subcategory: unit.dept_subcategory,
    rev_alloc_type: 'sg100',
    opex_type: 'opex',
  }
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
    if (!unit) { missing.add('(no organisational unit)'); return }
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

  const invoices: PlannedInvoice[] = []
  const transactions: PlannedTransaction[] = []
  const obligations: Parameters<typeof obligationRows>[0] = []
  /** Every retained deduction in this run, for the expected total below. */
  let retainedAcrossRun = 0

  const tag = `Payroll ${month} — ${run.label}`

  for (const line of run.salaries) {
    const p = people[line.employeeId]
    const where = placementFor(p, mapping)
    const department = where.department
    // Every salary lands under the one sub-category, whichever department
    // carries it. The allocation may name another, and then it is theirs.
    const deptSub = where.dept_subcategory || SALARY_DEPT_SUBCATEGORY
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
          pl_category: PL_CATEGORY,
          pl_subcategory: NET_SUBCATEGORY,
          department, dept_subcategory: deptSub,
          rev_alloc_type: where.rev_alloc_type, opex_type: where.opex_type, cf_type: cf,
          expense_description: line.name,
          amount: round2(amount),
          pl_impact: true,
          note: `${tag} — Deduction forwarded: ${d.label} — ${line.name}`,
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
        const retainedWhere = retainedCategoryFor(d.label, retained)
        transactions.push({
          kind: 'retained_storno',
          employeeName: line.name,
          pl_category: retainedWhere.pl_category,
          pl_subcategory: retainedWhere.pl_subcategory,
          department, dept_subcategory: deptSub,
          rev_alloc_type: where.rev_alloc_type, opex_type: where.opex_type, cf_type: cf,
          expense_description: d.label,
          amount: round2(-amount),
          note: `${tag} — Retained deduction (storno): ${d.label} — ${line.name}`,
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
        pl_category: PL_CATEGORY,
        pl_subcategory: NET_SUBCATEGORY,
        department, dept_subcategory: deptSub,
        rev_alloc_type: where.rev_alloc_type, opex_type: where.opex_type, cf_type: cf,
        expense_description: line.name,
        amount: toEmployee,
        pl_impact: true,
        note: `${tag} — Net salary — ${line.name}`
          + (thirdPartyTotal > 0 ? `, after ${round2(thirdPartyTotal)} forwarded` : ''),
      })
    }

    obligations.push({
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
    const deptSub = where.dept_subcategory || SALARY_DEPT_SUBCATEGORY
    // Under the person's own department, like their salary, but not among
    // the net salaries: an addition paid outside the salary is not one.
    invoices.push({
      kind: 'other_income',
      employeeId: line.employeeId,
      employeeName: line.name,
      partnerId: staffPartners[line.employeeId] ?? null,
      pl_category: PL_CATEGORY,
      pl_subcategory: OTHER_INCOME_SUBCATEGORY,
      department: where.department,
      dept_subcategory: deptSub,
      rev_alloc_type: where.rev_alloc_type, opex_type: where.opex_type,
      cf_type: cashFlowTypeFor(p?.employee ?? {}, monthEnd),
      expense_description: line.name,
      amount: round2(line.line.net),
      pl_impact: true,
      note: `${tag} — Other income — ${line.name}`,
    })
    obligations.push({
      employee_name: line.name,
      department_name: where.department,
      dept_subcategory_name: deptSub,
      tax: round2(line.line.incomeTax),
      contributionsEmployee: 0,
      contributionsEmployer: 0,
    })
  }

  // Every child row belongs to one employee, so it posts with that person's
  // allocation rather than with a default that would quietly send a quarter of
  // the tax filing to the wrong revenue stream.
  const placementByName = new Map<string, Placement>()
  const cfByName = new Map<string, 'recurring' | 'one_time'>()
  for (const line of [...run.salaries, ...run.otherIncome]) {
    const p = people[line.employeeId]
    placementByName.set(line.name, placementFor(p, mapping))
    cfByName.set(line.name, cashFlowTypeFor(p?.employee ?? {}, monthEnd))
  }

  const children = obligationRows(obligations)
  const owed = obligationTotal(children)
  if (owed > 0) {
    invoices.push({
      kind: 'obligation_parent',
      employeeId: null,
      employeeName: '',
      partnerId: input.taxPartnerId ?? null,
      pl_category: PL_CATEGORY,
      pl_subcategory: SUBCATEGORY.tax,
      department: null, dept_subcategory: null,
      rev_alloc_type: 'sg100', opex_type: 'opex', cf_type: 'recurring',
      expense_description: `Tax & contributions — ${month} ${run.label}`,
      amount: owed,
      // The payable the bank payment matches. Its children carry the P&L, so
      // counting it too would double every filing.
      pl_impact: false,
      note: `${tag} — Tax and contributions`,
    })
    for (const r of children) {
      invoices.push({
        kind: 'obligation_child',
        employeeId: null,
        employeeName: r.employee_name,
        partnerId: input.taxPartnerId ?? null,
        pl_category: PL_CATEGORY,
        pl_subcategory: r.pl_subcategory,
        department: r.department,
        dept_subcategory: r.dept_subcategory,
        rev_alloc_type: placementByName.get(r.employee_name)?.rev_alloc_type ?? 'sg100',
        opex_type: placementByName.get(r.employee_name)?.opex_type ?? 'opex',
        cf_type: cfByName.get(r.employee_name) ?? 'recurring',
        expense_description: r.expense_description,
        amount: r.amount,
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
  }
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
      return `The ledger has no ${unknown.join(', no ')}. Nothing was written. `
        + 'Posting to a name that does not exist creates a second heading one character '
        + 'from the real one, and the P&L then shows both with part of the payroll in '
        + 'each. Add them under Settings, or correct the allocation.'
    }
  }

  // The specific faults first. Each of them ALSO throws the total out, so
  // reporting the total first would answer "it does not add up" to somebody
  // whose actual problem is a named employee with no department.
  const negative = plan.invoices.find(i => i.amount < 0)
  if (negative) {
    return `"${negative.expense_description}" would be posted as a negative invoice `
      + `(${negative.amount.toFixed(2)}). A negative payable is not a thing; this is a `
      + 'sign the deductions exceed the salary they come out of.'
  }

  const undept = plan.invoices.filter(i => i.pl_impact && !i.department)
  if (undept.length > 0) {
    const names = [...new Set(undept.map(i => i.expense_description))].slice(0, 5)
    return `${undept.length} entries would land with no department (${names.join(', ')}). `
      + 'They would all fall into Unassigned, where a salary looks like an ordinary '
      + 'cost of nobody. Map the organisational units first.'
  }

  const total = planTotal(plan)
  const expected = round2(plan.expectedTotalCost)
  if (Math.abs(total - expected) > 0.02) {
    return `The entries come to ${total.toFixed(2)} and the run says the month costs `
      + `${expected.toFixed(2)} — a difference of ${(total - expected).toFixed(2)}. `
      + 'Nothing has been written. A payroll that does not add up to itself will not '
      + 'reconcile against the accountant either, and unpicking it afterwards is far '
      + 'worse than not posting it now.'
  }
  return null
}

const round2 = (n: number): number => Math.round(n * 100) / 100
