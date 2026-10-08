import {
  CLOSED_WITHIN, outstandingOwn, paysInInvoiceCurrency, settledStatus, settlementFor,
  toleranceFor,
} from './settleInvoice'

// A real shape: 220,996.00 RSD booked on a day the NBS said 102.3456, so the
// dollar column holds 2,159.31. The implied rate reads back off the row.
const bill = { currency: 'RSD', amount: 220996, amount_usd: 2159.31 }
const euro = { currency: 'EUR', amount: 1200, amount_usd: 1284.5 }
const dollars = { currency: 'USD', amount: 1200, amount_usd: 1200 }

describe('what an invoice is still owed', () => {
  it('is read in the currency the bill was written in, not in dollars', () => {
    // `paid_amount` is the view's sum of `allocated_amount` — the same column
    // the settled/partial rule is decided on. Deriving the remainder from the
    // DOLLAR column instead is how the dialog came to show an outstanding
    // figure that disagreed with the rule it was judged against.
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

  it('treats a missing currency on either side as dollars', () => {
    expect(paysInInvoiceCurrency(null, dollars)).toBe(true)
    expect(paysInInvoiceCurrency('USD', {})).toBe(true)
    expect(paysInInvoiceCurrency(null, bill)).toBe(false)
  })
})

describe('a payment in the same currency as the bill', () => {
  it('SETTLES IT TO THE PARA, whatever the dollar columns say', () => {
    // THE DEFECT. 220,996 dinars were paid against a bill of 220,996 dinars.
    // The old path converted the payment to dollars at the PAYMENT date's
    // rate, capped it against the invoice's dollars at the INVOICE date's
    // rate, and converted back — so a rate that had moved half a percent
    // between the two dates left the bill short by over a thousand dinars,
    // and an unmoved rate still left it short by the value of half a US cent.
    // Dinars paid a dinar bill. Nothing here needs a rate at all.
    const s = settlementFor({
      invoice: bill,
      paymentCurrency: 'RSD',
      paymentOwn: 220996,
      paymentUsd: 2157.89,   // a later day's rate — deliberately NOT the invoice's
    })
    expect(s.own).toBe(220996)
    expect(s.leftOnInvoice).toBe(0)
    expect(s.direct).toBe(true)
  })

  it('records a part payment exactly as it was paid', () => {
    // The figure a person typed is never shown back to them altered, and is
    // never stored altered either.
    const s = settlementFor({
      invoice: bill, paymentCurrency: 'RSD', paymentOwn: 110498, paymentUsd: 1079.66,
    })
    expect(s.own).toBe(110498)
    expect(s.leftOnInvoice).toBe(110498)
  })

  it('closes a bill with two part payments that leave NOTHING behind', () => {
    // Each leg used to be quantised to a whole US cent, worth about a dinar,
    // so two legs drifted by up to a dinar between them and the bill sat
    // there owing "par para" for ever.
    const first = settlementFor({
      invoice: bill, paymentCurrency: 'RSD', paymentOwn: 110498, paymentUsd: 1079.66,
    })
    const second = settlementFor({
      invoice: { ...bill, paid_amount: first.own },
      paymentCurrency: 'RSD', paymentOwn: 110498, paymentUsd: 1079.66,
    })
    expect(first.own + second.own).toBe(220996)
    expect(second.leftOnInvoice).toBe(0)
  })

  it('gives the bill only what it is owed and hands the rest back', () => {
    const s = settlementFor({
      invoice: bill, paymentCurrency: 'RSD', paymentOwn: 250000, paymentUsd: 2442.5,
    })
    expect(s.own).toBe(220996)
    expect(s.leftOnPayment).toBe(29004)
    expect(s.leftOnInvoice).toBe(0)
  })

  it('closes a bill left a hair short by an older, lossier allocation', () => {
    // There are rows in the database already short by the value of half a
    // cent. A payment for the round figure should finish them, not leave the
    // remainder to be chased.
    const s = settlementFor({
      invoice: { ...bill, paid_amount: 220995.99 },
      paymentCurrency: 'RSD', paymentOwn: 0.01, paymentUsd: 0,
    })
    expect(s.own).toBe(0.01)
    expect(s.leftOnInvoice).toBe(0)
  })

  it('allocates nothing to a bill that is already settled', () => {
    const s = settlementFor({
      invoice: { ...bill, paid_amount: 220996 },
      paymentCurrency: 'RSD', paymentOwn: 50000, paymentUsd: 488.5,
    })
    expect(s.own).toBe(0)
    expect(s.leftOnPayment).toBe(50000)
  })

  it('works the same for a dollar bill paid in dollars', () => {
    const s = settlementFor({
      invoice: dollars, paymentCurrency: 'USD', paymentOwn: 1200, paymentUsd: 1200,
    })
    expect(s).toMatchObject({ own: 1200, usd: 1200, leftOnInvoice: 0, direct: true })
  })
})

describe('a payment in another currency', () => {
  it('still settles the bill EXACTLY when it covers the whole remainder', () => {
    // Converting the remainder to dollars and back is what left the para
    // behind. Where the payment covers it, the allocation IS the remainder —
    // there is no arithmetic to get wrong.
    const s = settlementFor({
      invoice: bill, paymentCurrency: 'EUR', paymentOwn: 1885, paymentUsd: 2200,
    })
    expect(s.own).toBe(220996)
    expect(s.leftOnInvoice).toBe(0)
    expect(s.direct).toBe(false)
  })

  it('allocates what the payment reaches, and no more', () => {
    const s = settlementFor({
      invoice: bill, paymentCurrency: 'EUR', paymentOwn: 900, paymentUsd: 1050,
    })
    // 1,050 dollars at the invoice's own implied rate of 102.34565.
    expect(s.own).toBe(107462.94)
    expect(s.own).toBeLessThan(220996)
    expect(s.leftOnInvoice).toBeCloseTo(220996 - s.own, 2)
  })

  it('never gives a bill more than it is owed, whatever the rate does', () => {
    const s = settlementFor({
      invoice: euro, paymentCurrency: 'USD', paymentOwn: 5000, paymentUsd: 5000,
    })
    expect(s.own).toBe(1200)
    expect(s.leftOnInvoice).toBe(0)
  })

  it('leaves the payment alone when the bill wants nothing', () => {
    const s = settlementFor({
      invoice: { ...euro, paid_amount: 1200 },
      paymentCurrency: 'USD', paymentOwn: 500, paymentUsd: 500,
    })
    expect(s.own).toBe(0)
    expect(s.usd).toBe(0)
  })
})

describe('the figures it refuses to produce', () => {
  it('does not return NaN from a payment that is not a number', () => {
    const s = settlementFor({
      invoice: bill, paymentCurrency: 'RSD', paymentOwn: NaN, paymentUsd: NaN,
    })
    expect(s.own).toBe(0)
    expect(s.usd).toBe(0)
  })

  it('does not go negative on a payment that is', () => {
    const s = settlementFor({
      invoice: bill, paymentCurrency: 'RSD', paymentOwn: -500, paymentUsd: -5,
    })
    expect(s.own).toBe(0)
  })

  it('falls back to the amount itself where the invoice carries no rate', () => {
    // Not right for a foreign bill, but it is the only figure available, and
    // inventing a rate would be a quieter kind of wrong.
    const s = settlementFor({
      invoice: { currency: 'RSD', amount: 5000 },
      paymentCurrency: 'RSD', paymentOwn: 5000, paymentUsd: 48.9,
    })
    expect(s.own).toBe(5000)
    expect(s.usd).toBe(5000)
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

// ─── A dinar, not a para ────────────────────────────────────────────────────
//
// The absolute tolerance was right in shape and wrong in size for the currency
// this ledger mostly runs in. A para is a hundredth of a dinar and nothing
// settles to a hundredth of a dinar; what arrives is a bank rounding to the
// dinar, or a transfer sent as a round number.

describe('toleranceFor', () => {
  it('is about a dinar on a dinar bill', () => {
    // 505,023.01 RSD against $4,941.37 — roughly 102 dinars to the dollar.
    expect(toleranceFor(505023.01, 4941.37)).toBeCloseTo(1.02, 2)
  })

  /** A euro cent is already wider than a cent's worth, so it is kept. */
  it('leaves a euro bill its para', () => {
    expect(toleranceFor(920, 1000)).toBe(0.01)
  })

  it('leaves a dollar bill its cent', () => {
    expect(toleranceFor(1000, 1000)).toBe(0.01)
  })

  /** It can only ever loosen: tightening would reopen settled invoices. */
  it('never returns less than the para it replaced', () => {
    for (const [amount, usd] of [[1, 1000], [0.5, 900], [100, 100000]]) {
      expect(toleranceFor(amount, usd)).toBeGreaterThanOrEqual(0.01)
    }
  })

  it('falls back to a para when there is no dollar figure to size it with', () => {
    expect(toleranceFor(505023.01, null)).toBe(0.01)
    expect(toleranceFor(505023.01, 0)).toBe(0.01)
    expect(toleranceFor(505023.01, undefined)).toBe(0.01)
    expect(toleranceFor(0, 0)).toBe(0.01)
  })
})

describe('settling within a dinar', () => {
  const RSD = { amount: 505023.01, usd: 4941.37 }

  it('settles a dinar bill that is 60 para short', () => {
    expect(settledStatus(RSD.amount, RSD.amount - 0.60, RSD.usd)).toBe('paid')
  })

  it('settles one that is a whole dinar short', () => {
    expect(settledStatus(RSD.amount, RSD.amount - 1.00, RSD.usd)).toBe('paid')
  })

  /** A dinar is the tolerance, not a licence. Two is a difference. */
  it('does not settle one that is two dinars short', () => {
    expect(settledStatus(RSD.amount, RSD.amount - 2.00, RSD.usd)).toBe('partial')
  })

  it('still settles an exact payment, and an overpayment', () => {
    expect(settledStatus(RSD.amount, RSD.amount, RSD.usd)).toBe('paid')
    expect(settledStatus(RSD.amount, RSD.amount + 0.80, RSD.usd)).toBe('paid')
  })

  it('is unpaid when nothing has been allocated at all', () => {
    expect(settledStatus(RSD.amount, 0, RSD.usd)).toBe('unpaid')
  })

  /** Without the dollar figure it behaves exactly as it did before. */
  it('keeps the old answer when it is not told the dollar amount', () => {
    expect(settledStatus(RSD.amount, RSD.amount - 0.60)).toBe('partial')
    expect(settledStatus(RSD.amount, RSD.amount - 0.01)).toBe('paid')
  })
})
