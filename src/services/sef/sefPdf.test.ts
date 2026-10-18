import fs from 'fs'
import path from 'path'
import { webcrypto } from 'crypto'
import {
  pickEnvelopePdf, base64ToBytes, sha256Hex, sefPdfPath, sefPdfUrl,
  SEF_PDF_BUCKET, SEF_PDF_URL_SECONDS, type StorageClientLike,
} from './sefPdf'

const fixture = (name: string) =>
  fs.readFileSync(path.join(__dirname, 'fixtures', name), 'utf8')

const pdfB64 = (text: string) => Buffer.from(`%PDF-1.4\n${text}`).toString('base64')
const SUPPLIER = pdfB64('supplier')
const RENDERED = pdfB64('sef')

/** A fixture with its `REMOVED_FROM_FIXTURE` markers swapped for real PDFs. */
const withPdfs = (xml: string, rendered: string, supplier: string) => xml
  .replace(/(<env:DocumentPdf[^>]*>)[^<]*/, `$1${rendered}`)
  .replace(/(<cbc:EmbeddedDocumentBinaryObject[^>]*>)[^<]*/, `$1${supplier}`)

describe('choosing which envelope PDF to keep', () => {
  it('prefers the supplier’s own attachment', () => {
    const xml = withPdfs(fixture('credit-note-sample.xml'), RENDERED, SUPPLIER)
    expect(pickEnvelopePdf(xml)).toEqual({ kind: 'supplier_attachment', base64: SUPPLIER })
  })

  it('falls back to SEF’s rendering when the supplier attached none', () => {
    // invoice-sample.xml has no AdditionalDocumentReference at all.
    const xml = withPdfs(fixture('invoice-sample.xml'), RENDERED, '')
    expect(pickEnvelopePdf(xml)).toEqual({ kind: 'sef_rendering', base64: RENDERED })
  })

  it('skips an attachment that is not a PDF', () => {
    const xml = withPdfs(fixture('credit-note-sample.xml'), RENDERED, SUPPLIER)
      .replace('mimeCode="application/pdf" filename', 'mimeCode="image/png" filename')
    expect(pickEnvelopePdf(xml)?.kind).toBe('sef_rendering')
  })

  it('tolerates line breaks inside the base64', () => {
    const wrapped = RENDERED.replace(/(.{8})/g, '$1\n')
    const xml = withPdfs(fixture('invoice-sample.xml'), wrapped, '')
    expect(pickEnvelopePdf(xml)?.base64).toBe(RENDERED)
  })

  it('returns null when the envelope carries no PDF (the fixtures as committed)', () => {
    expect(pickEnvelopePdf(fixture('invoice-sample.xml'))).toBeNull()
    expect(pickEnvelopePdf(fixture('credit-note-sample.xml'))).toBeNull()
    expect(pickEnvelopePdf('<Invoice/>')).toBeNull()
  })
})

describe('bytes and their hash', () => {
  it('decodes base64 to the original bytes', () => {
    const bytes = base64ToBytes(pdfB64('x'))
    expect(Buffer.from(bytes).toString()).toBe('%PDF-1.4\nx')
  })

  it('hashes with SHA-256 as lower-case hex', async () => {
    const hex = await sha256Hex(new TextEncoder().encode('abc'), webcrypto.subtle as unknown as SubtleCrypto)
    expect(hex).toBe('ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad')
  })
})

describe('the path and the signed link', () => {
  it('names the object <company_id>/<sef_invoice_id>.pdf', () => {
    expect(sefPdfPath('c-1', 482178106)).toBe('c-1/482178106.pdf')
  })

  const clientWith = (result: { data: { signedUrl: string } | null; error: { message: string } | null }) => {
    const createSignedUrl = jest.fn(async () => result)
    const from = jest.fn(() => ({ createSignedUrl }))
    return { client: { storage: { from } } as StorageClientLike, from, createSignedUrl }
  }

  it('signs the row’s path in the private bucket for ten minutes', async () => {
    const m = clientWith({ data: { signedUrl: 'https://x/signed' }, error: null })
    await expect(sefPdfUrl(m.client, { pdf_path: 'c-1/1.pdf' })).resolves.toBe('https://x/signed')
    expect(m.from).toHaveBeenCalledWith(SEF_PDF_BUCKET)
    expect(m.createSignedUrl).toHaveBeenCalledWith('c-1/1.pdf', SEF_PDF_URL_SECONDS)
    expect(SEF_PDF_URL_SECONDS).toBe(600)
  })

  it('asks for nothing when the row has no PDF', async () => {
    const m = clientWith({ data: null, error: null })
    await expect(sefPdfUrl(m.client, { pdf_path: null })).resolves.toBeNull()
    expect(m.from).not.toHaveBeenCalled()
  })

  it('throws the storage error rather than returning a dead link', async () => {
    const m = clientWith({ data: null, error: { message: 'Object not found' } })
    await expect(sefPdfUrl(m.client, { pdf_path: 'c-1/1.pdf' })).rejects.toThrow('Object not found')
  })
})
