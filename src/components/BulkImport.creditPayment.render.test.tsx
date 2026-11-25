import React from 'react'
import { render, screen, fireEvent, waitFor, act } from '@testing-library/react'
import BulkImport from './BulkImport'

// ── A credit payment belongs to its import ──────────────────────────────────
//
// "Obriši" on a posted import calls `delete_statement_cascade`, which
// soft-deletes the rows carrying the import's batch id and reopens every
// instalment whose `transaction_id` is one of them. Until 20261125090000 the
// principal and interest legs carried no batch id and the instalment no
// transaction id, so a deleted import left both legs on the P&L and the
// instalment reading paid. Every firm and figure is invented.

const mockState = {
  tables: {} as Record<string, any[]>,
  /** Every insert, each row given an id as the server would. */
  inserted: [] as { table: string; rows: any[] }[],
  /** Every update, with the filters it was narrowed by. */
  updated: [] as { table: string; payload: any; filters: [string, any][] }[],
  seq: 0,
}
const mockProps: { credit: any } = { credit: null }

jest.mock('../supabase', () => {
  const builder = (table: string): any => {
    const b: any = {}
    let made: any[] | null = null
    let updating: { table: string; payload: any; filters: [string, any][] } | null = null
    for (const m of ['select', 'neq', 'in', 'is', 'gt', 'gte', 'lte', 'order', 'range', 'limit', 'not', 'or', 'ilike']) b[m] = () => b
    b.eq = (col: string, v: any) => { if (updating) updating.filters.push([col, v]); return b }
    b.insert = (rows: any) => {
      made = ([] as any[]).concat(rows).map(r => ({ id: `${table}-${++mockState.seq}`, ...r }))
      mockState.inserted.push({ table, rows: made })
      return b
    }
    b.update = (payload: any) => {
      updating = { table, payload, filters: [] }
      mockState.updated.push(updating)
      return b
    }
    b.delete = () => b
    b.maybeSingle = async () => ({ data: (mockState.tables[table] || [])[0] ?? null, error: null })
    // After an insert, `.select().single()` answers the row just written.
    b.single = async () => ({ data: made ? made[0] : (mockState.tables[table] || [])[0] ?? null, error: null })
    b.then = (ok: any, bad: any) => Promise.resolve({ data: made ?? (mockState.tables[table] || []), error: null }).then(ok, bad)
    return b
  }
  return {
    supabase: {
      from: (t: string) => builder(t),
      rpc: async () => ({ data: null, error: null }),
      functions: { invoke: async () => ({ data: null, error: null }) },
    },
  }
})
jest.mock('../contexts/CompaniesContext', () => {
  const ctx = { companies: [{ id: 'co', name: 'Firma doo' }], defaultCompany: { id: 'co', name: 'Firma doo' }, showPicker: false, loading: false }
  return { useCompanies: () => ctx }
})
jest.mock('../contexts/SystemCategoriesContext', () => {
  const { TEST_SYSTEM_CATEGORIES } = jest.requireActual('../services/systemCategories.fixture')
  return { useSystemCategories: () => ({ map: TEST_SYSTEM_CATEGORIES, loading: false }) }
})
jest.mock('../services/bookAmounts', () => ({
  ...jest.requireActual('../services/bookAmounts'),
  getBookRates: async (date: string) => ({ date, eurRate: 117.2, usdRate: 100, source: 'test' }),
}))
jest.mock('../services/allPartners', () => ({ fetchAllPartners: async () => mockState.tables.partners }))
jest.mock('../services/quickFillStore', () => ({
  ...jest.requireActual('../services/quickFillStore'),
  fetchScripts: async () => [],
}))
jest.mock('../utils/importHash', () => ({ importRowHash: async (parts: unknown[]) => JSON.stringify(parts) }))
jest.mock('./SplitEditor', () => () => null)
jest.mock('./ProjectSelect', () => () => null)
jest.mock('./PartnerDialog', () => () => null)
jest.mock('./CreditInstallmentSelector', () => (props: any) => { mockProps.credit = props; return null })

const INSTALMENT = {
  id: 'i-2', credit_id: 'cr-1', installment_no: 2, due_date: '2026-11-30',
  principal_amount: 1000, interest_amount: 784.4, total_amount: 1784.4,
  status: 'outstanding', paid_amount: 0,
}

beforeEach(() => {
  mockState.inserted.length = 0
  mockState.updated.length = 0
  mockState.seq = 0
  mockProps.credit = null
  // `postAccepted` stamps every row with one batch id; jsdom has no webcrypto.
  let n = 0
  ;(global as any).crypto = { randomUUID: () => `batch-${++n}` }
  Object.assign(mockState.tables, {
    banks: [{ id: 'b1', name: 'Raiffeisen RSD', company_id: 'co', currency: 'RSD' }],
    partners: [{ id: 'p1', name: 'Izmišljena Banka ad' }],
    partner_accounts: [],
    pl_categories: [], pl_subcategories: [], dept_subcategories: [], expense_descriptions: [],
    departments: [],
    v_invoice_status: [],
    transactions: [],
    credits: [{ id: 'cr-1', name: 'Izmišljeni kredit', bank: 'Izmišljena Banka', currency: 'RSD', status: 'active' }],
    credit_installments: [INSTALMENT],
    invoices: [], pl_splits: [], passthrough: [], import_logs: [],
  })
})

const HEADER = 'Br. racuna#Datum#Izvod#Valuta#x#Duguje#Potrazuje'
const line = (cols: Record<number, string>) => Array.from({ length: 18 }, (_, i) => cols[i] ?? '').join('#')
/** The bank takes the instalment: a debit line. */
const instalmentLine = line({
  1: '28.11.2026', 2: '45', 3: 'RSD', 5: '1.784,40',
  11: 'Izmišljena Banka ad', 12: 'Otplata rate kredita',
})

const importOneRow = async (body: string) => {
  const text = [HEADER, body].join('\n')
  render(<BulkImport onClose={() => {}} onImported={() => {}} />)
  const bankSelect = await screen.findByDisplayValue('Izaberite banku…')
  await screen.findByText('Raiffeisen RSD')
  fireEvent.change(bankSelect, { target: { value: 'b1' } })
  const file = new File([text], 'izvod.txt', { type: 'text/plain' })
  ;(file as any).arrayBuffer = async () => new TextEncoder().encode(text).buffer
  const input = document.querySelector('input[type="file"]') as HTMLInputElement
  fireEvent.change(input, { target: { files: [file] } })
  await screen.findByText(/Spremno stavki: 1/)
  fireEvent.click(screen.getByText('🔎 Prepoznaj i pregledaj'))
  await screen.findByText(/Samo za proveru/)
}

/** The row's Tip select, once its editor is open. */
const typeSelect = () => Array.from(document.querySelectorAll('select'))
  .find(s => Array.from(s.options).some(o => o.value === 'credit_payment')) as HTMLSelectElement

const payInstalment = async () => {
  await importOneRow(instalmentLine)
  fireEvent.click(screen.getByText(/Otplata rate kredita/))
  await waitFor(() => expect(typeSelect()).toBeTruthy())
  fireEvent.change(typeSelect(), { target: { value: 'credit_payment' } })
  await waitFor(() => expect(mockProps.credit).not.toBeNull())
  await act(async () => { await mockProps.credit.onCreditChange('cr-1') })
  await waitFor(() => expect(mockProps.credit.installments).toHaveLength(1))
  act(() => { mockProps.credit.onToggle('i-2') })
  await waitFor(() => expect(mockProps.credit.selectedInstallmentIds).toEqual(['i-2']))
  fireEvent.click(screen.getByText('✓ Prihvati sve'))
  await screen.findByText('Proknjiži (1)')
  fireEvent.click(screen.getByText('Proknjiži (1)'))
  await screen.findByText('Uvoz je završen.')
}

const txRows = () => mockState.inserted.filter(i => i.table === 'transactions').flatMap(i => i.rows)
const bankLine = () => txRows().find(r => r.import_hash)
const legs = () => txRows().filter(r => r.type === 'credit_payment' && r.pl_impact === true)

describe('a credit payment belongs to its import', () => {
  it('stamps the principal and the interest leg with the bank line’s batch', async () => {
    await payInstalment()
    expect(bankLine().import_batch_id).toBeTruthy()
    expect(legs()).toHaveLength(2)
    for (const leg of legs()) expect(leg.import_batch_id).toBe(bankLine().import_batch_id)
  })

  it('links the instalment to the bank line that paid it', async () => {
    await payInstalment()
    const settled = mockState.updated.filter(u => u.table === 'credit_installments')
    expect(settled).toHaveLength(1)
    expect(settled[0].filters).toEqual([['id', 'i-2']])
    expect(settled[0].payload).toMatchObject({ status: 'paid', transaction_id: bankLine().id })
  })
})
