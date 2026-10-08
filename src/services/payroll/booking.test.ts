import { cashFlowTypeFor, endOfMonth, unknownNames } from './booking'
import * as booking from './booking'

describe('the salary chain', () => {
  it('names no P&L heading of its own any more', () => {
    // The headings are the owner's, from the system categories. A Mintflow
    // name left in this module would be a heading MCFlow's P&L never has.
    for (const k of ['PL_CATEGORY', 'SUBCATEGORY', 'SALARY_DEPT_SUBCATEGORY',
      'OTHER_INCOME_SUBCATEGORY', 'SALARY_DEPARTMENTS']) {
      expect((booking as any)[k]).toBeUndefined()
    }
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
