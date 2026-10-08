// ─── Two names that are the same name ───────────────────────────────────────
//
// `Salary expenses domestic` and `Salary Expenses Domestic` were one
// department sub-category typed twice, months apart, through the same `+`
// button — which inserted whatever it was handed without ever looking to see
// whether it was already there.
//
// The cost was not the extra row. It was that the Budgeting tree groups by the
// label it reads, so one employee's cost split in half: the net salary under
// one spelling and the tax and contributions under the other, and neither row
// the cost of employing anybody. 2,172 accounting rows and $693,587.93 sat on
// the wrong side of a capital letter.
//
// ── What counts as the same ─────────────────────────────────────────────────
//
// Case, the spaces at the ends, and runs of spaces in the middle. All three
// are typing, not meaning: nobody intends `Salary  expenses` to be a different
// account from `Salary expenses`, and a chart of accounts that lets them be
// one is a chart of accounts that will eventually hold both.
//
// Accents are NOT folded. `Radović` and `Radovic` are two spellings of one
// person to a human and two different strings to everyone else, and quietly
// treating them as one would merge employees on a rule nobody asked for. That
// is a decision for whoever is looking at the list, not for an insert.

/** A name reduced to what it means, for comparison only — never for storage. */
export function foldName(name: string): string {
  return name.trim().toLowerCase().replace(/\s+/g, ' ')
}

/** Whether two names are the same account written differently. */
export function sameName(a: string, b: string): boolean {
  return foldName(a) === foldName(b)
}

/**
 * The row already holding this name, if there is one.
 *
 * `rows` must ALREADY BE NARROWED TO THE PARENT the new name would go under.
 * Eight departments each have their own `SaaS expenses` and none of them is a
 * duplicate of the others; searching the whole table would refuse to create
 * the ninth and file next month's spend under another department's account.
 */
export function findExisting<T extends { id: string; name: string }>(
  rows: T[], name: string,
): T | undefined {
  const folded = foldName(name)
  return rows.find(r => foldName(r.name) === folded)
}
