import {
  hoursFrom, cleanName, parseSheet, parseWorkbook, nameKey, matchEmployees, toTimesheet,
} from './timesheetImport'

/**
 * A sheet in the shape the real export produces.
 *
 * Taken from `Gradiliste_full report_2026-09.xlsx`, worksheet "6.Stevanović
 * Strahinja": 168 hours worked, one day of annual leave, and the two duration
 * formats side by side in the same block.
 */
function sheet(over: {
  name?: string
  worked?: string
  annual?: string
  sick?: string
  unpaid?: string
  bankHoliday?: string
  other?: [string, string][]
  total?: string
  nominal?: string
  difference?: string | null
} = {}) {
  // Spelled the way `xlsx` hands the cells over in the browser, which is what
  // production reads — verified against all twenty-four real September sheets.
  const o = {
    name: 'Stevanović Strahinja',
    worked: '168:00',
    annual: '8:00 (days: 1)',
    sick: '00:00',
    unpaid: '00:00',
    bankHoliday: '00:00',
    other: [] as [string, string][],
    total: '176:00',
    nominal: '176:00',
    difference: '00:00' as string | null,
    ...over,
  }
  const rows: unknown[][] = [
    ['Timesheet - 09.2026'],
    [o.name],
    ['Site Engineer (Contract of employment)'],
    ['Department: Gradilište'],
    ['Date', '', 'Working time (from-to)', 'Night work (hours)', 'Unpaid break',
      'Work time (hours)', 'Daily hrs number', 'Difference', 'Comment'],
    // Two daily rows, including one that says "Annual leave [Whole day]" — the
    // label the summary row must not be confused with.
    ['01/09/2026', 'Tue', '09:00-17:00', '0:00:00', '0:00:00', '8:00:00', '8:00:00', '0:00:00', ''],
    ['18/09/2026', 'Fri', 'Annual leave [Whole day]', '', '', '8:00:00', '8:00:00', '0:00:00', ''],
    // The summary block. No date in the first column, which is what tells them
    // apart from the days above.
    ['', '', 'Registered work time', '0:00:00', '0:00:00', o.worked],
    ['', '', 'incl.: Weekend work', '', '', '00:00'],
    ['', '', 'incl.: Remote work (hrs)', '', '', '8:00 (days: 1)'],
    ['', '', 'incl.: Business Trip', '', '', '00:00'],
    ['', '', 'Annual leave', '', '', o.annual],
    ...o.other.map(([label, v]) => ['', '', label, '', '', v]),
    ['', '', 'Occasional leave', '', '', '00:00'],
    ['', '', 'Sick leave', '', '', o.sick],
    ['', '', 'Unpaid leave', '', '', o.unpaid],
    ['', '', 'Day off in lieu of bank holiday', '', '', o.bankHoliday],
    ['', '', 'Private leave', '', '', '00:00'],
    ['', '', 'Registered working time + requests', '', '', o.total],
    ['', '', 'Nominal hours', '', '', o.nominal],
  ]
  if (o.difference !== null) rows.push(['', '', 'Difference', '', '', o.difference])
  return rows
}

describe('hoursFrom', () => {
  it('reads what the spreadsheet library actually hands over', () => {
    // THIS is the production shape, checked against all twenty-four real
    // September sheets read through `xlsx` in the browser: plain hours past
    // twenty-four, and a leading zero pair for nothing.
    expect(hoursFrom('168:00')).toBe(168)
    expect(hoursFrom('176:00')).toBe(176)
    expect(hoursFrom('00:00')).toBe(0)
    expect(hoursFrom('8:00 (days: 1)')).toBe(8)
  })

  it('also reads the form Excel shows on screen', () => {
    // openpyxl and Excel itself render the same cells as "7 days, 0:00:00",
    // and anybody checking this module by eye will be looking at those. A day
    // there is 24 hours, not a working day, and the day count in the other
    // form is decorative — between them that is two chances to be off by a
    // factor of three.
    expect(hoursFrom('7 days, 0:00:00')).toBe(168)
    expect(hoursFrom('7 days, 8:00:00')).toBe(176)
    expect(hoursFrom('0:00:00')).toBe(0)
  })

  it('reads a cell a spreadsheet library already turned into something else', () => {
    // The same cell comes back as text, as a Date, or as a fraction of a day
    // depending on how the file was read.
    expect(hoursFrom(new Date(Date.UTC(1899, 11, 30, 8, 0, 0)))).toBe(8)
    expect(hoursFrom(1 / 3)).toBeCloseTo(8, 6)
  })

  it('gives nothing for an empty cell rather than NaN', () => {
    expect(hoursFrom(null)).toBe(0)
    expect(hoursFrom(undefined)).toBe(0)
    expect(hoursFrom('')).toBe(0)
    expect(hoursFrom('nonsense')).toBe(0)
  })
})

describe('cleanName', () => {
  it('drops the phone number some rows carry', () => {
    expect(cleanName('Popović Dragana [+381600000000]')).toBe('Popović Dragana')
  })
})

describe('parseSheet', () => {
  it('reads the summary block, not the days above it', () => {
    // The daily rows say "Annual leave [Whole day]" and carry 8 hours each.
    // Adding those as well would double every absence.
    const p = parseSheet(sheet())!
    expect(p.name).toBe('Stevanović Strahinja')
    expect(p.department).toBe('Gradilište')
    expect(p.workedHours).toBe(168)
    expect(p.annualLeaveHours).toBe(8)
    expect(p.totalHours).toBe(176)
    expect(p.nominalHours).toBe(176)
    expect(p.problems).toEqual([])
  })

  it('leaves the "incl.:" breakdowns alone, being already counted', () => {
    // Remote work is 8 hours INSIDE the 168, not beside it.
    const p = parseSheet(sheet())!
    expect(p.workedHours + p.annualLeaveHours).toBe(p.totalHours)
  })

  it('refuses a sheet whose own difference is not zero', () => {
    // The file checks itself. A sheet that fails its own check has been
    // edited, and the hours behind a payroll are not the place to find that
    // out later.
    const p = parseSheet(sheet({ difference: '8:00:00' }))!
    expect(p.problems[0]).toContain('difference of 8')
    expect(p.problems[0]).toContain('edited')
  })

  it('refuses a sheet with no difference row at all', () => {
    const p = parseSheet(sheet({ difference: null }))!
    expect(p.problems[0]).toContain('no Difference row')
  })

  it('refuses a sheet whose categories do not reach its own total', () => {
    const p = parseSheet(sheet({ worked: '144:00' }))!
    expect(p.problems.some(x => x.includes('was not read'))).toBe(true)
  })

  it('NAMES a leave category it has no column for, rather than bucketing it', () => {
    // Maternity leave paid at the annual-leave rate is wrong by a lot, on a
    // line that looks perfectly ordinary.
    const p = parseSheet(sheet({
      worked: '00:00',
      other: [['Maternity leave', '176:00']],
      total: '176:00',
    }))!
    expect(p.unmapped).toEqual([{ label: 'Maternity leave', hours: 176 }])
    expect(p.problems.some(x => x.includes('Maternity leave'))).toBe(true)
    expect(p.problems.some(x => x.includes('wrong rate'))).toBe(true)
  })

  it('returns nothing for a sheet that is not a timesheet', () => {
    expect(parseSheet([['Cover page'], ['Notes']])).toBeNull()
    expect(parseSheet([])).toBeNull()
  })
})

describe('parseWorkbook', () => {
  it('reads every employee and says which sheets it skipped', () => {
    const file = parseWorkbook('Gradiliste_full report_2026-09.xlsx', [
      { name: '1.Stevanović Strahinja', rows: sheet() },
      { name: '2.Ristić Vladimir', rows: sheet({ name: 'Ristić Vladimir' }) },
      { name: 'Cover', rows: [['Nothing here']] },
    ])
    expect(file.employees.map(e => e.name))
      .toEqual(['Stevanović Strahinja', 'Ristić Vladimir'])
    expect(file.skipped).toEqual(['Cover'])
  })
})

describe('nameKey', () => {
  it('sees through diacritics and word order', () => {
    expect(nameKey('Stevanović Strahinja')).toBe(nameKey('Strahinja Stevanovic'))
    expect(nameKey('Žarkov Stefan')).toBe(nameKey('Zarkov Stefan'))
    expect(nameKey('Đukić Marina')).toBe(nameKey('Dukic Marina'))
  })

  it('does NOT pair a transliterated name with a different middle name', () => {
    // "Djurovic Teodor" against "Đurović Teodor Viktor". Guessing here puts one
    // person's hours on another's salary, and both would look plausible.
    expect(nameKey('Djurovic Teodor')).not.toBe(nameKey('Đurović Teodor Viktor'))
  })
})

describe('matchEmployees', () => {
  const employees = [
    { id: 'e1', full_name: 'Stevanović Strahinja' },
    { id: 'e2', full_name: 'Đurović Teodor Viktor' },
    { id: 'e3', full_name: 'Stevanović Bojan' },
  ]

  it('matches on the name where it can', () => {
    const [m] = matchEmployees([parseSheet(sheet())!], employees)
    expect(m.employeeId).toBe('e1')
    expect(m.how).toBe('name')
  })

  it('leaves one it cannot match, rather than guessing', () => {
    const [m] = matchEmployees([parseSheet(sheet({ name: 'Djurovic Teodor' }))!], employees)
    expect(m.employeeId).toBeNull()
    expect(m.how).toBe('none')
  })

  it('uses a link somebody made, over its own comparison', () => {
    const [m] = matchEmployees(
      [parseSheet(sheet({ name: 'Djurovic Teodor' }))!], employees,
      { 'Djurovic Teodor': 'e2' })
    expect(m.employeeId).toBe('e2')
    expect(m.how).toBe('remembered')
  })

  it('refuses to choose between two people whose names reduce alike', () => {
    // A coin toss between two salaries is not a match.
    const twins = [
      { id: 'a', full_name: 'Marko Marković' },
      { id: 'b', full_name: 'Markovic Marko' },
    ]
    const [m] = matchEmployees([parseSheet(sheet({ name: 'Marko Marković' }))!], twins)
    expect(m.employeeId).toBeNull()
  })
})

describe('toTimesheet', () => {
  const parsed = parseSheet(sheet())!

  it('puts everything worked into the work column', () => {
    const t = toTimesheet(parsed, 'e1', '2026-09')
    expect(t.regular_hours).toBe(168)
    expect(t.vacation_hours).toBe(8)
    expect(t.month).toBe('2026-09-01')
  })
})

describe('the whole September file, end to end', () => {
  it('produces a timesheet that reconciles against the month', () => {
    const parsed = parseSheet(sheet())!
    const t = toTimesheet(parsed, 'e1', '2026-09')
    const total = t.regular_hours + t.holiday_hours
      + t.vacation_hours + t.sick_hours + t.unpaid_hours
    expect(total).toBe(176)
    expect(total).toBe(parsed.nominalHours)
  })
})

describe('the real September files against the real register', () => {
  // Every name as the five export files spell it, and every name as the MPP
  // register spells it. This is where the risk actually is: the two lists were
  // typed by different people into different systems, and a pairing that is
  // wrong puts one person's hours on another person's salary.
  const IN_FILES = [
    'Đinić Dejan', 'Vucinic Bojana', 'Milosavljevic Djuro', 'Jeličić Branislav',
    'Milosavljević Andrija', 'Hajduk Milica', 'Popović Dragana [+381600000000]',
    'Popović Vesna', 'Vasiljević Tanja', 'Bogdanić Velimir', 'Đukić Marina',
    'Djurovic Teodor', 'Stevanović Bojan', 'Stevanović Strahinja', 'Marinković Radoslav',
    'Ristić Vladimir', 'Petrović Dejan', 'Popović Vladimir', 'Tomić Zoran',
    'Žarkov Stefan', 'Radović Vladimir', 'Gavrilov Dejan', 'Babin Goran',
    'Grašić Dejan',
  ]
  const IN_REGISTER = [
    'Vasiljević Tanja', 'Radović Vladimir', 'Bogdanić Velimir', 'Gavrilov Dejan',
    'Gavrilov Ivona', 'Babin Goran', 'Đurović Teodor Viktor', 'Đukić Marina',
    'Đinić Dejan', 'Vučinić Bojana', 'Milosavljević Andrija', 'Milosavljević Đuro',
    'Stevanović Bojan', 'Stevanović Strahinja', 'Marinković Radoslav', 'Ristić Vladimir',
    'Petrović Dejan', 'Hajduk Milica', 'Popović Vladimir', 'Popović Vesna',
    'Popović Dragana', 'Tomić Zoran', 'Jeličić Branislav', 'Grašić Dejan',
    'Žarkov Stefan',
  ].map((full_name, i) => ({ id: `e${i}`, full_name }))

  const parsedFor = (name: string) => parseSheet(sheet({ name }))!
  const matches = matchEmployees(IN_FILES.map(parsedFor), IN_REGISTER)

  it('pairs twenty-two of the twenty-four by name alone', () => {
    expect(matches.filter(m => m.employeeId).length).toBe(22)
  })

  it('leaves exactly the two that genuinely differ', () => {
    // "Djurovic Teodor" is missing a middle name and transliterates Đ; "Milosavljevic
    // Djuro" writes đ as "dj" where the register writes it as the letter.
    // Neither is a spelling difference this should paper over by itself.
    expect(matches.filter(m => !m.employeeId).map(m => m.parsed.name).sort())
      .toEqual(['Djurovic Teodor', 'Milosavljevic Djuro'])
  })

  it('sees through the diacritics and the phone number on the rest', () => {
    const by = (n: string) => matches.find(m => m.parsed.name === n)!
    // The phone number is gone by the time anything is matched, so the parsed
    // name is the plain one — which is also what a link would be remembered
    // under, and what a screen would show.
    expect(matches.some(m => m.parsed.name.includes('['))).toBe(false)
    expect(by('Popović Dragana').employeeId).toBeTruthy()
    expect(by('Vucinic Bojana').employeeId).toBeTruthy()
    expect(by('Žarkov Stefan').employeeId).toBeTruthy()
  })

  it('links the awkward two once, and then they stay linked', () => {
    const remembered = {
      'Djurovic Teodor': 'e6',        // Đurović Teodor Viktor
      'Milosavljevic Djuro': 'e11',    // Milosavljević Đuro
    }
    const again = matchEmployees(IN_FILES.map(parsedFor), IN_REGISTER, remembered)
    expect(again.every(m => m.employeeId)).toBe(true)
  })

  it('notices that one person in the register has no timesheet at all', () => {
    // Gavrilov Ivona. A payroll missing a person is the error this module
    // exists to catch, so the roster names her rather than the import
    // pretending twenty-four is everybody.
    const matched = new Set(matches.map(m => m.employeeId))
    const without = IN_REGISTER.filter(e => !matched.has(e.id))
    expect(without.map(e => e.full_name)).toContain('Gavrilov Ivona')
  })
})

describe('projectHoursAboveWorked', () => {
  const { projectHoursAboveWorked } = require('./timesheetImport')
  const { emptyTimesheet } = require('./timesheets')
  it('names only the people whose imported work falls below their project hours', () => {
    const a = { ...emptyTimesheet('a', '2026-09'), regular_hours: 100 }
    const b = { ...emptyTimesheet('b', '2026-09'), regular_hours: 160 }
    expect(projectHoursAboveWorked([a, b], {
      a: [{ hours: 80 }, { hours: 40 }],
      b: [{ hours: 160 }],
    })).toEqual([{ employeeId: 'a', worked: 100, onProjects: 120 }])
  })
})
