import { usdFactor, allocAmount, opexAlloc, type AllocEntry } from './allocation'

/**
 * The bill the defect was found on: 220,996 dinars, booked at $2,188, split
 * 120,000 / 100,996 by hand in the dialog. Read raw it printed as $120,000
 * and $100,996 beside a $2,188 total.
 */
const RSD_BILL = { amount: 220996, amount_usd: 2188 }

describe('usdFactor', () => {
  it('is 1 for a row already in USD', () => {
    expect(usdFactor({ amount: 7400, amount_usd: 7400 })).toBe(1)
  })

  it('is the rate the row was booked at, not any other rate', () => {
    expect(usdFactor(RSD_BILL)).toBeCloseTo(2188 / 220996, 12)
  })

  it.each([
    ['zero', 0],
    ['null', null],
    ['undefined', undefined],
  ])('falls back to 1 when amount is %s', (_label, amount) => {
    const f = usdFactor({ amount, amount_usd: 2188 } as AllocEntry)
    expect(f).toBe(1)
    expect(Number.isFinite(f)).toBe(true)
  })

  it('falls back to 1 when the row carries no amount at all', () => {
    // A view that predates the migration adding `amount` hands back rows
    // without the key. The figure is then wrong for a foreign-currency row,
    // but it is the figure the page printed before - not NaN.
    expect(usdFactor({ amount_usd: 2188 })).toBe(1)
  })

  it('falls back to 1 rather than NaN when amount_usd is missing', () => {
    expect(usdFactor({ amount: 220996 })).toBe(1)
  })

  it('is 0 for a row booked at zero dollars, so its split is zero too', () => {
    expect(usdFactor({ amount: 220996, amount_usd: 0 })).toBe(0)
  })
})

describe('allocAmount - the revenue-stream split', () => {
  it('leaves a USD row exactly as entered', () => {
    const e: AllocEntry = {
      amount: 7400, amount_usd: 7400,
      rev_alloc_type: 'byval', rev_alloc_sg: 4400, rev_alloc_aimfox: 3000,
    }
    expect(allocAmount(e, 'sg')).toBe(4400)
    expect(allocAmount(e, 'af')).toBe(3000)
  })

  it('converts a dinar split into dollars', () => {
    const e: AllocEntry = {
      ...RSD_BILL,
      rev_alloc_type: 'byval', rev_alloc_sg: 120000, rev_alloc_aimfox: 100996,
    }
    expect(allocAmount(e, 'sg')).toBeCloseTo(1188.076, 2)
    expect(allocAmount(e, 'af')).toBeCloseTo(999.924, 2)
  })

  it('makes the two streams sum to the row total - the property that matters', () => {
    const rows: AllocEntry[] = [
      { ...RSD_BILL, rev_alloc_type: 'byval', rev_alloc_sg: 120000, rev_alloc_aimfox: 100996 },
      { amount: 1200, amount_usd: 1384.2, rev_alloc_type: 'byval', rev_alloc_sg: 900, rev_alloc_aimfox: 300 },
      { amount: 7400, amount_usd: 7400, rev_alloc_type: 'byval', rev_alloc_sg: 0, rev_alloc_aimfox: 7400 },
      { amount: 9004, amount_usd: 9004, rev_alloc_type: 'shared' },
      { ...RSD_BILL, rev_alloc_type: 'sg100' },
      { ...RSD_BILL, rev_alloc_type: 'af100' },
      { ...RSD_BILL, rev_alloc_type: 'byval' },
    ]
    rows.forEach(e => {
      expect(allocAmount(e, 'sg') + allocAmount(e, 'af')).toBeCloseTo(e.amount_usd as number, 6)
    })
  })

  it('hands the whole USD total to one stream for sg100 and af100', () => {
    const sg: AllocEntry = { ...RSD_BILL, rev_alloc_type: 'sg100' }
    expect(allocAmount(sg, 'sg')).toBe(2188)
    expect(allocAmount(sg, 'af')).toBe(0)

    const af: AllocEntry = { ...RSD_BILL, rev_alloc_type: 'af100' }
    expect(allocAmount(af, 'af')).toBe(2188)
    expect(allocAmount(af, 'sg')).toBe(0)
  })

  it('never converts the sg100 total, whatever currency the row is in', () => {
    // The typed split is in dinars; the row total never is. Multiplying here
    // would be the same defect with the sign flipped.
    const e: AllocEntry = { ...RSD_BILL, rev_alloc_type: 'sg100', rev_alloc_sg: 120000 }
    expect(allocAmount(e, 'sg')).toBe(2188)
  })

  it('splits in half when rev_alloc_type is unset, as today', () => {
    expect(allocAmount({ ...RSD_BILL }, 'sg')).toBe(1094)
    expect(allocAmount({ ...RSD_BILL }, 'af')).toBe(1094)
    expect(allocAmount({ ...RSD_BILL, rev_alloc_type: 'shared' }, 'sg')).toBe(1094)
  })

  it('splits the USD half, not a converted half, when a byval figure is missing', () => {
    const e: AllocEntry = { ...RSD_BILL, rev_alloc_type: 'byval', rev_alloc_sg: null }
    expect(allocAmount(e, 'sg')).toBe(1094)
  })

  it('keeps a zero allocation at zero rather than falling back to half', () => {
    const e: AllocEntry = {
      ...RSD_BILL, rev_alloc_type: 'byval', rev_alloc_sg: 0, rev_alloc_aimfox: 220996,
    }
    expect(allocAmount(e, 'sg')).toBe(0)
    expect(allocAmount(e, 'af')).toBeCloseTo(2188, 6)
  })
})

describe('opexAlloc - the OPEX / performance split', () => {
  it('leaves a USD row exactly as entered', () => {
    const e: AllocEntry = {
      amount: 7400, amount_usd: 7400,
      opex_type: 'split', opex_amount: 4400, performance_amount: 3000,
    }
    expect(opexAlloc(e, 'opex')).toBe(4400)
    expect(opexAlloc(e, 'performance')).toBe(3000)
  })

  it('converts a dinar split into dollars', () => {
    const e: AllocEntry = {
      ...RSD_BILL,
      opex_type: 'split', opex_amount: 120000, performance_amount: 100996,
    }
    expect(opexAlloc(e, 'opex')).toBeCloseTo(1188.076, 2)
    expect(opexAlloc(e, 'performance')).toBeCloseTo(999.924, 2)
  })

  it('makes the two sides sum to the row total', () => {
    const rows: AllocEntry[] = [
      { ...RSD_BILL, opex_type: 'split', opex_amount: 120000, performance_amount: 100996 },
      { ...RSD_BILL, opex_type: 'split' },
      { ...RSD_BILL, opex_type: 'opex' },
      { ...RSD_BILL, opex_type: 'performance' },
      { ...RSD_BILL },
    ]
    rows.forEach(e => {
      expect(opexAlloc(e, 'opex') + opexAlloc(e, 'performance')).toBeCloseTo(e.amount_usd as number, 6)
    })
  })

  it('hands the whole USD total to one side for opex and performance', () => {
    expect(opexAlloc({ ...RSD_BILL, opex_type: 'opex' }, 'opex')).toBe(2188)
    expect(opexAlloc({ ...RSD_BILL, opex_type: 'opex' }, 'performance')).toBe(0)
    expect(opexAlloc({ ...RSD_BILL, opex_type: 'performance' }, 'performance')).toBe(2188)
    expect(opexAlloc({ ...RSD_BILL, opex_type: 'performance' }, 'opex')).toBe(0)
  })

  it('treats an unset opex_type as pure OPEX, as today', () => {
    expect(opexAlloc({ ...RSD_BILL }, 'opex')).toBe(2188)
    expect(opexAlloc({ ...RSD_BILL }, 'performance')).toBe(0)
  })

  it('splits the USD half when a split figure is missing', () => {
    const e: AllocEntry = { ...RSD_BILL, opex_type: 'split', performance_amount: null }
    expect(opexAlloc(e, 'performance')).toBe(1094)
  })

  it('keeps a zero allocation at zero rather than falling back to half', () => {
    const e: AllocEntry = {
      ...RSD_BILL, opex_type: 'split', opex_amount: 0, performance_amount: 220996,
    }
    expect(opexAlloc(e, 'opex')).toBe(0)
    expect(opexAlloc(e, 'performance')).toBeCloseTo(2188, 6)
  })
})

describe('the row that is not there yet', () => {
  it('reads a pre-migration row unchanged rather than blowing up', () => {
    // v_pl_entries did not carry `amount` before 20260918090000. A client
    // running ahead of the migration must still produce finite money.
    const e: AllocEntry = {
      amount_usd: 2188, rev_alloc_type: 'byval', rev_alloc_sg: 1188, rev_alloc_aimfox: 1000,
    }
    expect(allocAmount(e, 'sg')).toBe(1188)
    expect(allocAmount(e, 'af')).toBe(1000)
  })
})
