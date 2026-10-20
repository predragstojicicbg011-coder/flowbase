// ─── loadPartnerCard ────────────────────────────────────────────────────────
//
// Everything one partner's card needs, from where it lives. A loader and
// nothing else: what the figures mean is buildPartnerCard's (partnerCard.ts).
//
//   documents   v_invoice_status for the partner (deleted ones are hidden by
//               RLS, payroll children are not in the view)
//   payments    invoice_transaction_links of those documents, with the
//               transaction's date and bank; links of deleted transactions
//               are left out
//   usage       advance_usage of the final invoices
//   coverage    advance_coverage of the proformas
//   direct      direct transactions with the partner (no bill)
//   withDocs    which documents have a PDF (SEF or uploaded)

import { fetchAllPages, fetchByIds } from '../utils/fetchAllPages'
import { invoicesWithDocuments } from './sef/invoiceDocuments'
import type { CardCoverage, CardDirect, CardDocument, CardPayment, CardUsage } from './partnerCard'

export interface PartnerCardData {
  documents: CardDocument[]
  payments: CardPayment[]
  usage: CardUsage[]
  coverage: CardCoverage[]
  direct: CardDirect[]
  withDocs: Set<string>
}

export async function loadPartnerCard(client: any, partnerId: string, companyId: string | null): Promise<PartnerCardData> {
  const scoped = (q: any) => (companyId ? q.eq('company_id', companyId) : q)

  const documents = await fetchAllPages<any>((from, to) =>
    scoped(client.from('v_invoice_status')
      .select('id, invoice_number, invoice_date, type, document_type, currency, amount, amount_rsd, adjusts_invoice_id, prior_period, advance_open, advance_deducted_rsd')
      .eq('partner_id', partnerId))
      .order('invoice_date', { ascending: true }).order('id').range(from, to))
  const ids = documents.map(d => d.id)
  const proformaIds = documents.filter(d => d.document_type === 'proforma').map(d => d.id)

  const [links, usage, coverage, direct, withDocs] = await Promise.all([
    fetchByIds<any>(ids, chunk => client.from('invoice_transaction_links')
      .select('invoice_id, transaction_id, allocated_amount_rsd, transactions(transaction_date, deleted_at, type, tx_subtype, note, banks!transactions_bank_id_fkey(name))')
      .in('invoice_id', chunk)),
    fetchByIds<any>(ids, chunk => client.from('advance_usage').select('final_invoice_id, advance_invoice_id, amount_rsd').in('final_invoice_id', chunk)),
    fetchByIds<any>(proformaIds, chunk => client.from('advance_coverage').select('proforma_id, amount').in('proforma_id', chunk)),
    fetchAllPages<any>((from, to) =>
      scoped(client.from('transactions')
        .select('id, transaction_date, amount_rsd, tx_subtype, note, deleted_at, banks!transactions_bank_id_fkey(name)')
        .eq('partner_id', partnerId).eq('type', 'direct').is('deleted_at', null))
        .order('transaction_date', { ascending: true }).order('id').range(from, to)),
    invoicesWithDocuments(client, ids),
  ])

  // A direct transaction linked to a bill (a reconciled direct payment, a
  // currency difference) is in the balance through its link: not "no bill".
  const linkedTx = new Set((links || []).map((l: any) => l.transaction_id))

  return {
    documents: documents.map(d => ({
      ...d, amount: Number(d.amount) || 0, amount_rsd: Number(d.amount_rsd) || 0,
      advance_open: d.advance_open == null ? null : Number(d.advance_open),
      advance_deducted_rsd: Number(d.advance_deducted_rsd) || 0,
    })),
    payments: (links || [])
      .filter((l: any) => l.transactions && !l.transactions.deleted_at)
      .map((l: any) => ({
        invoice_id: l.invoice_id, transaction_id: l.transaction_id, date: l.transactions.transaction_date,
        amount_rsd: Number(l.allocated_amount_rsd) || 0, bank: l.transactions.banks?.name ?? null,
        kind: l.transactions.type === 'direct' && String(l.transactions.note || '').startsWith('Kursna razlika') ? 'fx' as const : 'payment' as const,
        direction: l.transactions.tx_subtype === 'revenue' ? 'in' as const : l.transactions.tx_subtype === 'expense' ? 'out' as const : null,
      })),
    usage: (usage || []).map((u: any) => ({ ...u, amount_rsd: Number(u.amount_rsd) || 0 })),
    coverage: (coverage || []).map((c: any) => ({ proforma_id: c.proforma_id, amount: Number(c.amount) || 0 })),
    direct: (direct || []).filter((t: any) => !linkedTx.has(t.id)).map((t: any) => ({
      id: t.id, date: t.transaction_date, amount_rsd: Math.abs(Number(t.amount_rsd) || 0),
      bank: t.banks?.name ?? null, note: t.note ?? null, direction: t.tx_subtype === 'revenue' ? 'in' : 'out',
    })),
    withDocs,
  }
}
