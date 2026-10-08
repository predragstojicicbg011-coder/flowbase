// ─── Splitting one payment across several expenses ──────────────────────────
//
// One invoice, one bank line, two costs. A supplier bills 120,000 for a
// laptop and a year of support; the laptop is capital expenditure and the
// support is a software subscription, and until now the row had to be filed
// under one of them and the other was simply wrong.
//
// A split is a list of lines, each with its own classification and its own
// amount. What matters about it is one thing: THE LINES HAVE TO ADD UP. A
// split that is 50 short does not announce itself anywhere — the payment is
// still right, the bank still reconciles, and the P&L is quietly 50 light in
// one category and 50 heavy in nothing at all.
//
// So the arithmetic lives here, away from any dialog, and is tested directly.
//
// ── The dollar figure is derived, never typed ───────────────────────────────
//
// Every line carries its own currency amount and its dollar equivalent,
// because `v_pl_entries` exposes both and the reports read whichever suits
// them. The dollars come from THE PARENT'S OWN RATE — `amount_usd / amount`
// off the row being split — so the lines sum to the parent in both columns by
// construction. A rate fetched separately can be right about the day and
// still disagree with the row it is applied to, and then the two columns tell
// different stories about the same payment.
//
// ── The remainder goes somewhere on purpose ─────────────────────────────────
//
// Two lines of 1/3 and 2/3 of 100 cannot both be rounded and still sum to 100.
// Rather than let the difference fall where the floating point puts it, the
// LAST line takes whatever is left over. One line absorbs one rounding, every
// time, and it is the line the person was last looking at.

export interface SplitLine {
  /** Stable within the editor, so a line can be removed without reordering. */
  key: string
  /** In the parent's own currency. Empty while being typed. */
  amount: number | null
  pl_category: string
  pl_subcategory: string
  department: string
  dept_subcategory: string
  expense_description: string
  rev_alloc_type: string
  opex_type: string
  cf_type: string
  note: string
}

export interface SplitParent {
  /** The whole payment, in its own currency. */
  amount: number
  /** The same payment in dollars, as the row already carries it. */
  amount_usd?: number | null
}

const cents = (n: number): number => Math.round(n * 100) / 100

/** A blank line, ready to be filled from a script or by hand. */
export function emptyLine(key: string): SplitLine {
  return {
    key,
    amount: null,
    pl_category: '', pl_subcategory: '',
    department: '', dept_subcategory: '', expense_description: '',
    rev_alloc_type: 'shared', opex_type: 'opex', cf_type: '',
    note: '',
  }
}

/** What the lines come to, in the parent's own currency. */
export function sumOf(lines: SplitLine[]): number {
  return cents(lines.reduce((total, l) => total + (l.amount || 0), 0))
}

/**
 * What is still unaccounted for. Positive means the lines are short.
 *
 * Rounded to the cent before being compared, because `120000 - 40000 -
 * 80000.00000000001` is the kind of number binary floating point produces and
 * nobody should be asked to look at.
 */
export function remainderOf(parent: SplitParent, lines: SplitLine[]): number {
  return cents((parent.amount || 0) - sumOf(lines))
}

/**
 * A cent. The split is typed in whole units of the currency and every line is
 * stored to two places, so anything inside this is a rounding artefact rather
 * than a disagreement.
 */
export const SPLIT_TOLERANCE = 0.01

export function isBalanced(parent: SplitParent, lines: SplitLine[]): boolean {
  return Math.abs(remainderOf(parent, lines)) <= SPLIT_TOLERANCE
}

/**
 * Why the split cannot be saved yet, in a sentence, or null.
 *
 * Ordered so the answer is the thing to do next. A reader told "the lines do
 * not add up" when the real problem is a line with no category has been given
 * the least useful of the two true statements.
 */
export function whySplitNotSavable(
  parent: SplitParent, lines: SplitLine[],
): string | null {
  if (lines.length === 0) return null

  if (lines.length < 2) {
    return 'A split needs at least two lines. Remove it, or add a second.'
  }

  const blank = lines.findIndex(l => !l.pl_category.trim())
  if (blank >= 0) {
    return `Line ${blank + 1} has no P&L category. Every line is its own entry in `
      + 'the report, and one without a category lands in Unassigned.'
  }

  const noAmount = lines.findIndex(l => !(l.amount && l.amount > 0))
  if (noAmount >= 0) {
    return `Line ${noAmount + 1} has no amount. A line worth nothing is not a split, `
      + 'it is a line to remove.'
  }

  const left = remainderOf(parent, lines)
  if (Math.abs(left) > SPLIT_TOLERANCE) {
    return left > 0
      ? `The lines come to ${sumOf(lines).toFixed(2)} and the total is `
        + `${(parent.amount || 0).toFixed(2)} — ${Math.abs(left).toFixed(2)} is not accounted for.`
      : `The lines come to ${sumOf(lines).toFixed(2)}, which is `
        + `${Math.abs(left).toFixed(2)} MORE than the ${(parent.amount || 0).toFixed(2)} being split.`
  }

  return null
}

/**
 * The remainder put on one line, so a split can be finished in one press.
 *
 * On the line given, not spread: spreading a rounding difference across
 * several lines makes every one of them slightly wrong instead of one of them
 * exactly right, and the person can see which line absorbed it.
 */
export function absorbRemainder(
  parent: SplitParent, lines: SplitLine[], onIndex?: number,
): SplitLine[] {
  if (lines.length === 0) return lines
  const at = onIndex != null && onIndex >= 0 && onIndex < lines.length
    ? onIndex : lines.length - 1
  const left = remainderOf(parent, lines)
  if (left === 0) return lines
  return lines.map((l, i) =>
    i === at ? { ...l, amount: cents((l.amount || 0) + left) } : l)
}

/** Two lines, the second holding whatever the first does not. */
export function splitInHalf(parent: SplitParent, keyOf: (n: number) => string): SplitLine[] {
  const half = cents((parent.amount || 0) / 2)
  return [
    { ...emptyLine(keyOf(0)), amount: half },
    { ...emptyLine(keyOf(1)), amount: cents((parent.amount || 0) - half) },
  ]
}

export interface SplitRow {
  amount: number
  amount_usd: number | null
  pl_category: string | null
  pl_subcategory: string | null
  department: string | null
  dept_subcategory: string | null
  expense_description: string | null
  rev_alloc_type: string | null
  opex_type: string | null
  cf_type: string | null
  note: string | null
  sort_order: number
}

/**
 * The lines as rows to store, with the dollars derived and made to sum.
 *
 * THE LAST LINE TAKES THE ROUNDING. Converting each line separately and
 * storing the result leaves the dollar column short or long by a cent or two,
 * which is the kind of difference that survives for years because every
 * individual row looks right. Here every line but the last is converted and
 * rounded, and the last is whatever is left of the parent's own dollar
 * figure — so the column sums exactly, by construction rather than by luck.
 */
export function rowsFor(parent: SplitParent, lines: SplitLine[]): SplitRow[] {
  const total = parent.amount || 0
  const totalUsd = typeof parent.amount_usd === 'number' && Number.isFinite(parent.amount_usd)
    ? parent.amount_usd : null

  let usdSoFar = 0
  return lines.map((l, i) => {
    const amount = cents(l.amount || 0)
    let amount_usd: number | null = null
    if (totalUsd !== null && total !== 0) {
      amount_usd = i === lines.length - 1
        ? cents(totalUsd - usdSoFar)
        : cents((amount / total) * totalUsd)
      usdSoFar = cents(usdSoFar + amount_usd)
    }
    return {
      amount,
      amount_usd,
      pl_category: l.pl_category.trim() || null,
      pl_subcategory: l.pl_subcategory.trim() || null,
      department: l.department.trim() || null,
      dept_subcategory: l.dept_subcategory.trim() || null,
      expense_description: l.expense_description.trim() || null,
      rev_alloc_type: l.rev_alloc_type || null,
      opex_type: l.opex_type || null,
      cf_type: l.cf_type || null,
      note: l.note.trim() || null,
      sort_order: i,
    }
  })
}

/** A stored split read back into editable lines. */
export function linesFrom(rows: SplitRow[], keyOf: (n: number) => string): SplitLine[] {
  return [...rows]
    .sort((a, b) => a.sort_order - b.sort_order)
    .map((r, i) => ({
      key: keyOf(i),
      amount: r.amount,
      pl_category: r.pl_category || '',
      pl_subcategory: r.pl_subcategory || '',
      department: r.department || '',
      dept_subcategory: r.dept_subcategory || '',
      expense_description: r.expense_description || '',
      rev_alloc_type: r.rev_alloc_type || 'shared',
      opex_type: r.opex_type || 'opex',
      cf_type: r.cf_type || '',
      note: r.note || '',
    }))
}

// ── A line is a script and an amount ────────────────────────────────────────
//
// Eight classification fields per line, three lines, is twenty-four dropdowns
// on a form whose whole point was to be unobtrusive. A quick-fill script
// already carries all eight and is the thing people actually think in — "this
// half is Figma, that half is the laptop" — so a line is a script and a
// figure, and the classification comes along for the ride.
//
// The script's own name is NOT copied onto the line. A script is a template
// that may be renamed or retired, and a line that recorded the template's
// name instead of what it resolved to would read correctly and group wrongly.

export interface ScriptLike {
  id: string
  name: string
  icon?: string
  pl_category: string
  pl_subcategory: string
  department: string
  dept_subcategory: string
  expense_description: string
  /** The script's word for `rev_alloc_type`. */
  rev_alloc: string
  opex_type: string
  cf_type: string
}

/** A line filled from a script, keeping whatever amount it already had. */
export function applyScript(line: SplitLine, script: ScriptLike): SplitLine {
  return {
    ...line,
    pl_category: script.pl_category || '',
    pl_subcategory: script.pl_subcategory || '',
    department: script.department || '',
    dept_subcategory: script.dept_subcategory || '',
    expense_description: script.expense_description || '',
    rev_alloc_type: script.rev_alloc || line.rev_alloc_type,
    opex_type: script.opex_type || line.opex_type,
    cf_type: script.cf_type || line.cf_type,
  }
}

/**
 * Which script a line currently matches, so the picker can show it.
 *
 * By what the line HOLDS rather than by an id stored on it. A line keeps its
 * classification, not its provenance: a script edited afterwards does not
 * silently reclassify every line ever filled from it, and a line adjusted by
 * hand stops claiming to be the script it started as.
 */
export function scriptMatching(line: SplitLine, scripts: ScriptLike[]): ScriptLike | null {
  return scripts.find(s =>
    (s.pl_category || '') === line.pl_category
    && (s.pl_subcategory || '') === line.pl_subcategory
    && (s.department || '') === line.department
    && (s.dept_subcategory || '') === line.dept_subcategory
    && (s.expense_description || '') === line.expense_description) ?? null
}


// ── What the payment itself is classified as, while it is split ─────────────
//
// A split payment still has a classification of its own, and it is not
// decoration: the General Ledger lists it, the cash side reads it, and a row
// showing nothing under P&L Category reads as a row somebody forgot.
//
// But it must not be TYPED while a split exists. Two classifications on one
// screen, one of which the report ignores, is a form that invites somebody to
// set the wrong one carefully. So the fields below the editor are filled from
// the split and locked, and the one they are filled from is the BIGGEST line
// — the payment's own heading should be what most of it was for.

/** The line that most of the payment went to, or null when there is no split. */
export function dominantLine(lines: SplitLine[]): SplitLine | null {
  if (lines.length === 0) return null
  return lines.reduce((best, l) =>
    Math.abs(l.amount || 0) > Math.abs(best.amount || 0) ? l : best, lines[0])
}

export interface ParentClassification {
  pl_category: string
  pl_subcategory: string
  department: string
  dept_subcategory: string
  expense_description: string
}

/**
 * The classification a split payment should carry, from its biggest line.
 *
 * Null when nothing is split, which is how a caller knows to leave the fields
 * alone and let them be typed.
 */
export function classificationFromSplit(lines: SplitLine[]): ParentClassification | null {
  const top = dominantLine(lines)
  if (!top) return null
  return {
    pl_category: top.pl_category,
    pl_subcategory: top.pl_subcategory,
    department: top.department,
    dept_subcategory: top.dept_subcategory,
    expense_description: top.expense_description,
  }
}
