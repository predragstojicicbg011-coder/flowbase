import {
  allocationCurrency, commonCurrency, formatMoney, hasOwnCurrency, seedOwn, toEur, toOwn, toRsd, toUsd,
} from './allocationDisplay'

// Rates checkable by hand: 117.5 RSD per EUR, 100.5 RSD per USD.
const rsd = { currency: 'RSD', amount: 300000, exchange_rate: 1, eur_rate: 117.5, amount_rsd: 300000, amount_eur: 2553.19 }
const usd = { currency: 'USD', amount: 1200, exchange_rate: 100.5, eur_rate: 117.5, amount_rsd: 120600, amount_eur: 1026.38 }
const eur = { currency: 'EUR', amount: 1200, exchange_rate: 117.5, eur_rate: 117.5, amount_rsd: 141000, amount_eur: 1200 }
const rateless = { currency: 'EUR', amount: 1200 }

describe('which currency an allocation is typed in', () => {
  it('is the invoice currency for a foreign bill', () => {
    expect(hasOwnCurrency(eur)).toBe(true)
    expect(allocationCurrency(eur)).toBe('EUR')
    expect(allocationCurrency(usd)).toBe('USD')
  })

  it('is dinars for a dinar bill, with nothing to convert', () => {
    expect(hasOwnCurrency(rsd)).toBe(false)
    expect(allocationCurrency(rsd)).toBe('RSD')
  })

  it('is still the bill currency when the invoice carries no usable rate', () => {
    // Nothing can be converted, but the figure typed is in euros all the same.
    expect(hasOwnCurrency(rateless)).toBe(false)
    expect(allocationCurrency(rateless)).toBe('EUR')
  })

  it('is dinars when the invoice names no currency', () => {
    expect(allocationCurrency({})).toBe('RSD')
  })
})

describe('converting between the two', () => {
  it('shows a dinar figure in the bill currency', () => {
    expect(toOwn(70500, eur)).toBe(600)
    expect(toOwn(60300, usd)).toBe(600)
  })

  it('takes an own-currency figure to dinars at the invoice rate', () => {
    expect(toRsd(600, eur)).toBe(70500)
    expect(toRsd(600, usd)).toBe(60300)
  })

  it('leaves a dinar invoice alone in both directions', () => {
    expect(toOwn(500, rsd)).toBe(500)
    expect(toRsd(500, rsd)).toBe(500)
  })

  it('gives euros exactly on a EUR bill and via dinars otherwise', () => {
    expect(toEur(600, eur)).toBe(600)
    expect(toEur(600, usd)).toBe(513.19)   // 60300 / 117.5
    expect(toEur(11750, rsd)).toBe(100)
    expect(toEur(600, { currency: 'USD', amount: 600 })).toBeNull()
  })

  it('keeps toUsd as a deprecated alias of toRsd', () => {
    expect(toUsd).toBe(toRsd)
  })

  it('treats nonsense as nothing rather than NaN', () => {
    expect(toOwn(NaN, eur)).toBe(0)
    expect(toRsd(NaN, eur)).toBe(0)
  })

  it('does not divide by a rate it does not have', () => {
    expect(toRsd(1200, rateless)).toBe(1200)
    expect(toOwn(1200, rateless)).toBe(1200)
  })
})

describe('seedOwn', () => {
  it('seeds from the stored own-currency figure when the link has one', () => {
    expect(seedOwn({ allocated_amount: 600, allocated_amount_rsd: 70500 }, eur)).toBe(600)
  })

  it('converts a dinar figure once when that is all there is', () => {
    expect(seedOwn({ allocated_amount_rsd: 70500 }, eur)).toBe(600)
    expect(seedOwn(70500, eur)).toBe(600)
  })
})

describe('commonCurrency', () => {
  it('is the shared currency when the payment and every invoice agree', () => {
    expect(commonCurrency('RSD', [rsd, rsd])).toBe('RSD')
  })

  it('is the payment currency when it closes nothing yet', () => {
    expect(commonCurrency('RSD', [])).toBe('RSD')
  })

  it('says there is none when the invoices disagree with each other', () => {
    expect(commonCurrency('RSD', [rsd, eur])).toBeNull()
  })

  it('says there is none when an invoice disagrees with the payment', () => {
    expect(commonCurrency('USD', [rsd])).toBeNull()
  })

  it('says there is none when the payment has no currency to speak of', () => {
    expect(commonCurrency('', [rsd])).toBeNull()
    expect(commonCurrency(null, [rsd])).toBeNull()
  })
})

describe('formatMoney', () => {
  it('writes every currency the way a Serbian statement does', () => {
    expect(formatMoney(300000, 'RSD')).toBe('300.000,00 RSD')
    expect(formatMoney(1200, 'EUR')).toBe('1.200,00 EUR')
    expect(formatMoney(1234.5, 'USD')).toBe('1.234,50 USD')
  })

  it('always writes the para, so a round figure cannot be read two ways', () => {
    expect(formatMoney(12000, 'RSD')).toBe('12.000,00 RSD')
    expect(formatMoney(86292, 'RSD')).toBe('86.292,00 RSD')
  })

  it('prints something rather than NaN', () => {
    expect(formatMoney(NaN, 'RSD')).toBe('0,00 RSD')
  })
})
