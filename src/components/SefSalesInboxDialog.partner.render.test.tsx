import fs from 'fs'
import path from 'path'
import React from 'react'
import { render, screen, fireEvent, within, act } from '@testing-library/react'
import SefSalesInboxDialog from './SefSalesInboxDialog'
import { parseUbl } from '../services/sef/ublInvoice'

// The customer rule is the supplier rule: a customer split over two partners
// is named and no third is offered; one added from the row or while booking
// starts from the invoice's PIB, registration number and address; the booking
// is told which partner it may complete. Names and numbers are invented.

const mockXml = fs.readFileSync(path.join(__dirname, '..', 'services', 'sef', 'fixtures', 'sales-invoice-sample.xml'), 'utf8')
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
    if (table === 'companies') return { data: [{ id: 'co1', name: 'Primer Gradnja d.o.o.' }], error: null }
    if (table === 'company_profiles') return { data: [{ company_id: 'co1', pib: '100000009', mb: '87654321' }], error: null }
    return { data: [], error: null }
  }
  const q: any = {}
  for (const m of ['select', 'is', 'order', 'range', 'limit', 'in', 'eq', 'update']) q[m] = () => q
  q.maybeSingle = async () => ({ data: (mockState.rows[0] ?? null), error: null })
  q.then = (ok: any, bad: any) => Promise.resolve(result()).then(ok, bad)
  return q
}

jest.mock('../supabase', () => ({
  supabase: {
    from: (t: string) => mockQuery(t),
    rpc: async () => ({ data: null, error: null }),
    functions: { invoke: async () => ({ data: null, error: null }) },
    storage: { from: () => ({ createSignedUrl: async () => ({ data: { signedUrl: 'https://x/signed' }, error: null }) }) },
  },
}))
jest.mock('../services/bookAmounts', () => ({
  ...jest.requireActual('../services/bookAmounts'),
  getBookRates: async () => { throw new Error('no rate in tests') },
}))
jest.mock('./InvoiceDialog', () => (p: any) => {
  mockState.invoiceProps = p
  return (
    <div data-testid="booking">
      {(p.reviewNotes || []).map((n: string, i: number) => <p key={i}>{n}</p>)}
    </div>
  )
})
jest.mock('./PartnerDialog', () => (p: any) => (
  <div data-testid="partner-dialog">{JSON.stringify({
    name: p.initialName, taxId: p.initialTaxId, registrationNumber: p.initialRegistrationNumber,
    address: p.initialAddress, city: p.initialCity,
  })}</div>
))

const row = (over: Record<string, unknown> = {}) => ({
  id: 'r1', sef_invoice_id: 555, document_number: 'IF-12/2026', document_type: 'Invoice',
  customer_name: 'Kupac Test d.o.o.', customer_vat_number: '100000002', customer_registration_number: '12345678',
  amount: 120000, currency: 'RSD', issue_date: '2026-10-31', due_date: '2026-11-15',
  sent_date: '2026-10-31T10:00:00Z', sef_status: 'Sent', sef_comment: null, state: 'pending',
  dismiss_reason: null, dismissed_at: null, imported_at: null, pdf_path: 'c/sales/555.pdf',
  ubl_xml: mockXml,
  ...over,
})

const twoOnOnePib = (pib: string) => [
  { id: 'k-a', name: 'Kupac Doo', tax_id: pib, registration_number: null },
  { id: 'k-b', name: 'Kupac Doo Beograd', tax_id: pib, registration_number: null },
]
const sharedSentence = (pib: string) => `Dva partnera imaju PIB ${pib}: Kupac Doo i Kupac Doo Beograd. `
  + 'Izaberite pravog ručno i uklonite duplikat u Partnerima; nov partner se ne nudi.'

const show = async () => {
  render(<SefSalesInboxDialog onClose={() => {}} onImported={() => {}} />)
  return (await screen.findByText('Kupac Test d.o.o.', { selector: 'span' })).closest('[data-row]') as HTMLElement
}

beforeEach(() => {
  mockState.rows = [row()]
  mockState.partners = []
  mockState.invoiceProps = null
})

afterEach(async () => { await act(async () => { await new Promise(r => setTimeout(r, 0)) }) })

describe('a customer already split over two partners', () => {
  it('names both on the row, and offers no third', async () => {
    mockState.partners = twoOnOnePib('100000002')
    const r = await show()
    expect(within(r).getByText(sharedSentence('100000002'))).toBeTruthy()
    expect(within(r).queryByText('Dodaj kupca')).toBeNull()
  })

  it('says so where the owner books, instead of asking to add the customer', async () => {
    const pib = doc.customerVatNumber as string
    mockState.partners = twoOnOnePib(pib)
    mockState.rows = [row({ customer_vat_number: pib })]
    await show()
    fireEvent.click(screen.getByText('Proknjiži'))
    const booking = await screen.findByTestId('booking')
    expect(mockState.invoiceProps.invoice.partner_id).toBeNull()
    expect(within(booking).getByText(sharedSentence(pib))).toBeTruthy()
    expect(within(booking).queryByText(/dodajte ga/)).toBeNull()
  })
})

describe('the customer handed to the booking', () => {
  it('is the one the document names, identifiers as bare digits, with no match', async () => {
    await show()
    fireEvent.click(screen.getByText('Proknjiži'))
    await screen.findByTestId('booking')
    expect(mockState.invoiceProps.sefSupplier).toEqual({
      name: doc.customerName, taxId: doc.customerVatNumber, registrationNumber: doc.customerRegistrationNumber,
      address: doc.customerAddress, city: doc.customerCity, matchedPartnerId: null,
    })
  })

  it('names the partner the inbox matched', async () => {
    mockState.partners = [{ id: 'k1', name: 'Kupac Test d.o.o.', tax_id: doc.customerVatNumber, registration_number: null }]
    await show()
    fireEvent.click(screen.getByText('Proknjiži'))
    await screen.findByTestId('booking')
    expect(mockState.invoiceProps.sefSupplier.matchedPartnerId).toBe('k1')
  })
})

describe('adding the customer from its row', () => {
  const xml = `<Invoice xmlns:cac="urn:cac" xmlns:cbc="urn:cbc"><cbc:ID>1</cbc:ID>
    <cac:AccountingSupplierParty><cac:Party>
      <cac:PostalAddress><cbc:StreetName>Nasa ulica 5</cbc:StreetName><cbc:CityName>Nasgrad</cbc:CityName></cac:PostalAddress>
    </cac:Party></cac:AccountingSupplierParty>
    <cac:AccountingCustomerParty><cac:Party>
      <cac:PartyName><cbc:Name>Kupac Test d.o.o.</cbc:Name></cac:PartyName>
      <cac:PostalAddress><cbc:StreetName>Test ulica</cbc:StreetName><cbc:BuildingNumber>2</cbc:BuildingNumber><cbc:CityName>Testgrad</cbc:CityName></cac:PostalAddress>
    </cac:Party></cac:AccountingCustomerParty></Invoice>`

  it('opens the form on its PIB, registration number, and the address from the stored document', async () => {
    mockState.rows = [row({ customer_vat_number: 'RS100000002', ubl_xml: xml })]
    await show()
    fireEvent.click(screen.getByText('Dodaj kupca'))
    const form = await screen.findByTestId('partner-dialog')
    expect(JSON.parse(form.textContent || '{}')).toEqual({
      name: 'Kupac Test d.o.o.', taxId: '100000002', registrationNumber: '12345678', address: 'Test ulica 2', city: 'Testgrad',
    })
  })

  it('opens it without an address where no document is stored', async () => {
    mockState.rows = [row({ ubl_xml: null })]
    await show()
    fireEvent.click(screen.getByText('Dodaj kupca'))
    const form = await screen.findByTestId('partner-dialog')
    expect(JSON.parse(form.textContent || '{}')).toMatchObject({ taxId: '100000002', address: '', city: '' })
  })
})
