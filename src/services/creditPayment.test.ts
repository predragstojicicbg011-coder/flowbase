import {
  payableInCreditCurrency, creditLegMoney, creditLegBooker, checkCreditCurrency,
  UnsupportedCreditCurrencyError, type PaymentBook,
} from './creditPayment'
import { bookAmountsAtRate, round2 } from './bookAmounts'

const EUR_RATE = 117.1734

/** A payment's stored book columns, as bookAmountsAtRate writes them. */
const paid = (amount: number, currency: string): PaymentBook =>
  bookAmountsAtRate(amount, currency, currency === 'EUR' ? EUR_RATE : currency === 'RSD' ? 1 : 108.5, EUR_RATE)

const sum = (xs: number[]) => round2(xs.reduce((s, x) => s + x, 0))

describe('payableInCreditCurrency', () => {
  it('an RSD credit is paid down by the payment in dinars', () => {
    expect(payableInCreditCurrency('RSD', paid(50000, 'RSD'))).toBe(50000)
  })
  it('a EUR credit paid from an RSD payment is paid down by its EUR figure at eur_rate', () => {
    const p = paid(50000, 'RSD')
    expect(payableInCreditCurrency('EUR', p)).toBe(round2(50000 / EUR_RATE))
  })
  it('a EUR credit paid from a EUR payment is paid down by exactly the document amount', () => {
    expect(payableInCreditCurrency('EUR', paid(426.73, 'EUR'))).toBe(426.73)
  })
  it('an RSD credit paid from a USD payment is paid down by the payment in dinars', () => {
    const p = paid(100, 'USD')
    expect(payableInCreditCurrency('RSD', p)).toBe(10850)
  })
  it('refuses a credit in any other currency rather than guessing', () => {
    expect(() => payableInCreditCurrency('USD', paid(100, 'RSD'))).toThrow(UnsupportedCreditCurrencyError)
    expect(() => payableInCreditCurrency(null, paid(100, 'RSD'))).toThrow(UnsupportedCreditCurrencyError)
    expect(() => checkCreditCurrency('CHF', 'Hipotekarni')).toThrow(/Hipotekarni.*CHF.*RSD ili EUR/)
  })
})

describe('creditLegMoney', () => {
  it('an RSD instalment of 50,000 is booked as 50,000 RSD — not 50,000 EUR', () => {
    const leg = creditLegMoney('RSD', paid(50000, 'RSD'), 50000)
    expect(leg).toEqual({
      currency: 'RSD', amount: 50000, exchange_rate: 1, eur_rate: EUR_RATE,
      amount_rsd: 50000, amount_eur: round2(50000 / EUR_RATE),
    })
  })

  it('a EUR leg paid from an RSD payment is a EUR row at the payment\'s eur_rate', () => {
    const p = paid(117173.4, 'RSD')   // exactly 1,000 EUR
    const leg = creditLegMoney('EUR', p, 400)
    expect(leg).toEqual({
      currency: 'EUR', amount: 400, exchange_rate: EUR_RATE, eur_rate: EUR_RATE,
      amount_rsd: round2(400 * EUR_RATE), amount_eur: 400,
    })
  })

  it('a EUR leg paid from a EUR payment keeps amount_eur = amount', () => {
    const leg = creditLegMoney('EUR', paid(426.73, 'EUR'), 426.73)
    expect(leg.amount).toBe(426.73)
    expect(leg.amount_eur).toBe(426.73)
    expect(leg.amount_rsd).toBe(paid(426.73, 'EUR').amount_rsd)
  })

  it('refuses an unsupported credit currency', () => {
    expect(() => creditLegMoney('USD', paid(100, 'RSD'), 10)).toThrow(UnsupportedCreditCurrencyError)
  })
})

describe('creditLegBooker — the last leg takes the rounding', () => {
  it('EUR legs from an RSD payment add up to the payment\'s amount_rsd exactly', () => {
    // 100,000 RSD = 853.44 EUR; split into three legs whose RSD figures,
    // each rounded on its own, would not add back to 100,000.
    const p = paid(100000, 'RSD')
    const legs = creditLegBooker('EUR', p)
    expect(legs.payable).toBe(853.44)
    const a = legs.book(333.33)
    const b = legs.book(333.33)
    expect(legs.remaining()).toBe(186.78)
    const c = legs.book(legs.remaining())
    const separately = sum([333.33, 333.33, 186.78].map(x => round2(x * EUR_RATE)))
    expect(separately).not.toBe(100000)         // the drift this exists to absorb
    expect(sum([a, b, c].map(l => l.amount_rsd))).toBe(100000)
    expect(sum([a, b, c].map(l => l.amount_eur))).toBe(p.amount_eur)
    // every leg but the last is booked at the rate, unadjusted
    expect(a.amount_rsd).toBe(round2(333.33 * EUR_RATE))
    // and every EUR leg keeps amount_eur = amount
    for (const l of [a, b, c]) expect(l.amount_eur).toBe(l.amount)
  })

  it('RSD legs from a EUR payment add up to the payment in both columns', () => {
    const p = paid(1000, 'EUR')                  // 117,173.40 RSD
    const legs = creditLegBooker('RSD', p)
    expect(legs.payable).toBe(117173.4)
    const a = legs.book(70000.01)
    const b = legs.book(legs.remaining())
    expect(sum([a.amount_rsd, b.amount_rsd])).toBe(117173.4)
    expect(sum([a.amount_eur, b.amount_eur])).toBe(1000)
    for (const l of [a, b]) expect(l.amount_rsd).toBe(l.amount)
  })

  it('a payment only partly used on instalments books its legs at the rate, no adjustment', () => {
    const p = paid(100000, 'RSD')
    const legs = creditLegBooker('EUR', p)
    const a = legs.book(100)
    expect(a.amount_rsd).toBe(round2(100 * EUR_RATE))
    expect(legs.remaining()).toBe(753.44)
  })

  it('refuses up front, before any leg is booked', () => {
    expect(() => creditLegBooker('USD', paid(100, 'RSD'), 'Leasing')).toThrow(/Leasing/)
  })
})
