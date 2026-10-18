// A booked invoice's documents: the SEF invoice it came from, its PDF and the
// supplier's attachments — reachable from the ledger, long after booking.
//
// The link already exists in the database: `sef_inbox.imported_invoice_id`,
// set by `sef_inbox_mark_imported` when a row is booked from the inbox. An
// invoice typed in by hand has no link; it can be given one later by pairing
// it with a SEF row still waiting in the inbox, through the same function, so
// the row also leaves the queue it would otherwise sit in for ever.
//
// SEF's PDFs are kept by `sef-fetch-invoice` when a row is opened; a linked
// row that was never opened is opened from here, with the same warning the
// inbox gives about SEF's New status. PDFs from anywhere else are uploaded by
// hand into `invoice-docs` (see the end of this file).

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
  uploads: UploadedDocument[]
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
  const uploads = await loadUploads(client, invoiceId)
  return { invoice, linked, attachments, uploads }
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

/** The invoice ids, of those given, that have any document: a SEF row or an upload. */
export async function invoicesWithDocuments(client: DocsClient, invoiceIds: string[]): Promise<Set<string>> {
  if (invoiceIds.length === 0) return new Set()
  const [sef, up] = await Promise.all([
    client.from('sef_inbox').select('imported_invoice_id').in('imported_invoice_id', invoiceIds),
    client.from('invoice_documents').select('invoice_id').in('invoice_id', invoiceIds).is('removed_at', null),
  ])
  if (sef.error) throw new Error(sef.error.message)
  const ids = new Set<string>((sef.data || []).map((r: any) => r.imported_invoice_id).filter(Boolean))
  // A database without the uploads table yet still shows the SEF clip.
  if (!up.error) (up.data || []).forEach((r: any) => ids.add(r.invoice_id))
  return ids
}

// ─── PDFs uploaded by hand (20261019120000) ─────────────────────────────────
//
// Bucket `invoice-docs`, path <company_id>/<invoice_id>/<document_id>.pdf. The
// file goes up first and the row after it: storage takes a file only under a
// live invoice's folder, and nobody can read it until a row names it.

export const UPLOAD_BUCKET = 'invoice-docs'
export const UPLOAD_MAX_BYTES = 15 * 1024 * 1024

export interface UploadedDocument {
  id: string
  invoice_id: string
  path: string
  filename: string
  description: string | null
  bytes: number
  uploaded_at: string
}

export const UPLOAD_COLUMNS = 'id, invoice_id, path, filename, description, bytes, uploaded_at'

export const uploadPath = (companyId: string, invoiceId: string, documentId: string): string =>
  `${companyId}/${invoiceId}/${documentId}.pdf`

/** Why this file may not be uploaded, or null. `head` is the file's first bytes. */
export function uploadRefusal(file: { name: string; size: number; type: string }, head: Uint8Array): string | null {
  if (file.size === 0) return `„${file.name}“ je prazan fajl.`
  if (file.size > UPLOAD_MAX_BYTES) return `„${file.name}“ je veći od 15 MB.`
  // The name and the browser's type can both be wrong; the first bytes cannot.
  const magic = String.fromCharCode(...Array.from(head.slice(0, 5)))
  if (magic !== '%PDF-') return `„${file.name}“ nije PDF.`
  return null
}

export async function loadUploads(client: DocsClient, invoiceId: string): Promise<UploadedDocument[]> {
  const { data, error } = await client.from('invoice_documents').select(UPLOAD_COLUMNS)
    .eq('invoice_id', invoiceId).is('removed_at', null).order('uploaded_at')
  if (error) throw new Error(error.message)
  return data || []
}

/** A v4 UUID; `randomUUID` is missing on older phones and outside https. */
export function newUuid(): string {
  const c: Crypto | undefined = (globalThis as any).crypto
  if (c?.randomUUID) return c.randomUUID()
  const b = new Uint8Array(16)
  if (c?.getRandomValues) c.getRandomValues(b)
  else for (let i = 0; i < 16; i++) b[i] = Math.floor(Math.random() * 256)
  b[6] = (b[6] & 0x0f) | 0x40
  b[8] = (b[8] & 0x3f) | 0x80
  const h = Array.from(b, x => x.toString(16).padStart(2, '0')).join('')
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-${h.slice(12, 16)}-${h.slice(16, 20)}-${h.slice(20)}`
}

/** A blob's bytes; FileReader where `Blob.arrayBuffer` is missing (older browsers, jsdom). */
function readHead(blob: Blob): Promise<Uint8Array> {
  if (typeof blob.arrayBuffer === 'function') return blob.arrayBuffer().then(b => new Uint8Array(b))
  return new Promise((resolve, reject) => {
    const r = new FileReader()
    r.onload = () => resolve(new Uint8Array(r.result as ArrayBuffer))
    r.onerror = () => reject(r.error)
    r.readAsArrayBuffer(blob)
  })
}

export interface UploadClient extends DocsClient {
  storage: { from(bucket: string): any }
}

/** Uploads one checked PDF and records it. Throws with the reason on failure. */
export async function uploadInvoicePdf(
  client: UploadClient,
  invoice: Pick<BookedInvoice, 'id' | 'company_id'>,
  file: File,
  description: string,
  newId: () => string = newUuid,
): Promise<void> {
  if (!invoice.company_id) throw new Error('Faktura nema firmu, pa dokument nema gde da se sačuva.')
  const head = await readHead(file.slice(0, 5))
  const refusal = uploadRefusal(file, head)
  if (refusal) throw new Error(refusal)

  const id = newId()
  const path = uploadPath(invoice.company_id, invoice.id, id)
  const { error: upErr } = await client.storage.from(UPLOAD_BUCKET)
    .upload(path, file, { contentType: 'application/pdf', upsert: false })
  if (upErr) throw new Error(`Fajl „${file.name}“ nije otpremljen: ${upErr.message}`)

  const { error } = await client.from('invoice_documents').insert({
    id, invoice_id: invoice.id, company_id: invoice.company_id, path,
    filename: file.name, description: description.trim() || null, bytes: file.size,
  })
  if (error) throw new Error(`Fajl „${file.name}“ je otpremljen, ali nije upisan: ${error.message}`)
}

/** Hides an uploaded document; the file and the record stay. */
export async function removeUpload(client: DocsClient, documentId: string): Promise<void> {
  const { error } = await client.rpc('invoice_document_remove', { p_id: documentId })
  if (error) throw new Error(error.message)
}
