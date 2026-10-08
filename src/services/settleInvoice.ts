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
// What the four settlement paths used to do, every one of them, was:
//
//     own ──► dollars (rounded to the cent) ──► own (rounded again)
//
// and write the far end of that into `allocated_amount`, which is the column
// the settled/partial rule reads. Two separate faults rode on it.
//
// ONE. A US cent is worth about a dinar. Quantising the dinar figure to a
// whole cent moved it by up to half a dinar per link, in whichever direction
// the rounding fell. Two part payments and a bill that had been paid in full
// sat there owing sixty para — the "par para i dinara" that started this.
//
// TWO, and much worse at size. A dinar payment against a dinar bill was
// converted to dollars at the PAYMENT date's rate and capped against the
// bill's dollars at the INVOICE date's rate:
//
//     allocUsd = Math.min(rowUsd, remainingUsd)
//
// Those two rates are not the same number. Half a percent between the invoice
// date and the payment date left a 12,500,000 dinar bill short by 62,000
// dinars, and the shortfall then presented itself as an unpaid remainder or
// as a currency difference to book. It is neither. Dinars paid a dinar bill
// in full. There is no exposure, nothing was gained or lost on a rate, and
// there is no reason for a rate to appear in the arithmetic at all.
//
// So: when the payment and the bill are in the same currency, NOTHING IS
// CONVERTED. The allocation is the payment, capped at what the bill is owed,
// and the dollar column is derived from it afterwards for reporting. When
// they genuinely differ, the conversion happens once, and a payment that
// covers the whole remainder settles the remainder EXACTLY rather than
// settling a round trip of it.
//
// The rate, where one is needed, comes from the invoice's own
// `amount / amount_usd` — the same source `invoiceLinks` uses — so the
// conversion agrees with how that row was booked rather than with a rate
// fetched separately and rounded differently.

import { impliedRate, type InvoiceMoney } from './invoiceLinks'

/**
 * Under this much left, a bill is settled.
 *
 * One para. One cent. An absolute figure, because money rounds to a fixed
 * place and not to a proportion of itself: `v_invoice_status` still allows a
 * tenth of a percent, which is 0.22 dinars on a 220 dinar bill and 12,500 on
 * one of twelve and a half million. The first is too tight to absorb a
 * rounding artefact and the second is loose enough to call a materially short
 * invoice paid. Nothing written through this module needs either, because
 * what it writes lands exactly.
 */
export const CLOSED_WITHIN = 0.01

/**
 * The tolerance for one bill, in its own currency.
 *
 * One para was right about the SHAPE — absolute, not a proportion — and wrong
 * about the size for the currency most of this ledger is in. A para is a
 * hundredth of a dinar, and nothing in this business settles to a hundredth
 * of a dinar: the differences that actually arrive are a bank rounding to the
 * dinar, or a transfer sent as a round number.
 *
 * So the floor is a US cent, converted at THE INVOICE'S OWN RATE — `amount /
 * amount_usd`, the rate it was booked at rather than one looked up separately
 * and right about a different day. About 1.02 on a dinar bill, 0.0092 on a
 * euro one: a dinar either way.
 *
 * `GREATEST`, never less than the para it already allowed. Tightening this
 * would reopen invoices somebody has already treated as closed, which is not
 * a thing to do as a side effect of loosening a tolerance.
 */
export function toleranceFor(amount: number, amountUsd?: number | null): number {
  if (!(amount > 0) || !(typeof amountUsd === 'number') || !(amountUsd > 0)) {
    return CLOSED_WITHIN
  }
  const perUsd = amount / amountUsd
  return Math.max(CLOSED_WITHIN, Math.round(CLOSED_WITHIN * perUsd * 100) / 100)
}

export type SettledStatus = 'paid' | 'partial' | 'unpaid'

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
  amount: number, allocated: number, amountUsd?: number | null,
): SettledStatus {
  if (!(allocated > 0)) return 'unpaid'
  // Rounded to the para BEFORE the comparison. `220.49 - 0.01` is
  // 220.48000000000002 in binary floating point, so a bill settled to the
  // para read `partial` — a tolerance that cannot survive its own subtraction
  // is worse than none.
  const short = Math.round(((amount || 0) - allocated) * 100) / 100
  return short <= toleranceFor(amount, amountUsd) ? 'paid' : 'partial'
}

/** Two decimal places, the way both amount columns are stored. */
const cents = (n: number): number => Math.round(n * 100) / 100
const positive = (n: unknown): number =>
  typeof n === 'number' && Number.isFinite(n) && n > 0 ? n : 0

export interface InvoiceSettlement extends InvoiceMoney {
  /**
   * What the bill already holds, in its own currency — the view's
   * `paid_amount`, which is `sum(allocated_amount)`.
   *
   * The same column the settled/partial rule is decided on. Deriving the
   * remainder from `remaining_usd` instead is how the dialog came to show an
   * outstanding figure that disagreed with the rule it was judged against.
   */
  paid_amount?: number | null
}

/** What the bill is still owed, in the currency it was written in. */
export function outstandingOwn(invoice: InvoiceSettlement): number {
  const amount = positive(invoice.amount)
  const paid = positive(invoice.paid_amount)
  return cents(Math.max(0, amount - paid))
}

/**
 * Is the payment in the currency the bill is written in?
 *
 * A missing currency on either side means dollars, which is what every other
 * module in this chain assumes and what the columns default to.
 */
export function paysInInvoiceCurrency(
  paymentCurrency: string | null | undefined,
  invoice: InvoiceMoney,
): boolean {
  return (paymentCurrency || 'USD') === (invoice.currency || 'USD')
}

export interface SettlementRequest {
  /** The bill, carrying what it already holds. */
  invoice: InvoiceSettlement
  /** The currency the payment is in. */
  paymentCurrency?: string | null
  /** What is left of the payment, in the payment's own currency. */
  paymentOwn: number
  /**
   * The same, in dollars.
   *
   * Used ONLY where the two currencies genuinely differ. Passing a figure
   * converted at the payment date's rate is fine and expected — it is the
   * comparison against the invoice's own rate that used to do the damage, and
   * that comparison no longer happens for a same-currency payment.
   */
  paymentUsd: number
}

export interface Settlement {
  /** `allocated_amount` — in the INVOICE's currency. */
  own: number
  /** `allocated_amount_usd` — derived from it, for reporting. */
  usd: number
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
 * construction, which is the property the settled/partial rule needs and
 * never had.
 */
export function settlementFor(req: SettlementRequest): Settlement {
  const { invoice } = req
  const outstanding = outstandingOwn(invoice)
  const payOwn = cents(positive(req.paymentOwn))
  const direct = paysInInvoiceCurrency(req.paymentCurrency, invoice)
  const rate = impliedRate(invoice)

  /** The dollar side, derived from the figure that was actually settled. */
  const usdFor = (own: number): number =>
    cents(direct && rate === null ? own : rate === null ? own : own / rate)

  if (outstanding <= 0 || payOwn <= 0) {
    return { own: 0, usd: 0, leftOnInvoice: outstanding, leftOnPayment: payOwn, direct }
  }

  if (direct) {
    // Nothing to convert. The payment pays the bill, up to what it is owed,
    // and anything within a para of finishing it finishes it — a remainder
    // smaller than the smallest unit of the currency is not a debt.
    const own = payOwn >= outstanding - CLOSED_WITHIN ? outstanding : payOwn
    return {
      own,
      usd: usdFor(own),
      leftOnInvoice: cents(outstanding - own),
      leftOnPayment: cents(payOwn - own),
      direct: true,
    }
  }

  // Genuinely two currencies. The comparison has to happen in the one they
  // both have, but the ANSWER is still written in the invoice's.
  const payUsd = cents(positive(req.paymentUsd))
  const outstandingUsd = rate === null ? outstanding : cents(outstanding / rate)

  if (payUsd >= outstandingUsd - CLOSED_WITHIN) {
    // It covers the remainder, so the allocation IS the remainder. Converting
    // it to dollars and back would move it by the value of half a cent and
    // leave the bill owing the difference for ever.
    return {
      own: outstanding,
      usd: outstandingUsd,
      leftOnInvoice: 0,
      leftOnPayment: cents(payOwn * (payUsd > 0 ? 1 - outstandingUsd / payUsd : 0)),
      direct: false,
    }
  }

  const own = Math.min(outstanding, cents(rate === null ? payUsd : payUsd * rate))
  return {
    own,
    usd: payUsd,
    leftOnInvoice: cents(outstanding - own),
    leftOnPayment: 0,
    direct: false,
  }
}
