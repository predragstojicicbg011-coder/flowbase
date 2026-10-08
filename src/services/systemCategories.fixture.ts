// A complete system-category map for tests: every role set, with names an
// owner might give his own P&L. Tests that assert where something posts
// assert these names — never the English Mintflow ones.

import type { Classification, SystemCategoryMap } from './systemCategories'

const pl = (pl_category: string, pl_subcategory: string): Classification => ({
  pl_category, pl_subcategory, department: null, dept_subcategory: null, expense_description: null,
})

export const TEST_SYSTEM_CATEGORIES: SystemCategoryMap = {
  payroll_net_salary: pl('Zarade', 'Neto zarade'),
  payroll_income_tax: pl('Zarade', 'Porez na zarade'),
  payroll_employee_contributions: pl('Zarade', 'Doprinosi na teret zaposlenog'),
  payroll_employer_contributions: pl('Zarade', 'Doprinosi na teret poslodavca'),
  payroll_other_income: pl('Zarade', 'Naknade i ostala primanja'),
  payroll_salary_dept_subcategory: {
    pl_category: null, pl_subcategory: null, department: null,
    dept_subcategory: 'Zarade u zemlji', expense_description: null,
  },
  payroll_retained_fallback: pl('Zarade', 'Naknade i ostala primanja'),
  payroll_fitpass: {
    pl_category: 'Zarade', pl_subcategory: 'FitPass',
    department: 'Opšti troškovi', dept_subcategory: 'Troškovi zaposlenih', expense_description: 'FitPass',
  },
  payroll_health_insurance: pl('Zarade', 'Privatno zdravstveno osiguranje'),
  payroll_penalty: {
    pl_category: 'Opšti troškovi poslovanja', pl_subcategory: 'Kazne i penali',
    department: 'Opšti troškovi', dept_subcategory: 'Opšti troškovi', expense_description: 'Kazne i penali',
  },
  credit_principal: {
    pl_category: 'Krediti', pl_subcategory: 'Otplata glavnice',
    department: 'Krediti', dept_subcategory: 'Bankarski krediti', expense_description: 'Glavnica',
  },
  credit_interest: {
    pl_category: 'Krediti', pl_subcategory: 'Kamata na kredite',
    department: 'Krediti', dept_subcategory: 'Bankarski krediti', expense_description: 'Kamata',
  },
  cashflow_banking: pl('Bankarski troškovi', ''),
  cashflow_taxes: pl('Porezi', ''),
}

/** The same rows as `system_categories` holds them, for a mocked table. */
export function testSystemCategoryRows(companyId = 'c1') {
  return Object.entries(TEST_SYSTEM_CATEGORIES).map(([role, c]) => ({
    id: `sc-${role}`, company_id: companyId, role, ...c,
  }))
}
