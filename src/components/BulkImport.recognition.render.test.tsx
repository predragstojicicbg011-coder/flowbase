import React from 'react'
import { render, screen, fireEvent, waitFor } from '@testing-library/react'
import BulkImport from './BulkImport'

// A statement imported and recognised by rules, with no AI: the open bill a
// line pays, the way the partner's earlier lines were booked, and nothing
// accepted until the person importing says so.

const mockTables: Record<string, any[]> = {}
const mockCalls: string[] = []

jest.mock('../supabase', () => {
  const builder = (table: string): any => {
    const b: any = {}
    for (const m of ['select', 'eq', 'neq', 'in', 'is', 'gt', 'gte', 'lte', 'order', 'range', 'limit', 'not', 'or', 'ilike']) b[m] = () => b
    b.maybeSingle = async () => ({ data: (mockTables[table] || [])[0] ?? null, error: null })
    b.single = b.maybeSingle
    b.then = (ok: any, bad: any) => Promise.resolve({ data: mockTables[table] || [], error: null }).then(ok, bad)
    return b
  }
  return {
    supabase: {
      from: (t: string) => { mockCalls.push(t); return builder(t) },
      rpc: async () => ({ data: null, error: null }),
      functions: { invoke: async (name: string) => { mockCalls.push(`fn:${name}`); return { data: null, error: null } } },
    },
  }
})
jest.mock('../contexts/CompaniesContext', () => {
  const ctx = { companies: [{ id: 'co', name: 'Firma doo' }], defaultCompany: { id: 'co', name: 'Firma doo' }, showPicker: false, loading: false }
  return { useCompanies: () => ctx }
})
jest.mock('../contexts/SystemCategoriesContext', () => ({ useSystemCategories: () => ({}) }))
jest.mock('../services/bookAmounts', () => ({
  ...jest.requireActual('../services/bookAmounts'),
  getBookRates: async (date: string) => ({ date, eurRate: 117.2, usdRate: 100, source: 'test' }),
}))
jest.mock('../services/allPartners', () => ({ fetchAllPartners: async () => mockTables.partners }))
jest.mock('../services/quickFillStore', () => ({ ...jest.requireActual('../services/quickFillStore'), fetchScripts: async () => [] }))
jest.mock('../utils/importHash', () => ({ importRowHash: async (parts: unknown[]) => JSON.stringify(parts) }))
jest.mock('./SplitEditor', () => () => null)
jest.mock('./ProjectSelect', () => () => null)
jest.mock('./PartnerDialog', () => () => null)
jest.mock('./CreditInstallmentSelector', () => () => null)

const past = (id: string, date: string) => ({
  id, partner_id: 'p2', transaction_date: date, created_at: `${date}T10:00:00Z`, tx_subtype: 'expense', type: 'direct',
  pl_category: 'Gorivo', pl_subcategory: null, department: 'Gradilište', dept_subcategory: null,
  expense_description: null, revenue_stream: null, project_id: null,
})

beforeEach(() => {
  mockCalls.length = 0
  Object.assign(mockTables, {
    banks: [{ id: 'b1', name: 'Raiffeisen RSD', company_id: 'co', currency: 'RSD' }],
    partners: [{ id: 'p1', name: 'Beton Plus doo' }, { id: 'p2', name: 'Lukoil Srbija' }],
    partner_accounts: [{ id: 'a1', partner_id: 'p1', account_number: '160-0000000553857-18', bank_name: 'Banca Intesa', is_primary: true }],
    pl_categories: [{ id: 'c1', name: 'Gorivo', sort_order: 1 }],
    pl_subcategories: [], dept_subcategories: [], expense_descriptions: [],
    departments: [{ id: 'd1', name: 'Gradilište', sort_order: 1 }],
    v_invoice_status: [{
      id: 'f1', partner_id: 'p1', type: 'expense', document_type: 'invoice', calculated_status: 'unpaid',
      invoice_number: 'F-1', reference_number: '2026-555', invoice_date: '2026-10-01', currency: 'RSD',
      amount: 50000, paid_amount: 0, adjustments: 0, advance_used: 0, partner_name: 'Beton Plus doo',
    }],
    transactions: [past('t1', '2026-09-20'), past('t2', '2026-08-20'), past('t3', '2026-07-20')],
    invoices: [], pl_splits: [], passthrough: [], import_logs: [],
  })
})

const line = (cols: Record<number, string>) => Array.from({ length: 18 }, (_, i) => cols[i] ?? '').join('#')
const statement = [
  'Br. racuna#Datum#Izvod#Valuta#x#Duguje#Potrazuje',
  line({ 1: '10.10.2026', 2: '41', 3: 'RSD', 5: '12.000,00', 10: '160-553857-18', 11: 'BETON PLUS', 12: 'Placanje', 15: '2026-555' }),
  line({ 1: '10.10.2026', 2: '41', 3: 'RSD', 5: '3.500,00', 11: 'Lukoil Srbija', 12: 'Gorivo' }),
  line({ 1: '10.10.2026', 2: '41', 3: 'RSD', 5: '100,00', 11: 'Nepoznat doo', 12: 'Nesto' }),
].join('\n')

const importIt = async () => {
  render(<BulkImport onClose={() => {}} onImported={() => {}} />)
  const bankSelect = await screen.findByDisplayValue('Izaberite banku…')
  await screen.findByText('Raiffeisen RSD')
  fireEvent.change(bankSelect, { target: { value: 'b1' } })
  const file = new File([statement], 'izvod.txt', { type: 'text/plain' })
  ;(file as any).arrayBuffer = async () => new TextEncoder().encode(statement).buffer
  const input = document.querySelector('input[type="file"]') as HTMLInputElement
  fireEvent.change(input, { target: { files: [file] } })
  await screen.findByText('Spremno stavki: 3')
  fireEvent.click(screen.getByText('🔎 Prepoznaj i pregledaj'))
  await screen.findByText(/Samo za proveru/)
}

describe('a statement recognised by rules', () => {
  it('links the line to the open bill by its reference, and books the other as the partner was booked before', async () => {
    await importIt()
    expect(screen.getByText('✓ Faktura F-1 · poziv na broj')).toBeInTheDocument()
    expect(screen.getByText('✓ Kao prethodnih 3 plaćanja')).toBeInTheDocument()
    expect(screen.getByText(/📊 Gorivo · Gradilište/)).toBeInTheDocument()
  })

  it('calls no AI', async () => {
    await importIt()
    expect(mockCalls.filter(c => c.startsWith('fn:'))).toEqual([])
  })

  it('accepts nothing by itself; the sure ones on request, the rest stay to be checked', async () => {
    await importIt()
    const stat = (label: string) => screen.getByText(label).previousSibling?.textContent
    expect(stat('Prihvaćeno')).toBe('0')
    expect(screen.getByText('Samo za proveru (1)')).toBeInTheDocument()
    fireEvent.click(screen.getByText('✓ Prihvati sve sigurne'))
    await waitFor(() => expect(stat('Prihvaćeno')).toBe('2'))
    expect(stat('Na čekanju')).toBe('1')
  })

  it('shows only the lines to be checked when asked', async () => {
    await importIt()
    fireEvent.click(screen.getByLabelText(/Samo za proveru/))
    expect(screen.queryByText('Beton Plus doo')).not.toBeInTheDocument()
    expect(screen.getByText('Nepoznat doo')).toBeInTheDocument()
  })
})

describe('after review', () => {
  it('a partner still owed a bill is not booked as a sure cost', async () => {
    mockTables.v_invoice_status = [...mockTables.v_invoice_status, {
      id: 'f2', partner_id: 'p2', type: 'expense', document_type: 'invoice', calculated_status: 'unpaid',
      invoice_number: 'L-9', reference_number: null, invoice_date: '2026-10-01', currency: 'EUR',
      amount: 30, paid_amount: 0, adjustments: 0, advance_used: 0, partner_name: 'Lukoil Srbija',
    }]
    await importIt()
    expect(screen.getByText('proveri · Kao prethodnih 3 plaćanja — partner ima otvorenu fakturu, proverite da li je plaća')).toBeInTheDocument()
  })

  it('several bills of the amount: offered, and left out of accept all', async () => {
    mockTables.v_invoice_status = [1, 2].map(n => ({
      id: `g${n}`, partner_id: 'p1', type: 'expense', document_type: 'invoice', calculated_status: 'unpaid',
      invoice_number: `G-${n}`, reference_number: null, invoice_date: '2026-10-01', currency: 'RSD',
      amount: 12000, paid_amount: 0, adjustments: 0, advance_used: 0, partner_name: 'Beton Plus doo',
    }))
    await importIt()
    expect(screen.getByText(/2 otvorene fakture odgovaraju \(isti iznos\)/)).toBeInTheDocument()
    fireEvent.click(screen.getByText('✓ Prihvati sve'))
    const stat = (label: string) => screen.getByText(label).previousSibling?.textContent
    await waitFor(() => expect(stat('Prihvaćeno')).toBe('2'))
    expect(stat('Na čekanju')).toBe('1')
  })

  it('recognising again starts every row afresh, nothing left accepted', async () => {
    await importIt()
    fireEvent.click(screen.getByText('✓ Prihvati sve'))
    fireEvent.click(screen.getByText('← Nazad'))
    fireEvent.click(await screen.findByText('🔎 Prepoznaj i pregledaj'))
    await screen.findByText(/Samo za proveru/)
    expect(screen.getByText('Prihvaćeno').previousSibling?.textContent).toBe('0')
  })
})
