// ─── Today, in Belgrade ─────────────────────────────────────────────────────
//
// The one place the app turns "now" into a calendar date. Every page that
// opens on "this month" or "today" takes it from here, never from
// `new Date().toISOString()`, which is the UTC date.

const BELGRADE = new Intl.DateTimeFormat('en-CA', {
  timeZone: 'Europe/Belgrade', year: 'numeric', month: '2-digit', day: '2-digit',
})

/**
 * Today's date in Belgrade, 'YYYY-MM-DD'. Not `toISOString()`, which is the
 * UTC date: between midnight and 01:00 (02:00 in summer) on the 1st it is still
 * the last day of the previous month, and "Ovaj mesec" would open on it.
 * `.slice(0, 7)` of it is the running month.
 */
export function belgradeToday(now: Date = new Date()): string {
  const parts = BELGRADE.formatToParts(now)
  const get = (t: string) => parts.find(p => p.type === t)?.value || ''
  return `${get('year')}-${get('month')}-${get('day')}`
}
