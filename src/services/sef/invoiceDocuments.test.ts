import { rankLinkCandidates, pdfStateOf, uploadRefusal, uploadPath, newUuid, type BookedInvoice, type SefDocRow } from './invoiceDocuments'

const inv = (over: Partial<BookedInvoice> = {}): BookedInvoice => ({
  id: 'inv', company_id: 'c', type: 'expense', invoice_number: '2026/0412', invoice_date: '2026-10-14',
  amount: 12000, currency: 'RSD', partner_tax_id: '100200300', ...over,
})

const row = (over: Partial<SefDocRow> & { id: string }): SefDocRow => ({
  sef_invoice_id: 1, document_number: '2026-0412', supplier_name: 'Dobavljač', supplier_vat_number: '100200300',
  amount: 12000, currency: 'RSD', sent_date: '2026-10-14T08:00:00Z', sef_status: 'Seen', state: 'pending',
  ubl_fetched_at: null, pdf_path: null, pdf_kind: null, pdf_note: null, ...over,
})

describe('pairing a hand-typed invoice with a waiting SEF row', () => {
  it('puts the row that agrees on PIB, number and amount first', () => {
    const got = rankLinkCandidates(inv(), [
      row({ id: 'pib-only', document_number: '999', amount: 1 }),
      row({ id: 'all' }),
    ])
    expect(got.map(c => c.row.id)).toEqual(['all', 'pib-only'])
    expect(got[0].reasons).toEqual(['isti PIB', 'isti broj', 'isti iznos'])
  })

  it('compares numbers on their letters and digits only', () => {
    const got = rankLinkCandidates(inv({ partner_tax_id: null }), [row({ id: 'a', document_number: '2026 0412' })])
    expect(got[0].reasons).toContain('isti broj')
  })

  it('never offers a row on the amount alone', () => {
    expect(rankLinkCandidates(inv(), [
      row({ id: 'stranger', supplier_vat_number: '555', document_number: '1' }),
    ])).toEqual([])
  })

  it('offers only rows still waiting in the inbox', () => {
    expect(rankLinkCandidates(inv(), [
      row({ id: 'booked', state: 'imported' }), row({ id: 'declined', state: 'dismissed' }),
    ])).toEqual([])
  })

  it('does not count an amount in another currency as the same', () => {
    const got = rankLinkCandidates(inv(), [row({ id: 'eur', currency: 'EUR' })])
    expect(got[0].reasons).not.toContain('isti iznos')
  })

  it('breaks a tie by how close the dates are', () => {
    const got = rankLinkCandidates(inv({ invoice_number: null, amount: null }), [
      row({ id: 'far', sent_date: '2026-08-01T00:00:00Z' }),
      row({ id: 'near', sent_date: '2026-10-15T00:00:00Z' }),
    ])
    expect(got.map(c => c.row.id)).toEqual(['near', 'far'])
  })
})

describe('what a linked row can show', () => {
  const base = { pdf_path: null, pdf_kind: null, ubl_fetched_at: null, sef_status: 'Seen' }

  it('is ready with SEF’s rendering of the invoice', () => {
    expect(pdfStateOf({ ...base, pdf_path: 'c/1.pdf', pdf_kind: 'sef_rendering' }).kind).toBe('ready')
  })

  it('flags a main PDF that is only the supplier’s attachment', () => {
    expect(pdfStateOf({ ...base, pdf_path: 'c/1.pdf', pdf_kind: 'supplier_attachment' }).kind).toBe('attachment_only')
  })

  it('says whether opening a never-opened row would spend SEF’s New status', () => {
    expect(pdfStateOf({ ...base, sef_status: 'New' })).toEqual({ kind: 'never_opened', isNew: true })
    expect(pdfStateOf(base)).toEqual({ kind: 'never_opened', isNew: false })
  })

  it('knows a row opened before PDFs were kept', () => {
    expect(pdfStateOf({ ...base, ubl_fetched_at: '2026-10-10T00:00:00Z' }).kind).toBe('opened_without_pdf')
  })
})

describe('which files may be uploaded', () => {
  const bytes = (s: string) => Uint8Array.from(s, c => c.charCodeAt(0))
  const pdf = bytes('%PDF-1.7')
  const f = (over: Partial<{ name: string; size: number; type: string }> = {}) =>
    ({ name: 'racun.pdf', size: 2048, type: 'application/pdf', ...over })

  it('takes a PDF', () => {
    expect(uploadRefusal(f(), pdf)).toBeNull()
  })

  it('reads the first bytes, not the name: a renamed image is refused', () => {
    expect(uploadRefusal(f({ name: 'slika.pdf' }), bytes('\x89PNG\r'))).toMatch(/nije PDF/)
  })

  it('refuses an empty file and one over 15 MB', () => {
    expect(uploadRefusal(f({ size: 0 }), pdf)).toMatch(/prazan/)
    expect(uploadRefusal(f({ size: 15 * 1024 * 1024 + 1 }), pdf)).toMatch(/15 MB/)
  })

  it('puts the file at the address the database checks', () => {
    expect(uploadPath('c', 'i', 'd')).toBe('c/i/d.pdf')
  })
})

it('makes ids the database path check accepts', () => {
  expect(newUuid()).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/)
})
