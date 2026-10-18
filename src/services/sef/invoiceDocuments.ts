// A booked invoice's documents: the SEF invoice it came from, its PDF and the
// supplier's attachments — reachable from the ledger, long after booking.
//
// The link already exists in the database: `sef_inbox.imported_invoice_id`,
// set by `sef_inbox_mark_imported` when a row is booked from the inbox. An
// invoice typed in by hand has no link; it can be given one later by pairing
// it with a SEF row still waiting in the inbox, through the same function, so
// the row also leaves the queue it would otherwise sit in for ever.
//
// Nothing here writes a PDF. The PDFs are kept by `sef-fetch-invoice` when a
// row is opened; a linked row that was never opened is opened from here, with
// the same warning the inbox gives about SEF's New status.

import { ATTACHMENT_COLUMNS, type SefAttachmentRow } from './sefPdf'

/** What the documents view reads of a `sef_inbox` row. */
export interface SefDocRow {
  id: string
  sef_invoice_id: number
  document_number: string | null
  supplier_name: string | null
  supplier_vat_number: string | null
  amount: number | null
  currency: string | null
  sent_date: string | null
  sef_status: string | null
  state: string
  ubl_fetched_at: string | null
  pdf_path: string | null
  pdf_kind: string | null
  pdf_note: string | null
}

export const DOC_ROW_COLUMNS =
  'id, sef_invoice_id, document_number, supplier_name, supplier_vat_number, amount, currency, sent_date, '
  + 'sef_status, state, ubl_fetched_at, pdf_path, pdf_kind, pdf_note'

/** The booked invoice, as much as pairing needs. */
export interface BookedInvoice {
  id: string
  company_id: string | null
  type: string | null
  invoice_number: string | null
  invoice_date: string | null
  amount: number | null
  currency: string | null
  partner_tax_id: string | null
}

export interface LinkCandidate {
  row: SefDocRow
  score: number
  /** Why it is offered, in words: „isti PIB“, „isti broj“, „isti iznos“. */
  reasons: string[]
}

/** Numbers compared on their alphanumerics, as `sefDuplicate` does. */
export const foldNumber = (n: string | null | undefined): string =>
  (n || '').toLowerCase().replace(/[^a-z0-9]/g, '')

const foldTaxId = (t: string | null | undefined): string => (t || '').replace(/\D/g, '')

const sameMoney = (a: number | null, ac: string | null, b: number | null, bc: string | null): boolean =>
  a !== null && b !== null && Math.abs(Number(a) - Number(b)) <= 0.01
  && (ac || 'RSD').toUpperCase() === (bc || 'RSD').toUpperCase()

const MAX_CANDIDATES = 10

/**
 * The waiting SEF rows this invoice may be, best first.
 *
 * A row is offered only when the supplier's PIB or the invoice number agrees:
 * an amount alone pairs strangers. A matching PIB with neither number nor
 * amount is still offered (a supplier with three open bills), but below any
 * row that agrees on more.
 */
export function rankLinkCandidates(invoice: BookedInvoice, rows: SefDocRow[]): LinkCandidate[] {
  const tax = foldTaxId(invoice.partner_tax_id)
  const num = foldNumber(invoice.invoice_number)
  const out: LinkCandidate[] = []
  for (const row of rows) {
    if (row.state !== 'pending') continue
    const reasons: string[] = []
    let score = 0
    const taxHit = tax !== '' && foldTaxId(row.supplier_vat_number) === tax
    const numHit = num !== '' && foldNumber(row.document_number) === num
    if (!taxHit && !numHit) continue
    if (taxHit) { score += 4; reasons.push('isti PIB') }
    if (numHit) { score += 4; reasons.push('isti broj') }
    if (sameMoney(invoice.amount, invoice.currency, row.amount, row.currency)) { score += 2; reasons.push('isti iznos') }
    out.push({ row, score, reasons })
  }
  const day = (d: string | null) => (d ? Date.parse(d.slice(0, 10)) : NaN)
  const target = day(invoice.invoice_date)
  const distance = (r: SefDocRow) => {
    const t = day(r.sent_date)
    return Number.isNaN(t) || Number.isNaN(target) ? Number.MAX_SAFE_INTEGER : Math.abs(t - target)
  }
  out.sort((a, b) => b.score - a.score || distance(a.row) - distance(b.row))
  return out.slice(0, MAX_CANDIDATES)
}

/** What a linked row lacks, and what (if anything) can be done about it here. */
export type PdfState =
  | { kind: 'ready' }
  | { kind: 'attachment_only' }          // main PDF is the supplier's attachment
  | { kind: 'never_opened'; isNew: boolean }
  | { kind: 'opened_without_pdf' }       // opened before PDFs were kept

export function pdfStateOf(row: Pick<SefDocRow, 'pdf_path' | 'pdf_kind' | 'ubl_fetched_at' | 'sef_status'>): PdfState {
  if (row.pdf_path) return row.pdf_kind === 'supplier_attachment' ? { kind: 'attachment_only' } : { kind: 'ready' }
  if (!row.ubl_fetched_at) return { kind: 'never_opened', isNew: (row.sef_status || '').trim().toLowerCase() === 'new' }
  return { kind: 'opened_without_pdf' }
}

// ─── Reads and the one write ────────────────────────────────────────────────

/** The minimum of a Supabase client this uses; loosely typed, as tests mock it. */
export interface DocsClient {
  from(table: string): any
  rpc(fn: string, args: Record<string, any>): any
}

export interface InvoiceDocuments {
  invoice: BookedInvoice
  linked: SefDocRow | null
  attachments: SefAttachmentRow[]
}

export async function loadInvoiceDocuments(client: DocsClient, invoiceId: string): Promise<InvoiceDocuments> {
  const { data: inv, error: invErr } = await client.from('invoices')
    .select('id, company_id, type, invoice_number, invoice_date, amount, currency, partners(tax_id)')
    .eq('id', invoiceId).single()
  if (invErr || !inv) throw new Error(invErr?.message || 'Faktura nije pronađena.')
  const invoice: BookedInvoice = {
    id: inv.id, company_id: inv.company_id ?? null, type: inv.type ?? null,
    invoice_number: inv.invoice_number ?? null, invoice_date: inv.invoice_date ?? null,
    amount: inv.amount ?? null, currency: inv.currency ?? null,
    partner_tax_id: inv.partners?.tax_id ?? null,
  }

  const { data: rows, error: rowErr } = await client.from('sef_inbox')
    .select(DOC_ROW_COLUMNS).eq('imported_invoice_id', invoiceId).limit(1)
  if (rowErr) throw new Error(rowErr.message)
  const linked: SefDocRow | null = rows?.[0] ?? null

  let attachments: SefAttachmentRow[] = []
  if (linked) {
    const { data: att, error: attErr } = await client.from('sef_inbox_attachments')
      .select(ATTACHMENT_COLUMNS).eq('inbox_id', linked.id).order('n')
    if (attErr) throw new Error(attErr.message)
    attachments = att || []
  }
  return { invoice, linked, attachments }
}

/** Waiting SEF rows of the invoice's company, ranked for pairing. */
export async function loadLinkCandidates(client: DocsClient, invoice: BookedInvoice): Promise<LinkCandidate[]> {
  let q = client.from('sef_inbox').select(DOC_ROW_COLUMNS)
    .eq('state', 'pending').is('imported_invoice_id', null)
  if (invoice.company_id) q = q.eq('company_id', invoice.company_id)
  const { data, error } = await q.order('sent_date', { ascending: false }).limit(2000)
  if (error) throw new Error(error.message)
  return rankLinkCandidates(invoice, data || [])
}

/** Pairs a waiting SEF row with an invoice already in the books. */
export async function linkInvoiceToSef(client: DocsClient, rowId: string, invoiceId: string): Promise<void> {
  const { error } = await client.rpc('sef_inbox_mark_imported', { p_id: rowId, p_invoice_id: invoiceId })
  if (error) throw new Error(error.message)
}

/** The invoice ids, of those given, that have a SEF row behind them. */
export async function invoicesWithSef(client: DocsClient, invoiceIds: string[]): Promise<Set<string>> {
  if (invoiceIds.length === 0) return new Set()
  const { data, error } = await client.from('sef_inbox')
    .select('imported_invoice_id').in('imported_invoice_id', invoiceIds)
  if (error) throw new Error(error.message)
  return new Set((data || []).map((r: any) => r.imported_invoice_id).filter(Boolean))
}
