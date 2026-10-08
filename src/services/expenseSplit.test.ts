import {
  emptyLine, sumOf, remainderOf, isBalanced, whySplitNotSavable,
  absorbRemainder, splitInHalf, rowsFor, linesFrom,
  SPLIT_TOLERANCE, applyScript, scriptMatching, dominantLine,
  classificationFromSplit, type SplitLine,
} from './expenseSplit'

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
  const parent = { amount: 120000, amount_usd: 1200 }

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
  const parent = { amount: 1000, amount_usd: 10 }

  it('has nothing to say about a row that is not split at all', () => {
    expect(whySplitNotSavable(parent, [])).toBeNull()
  })

  it('refuses a split of one, which is not a split', () => {
    expect(whySplitNotSavable(parent, [line({ amount: 1000 })]))
      .toMatch(/at least two lines/)
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
    expect(why).toMatch(/Line 2 has no P&L category/)
  })

  it('names a line with no amount', () => {
    expect(whySplitNotSavable(parent, [line({ amount: 1000 }), line({ amount: 0 })]))
      .toMatch(/Line 2 has no amount/)
  })

  it('says how much is missing, and which way', () => {
    expect(whySplitNotSavable(parent, [line({ amount: 400 }), line({ amount: 500 })]))
      .toMatch(/100\.00 is not accounted for/)
    expect(whySplitNotSavable(parent, [line({ amount: 600 }), line({ amount: 500 })]))
      .toMatch(/100\.00 MORE/)
  })

  it('passes a split that balances', () => {
    expect(whySplitNotSavable(parent, [line({ amount: 400 }), line({ amount: 600 })]))
      .toBeNull()
  })
})

describe('absorbing the remainder', () => {
  const parent = { amount: 1000, amount_usd: 10 }

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

describe('the rows that get stored', () => {
  const parent = { amount: 120000, amount_usd: 1178.21 }
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
   * The whole reason the dollars are derived rather than converted line by
   * line: a column short by a cent survives for years, because every single
   * row in it looks right.
   */
  it('makes the dollar column sum to the parent exactly', () => {
    const rows = rowsFor({ amount: 100, amount_usd: 1 }, [
      line({ amount: 33.33 }), line({ amount: 33.33 }), line({ amount: 33.34 }),
    ])
    const total = rows.reduce((s, r) => s + (r.amount_usd || 0), 0)
    expect(Math.round(total * 100) / 100).toBe(1)
  })

  it('keeps the own-currency column summing to the parent too', () => {
    const rows = rowsFor(parent, lines)
    expect(rows.reduce((s, r) => s + r.amount, 0)).toBe(120000)
  })

  it('leaves the dollars null when the parent has none', () => {
    const rows = rowsFor({ amount: 100, amount_usd: null }, lines)
    expect(rows.every(r => r.amount_usd === null)).toBe(true)
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
      { ...rowsFor({ amount: 2 }, [line({ amount: 2, pl_category: 'B' })])[0], sort_order: 1 },
      { ...rowsFor({ amount: 1 }, [line({ amount: 1, pl_category: 'A' })])[0], sort_order: 0 },
    ], key)
    expect(lines.map(l => l.pl_category)).toEqual(['A', 'B'])
  })

  it('survives a round trip without changing a figure', () => {
    const parent = { amount: 120000, amount_usd: 1178.21 }
    const original = [
      line({ amount: 40000, pl_category: 'Capital expenditures', department: 'Product' }),
      line({ amount: 80000, pl_category: 'General Business', department: 'Admin' }),
    ]
    const back = linesFrom(rowsFor(parent, original), key)
    expect(back.map(l => l.amount)).toEqual([40000, 80000])
    expect(back.map(l => l.department)).toEqual(['Product', 'Admin'])
    expect(isBalanced(parent, back)).toBe(true)
  })
})

describe('a line filled from a script', () => {
  const script = {
    id: 's1', name: 'Figma', icon: '⚡',
    pl_category: 'General Business', pl_subcategory: 'Software subscriptions',
    department: 'Admin', dept_subcategory: 'Tools', expense_description: 'Figma',
    rev_alloc: 'sg100', opex_type: 'opex', cf_type: 'recurring',
  }

  it('takes all eight fields off the script', () => {
    const out = applyScript(emptyLine('a'), script)
    expect(out.pl_category).toBe('General Business')
    expect(out.dept_subcategory).toBe('Tools')
    expect(out.rev_alloc_type).toBe('sg100')
    expect(out.cf_type).toBe('recurring')
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
