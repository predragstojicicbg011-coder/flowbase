// ─── settlementCheck ────────────────────────────────────────────────────────
//
// Reading back what a dialog just promised, and saying so when it did not
// happen.
//
// A payment dialog makes a specific claim as you fill it in: this allocation
// settles the invoice in full, or leaves it owing so much. Everything that
// claim rests on is read when the dialog opens, and one stale figure is enough
// to make it wrong — which is not hypothetical. A remainder that excluded the
// link's own contribution left an invoice short by exactly what that link had
// held, and led to a currency difference booked in the WRONG DIRECTION: a loss
// where the truth was a gain. Every individual write succeeded. Nothing was
// refused. The dialog closed on a green tick.
//
// So the claim is checked against the database after the writes, in the
// database's own terms — the same para, in the invoice's own
// currency, that `v_invoice_status` applies.
//
// NOT TO ROLL ANYTHING BACK. By then the rows are there, and undoing them
// blindly would be its own hazard. This exists to say, before the person walks
// away, that the thing they were told would happen did not.

import { settledStatus, type SettledStatus } from './settleInvoice'

/**
 * The rule itself lives in `settleInvoice`, because it was written here and
 * in four other places, and five copies of a rule are five chances to
 * disagree. A disagreement between them is exactly what raised the warning
 * this module exists to print.
 */
export type Settlement = SettledStatus

export interface Expectation {
  invoiceId: string
  invoiceNumber?: string | null
  /** The invoice's own amount, in its own currency. */
  amount: number
  /** Everything that will be allocated to it, in the same currency. */
  allocated: number
  /**
   * The same bill in dinars (`amount_rsd`), which sizes the tolerance exactly
   * as `v_invoice_status` does.
   *
   * Optional, and where it is missing the tolerance is a para rather than
   * being guessed at.
   */
  amountRsd?: number | null
}

/** What `v_invoice_status` will say, given those two figures. */
export function expectedStatus(
  amount: number, allocated: number, amountRsd?: number | null,
): Settlement {
  return settledStatus(amount, allocated, amountRsd)
}

export interface Mismatch {
  invoiceId: string
  invoiceNumber?: string | null
  expected: Settlement
  actual: Settlement | 'missing'
}

/**
 * Every invoice that did not end up where the dialog said it would.
 *
 * An invoice the view has no row for counts as a mismatch: a promise about
 * something that cannot be read back is not a promise that was kept.
 */
export function mismatches(
  expectations: Expectation[],
  actual: Record<string, Settlement | undefined>,
): Mismatch[] {
  const out: Mismatch[] = []
  for (const e of expectations) {
    const want = expectedStatus(e.amount, e.allocated, e.amountRsd)
    const got = actual[e.invoiceId]
    if (got === undefined) {
      out.push({ invoiceId: e.invoiceId, invoiceNumber: e.invoiceNumber, expected: want, actual: 'missing' })
    } else if (got !== want) {
      out.push({ invoiceId: e.invoiceId, invoiceNumber: e.invoiceNumber, expected: want, actual: got })
    }
  }
  return out
}

/**
 * What to put in front of the person, in the words of what they were told.
 *
 * Names the invoice rather than counting, because the next thing they have to
 * do is open it.
 */
export function describeMismatches(list: Mismatch[]): string {
  if (list.length === 0) return ''
  const one = (m: Mismatch) => {
    const who = m.invoiceNumber || m.invoiceId
    return m.actual === 'missing'
      ? `${who} could not be read back at all`
      : `${who} was expected to be ${m.expected} and is ${m.actual}`
  }
  return 'Everything was written, but the result is not what this dialog said it would be: '
    + list.map(one).join('; ')
    + '. Open the invoice and check its allocations before relying on the figures.'
}
