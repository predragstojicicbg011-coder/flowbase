// ─── invoiceLinks ───────────────────────────────────────────────────────────
//
// What a payment link has to record, in the currency each column is for.
//
// `invoice_transaction_links` has two amount columns and they mean different
// things: `allocated_amount` is in the invoice's own currency, and
// `allocated_amount_usd` is the same figure in dollars. The bulk import and
// the bank statement dialog have always written them that way. Two other call
// sites — the transaction dialog and the reconcile panel — allocate in dollars
// and wrote that dollar figure into BOTH columns:
//
//     allocated_amount: link.allocated_usd, allocated_amount_usd: link.allocated_usd
//
// For a dollar invoice that is correct and indistinguishable. For a dinar
// invoice it puts about a hundredth of the real figure into the own-currency
// column, and until now nothing read it: `v_invoice_status` decided paid or
// partial from the dollar column alone, so the wrong number sat there doing no
// visible harm.
//
// That changed with 20260921130000, which makes the view decide in the
// invoice's own currency — the same rule the application already applies at
// write time, and the fix for a whole class of FX drift. It also makes
// `allocated_amount` load-bearing. Left alone, a dinar invoice settled through
// either of those two dialogs would read `partial` forever, and one wrong
// status would simply have been traded for another.
//
// The rate comes from the invoice's own `amount / amount_usd` rather than from
// a rate column, so the conversion is by construction consistent with how that
// invoice was converted in the first place. A rate fetched separately can be
// right about the day and still disagree with the row.

export interface InvoiceMoney {
  currency?: string | null
  /** The invoice in its own currency. */
  amount?: number | null
  /** The same invoice in dollars, converted when it was booked. */
  amount_usd?: number | null
}

/** Two decimal places, the way both columns are stored. */
const cents = (n: number): number => Math.round(n * 100) / 100

/**
 * The invoice's own implied rate — units of its currency per dollar.
 *
 * `null` when the invoice does not carry enough to say, which is why the
 * caller below has a documented fallback rather than a division by zero.
 */
export function impliedRate(invoice: InvoiceMoney): number | null {
  const amount = invoice.amount
  const usd = invoice.amount_usd
  if (typeof amount !== 'number' || typeof usd !== 'number') return null
  if (!Number.isFinite(amount) || !Number.isFinite(usd) || usd === 0) return null
  const rate = amount / usd
  return Number.isFinite(rate) && rate > 0 ? rate : null
}

/**
 * A dollar allocation, in the invoice's own currency.
 *
 * A dollar invoice returns the figure unchanged — there is nothing to convert
 * and no rounding to introduce.
 *
 * Where the invoice carries no usable rate the dollar figure is returned as
 * it was, which is what these call sites did before this module existed. It
 * is not right for a foreign-currency invoice, but it is the only number
 * available, and inventing a rate here would be a quieter kind of wrong. In
 * practice an invoice you can pay always carries both amounts.
 */
export function allocatedInInvoiceCurrency(allocatedUsd: number, invoice: InvoiceMoney): number {
  const usd = Number.isFinite(allocatedUsd) ? allocatedUsd : 0
  if (!invoice.currency || invoice.currency === 'USD') return cents(usd)
  const rate = impliedRate(invoice)
  if (rate === null) return cents(usd)
  return cents(usd * rate)
}

/**
 * Both columns of a link, from one dollar allocation.
 *
 * Returned together so a call site cannot fill one and forget the other —
 * which is the shape the original defect took.
 */
export function linkAmounts(allocatedUsd: number, invoice: InvoiceMoney): {
  allocated_amount: number
  allocated_amount_usd: number
} {
  return {
    allocated_amount: allocatedInInvoiceCurrency(allocatedUsd, invoice),
    allocated_amount_usd: cents(Number.isFinite(allocatedUsd) ? allocatedUsd : 0),
  }
}

/**
 * Both columns, from the amount that was actually settled.
 *
 * THE DIRECTION MATTERS, and it is the opposite of `linkAmounts` above.
 *
 * `allocated_amount` is the column `v_invoice_status` decides paid or partial
 * on. Deriving it from dollars quantises it to the whole US cent, which is
 * worth about a dinar, so a bill paid in full in dinars was recorded as paid
 * to within half a dinar and sat there owing the remainder. Here the settled
 * figure is stored as it stands and the dollars are derived from it, which is
 * the direction the money moved: somebody paid dinars, and the dollar column
 * is a reporting convenience computed afterwards.
 *
 * Use this wherever the amount is known in the invoice's own currency — which
 * is everywhere a person typed it, and everywhere the payment and the bill
 * share a currency. `linkAmounts` remains for the one case that genuinely
 * starts in dollars.
 */
export function linkAmountsFromOwn(allocatedOwn: number, invoice: InvoiceMoney): {
  allocated_amount: number
  allocated_amount_usd: number
} {
  const own = cents(Number.isFinite(allocatedOwn) ? allocatedOwn : 0)
  const rate = !invoice.currency || invoice.currency === 'USD' ? null : impliedRate(invoice)
  return {
    allocated_amount: own,
    allocated_amount_usd: rate === null ? own : cents(own / rate),
  }
}
