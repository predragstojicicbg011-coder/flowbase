import {
  allocatedInInvoiceCurrency, impliedRate, linkAmounts, linkAmountsFromOwn,
} from './invoiceLinks'

// A real one: 300,000 RSD booked at the NBS rate, giving $2,936.86.
const rsd = { currency: 'RSD', amount: 300000, amount_usd: 2936.86 }
const usd = { currency: 'USD', amount: 1200, amount_usd: 1200 }
const eur = { currency: 'EUR', amount: 1200, amount_usd: 1284.5 }

describe('impliedRate', () => {
  it('reads the rate off the invoice itself, not from a rate table', () => {
    // Consistent by construction with how this row was converted. A rate
    // fetched separately can be right about the day and still disagree.
    expect(impliedRate(rsd)).toBeCloseTo(102.15, 2)
  })

  it('says nothing rather than dividing by zero', () => {
    expect(impliedRate({ currency: 'RSD', amount: 300000, amount_usd: 0 })).toBeNull()
  })

  it('says nothing when either side is missing', () => {
    expect(impliedRate({ currency: 'RSD', amount: 300000 })).toBeNull()
    expect(impliedRate({ currency: 'RSD', amount_usd: 2936 })).toBeNull()
    expect(impliedRate({ currency: 'RSD', amount: null, amount_usd: null })).toBeNull()
  })

  it('refuses a rate that is not a positive number', () => {
    expect(impliedRate({ currency: 'RSD', amount: -300000, amount_usd: 2936.86 })).toBeNull()
    expect(impliedRate({ currency: 'RSD', amount: NaN, amount_usd: 100 })).toBeNull()
  })
})

describe('allocatedInInvoiceCurrency', () => {
  it('converts a dollar allocation into the currency the bill was written in', () => {
    // THE BUG: this used to be written as 2,936.86 into a dinar column.
    expect(allocatedInInvoiceCurrency(2936.86, rsd)).toBeCloseTo(300000, 0)
  })

  it('leaves a dollar invoice alone — nothing to convert, nothing to round', () => {
    expect(allocatedInInvoiceCurrency(1200, usd)).toBe(1200)
  })

  it('handles a euro invoice the same way', () => {
    expect(allocatedInInvoiceCurrency(642.25, eur)).toBeCloseTo(600, 2)
  })

  it('settles a whole invoice to its own amount, so it does not read as short', () => {
    // The property the view depends on: paying the full dollar figure must
    // land on the full own-currency figure. The tolerance is one para now,
    // not a tenth of a percent, so this has to hold much more tightly than it
    // did — see settledStatus() in services/settleInvoice.ts.
    const own = allocatedInInvoiceCurrency(rsd.amount_usd, rsd)
    expect(own).toBeGreaterThanOrEqual(rsd.amount - 0.01)
  })

  it('scales a part payment proportionally', () => {
    expect(allocatedInInvoiceCurrency(rsd.amount_usd / 2, rsd)).toBeCloseTo(150000, 0)
  })

  it('rounds to the cent, as the column stores it', () => {
    const out = allocatedInInvoiceCurrency(33.333, { currency: 'EUR', amount: 100, amount_usd: 100 })
    expect(out).toBe(33.33)
  })

  it('falls back to the dollar figure when the invoice carries no usable rate', () => {
    // Not right for a foreign invoice, but it is the only number available,
    // and it is what these call sites did before. Inventing a rate would be a
    // quieter kind of wrong.
    expect(allocatedInInvoiceCurrency(500, { currency: 'RSD' })).toBe(500)
  })

  it('treats a missing currency as dollars rather than throwing', () => {
    expect(allocatedInInvoiceCurrency(500, {})).toBe(500)
  })

  it('does not turn a nonsense allocation into NaN in the database', () => {
    expect(allocatedInInvoiceCurrency(NaN, rsd)).toBe(0)
  })
})

describe('linkAmounts', () => {
  it('fills both columns, each in its own unit', () => {
    const out = linkAmounts(2936.86, rsd)
    expect(out.allocated_amount_usd).toBe(2936.86)
    expect(out.allocated_amount).toBeCloseTo(300000, 0)
  })

  it('gives the same figure twice for a dollar invoice, which is correct there', () => {
    expect(linkAmounts(1200, usd)).toEqual({ allocated_amount: 1200, allocated_amount_usd: 1200 })
  })

  it('returns them together so a call site cannot fill one and forget the other', () => {
    // The shape of the original defect: one column right, the other carrying
    // the same number in the wrong unit.
    expect(Object.keys(linkAmounts(100, rsd)).sort())
      .toEqual(['allocated_amount', 'allocated_amount_usd'])
  })
})

describe('linkAmountsFromOwn', () => {
  it('stores the figure that was actually settled, untouched', () => {
    // THE DEFECT THIS EXISTS FOR. `linkAmounts` takes dollars and derives the
    // dinars, so the column the settled/partial rule reads had been through a
    // rounding to the whole US cent — about a dinar — on the way in. This
    // takes the dinars and derives the dollars, which is the direction the
    // money actually moved.
    const out = linkAmountsFromOwn(220996, { currency: 'RSD', amount: 220996, amount_usd: 2159.31 })
    expect(out.allocated_amount).toBe(220996)
    expect(out.allocated_amount_usd).toBe(2159.31)
  })

  it('keeps a part payment to the para', () => {
    const out = linkAmountsFromOwn(110498, rsd)
    expect(out.allocated_amount).toBe(110498)
  })

  it('leaves a dollar invoice alone', () => {
    expect(linkAmountsFromOwn(1200, usd)).toEqual({ allocated_amount: 1200, allocated_amount_usd: 1200 })
  })

  it('falls back to the figure itself where the invoice carries no rate', () => {
    expect(linkAmountsFromOwn(500, { currency: 'RSD' }))
      .toEqual({ allocated_amount: 500, allocated_amount_usd: 500 })
  })

  it('does not put NaN in a column of money', () => {
    expect(linkAmountsFromOwn(NaN, rsd)).toEqual({ allocated_amount: 0, allocated_amount_usd: 0 })
  })

  it('survives the round trip `linkAmounts` does not', () => {
    // Two part payments of a bill, each typed in dinars. Through the dollar
    // column they drifted apart by the value of half a cent each and the bill
    // never closed.
    const legs = [110498, 110498]
    const total = legs.reduce((s, own) => s + linkAmountsFromOwn(own, rsd).allocated_amount, 0)
    expect(total).toBe(220996)
  })
})
