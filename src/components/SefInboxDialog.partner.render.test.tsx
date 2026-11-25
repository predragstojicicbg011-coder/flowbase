import fs from 'fs'
import path from 'path'
import React from 'react'
import { render, screen, fireEvent, within } from '@testing-library/react'
import SefInboxDialog from './SefInboxDialog'
import { parseUbl } from '../services/sef/ublInvoice'

// One supplier, one partner: the row and the booking name the partners that
// already share the bill's PIB and offer no third; a partner created from the
// row or while booking starts from the bill's PIB, registration number and
// address. Names and numbers are invented; the document's own PIB is read
// from the fixture rather than written out here.

const mockXml = fs.readFileSync(path.join(__dirname, '..', 'services', 'sef', 'fixtures', 'invoice-sample.xml'), 'utf8')
const doc = parseUbl(mockXml)

const mockState = {
  rows: [] as any[],
  partners: [] as any[],
  invoiceProps: null as any,
}

function mockQuery(table: string) {
  const result = () => {
    if (table === 'sef_inbox') return { data: mockState.rows, error: null }
    if (table === 'partners') return { data: mockState.partners, error: null }
    if (table === 'feature_flags') return { data: { enabled: true }, error: null }
    return { data: [], error: null }
  }
  const q: any = {}
  for (const m of ['select', 'eq', 'is', 'order', 'range', 'limit', 'update', 'in', 'neq', 'gt', 'not']) q[m] = () => q
  q.maybeSingle = async () => ({ data: (result().data as any[])[0] ?? null, error: null })
  q.single = q.maybeSingle
  q.then = (ok: any, bad: any) => Promise.resolve(result()).then(ok, bad)
  return q
}

jest.mock('../supabase', () => ({
  supabase: {
    from: (t: string) => mockQuery(t),
    rpc: () => Promise.resolve({ data: [{ date_from: '1900-01-01' }], error: null }),
    functions: {
      invoke: async (name: string) => {
        if (name !== 'sef-fetch-invoice') return { data: null, error: { message: 'no' } }
        mockState.rows = mockState.rows.map(r => ({ ...r, ubl_fetched_at: '2026-10-21T08:00:00Z', ubl_xml: mockXml }))
        return { data: { ubl_xml: mockXml }, error: null }
      },
    },
    storage: { from: () => ({ createSignedUrl: async () => ({ data: { signedUrl: 'https://x/signed' }, error: null }) }) },
  },
}))
jest.mock('../contexts/AuthContext', () => ({ useAuth: () => ({ canEdit: true }) }))
jest.mock('./PartnerDialog', () => (p: any) => (
  <div data-testid="partner-dialog">{JSON.stringify({
    name: p.initialName, taxId: p.initialTaxId, registrationNumber: p.initialRegistrationNumber,
    address: p.initialAddress, city: p.initialCity,
  })}</div>
))
jest.mock('./InvoiceDialog', () => (p: any) => {
  mockState.invoiceProps = p
  return (
    <div data-testid="booking">
      {(p.reviewNotes || []).map((n: string, i: number) => <p key={i}>{n}</p>)}
    </div>
  )
})
jest.mock('../services/bookAmounts', () => ({
  ...jest.requireActual('../services/bookAmounts'),
  getBookRates: async () => { throw new Error('no rate in tests') },
}))

const row = (over: Record<string, unknown> = {}) => ({
  id: 'r1', sef_invoice_id: 473450675, document_number: 'F-1', document_type: 'Invoice',
  supplier_name: 'Dobavljač doo', supplier_vat_number: doc.supplierVatNumber, supplier_registration_number: null,
  amount: 1200, currency: 'RSD', delivery_date: '2026-10-01', due_date: '2026-10-15',
  sent_date: '2026-10-02T10:00:00Z', sef_status: 'New', state: 'pending',
  dismiss_reason: null, dismissed_at: null, imported_at: null,
  ubl_fetched_at: null, pdf_path: null, pdf_kind: null, pdf_note: null,
  sef_decision: null, sef_decision_comment: null, sef_decided_at: null, sef_decided_by_name: null,
  ...over,
})

const twoOnOnePib = (pib: string) => [
  { id: 'p-a', name: 'Alfa Doo', tax_id: pib, registration_number: null },
  { id: 'p-b', name: 'Alfa Doo Beograd', tax_id: pib, registration_number: null },
]
const sharedSentence = (pib: string) => `Dva partnera imaju PIB ${pib}: Alfa Doo i Alfa Doo Beograd. `
  + 'Izaberite pravog ručno i uklonite duplikat u Partnerima; nov partner se ne nudi.'

const show = () => render(<SefInboxDialog onClose={() => {}} onImported={() => {}} />)
const rowEl = async () => (await screen.findByText('Dobavljač doo')).closest('[data-row]') as HTMLElement

beforeEach(() => {
  mockState.rows = [row()]
  mockState.partners = []
  mockState.invoiceProps = null
})

describe('a supplier already split over two partners', () => {
  it('names both on the row, and offers no third', async () => {
    mockState.partners = twoOnOnePib('100000001')
    mockState.rows = [row({ supplier_vat_number: '100000001' })]
    show()
    const r = await rowEl()
    expect(within(r).getByText(sharedSentence('100000001'))).toBeTruthy()
    expect(within(r).queryByText('Nov dobavljač — napravi')).toBeNull()
  })

  it('says so where the owner books, instead of asking for a partner to be created', async () => {
    const pib = doc.supplierVatNumber as string
    mockState.partners = twoOnOnePib(pib)
    show()
    fireEvent.click(await screen.findByText('Otvori i proknjiži'))
    const booking = await screen.findByTestId('booking')
    expect(mockState.invoiceProps.invoice.partner_id).toBeNull()
    expect(within(booking).getByText(sharedSentence(pib))).toBeTruthy()
    expect(within(booking).queryByText(/Nijedan partner ne odgovara/)).toBeNull()
  })
})

describe('the supplier handed to the booking', () => {
  it('is the one the document names, identifiers as bare digits', async () => {
    mockState.rows = [row({ supplier_vat_number: '999999999' })]
    show()
    fireEvent.click(await screen.findByText('Otvori i proknjiži'))
    await screen.findByTestId('booking')
    expect(mockState.invoiceProps.sefSupplier).toEqual({
      name: doc.supplierName, taxId: doc.supplierVatNumber, registrationNumber: doc.supplierRegistrationNumber,
      address: doc.supplierAddress, city: doc.supplierCity, matchedPartnerId: null,
    })
    expect(doc.supplierVatNumber).toMatch(/^\d+$/)
    expect(doc.supplierAddress).toBeTruthy()
  })

  /** Only the matched partner is given the bill's identifiers; the dialog
   *  needs to know which one that is. */
  it('names the partner the inbox matched', async () => {
    mockState.partners = [{ id: 'p-doc', name: 'Dobavljač doo', tax_id: doc.supplierVatNumber, registration_number: null }]
    show()
    fireEvent.click(await screen.findByText('Otvori i proknjiži'))
    await screen.findByTestId('booking')
    expect(mockState.invoiceProps.sefSupplier.matchedPartnerId).toBe('p-doc')
  })
})

describe('creating the supplier from its row', () => {
  const xml = `<Invoice xmlns:cac="urn:cac" xmlns:cbc="urn:cbc"><cbc:ID>1</cbc:ID>
    <cac:AccountingSupplierParty><cac:Party>
      <cac:PartyName><cbc:Name>Gama Doo</cbc:Name></cac:PartyName>
      <cac:PostalAddress><cbc:StreetName>Test ulica 1</cbc:StreetName><cbc:CityName>Testgrad</cbc:CityName></cac:PostalAddress>
    </cac:Party></cac:AccountingSupplierParty></Invoice>`

  it('opens the form on its PIB, registration number, and the address of a document already fetched', async () => {
    mockState.rows = [row({
      supplier_name: 'Dobavljač doo', supplier_vat_number: 'RS100000003', supplier_registration_number: '20000003',
      sef_status: 'Seen', ubl_fetched_at: '2026-10-21T08:00:00Z', ubl_xml: xml,
    })]
    show()
    fireEvent.click(await screen.findByText('Nov dobavljač — napravi'))
    const form = await screen.findByTestId('partner-dialog')
    expect(JSON.parse(form.textContent || '{}')).toEqual({
      name: 'Dobavljač doo', taxId: '100000003', registrationNumber: '20000003', address: 'Test ulica 1', city: 'Testgrad',
    })
  })

  it('opens it without an address where the document was never fetched', async () => {
    mockState.rows = [row({ supplier_vat_number: '100000003', ubl_fetched_at: null, ubl_xml: xml })]
    show()
    fireEvent.click(await screen.findByText('Nov dobavljač — napravi'))
    const form = await screen.findByTestId('partner-dialog')
    expect(JSON.parse(form.textContent || '{}')).toEqual({
      name: 'Dobavljač doo', taxId: '100000003', registrationNumber: '', address: '', city: '',
    })
  })
})
