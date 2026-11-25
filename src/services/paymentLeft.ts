// ─── paymentLeft ────────────────────────────────────────────────────────────
//
// What is left of a payment to allocate, and why an allocation is refused.
//
// A payment's links to invoices carry `allocated_amount` in each INVOICE's
// currency and `allocated_amount_rsd` at the invoice's stored rate. They are
// added up against the payment in DINARS, the book currency (the owner's
// ruling, 2026-11-25), each AS THE PAYMENT SEES IT:
//
//   a link to an invoice in the payment's own currency  allocated_amount at
//       the payment's own rate (amount_rsd / amount; 1 for a dinar payment).
//       Its stored dinars are at the invoice's rate, and the move between the
//       two dates is the currency difference, not an over-allocation;
//   a link to an invoice in another currency  allocated_amount_rsd — the
//       figure settlementFor and allocateAcross hold against the payment's
//       dinars when the currencies differ.
//
// For a dinar payment that is exactly the sum of allocated_amount_rsd against
// amount_rsd, so a dinar payment of a euro bill is counted too. A payroll child
// mirrors its parent's share of the same payment and is not counted twice; a
// deleted (unseen) invoice is not counted. The database holds the same rule
// (links_stay_within_their_payment, 20261125100000): this is the form's copy,
// so the person sees the figure and the reason before anything is written.

import { formatMoney } from './allocationDisplay'

/** A link of the payment as read: its allocation and the invoice it points to. */
export interface HeldLink {
  allocated_amount: number | null
  allocated_amount_rsd: number | null
  /** The invoice's currency. */
  currency: string | null
  /** The invoice is a payroll child (parent_invoice_id set): it mirrors its parent. */
  child?: boolean
  /** The invoice is deleted or hidden: the database does not count it either. */
  deleted?: boolean
}

/** The payment: its own figure and currency, and its dinars. */
export interface PaymentMoney {
  amount: number | null
  amount_rsd?: number | null
  currency: string | null
}

const cents = (n: number) => Math.round(n * 100) / 100
const cur = (c: string | null | undefined) => c || 'RSD'
const num = (v: unknown) => Number(v) || 0

/**
 * Dinars per unit of the payment's currency: 1 for a dinar payment, its own
 * amount_rsd / amount otherwise, null where it carries no dinar figure.
 */
export function paymentRate(payment: PaymentMoney): number | null {
  if (cur(payment.currency) === 'RSD') return 1
  const own = Math.abs(num(payment.amount)), rsd = Math.abs(num(payment.amount_rsd))
  return own > 0 && rsd > 0 ? rsd / own : null
}

/**
 * One allocation in dinars as the payment sees it, or null where it is not
 * counted (another currency, and the payment has no rate).
 */
export function linkDinars(
  payment: PaymentMoney,
  link: { currency: string | null; allocated_amount: number | null; allocated_amount_rsd: number | null },
): number | null {
  const rate = paymentRate(payment)
  if (cur(link.currency) === cur(payment.currency)) return num(link.allocated_amount) * (rate ?? 1)
  if (rate === null || link.allocated_amount_rsd == null) return null
  return num(link.allocated_amount_rsd)
}

const countedLinks = (payment: PaymentMoney, links: HeldLink[]) =>
  links.filter(l => !l.child && !l.deleted).map(l => linkDinars(payment, l)).filter((v): v is number => v !== null)

/** The payment in dinars (in its own currency when it has no rate). */
export function paymentDinars(payment: PaymentMoney): number {
  return cents(Math.abs(num(payment.amount)) * (paymentRate(payment) ?? 1))
}

/** What the links already hold of the payment, in dinars as it sees them. */
export function heldDinars(payment: PaymentMoney, links: HeldLink[]): number {
  return cents(countedLinks(payment, links).reduce((s, v) => s + v, 0))
}

/** A link as the slack sees it: its currency and its two figures. */
export interface SlackLink { currency: string | null; allocated_amount: number | null; allocated_amount_rsd: number | null }

/**
 * The rounding one counted link may carry, in dinars, or null where it is not
 * counted. A para of the PAYMENT's currency for a link in the payment's
 * currency (settlementFor finishes a bill within CLOSED_WITHIN); a para of the
 * INVOICE's currency, at the link's own rate, for a link in another currency:
 * a part payment there is written as own = round2(dinars / rate) and its
 * dinars as round2(own × rate), up to half a para of the invoice's currency
 * above what was paid (a 117.200 RSD payment of a 1.000 EUR bill at 117,5:
 * 997,45 EUR = 117.200,38 RSD). The database allows the same.
 */
export function linkSlack(payment: PaymentMoney, link: SlackLink): number | null {
  const rate = paymentRate(payment)
  if (cur(link.currency) === cur(payment.currency)) return Math.max(0.01, 0.01 * (rate ?? 1))
  if (rate === null || link.allocated_amount_rsd == null) return null
  const own = Math.abs(num(link.allocated_amount))
  return Math.max(0.01, 0.01 * (own > 0 ? Math.abs(num(link.allocated_amount_rsd)) / own : 0))
}

const slackOf = (payment: PaymentMoney, links: SlackLink[]) =>
  links.map(l => linkSlack(payment, l)).filter((v): v is number => v !== null).reduce((s, v) => s + v, 0)

/** A para of the payment's own currency, in dinars. */
const paymentPara = (payment: PaymentMoney) => Math.max(0.01, 0.01 * (paymentRate(payment) ?? 1))

/** What is left of the payment, never below zero: in dinars, and in its own currency. */
export function paymentLeft(payment: PaymentMoney, links: HeldLink[]): { rsd: number; own: number } {
  const rate = paymentRate(payment) ?? 1
  const rsd = Math.max(0, cents(paymentDinars(payment) - heldDinars(payment, links)))
  return { rsd, own: cents(rsd / rate) }
}

/** A figure in the payment's own currency, from dinars. */
const ownOf = (payment: PaymentMoney, rsd: number) => cents(rsd / (paymentRate(payment) ?? 1))

/**
 * Why allocating `askedRsd` more of this payment (dinars as it sees them, see
 * linkDinars) would take it beyond what it paid, or null. `links` are the ones
 * it already has; `asked` the links the figure is made of, for their rounding
 * (without them, a para of the payment's currency).
 */
export function overAllocationProblem(
  payment: PaymentMoney & { label?: string | null },
  links: HeldLink[],
  askedRsd: number,
  asked: SlackLink[] = [],
): string | null {
  const paid = paymentDinars(payment)
  const held = heldDinars(payment, links)
  const room = slackOf(payment, links.filter(l => !l.child && !l.deleted))
    + (asked.length > 0 ? slackOf(payment, asked) : paymentPara(payment)) + 0.005
  if (cents(held + askedRsd) <= paid + room) return null
  const c = cur(payment.currency)
  const name = payment.label ? `Plaćanje ${payment.label}` : 'Plaćanje'
  return `${name} iznosi ${formatMoney(ownOf(payment, paid), c)} i već plaća ${formatMoney(ownOf(payment, held), c)}: od njega je ostalo ${formatMoney(ownOf(payment, Math.max(0, cents(paid - held))), c)}, a traži se ${formatMoney(ownOf(payment, askedRsd), c)}. Plaćanje se ne raspoređuje preko onoga što je plaćeno.`
}

/** A link row as read with its invoice embedded, turned into what this module counts. */
export function asHeldLink(l: {
  allocated_amount?: number | null; allocated_amount_rsd?: number | null
  invoices?: { currency?: string | null; parent_invoice_id?: string | null } | null
}): HeldLink {
  return {
    allocated_amount: l.allocated_amount ?? 0,
    allocated_amount_rsd: l.allocated_amount_rsd ?? null,
    currency: l.invoices?.currency ?? null,
    child: !!l.invoices?.parent_invoice_id,
    // Hidden by RLS once deleted: an invoice the embed cannot see is not counted, as the database does not count it.
    deleted: !l.invoices,
  }
}

/**
 * The links a payment already has, read now. `exceptInvoiceId` leaves out the
 * link of a bill the caller is about to rewrite (an edited invoice re-linking
 * its own payment).
 */
export async function readHeldLinks(
  client: any, transactionId: string, exceptInvoiceId?: string | null,
): Promise<{ held: HeldLink[] }> {
  const { data } = await client
    .from('invoice_transaction_links')
    .select('invoice_id, allocated_amount, allocated_amount_rsd, invoices(currency, parent_invoice_id)')
    .eq('transaction_id', transactionId)
  const rows = ((data || []) as any[]).filter(r => !exceptInvoiceId || r.invoice_id !== exceptInvoiceId)
  return { held: rows.map(asHeldLink) }
}

/** An allocation as a save holds it: a payroll child (`child`) or an invoice
 *  the reader cannot see (`unseen`, i.e. deleted) is not counted. */
export interface SavedAllocation {
  /** In the invoice's currency. */
  allocated: number
  /** In dinars at the invoice's rate. */
  allocated_rsd: number | null
  currency: string | null
  child?: boolean
  unseen?: boolean
}

/**
 * Why the allocations a payment is being saved with come to more than the
 * payment itself, or null — asked of the whole set the save will leave (the
 * transaction dialog writes every link of its payment), before anything is
 * written. Counted as the database counts. With `before` (the links the
 * payment had when the dialog opened) only a save that RAISES the total is
 * refused, as the database refuses only a raise: a payment already over can be
 * re-saved unchanged, or lowered.
 */
export function allocationsExceedPayment(
  payment: PaymentMoney,
  allocations: SavedAllocation[],
  before?: SavedAllocation[],
): string | null {
  const asLinks = (list: SavedAllocation[]): HeldLink[] => list
    .filter(a => num(a.allocated) > 0)
    .map(a => ({ allocated_amount: a.allocated, allocated_amount_rsd: a.allocated_rsd, currency: a.currency, child: a.child, deleted: a.unseen }))
  const paid = paymentDinars(payment)
  const mine = asLinks(allocations)
  const asked = heldDinars(payment, mine)
  if (asked <= paid + Math.max(slackOf(payment, mine.filter(l => !l.child && !l.deleted)), paymentPara(payment)) + 0.005) return null
  if (before && asked <= heldDinars(payment, asLinks(before)) + 0.005) return null
  const c = cur(payment.currency)
  return `Fakture na ovom plaćanju su raspoređene ${formatMoney(ownOf(payment, asked), c)}, više od samog plaćanja (${formatMoney(ownOf(payment, paid), c)}). Ništa nije sačuvano. Smanjite raspodelu: plaćanje se ne raspoređuje preko onoga što je plaćeno.`
}
