// The invoice's PDF, kept.
//
// A SEF document arrives as an envelope with up to two base64 PDFs in it:
//
//   * `env:DocumentHeader/env:DocumentPdf` — SEF's own rendering of the UBL,
//     present on every document;
//   * `cac:AdditionalDocumentReference/cac:Attachment/
//      cbc:EmbeddedDocumentBinaryObject mimeCode="application/pdf"` — the PDF
//     the supplier attached, i.e. the document the supplier actually issued.
//     Not every supplier sends one.
//
// The supplier's own PDF is preferred; SEF's rendering is the fallback.
//
// `supabase/functions/sef-fetch-invoice` does the same choice in Deno. The
// edge functions share no code with `src/`, so the logic there is a minimal
// copy of this file; change both together.

export type SefPdfKind = 'supplier_attachment' | 'sef_rendering'

export interface EnvelopePdf {
  kind: SefPdfKind
  /** Base64 as it stood in the document, whitespace removed. */
  base64: string
}

export const SEF_PDF_BUCKET = 'sef-pdf'

/** Bucket path convention: `<company_id>/<sef_invoice_id>.pdf`. */
export const sefPdfPath = (companyId: string, sefInvoiceId: number | string): string =>
  `${companyId}/${sefInvoiceId}.pdf`

const ATTACHMENT = /<cbc:EmbeddedDocumentBinaryObject([^>]*)>([^<]*)<\/cbc:EmbeddedDocumentBinaryObject>/g
const RENDERING = /<env:DocumentPdf[^>]*>([^<]*)<\/env:DocumentPdf>/

const isPdfMime = (attrs: string) => /mimeCode\s*=\s*["']application\/pdf["']/i.test(attrs)

/** `%PDF-` in base64 begins `JVBERi0`. A candidate that does not is not a PDF
 *  (a placeholder, an empty element), and is skipped rather than stored. */
const looksLikePdf = (b64: string) => b64.startsWith('JVBERi0')

/** Which of the envelope's PDFs to keep, or null when it carries none. */
export function pickEnvelopePdf(xml: string): EnvelopePdf | null {
  for (const m of Array.from(xml.matchAll(ATTACHMENT))) {
    const b64 = m[2].replace(/\s+/g, '')
    if (isPdfMime(m[1]) && looksLikePdf(b64)) return { kind: 'supplier_attachment', base64: b64 }
  }
  const r = RENDERING.exec(xml)
  if (r) {
    const b64 = r[1].replace(/\s+/g, '')
    if (looksLikePdf(b64)) return { kind: 'sef_rendering', base64: b64 }
  }
  return null
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
 * A short-lived link to the row's kept PDF, or null when the row has none.
 * The bucket is private: the link is signed for ten minutes, and storage RLS
 * decides whether this user may have it at all.
 */
export async function sefPdfUrl(
  client: StorageClientLike,
  row: { pdf_path: string | null | undefined },
): Promise<string | null> {
  if (!row.pdf_path) return null
  const { data, error } = await client.storage.from(SEF_PDF_BUCKET)
    .createSignedUrl(row.pdf_path, SEF_PDF_URL_SECONDS)
  if (error) throw new Error(error.message)
  return data?.signedUrl ?? null
}
