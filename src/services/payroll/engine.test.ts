import {
  chargesOn, grossFromNet, netFromGross, salaryLine, sickLeaveLine, otherIncomeLine,
  unprovenRule, RATES_2026,
  splitContractedNet, contractInDinars, wholeYearsBetween,
} from './engine'

// ─── Real months, from the MPP exports ──────────────────────────────────────
//
// Every figure marked `export:` below was produced by Mali privredni savetnik
// for Kalemar and is what this engine has to reproduce. Nothing is a
// plausible number someone made up to make a test pass — if one of these
// changes, either MPP changed or the engine is wrong, and both are worth
// stopping for.
//
// A full month and a part month of salary, and maternity leave from May 2026,
// which is the only one that enters through a gross. Only the figures this
// engine calculates are asserted; nothing else on those runs is relied on.

const R = RATES_2026
const FULL = { monthHours: 168, workedHours: 168 }

describe('A full month 2026-08', () => {
  // Gavrilov Dejan, 117,358.60 contracted net.
  const line = salaryLine({ contractedNet: 117358.60, period: FULL }, R)

  it('grosses up to what MPP grossed up to', () => {
    expect(line.gross).toBeCloseTo(162819.54, 2)
  })

  it('takes the tax-free amount off the base', () => {
    expect(line.taxBase).toBeCloseTo(128598.54, 2)
  })

  it('charges the tax and every contribution at MPP’s figures', () => {
    expect(line.incomeTax).toBeCloseTo(12859.85, 2)
    expect(line.pensionEmployee).toBeCloseTo(22794.74, 2)
    expect(line.healthEmployee).toBeCloseTo(8385.21, 2)
    expect(line.unemploymentEmployee).toBeCloseTo(1221.15, 2)
    expect(line.pensionEmployer).toBeCloseTo(16281.95, 2)
    expect(line.healthEmployer).toBeCloseTo(8385.21, 2)
  })

  it('returns the net the payslip shows, exactly', () => {
    expect(line.net).toBeCloseTo(117558.60, 2)
  })
})

describe('Another full month 2026-08, end to end', () => {
  const line = salaryLine({ contractedNet: 234717.20, period: FULL }, R)

  it('reproduces the run end to end', () => {
    expect(line.gross).toBeCloseTo(330235.52, 2)
    expect(line.incomeTax).toBeCloseTo(29601.45, 2)
    expect(line.pensionEmployee).toBeCloseTo(46232.97, 2)
    expect(line.net).toBeCloseTo(234917.20, 2)
    expect(line.totalCost).toBeCloseTo(380266.20, 2)
  })

  it('costs the gross plus the employer’s contributions', () => {
    expect(line.totalCost).toBeCloseTo(line.gross + line.employerContributions, 2)
  })
})

describe('A part month 2026-08 — eight hours of a 168-hour fund', () => {
  // Petrović Dejan: 352,075.80 contracted, 8 hours of this calculation.
  // The contract is NOT divided beforehand — the engine prorates it.
  const line = salaryLine(
    { contractedNet: 352075.80, period: { monthHours: 168, workedHours: 8 } }, R)

  it('prorates the contract by the hours this run covers', () => {
    expect(line.contractedForPeriod).toBeCloseTo(352075.80 * 8 / 168, 2)
  })

  it('prorates the tax-free amount too', () => {
    // A part month carries part of the allowance — "неопорезив део зараде за
    // фонд сати (процењен)" in the export.
    expect(line.taxFreeForPeriod).toBeCloseTo(34221 * 8 / 168, 2)
  })

  it('reaches the gross MPP reached', () => {
    expect(line.gross).toBeCloseTo(23697.69, 2)
  })
})

describe('the parts of a month add back up', () => {
  it('splitting a contract across two periods costs what one full month costs', () => {
    // Proration must not create or destroy salary: two periods of one month
    // come to exactly what the whole month does.
    const whole = salaryLine({ contractedNet: 352075.80, period: FULL }, R)
    const first = salaryLine(
      { contractedNet: 352075.80, period: { monthHours: 168, workedHours: 160 } }, R)
    const rest = salaryLine(
      { contractedNet: 352075.80, period: { monthHours: 168, workedHours: 8 } }, R)

    expect(first.gross + rest.gross).toBeCloseTo(whole.gross, 2)
    expect(first.totalCost + rest.totalCost).toBeCloseTo(whole.totalCost, 2)
    expect(first.net + rest.net).toBeCloseTo(whole.net, 2)
  })
})

describe('Trudničko bolovanje 30+ 2026-05 — entering through a gross', () => {
  // Gavrilov Ivona, allowance from her own average: 83,283.37 a month.
  const line = sickLeaveLine(
    { monthlyAllowance: 83283.37, period: FULL, coefficient: 1 }, R)

  it('raises the hourly gross to the statutory minimum', () => {
    // The average gives 495.73; the minimum is 500.19 and it is what MPP pays.
    expect(line.raisedToMinimum).toBe(true)
    expect(line.grossPerHour).toBeCloseTo(500.19, 2)
  })

  it('derives that minimum from the minimum NET, not from a second setting', () => {
    // 371 net per hour, grossed up with the hourly tax-free amount. Storing
    // the gross separately would let the two drift.
    const taxFreePerHour = R.taxFreeAmount / FULL.workedHours
    expect(grossFromNet(R.minimumNetPerHour, R, taxFreePerHour)).toBeCloseTo(500.19, 2)
  })

  it('reproduces the whole run', () => {
    expect(line.gross).toBeCloseTo(84031.24, 2)
    expect(line.taxBase).toBeCloseTo(49810.24, 2)
    expect(line.incomeTax).toBeCloseTo(4981.02, 2)
    expect(line.pensionEmployee).toBeCloseTo(11764.37, 2)
    expect(line.healthEmployee).toBeCloseTo(4327.61, 2)
    expect(line.unemploymentEmployee).toBeCloseTo(630.23, 2)
    expect(line.totalCost).toBeCloseTo(96761.97, 2)
    // One cent of rounding order: MPP rounds each intermediate to two
    // decimals and this rounds at the end. Counted in cents, because 0.01 in
    // binary floating point renders as slightly more than 0.01.
    expect(Math.round(Math.abs(line.net - 62328.01) * 100)).toBeLessThanOrEqual(1)
  })

  it('pays exactly the minimum net per hour once the floor binds', () => {
    expect(line.net / FULL.workedHours).toBeCloseTo(R.minimumNetPerHour, 2)
  })

  it('does not raise a figure that already clears the minimum', () => {
    const rich = sickLeaveLine({ monthlyAllowance: 300000, period: FULL }, R)
    expect(rich.raisedToMinimum).toBe(false)
    expect(rich.grossPerHour).toBeCloseTo(300000 / 168, 2)
  })
})

describe('Other income — taxed, but not contributed on', () => {
  // The same arithmetic MPP applies to a taxed, uncontributed payment: a net
  // grossed up for tax alone.
  const line = otherIncomeLine({ net: 3000 }, R)

  it('grosses 3,000 up to 3,333.33 and charges 333.33', () => {
    expect(line.gross).toBeCloseTo(3333.33, 2)
    expect(line.incomeTax).toBeCloseTo(333.33, 2)
    expect(line.totalCost).toBeCloseTo(3333.33, 2)
  })

  it('carries no contributions, which is why it is its own run', () => {
    expect(Object.keys(line)).not.toContain('pensionEmployee')
    expect(line.totalCost).toBeCloseTo(line.net + line.incomeTax, 2)
  })

  it('taxes only what is above the tax-free part', () => {
    const part = otherIncomeLine({ net: 3000, taxFree: 1000 }, R)
    expect(part.taxableNet).toBe(2000)
    expect(part.incomeTax).toBeCloseTo(2000 / 0.9 * 0.1, 2)
    expect(part.totalCost).toBeCloseTo(2000 / 0.9 + 1000, 2)
  })
})

// ─── The arithmetic, on its own ─────────────────────────────────────────────

describe('grossFromNet and netFromGross', () => {
  it('are each other’s inverse', () => {
    for (const net of [50000, 117558.60, 234917.20, 1]) {
      expect(netFromGross(grossFromNet(net, R, R.taxFreeAmount), R, R.taxFreeAmount))
        .toBeCloseTo(net, 6)
    }
  })

  it('returns nothing rather than dividing by zero on impossible rates', () => {
    const absurd = { ...R, incomeTax: 0.9, pensionEmployee: 0.9 }
    expect(grossFromNet(1000, absurd, 0)).toBe(0)
  })
})

describe('chargesOn', () => {
  it('never lets the tax base go below zero', () => {
    // A very short month can gross less than the tax-free allowance, and a
    // negative base would pay tax backwards.
    const c = chargesOn(1000, R, 34221)
    expect(c.taxBase).toBe(0)
    expect(c.incomeTax).toBe(0)
  })

  it('reconstructs the net from its own parts', () => {
    const c = chargesOn(162819.54, R, 34221)
    expect(c.gross - c.incomeTax - c.employeeContributions).toBeCloseTo(c.net, 2)
  })

  it('costs the gross plus the employer’s contributions', () => {
    const c = chargesOn(162819.54, R, 34221)
    expect(c.totalCost).toBeCloseTo(c.gross + c.employerContributions, 2)
  })
})

describe('what the engine refuses to invent', () => {
  it('will not produce a figure for a rule no month has proved', () => {
    // The settings carry coefficients for overtime, night work and a dozen
    // absences. None has appeared in an export, so none has been checked
    // against MPP — and a guessed figure would be indistinguishable from a
    // verified one in a module whose whole job is checking.
    expect(() => unprovenRule('Overtime')).toThrow(/no payroll export has exercised it/)
    expect(() => unprovenRule('Overtime')).toThrow(/Guessing here/)
  })
})

describe('seniority, and what a contract amount means', () => {
  const COEF = 0.004

  // Three of the fourteen from the August 2026 export, verbatim. The rule
  // was checked against all fourteen; these are kept as the regression because
  // they span the range — six years, four, and one.
  const AUGUST = [
    { name: 'Gavrilov Dejan', years: 6, base: 114608.01, seniority: 2750.59, total: 117358.60 },
    { name: 'Stevanović Bojan', years: 4, base: 323429.21, seniority: 5174.87, total: 328604.08 },
    { name: 'Vasiljević Tanja', years: 1, base: 257160.28, seniority: 1028.64, total: 258188.92 },
  ]

  it.each(AUGUST)('splits the contract for $name the way MPP did', ({ years, base, seniority, total }) => {
    const split = splitContractedNet(total, years, COEF)
    expect(split.base).toBeCloseTo(base, 2)
    expect(split.seniority).toBeCloseTo(seniority, 2)
  })

  it('treats the contracted figure as INCLUDING seniority, not on top of it', () => {
    // The payslip reads "Уговорена месечна зарада 352.075,80 (3.000,00 EUR,
    // курс 117,3586)" and that figure is the total: base 350,673.11 plus one
    // year of seniority. Reading it as the base instead would pay seniority
    // twice, by more the longer somebody had been here.
    const split = splitContractedNet(352075.80, 1, COEF)
    expect(split.base).toBeCloseTo(350673.11, 2)
    expect(split.seniority).toBeCloseTo(1402.69, 2)
    expect(split.base + split.seniority).toBeCloseTo(352075.80, 2)
  })

  it('gives somebody in their first year no seniority at all', () => {
    expect(splitContractedNet(100000, 0, COEF)).toEqual({
      base: 100000, seniority: 0, total: 100000,
    })
  })

  it('converts a euro contract at the rate for the month', () => {
    expect(contractInDinars(3000, 117.3586)).toBeCloseTo(352075.80, 2)
  })

  it('returns nothing rather than Infinity when no rate is known', () => {
    // A month whose rate has not been entered must not silently produce a
    // salary of zero dinars dressed up as a real one — the caller checks.
    expect(contractInDinars(3000, 0)).toBe(0)
  })
})

describe('wholeYearsBetween', () => {
  // Fourteen employees of the August 2026 export: a date their last
  // engagement began (the day and month changed, the whole years kept), and the seniority MPP credited them with for that
  // month. This is the evidence the rule rests on, so it is the test.
  const AUGUST_2026 = '2026-08-01'
  const FOURTEEN: [string, string, number][] = [
    ['Gavrilov Dejan',        '2020-03-04', 6],
    ['Marinković Radoslav',      '2020-05-18', 6],
    ['Stevanović Bojan',    '2022-03-01', 4],
    ['Stevanović Strahinja',  '2022-03-01', 4],
    ['Popović Vladimir', '2022-03-01', 4],
    ['Babin Goran',           '2022-03-01', 4],
    ['Đurović Teodor Viktor', '2022-04-19', 4],
    ['Žarkov Stefan',       '2023-01-16', 3],
    ['Ristić Vladimir',     '2024-02-12', 2],
    ['Bogdanić Velimir',      '2024-05-06', 2],
    ['Petrović Dejan',      '2025-03-10', 1],
    ['Tomić Zoran',    '2025-03-10', 1],
    ['Đukić Marina',          '2025-05-05', 1],
    ['Vasiljević Tanja',      '2025-06-02', 1],
  ]

  it.each(FOURTEEN)('credits %s with the years MPP did', (_name, from, years) => {
    expect(wholeYearsBetween(from, AUGUST_2026)).toBe(years)
  })

  it('counts anniversaries, not 365-day blocks', () => {
    // A day before the anniversary is still the previous year, on it and
    // after it is the next one. Dividing by 365.25 drifts either side of this
    // and would move somebody between six and seven years depending on which
    // leap years fell in between.
    expect(wholeYearsBetween('2020-03-04', '2027-03-03')).toBe(6)
    expect(wholeYearsBetween('2020-03-04', '2027-03-04')).toBe(7)
  })

  it('gives nothing rather than a negative for somebody not yet started', () => {
    expect(wholeYearsBetween('2026-09-07', AUGUST_2026)).toBe(0)
  })

  it('gives nothing when no seniority date is set', () => {
    // A missing date must not become a year of service out of nowhere.
    expect(wholeYearsBetween('', AUGUST_2026)).toBe(0)
  })
})
