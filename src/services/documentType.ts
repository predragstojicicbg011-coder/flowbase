// ─── documentType ───────────────────────────────────────────────────────────
//
// A bill, a credit note (knjižno odobrenje) or a debit note (knjižno
// zaduženje). A credit note reduces one bill and is negative; a debit note
// adds to one bill and is positive. The database holds the same rules
// (20261020100000_credit_and_debit_notes.sql, invoices_adjustment_rules);
// these are the form's copy of them, so the person reads the reason before
// saving instead of a refusal after.

import { fmtNum } from '../utils/formatters'

export type DocumentType = 'invoice' | 'credit_note' | 'debit_note'

export const DOCUMENT_TYPES: DocumentType[] = ['invoice', 'credit_note', 'debit_note']

export const DOCUMENT_TYPE_LABEL: Record<DocumentType, string> = {
  invoice: 'Račun',
  credit_note: 'Knjižno odobrenje',
  debit_note: 'Knjižno zaduženje',
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
