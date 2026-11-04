import React from 'react'
import { render, screen, fireEvent, waitFor } from '@testing-library/react'
import InvoiceDialog from './InvoiceDialog'

// Every revenue invoice is a project, a lease or sales of services: what the
// form asks, what it refuses and what it sends. The database is mocked.

const mockState = {
  leases: [] as any[],
  billed: [] as any[],
  inserted: [] as any[],
  updated: [] as any[],
  splits: [] as any[],
  insertError: null as null | { code?: string; message: string },
}

function mockQuery(table: string) {
  const result = () => {
    if (table === 'rental_leases') return { data: mockState.leases, error: null }
    if (table === 'invoices') return { data: mockState.billed, error: null }
    return { data: [], error: null }
  }
  const q: any = {}
  for (const m of ['select', 'eq', 'neq', 'is', 'in', 'gt', 'order', 'range', 'limit']) q[m] = () => q
  q.insert = (payload: any) => {
    mockState.inserted.push(payload)
    const ins: any = {}
    ins.select = () => ins
    ins.single = async () => (mockState.insertError
      ? { data: null, error: mockState.insertError }
      : { data: { id: 'new1' }, error: null })
    return ins
  }
  q.update = (payload: any) => {
    mockState.updated.push(payload)
    const upd: any = {}
    upd.eq = () => upd
    upd.select = () => upd
    upd.then = (ok: any, bad: any) => Promise.resolve({ data: [{ id: 'x1' }], error: null }).then(ok, bad)
    return upd
  }
  q.maybeSingle = async () => result()
  q.single = async () => result()
  q.then = (ok: any, bad: any) => Promise.resolve(result()).then(ok, bad)
  return q
}

jest.mock('../supabase', () => ({
  supabase: {
    from: (t: string) => mockQuery(t),
    rpc: () => Promise.resolve({ data: null, error: null }),
  },
}))
jest.mock('../contexts/CompaniesContext', () => ({
  useCompanies: () => ({
    companies: [{ id: 'co1', name: 'Firma', currencies: ['RSD', 'EUR'] }],
    defaultCompany: { id: 'co1', name: 'Firma' },
    showPicker: false,
  }),
}))
jest.mock('../contexts/ProjectsContext', () => ({
  useProjects: () => ({
    projects: [
      { id: 'zgrada', name: 'Poslovna zgrada Zemun', code: 'ZG', kind: 'rental', active: true },
      { id: 'pr1', name: 'Novi Beograd A1', code: 'NB-01', kind: 'construction', active: true },
    ],
  }),
}))
jest.mock('../services/allPartners', () => ({
  fetchAllPartners: async () => [{ id: 'k1', name: 'Zakupac Market' }],
}))
jest.mock('../services/quickFillStore', () => ({
  fetchScripts: async () => [], saveScript: async () => ({}), whyNotSavable: () => null,
}))
jest.mock('../services/saveSplits', () => ({
  loadSplits: async () => mockState.splits,
  saveSplits: async (_c: any, _s: string, _id: string, _p: any, lines: any[]) => ({ ok: true, lines: lines.length, message: '' }),
}))
jest.mock('./SplitEditor', () => () => null)
jest.mock('./ProjectSelect', () => () => null)
jest.mock('./PartnerDialog', () => () => null)

const lease = (over: Record<string, unknown> = {}) => ({
  id: 'l1', company_id: 'co1', project_id: 'zgrada', tenant_partner_id: 'k1', monthly_rent: 50000,
  currency: 'RSD', start_date: '2026-01-01', end_date: null, invoice_day: 1, payment_days: 15, active: true,
  ...over,
})

/** A revenue invoice as the sales inbox or the Prihodi page hands it over. */
const draft = (over: Record<string, unknown> = {}) => ({
  company_id: 'co1', partner_id: 'k1', partners: { name: 'Zakupac Market' }, type: 'revenue',
  invoice_number: 'IF-12/2026', invoice_date: '2026-10-31', currency: 'RSD', amount: 50000,
  exchange_rate: 1, eur_rate: 117.2, revenue_stream: 'Ostalo',
  ...over,
})

const next = () => fireEvent.click(screen.getByText('Dalje'))
const save = () => fireEvent.click(screen.getByText(/Proknjiži fakturu|Sačuvaj izmene/))
const radio = (name: string) => screen.getByRole('radio', { name }) as HTMLInputElement

/** To the step with the classification, once the leases are in. */
const toClassification = async () => {
  next(); next()
  await screen.findByRole('group', { name: 'Razvrstavanje' })
}

beforeEach(() => {
  mockState.leases = [lease()]
  mockState.billed = []
  mockState.inserted = []
  mockState.updated = []
  mockState.splits = []
  mockState.insertError = null
})

describe('classification of a revenue invoice', () => {
  it('requires a classification on a revenue invoice', async () => {
    render(<InvoiceDialog onClose={() => {}} invoice={draft()} />)
    await toClassification()
    expect(radio('Projekat').checked).toBe(false)
    expect(radio('Zakup').checked).toBe(false)
    expect(radio('Prodaja usluga').checked).toBe(false)
    next()
    save()
    expect((await screen.findAllByText(/Izaberite: projekat, zakup ili prodaja usluga\./)).length).toBeGreaterThan(0)
    expect(mockState.inserted).toHaveLength(0)
  })

  it('asks for the lease and month once rent is picked', async () => {
    render(<InvoiceDialog onClose={() => {}} invoice={draft()} />)
    await toClassification()
    fireEvent.click(radio('Zakup'))
    next()
    save()
    expect((await screen.findAllByText(/Izaberite zakup i mesec usluge\./)).length).toBeGreaterThan(0)
    expect(mockState.inserted).toHaveLength(0)
  })

  it('saves a rent invoice with its lease, month and building', async () => {
    render(<InvoiceDialog onClose={() => {}} invoice={draft()} />)
    await toClassification()
    fireEvent.click(radio('Zakup'))
    const pick = screen.getByRole('combobox', { name: 'Zakup' }) as HTMLSelectElement
    await waitFor(() => expect(pick.querySelectorAll('option').length).toBe(2))
    expect(pick.querySelectorAll('option')[1].textContent).toBe('Zakupac Market · ZG · Poslovna zgrada Zemun')
    fireEvent.change(pick, { target: { value: 'l1' } })
    fireEvent.change(screen.getByLabelText('Mesec usluge'), { target: { value: '2026-10' } })
    next()
    save()
    await waitFor(() => expect(mockState.inserted).toHaveLength(1))
    expect(mockState.inserted[0]).toMatchObject({
      type: 'revenue', lease_id: 'l1', service_month: '2026-10-01', project_id: 'zgrada',
    })
  })

  it('warns that a month is already billed', async () => {
    mockState.billed = [{ lease_id: 'l1', service_month: '2026-10-01' }]
    render(<InvoiceDialog onClose={() => {}} invoice={draft()} />)
    await toClassification()
    fireEvent.click(radio('Zakup'))
    const pick = screen.getByRole('combobox', { name: 'Zakup' }) as HTMLSelectElement
    await waitFor(() => expect(pick.querySelectorAll('option').length).toBe(2))
    fireEvent.change(pick, { target: { value: 'l1' } })
    fireEvent.change(screen.getByLabelText('Mesec usluge'), { target: { value: '2026-10' } })
    expect(await screen.findByText('Za ovaj zakup je mesec već fakturisan.')).toBeInTheDocument()
    fireEvent.change(screen.getByLabelText('Mesec usluge'), { target: { value: '2026-11' } })
    expect(screen.queryByText('Za ovaj zakup je mesec već fakturisan.')).not.toBeInTheDocument()
  })

  it('saves services with no project', async () => {
    render(<InvoiceDialog onClose={() => {}} invoice={draft({ project_id: 'pr1' })} />)
    await toClassification()
    expect(radio('Projekat').checked).toBe(true)
    fireEvent.click(radio('Prodaja usluga'))
    next()
    save()
    await waitFor(() => expect(mockState.inserted).toHaveLength(1))
    expect(mockState.inserted[0].project_id).toBeNull()
    expect(mockState.inserted[0].lease_id).toBeUndefined()
    expect(mockState.inserted[0].service_month).toBeUndefined()
  })

  it('saves a project invoice on its project, with no lease', async () => {
    render(<InvoiceDialog onClose={() => {}} invoice={draft({ project_id: 'pr1' })} />)
    await toClassification()
    next()
    save()
    await waitFor(() => expect(mockState.inserted).toHaveLength(1))
    expect(mockState.inserted[0]).toMatchObject({ project_id: 'pr1' })
    expect(mockState.inserted[0].lease_id).toBeUndefined()
  })

  it('takes the classification a draft arrives with', async () => {
    render(<InvoiceDialog onClose={() => {}}
      invoice={draft({ revenue_kind: 'lease', lease_id: 'l1', service_month: '2026-10-01', project_id: 'zgrada', classification_why: 'Iznos je jednak zakupnini.' })} />)
    await toClassification()
    expect(radio('Zakup').checked).toBe(true)
    expect(screen.getByText('Iznos je jednak zakupnini.')).toBeInTheDocument()
    expect((screen.getByLabelText('Mesec usluge') as HTMLInputElement).value).toBe('2026-10')
    next()
    save()
    await waitFor(() => expect(mockState.inserted).toHaveLength(1))
    expect(mockState.inserted[0]).toMatchObject({ lease_id: 'l1', service_month: '2026-10-01', project_id: 'zgrada' })
  })

  it('explains a month already billed instead of the database error', async () => {
    mockState.insertError = { code: '23505', message: 'duplicate key value violates unique constraint "invoices_lease_month_key"' }
    render(<InvoiceDialog onClose={() => {}} invoice={draft({ revenue_kind: 'lease', lease_id: 'l1', service_month: '2026-10-01', project_id: 'zgrada' })} />)
    await toClassification()
    next()
    save()
    expect(await screen.findByText('Za ovaj zakup i mesec faktura već postoji.')).toBeInTheDocument()
    expect(screen.queryByText(/invoices_lease_month_key/)).not.toBeInTheDocument()
  })

  it('saves a split revenue invoice as a project: its lines carry the projects', async () => {
    mockState.splits = [
      { amount: 30000, pl_category: 'Zakup', department: 'Prihodi', project_id: 'pr1', sort_order: 0 },
      { amount: 20000, pl_category: 'Zakup', department: 'Prihodi', project_id: 'zgrada', sort_order: 1 },
    ]
    render(<InvoiceDialog onClose={() => {}} invoice={draft({ id: 'x1', project_id: null })} />)
    next(); next()
    await screen.findByRole('group', { name: 'Razvrstavanje' })
    await waitFor(() => expect(radio('Projekat').checked).toBe(true))
    expect(radio('Prodaja usluga').checked).toBe(false)
    expect(screen.getByText(/svaka stavka iznad nosi svoj projekat/)).toBeInTheDocument()
    next()
    save()
    await waitFor(() => expect(mockState.updated).toHaveLength(1))
    expect(mockState.updated[0].project_id).toBeNull()
    expect(screen.queryByText(/Izaberite projekat/)).not.toBeInTheDocument()
  })

  it('shows another unique refusal as it is, not as a duplicate rent', async () => {
    mockState.insertError = { code: '23505', message: 'Izlazna faktura broj IF-12/2026 je već proknjižena.' }
    render(<InvoiceDialog onClose={() => {}} invoice={draft({ revenue_kind: 'lease', lease_id: 'l1', service_month: '2026-10-01', project_id: 'zgrada' })} />)
    await toClassification()
    next()
    save()
    expect(await screen.findByText('Izlazna faktura broj IF-12/2026 je već proknjižena.')).toBeInTheDocument()
    expect(screen.queryByText('Za ovaj zakup i mesec faktura već postoji.')).not.toBeInTheDocument()
  })

  it('keeps rent to invoices', async () => {
    render(<InvoiceDialog onClose={() => {}} invoice={draft({ revenue_kind: 'lease', lease_id: 'l1', service_month: '2026-10-01', project_id: 'zgrada', amount: -50000 })} />)
    await toClassification()
    next()
    save()
    expect((await screen.findAllByText(/Zakup se bira samo na računu/)).length).toBeGreaterThan(0)
    expect(mockState.inserted).toHaveLength(0)
  })

  it('does not ask an expense for a classification', async () => {
    render(<InvoiceDialog onClose={() => {}} />)
    next(); next()
    expect(screen.queryByRole('group', { name: 'Razvrstavanje' })).not.toBeInTheDocument()
  })
})
