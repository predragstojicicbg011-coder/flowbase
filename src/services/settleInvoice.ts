// ─── settleInvoice ──────────────────────────────────────────────────────────
//
// How much of a bill a payment settles, in the currency the bill was written
// in.
//
// THE UNIT OF SETTLEMENT IS THE INVOICE'S OWN CURRENCY. It is the unit the
// bill is written in, the unit the bank statement is written in, the unit the
// person types, and — since 20260921130000 — the unit `v_invoice_status`
// decides paid or partial in. It was the only thing in the chain that was not
// doing the arithmetic.
//
// What the settlement paths once did was round-trip the figure through the
// reporting currency — own ──► book (rounded) ──► own (rounded again) — and
// write the far end into `allocated_amount`, the column the settled/partial
// rule reads. Two faults rode on it: the rounding left bills a para or two
// short for ever, and a same-currency payment converted at the PAYMENT date's
// rate but capped at the INVOICE date's rate left a large bill short by the
// rate move between the two days. Dinars paying a dinar bill involve no rate
// at all.
//
// So: when the payment and the bill are in the same currency, NOTHING IS
// CONVERTED. The allocation is the payment, capped at what the bill is owed,
// and the dinar and euro columns are derived from it afterwards at the
// invoice's stored rates. When they genuinely differ, the comparison happens
// once, in dinars (the book currency), and a payment that covers the whole
// remainder settles the remainder EXACTLY rather than settling a round trip
// of it.
//
// Every book figure of an allocation is the invoice's own part at the
// invoice's STORED exchange_rate and eur_rate (`partBookAmounts`), so the
// links of a bill paid in full add up to the bill in every currency. What the
// payment is worth at its own date's rate, against that, is the currency
// difference — see currencyDifference.ts.

import { type InvoiceMoney } from './invoiceLinks'
import { partBookAmounts, partFromRsd, round2 } from './bookAmounts'

/**
 * The floor of the rule: under this much left, in any currency, a bill is
 * settled.
 */
export const CLOSED_WITHIN = 0.01

/** How much a bill may be left short and still count as paid, in dinars. */
export const PAID_WITHIN_RSD = 1

/**
 * The tolerance for one bill, in its own currency — the same expression
 * `v_invoice_status` uses: one dinar at the invoice's own booked rate,
 * `1 * amount / amount_rsd`, never less than 0.01 of the invoice's currency.
 *
 * A dinar bill may be 1.00 RSD short, a euro bill 0.01 EUR. It is written
 * out so the application and the view cannot disagree about any bill.
 */
export function toleranceFor(amount: number, amountRsd?: number | null): number {
  if (!(amount > 0) || !(typeof amountRsd === 'number') || !(amountRsd > 0)) {
    return CLOSED_WITHIN
  }
  return Math.max(CLOSED_WITHIN, round2((PAID_WITHIN_RSD * amount) / amountRsd))
}

export type SettledStatus = 'paid' | 'partial' | 'unpaid'

const positive = (n: unknown): number => {
  const v = typeof n === 'string' ? Number(n) : n
  return typeof v === 'number' && Number.isFinite(v) && v > 0 ? v : 0
}

/**
 * What the ledger says about a bill, given everything allocated against it.
 *
 * THE ONE PLACE THIS RULE IS WRITTEN. It was written in five — the view,
 * `settlementCheck`, `statementEdit`, and twice inside BulkImport — and five
 * copies of a rule are five chances to disagree. A disagreement between them
 * is not academic: it is precisely what raised "everything was written, but
 * the result is not what this dialog said it would be".
 *
 * `amount` and `allocated` are both in the invoice's own currency. Nothing
 * here converts anything; see the note at the top of this file for why.
 *
 * `advanceDeducted` (a revenue billing's `advance_deducted`, same currency)
 * counts as settled, exactly as v_invoice_status counts it since
 * 20261008180000: within tolerance of `amount` is paid, even with no money
 * received; short of it with no money received is unpaid, not partial.
 *
 * ONE PARA, NOT A TENTH OF A PERCENT. The old rule scaled the slack with the
 * bill, which is the wrong shape for money twice over:
 *
 *   a tenth of a percent of 12,500,000 dinars is 12,500 dinars, so a bill
 *   short by a month of somebody's salary read `paid`
 *
 *   a tenth of a percent of 220 dinars is 22 para, which is tighter than the
 *   rounding the old settlement arithmetic could itself produce
 *
 * An absolute para works at both ends, and it is what the writes now land on.
 */
export function settledStatus(
  amount: number, allocated: number, amountRsd?: number | null, advanceDeducted = 0,
): SettledStatus {
  const advance = positive(advanceDeducted)
  const paid = positive(allocated)
  if (!(paid + advance > 0)) return 'unpaid'
  // Rounded to the para BEFORE the comparison. `220.49 - 0.01` is
  // 220.48000000000002 in binary floating point, so a bill settled to the
  // para read `partial` — a tolerance that cannot survive its own subtraction
  // is worse than none.
  const short = round2((amount || 0) - (paid + advance))
  if (short <= toleranceFor(amount, amountRsd)) return 'paid'
  // An advance deducted on a billing is not money from the investor: until
  // something is paid against what is left, the billing is unpaid.
  return paid > 0 ? 'partial' : 'unpaid'
}

export interface InvoiceSettlement extends InvoiceMoney {
  /**
   * What the bill already holds, in its own currency — the view's
   * `paid_amount`, which is `sum(allocated_amount)`.
   *
   * The same column the settled/partial rule is decided on. Deriving the
   * remainder from `remaining_rsd` instead is how a dialog comes to show an
   * outstanding figure that disagrees with the rule it is judged against.
   */
  paid_amount?: number | null
  /**
   * The part of a revenue billing covered by the project's advance, in the
   * bill's own currency (`invoices.advance_deducted`). Settled as surely as
   * a payment: the investor owes `amount − advance_deducted`.
   */
  advance_deducted?: number | string | null
}

/** What the bill is still owed, in the currency it was written in. */
export function outstandingOwn(invoice: InvoiceSettlement): number {
  const amount = positive(invoice.amount)
  const paid = positive(invoice.paid_amount)
  const advance = positive(invoice.advance_deducted)
  return round2(Math.max(0, amount - advance - paid))
}

/**
 * Is the payment in the currency the bill is written in?
 *
 * A missing currency on either side means dinars, the book currency and what
 * the columns default to.
 */
export function paysInInvoiceCurrency(
  paymentCurrency: string | null | undefined,
  invoice: InvoiceMoney,
): boolean {
  return (paymentCurrency || 'RSD') === (invoice.currency || 'RSD')
}

export interface SettlementRequest {
  /** The bill, carrying what it already holds and its stored rates. */
  invoice: InvoiceSettlement
  /** The currency the payment is in. */
  paymentCurrency?: string | null
  /** What is left of the payment, in the payment's own currency. */
  paymentOwn: number
  /**
   * The same, in dinars at the PAYMENT's rate.
   *
   * Used ONLY where the two currencies genuinely differ, to compare the
   * payment with the bill in the one currency they both have.
   */
  paymentRsd: number
}

export interface Settlement {
  /** `allocated_amount` — in the INVOICE's currency. */
  own: number
  /** `allocated_amount_rsd` — `own` at the invoice's exchange_rate. */
  rsd: number
  /** `allocated_amount_eur` — at the invoice's eur_rate; `own` on a EUR bill. */
  eur: number
  /** What the bill still wants afterwards, in its own currency. */
  leftOnInvoice: number
  /** What is left of the payment, in the payment's currency. */
  leftOnPayment: number
  /** True when no rate was involved: a dinar paid a dinar bill. */
  direct: boolean
}

/**
 * What one payment puts against one bill.
 *
 * `own` is the figure to write, and it is never a round trip: for a
 * same-currency payment it is the payment itself, and for a payment that
 * covers the whole remainder it is the remainder itself. Both are exact by
 * construction, which is the property the settled/partial rule needs.
 *
 * Throws RateUnavailableError when the invoice carries no stored rates — the
 * book columns of the link cannot be written without them.
 */
export function settlementFor(req: SettlementRequest): Settlement {
  const { invoice } = req
  const parent = { ...invoice, currency: invoice.currency || 'RSD' }
  const outstanding = outstandingOwn(invoice)
  const payOwn = round2(positive(req.paymentOwn))
  const direct = paysInInvoiceCurrency(req.paymentCurrency, invoice)

  const booked = (own: number) => {
    const b = partBookAmounts(own, parent)
    return { rsd: b.amount_rsd, eur: b.amount_eur }
  }

  if (outstanding <= 0 || payOwn <= 0) {
    return { own: 0, rsd: 0, eur: 0, leftOnInvoice: outstanding, leftOnPayment: payOwn, direct }
  }

  if (direct) {
    // Nothing to convert. The payment pays the bill, up to what it is owed,
    // and anything within a para of finishing it finishes it — a remainder
    // smaller than the smallest unit of the currency is not a debt.
    const own = payOwn >= outstanding - CLOSED_WITHIN ? outstanding : payOwn
    return {
      own,
      ...booked(own),
      leftOnInvoice: round2(outstanding - own),
      leftOnPayment: round2(payOwn - own),
      direct: true,
    }
  }

  // Genuinely two currencies. The comparison happens in dinars, but the
  // ANSWER is still written in the invoice's currency.
  const payRsd = round2(positive(req.paymentRsd))
  const outstandingRsd = booked(outstanding).rsd

  if (payRsd >= outstandingRsd - CLOSED_WITHIN) {
    // It covers the remainder, so the allocation IS the remainder.
    return {
      own: outstanding,
      ...booked(outstanding),
      leftOnInvoice: 0,
      leftOnPayment: round2(payOwn * (payRsd > 0 ? 1 - outstandingRsd / payRsd : 0)),
      direct: false,
    }
  }

  const own = Math.min(outstanding, partFromRsd(payRsd, parent).amount)
  return {
    own,
    ...booked(own),
    leftOnInvoice: round2(outstanding - own),
    leftOnPayment: 0,
    direct: false,
  }
}
