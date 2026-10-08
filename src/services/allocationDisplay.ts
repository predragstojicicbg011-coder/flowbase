// ─── allocationDisplay ──────────────────────────────────────────────────────
//
// Allocating a payment in the currency the bill was written in.
//
// The transaction dialog asked for allocations in dollars against invoices
// denominated in dinars. Checking a figure then meant dividing by a rate in
// your head — 12,000 RSD is $117.23 at 102.36 — which is not a check anybody
// performs reliably, and an allocation that is wrong by a factor is exactly
// the kind of error this codebase has spent a week repairing.
//
// The stored contract does not change. `invoice_transaction_links` keeps both
// columns and `linkAmounts` still decides what goes in them. This is about
// which number a person types and reads.
//
// WHICH WAY ROUND MATTERS. Holding dollars and displaying the conversion
// makes the field move under the user: type 12,000, store 117.23, redisplay
// 12,000.06. So the typed figure is the one that is held, and the dollars are
// derived from it at the moment of writing. A number a person entered is
// never shown back to them altered.
//
// The rate comes from the invoice's own `amount / amount_usd`, the same source
// `invoiceLinks` uses, so the conversion agrees with how that row was booked
// rather than with a rate fetched separately and rounded differently.

import { impliedRate, type InvoiceMoney } from './invoiceLinks'

const cents = (n: number): number => Math.round(n * 100) / 100

/** Is this invoice denominated in something other than dollars? */
export function hasOwnCurrency(invoice: InvoiceMoney): boolean {
  return !!invoice.currency && invoice.currency !== 'USD' && impliedRate(invoice) !== null
}

/** The currency an allocation against this invoice should be typed in. */
export function allocationCurrency(invoice: InvoiceMoney): string {
  return hasOwnCurrency(invoice) ? (invoice.currency as string) : 'USD'
}

/** A dollar allocation, in the currency the bill was written in. */
export function toOwn(usd: number, invoice: InvoiceMoney): number {
  if (!Number.isFinite(usd)) return 0
  const rate = hasOwnCurrency(invoice) ? impliedRate(invoice) : null
  return cents(rate === null ? usd : usd * rate)
}

/** The same figure back in dollars, which is what the link's USD column holds. */
export function toUsd(own: number, invoice: InvoiceMoney): number {
  if (!Number.isFinite(own)) return 0
  const rate = hasOwnCurrency(invoice) ? impliedRate(invoice) : null
  return cents(rate === null || rate === 0 ? own : own / rate)
}

/**
 * The currency the running totals can honestly be shown in.
 *
 * Only when the payment and every invoice it closes agree. A payment in
 * dinars against one dinar invoice and one euro invoice has no single
 * currency its total means anything in, and inventing one by converting would
 * put a figure on screen that is nobody's actual money. `null` means fall
 * back to dollars and say so.
 */
export function commonCurrency(
  transactionCurrency: string | null | undefined,
  invoices: InvoiceMoney[],
): string | null {
  const tx = transactionCurrency || ''
  if (!tx) return null
  if (invoices.length === 0) return tx
  return invoices.every(i => (i.currency || '') === tx) ? tx : null
}

/**
 * A figure with its currency, the way this dialog writes money.
 *
 * Dollars lead with the sign because that is the convention everywhere else
 * on this screen; everything else trails its code, because "12.000,00 RSD" is
 * how a Serbian statement reads and this is meant to be checked against one.
 */
export function formatMoney(amount: number, currency: string): string {
  const n = Number.isFinite(amount) ? amount : 0
  if (currency === 'USD') {
    return (n < 0 ? '-$' : '$') + Math.abs(n).toLocaleString('en-US',
      { minimumFractionDigits: 2, maximumFractionDigits: 2 })
  }
  // Serbian notation, because the bill, the bank statement and the payment
  // order this is checked against are all written that way. It used to print
  // `300,000.00 RSD`, which is the dollar convention wearing a dinar's code.
  return n.toLocaleString('sr-RS', { minimumFractionDigits: 2, maximumFractionDigits: 2 })
    + ' ' + currency
}

/**
 * What a row should start with when the dialog opens.
 *
 * An existing link stores dollars, so the field it is typed into has to be
 * seeded with the conversion — this is the one place the round trip happens,
 * and it happens once, before anyone has typed anything to be altered.
 */
export function seedOwn(allocatedUsd: number, invoice: InvoiceMoney): number {
  return toOwn(allocatedUsd, invoice)
}
