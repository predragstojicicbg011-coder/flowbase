import React from 'react'
import { render, screen, fireEvent, waitFor } from '@testing-library/react'
import InvoiceDialog from './InvoiceDialog'

// The document type in the entry form: bill, credit note, debit note, and a
// note's link to the bill it adjusts. The database is mocked: these are about
// what the form shows, fills in and sends.

const mockState = {
  bases: [] as any[],
  splits: {} as Record<string, any[]>,
  inserted: [] as any[],
  savedSplits: [] as any[],
}

function mockQuery(table: string) {
  const result = () => {
    if (table === 'v_invoice_status') return { data: mockState.bases, error: null }
    if (table === 'pl_categories') return { data: [{ id: 'c1', name: 'Materijal', type: 'expense', sort_order: 1 }], error: null }
    if (table === 'departments') return { data: [{ id: 'd1', name: 'Gradilište', sort_order: 1 }], error: null }
    return { data: [], error: null }
  }
  const q: any = {}
  for (const m of ['select', 'eq', 'neq', 'is', 'in', 'gt', 'order', 'range', 'limit']) q[m] = () => q
  q.insert = (payload: any) => {
    mockState.inserted.push(payload)
    const ins: any = {}
    ins.select = () => ins
    ins.single = async () => ({ data: { id: 'new1' }, error: null })
    return ins
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
jest.mock('../contexts/ProjectsContext', () => ({ useProjects: () => ({ projects: [] }) }))
jest.mock('../services/allPartners', () => ({
  fetchAllPartners: async () => [{ id: 'p1', name: 'Dobavljač doo' }],
}))
jest.mock('../services/quickFillStore', () => ({
  fetchScripts: async () => [], saveScript: async () => ({}), whyNotSavable: () => null,
}))
jest.mock('../services/saveSplits', () => ({
  loadSplits: async (_c: any, _s: string, id: string) => mockState.splits[id] || [],
  saveSplits: async (_c: any, _s: string, _id: string, _p: any, lines: any[]) => {
    mockState.savedSplits.push(lines)
    return { ok: true, lines: lines.length, message: '' }
  },
}))
jest.mock('./SplitEditor', () => (p: any) => (
  <div data-testid="split">{p.lines.map((l: any) => l.amount).join('|')}</div>
))
jest.mock('./ProjectSelect', () => () => null)
jest.mock('./PartnerDialog', () => () => null)

const base = (over: Record<string, unknown> = {}) => ({
  id: 'b1', invoice_number: 'R-1/26', invoice_date: '2026-10-01', type: 'expense',
  amount: 120000, adjustments: 0, paid_amount: 0, amount_due: 120000, currency: 'RSD',
  exchange_rate: 1, eur_rate: 117.2, pl_category: 'Materijal', pl_subcategory: null,
  department: 'Gradilište', dept_subcategory: null, expense_description: null,
  project_id: 'pr1', pl_impact: true, cf_type: null, revenue_stream: null,
  ...over,
})

/** A credit note as the SEF inbox hands it over: no id, everything filled in. */
const draft = (over: Record<string, unknown> = {}) => ({
  company_id: 'co1', partner_id: 'p1', partners: { name: 'Dobavljač doo' },
  invoice_number: 'KO-5/26', invoice_date: '2026-10-10', type: 'expense',
  currency: 'RSD', amount: -30000, exchange_rate: 1, eur_rate: 117.2,
  ...over,
})

const typeSelect = () => screen.getByLabelText('Vrsta dokumenta') as HTMLSelectElement
const next = () => fireEvent.click(screen.getByText('Dalje'))

beforeEach(() => {
  mockState.bases = [base()]
  mockState.splits = {}
  mockState.inserted = []
  mockState.savedSplits = []
})

describe('document type in the entry form', () => {
  it('starts as a bill, follows the sign until picked by hand', async () => {
    render(<InvoiceDialog onClose={() => {}} />)
    expect(typeSelect().value).toBe('invoice')
    next()
    const amount = screen.getByPlaceholderText('0.00')
    fireEvent.change(amount, { target: { value: '-100' } })
    expect(typeSelect().value).toBe('credit_note')
    fireEvent.change(typeSelect(), { target: { value: 'invoice' } })
    fireEvent.change(amount, { target: { value: '-50' } })
    expect(typeSelect().value).toBe('invoice')
  })

  it('a credit note picks its bill and takes the bill\'s booking', async () => {
    render(<InvoiceDialog onClose={() => {}} creditNote invoice={draft()} />)
    expect(typeSelect().value).toBe('credit_note')
    const pick = await screen.findByLabelText('Odnosi se na račun') as HTMLSelectElement
    await waitFor(() => expect(pick.querySelectorAll('option').length).toBe(2))
    fireEvent.change(pick, { target: { value: 'b1' } })
    next(); next(); next()
    fireEvent.click(screen.getByText(/Proknjiži fakturu|Sačuvaj izmene/))
    await waitFor(() => expect(mockState.inserted).toHaveLength(1))
    expect(mockState.inserted[0]).toMatchObject({
      document_type: 'credit_note', adjusts_invoice_id: 'b1', amount: -30000,
      pl_category: 'Materijal', department: 'Gradilište', project_id: 'pr1',
    })
  })

  it('the bill\'s split comes over scaled to the note', async () => {
    mockState.splits.b1 = [
      { amount: 80000, pl_category: 'Materijal', department: 'Gradilište', project_id: 'pr1', sort_order: 0 },
      { amount: 40000, pl_category: 'Materijal', department: 'Gradilište', project_id: 'pr2', sort_order: 1 },
    ]
    render(<InvoiceDialog onClose={() => {}} creditNote invoice={draft()} />)
    const pick = await screen.findByLabelText('Odnosi se na račun') as HTMLSelectElement
    await waitFor(() => expect(pick.querySelectorAll('option').length).toBe(2))
    fireEvent.change(pick, { target: { value: 'b1' } })
    next(); next()
    await waitFor(() => expect(screen.getByTestId('split').textContent).toBe('-20000|-10000'))
    next()
    fireEvent.click(screen.getByText(/Proknjiži fakturu|Sačuvaj izmene/))
    await waitFor(() => expect(mockState.savedSplits).toHaveLength(1))
    expect(mockState.savedSplits[0].map((l: any) => l.amount)).toEqual([-20000, -10000])
  })

  it('a note with no bill says it will be linked later, and is sent unlinked', async () => {
    render(<InvoiceDialog onClose={() => {}} creditNote invoice={draft({ pl_category: 'Materijal', department: 'Gradilište' })} />)
    await screen.findByLabelText('Odnosi se na račun')
    expect(screen.getByText('Nije vezano za račun — veže se kasnije')).toBeInTheDocument()
  })

  it('a debit note with a minus is refused', async () => {
    render(<InvoiceDialog onClose={() => {}} />)
    fireEvent.change(typeSelect(), { target: { value: 'debit_note' } })
    next()
    const amount = screen.getByPlaceholderText('0.00')
    fireEvent.change(amount, { target: { value: '-5' } })
    fireEvent.blur(amount)
    expect(await screen.findByText('Knjižno zaduženje mora imati pozitivan iznos')).toBeInTheDocument()
    expect(typeSelect().value).toBe('debit_note')
  })
})
