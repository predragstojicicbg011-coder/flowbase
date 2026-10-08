import { bookFactor, bookAmount, allocAmount, opexAlloc, type AllocEntry } from './allocation'

/**
 * A dinar bill: 220,996 RSD, carried as 1,886 EUR beside it, split
 * 120,000 / 100,996 by hand in the dialog. Read raw in the EUR view it would
 * print 120,000 and 100,996 beside a 1,886 total.
 */
const RSD_BILL = { amount: 220996, amount_rsd: 220996, amount_eur: 1886 }

/** A euro bill: 1,886 EUR booked at 117.2 → 221,039.20 RSD. */
const EUR_BILL = { amount: 1886, amount_rsd: 221039.2, amount_eur: 1886 }

describe('bookAmount', () => {
  it('reads the figure for the currency asked for', () => {
    expect(bookAmount(RSD_BILL, 'RSD')).toBe(220996)
    expect(bookAmount(RSD_BILL, 'EUR')).toBe(1886)
  })

  it('is 0 when the row has no figure in that currency', () => {
    expect(bookAmount({ amount: 5, amount_rsd: 5 }, 'EUR')).toBe(0)
  })
})

describe('bookFactor', () => {
  it('is 1 for a row already in the display currency', () => {
    expect(bookFactor(RSD_BILL, 'RSD')).toBe(1)
    expect(bookFactor(EUR_BILL, 'EUR')).toBe(1)
  })

  it('is the rate the row was booked at, not any other rate', () => {
    expect(bookFactor(RSD_BILL, 'EUR')).toBeCloseTo(1886 / 220996, 12)
    expect(bookFactor(EUR_BILL, 'RSD')).toBeCloseTo(117.2, 9)
  })

  it.each([
    ['zero', 0],
    ['null', null],
    ['undefined', undefined],
  ])('falls back to 1 when amount is %s', (_label, amount) => {
    const f = bookFactor({ amount, amount_rsd: 220996 } as AllocEntry, 'RSD')
    expect(f).toBe(1)
    expect(Number.isFinite(f)).toBe(true)
  })

  it('falls back to 1 when the row carries no amount at all', () => {
    expect(bookFactor({ amount_rsd: 220996 }, 'RSD')).toBe(1)
  })

  it('falls back to 1 rather than NaN when the book figure is missing', () => {
    expect(bookFactor({ amount: 220996 }, 'RSD')).toBe(1)
    expect(bookFactor({ amount: 220996, amount_rsd: 220996 }, 'EUR')).toBe(1)
  })

  it('is 0 for a row booked at zero, so its split is zero too', () => {
    expect(bookFactor({ amount: 220996, amount_rsd: 0 }, 'RSD')).toBe(0)
  })
})

describe('allocAmount - the revenue-stream split', () => {
  it('leaves a row in the display currency exactly as entered', () => {
    const e: AllocEntry = {
      ...RSD_BILL, rev_alloc_type: 'byval', rev_alloc_sg: 120000, rev_alloc_aimfox: 100996,
    }
    expect(allocAmount(e, 'sg', 'RSD')).toBe(120000)
    expect(allocAmount(e, 'af', 'RSD')).toBe(100996)
  })

  it('converts a dinar split into euros at the row’s own rate', () => {
    const e: AllocEntry = {
      ...RSD_BILL, rev_alloc_type: 'byval', rev_alloc_sg: 120000, rev_alloc_aimfox: 100996,
    }
    expect(allocAmount(e, 'sg', 'EUR')).toBeCloseTo(1024.09, 2)
    expect(allocAmount(e, 'af', 'EUR')).toBeCloseTo(861.91, 2)
  })

  it('converts a euro split into dinars at the row’s own rate', () => {
    const e: AllocEntry = {
      ...EUR_BILL, rev_alloc_type: 'byval', rev_alloc_sg: 1000, rev_alloc_aimfox: 886,
    }
    expect(allocAmount(e, 'sg', 'RSD')).toBeCloseTo(117200, 6)
    expect(allocAmount(e, 'af', 'RSD')).toBeCloseTo(103839.2, 6)
    expect(allocAmount(e, 'sg', 'EUR')).toBe(1000)
  })

  it.each(['RSD', 'EUR'] as const)('makes the two streams sum to the row total in %s', cur => {
    const rows: AllocEntry[] = [
      { ...RSD_BILL, rev_alloc_type: 'byval', rev_alloc_sg: 120000, rev_alloc_aimfox: 100996 },
      { ...EUR_BILL, rev_alloc_type: 'byval', rev_alloc_sg: 900, rev_alloc_aimfox: 986 },
      { ...RSD_BILL, rev_alloc_type: 'byval', rev_alloc_sg: 0, rev_alloc_aimfox: 220996 },
      { ...EUR_BILL, rev_alloc_type: 'shared' },
      { ...RSD_BILL, rev_alloc_type: 'sg100' },
      { ...RSD_BILL, rev_alloc_type: 'af100' },
      { ...RSD_BILL, rev_alloc_type: 'byval' },
    ]
    const total = (e: AllocEntry) => (cur === 'RSD' ? e.amount_rsd : e.amount_eur) as number
    rows.forEach(e => {
      expect(allocAmount(e, 'sg', cur) + allocAmount(e, 'af', cur)).toBeCloseTo(total(e), 6)
    })
  })

  it('hands the whole book total to one stream for sg100 and af100', () => {
    const sg: AllocEntry = { ...RSD_BILL, rev_alloc_type: 'sg100' }
    expect(allocAmount(sg, 'sg', 'RSD')).toBe(220996)
    expect(allocAmount(sg, 'sg', 'EUR')).toBe(1886)
    expect(allocAmount(sg, 'af', 'RSD')).toBe(0)

    const af: AllocEntry = { ...RSD_BILL, rev_alloc_type: 'af100' }
    expect(allocAmount(af, 'af', 'EUR')).toBe(1886)
    expect(allocAmount(af, 'sg', 'EUR')).toBe(0)
  })

  it('never converts the sg100 total, whatever currency the row is in', () => {
    // The typed split is in the bill's currency; the row total never is.
    const e: AllocEntry = { ...EUR_BILL, rev_alloc_type: 'sg100', rev_alloc_sg: 1000 }
    expect(allocAmount(e, 'sg', 'RSD')).toBe(221039.2)
  })

  it('splits in half when rev_alloc_type is unset, as today', () => {
    expect(allocAmount({ ...RSD_BILL }, 'sg', 'RSD')).toBe(110498)
    expect(allocAmount({ ...RSD_BILL }, 'af', 'EUR')).toBe(943)
    expect(allocAmount({ ...RSD_BILL, rev_alloc_type: 'shared' }, 'sg', 'RSD')).toBe(110498)
  })

  it('splits the book half, not a converted half, when a byval figure is missing', () => {
    const e: AllocEntry = { ...RSD_BILL, rev_alloc_type: 'byval', rev_alloc_sg: null }
    expect(allocAmount(e, 'sg', 'EUR')).toBe(943)
  })

  it('keeps a zero allocation at zero rather than falling back to half', () => {
    const e: AllocEntry = {
      ...RSD_BILL, rev_alloc_type: 'byval', rev_alloc_sg: 0, rev_alloc_aimfox: 220996,
    }
    expect(allocAmount(e, 'sg', 'EUR')).toBe(0)
    expect(allocAmount(e, 'af', 'EUR')).toBeCloseTo(1886, 6)
  })
})

describe('opexAlloc - the OPEX / performance split', () => {
  it('leaves a row in the display currency exactly as entered', () => {
    const e: AllocEntry = {
      ...EUR_BILL, opex_type: 'split', opex_amount: 1000, performance_amount: 886,
    }
    expect(opexAlloc(e, 'opex', 'EUR')).toBe(1000)
    expect(opexAlloc(e, 'performance', 'EUR')).toBe(886)
  })

  it('converts a dinar split into euros', () => {
    const e: AllocEntry = {
      ...RSD_BILL, opex_type: 'split', opex_amount: 120000, performance_amount: 100996,
    }
    expect(opexAlloc(e, 'opex', 'EUR')).toBeCloseTo(1024.09, 2)
    expect(opexAlloc(e, 'performance', 'EUR')).toBeCloseTo(861.91, 2)
  })

  it.each(['RSD', 'EUR'] as const)('makes the two sides sum to the row total in %s', cur => {
    const rows: AllocEntry[] = [
      { ...RSD_BILL, opex_type: 'split', opex_amount: 120000, performance_amount: 100996 },
      { ...EUR_BILL, opex_type: 'split', opex_amount: 1000, performance_amount: 886 },
      { ...RSD_BILL, opex_type: 'split' },
      { ...RSD_BILL, opex_type: 'opex' },
      { ...RSD_BILL, opex_type: 'performance' },
      { ...RSD_BILL },
    ]
    const total = (e: AllocEntry) => (cur === 'RSD' ? e.amount_rsd : e.amount_eur) as number
    rows.forEach(e => {
      expect(opexAlloc(e, 'opex', cur) + opexAlloc(e, 'performance', cur)).toBeCloseTo(total(e), 6)
    })
  })

  it('hands the whole book total to one side for opex and performance', () => {
    expect(opexAlloc({ ...RSD_BILL, opex_type: 'opex' }, 'opex', 'RSD')).toBe(220996)
    expect(opexAlloc({ ...RSD_BILL, opex_type: 'opex' }, 'performance', 'RSD')).toBe(0)
    expect(opexAlloc({ ...RSD_BILL, opex_type: 'performance' }, 'performance', 'EUR')).toBe(1886)
    expect(opexAlloc({ ...RSD_BILL, opex_type: 'performance' }, 'opex', 'EUR')).toBe(0)
  })

  it('treats an unset opex_type as pure OPEX, as today', () => {
    expect(opexAlloc({ ...RSD_BILL }, 'opex', 'RSD')).toBe(220996)
    expect(opexAlloc({ ...RSD_BILL }, 'performance', 'RSD')).toBe(0)
  })

  it('splits the book half when a split figure is missing', () => {
    const e: AllocEntry = { ...RSD_BILL, opex_type: 'split', performance_amount: null }
    expect(opexAlloc(e, 'performance', 'RSD')).toBe(110498)
  })

  it('keeps a zero allocation at zero rather than falling back to half', () => {
    const e: AllocEntry = {
      ...RSD_BILL, opex_type: 'split', opex_amount: 0, performance_amount: 220996,
    }
    expect(opexAlloc(e, 'opex', 'EUR')).toBe(0)
    expect(opexAlloc(e, 'performance', 'EUR')).toBeCloseTo(1886, 6)
  })
})

describe('the row that is not fully there', () => {
  it('reads a row without `amount` unchanged rather than blowing up', () => {
    const e: AllocEntry = {
      amount_rsd: 220996, rev_alloc_type: 'byval', rev_alloc_sg: 120000, rev_alloc_aimfox: 100996,
    }
    expect(allocAmount(e, 'sg', 'RSD')).toBe(120000)
    expect(allocAmount(e, 'af', 'RSD')).toBe(100996)
  })

  it('gives zero, not NaN, for a row with no EUR figure in the EUR view', () => {
    const e: AllocEntry = { amount: 100, amount_rsd: 100 }
    expect(allocAmount(e, 'sg', 'EUR')).toBe(0)
    expect(opexAlloc(e, 'opex', 'EUR')).toBe(0)
  })
})
