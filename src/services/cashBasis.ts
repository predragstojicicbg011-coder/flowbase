// ─── cashBasis ──────────────────────────────────────────────────────────────
//
// Which transactions are actually money moving.
//
// Almost all of them are: a row in `transactions` is a line on a bank
// statement. The exception is a currency gain. When a dinar invoice indexed to
// the euro is settled for less than it was booked at, the remainder is
// extinguished by an entry that belongs in the P&L and never touched the bank.
// Counting it as an inflow would overstate cash by exactly the difference.
//
// `cf_type = 'accrual'` is the marker, chosen because it already existed and
// nothing was using it — measured before the choice, not assumed: of 6,991
// posted transactions, 4,017 were recurring, 1,629 one-time, 1,345 unset, and
// none accrual.
//
// THE NULL TRAP, which is the reason this is a module and not a `.neq()`.
//
// `cf_type <> 'accrual'` is NULL for a row whose `cf_type` is NULL, and a NULL
// predicate excludes the row. So `.neq('cf_type', 'accrual')` would silently
// drop all 1,345 unclassified transactions — $3.9m of real cash — while
// looking exactly like the filter anyone would write.

/** The cash-flow types that mean "this never touched the bank". */
export const NON_CASH_CF_TYPES = ['accrual']

/**
 * The PostgREST `or=()` body that keeps only real movements.
 *
 * Spelled out rather than built from `NON_CASH_CF_TYPES`, because the two have
 * to stay legible side by side: one is what the predicate below tests and the
 * other is what the database is asked, and a reader has to be able to see they
 * agree.
 */
export const CASH_ONLY_FILTER = 'cf_type.is.null,cf_type.neq.accrual'

/** The same rule in memory, for rows already fetched. */
export function isCashMovement(row: { cf_type?: string | null }): boolean {
  const t = row?.cf_type
  if (t === null || t === undefined || t === '') return true
  return !NON_CASH_CF_TYPES.includes(t)
}

/** Keeps only the rows that moved money. */
export function cashOnly<T extends { cf_type?: string | null }>(rows: T[]): T[] {
  return rows.filter(isCashMovement)
}
