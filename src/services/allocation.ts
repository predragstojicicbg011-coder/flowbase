// ── Reading a by-value split back in the book currencies ─────────────────────
//
// Four columns hold the splits a user types by hand: rev_alloc_sg /
// rev_alloc_aimfox for the revenue streams, opex_amount / performance_amount
// for the expense type. All four are entered, and stored, in the currency of
// the bill. That is deliberate and it should stay: the dialogs label the
// inputs `Social Growth (EUR)`, check the two halves against the bill total,
// and seed them back from the stored value when the row is reopened. Asking
// someone looking at a 1,886 EUR invoice to split it in dinars would be
// asking them to do the conversion in their head.
//
// The reports print those figures beside amount_rsd (or amount_eur, when the
// viewer reads the books in euros). Read raw, a 1,886 EUR bill split
// 1,000 / 886 would print as 1,000 RSD and 886 RSD against a true total of
// 220,996 RSD — the page contradicting itself line by line.
//
// So the conversion belongs here, on read. The row already carries the
// factor: amount_rsd over amount is dinars per unit of whatever the row is in,
// at the rate the row was booked with (amount_eur over amount likewise for
// euros). Not today's rate, not a second lookup - the same rate that produced
// the total the split has to add up to. That is the whole reason this is
// derived from the row rather than fetched: it makes
// `sg + af = amount_rsd` (and `= amount_eur`) true by construction.
//
// Every function takes the display currency, because the two book figures
// are stored side by side and a report reads one of them — never a sum
// converted afterwards.

import { pickAmount, type DisplayCurrency } from '../contexts/DisplayCurrencyContext'

/** The fields of a P&L entry this module reads. Everything else is ignored. */
export interface AllocEntry {
  amount?: number | null
  amount_rsd?: number | null
  amount_eur?: number | null
  rev_alloc_type?: string | null
  rev_alloc_sg?: number | null
  rev_alloc_aimfox?: number | null
  opex_type?: string | null
  opex_amount?: number | null
  performance_amount?: number | null
}

const finite = (v: unknown): v is number => typeof v === 'number' && Number.isFinite(v)

/** The row's book figure in `currency`; a missing figure (no EUR yet) is 0. */
export function bookAmount(e: AllocEntry, currency: DisplayCurrency): number {
  return pickAmount(e, currency) ?? 0
}

/**
 * Units of `currency` per unit of the row's own currency, from what the row
 * already carries.
 *
 * A row already in `currency` gives 1, because its two amounts are equal.
 * Anything the factor cannot be computed from - no `amount`, a zero `amount`,
 * no book figure in that currency - gives 1 as well, which leaves the stored
 * figure exactly as typed. That is the wrong number for a foreign-currency
 * row, but it is finite: dividing by a missing or zero amount would otherwise
 * put Infinity or NaN into a column of money and poison every total it is
 * added to.
 */
export function bookFactor(e: AllocEntry, currency: DisplayCurrency): number {
  const amount = e.amount
  const book = pickAmount(e, currency)
  if (!finite(amount) || amount === 0) return 1
  if (!finite(book)) return 1
  const factor = book / amount
  return Number.isFinite(factor) ? factor : 1
}

/**
 * One revenue stream's share of an entry, in `currency`.
 *
 * `sg100` and `af100` hand the whole row to one stream and are already a book
 * figure, so the factor never touches them. Only the two typed figures of a
 * `byval` split are converted; where one of them was never filled in, the
 * half of the book figure that stands in for it is converted already.
 */
export function allocAmount(e: AllocEntry, stream: 'sg' | 'af', currency: DisplayCurrency): number {
  const amt = bookAmount(e, currency)
  if (e.rev_alloc_type === 'sg100') return stream === 'sg' ? amt : 0
  if (e.rev_alloc_type === 'af100') return stream === 'af' ? amt : 0
  if (e.rev_alloc_type === 'byval') {
    const f = bookFactor(e, currency)
    // Null check, not falsy - 0 is a valid allocation, and 0 * f is still 0.
    const raw = stream === 'af' ? e.rev_alloc_aimfox : e.rev_alloc_sg
    return raw != null ? raw * f : amt / 2
  }
  return amt / 2
}

/**
 * The OPEX or performance share of an expense, in `currency`.
 *
 * Same shape as the revenue split and the same rule: only the two typed
 * figures of a `split` are in the bill's currency. An entry with no
 * `opex_type` at all is treated as pure OPEX, which is what the page has
 * always done with rows classified before the field existed.
 */
export function opexAlloc(e: AllocEntry, type: 'opex' | 'performance', currency: DisplayCurrency): number {
  const amt = bookAmount(e, currency)
  if (!e.opex_type || e.opex_type === 'opex') return type === 'opex' ? amt : 0
  if (e.opex_type === 'performance') return type === 'performance' ? amt : 0
  if (e.opex_type === 'split') {
    const f = bookFactor(e, currency)
    const raw = type === 'opex' ? e.opex_amount : e.performance_amount
    return raw != null ? raw * f : amt / 2
  }
  return type === 'opex' ? amt : 0
}
