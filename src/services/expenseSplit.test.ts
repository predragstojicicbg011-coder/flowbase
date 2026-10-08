import {
  emptyLine, sumOf, remainderOf, isBalanced, whySplitNotSavable,
  absorbRemainder, splitInHalf, rowsFor, linesFrom,
  SPLIT_TOLERANCE, applyScript, scriptMatching, dominantLine,
  classificationFromSplit, splitProjectChange, type SplitLine,
} from './expenseSplit'
import { RateUnavailableError } from './bookAmounts'

const key = (n: number) => `k${n}`

const line = (over: Partial<SplitLine> & { amount: number }): SplitLine => ({
  ...emptyLine(`k${Math.random()}`),
  pl_category: 'General Business',
  ...over,
})

describe('what the lines come to', () => {
  it('adds them up', () => {
    expect(sumOf([line({ amount: 40000 }), line({ amount: 80000 })])).toBe(120000)
  })

  /** `120000 - 40000 - 80000.00000000001` is the kind of number binary
   *  floating point produces, and nobody should be asked to look at it. */
  it('does not leave a floating-point tail on the answer', () => {
    expect(sumOf([line({ amount: 0.1 }), line({ amount: 0.2 })])).toBe(0.3)
  })

  it('treats a line still being typed as nothing yet', () => {
    expect(sumOf([line({ amount: 500 }), { ...emptyLine('x'), amount: null }])).toBe(500)
  })

  it('has nothing to add with no lines', () => {
    expect(sumOf([])).toBe(0)
  })
})

describe('what is unaccounted for', () => {
  const parent = { amount: 120000 }

  it('is positive when the lines are short', () => {
    expect(remainderOf(parent, [line({ amount: 100000 })])).toBe(20000)
  })

  it('is negative when they overshoot', () => {
    expect(remainderOf(parent, [line({ amount: 130000 })])).toBe(-10000)
  })

  it('is nothing when they land exactly', () => {
    expect(remainderOf(parent, [line({ amount: 40000 }), line({ amount: 80000 })])).toBe(0)
    expect(isBalanced(parent, [line({ amount: 40000 }), line({ amount: 80000 })])).toBe(true)
  })

  it('allows a cent either way and no more', () => {
    expect(isBalanced(parent, [line({ amount: 120000 - SPLIT_TOLERANCE })])).toBe(true)
    expect(isBalanced(parent, [line({ amount: 120000 - 0.02 })])).toBe(false)
  })
})

describe('why a split cannot be saved', () => {
  const parent = { amount: 1000 }

  it('has nothing to say about a row that is not split at all', () => {
    expect(whySplitNotSavable(parent, [])).toBeNull()
  })

  it('refuses a split of one, which is not a split', () => {
    expect(whySplitNotSavable(parent, [line({ amount: 1000 })]))
      .toMatch(/najmanje dve stavke/)
  })

  /**
   * Ordered so the answer is the thing to do next. Told "the lines do not add
   * up" when the real problem is a line with no category, a reader has been
   * given the less useful of two true statements.
   */
  it('names the line with no category before it mentions the total', () => {
    const why = whySplitNotSavable(parent, [
      line({ amount: 400 }),
      { ...emptyLine('b'), amount: 100, pl_category: '' },
    ])
    expect(why).toMatch(/Stavka 2 nema P&L kategoriju/)
  })

  it('names a line with no amount', () => {
    expect(whySplitNotSavable(parent, [line({ amount: 1000 }), line({ amount: 0 })]))
      .toMatch(/Stavka 2 nema iznos/)
  })

  it('says how much is missing, and which way', () => {
    expect(whySplitNotSavable(parent, [line({ amount: 400 }), line({ amount: 500 })]))
      .toMatch(/100,00 nije raspoređeno/)
    expect(whySplitNotSavable(parent, [line({ amount: 600 }), line({ amount: 500 })]))
      .toMatch(/100,00 VIŠE/)
  })

  it('passes a split that balances', () => {
    expect(whySplitNotSavable(parent, [line({ amount: 400 }), line({ amount: 600 })]))
      .toBeNull()
  })
})

describe('absorbing the remainder', () => {
  const parent = { amount: 1000 }

  /** One line absorbs one rounding, and it is visible which. */
  it('puts what is left on the last line by default', () => {
    const out = absorbRemainder(parent, [line({ amount: 333.33 }), line({ amount: 333.33 })])
    expect(out[0].amount).toBe(333.33)
    expect(out[1].amount).toBe(666.67)
    expect(sumOf(out)).toBe(1000)
  })

  it('puts it on the line asked for', () => {
    const out = absorbRemainder(parent, [line({ amount: 100 }), line({ amount: 100 })], 0)
    expect(out[0].amount).toBe(900)
    expect(out[1].amount).toBe(100)
  })

  it('takes money off when the lines overshoot', () => {
    const out = absorbRemainder(parent, [line({ amount: 700 }), line({ amount: 700 })])
    expect(out[1].amount).toBe(300)
    expect(sumOf(out)).toBe(1000)
  })

  it('changes nothing when it already balances', () => {
    const lines = [line({ amount: 400 }), line({ amount: 600 })]
    expect(absorbRemainder(parent, lines)).toBe(lines)
  })

  it('has nothing to absorb into with no lines', () => {
    expect(absorbRemainder(parent, [])).toEqual([])
  })
})

describe('starting from a half', () => {
  it('splits an even amount evenly', () => {
    const out = splitInHalf({ amount: 1000 }, key)
    expect(out.map(l => l.amount)).toEqual([500, 500])
  })

  /** An odd number of para cannot halve twice. The second line takes it. */
  it('gives the odd para to the second line', () => {
    const out = splitInHalf({ amount: 1000.01 }, key)
    expect(sumOf(out)).toBe(1000.01)
    expect(out[0].amount).toBe(500.01)
    expect(out[1].amount).toBe(500)
  })
})

// 120,000 RSD at 117.5 RSD per EUR = 1,021.28 EUR.
const RSD_PARENT = { amount: 120000, currency: 'RSD', exchange_rate: 1, eur_rate: 117.5, amount_rsd: 120000, amount_eur: 1021.28 }

describe('the rows that get stored', () => {
  const parent = RSD_PARENT
  const lines = [
    line({ amount: 40000, pl_category: 'Capital expenditures' }),
    line({ amount: 80000, pl_category: 'General Business' }),
  ]

  it('keeps each line its own classification', () => {
    const rows = rowsFor(parent, lines)
    expect(rows[0].pl_category).toBe('Capital expenditures')
    expect(rows[1].pl_category).toBe('General Business')
  })

  it('numbers them so they come back in the order they were typed', () => {
    expect(rowsFor(parent, lines).map(r => r.sort_order)).toEqual([0, 1])
  })

  /**
   * The whole reason the book figures are derived rather than converted line
   * by line: a column short by a para survives for years, because every
   * single row in it looks right.
   */
  it('makes the RSD and EUR columns sum to the parent exactly', () => {
    // 100 USD at 101.23 = 10,123 RSD; at 117.07 RSD per EUR = 86.47 EUR.
    // Line by line, 33.33 USD is 3,374.0 RSD / 28.82 EUR; the last takes the rest.
    const usdParent = { amount: 100, currency: 'USD', exchange_rate: 101.23, eur_rate: 117.07, amount_rsd: 10123, amount_eur: 86.47 }
    const rows = rowsFor(usdParent, [
      line({ amount: 33.33 }), line({ amount: 33.33 }), line({ amount: 33.34 }),
    ])
    const sum = (k: 'amount_rsd' | 'amount_eur') => Math.round(rows.reduce((s, r) => s + r[k], 0) * 100) / 100
    expect(sum('amount_rsd')).toBe(10123)
    expect(sum('amount_eur')).toBe(86.47)
    expect(rows[0].amount_rsd).toBe(3374)       // 33.33 * 101.23 = 3373.9959
    expect(rows[0].amount_eur).toBe(28.82)      // 3374 / 117.07 = 28.820
    expect(rows[2].amount_rsd).toBe(3375)       // 10123 - 2 * 3374
  })

  it('books a EUR parent exactly in EUR', () => {
    const eurParent = { amount: 1000, currency: 'EUR', exchange_rate: 117.5, eur_rate: 117.5, amount_rsd: 117500, amount_eur: 1000 }
    const rows = rowsFor(eurParent, [line({ amount: 400 }), line({ amount: 600 })])
    expect(rows.map(r => [r.amount, r.amount_rsd, r.amount_eur])).toEqual([[400, 47000, 400], [600, 70500, 600]])
  })

  it('keeps the own-currency column summing to the parent too', () => {
    const rows = rowsFor(parent, lines)
    expect(rows.reduce((s, r) => s + r.amount, 0)).toBe(120000)
  })

  it('refuses to book lines when the parent has no stored rates', () => {
    expect(() => rowsFor({ amount: 100, currency: 'USD' }, lines)).toThrow(RateUnavailableError)
  })

  it('stores an empty classification as nothing rather than as an empty string', () => {
    const rows = rowsFor(parent, [
      { ...emptyLine('a'), amount: 60000, pl_category: 'X' },
      { ...emptyLine('b'), amount: 60000, pl_category: 'Y' },
    ])
    expect(rows[0].department).toBeNull()
    expect(rows[0].expense_description).toBeNull()
  })
})

describe('reading a stored split back', () => {
  it('comes back in the order it was stored, whatever order it arrives in', () => {
    const lines = linesFrom([
      { ...rowsFor({ ...RSD_PARENT, amount: 2, amount_rsd: 2, amount_eur: 0.02 }, [line({ amount: 2, pl_category: 'B' })])[0], sort_order: 1 },
      { ...rowsFor({ ...RSD_PARENT, amount: 1, amount_rsd: 1, amount_eur: 0.01 }, [line({ amount: 1, pl_category: 'A' })])[0], sort_order: 0 },
    ], key)
    expect(lines.map(l => l.pl_category)).toEqual(['A', 'B'])
  })

  it('survives a round trip without changing a figure', () => {
    const parent = RSD_PARENT
    const original = [
      line({ amount: 40000, pl_category: 'Capital expenditures', department: 'Product' }),
      line({ amount: 80000, pl_category: 'General Business', department: 'Admin' }),
    ]
    const back = linesFrom(rowsFor(parent, original), key)
    expect(back.map(l => l.amount)).toEqual([40000, 80000])
    expect(back.map(l => l.department)).toEqual(['Product', 'Admin'])
    expect(isBalanced(parent, back)).toBe(true)
  })

  /** One bill shared by two sites: each line carries its own project, and a
   *  line on no project is overhead (null), not an empty string. */
  it('carries each line’s project through to the row and back', () => {
    const parent = RSD_PARENT
    const original = [
      line({ amount: 40000, pl_category: 'A', project_id: 'site-1' }),
      line({ amount: 80000, pl_category: 'B', project_id: null }),
    ]
    const rows = rowsFor(parent, original)
    expect(rows.map(r => r.project_id)).toEqual(['site-1', null])
    const back = linesFrom(rows, key)
    expect(back.map(l => l.project_id)).toEqual(['site-1', null])
  })

  it('stores an empty-string project as overhead (null)', () => {
    const rows = rowsFor(RSD_PARENT, [
      line({ amount: 60000, pl_category: 'A', project_id: '' as any }),
      line({ amount: 60000, pl_category: 'B', project_id: 'site-2' }),
    ])
    expect(rows[0].project_id).toBeNull()
    expect(rows[1].project_id).toBe('site-2')
  })
})

describe('a line filled from a script', () => {
  const script = {
    id: 's1', name: 'Figma', icon: '⚡',
    pl_category: 'General Business', pl_subcategory: 'Software subscriptions',
    department: 'Admin', dept_subcategory: 'Tools', expense_description: 'Figma',
    cf_type: 'recurring',
  }

  it('takes all six fields off the script', () => {
    const out = applyScript(emptyLine('a'), script)
    expect(out.pl_category).toBe('General Business')
    expect(out.dept_subcategory).toBe('Tools')
    expect(out.cf_type).toBe('recurring')
  })

  /** A script carries no project; the line's project is chosen per document. */
  it('keeps the project the line already had', () => {
    const out = applyScript({ ...emptyLine('a'), project_id: 'p-1' }, script)
    expect(out.project_id).toBe('p-1')
    expect(applyScript(emptyLine('b'), script).project_id).toBeNull()
  })

  it('leaves the amount where it was', () => {
    const out = applyScript({ ...emptyLine('a'), amount: 40000 }, script)
    expect(out.amount).toBe(40000)
  })

  /** A script is a template that may be renamed or retired; a line that
   *  recorded its name would read correctly and group wrongly. */
  it('does not copy the script’s name onto the line', () => {
    expect(applyScript(emptyLine('a'), script).note).toBe('')
  })

  it('finds the script a line matches', () => {
    const line = applyScript(emptyLine('a'), script)
    expect(scriptMatching(line, [script])?.id).toBe('s1')
  })

  /**
   * By what the line HOLDS, not by an id stored on it: a script edited later
   * must not silently reclassify every line ever filled from it, and a line
   * adjusted by hand must stop claiming to be the script it started as.
   */
  it('stops matching once the line is changed by hand', () => {
    const line = { ...applyScript(emptyLine('a'), script), department: 'Product' }
    expect(scriptMatching(line, [script])).toBeNull()
  })

  it('matches nothing when nothing matches', () => {
    expect(scriptMatching(emptyLine('a'), [script])).toBeNull()
    expect(scriptMatching(applyScript(emptyLine('a'), script), [])).toBeNull()
  })
})


describe('what a split payment is itself classified as', () => {
  const a = { ...emptyLine('a'), amount: 40000, pl_category: 'Capital expenditures', department: 'Product' }
  const b = { ...emptyLine('b'), amount: 80000, pl_category: 'General Business', department: 'Admin' }

  /** The payment's own heading should be what most of it was for. */
  it('takes the biggest line', () => {
    expect(dominantLine([a, b])?.pl_category).toBe('General Business')
    expect(classificationFromSplit([a, b])?.department).toBe('Admin')
  })

  it('does not care which order the lines are in', () => {
    expect(dominantLine([b, a])?.pl_category).toBe('General Business')
  })

  it('takes the first of two equal lines rather than nothing', () => {
    const even = [{ ...a, amount: 60000 }, { ...b, amount: 60000 }]
    expect(dominantLine(even)?.pl_category).toBe('Capital expenditures')
  })

  it('reads a line still being typed as nothing yet', () => {
    expect(dominantLine([{ ...a, amount: null }, b])?.pl_category).toBe('General Business')
  })

  /** Null is how a caller knows to leave the fields alone and let them be
   *  typed, which is what an unsplit payment needs. */
  it('says nothing about a payment that is not split', () => {
    expect(dominantLine([])).toBeNull()
    expect(classificationFromSplit([])).toBeNull()
  })
})

describe('the project while a document is split', () => {
  const l = (amount: number, project_id: string | null = null) =>
    ({ ...emptyLine(`k${amount}`), amount, pl_category: 'A', project_id })

  /** A bill on site A, split in two: both halves start on site A. */
  it('starts the new lines on the document’s project and clears the document', () => {
    const out = splitProjectChange([], [l(60), l(40)], 'site-a')
    expect(out.lines.map(x => x.project_id)).toEqual(['site-a', 'site-a'])
    expect(out.parentProjectId).toBeNull()
  })

  it('keeps a project a new line was already given', () => {
    const out = splitProjectChange([], [l(60, 'site-b'), l(40)], 'site-a')
    expect(out.lines.map(x => x.project_id)).toEqual(['site-b', 'site-a'])
  })

  it('starts overhead lines on a document that was overhead', () => {
    const out = splitProjectChange([], [l(60), l(40)], null)
    expect(out.lines.map(x => x.project_id)).toEqual([null, null])
    expect(out.parentProjectId).toBeNull()
  })

  /** Two projects on one row would count the bill twice. */
  it('keeps the document clear while lines are edited', () => {
    const out = splitProjectChange([l(60, 'a'), l(40, 'b')], [l(50, 'a'), l(50, 'b')], 'stale')
    expect(out.parentProjectId).toBeNull()
  })

  it('puts the document back on its biggest line’s project when the split is removed', () => {
    const out = splitProjectChange([l(30, 'a'), l(70, 'b')], [], null)
    expect(out.lines).toEqual([])
    expect(out.parentProjectId).toBe('b')
  })

  it('leaves the document alone when there was no split either side', () => {
    expect(splitProjectChange([], [], 'site-a').parentProjectId).toBe('site-a')
  })
})
