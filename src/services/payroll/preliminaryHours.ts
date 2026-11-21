// ─── Preliminary hours: a template for the running month ───────────────────
//
// Before the real timesheets arrive (after the 20th), the running month can
// still be calculated on ASSUMED hours. They are kept as one template per
// month — "somebody who worked the whole month has these hours" — and never as
// timesheets: a stored timesheet would silence the check that catches a
// forgotten person, and a month could turn regular on hours nobody worked.
//
// So the template is applied in memory, only to people with no timesheet, and
// only for the running month. Each person gets the template scaled by the
// share of the month's working days they are on the payroll — the same share
// "Upiši pun mesec" and the per-person fund use. FlowBase has no R&D split,
// so every category is simply scaled: worked hours stay regular hours and the
// holiday stays a holiday.
//
// Their total is their per-person fund for a joiner or a leaver, to within
// 0.01 h a category (each is rounded on its own). It is LESS than that for
// somebody whose off-payroll period starts during the month (C7): nothing is
// assumed for the days after it starts, so those hours are simply not there.

import {
  HOUR_FIELDS, emptyTimesheet, firstOfMonth, type HourField, type TimesheetRow,
} from './timesheets'
import { holidaysInMonth, isWeekday, type HolidayRow, type MonthFund } from './holidays'
import type { EmployeeForMonth, AbsenceRow } from './employees'
import { coversDate } from './settings'
import { TEMPLATE_NEGATIVE, TEMPLATE_OFF_FUND, type RunKind } from './preliminaryText'

export type { RunKind } from './preliminaryText'

/** The template has every hour category a timesheet has. */
export type TemplateField = HourField

export const TEMPLATE_FIELDS: readonly TemplateField[] = HOUR_FIELDS

export type PreliminaryHoursRow = {
  /** `YYYY-MM-01`. */
  month: string
  note: string | null
  saved_by?: string | null
  saved_at?: string
} & Record<TemplateField, number>

/** The calendar's proposal: the workable hours as work, the holidays as holidays. */
export function proposeFromCalendar(month: string, fund: MonthFund): PreliminaryHoursRow {
  const row = { month: firstOfMonth(month), note: null } as PreliminaryHoursRow
  for (const f of TEMPLATE_FIELDS) row[f] = 0
  row.regular_hours = fund.workableHours
  row.holiday_hours = fund.holidayHours
  return row
}

export function templateTotal(t: PreliminaryHoursRow): number {
  return round2(TEMPLATE_FIELDS.reduce((sum, f) => sum + num(t[f]), 0))
}

/**
 * Why a template cannot be used for a month's fund, or `null`.
 *
 * A template whose total is not the fund would give everybody hours the grid
 * would call wrong. Checked when it is saved AND again when it is read: a
 * setting or a holiday may have changed the fund since (C9).
 */
export function templateProblem(t: PreliminaryHoursRow, fund: MonthFund): string | null {
  if (TEMPLATE_FIELDS.some(f => num(t[f]) < 0)) return TEMPLATE_NEGATIVE
  const total = templateTotal(t)
  if (Math.abs(total - fund.monthHours) >= 0.005) return TEMPLATE_OFF_FUND(total, fund.monthHours)
  return null
}

/**
 * The working days of a month somebody is on the payroll for.
 *
 * A working day is a weekday that is not a public holiday. Counted from the
 * later of the 1st and the hiring date to the earlier of the month's end and
 * the leaving date, both inclusive, leaving out every day an off-payroll
 * period of theirs covers — so a leave that starts on the 23rd ends the
 * assumed hours on the 20th, and nothing is assumed for the rest (C7).
 * `total` is the month's working days, the same as `workingDaysFor().total`.
 */
export function daysOnPayroll(
  month: string,
  holidays: HolidayRow[],
  employee: { id: string; hired_on?: string | null; left_on?: string | null },
  absences: AbsenceRow[],
): { days: number; total: number; firstDay: string | null; lastDay: string | null } {
  const first = firstOfMonth(month)
  const [y, m] = first.split('-').map(Number)
  const lastOfMonth = new Date(Date.UTC(y, m, 0)).getUTCDate()
  const off = new Set(holidaysInMonth(holidays, month).map(h => h.holiday_on))
  const mine = absences.filter(a => a.employee_id === employee.id)

  let days = 0, total = 0
  let firstDay: string | null = null, lastDay: string | null = null
  for (let d = 1; d <= lastOfMonth; d++) {
    const date = `${first.slice(0, 8)}${String(d).padStart(2, '0')}`
    if (!isWeekday(date) || off.has(date)) continue
    total += 1
    if (employee.hired_on && date < employee.hired_on) continue
    if (employee.left_on && date > employee.left_on) continue
    if (mine.some(a => coversDate(a as any, date))) continue
    days += 1
    if (firstDay === null) firstDay = date
    lastDay = date
  }
  return { days, total, firstDay, lastDay }
}

/** One person's hours from the template: every category scaled by `share`. */
export function timesheetFromTemplate(
  employeeId: string, month: string, template: PreliminaryHoursRow, share: number,
): TimesheetRow {
  const row = emptyTimesheet(employeeId, month)
  for (const f of TEMPLATE_FIELDS) row[f] = round2(num(template[f]) * share)
  row.note = null
  return row
}

export interface PreliminaryInput {
  month: string
  people: EmployeeForMonth[]
  timesheets: Record<string, TimesheetRow>
  template: PreliminaryHoursRow | null
  holidays: HolidayRow[]
  absences: AbsenceRow[]
}

export interface PreliminaryMerge {
  timesheets: Record<string, TimesheetRow>
  /** Who is calculated on the template: everybody on the roster with no timesheet. */
  onTemplate: string[]
  /**
   * On the roster but with no working day on the payroll this month (an
   * off-payroll period from the first working day). They get an all-zero row,
   * so a run neither calculates them nor calls them missing, are not counted
   * in `onTemplate`, and the page lists them with the people off payroll.
   */
  noDays: string[]
}

/**
 * The month's timesheets with the template filled in for whoever has none.
 * A real timesheet always wins; the given map is never written into.
 */
export function applyPreliminaryHours(input: PreliminaryInput): PreliminaryMerge {
  if (input.template === null) {
    return { timesheets: input.timesheets, onTemplate: [], noDays: [] }
  }
  const template = input.template
  const timesheets: Record<string, TimesheetRow> = { ...input.timesheets }
  const onTemplate: string[] = []
  const noDays: string[] = []

  for (const p of input.people) {
    const id = p.employee.id
    if (input.timesheets[id]) continue
    const { days, total } = daysOnPayroll(input.month, input.holidays, p.employee, input.absences)
    const share = total > 0 ? days / total : 0
    timesheets[id] = timesheetFromTemplate(id, input.month, template, share)
    if (days === 0) noDays.push(id)
    else onTemplate.push(id)
  }

  return { timesheets, onTemplate, noDays }
}

/**
 * Whether the month's calculation is preliminary. One answer for the whole
 * month: a month cannot be half postable.
 *
 * The running month is preliminary while anybody's hours are assumed — the
 * template, or the all-zero row of a person with no working day on the
 * payroll, which silences "no timesheet" and must not turn the month regular
 * on a row nobody entered.
 *
 * ANY month is preliminary while `rateSettled` is false: it converts an amount
 * that is not in dinars and its rate is not yet the 20th's (`payrollRate.ts`).
 * A month all in dinars does not depend on the rate, as the posting rule
 * already says, so it never waits for one.
 */
export function monthKind(a: {
  running: boolean; onTemplate: number; noDays?: number; rateSettled: boolean
}): RunKind {
  const assumed = a.onTemplate + (a.noDays ?? 0)
  return !a.rateSettled || (a.running && assumed > 0) ? 'preliminary' : 'regular'
}

function num(v: unknown): number {
  const n = typeof v === 'number' ? v : parseFloat(String(v ?? ''))
  return Number.isFinite(n) ? n : 0
}

const round2 = (n: number): number => Math.round(n * 100) / 100
