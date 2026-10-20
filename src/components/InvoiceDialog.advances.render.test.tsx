import React from 'react'
import { render, screen, fireEvent, waitFor } from '@testing-library/react'
import InvoiceDialog from './InvoiceDialog'

// Supplier advances in the entry form: a proforma, an advance invoice and the
// paid proformas it covers, and (below) a final invoice and the advances it
// uses. The database is mocked: these are about what the form proposes and
// what it sends.

const mockState = {
  /** v_invoice_status rows by document_type asked for. */
  status: {} as Record<string, any[]>,
  inserted: [] as { table: string; payload: any }[],
}

function mockQuery(table: string) {
  const filters: Record<string, any> = {}
  const result = () => {
    if (table === 'v_invoice_status') {
      const rows = mockState.status[filters.document_type] || []
      return { data: rows, error: null }
    }
    if (table === 'pl_categories') return { data: [{ id: 'c1', name: 'Materijal', type: 'expense', sort_order: 1 }], error: null }
    if (table === 'departments') return { data: [{ id: 'd1', name: 'Gradilište', sort_order: 1 }], error: null }
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
  q.delete = () => q
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
  loadSplits: async () => [],
  saveSplits: async (_c: any, _s: string, _id: string, _p: any, lines: any[]) => ({ ok: true, lines: lines.length, message: '' }),
}))
jest.mock('./SplitEditor', () => () => null)
jest.mock('./ProjectSelect', () => () => null)
jest.mock('./PartnerDialog', () => () => null)

const draft = (over: Record<string, unknown> = {}) => ({
  company_id: 'co1', partner_id: 'p1', partners: { name: 'Dobavljač doo' },
  invoice_number: 'RA2027179', invoice_date: '2026-10-08', type: 'expense',
  currency: 'RSD', amount: 18144, exchange_rate: 1, eur_rate: 117.2,
  ...over,
})

const proforma = (over: Record<string, unknown> = {}) => ({
  id: 'pf1', invoice_number: '256173', invoice_date: '2026-10-06', document_type: 'proforma',
  currency: 'RSD', amount: 18144, paid_amount: 18144, covered: 0, ...over,
})

const next = () => fireEvent.click(screen.getByText('Dalje'))
const post = () => fireEvent.click(screen.getByText(/Proknjiži fakturu|Sačuvaj izmene/))
const insertedInto = (table: string) => mockState.inserted.filter(i => i.table === table).map(i => i.payload)

beforeEach(() => {
  mockState.status = {}
  mockState.inserted = []
})

describe('a proforma', () => {
  it('is posted with no P&L and needs no P&L category', async () => {
    render(<InvoiceDialog onClose={() => {}} invoice={draft({ document_type: 'proforma', invoice_number: 'PR-1', amount: 200000 })} />)
    expect((screen.getByLabelText('Vrsta dokumenta') as HTMLSelectElement).value).toBe('proforma')
    next(); next()
    expect(screen.getByText(/Predračun ne ulazi u troškove/)).toBeInTheDocument()
    next(); post()
    await waitFor(() => expect(insertedInto('invoices')).toHaveLength(1))
    expect(insertedInto('invoices')[0]).toMatchObject({ document_type: 'proforma', pl_impact: false, amount: 200000 })
  })
})

describe('an advance invoice', () => {
  it('from SEF proposes the paid proforma it names, and saves the coverage', async () => {
    mockState.status.proforma = [proforma({ id: 'pf0', invoice_number: '1', paid_amount: 50000 }), proforma({})]
    render(<InvoiceDialog onClose={() => {}} invoice={draft({ document_type: 'advance_invoice', pl_impact: false, proforma_hints: ['256173'] })} />)
    const cover = await screen.findByLabelText('Pokriće 256173') as HTMLInputElement
    await waitFor(() => expect(cover.value).toBe('18144'))
    expect((screen.getByLabelText('Pokriće 1') as HTMLInputElement).value).toBe('')
    next(); next(); next(); post()
    await waitFor(() => expect(insertedInto('advance_coverage')).toHaveLength(1))
    expect(insertedInto('invoices')[0]).toMatchObject({ document_type: 'advance_invoice', pl_impact: false, prior_period: false })
    expect(insertedInto('advance_coverage')[0]).toEqual([{ advance_invoice_id: 'new-1', proforma_id: 'pf1', amount: 18144 }])
  })

  it('larger than what was paid cannot be covered', async () => {
    mockState.status.proforma = [proforma({ paid_amount: 10000 })]
    render(<InvoiceDialog onClose={() => {}} invoice={draft({ document_type: 'advance_invoice', proforma_hints: ['256173'] })} />)
    const cover = await screen.findByLabelText('Pokriće 256173') as HTMLInputElement
    fireEvent.change(cover, { target: { value: '18144' } })
    expect(await screen.findByText('Avansni račun (18.144,00) je veći od plaćenog po izabranim predračunima (10.000,00).')).toBeInTheDocument()
  })

  it('with no proforma is saved unlinked and says so', async () => {
    render(<InvoiceDialog onClose={() => {}} invoice={draft({ document_type: 'advance_invoice' })} />)
    expect(await screen.findByText('Nije vezano za predračun — veže se kasnije')).toBeInTheDocument()
  })

  it('from an earlier period has no proforma', async () => {
    mockState.status.proforma = [proforma({})]
    render(<InvoiceDialog onClose={() => {}} invoice={draft({ document_type: 'advance_invoice' })} />)
    await screen.findByLabelText('Pokriće 256173')
    fireEvent.click(screen.getByLabelText('Iz ranijeg perioda'))
    expect(screen.queryByLabelText('Pokriće 256173')).not.toBeInTheDocument()
    next(); next(); next(); post()
    await waitFor(() => expect(insertedInto('invoices')).toHaveLength(1))
    expect(insertedInto('invoices')[0]).toMatchObject({ document_type: 'advance_invoice', prior_period: true })
    expect(insertedInto('advance_coverage')).toHaveLength(0)
  })
})

describe('a final invoice', () => {
  const advance = (over: Record<string, unknown> = {}) => ({
    id: 'av1', invoice_number: 'RA2027179', invoice_date: '2026-10-08', document_type: 'advance_invoice',
    currency: 'RSD', amount: 18144, advance_open: 18144, ...over,
  })
  const final = (over: Record<string, unknown> = {}) => draft({
    invoice_number: '21404-01-26', amount: 18144, pl_category: 'Materijal', department: 'Gradilište',
    advance_refs: [{ number: 'RA2027179', date: '2026-10-08', amount: 18144 }], advance_used: 18144, ...over,
  })

  it('B.B. Link: books the full amount and uses the advance it names', async () => {
    mockState.status.advance_invoice = [advance()]
    render(<InvoiceDialog onClose={() => {}} invoice={final()} />)
    const use = await screen.findByLabelText('Avans RA2027179') as HTMLInputElement
    await waitFor(() => expect(use.value).toBe('18144'))
    next(); next(); next(); post()
    await waitFor(() => expect(insertedInto('advance_usage')).toHaveLength(1))
    expect(insertedInto('invoices')[0]).toMatchObject({ document_type: 'invoice', amount: 18144 })
    expect(insertedInto('advance_usage')[0]).toEqual([{ final_invoice_id: 'new-1', advance_invoice_id: 'av1', amount: 18144 }])
  })

  it('DST: the advance closes part of it', async () => {
    mockState.status.advance_invoice = [advance({ id: 'd1', invoice_number: '0033/26', amount: 13260, advance_open: 13260 })]
    render(<InvoiceDialog onClose={() => {}} invoice={final({ invoice_number: '427/26', amount: 17340, advance_used: 13260,
      advance_refs: [{ number: '0033/26', date: '2026-10-07', amount: 13260 }] })} />)
    await waitFor(() => expect((screen.getByLabelText('Avans 0033/26') as HTMLInputElement).value).toBe('13260'))
    next(); next(); next(); post()
    await waitFor(() => expect(insertedInto('advance_usage')).toHaveLength(1))
    expect(insertedInto('advance_usage')[0]).toEqual([{ final_invoice_id: 'new-1', advance_invoice_id: 'd1', amount: 13260 }])
  })

  it('names an advance not in the books: cannot be posted until it is added from an earlier period', async () => {
    render(<InvoiceDialog onClose={() => {}} invoice={final({ advance_refs: [{ number: 'RA-9', date: '2025-01-15', amount: 18144 }] })} />)
    expect(await screen.findByText('Konačni račun navodi avansni račun RA-9 koji nije u knjigama.')).toBeInTheDocument()
    next(); next(); next(); post()
    await new Promise(r => setTimeout(r, 50))
    expect(insertedInto('invoices')).toHaveLength(0)
    expect(screen.getAllByText(/Konačni račun navodi avansni račun RA-9 koji nije u knjigama/).length).toBeGreaterThan(0)
    for (let i = 0; i < 3; i++) fireEvent.click(screen.getByText('Nazad'))
    fireEvent.click(screen.getByText('Dodaj avansni račun iz ranijeg perioda'))
    next(); next(); next(); post()
    await waitFor(() => expect(insertedInto('advance_usage')).toHaveLength(1))
    expect(insertedInto('invoices')[1]).toMatchObject({
      document_type: 'advance_invoice', prior_period: true, invoice_number: 'RA-9', invoice_date: '2025-01-15', amount: 18144, pl_impact: false,
    })
    expect(insertedInto('advance_usage')[0]).toEqual([{ final_invoice_id: 'new-1', advance_invoice_id: 'new-2', amount: 18144 }])
  })

  it('typed by hand: tells of open advances, and posts without them', async () => {
    mockState.status.advance_invoice = [advance({ advance_open: 300000 }), advance({ id: 'av2', invoice_number: 'A-2', advance_open: 35000 })]
    render(<InvoiceDialog onClose={() => {}} invoice={draft({ invoice_number: 'F-7', amount: 5000, pl_category: 'Materijal', department: 'Gradilište' })} />)
    expect(await screen.findByText('Dobavljač ima otvorene avanse: 2 avansna računa, ukupno 335.000,00 RSD')).toBeInTheDocument()
    next(); next(); next(); post()
    await waitFor(() => expect(insertedInto('invoices')).toHaveLength(1))
    expect(insertedInto('advance_usage')).toHaveLength(0)
  })
})
