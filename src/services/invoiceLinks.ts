// ─── invoiceLinks ───────────────────────────────────────────────────────────
//
// What a payment link has to record, in the currency each column is for.
//
// `invoice_transaction_links` has three amount columns and they mean different
// things:
//
//   allocated_amount       the part of the invoice this payment settles, in
//                          the INVOICE's own currency. `v_invoice_status`
//                          decides paid or partial on this column.
//   allocated_amount_rsd   the same part in dinars, at the invoice's stored
//                          exchange_rate
//   allocated_amount_eur   the same part in euros, at the invoice's stored
//                          eur_rate — exactly `allocated_amount` on a EUR bill
//
// An allocation is a PART of the invoice, so it is booked at the invoice's
// stored rates (`partBookAmounts` / `partFromRsd` in bookAmounts.ts), never at
// a rate fetched for the payment date. That is what makes the links of a bill
// paid in full add up to the bill in every currency.
//
// Returned as one object so a call site cannot fill one column and forget the
// others — which is the shape every past defect in this table took.
//
// An invoice without usable rates throws RateUnavailableError: a link booked
// on a guessed rate looks exactly like a correct one.

import { partBookAmounts, partFromRsd, rowRates, round2 } from './bookAmounts'

export interface InvoiceMoney {
  currency?: string | null
  /** The invoice in its own currency. */
  amount?: number | null
  /** The same invoice in dinars, as booked. */
  amount_rsd?: number | null
  /** The same invoice in euros, as booked. */
  amount_eur?: number | null
  /** RSD per 1 unit of `currency`, as stored on the invoice. */
  exchange_rate?: number | string | null
  /** RSD per 1 EUR, as stored on the invoice. */
  eur_rate?: number | string | null
}

export interface LinkAmounts {
  allocated_amount: number
  allocated_amount_rsd: number
  allocated_amount_eur: number
}

const finite = (n: number): number => (Number.isFinite(n) ? n : 0)

/**
 * The invoice's stored rates, or null when it does not carry them.
 *
 * For display code that must not throw while rendering; anything that WRITES
 * goes through `linkAmountsFromOwn` / `linkAmountsFromRsd`, which throw.
 */
export function invoiceRates(invoice: InvoiceMoney): { exchangeRate: number; eurRate: number } | null {
  try {
    return rowRates({ ...invoice, currency: invoice.currency || 'RSD' })
  } catch {
    return null
  }
}

/**
 * All three columns, from the amount settled in the invoice's own currency.
 *
 * The figure a person typed (or the payment, when it shares the bill's
 * currency) is stored as it stands; the dinars and euros are derived from it
 * at the invoice's rates.
 */
export function linkAmountsFromOwn(allocatedOwn: number, invoice: InvoiceMoney): LinkAmounts {
  const own = round2(finite(allocatedOwn))
  const b = partBookAmounts(own, { ...invoice, currency: invoice.currency || 'RSD' })
  return { allocated_amount: own, allocated_amount_rsd: b.amount_rsd, allocated_amount_eur: b.amount_eur }
}

/**
 * All three columns, from an allocation known in dinars (the book currency).
 *
 * The RSD figure is stored as given; the invoice-currency part is derived from
 * it at the invoice's rate — the same arithmetic `reconcile_direct_transaction`
 * does in the database.
 */
export function linkAmountsFromRsd(allocatedRsd: number, invoice: InvoiceMoney): LinkAmounts {
  const p = partFromRsd(finite(allocatedRsd), { ...invoice, currency: invoice.currency || 'RSD' })
  return { allocated_amount: p.amount, allocated_amount_rsd: p.amount_rsd, allocated_amount_eur: p.amount_eur }
}
