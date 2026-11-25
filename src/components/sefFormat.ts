// How the SEF inbox, and what it links to, print a date and an amount. Moved
// out of SefInboxDialog so the instalment chooser and the Krediti page print
// them the same way.

import { MONTHS_SHORT_SR } from '../utils/months'
import { fmtLocal } from '../utils/formatters'

/** A calendar date, read from its own digits: `new Date('2026-08-01')` is
 *  midnight UTC and prints as the day before west of Greenwich. */
export function fmtDate(value: string | null | undefined): string {
  const m = /^(\d{4})-(\d{2})-(\d{2})/.exec(value || '')
  if (!m) return value || '—'
  return `${Number(m[3])}. ${MONTHS_SHORT_SR[Number(m[2]) - 1]} ${m[1]}.`
}

export function fmtAmount(amount: number | null | undefined, currency: string | null | undefined): string {
  if (amount === null || amount === undefined) return '—'
  // Through the application's own formatter: 1.234,56 RSD.
  return currency ? fmtLocal(Number(amount), currency) : String(amount)
}
