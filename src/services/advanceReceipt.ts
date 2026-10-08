// ─── advanceReceipt: the shape of a receipt the dialogs write ──────────────
//
// Schema: supabase/migrations/20261008180000_accrual_revenue.sql.
//
// Three decisions every payment dialog (TransactionDialog,
// BankStatementDialog, BulkImport) makes the same way, kept here so they
// cannot drift apart:
//
//   1. AN ADVANCE (avans) is a direct revenue receipt on a project, with
//      is_advance true and pl_impact false (CHECK transactions_advance_shape).
//      The flag only survives while the row IS a direct revenue receipt — a
//      row switched to an expense, an invoice payment or a pass-through drops
//      it, or the database refuses the save. It is never split and never
//      linked to an invoice (a trigger refuses the link): a billing uses it
//      through invoices.advance_deducted.
//
//   2. THE DIRECTION OF AN INVOICE PAYMENT is the linked invoice's type,
//      written to tx_subtype: 'expense' — we paid a supplier; 'revenue' — an
//      investor or tenant paid us. The cash line reads it
//      (cashTimeline.cashDirection).
//
//   3. A DIRECT REVENUE RECEIPT FROM A PARTNER WITH OPEN REVENUE INVOICES is
//      most likely the payment of one of them. Booked as direct revenue it is
//      revenue a second time (the invoice already is). The dialogs say so —
//      without refusing, because interest or a refund from the same partner
//      is legitimately direct.

import { fmtMoney } from '../utils/formatters'

export const ADVANCE_LABEL = 'Avans'

/** The badge colours for an advance row, wherever a dialog lists one. */
export const ADVANCE_BADGE_STYLE = {
  background: 'rgba(155,109,255,0.14)',
  color: '#7C4DDB',
  fontSize: '10px',
  fontWeight: 600,
  padding: '1px 7px',
  borderRadius: '10px',
  whiteSpace: 'nowrap' as const,
}

export type InvoiceSide = 'expense' | 'revenue'

/**
 * The is_advance a row is saved with: the flag the user set, kept only while
 * the row is a direct revenue receipt.
 */
export function effectiveAdvance(type: string | null | undefined, subtype: string | null | undefined, flag: boolean | null | undefined): boolean {
  return !!flag && type === 'direct' && subtype === 'revenue'
}

export interface AdvanceCheck {
  type: string | null | undefined
  subtype: string | null | undefined
  isAdvance: boolean | null | undefined
  projectId: string | null | undefined
  /** Split lines the row would be saved with. */
  splitLines?: number
  /** Invoices the row would be linked to. */
  linkedInvoices?: number
}

/** Why an advance cannot be saved as it stands, in Serbian, or null. */
export function whyAdvanceNotSavable(c: AdvanceCheck): string | null {
  if (!effectiveAdvance(c.type, c.subtype, c.isAdvance)) return null
  if (!c.projectId) return 'Avans mora biti na projektu — izaberite projekat.'
  if ((c.splitLines || 0) > 0) return 'Avans se ne deli na stavke — uklonite podelu.'
  if ((c.linkedInvoices || 0) > 0) return 'Avans se ne povezuje sa fakturom — faktura ga koristi kroz „Odbijeni avans”.'
  return null
}

/**
 * The tx_subtype an invoice payment is saved with: the type of the invoices
 * it settles. When they disagree (a netting of a bill against a billing),
 * or none is known, `fallback` — the bank direction where the caller has
 * one — and otherwise null, which the cash line reads as an outflow.
 */
export function paymentSubtypeFor(
  invoiceTypes: readonly (string | null | undefined)[],
  fallback: InvoiceSide | null = null,
): InvoiceSide | null {
  const known = new Set(invoiceTypes.filter((t): t is InvoiceSide => t === 'expense' || t === 'revenue'))
  if (known.size === 1) return Array.from(known)[0]
  return fallback
}

/** A v_invoice_status row, as far as the double-count hint reads it. */
export interface OpenInvoiceRow {
  id: string
  type?: string | null
  partner_id?: string | null
  invoice_number?: string | null
  currency?: string | null
  amount?: number | string | null
  paid_amount?: number | string | null
  advance_deducted?: number | string | null
  calculated_status?: string | null
}

const n0 = (v: unknown) => {
  const n = typeof v === 'number' ? v : Number(v)
  return Number.isFinite(n) ? n : 0
}

/** The partner's revenue invoices still owed something. */
export function openRevenueInvoicesOf(partnerId: string | null | undefined, invoices: readonly OpenInvoiceRow[]): OpenInvoiceRow[] {
  if (!partnerId) return []
  return invoices.filter(i =>
    i.type === 'revenue' && i.partner_id === partnerId
    && (i.calculated_status === 'unpaid' || i.calculated_status === 'partial')
    && n0(i.amount) - n0(i.advance_deducted) - n0(i.paid_amount) > 0.005)
}

/**
 * The hint for a direct revenue receipt from a partner with open billings,
 * or null when there is nothing to say (not a direct revenue receipt, an
 * advance, or no open billing).
 */
export function doubleCountHint(
  c: { type: string | null | undefined; subtype: string | null | undefined; isAdvance?: boolean | null },
  partnerId: string | null | undefined,
  invoices: readonly OpenInvoiceRow[],
): string | null {
  if (c.type !== 'direct' || c.subtype !== 'revenue' || c.isAdvance) return null
  const open = openRevenueInvoicesOf(partnerId, invoices)
  if (open.length === 0) return null
  const shown = open.slice(0, 3).map(i => {
    const left = Math.max(0, n0(i.amount) - n0(i.advance_deducted) - n0(i.paid_amount))
    return `${i.invoice_number || '—'} (${fmtMoney(left, (i.currency || 'RSD').toUpperCase())})`
  }).join(', ')
  const more = open.length > 3 ? ` i još ${open.length - 3}` : ''
  return `Ovaj partner ima otvorene izlazne fakture (${open.length}): ${shown}${more}. `
    + 'Ako je ovo uplata po fakturi, evidentirajte je kao plaćanje fakture — kao direktan prihod bila bi prihod po drugi put.'
}

export interface ReceiptShapeInput {
  /** The row's transaction type. */
  type: string | null | undefined
  /** The subtype the row carries (a direct row's expense/revenue choice). */
  subtype: string | null | undefined
  isAdvance?: boolean | null
  /** The bank direction where the caller knows it (debit = expense). */
  bankSide?: InvoiceSide | null
  /** The linked invoice's type, for an invoice payment. */
  invoiceType?: string | null
}

export interface ReceiptShape {
  tx_subtype: string | null
  is_advance: boolean
  pl_impact: boolean
}

/**
 * The three columns that decide what a transaction row IS, from what a
 * statement or import row says. A direct row keeps its subtype and has P&L
 * unless it is an advance; an invoice payment takes its invoice's side (the
 * bank direction when that is unknown); everything else has no P&L of its
 * own here and is never an advance.
 */
export function receiptShape(r: ReceiptShapeInput): ReceiptShape {
  const is_advance = effectiveAdvance(r.type, r.subtype, r.isAdvance)
  if (r.type === 'direct') {
    return { tx_subtype: r.subtype ?? null, is_advance, pl_impact: !is_advance }
  }
  if (r.type === 'invoice_payment') {
    return { tx_subtype: paymentSubtypeFor([r.invoiceType], r.bankSide ?? null), is_advance: false, pl_impact: false }
  }
  return { tx_subtype: r.subtype ?? null, is_advance: false, pl_impact: false }
}
