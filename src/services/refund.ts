// The refund rule, in one place.
//
// A refund is money that came back from a supplier. It is booked as a direct
// expense transaction with a minus (type 'direct', tx_subtype 'expense',
// amount < 0, amount_rsd < 0, amount_eur < 0), so every sum that adds expenses
// subtracts it. What a person types is always a magnitude; the sign is decided
// here. The two rates are never negative.

/** A statement line as the importers hold it: two magnitudes, at most one of them filled. */
export interface BankLine { debit: number | null; credit: number | null }

export const REFUND_TAG = 'Povraćaj'
export const REFUND_LINE_NOTE =
  'Povraćaj: novac je vraćen, pa ova stavka umanjuje trošak umesto da ga uvećava.'
export const REFUND_SWITCH = 'Ovo je povraćaj'
export const REFUND_SWITCH_NOTE =
  'Dobavljač je vratio novac. Iznos se knjiži sa minusom i umanjuje trošak pod kojim je zaveden.'
export const REFUND_ONE_TIME_NOTE =
  'Povraćaj se knjiži kao jednokratan — ne ulazi u procene narednih meseci.'

const filled = (n: number | null | undefined): boolean => typeof n === 'number' && n !== 0

/** Money came IN and it is booked as a direct expense. */
export function isRefundLine(
  line: BankLine,
  txType: string | null | undefined,
  subtype: string | null | undefined,
): boolean {
  return txType === 'direct'
    && subtype === 'expense'
    && typeof line.credit === 'number' && line.credit > 0
    && !filled(line.debit)
}

/** -1 for a refund line, 1 for everything else. */
export function bookedSign(
  line: BankLine,
  txType: string | null | undefined,
  subtype: string | null | undefined,
): 1 | -1 {
  return isRefundLine(line, txType, subtype) ? -1 : 1
}

/** A typed magnitude as it is stored: null stays null, 0 stays 0, never -0. */
export function booked(value: number | null | undefined, sign: 1 | -1): number | null {
  if (value == null) return null
  if (value === 0) return 0
  return sign * value
}

/** The three book figures of a row, signed together; the two rates are left alone. */
export function bookedAmounts<T extends { amount_rsd: number | null; amount_eur: number | null }>(
  book: T,
  sign: 1 | -1,
): T {
  return { ...book, amount_rsd: booked(book.amount_rsd, sign), amount_eur: booked(book.amount_eur, sign) }
}

/** A stored row that is a refund: a direct expense transaction with a minus. */
export function isRefundRow(row: {
  type?: string | null; tx_subtype?: string | null
  amount?: number | null; amount_rsd?: number | null
}): boolean {
  if (row.type != null && row.type !== 'direct') return false
  if (row.tx_subtype !== 'expense') return false
  // The dinar book figure leads; the typed amount stands in where it is missing.
  const figure = row.amount_rsd != null ? row.amount_rsd : row.amount
  return typeof figure === 'number' && figure < 0
}

/** What is written for the cash-flow fields of a refund (spec D2). */
export const REFUND_CASH_FLOW: {
  cf_type: 'one_time'; cf_frequency: null; cf_next_month_est: null
  cf_accrual_from: null; cf_accrual_to: null; cf_capex_months: null; cf_reimbursable_date: null
} = {
  cf_type: 'one_time',
  cf_frequency: null,
  cf_next_month_est: null,
  cf_accrual_from: null,
  cf_accrual_to: null,
  cf_capex_months: null,
  cf_reimbursable_date: null,
}
