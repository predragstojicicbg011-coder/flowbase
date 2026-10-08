import {
  cashMovement, cashTimeline, datedByMonth, monthsAround, monthsEndingAt, previousMonth,
  type CashInput,
} from './cashTimeline'

const MONTHS = ['2026-07', '2026-08', '2026-09', '2026-10', '2026-11']

const base = (over: Partial<CashInput> = {}): CashInput => ({
  months: MONTHS,
  currentMonth: '2026-09',
  actual: {
    '2026-07': { inflow: 300000, outflow: 280000 },
    '2026-08': { inflow: 290000, outflow: 310000 },
    '2026-09': { inflow: 200000, outflow: 190000 },
  },
  projected: {
    '2026-09': { inflow: 340000, outflow: 320000 },
    '2026-10': { inflow: 330000, outflow: 290000 },
    '2026-11': { inflow: 345000, outflow: 285000 },
  },
  position: { amount: 600000, asOf: '2026-09-26' },
  currency: 'RSD',
  ...over,
})

describe('which months are on the line', () => {
  it('counts back from a month, oldest first', () => {
    expect(monthsEndingAt('2026-02', 3)).toEqual(['2025-12', '2026-01', '2026-02'])
  })

  it('reaches both ways around an anchor', () => {
    expect(monthsAround('2026-01', 2, 2))
      .toEqual(['2025-11', '2025-12', '2026-01', '2026-02', '2026-03'])
  })

  it('steps back one month, across a year end', () => {
    expect(previousMonth('2026-10')).toBe('2026-09')
    expect(previousMonth('2026-01')).toBe('2025-12')
  })
})

describe('where each month gets its figures', () => {
  it('reads a settled month from what actually moved', () => {
    const t = cashTimeline(base())
    const july = t.months[0]
    expect(july).toMatchObject({ basis: 'actual', inflow: 300000, outflow: 280000 })
  })

  it('reads a future month from the projection', () => {
    const t = cashTimeline(base())
    expect(t.months[3]).toMatchObject({ basis: 'projected', inflow: 330000, outflow: 290000 })
  })

  it('READS THE MONTH IN PROGRESS FROM BOTH', () => {
    // Actuals only and a month three weeks in looks like a collapse.
    // Projection only and the money already spent is invisible. It is
    // neither, and it is the month everybody is actually looking at.
    const t = cashTimeline(base())
    const sep = t.months[2]
    expect(sep.basis).toBe('partial')
    // 200,000 posted plus the 140,000 still expected of the 340,000 forecast.
    expect(sep.inflow).toBe(340000)
    expect(sep.outflow).toBe(320000)
  })

  it('NEVER TAKES A MONTH BELOW WHAT IT HAS ALREADY SPENT', () => {
    // A month that has outspent its own forecast has nothing left to expect,
    // and subtracting past that would hand it a negative outflow.
    const t = cashTimeline(base({
      actual: { '2026-09': { inflow: 0, outflow: 500000 } },
      projected: { '2026-09': { inflow: 0, outflow: 320000 } },
    }))
    expect(t.months[2].outflow).toBe(500000)
  })

  it('gives a month with nothing in it a zero rather than leaving it out', () => {
    const t = cashTimeline(base({ actual: {}, projected: {} }))
    expect(t.months).toHaveLength(5)
    expect(t.months[0]).toMatchObject({ inflow: 0, outflow: 0, net: 0 })
  })
})

describe('the balance, walked out from the reading', () => {
  it('ANCHORS ON THE MONTH THE READING WAS TAKEN IN', () => {
    // The reading is the only measured figure on the line. Anchoring at the
    // start of the series instead puts it at the end of a chain of estimates,
    // where it corrects nothing.
    const t = cashTimeline(base())
    expect(t.anchorMonth).toBe('2026-09')
    expect(t.months[2].closing).toBe(600000)
  })

  it('takes off what was posted after the reading, so the column is month-end', () => {
    // The reading is a point inside its month; without this the anchor's
    // close is the reading plus the whole month, counting again everything
    // that had already happened when the balance was read.
    const t = cashTimeline(base({
      postedAfterReading: { inflow: 5000, outflow: 21000 },
    }))
    expect(t.months[2].closing).toBe(584000)
  })

  it('walks forward by adding each month\'s net', () => {
    const t = cashTimeline(base())
    expect(t.months[3].closing).toBe(600000 + 40000)
    expect(t.months[4].closing).toBe(600000 + 40000 + 60000)
  })

  it('WALKS BACKWARD BY SUBTRACTING THE MONTH AFTER', () => {
    // August's close is September's close less what September moved — not
    // August's own net added to something.
    const t = cashTimeline(base())
    expect(t.months[1].closing).toBe(600000 - 20000)        // less September's +20,000
    expect(t.months[0].closing).toBe(600000 - 20000 + 20000) // less August's −20,000
  })

  it('finds the lowest point on the line and says when', () => {
    const t = cashTimeline(base({
      projected: {
        '2026-09': { inflow: 340000, outflow: 320000 },
        '2026-10': { inflow: 100000, outflow: 500000 },
        '2026-11': { inflow: 345000, outflow: 285000 },
      },
    }))
    expect(t.trough).toEqual({ month: '2026-10', amount: 200000 })
  })

  it('SAYS SO WHEN THE LINE GOES NEGATIVE', () => {
    const t = cashTimeline(base({
      position: { amount: 50000, asOf: '2026-09-26' },
      projected: {
        '2026-09': { inflow: 0, outflow: 0 },
        '2026-10': { inflow: 10000, outflow: 400000 },
        '2026-11': { inflow: 0, outflow: 0 },
      },
    }))
    expect(t.trough!.amount).toBeLessThan(0)
    expect(t.problems.join(' ')).toMatch(/goes negative in 2026-10/)
    // Written in the app's money notation, with the currency it is in.
    expect(t.problems.join(' ')).toMatch(/reaching -340\.000,00 RSD\./)
  })
})

describe('what it refuses to draw', () => {
  it('DRAWS NO BALANCE AT ALL with no cash position, and says why', () => {
    // Not a zero, and not a balance starting from zero. Both read as
    // measurements on a page opened to decide something.
    const t = cashTimeline(base({ position: null }))
    expect(t.months.every(m => m.closing === null)).toBe(true)
    expect(t.trough).toBeNull()
    expect(t.problems.join(' ')).toMatch(/no cash position/i)
  })

  it('still shows the flows without a balance', () => {
    const t = cashTimeline(base({ position: null }))
    expect(t.months[0].inflow).toBe(300000)
  })

  it('refuses to anchor a reading taken outside the months drawn', () => {
    const t = cashTimeline(base({ position: { amount: 600000, asOf: '2025-02-10' } }))
    expect(t.anchorMonth).toBeNull()
    expect(t.months.every(m => m.closing === null)).toBe(true)
    expect(t.problems.join(' ')).toMatch(/outside the months drawn/i)
  })
})

describe('the outflows that carry a date of their own', () => {
  const items = [
    { date: '2026-10-24', label: 'Cognant AI', amount: 4840, kind: 'invoice' as const },
    { date: '2026-10-05', label: 'Intesa 100k #18', amount: 6654.25, kind: 'instalment' as const },
    { date: '2026-11-05', label: 'Intesa 100k #19', amount: 6654.25, kind: 'instalment' as const },
    { date: '2027-06-05', label: 'far away', amount: 99, kind: 'instalment' as const },
  ]

  it('sums them by month AND keeps the list', () => {
    // "October is heavy" is a different statement from "October is heavy
    // because the Intesa instalment and the Cognant invoice both fall in it",
    // and only the second one can be acted on.
    const by = datedByMonth(items, ['2026-10', '2026-11'])
    expect(by['2026-10'].total).toBe(11494.25)
    expect(by['2026-10'].items).toHaveLength(2)
  })

  it('puts the earliest first, so a month reads in the order it happens', () => {
    const by = datedByMonth(items, ['2026-10'])
    expect(by['2026-10'].items[0].label).toBe('Intesa 100k #18')
  })

  it('leaves out anything outside the months drawn', () => {
    expect(datedByMonth(items, ['2026-10'])['2027-06']).toBeUndefined()
  })

  it('leaves out an item with no date rather than guessing one', () => {
    const by = datedByMonth([{ date: '', label: 'x', amount: 10, kind: 'invoice' }], ['2026-10'])
    expect(Object.keys(by)).toEqual([])
  })
})


describe('what counts as money moving', () => {
  it('counts a direct receipt in, and a direct payment out', () => {
    expect(cashMovement({ type: 'direct', tx_subtype: 'revenue', amount_rsd: 500 }, 'RSD'))
      .toEqual({ inflow: 500, outflow: 0 })
    expect(cashMovement({ type: 'direct', tx_subtype: 'expense', amount_rsd: 500 }, 'RSD'))
      .toEqual({ inflow: 0, outflow: 500 })
  })

  it('counts a payment against an invoice as money out', () => {
    expect(cashMovement({ type: 'invoice_payment', amount_rsd: 420 }, 'RSD').outflow).toBe(420)
  })

  it('COUNTS NO TRANSFER BETWEEN OUR OWN ACCOUNTS', () => {
    // The same money leaving one account and arriving in another. Counting
    // both legs inflates the inflow and the outflow by the same amount — the
    // net is untouched, so nothing looks wrong, and both totals are too big.
    for (const tx of [
      { type: 'passthrough', tx_subtype: 'in', amount_rsd: 50000 },
      { type: 'passthrough', tx_subtype: 'out', amount_rsd: 50000 },
      { type: 'transfer', amount_rsd: 50000 },
    ]) {
      expect(cashMovement(tx, 'RSD')).toEqual({ inflow: 0, outflow: 0 })
    }
  })

  it('IS AN ALLOWLIST, so a shape added to the ledger tomorrow counts nothing', () => {
    // Written the other way round it would count whatever arrives next,
    // which is how a total starts drifting with no change to this file.
    expect(cashMovement({ type: 'something_new', amount_rsd: 9999 }, 'RSD'))
      .toEqual({ inflow: 0, outflow: 0 })
    expect(cashMovement({ type: 'direct', tx_subtype: 'neither', amount_rsd: 9999 }, 'RSD'))
      .toEqual({ inflow: 0, outflow: 0 })
  })

  it('takes an amount at its size whichever sign it arrives with', () => {
    expect(cashMovement({ type: 'direct', tx_subtype: 'expense', amount_rsd: -500 }, 'RSD').outflow)
      .toBe(500)
  })

  it('reads the EUR figure in the EUR view, and nothing where a row has none', () => {
    const tx = { type: 'direct', tx_subtype: 'revenue', amount_rsd: 117200, amount_eur: 1000 }
    expect(cashMovement(tx, 'EUR')).toEqual({ inflow: 1000, outflow: 0 })
    expect(cashMovement(tx, 'RSD')).toEqual({ inflow: 117200, outflow: 0 })
    expect(cashMovement({ type: 'invoice_payment', amount_rsd: 500 }, 'EUR'))
      .toEqual({ inflow: 0, outflow: 0 })
  })

  it('has nothing to say about a transaction of nothing', () => {
    expect(cashMovement({ type: 'direct', tx_subtype: 'revenue', amount_rsd: 0 }, 'RSD'))
      .toEqual({ inflow: 0, outflow: 0 })
  })
})
