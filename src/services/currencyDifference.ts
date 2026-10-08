// ─── currencyDifference ─────────────────────────────────────────────────────
//
// What is left over when a bill and its payment cannot agree.
//
// A dinar invoice indexed to the euro, or a euro invoice paid in dinars, is
// booked in dinars at the issue date's rate and settled at the payment date's. The two are never the same figure,
// so every such invoice ends with a gap that is not a part payment and not an
// error — it is the exchange moving between the two dates.
//
// Two shapes, and they are not symmetrical:
//
//   the payment is SHORT of the invoice     the euro fell; less was paid than
//                                           was booked. The remainder of the
//                                           invoice is a gain, and it has to
//                                           be linked to the invoice, because
//                                           nothing else is going to close it.
//
//   the payment is LARGER than the invoice  the euro rose. The invoice is
//                                           already closed by the payment; the
//                                           surplus is a loss and belongs to
//                                           the same bank line, split off from
//                                           it rather than added to it.
//
// So a gain is linked and a loss is not, and that asymmetry is the whole of
// the logic here.
//
// ── A REVENUE INVOICE TURNS THE ECONOMICS ROUND, NOT THE SHAPE ─────────────
//
// The above is a bill the company PAYS. On a revenue invoice (a billing to an
// investor or tenant) the company RECEIVES, and receiving less than was
// billed is a LOSS; receiving more is a GAIN. The shape is unchanged — the
// short side still has to be linked to close the invoice, the surplus still
// splits off the bank line — so `linksToInvoice` follows the shape and
// `kind` / `direction` follow the economics:
//
//                         expense bill            revenue invoice
//   invoice short         gain, linked            loss, linked
//   payment has surplus   loss, not linked        gain, not linked
//
// Callers decide "which side of the pair is this" by `linksToInvoice`, never
// by `kind`. Getting it the other way round would either leave an invoice
// open forever or allocate more to a payment than the bank actually moved.
//
// This module decides the figure and the direction. It does not know what a
// transaction looks like, which classification carries it, or which dialog is
// asking.

import { fmtMoney, fmtNum } from '../utils/formatters'

/** Under this much, in the invoice's own currency, there is nothing to book. */
export const TOLERANCE = 0.01

export type DifferenceKind = 'none' | 'gain' | 'loss' | 'allocate-first'

export interface Difference {
  kind: DifferenceKind
  /** Always positive. Zero when there is nothing to book. */
  amount: number
  /** What the entry is: a gain is revenue, a loss is an expense. */
  direction: 'revenue' | 'expense' | null
  /**
   * Whether the entry must also be linked to the invoice.
   *
   * A gain must: the invoice is short and nothing else will settle the rest.
   * A loss must not: the invoice is already closed, and the surplus is part of
   * a bank movement that has already been recorded once.
   */
  linksToInvoice: boolean
  /** Said in words, because a figure with no direction invites a guess. */
  note: string
}

const NOTHING: Difference = {
  kind: 'none', amount: 0, direction: null, linksToInvoice: false,
  note: 'The payment and the invoice agree — there is no difference to book.',
}

export interface DifferenceInput {
  /** The invoice, less everything allocated to it including this payment. */
  invoiceShortfall: number
  /** The payment, less everything it allocates. */
  paymentUnallocated: number
  /** The currency both figures are in, for the wording. */
  currency?: string
  tolerance?: number
  /**
   * The invoice's `type`. 'revenue' flips gain and loss (see the top of the
   * file). Anything else — including missing — is an expense bill, as before.
   */
  invoiceType?: string | null
}

const money = (n: number, currency?: string) =>
  currency ? fmtMoney(n, currency) : fmtNum(n)

/**
 * The difference to book, if there is one.
 *
 * Both figures positive at once is not a difference — it is an allocation that
 * has not been finished. The payment still has money to give and the invoice
 * still wants some; booking anything there would paper over an unfinished
 * edit, so it says so instead.
 */
export function differenceFor(input: DifferenceInput): Difference {
  const tol = input.tolerance ?? TOLERANCE
  const short = input.invoiceShortfall
  const spare = input.paymentUnallocated
  const cur = input.currency

  const invoiceIsShort = short > tol
  const paymentHasSpare = spare > tol

  if (invoiceIsShort && paymentHasSpare) {
    return {
      kind: 'allocate-first',
      amount: 0,
      direction: null,
      linksToInvoice: false,
      note: `This payment still has ${money(spare, cur)} unallocated and the invoice is `
        + `${money(short, cur)} short. Allocate what is left before booking a difference.`,
    }
  }

  const revenue = input.invoiceType === 'revenue'

  if (invoiceIsShort) {
    if (revenue) {
      return {
        kind: 'loss',
        amount: short,
        direction: 'expense',
        linksToInvoice: true,
        note: `Less was received than was invoiced, by ${money(short, cur)}. Booking it as a loss `
          + `closes the invoice; nothing else will.`,
      }
    }
    return {
      kind: 'gain',
      amount: short,
      direction: 'revenue',
      linksToInvoice: true,
      note: `Less was paid than was invoiced, by ${money(short, cur)}. Booking it as a gain `
        + `closes the invoice; nothing else will.`,
    }
  }

  if (paymentHasSpare) {
    if (revenue) {
      return {
        kind: 'gain',
        amount: spare,
        direction: 'revenue',
        linksToInvoice: false,
        note: `More was received than was invoiced, by ${money(spare, cur)}. The invoice is already `
          + `closed, so this splits the surplus off the same bank line as a gain.`,
      }
    }
    return {
      kind: 'loss',
      amount: spare,
      direction: 'expense',
      linksToInvoice: false,
      note: `More was paid than was invoiced, by ${money(spare, cur)}. The invoice is already `
        + `closed, so this splits the surplus off the same bank line as a loss.`,
    }
  }

  return NOTHING
}

/** Whether the dialog should offer the control at all. */
export function isBookable(d: Difference): boolean {
  return d.kind === 'gain' || d.kind === 'loss'
}

/**
 * The note that goes on the created entry, so the row explains itself a year
 * from now without anyone having to reconstruct which invoice it came from.
 */
export function entryNote(invoiceNumber: string | null | undefined, d: Difference): string {
  const which = invoiceNumber ? ` on ${invoiceNumber}` : ''
  // The shape, not the economics: short is "less than invoiced" whichever
  // side of the bill the company is on.
  const verb = d.direction === (d.linksToInvoice ? 'expense' : 'revenue') ? 'received' : 'paid'
  return d.linksToInvoice
    ? `Currency difference${which} — ${verb} less than invoiced`
    : `Currency difference${which} — ${verb} more than invoiced`
}
