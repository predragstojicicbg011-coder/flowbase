import fs from 'fs'
import path from 'path'
import { webcrypto } from 'crypto'
import {
  pickEnvelopePdf, extractEnvelopePdfs, base64ToBytes, sha256Hex, sefPdfPath, sefPdfUrl,
  sefAttachmentPath, sefObjectUrl, attachmentsByInbox, attachmentLabel,
  refetchPdfRefusal, offersRefetchPdf, refetchSefPdf,
  SEF_PDF_BUCKET, SEF_PDF_URL_SECONDS, type StorageClientLike, type SefAttachmentRow,
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

describe('choosing which envelope PDF is the main one', () => {
  it('keeps SEF’s rendering of the invoice even when the supplier attached a PDF', () => {
    const xml = withPdfs(fixture('credit-note-sample.xml'), RENDERED, SUPPLIER)
    expect(pickEnvelopePdf(xml)).toEqual({ kind: 'sef_rendering', base64: RENDERED })
  })

  it('falls back to the supplier’s attachment only when SEF’s rendering is missing', () => {
    const xml = withPdfs(fixture('credit-note-sample.xml'), '', SUPPLIER)
    expect(pickEnvelopePdf(xml)).toEqual({ kind: 'supplier_attachment', base64: SUPPLIER })
  })

  it('uses the rendering on an invoice with no attachment at all', () => {
    // invoice-sample.xml has no AdditionalDocumentReference at all.
    const xml = withPdfs(fixture('invoice-sample.xml'), RENDERED, '')
    expect(pickEnvelopePdf(xml)).toEqual({ kind: 'sef_rendering', base64: RENDERED })
    expect(extractEnvelopePdfs(xml).attachments).toEqual([])
  })

  it('never falls back to an attachment that is not a PDF', () => {
    const xml = withPdfs(fixture('credit-note-sample.xml'), '', SUPPLIER)
      .replace('mimeCode="application/pdf" filename', 'mimeCode="image/png" filename')
    expect(pickEnvelopePdf(xml)).toBeNull()
  })

  it('tolerates line breaks inside the base64', () => {
    const wrapped = RENDERED.replace(/(.{8})/g, '$1\n')
    const xml = withPdfs(fixture('invoice-sample.xml'), wrapped, '')
    expect(pickEnvelopePdf(xml)?.base64).toBe(RENDERED)
  })

  it('returns nothing when the envelope carries no PDF (the fixtures as committed)', () => {
    for (const f of ['invoice-sample.xml', 'invoice-sample-2.xml', 'credit-note-sample.xml']) {
      expect(extractEnvelopePdfs(fixture(f))).toEqual({ main: null, attachments: [] })
    }
    expect(pickEnvelopePdf('<Invoice/>')).toBeNull()
  })
})

describe('the supplier’s attachments', () => {
  it('lists the attachment on the real credit note, named by its filename', () => {
    const xml = withPdfs(fixture('credit-note-sample.xml'), RENDERED, SUPPLIER)
    expect(extractEnvelopePdfs(xml).attachments).toEqual([
      { n: 1, filename: '26-07-558396', description: null, base64: SUPPLIER },
    ])
  })

  it('keeps the attachment even when it stood in as the main PDF', () => {
    const xml = withPdfs(fixture('credit-note-sample.xml'), '', SUPPLIER)
    const got = extractEnvelopePdfs(xml)
    expect(got.main?.kind).toBe('supplier_attachment')
    expect(got.attachments).toHaveLength(1)
  })

  it('lists every PDF attachment in order, with ID, description and type', () => {
    const ref = (id: string, extra: string, attrs: string, b64: string) =>
      `<cac:AdditionalDocumentReference><cbc:ID>${id}</cbc:ID>${extra}<cac:Attachment>`
      + `<cbc:EmbeddedDocumentBinaryObject ${attrs}>${b64}</cbc:EmbeddedDocumentBinaryObject>`
      + '</cac:Attachment></cac:AdditionalDocumentReference>'
    const xml = withPdfs(fixture('invoice-sample.xml'), RENDERED, '').replace('</cbc:DocumentCurrencyCode>',
      '</cbc:DocumentCurrencyCode>'
      + ref('OTP-7', '<cbc:DocumentDescription>Otpremnica &amp; spec.</cbc:DocumentDescription>', 'mimeCode="application/pdf"', pdfB64('a'))
      + ref('IMG-1', '', 'mimeCode="image/png" filename="slika.png"', 'iVBORw0KGgo=')
      + ref('SPEC', '<cbc:DocumentType>Specifikacija</cbc:DocumentType>', "mimeCode='application/pdf' filename='spec.pdf'", pdfB64('b')))
    const got = extractEnvelopePdfs(xml)
    expect(got.main).toEqual({ kind: 'sef_rendering', base64: RENDERED })
    expect(got.attachments.map(({ base64, ...a }) => a)).toEqual([
      { n: 1, filename: 'OTP-7', description: 'Otpremnica & spec.' },
      { n: 2, filename: 'spec.pdf', description: 'Specifikacija' },
    ])
    expect(got.attachments[1].base64).toBe(pdfB64('b'))
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

  it('names an attachment <company_id>/<sef_invoice_id>/prilog-<n>.pdf', () => {
    expect(sefAttachmentPath('c-1', 482178106, 2)).toBe('c-1/482178106/prilog-2.pdf')
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

  it('signs an attachment’s path the same way', async () => {
    const m = clientWith({ data: { signedUrl: 'https://x/a' }, error: null })
    await expect(sefObjectUrl(m.client, 'c-1/1/prilog-1.pdf')).resolves.toBe('https://x/a')
    expect(m.from).toHaveBeenCalledWith(SEF_PDF_BUCKET)
    expect(m.createSignedUrl).toHaveBeenCalledWith('c-1/1/prilog-1.pdf', 600)
  })
})

describe('the attachments in the inbox', () => {
  const a = (inbox_id: string, n: number): SefAttachmentRow =>
    ({ id: `${inbox_id}-${n}`, inbox_id, n, path: `c/1/prilog-${n}.pdf`, filename: null, description: null, bytes: 1 })

  it('groups by row and orders by n', () => {
    const by = attachmentsByInbox([a('r1', 2), a('r2', 1), a('r1', 1)])
    expect(by.get('r1')!.map(x => x.n)).toEqual([1, 2])
    expect(by.get('r2')).toHaveLength(1)
    expect(by.get('r3')).toBeUndefined()
  })

  it('labels by filename and description, or by number', () => {
    expect(attachmentLabel({ n: 1, filename: 'OTP-7', description: 'Otpremnica' })).toBe('OTP-7 — Otpremnica')
    expect(attachmentLabel({ n: 3, filename: null, description: null })).toBe('Prilog 3')
  })
})

describe('fetching the invoice again for a row that kept an attachment', () => {
  const opened = { id: 'r1', ubl_fetched_at: '2026-10-03T08:00:00Z', sef_status: 'Seen', pdf_kind: 'supplier_attachment' }
  const clientReturning = (result: { data: any; error: any }) => {
    const invoke = jest.fn(async (_name: string, _opts: { body: Record<string, any> }) => result)
    return { client: { functions: { invoke } }, invoke }
  }

  it('is refused for an invoice still New on SEF, and the function is not called', async () => {
    const m = clientReturning({ data: {}, error: null })
    expect(refetchPdfRefusal({ ...opened, sef_status: 'New' })).toMatch(/još nova/)
    expect(refetchPdfRefusal({ ...opened, sef_status: 'new' })).toMatch(/još nova/)
    await expect(refetchSefPdf(m.client, { ...opened, sef_status: 'New' })).rejects.toThrow(/još nova/)
    expect(m.invoke).not.toHaveBeenCalled()
  })

  it('is refused for an unknown status and for an unopened row', () => {
    expect(refetchPdfRefusal({ ...opened, sef_status: null })).toMatch(/nije poznat/)
    expect(refetchPdfRefusal({ ...opened, ubl_fetched_at: null })).toMatch(/nije otvorena/)
  })

  it('is offered only where the main PDF is a supplier attachment', () => {
    expect(offersRefetchPdf(opened)).toBe(true)
    expect(offersRefetchPdf({ ...opened, pdf_kind: 'sef_rendering' })).toBe(false)
    expect(offersRefetchPdf({ ...opened, pdf_kind: null })).toBe(false)
    expect(offersRefetchPdf({ ...opened, sef_status: 'New' })).toBe(false)
    for (const status of ['Seen', 'Approved', 'Rejected', 'Cancelled', 'Storno']) {
      expect(offersRefetchPdf({ ...opened, sef_status: status })).toBe(true)
    }
  })

  it('asks the function once, for the PDFs only, and reads its answer', async () => {
    const m = clientReturning({
      data: { pdf_path: 'c/1.pdf', pdf_kind: 'sef_rendering', attachments: 2, pdf_note: 'Ponovo preuzeto' },
      error: null,
    })
    await expect(refetchSefPdf(m.client, opened)).resolves.toEqual(
      { pdfPath: 'c/1.pdf', pdfKind: 'sef_rendering', attachments: 2, note: 'Ponovo preuzeto' })
    expect(m.invoke).toHaveBeenCalledTimes(1)
    expect(m.invoke).toHaveBeenCalledWith('sef-fetch-invoice', { body: { inbox_id: 'r1', refetch_pdf: true } })
  })

  it('throws the server’s words when the function refuses', async () => {
    const m = clientReturning({ data: null, error: { message: 'non-2xx' } })
    await expect(refetchSefPdf(m.client, opened, async () => 'Faktura je na SEF-u još nova'))
      .rejects.toThrow('Faktura je na SEF-u još nova')
  })
})
