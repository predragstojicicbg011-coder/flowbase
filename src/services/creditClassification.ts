// ─── Credit payment classification ──────────────────────────────────────────
//
// A credit installment is booked as two expense transactions — principal and
// interest — and until now neither carried a department, so every one of them
// landed under Unassigned in the department branch of the report. Roughly $23k
// of the unclassified total was this.
//
// The classification is declared here rather than inline in the three dialogs
// that post credit payments (transaction, bank statement, bulk import). They
// had three copies of the same object literal, which is how they came to differ
// from what the business actually wanted.
//
// Principal and interest are still separate lines, but both now sit under
// Loans/Credits/Dividend on the P&L side too. Splitting them across two P&L
// categories meant the cost of a credit was never one number anywhere: the P&L
// branch showed 24,104 under Loans/Credits/Dividend while the department branch
// showed 26,270, and the difference was the interest sitting in Financial
// Expenses. Both are correct and the branches reconcile, but nobody reading it
// should have to reconcile them in their head.
//
// Financial Expenses / Interest is left alone — it is still where interest that
// is not a credit instalment belongs.

import { fmtMoney } from '../utils/formatters'

export interface CreditClassification {
  pl_category: string
  pl_subcategory: string
  department: string
  dept_subcategory: string
  expense_description: string
}

export const CREDIT_DEPARTMENT = 'Loans/Credits/Dividend'
export const CREDIT_DEPT_SUBCATEGORY = 'Credit'

export const CREDIT_PRINCIPAL: CreditClassification = {
  pl_category: 'Loans/Credits/Dividend',
  pl_subcategory: 'Bank Credits',
  department: CREDIT_DEPARTMENT,
  dept_subcategory: CREDIT_DEPT_SUBCATEGORY,
  expense_description: 'Credit',
}

export const CREDIT_INTEREST: CreditClassification = {
  pl_category: 'Loans/Credits/Dividend',
  pl_subcategory: 'Paid Interest on credit',
  department: CREDIT_DEPARTMENT,
  dept_subcategory: CREDIT_DEPT_SUBCATEGORY,
  expense_description: 'Interest',
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
  const label = leg === 'principal' ? 'Principal' : 'Interest'
  const detail = `${label} — ${creditName} #${installmentNo} (${fmtMoney(amount, currency)})`
  const typed = (userNote || '').trim()
  return typed ? `${detail} | bank line: ${typed}` : detail
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
