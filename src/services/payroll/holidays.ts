// ─── Holidays, and the hour fund a month gets from them ─────────────────────
//
// The fund of hours in a month is arithmetic: its weekdays, times eight. The
// holidays among those weekdays are paid without being worked, and they are a
// bucket INSIDE the fund rather than a subtraction from it — which is the
// shape MPP uses, фонд сати у месецу alongside фонд сати празника, and the
// shape the timesheet reconciles against.
//
// THE RULE IS PROVED FOR TWO MONTHS AND ONLY GUESSED FOR THE REST, and that is
// worth being honest about. September 2026 has 22 weekdays, no holidays, and
// its settings say 176. The August 2026 payroll the engine reproduces to the
// cent was calculated on 168, which is its 21 weekdays. Both come out right.
// Neither month contains a holiday, so neither says anything about how a
// holiday is treated — hence `fundIsProvenFor`, which tells a caller when the
// month it is looking at rests on the part that has evidence and when it does
// not.
//
// A SETTING ALWAYS WINS. If somebody has entered фонд сати for a month, that
// is what a run uses. Derivation is a convenience, and a convenience must not
// overrule a figure a person put in on purpose.

import { fetchAllPages } from '../../utils/fetchAllPages'
import { firstOfMonth, workingDaysIn } from './timesheets'
import { countOf, plural } from '../../utils/plural'
import { monthLongLabel } from '../../utils/months'

export interface HolidayRow {
  id?: string
  holiday_on: string
  name: string
  kind: 'state' | 'orthodox' | 'substitute'
  note?: string | null
}

export const HOURS_PER_DAY = 8

/** The holidays falling inside a month. */
export function holidaysInMonth(holidays: HolidayRow[], month: string): HolidayRow[] {
  const first = firstOfMonth(month)
  const prefix = first.slice(0, 7)
  return holidays.filter(h => h.holiday_on.slice(0, 7) === prefix)
}

/** A holiday only shortens a month if it falls on a day that was worked. */
export function isWeekday(date: string): boolean {
  const [y, m, d] = date.slice(0, 10).split('-').map(Number)
  const dow = new Date(Date.UTC(y, m - 1, d)).getUTCDay()
  return dow !== 0 && dow !== 6
}

/** Holidays that land on a weekday, and so are paid rather than simply free. */
export function paidHolidaysIn(holidays: HolidayRow[], month: string): HolidayRow[] {
  return holidaysInMonth(holidays, month).filter(h => isWeekday(h.holiday_on))
}

export interface MonthFund {
  /** Фонд сати у месецу — every weekday, holidays included. */
  monthHours: number
  /** Фонд сати празника — the holidays among them. */
  holidayHours: number
  /** The hours somebody is actually expected to work. */
  workableHours: number
  /** Where each figure came from, which is what a caller has to report. */
  source: 'settings' | 'derived'
  /** The holidays behind `holidayHours`, so a page can name them. */
  holidays: HolidayRow[]
}

/**
 * The fund for a month.
 *
 * `settingsMonthHours` and `settingsHolidayHours` are whatever the payroll
 * settings hold for that month, or `null`. They take precedence wholesale
 * rather than field by field: a month half from a setting and half derived
 * would be a figure nobody entered and nobody computed.
 */
export function fundFor(
  month: string,
  holidays: HolidayRow[],
  settingsMonthHours: number | null,
  settingsHolidayHours: number | null,
): MonthFund {
  const inMonth = paidHolidaysIn(holidays, month)

  if (settingsMonthHours !== null) {
    const holidayHours = settingsHolidayHours ?? inMonth.length * HOURS_PER_DAY
    return {
      monthHours: settingsMonthHours,
      holidayHours,
      workableHours: round2(settingsMonthHours - holidayHours),
      source: 'settings',
      holidays: inMonth,
    }
  }

  const monthHours = workingDaysIn(month) * HOURS_PER_DAY
  const holidayHours = inMonth.length * HOURS_PER_DAY
  return {
    monthHours,
    holidayHours,
    workableHours: round2(monthHours - holidayHours),
    source: 'derived',
    holidays: inMonth,
  }
}

/**
 * Whether a derived fund rests only on the part with evidence behind it.
 *
 * True for a month with no holidays in it: weekdays × 8 is proved by August
 * and September 2026. A month WITH holidays additionally assumes that a
 * holiday is paid from inside the fund rather than taken off it, and no export
 * has ever shown that — so a page says which kind of month it is looking at
 * rather than presenting both with the same confidence.
 */
export function fundIsProvenFor(fund: MonthFund): boolean {
  return fund.source === 'settings' || fund.holidays.length === 0
}

/** A plain sentence about where a month's fund came from. */
export function explainFund(month: string, fund: MonthFund): string {
  if (fund.source === 'settings') {
    return `${fund.monthHours} ${plural(fund.monthHours, 'sat', 'sata', 'sati')}, iz podešavanja zarada za ${monthLongLabel(month)}.`
  }
  const days = fund.monthHours / HOURS_PER_DAY
  const daysWord = countOf(days, 'radni dan', 'radna dana', 'radnih dana')
  if (fund.holidays.length === 0) {
    return `${fund.monthHours} ${plural(fund.monthHours, 'sat', 'sata', 'sati')} — ${daysWord}, bez državnih praznika. `
      + 'Izračunato, a ne uneto; isti račun daje avgustu i septembru 2026. '
      + 'iste fondove koje su ti obračuni zaista koristili.'
  }
  const n = fund.holidays.length
  return `${fund.monthHours} ${plural(fund.monthHours, 'sat', 'sata', 'sati')} — ${daysWord}, od kojih `
    + `${n === 1 ? 'je' : 'su'} ${countOf(n, 'državni praznik', 'državna praznika', 'državnih praznika')} `
    + `(${fund.holidays.map(holidayName).join(', ')}), pa za rad ostaje ${fund.workableHours} `
    + `${plural(fund.workableHours, 'sat', 'sata', 'sati')}. `
    + 'Izračunato, a ne uneto, a nijedan izvoz još nije pokazao mesec sa praznikom — '
    + 'proverite ovaj mesec u MPP pre nego što se oslonite na njega.'
}

// ─── Holiday names, as the page shows them ──────────────────────────────────
//
// The public_holidays rows were seeded in Cyrillic and are stored that way;
// the interface is Latin. The official names (Zakon o državnim i drugim
// praznicima) are mapped here, and anything unknown is transliterated so a
// holiday somebody adds later still reads in the right script.

const OFFICIAL_HOLIDAY_NAMES: Record<string, string> = {
  'нова година': 'Nova godina',
  'божић': 'Božić',
  'дан државности': 'Sretenje — Dan državnosti Srbije',
  'сретење': 'Sretenje — Dan državnosti Srbije',
  'празник рада': 'Praznik rada',
  'велики петак': 'Veliki petak',
  'велика субота': 'Velika subota',
  'васкрс': 'Uskrs',
  'ускрс': 'Uskrs',
  'васкршњи понедељак': 'Uskrsni ponedeljak',
  'ускршњи понедељак': 'Uskrsni ponedeljak',
  'дан примирја': 'Dan primirja u Prvom svetskom ratu',
}

const HOLIDAY_SUFFIXES: Record<string, string> = {
  'други дан': 'drugi dan',
  'замена': 'prenet neradni dan',
}

const CYR_TO_LAT: Record<string, string> = {
  а: 'a', б: 'b', в: 'v', г: 'g', д: 'd', ђ: 'đ', е: 'e', ж: 'ž', з: 'z', и: 'i',
  ј: 'j', к: 'k', л: 'l', љ: 'lj', м: 'm', н: 'n', њ: 'nj', о: 'o', п: 'p', р: 'r',
  с: 's', т: 't', ћ: 'ć', у: 'u', ф: 'f', х: 'h', ц: 'c', ч: 'č', џ: 'dž', ш: 'š',
}

/** Serbian Cyrillic → Latin, letter by letter. */
export function toLatin(text: string): string {
  let out = ''
  for (const ch of text) {
    const lower = ch.toLowerCase()
    const lat = CYR_TO_LAT[lower]
    if (lat === undefined) { out += ch; continue }
    out += ch === lower ? lat : lat.charAt(0).toUpperCase() + lat.slice(1)
  }
  return out
}

/** The name a page shows for a holiday: official, in Latin script. */
export function holidayName(h: Pick<HolidayRow, 'name'>): string {
  const [base, ...rest] = h.name.split(',').map(p => p.trim())
  const official = OFFICIAL_HOLIDAY_NAMES[base.toLowerCase()] ?? toLatin(base)
  const suffix = rest.map(r => HOLIDAY_SUFFIXES[r.toLowerCase()] ?? toLatin(r))
  if (suffix.length === 0) return official
  return `${official} (${suffix.join(', ')})`
}

/**
 * Working days of a month, optionally only those inside a date range.
 *
 * Weekdays that are not public holidays. Used to prorate the hour fund for
 * somebody who joined or left mid-month — Đuro Milosavljević left on the 12th
 * of September 2026 and was here for 9 days of 22, Bojana Vučinić joined on
 * the 7th and was here for 18.
 *
 * `from` and `to` are inclusive, and either may be null for open-ended.
 */
export function workingDaysBetween(
  month: string,
  holidays: HolidayRow[],
  from?: string | null,
  to?: string | null,
): number {
  const first = firstOfMonth(month)
  const [y, m] = first.split('-').map(Number)
  const lastDay = new Date(Date.UTC(y, m, 0)).getUTCDate()
  const off = new Set(holidaysInMonth(holidays, month).map(h => h.holiday_on))

  let count = 0
  for (let d = 1; d <= lastDay; d++) {
    const date = `${first.slice(0, 8)}${String(d).padStart(2, '0')}`
    if (!isWeekday(date)) continue
    if (off.has(date)) continue
    if (from && date < from) continue
    if (to && date > to) continue
    count += 1
  }
  return count
}

/**
 * The working-day counter a payroll run needs, for one month.
 *
 * Bundled as one object because the total and the per-person figure have to
 * come from the same calendar: a person counted against a different month's
 * holidays would be paid a share of something that was never the denominator.
 */
export function workingDaysFor(month: string, holidays: HolidayRow[]): {
  total: number
  forEmployee: (e: { hired_on?: string | null; left_on?: string | null }) => number
} {
  const total = workingDaysBetween(month, holidays)
  return {
    total,
    forEmployee: e => workingDaysBetween(month, holidays, e.hired_on, e.left_on),
  }
}

/**
 * The hour fund for ONE person, which is not the month's when they were not
 * here for all of it.
 *
 * Vučinić Bojana joined on the 7th of September. The month's fund is 176 and
 * hers is 144 — and the export agrees: her sheet says `Nominal hours 144`.
 * Reconciling her against 176 reports 32 hours missing on a month that is
 * complete, which is the kind of complaint that teaches people to ignore the
 * check entirely.
 *
 * Prorated by WORKING DAYS rather than calendar days, so joining the day
 * before a weekend does not buy two days of fund.
 */
export function fundForEmployee(
  monthHours: number, daysEmployed: number, monthDays: number,
): number {
  if (!(monthDays > 0)) return monthHours
  if (daysEmployed >= monthDays) return monthHours
  return round2(monthHours * daysEmployed / monthDays)
}

export async function fetchHolidays(client: any, year?: number): Promise<HolidayRow[]> {
  return fetchAllPages<HolidayRow>((from, to) => {
    let q = client.from('public_holidays').select('*').order('holiday_on').range(from, to)
    if (year) {
      q = q.gte('holiday_on', `${year}-01-01`).lt('holiday_on', `${year + 1}-01-01`)
    }
    return q
  }).catch((e: any) => { throw new Error(`Državni praznici nisu učitani: ${e.message || e}. Osvežite stranu.`) })
}

const round2 = (n: number): number => Math.round(n * 100) / 100


/**
 * The last day of a month anybody works.
 *
 * A payroll invoice falls due on it — which is not the last day of the month,
 * and is not the same thing every month. September 2026 ends on a Wednesday
 * and the answer is the 30th; August 2026 ends on a Monday but that Monday is
 * a holiday, and then the answer is the Friday before it.
 *
 * Counted backwards from the end rather than forwards from the start: what is
 * wanted is the last one, and walking forwards to find it means holding a
 * candidate through the whole month and hoping nothing after it qualifies.
 *
 * Returns the last calendar day if the whole month is holidays and weekends,
 * which cannot happen — but a function that can return nothing makes every
 * caller handle a case that does not exist.
 */
export function lastWorkingDayOf(month: string, holidays: HolidayRow[]): string {
  const first = firstOfMonth(month)
  const [y, m] = first.split('-').map(Number)
  const lastDay = new Date(Date.UTC(y, m, 0)).getUTCDate()
  const off = new Set(holidaysInMonth(holidays, month).map(h => h.holiday_on))

  for (let d = lastDay; d >= 1; d--) {
    const date = `${first.slice(0, 8)}${String(d).padStart(2, '0')}`
    if (!isWeekday(date)) continue
    if (off.has(date)) continue
    return date
  }
  return `${first.slice(0, 8)}${String(lastDay).padStart(2, '0')}`
}
