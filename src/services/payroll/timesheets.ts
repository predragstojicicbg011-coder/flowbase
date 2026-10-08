// ─── Timesheets: the hours behind a month ───────────────────────────────────
//
// One row per person per month: the hours worked, and every kind of absence in
// a column of its own, because each one is paid at its own coefficient.
//
// WHY THE HOURS ARE CHECKED AT ALL. An hour in the wrong column, or missing
// from the month altogether, becomes a salary that looks deliberate. So the
// arithmetic that can be checked — do the hours add up to the month — is
// checked, and loudly.
//
// It reports rather than refuses. Hours over the fund mean overtime; the
// engine will not calculate overtime because no export has exercised it, so
// the honest answer is to say so and let somebody look, not to reject a save
// and leave them with nowhere to put the number.

import { fetchAllPages } from '../../utils/fetchAllPages'

export interface TimesheetRow {
  id?: string
  employee_id: string
  /** Always the first of the month. */
  month: string

  // Worked.
  regular_hours: number

  // Away, and each paid at its own rate. See ABSENCES.
  holiday_hours: number
  vacation_hours: number
  sick_hours: number
  sick_full_hours: number
  sick_maternity_hours: number
  sick_fund_hours: number
  paid_leave_hours: number
  religious_holiday_hours: number
  military_court_hours: number
  work_stoppage_hours: number
  absence_hours: number
  undocumented_hours: number
  suspension_single_hours: number
  suspension_family_hours: number
  unpaid_hours: number

  note?: string | null
}

/**
 * Every kind of absence, and the setting that prices it.
 *
 * THE COEFFICIENT IS THE WHOLE POINT. Sick leave at the employer's expense is
 * paid at 0.65 and the same leave on a full fund at 1, and one "sick leave"
 * column cannot tell them apart — so it was either paid at the wrong rate or,
 * as it was, left out of the salary altogether. Neither is an answer.
 *
 * `settingKey` is the key in `payroll_settings`, so the rate is read for the
 * month being calculated rather than compiled in. `null` means this company
 * pays nothing for those hours: unpaid leave by agreement, and sick leave once
 * the health fund takes it over — which has no coefficient precisely because
 * it is not ours.
 *
 * NONE OF THESE COEFFICIENTS IS PROVED BY AN EXPORT. Every month checked so
 * far contains only work and annual leave, both at 1. They are the figures the
 * owner's own settings state, applied as those settings describe them, and a
 * run that uses any of the others says so rather than presenting the total
 * with the same confidence as a month that has been checked.
 */
export interface AbsenceCategory {
  field: AbsenceField
  label: string
  /** The key in payroll_settings, or null where nothing is paid. */
  settingKey: string | null
  /** Shown in the grid by default; the rest are behind a toggle. */
  common: boolean
}

export const ABSENCES: AbsenceCategory[] = [
  { field: 'holiday_hours', label: 'Public holiday', settingKey: 'drzavni_i_verski_praznik', common: true },
  { field: 'vacation_hours', label: 'Annual leave', settingKey: 'godisnji_odmor', common: true },
  { field: 'sick_hours', label: 'Sick leave, 65%', settingKey: 'bolovanje_na_teret_poslodavca', common: true },
  { field: 'sick_full_hours', label: 'Sick leave, full', settingKey: 'bolovanje_na_teret_poslodavca_pun_fond', common: true },
  { field: 'sick_maternity_hours', label: 'Maternity sick leave', settingKey: 'trudnicko_bolovanje_na_teret_poslodavca', common: false },
  { field: 'sick_fund_hours', label: 'Sick leave, the fund pays', settingKey: null, common: false },
  { field: 'paid_leave_hours', label: 'Paid leave', settingKey: 'placeno_odsustvo', common: true },
  { field: 'religious_holiday_hours', label: 'Religious holiday', settingKey: 'verski_praznik', common: false },
  { field: 'military_court_hours', label: 'Military or court summons', settingKey: 'vojni_ili_sudski_poziv', common: false },
  { field: 'work_stoppage_hours', label: 'Work stoppage', settingKey: 'prekid_rada', common: false },
  { field: 'absence_hours', label: 'Absence from work', settingKey: 'izostanak_sa_rada', common: false },
  { field: 'undocumented_hours', label: 'Undocumented', settingKey: 'nedokumentovani_sati', common: false },
  { field: 'suspension_single_hours', label: 'Suspended, living alone', settingKey: 'udaljenje_sa_posla_samac', common: false },
  { field: 'suspension_family_hours', label: 'Suspended, supporting a family', settingKey: 'udaljenje_sa_posla_izdrzava_porodicu', common: false },
  { field: 'unpaid_hours', label: 'Unpaid leave', settingKey: null, common: true },
]

export type AbsenceField =
  | 'holiday_hours' | 'vacation_hours' | 'sick_hours' | 'sick_full_hours'
  | 'sick_maternity_hours' | 'sick_fund_hours' | 'paid_leave_hours'
  | 'religious_holiday_hours' | 'military_court_hours' | 'work_stoppage_hours'
  | 'absence_hours' | 'undocumented_hours' | 'suspension_single_hours'
  | 'suspension_family_hours' | 'unpaid_hours'

export const WORK_FIELDS = ['regular_hours'] as const

export const HOUR_FIELDS = [
  ...WORK_FIELDS, ...ABSENCES.map(a => a.field),
] as const as readonly HourField[]

export type HourField = 'regular_hours' | AbsenceField

export function emptyTimesheet(employeeId: string, month: string): TimesheetRow {
  const row = { employee_id: employeeId, month: firstOfMonth(month), note: null } as TimesheetRow
  for (const f of HOUR_FIELDS) (row as any)[f] = 0
  return row
}

export function firstOfMonth(month: string): string {
  return /^\d{4}-\d{2}$/.test(month) ? `${month}-01` : `${month.slice(0, 7)}-01`
}

/** Everything on the row, including the hours nobody is paid for. */
export function totalHours(t: TimesheetRow): number {
  return round2(HOUR_FIELDS.reduce((sum, f) => sum + num(t[f]), 0))
}

/** The hours actually worked — what a salary is calculated from. */
export function workedHours(t: TimesheetRow): number {
  return round2(num(t.regular_hours))
}

/** Paid, whether worked or not. Only the unpriced categories are left out. */
export function paidHours(t: TimesheetRow): number {
  return round2(totalHours(t) - unpaidHours(t))
}

/** One category's contribution to what a month is worth. */
export interface HoursAtRate {
  field: HourField
  label: string
  hours: number
  /** 1 for work; whatever the settings price the absence at otherwise. */
  coefficient: number
  /** hours × coefficient — what the salary is actually prorated on. */
  effective: number
  /** False where no setting could be found for a category that has one. */
  priced: boolean
}

/**
 * What a month is worth in hours, category by category.
 *
 * NOT THE SAME AS THE HOURS THEMSELVES. Eight hours of sick leave at the
 * employer's expense are worth 5.2, because that is what the settings price
 * them at, and paying them as eight would overstate the month by a third of
 * them. Work is worth its hours; unpaid leave and fund-borne sick leave are
 * worth nothing.
 *
 * `coefficients` is a lookup by setting key, from the settings for the month.
 * A category whose setting is missing comes back with `priced: false` and
 * contributes NOTHING rather than defaulting to a rate — a coefficient
 * guessed at is a salary guessed at.
 */
export function hoursByCategory(
  t: TimesheetRow, coefficients: Record<string, number | null> = {},
): HoursAtRate[] {
  const out: HoursAtRate[] = []

  for (const field of WORK_FIELDS) {
    const hours = num(t[field])
    if (hours === 0) continue
    out.push({
      field, hours, coefficient: 1, effective: hours, priced: true, label: 'Work',
    })
  }

  for (const a of ABSENCES) {
    const hours = num(t[a.field])
    if (hours === 0) continue
    if (a.settingKey === null) {
      out.push({ field: a.field, label: a.label, hours, coefficient: 0, effective: 0, priced: true })
      continue
    }
    const coefficient = coefficients[a.settingKey]
    if (coefficient === null || coefficient === undefined) {
      out.push({ field: a.field, label: a.label, hours, coefficient: 0, effective: 0, priced: false })
      continue
    }
    out.push({
      field: a.field, label: a.label, hours, coefficient,
      effective: round2(hours * coefficient), priced: true,
    })
  }

  return out
}

/**
 * The coefficients for a month, by settings key.
 *
 * Built from whatever the settings hold, with a missing one left ABSENT
 * rather than filled in — `hoursByCategory` reports an absent coefficient by
 * name, and a zero here would look like a category priced at nothing.
 */
export function coefficientsFrom(
  read: (key: string) => number | null,
): Record<string, number | null> {
  const out: Record<string, number | null> = {}
  for (const a of ABSENCES) {
    if (a.settingKey === null) continue
    const value = read(a.settingKey)
    if (value !== null) out[a.settingKey] = value
  }
  return out
}

/** The hours a salary is prorated on, once every coefficient is applied. */
export function effectiveHours(
  t: TimesheetRow, coefficients: Record<string, number | null> = {},
): number {
  return round2(hoursByCategory(t, coefficients).reduce((sum, h) => sum + h.effective, 0))
}

/** Categories present in a month that nothing priced. */
export function unpricedCategories(
  t: TimesheetRow, coefficients: Record<string, number | null> = {},
): HoursAtRate[] {
  return hoursByCategory(t, coefficients).filter(h => !h.priced)
}

/** The absence hours this company pays nothing at all for. */
export function unpaidHours(t: TimesheetRow): number {
  return round2(ABSENCES
    .filter(a => a.settingKey === null)
    .reduce((sum, a) => sum + num(t[a.field]), 0))
}

/**
 * The hours a salary is calculated from, at the ordinary rate.
 *
 * Kept for callers that have no settings to hand. It counts work and the
 * absences priced at 1 in the settings as of 2026, and a month containing
 * anything paid at another rate needs `effectiveHours` and the coefficients.
 */
export function salaryHours(t: TimesheetRow): number {
  return round2(num(t.regular_hours)
    + num(t.holiday_hours) + num(t.vacation_hours))
}

/** Sick leave of every kind, whoever ends up paying for it. */
export function sickHours(t: TimesheetRow): number {
  return round2(num(t.sick_hours) + num(t.sick_full_hours)
    + num(t.sick_maternity_hours) + num(t.sick_fund_hours))
}

export interface TimesheetProblem {
  /** `error` stops a run; `warning` is worth seeing and may be intended. */
  level: 'error' | 'warning'
  message: string
}

/**
 * What is wrong with a timesheet, for a month whose fund is `monthHours`.
 *
 * `monthHours` comes from the payroll settings for that month. When it is
 * unknown the hours cannot be reconciled at all, and that is said rather than
 * passed over — a timesheet nobody could check is not a checked timesheet.
 */
export function checkTimesheet(t: TimesheetRow, monthHours: number | null): TimesheetProblem[] {
  const problems: TimesheetProblem[] = []
  const total = totalHours(t)

  for (const f of HOUR_FIELDS) {
    if (num(t[f]) < 0) {
      problems.push({ level: 'error', message: `${label(f)} cannot be negative.` })
    }
  }

  if (monthHours === null) {
    problems.push({
      level: 'warning',
      message: 'The hour fund for this month is not in the payroll settings, so these '
        + 'hours cannot be reconciled against anything.',
    })
    return problems
  }

  if (Math.abs(total - monthHours) < 0.005) return problems

  if (total > monthHours) {
    problems.push({
      level: 'error',
      message: `${fmt(total)} hours against a fund of ${fmt(monthHours)} — `
        + `${fmt(total - monthHours)} over. Hours above the fund are overtime, and the `
        + 'engine refuses to calculate overtime because no export has ever shown it. '
        + 'Either the hours are wrong or this month needs a rule that has been proved.',
    })
  } else {
    problems.push({
      level: 'error',
      message: `${fmt(total)} hours against a fund of ${fmt(monthHours)} — `
        + `${fmt(monthHours - total)} unaccounted for. Every hour of the month has to be `
        + 'somewhere, even if it is unpaid leave; hours that are simply missing become a '
        + 'smaller salary that looks deliberate.',
    })
  }
  return problems
}

/** Whether a whole month is fit to calculate from. */
export function monthIsReady(
  rows: { employee_id: string; timesheet: TimesheetRow | null }[],
  monthHours: number | null,
): { ready: boolean; missing: string[]; failing: string[] } {
  const missing: string[] = []
  const failing: string[] = []
  for (const r of rows) {
    if (!r.timesheet) { missing.push(r.employee_id); continue }
    if (checkTimesheet(r.timesheet, monthHours).some(p => p.level === 'error')) {
      failing.push(r.employee_id)
    }
  }
  return { ready: missing.length === 0 && failing.length === 0, missing, failing }
}

/**
 * A timesheet for somebody who has none yet, filled with a plain full month.
 *
 * Every hour goes to `regular_hours`. Twenty-five people each month is enough
 * typing to want a default; any absence is entered over it.
 */
export function prefill(employeeId: string, month: string, monthHours: number): TimesheetRow {
  return { ...emptyTimesheet(employeeId, month), regular_hours: monthHours }
}

/**
 * Working days in a month, Monday to Friday.
 *
 * A SUGGESTION AND NOT A FUND. It knows nothing about public holidays, and
 * Serbia has enough of them to move a month by a day or two — so it is offered
 * as a starting figure for somebody entering the hour fund, and never used to
 * reconcile anything. Computing the fund outright would mean this module
 * deciding what the holidays were, which is exactly the kind of rule it
 * refuses to invent.
 */
export function workingDaysIn(month: string): number {
  const [y, m] = firstOfMonth(month).split('-').map(Number)
  const days = new Date(Date.UTC(y, m, 0)).getUTCDate()
  let count = 0
  for (let d = 1; d <= days; d++) {
    const dow = new Date(Date.UTC(y, m - 1, d)).getUTCDay()
    if (dow !== 0 && dow !== 6) count += 1
  }
  return count
}

/** The suggestion in hours. Public holidays would reduce it. */
export function suggestedFund(month: string, hoursPerDay = 8): number {
  return workingDaysIn(month) * hoursPerDay
}

// ─── Reading and writing ────────────────────────────────────────────────────

export async function fetchTimesheets(client: any, month: string): Promise<TimesheetRow[]> {
  const first = firstOfMonth(month)
  return fetchAllPages<TimesheetRow>((from, to) =>
    client.from('payroll_timesheets').select('*')
      .eq('month', first).order('employee_id').range(from, to),
  ).catch((e: any) => { throw new Error(`The timesheets could not be read: ${e.message || e}`) })
}

/**
 * Save one timesheet, inserting or updating as needed.
 *
 * An upsert on (employee_id, month) rather than a read-then-write: the unique
 * index is what guarantees one row per person per month, and checking first
 * would leave a window in which two saves both decide to insert.
 */
export async function saveTimesheet(client: any, t: TimesheetRow): Promise<void> {
  const row: Record<string, unknown> = {
    employee_id: t.employee_id,
    month: firstOfMonth(t.month),
    note: t.note || null,
    updated_at: new Date().toISOString(),
  }
  // Every column, from the one list — so a category added to ABSENCES is
  // saved without anybody having to remember this function exists.
  for (const f of HOUR_FIELDS) row[f] = num(t[f])
  const { data, error } = await client
    .from('payroll_timesheets')
    .upsert(row, { onConflict: 'employee_id,month' })
    .select('id')
  if (error) throw new Error(`The hours could not be saved: ${error.message}`)
  // A zero-row upsert is a PostgREST success and would leave the page showing
  // figures nothing has stored — almost always RLS declining the write.
  if (!data || data.length === 0) {
    throw new Error('The hours were not saved and the database reported no error. '
      + 'This usually means the write was refused; check you are signed in as an '
      + 'administrator or owner.')
  }
}

export async function deleteTimesheet(client: any, id: string): Promise<void> {
  const { error } = await client.from('payroll_timesheets').delete().eq('id', id).select('id')
  if (error) throw new Error(`The timesheet could not be deleted: ${error.message}`)
}

// ─── Small things ───────────────────────────────────────────────────────────

function num(v: unknown): number {
  const n = typeof v === 'number' ? v : parseFloat(String(v ?? ''))
  return Number.isFinite(n) ? n : 0
}

const round2 = (n: number): number => Math.round(n * 100) / 100
const fmt = (n: number): string => (Math.round(n * 100) / 100).toString()

export function label(f: HourField): string {
  if (f === 'regular_hours') return 'Work'
  return ABSENCES.find(a => a.field === f)?.label ?? f
}
