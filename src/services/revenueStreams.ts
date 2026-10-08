// ─── Revenue streams: what kind of income a row is ──────────────────────────
//
// `revenue_stream` on transactions and invoices CLASSIFIES
// income. It says nothing about who earned it — that is the project
// (`project_id`, see ./projects.ts). Mintflow used this column for its two
// businesses, Aimfox and Social Growth; MCFlow is one construction company,
// so the list is the kinds of money a construction company takes in.
//
// The stored values are Serbian, because the UI is, and they are stable: a
// database CHECK on both tables (20261008170000_projects.sql) allows
// exactly REVENUE_STREAMS. Renaming one is a migration, not an edit here.
//
// This is the one list. TransactionDialog, InvoiceDialog, BankStatementDialog,
// BulkImport and the Ledger's filters all read it.
//
// No code branches on a stream value today — 'Loans', 'Credit', 'VAT Claimed'
// and 'Interest Received' were labels only; credit and VAT logic works off
// tx type, pl_category and the credit tables. The named constants exist so
// that whatever does branch later names the value instead of spelling it.

export const REVENUE_STREAM = {
  /** Billed construction progress — "situacije" to an investor. */
  construction: 'Građevinske situacije',
  /** Rent from a rental building. */
  rental: 'Zakup',
  /** VAT refunded by the tax authority. */
  vatRefund: 'Povraćaj PDV-a',
  /** Interest earned on deposits. */
  interest: 'Prihod od kamata',
  /** Loan and credit inflows (not income in the P&L sense, but money in). */
  loans: 'Krediti',
  /** Anything else. */
  other: 'Ostalo',
} as const

export type RevenueStream = typeof REVENUE_STREAM[keyof typeof REVENUE_STREAM]

/** In the order the pickers show them. Must match the database CHECK. */
export const REVENUE_STREAMS: readonly RevenueStream[] = [
  REVENUE_STREAM.construction,
  REVENUE_STREAM.rental,
  REVENUE_STREAM.vatRefund,
  REVENUE_STREAM.interest,
  REVENUE_STREAM.loans,
  REVENUE_STREAM.other,
]

export function isRevenueStream(v: unknown): v is RevenueStream {
  return typeof v === 'string' && (REVENUE_STREAMS as readonly string[]).includes(v)
}

/**
 * Mintflow's values, and the one each became. Both spellings Mintflow used
 * are here: the dialogs' labels and the lower-case codes of the old
 * revenue_entries table (dropped in 20261008180000).
 * The migration applies the same mapping in SQL.
 */
export const LEGACY_REVENUE_STREAMS: Readonly<Record<string, RevenueStream>> = {
  'Social Growth': REVENUE_STREAM.construction,
  'Aimfox': REVENUE_STREAM.construction,
  'Outsourced Services': REVENUE_STREAM.construction,
  'VAT Claimed': REVENUE_STREAM.vatRefund,
  'Interest Received': REVENUE_STREAM.interest,
  'Loans': REVENUE_STREAM.loans,
  'Credit': REVENUE_STREAM.loans,
  'Other': REVENUE_STREAM.other,
  aimfox: REVENUE_STREAM.construction,
  social_growth: REVENUE_STREAM.construction,
  other: REVENUE_STREAM.other,
}

/**
 * A stored or imported value in today's vocabulary: a current value as is, a
 * Mintflow value mapped, empty as null. Anything else is null rather than
 * guessed — the caller decides whether that is "unclassified" or an error.
 */
export function normaliseRevenueStream(v: string | null | undefined): RevenueStream | null {
  const t = (v ?? '').trim()
  if (!t) return null
  if (isRevenueStream(t)) return t
  return LEGACY_REVENUE_STREAMS[t] ?? null
}
