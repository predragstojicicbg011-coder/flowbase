import React from 'react'
import { render, screen, fireEvent, waitFor, act } from '@testing-library/react'
import BankStatementDialog from './BankStatementDialog'

// ── A credit payment belongs to its statement ───────────────────────────────
//
// "Obriši izvod" calls `delete_statement_cascade`, which soft-deletes the rows
// that carry the statement's batch id and reopens every instalment whose
// `transaction_id` is one of them. Until 20261125090000 the principal and
// interest legs carried no batch id and the instalment no transaction id, so
// deleting a statement left both legs on the P&L and the instalment reading
// paid. The legs now carry the batch, and the instalment the BANK LINE.
// Reopening a statement leaves the legs out of the grid.
//
// Driven through the real dialog over a mocked database: what matters is what
// reaches it. Every firm and figure is invented.

const mockState = {
  tables: {} as Record<string, any[]>,
  /** Every write the dialog sent, in order, with the filters it narrowed by. */
  writes: [] as { table: string; op: string; payload: any; filters: [string, any][] }[],
  seq: 0,
}
/** The props the instalment selector was last rendered with. */
const mockProps: { credit: any } = { credit: null }

jest.mock('../supabase', () => {
  const builder = (table: string): any => {
    const st: any = { op: 'select', payload: null, filters: [] as [string, any][], single: false }
    const matches = (r: any) => st.filters.every(([c, v]: [string, any]) => r[c] === v)
    const settle = () => {
      const all = mockState.tables[table] || []
      if (st.op === 'insert') {
        const list = ([] as any[]).concat(st.payload)
        const made = list.map(p => ({ id: `${table}-new-${++mockState.seq}`, ...p }))
        mockState.writes.push({ table, op: 'insert', payload: made, filters: st.filters })
        mockState.tables[table] = [...all, ...made]
        return { data: st.single ? made[0] : made, error: null }
      }
      if (st.op === 'update') {
        mockState.writes.push({ table, op: 'update', payload: st.payload, filters: st.filters })
        return { data: null, error: null }
      }
      if (st.op === 'delete') {
        mockState.writes.push({ table, op: 'delete', payload: null, filters: st.filters })
        return { data: null, error: null }
      }
      const rows = all.filter(matches)
      if (st.single) return { data: rows[0] ?? null, error: null }
      return { data: rows, count: rows.length, error: null }
    }
    const b: any = {}
    for (const m of ['select', 'neq', 'in', 'is', 'gt', 'gte', 'lt', 'lte', 'order', 'range', 'limit', 'not', 'or', 'ilike']) b[m] = () => b
    b.eq = (col: string, v: any) => { st.filters.push([col, v]); return b }
    b.insert = (payload: any) => { st.op = 'insert'; st.payload = payload; return b }
    b.update = (payload: any) => { st.op = 'update'; st.payload = payload; return b }
    b.delete = () => { st.op = 'delete'; return b }
    b.single = async () => { st.single = true; return settle() }
    b.maybeSingle = b.single
    b.then = (ok: any, bad: any) => Promise.resolve(settle()).then(ok, bad)
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
  const ctx = { companies: [{ id: 'co', name: 'Izmišljena Firma doo' }], defaultCompany: { id: 'co', name: 'Izmišljena Firma doo' }, showPicker: false, loading: false }
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
jest.mock('../services/allPartners', () => ({ fetchAllPartners: async () => [] }))
jest.mock('../services/quickFillStore', () => ({
  ...jest.requireActual('../services/quickFillStore'),
  fetchScripts: async () => [],
}))
jest.mock('../utils/importHash', () => ({ importRowHash: async (parts: unknown[]) => JSON.stringify(parts) }))
jest.mock('./SplitEditor', () => () => null)
jest.mock('./ProjectSelect', () => () => null)
jest.mock('./CreditInstallmentSelector', () => (props: any) => { mockProps.credit = props; return null })

const DATE = '2026-11-12'
const CREDIT = 'cr-1'

beforeEach(() => {
  mockState.writes.length = 0
  mockState.seq = 0
  mockProps.credit = null
  let n = 0
  ;(global as any).crypto = { randomUUID: () => `batch-${++n}` }
  mockState.tables = {
    banks: [{ id: 'b1', name: 'Izmišljena Banka RSD', company_id: 'co', currency: 'RSD' }],
    partners: [], partner_accounts: [],
    pl_categories: [], pl_subcategories: [], departments: [],
    v_invoice_status: [], transactions: [], passthrough: [],
    credits: [{ id: CREDIT, name: 'Izmišljeni kredit', bank: 'Izmišljena Banka', currency: 'RSD', status: 'active' }],
    credit_installments: [],
    invoices: [], invoice_transaction_links: [], pl_splits: [], import_logs: [],
    feature_flags: [], closed_periods: [],
  }
})

// ── Driving the dialog ──────────────────────────────────────────────────────

const openDialog = async () => {
  render(<BankStatementDialog onClose={() => {}} onImported={() => {}} />)
  const bankSelect = await screen.findByDisplayValue('Izaberite banku…')
  await screen.findByText('Izmišljena Banka RSD')
  fireEvent.change(bankSelect, { target: { value: 'b1' } })
}

const cell = (placeholder: string, index = 0) =>
  screen.getAllByPlaceholderText(placeholder)[index] as HTMLInputElement
const header = (index = 0) => cell('Opis', index).parentElement as HTMLElement

const warning = () => {
  const box = Array.from(document.querySelectorAll('div'))
    .find(d => (d.textContent || '').startsWith('⚠️ '))
  return box ? (box.textContent || '').replace('⚠️ ', '') : ''
}

const post = async () => {
  fireEvent.click(screen.getByText(/^Proknjiži \(\d+\)$/))
  await waitFor(() =>
    expect(Boolean(screen.queryByText('Izvod je proknjižen.')) || warning() !== '').toBe(true))
  expect(warning()).toBe('')
}

const wrote = (table: string, op = 'insert') =>
  mockState.writes.filter(w => w.table === table && w.op === op)
const txRows = () => wrote('transactions').flatMap(w => ([] as any[]).concat(w.payload))
const bankLine = () => txRows().find(r => r.type === 'credit_payment' && r.pl_impact !== true)
const legs = () => txRows().filter(r => r.type === 'credit_payment' && r.pl_impact === true)

/** A line of Isplata paying instalment `inst` of the credit. */
const payInstalment = async (inst: any, amount: string) => {
  mockState.tables.credit_installments = [inst]
  await openDialog()
  fireEvent.change(header().querySelector('input[type="date"]')!, { target: { value: DATE } })
  fireEvent.change(cell('Opis'), { target: { value: 'Otplata rate kredita' } })
  fireEvent.change(cell('Isplata'), { target: { value: amount } })
  fireEvent.click(header())
  fireEvent.click(screen.getByText('Otplata kredita'))
  await waitFor(() => expect(mockProps.credit).not.toBeNull())
  act(() => { mockProps.credit.onCreditChange(CREDIT) })
  await waitFor(() => expect(mockProps.credit.installments).toHaveLength(1))
  act(() => { mockProps.credit.onToggle(inst.id) })
  await waitFor(() => expect(mockProps.credit.selectedInstallmentIds).toEqual([inst.id]))
  await post()
}

const ANNUITY = {
  id: 'inst-4', credit_id: CREDIT, installment_no: 4, due_date: '2026-11-28',
  principal_amount: 1000, interest_amount: 200, total_amount: 1200,
  status: 'outstanding', paid_amount: 0,
}

describe('a credit payment belongs to its statement', () => {
  it('stamps the principal and the interest leg with the bank line’s batch', async () => {
    await payInstalment(ANNUITY, '1200')
    const line = bankLine()
    expect(line.import_batch_id).toBeTruthy()
    expect(legs()).toHaveLength(2)
    expect(legs().map((l: any) => l.amount).sort()).toEqual([1000, 200])
    for (const leg of legs()) expect(leg.import_batch_id).toBe(line.import_batch_id)
  })

  it('links the instalment to the bank line that paid it', async () => {
    await payInstalment(ANNUITY, '1200')
    const settled = wrote('credit_installments', 'update')
    expect(settled).toHaveLength(1)
    expect(settled[0].filters).toEqual([['id', 'inst-4']])
    expect(settled[0].payload).toMatchObject({ status: 'paid', transaction_id: bankLine().id })
  })

  it('links an interest-only instalment too, which has no principal leg to point at', async () => {
    await payInstalment({ ...ANNUITY, id: 'inst-int', installment_no: 1, principal_amount: 0, interest_amount: 350, total_amount: 350 }, '350')
    expect(legs()).toHaveLength(1)
    expect(legs()[0].import_batch_id).toBe(bankLine().import_batch_id)
    expect(wrote('credit_installments', 'update')[0].payload.transaction_id).toBe(bankLine().id)
  })
})

describe('a statement holding a credit payment, reopened', () => {
  it('leaves the legs out of the grid', async () => {
    // The legs carry the batch now, and Izmeni reads the batch. Shown, they
    // would read as two more lines of the statement and be saved back as bank
    // lines without their P&L classification.
    const BATCH = 'batch-reopened'
    const stored = (over: Record<string, unknown>): any => ({
      import_batch_id: BATCH, transaction_date: DATE, partner_id: null, statement_number: '7',
      currency: 'RSD', exchange_rate: 1, eur_rate: 117.2, status: 'posted', is_advance: false,
      tx_subtype: 'expense', reference_number: null, model: null, account_number: null,
      ...over,
    })
    mockState.tables.transactions = [
      stored({ id: 'tx-cost', type: 'direct', pl_impact: true, note: 'KANCELARIJSKI MATERIJAL',
        amount: 500, amount_rsd: 500, pl_category: 'Kancelarija' }),
      stored({ id: 'tx-line', type: 'credit_payment', pl_impact: false, note: 'OTPLATA KREDITA', amount: 1200, amount_rsd: 1200 }),
      stored({ id: 'tx-p', type: 'credit_payment', pl_impact: true, note: 'GLAVNICA RATA 4', amount: 1000, amount_rsd: 1000 }),
      stored({ id: 'tx-i', type: 'credit_payment', pl_impact: true, note: 'KAMATA RATA 4', amount: 200, amount_rsd: 200 }),
    ]
    const log = {
      id: 'log-1', filing_ref: BATCH, company_id: 'co', bank_id: 'b1',
      file_name: 'Izvod #7', import_type: 'manual_statement', note: '', default_currency: 'RSD',
    }
    mockState.tables.import_logs = [log]
    render(<BankStatementDialog onClose={() => {}} onImported={() => {}} editLog={log} />)
    await waitFor(() => expect(cell('Opis', 0).value).toBe('KANCELARIJSKI MATERIJAL'))

    // A credit row is locked in the grid, so it is drawn as text.
    expect(await screen.findByText('OTPLATA KREDITA')).toBeInTheDocument()
    const shown = screen.getAllByPlaceholderText('Opis').map(i => (i as HTMLInputElement).value)
    expect(shown).toEqual(['KANCELARIJSKI MATERIJAL'])
    expect(screen.queryByDisplayValue('GLAVNICA RATA 4')).toBeNull()
    expect(screen.queryByDisplayValue('KAMATA RATA 4')).toBeNull()
    expect(screen.queryByText('GLAVNICA RATA 4')).toBeNull()
    expect(screen.queryByText('KAMATA RATA 4')).toBeNull()
  })
})
