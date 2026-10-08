import {
  obligationRows, obligationTotal, unallocatedTotal, employeesMissingDepartment,
  SUBCATEGORY, EmployeeObligation,
} from './payrollAllocation'
import { buildTree, UNASSIGNED, PlEntry } from './expenseTree'

const emp = (o: Partial<EmployeeObligation> & { employee_name: string }): EmployeeObligation => ({
  department_name: 'Development Expenses',
  dept_subcategory_name: 'Engineering',
  tax: 0, contributionsEmployee: 0, contributionsEmployer: 0,
  ...o,
})

const two = [
  emp({ employee_name: 'Ana Ilić', tax: 120.50, contributionsEmployee: 340.10, contributionsEmployer: 410.00 }),
  emp({ employee_name: 'Marko Petrović', department_name: 'Sales Expenses', dept_subcategory_name: 'Field',
        tax: 95.25, contributionsEmployee: 280.00, contributionsEmployer: 330.40 }),
]

describe('obligationRows', () => {
  it('makes one row per employee per component that has money in it', () => {
    expect(obligationRows(two)).toHaveLength(6)
  })

  it('carries the employee department onto every row', () => {
    for (const r of obligationRows(two)) {
      expect(r.department).not.toBeNull()
      expect(r.dept_subcategory).not.toBeNull()
    }
    expect(unallocatedTotal(obligationRows(two))).toBe(0)
  })

  it('names the row after the employee, so the department branch groups by person', () => {
    const ana = obligationRows(two).filter(r => r.expense_description === 'Ana Ilić')
    expect(ana).toHaveLength(3)
    expect(ana.map(r => r.pl_subcategory).sort())
      .toEqual([SUBCATEGORY.employer, SUBCATEGORY.employee, SUBCATEGORY.tax].sort())
  })

  it('skips a component the employee does not have', () => {
    const rows = obligationRows([emp({ employee_name: 'Solo', tax: 50 })])
    expect(rows).toHaveLength(1)
    expect(rows[0].pl_subcategory).toBe(SUBCATEGORY.tax)
  })

  it('adds up to the sum of the components', () => {
    expect(obligationTotal(obligationRows(two))).toBeCloseTo(
      120.50 + 340.10 + 410.00 + 95.25 + 280.00 + 330.40, 2)
  })

  it('leaves an employee with no department visible as unallocated rather than hiding it', () => {
    const rows = obligationRows([emp({ employee_name: 'No dept', department_name: null, tax: 75 })])
    expect(rows[0].department).toBeNull()
    expect(unallocatedTotal(rows)).toBe(75)
  })
})

describe('the filing rounding adjustment', () => {
  it('goes into the largest employer-contribution row, not a row of its own', () => {
    // A row of its own would have no employee and therefore no department,
    // which is the exact problem this function exists to remove.
    const rows = obligationRows(two, 3.33)
    expect(rows).toHaveLength(6)
    const carrier = rows.find(r => r.carriesRounding)!
    expect(carrier.component).toBe('employer')
    expect(carrier.employee_name).toBe('Ana Ilić')     // 410.00 is the largest
    expect(carrier.amount).toBeCloseTo(413.33, 2)
  })

  it('makes the total match the payable exactly', () => {
    const base = 120.50 + 340.10 + 410.00 + 95.25 + 280.00 + 330.40
    for (const r of [0, 0.01, -0.02, 3.33, -12.5]) {
      expect(obligationTotal(obligationRows(two, r))).toBeCloseTo(base + r, 2)
    }
  })

  it('falls back to the largest row when nobody has an employer contribution', () => {
    const rows = obligationRows([emp({ employee_name: 'Tax only', tax: 100 })], 5)
    expect(rows).toHaveLength(1)
    expect(rows[0].amount).toBe(105)
  })

  it('does nothing when there is nothing to round', () => {
    expect(obligationRows([], 4)).toEqual([])
    expect(obligationRows(two).some(r => r.carriesRounding)).toBe(false)
  })
})

describe('what the expense report then shows', () => {
  const asEntry = (r: ReturnType<typeof obligationRows>[number]): PlEntry => ({
    tx_type: 'invoice_expense', pl_date: '2026-08-31', amount_usd: r.amount,
    pl_category: 'Employee and Labour', pl_subcategory: r.pl_subcategory,
    department: r.department, dept_subcategory: r.dept_subcategory,
    expense_description: r.expense_description,
  })

  it('leaves nothing under Unassigned', () => {
    const entries = obligationRows(two, 1.11).map(asEntry)
    const dept = buildTree(entries, 'department')
    expect(dept.map(n => n.label)).not.toContain(UNASSIGNED)
  })

  it('groups an employee onto one line in the department branch', () => {
    const entries = obligationRows(two).map(asEntry)
    const leaves = buildTree(entries, 'department')
      .flatMap(n => n.children).flatMap(n => n.children)
    expect(leaves.map(l => l.label).sort()).toEqual(['Ana Ilić', 'Marko Petrović'])
    expect(leaves.find(l => l.label === 'Ana Ilić')!.amount).toBeCloseTo(870.60, 2)
  })

  it('still separates the components in the P&L branch', () => {
    const entries = obligationRows(two).map(asEntry)
    const subs = buildTree(entries, 'pl')[0].children.map(c => c.label).sort()
    expect(subs).toEqual([SUBCATEGORY.employer, SUBCATEGORY.employee, SUBCATEGORY.tax].sort())
  })

  it('both branches tie', () => {
    const entries = obligationRows(two, 2.5).map(asEntry)
    const total = (b: 'pl' | 'department') =>
      buildTree(entries, b).reduce((s, n) => s + n.amount, 0)
    expect(total('pl')).toBeCloseTo(total('department'), 6)
  })
})

describe('employeesMissingDepartment', () => {
  it('names anyone who would post without a department', () => {
    expect(employeesMissingDepartment([
      { employee_name: 'Ana Ilić', department_name: 'Sales Expenses' },
      { employee_name: 'Marko Petrović', department_name: null },
      { employee_name: 'Jelena Milosavljević', department_name: '   ' },
    ])).toEqual(['Marko Petrović', 'Jelena Milosavljević'])
  })

  it('says nothing when everyone is placed', () => {
    expect(employeesMissingDepartment([
      { employee_name: 'Ana', department_name: 'Sales Expenses' },
    ])).toEqual([])
  })

  it('still reports a nameless row rather than dropping it', () => {
    expect(employeesMissingDepartment([{ employee_name: '', department_name: '' }]))
      .toEqual(['(unnamed)'])
  })
})
