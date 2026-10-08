import { fmtUSDCompact, fmtUSDFull, budgetFigureFormat, fmtNum, fmtLocal } from './formatters'

// ─── The budget table's own scale ────────────────────────────────────────────
//
// `showSign` decides whether a POSITIVE number is announced with a `+`. It has
// never had any business deciding whether a negative number keeps its minus,
// and while it did, one row of the budget table could print two figures 4,400
// apart: a `direct` of −2,200 rendered `$2.2K` beside a variance cell computed
// from the real −2,200.

describe('fmtUSDCompact', () => {
  it('keeps the minus on a negative number nobody asked to sign', () => {
    // The ordinary case: a budget carried over below its seed resolves to a
    // negative delta, and every cell but the variance one prints unsigned.
    expect(fmtUSDCompact(-2200)).toBe('-$2.2K')
    expect(fmtUSDCompact(-340)).toBe('-$340')
  })

  it('does not put a plus on a positive number unless asked', () => {
    expect(fmtUSDCompact(2200)).toBe('$2.2K')
    expect(fmtUSDCompact(340)).toBe('$340')
  })

  it('adds the plus only when showSign is set', () => {
    expect(fmtUSDCompact(2200, true)).toBe('+$2.2K')
    expect(fmtUSDCompact(340, true)).toBe('+$340')
  })

  it('signs a negative the same way whether or not showSign is set', () => {
    // The variance cell and the budget cell beside it must never disagree
    // about what −2,200 is.
    expect(fmtUSDCompact(-2200, true)).toBe(fmtUSDCompact(-2200))
  })

  it('is an em dash for nothing at all, signed or not', () => {
    expect(fmtUSDCompact(0)).toBe('—')
    expect(fmtUSDCompact(0, true)).toBe('—')
  })

  it('switches to thousands at a thousand, either side of zero', () => {
    expect(fmtUSDCompact(999)).toBe('$999')
    expect(fmtUSDCompact(1000)).toBe('$1.0K')
    expect(fmtUSDCompact(-999)).toBe('-$999')
    expect(fmtUSDCompact(-1000)).toBe('-$1.0K')
  })
})

// ─── The same scale at full precision ────────────────────────────────────────
//
// `fmtUSDFull` exists because `$6.7K` is the same string for every figure
// between 6,650 and 6,749, and a budget is compared month against month. Its
// sign rules are `fmtUSDCompact`'s to the letter: the two print into the SAME
// cell on different days, so a figure that changes sign when the horizon
// changes would be a wrong number, not a style.

describe('fmtUSDFull', () => {
  it('prints the whole figure, grouped, rather than rounding it to a K', () => {
    expect(fmtUSDFull(26432)).toBe('$26,432')
    expect(fmtUSDFull(6700)).toBe('$6,700')
    expect(fmtUSDFull(340)).toBe('$340')
    expect(fmtUSDFull(1262432)).toBe('$1,262,432')
  })

  it('tells apart two figures the compact form cannot', () => {
    // The whole reason it exists: at three months there is room, and two
    // months an accountant is trying to compare must not read identically.
    expect(fmtUSDCompact(6650)).toBe(fmtUSDCompact(6749))
    expect(fmtUSDFull(6650)).not.toBe(fmtUSDFull(6749))
  })

  it('keeps the minus on a negative number nobody asked to sign', () => {
    // The fault that was fixed in the compact formatter, which must not be
    // reintroduced by its sibling: a `direct` row of −2,200 printing as a
    // positive beside a variance computed from the real −2,200.
    expect(fmtUSDFull(-2200)).toBe('-$2,200')
    expect(fmtUSDFull(-340)).toBe('-$340')
    expect(fmtUSDFull(-26432)).toBe('-$26,432')
  })

  it('adds the plus only when showSign is set', () => {
    expect(fmtUSDFull(2200)).toBe('$2,200')
    expect(fmtUSDFull(2200, true)).toBe('+$2,200')
  })

  it('signs a negative the same way whether or not showSign is set', () => {
    expect(fmtUSDFull(-2200, true)).toBe(fmtUSDFull(-2200))
    expect(fmtUSDFull(-26432, true)).toBe('-$26,432')
  })

  it('is an em dash for nothing at all, signed or not', () => {
    expect(fmtUSDFull(0)).toBe('—')
    expect(fmtUSDFull(0, true)).toBe('—')
  })

  it('rounds to whole dollars rather than showing cents', () => {
    expect(fmtUSDFull(26432.49)).toBe('$26,432')
    expect(fmtUSDFull(-26432.51)).toBe('-$26,433')
  })
})

describe('budgetFigureFormat', () => {
  // One rule, decided once, so the dozen places the budget table prints a
  // figure cannot drift apart from each other.
  it('is full at the three-month horizon', () => {
    expect(budgetFigureFormat(3)).toBe(fmtUSDFull)
    expect(budgetFigureFormat(3)(26432)).toBe('$26,432')
  })

  it('is compact at every horizon wider than three months', () => {
    expect(budgetFigureFormat(6)).toBe(fmtUSDCompact)
    expect(budgetFigureFormat(12)).toBe(fmtUSDCompact)
    expect(budgetFigureFormat(12)(26432)).toBe('$26.4K')
  })

  it('passes showSign through whichever it picked', () => {
    expect(budgetFigureFormat(3)(2200, true)).toBe('+$2,200')
    expect(budgetFigureFormat(12)(2200, true)).toBe('+$2.2K')
    // And a negative is a negative at both horizons.
    expect(budgetFigureFormat(3)(-2200, true)).toBe('-$2,200')
    expect(budgetFigureFormat(12)(-2200, true)).toBe('-$2.2K')
  })
})

describe('a figure in Serbian notation', () => {
  it('ALWAYS writes the para, so a round figure cannot be read two ways', () => {
    // `86.292` is eighty-six thousand to a Serbian eye and eighty-six point
    // two nine two to everyone else, and nothing in the string says which.
    // This is the whole reason the formatter exists.
    expect(fmtNum(86292)).toBe('86.292,00')
    expect(fmtNum(66198)).toBe('66.198,00')
  })

  it('writes a dot for thousands and a comma for the para', () => {
    expect(fmtNum(1000.46)).toBe('1.000,46')
    expect(fmtNum(18385.97)).toBe('18.385,97')
  })

  it('does not round a third decimal into view', () => {
    // `toLocaleString('sr-RS')` on its own allows three places, so a figure
    // carried at more precision than the column stores printed as 1.234,567.
    expect(fmtNum(1234.5678)).toBe('1.234,57')
  })

  it('keeps the minus, because a figure that prints its own negation is wrong', () => {
    expect(fmtNum(-1234.5)).toBe('-1.234,50')
  })

  it('prints a dash rather than NaN or Infinity', () => {
    expect(fmtNum(NaN)).toBe('—')
    expect(fmtNum(Infinity)).toBe('—')
  })

  it('writes zero as zero, not as a dash', () => {
    // An allocation of nothing is a figure, and a column of money that goes
    // blank where it should read 0,00 is a column somebody has to check.
    expect(fmtNum(0)).toBe('0,00')
  })
})

describe('a local amount with its currency', () => {
  it('trails the code, the way a statement reads', () => {
    expect(fmtLocal(134561.52, 'RSD')).toBe('134.561,52 RSD')
    expect(fmtLocal(86292, 'RSD')).toBe('86.292,00 RSD')
    expect(fmtLocal(1200, 'EUR')).toBe('1.200,00 EUR')
  })
})
