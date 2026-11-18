import React from 'react'
import { render, screen, fireEvent, waitFor, act } from '@testing-library/react'
import BulkImport from './BulkImport'
import { DIALOG } from './dialogTheme'
import { REFUND_LINE_NOTE, REFUND_ONE_TIME_NOTE } from '../services/refund'

// ── Money that came back, booked as an expense ──────────────────────────────
//
// A supplier is paid and the cost is booked; days later the supplier refunds
// it. The refund arrives on the statement as a credit line, and the person
// importing it files it as an expense under the same classification. It is a
// refund: stored with a minus in all three figures, so the expense it is filed
// under goes down instead of up. What a person types stays a magnitude; the
// minus is the application's (services/refund.ts).
//
// Every other line — a debit booked as an expense, a credit booked as
// revenue — is written exactly as before, and is pinned here as well.

const mockState = {
  tables: {} as Record<string, any[]>,
  writes: [] as { table: string; op: string; payload: any }[],
}
/** The props the split editor and the project picker were last rendered with. */
const mockProps: { split: any; project: any } = { split: null, project: null }

jest.mock('../supabase', () => {
  const builder = (table: string): any => {
    const b: any = {}
    for (const m of ['select', 'eq', 'neq', 'in', 'is', 'gt', 'gte', 'lte', 'order', 'range', 'limit', 'not', 'or', 'ilike']) b[m] = () => b
    b.insert = (payload: any) => {
      mockState.writes.push({ table, op: 'insert', payload })
      // What the server hands back for an insert: one id per row written.
      const rows = ([] as any[]).concat(payload).map((_, i) => ({ id: `${table}-new-${i}` }))
      const ins: any = {}
      ins.select = () => ins
      ins.single = async () => ({ data: rows[0], error: null })
      ins.then = (ok: any, bad: any) => Promise.resolve({ data: rows, error: null }).then(ok, bad)
      return ins
    }
    b.update = () => b
    b.delete = () => b
    b.maybeSingle = async () => ({ data: (mockState.tables[table] || [])[0] ?? null, error: null })
    b.single = b.maybeSingle
    b.then = (ok: any, bad: any) => Promise.resolve({ data: mockState.tables[table] || [], error: null }).then(ok, bad)
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
jest.mock('../contexts/SystemCategoriesContext', () => ({ useSystemCategories: () => ({}) }))
// 1 EUR = 117.2 RSD on every date.
const EUR_RATE = 117.2
jest.mock('../services/bookAmounts', () => ({
  ...jest.requireActual('../services/bookAmounts'),
  getBookRates: async (date: string) => ({ date, eurRate: 117.2, usdRate: 100, source: 'test' }),
}))
jest.mock('../services/allPartners', () => ({ fetchAllPartners: async () => mockState.tables.partners }))
jest.mock('../services/quickFillStore', () => ({
  ...jest.requireActual('../services/quickFillStore'),
  fetchScripts: async () => [{
    id: 'sc-1', name: 'Kancelarijski materijal', icon: '⚡',
    pl_category: 'Kancelarija', pl_subcategory: '', department: 'Uprava', cf_type: 'recurring',
  }],
}))
jest.mock('../utils/importHash', () => ({ importRowHash: async (parts: unknown[]) => JSON.stringify(parts) }))
jest.mock('./SplitEditor', () => (props: any) => { mockProps.split = props; return null })
jest.mock('./ProjectSelect', () => (props: any) => { mockProps.project = props; return null })
jest.mock('./PartnerDialog', () => () => null)
jest.mock('./CreditInstallmentSelector', () => () => null)

beforeEach(() => {
  mockState.writes.length = 0
  mockProps.split = null
  mockProps.project = null
  // `postAccepted` stamps every row with one batch id; jsdom has no webcrypto.
  let n = 0
  ;(global as any).crypto = { randomUUID: () => `batch-${++n}` }
  Object.assign(mockState.tables, {
    banks: [{ id: 'b1', name: 'Raiffeisen RSD', company_id: 'co', currency: 'RSD' }],
    partners: [{ id: 'p1', name: 'Papirnica Zvezda doo' }],
    partner_accounts: [],
    pl_categories: [{ id: 'c1', name: 'Kancelarija', sort_order: 1 }],
    pl_subcategories: [], dept_subcategories: [], expense_descriptions: [],
    departments: [{ id: 'd1', name: 'Uprava', sort_order: 1 }],
    v_invoice_status: [],
    transactions: [],
    credits: [], credit_installments: [],
    invoices: [], pl_splits: [], passthrough: [], import_logs: [],
  })
})

const HEADER = 'Br. racuna#Datum#Izvod#Valuta#x#Duguje#Potrazuje'
const line = (cols: Record<number, string>) => Array.from({ length: 18 }, (_, i) => cols[i] ?? '').join('#')
/** Money back from the supplier: a credit line. */
const refundLine = (ccy = 'RSD') => line({
  1: '12.11.2026', 2: '44', 3: ccy, 6: '1.199,22',
  11: 'Papirnica Zvezda doo', 12: 'Povracaj za reklamaciju',
})
/** An ordinary payment to the supplier: a debit line. */
const costLine = line({
  1: '05.11.2026', 2: '43', 3: 'RSD', 5: '1.784,40',
  11: 'Papirnica Zvezda doo', 12: 'Toneri i papir',
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

/** The subtype select inside the expanded row editor. */
const subtypeSelect = () => Array.from(document.querySelectorAll('select'))
  .find(s => Array.from(s.options).some(o => o.value === 'revenue')) as HTMLSelectElement

/** Opens the row's editor; the description line is the row's own handle. */
const openRow = async (description: RegExp) => {
  fireEvent.click(screen.getByText(description))
  await waitFor(() => expect(subtypeSelect()).toBeTruthy())
}

const makeItAnExpense = async () => {
  fireEvent.change(subtypeSelect(), { target: { value: 'expense' } })
  await screen.findByText('P&L klasifikacija')
}

/** Kancelarija · Uprava, through the quick fill (whose script says recurring). */
const classify = async () => {
  fireEvent.focus(screen.getByPlaceholderText('⚡ Brza popuna — kliknite ili pretražite…'))
  fireEvent.mouseDown(await screen.findByText('⚡ Kancelarijski materijal'))
  await screen.findByText(/📊 Kancelarija · Uprava/)
}

const pickProject = (id: string) => act(() => { mockProps.project.onChange(id) })

const acceptAndPost = async () => {
  fireEvent.click(screen.getByText('✓ Prihvati sve'))
  await screen.findByText('Proknjiži (1)')
  fireEvent.click(screen.getByText('Proknjiži (1)'))
  await screen.findByText('Uvoz je završen.')
}

const theTransaction = () => {
  const tx = mockState.writes.filter(w => w.table === 'transactions' && w.op === 'insert')
  expect(tx).toHaveLength(1)
  return tx[0].payload
}

const reviewAmount = () => document.querySelector('[data-testid^="review-amount-"]') as HTMLElement

describe('a credit line', () => {
  it('left as revenue is written exactly as before', async () => {
    await importOneRow(refundLine())
    expect(screen.queryByText('Povraćaj')).toBeNull()
    expect(reviewAmount().textContent).toBe('+1.199,22 RSD')
    await acceptAndPost()

    const tx = theTransaction()
    expect(tx.type).toBe('direct')
    expect(tx.tx_subtype).toBe('revenue')
    expect(tx.amount).toBe(1199.22)
    expect(tx.amount_rsd).toBe(1199.22)
    expect(tx.amount_eur).toBe(10.23)
    expect(tx.exchange_rate).toBe(1)
    expect(tx.eur_rate).toBe(EUR_RATE)
    expect(tx.cf_type).toBeNull()
    expect(tx).not.toHaveProperty('cf_accrual_from')
  })

  it('set to expense is a refund: tagged, explained, and stored with a minus', async () => {
    await importOneRow(refundLine())
    await openRow(/Povracaj za reklamaciju/)
    await makeItAnExpense()
    await classify()
    pickProject('pr-7')

    // The review says what it is, in words and not by colour alone.
    expect(screen.getByText('Povraćaj')).toBeInTheDocument()
    expect(reviewAmount().textContent).toBe('-1.199,22 RSD')
    // The green a credit is written in: the money did come in.
    expect(reviewAmount()).toHaveStyle({ color: DIALOG.accent })
    expect(screen.getByText(REFUND_LINE_NOTE)).toBeInTheDocument()
    expect(screen.getByText(REFUND_ONE_TIME_NOTE)).toBeInTheDocument()
    expect(screen.queryByText('🔁 Ponavljajući')).toBeNull()
    expect(screen.queryByText('1️⃣ Jednokratni')).toBeNull()
    expect(screen.queryByText('↩️ Refund.')).toBeNull()
    // The split editor still works in what a person types: a magnitude.
    expect(mockProps.split.parent.amount).toBe(1199.22)

    await acceptAndPost()
    const tx = theTransaction()
    expect(tx.type).toBe('direct')
    expect(tx.tx_subtype).toBe('expense')
    expect(tx.is_advance).toBe(false)
    expect(tx.amount).toBe(-1199.22)
    expect(tx.amount_rsd).toBe(-1199.22)
    expect(tx.amount_eur).toBe(-10.23)
    expect(tx.exchange_rate).toBe(1)
    expect(tx.eur_rate).toBe(EUR_RATE)
    expect(tx.pl_impact).toBe(true)
    expect(tx.pl_category).toBe('Kancelarija')
    expect(tx.department).toBe('Uprava')
    expect(tx.project_id).toBe('pr-7')
    // The script said recurring; a refund is one-time all the same.
    expect(tx.cf_type).toBe('one_time')
    expect(tx.cf_frequency).toBeNull()
    expect(tx.cf_next_month_est).toBeNull()
    expect(tx.cf_accrual_from).toBeNull()
    // The fingerprint is the line as parsed, not the booking.
    expect(tx.import_hash).toContain(',1199.22,')
    expect(tx.import_hash).not.toContain('-1199.22')
  })
})

describe('Review Focus 1: a refund in euros', () => {
  it('is negative in its own money, in dinars and in euros, and both rates stay positive', async () => {
    await importOneRow(refundLine('EUR'))
    await openRow(/Povracaj za reklamaciju/)
    await makeItAnExpense()
    await classify()
    await acceptAndPost()

    const tx = theTransaction()
    expect(tx.currency).toBe('EUR')
    expect(tx.amount).toBe(-1199.22)
    expect(tx.amount_eur).toBe(-1199.22)
    expect(tx.amount_rsd).toBe(-140548.58)
    expect(tx.exchange_rate).toBe(EUR_RATE)
    expect(tx.eur_rate).toBe(EUR_RATE)
  })
})

describe('Review Focus 2: a refund split over P and L lines', () => {
  const lineOf = (key: string, amount: number) => ({
    key, amount, pl_category: 'Kancelarija', pl_subcategory: '', department: 'Uprava',
    project_id: null, cf_type: '', note: '',
  })
  const splitWrite = () => {
    const write = mockState.writes.find(w => w.table === 'pl_splits' && w.op === 'insert')
    expect(write).toBeTruthy()
    return write!.payload as any[]
  }

  it('lines typed positive are written negative, against a parent negative in all three figures', async () => {
    await importOneRow(refundLine())
    await openRow(/Povracaj za reklamaciju/)
    await makeItAnExpense()
    await waitFor(() => expect(mockProps.split).toBeTruthy())
    act(() => { mockProps.split.onChange([lineOf('a', 1000), lineOf('b', 199.22)]) })
    await acceptAndPost()

    expect(theTransaction().amount).toBe(-1199.22)
    const write = mockState.writes.find(w => w.table === 'pl_splits' && w.op === 'insert')
    expect(write).toBeTruthy()
    const splits = write!.payload as any[]
    expect(splits.map(r => r.amount)).toEqual([-1000, -199.22])
    expect(splits.map(r => r.amount_rsd)).toEqual([-1000, -199.22])
    expect(splits.every(r => r.amount_eur < 0)).toBe(true)
    // The last line is the remainder: the euros add up to the row.
    const eur = splits.reduce((s, r) => s + r.amount_eur, 0)
    expect(Math.round(eur * 100) / 100).toBe(theTransaction().amount_eur)
  })

  it('every line of a refund is written one-time, a recurring one included', async () => {
    await importOneRow(refundLine())
    await openRow(/Povracaj za reklamaciju/)
    await makeItAnExpense()
    await waitFor(() => expect(mockProps.split).toBeTruthy())
    act(() => { mockProps.split.onChange([{ ...lineOf('a', 1000), cf_type: 'recurring' }, lineOf('b', 199.22)]) })
    await acceptAndPost()

    const splits = splitWrite()
    expect(splits.map(r => r.amount)).toEqual([-1000, -199.22])
    expect(splits.map(r => r.amount_rsd)).toEqual([-1000, -199.22])
    expect(splits.map(r => r.cf_type)).toEqual(['one_time', 'one_time'])
  })

  it('an ordinary cost split the same way keeps each line cash-flow type', async () => {
    await importOneRow(costLine)
    await openRow(/Toneri i papir/)
    await waitFor(() => expect(mockProps.split).toBeTruthy())
    act(() => { mockProps.split.onChange([{ ...lineOf('a', 1000), cf_type: 'recurring' }, lineOf('b', 784.4)]) })
    await acceptAndPost()

    const splits = splitWrite()
    expect(splits.map(r => r.amount)).toEqual([1000, 784.4])
    expect(splits.map(r => r.cf_type)).toEqual(['recurring', null])
  })
})

describe('a debit line', () => {
  it('booked as an expense is written exactly as before', async () => {
    await importOneRow(costLine)
    await openRow(/Toneri i papir/)
    await classify()
    expect(screen.queryByText('Povraćaj')).toBeNull()
    expect(screen.queryByText(REFUND_LINE_NOTE)).toBeNull()
    expect(screen.queryByText(REFUND_ONE_TIME_NOTE)).toBeNull()
    expect(screen.getByText('↩️ Refund.')).toBeInTheDocument()
    expect(reviewAmount().textContent).toBe('-1.784,40 RSD')
    expect(reviewAmount()).toHaveStyle({ color: DIALOG.red })
    await acceptAndPost()

    const tx = theTransaction()
    expect(tx.tx_subtype).toBe('expense')
    expect(tx.amount).toBe(1784.4)
    expect(tx.amount_rsd).toBe(1784.4)
    expect(tx.amount_eur).toBe(15.23)
    expect(tx.exchange_rate).toBe(1)
    // What was chosen — the script's recurring — carried as before, and the
    // estimate falls back to the line's own amount.
    expect(tx.cf_type).toBe('recurring')
    expect(tx.cf_frequency).toBe('monthly')
    expect(tx.cf_next_month_est).toBe(1784.4)
    expect(tx).not.toHaveProperty('cf_accrual_from')
  })
})
