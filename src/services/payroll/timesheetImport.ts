// ─── Reading the department timesheet exports ───────────────────────────────
//
// Five files a month, one per department, one WORKSHEET PER EMPLOYEE. Each
// sheet is a month of daily rows followed by a summary block, and it is the
// summary block this reads. Not the daily rows: the file has already added
// them up, it carries its own `Difference` to prove it, and re-adding them
// here would be a second arithmetic that can disagree with the first.
//
// THE FILE CHECKS ITSELF AND THIS TRUSTS THAT CHECK. `Registered working time
// + requests` equals `Nominal hours` and `Difference` is zero on every one of
// the twenty-four sheets of September 2026. A sheet where that is not true is
// reported rather than imported — somebody has edited it, and the hours behind
// a payroll are not the place to find out later.
//
// TWO DURATION FORMATS IN THE SAME BLOCK, which is the one thing that will
// catch anybody reading this file by eye:
//
//   7 days, 0:00:00     168 hours — a day is 24 hours, not a working day
//   8:00 (days: 1)      8 hours — the day count is decorative
//
// WHAT IS NOT MAPPED IS NAMED. The export has ten leave categories and this
// module has columns for four of them. Maternity, paternity, parental, child
// care, occasional and private leave are each paid their own way, and bucketing
// them into "annual leave" would pay them at the wrong rate on a line that
// looks ordinary. Any of them that is not zero is reported, and every one of
// them is zero in the month this was built against.

import { emptyTimesheet, type TimesheetRow } from './timesheets'

/** A worksheet, as rows of cells. Whatever read the file produces this. */
export type SheetRows = unknown[][]

export interface ParsedEmployee {
  /** As the file spells it, with any phone number stripped. */
  name: string
  /** "Gradilište", "Mehanizacija" — the export's own word, not a ledger department. */
  department: string | null
  role: string | null
  /** Сати рада — what goes into the timesheet as work. */
  workedHours: number
  annualLeaveHours: number
  sickLeaveHours: number
  unpaidLeaveHours: number
  bankHolidayHours: number
  /** `Registered working time + requests`, the file's own total. */
  totalHours: number
  /** `Nominal hours`, the month's fund as the export sees it. */
  nominalHours: number
  /** Anything the file recorded that this module has no column for. */
  unmapped: { label: string; hours: number }[]
  /** Why this sheet must not be imported, if anything. */
  problems: string[]
}

/** Every label in the summary block, and where it goes. */
const MAPPED: Record<string, keyof Pick<ParsedEmployee,
  'workedHours' | 'annualLeaveHours' | 'sickLeaveHours' | 'unpaidLeaveHours' | 'bankHolidayHours'>> = {
  'Registered work time': 'workedHours',
  'Annual leave': 'annualLeaveHours',
  'Sick leave': 'sickLeaveHours',
  'Unpaid leave': 'unpaidLeaveHours',
  'Day off in lieu of bank holiday': 'bankHolidayHours',
}

/** Recorded, paid its own way, and deliberately not folded into the above. */
const UNMAPPED_LEAVE = [
  'Occasional leave', 'Child <14 care leave', 'Maternity leave',
  'Paternity leave', 'Parental leave', 'Private leave',
]

/** Breakdowns of `Registered work time`, already inside it. */
const INCLUSIVE = ['incl.: Weekend work', 'incl.: Remote work (hrs)', 'incl.: Business Trip']

const TOTAL = 'Registered working time + requests'
const NOMINAL = 'Nominal hours'
const DIFFERENCE = 'Difference'

/**
 * Hours from a duration cell.
 *
 * Handles both of the export's formats and the two ways a spreadsheet library
 * may hand the same cell back — as text, or already as a date or duration.
 */
export function hoursFrom(value: unknown): number {
  if (value === null || value === undefined || value === '') return 0
  if (typeof value === 'number') {
    // A serial fraction of a day, which is how a library may give `8:00:00`.
    return value * 24
  }
  if (value instanceof Date) {
    return value.getUTCHours() + value.getUTCMinutes() / 60 + value.getUTCSeconds() / 3600
  }
  let text = String(value).trim()
  if (!text) return 0
  // "(days: 1)" repeats what the hours already say.
  text = text.replace(/\(days:\s*\d+\)/i, '').trim()

  let days = 0
  const withDays = text.match(/^(\d+)\s*days?,\s*(.*)$/i)
  if (withDays) {
    days = parseInt(withDays[1], 10)
    text = withDays[2].trim()
  }
  if (!text) return days * 24

  const parts = text.split(':')
  const h = parseInt(parts[0], 10)
  const m = parts.length > 1 ? parseInt(parts[1], 10) : 0
  const sec = parts.length > 2 ? parseInt(parts[2], 10) : 0
  if (!Number.isFinite(h)) return days * 24
  return days * 24 + h + (Number.isFinite(m) ? m : 0) / 60 + (Number.isFinite(sec) ? sec : 0) / 3600
}

/** A cell as trimmed text, or ''. */
const text = (v: unknown): string => (v === null || v === undefined ? '' : String(v).trim())

/** The name without the phone number some rows carry. */
export function cleanName(raw: string): string {
  return raw.replace(/\[[^\]]*\]/g, '').trim()
}

/**
 * One employee, from one worksheet.
 *
 * Returns `null` for a sheet that is not a timesheet at all, rather than a
 * half-filled record — a workbook may one day grow a cover page, and an
 * employee called "Summary" with no hours would be worse than no employee.
 */
export function parseSheet(rows: SheetRows): ParsedEmployee | null {
  if (!rows || rows.length < 6) return null

  const name = cleanName(text(rows[1]?.[0]))
  if (!name) return null

  const role = text(rows[2]?.[0]) || null
  const deptCell = text(rows[3]?.[0])
  const department = deptCell.replace(/^Department:\s*/i, '').trim() || null

  const parsed: ParsedEmployee = {
    name, department, role,
    workedHours: 0, annualLeaveHours: 0, sickLeaveHours: 0,
    unpaidLeaveHours: 0, bankHolidayHours: 0,
    totalHours: 0, nominalHours: 0,
    unmapped: [], problems: [],
  }

  let sawSummary = false
  let difference = 0
  let sawDifference = false

  for (const row of rows) {
    // A summary row has no date in the first column; a daily row does. That
    // is what keeps "Annual leave" the label apart from "Annual leave [Whole
    // day]" the day, which carry the same hours in different places.
    if (text(row?.[0])) continue
    const label = text(row?.[2])
    if (!label) continue

    const value = row?.[5]
    if (label in MAPPED) {
      parsed[MAPPED[label]] = hoursFrom(value)
      sawSummary = true
    } else if (UNMAPPED_LEAVE.includes(label)) {
      const hours = hoursFrom(value)
      if (hours > 0) parsed.unmapped.push({ label, hours })
    } else if (label === TOTAL) {
      parsed.totalHours = hoursFrom(value)
    } else if (label === NOMINAL) {
      parsed.nominalHours = hoursFrom(value)
    } else if (label === DIFFERENCE) {
      difference = hoursFrom(value)
      sawDifference = true
    } else if (INCLUSIVE.includes(label)) {
      // Already counted inside Registered work time.
    }
  }

  if (!sawSummary) return null

  // ── What makes a sheet unusable ───────────────────────────────────────────

  if (!sawDifference) {
    parsed.problems.push(
      'List nema red Difference, pa ne može da potvrdi da se njegovi sati slažu. Izvezite ga ponovo.')
  } else if (Math.abs(difference) > 0.005) {
    parsed.problems.push(
      `Fajl prijavljuje razliku od ${round2(difference)} sati u odnosu na svoj fond (Nominal hours). `
      + 'Fajl je ručno menjan ili je nepotpun; sati za obračun zarade nisu mesto '
      + 'gde to treba otkriti kasnije. Izvezite ga ponovo.')
  }

  const summed = round2(parsed.workedHours + parsed.annualLeaveHours + parsed.sickLeaveHours
    + parsed.unpaidLeaveHours + parsed.bankHolidayHours
    + parsed.unmapped.reduce((s, u) => s + u.hours, 0))
  if (parsed.totalHours > 0 && Math.abs(summed - parsed.totalHours) > 0.005) {
    parsed.problems.push(
      `Kategorije daju ${summed} sati, a ukupno u samom fajlu je `
      + `${parsed.totalHours}. Nešto u bloku nije pročitano.`)
  }

  for (const u of parsed.unmapped) {
    parsed.problems.push(
      `${u.hours} sati „${u.label}“, za šta ovde nema kolone, a plaća se na svoj način. `
      + 'Da se doda godišnjem odmoru, bilo bi plaćeno po pogrešnoj stopi u redu koji izgleda '
      + 'sasvim obično, pa mora da se unese ručno.')
  }

  return parsed
}

export interface ParsedFile {
  /** The file's own name, for saying which one a problem came from. */
  fileName: string
  employees: ParsedEmployee[]
  /** Sheets that were not timesheets at all. */
  skipped: string[]
}

export function parseWorkbook(
  fileName: string, sheets: { name: string; rows: SheetRows }[],
): ParsedFile {
  const employees: ParsedEmployee[] = []
  const skipped: string[] = []
  for (const sheet of sheets) {
    const parsed = parseSheet(sheet.rows)
    if (parsed) employees.push(parsed)
    else skipped.push(sheet.name)
  }
  return { fileName, employees, skipped }
}

// ─── Matching a sheet to an employee ────────────────────────────────────────

/**
 * A name reduced to what two spellings of it have in common.
 *
 * Diacritics stripped, order ignored, case ignored. "Djurovic Teodor" and
 * "Đurović Teodor Viktor" still do not match — one has a middle name and the
 * other transliterates — and that is correct: a guess that pairs the wrong two
 * people puts one person's hours on another's salary, and both would look
 * plausible. Those are linked by hand once and the link is remembered.
 */
export function nameKey(name: string): string {
  const folded = cleanName(name)
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .replace(/đ/gi, 'd')
    .toLowerCase()
    .replace(/[^a-z0-9 ]/g, ' ')
  return folded.split(/\s+/).filter(Boolean).sort().join(' ')
}

export interface Match {
  parsed: ParsedEmployee
  employeeId: string | null
  /** How it was matched, so a page can say. */
  how: 'name' | 'remembered' | 'none'
}

/**
 * Pair each parsed sheet with an employee.
 *
 * `remembered` is a map from the file's spelling to an employee id, built up
 * as somebody links the ones that do not match by themselves. It wins over the
 * name comparison, because it is a decision somebody made and the comparison
 * is a guess that happened to work.
 */
export function matchEmployees(
  parsed: ParsedEmployee[],
  employees: { id: string; full_name: string }[],
  remembered: Record<string, string> = {},
): Match[] {
  const byKey = new Map<string, string[]>()
  for (const e of employees) {
    const key = nameKey(e.full_name)
    byKey.set(key, [...(byKey.get(key) ?? []), e.id])
  }

  return parsed.map(p => {
    const known = remembered[p.name]
    if (known) return { parsed: p, employeeId: known, how: 'remembered' as const }

    const ids = byKey.get(nameKey(p.name)) ?? []
    // Two employees whose names reduce to the same key is not a match. It is a
    // coin toss between two people's salaries.
    if (ids.length === 1) return { parsed: p, employeeId: ids[0], how: 'name' as const }
    return { parsed: p, employeeId: null, how: 'none' as const }
  })
}

// ─── Turning a match into a timesheet ───────────────────────────────────────

/**
 * The timesheet row a parsed sheet becomes. A SUGGESTION that stays editable.
 */
export function toTimesheet(
  parsed: ParsedEmployee,
  employeeId: string,
  month: string,
): TimesheetRow {
  return {
    ...emptyTimesheet(employeeId, month),
    regular_hours: round2(parsed.workedHours),
    holiday_hours: round2(parsed.bankHolidayHours),
    vacation_hours: round2(parsed.annualLeaveHours),
    sick_hours: round2(parsed.sickLeaveHours),
    unpaid_hours: round2(parsed.unpaidLeaveHours),
    note: null,
  }
}

const round2 = (n: number): number => Math.round(n * 100) / 100

// ─── Project hours survive an import ────────────────────────────────────────
//
// An import writes payroll_timesheets only. The hours on each project live in
// payroll_timesheet_projects and are never touched by it, so importing a month
// again cannot wipe them. What it CAN do is bring somebody's worked hours
// below what is already on their projects — and that is said before saving,
// because the posting will refuse the month until one of the two is corrected.

export interface ProjectHoursClash {
  employeeId: string
  worked: number
  onProjects: number
}

/** People whose imported worked hours fall below the hours already on their projects. */
export function projectHoursAboveWorked(
  sheets: readonly TimesheetRow[],
  projectHours: Readonly<Record<string, readonly { hours: number }[]>>,
): ProjectHoursClash[] {
  const out: ProjectHoursClash[] = []
  for (const t of sheets) {
    const onProjects = round2((projectHours[t.employee_id] ?? [])
      .reduce((s, r) => s + (Number(r.hours) || 0), 0))
    const worked = round2(Number(t.regular_hours) || 0)
    if (onProjects > worked + 0.005) out.push({ employeeId: t.employee_id, worked, onProjects })
  }
  return out
}
