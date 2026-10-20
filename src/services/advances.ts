// ─── advances ───────────────────────────────────────────────────────────────
//
// Supplier advances: a paid PROFORMA is covered by an ADVANCE INVOICE, which a
// FINAL INVOICE uses up, in full or in part (20261021090000). The database
// holds the rules; these are the form's proposals and its copy of the rules,
// so the person sees the figures filled in and the reason before saving.

import { fmtNum, fmtMoney } from '../utils/formatters'
import { invoiceNumberKey } from './documentType'

/** An advance invoice with something left to use (v_invoice_status.advance_open). */
export interface OpenAdvance {
  id: string
  invoice_number: string | null
  invoice_date: string | null
  amount: number
  open: number
  currency: string | null
}

/** A proforma with payments (v_invoice_status: paid_amount, covered). */
export interface PaidProforma {
  id: string
  invoice_number: string | null
  paid: number
  covered: number
  currency: string | null
}

/** An advance invoice a final invoice names (SEF BillingReference). */
export interface AdvanceRef { number: string; date: string | null; amount?: number }

const cents = (n: number) => Math.round(n * 100) / 100

/**
 * The advances a final invoice uses: each one it names, in the order it names
 * them, up to what is left of it, until `advanceTotal` is reached. A named
 * advance not in the books is `missing`; `left` is what nothing covered.
 */
export function proposeUsage(
  refs: AdvanceRef[], advanceTotal: number, advances: OpenAdvance[],
): { usage: { advanceId: string; amount: number }[]; missing: AdvanceRef[]; left: number } {
  let left = cents(advanceTotal)
  const usage: { advanceId: string; amount: number }[] = []
  const missing: AdvanceRef[] = []
  for (const ref of refs) {
    const a = advances.find(x => invoiceNumberKey(x.invoice_number) === invoiceNumberKey(ref.number))
    if (!a) { missing.push(ref); continue }
    // What the bill says this advance paid, where it says it (SEF extension).
    const amount = cents(Math.min(a.open, left, ref.amount ?? left))
    if (amount > 0) { usage.push({ advanceId: a.id, amount }); left = cents(left - amount) }
  }
  return { usage, missing, left }
}

/**
 * The paid proformas an advance invoice covers: first those its text names,
 * then the rest in the order given, each up to what was paid and not yet
 * covered. Empty where the proformas cannot cover it in full — an advance
 * invoice larger than what was paid is not linked.
 */
export function proposeCoverage(
  amount: number, proformas: PaidProforma[], preferredNumbers: string[],
): { proformaId: string; amount: number }[] {
  const keys = preferredNumbers.map(invoiceNumberKey)
  const ordered = [
    ...proformas.filter(p => keys.includes(invoiceNumberKey(p.invoice_number))),
    ...proformas.filter(p => !keys.includes(invoiceNumberKey(p.invoice_number))),
  ]
  let left = cents(amount)
  const out: { proformaId: string; amount: number }[] = []
  for (const p of ordered) {
    if (left <= 0) break
    const take = cents(Math.min(p.paid - p.covered, left))
    if (take > 0) { out.push({ proformaId: p.id, amount: take }); left = cents(left - take) }
  }
  return left > 0.005 ? [] : out
}

/** Why the chosen proformas cannot cover this advance invoice, or null. */
export function coverageProblem(amount: number, chosen: PaidProforma[]): string | null {
  const available = cents(chosen.reduce((s, p) => s + (p.paid - p.covered), 0))
  if (amount <= available + 0.005) return null
  return `Avansni račun (${fmtNum(amount)}) je veći od plaćenog po izabranim predračunima (${fmtNum(available)}).`
}

/** Why these uses of advances do not fit the final invoice, or null. */
export function usageProblem(finalAmount: number, rows: { amount: number; open: number }[]): string | null {
  const over = rows.find(r => r.amount > r.open + 0.005)
  if (over) return `Od avansnog računa je ostalo ${fmtNum(over.open)}, a traži se ${fmtNum(over.amount)}.`
  const total = cents(rows.reduce((s, r) => s + r.amount, 0))
  if (total > finalAmount + 0.005) return `Iskorišćeni avans (${fmtNum(total)}) je veći od računa (${fmtNum(finalAmount)}).`
  return null
}

/** Proforma numbers an advance invoice mentions in its text („po predračunu br. 256173“). */
export function proformaNumbersIn(text: string): string[] {
  const out: string[] = []
  const re = /predra[čc]un\w*\s+(?:br\.?\s*)?([A-Za-z0-9][\w\-/.]*)/giu
  for (const m of (text || '').matchAll(re)) {
    const n = m[1].replace(/[.]+$/, '')
    if (/\d/.test(n) && !out.includes(n)) out.push(n)
  }
  return out
}

/** „Dobavljač ima otvorene avanse: 2 avansna računa, ukupno 335.000,00 RSD“, or ''. */
export function openAdvancesNotice(advances: OpenAdvance[]): string {
  const open = advances.filter(a => a.open > 0.005)
  if (open.length === 0) return ''
  const n = open.length, m10 = n % 10, m100 = n % 100
  const word = m10 === 1 && m100 !== 11 ? 'avansni račun'
    : m10 >= 2 && m10 <= 4 && (m100 < 12 || m100 > 14) ? 'avansna računa' : 'avansnih računa'
  const total = cents(open.reduce((s, a) => s + a.open, 0))
  return `Dobavljač ima otvorene avanse: ${n} ${word}, ukupno ${fmtMoney(total, open[0].currency || 'RSD')}`
}

/**
 * A proforma made from a payment that went out with none (spec: the money was
 * released without a proforma). Dinars only: a foreign-currency proforma needs
 * its own rate and is entered as a proforma. Everything is editable later.
 */
export function proformaFromPayment(p: {
  companyId: string | null; partnerId: string | null; date: string; amount: number
  currency: string | null; accountNumber: string | null; description: string | null
}): { ok: true; row: Record<string, unknown> } | { ok: false; why: string } {
  if (!p.partnerId) return { ok: false, why: 'Prvo izaberite dobavljača.' }
  if (!(p.amount > 0)) return { ok: false, why: 'Predračun se pravi samo iz isplate.' }
  if ((p.currency || 'RSD') !== 'RSD') return { ok: false, why: 'Iz uplate se pravi samo dinarski predračun; devizni unesite kao predračun.' }
  const amount = cents(p.amount)
  const when = p.date.split('-').reverse().join('.')
  return {
    ok: true,
    row: {
      company_id: p.companyId, partner_id: p.partnerId, invoice_number: null, invoice_date: p.date, due_date: p.date,
      type: 'expense', currency: 'RSD', amount, amount_rsd: amount, exchange_rate: 1,
      document_type: 'proforma', pl_impact: false, status: 'unpaid', account_number: p.accountNumber || null,
      note: `Predračun napravljen iz uplate od ${when}` + (p.description ? `: ${p.description}` : ''),
    },
  }
}
