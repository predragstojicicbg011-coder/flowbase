// ─── The exchange rate a payroll month is calculated on ────────────────────
//
// The rule is the NBS middle rate of the 20th. NBS publishes nothing at a
// weekend or on a public holiday, so "the 20th" is the business day the 20th
// walks back to. Until that day's list is out the rate service answers with
// the latest list it has — a real rate, but of an earlier day — and the pages
// must say so: euro amounts converted at it are not yet the month's.
//
// The day of a rate is the day its list applies from (`quotedOn`, from the
// service's `date_from`), never the day that was asked: the service echoes
// the asked day in `date`. A rate whose day is not known is never taken for
// the 20th's.
//
// NEVER A GUESSED RATE. FlowBase has no fallback rate; a month whose rate
// cannot be had shows no euro figures at all.

import { srDate } from '../../utils/months'
import { rateDateFor, type EmployeeForMonth } from './employees'
import { isWeekday, type HolidayRow } from './holidays'
import type { AdditionRow } from './additions'

export interface PayrollRate {
  /** RSD per 1 EUR. */
  eur: number
  /** The day the NBS list applies from, or null when the answer did not say. */
  quotedOn: string | null
  /** Whether it is the 20th's rate, which is what a month may be posted on. */
  ofTheTwentieth: boolean
  /** The business day whose list is the 20th's. */
  twentieth: string
}

const addDays = (iso: string, n: number): string => {
  const d = new Date(`${iso}T00:00:00Z`)
  d.setUTCDate(d.getUTCDate() + n)
  return d.toISOString().slice(0, 10)
}

/**
 * The business day a month's 20th maps to: the 20th, walked back over
 * weekends and public holidays, on which NBS publishes nothing.
 */
export function twentiethBusinessDay(month: string, holidays: HolidayRow[]): string {
  const off = new Set(holidays.map(h => h.holiday_on))
  let day = rateDateFor(month)
  while (!isWeekday(day) || off.has(day)) day = addDays(day, -1)
  return day
}

/** The month's rate, from the answer to `getBookRates(rateDateFor(month))`. */
export function rateForMonth(
  month: string,
  holidays: HolidayRow[],
  answer: { eurRate: number; quotedOn?: string | null },
): PayrollRate {
  const twentieth = twentiethBusinessDay(month, holidays)
  const quotedOn = answer.quotedOn ?? null
  return { eur: answer.eurRate, quotedOn, ofTheTwentieth: quotedOn === twentieth, twentieth }
}

// ─── What the pages say ─────────────────────────────────────────────────────

/** Where a rate's day would be named and the answer did not name it. */
export const UNKNOWN_RATE_DAY = 'nepoznatog dana'

/** HR's hours and additions, when no rate can be had at all. */
export const RATE_WITHHELD = 'Kurs NBS nije dostupan, pa iznosi u evrima nisu prikazani. '
  + 'Svi zaposleni su i dalje na spisku i sati mogu da se unose.'

const dayOf = (rate: PayrollRate): string =>
  (rate.quotedOn ? srDate(rate.quotedOn) : UNKNOWN_RATE_DAY)

/** A sentence that ends on a date written `20.11.2026.` takes no second period. */
const ending = (s: string): string => (s.endsWith('.') ? s : `${s}.`)

export const RATE_BADGE = (eur: string, day: string): string =>
  `1 EUR = ${eur} RSD, kurs NBS od ${day}`

export const RATE_NOT_YET_THE_TWENTIETHS = (twentieth: string, day: string): string =>
  `Kurs NBS za ${twentieth} još nije objavljen. `
  + `Iznosi u evrima preračunati su po kursu od ${ending(day)}`

export const POST_WAITS_FOR_THE_TWENTIETH = (day: string, twentieth: string): string =>
  `Obračun koristi kurs od ${day}, a ne kurs za ${ending(twentieth)} `
  + 'Knjiženje je moguće kada NBS objavi taj kurs.'

/** The badge beside the month picker. */
export function rateBadge(rate: PayrollRate, money: (n: number) => string): string {
  return RATE_BADGE(money(rate.eur), dayOf(rate))
}

/** The notice under it, or null for the 20th's rate. */
export function rateNotice(rate: PayrollRate): string | null {
  return rate.ofTheTwentieth ? null : RATE_NOT_YET_THE_TWENTIETHS(srDate(rate.twentieth), dayOf(rate))
}

/** Why Post waits, while the rate is not the 20th's. */
export function postWaitsForTheTwentieth(rate: PayrollRate): string {
  return POST_WAITS_FOR_THE_TWENTIETH(dayOf(rate), srDate(rate.twentieth))
}

/**
 * Whether the month turns anything that is not in dinars into dinars: a
 * contract, an addition, or a fixed deduction in another currency. Only such
 * a month depends on the rate, so only such a month waits for the 20th's.
 */
export function convertsForeignAmount(
  people: Pick<EmployeeForMonth, 'contract' | 'deductions'>[],
  additions: Pick<AdditionRow, 'currency'>[],
): boolean {
  const foreign = (c: string | null | undefined) => !!c && c !== 'RSD'
  return people.some(p => foreign(p.contract.currency)
      || p.deductions.some(d => d.amount !== null && foreign(d.currency)))
    || additions.some(a => foreign(a.currency))
}
