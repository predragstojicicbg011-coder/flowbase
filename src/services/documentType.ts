// ─── documentType ───────────────────────────────────────────────────────────
//
// A bill, a credit note (knjižno odobrenje) or a debit note (knjižno
// zaduženje). A credit note reduces one bill and is negative; a debit note
// adds to one bill and is positive. The database holds the same rules
// (20261020100000_credit_and_debit_notes.sql, invoices_adjustment_rules);
// these are the form's copy of them, so the person reads the reason before
// saving instead of a refusal after.

import { fmtNum } from '../utils/formatters'

export type DocumentType = 'invoice' | 'credit_note' | 'debit_note' | 'proforma' | 'advance_invoice'

export const DOCUMENT_TYPES: DocumentType[] = ['invoice', 'credit_note', 'debit_note', 'proforma', 'advance_invoice']

export const DOCUMENT_TYPE_LABEL: Record<DocumentType, string> = {
  invoice: 'Račun',
  credit_note: 'Knjižno odobrenje',
  debit_note: 'Knjižno zaduženje',
  proforma: 'Predračun',
  advance_invoice: 'Avansni račun',
}

/** Paid through the unpaid list, Halcom and the bank: a bill and a proforma.
 *  A note is settled through its bill, an advance invoice never is. */
export function isPayable(t: DocumentType): boolean {
  return t === 'invoice' || t === 'proforma'
}

/** Never in the P&L: a proforma and an advance invoice (20261021090000). */
export function hasNoPl(t: DocumentType): boolean {
  return t === 'proforma' || t === 'advance_invoice'
}

/** The type a document gets until the person picks one: a minus means a credit note. */
export function defaultDocumentType(amount: number | null): DocumentType {
  return amount != null && amount < 0 ? 'credit_note' : 'invoice'
}

/** Why the amount's sign does not fit the type, or null. No amount yet is not a problem. */
export function signProblem(type: DocumentType, amount: number | null): string | null {
  if (amount == null || !Number.isFinite(amount)) return null
  if (type === 'credit_note' && amount >= 0) return 'Knjižno odobrenje mora imati negativan iznos'
  if (type === 'debit_note' && amount <= 0) return 'Knjižno zaduženje mora imati pozitivan iznos'
  if (hasNoPl(type) && amount <= 0) return 'Iznos mora biti veći od 0'
  return null
}

/** A bill a note can point to, as v_invoice_status gives it. */
export interface AdjustableBill {
  id: string
  invoice_number: string | null
  invoice_date: string | null
  amount: number
  /** The live notes already on it, in its currency: credits negative, debits positive. */
  adjustments: number
  paid_amount: number
  currency: string | null
}

/** What the bill comes to with its notes. */
export function billTotal(b: AdjustableBill): number {
  return Math.round((b.amount + b.adjustments) * 100) / 100
}

/** Why a credit note cannot go on this bill, or null. Only credits are limited. */
export function creditProblem(amount: number, base: AdjustableBill): string | null {
  if (amount >= 0) return null
  const left = billTotal(base)
  if (-amount <= left + 0.000001) return null
  return `Knjižno odobrenje (${fmtNum(-amount)}) je veće od ostatka računa ${base.invoice_number ?? ''} (${fmtNum(left)})`
}

/**
 * The base bill's split lines scaled to the note's amount, each rounded to the
 * para, the last line taking what the rounding left so the lines add up to the
 * note exactly. A base with nothing to scale from gives the whole note to the
 * last line.
 */
export function scaleSplits<T extends { amount: number }>(lines: T[], baseAmount: number, newAmount: number): T[] {
  if (lines.length === 0) return []
  let used = 0
  return lines.map((l, i) => {
    let amount: number
    if (i === lines.length - 1) amount = Math.round((newAmount - used) * 100) / 100
    else if (baseAmount === 0) amount = 0
    else amount = Math.round((l.amount * newAmount / baseAmount) * 100) / 100
    used += amount
    return { ...l, amount }
  })
}

/** A bill number on its letters and digits, lower case: the database's
 *  invoice_number_key, so "R-1/26" and "r 1 26" are one number. */
export function invoiceNumberKey(n: string | null | undefined): string {
  return (n || '').toLowerCase().replace(/[^\p{L}\p{N}]/gu, '')
}

/** „knjižno odobrenje −20.000,00 RSD“, „knjižno zaduženje +5.000,00 RSD“, or '' for a bill with no notes. */
export function adjustmentSummary(_amount: number, adjustments: number, currency: string): string {
  if (Math.abs(adjustments) < 0.005) return ''
  const figure = `${fmtNum(Math.abs(adjustments))} ${currency}`
  return adjustments < 0 ? `knjižno odobrenje −${figure}` : `knjižno zaduženje +${figure}`
}

/** A row of v_invoice_status, as much of it as `closureNote` reads. */
export interface ClosureRow {
  document_type?: string | null
  type?: string | null
  calculated_status?: string | null
  currency?: string | null
  adjustments?: number | null
  advance_used?: number | null
  paid_amount?: number | null
  amount_due?: number | null
}

/**
 * Why a bill is closed or smaller, when it is a credit note and not a
 * payment (spec, decisions 1 and 2): '' where money did it, or on a note.
 * A credit note after payment leaves the other side owing a refund.
 */
export function closureNote(r: ClosureRow): string {
  if ((r.document_type ?? 'invoice') !== 'invoice') return ''
  const adj = Number(r.adjustments) || 0
  const paid = Number(r.paid_amount) || 0
  const due = Number(r.amount_due) || 0
  if (adj < 0 && paid > due + 0.005) {
    const who = r.type === 'revenue' ? 'kupcu dugujemo povraćaj' : 'dobavljač duguje povraćaj'
    return `${who} ${fmtNum(paid - due)} ${r.currency || 'RSD'}`
  }
  // A final invoice the supplier's advance settled (20261021090000).
  if ((Number(r.advance_used) || 0) > 0 && paid <= 0) {
    if (r.calculated_status === 'paid') return 'zatvoreno avansom'
    if (r.calculated_status === 'partial') return 'delimično zatvoreno avansom'
  }
  if (adj < 0 && paid <= 0) {
    if (r.calculated_status === 'paid') return 'zatvoreno knjižnim odobrenjem'
    if (r.calculated_status === 'partial') return 'umanjeno knjižnim odobrenjem'
  }
  return ''
}
