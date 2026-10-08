import { runsFor, grandTotal, RUN_LABELS, type RunInput } from './runs'
import { RATES_2026, splitContractedNet } from './engine'
import { emptyTimesheet, type TimesheetRow } from './timesheets'
import type { EmployeeForMonth, EmployeeRow, ContractRow, DeductionRow } from './employees'

const COEF = 0.004
const FUND = 168

/**
 * The coefficients as seeded, by settings key.
 *
 * Passed in on purpose rather than defaulted: a category the settings do not
 * price is worth nothing, because a coefficient guessed at is a salary guessed
 * at. Every test that expects leave to be paid has to say what it is paid at.
 */
const COEFFICIENTS: Record<string, number> = {
  drzavni_i_verski_praznik: 1,
  godisnji_odmor: 1,
  bolovanje_na_teret_poslodavca: 0.65,
  bolovanje_na_teret_poslodavca_pun_fond: 1,
  trudnicko_bolovanje_na_teret_poslodavca: 1,
  placeno_odsustvo: 1,
  vojni_ili_sudski_poziv: 1,
  verski_praznik: 1,
  prekid_rada: 0.6,
  izostanak_sa_rada: 0,
  nedokumentovani_sati: 0,
  udaljenje_sa_posla_samac: 0.25,
  udaljenje_sa_posla_izdrzava_porodicu: 0.3333,
}


const employee = (over: Partial<EmployeeRow> = {}): EmployeeRow => ({
  id: 'e1', company_id: 'c1', code: 'E002', full_name: 'Gavrilov Dejan',
  organisational_unit: 'UPR', hired_on: null, seniority_from: '2020-03-04',
  left_on: null, note: null, deleted_at: null, ...over,
})

const contract = (over: Partial<ContractRow> = {}): ContractRow => ({
  id: 'k1', employee_id: 'e1', valid_from: '2026-08-01', valid_to: null,
  currency: 'EUR', net_amount: 1000, service_years: null,
  note: null, ...over,
})

const person = (over: Partial<EmployeeForMonth> = {}): EmployeeForMonth => {
  const e = over.employee ?? employee()
  const c = over.contract ?? contract()
  return {
    employee: e, contract: c,
    net: splitContractedNet(117358.60, 6, COEF),
    deductions: [], allocation: null,
    serviceYears: 6, serviceYearsDerived: true,
    ...over,
  }
}

const sheet = (over: Partial<TimesheetRow> = {}): TimesheetRow =>
  ({ ...emptyTimesheet('e1', '2026-08'), ...over })

const input = (over: Partial<RunInput> = {}): RunInput => ({
  people: [person()],
  timesheets: { e1: sheet({ regular_hours: FUND }) },
  rates: RATES_2026, monthHours: FUND,
  currencyRates: { EUR: 117.3586 },
  coefficients: COEFFICIENTS,
  ...over,
})

const run = (r: ReturnType<typeof runsFor>, key: string) =>
  r.runs.find(x => x.key === key)!

describe('a whole month of work', () => {
  it('reproduces the August gross MPP produced', () => {
    // The one end-to-end check that matters: roster in, runs out, and the
    // figure has to be the accountant's. 117,358.60 contracted net over a full
    // 168-hour month grosses to 162,819.54 in the real export.
    const r = runsFor(input())
    const salaries = run(r, 'regular')
    expect(salaries.salaries).toHaveLength(1)
    expect(salaries.salaries[0].line.gross).toBeCloseTo(162819.54, 2)
    expect(r.problems).toEqual([])
  })

  it('costs the gross plus the employer’s contributions', () => {
    const salaries = run(runsFor(input()), 'regular')
    // Within a cent, because the engine rounds once at the end while these
    // components are each rounded on the way out.
    const rebuilt = salaries.totals.gross + salaries.totals.employerContributions
    expect(Math.round(Math.abs(salaries.totals.totalCost - rebuilt) * 100)).toBeLessThanOrEqual(1)
  })
})

describe('a month of work and annual leave', () => {
  const mixed = runsFor(input({
    timesheets: { e1: sheet({ regular_hours: 100, vacation_hours: 68 }) },
  }))

  it('produces one line for the person, carrying both', () => {
    const lines = run(mixed, 'regular').salaries
    expect(lines.map(s => s.name)).toEqual(['Gavrilov Dejan'])
    expect(lines[0].categories.map(c => c.field)).toEqual(['regular_hours', 'vacation_hours'])
  })

  it('pays the same as a month of work, since leave is paid at 1', () => {
    const whole = grandTotal(runsFor(input()).runs).net
    expect(grandTotal(mixed.runs).net).toBeCloseTo(whole, 2)
  })

  it('carries the whole tax-free allowance, and no more', () => {
    const line = run(mixed, 'regular').salaries[0].line
    expect(line.taxFreeForPeriod).toBeCloseTo(RATES_2026.taxFreeAmount, 2)
  })
})

describe('who lands in which run', () => {
  it('puts everybody in the one salary run', () => {
    const other = person({
      employee: employee({ id: 'e2', full_name: 'Đinić Dejan' }),
      contract: contract({ employee_id: 'e2' }),
    })
    const r = runsFor(input({
      people: [person(), other],
      timesheets: { e1: sheet({ regular_hours: FUND }), e2: sheet({ regular_hours: FUND }) },
    }))
    expect(run(r, 'regular').salaries).toHaveLength(2)
    expect(run(r, 'other').salaries).toEqual([])
  })

  it('names somebody with no timesheet instead of calculating them as zero', () => {
    const r = runsFor(input({ timesheets: {} }))
    expect(r.problems).toHaveLength(1)
    expect(r.problems[0].name).toBe('Gavrilov Dejan')
    expect(r.problems[0].why).toContain('No timesheet')
  })

  it('reports a month whose absence nothing has priced', () => {
    // The silence was the bug: sick leave is paid, just at a coefficient, so
    // saying nothing left a person unpaid on a screen that looked finished.
    const r = runsFor(input({
      timesheets: { e1: sheet({ sick_hours: FUND }) }, coefficients: {},
    }))
    expect(r.problems[0].why).toContain('sick leave')
    expect(grandTotal(r.runs).gross).toBe(0)
  })

  it('pays a month that was entirely ANNUAL leave', () => {
    // Unlike sick leave, this is paid at the contracted rate — and used to be
    // paid at nothing at all.
    const r = runsFor(input({ timesheets: { e1: sheet({ vacation_hours: FUND }) } }))
    expect(r.problems).toEqual([])
    expect(run(r, 'regular').salaries[0].line.net).toBeGreaterThan(100000)
  })
})

describe('deductions', () => {
  const loan = (over: Partial<DeductionRow> = {}): DeductionRow => ({
    id: 'd1', employee_id: 'e1', label: 'Fitpass', goes_to: 'employer',
    payee: null, amount: 1000, currency: 'RSD', percent_of_net: null,
    valid_from: '2023-01-01', valid_to: null, is_active: true, note: null, ...over,
  })

  it('takes them ONCE, in full, whatever the month was made of', () => {
    // A membership is a monthly arrangement, not a function of hours.
    // Prorating it by the hours worked would quietly deduct less in a month
    // with unpaid leave, and the line would look perfectly reasonable.
    const r = runsFor(input({
      people: [person({ deductions: [loan()] })],
      timesheets: { e1: sheet({ regular_hours: 100, unpaid_hours: 68 }) },
    }))
    const total = grandTotal(r.runs)
    expect(total.deductionsEmployer).toBe(1000)
  })

  it('keeps what leaves the company apart from what stays', () => {
    const r = runsFor(input({
      people: [person({ deductions: [
        loan({ id: 'a', goes_to: 'employer', amount: 1000 }),
        loan({ id: 'b', goes_to: 'third_party', amount: 2500 }),
      ] })],
    }))
    const t = grandTotal(r.runs)
    expect(t.deductionsEmployer).toBe(1000)
    expect(t.deductionsThirdParty).toBe(2500)
  })

  it('converts a euro deduction at the rate of the month', () => {
    const r = runsFor(input({
      people: [person({ deductions: [loan({ amount: 57.80, currency: 'EUR' })] })],
    }))
    expect(grandTotal(r.runs).deductionsEmployer).toBeCloseTo(57.80 * 117.3586, 2)
  })

  it('leaves out a euro deduction with no rate, and says so by name', () => {
    // Left out rather than converted at a guess: the salary is still right,
    // and the page has to be able to say what is not.
    const r = runsFor(input({
      people: [person({ deductions: [loan({ amount: 57.80, currency: 'EUR' })] })],
      currencyRates: {},
    }))
    expect(grandTotal(r.runs).deductionsEmployer).toBe(0)
    expect(r.problems[0].why).toContain('no rate for this month')
  })

  it('skips one that has been switched off', () => {
    const r = runsFor(input({
      people: [person({ deductions: [] })],
    }))
    expect(grandTotal(r.runs).deductionsEmployer).toBe(0)
  })
})

describe('the runs', () => {
  it('always returns all of them, in order, even when empty', () => {
    // A page that renders what it is given should not have to guess whether a
    // run with nobody in it exists.
    const r = runsFor(input({ people: [], timesheets: {} }))
    expect(r.runs.map(x => x.key)).toEqual(['regular', 'other'])
    expect(r.runs.map(x => x.label)).toEqual([RUN_LABELS.regular, RUN_LABELS.other])
  })

  it('keeps Other income apart from the salaries', () => {
    // It is taxed once and carries no contributions, so an addition that is
    // not a salary gets its own run rather than being folded in.
    const r = runsFor(input({ people: [], timesheets: {} }))
    expect(RUN_LABELS.other).toBe('Other income')
    expect(r.runs.find(x => x.key === 'other')).toBeTruthy()
  })

  it('adds up to what the month costs', () => {
    const r = runsFor(input())
    const t = grandTotal(r.runs)
    expect(t.totalCost).toBeCloseTo(
      r.runs.reduce((sum, x) => sum + x.totals.totalCost, 0), 2)
  })
})
