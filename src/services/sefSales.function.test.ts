import fs from 'fs'
import path from 'path'
import {
  PULLED_STATUSES, VOIDED_STATUSES, MAX_NEW_PER_PASS, isVoided, idsUrl, readIds, readStatus, readChanges,
  headerFromUbl, slimXml, ublPdfAttachments, salesPdfPath, salesAttachmentPath, refreshTargets,
  SALES_FORBIDDEN, salesRefusal,
} from '../../supabase/functions/sef-pull-sales/salesInvoice'

// Issued invoices as SEF gives them, read by the sef-pull-sales function. The
// document below is made up: a seller, a customer, one embedded PDF.

const fiktura = fs.readFileSync(path.join(__dirname, 'sef', 'fixtures', 'sales-invoice-sample.xml'), 'utf8')

describe('which statuses are pulled', () => {
  it('pulls exactly the five issued statuses', () => {
    expect([...PULLED_STATUSES]).toEqual(['Sent', 'Approved', 'Paid', 'OverDue', 'Archived'])
    expect([...VOIDED_STATUSES]).toEqual(['Cancelled', 'Storno', 'Rejected'])
    expect(isVoided('storno')).toBe(true)
    expect(isVoided('Cancelled')).toBe(true)
    expect(isVoided('Rejected')).toBe(true)
    expect(isVoided('Paid')).toBe(false)
    expect(isVoided(null)).toBe(false)
    expect(MAX_NEW_PER_PASS).toBe(40)
  })
  it('builds the ids url', () => {
    expect(idsUrl('https://x/api/publicApi', 'Sent', '2026-10-01', '2026-11-04'))
      .toBe('https://x/api/publicApi/sales-invoice/ids?status=Sent&dateFrom=2026-10-01&dateTo=2026-11-04')
  })
})

describe('reading SEF answers', () => {
  it('reads ids in any case and drops repeats', () => {
    expect(readIds({ salesInvoiceIds: [5, '7', 5] })).toEqual([5, 7])
    expect(readIds({ SalesInvoiceIds: [1, 'x', 2] })).toEqual([1, 2])
    expect(readIds(null)).toEqual([])
    expect(readIds({})).toEqual([])
  })
  it('reads the status and the storno comment', () => {
    expect(readStatus({ InvoiceId: 9, Status: 'Storno', StornoComment: 'greška' }))
      .toEqual({ invoiceId: 9, status: 'Storno', globUniqId: null, cirInvoiceId: null, comment: 'greška' })
    expect(readStatus({ invoiceId: '10', status: 'Cancelled', CancelComment: 'otkazano', GlobUniqId: 'g', CirInvoiceId: '77' }))
      .toEqual({ invoiceId: 10, status: 'Cancelled', globUniqId: 'g', cirInvoiceId: '77', comment: 'otkazano' })
    expect(readStatus({ Status: 'Sent' })).toBeNull()
  })
  it('reads the status changes', () => {
    expect(readChanges([{ SalesInvoiceId: 4, NewInvoiceStatus: 'Paid', Date: '2026-11-04' }, { nothing: 1 }]))
      .toEqual([{ invoiceId: 4, status: 'Paid' }])
    expect(readChanges({})).toEqual([])
  })
})

describe('the header off the document', () => {
  it('reads the header off the document', () => {
    expect(headerFromUbl(fiktura)).toEqual({
      documentNumber: 'IF-12/2026', documentType: 'Invoice',
      customerName: 'Kupac Test d.o.o.', customerVatNumber: '100000002', customerRegistrationNumber: '12345678',
      amount: 120000, sumWithoutVat: 100000, vatAmount: 20000, currency: 'RSD',
      issueDate: '2026-10-31', deliveryDate: '2026-10-30', dueDate: '2026-11-15',
    })
    expect(headerFromUbl(fiktura.replace('>380<', '>386<')).documentType).toBe('Prepayment')
    expect(headerFromUbl(fiktura.replace('>380<', '>381<')).documentType).toBe('CreditNote')
    expect(headerFromUbl(fiktura.replace('>380<', '>383<')).documentType).toBe('DebitNote')
    expect(headerFromUbl(fiktura.replace('>380<', '>999<')).documentType).toBeNull()
  })
  it('leaves what is missing empty', () => {
    expect(headerFromUbl('<Invoice></Invoice>')).toMatchObject({ documentNumber: null, amount: null, customerName: null })
  })
})

describe('the PDFs', () => {
  it('keeps sales files apart from purchase files', () => {
    expect(salesPdfPath('c', 555)).toBe('c/sales/555.pdf')
    expect(salesAttachmentPath('c', 555, 1)).toBe('c/sales/555/prilog-1.pdf')
  })
  it('empties the PDFs and leaves the elements', () => {
    const slim = slimXml(fiktura)
    expect(slim).toContain('<env:DocumentPdf mimeCode="application/pdf"></env:DocumentPdf>')
    expect(slim).toContain('filename="prilog.pdf"></cbc:EmbeddedDocumentBinaryObject>')
    expect(slim).not.toContain('JVBERi0')
  })
  it('finds the one attached PDF', () => {
    const found = ublPdfAttachments(fiktura)
    expect(found).toHaveLength(1)
    expect(found[0]).toMatchObject({ n: 1, filename: 'prilog.pdf', description: 'Prilog uz fakturu', base64: 'JVBERi0xLjQKcHJpbG9n' })
  })
})

describe('what to ask again', () => {
  it('asks again about a known row that left the list', () => {
    expect(refreshTargets(
      [{ sefInvoiceId: 1, sefStatus: 'Sent' }, { sefInvoiceId: 2, sefStatus: 'Sent' }, { sefInvoiceId: 3, sefStatus: 'Storno' }],
      new Set([1]),
    )).toEqual([2])
  })
  it('says plainly when the key may not read sales', () => {
    expect(salesRefusal(403)).toBe(SALES_FORBIDDEN)
    expect(salesRefusal(401)).toContain('odbio ključ')
    expect(salesRefusal(200)).toBeNull()
  })
})
