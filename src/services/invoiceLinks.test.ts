import { invoiceRates, linkAmountsFromOwn, linkAmountsFromRsd } from './invoiceLinks'
import { RateUnavailableError } from './bookAmounts'

// Rates chosen to be checkable by hand: 117.5 RSD per EUR, 100.5 RSD per USD.
const rsd = { currency: 'RSD', amount: 300000, exchange_rate: 1, eur_rate: 117.5, amount_rsd: 300000, amount_eur: 2553.19 }
const eur = { currency: 'EUR', amount: 1200, exchange_rate: 117.5, eur_rate: 117.5, amount_rsd: 141000, amount_eur: 1200 }
const usd = { currency: 'USD', amount: 1200, exchange_rate: 100.5, eur_rate: 117.5, amount_rsd: 120600, amount_eur: 1026.38 }

describe('invoiceRates', () => {
  it('reads the stored rates off the invoice, RSD being 1', () => {
    expect(invoiceRates(rsd)).toEqual({ exchangeRate: 1, eurRate: 117.5 })
    expect(invoiceRates(usd)).toEqual({ exchangeRate: 100.5, eurRate: 117.5 })
  })

  it('says nothing rather than throwing while a page renders', () => {
    expect(invoiceRates({ currency: 'USD', amount: 10 })).toBeNull()
    expect(invoiceRates({ currency: 'RSD', amount: 10 })).toBeNull()   // no eur_rate
  })
})

describe('linkAmountsFromOwn', () => {
  it('stores the figure that was actually settled, untouched', () => {
    const out = linkAmountsFromOwn(220996, rsd)
    expect(out.allocated_amount).toBe(220996)
    expect(out.allocated_amount_rsd).toBe(220996)
    // 220996 / 117.5 = 1880.817…
    expect(out.allocated_amount_eur).toBe(1880.82)
  })

  it('books a EUR allocation exactly in EUR, and in RSD at the invoice rate', () => {
    expect(linkAmountsFromOwn(600, eur)).toEqual({
      allocated_amount: 600, allocated_amount_rsd: 70500, allocated_amount_eur: 600,
    })
  })

  it('books a USD allocation at the invoice rate, not a payment-date one', () => {
    // 600 * 100.5 = 60300; 60300 / 117.5 = 513.191…
    expect(linkAmountsFromOwn(600, usd)).toEqual({
      allocated_amount: 600, allocated_amount_rsd: 60300, allocated_amount_eur: 513.19,
    })
  })

  it('a bill paid in full lands on the bill in every currency', () => {
    expect(linkAmountsFromOwn(usd.amount, usd)).toEqual({
      allocated_amount: usd.amount, allocated_amount_rsd: usd.amount_rsd, allocated_amount_eur: usd.amount_eur,
    })
  })

  it('returns all three columns together so a call site cannot forget one', () => {
    expect(Object.keys(linkAmountsFromOwn(100, rsd)).sort())
      .toEqual(['allocated_amount', 'allocated_amount_eur', 'allocated_amount_rsd'])
  })

  it('does not put NaN in a column of money', () => {
    expect(linkAmountsFromOwn(NaN, rsd)).toEqual({ allocated_amount: 0, allocated_amount_rsd: 0, allocated_amount_eur: 0 })
  })

  it('refuses to guess when the invoice carries no rate', () => {
    expect(() => linkAmountsFromOwn(500, { currency: 'USD', amount: 500 })).toThrow(RateUnavailableError)
    expect(() => linkAmountsFromOwn(500, { currency: 'RSD', amount: 500 })).toThrow(RateUnavailableError)
  })

  it('keeps two part payments to the para', () => {
    const legs = [110498, 110498]
    const total = legs.reduce((s, own) => s + linkAmountsFromOwn(own, rsd).allocated_amount, 0)
    expect(total).toBe(220996)
  })
})

describe('linkAmountsFromRsd', () => {
  it('expresses a dinar figure in the invoice currency at the invoice rate', () => {
    // 70500 / 117.5 = 600 exactly; on a EUR bill the EUR column is that figure.
    expect(linkAmountsFromRsd(70500, eur)).toEqual({
      allocated_amount: 600, allocated_amount_rsd: 70500, allocated_amount_eur: 600,
    })
  })

  it('keeps the dinars as given on a dinar bill', () => {
    expect(linkAmountsFromRsd(12000, rsd)).toEqual({
      allocated_amount: 12000, allocated_amount_rsd: 12000, allocated_amount_eur: 102.13,
    })
  })

  it('refuses to guess when the invoice carries no rate', () => {
    expect(() => linkAmountsFromRsd(500, { currency: 'USD' })).toThrow(RateUnavailableError)
  })
})
