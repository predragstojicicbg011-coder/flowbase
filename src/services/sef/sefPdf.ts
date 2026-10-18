// The invoice's PDF, kept — the invoice first, the supplier's attachments beside it.
//
// A SEF document arrives as an envelope with base64 PDFs in it:
//
//   * `env:DocumentHeader/env:DocumentPdf` — SEF's own rendering of the UBL,
//     i.e. THE INVOICE as SEF shows it, present on every document;
//   * `cac:AdditionalDocumentReference/cac:Attachment/
//      cbc:EmbeddedDocumentBinaryObject mimeCode="application/pdf"` — whatever
//     the supplier attached: often a delivery note or a specification, not the
//     invoice. Zero, one or several.
//
// THE RULE: the main PDF is SEF's rendering whenever there is one; a supplier
// attachment stands in only when the rendering is missing. Every supplier PDF
// attachment is kept as well, each in its own file beside the main one, so the
// finance team sees the invoice first and the rest one click away.
//
// (Until 20261019100000 the supplier's attachment was preferred, and approvers
// were shown a delivery note where they expected the invoice.)
//
// `supabase/functions/sef-fetch-invoice` does the same extraction in Deno. The
// edge functions share no code with `src/`, so the logic there is a minimal
// copy of this file; change both together.

export type SefPdfKind = 'supplier_attachment' | 'sef_rendering'

export interface EnvelopePdf {
  kind: SefPdfKind
  /** Base64 as it stood in the document, whitespace removed. */
  base64: string
}

/** One PDF the supplier attached. `n` counts PDF attachments from 1, in document order. */
export interface EnvelopeAttachment {
  n: number
  /** The attachment's `filename` attribute, else the reference's `cbc:ID`. */
  filename: string | null
  /** `cbc:DocumentDescription`, else `cbc:DocumentType`. */
  description: string | null
  base64: string
}

export interface EnvelopePdfs {
  main: EnvelopePdf | null
  attachments: EnvelopeAttachment[]
}

export const SEF_PDF_BUCKET = 'sef-pdf'

/** Bucket path convention: `<company_id>/<sef_invoice_id>.pdf`. */
export const sefPdfPath = (companyId: string, sefInvoiceId: number | string): string =>
  `${companyId}/${sefInvoiceId}.pdf`

/** An attachment's path: `<company_id>/<sef_invoice_id>/prilog-<n>.pdf`. */
export const sefAttachmentPath = (companyId: string, sefInvoiceId: number | string, n: number): string =>
  `${companyId}/${sefInvoiceId}/prilog-${n}.pdf`

const REFERENCE = /<cac:AdditionalDocumentReference\b[^>]*>([\s\S]*?)<\/cac:AdditionalDocumentReference>/g
const BINARY = /<cbc:EmbeddedDocumentBinaryObject([^>]*)>([^<]*)<\/cbc:EmbeddedDocumentBinaryObject>/
const RENDERING = /<env:DocumentPdf[^>]*>([^<]*)<\/env:DocumentPdf>/

const isPdfMime = (attrs: string) => /mimeCode\s*=\s*["']application\/pdf["']/i.test(attrs)

/** `%PDF-` in base64 begins `JVBERi0`. A candidate that does not is not a PDF
 *  (a placeholder, an empty element), and is skipped rather than stored. */
const looksLikePdf = (b64: string) => b64.startsWith('JVBERi0')

const unescapeXml = (s: string) => s
  .replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"')
  .replace(/&apos;/g, "'").replace(/&amp;/g, '&')

/** The text of the first `<cbc:{tag}>` in a fragment, trimmed; null when absent or empty. */
function textOf(fragment: string, tag: string): string | null {
  const m = new RegExp(`<cbc:${tag}\\b[^>]*>([^<]*)</cbc:${tag}>`).exec(fragment)
  const t = m ? unescapeXml(m[1]).trim() : ''
  return t || null
}

function attrOf(attrs: string, name: string): string | null {
  const m = new RegExp(`\\b${name}\\s*=\\s*(?:"([^"]*)"|'([^']*)')`).exec(attrs)
  const v = m ? unescapeXml(m[1] ?? m[2] ?? '').trim() : ''
  return v || null
}

/** Every supplier PDF attachment, in document order. */
export function envelopeAttachments(xml: string): EnvelopeAttachment[] {
  const out: EnvelopeAttachment[] = []
  for (const ref of Array.from(xml.matchAll(REFERENCE))) {
    const body = ref[1]
    const bin = BINARY.exec(body)
    if (!bin) continue
    const b64 = bin[2].replace(/\s+/g, '')
    if (!isPdfMime(bin[1]) || !looksLikePdf(b64)) continue
    // The reference's own cbc:ID, not one inside the attachment.
    const at = body.search(/<cac:Attachment\b/)
    const head = at < 0 ? body : body.slice(0, at)
    out.push({
      n: out.length + 1,
      filename: attrOf(bin[1], 'filename') ?? textOf(head, 'ID'),
      description: textOf(body, 'DocumentDescription') ?? textOf(body, 'DocumentType'),
      base64: b64,
    })
  }
  return out
}

/** SEF's rendering of the invoice, or null when the envelope carries none. */
export function envelopeRendering(xml: string): string | null {
  const r = RENDERING.exec(xml)
  const b64 = r ? r[1].replace(/\s+/g, '') : ''
  return looksLikePdf(b64) ? b64 : null
}

/** The main PDF and every attachment. The invoice (SEF's rendering) wins. */
export function extractEnvelopePdfs(xml: string): EnvelopePdfs {
  const attachments = envelopeAttachments(xml)
  const rendering = envelopeRendering(xml)
  const main: EnvelopePdf | null = rendering
    ? { kind: 'sef_rendering', base64: rendering }
    : attachments[0] ? { kind: 'supplier_attachment', base64: attachments[0].base64 } : null
  return { main, attachments }
}

/** Which of the envelope's PDFs is the main one, or null when it carries none. */
export function pickEnvelopePdf(xml: string): EnvelopePdf | null {
  return extractEnvelopePdfs(xml).main
}

/** Base64 to bytes, without Node's Buffer (this also runs in the browser). */
export function base64ToBytes(b64: string): Uint8Array {
  const bin = atob(b64.replace(/\s+/g, ''))
  const out = new Uint8Array(bin.length)
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i)
  return out
}

/** SHA-256 of the bytes, lower-case hex. `subtle` is injectable for tests. */
export async function sha256Hex(
  bytes: Uint8Array,
  subtle: SubtleCrypto = globalThis.crypto.subtle,
): Promise<string> {
  const digest = await subtle.digest('SHA-256', bytes)
  return Array.from(new Uint8Array(digest)).map(b => b.toString(16).padStart(2, '0')).join('')
}

/** The minimum of a Supabase client this needs, so tests can hand in a mock. */
export interface StorageClientLike {
  storage: {
    from(bucket: string): {
      createSignedUrl(path: string, expiresIn: number): Promise<{
        data: { signedUrl: string } | null
        error: { message: string } | null
      }>
    }
  }
}

export const SEF_PDF_URL_SECONDS = 10 * 60

/**
 * A short-lived link to an object in the private bucket. Signed for ten
 * minutes; storage RLS decides whether this user may have it at all.
 */
export async function sefObjectUrl(client: StorageClientLike, path: string): Promise<string | null> {
  const { data, error } = await client.storage.from(SEF_PDF_BUCKET)
    .createSignedUrl(path, SEF_PDF_URL_SECONDS)
  if (error) throw new Error(error.message)
  return data?.signedUrl ?? null
}

/** A link to the row's main PDF (the invoice), or null when the row has none. */
export async function sefPdfUrl(
  client: StorageClientLike,
  row: { pdf_path: string | null | undefined },
): Promise<string | null> {
  if (!row.pdf_path) return null
  return sefObjectUrl(client, row.pdf_path)
}

// ─── The attachments as the browser sees them ───────────────────────────────

/** A row of `sef_inbox_attachments`, as much as the inbox reads. */
export interface SefAttachmentRow {
  id: string
  inbox_id: string
  n: number
  path: string
  filename: string | null
  description: string | null
  bytes: number | null
}

export const ATTACHMENT_COLUMNS = 'id, inbox_id, n, path, filename, description, bytes'

/** Attachments grouped by inbox row, each group in `n` order. */
export function attachmentsByInbox(rows: SefAttachmentRow[]): Map<string, SefAttachmentRow[]> {
  const by = new Map<string, SefAttachmentRow[]>()
  for (const r of rows) {
    const list = by.get(r.inbox_id) || []
    list.push(r)
    by.set(r.inbox_id, list)
  }
  by.forEach(list => list.sort((a, b) => a.n - b.n))
  return by
}

/** What a person sees for one attachment. */
export const attachmentLabel = (a: Pick<SefAttachmentRow, 'n' | 'filename' | 'description'>): string =>
  [a.filename || `Prilog ${a.n}`, a.description].filter(Boolean).join(' — ')

// ─── The repair: the invoice fetched again for a row that kept an attachment ─
//
// Rows opened before 20261019100000 kept the supplier's attachment as their
// PDF, and the stored XML had every PDF stripped. The only way to the invoice
// is the document again, from SEF. Fetching an invoice that is already Seen
// changes nothing there; fetching one that is still New would mark it Seen —
// the very thing the inbox promises not to do behind anyone's back — so the
// repair is refused for New (and for a row whose status is unknown).

export interface RepairableRow {
  ubl_fetched_at: string | null
  sef_status: string | null
  pdf_kind?: string | null
}

export const PDF_NOTE_REFETCHED = 'Ponovo preuzeto sa SEF-a radi računa (umesto priloga)'

/** Why the repair may not run on this row, or null when it may. */
export function refetchPdfRefusal(row: RepairableRow): string | null {
  if (!row.ubl_fetched_at) return 'Faktura još nije otvorena — otvorite je, i PDF računa se čuva odmah.'
  const status = (row.sef_status || '').trim()
  if (!status) return 'SEF status fakture nije poznat, pa se dokument ne preuzima ponovo.'
  if (status.toLowerCase() === 'new') {
    return 'Faktura je na SEF-u još nova; ponovno preuzimanje bi je označilo kao pregledanu, pa se ne radi.'
  }
  return null
}

/** Whether the inbox offers the repair: an opened row whose main PDF is a supplier attachment. */
export const offersRefetchPdf = (row: RepairableRow): boolean =>
  row.pdf_kind === 'supplier_attachment' && refetchPdfRefusal(row) === null

export interface FunctionsClientLike {
  functions: {
    invoke(name: string, options: { body: Record<string, any> }): Promise<{ data: any; error: any }>
  }
}

export interface RefetchResult {
  pdfPath: string | null
  pdfKind: SefPdfKind | null
  attachments: number
  note: string | null
}

/**
 * Asks `sef-fetch-invoice` for the document again, for its PDFs only. The
 * refusal is checked here first so a New invoice never reaches the function
 * (which refuses it too). Throws with the server's words on failure.
 */
export async function refetchSefPdf(
  client: FunctionsClientLike,
  row: RepairableRow & { id: string },
  reasonFrom: (err: any) => Promise<string> = async e => e?.message || 'Poziv nije uspeo.',
): Promise<RefetchResult> {
  const refusal = refetchPdfRefusal(row)
  if (refusal) throw new Error(refusal)
  const { data, error } = await client.functions
    .invoke('sef-fetch-invoice', { body: { inbox_id: row.id, refetch_pdf: true } })
  if (error) throw new Error(await reasonFrom(error))
  if (!data || data.error) throw new Error(data?.error || 'Dokument nije mogao da se preuzme.')
  return {
    pdfPath: data.pdf_path ?? null,
    pdfKind: data.pdf_kind ?? null,
    attachments: Number(data.attachments ?? 0),
    note: data.pdf_note ?? data.pdf_error ?? null,
  }
}
