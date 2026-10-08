import {
  CLOSED_WITHIN, outstandingOwn, paysInInvoiceCurrency, settledStatus, settlementFor,
  toleranceFor,
} from './settleInvoice'
import { RateUnavailableError } from './bookAmounts'

// Rates checkable by hand: 117.2 RSD per EUR, 100.5 RSD per USD.
// 220,996 RSD / 117.2 = 1,885.63 EUR; 1,200 USD * 100.5 = 120,600 RSD = 1,029.01 EUR.
const bill = { currency: 'RSD', amount: 220996, exchange_rate: 1, eur_rate: 117.2, amount_rsd: 220996, amount_eur: 1885.63 }
const euro = { currency: 'EUR', amount: 1200, exchange_rate: 117.2, eur_rate: 117.2, amount_rsd: 140640, amount_eur: 1200 }
const dollars = { currency: 'USD', amount: 1200, exchange_rate: 100.5, eur_rate: 117.2, amount_rsd: 120600, amount_eur: 1029.01 }

describe('what an invoice is still owed', () => {
  it('is read in the currency the bill was written in, not in the book currency', () => {
    // `paid_amount` is the view's sum of `allocated_amount` — the same column
    // the settled/partial rule is decided on. Deriving the remainder from the
    // BOOK column (remaining_rsd) instead is how the dialog came to show an
    // outstanding figure that disagreed with the rule it was judged against.
    expect(outstandingOwn({ ...bill, paid_amount: 100000 })).toBe(120996)
  })

  it('is the whole bill when nothing has been allocated', () => {
    expect(outstandingOwn(bill)).toBe(220996)
    expect(outstandingOwn({ ...bill, paid_amount: 0 })).toBe(220996)
    expect(outstandingOwn({ ...bill, paid_amount: null })).toBe(220996)
  })

  it('never goes below zero, however much was over-allocated', () => {
    // An over-allocated invoice is a thing to look at, not a negative number
    // to hand to the next allocation as a budget.
    expect(outstandingOwn({ ...bill, paid_amount: 230000 })).toBe(0)
  })

  it('does not put NaN where an amount belongs', () => {
    expect(outstandingOwn({ currency: 'RSD' })).toBe(0)
    expect(outstandingOwn({ ...bill, paid_amount: NaN })).toBe(220996)
  })
})

describe('whether the payment is in the currency of the bill', () => {
  it('is true when they agree, which is the ordinary case', () => {
    expect(paysInInvoiceCurrency('RSD', bill)).toBe(true)
  })

  it('is false when they do not', () => {
    expect(paysInInvoiceCurrency('EUR', bill)).toBe(false)
  })

  it('treats a missing currency on either side as dinars, the book currency', () => {
    expect(paysInInvoiceCurrency(null, bill)).toBe(true)
    expect(paysInInvoiceCurrency('RSD', {})).toBe(true)
    expect(paysInInvoiceCurrency(null, dollars)).toBe(false)
  })
})

describe('a payment in the same currency as the bill', () => {
  it('SETTLES IT TO THE PARA, whatever a payment-date rate says', () => {
    // Dinars paid a dinar bill. The payment's RSD figure is deliberately
    // something else, to show it plays no part.
    const s = settlementFor({
      invoice: bill, paymentCurrency: 'RSD', paymentOwn: 220996, paymentRsd: 1,
    })
    expect(s).toEqual({ own: 220996, rsd: 220996, eur: 1885.63, leftOnInvoice: 0, leftOnPayment: 0, direct: true })
  })

  it('records a part payment exactly as it was paid, booked at the invoice rates', () => {
    const s = settlementFor({
      invoice: bill, paymentCurrency: 'RSD', paymentOwn: 110498, paymentRsd: 110498,
    })
    expect(s.own).toBe(110498)
    expect(s.rsd).toBe(110498)
    expect(s.eur).toBe(942.82)   // 110498 / 117.2 = 942.8157
    expect(s.leftOnInvoice).toBe(110498)
  })

  it('closes a bill with two part payments that leave NOTHING behind', () => {
    const first = settlementFor({
      invoice: bill, paymentCurrency: 'RSD', paymentOwn: 110498, paymentRsd: 110498,
    })
    const second = settlementFor({
      invoice: { ...bill, paid_amount: first.own },
      paymentCurrency: 'RSD', paymentOwn: 110498, paymentRsd: 110498,
    })
    expect(first.own + second.own).toBe(220996)
    expect(first.rsd + second.rsd).toBe(220996)
    expect(second.leftOnInvoice).toBe(0)
  })

  it('gives the bill only what it is owed and hands the rest back', () => {
    const s = settlementFor({
      invoice: bill, paymentCurrency: 'RSD', paymentOwn: 250000, paymentRsd: 250000,
    })
    expect(s.own).toBe(220996)
    expect(s.leftOnPayment).toBe(29004)
    expect(s.leftOnInvoice).toBe(0)
  })

  it('closes a bill left a hair short by an older allocation', () => {
    const s = settlementFor({
      invoice: { ...bill, paid_amount: 220995.99 },
      paymentCurrency: 'RSD', paymentOwn: 0.01, paymentRsd: 0.01,
    })
    expect(s.own).toBe(0.01)
    expect(s.leftOnInvoice).toBe(0)
  })

  it('allocates nothing to a bill that is already settled', () => {
    const s = settlementFor({
      invoice: { ...bill, paid_amount: 220996 },
      paymentCurrency: 'RSD', paymentOwn: 50000, paymentRsd: 50000,
    })
    expect(s.own).toBe(0)
    expect(s.leftOnPayment).toBe(50000)
  })

  it('works the same for a dollar bill paid in dollars, booked at the bill rates', () => {
    const s = settlementFor({
      invoice: dollars, paymentCurrency: 'USD', paymentOwn: 1200, paymentRsd: 121000,
    })
    expect(s).toMatchObject({ own: 1200, rsd: 120600, eur: 1029.01, leftOnInvoice: 0, direct: true })
  })

  it('gives a euro bill its euros exactly', () => {
    const s = settlementFor({
      invoice: euro, paymentCurrency: 'EUR', paymentOwn: 600, paymentRsd: 70350,
    })
    expect(s).toMatchObject({ own: 600, rsd: 70320, eur: 600 })   // 600 * 117.2
  })
})

describe('a payment in another currency', () => {
  it('still settles the bill EXACTLY when it covers the whole remainder', () => {
    // 1,885 EUR at the payment date's 117.3 is 221,110.50 RSD — more than the
    // 220,996 owed, so the allocation is the remainder itself.
    const s = settlementFor({
      invoice: bill, paymentCurrency: 'EUR', paymentOwn: 1885, paymentRsd: 221110.5,
    })
    expect(s.own).toBe(220996)
    expect(s.rsd).toBe(220996)
    expect(s.eur).toBe(1885.63)
    expect(s.leftOnInvoice).toBe(0)
    // What is left of the payment: 1885 * (1 - 220996 / 221110.5) = 0.976…
    expect(s.leftOnPayment).toBe(0.98)
    expect(s.direct).toBe(false)
  })

  it('allocates what the payment reaches, and no more', () => {
    // 900 EUR at 117.3 = 105,570 RSD, which on a dinar bill is 105,570 RSD.
    const s = settlementFor({
      invoice: bill, paymentCurrency: 'EUR', paymentOwn: 900, paymentRsd: 105570,
    })
    expect(s.own).toBe(105570)
    expect(s.leftOnInvoice).toBe(115426)
    expect(s.leftOnPayment).toBe(0)
  })

  it('expresses a part in the bill currency at the bill rate', () => {
    // 60,000 RSD of a USD payment against a EUR bill: 60000 / 117.2 = 511.95 EUR,
    // booked back at the bill's rate as 511.95 * 117.2 = 60,000.54 RSD.
    const s = settlementFor({
      invoice: euro, paymentCurrency: 'USD', paymentOwn: 597, paymentRsd: 60000,
    })
    expect(s).toMatchObject({ own: 511.95, rsd: 60000.54, eur: 511.95, leftOnInvoice: 688.05 })
  })

  it('never gives a bill more than it is owed, whatever the rate does', () => {
    const s = settlementFor({
      invoice: euro, paymentCurrency: 'USD', paymentOwn: 5000, paymentRsd: 502500,
    })
    expect(s.own).toBe(1200)
    expect(s.rsd).toBe(140640)
    expect(s.leftOnInvoice).toBe(0)
  })

  it('leaves the payment alone when the bill wants nothing', () => {
    const s = settlementFor({
      invoice: { ...euro, paid_amount: 1200 },
      paymentCurrency: 'USD', paymentOwn: 500, paymentRsd: 50250,
    })
    expect(s.own).toBe(0)
    expect(s.rsd).toBe(0)
    expect(s.eur).toBe(0)
  })
})

describe('the figures it refuses to produce', () => {
  it('does not return NaN from a payment that is not a number', () => {
    const s = settlementFor({
      invoice: bill, paymentCurrency: 'RSD', paymentOwn: NaN, paymentRsd: NaN,
    })
    expect(s.own).toBe(0)
    expect(s.rsd).toBe(0)
  })

  it('does not go negative on a payment that is', () => {
    const s = settlementFor({
      invoice: bill, paymentCurrency: 'RSD', paymentOwn: -500, paymentRsd: -500,
    })
    expect(s.own).toBe(0)
  })

  it('refuses to book a link when the invoice carries no stored rate', () => {
    // A guessed rate looks exactly like a correct one.
    expect(() => settlementFor({
      invoice: { currency: 'RSD', amount: 5000 },
      paymentCurrency: 'RSD', paymentOwn: 5000, paymentRsd: 5000,
    })).toThrow(RateUnavailableError)
  })
})

describe('the tolerance', () => {
  it('is one para, not a tenth of a percent', () => {
    // A ratio grows with the bill: a tenth of a percent of 12,500,000 dinars
    // is 12,500 dinars of slack, which is not a rounding artefact — it is a
    // month of somebody's salary reading as settled.
    expect(CLOSED_WITHIN).toBe(0.01)
  })
})

describe('what the ledger says about a bill', () => {
  it('is unpaid when nothing has been allocated', () => {
    expect(settledStatus(220996, 0)).toBe('unpaid')
    expect(settledStatus(220996, -5)).toBe('unpaid')
  })

  it('is paid when the allocations land on the amount', () => {
    expect(settledStatus(220996, 220996)).toBe('paid')
  })

  it('is paid within one para, and not a hair further', () => {
    expect(settledStatus(220996, 220995.99)).toBe('paid')
    expect(settledStatus(220996, 220995.98)).toBe('partial')
  })

  it('is paid when more was allocated than the bill asked for', () => {
    expect(settledStatus(220996, 221000)).toBe('paid')
  })

  it('STOPS CALLING A MATERIALLY SHORT BILL PAID', () => {
    // The rule was `allocated >= amount * 0.999`, so the slack grew with the
    // bill: a tenth of a percent of twelve and a half million dinars is
    // 12,500 dinars, and an invoice short by twelve thousand read `paid`.
    // That is not a rounding artefact; it is a month of somebody's salary.
    expect(settledStatus(12500000, 12488000)).toBe('partial')
    expect(12488000).toBeGreaterThanOrEqual(12500000 * 0.999)  // the old rule said paid
  })

  it('STOPS CALLING A SETTLED SMALL BILL PARTIAL', () => {
    // And the same ratio was too TIGHT at the other end: a tenth of a percent
    // of 220 dinars is 22 para, so a bill settled to within a para of itself
    // could still read partial.
    expect(settledStatus(220.49, 220.48)).toBe('paid')
  })

  it('treats a bill for nothing as unpaid rather than paid', () => {
    expect(settledStatus(0, 0)).toBe('unpaid')
  })
})

// ─── The same tolerance as v_invoice_status ─────────────────────────────────
//
// One para (0.01 RSD) expressed in the bill's currency at its booked rate,
// never less than 0.01 of that currency: GREATEST(0.01, round(0.01 * amount /
// amount_rsd, 2)). For a dinar, euro or dollar bill that is 0.01.

describe('toleranceFor', () => {
  it('is a para on a dinar bill', () => {
    expect(toleranceFor(505023.01, 505023.01)).toBe(0.01)
  })

  it('is a cent on a euro or dollar bill', () => {
    expect(toleranceFor(1200, 140640)).toBe(0.01)
    expect(toleranceFor(1200, 120600)).toBe(0.01)
  })

  it('follows the view where a unit is worth less than a para', () => {
    // Not a currency this ledger takes; it shows the expression is the view's.
    expect(toleranceFor(1000, 10)).toBe(1)
  })

  it('falls back to a para when there is no dinar figure to size it with', () => {
    expect(toleranceFor(505023.01, null)).toBe(0.01)
    expect(toleranceFor(505023.01, 0)).toBe(0.01)
    expect(toleranceFor(505023.01, undefined)).toBe(0.01)
    expect(toleranceFor(0, 0)).toBe(0.01)
  })
})

describe('settling within a para', () => {
  const RSD = { amount: 505023.01, rsd: 505023.01 }

  it('does not settle a dinar bill that is 60 para short', () => {
    expect(settledStatus(RSD.amount, RSD.amount - 0.60, RSD.rsd)).toBe('partial')
  })

  it('settles one that is a para short', () => {
    expect(settledStatus(RSD.amount, RSD.amount - 0.01, RSD.rsd)).toBe('paid')
  })

  it('still settles an exact payment, and an overpayment', () => {
    expect(settledStatus(RSD.amount, RSD.amount, RSD.rsd)).toBe('paid')
    expect(settledStatus(RSD.amount, RSD.amount + 0.80, RSD.rsd)).toBe('paid')
  })

  it('is unpaid when nothing has been allocated at all', () => {
    expect(settledStatus(RSD.amount, 0, RSD.rsd)).toBe('unpaid')
  })
})
