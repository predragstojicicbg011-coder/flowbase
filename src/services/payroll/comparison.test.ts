import {
  previousMonth, lastRegular, compareRuns, percentChange, peopleDifference,
} from './comparison'
import type { SavedRun, SavedRunLine } from './savedRuns'
import type { PayrollRun } from './runs'

// Osoba A to Osoba E, codes E-001 to E-005, invented round figures.

const kept = (over: Partial<SavedRun>): SavedRun => ({
  id: 'r1', company_id: 'c1', period_month: '2026-10-01', run_key: 'regular',
  label: 'Zarade', status: 'draft', exchange_rate: 117, eur_rate: 117, month_hours: 168,
  gross: 0, net: 0, income_tax: 0, contributions_employee: 0, contributions_employer: 0,
  total_cost: 0, deductions_third_party: 0, deductions_employer: 0,
  calculated_at: '', posted_at: null, note: null, kind: 'regular', ...over,
})

const totals = (over: Partial<PayrollRun['totals']> = {}): PayrollRun['totals'] => ({
  gross: 0, net: 0, incomeTax: 0, employeeContributions: 0, employerContributions: 0,
  totalCost: 0, deductionsThirdParty: 0, deductionsEmployer: 0, ...over,
})

const salary = (id: string, name: string, code: string | null, totalCost: number) => ({
  employeeId: id, name, code, hours: 168, monthHours: 168, categories: [],
  contractedNet: 0, seniorityNet: 0, additions: [], deductions: { thirdParty: 0, employer: 0, total: 0 },
  line: { totalCost } as any,
})
const other = (id: string, name: string, code: string | null, totalCost: number) => ({
  employeeId: id, name, code, line: { totalCost } as any,
})

const run = (key: PayrollRun['key'], over: Partial<PayrollRun> = {}): PayrollRun => ({
  key, label: key === 'regular' ? 'Zarade' : 'Ostala primanja', salaries: [], otherIncome: [],
  totals: totals(), ...over,
})

const line = (over: Partial<SavedRunLine>): SavedRunLine => ({
  employee_id: null, employee_code: null, employee_name: '', department: null,
  line_kind: 'salary', label: null, hours: 0, month_hours: 0,
  contracted_net: 0, seniority_net: 0, additional_net: 0, service_years: null,
  gross: 0, contribution_base: 0, tax_free: 0, tax_base: 0, income_tax: 0,
  pension_employee: 0, health_employee: 0, unemployment_employee: 0,
  pension_employer: 0, health_employer: 0, unemployment_employer: 0,
  net: 0, total_cost: 0, deductions_third_party: 0, deductions_employer: 0,
  detail: null, ...over,
})

describe('last month', () => {
  it('is the month before, across a year', () => {
    expect(previousMonth('2026-11')).toBe('2026-10')
    expect(previousMonth('2027-01')).toBe('2026-12')
  })

  it('a month with one preliminary run is not last month\'s regular', () => {
    expect(lastRegular([kept({ id: 'a' }), kept({ id: 'b', run_key: 'other', kind: 'preliminary' })])).toBeNull()
    expect(lastRegular([])).toBeNull()
    const both = [kept({ id: 'a' }), kept({ id: 'b', run_key: 'other', kind: undefined })]
    expect(lastRegular(both)).toEqual(both)
  })
})

describe('per run and in total', () => {
  it('per run and in total, with no subsidy anywhere', () => {
    const live = [
      run('regular', { salaries: [salary('e1', 'Osoba A', 'E-001', 2000)] as any,
        totals: totals({ totalCost: 2000, net: 1400, incomeTax: 100, employeeContributions: 200,
          employerContributions: 300 }) }),
      run('other'),
    ]
    const last = [
      kept({ id: 'k1', run_key: 'regular', total_cost: 1800, net: 1300,
        income_tax: 90, contributions_employee: 180, contributions_employer: 230 }),
      kept({ id: 'k2', run_key: 'other', label: 'Ostala primanja', total_cost: 100, net: 90,
        income_tax: 10 }),
    ]
    const r = compareRuns(live, last)
    expect(r.runs.map(x => x.key)).toEqual(['regular', 'other'])
    expect(r.runs[0]).toEqual({
      key: 'regular', label: 'Zarade',
      now: { totalCost: 2000, net: 1400, taxAndContributions: 600 },
      then: { totalCost: 1800, net: 1300, taxAndContributions: 500 },
    })
    expect(r.runs[1]).toEqual({
      key: 'other', label: 'Ostala primanja',
      now: { totalCost: 0, net: 0, taxAndContributions: 0 },
      then: { totalCost: 100, net: 90, taxAndContributions: 10 },
    })
    expect(r.total).toEqual({
      now: { totalCost: 2000, net: 1400, taxAndContributions: 600 },
      then: { totalCost: 1900, net: 1390, taxAndContributions: 510 },
    })
  })

  it('a run with nobody now and nothing kept then is left out; one kept for nobody now is not', () => {
    const r = compareRuns([run('regular', { salaries: [salary('e1', 'Osoba A', 'E-001', 1)] as any }), run('other')],
      [kept({ run_key: 'regular' })])
    expect(r.runs.map(x => x.key)).toEqual(['regular'])
  })

  it('percent is null against nothing', () => {
    expect(percentChange(110, 100)).toBe(10)
    expect(percentChange(90, 100)).toBe(-10)
    expect(percentChange(50, 0)).toBeNull()
    expect(percentChange(0, 0)).toBeNull()
    expect(percentChange(-50, -100)).toBe(50)
    expect(percentChange(0, 100)).toBe(-100)
  })
})

describe('who makes the difference', () => {
  it('people are matched by id across runs, then by code, never by name', () => {
    const live = [
      run('regular', { salaries: [
        salary('e1', 'Osoba A', 'E-001', 1000),
        salary('e2', 'Osoba B', 'E-002', 500),
        salary('e3', 'Osoba C', 'E-003', 400),
      ] as any }),
      run('other', { otherIncome: [other('e1', 'Osoba A — Bonus A', 'E-001', 50)] as any }),
    ]
    const lines = [
      line({ employee_id: 'e1', employee_code: 'E-001', employee_name: 'Osoba A', total_cost: 900 }),
      line({ employee_id: 'e1', employee_code: 'E-001', employee_name: 'Osoba A — Bonus A', total_cost: 50,
        line_kind: 'other', label: 'Ostala primanja' }),
      line({ employee_id: null, employee_code: 'E-002', employee_name: 'Osoba B', total_cost: 500 }),
      // Same name as somebody this month, but another person.
      line({ employee_id: 'e9', employee_code: 'E-009', employee_name: 'Osoba C', total_cost: 300 }),
    ]
    const d = peopleDifference(live, lines)
    expect(d.changed).toEqual([
      { key: 'e1', name: 'Osoba A', code: 'E-001', now: 1050, then: 950, difference: 100 },
    ])
    expect(d.joined).toEqual([
      { key: 'e3', name: 'Osoba C', code: 'E-003', now: 400, then: 0, difference: 400 },
    ])
    expect(d.left).toEqual([
      { key: 'e9', name: 'Osoba C', code: 'E-009', now: 0, then: 300, difference: -300 },
    ])
  })

  it('the largest difference first, and a line with neither id nor code stands alone', () => {
    const live = [run('regular', { salaries: [
      salary('e1', 'Osoba A', 'E-001', 110),
      salary('e2', 'Osoba B', 'E-002', 50),
      salary('e3', 'Osoba C', 'E-003', 100),
      salary('e4', 'Osoba D', 'E-004', 10),
    ] as any })]
    const lines = [
      line({ employee_id: 'e1', employee_name: 'Osoba A', total_cost: 100 }),
      line({ employee_id: 'e2', employee_name: 'Osoba B', total_cost: 100 }),
      line({ employee_id: 'e3', employee_name: 'Osoba C', total_cost: 100.004 }),
      line({ employee_id: null, employee_code: null, employee_name: 'Osoba E', total_cost: 20 }),
    ]
    const d = peopleDifference(live, lines)
    expect(d.changed.map(p => p.key)).toEqual(['e2', 'e1'])
    expect(d.joined.map(p => p.key)).toEqual(['e4'])
    expect(d.left).toEqual([
      { key: 'line:3', name: 'Osoba E', code: null, now: 0, then: 20, difference: -20 },
    ])
  })
})
