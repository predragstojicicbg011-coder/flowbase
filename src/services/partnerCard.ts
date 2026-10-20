// ─── partnerCard ────────────────────────────────────────────────────────────
//
// The partner's card (kartica partnera): every change with one partner in date
// order, with a running balance, for reconciling with the partner's own card.
//
// THE BALANCE IS WHAT WE OWE THE PARTNER, in dinars as booked (amount_rsd,
// allocated_amount_rsd): positive, we owe them; negative, they owe us.
//
//   supplier's bill, debit note        Potražuje   balance rises
//   credit note on a supplier's bill   Duguje      balance falls
//   payment of a supplier's bill       Duguje      balance falls
//   advance closing a final invoice    Duguje      balance falls (on the final invoice's date)
//   our invoice to a customer          Duguje      balance falls (they owe us)
//   credit note on our invoice         Potražuje   balance rises
//   receipt from a customer            Potražuje   balance rises
//   investor advance deducted          Potražuje   balance rises
//
// NOT in the balance (the client's decision), listed below it: advances to
// suppliers (payments of proformas, advance invoices and what is left of
// them), and direct payments with no bill.
//
// Pure: the loader (loadPartnerCard) fetches, this decides.

export interface CardDocument {
  id: string
  invoice_number: string | null
  invoice_date: string | null
  type: string | null
  document_type: string | null
  currency: string | null
  amount: number
  amount_rsd: number
  adjusts_invoice_id: string | null
  prior_period: boolean | null
  /** v_invoice_status.advance_open on an advance invoice. */
  advance_open: number | null
  /** An investor advance deducted on our invoice, in dinars. */
  advance_deducted_rsd: number | null
}

export interface CardPayment {
  invoice_id: string
  transaction_id: string
  date: string
  amount_rsd: number
  bank: string | null
}

export interface CardUsage { final_invoice_id: string; advance_invoice_id: string; amount_rsd: number }
export interface CardCoverage { proforma_id: string; amount: number }
export interface CardDirect { id: string; date: string; amount_rsd: number; bank: string | null; note: string | null; direction: 'in' | 'out' }

export interface CardRow {
  date: string
  label: string
  /** The document it is, or that it pays: the 📎 opens it. */
  documentId: string | null
  /** The bill a payment, a credit note or an advance closes. */
  refers: string | null
  debit: number
  credit: number
  balance: number
}

export interface PartnerCard {
  opening: number
  rows: CardRow[]
  closing: number
  verdict: 'Dugujemo partneru' | 'Partner nam duguje' | 'Nema duga'
  advances: {
    invoices: { id: string; invoice_number: string | null; date: string | null; amount: number; used: number; open: number; priorPeriod: boolean }[]
    proformaPayments: { documentId: string; invoice_number: string | null; date: string; amount: number; bank: string | null }[]
    paidWithoutAdvance: number
  }
  direct: { id: string; date: string; amount: number; bank: string | null; note: string | null; direction: 'in' | 'out' }[]
}

const r2 = (n: number) => Math.round(n * 100) / 100
const num = (n: unknown) => { const v = Number(n); return Number.isFinite(v) ? v : 0 }

interface Change { date: string; order: number; label: string; documentId: string | null; refers: string | null; owe: number }

export function buildPartnerCard(
  input: { documents: CardDocument[]; payments: CardPayment[]; usage: CardUsage[]; direct: CardDirect[]; coverage: CardCoverage[] },
  period: { from: string | null; to: string | null },
): PartnerCard {
  const byId = new Map(input.documents.map(d => [d.id, d]))
  const changes: Change[] = []
  const inTo = (date: string | null) => !period.to || (date || '') <= period.to

  for (const d of input.documents) {
    const kind = d.document_type || 'invoice'
    if (kind === 'proforma' || kind === 'advance_invoice') continue
    const date = d.invoice_date || ''
    const amt = num(d.amount_rsd)
    const revenue = d.type === 'revenue'
    const base = d.adjusts_invoice_id ? byId.get(d.adjusts_invoice_id) : undefined
    const label = kind === 'credit_note' ? `Knjižno odobrenje ${d.invoice_number || ''}`.trim()
      : kind === 'debit_note' ? `Knjižno zaduženje ${d.invoice_number || ''}`.trim()
      : `${revenue ? 'Izlazni račun' : 'Račun'} ${d.invoice_number || ''}`.trim()
    // A supplier's document adds to what we owe by its signed amount; ours to
    // a customer takes from it.
    changes.push({ date, order: kind === 'invoice' ? 0 : 1, label, documentId: d.id, refers: base?.invoice_number ?? null, owe: revenue ? -amt : amt })
    if (revenue && num(d.advance_deducted_rsd) > 0) {
      changes.push({ date, order: 2, label: `Odbijen avans po ${d.invoice_number || ''}`.trim(), documentId: d.id, refers: d.invoice_number, owe: num(d.advance_deducted_rsd) })
    }
  }

  for (const u of input.usage) {
    const fin = byId.get(u.final_invoice_id)
    const adv = byId.get(u.advance_invoice_id)
    if (!fin) continue
    changes.push({
      date: fin.invoice_date || '', order: 2, label: `Zatvoreno avansom ${adv?.invoice_number || ''}`.trim(),
      documentId: u.advance_invoice_id, refers: fin.invoice_number, owe: -num(u.amount_rsd),
    })
  }

  const proformaPayments: PartnerCard['advances']['proformaPayments'] = []
  for (const p of input.payments) {
    const d = byId.get(p.invoice_id)
    if (!d) continue
    if (d.document_type === 'proforma') {
      if (inTo(p.date)) proformaPayments.push({ documentId: d.id, invoice_number: d.invoice_number, date: p.date, amount: r2(num(p.amount_rsd)), bank: p.bank })
      continue
    }
    const revenue = d.type === 'revenue'
    changes.push({
      date: p.date, order: 3, label: `${revenue ? 'Uplata' : 'Isplata'} — ${p.bank || 'banka'}`,
      documentId: d.id, refers: d.invoice_number, owe: revenue ? num(p.amount_rsd) : -num(p.amount_rsd),
    })
  }

  changes.sort((a, b) => a.date.localeCompare(b.date) || a.order - b.order)

  let opening = 0
  const rows: CardRow[] = []
  let balance = 0
  for (const c of changes) {
    if (period.to && c.date > period.to) continue
    if (period.from && c.date < period.from) { opening = r2(opening + c.owe); balance = opening; continue }
    balance = r2(balance + c.owe)
    rows.push({
      date: c.date, label: c.label, documentId: c.documentId, refers: c.refers,
      debit: c.owe < 0 ? r2(-c.owe) : 0, credit: c.owe > 0 ? r2(c.owe) : 0, balance,
    })
  }
  const closing = rows.length ? rows[rows.length - 1].balance : opening

  const usedBy = new Map<string, number>()
  for (const u of input.usage) usedBy.set(u.advance_invoice_id, r2((usedBy.get(u.advance_invoice_id) || 0) + num(u.amount_rsd)))
  const advanceInvoices = input.documents
    .filter(d => d.document_type === 'advance_invoice' && inTo(d.invoice_date))
    .map(d => {
      const used = usedBy.get(d.id) || 0
      return {
        id: d.id, invoice_number: d.invoice_number, date: d.invoice_date, amount: r2(num(d.amount_rsd)), used,
        open: d.advance_open != null ? r2(num(d.advance_open)) : r2(num(d.amount_rsd) - used), priorPeriod: !!d.prior_period,
      }
    })
  const paidOnProformas = proformaPayments.reduce((s, p) => s + p.amount, 0)
  const covered = input.coverage.reduce((s, c) => s + num(c.amount), 0)

  return {
    opening, rows, closing,
    verdict: closing > 0.005 ? 'Dugujemo partneru' : closing < -0.005 ? 'Partner nam duguje' : 'Nema duga',
    advances: { invoices: advanceInvoices, proformaPayments, paidWithoutAdvance: r2(Math.max(0, paidOnProformas - covered)) },
    direct: input.direct
      .filter(t => (!period.from || t.date >= period.from) && inTo(t.date))
      .map(t => ({ id: t.id, date: t.date, amount: r2(num(t.amount_rsd)), bank: t.bank, note: t.note, direction: t.direction })),
  }
}
