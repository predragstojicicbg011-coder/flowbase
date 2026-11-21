import {
  proposeFromCalendar, templateTotal, templateProblem, daysOnPayroll,
  timesheetFromTemplate, applyPreliminaryHours, monthKind, TEMPLATE_FIELDS,
  type PreliminaryHoursRow,
} from './preliminaryHours'
import { TEMPLATE_NEGATIVE, TEMPLATE_OFF_FUND, noticeFor } from './preliminaryText'
import { fundFor, fundForEmployee, workingDaysFor, type HolidayRow } from './holidays'
import {
  employeesForMonth, type EmployeeRow, type ContractRow, type AbsenceRow,
} from './employees'
import { totalHours, emptyTimesheet, HOUR_FIELDS } from './timesheets'

// November 2026: 21 weekdays, one of them (the 11th) a public holiday.
const HOLIDAYS: HolidayRow[] = [{ holiday_on: '2026-11-11', name: 'Praznik A', kind: 'state' }]
const FUND = fundFor('2026-11', HOLIDAYS, null, null)

const person = (n: number, over: Partial<EmployeeRow> = {}): EmployeeRow => ({
  id: `emp-${n}`,
  company_id: 'co-1',
  code: `E-00${n}`,
  full_name: `Osoba ${String.fromCharCode(64 + n)}`,
  organisational_unit: null,
  hired_on: '2025-01-01',
  seniority_from: '2025-01-01',
  left_on: null,
  note: null,
  ...over,
})

const contract = (employeeId: string): ContractRow => ({
  id: `con-${employeeId}`,
  employee_id: employeeId,
  valid_from: '2025-01-01',
  valid_to: null,
  currency: 'RSD',
  net_amount: 100000,
  service_years: 0,
  note: null,
})

const away = (employeeId: string, from: string): AbsenceRow => ({
  id: `abs-${employeeId}`, employee_id: employeeId, reason: 'unpaid_leave',
  valid_from: from, valid_to: null, note: null,
})

const rosterOf = (employees: EmployeeRow[], absences: AbsenceRow[] = []) => employeesForMonth(
  employees, employees.map(e => contract(e.id)), [],
  { date: '2026-11-01', seniorityCoefficient: 0, rates: {} },
  [], absences,
)

const TEMPLATE = proposeFromCalendar('2026-11', FUND)

describe('the template of hours', () => {
  it('the calendar proposes the workable hours and the holiday', () => {
    expect(TEMPLATE.regular_hours).toBe(160)
    expect(TEMPLATE.holiday_hours).toBe(8)
    for (const f of TEMPLATE_FIELDS) {
      if (f !== 'regular_hours' && f !== 'holiday_hours') expect(TEMPLATE[f]).toBe(0)
    }
    expect(TEMPLATE.month).toBe('2026-11-01')
    expect(TEMPLATE.note).toBeNull()
    expect(templateTotal(TEMPLATE)).toBe(168)
  })

  it('has every hour category of a timesheet, in the timesheet order (no R&D in FlowBase)', () => {
    expect(TEMPLATE_FIELDS).toEqual(HOUR_FIELDS)
    expect(TEMPLATE_FIELDS).toHaveLength(16)
    expect(TEMPLATE_FIELDS).not.toContain('research_hours')
  })

  it('a template that matches the fund is used, and one that does not is refused by sentence', () => {
    expect(templateProblem(TEMPLATE, FUND)).toBeNull()
    expect(templateProblem({ ...TEMPLATE, holiday_hours: 0 }, FUND)).toBe(TEMPLATE_OFF_FUND(160, 168))
    expect(templateProblem({ ...TEMPLATE, vacation_hours: -8, regular_hours: 176 }, FUND))
      .toBe(TEMPLATE_NEGATIVE)
  })

  it('a fund from the settings is what the template is held to', () => {
    const set = fundFor('2026-11', HOLIDAYS, 160, 8)
    expect(templateProblem(TEMPLATE, set)).toBe(TEMPLATE_OFF_FUND(168, 160))
    expect(templateProblem(proposeFromCalendar('2026-11', set), set)).toBeNull()
  })

  it('the sentences are Serbian and name both figures', () => {
    expect(TEMPLATE_OFF_FUND(160, 168)).toContain('160')
    expect(TEMPLATE_OFF_FUND(160, 168)).toContain('168')
    expect(TEMPLATE_OFF_FUND(160, 168)).toContain('Pretpostavljeni sati')
    expect(TEMPLATE_NEGATIVE).toBe('Pretpostavljeni sati ne mogu biti negativni.')
  })
})

describe('the days somebody is on the payroll', () => {
  it('a full month on payroll is the whole month', () => {
    expect(daysOnPayroll('2026-11', HOLIDAYS, person(1), [])).toEqual({
      days: 20, total: 20, firstDay: '2026-11-02', lastDay: '2026-11-30',
    })
  })

  it('agrees with the working days the grid prorates a joiner by', () => {
    const b = person(2, { hired_on: '2026-11-16' })
    const wd = workingDaysFor('2026-11', HOLIDAYS)
    const r = daysOnPayroll('2026-11', HOLIDAYS, b, [])
    expect(r.days).toBe(wd.forEmployee(b))
    expect(r.total).toBe(wd.total)
  })

  it('a joiner on the 16th has eleven of twenty days', () => {
    const r = daysOnPayroll('2026-11', HOLIDAYS, person(2, { hired_on: '2026-11-16' }), [])
    expect(r.days).toBe(11)
    expect(r.total).toBe(20)
    expect(r.firstDay).toBe('2026-11-16')
  })

  it('a leaver on the 10th has seven of twenty days', () => {
    const r = daysOnPayroll('2026-11', HOLIDAYS, person(1, { left_on: '2026-11-10' }), [])
    expect(r.days).toBe(7)
    expect(r.lastDay).toBe('2026-11-10')
  })

  it('an off-payroll period starting during the month ends the hours (C7)', () => {
    const r = daysOnPayroll('2026-11', HOLIDAYS, person(1), [away('emp-1', '2026-11-23')])
    expect(r.days).toBe(14)
    expect(r.lastDay).toBe('2026-11-20')
  })

  it('an off-payroll period that ends during the month starts the hours when they are back', () => {
    const r = daysOnPayroll('2026-11', HOLIDAYS, person(1),
      [{ ...away('emp-1', '2026-10-01'), valid_to: '2026-11-16' }])
    // valid_to is the first day back, as every dated row here reads it.
    expect(r.firstDay).toBe('2026-11-16')
    expect(r.days).toBe(11)
  })

  it('an off-payroll period of somebody else changes nothing', () => {
    expect(daysOnPayroll('2026-11', HOLIDAYS, person(1), [away('emp-9', '2026-11-23')]).days).toBe(20)
  })
})

describe('one person from the template', () => {
  it('scales every category by the share, rounded to the cent', () => {
    const row = timesheetFromTemplate('x', '2026-11', TEMPLATE, 11 / 20)
    expect(row.regular_hours).toBe(88)
    expect(row.holiday_hours).toBe(4.4)
    expect(row.month).toBe('2026-11-01')
    expect(row.employee_id).toBe('x')
    expect(row.note).toBeNull()
    expect(totalHours(row)).toBe(fundForEmployee(168, 11, 20))
  })

  it('a share of one is the template itself', () => {
    const row = timesheetFromTemplate('x', '2026-11', { ...TEMPLATE, regular_hours: 152, vacation_hours: 8 }, 1)
    expect([row.regular_hours, row.vacation_hours, row.holiday_hours]).toEqual([152, 8, 8])
  })
})

describe('applying the template', () => {
  const base = {
    month: '2026-11', template: TEMPLATE as PreliminaryHoursRow | null, holidays: HOLIDAYS,
    timesheets: {},
  }

  it('a joiner on the 16th gets their own fund', () => {
    const b = person(2, { hired_on: '2026-11-16' })
    const roster = rosterOf([b])
    const merge = applyPreliminaryHours({ ...base, people: roster.people, absences: [] })
    const row = merge.timesheets[b.id]
    expect(row.regular_hours).toBe(88)
    expect(row.holiday_hours).toBe(4.4)
    expect(totalHours(row)).toBe(92.4)
    expect(merge.onTemplate).toEqual([b.id])
    expect(merge.noDays).toEqual([])
  })

  it('a leaver on the 10th has seven of twenty days', () => {
    const a = person(1, { left_on: '2026-11-10' })
    const merge = applyPreliminaryHours({ ...base, people: rosterOf([a]).people, absences: [] })
    const row = merge.timesheets[a.id]
    expect(row.regular_hours).toBe(56)
    expect(row.holiday_hours).toBe(2.8)
    expect(totalHours(row)).toBe(fundForEmployee(168, 7, 20))
  })

  it('off payroll from the 12th: hours stop on the 10th and total less than the month (C7)', () => {
    const c = person(3)
    const absences = [away(c.id, '2026-11-12')]
    const roster = rosterOf([c], absences)
    const merge = applyPreliminaryHours({ ...base, people: roster.people, absences })
    const row = merge.timesheets[c.id]
    expect(row.regular_hours).toBe(56)
    expect(row.holiday_hours).toBe(2.8)
    expect(totalHours(row)).toBeLessThan(168)
    expect(merge.onTemplate).toEqual([c.id])
  })

  it('off payroll from the 2nd, the 1st a Sunday: no day on payroll, not counted, said', () => {
    const d = person(4)
    const absences = [away(d.id, '2026-11-02')]
    const roster = rosterOf([d], absences)
    expect(roster.people.map(p => p.employee.id)).toEqual([d.id])
    const merge = applyPreliminaryHours({ ...base, people: roster.people, absences })
    expect(merge.onTemplate).toEqual([])
    expect(merge.noDays).toEqual([d.id])
    // An all-zero row, so the run neither calculates them nor calls them missing.
    expect(totalHours(merge.timesheets[d.id])).toBe(0)
  })

  it('a real timesheet wins and is not counted', () => {
    const a = person(1), e = person(5)
    const real = { ...emptyTimesheet(e.id, '2026-11'), regular_hours: 100, vacation_hours: 68 }
    const roster = rosterOf([a, e])
    const merge = applyPreliminaryHours({
      ...base, people: roster.people, absences: [], timesheets: { [e.id]: real },
    })
    expect(merge.timesheets[e.id]).toBe(real)
    expect(merge.onTemplate).toEqual([a.id])
    expect(merge.noDays).toEqual([])
  })

  it('no template, nothing changes', () => {
    const roster = rosterOf([person(1)])
    const timesheets = {}
    const merge = applyPreliminaryHours({
      ...base, template: null, people: roster.people, absences: [], timesheets,
    })
    expect(merge.timesheets).toBe(timesheets)
    expect(merge.onTemplate).toEqual([])
    expect(merge.noDays).toEqual([])
  })

  it('never writes into the timesheets it was given', () => {
    const timesheets = {}
    applyPreliminaryHours({ ...base, people: rosterOf([person(1)]).people, absences: [], timesheets })
    expect(timesheets).toEqual({})
  })
})

describe('the kind of a month', () => {
  it('the running month on assumed hours is preliminary; any other month is not', () => {
    expect(monthKind({ running: true, onTemplate: 0, rateSettled: true })).toBe('regular')
    expect(monthKind({ running: true, onTemplate: 2, rateSettled: true })).toBe('preliminary')
    expect(monthKind({ running: false, onTemplate: 2, rateSettled: true })).toBe('regular')
  })

  it('a rate the month still waits for makes any month preliminary', () => {
    expect(monthKind({ running: true, onTemplate: 0, rateSettled: false })).toBe('preliminary')
    // A page left open across midnight on the last day.
    expect(monthKind({ running: false, onTemplate: 0, rateSettled: false })).toBe('preliminary')
  })

  it('a person with no day on the payroll and no timesheet keeps the running month preliminary', () => {
    expect(monthKind({ running: true, onTemplate: 0, noDays: 1, rateSettled: true })).toBe('preliminary')
    expect(monthKind({ running: true, onTemplate: 0, noDays: 0, rateSettled: true })).toBe('regular')
    expect(monthKind({ running: false, onTemplate: 0, noDays: 1, rateSettled: true })).toBe('regular')
  })
})

describe('the notice above a preliminary month', () => {
  it('says each part only when it is true, and goes on in lower case after the colon', () => {
    expect(noticeFor({ onTemplate: 3, people: 12 }))
      .toBe('Preliminarno: na pretpostavljenim satima obračunato je 3 od 12 zaposlenih.')
    expect(noticeFor({ onTemplate: 0, people: 12, noDays: 1 }))
      .toBe('Preliminarno: 1 zaposleni bez ijednog radnog dana u obračunu ovog meseca nema evidenciju radnog vremena.')
    expect(noticeFor({ onTemplate: 0, people: 12, noDays: 2 }))
      .toBe('Preliminarno: 2 zaposlena bez ijednog radnog dana u obračunu ovog meseca nemaju evidenciju radnog vremena.')
    expect(noticeFor({ onTemplate: 0, people: 12, rate: { day: '14.11.2026.', twentieth: '20.11.2026.' } }))
      .toBe('Preliminarno: iznosi u evrima preračunati su po kursu od 14.11.2026., a ne po kursu za 20.11.2026.')
    expect(noticeFor({ onTemplate: 3, people: 12, noDays: 1, rate: { day: 'nepoznatog dana', twentieth: '20.11.2026.' } }))
      .toBe('Preliminarno: na pretpostavljenim satima obračunato je 3 od 12 zaposlenih. '
        + '1 zaposleni bez ijednog radnog dana u obračunu ovog meseca nema evidenciju radnog vremena. '
        + 'Iznosi u evrima preračunati su po kursu od nepoznatog dana, a ne po kursu za 20.11.2026.')
  })
})
