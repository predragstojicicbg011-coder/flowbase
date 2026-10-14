// Correcting a bank line by hand.
//
// A statement is not always right: a description arrives truncated, a date is
// the posting date rather than the value date, an amount is read off the wrong
// column of an odd export. The bank statement dialog has always let the owner
// fix those before posting. This is the same rule, for the bulk import.
//
// THE ROW'S FINGERPRINT IS NOT RECOMPUTED when a value is corrected. It is
// taken once, from the file, and answers "has this line of this file been
// imported already?" — not "is this booking a duplicate?". Recomputing it
// would make a corrected row look like one nobody had ever seen, and the
// protection against importing the same statement twice would quietly stop
// working on exactly the rows that got attention.

export interface LineAmounts {
  /** Money out. Null, never 0, where the line is not an expense. */
  debit: number | null
  /** Money in. */
  credit: number | null
}

/**
 * What the two amount fields become when one of them is typed into.
 *
 * A bank line is one or the other, so filling one empties the other — the
 * same rule the statement dialog has. CLEARING a field does not refill its
 * opposite: an owner emptying a box is not asking for the other one back.
 *
 * `typed` is the raw text of a `number` input, so its decimal separator is
 * always a point and there is nothing to guess. The emptiness that decides
 * whether the opposite is cleared is the TEXT's, not the number's: `0` is
 * something typed, and it clears the other side like any other figure.
 */
export function editedAmounts(
  side: 'debit' | 'credit',
  typed: string,
  current: LineAmounts,
): LineAmounts {
  const n = typed === '' ? null : Number(typed)
  const value = n !== null && Number.isFinite(n) ? n : null
  const other = typed === '' ? current : { debit: null, credit: null }
  return side === 'debit'
    ? { debit: value, credit: other.credit }
    : { credit: value, debit: other.debit }
}

/** What a `number` input shows for an amount that may be absent. */
export const amountText = (v: number | null | undefined): string =>
  v === null || v === undefined || !Number.isFinite(v) ? '' : String(v)

/**
 * Apply a correction to one row's parsed line, leaving every other row and
 * everything else about this one as it was.
 *
 * Written here rather than inline so the thing that must NOT happen can be
 * held to by a test: the row's `import_hash` and `already_imported` are
 * outside `parsed` and are not touched. See the note at the top of this file
 * for why that matters.
 */
export function correctLine<R extends { parsed: { id: string } }>(
  rows: R[],
  id: string,
  patch: Partial<R['parsed']>,
): R[] {
  return rows.map(r => r.parsed.id === id ? { ...r, parsed: { ...r.parsed, ...patch } } : r)
}
