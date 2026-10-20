import React from 'react'
import { render, screen, fireEvent, waitFor } from '@testing-library/react'
import InvoiceDialog from './InvoiceDialog'

// The bill's account and the partner's saved accounts: recognised in any
// written form, and saved to the partner from the form when it is new.

const mockState = {
  tables: {} as Record<string, any[]>,
  inserted: [] as { table: string; payload: any }[],
}

function mockQuery(table: string) {
  const result = () => {
    if (table === 'pl_categories') return { data: [{ id: 'c1', name: 'Materijal', type: 'expense', sort_order: 1 }], error: null }
    if (table === 'departments') return { data: [{ id: 'd1', name: 'Gradilište', sort_order: 1 }], error: null }
    return { data: mockState.tables[table] || [], error: null }
  }
  const q: any = {}
  for (const m of ['select', 'eq', 'neq', 'is', 'in', 'gt', 'order', 'range', 'limit']) q[m] = () => q
  q.insert = (payload: any) => {
    mockState.inserted.push({ table, payload })
    const ins: any = {}
    ins.select = () => ins
    ins.single = async () => ({ data: { id: `${table}-new`, ...(Array.isArray(payload) ? payload[0] : payload) }, error: null })
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
jest.mock('../services/allPartners', () => ({ fetchAllPartners: async () => [{ id: 'p1', name: 'Lukoil Srbija a.d.' }] }))
jest.mock('../services/quickFillStore', () => ({ fetchScripts: async () => [], saveScript: async () => ({}), whyNotSavable: () => null }))
jest.mock('../services/saveSplits', () => ({ loadSplits: async () => [], saveSplits: async () => ({ ok: true, lines: 0, message: '' }) }))
jest.mock('./SplitEditor', () => () => null)
jest.mock('./ProjectSelect', () => () => null)
jest.mock('./PartnerDialog', () => () => null)

const draft = (over: Record<string, unknown> = {}) => ({
  company_id: 'co1', partner_id: 'p1', partners: { name: 'Lukoil Srbija a.d.' },
  invoice_number: 'F-1', invoice_date: '2026-10-08', type: 'expense', currency: 'RSD', amount: 1000,
  exchange_rate: 1, eur_rate: 117.2, account_number: '160-553857-18', ...over,
})

beforeEach(() => {
  mockState.tables = {}
  mockState.inserted = []
})

describe('the partner\'s account on the bill', () => {
  it('is recognised although the bill writes it short', async () => {
    mockState.tables.partner_accounts = [
      { id: 'a1', partner_id: 'p1', account_number: '160-0000000553857-18', bank_name: 'Banca Intesa', is_primary: true, currency: 'RSD' },
    ]
    render(<InvoiceDialog onClose={() => {}} invoice={draft()} />)
    await screen.findByText('Pronađeno računa: 1')
    expect(screen.queryByText('+ Sačuvaj račun kod partnera')).not.toBeInTheDocument()
  })

  it('a new one is saved to the partner from the form, in full form and with its bank', async () => {
    mockState.tables.partner_accounts = [
      { id: 'a1', partner_id: 'p1', account_number: '265-1100310002899-82', bank_name: 'Raiffeisen banka', is_primary: true, currency: 'RSD' },
    ]
    render(<InvoiceDialog onClose={() => {}} invoice={draft()} />)
    fireEvent.click(await screen.findByText('+ Sačuvaj račun kod partnera'))
    await waitFor(() => expect(mockState.inserted.filter(i => i.table === 'partner_accounts')).toHaveLength(1))
    expect(mockState.inserted[0].payload).toEqual({
      partner_id: 'p1', account_number: '160-0000000553857-18', bank_name: 'Banca Intesa', currency: 'RSD', is_primary: false,
    })
    expect(await screen.findByText('Račun je sačuvan kod partnera.')).toBeInTheDocument()
  })

  it('the first account of a partner becomes the main one', async () => {
    render(<InvoiceDialog onClose={() => {}} invoice={draft()} />)
    fireEvent.click(await screen.findByText('+ Sačuvaj račun kod partnera'))
    await waitFor(() => expect(mockState.inserted).toHaveLength(1))
    expect(mockState.inserted[0].payload.is_primary).toBe(true)
  })
})

describe('the source documents in the header', () => {
  it('opens the invoice PDF and an attachment from the header while booking', async () => {
    const pdf = jest.fn()
    const att = jest.fn()
    render(<InvoiceDialog onClose={() => {}} invoice={draft()} sourceDocuments={[{ label: 'Račun (SEF)', open: pdf }, { label: 'OTP-1', open: att }]} />)
    fireEvent.click(screen.getByText('📎 Račun i prilozi (2)'))
    fireEvent.click(screen.getByText('OTP-1'))
    expect(att).toHaveBeenCalled()
    fireEvent.click(screen.getByText('📎 Račun i prilozi (2)'))
    fireEvent.click(screen.getByText('Račun (SEF)'))
    expect(pdf).toHaveBeenCalled()
  })

  it('is not there for a bill typed by hand', async () => {
    render(<InvoiceDialog onClose={() => {}} invoice={draft()} />)
    expect(screen.queryByText(/Račun i prilozi/)).not.toBeInTheDocument()
  })
})
