import fs from 'fs'
import path from 'path'
import {
  PULLED_STATUSES, VOIDED_STATUSES, MAX_NEW_PER_PASS, isVoided, idsUrl, readIds, readStatus, readChanges,
  headerFromUbl, slimXml, ublPdfAttachments, salesPdfPath, salesAttachmentPath, refreshTargets,
  SALES_FORBIDDEN, salesRefusal, mergeStatusUpdates, pickAskAgain, choosePdf,
  MIN_GAP_MS, MAX_RATE_RETRIES, paceWaitMs, nextDelayMs, retryPlan, RATE_LIMITED,
  changeDays,
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
      .toEqual([{ invoiceId: 4, status: 'Paid', date: '2026-11-04' }])
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
  it('reads a credit note with no due date', () => {
    const note = fiktura
      .replace('<Invoice ', '<CreditNote ').replace('</Invoice>', '</CreditNote>')
      .replace('<cbc:InvoiceTypeCode>380</cbc:InvoiceTypeCode>', '<cbc:CreditNoteTypeCode>381</cbc:CreditNoteTypeCode>')
      .replace(/ {6}<cbc:DueDate>2026-11-15<\/cbc:DueDate>\r?\n/, '')
    expect(headerFromUbl(note)).toMatchObject({ documentType: 'CreditNote', dueDate: null, amount: 120000, documentNumber: 'IF-12/2026' })
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

describe('statuses after a pass', () => {
  it('keeps the newest status when yesterday and today both changed it', () => {
    const out = mergeStatusUpdates([
      { invoiceId: 7, status: 'Paid', date: '2026-11-04' },
      { invoiceId: 7, status: 'Approved', date: '2026-11-03' },
    ], [])
    expect(out).toEqual([{ sefInvoiceId: 7, status: 'Paid', comment: null }])
  })
  it('lets a status read in this pass win over any change', () => {
    const out = mergeStatusUpdates(
      [{ invoiceId: 7, status: 'Approved', date: '2026-11-04' }, { invoiceId: 8, status: 'Paid', date: '2026-11-04' }],
      [{ sefInvoiceId: 7, status: 'Paid', comment: null }],
    )
    expect(out).toContainEqual({ sefInvoiceId: 7, status: 'Paid', comment: null })
    expect(out).toContainEqual({ sefInvoiceId: 8, status: 'Paid', comment: null })
    expect(out).toHaveLength(2)
  })
  it('leaves voided changes to be asked about', () => {
    expect(mergeStatusUpdates([{ invoiceId: 9, status: 'Storno', date: '2026-11-04' }], [])).toEqual([])
  })
})

describe('whom to ask about again', () => {
  const rows = (...r: [number, string | null, string | null][]) =>
    r.map(([sefInvoiceId, sefStatus, lastSeenAt]) => ({ sefInvoiceId, sefStatus, lastSeenAt }))
  it('asks about the changes first, then the rows that left the list', () => {
    const ids = pickAskAgain([50], rows([1, 'Sent', null], [2, 'Sent', null]), new Set(), 2)
    expect(ids).toEqual([50, 1])
  })
  it('stops asking about rows whose status is neither issued nor voided', () => {
    expect(refreshTargets([{ sefInvoiceId: 1, sefStatus: 'Mistake' }, { sefInvoiceId: 2, sefStatus: 'Deleted' }, { sefInvoiceId: 3, sefStatus: null }], new Set()))
      .toEqual([3])
  })
  it('goes round: the row seen longest ago comes first', () => {
    const ids = pickAskAgain([], rows([1, 'Sent', '2026-11-04T10:00:00Z'], [2, 'Sent', '2026-11-01T10:00:00Z'], [3, 'Sent', null]), new Set(), 3)
    expect(ids).toEqual([3, 2, 1])
  })
  it('does not repeat an id and skips the listed', () => {
    expect(pickAskAgain([1, 1], rows([1, 'Sent', null], [2, 'Sent', null]), new Set([2]), 10)).toEqual([1])
  })
})

describe('which PDF is kept', () => {
  const enc = (t: string) => new TextEncoder().encode(t)
  const withDocPdf = fiktura
  it('takes raw PDF bytes from the pdf endpoint', () => {
    const r = choosePdf(enc('%PDF-1.4 body'), withDocPdf)
    expect(r.bytes && Array.from(r.bytes.slice(0, 5))).toEqual(Array.from(enc('%PDF-')))
    expect(r.source).toBe('endpoint')
  })
  it('takes a base64 body', () => {
    const r = choosePdf(enc('JVBERi0xLjQKYm9keQ=='), withDocPdf)
    expect(r.source).toBe('endpoint')
    expect(r.bytes && String.fromCharCode(...Array.from(r.bytes.slice(0, 5)))).toBe('%PDF-')
  })
  it('falls back to the PDF inside the document when the body is JSON', () => {
    const r = choosePdf(enc('{"Pdf":"x"}'), withDocPdf)
    expect(r.source).toBe('document')
    expect(r.bytes && String.fromCharCode(...Array.from(r.bytes.slice(0, 5)))).toBe('%PDF-')
  })
  it('falls back to the document when the endpoint failed', () => {
    expect(choosePdf(null, withDocPdf, 'SEF 500').source).toBe('document')
  })
  it('says why when nothing is usable', () => {
    const r = choosePdf(enc('<html>'), slimXml(fiktura))
    expect(r.bytes).toBeNull()
    expect(r.note).toContain('PDF')
  })
})

describe('pacing and rate limit', () => {
  it('keeps at least 400 ms between two requests', () => {
    expect(MIN_GAP_MS).toBe(400)
    expect(paceWaitMs(null, 1000)).toBe(0)
    expect(paceWaitMs(1000, 1100)).toBe(300)
    expect(paceWaitMs(1000, 1400)).toBe(0)
    expect(paceWaitMs(1000, 5000)).toBe(0)
  })
  it('waits longer after every 429 and gives up after three retries', () => {
    expect(MAX_RATE_RETRIES).toBe(3)
    expect(nextDelayMs(0, 429)).toBe(1000)
    expect(nextDelayMs(1, 429)).toBe(2000)
    expect(nextDelayMs(2, 429)).toBe(4000)
    expect(nextDelayMs(3, 429)).toBeNull()
  })
  it('does not retry anything but 429', () => {
    for (const s of [200, 400, 401, 403, 404, 500, 503]) expect(nextDelayMs(0, s)).toBeNull()
  })
  it('plans a retry, a final answer, a stop for the budget or a rate limit error', () => {
    expect(retryPlan(0, 200, 0, 110000)).toEqual({ action: 'done' })
    expect(retryPlan(0, 500, 0, 110000)).toEqual({ action: 'done' })
    expect(retryPlan(0, 429, 5000, 110000)).toEqual({ action: 'retry', waitMs: 1000 })
    expect(retryPlan(2, 429, 5000, 110000)).toEqual({ action: 'retry', waitMs: 4000 })
    expect(retryPlan(3, 429, 5000, 110000)).toEqual({ action: 'rate_limited', message: RATE_LIMITED })
    expect(RATE_LIMITED).toMatch(/rate limit/i)
    expect(RATE_LIMITED).toContain('429')
    // a wait that would pass the budget is not started
    expect(retryPlan(2, 429, 107000, 110000)).toEqual({ action: 'out_of_time' })
    expect(retryPlan(0, 429, 109500, 110000)).toEqual({ action: 'out_of_time' })
  })
  it('leaves 401 and 403 to salesRefusal', () => {
    expect(retryPlan(0, 401, 0, 110000)).toEqual({ action: 'done' })
    expect(retryPlan(0, 403, 0, 110000)).toEqual({ action: 'done' })
    expect(salesRefusal(403)).toBe(SALES_FORBIDDEN)
    expect(salesRefusal(401)).toContain('odbio')
    expect(salesRefusal(429)).toBeNull()
  })
})

describe('the days whose status changes are asked about', () => {
  it('asks only about days already past: the day before yesterday and yesterday, oldest first', () => {
    expect(changeDays('2026-11-05')).toEqual(['2026-11-03', '2026-11-04'])
  })

  it('crosses a month and a year end', () => {
    expect(changeDays('2026-03-01')).toEqual(['2026-02-27', '2026-02-28'])
    expect(changeDays('2027-01-01')).toEqual(['2026-12-30', '2026-12-31'])
  })
})
