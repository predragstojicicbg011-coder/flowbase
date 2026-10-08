// ─── Where each part of a payroll posts ─────────────────────────────────────
//
// Five fields decide where a cost lands in this application:
//
//   pl_category · pl_subcategory · department · dept_subcategory · expense_description
//
// For a payroll, only ONE of them is a decision about a person. The rest follow
// from what the amount is, and are set out here so they are in one place rather
// than spelled out at four call sites that can drift apart.
//
//   pl_category          always Employee and Labour
//   pl_subcategory       follows the component — net, tax, or which side's
//                        contributions. Nobody chooses it.
//   department           THE ONE CHOICE. Which team carries this person's cost:
//                        Development, Marketing, CS, Office & Administration…
//   dept_subcategory     Salary expenses domestic
//   expense_description  the employee's name
//
// OTHER INCOME follows the person the same way, under their department, but
// it is not a salary and so does not post under Net Salaries.
//
// The names here are the ones the ledger already uses. They are matched
// against `pl_subcategories`, `departments` and `dept_subcategories` when a
// posting is planned, and a name that is not in those tables is reported
// rather than written — a category invented by this module would create a
// second heading one character away from the real one, and the P&L would show
// both.

export const PL_CATEGORY = 'Employee and Labour'

/** Which sub-category each part of a salary posts under. */
export const SUBCATEGORY = {
  net: 'Net Salaries',
  tax: 'Tax on salary',
  employee: 'Contributions on behalf of the employee',
  employer: 'Contributions on behalf of the employer',
} as const

/** Под-категорија за зараде, the same for every employee. */
export const SALARY_DEPT_SUBCATEGORY = 'Salary expenses domestic'

/**
 * Where an addition paid outside the salary posts: other income, and the
 * untaxed kind. Under the person's own department, like their salary, but not
 * among the net salaries — it is not one. Spelled as the ledger spells it.
 */
export const OTHER_INCOME_SUBCATEGORY = 'Renumeration, allowances and other benefits'

/**
 * The departments a salary is expected to be allocated to.
 *
 * Informational — the dropdown reads the real `departments` table, and this
 * list exists so a test can catch it drifting. Spelled as the ledger spells
 * them, which is not how anybody says them out loud: capital E on Expenses,
 * and "Office & Administration" carries no "expenses" at all. That last one is
 * why the first attempt at the unit mapping rolled back, which is exactly what
 * it was supposed to do.
 */
export const SALARY_DEPARTMENTS = [
  'Marketing Expenses',
  'Development Expenses',
  'Product Expenses',
  'Design Expenses',
  'Sales Expenses',
  'CS Expenses',
  'Office & Administration',
  'Shareholder Expenses',
] as const

/**
 * `cf_type` for a payroll entry.
 *
 * Recurring while somebody is still employed, because next month there will be
 * another one and the cash forecast should expect it. Once they have left, the
 * last month is a ONE-OFF: leaving it recurring would have the forecast go on
 * predicting the salary of somebody who has gone, every month, quietly, for as
 * long as the forecast runs.
 *
 * `monthEnd` is the last day of the month being calculated, because leaving on
 * the 12th still means a salary this month and none after it.
 */
export function cashFlowTypeFor(
  employee: { left_on?: string | null }, monthEnd: string,
): 'recurring' | 'one_time' {
  if (!employee.left_on) return 'recurring'
  return employee.left_on <= monthEnd ? 'one_time' : 'recurring'
}

/** The last day of a month, as `YYYY-MM-DD`. */
export function endOfMonth(month: string): string {
  const [y, m] = month.slice(0, 7).split('-').map(Number)
  const day = new Date(Date.UTC(y, m, 0)).getUTCDate()
  return `${month.slice(0, 7)}-${String(day).padStart(2, '0')}`
}

export interface LedgerNames {
  plSubcategories: string[]
  departments: string[]
  deptSubcategories: string[]
}

/**
 * Names this module would post to that the ledger has never heard of.
 *
 * Checked rather than trusted, because a near-miss is the worst outcome
 * available: "Salary expenses domestic " with a trailing space creates a second
 * heading beside the real one, and the P&L shows both, each with part of the
 * payroll in it.
 */
export function unknownNames(
  used: { pl_subcategory: string; department: string | null; dept_subcategory: string | null }[],
  known: LedgerNames,
): string[] {
  const missing = new Set<string>()
  const has = (list: string[], v: string | null) => !v || list.includes(v)

  for (const u of used) {
    if (!has(known.plSubcategories, u.pl_subcategory)) {
      missing.add(`P&L sub-category "${u.pl_subcategory}"`)
    }
    if (!has(known.departments, u.department)) {
      missing.add(`department "${u.department}"`)
    }
    if (!has(known.deptSubcategories, u.dept_subcategory)) {
      missing.add(`department sub-category "${u.dept_subcategory}"`)
    }
  }
  return [...missing].sort()
}
