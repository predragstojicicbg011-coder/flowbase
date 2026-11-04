// ─── Receivables: what customers owe, what falls due, who is late ───────────
// Pure arithmetic over the Prihodi invoice rows (v_invoice_status). Money is
// read from each row's own figure in the display currency (`remaining_*`),
// never converted here; a row with none is counted in `unconverted`.

import { round2 } from './bookAmounts'
import { isVoidedOnSef } from './sef/salesDraft'
import type { RevenueListRow } from './revenuePage'
import { pickAmount, type DisplayCurrency } from '../contexts/DisplayCurrencyContext'

export const DUE_SOON_DAYS = 7

export type ReceivableBucket = 'all' | 'dueSoon' | 'overdue'

export interface ReceivableTotals {
  total: number
  dueSoon: number
  overdue: number
  counts: Record<ReceivableBucket, number>
  unconverted: number
  proformasAwaiting: { count: number; amount: number }
}

const EPS = 0.005
const NOT_BOOKED = new Set(['proforma', 'advance_invoice'])

const day = (d: string | null | undefined): string => String(d ?? '').slice(0, 10)

/** Whole days from `a` to `b` (positive when `b` is later), by calendar date. */
function daysFromTo(a: string, b: string): number {
  return Math.round((Date.parse(`${day(b)}T00:00:00Z`) - Date.parse(`${day(a)}T00:00:00Z`)) / 86400000)
}

const addDays = (d: string, n: number): string =>
  new Date(Date.parse(`${day(d)}T00:00:00Z`) + n * 86400000).toISOString().slice(0, 10)

const owesSomething = (r: RevenueListRow): boolean =>
  Number(r.remaining_rsd ?? 0) > EPS || Number(r.remaining_eur ?? 0) > EPS

/** A revenue invoice (not a proforma or advance invoice) with something still owed. */
export function isReceivable(r: RevenueListRow): boolean {
  return r.type === 'revenue' && !NOT_BOOKED.has(r.document_type ?? '') && owesSomething(r)
}

const bucketOf = (r: RevenueListRow, today: string): 'dueSoon' | 'overdue' | null => {
  const due = day(r.due_date)
  if (!due) return null
  if (due < today) return 'overdue'
  if (due <= addDays(today, DUE_SOON_DAYS)) return 'dueSoon'
  return null
}

export function receivableTotals(
  rows: readonly RevenueListRow[], today: string, currency: DisplayCurrency,
): ReceivableTotals {
  const t: ReceivableTotals = {
    total: 0, dueSoon: 0, overdue: 0, counts: { all: 0, dueSoon: 0, overdue: 0 },
    unconverted: 0, proformasAwaiting: { count: 0, amount: 0 },
  }
  for (const r of rows) {
    if (r.type !== 'revenue') continue
    const remaining = pickAmount(r, currency, 'remaining')
    if (r.document_type === 'proforma') {
      if (remaining !== null && remaining > EPS) {
        t.proformasAwaiting.count++
        t.proformasAwaiting.amount += remaining
      }
      continue
    }
    if (!isReceivable(r)) continue
    if (remaining === null) { t.unconverted++; continue }
    if (!(remaining > EPS)) continue
    t.total += remaining
    t.counts.all++
    const b = bucketOf(r, today)
    if (b === 'dueSoon') t.dueSoon += remaining
    if (b === 'overdue') t.overdue += remaining
    if (b) t.counts[b]++
  }
  t.total = round2(t.total)
  t.dueSoon = round2(t.dueSoon)
  t.overdue = round2(t.overdue)
  t.proformasAwaiting.amount = round2(t.proformasAwaiting.amount)
  return t
}

/** Receivables in a bucket, by due date (those without one last). */
export function receivablesIn(
  rows: readonly RevenueListRow[], bucket: ReceivableBucket, today: string,
): RevenueListRow[] {
  return rows
    .filter(r => isReceivable(r) && (bucket === 'all' || bucketOf(r, today) === bucket))
    .sort((a, b) => (day(a.due_date) || '9999').localeCompare(day(b.due_date) || '9999'))
}

export interface LatePayer {
  partnerId: string | null
  partnerName: string
  amount: number
  oldestDue: string
  daysLate: number
  count: number
  oldestInvoiceId: string
}

/** Customers with overdue invoices, the largest debt first. */
export function latePayers(
  rows: readonly RevenueListRow[], today: string, currency: DisplayCurrency,
): LatePayer[] {
  const byKey = new Map<string, LatePayer>()
  for (const r of rows) {
    if (!isReceivable(r) || bucketOf(r, today) !== 'overdue') continue
    const remaining = pickAmount(r, currency, 'remaining')
    if (remaining === null || !(remaining > EPS)) continue
    const due = day(r.due_date)
    const name = r.partner_name || '—'
    const key = r.partner_id ?? `name:${name}`
    const cur = byKey.get(key)
    if (!cur) {
      byKey.set(key, {
        partnerId: r.partner_id ?? null, partnerName: name, amount: remaining, oldestDue: due,
        daysLate: daysFromTo(due, today), count: 1, oldestInvoiceId: r.id,
      })
    } else {
      cur.amount += remaining
      cur.count++
      if (due < cur.oldestDue) {
        cur.oldestDue = due
        cur.daysLate = daysFromTo(due, today)
        cur.oldestInvoiceId = r.id
      }
    }
  }
  return [...byKey.values()]
    .map(p => ({ ...p, amount: round2(p.amount) }))
    .sort((a, b) => b.amount - a.amount)
}

export type SefFlag = 'voided' | 'paid_on_sef'

/** Invoices whose SEF status disagrees with the books: voided, or paid on SEF but not in the statement. */
export function sefFlags(
  rows: readonly { id: string; calculated_status?: string | null }[],
  sefRows: readonly { imported_invoice_id: string | null; sef_status: string | null }[],
): Map<string, SefFlag> {
  const status = new Map(rows.map(r => [r.id, r.calculated_status ?? null]))
  const out = new Map<string, SefFlag>()
  for (const s of sefRows) {
    const id = s.imported_invoice_id
    if (!id || !status.has(id)) continue
    if (isVoidedOnSef(s.sef_status)) out.set(id, 'voided')
    else if ((s.sef_status ?? '').trim().toLowerCase() === 'paid' && status.get(id) !== 'paid' && !out.has(id)) {
      out.set(id, 'paid_on_sef')
    }
  }
  return out
}
