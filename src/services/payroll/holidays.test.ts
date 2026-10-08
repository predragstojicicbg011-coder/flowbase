import {
  holidaysInMonth, isWeekday, paidHolidaysIn, fundFor, fundIsProvenFor,
  explainFund, HOURS_PER_DAY, fundForEmployee, workingDaysBetween, workingDaysFor,
  type HolidayRow,
  lastWorkingDayOf, holidayName, toLatin,
} from './holidays'

/** 2026, as seeded — the days this company does not work. */
const H2026: HolidayRow[] = [
  { holiday_on: '2026-01-01', name: 'Нова година', kind: 'state' },
  { holiday_on: '2026-01-02', name: 'Нова година, други дан', kind: 'state' },
  { holiday_on: '2026-01-07', name: 'Божић', kind: 'orthodox' },
  { holiday_on: '2026-02-15', name: 'Дан државности', kind: 'state' },
  { holiday_on: '2026-02-16', name: 'Дан државности, други дан', kind: 'state' },
  { holiday_on: '2026-02-17', name: 'Дан државности, замена', kind: 'substitute' },
  { holiday_on: '2026-04-10', name: 'Велики петак', kind: 'orthodox' },
  { holiday_on: '2026-04-11', name: 'Велика субота', kind: 'orthodox' },
  { holiday_on: '2026-04-12', name: 'Васкрс', kind: 'orthodox' },
  { holiday_on: '2026-04-13', name: 'Васкршњи понедељак', kind: 'orthodox' },
  { holiday_on: '2026-05-01', name: 'Празник рада', kind: 'state' },
  { holiday_on: '2026-05-02', name: 'Празник рада, други дан', kind: 'state' },
  { holiday_on: '2026-11-11', name: 'Дан примирја', kind: 'state' },
]

describe('isWeekday', () => {
  it('knows a Saturday and a Sunday from the rest', () => {
    expect(isWeekday('2026-02-15')).toBe(false)  // Sunday
    expect(isWeekday('2026-05-02')).toBe(false)  // Saturday
    expect(isWeekday('2026-02-16')).toBe(true)   // Monday
  })
})

describe('the holidays of a month', () => {
  it('picks out the ones inside it', () => {
    expect(holidaysInMonth(H2026, '2026-01').map(h => h.holiday_on))
      .toEqual(['2026-01-01', '2026-01-02', '2026-01-07'])
  })

  it('counts only the ones that fall on a working day', () => {
    // Statehood Day is the 15th, 16th and 17th, but the 15th is a Sunday and
    // takes nothing off a month that was not going to be worked anyway.
    expect(paidHolidaysIn(H2026, '2026-02').map(h => h.holiday_on))
      .toEqual(['2026-02-16', '2026-02-17'])
  })

  it('drops the two Easter weekend days that are not weekdays', () => {
    expect(paidHolidaysIn(H2026, '2026-04').map(h => h.holiday_on))
      .toEqual(['2026-04-10', '2026-04-13'])
  })

  it('finds none in a month that has none', () => {
    expect(paidHolidaysIn(H2026, '2026-08')).toEqual([])
    expect(paidHolidaysIn(H2026, '2026-09')).toEqual([])
  })
})

describe('fundFor', () => {
  it('reproduces the two months there is evidence for', () => {
    // These are the whole basis of the derivation. August 2026 was calculated
    // on 168 hours by the payroll the engine matches to the cent, and
    // September 2026 is what the settings say. If either of these ever stops
    // coming out right, every derived fund is wrong and quietly so.
    expect(fundFor('2026-08', H2026, null, null).monthHours).toBe(168)
    expect(fundFor('2026-09', H2026, null, null).monthHours).toBe(176)
  })

  it('keeps holidays inside the fund rather than taking them off it', () => {
    // MPP's shape: фонд сати у месецу is every weekday, and фонд сати
    // празника is a bucket within it. The timesheet reconciles to the first.
    const january = fundFor('2026-01', H2026, null, null)
    expect(january.monthHours).toBe(22 * HOURS_PER_DAY)   // 176
    expect(january.holidayHours).toBe(3 * HOURS_PER_DAY)  // 1st, 2nd, 7th
    expect(january.workableHours).toBe(152)
  })

  it('lets a setting overrule the derivation, whole', () => {
    // Not field by field: a month half entered and half computed would be a
    // figure nobody put in and nobody worked out.
    const f = fundFor('2026-01', H2026, 160, 16)
    expect(f.monthHours).toBe(160)
    expect(f.holidayHours).toBe(16)
    expect(f.workableHours).toBe(144)
    expect(f.source).toBe('settings')
  })

  it('still names the holidays when a setting was used', () => {
    // The figure is the setting's, but a page should be able to say which
    // days are behind it.
    expect(fundFor('2026-01', H2026, 160, 16).holidays).toHaveLength(3)
  })
})

describe('fundIsProvenFor', () => {
  it('trusts a month with no holidays, because two such months are proved', () => {
    expect(fundIsProvenFor(fundFor('2026-08', H2026, null, null))).toBe(true)
  })

  it('does NOT claim a month with a holiday in it', () => {
    // Neither August nor September contains one, so nothing has ever shown
    // how MPP treats a holiday. Presenting January with the same confidence
    // as August would be the module vouching for its own guess.
    expect(fundIsProvenFor(fundFor('2026-01', H2026, null, null))).toBe(false)
  })

  it('trusts anything somebody entered by hand', () => {
    expect(fundIsProvenFor(fundFor('2026-01', H2026, 160, 16))).toBe(true)
  })
})

describe('explainFund', () => {
  it('says a clean month was worked out and from what', () => {
    const text = explainFund('2026-08', fundFor('2026-08', H2026, null, null))
    expect(text).toContain('168 sati')
    expect(text).toContain('21 radni dan')
  })

  it('warns, and names the days, when a month has holidays in it', () => {
    const text = explainFund('2026-01', fundFor('2026-01', H2026, null, null))
    expect(text).toContain('Božić')
    expect(text).toContain('Nova godina (drugi dan)')
    expect(text).toContain('od kojih su 3 državna praznika')
    expect(text).toContain('proverite ovaj mesec u MPP')
  })

  it('says plainly when the figure was entered rather than derived', () => {
    expect(explainFund('2026-01', fundFor('2026-01', H2026, 160, 16)))
      .toContain('iz podešavanja zarada za januar 2026')
  })
})

describe('holidayName', () => {
  it('shows the seeded Cyrillic rows under their official Latin names', () => {
    const byDate = Object.fromEntries(H2026.map(h => [h.holiday_on, holidayName(h)]))
    expect(byDate['2026-01-01']).toBe('Nova godina')
    expect(byDate['2026-01-07']).toBe('Božić')
    expect(byDate['2026-02-15']).toBe('Sretenje — Dan državnosti Srbije')
    expect(byDate['2026-02-17']).toBe('Sretenje — Dan državnosti Srbije (prenet neradni dan)')
    expect(byDate['2026-04-10']).toBe('Veliki petak')
    expect(byDate['2026-04-12']).toBe('Uskrs')
    expect(byDate['2026-04-13']).toBe('Uskrsni ponedeljak')
    expect(byDate['2026-05-02']).toBe('Praznik rada (drugi dan)')
    expect(byDate['2026-11-11']).toBe('Dan primirja u Prvom svetskom ratu')
  })

  it('transliterates a name it does not know, and leaves Latin alone', () => {
    expect(holidayName({ name: 'Видовдан' })).toBe('Vidovdan')
    expect(holidayName({ name: 'Đurđevdan' })).toBe('Đurđevdan')
    expect(toLatin('Љубав и Џак')).toBe('Ljubav i Džak')
  })
})

describe('the fund for one person, when the month is not all theirs', () => {
  it('gives Vučinić Bojana the 144 hours her own sheet states', () => {
    // She joined on the 7th of September. The month is 176 and hers is 144 —
    // and the export agrees: `Nominal hours 144`. Holding her to 176 reports
    // 32 hours missing from a month that is complete, which is exactly the
    // kind of complaint that teaches people to ignore the check.
    const days = workingDaysBetween('2026-09', H2026, '2026-09-07', null)
    expect(days).toBe(18)
    expect(fundForEmployee(176, days, 22)).toBe(144)
  })

  it('gives Milosavljević Đuro the part of September he was here for', () => {
    // He left on the 12th: 9 working days of 22.
    const days = workingDaysBetween('2026-09', H2026, null, '2026-09-12')
    expect(days).toBe(9)
    expect(fundForEmployee(176, days, 22)).toBe(72)
  })

  it('gives a full month to anybody who was here for all of it', () => {
    expect(fundForEmployee(176, 22, 22)).toBe(176)
  })

  it('never gives more than the month, whatever the days say', () => {
    expect(fundForEmployee(176, 30, 22)).toBe(176)
  })

  it('falls back to the month when there is no calendar', () => {
    expect(fundForEmployee(176, 0, 0)).toBe(176)
  })

  it('prorates by WORKING days, not calendar ones', () => {
    // Joining on a Friday does not buy the weekend.
    const friday = workingDaysBetween('2026-09', H2026, '2026-09-25', null)
    expect(friday).toBe(4)   // 25th, 28th, 29th, 30th
  })

  it('counts the days somebody was employed against the same calendar', () => {
    // One calendar for both, or a person's fund is a share of a month that
    // was never the denominator.
    const counter = workingDaysFor('2026-09', H2026)
    expect(counter.total).toBe(22)
    expect(counter.forEmployee({ hired_on: '2026-09-07', left_on: null })).toBe(18)
  })
})


describe('the last working day of a month', () => {
  const holiday = (on: string): HolidayRow =>
    ({ id: on, holiday_on: on, name: 'Praznik' } as HolidayRow)

  it('is the last day when the month ends on a weekday', () => {
    // 30 September 2026 is a Wednesday.
    expect(lastWorkingDayOf('2026-09', [])).toBe('2026-09-30')
  })

  it('steps back over a weekend', () => {
    // 31 October 2026 is a Saturday, so the Friday before it.
    expect(lastWorkingDayOf('2026-10', [])).toBe('2026-10-30')
    // 28 February 2026 is a Saturday.
    expect(lastWorkingDayOf('2026-02', [])).toBe('2026-02-27')
  })

  it('steps back over a holiday on the last weekday', () => {
    expect(lastWorkingDayOf('2026-09', [holiday('2026-09-30')])).toBe('2026-09-29')
  })

  it('steps back over a holiday AND a weekend together', () => {
    // Drop the Wednesday and the Tuesday; the Monday the 28th remains.
    expect(lastWorkingDayOf('2026-09', [holiday('2026-09-30'), holiday('2026-09-29')]))
      .toBe('2026-09-28')
  })

  it('ignores a holiday in another month', () => {
    expect(lastWorkingDayOf('2026-09', [holiday('2026-10-30')])).toBe('2026-09-30')
  })

  it('gets February right in a leap year', () => {
    // 29 February 2028 is a Tuesday.
    expect(lastWorkingDayOf('2028-02', [])).toBe('2028-02-29')
  })

  /** A month that is entirely weekend and holiday cannot happen; a function
   *  that can return nothing makes every caller handle a case that does not. */
  it('always returns a date', () => {
    const everyDay = Array.from({ length: 31 }, (_, i) =>
      holiday(`2026-09-${String(i + 1).padStart(2, '0')}`))
    expect(lastWorkingDayOf('2026-09', everyDay)).toBe('2026-09-30')
  })
})
