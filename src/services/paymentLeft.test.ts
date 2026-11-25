import {
  allocationsExceedPayment, asHeldLink, heldDinars, linkDinars, linkSlack, overAllocationProblem, paymentLeft, paymentRate, readHeldLinks,
} from './paymentLeft'
import { linkAmountsFromOwn } from './invoiceLinks'
import { settlementFor } from './settleInvoice'

// A payment is never allocated beyond itself, counted in DINARS as the payment
// sees each link (20261125100000; the owner's ruling of 2026-11-25).

const rsd700 = { amount: 700, amount_rsd: 700, currency: 'RSD' }
const eur1000 = { amount: 1000, amount_rsd: 117200, currency: 'EUR' }

describe('the payment in dinars', () => {
  it('a dinar payment has rate 1; a euro payment its own amount_rsd / amount; none without a dinar figure', () => {
    expect(paymentRate(rsd700)).toBe(1)
    expect(paymentRate({ amount: 700, currency: null })).toBe(1)
    expect(paymentRate(eur1000)).toBeCloseTo(117.2, 10)
    expect(paymentRate({ amount: 1000, amount_rsd: null, currency: 'EUR' })).toBeNull()
  })

  it('a link in the payment\'s currency counts at the PAYMENT\'s rate, not the invoice\'s', () => {
    // A 1000 EUR bill booked at 117.5 paid by a 1000 EUR payment at 117.2.
    expect(linkDinars(eur1000, { currency: 'EUR', allocated_amount: 1000, allocated_amount_rsd: 117500 })).toBeCloseTo(117200, 6)
  })

  it('a link in another currency counts at its own dinar figure -- a dinar payment of a euro bill is counted', () => {
    expect(linkDinars(rsd700, { currency: 'EUR', allocated_amount: 5, allocated_amount_rsd: 587.5 })).toBe(587.5)
    expect(linkDinars({ amount: 1000, amount_rsd: null, currency: 'EUR' }, { currency: 'RSD', allocated_amount: 5, allocated_amount_rsd: 5 })).toBeNull()
  })
})

describe('what is left of a payment', () => {
  it('nothing, once its links hold all of it', () => {
    const held = [{ allocated_amount: 700, allocated_amount_rsd: 700, currency: 'RSD' }]
    expect(heldDinars(rsd700, held)).toBe(700)
    expect(paymentLeft(rsd700, held)).toEqual({ rsd: 0, own: 0 })
  })

  it('a payroll child and a deleted invoice are not counted', () => {
    const held = [
      { allocated_amount: 400, allocated_amount_rsd: 400, currency: 'RSD' },
      { allocated_amount: 400, allocated_amount_rsd: 400, currency: 'RSD', child: true },
      { allocated_amount: 100, allocated_amount_rsd: 100, currency: 'RSD', deleted: true },
    ]
    expect(paymentLeft(rsd700, held)).toEqual({ rsd: 300, own: 300 })
  })

  it('a euro payment half spent has 500 EUR left, 58.600 RSD at its own rate', () => {
    const held = [{ allocated_amount: 500, allocated_amount_rsd: 58750, currency: 'EUR' }]
    expect(paymentLeft(eur1000, held)).toEqual({ rsd: 58600, own: 500 })
  })
})

describe('overAllocationProblem', () => {
  const held = [{ allocated_amount: 700, allocated_amount_rsd: 700, currency: 'RSD' }]

  it('refuses the second whole allocation of one payment, with the figures, in Serbian', () => {
    expect(overAllocationProblem({ ...rsd700, label: 'od 12.10.2026 (izvod 5)' }, held, 700)).toBe(
      'Plaćanje od 12.10.2026 (izvod 5) iznosi 700,00 RSD i već plaća 700,00 RSD: od njega je ostalo 0,00 RSD, a traži se 700,00 RSD. Plaćanje se ne raspoređuje preko onoga što je plaćeno.')
  })

  it('lets through what is left, and a para of rounding per link', () => {
    expect(overAllocationProblem(rsd700, [], 700)).toBeNull()
    expect(overAllocationProblem(rsd700, [{ allocated_amount: 400, allocated_amount_rsd: 400, currency: 'RSD' }], 300.01)).toBeNull()
    expect(overAllocationProblem(rsd700, [{ allocated_amount: 400, allocated_amount_rsd: 400, currency: 'RSD' }], 300.05)).not.toBeNull()
  })

  it('counts a dinar payment\'s euro link (Mintflow would not)', () => {
    const payment = { amount: 117500, amount_rsd: 117500, currency: 'RSD' }
    const euroLink = [{ allocated_amount: 1000, allocated_amount_rsd: 117500, currency: 'EUR' }]
    expect(overAllocationProblem(payment, euroLink, 2)).toMatch(/^Plaćanje iznosi 117\.500,00 RSD i već plaća 117\.500,00 RSD/)
  })
})

describe('asHeldLink and readHeldLinks', () => {
  it('reads a link with its invoice: child and unseen', () => {
    expect(asHeldLink({ allocated_amount: 5, allocated_amount_rsd: 587.5, invoices: { currency: 'EUR', parent_invoice_id: null } }))
      .toEqual({ allocated_amount: 5, allocated_amount_rsd: 587.5, currency: 'EUR', child: false, deleted: false })
    expect(asHeldLink({ allocated_amount: 5, invoices: { currency: 'RSD', parent_invoice_id: 'p' } }).child).toBe(true)
    expect(asHeldLink({ allocated_amount: 5, invoices: null }).deleted).toBe(true)
  })

  it('leaves out the link of the bill about to be rewritten', async () => {
    const rows = [
      { invoice_id: 'a', allocated_amount: 300, allocated_amount_rsd: 300, invoices: { currency: 'RSD', parent_invoice_id: null } },
      { invoice_id: 'b', allocated_amount: 400, allocated_amount_rsd: 400, invoices: { currency: 'RSD', parent_invoice_id: null } },
    ]
    const asked: string[] = []
    const client = { from: (t: string) => ({ select: (s: string) => { asked.push(`${t}:${s}`); return { eq: () => Promise.resolve({ data: rows }) } } }) }
    const { held } = await readHeldLinks(client, 'tx', 'b')
    expect(held).toHaveLength(1)
    expect(asked[0]).toBe('invoice_transaction_links:invoice_id, allocated_amount, allocated_amount_rsd, invoices(currency, parent_invoice_id)')
  })
})

describe('allocationsExceedPayment (the transaction dialog, before any write)', () => {
  const a = (allocated: number, extra: Record<string, unknown> = {}) => ({ allocated, allocated_rsd: allocated, currency: 'RSD', ...extra })

  it('refuses a set above the payment, in Serbian', () => {
    expect(allocationsExceedPayment({ amount: 100, amount_rsd: 100, currency: 'RSD' }, [a(70), a(40)])).toBe(
      'Fakture na ovom plaćanju su raspoređene 110,00 RSD, više od samog plaćanja (100,00 RSD). Ništa nije sačuvano. Smanjite raspodelu: plaćanje se ne raspoređuje preko onoga što je plaćeno.')
    expect(allocationsExceedPayment({ amount: 100, amount_rsd: 100, currency: 'RSD' }, [a(70), a(30)])).toBeNull()
  })

  it('counts as the database does: no payroll child, no unseen invoice, a euro link in dinars', () => {
    expect(allocationsExceedPayment({ amount: 1000, amount_rsd: 1000, currency: 'RSD' }, [a(1000), a(1000, { child: true })])).toBeNull()
    expect(allocationsExceedPayment({ amount: 1000, amount_rsd: 1000, currency: 'RSD' }, [a(1000), a(500, { unseen: true })])).toBeNull()
    expect(allocationsExceedPayment({ amount: 117500, amount_rsd: 117500, currency: 'RSD' },
      [{ allocated: 1000, allocated_rsd: 117500, currency: 'EUR' }, a(2)])).not.toBeNull()
  })

  it('a payment already over re-saves unchanged or lowered; raised, it is refused', () => {
    const before = [a(700), a(700)]
    const pay = { amount: 700, amount_rsd: 700, currency: 'RSD' }
    expect(allocationsExceedPayment(pay, [a(700), a(700)], before)).toBeNull()
    expect(allocationsExceedPayment(pay, [a(700), a(100)], before)).toBeNull()
    expect(allocationsExceedPayment(pay, [a(700), a(701)], before)).not.toBeNull()
  })
})

// ── A dinar payment short of a euro bill (fix round 1) ──────────────────────
//
// settlementFor's part payment writes own = round2(dinars / rate), and the
// link's dinars are round2(own × rate): up to half a euro-para ABOVE what the
// payment paid. The slack for a link in another currency is a para of the
// INVOICE's currency, as the database allows.
describe('settlementFor -> overAllocationProblem: the guard never refuses settlementFor\'s own output', () => {
  const euroBill = (amount: number, rate: number) => ({
    currency: 'EUR', amount, amount_rsd: Math.round(amount * rate * 100) / 100, amount_eur: amount,
    exchange_rate: rate, eur_rate: rate, paid_amount: 0,
  })
  const settle = (bill: ReturnType<typeof euroBill>, payRsd: number) => {
    const s = settlementFor({ invoice: bill, paymentCurrency: 'RSD', paymentOwn: payRsd, paymentRsd: payRsd })
    const link = { currency: 'EUR', ...linkAmountsFromOwn(s.own, bill) }
    const payment = { amount: payRsd, amount_rsd: payRsd, currency: 'RSD' }
    return { s, link, payment }
  }

  it('117.200 RSD on a 1.000 EUR bill at 117,5: 997,45 EUR = 117.200,38 RSD, and it is not refused', () => {
    const { s, link, payment } = settle(euroBill(1000, 117.5), 117200)
    expect(s.own).toBe(997.45)
    expect(link.allocated_amount_rsd).toBe(117200.38)
    expect(overAllocationProblem(payment, [], linkDinars(payment, link)!, [link])).toBeNull()
    // Measured with only a dinar-para it would be refused -- the fault this closes.
    expect(overAllocationProblem(payment, [], linkDinars(payment, link)!)).not.toBeNull()
  })

  it('the slack of a link in another currency is a para of the invoice\'s currency; in the payment\'s, a para of the payment\'s', () => {
    const rsd = { amount: 117200, amount_rsd: 117200, currency: 'RSD' }
    expect(linkSlack(rsd, { currency: 'EUR', allocated_amount: 997.45, allocated_amount_rsd: 117200.38 })).toBeCloseTo(1.175, 3)
    expect(linkSlack(rsd, { currency: 'RSD', allocated_amount: 5, allocated_amount_rsd: 5 })).toBe(0.01)
    expect(linkSlack({ amount: 1000, amount_rsd: 117200, currency: 'EUR' }, { currency: 'EUR', allocated_amount: 5, allocated_amount_rsd: 587 })).toBeCloseTo(1.172, 3)
  })

  it('a sweep of 3.000 bills, rates and payments: none of settlementFor\'s outputs is refused', () => {
    let seed = 20261125
    const rnd = () => { seed = (seed * 1103515245 + 12345) % 2147483648; return seed / 2147483648 }
    let refused = 0, beyondDinarPara = 0
    for (let k = 0; k < 3000; k++) {
      const rate = Math.round((95 + rnd() * 30) * 10000) / 10000
      const bill = euroBill(Math.round((1 + rnd() * 20000) * 100) / 100, rate)
      const payRsd = Math.round(bill.amount_rsd * (0.5 + rnd() * 0.51) * 100) / 100
      const { link, payment } = settle(bill, payRsd)
      if (link.allocated_amount <= 0) continue
      const asked = linkDinars(payment, link)!
      if (asked > payRsd + 0.015) beyondDinarPara++
      if (overAllocationProblem(payment, [], asked, [link]) !== null) refused++
    }
    expect(refused).toBe(0)
    expect(beyondDinarPara).toBeGreaterThan(0)
  })

  it('more than a para of the invoice\'s currency above the payment is still refused', () => {
    const payment = { amount: 117200, amount_rsd: 117200, currency: 'RSD' }
    const link = { currency: 'EUR', allocated_amount: 997.46, allocated_amount_rsd: 117201.55 }
    expect(overAllocationProblem(payment, [], 117201.55, [link])).not.toBeNull()
  })
})
