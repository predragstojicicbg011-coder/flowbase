// ─── Payroll obligation allocation ──────────────────────────────────────────
//
// Tax and contributions were booked as one aggregate invoice per filing with no
// department, so the whole amount fell into Unassigned even though the payroll
// import knows, per employee, exactly which department it belongs to.
//
// The payable is not the problem — one filing is one payment to the tax
// authority, and the import already models that as a parent invoice with
// `pl_impact: false` that the bank payment matches against. The problem is that
// the P&L children under it were aggregates too.
//
// This splits those children per employee, so each one carries the employee's
// department. Both branches of the expense report then work:
//
//   P&L branch          <category> > <tax / contributions sub-category>
//   Department branch   <department> > <sub-category> > <employee>
//
// The P&L headings are the owner's, from the system categories
// (services/systemCategories.ts) — passed in as `ObligationClasses`, never
// named here.
//
// The two conventions for `contributionsEmployee` differ between the manual
// dialog and the import — in one it includes the tax, in the other it does not —
// so this takes the components already separated and does not try to guess.

import { plPartFor, type SystemCategoryMap } from './systemCategories'

export type ObligationComponent = 'tax' | 'employee' | 'employer'

/** The P&L heading each component of a filing posts under. */
export type ObligationClasses = Record<ObligationComponent, { pl_category: string; pl_subcategory: string }>

/**
 * The three headings from the system categories. Throws
 * `SystemCategoryMissing` for the first one that is not set — a filing is
 * not posted with a component under no heading.
 */
export function obligationClassesFrom(map: SystemCategoryMap | null | undefined): ObligationClasses {
  return {
    tax: plPartFor('payroll_income_tax', map),
    employee: plPartFor('payroll_employee_contributions', map),
    employer: plPartFor('payroll_employer_contributions', map),
  }
}

export interface EmployeeObligation {
  /** Carried onto the rows, so a row can follow its person over projects. */
  employee_id?: string | null
  employee_name: string
  department_name?: string | null
  dept_subcategory_name?: string | null
  /** Tax on salary only — never including contributions. */
  tax: number
  /** Employee-side contributions, tax already excluded. */
  contributionsEmployee: number
  contributionsEmployer: number
}

export interface ObligationRow {
  pl_category: string
  pl_subcategory: string
  department: string | null
  dept_subcategory: string | null
  expense_description: string
  amount: number
  /** Which employee and component this row came from, for the note. */
  employee_id: string | null
  employee_name: string
  component: ObligationComponent
  /** True when the filing's rounding adjustment was folded into this row. */
  carriesRounding?: boolean
}

const round2 = (n: number) => Math.round(n * 100) / 100

/**
 * One row per employee per component that has an amount.
 *
 * `rounding` is the filing-level adjustment between what the components add up
 * to and what the tax authority actually charges. It is folded into the largest
 * employer-contribution row rather than given a row of its own — a row of its
 * own would have no employee, and therefore no department, which is the exact
 * problem this function exists to remove.
 */
export function obligationRows(
  employees: EmployeeObligation[], classes: ObligationClasses, rounding = 0,
): ObligationRow[] {
  const rows: ObligationRow[] = []

  for (const e of employees) {
    const parts: [ObligationComponent, number][] = [
      ['tax', e.tax],
      ['employee', e.contributionsEmployee],
      ['employer', e.contributionsEmployer],
    ]
    for (const [component, amount] of parts) {
      if (!(round2(amount) > 0)) continue
      rows.push({
        pl_category: classes[component].pl_category,
        pl_subcategory: classes[component].pl_subcategory,
        department: e.department_name || null,
        dept_subcategory: e.dept_subcategory_name || null,
        expense_description: e.employee_name,
        amount: round2(amount),
        employee_id: e.employee_id ?? null,
        employee_name: e.employee_name,
        component,
      })
    }
  }

  if (round2(rounding) !== 0 && rows.length > 0) {
    const employerRows = rows.filter(r => r.component === 'employer')
    const target = (employerRows.length > 0 ? employerRows : rows)
      .reduce((best, r) => (r.amount > best.amount ? r : best))
    target.amount = round2(target.amount + rounding)
    target.carriesRounding = true
  }

  return rows
}

/** What the rows add up to — the caller checks this against the payable. */
export function obligationTotal(rows: ObligationRow[]): number {
  return round2(rows.reduce((s, r) => s + r.amount, 0))
}

/** How much of a filing still has no department, if any. */
export function unallocatedTotal(rows: ObligationRow[]): number {
  return round2(rows.filter(r => !r.department).reduce((s, r) => s + r.amount, 0))
}

/**
 * Employees that would post with no department.
 *
 * The parser starts every imported employee with an empty department and the
 * review screen never insisted on one, so a single forgotten dropdown put that
 * person's salary AND their whole share of the tax filing back under
 * Unassigned. Splitting the obligation per employee only helps if the employee
 * has somewhere to go.
 */
export function employeesMissingDepartment(
  employees: { employee_name: string; department_name?: string | null }[],
): string[] {
  return employees
    .filter(e => !(e.department_name || '').trim())
    .map(e => (e.employee_name || '').trim() || '(unnamed)')
}
