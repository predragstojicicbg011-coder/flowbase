// Serbian (Latin) month names for labels the app builds itself, so a chart
// axis or a month grid never depends on the browser's locale data.

/** Short month names, index 0 = January: jan, feb, mar … dec. */
export const MONTHS_SHORT_SR = ['jan', 'feb', 'mar', 'apr', 'maj', 'jun', 'jul', 'avg', 'sep', 'okt', 'nov', 'dec']

/** Long month names, index 0 = January: januar, februar … decembar. */
export const MONTHS_LONG_SR = [
  'januar', 'februar', 'mart', 'april', 'maj', 'jun',
  'jul', 'avgust', 'septembar', 'oktobar', 'novembar', 'decembar',
]

/** The same names with a capital first letter, for a label that starts a line. */
export const capitalize = (s: string): string => s.charAt(0).toUpperCase() + s.slice(1)

/** 'YYYY-MM…' → 'okt 2026'. */
export function monthShortLabel(ym: string): string {
  const y = ym.slice(0, 4)
  const m = Number(ym.slice(5, 7))
  return `${MONTHS_SHORT_SR[m - 1] ?? '?'} ${y}`
}

/** 'YYYY-MM…' → 'oktobar 2026'. */
export function monthLongLabel(ym: string): string {
  const y = ym.slice(0, 4)
  const m = Number(ym.slice(5, 7))
  return `${MONTHS_LONG_SR[m - 1] ?? '?'} ${y}`
}

/** A date as 08.10.2026. */
export const srDate = (d: string | Date): string =>
  new Date(d).toLocaleDateString('sr-Latn-RS', { day: '2-digit', month: '2-digit', year: 'numeric' })
