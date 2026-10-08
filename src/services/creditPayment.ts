// ─── creditPayment ──────────────────────────────────────────────────────────
//
// How a bank payment that pays credit instalments is booked.
//
// A credit is kept in its OWN currency — RSD or EUR (`credits.currency`) — and
// every instalment figure (principal_amount, interest_amount, total_amount,
// paid_amount) is in it. The payment may have moved in any document currency.
// Three writers do this (TransactionDialog, BankStatementDialog, BulkImport);
// they all go through here, so none of them assumes the credit is in euros.
//
//   payableInCreditCurrency(creditCurrency, payment)  → number
//       What the payment can pay down, in the credit's currency: the
//       payment's stored amount_rsd for an RSD credit, its amount_eur for a
//       EUR credit (exactly the document amount for a EUR payment). Any other
//       credit currency throws UnsupportedCreditCurrencyError — nothing is
//       guessed.
//
//   creditLegMoney(creditCurrency, payment, legAmount, soFar?) → CreditLegMoney
//       The money columns of one principal / interest row: currency = the
//       credit's, amount = the leg, and the book columns at the PAYMENT's
//       stored eur_rate (never a refetched one — the legs are parts of the
//       payment). `soFar` is what earlier legs of the same payment booked.
//
//       THE LAST LEG TAKES THE ROUNDING, as in expenseSplit.rowsFor: when a
//       leg uses up what is left of the payment, its converted column is
//       whatever is left of the payment's own amount_rsd / amount_eur, so the
//       legs sum to the payment exactly. The leg's own column (amount_rsd for
//       an RSD credit, amount_eur for a EUR one) always equals the leg amount.
//
//   creditLegBooker(creditCurrency, payment) → { payable, remaining(), book(leg) }
//       The two above with the running totals kept for the caller.

import { bookAmountsAtRate, round2 } from './bookAmounts'
import type { BookAmounts } from './bookAmounts'

export const CREDIT_CURRENCIES = ['RSD', 'EUR'] as const
export type CreditCurrency = typeof CREDIT_CURRENCIES[number]

export class UnsupportedCreditCurrencyError extends Error {
  constructor(currency: unknown, creditName?: string) {
    const who = creditName ? `Credit "${creditName}"` : 'This credit'
    super(`${who} is in ${currency || 'an unknown currency'}; instalments can only be paid for credits in RSD or EUR`)
    this.name = 'UnsupportedCreditCurrencyError'
  }
}

/** The credit's currency, checked. Throws UnsupportedCreditCurrencyError. */
export function checkCreditCurrency(currency: unknown, creditName?: string): CreditCurrency {
  const c = typeof currency === 'string' ? currency.trim().toUpperCase() : ''
  if (c === 'RSD' || c === 'EUR') return c
  throw new UnsupportedCreditCurrencyError(currency, creditName)
}

/** The stored book columns of the payment that pays the instalments. */
export type PaymentBook = Pick<BookAmounts, 'eur_rate' | 'amount_rsd' | 'amount_eur'>

/** The money columns of one credit leg row. */
export interface CreditLegMoney extends BookAmounts {
  currency: CreditCurrency
  amount: number
}

/** What earlier legs of the same payment booked. */
export interface LegTotals {
  amount: number
  amount_rsd: number
  amount_eur: number
}

export const NO_LEGS: LegTotals = { amount: 0, amount_rsd: 0, amount_eur: 0 }

/** What the payment can pay down, in the credit's own currency. */
export function payableInCreditCurrency(creditCurrency: unknown, payment: PaymentBook): number {
  const c = checkCreditCurrency(creditCurrency)
  return round2(c === 'RSD' ? payment.amount_rsd : payment.amount_eur)
}

export function creditLegMoney(
  creditCurrency: unknown, payment: PaymentBook, legAmount: number, soFar: LegTotals = NO_LEGS,
): CreditLegMoney {
  const currency = checkCreditCurrency(creditCurrency)
  const amount = round2(legAmount)
  const eurRate = payment.eur_rate
  const book = currency === 'RSD'
    ? bookAmountsAtRate(amount, 'RSD', 1, eurRate)
    : bookAmountsAtRate(amount, 'EUR', eurRate, eurRate)

  const payable = payableInCreditCurrency(currency, payment)
  const usesUpPayment = Math.abs(payable - round2(soFar.amount + amount)) < 0.005
  if (usesUpPayment) {
    if (currency === 'RSD') book.amount_eur = round2(payment.amount_eur - soFar.amount_eur)
    else book.amount_rsd = round2(payment.amount_rsd - soFar.amount_rsd)
  }
  return { currency, amount, ...book }
}

export function addLeg(soFar: LegTotals, leg: Pick<CreditLegMoney, 'amount' | 'amount_rsd' | 'amount_eur'>): LegTotals {
  return {
    amount: round2(soFar.amount + leg.amount),
    amount_rsd: round2(soFar.amount_rsd + leg.amount_rsd),
    amount_eur: round2(soFar.amount_eur + leg.amount_eur),
  }
}

/**
 * Books the legs of one payment in order, keeping the running totals.
 * Throws UnsupportedCreditCurrencyError up front for a credit not in RSD/EUR.
 */
export function creditLegBooker(creditCurrency: unknown, payment: PaymentBook, creditName?: string) {
  const currency = checkCreditCurrency(creditCurrency, creditName)
  const payable = payableInCreditCurrency(currency, payment)
  let soFar: LegTotals = NO_LEGS
  return {
    currency,
    payable,
    /** What is still left of the payment, in the credit's currency. */
    remaining: () => round2(payable - soFar.amount),
    book(legAmount: number): CreditLegMoney {
      const money = creditLegMoney(currency, payment, legAmount, soFar)
      soFar = addLeg(soFar, money)
      return money
    },
  }
}
