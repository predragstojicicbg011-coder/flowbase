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
//   pl_category          \ follow the component — net, tax, which side's
//   pl_subcategory       / contributions, other income. Nobody chooses them
//                        per person: each component is a SYSTEM CATEGORY
//                        role (services/systemCategories.ts), set once by the
//                        owner in Podešavanja → Sistemske kategorije.
//   department           THE ONE CHOICE. Which sector carries this person's
//                        cost — from their dated allocation
//                        (employee_cost_allocation), else the unit mapping.
//   dept_subcategory     the allocation's own, else the role
//                        `payroll_salary_dept_subcategory`
//   expense_description  the employee's name
//
// OTHER INCOME follows the person the same way, under their department, but
// it is not a salary and so does not post under the net-salary role.
//
// No heading is named in this code. Mintflow's English names ('Employee and
// Labour', 'Net Salaries', 'Salary expenses domestic' …) were hardcoded here;
// FlowBase's P&L is the owner's own, in Serbian, and an unset role refuses the
// posting rather than inventing a heading. The names a role resolves to are
// still matched against `pl_subcategories`, `departments` and
// `dept_subcategories` when a posting is planned (`unknownNames`): a name
// that is not in those tables is reported rather than written — a renamed
// heading would otherwise come back as a second one beside it.

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
      missing.add(`P&L potkategorija "${u.pl_subcategory}"`)
    }
    if (!has(known.departments, u.department)) {
      missing.add(`sektor "${u.department}"`)
    }
    if (!has(known.deptSubcategories, u.dept_subcategory)) {
      missing.add(`podsektor "${u.dept_subcategory}"`)
    }
  }
  return [...missing].sort()
}
