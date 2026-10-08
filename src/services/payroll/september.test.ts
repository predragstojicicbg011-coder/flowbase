// ─── September 2026, against the spreadsheet that has been doing this ────────
//
// The month is taken from the owner's own working spreadsheet and from the
// five department timesheet exports behind it. It is here because something
// this module had wrong was only visible by comparing against a real month:
//
//   PAID LEAVE IS PAID. It was being left out of the salary altogether, so
//   anybody who took a holiday was paid for the days they worked and nothing
//   else. Tomić Zoran had seven days off in September and would have
//   been short about 113,000 dinars of gross.
//
// Some people's months were laid out on the sheet as two periods. Their
// figures are checked here period by period through the engine — the gross,
// the charges and the net of a period stand on their own — and their month
// through `runsFor` only for what a month must add up to.

import { runsFor, grandTotal, type RunInput } from './runs'
import {
  salaryLine, splitContractedNet, chargesOn, grossFromNet, contributionBase,
  RATES_2026,
} from './engine'
import { emptyTimesheet, type TimesheetRow } from './timesheets'
import { payslipFor } from './payslip'
import type {
  EmployeeForMonth, EmployeeRow, ContractRow, DeductionRow,
} from './employees'

const FUND = 176
const RATE = 117.4007          // 1,000 EUR comes to 117,400.70
const MONTH = '2026-09'

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
  id: 'e1', company_id: 'c1', code: 'E003', full_name: 'Popović Vladimir',
  organisational_unit: 'GRAD - Gradilište', hired_on: null,
  seniority_from: '2022-03-01', left_on: null, note: null, deleted_at: null, ...over,
})

const contract = (over: Partial<ContractRow> = {}): ContractRow => ({
  id: 'k1', employee_id: 'e1', valid_from: '2026-09-01', valid_to: null,
  currency: 'EUR', net_amount: 2600, service_years: null,
  note: null, ...over,
})

const person = (eur: number, over: Partial<EmployeeForMonth> = {}): EmployeeForMonth => {
  const e = over.employee ?? employee()
  const c = over.contract ?? contract({ net_amount: eur })
  return {
    employee: e, contract: c,
    net: splitContractedNet(Math.round(eur * RATE * 100) / 100, 4, 0.004),
    deductions: [], allocation: null,
    serviceYears: 4, serviceYearsDerived: true, ...over,
  }
}

const sheet = (over: Partial<TimesheetRow> = {}): TimesheetRow =>
  ({ ...emptyTimesheet('e1', MONTH), ...over })

const input = (over: Partial<RunInput> = {}): RunInput => ({
  people: [person(2600)],
  timesheets: { e1: sheet({ regular_hours: 168, vacation_hours: 8 }) },
  rates: RATES_2026, monthHours: FUND, month: MONTH,
  coefficients: COEFFICIENTS,
  // Without it a euro deduction converts to nothing and the run says so —
  // which is correct, and not what any of these months are testing.
  currencyRates: { EUR: RATE },
  ...over,
})

const run = (r: ReturnType<typeof runsFor>, key: string) => r.runs.find(x => x.key === key)!

describe('Popović Vladimir — 168 hours worked, 8 on leave', () => {
  // His September figures are per period, from a month that split him across
  // two runs; they are checked through the engine below. Here, only what one
  // line for the month has to be.
  const r = runsFor(input())

  it('puts the worked hours and the LEAVE hours on one line', () => {
    // The correction. The eight hours of leave used to be paid to nobody.
    const line = run(r, 'regular').salaries[0]
    expect(line.hours).toBe(176)
    expect(run(r, 'regular').salaries).toHaveLength(1)
  })

  it('pays him the whole month', () => {
    // 2,600 EUR at 117.4007, plus the 200 of meal and holiday allowance.
    expect(run(r, 'regular').totals.net).toBeCloseTo(2600 * RATE + 200, 0)
  })
})

describe('a whole month of leave is still a whole month', () => {
  it('pays somebody who was on leave for all of it', () => {
    // The clearest case of the bug: no worked hours at all used to mean no
    // salary at all, for a person who was simply on holiday.
    const r = runsFor(input({ timesheets: { e1: sheet({ vacation_hours: FUND }) } }))
    expect(run(r, 'regular').salaries[0].line.net).toBeCloseTo(2600 * RATE + 200, 0)
  })
})

describe('one run, leave included', () => {
  it('matches Grašić Dejan — 120 worked, 56 on leave, one line', () => {
    const plain = person(1500, {
      employee: employee({ id: 'e1', full_name: 'Grašić Dejan' }),
      contract: contract({ net_amount: 1500 }),
    })
    const r = runsFor(input({
      people: [plain],
      timesheets: { e1: sheet({ regular_hours: 120, vacation_hours: 56 }) },
    }))
    expect(run(r, 'regular').salaries).toHaveLength(1)
    expect(run(r, 'regular').salaries[0].line.gross).toBeCloseTo(246617.62, 1)
  })
})

describe('sick leave is paid at the coefficient the settings state', () => {
  it('is worth 65% of its hours at the employer expense', () => {
    // Forty hours of sick leave are worth 26. Paying them as forty overstates
    // the month by a third of them; leaving them out, as this used to, pays
    // nothing for a week somebody was legitimately away.
    const r = runsFor(input({
      timesheets: { e1: sheet({ regular_hours: 136, sick_hours: 40 }) },
    }))
    expect(r.problems).toEqual([])
    expect(run(r, 'regular').salaries[0].hours).toBe(162)   // 136 + 40 × 0.65
  })

  it('pays the full-fund kind at its hours', () => {
    const r = runsFor(input({
      timesheets: { e1: sheet({ regular_hours: 136, sick_full_hours: 40 }) },
    }))
    expect(run(r, 'regular').salaries[0].hours).toBe(176)
  })

  it('pays nothing for the hours the fund carries', () => {
    // The settings have no coefficient for it precisely because this company
    // does not pay it.
    const r = runsFor(input({
      timesheets: { e1: sheet({ regular_hours: 136, sick_fund_hours: 40 }) },
    }))
    expect(r.problems).toEqual([])
    expect(run(r, 'regular').salaries[0].hours).toBe(136)
  })

  it('REFUSES to price a category the settings say nothing about', () => {
    const r = runsFor(input({
      timesheets: { e1: sheet({ regular_hours: 136, sick_hours: 40 }) },
      coefficients: {},
    }))
    expect(r.problems[0].why).toContain('do not price')
    expect(r.problems[0].why).toContain('sick leave, 65%')
    expect(run(r, 'regular').salaries[0].hours).toBe(136)
  })
})

describe('Gavrilov Dejan — the whole month worked', () => {
  it('reproduces the gross and the net the sheet reports', () => {
    const r = runsFor(input({
      people: [person(1000, { contract: contract({ net_amount: 1000 }) })],
      timesheets: { e1: sheet({ regular_hours: FUND }) },
    }))
    const line = run(r, 'regular').salaries[0].line
    expect(line.gross).toBeCloseTo(162879.60, 1)
    expect(line.net).toBeCloseTo(117600.70, 1)
  })
})

describe('the engine, used directly the way the sheet lays it out', () => {
  it('grosses two periods separately and they add back to the month', () => {
    // Popović Vladimir's two periods, as the sheet grossed them.
    const contracted = Math.round(2600 * RATE * 100) / 100
    const worked = salaryLine({ contractedNet: contracted,
      period: { monthHours: FUND, workedHours: 168 } }, RATES_2026)
    const leave = salaryLine({ contractedNet: contracted,
      period: { monthHours: FUND, workedHours: 8 } }, RATES_2026)
    expect(worked.gross).toBeCloseTo(411257.56, 1)
    expect(leave.gross).toBeCloseTo(19583.69, 1)
    expect(worked.net + leave.net).toBeCloseTo(contracted + 200, 0)
  })
})

describe('the whole month adds up', () => {
  it('leaves nothing unpaid when the hours reconcile', () => {
    const r = runsFor(input())
    expect(r.problems).toEqual([])
    expect(grandTotal(r.runs).totalCost).toBeGreaterThan(0)
  })
})

describe('Stevanović Strahinja — over the contribution ceiling', () => {
  // The one person at this company whose month passes 732,820. His September
  // is the whole reason the contribution base is a separate figure:
  //
  //   Gross 1            873,444.24 on 168 hours
  //   Contribution base  699,510.00   = 732,820 × 168/176
  //
  // Those two are the same number for everybody else. Charging his
  // contributions on the gross overstates them by about 35,000 dinars a
  // month, and nothing on the line would look wrong.
  //
  // The sheet calculated his month as two periods, 168 hours and 8, with the
  // ceiling split between them by hours. Each period is reproduced here
  // through the engine, handed the share of the ceiling the sheet used —
  // whether a ceiling applies at all is a fact about his whole month, which
  // `runsFor` decides and is checked on below.
  const CONTRACTED = 680924.06        // 5,800 EUR at 117.4007
  const period = (hours: number, max: number) => salaryLine({
    contractedNet: CONTRACTED,
    period: { monthHours: FUND, workedHours: hours },
    seniorityNet: splitContractedNet(CONTRACTED, 4, 0.004).seniority,
    baseLimits: { min: 0, max },
  }, RATES_2026)
  const worked = period(168, 699510)
  const leave = period(8, 33310)

  it('caps the base at its share of the ceiling', () => {
    expect(worked.contributionBase).toBeCloseTo(699510.00, 1)
    expect(leave.contributionBase).toBeCloseTo(33310.00, 1)
  })

  it('grosses him up against the capped base, not the free formula', () => {
    // Above the ceiling the contributions stop following the salary, so the
    // gross-up changes shape. The free formula gives 922,821 here — fifty
    // thousand dinars out, on a line that looks entirely ordinary.
    expect(worked.gross).toBeCloseTo(873444.24, 0)
    expect(leave.gross).toBeCloseTo(41592.58, 0)
  })

  it('charges every contribution on the base and the tax on the gross', () => {
    expect(worked.pensionEmployee).toBeCloseTo(97931.40, 0)      // 699,510 × 14%
    expect(worked.healthEmployee).toBeCloseTo(36024.77, 0)       // × 5.15%
    expect(worked.unemploymentEmployee).toBeCloseTo(5246.33, 0)  // × 0.75%
    expect(worked.pensionEmployer).toBeCloseTo(69951.00, 0)      // × 10%
    expect(worked.healthEmployer).toBeCloseTo(36024.77, 0)
    // The tax is on the gross less the tax-free part, which does not cap.
    expect(worked.incomeTax).toBeCloseTo(84077.87, 0)
  })

  it('pays him what the sheet paid him', () => {
    expect(worked.net).toBeCloseTo(650163.88, 0)
    expect(leave.net).toBeCloseTo(30960.18, 0)
    expect(worked.net + leave.net).toBeCloseTo(CONTRACTED + 200, 0)
  })

  it('costs what the sheet says the second period cost', () => {
    expect(leave.totalCost).toBeCloseTo(46639.05, 0)
  })

  describe('his month, as one run', () => {
    const strahinja = person(5800, {
      employee: employee({ id: 'e1', full_name: 'Stevanović Strahinja' }),
      contract: contract({ net_amount: 5800 }),
    })
    const r = runsFor(input({
      people: [strahinja],
      timesheets: { e1: sheet({ regular_hours: 168, vacation_hours: 8 }) },
    }))
    const line = run(r, 'regular').salaries[0].line

    it('caps the base at EXACTLY the monthly maximum', () => {
      // Which is what says the ceiling is a limit on his month: a whole
      // month's line is charged on the whole monthly figure.
      expect(line.contributionBase).toBeCloseTo(732820, 1)
    })

    it('still pays him the contracted month', () => {
      expect(line.net).toBeCloseTo(CONTRACTED + 200, 0)
    })
  })
})

describe('Milosavljević Đuro — under the ceiling, with a large one-off', () => {
  // September 2026, from his MPP payslip. He left on the 12th, worked 72 of
  // the month's 176 hours, and was paid 256,168.33 of compensation on top.
  //
  // THE CEILING MUST NOT TOUCH HIM. His gross comes to 569,091.70, which is
  // comfortably under the monthly 732,820, so MPP charges his contributions on
  // all of it. Prorating the ceiling by his hours gives 299,790 — and capping
  // him there understated his gross by 59,546 dinars, which is the bug this
  // test exists to keep out.
  const CONTRACTED = 352202.10        // 3,000 EUR at 117.4007
  const DAMAGES = 256168.33

  const djuro = person(3000, {
    employee: employee({ id: 'e1', full_name: 'Milosavljević Đuro', left_on: '2026-09-12' }),
    contract: contract({ net_amount: 3000 }),
    net: splitContractedNet(CONTRACTED, 3, 0.004),
    // 106.03 EUR of private health cover for his family, which his payslip
    // withholds as 12,448.00 at the month's rate.
    deductions: [{
      id: 'd1', employee_id: 'e1',
      label: 'Privatno zdravstveno osiguranje Sara i Ljiljana Milosavljević',
      goes_to: 'employer', payee: 'KALEMAR D.O.O.',
      amount: 106.03, currency: 'EUR', percent_of_net: null,
      valid_from: '2026-02-01', valid_to: '2026-09-12', is_active: true, note: null,
    }],
  })
  const r = runsFor(input({
    people: [djuro],
    timesheets: { e1: sheet({ regular_hours: 72 }) },
    additions: [{
      id: 'x1', employee_id: 'e1', month: '2026-09-01', kind: 'damages',
      label: 'Compensation for damage', treatment: 'salary',
      amount: DAMAGES, currency: 'RSD', note: null,
    }],
  }))
  const line = run(r, 'regular').salaries[0].line

  it('charges his contributions on the whole gross', () => {
    expect(line.contributionBase).toBeCloseTo(line.gross, 2)
    expect(line.contributionBase).toBeCloseTo(569091.12, 1)
  })

  it('does NOT prorate a ceiling he never reached', () => {
    // 732,820 × 72/176 is 299,790. Applying it here is the whole mistake.
    expect(line.contributionBase).toBeGreaterThan(299790)
  })

  it('reaches the gross and the net on his payslip', () => {
    expect(line.gross).toBeCloseTo(569091.12, 1)
    expect(line.net).toBeCloseTo(400332.83, 1)
  })

  it('prorates the tax-free relief by his hours', () => {
    // 34,221 × 72/176. The first version of his payslip carried 13,995.41
    // here, which no fraction of 34,221 produces — an MPP setting, since
    // corrected. Worth keeping as a test: a 4-dinar difference in the relief
    // is 58 para of gross, and nothing but a line-by-line comparison against
    // a real payslip would ever have surfaced it.
    expect(line.taxFreeForPeriod).toBeCloseTo(13999.50, 2)
    expect(line.taxBase).toBeCloseTo(555091.62, 1)
  })

  it('matches the tax and the total withheld', () => {
    expect(line.incomeTax).toBeCloseTo(55509.16, 1)
    expect(line.incomeTax + line.employeeContributions).toBeCloseTo(168758.29, 1)
  })

  it('matches each charge on the sheet', () => {
    expect(line.pensionEmployee).toBeCloseTo(79672.76, 1)
    expect(line.healthEmployee).toBeCloseTo(29308.19, 1)
    expect(line.unemploymentEmployee).toBeCloseTo(4268.18, 1)
    expect(line.pensionEmployer).toBeCloseTo(56909.11, 1)
    expect(line.employerContributions).toBeCloseTo(86217.30, 1)
  })

  it('lays his payslip out the way MPP lays it out', () => {
    // The one month with a large one-off in it, so the only check that the
    // parts still add up once a bonus is among them.
    const slip = payslipFor(
      run(r, 'regular').salaries[0], djuro, RATES_2026, 0.004, { EUR: RATE })
    const part = (label: string) => slip.parts.find(x => x.label === label)!

    expect(part('Regular work').gross).toBeCloseTo(201104.48, 1)
    expect(part('Compensation for damage').net).toBeCloseTo(DAMAGES, 2)
    expect(part('Compensation for damage').gross).toBeCloseTo(365432.71, 1)
    expect(part('Seniority').net).toBeCloseTo(1708.49, 1)
    expect(slip.workPerHourGross).toBeCloseTo(2793.12, 1)

    // 7 обуставе 12.448,00 · 8 нето за исплату 387.884,83
    expect(slip.deductions).toHaveLength(1)
    expect(slip.deductions[0].amount).toBeCloseTo(12448.00, 1)
    expect(slip.netPaid).toBeCloseTo(387884.83, 1)

    // And they still add to the gross exactly, bonus and all.
    const sum = slip.parts.reduce((s, x) => s + x.gross, 0)
    expect(Math.round(sum * 100)).toBe(Math.round(slip.gross * 100))
  })

  it('puts the whole one-off into the salary, unprorated', () => {
    // MPP shows it as a part of the salary — "бонуси 256.168,33" — grossed up
    // with everything else. Prorating it by his 72 hours would have paid him
    // 104,796 of a 256,168 payment.
    expect(line.additionalNet).toBeCloseTo(DAMAGES, 2)
  })

  it('splits his contracted net the way the sheet does', () => {
    // 3 years of service, 1.20%: 348,025.79 of base and 4,176.31 of seniority.
    expect(djuro.net.base).toBeCloseTo(348025.79, 1)
    expect(djuro.net.seniority).toBeCloseTo(4176.31, 1)
  })
})

describe('the base, for everybody who is nowhere near it', () => {
  it('is simply the gross', () => {
    // Which is what makes the ceiling so easy to miss: it is invisible for
    // twenty-four people out of twenty-five.
    const line = salaryLine({ contractedNet: 117400.70,
      period: { monthHours: FUND, workedHours: FUND } }, RATES_2026)
    expect(line.contributionBase).toBeCloseTo(line.gross, 2)
  })

  it('holds a very small run up to the floor', () => {
    // The floor is the same arithmetic for the same reason. Nobody here has
    // ever been under it, so unlike the ceiling it is not proved by an export.
    const limits = { min: 51297, max: 732820 }
    expect(contributionBase(10000, limits)).toBe(51297)
    expect(contributionBase(900000, limits)).toBe(732820)
    expect(contributionBase(400000, limits)).toBe(400000)
  })

  it('leaves the gross alone when no limits are given at all', () => {
    expect(contributionBase(900000)).toBe(900000)
    expect(grossFromNet(100000, RATES_2026, 34221))
      .toBeCloseTo(grossFromNet(100000, RATES_2026, 34221, { min: 0, max: 0 }), 6)
  })

  it('reports the base it used, whatever it was', () => {
    const capped = chargesOn(900000, RATES_2026, 34221, { min: 51297, max: 732820 })
    expect(capped.contributionBase).toBe(732820)
    expect(capped.pensionEmployee).toBeCloseTo(732820 * 0.14, 2)
  })
})
