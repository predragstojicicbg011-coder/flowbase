// ── Money in MCFlow: RSD books, EUR beside them ───────────
//
// ONE CONVENTION, for every currency: the figure in Serbian notation, a space,
// then the ISO code — `1.234.567,89 RSD`, `1.234,56 EUR`, `1.234,56 USD`.
// The code goes after the number because that is how Serbian invoices and
// bank statements write it, and because a `€`/`$` prefix next to a Serbian
// decimal comma reads as two conventions at once.
//
//   fmtMoney(n, cur, decimals = 2)   full figure, KEEPS its minus: -1.234,56 EUR
//   fmtRSD / fmtEUR                  fmtMoney with the currency fixed
//   fmtMoneyCompact(n, cur, showSign) the glance scale for cards and dense
//                                    tables: 340 RSD, 12,3 hilj. RSD,
//                                    1,2 mil. RSD, 1,2 mlrd. RSD
//   fmtRSDCompact / fmtEURCompact    the same with the currency fixed
//   fmtMoneyWhole(n, cur, showSign)  the compact scale's full-precision twin:
//                                    26.432 RSD
//
// The compact and whole formatters follow the budget table's sign rules (see
// fmtUSDCompact below): zero is an em dash, a negative ALWAYS keeps its minus,
// `showSign` only decides whether a positive gets a `+`. Their (n, showSign)
// shape is `BudgetFigureFormat`'s, so they drop into the budget table.
//
// Not a number (null, undefined, NaN) prints an em dash everywhere.

const srFixed = (n: number, decimals: number): string =>
  n.toLocaleString('sr-RS', { minimumFractionDigits: decimals, maximumFractionDigits: decimals })

export const fmtMoney = (n: number | null | undefined, currency: string, decimals = 2): string => {
  if (typeof n !== 'number' || !Number.isFinite(n)) return '—'
  // toLocaleString of a negative that rounds to zero would print "-0,00".
  const v = Math.abs(n) < 0.5 * Math.pow(10, -decimals) ? 0 : n
  return `${srFixed(v, decimals)} ${currency}`
}

export const fmtRSD = (n: number | null | undefined, decimals = 2): string => fmtMoney(n, 'RSD', decimals)
export const fmtEUR = (n: number | null | undefined, decimals = 2): string => fmtMoney(n, 'EUR', decimals)

const signed = (n: number, body: string, showSign: boolean): string =>
  n < 0 ? `-${body}` : showSign ? `+${body}` : body

export const fmtMoneyCompact = (n: number | null | undefined, currency: string, showSign = false): string => {
  if (typeof n !== 'number' || !Number.isFinite(n) || n === 0) return '—'
  const abs = Math.abs(n)
  const scaled = (div: number, unit: string) => `${srFixed(abs / div, 1)} ${unit} ${currency}`
  const body =
    abs >= 1e9 ? scaled(1e9, 'mlrd.')
    : abs >= 1e6 ? scaled(1e6, 'mil.')
    : abs >= 1e3 ? scaled(1e3, 'hilj.')
    : `${srFixed(abs, 0)} ${currency}`
  return signed(n, body, showSign)
}

export const fmtRSDCompact = (n: number | null | undefined, showSign = false): string => fmtMoneyCompact(n, 'RSD', showSign)
export const fmtEURCompact = (n: number | null | undefined, showSign = false): string => fmtMoneyCompact(n, 'EUR', showSign)

export const fmtMoneyWhole = (n: number | null | undefined, currency: string, showSign = false): string => {
  if (typeof n !== 'number' || !Number.isFinite(n) || n === 0) return '—'
  return signed(n, `${srFixed(Math.abs(n), 0)} ${currency}`, showSign)
}

// ── Mintflow's USD formatters ─────────────────────────────
// Kept so pages not yet moved to RSD/EUR compile. Every one is deprecated.

/** @deprecated USD is not a reporting currency in MCFlow — use fmtMoney / fmtRSD / fmtEUR. */
export const fmtUSD = (n: number, decimals = 0): string => {
  if (!n && n !== 0) return '—'
  return '$' + Math.abs(n).toLocaleString('en-US', {
    minimumFractionDigits: decimals,
    maximumFractionDigits: decimals,
  })
}

/** @deprecated Use fmtMoney, which keeps the sign. */
export const fmtUSDSigned = (n: number, decimals = 0): string => {
  if (!n && n !== 0) return '—'
  const prefix = n < 0 ? '-$' : '$'
  return prefix + Math.abs(n).toLocaleString('en-US', {
    minimumFractionDigits: decimals,
    maximumFractionDigits: decimals,
  })
}

/**
 * A figure in Serbian notation, with the decimals ALWAYS written.
 *
 * `toLocaleString('sr-RS')` on its own drops trailing zeros and allows up to
 * three decimal places, so 86,292 dinars printed as `86.292` — which reads as
 * eighty-six thousand to a Serbian eye and as eighty-six point two nine two to
 * everyone else, and there is nothing in the string to say which. Writing the
 * para every time removes the question: `86.292,00` cannot be read any other
 * way.
 *
 * This is why the call sites do not format money themselves. There were ten
 * spellings of this across the application, four of them ambiguous.
 */
export const fmtNum = (n: number, decimals = 2): string => {
  if (!Number.isFinite(n)) return '—'
  return n.toLocaleString('sr-RS', {
    minimumFractionDigits: decimals,
    maximumFractionDigits: decimals,
  })
}

/**
 * Local currency (RSD, EUR) — Serbian locale: 1.234,56 RSD. See fmtMoney,
 * which keeps the sign, for new code.
 *
 * WRITES THE MAGNITUDE, NOT THE SIGN, the same way `fmtUSD` does: the call
 * sites that deal in direction supply their own `+` or `-` in front of it
 * (Cash Flow's in/out column, for one), and a minus arriving from both ends
 * would print `--1.234,56`. Where the sign belongs to the figure rather than
 * to the row, use `fmtNum`, which keeps it.
 */
export const fmtLocal = (n: number, currency: string, decimals = 2): string => {
  if (!n && n !== 0) return '—'
  return Math.abs(n).toLocaleString('sr-RS', {
    minimumFractionDigits: decimals,
    maximumFractionDigits: decimals,
  }) + ' ' + currency
}

// Smart formatter — picks format based on currency
export const fmtAmount = (n: number, currency: string): string => {
  if (!n && n !== 0) return '—'
  if (currency === 'USD') return fmtUSD(n, 2)
  return fmtLocal(n, currency)
}

// Percentage
export const fmtPct = (n: number, decimals = 1): string => {
  if (!n && n !== 0) return '—'
  return n.toFixed(decimals) + '%'
}

// Short number (for cards/summaries) — no decimals
export const fmtShort = (n: number, currency = 'USD'): string => {
  if (!n && n !== 0) return '—'
  if (currency === 'USD') return fmtUSD(n, 0)
  return fmtLocal(n, currency, 0)
}

/**
 * The budget table's own scale: $1.2K above a thousand, $340 below it, and an
 * em dash for nothing at all.
 *
 * Thirty-seven columns of figures do not fit at full precision, and a budget is
 * read for its shape rather than its cents. It lives here rather than in the
 * page because the drill-down under a cell has to print the same number the
 * same way — two copies of a formatter is how a total starts disagreeing with
 * the list behind it.
 *
 * `showSign` decides ONE thing: whether a positive number is announced with a
 * leading `+`. It does not decide whether a negative number keeps its minus —
 * nothing may, because a figure that prints its own negation is not a
 * formatting preference, it is a wrong number. While it did decide that, only
 * the variance cell passed the flag, so a `direct` row of −2,200 printed
 * `$2.2K` next to a variance computed from the real −2,200: one row, two
 * figures, 4,400 apart.
 *
 * @deprecated Use fmtRSDCompact / fmtEURCompact (same sign rules).
 */
export const fmtUSDCompact = (n: number, showSign = false): string => {
  if (n === 0) return '—'
  const abs = Math.abs(n)
  const str = abs >= 1000 ? `$${(abs / 1000).toFixed(1)}K` : `$${abs.toFixed(0)}`
  if (n < 0) return `-${str}`
  return showSign ? `+${str}` : str
}

/**
 * The same scale at full precision: `$26,432` where `fmtUSDCompact` says
 * `$26.4K`.
 *
 * `$6.7K` is a fine glance and a poor comparison — it is the same string for
 * every figure between 6,650 and 6,749, so two months an accountant is trying
 * to tell apart can read identically. It exists because thirty-seven columns
 * of figures do not fit at full precision; with the horizon narrowed to three
 * months they do, and then there is no reason to round the number the page is
 * read for.
 *
 * Sign rules are `fmtUSDCompact`'s, deliberately and to the letter: zero is an
 * em dash, a negative ALWAYS keeps its minus, and `showSign` decides one thing
 * only — whether a positive is announced with a `+`. The two formatters appear
 * in the same cell on different days, and a cell that changes a figure's sign
 * when the horizon changes is not a formatting preference, it is a wrong
 * number.
 *
 * @deprecated Use fmtMoneyWhole (same sign rules).
 */
export const fmtUSDFull = (n: number, showSign = false): string => {
  if (n === 0) return '—'
  const str = '$' + Math.abs(n).toLocaleString('en-US', {
    minimumFractionDigits: 0,
    maximumFractionDigits: 0,
  })
  if (n < 0) return `-${str}`
  return showSign ? `+${str}` : str
}

/** How the budget table prints a figure. Both formatters have this shape. */
export type BudgetFigureFormat = (n: number, showSign?: boolean) => string

/**
 * The one rule: full figures when the horizon is three months, compact beyond
 * it.
 *
 * Decided here rather than at each call site. The budget table prints a figure
 * in a dozen places — actual, estimate, variance, direct, committed, the
 * totals row, the Year column and the drill-down under any of them — and a
 * page where each of those picks its own formatter is a page where two of them
 * eventually disagree about what 6,700 is.
 */
export const budgetFigureFormat = (horizonMonths: number): BudgetFigureFormat =>
  horizonMonths <= 3 ? fmtUSDFull : fmtUSDCompact
