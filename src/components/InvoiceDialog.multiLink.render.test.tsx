import React from 'react'
import { render, screen, fireEvent, waitFor } from '@testing-library/react'
import InvoiceDialog from './InvoiceDialog'

// One bill closed by several direct transactions already in the books (a
// bank's fees through the month). The P&L stays on the transactions; a bill
// they do not cover in full is left partly closed.

const mockState = {
  tables: {} as Record<string, any[]>,
  writes: [] as { table: string; op: string; payload: any; ids?: string[] }[],
}

function mockQuery(table: string) {
  let ids: string[] | undefined
  const result = () => {
    if (table === 'pl_categories') return { data: [{ id: 'c1', name: 'Bankarske usluge', type: 'expense', sort_order: 1 }], error: null }
    if (table === 'departments') return { data: [{ id: 'd1', name: 'Uprava', sort_order: 1 }], error: null }
    return { data: mockState.tables[table] || [], error: null }
  }
  const q: any = {}
  for (const m of ['select', 'eq', 'neq', 'is', 'gt', 'order', 'range', 'limit']) q[m] = () => q
  q.in = (_c: string, v: string[]) => { ids = v; return q }
  q.insert = (payload: any) => {
    mockState.writes.push({ table, op: 'insert', payload })
    const ins: any = {}
    ins.select = () => ins
    ins.single = async () => ({ data: { id: 'new1' }, error: null })
    return ins
  }
  q.upsert = (payload: any) => { mockState.writes.push({ table, op: 'upsert', payload }); return q }
  q.update = (payload: any) => {
    const u: any = {}
    for (const m of ['eq', 'select']) u[m] = () => u
    let n = 1
    u.in = (_c: string, v: string[]) => { n = v.length; mockState.writes.push({ table, op: 'update', payload, ids: v }); return u }
    u.then = (ok: any, bad: any) => Promise.resolve({ data: Array.from({ length: n }, (_, i) => ({ id: `x${i}` })), error: null }).then(ok, bad)
    return u
  }
  q.delete = () => { mockState.writes.push({ table, op: 'delete', payload: null }); return q }
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
jest.mock('../services/allPartners', () => ({ fetchAllPartners: async () => [{ id: 'p1', name: 'Banca Intesa' }] }))
jest.mock('../services/quickFillStore', () => ({ fetchScripts: async () => [], saveScript: async () => ({}), whyNotSavable: () => null }))
jest.mock('../services/saveSplits', () => ({ loadSplits: async () => [], saveSplits: async () => ({ ok: true, lines: 0, message: '' }) }))
jest.mock('./SplitEditor', () => () => null)
jest.mock('./ProjectSelect', () => () => null)
jest.mock('./PartnerDialog', () => () => null)

const fee = (id: string, date: string, rsd: number) => ({
  id, transaction_date: date, is_advance: false, amount: -rsd, amount_rsd: -rsd, amount_eur: -(rsd / 117.2), currency: 'RSD',
  pl_category: 'Bankarske usluge', department: 'Uprava', banks: { id: 'b1', name: 'Banca Intesa' }, partners: { id: 'p1', name: 'Banca Intesa' },
})

const draft = {
  company_id: 'co1', partner_id: 'p1', partners: { name: 'Banca Intesa' }, invoice_number: 'BI-10/26',
  invoice_date: '2026-10-31', type: 'expense', currency: 'RSD', amount: 1000, exchange_rate: 1, eur_rate: 117.2,
  pl_category: 'Bankarske usluge', department: 'Uprava',
}

beforeEach(() => {
  mockState.tables = { transactions: [fee('t1', '2026-10-05', 300), fee('t2', '2026-10-15', 450), fee('t3', '2026-10-25', 250)] }
  mockState.writes = []
})

const next = () => fireEvent.click(screen.getByText('Dalje'))
const post = () => fireEvent.click(screen.getByText(/Proknjiži fakturu|Sačuvaj izmene/))
const pick = async (date: string) => fireEvent.click((await screen.findAllByText(new RegExp(`^${date}`)))[0])

describe('one bill, several transactions', () => {
  it('links several and says what is left', async () => {
    render(<InvoiceDialog onClose={() => {}} invoice={draft} />)
    await pick('2026-10-05')
    await pick('2026-10-15')
    expect(await screen.findByText('Izabrano: 2 transakcije · 750,00 RSD od 1.000,00 RSD · ostaje 250,00 RSD — račun ostaje delimično zatvoren')).toBeInTheDocument()
    expect(screen.getByText('✕ Raskini sve veze')).toBeInTheDocument()
  })

  it('books the bill out of the P&L, links each transaction with its share, partly closed', async () => {
    render(<InvoiceDialog onClose={() => {}} invoice={draft} />)
    await pick('2026-10-05')
    await pick('2026-10-15')
    next(); next(); next(); post()
    await waitFor(() => expect(mockState.writes.filter(w => w.op === 'upsert')).toHaveLength(2))
    expect(mockState.writes.find(w => w.table === 'invoices' && w.op === 'insert')?.payload).toMatchObject({ pl_impact: false, status: 'partial', amount: 1000 })
    expect(mockState.writes.filter(w => w.op === 'upsert').map(w => [w.payload.transaction_id, w.payload.allocated_amount])).toEqual([['t1', 300], ['t2', 450]])
    expect(mockState.writes.find(w => w.table === 'transactions' && w.op === 'update')?.ids).toEqual(['t1', 't2'])
  })

  it('covered in full: paid', async () => {
    render(<InvoiceDialog onClose={() => {}} invoice={draft} />)
    await pick('2026-10-05')
    await pick('2026-10-15')
    await pick('2026-10-25')
    next(); next(); next(); post()
    await waitFor(() => expect(mockState.writes.filter(w => w.op === 'upsert')).toHaveLength(3))
    expect(mockState.writes.find(w => w.table === 'invoices' && w.op === 'insert')?.payload).toMatchObject({ status: 'paid' })
  })

  it('one transaction is unlinked and the rest stay', async () => {
    render(<InvoiceDialog onClose={() => {}} invoice={draft} />)
    await pick('2026-10-05')
    await pick('2026-10-15')
    fireEvent.click(screen.getAllByLabelText('Ukloni transakciju')[0])
    expect(await screen.findByText(/Izabrano: 1 transakcija · 450,00 RSD/)).toBeInTheDocument()
  })
})
