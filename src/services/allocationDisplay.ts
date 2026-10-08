// ─── allocationDisplay ──────────────────────────────────────────────────────
//
// Allocating a payment in the currency the bill was written in.
//
// A person types an allocation in the bill's own currency — that is what the
// bill, the bank statement and the payment order show. The book figures
// (`allocated_amount_rsd`, `allocated_amount_eur`) are derived from it at the
// moment of writing, by `invoiceLinks`.
//
// WHICH WAY ROUND MATTERS. Holding dinars and displaying the conversion makes
// the field move under the user: type 600 EUR, store 70,500 RSD, redisplay
// 600.00x. So the typed figure is the one that is held. A number a person
// entered is never shown back to them altered.
//
// Conversions here use the invoice's STORED rates, the same source
// `invoiceLinks` uses, so the display agrees with how that row was booked.
// They never throw: a row without rates is shown in its own figures and the
// save path, which does throw, says why it cannot be written.

import { invoiceRates, type InvoiceMoney } from './invoiceLinks'
import { BOOK_CURRENCY, round2 } from './bookAmounts'
import { fmtMoney } from '../utils/formatters'

/** Is this invoice denominated in something other than the book currency (RSD)? */
export function hasOwnCurrency(invoice: InvoiceMoney): boolean {
  return !!invoice.currency && invoice.currency !== BOOK_CURRENCY && invoiceRates(invoice) !== null
}

/**
 * The currency an allocation against this invoice is typed in: the bill's
 * own, always — `allocated_amount` is in it whether or not the invoice
 * carries the rates to convert it. Dinars when the invoice names none.
 */
export function allocationCurrency(invoice: InvoiceMoney): string {
  return invoice.currency || BOOK_CURRENCY
}

/** A dinar figure, in the currency the bill was written in (invoice rate). */
export function toOwn(amountRsd: number, invoice: InvoiceMoney): number {
  if (!Number.isFinite(amountRsd)) return 0
  const r = hasOwnCurrency(invoice) ? invoiceRates(invoice) : null
  return round2(r === null ? amountRsd : amountRsd / r.exchangeRate)
}

/** An own-currency figure in dinars, at the invoice's rate. */
export function toRsd(own: number, invoice: InvoiceMoney): number {
  if (!Number.isFinite(own)) return 0
  const r = hasOwnCurrency(invoice) ? invoiceRates(invoice) : null
  return round2(r === null ? own : own * r.exchangeRate)
}

/**
 * An own-currency figure in euros, at the invoice's rates — exactly `own` on
 * a EUR bill. Null when the invoice carries no eur_rate.
 */
export function toEur(own: number, invoice: InvoiceMoney): number | null {
  if (!Number.isFinite(own)) return 0
  if (invoice.currency === 'EUR') return round2(own)
  const r = invoiceRates(invoice)
  if (r === null) return null
  return round2(round2(own * r.exchangeRate) / r.eurRate)
}

/**
 * @deprecated The book currency is RSD now; this returns DINARS. Kept as an
 * alias of `toRsd` so src/pages/Reports.tsx keeps compiling — use `toRsd`.
 */
export const toUsd = toRsd

/**
 * The currency the running totals can honestly be shown in.
 *
 * Only when the payment and every invoice it closes agree. A payment in
 * dinars against one dinar invoice and one euro invoice has no single
 * currency its total means anything in other than the book's. `null` means
 * fall back to RSD (the book) and say so.
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
 * A figure with its currency, the way this dialog writes money — Serbian
 * notation with the code trailing, because the bill and the bank statement it
 * is checked against are written that way. Nonsense prints as zero.
 */
export function formatMoney(amount: number, currency: string): string {
  return fmtMoney(Number.isFinite(amount) ? amount : 0, currency)
}

/**
 * What a row should start with when the dialog opens.
 *
 * A stored link carries `allocated_amount` in the invoice's own currency, so
 * that is the seed when it is there; a dinar figure is converted once, before
 * anyone has typed anything to be altered.
 */
export function seedOwn(
  link: { allocated_amount?: number | null; allocated_amount_rsd?: number | null } | number,
  invoice: InvoiceMoney,
): number {
  if (typeof link === 'number') return toOwn(link, invoice)
  if (typeof link.allocated_amount === 'number' && Number.isFinite(link.allocated_amount)) {
    return round2(link.allocated_amount)
  }
  return toOwn(Number(link.allocated_amount_rsd) || 0, invoice)
}
