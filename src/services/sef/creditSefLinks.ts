// ─── The SEF invoices linked to credit instalments, as the Krediti page reads them ─
//
// A bank's interest invoice linked to its instalment from the SEF inbox (see
// ./creditInterestLink.ts) is shown on that instalment. Every member already
// reads the inbox (`sef_inbox_read using is_member()`), and the `sef-pdf`
// storage policy reads it as the caller, so the page reads the table itself:
// no definer function is needed for what the policies already allow.

import { fetchAllPages } from '../../utils/fetchAllPages'
import { fmtAmount } from '../../components/sefFormat'

export interface CreditSefLink {
  inboxId: string
  installmentId: string
  documentNumber: string | null
  supplierName: string | null
  amount: number | null
  currency: string | null
  /** The kept PDF in the private `sef-pdf` bucket, or null when none was kept. */
  pdfPath: string | null
  linkedAt: string | null
}

export const LINK_COLUMNS = 'id, credit_installment_id, document_number, supplier_name, amount, currency, pdf_path, linked_at'

/** Every linked invoice. Throws the reason when the read fails. */
export async function loadCreditSefLinks(client: { from(table: string): any }): Promise<CreditSefLink[]> {
  const rows = await fetchAllPages<any>((from, to) => client.from('sef_inbox')
    .select(LINK_COLUMNS)
    .eq('state', 'linked')
    .order('linked_at').order('id')
    .range(from, to))
  return rows
    .filter(r => r.credit_installment_id)
    .map(r => ({
      inboxId: r.id,
      installmentId: r.credit_installment_id,
      documentNumber: r.document_number ?? null,
      supplierName: r.supplier_name ?? null,
      amount: r.amount === null || r.amount === undefined ? null : Number(r.amount),
      currency: r.currency ?? null,
      pdfPath: r.pdf_path ?? null,
      linkedAt: r.linked_at ?? null,
    }))
}

/** The links of each instalment, in the order read. An instalment may have more than one (a correction). */
export function linksByInstalment(links: CreditSefLink[]): Map<string, CreditSefLink[]> {
  const by = new Map<string, CreditSefLink[]>()
  for (const l of links) {
    const list = by.get(l.installmentId)
    if (list) list.push(l); else by.set(l.installmentId, [l])
  }
  return by
}

/** "SEF KR-0101/26 · 30.705,92 RSD" */
export const sefLinkLabel = (l: Pick<CreditSefLink, 'documentNumber' | 'amount' | 'currency'>): string =>
  `SEF ${l.documentNumber || 'faktura'} · ${fmtAmount(l.amount, l.currency)}`
