import React from 'react'
import { render, screen, fireEvent, waitFor } from '@testing-library/react'
import InvoiceDialog from './InvoiceDialog'

// A step after the invoice insert fails: the invoice exists, so the dialog
// says so and Post stays disabled. A second press could only add a second
// invoice that nothing links or reports. Names and numbers are invented.

const mockState = {
  inserted: [] as { table: string; payload: any }[],
  splitsFail: false,
}

function mockQuery(table: string) {
  const result = () => {
    if (table === 'pl_categories') return { data: [{ id: 'c1', name: 'Materijal', type: 'expense', sort_order: 1 }], error: null }
    if (table === 'departments') return { data: [{ id: 'd1', name: 'Uprava', sort_order: 1 }], error: null }
    return { data: [], error: null }
  }
  const q: any = {}
  for (const m of ['select', 'eq', 'neq', 'is', 'in', 'gt', 'order', 'range', 'limit']) q[m] = () => q
  q.insert = (payload: any) => {
    mockState.inserted.push({ table, payload })
    const ins: any = {}
    ins.select = () => ins
    ins.single = async () => ({ data: { id: `${table}-new`, ...payload }, error: null })
    return ins
  }
  q.maybeSingle = async () => result()
  q.single = async () => result()
  q.then = (ok: any, bad: any) => Promise.resolve(result()).then(ok, bad)
  return q
}

jest.mock('../supabase', () => ({
  supabase: { from: (t: string) => mockQuery(t), rpc: () => Promise.resolve({ data: null, error: null }) },
}))
jest.mock('../contexts/CompaniesContext', () => ({
  useCompanies: () => ({ companies: [{ id: 'co1', name: 'Firma', currencies: ['RSD'] }], defaultCompany: { id: 'co1', name: 'Firma' }, showPicker: false }),
}))
jest.mock('../contexts/ProjectsContext', () => ({ useProjects: () => ({ projects: [] }) }))
jest.mock('../services/allPartners', () => ({ fetchAllPartners: async () => [{ id: 'p1', name: 'Alfa Doo' }] }))
jest.mock('../services/quickFillStore', () => ({ fetchScripts: async () => [], saveScript: async () => ({}), whyNotSavable: () => null }))
jest.mock('../services/saveSplits', () => ({
  loadSplits: async () => [],
  saveSplits: async () => (mockState.splitsFail
    ? { ok: false, lines: 0, message: 'Faktura je sačuvana, ali podela nije: permission denied' }
    : { ok: true, lines: 0, message: '' }),
}))
jest.mock('./SplitEditor', () => () => null)
jest.mock('./ProjectSelect', () => () => null)
jest.mock('./PartnerDialog', () => () => null)

const draft = {
  company_id: 'co1', partner_id: 'p1', partners: { name: 'Alfa Doo' }, invoice_number: 'F-7/26',
  invoice_date: '2026-10-10', type: 'expense', currency: 'RSD', amount: 1000, exchange_rate: 1, eur_rate: 117.2,
  pl_category: 'Materijal', department: 'Uprava',
}

const next = () => fireEvent.click(screen.getByText('Dalje'))
const postButton = () => screen.getByText(/Proknjiži fakturu|Sačuvaj izmene/).closest('button') as HTMLButtonElement

beforeEach(() => {
  mockState.inserted = []
  mockState.splitsFail = false
})

describe('a failure after the invoice exists', () => {
  it('says the invoice was posted, and Post cannot add a second one', async () => {
    mockState.splitsFail = true
    render(<InvoiceDialog onClose={() => {}} invoice={draft} />)
    await screen.findByDisplayValue('Alfa Doo')
    next(); next(); next()
    fireEvent.click(postButton())
    expect(await screen.findByText('Faktura JE proknjižena — F-7/26 je u knjigama')).toBeInTheDocument()
    expect(screen.getByText('Faktura je sačuvana, ali podela nije: permission denied')).toBeInTheDocument()
    expect(screen.queryByText('Faktura nije proknjižena')).not.toBeInTheDocument()
    expect(screen.getByText('Ono što nije uspelo došlo je posle nje, a ponovno knjiženje bi samo dodalo drugu. Zatvorite ovo i ispravite iz knjige faktura.')).toBeInTheDocument()
    expect(postButton().disabled).toBe(true)
    fireEvent.click(postButton())
    await waitFor(() => expect(mockState.inserted.filter(i => i.table === 'invoices')).toHaveLength(1))
  })
})
