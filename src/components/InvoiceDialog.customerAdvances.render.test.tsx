import React from 'react'
import { render, screen, fireEvent, waitFor } from '@testing-library/react'
import InvoiceDialog from './InvoiceDialog'

// Customer advances in the entry form: a proforma and an advance invoice we
// issue, the paid proformas it covers, and a final invoice with the advances
// it uses. The database is mocked: these are about what the form asks for and
// what it sends.

const mockState = {
  /** v_invoice_status rows by document_type asked for. */
  status: {} as Record<string, any[]>,
  /** Every v_invoice_status read: its filters. */
  reads: [] as Record<string, any>[],
  inserted: [] as { table: string; payload: any }[],
  rpc: [] as { name: string; args: any }[],
}

function mockQuery(table: string) {
  const filters: Record<string, any> = {}
  const result = () => {
    if (table === 'v_invoice_status') {
      mockState.reads.push({ ...filters })
      return { data: mockState.status[filters.document_type] || [], error: null }
    }
    return { data: [], error: null }
  }
  const q: any = {}
  for (const m of ['select', 'neq', 'is', 'in', 'gt', 'order', 'range', 'limit']) q[m] = () => q
  q.eq = (col: string, val: any) => { filters[col] = val; return q }
  q.insert = (payload: any) => {
    mockState.inserted.push({ table, payload })
    const ins: any = {}
    ins.select = () => ins
    ins.single = async () => ({ data: { id: table === 'invoices' ? `new-${mockState.inserted.length}` : 'x' }, error: null })
    ins.then = (ok: any, bad: any) => Promise.resolve({ data: [{ id: 'x' }], error: null }).then(ok, bad)
    return ins
  }
  q.update = () => {
    const upd: any = {}
    upd.eq = () => upd
    upd.select = () => upd
    upd.then = (ok: any, bad: any) => Promise.resolve({ data: [{ id: 'x1' }], error: null }).then(ok, bad)
    return upd
  }
  q.delete = () => q
  q.maybeSingle = async () => result()
  q.single = async () => result()
  q.then = (ok: any, bad: any) => Promise.resolve(result()).then(ok, bad)
  return q
}

jest.mock('../supabase', () => ({
  supabase: {
    from: (t: string) => mockQuery(t),
    rpc: (name: string, args: any) => { mockState.rpc.push({ name, args }); return Promise.resolve({ data: null, error: null }) },
  },
}))
jest.mock('../contexts/CompaniesContext', () => ({
  useCompanies: () => ({
    companies: [{ id: 'co1', name: 'Firma', currencies: ['RSD', 'EUR'] }],
    defaultCompany: { id: 'co1', name: 'Firma' },
    showPicker: false,
  }),
}))
jest.mock('../contexts/ProjectsContext', () => ({ useProjects: () => ({ projects: [] }) }))
jest.mock('../services/allPartners', () => ({
  fetchAllPartners: async () => [{ id: 'k1', name: 'Kupac Test d.o.o.' }],
}))
jest.mock('../services/quickFillStore', () => ({
  fetchScripts: async () => [], saveScript: async () => ({}), whyNotSavable: () => null,
}))
jest.mock('../services/saveSplits', () => ({
  loadSplits: async () => [],
  saveSplits: async (_c: any, _s: string, _id: string, _p: any, lines: any[]) => ({ ok: true, lines: lines.length, message: '' }),
}))
jest.mock('./SplitEditor', () => () => null)
jest.mock('./ProjectSelect', () => () => null)
jest.mock('./PartnerDialog', () => () => null)

/** A revenue invoice as the sales inbox hands it over, classified as sales of services. */
const draft = (over: Record<string, unknown> = {}) => ({
  company_id: 'co1', partner_id: 'k1', partners: { name: 'Kupac Test d.o.o.' }, type: 'revenue',
  invoice_number: 'IF-15/2026', invoice_date: '2026-11-02', currency: 'RSD', amount: 120000,
  exchange_rate: 1, eur_rate: 117.2, revenue_kind: 'services', revenue_stream: 'Ostalo',
  ...over,
})

const proforma = (over: Record<string, unknown> = {}) => ({
  id: 'pf1', invoice_number: '177/2026', invoice_date: '2026-09-10', document_type: 'proforma',
  currency: 'RSD', amount: 120000, paid_amount: 120000, covered: 0, ...over,
})
const advance = (over: Record<string, unknown> = {}) => ({
  id: 'av1', invoice_number: 'AV-7/2026', invoice_date: '2026-09-15', document_type: 'advance_invoice',
  currency: 'RSD', amount: 120000, advance_open: 120000, ...over,
})
const final = (over: Record<string, unknown> = {}) => draft({
  amount: 300000,
  advance_refs: [{ number: 'AV-7/2026', date: '2026-09-15', amount: 120000 }], advance_used: 120000, ...over,
})

const next = () => fireEvent.click(screen.getByText('Dalje'))
const post = () => fireEvent.click(screen.getByText(/Proknjiži fakturu|Sačuvaj izmene/))
const insertedInto = (table: string) => mockState.inserted.filter(i => i.table === table).map(i => i.payload)
const links = () => mockState.rpc.filter(c => c.name === 'replace_advance_links').map(c => c.args)

beforeEach(() => {
  mockState.status = {}
  mockState.reads = []
  mockState.inserted = []
  mockState.rpc = []
})

describe('a customer proforma', () => {
  it('posts a customer proforma with no P&L and no revenue stream', async () => {
    render(<InvoiceDialog onClose={() => {}} invoice={draft({ document_type: 'proforma', invoice_number: '177/2026' })} />)
    expect((screen.getByLabelText('Vrsta dokumenta') as HTMLSelectElement).value).toBe('proforma')
    next(); next(); next(); post()
    await waitFor(() => expect(insertedInto('invoices')).toHaveLength(1))
    expect(insertedInto('invoices')[0]).toMatchObject({
      type: 'revenue', document_type: 'proforma', pl_impact: false, revenue_stream: null, amount: 120000,
    })
  })
})

describe('a customer advance invoice', () => {
  it('covers the customer proforma named on a SEF advance invoice', async () => {
    mockState.status.proforma = [proforma({ id: 'pf0', invoice_number: '1', paid_amount: 50000 }), proforma()]
    render(<InvoiceDialog onClose={() => {}} invoice={draft({ document_type: 'advance_invoice', pl_impact: false, invoice_number: 'AV-7/2026', proforma_hints: ['177/2026'] })} />)
    const cover = await screen.findByLabelText('Pokriće 177/2026') as HTMLInputElement
    await waitFor(() => expect(cover.value).toBe('120000'))
    next(); next(); next(); post()
    await waitFor(() => expect(links()).toHaveLength(1))
    expect(insertedInto('invoices')[0]).toMatchObject({ type: 'revenue', document_type: 'advance_invoice', pl_impact: false })
    expect(links()[0]).toEqual({ p_invoice: 'new-1', p_coverage: [{ proforma_id: 'pf1', amount: 120000 }], p_usage: null })
  })
})

describe('a customer final invoice', () => {
  it('books the final invoice in full and uses the advance', async () => {
    mockState.status.advance_invoice = [advance()]
    render(<InvoiceDialog onClose={() => {}} invoice={final()} />)
    const use = await screen.findByLabelText('Avans AV-7/2026') as HTMLInputElement
    await waitFor(() => expect(use.value).toBe('120000'))
    expect(screen.getByText('Kupac ima otvorene avanse: 1 avansni račun, ukupno 120.000,00 RSD')).toBeInTheDocument()
    next(); next(); next(); post()
    await waitFor(() => expect(links()).toHaveLength(1))
    expect(insertedInto('invoices')[0]).toMatchObject({ type: 'revenue', document_type: 'invoice', amount: 300000, pl_impact: true })
    expect(links()[0]).toEqual({ p_invoice: 'new-1', p_coverage: null, p_usage: [{ advance_invoice_id: 'av1', amount: 120000 }] })
  })

  it('will not post a final invoice whose advance is not in the books', async () => {
    render(<InvoiceDialog onClose={() => {}} invoice={final()} />)
    expect(await screen.findByText('Konačna faktura navodi avansni račun AV-7/2026 koji nije u knjigama.')).toBeInTheDocument()
    next(); next(); next(); post()
    await new Promise(r => setTimeout(r, 50))
    expect(insertedInto('invoices')).toHaveLength(0)
    for (let i = 0; i < 3; i++) fireEvent.click(screen.getByText('Nazad'))
    fireEvent.click(screen.getByText('Dodaj avansni račun iz ranijeg perioda'))
    next(); next(); next(); post()
    await waitFor(() => expect(links()).toHaveLength(1))
    expect(insertedInto('invoices')[1]).toMatchObject({
      type: 'revenue', document_type: 'advance_invoice', prior_period: true, invoice_number: 'AV-7/2026', amount: 120000, pl_impact: false,
    })
    expect(links()[0].p_usage).toEqual([{ advance_invoice_id: 'new-2', amount: 120000 }])
  })

  it('reads only customer advances for a revenue invoice', async () => {
    mockState.status.advance_invoice = [advance()]
    render(<InvoiceDialog onClose={() => {}} invoice={final()} />)
    await screen.findByLabelText('Avans AV-7/2026')
    const reads = mockState.reads.filter(r => r.document_type === 'advance_invoice')
    expect(reads.length).toBeGreaterThan(0)
    for (const r of reads) expect(r.type).toBe('revenue')
  })
})

describe('the old deduction of an advance', () => {
  it('shows no advance deduction field on a new revenue invoice', async () => {
    render(<InvoiceDialog onClose={() => {}} invoice={draft()} />)
    next(); next()
    await screen.findByRole('group', { name: 'Razvrstavanje' })
    expect(screen.queryByText('Odbijeni avans')).not.toBeInTheDocument()
  })

  it('keeps the deduction of an invoice that already has one', async () => {
    mockState.status.advance_invoice = [advance()]
    render(<InvoiceDialog onClose={() => {}} invoice={draft({ id: 'inv1', revenue_kind: 'project', project_id: 'pr1', advance_deducted: 5000 })} />)
    next(); next()
    await screen.findByRole('group', { name: 'Razvrstavanje' })
    expect(screen.getByText('Odbijeni avans')).toBeInTheDocument()
    // The two ways of using an advance are never offered together.
    expect(screen.queryByRole('group', { name: 'Avansi' })).not.toBeInTheDocument()
  })
})
