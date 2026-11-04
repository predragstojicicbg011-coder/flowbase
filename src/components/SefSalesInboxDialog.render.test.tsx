import fs from 'fs'
import path from 'path'
import React from 'react'
import { render, screen, fireEvent, waitFor, act } from '@testing-library/react'
import SefSalesInboxDialog from './SefSalesInboxDialog'

// The inbox of invoices we issued: reading, booking through the invoice
// dialog, linking to a hand-typed invoice, declining. The database, storage
// and edge functions are mocked.

const mockXml = fs.readFileSync(path.join(__dirname, '..', 'services', 'sef', 'fixtures', 'sales-invoice-sample.xml'), 'utf8')

const mockState = {
  rows: [] as any[],
  ledger: [] as any[],
  partners: [] as any[],
  leases: [] as any[],
  projects: [] as any[],
  invoke: jest.fn(),
  rpc: jest.fn(),
  updates: [] as any[],
  invoiceProps: null as any,
}

const eqCalls: Array<[string, string, unknown]> = []

function mockQuery(table: string) {
  let isUpdate = false
  const result = () => {
    if (table === 'sef_inbox') return { data: isUpdate ? [{ id: 'r1' }] : mockState.rows, error: null }
    if (table === 'invoices') return { data: mockState.ledger, error: null }
    if (table === 'partners') return { data: mockState.partners, error: null }
    if (table === 'companies') return { data: [{ id: 'co1', name: 'Primer Gradnja d.o.o.' }], error: null }
    if (table === 'company_profiles') return { data: [{ company_id: 'co1', pib: '100000009', mb: '87654321' }], error: null }
    if (table === 'rental_leases') return { data: mockState.leases, error: null }
    if (table === 'projects') return { data: mockState.projects, error: null }
    return { data: [], error: null }
  }
  const q: any = {}
  for (const m of ['select', 'is', 'order', 'range', 'limit', 'in']) q[m] = () => q
  q.update = (v: unknown) => { isUpdate = true; mockState.updates.push(v); return q }
  q.eq = (col: string, val: unknown) => { eqCalls.push([table, col, val]); return q }
  q.maybeSingle = async () => ({ data: (mockState.rows[0] ?? null), error: null })
  q.then = (ok: any, bad: any) => Promise.resolve(result()).then(ok, bad)
  return q
}

jest.mock('../supabase', () => ({
  supabase: {
    from: (t: string) => mockQuery(t),
    rpc: (...args: any[]) => mockState.rpc(...args),
    functions: { invoke: (...args: any[]) => mockState.invoke(...args) },
    storage: { from: () => ({ createSignedUrl: async () => ({ data: { signedUrl: 'https://x/signed' }, error: null }) }) },
  },
}))
jest.mock('../services/bookAmounts', () => ({
  ...jest.requireActual('../services/bookAmounts'),
  getBookRates: async () => { throw new Error('no rate in tests') },
}))
jest.mock('./InvoiceDialog', () => (p: any) => {
  mockState.invoiceProps = p
  return <div data-testid="booking" />
})
jest.mock('./PartnerDialog', () => (p: any) => <div data-testid="partner-dialog">{p.initialName}</div>)

const row = (over: Record<string, unknown> = {}) => ({
  id: 'r1', sef_invoice_id: 555, document_number: 'IF-12/2026', document_type: 'Invoice',
  customer_name: 'Kupac Test d.o.o.', customer_vat_number: '100000002', customer_registration_number: '12345678',
  amount: 120000, currency: 'RSD', issue_date: '2026-10-31', due_date: '2026-11-15',
  sent_date: '2026-10-31T10:00:00Z', sef_status: 'Sent', sef_comment: null, state: 'pending',
  dismiss_reason: null, dismissed_at: null, imported_at: null, pdf_path: 'c/sales/555.pdf',
  ubl_xml: mockXml,
  ...over,
})

const buyer = { id: 'k1', name: 'Kupac Test d.o.o.', tax_id: '100000002', registration_number: '12345678' }

const show = async () => {
  render(<SefSalesInboxDialog onClose={() => {}} onImported={() => {}} />)
  await screen.findByText('Kupac Test d.o.o.', { selector: 'span' })
}

beforeEach(() => {
  mockState.rows = [row()]
  mockState.ledger = []
  mockState.partners = [buyer]
  mockState.leases = []
  mockState.projects = []
  mockState.invoke = jest.fn()
  mockState.rpc = jest.fn(async () => ({ data: null, error: null }))
  mockState.updates = []
  mockState.invoiceProps = null
  eqCalls.length = 0
})

describe('the sales inbox', () => {
  // Let the page's own follow-up updates (busy flags, reloads) land inside act.
  afterEach(async () => { await act(async () => { await new Promise(r => setTimeout(r, 0)) }) })
  it('reads only sales rows', async () => {
    await show()
    expect(eqCalls.filter(c => c[0] === 'sef_inbox').map(c => [c[1], c[2]])).toContainEqual(['direction', 'sales'])
    expect(screen.getByText('Kupac Test d.o.o.', { selector: 'span' })).toBeInTheDocument()
    expect(screen.getByText(/IF-12\/2026/)).toBeInTheDocument()
  })

  it('opens the invoice dialog with the drafted revenue invoice and its PDF', async () => {
    await show()
    fireEvent.click(screen.getByText('Proknjiži'))
    await screen.findByTestId('booking')
    expect(mockState.invoiceProps.invoice).toMatchObject({ type: 'revenue', partner_id: 'k1', amount: 120000 })
    expect(mockState.invoiceProps.sourceDocuments[0].label).toBe('Faktura (SEF)')
    expect(mockState.invoke).not.toHaveBeenCalled()
  })

  it('proposes the lease when the amount is the monthly rent', async () => {
    mockState.leases = [{
      id: 'l1', company_id: 'co1', project_id: 'zgrada', tenant_partner_id: 'k1', monthly_rent: 100000, currency: 'RSD',
      start_date: '2026-01-01', end_date: null, invoice_day: 1, payment_days: 15, active: true,
    }]
    await show()
    fireEvent.click(screen.getByText('Proknjiži'))
    await screen.findByTestId('booking')
    expect(mockState.invoiceProps.invoice).toMatchObject({
      revenue_kind: 'lease', lease_id: 'l1', service_month: '2026-10-01', project_id: 'zgrada',
    })
    expect(mockState.invoiceProps.reviewNotes.join(' ')).toMatch(/Predlog razvrstavanja — zakup/)
  })

  it('does not propose a lease of another company', async () => {
    mockState.leases = [{
      id: 'l9', company_id: 'other', project_id: 'zgrada', tenant_partner_id: 'k1', monthly_rent: 100000, currency: 'RSD',
      start_date: '2026-01-01', end_date: null, invoice_day: 1, payment_days: 15, active: true,
    }]
    mockState.projects = [{ id: 'pX', company_id: 'other', name: 'Tuđ projekat', code: 'TP', kind: 'construction', investor_partner_id: 'k1', active: true }]
    await show()
    fireEvent.click(screen.getByText('Proknjiži'))
    await screen.findByTestId('booking')
    expect(mockState.invoiceProps.invoice.lease_id).toBeUndefined()
    expect(mockState.invoiceProps.invoice.project_id).toBeUndefined()
    expect(mockState.invoiceProps.invoice.revenue_kind).toBeUndefined()
  })

  it('proposes the project of the customer when it is the investor of the only site', async () => {
    mockState.projects = [{ id: 'pr1', company_id: 'co1', name: 'Novi Beograd A1', code: 'NB-01', kind: 'construction', investor_partner_id: 'k1', active: true }]
    await show()
    fireEvent.click(screen.getByText('Proknjiži'))
    await screen.findByTestId('booking')
    expect(mockState.invoiceProps.invoice).toMatchObject({ revenue_kind: 'project', project_id: 'pr1' })
    expect(mockState.invoiceProps.invoice.lease_id).toBeUndefined()
  })

  it('proposes nothing it cannot back, and says so', async () => {
    await show()
    fireEvent.click(screen.getByText('Proknjiži'))
    await screen.findByTestId('booking')
    expect(mockState.invoiceProps.invoice.revenue_kind).toBeUndefined()
    expect(mockState.invoiceProps.reviewNotes.join(' ')).toMatch(/Razvrstavanje nije predloženo/)
  })

  it('marks the row booked after saving', async () => {
    await show()
    fireEvent.click(screen.getByText('Proknjiži'))
    await screen.findByTestId('booking')
    await act(async () => { await mockState.invoiceProps.onSaved('inv9') })
    await waitFor(() => expect(mockState.rpc).toHaveBeenCalledWith('sef_inbox_mark_imported', { p_id: 'r1', p_invoice_id: 'inv9' }))
  })

  it('does not offer booking for an invoice voided on SEF', async () => {
    mockState.rows = [row({ sef_status: 'Storno' })]
    await show()
    expect(screen.getByText('Stornirana na SEF-u')).toBeInTheDocument()
    expect(screen.queryByText('Proknjiži')).not.toBeInTheDocument()
  })

  it('links an invoice already typed in by hand', async () => {
    mockState.ledger = [{ id: 'hand1', invoice_number: 'IF-12/2026', invoice_date: '2026-10-31', amount: 120000, currency: 'RSD', partner_id: 'k1' }]
    await show()
    fireEvent.click(screen.getByText('Poveži sa postojećom'))
    await waitFor(() => expect(mockState.rpc).toHaveBeenCalledWith('sef_inbox_mark_imported', { p_id: 'r1', p_invoice_id: 'hand1' }))
  })

  it('offers to add an unknown customer', async () => {
    mockState.partners = []
    await show()
    fireEvent.click(screen.getByText('Dodaj kupca'))
    expect(await screen.findByTestId('partner-dialog')).toHaveTextContent('Kupac Test d.o.o.')
  })

  it('needs a reason to decline', async () => {
    await show()
    fireEvent.click(screen.getByText('Odbij'))
    expect(screen.getByText('Odbij ovu fakturu')).toBeDisabled()
    expect(mockState.updates).toHaveLength(0)
    fireEvent.change(screen.getByLabelText('Razlog'), { target: { value: 'Pogresan kupac' } })
    fireEvent.click(screen.getByText('Odbij ovu fakturu'))
    await waitFor(() => expect(mockState.updates).toHaveLength(1))
    expect(mockState.updates[0]).toMatchObject({ state: 'dismissed', dismiss_reason: 'Pogresan kupac' })
  })

  it('opens an advance invoice in the dialog with no P&L', async () => {
    mockState.rows = [row({ ubl_xml: mockXml.replace('<cbc:InvoiceTypeCode>380<', '<cbc:InvoiceTypeCode>386<') })]
    await show()
    fireEvent.click(screen.getByText('Proknjiži'))
    await waitFor(() => expect(mockState.invoiceProps).not.toBeNull())
    expect(mockState.invoiceProps.invoice).toMatchObject({ type: 'revenue', document_type: 'advance_invoice', pl_impact: false })
  })

  it('shows Paid on SEF as information only', async () => {
    mockState.rows = [row({ sef_status: 'Paid' })]
    await show()
    expect(screen.getByText('Plaćena (SEF)')).toBeInTheDocument()
    expect(screen.getByText('Proknjiži')).toBeEnabled()
  })
})
