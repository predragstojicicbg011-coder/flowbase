import {
  additionsFor, amountInDinars, unconvertible, totalsFor,
  treatmentLabel, kindLabel, TREATMENTS, KINDS, type AdditionRow,
} from './additions'
import { runsFor, type RunInput } from './runs'
import { salaryLine, splitContractedNet, RATES_2026 } from './engine'
import { emptyTimesheet, type TimesheetRow } from './timesheets'
import type { EmployeeForMonth, EmployeeRow, ContractRow } from './employees'

const MONTH = '2026-09'
const FUND = 176
const RATE = 117.4007

const addition = (over: Partial<AdditionRow> = {}): AdditionRow => ({
  id: 'x1', employee_id: 'e1', month: '2026-09-01', kind: 'bonus',
  label: 'Quarterly bonus', treatment: 'salary', amount: 50000,
  currency: 'RSD', note: null, ...over,
})

describe('additionsFor', () => {
  it('takes the ones for that person in that month', () => {
    const rows = [
      addition({ id: 'a' }),
      addition({ id: 'b', month: '2026-08-01' }),
      addition({ id: 'c', employee_id: 'e2' }),
    ]
    expect(additionsFor(rows, 'e1', MONTH).map(a => a.id)).toEqual(['a'])
  })

  it('reads a month written either way', () => {
    expect(additionsFor([addition()], 'e1', '2026-09-01')).toHaveLength(1)
  })
})

describe('amountInDinars', () => {
  it('leaves a dinar amount alone', () => {
    expect(amountInDinars(addition({ amount: 50000 }))).toBe(50000)
  })

  it('converts a euro bonus at the rate of the month', () => {
    // The same rule a euro contract and a euro deduction already follow.
    expect(amountInDinars(addition({ currency: 'EUR', amount: 500 }), { EUR: RATE }))
      .toBeCloseTo(500 * RATE, 2)
  })

  it('comes to nothing, not to a guess, when the rate is unknown', () => {
    expect(amountInDinars(addition({ currency: 'EUR', amount: 500 }), {})).toBe(0)
    expect(unconvertible([addition({ currency: 'EUR' })], {})).toHaveLength(1)
    expect(unconvertible([addition()], {})).toHaveLength(0)
  })
})

describe('totalsFor', () => {
  it('keeps the three treatments apart, because they cost different amounts', () => {
    const t = totalsFor([
      addition({ id: 'a', treatment: 'salary', amount: 50000 }),
      addition({ id: 'b', treatment: 'other_income', amount: 20000 }),
      addition({ id: 'c', treatment: 'non_taxable', amount: 10000 }),
    ])
    expect(t.salary).toBe(50000)
    expect(t.otherIncome).toBe(20000)
    expect(t.nonTaxable).toBe(10000)
    expect(t.total).toBe(80000)
  })
})

describe('the labels', () => {
  it('names every treatment and every kind in English', () => {
    for (const t of TREATMENTS) expect(treatmentLabel(t.value)).toBe(t.label)
    for (const k of KINDS) expect(kindLabel(k.value)).toBe(k.label)
  })

  it('says what each treatment actually does to the money', () => {
    const salary = TREATMENTS.find(t => t.value === 'salary')!
    expect(salary.detail).toContain('doprinosi')
    expect(TREATMENTS.find(t => t.value === 'other_income')!.detail).toContain('bez doprinosa')
  })
})

// ─── In a run ───────────────────────────────────────────────────────────────

const employee = (over: Partial<EmployeeRow> = {}): EmployeeRow => ({
  id: 'e1', company_id: 'c1', code: 'E003', full_name: 'Popović Vladimir',
  organisational_unit: 'GRAD', hired_on: null, seniority_from: '2022-03-01',
  left_on: null, note: null, deleted_at: null, ...over,
})

const contract = (over: Partial<ContractRow> = {}): ContractRow => ({
  id: 'k1', employee_id: 'e1', valid_from: '2026-09-01', valid_to: null,
  currency: 'EUR', net_amount: 2600, service_years: null,
  note: null, ...over,
})

const person = (over: Partial<EmployeeForMonth> = {}): EmployeeForMonth => ({
  employee: employee(), contract: contract(),
  net: splitContractedNet(Math.round(2600 * RATE * 100) / 100, 4, 0.004),
  deductions: [], allocation: null,
  serviceYears: 4, serviceYearsDerived: true, ...over,
})

const sheet = (over: Partial<TimesheetRow> = {}): TimesheetRow =>
  ({ ...emptyTimesheet('e1', MONTH), ...over })

const input = (over: Partial<RunInput> = {}): RunInput => ({
  people: [person()],
  timesheets: { e1: sheet({ regular_hours: FUND }) },
  rates: RATES_2026, monthHours: FUND, month: MONTH,
  coefficients: { godisnji_odmor: 1 },
  ...over,
})

const run = (r: ReturnType<typeof runsFor>, key: string) => r.runs.find(x => x.key === key)!

describe('a bonus treated as salary', () => {
  const r = runsFor(input({ additions: [addition({ amount: 50000 })] }))
  const line = run(r, 'regular').salaries[0]

  it('joins the gross-up, so tax and contributions apply', () => {
    const without = salaryLine({ contractedNet: person().net.total,
      period: { monthHours: FUND, workedHours: FUND } }, RATES_2026)
    expect(line.line.net - without.net).toBeCloseTo(50000, 0)
    expect(line.line.gross).toBeGreaterThan(without.gross + 50000)
  })

  it('is carried on the line by name, for the payslip', () => {
    expect(line.additions.map(a => a.label)).toEqual(['Quarterly bonus'])
    expect(line.line.additionalNet).toBe(50000)
  })

  it('is NOT prorated by the hours worked', () => {
    // Fifty thousand is fifty thousand whether somebody worked the whole
    // month or half of it. Prorating would quietly halve a bonus for anybody
    // who took a fortnight off unpaid.
    const half = runsFor(input({
      timesheets: { e1: sheet({ regular_hours: 88, unpaid_hours: 88 }) },
      additions: [addition({ amount: 50000 })],
    }))
    expect(run(half, 'regular').salaries[0].line.additionalNet).toBe(50000)
  })
})

describe('an addition that is not salary', () => {
  it('goes to Other income, taxed once and with no contributions', () => {
    const r = runsFor(input({
      additions: [addition({ treatment: 'other_income', amount: 20000, label: 'Referral' })],
    }))
    const other = run(r, 'other')
    expect(other.otherIncome).toHaveLength(1)
    expect(other.otherIncome[0].name).toContain('Referral')
    expect(other.totals.incomeTax).toBeCloseTo(20000 / 0.9 * 0.10, 2)
    expect(other.totals.employeeContributions).toBe(0)
    expect(other.totals.employerContributions).toBe(0)
  })

  it('pays an untaxed one exactly as it stands', () => {
    const r = runsFor(input({
      additions: [addition({ treatment: 'non_taxable', amount: 10000, label: 'Damage' })],
    }))
    const other = run(r, 'other')
    expect(other.totals.net).toBeCloseTo(10000, 2)
    expect(other.totals.incomeTax).toBe(0)
    expect(other.totals.totalCost).toBeCloseTo(10000, 2)
  })

  it('does not touch the salary at all', () => {
    const r = runsFor(input({
      additions: [addition({ treatment: 'non_taxable', amount: 10000 })],
    }))
    expect(run(r, 'regular').salaries[0].line.additionalNet).toBe(0)
  })
})

describe('an addition in a currency with no rate', () => {
  it('is left out and reported, rather than converted at a guess', () => {
    const r = runsFor(input({
      additions: [addition({ currency: 'EUR', amount: 500 })],
      currencyRates: {},
    }))
    expect(r.problems[0].why).toContain('bez kursa za ovaj mesec')
    expect(r.problems[0].why).toContain('veće od prikazanog')
    expect(run(r, 'regular').salaries[0].line.additionalNet).toBe(0)
  })
})

describe('a month with no additions at all', () => {
  it('is exactly the month it was before any of this', () => {
    const r = runsFor(input())
    expect(run(r, 'regular').salaries[0].line.additionalNet).toBe(0)
    expect(run(r, 'other').otherIncome).toEqual([])
    expect(run(r, 'other').totals.totalCost).toBe(0)
  })
})
