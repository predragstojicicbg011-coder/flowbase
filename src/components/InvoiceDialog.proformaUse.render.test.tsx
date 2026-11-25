import React from 'react'
import { render, screen, fireEvent, waitFor } from '@testing-library/react'
import InvoiceDialog from './InvoiceDialog'

// A final invoice closed by a paid proforma directly, with no advance invoice
// in between (20261125100000), in both directions; a bill not paid twice; and
// a linked payment not allocated beyond itself. The database is mocked: these
// are about what the form proposes, refuses and sends.

const mockState = {
  /** v_invoice_status rows by document_type asked for, and by id. */
  status: {} as Record<string, any[]>,
  byId: {} as Record<string, any>,
  tables: {} as Record<string, any[]>,
  inserted: [] as { table: string; payload: any }[],
  writes: [] as { table: string; op: string; payload: any }[],
  rpc: [] as { name: string; args: any }[],
}

function mockQuery(table: string) {
  const filters: Record<string, any> = {}
  const result = () => {
    if (table === 'v_invoice_status') {
      if (filters.id) return { data: mockState.byId[filters.id] ? [mockState.byId[filters.id]] : [], error: null }
      return { data: mockState.status[filters.document_type] || [], error: null }
    }
    if (table === 'pl_categories') return { data: [{ id: 'c1', name: 'Materijal', type: 'expense', sort_order: 1 }], error: null }
    if (table === 'departments') return { data: [{ id: 'd1', name: 'Gradilište', sort_order: 1 }], error: null }
    const rows = (mockState.tables[table] || []).filter(r => Object.entries(filters).every(([c, v]) => !(c in r) || r[c] === v))
    return { data: rows, error: null }
  }
  const q: any = {}
  for (const m of ['select', 'neq', 'is', 'in', 'gt', 'order', 'range', 'limit']) q[m] = () => q
  q.eq = (col: string, val: any) => { filters[col] = val; return q }
  q.insert = (payload: any) => {
    mockState.inserted.push({ table, payload })
    mockState.writes.push({ table, op: 'insert', payload })
    const ins: any = {}
    ins.select = () => ins
    ins.single = async () => ({ data: { id: table === 'invoices' ? `new-${mockState.inserted.length}` : 'x' }, error: null })
    ins.then = (ok: any, bad: any) => Promise.resolve({ data: [{ id: 'x' }], error: null }).then(ok, bad)
    return ins
  }
  q.upsert = (payload: any) => { mockState.writes.push({ table, op: 'upsert', payload }); return q }
  q.update = (payload: any) => { mockState.writes.push({ table, op: 'update', payload }); return q }
  q.delete = () => { mockState.writes.push({ table, op: 'delete', payload: null }); return q }
  q.maybeSingle = async () => { const r = result(); return { data: Array.isArray(r.data) ? r.data[0] ?? null : r.data, error: null } }
  q.single = async () => { const r = result(); return { data: Array.isArray(r.data) ? r.data[0] ?? null : r.data, error: null } }
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
  fetchAllPartners: async () => [{ id: 'p1', name: 'Dobavljač doo' }, { id: 'k1', name: 'Kupac doo' }],
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

const bill = (over: Record<string, unknown> = {}) => ({
  company_id: 'co1', partner_id: 'p1', partners: { name: 'Dobavljač doo' },
  invoice_number: 'F-21', invoice_date: '2026-11-10', type: 'expense',
  currency: 'RSD', amount: 2400, exchange_rate: 1, eur_rate: 117.2,
  pl_category: 'Materijal', department: 'Gradilište',
  ...over,
})
const ours = (over: Record<string, unknown> = {}) => ({
  company_id: 'co1', partner_id: 'k1', partners: { name: 'Kupac doo' }, type: 'revenue',
  invoice_number: 'IF-21', invoice_date: '2026-11-10', currency: 'RSD', amount: 1000,
  exchange_rate: 1, eur_rate: 117.2, revenue_kind: 'services', revenue_stream: 'Ostalo',
  ...over,
})
const paidProforma = (over: Record<string, unknown> = {}) => ({
  id: 'pf7', invoice_number: 'PR-7', invoice_date: '2026-11-02', document_type: 'proforma',
  currency: 'RSD', paid_amount: 2400, covered: 0, used_directly: 0, ...over,
})
const tx = (id: string, date: string, rsd: number) => ({
  id, transaction_date: date, is_advance: false, type: 'direct', tx_subtype: 'expense', amount: rsd, amount_rsd: rsd, amount_eur: rsd / 117.2, currency: 'RSD',
  pl_category: 'Materijal', department: 'Gradilište', banks: { id: 'b1', name: 'Banca Intesa' }, partners: { id: 'p1', name: 'Dobavljač doo' },
})

const next = () => fireEvent.click(screen.getByText('Dalje'))
const post = () => fireEvent.click(screen.getByText(/Proknjiži fakturu|Sačuvaj izmene/))
const insertedInto = (table: string) => mockState.inserted.filter(i => i.table === table).map(i => i.payload)
const links = () => mockState.rpc.filter(c => c.name === 'replace_advance_links').map(c => c.args)
const pick = async (date: string) => fireEvent.click((await screen.findAllByText(new RegExp(`^${date}`)))[0])

beforeEach(() => {
  mockState.status = {}
  mockState.byId = {}
  mockState.tables = {}
  mockState.inserted = []
  mockState.writes = []
  mockState.rpc = []
})

describe('a supplier\'s bill and its paid proforma', () => {
  it('with exactly one paid proforma, fills the use itself and sends it as a proforma_id', async () => {
    mockState.status.proforma = [paidProforma()]
    render(<InvoiceDialog onClose={() => {}} invoice={bill()} />)
    const use = await screen.findByLabelText('Predračun PR-7') as HTMLInputElement
    await waitFor(() => expect(use.value).toBe('2400'))
    expect(screen.getByText('Plaćeno bez avansnog računa: 1 predračun, neiskorišćeno 2.400,00 RSD. Može da zatvori ovaj račun direktno.')).toBeInTheDocument()
    expect(screen.getByText(/Predračun PR-7 · plaćeno 2\.400,00 · neiskorišćeno 2\.400,00/)).toBeInTheDocument()
    next(); next(); next(); post()
    await waitFor(() => expect(links()).toHaveLength(1))
    expect(insertedInto('invoices')[0]).toMatchObject({ document_type: 'invoice', amount: 2400 })
    expect(links()[0]).toEqual({ p_invoice: 'new-1', p_coverage: null, p_usage: [{ proforma_id: 'pf7', amount: 2400 }] })
  })

  it('a bill larger than what is left of the proforma takes what is left, and stays partly open', async () => {
    mockState.status.proforma = [paidProforma({ paid_amount: 3000, covered: 1000 })]
    render(<InvoiceDialog onClose={() => {}} invoice={bill({ amount: 5000 })} />)
    const use = await screen.findByLabelText('Predračun PR-7') as HTMLInputElement
    await waitFor(() => expect(use.value).toBe('2000'))
  })

  it('with two paid proformas fills nothing and lists both', async () => {
    mockState.status.proforma = [paidProforma(), paidProforma({ id: 'pf8', invoice_number: 'PR-8', paid_amount: 500 })]
    render(<InvoiceDialog onClose={() => {}} invoice={bill()} />)
    expect(await screen.findByLabelText('Predračun PR-8')).toBeInTheDocument()
    expect((screen.getByLabelText('Predračun PR-7') as HTMLInputElement).value).toBe('')
    expect(screen.getByText('Plaćeno bez avansnog računa: 2 predračuna, neiskorišćeno 2.900,00 RSD. Mogu da zatvore ovaj račun direktno.')).toBeInTheDocument()
  })

  it('does not offer a proforma in another currency, nor one nothing is left of', async () => {
    mockState.status.proforma = [paidProforma({ currency: 'EUR' }), paidProforma({ id: 'pf9', invoice_number: 'PR-9', covered: 1000, used_directly: 1400 })]
    render(<InvoiceDialog onClose={() => {}} invoice={bill()} />)
    await new Promise(r => setTimeout(r, 100))
    expect(screen.queryByLabelText('Predračun PR-7')).not.toBeInTheDocument()
    expect(screen.queryByLabelText('Predračun PR-9')).not.toBeInTheDocument()
  })

  it('refuses a use above what is left of the proforma, and posts nothing', async () => {
    mockState.status.proforma = [paidProforma()]
    render(<InvoiceDialog onClose={() => {}} invoice={bill({ amount: 5000 })} />)
    const use = await screen.findByLabelText('Predračun PR-7') as HTMLInputElement
    fireEvent.change(use, { target: { value: '2500' } })
    next(); next(); next(); post()
    expect((await screen.findAllByText('Od predračuna je ostalo 2.400,00, a traži se 2.500,00.')).length).toBeGreaterThan(0)
    expect(insertedInto('invoices')).toHaveLength(0)
  })

  it('an existing bill opened for editing lists its usable proforma and fills NOTHING (fix round 1)', async () => {
    mockState.status.proforma = [paidProforma()]
    mockState.byId.b1 = { id: 'b1', paid_amount: 0, adjustments: 0 }
    render(<InvoiceDialog onClose={() => {}} invoice={bill({ id: 'b1', document_type: 'invoice' })} />)
    const use = await screen.findByLabelText('Predračun PR-7') as HTMLInputElement
    await new Promise(r => setTimeout(r, 100))
    expect(use.value).toBe('')
    expect(screen.getByText('Plaćeno bez avansnog računa: 1 predračun, neiskorišćeno 2.400,00 RSD. Može da zatvori ovaj račun direktno.')).toBeInTheDocument()
  })

  it('on edit, a use typed by hand is held to what the bill still owes: its credit notes and payments taken off', async () => {
    mockState.status.proforma = [paidProforma()]
    mockState.byId.b1 = { id: 'b1', paid_amount: 300, adjustments: -500 }
    render(<InvoiceDialog onClose={() => {}} invoice={bill({ id: 'b1', document_type: 'invoice' })} />)
    const use = await screen.findByLabelText('Predračun PR-7') as HTMLInputElement
    // 2.400 − 500 (credit note) = 1.900 owed; 300 paid; 1.700 would be 2.000.
    fireEvent.change(use, { target: { value: '1700' } })
    expect(await screen.findByText('Iskorišćeni avans (1.700,00) i ono što plaćanja već drže (300,00) zajedno su više od onoga što račun duguje (1.900,00). Račun se ne plaća dva puta.')).toBeInTheDocument()
    fireEvent.change(use, { target: { value: '1600' } })
    await waitFor(() => expect(screen.queryByText(/Račun se ne plaća dva puta/)).not.toBeInTheDocument())
  })
})

describe('a bill is not paid twice', () => {
  it('a transaction linked to the bill withdraws the proposed use; a use typed beside it is refused', async () => {
    mockState.status.proforma = [paidProforma()]
    mockState.tables.transactions = [tx('t1', '2026-10-05', 2400)]
    render(<InvoiceDialog onClose={() => {}} invoice={bill()} />)
    const use = await screen.findByLabelText('Predračun PR-7') as HTMLInputElement
    await waitFor(() => expect(use.value).toBe('2400'))
    await pick('2026-10-05')
    await waitFor(() => expect((screen.getByLabelText('Predračun PR-7') as HTMLInputElement).value).toBe(''))
    fireEvent.change(screen.getByLabelText('Predračun PR-7'), { target: { value: '1000' } })
    next(); next(); next(); post()
    expect((await screen.findAllByText('Iskorišćeni avans (1.000,00) i ono što plaćanja već drže (2.400,00) zajedno su više od onoga što račun duguje (2.400,00). Račun se ne plaća dva puta.')).length).toBeGreaterThan(0)
    expect(insertedInto('invoices')).toHaveLength(0)
  })

  it('a transaction that already pays another bill is refused before anything is written', async () => {
    mockState.tables.transactions = [tx('t1', '2026-10-05', 2400)]
    mockState.tables.invoice_transaction_links = [
      { invoice_id: 'other', transaction_id: 't1', allocated_amount: 2400, allocated_amount_rsd: 2400, invoices: { currency: 'RSD', parent_invoice_id: null } },
    ]
    render(<InvoiceDialog onClose={() => {}} invoice={bill()} />)
    await pick('2026-10-05')
    next(); next(); next(); post()
    expect(await screen.findByText('Plaćanje od 05.10.2026 iznosi 2.400,00 RSD i već plaća 2.400,00 RSD: od njega je ostalo 0,00 RSD, a traži se 2.400,00 RSD. Plaćanje se ne raspoređuje preko onoga što je plaćeno.')).toBeInTheDocument()
    expect(mockState.writes).toHaveLength(0)
  })
})

describe('our invoice to a customer and the customer\'s paid proforma', () => {
  it('fills the use from the customer proforma and sends it as a proforma_id', async () => {
    mockState.status.proforma = [paidProforma({ id: 'cpf', invoice_number: 'IPR-3', paid_amount: 1200 })]
    render(<InvoiceDialog onClose={() => {}} invoice={ours()} />)
    const use = await screen.findByLabelText('Predračun IPR-3') as HTMLInputElement
    await waitFor(() => expect(use.value).toBe('1000'))
    next(); next(); next(); post()
    await waitFor(() => expect(links()).toHaveLength(1))
    expect(insertedInto('invoices')[0]).toMatchObject({ type: 'revenue', document_type: 'invoice', amount: 1000 })
    expect(links()[0]).toEqual({ p_invoice: 'new-1', p_coverage: null, p_usage: [{ proforma_id: 'cpf', amount: 1000 }] })
  })
})
