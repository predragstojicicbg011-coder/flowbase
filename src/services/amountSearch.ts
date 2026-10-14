// Finding a record by what it cost.
//
// The pickers that link an invoice to a transaction search on the partner's
// name, and a line with no partner on it cannot be found that way at all —
// which is exactly the line that needs linking by hand. The amount is on the
// screen in front of the owner, so he should be able to type it.
//
// SEPARATORS ARE IGNORED ENTIRELY, both in what is typed and in what is
// matched. `13.056,00` is thirteen thousand here and thirteen-and-a-bit in
// English, and the same keyboard produces both in this office. Deciding which
// was meant is a guess that would be wrong often enough to matter, so the
// comparison is made on digits alone and the question never arises.

/**
 * The digits of a query that is an amount, or '' for one that is not.
 *
 * A query only counts as an amount when it is ENTIRELY digits and separators.
 * `INV-2026` and `2026-10-09` carry digits too, and letting those through
 * would match them against money and fill the list with records that have
 * nothing to do with what was typed.
 */
export function amountQuery(query: string): string {
  const q = (query || '').trim()
  if (!/^[0-9][0-9.,\s]*$/.test(q)) return ''
  return q.replace(/\D/g, '')
}

/** The digits of an amount as it is written with two decimals: 13056 -> '1305600'. */
const digitsOfAmount = (a: number | string | null | undefined): string | null => {
  // `numeric` arrives from PostgREST as a string often enough to matter.
  const n = typeof a === 'string' ? Number(a) : a
  if (n === null || n === undefined || !Number.isFinite(n)) return null
  // Signed amounts are matched on their size: the owner types 13056, not
  // -13056, whichever side of the ledger the record sits on.
  return Math.abs(n).toFixed(2).replace(/\D/g, '')
}

/**
 * Does what was typed name any of these amounts?
 *
 * Substring, not equality, because this filters WHILE he types: after `130`
 * the list should already be shrinking toward 13.056,00, and it only reaches
 * equality on the last keystroke. It admits a few neighbours — `130` also
 * finds 1.300,00 — which is what a filter is for.
 */
export function matchesAmount(
  query: string,
  ...amounts: Array<number | string | null | undefined>
): boolean {
  const q = amountQuery(query)
  if (!q) return false
  return amounts.some(a => {
    const d = digitsOfAmount(a)
    return d !== null && d.includes(q)
  })
}
