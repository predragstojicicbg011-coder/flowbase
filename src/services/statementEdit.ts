// ─── Editing a posted bank statement ────────────────────────────────────────
//
// A manual statement is posted as one batch: every row it creates carries the
// same `import_batch_id`, and an `import_logs` entry records the batch under
// `filing_ref`. That batch id is the only thing tying the rows together, so it
// is also the handle for going back and correcting them.
//
// Reopening a statement means turning stored rows back into the shape the entry
// grid uses. That mapping is the part worth testing — it runs in both
// directions, and a field dropped on the way out is a field silently blanked on
// the way back in.
//
// Two kinds of row are deliberately not editable here:
//
//   credit payments  post far more than themselves. One row settles
//                    installments and writes separate principal and interest
//                    rows that carry no batch id. Editing the row we can see
//                    would leave the rows we cannot see saying something else.
//
//   pass-through     lives in its own table. Changing a row's type across
//                    tables is a delete and an insert, not an update, and the
//                    row's identity goes with it.
//
// Both are shown, marked, and left alone. Everything else round-trips.

import { settledStatus } from './settleInvoice'

export type RowSource = 'transactions' | 'passthrough'

export type TxType = 'direct' | 'invoice_payment' | 'passthrough' | 'credit_payment'

/** The subset of grid-row fields a stored row can populate. */
export interface RowSeed {
  tx_id: string
  source: RowSource
  locked: boolean
  date: string
  partner_name: string
  partner_id: string | null
  description: string
  debit: string
  credit: string
  currency: string
  reference_number: string
  model: string
  account_number: string
  tx_type: TxType
  tx_subtype: 'expense' | 'revenue'
  pt_direction: 'in' | 'out'
  pt_period: string
  linked_invoice_id: string
  pl_category_name: string
  pl_subcategory_name: string
  department_name: string
  dept_subcategory_name: string
  expense_description: string
  revenue_stream: string
  rev_alloc: string
  aimfox_val: string
  sg_val: string
  opex_type: string
  opex_val: string
  performance_val: string
  cf_type: string
  cf_frequency: string
  cf_next_month_est: string
  note: string
}

/** Empty string rather than null, because every one of these binds to an input. */
const str = (v: unknown): string => (v === null || v === undefined ? '' : String(v))

const money = (v: unknown): string => (v === null || v === undefined || v === '' ? '' : String(v))

/**
 * A row from `transactions`, as the entry grid would have held it.
 *
 * Revenue was typed into the credit column and expense into the debit column,
 * so `tx_subtype` is what decides which one it goes back into.
 */
export function txToSeed(tx: any, partnerName = ''): RowSeed {
  const isRevenue = tx.tx_subtype === 'revenue'
  return {
    tx_id: tx.id,
    source: 'transactions',
    locked: tx.type === 'credit_payment',
    date: str(tx.transaction_date),
    partner_name: partnerName,
    partner_id: tx.partner_id ?? null,
    description: str(tx.note),
    debit: isRevenue ? '' : money(tx.amount),
    credit: isRevenue ? money(tx.amount) : '',
    currency: str(tx.currency) || 'RSD',
    reference_number: str(tx.reference_number),
    model: str(tx.model),
    account_number: str(tx.account_number),
    tx_type: (tx.type as TxType) || 'direct',
    tx_subtype: isRevenue ? 'revenue' : 'expense',
    pt_direction: 'out',
    pt_period: str(tx.transaction_date).slice(0, 7),
    linked_invoice_id: '',
    pl_category_name: str(tx.pl_category),
    pl_subcategory_name: str(tx.pl_subcategory),
    department_name: str(tx.department),
    dept_subcategory_name: str(tx.dept_subcategory),
    expense_description: str(tx.expense_description),
    revenue_stream: str(tx.revenue_stream),
    rev_alloc: str(tx.rev_alloc_type) || 'sg100',
    aimfox_val: money(tx.rev_alloc_aimfox),
    sg_val: money(tx.rev_alloc_sg),
    opex_type: str(tx.opex_type) || 'opex',
    opex_val: money(tx.opex_amount),
    performance_val: money(tx.performance_amount),
    cf_type: str(tx.cf_type),
    cf_frequency: str(tx.cf_frequency) || 'monthly',
    cf_next_month_est: money(tx.cf_next_month_est),
    note: '',
  }
}

/**
 * A row from `passthrough`. It has no P&L side at all — money in transit is
 * recorded, not classified — so those fields come back at their defaults.
 */
export function passthroughToSeed(pt: any, partnerName = ''): RowSeed {
  const isIn = pt.direction === 'in'
  return {
    tx_id: pt.id,
    source: 'passthrough',
    locked: false,
    date: str(pt.transaction_date),
    partner_name: partnerName,
    partner_id: pt.partner_id ?? null,
    description: str(pt.note),
    debit: isIn ? '' : money(pt.amount),
    credit: isIn ? money(pt.amount) : '',
    currency: str(pt.currency) || 'RSD',
    reference_number: str(pt.reference_number),
    model: str(pt.model),
    account_number: str(pt.account_number),
    tx_type: 'passthrough',
    tx_subtype: isIn ? 'revenue' : 'expense',
    pt_direction: isIn ? 'in' : 'out',
    pt_period: str(pt.period_month) || str(pt.transaction_date).slice(0, 7),
    linked_invoice_id: '',
    pl_category_name: '', pl_subcategory_name: '',
    department_name: '', dept_subcategory_name: '',
    expense_description: '', revenue_stream: '',
    rev_alloc: 'sg100', aimfox_val: '', sg_val: '',
    opex_type: 'opex', opex_val: '', performance_val: '',
    cf_type: '', cf_frequency: 'monthly', cf_next_month_est: '',
    note: '',
  }
}

/**
 * Which transaction types a row may be switched to.
 *
 * A row already saved cannot cross between the two tables, and a credit
 * payment cannot be turned into anything at all. A row being added for the
 * first time has no such history and may be anything except a credit payment,
 * which has to go through the normal posting flow so its installments follow.
 */
export function allowedTypes(row: { tx_id?: string; source?: RowSource; locked?: boolean }): TxType[] {
  if (row.locked) return ['credit_payment']
  if (!row.tx_id) return ['direct', 'invoice_payment', 'passthrough']
  return row.source === 'passthrough' ? ['passthrough'] : ['direct', 'invoice_payment']
}

/** Whether any of this row's fields may be changed. */
export function isRowEditable(row: { locked?: boolean }): boolean {
  return !row.locked
}

export interface StatementSpan {
  date_from: string | null
  date_to: string | null
  row_count: number
}

/**
 * The header figures an `import_logs` entry carries, recomputed from whatever
 * the statement holds now. A row without a date cannot narrow the span.
 */
export function statementSpan(rows: { date?: string }[]): StatementSpan {
  const dates = rows.map(r => r.date).filter((d): d is string => !!d).sort()
  return {
    date_from: dates[0] ?? null,
    date_to: dates[dates.length - 1] ?? null,
    row_count: rows.length,
  }
}

/** What an import_logs entry is called, given the statement number typed for it. */
export function statementLabel(statementNumber: string): string {
  const n = (statementNumber || '').trim()
  return n ? `Statement #${n}` : 'Manual entry'
}

/**
 * An invoice's status from what has been allocated against it.
 *
 * The tenth of a percent that used to be written here was a fudge for
 * settlement arithmetic that went through the dollar column and came back
 * rounded. It does not any more — see services/settleInvoice.ts — so the
 * tolerance is a para, and the rule is that module's rather than a fourth
 * copy of it.
 */
export function invoiceStatus(
  allocated: number, invoiceAmount: number, invoiceAmountUsd?: number | null,
): 'unpaid' | 'partial' | 'paid' {
  return settledStatus(invoiceAmount, allocated, invoiceAmountUsd)
}

/** What a grid row is worth: debit is money out, credit is money in. */
export function rowAmount(row: { debit?: string; credit?: string }): { amount: number; isExpense: boolean } {
  const debit = parseFloat(row.debit || '') || 0
  const credit = parseFloat(row.credit || '') || 0
  return debit > 0 ? { amount: debit, isExpense: true } : { amount: credit, isExpense: false }
}
