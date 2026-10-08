import {
  PL_CATEGORY, SUBCATEGORY, SALARY_DEPT_SUBCATEGORY, OTHER_INCOME_SUBCATEGORY, SALARY_DEPARTMENTS,
  cashFlowTypeFor, endOfMonth, unknownNames,
} from './booking'

describe('the salary chain', () => {
  it('books every part under one P&L category', () => {
    expect(PL_CATEGORY).toBe('Employee and Labour')
  })

  it('names a sub-category per component, so nobody has to choose one', () => {
    // The component decides it. A dropdown here would be a chance to file the
    // employer's contributions under the employee's, which nothing downstream
    // would question.
    expect(SUBCATEGORY.net).toBe('Net Salaries')
    expect(SUBCATEGORY.tax).toBe('Tax on salary')
    expect(SUBCATEGORY.employee).toBe('Contributions on behalf of the employee')
    expect(SUBCATEGORY.employer).toBe('Contributions on behalf of the employer')
  })

  it('puts every salary under the same department sub-category', () => {
    expect(SALARY_DEPT_SUBCATEGORY).toBe('Salary expenses domestic')
  })

  it('spells the departments the way the ledger does, not the way people say them', () => {
    // Read off the real `departments` table. Capital E on Expenses, and
    // "Office & Administration" has no "expenses" on the end at all — which
    // is what rolled the first unit-mapping migration back.
    expect(SALARY_DEPARTMENTS).toContain('Development Expenses')
    expect(SALARY_DEPARTMENTS).toContain('Office & Administration')
    expect(SALARY_DEPARTMENTS).toContain('Shareholder Expenses')
    expect(SALARY_DEPARTMENTS).not.toContain('Office & Administration expenses' as any)
  })
})

describe('the other-income chain', () => {
  it('is not filed among the net salaries', () => {
    // An addition paid outside the salary is not a salary, and the people
    // reading Net Salaries are looking for wages.
    expect(OTHER_INCOME_SUBCATEGORY).toBe('Renumeration, allowances and other benefits')
    expect(Object.values(SUBCATEGORY)).not.toContain(OTHER_INCOME_SUBCATEGORY as any)
  })
})

describe('endOfMonth', () => {
  it('finds the last day of a month, February included', () => {
    expect(endOfMonth('2026-09')).toBe('2026-09-30')
    expect(endOfMonth('2026-02')).toBe('2026-02-28')
    expect(endOfMonth('2028-02')).toBe('2028-02-29')
  })
})

describe('cashFlowTypeFor', () => {
  it('is recurring for somebody still employed', () => {
    expect(cashFlowTypeFor({ left_on: null }, '2026-09-30')).toBe('recurring')
  })

  it('makes the month somebody leaves in a one-off', () => {
    // The month they leave is still paid, and it is the LAST one. Leaving it
    // recurring has the forecast predict their salary every month afterwards,
    // silently, for as long as it runs.
    expect(cashFlowTypeFor({ left_on: '2026-09-12' }, '2026-09-30')).toBe('one_time')
  })

  it('is still recurring in a month before they leave', () => {
    expect(cashFlowTypeFor({ left_on: '2026-12-31' }, '2026-09-30')).toBe('recurring')
  })

  it('treats leaving on the last day of the month as that month being the last', () => {
    expect(cashFlowTypeFor({ left_on: '2026-09-30' }, '2026-09-30')).toBe('one_time')
  })
})

describe('unknownNames', () => {
  const known = {
    plSubcategories: ['Net Salaries', 'Transportation cost'],
    departments: ['Development expenses', 'General Business expenses'],
    deptSubcategories: ['Salary expenses domestic', 'Labour related expenses'],
  }

  it('is happy when every name is one the ledger already has', () => {
    expect(unknownNames([
      { pl_subcategory: 'Net Salaries', department: 'Development expenses',
        dept_subcategory: 'Salary expenses domestic' },
    ], known)).toEqual([])
  })

  it('catches a near miss rather than creating a second heading', () => {
    // The worst outcome available: a trailing space makes a heading one
    // character from the real one, and the P&L shows both, each with part of
    // the payroll in it.
    const missing = unknownNames([
      { pl_subcategory: 'Net Salaries', department: 'Development expenses',
        dept_subcategory: 'Salary expenses domestic ' },
    ], known)
    expect(missing).toHaveLength(1)
    expect(missing[0]).toContain('Salary expenses domestic ')
  })

  it('reports each unknown name once, however many rows used it', () => {
    const rows = Array.from({ length: 5 }, () => ({
      pl_subcategory: 'Net Salaries', department: 'Marketing expenses',
      dept_subcategory: 'Salary expenses domestic',
    }))
    expect(unknownNames(rows, known)).toEqual(['sektor "Marketing expenses"'])
  })

  it('does not complain about a field nobody filled in', () => {
    // The obligation parent has no department on purpose.
    expect(unknownNames([
      { pl_subcategory: 'Net Salaries', department: null, dept_subcategory: null },
    ], known)).toEqual([])
  })
})

describe('every name this module posts to exists in the ledger', () => {
  // Read off the real tables on 2026-09-23. This is the one test that would
  // catch somebody renaming a heading in Settings and quietly splitting the
  // payroll across the old one and the new.
  const LEDGER = {
    plSubcategories: [
      'Contributions on behalf of the employee', 'Contributions on behalf of the employer',
      'Education and training of employees', 'Employee participation in benefits',
      'Expenses for Financing Disability Funds', 'FitPass expenses',
      'Health care expenses paid by employer', 'Health care expenses paid by the employer',
      'Net Salaries', 'Private Health insurance',
      'Renumeration, allowances and other benefits', 'Salary Expenses Abroad',
      'Tax on salary', 'Team Building expenses', 'Transportation cost',
      'Warm Meal expenses',
    ],
    departments: [
      'CS Expenses', 'Design Expenses', 'Development Expenses', 'General Business Expenses',
      'Loans/Credits/Dividend', 'Marketing Expenses', 'Office & Administration',
      'Product Expenses', 'Sales Expenses', 'Shareholder Expenses',
    ],
    deptSubcategories: [
      'Salary expenses abroad', 'Salary expenses domestic', 'Labour related expenses',
    ],
  }

  it('has every salary sub-category', () => {
    for (const sub of Object.values(SUBCATEGORY)) {
      expect(LEDGER.plSubcategories).toContain(sub)
    }
  })

  it('has the salary department sub-category', () => {
    expect(LEDGER.deptSubcategories).toContain(SALARY_DEPT_SUBCATEGORY)
  })

  it('has every department a salary may be allocated to', () => {
    for (const d of SALARY_DEPARTMENTS) expect(LEDGER.departments).toContain(d)
  })

  it('has the other-income sub-category', () => {
    expect(LEDGER.plSubcategories).toContain(OTHER_INCOME_SUBCATEGORY)
  })
})
