// ─── statementRecognition ───────────────────────────────────────────────────
//
// A bank statement line recognised by rules alone, with no AI and no cost:
//
//   1. The open bill it pays. The partner's reference number or the bill's
//      number written on the line, on exactly one open bill; failing that,
//      the one open bill that still owes exactly the line's amount. Several
//      bills owing the same amount are offered, never chosen.
//   2. Failing a bill, the way the partner's earlier lines were booked: the
//      last five in the same direction. All alike is sure; the latest one
//      alone, or the latest of ones that differ, is to be checked.
//
// Measured on Mintflow's history (22.10.2026), recognising each past payment
// as if it were new: rule 1 by text 178 of 178 right, by amount 364 of 364;
// several bills of one amount, "the oldest" only 6 of 12 — hence offered. Of
// 4945 lines booked with no bill, the rules would have linked 10. Rule 2: 97%
// right where the last ones agree, 92% from a single one, 55% where they
// differ — hence "to be checked".
//
// Nothing here is booked: every line it recognises waits for the person
// importing to accept it.

/** The statement line, as far as recognising it goes. */
export interface RecognitionRow {
  partnerId: string | null
  isExpense: boolean
  /** Positive, in the line's own currency. */
  amount: number
  currency: string
  /** ISO date. */
  date: string
  reference: string
  description: string
}

/** An open bill (v_invoice_status). */
export interface OpenBill {
  id: string
  partner_id: string | null
  type: string | null
  invoice_number: string | null
  reference_number: string | null
  invoice_date: string | null
  currency: string | null
  amount: number | null
  paid_amount?: number | null
  adjustments?: number | null
  advance_used?: number | null
  /** Our own billing that deducts an advance already received. */
  advance_deducted?: number | null
}

export type InvoiceMatch =
  | { kind: 'invoice'; invoiceId: string; reason: 'reference' | 'number' | 'amount' }
  | { kind: 'ambiguous'; candidates: string[]; reason: 'reference' | 'number' | 'amount' }

/** A bill issued a few days after it was paid is still the one paid. */
const DAYS_AFTER = 5
const EPS = 0.01

const digits = (s: string | null | undefined) => (s || '').replace(/\D/g, '')
const squeezed = (s: string | null | undefined) => (s || '').replace(/\s/g, '').toLowerCase()
const round2 = (n: number) => Math.round(n * 100) / 100

/** What the bill still owes in its own currency: credit notes and advances counted, payments taken off. */
export function owedNow(b: OpenBill): number {
  const due = (Number(b.amount) || 0) + (Number(b.adjustments) || 0) - (Number(b.advance_used) || 0) - (Number(b.advance_deducted) || 0)
  return round2(Math.max(0, due - (Number(b.paid_amount) || 0)))
}

function addDays(iso: string, n: number): string {
  const d = new Date(`${iso}T00:00:00Z`)
  d.setUTCDate(d.getUTCDate() + n)
  return d.toISOString().slice(0, 10)
}

/**
 * The open bill a line pays, the bills it might pay, or null.
 *
 * `taken` are bills other lines of the same import have already been given,
 * so two lines never close one bill.
 */
export function matchOpenInvoice(row: RecognitionRow, bills: OpenBill[], taken: Set<string> = new Set()): InvoiceMatch | null {
  if (!row.partnerId || !(row.amount > 0)) return null
  const type = row.isExpense ? 'expense' : 'revenue'
  const latest = addDays(row.date, DAYS_AFTER)
  const currency = row.currency || 'RSD'
  // Any currency: a bill in euros paid in dinars names itself just the same.
  // Only the amount rule needs the line and the bill in one currency.
  const open = bills.filter(b => b.partner_id === row.partnerId && b.type === type
    && !!b.invoice_date && b.invoice_date <= latest
    && !taken.has(b.id) && owedNow(b) > EPS)
  if (open.length === 0) return null

  // The model ("97 ") is not part of the number.
  const ref = digits((row.reference || '').replace(/^\s*\d{2}\s+/, ''))
  const text = squeezed(`${row.description} ${row.reference}`)

  const byRef = ref.length >= 3
    ? open.filter(b => digits(b.reference_number) === ref || digits(b.invoice_number) === ref)
    : []
  if (byRef.length === 1) return { kind: 'invoice', invoiceId: byRef[0].id, reason: 'reference' }
  if (byRef.length > 1) return { kind: 'ambiguous', candidates: byRef.map(b => b.id), reason: 'reference' }

  const byNumber = open.filter(b => {
    const n = squeezed(b.invoice_number)
    return n.length >= 3 && /\d/.test(n) && text.includes(n)
  })
  if (byNumber.length === 1) return { kind: 'invoice', invoiceId: byNumber[0].id, reason: 'number' }
  if (byNumber.length > 1) return { kind: 'ambiguous', candidates: byNumber.map(b => b.id), reason: 'number' }

  const byAmount = open.filter(b => (b.currency || 'RSD') === currency && Math.abs(owedNow(b) - row.amount) < EPS)
  if (byAmount.length === 1) return { kind: 'invoice', invoiceId: byAmount[0].id, reason: 'amount' }
  if (byAmount.length > 1) return { kind: 'ambiguous', candidates: byAmount.map(b => b.id), reason: 'amount' }
  return null
}

/** One earlier line of the partner, as it was booked. Newest first when handed over. */
export interface PastBooking {
  date: string
  pl_category: string | null
  pl_subcategory: string | null
  department: string | null
  dept_subcategory: string | null
  expense_description: string | null
  revenue_stream: string | null
  project_id: string | null
  /** Booked as several costs: the split itself is not copied. */
  split: boolean
}

export interface HistoryClassification {
  fields: Omit<PastBooking, 'date' | 'split'>
  /** All of the last ones alike, or the only one there is. */
  sure: boolean
  /** How many earlier lines it looked at. */
  count: number
  split: boolean
}

const HISTORY_DEPTH = 5
const keyOf = (b: PastBooking) => [b.pl_category, b.pl_subcategory, b.department, b.dept_subcategory, b.revenue_stream, b.project_id].join('|')

/** Does the partner have a bill still open in the line's direction, in any currency? */
export function hasOpenBill(partnerId: string | null, isExpense: boolean, bills: OpenBill[]): boolean {
  const type = isExpense ? 'expense' : 'revenue'
  return !!partnerId && bills.some(b => b.partner_id === partnerId && b.type === type && owedNow(b) > EPS)
}

/** The way to book a line, from the partner's earlier ones (newest first), or null with none classified. */
export function classifyFromHistory(history: PastBooking[]): HistoryClassification | null {
  const last = history.filter(b => !!b.pl_category).slice(0, HISTORY_DEPTH)
  if (last.length === 0) return null
  const [latest] = last
  const alike = last.every(b => keyOf(b) === keyOf(latest))
  const { date: _d, split: _s, ...fields } = latest
  return { fields, sure: alike && !latest.split, count: last.length, split: latest.split }
}
