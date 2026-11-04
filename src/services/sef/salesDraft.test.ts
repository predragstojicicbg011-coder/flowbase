import fs from 'fs'
import path from 'path'
import {
  salesDraftFromUbl, salesBookingRefusal, isVoidedOnSef, voidedLabel, salesReviewNotes,
} from './salesDraft'
import { parseUbl } from './ublInvoice'

const xml = fs.readFileSync(path.join(__dirname, 'fixtures', 'sales-invoice-sample.xml'), 'utf8')
const base = () => parseUbl(xml)
const row = { id: 'r1', currency: 'RSD' }

describe('salesDraftFromUbl', () => {
  it('fills a revenue invoice from the document', () => {
    const d = salesDraftFromUbl(base(), row, 'k1', 'c1', null, null)
    expect(d).toMatchObject({
      type: 'revenue', partner_id: 'k1', company_id: 'c1', invoice_number: 'IF-12/2026',
      invoice_date: '2026-10-30', due_date: '2026-11-15', amount: 120000, currency: 'RSD',
      document_type: 'invoice', pl_impact: true, account_number: null,
      note: 'Izlazna faktura sa SEF-a',
    })
  })

  it('books a euro invoice at the rate of the delivery date', () => {
    const eur = parseUbl(xml.replace(/RSD/g, 'EUR'))
    const d = salesDraftFromUbl(eur, row, 'k1', 'c1', 117.2, 117.2)
    expect(d).toMatchObject({ currency: 'EUR', exchange_rate: 117.2, eur_rate: 117.2 })
  })

  it('maps the four document types', () => {
    const of = (code: string) => salesDraftFromUbl(
      parseUbl(xml.replace('<cbc:InvoiceTypeCode>380<', `<cbc:InvoiceTypeCode>${code}<`)),
      row, 'k1', 'c1', null, null)
    expect(of('380')).toMatchObject({ document_type: 'invoice', pl_impact: true, note: 'Izlazna faktura sa SEF-a' })
    expect(of('386')).toMatchObject({ document_type: 'advance_invoice', pl_impact: false, note: 'Avansni račun sa SEF-a' })
    expect(of('381')).toMatchObject({ document_type: 'credit_note', note: 'Knjižno odobrenje sa SEF-a' })
    expect(of('383')).toMatchObject({ document_type: 'debit_note', note: 'Knjižno zaduženje sa SEF-a' })
  })
})

describe('salesBookingRefusal', () => {
  it('refuses a voided or unreadable document', () => {
    expect(salesBookingRefusal(base(), { sef_status: 'Approved' })).toBeNull()
    for (const s of ['Cancelled', 'storno', 'REJECTED']) {
      expect(salesBookingRefusal(base(), { sef_status: s }))
        .toBe('Faktura je stornirana, otkazana ili odbijena na SEF-u i ne knjiži se.')
    }
    expect(salesBookingRefusal({ ...base(), total: null, grossTotal: null }, { sef_status: 'Approved' }))
      .toBe('Dokument ne može da se pročita kao faktura.')
    expect(salesBookingRefusal({ ...base(), issueDate: null, deliveryDate: null }, { sef_status: 'Approved' }))
      .toBe('Dokument ne može da se pročita kao faktura.')
  })

  it('names the voided state', () => {
    expect(isVoidedOnSef('Cancelled')).toBe(true)
    expect(isVoidedOnSef('Paid')).toBe(false)
    expect(isVoidedOnSef(null)).toBe(false)
    expect(voidedLabel('storno')).toBe('Stornirana na SEF-u')
    expect(voidedLabel('CANCELLED')).toBe('Otkazana na SEF-u')
    expect(voidedLabel('Rejected')).toBe('Odbijena na SEF-u')
    expect(voidedLabel('Paid')).toBeNull()
  })

  it('holds advance documents until customer advances exist', () => {
    const msg = 'Avansni račun i konačna faktura sa avansom knjiže se kad avansi kupaca budu uključeni.'
    expect(salesBookingRefusal({ ...base(), isAdvanceInvoice: true }, { sef_status: 'Approved' })).toBe(msg)
    expect(salesBookingRefusal({ ...base(), advanceUsed: 5000 }, { sef_status: 'Approved' })).toBe(msg)
  })
})

describe('salesReviewNotes', () => {
  const company = { by: 'pib' as const, name: 'Primer Gradnja d.o.o.' }

  it('says how the customer was found', () => {
    expect(salesReviewNotes(base(), { matchedBy: 'pib', company })).toContain('Kupac prepoznat po PIB-u.')
    expect(salesReviewNotes(base(), { matchedBy: 'name', company }).join(' ')).toContain('samo po nazivu — proverite')
    expect(salesReviewNotes(base(), { matchedBy: null, company })).toContain('Kupac nije u partnerima — dodajte ga.')
  })

  it('names the seller company and the booking date', () => {
    const notes = salesReviewNotes(base(), { matchedBy: 'pib', company }).join(' ')
    expect(notes).toContain('Primer Gradnja d.o.o.')
    expect(notes).toContain('2026-10-30')
  })
})
