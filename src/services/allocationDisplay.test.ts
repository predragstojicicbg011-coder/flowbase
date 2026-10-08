import {
  allocationCurrency, commonCurrency, formatMoney, hasOwnCurrency, seedOwn, toOwn, toUsd,
} from './allocationDisplay'

// A real one: 300,000 RSD booked at the NBS rate, so the implied rate is
// 102.15 and every figure below is checkable by hand.
const rsd = { currency: 'RSD', amount: 300000, amount_usd: 2936.86 }
const usd = { currency: 'USD', amount: 1200, amount_usd: 1200 }
const eur = { currency: 'EUR', amount: 1200, amount_usd: 1284.5 }
const rateless = { currency: 'RSD', amount: 300000, amount_usd: 0 }

describe('which currency an allocation is typed in', () => {
  it('is the invoice currency for a foreign bill', () => {
    expect(hasOwnCurrency(rsd)).toBe(true)
    expect(allocationCurrency(rsd)).toBe('RSD')
  })

  it('is dollars for a dollar bill, with nothing to convert', () => {
    expect(hasOwnCurrency(usd)).toBe(false)
    expect(allocationCurrency(usd)).toBe('USD')
  })

  it('falls back to dollars when the invoice carries no usable rate', () => {
    // Converting on a rate that is not there would put an invented figure in
    // front of someone about to type money into it.
    expect(hasOwnCurrency(rateless)).toBe(false)
    expect(allocationCurrency(rateless)).toBe('USD')
  })
})

describe('converting between the two', () => {
  it('shows a dollar allocation in dinars', () => {
    expect(toOwn(2936.86, rsd)).toBeCloseTo(300000, 0)
  })

  it('takes a dinar allocation back to dollars for the link', () => {
    expect(toUsd(300000, rsd)).toBeCloseTo(2936.86, 2)
  })

  it('leaves a dollar invoice alone in both directions', () => {
    expect(toOwn(500, usd)).toBe(500)
    expect(toUsd(500, usd)).toBe(500)
  })

  it('handles euros the same way', () => {
    expect(toOwn(642.25, eur)).toBeCloseTo(600, 2)
    expect(toUsd(600, eur)).toBeCloseTo(642.25, 2)
  })

  it('cannot round-trip exactly, which is why the component holds the typed figure', () => {
    // The dollar column stores cents, so half a cent of rounding comes back as
    // half a cent times the rate — about 0.51 RSD here. 12,000 returns as
    // 11,999.69.
    //
    // This is not a defect to fix; it is arithmetic. It is the reason the
    // dialog keeps what the user typed and derives the dollars from it,
    // instead of storing dollars and redisplaying the conversion. A field that
    // rewrites your number after you leave it is how a figure gets corrected
    // twice and ends up wrong.
    const halfACent = 0.005 * (rsd.amount / rsd.amount_usd)
    for (const typed of [12000, 1, 99999.99, 0.01, 345678.9]) {
      const back = toOwn(toUsd(typed, rsd), rsd)
      expect(Math.abs(back - typed)).toBeLessThanOrEqual(halfACent + 0.01)
      expect(back).not.toBe(typed)   // not equal, and not pretended to be
    }
  })

  it('treats nonsense as nothing rather than NaN', () => {
    expect(toOwn(NaN, rsd)).toBe(0)
    expect(toUsd(NaN, rsd)).toBe(0)
  })

  it('does not divide by a rate it does not have', () => {
    expect(toUsd(300000, rateless)).toBe(300000)
    expect(toOwn(300000, rateless)).toBe(300000)
  })
})

describe('seedOwn', () => {
  it('converts a stored link once, before anyone has typed anything', () => {
    expect(seedOwn(2936.86, rsd)).toBeCloseTo(300000, 0)
  })

  it('leaves a dollar link as it is', () => {
    expect(seedOwn(1200, usd)).toBe(1200)
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
    // A total in one of the two would be nobody's actual money.
    expect(commonCurrency('USD', [rsd])).toBeNull()
  })

  it('says there is none when the payment has no currency to speak of', () => {
    expect(commonCurrency('', [rsd])).toBeNull()
    expect(commonCurrency(null, [rsd])).toBeNull()
  })
})

describe('formatMoney', () => {
  it('leads with the sign for dollars, as the rest of this screen does', () => {
    expect(formatMoney(1234.5, 'USD')).toBe('$1,234.50')
    expect(formatMoney(-1234.5, 'USD')).toBe('-$1,234.50')
  })

  it('writes everything else the way a Serbian statement does', () => {
    // Dots for thousands, a comma for the para. It printed `300,000.00 RSD`
    // before — the dollar convention wearing a dinar's code, on a figure
    // meant to be checked against a bank statement.
    expect(formatMoney(300000, 'RSD')).toBe('300.000,00 RSD')
    expect(formatMoney(1200, 'EUR')).toBe('1.200,00 EUR')
  })

  it('always writes the para, so a round figure cannot be read two ways', () => {
    // `86.292` is eighty-six thousand to one reader and eighty-six point two
    // nine two to another. `86.292,00` is only ever one of them.
    expect(formatMoney(12000, 'RSD')).toBe('12.000,00 RSD')
    expect(formatMoney(86292, 'RSD')).toBe('86.292,00 RSD')
  })

  it('prints something rather than NaN', () => {
    expect(formatMoney(NaN, 'RSD')).toBe('0,00 RSD')
  })
})
