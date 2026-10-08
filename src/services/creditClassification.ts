// ─── Credit payment classification ──────────────────────────────────────────
//
// A credit installment is booked as two expense transactions — principal and
// interest — and until now neither carried a department, so every one of them
// landed under Unassigned in the department branch of the report. Roughly $23k
// of the unclassified total was this.
//
// The classification is declared ONCE rather than inline in the three dialogs
// that post credit payments (transaction, bank statement, bulk import). They
// had three copies of the same object literal, which is how they came to differ
// from what the business actually wanted.
//
// Principal and interest are separate lines, each with all five fields, so
// both branches of the expense report place them. WHICH headings is the
// owner's choice: the system categories `credit_principal` and
// `credit_interest` (services/systemCategories.ts), set in Podešavanja →
// Sistemske kategorije. Mintflow's 'Loans/Credits/Dividend' names were
// hardcoded here; MCFlow's P&L is in Serbian and has its own. Unset, a credit
// payment is refused before anything is written.

import { fmtMoney } from '../utils/formatters'
import {
  classificationFor, classificationOrNull,
  type Classification, type SystemCategoryMap,
} from './systemCategories'

export interface CreditClassification {
  pl_category: string
  pl_subcategory: string
  department: string
  dept_subcategory: string
  expense_description: string
}

export interface CreditLegs {
  principal: CreditClassification
  interest: CreditClassification
}

const asCredit = (c: Classification): CreditClassification => ({
  pl_category: c.pl_category!, pl_subcategory: c.pl_subcategory!,
  department: c.department!, dept_subcategory: c.dept_subcategory!,
  expense_description: c.expense_description!,
})

/**
 * The two legs' classifications. Throws `SystemCategoryMissing` when either
 * is unset — call it BEFORE the first write of a credit payment.
 */
export function creditLegsFrom(map: SystemCategoryMap | null | undefined): CreditLegs {
  return {
    principal: asCredit(classificationFor('credit_principal', map)),
    interest: asCredit(classificationFor('credit_interest', map)),
  }
}

/** The same for a reader (the budget): null when either leg is unset. */
export function creditLegsOrNull(map: SystemCategoryMap | null | undefined): CreditLegs | null {
  const p = classificationOrNull('credit_principal', map)
  const i = classificationOrNull('credit_interest', map)
  return p && i ? { principal: asCredit(p), interest: asCredit(i) } : null
}

/**
 * Which installment this leg paid, as a note.
 *
 * The detail used to live in `expense_description`, where it made every
 * payment its own category — 200 payments, 200 "categories" in the report, and
 * nothing groupable. The description is now a fixed classification value and
 * the detail moves here, where free text belongs. Nothing is lost.
 *
 * The leg leads and the bank's own wording follows it, because the drill-down
 * truncates a note at 80 characters. Put the statement description first and a
 * principal row reads "Naplata redovne kamate…" — the bank's word for interest,
 * on a row that is principal — and the reader has no way to tell that the
 * classification is right and the prefix is just where the line came from.
 */
export function creditNote(
  leg: 'principal' | 'interest',
  creditName: string,
  installmentNo: number | string,
  amount: number,
  userNote?: string | null,
  /**
   * The credit's own currency — what `amount` is in. A loan may be indexed to
   * EUR or taken in RSD; the note names which rather than assuming euros.
   */
  currency: string = 'EUR',
): string {
  const label = leg === 'principal' ? 'Glavnica' : 'Kamata'
  const detail = `${label} — ${creditName} #${installmentNo} (${fmtMoney(amount, currency)})`
  const typed = (userNote || '').trim()
  return typed ? `${detail} | stavka izvoda: ${typed}` : detail
}

// ── Allocating a payment to an installment ──────────────────────────────────

export interface InstallmentSplit {
  principal: number
  interest: number
}

const r2 = (n: number) => Math.round(n * 100) / 100

/**
 * How much of a payment goes to principal and how much to interest.
 *
 * Two faults this exists to prevent, both seen in production:
 *
 *   BankStatementDialog ignored the paid amount entirely and booked the
 *   installment's full principal AND full interest for every bank line matched
 *   to it. A statement that splits an installment into "Naplata glavnice
 *   kredita" and "Naplata redovne kamate" therefore booked it twice — EUR
 *   71,188.74 across thirteen installments.
 *
 *   The other paths always satisfied principal first, so an interest-only line
 *   closed principal instead and the interest was recorded as principal.
 *
 * So the amount decides. A payment that matches one leg on its own is that leg
 * — that is what a statement with separate lines looks like. Only a payment
 * that matches neither is spread, principal first, which is the right reading
 * of a single combined payment.
 */
export function allocatePayment(
  paid: number, principalDue: number, interestDue: number, tolerance = 0.01,
): InstallmentSplit {
  const p = Math.max(principalDue, 0)
  const i = Math.max(interestDue, 0)
  const amount = Math.max(paid, 0)
  if (amount <= 0) return { principal: 0, interest: 0 }

  const matchesInterest = i > 0 && Math.abs(amount - i) <= tolerance
  const matchesPrincipal = p > 0 && Math.abs(amount - p) <= tolerance

  // A line that could be either is ambiguous only when the two legs are equal;
  // principal is the larger commitment, so it wins that coin toss.
  if (matchesInterest && !matchesPrincipal) return { principal: 0, interest: r2(Math.min(amount, i)) }
  if (matchesPrincipal) return { principal: r2(Math.min(amount, p)), interest: 0 }

  const toPrincipal = Math.min(amount, p)
  const toInterest = Math.min(amount - toPrincipal, i)
  return { principal: r2(toPrincipal), interest: r2(toInterest) }
}
