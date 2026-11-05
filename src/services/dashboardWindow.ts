// ─── The home page's period: whole months ───────────────────────────────────
//
// A run of whole months, both ends inclusive, never past the current month.
// Months and not days, because every figure on the page is drawn per month:
// a period from the 17th to the 9th would put two half-months at the ends of
// every chart, drawn at the same height as the whole ones between them.
//
// The current month is counted to today — `ledgerRange` cuts it there — and
// never to a day that has not happened.
//
// Everything here takes `today` as a 'YYYY-MM-DD' string and slices it. It is
// never turned into a Date and back: a Date built from local calendar fields
// and read through toISOString() lands on the wrong day in the first hours of
// the 1st east of Greenwich.

import { addMonths, monthsBetween } from './debtSchedule'
import { MONTHS_SHORT_SR } from '../utils/months'

export interface MonthWindow {
  /** 'YYYY-MM' */
  from: string
  /** 'YYYY-MM' */
  to: string
}

const monthOf = (today: string) => today.slice(0, 7)

const BELGRADE = new Intl.DateTimeFormat('en-CA', {
  timeZone: 'Europe/Belgrade', year: 'numeric', month: '2-digit', day: '2-digit',
})

/**
 * Today's date in Belgrade, 'YYYY-MM-DD'. Not `toISOString()`, which is the
 * UTC date: between midnight and 01:00 (02:00 in summer) on the 1st it is still
 * the last day of the previous month, and "Ovaj mesec" would open on it.
 */
export function belgradeToday(now: Date = new Date()): string {
  const parts = BELGRADE.formatToParts(now)
  const get = (t: string) => parts.find(p => p.type === t)?.value || ''
  return `${get('year')}-${get('month')}-${get('day')}`
}

const isMonth = (m: string) => /^\d{4}-(0[1-9]|1[0-2])$/.test(m)

function lastDayOfMonth(month: string): number {
  const [y, m] = month.split('-').map(Number)
  return new Date(Date.UTC(y, m, 0)).getUTCDate()
}

/** The months in the window, oldest first. */
export function monthsOf(w: MonthWindow): string[] {
  const n = monthsBetween(w.from, w.to) + 1
  return Array.from({ length: Math.max(n, 0) }, (_, i) => addMonths(w.from, i))
}

/**
 * The ledger's date range: the 1st of the first month to the last day of the
 * last — or to today, when the window reaches the current month.
 */
export function ledgerRange(w: MonthWindow, today: string): { dateFrom: string; dateTo: string } {
  const dateFrom = `${w.from}-01`
  if (w.to >= monthOf(today)) return { dateFrom, dateTo: today }
  return { dateFrom, dateTo: `${w.to}-${String(lastDayOfMonth(w.to)).padStart(2, '0')}` }
}

/** The four shortcuts, in the order the page shows them. */
export const HOME_SHORTCUTS: { label: string; of(today: string): MonthWindow }[] = [
  { label: 'Ovaj mesec', of: today => ({ from: monthOf(today), to: monthOf(today) }) },
  {
    label: 'Ovaj kvartal',
    of: today => {
      const month = Number(today.slice(5, 7))
      const first = Math.floor((month - 1) / 3) * 3 + 1
      return { from: `${today.slice(0, 4)}-${String(first).padStart(2, '0')}`, to: monthOf(today) }
    },
  },
  { label: 'Od početka godine', of: today => ({ from: `${today.slice(0, 4)}-01`, to: monthOf(today) }) },
  {
    label: 'Prošli mesec',
    of: today => {
      const last = addMonths(monthOf(today), -1)
      return { from: last, to: last }
    },
  },
]

/** The label of the shortcut the window is, or '' when it is none of them. */
export function shortcutOf(w: MonthWindow, today: string): string {
  const hit = HOME_SHORTCUTS.find(s => {
    const x = s.of(today)
    return x.from === w.from && x.to === w.to
  })
  return hit ? hit.label : ''
}

const notPast = (m: string, today: string) => (m > monthOf(today) ? monthOf(today) : m)

/**
 * The window with a new first month. Never past the current month; when it
 * passes the last month, the last month comes with it. A cleared or malformed
 * value leaves the window as it was.
 */
export function withFrom(w: MonthWindow, month: string, today: string): MonthWindow {
  if (!isMonth(month)) return w
  const from = notPast(month, today)
  return { from, to: w.to < from ? from : w.to }
}

/** The window with a new last month, under the same rules. */
export function withTo(w: MonthWindow, month: string, today: string): MonthWindow {
  if (!isMonth(month)) return w
  const to = notPast(month, today)
  return { from: w.from > to ? to : w.from, to }
}

const short = (m: string) => MONTHS_SHORT_SR[Number(m.slice(5, 7)) - 1] ?? m

/** 'okt 2026', 'jan – nov 2026', 'nov 2025 – feb 2026'. */
export function windowLabel(w: MonthWindow): string {
  const fy = w.from.slice(0, 4)
  const ty = w.to.slice(0, 4)
  if (w.from === w.to) return `${short(w.from)} ${fy}`
  if (fy === ty) return `${short(w.from)} – ${short(w.to)} ${ty}`
  return `${short(w.from)} ${fy} – ${short(w.to)} ${ty}`
}
