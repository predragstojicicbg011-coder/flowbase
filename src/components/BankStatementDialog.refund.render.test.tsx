import React from 'react'
import { render, screen, fireEvent, waitFor, within, act } from '@testing-library/react'
import BankStatementDialog from './BankStatementDialog'
import { DIALOG } from './dialogTheme'
import { REFUND_TAG, REFUND_LINE_NOTE, REFUND_ONE_TIME_NOTE } from '../services/refund'
import { REVENUE_STREAMS } from '../services/revenueStreams'

// ── Money that came back, typed into the statement grid ─────────────────────
//
// A supplier is paid and the cost is booked; later the supplier refunds part
// of it. The refund is a line in the Uplata column of the statement, and the
// person typing the statement in files it as an expense under the cost it
// reduces. It is a refund: stored with a minus in all three figures, so that
// expense goes down instead of up. What a person types stays a magnitude; the
// minus is the application's (services/refund.ts).
//
// Three things are held here:
//
//   1. A figure typed into Uplata on a new row is revenue unless somebody says
//      otherwise. It used to be an expense whichever box it went into, so an
//      uplata nobody classified became a positive cost.
//   2. An uplata filed as an expense is a refund: tagged, explained, and
//      written negative, split lines included.
//   3. A statement holding a stored refund (or a payroll storno) can be
//      reopened and saved. Both used to come back into the Isplata box as a
//      negative figure, and the save refused them as having no amount.
//
// Driven through the real dialog over a mocked database: what matters is what
// reaches it. The split check and the split writer are the real ones.

const mockState = {
  tables: {} as Record<string, any[]>,
  /** Every write the dialog sent, in order, with the filters it narrowed by. */
  writes: [] as { table: string; op: string; payload: any; filters: [string, any][] }[],
  seq: 0,
}
/** The props the split editor was last rendered with. */
const mockProps: { split: any } = { split: null }

jest.mock('../supabase', () => {
  const builder = (table: string): any => {
    const st: any = { op: 'select', payload: null, filters: [] as [string, any][], single: false }
    const matches = (r: any) => st.filters.every(([c, v]: [string, any]) => r[c] === v)
    const settle = () => {
      const all = mockState.tables[table] || []
      if (st.op === 'insert') {
        const list = ([] as any[]).concat(st.payload)
        const made = list.map(p => ({ id: `${table}-new-${++mockState.seq}`, ...p }))
        mockState.writes.push({ table, op: 'insert', payload: st.payload, filters: st.filters })
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
jest.mock('../contexts/SystemCategoriesContext', () => ({ useSystemCategories: () => ({ map: {}, loading: false }) }))
// 1 EUR = 117.2 RSD on every date.
const EUR_RATE = 117.2
jest.mock('../services/bookAmounts', () => ({
  ...jest.requireActual('../services/bookAmounts'),
  getBookRates: async (date: string) => ({ date, eurRate: 117.2, usdRate: 100, source: 'test' }),
}))
jest.mock('../services/allPartners', () => ({ fetchAllPartners: async () => [] }))
jest.mock('../services/quickFillStore', () => ({
  ...jest.requireActual('../services/quickFillStore'),
  fetchScripts: async () => [{
    id: 'sc-1', name: 'Kancelarijski materijal', icon: '⚡',
    pl_category: 'Kancelarija', pl_subcategory: '', department: 'Uprava', cf_type: 'recurring',
  }],
}))
jest.mock('../utils/importHash', () => ({ importRowHash: async (parts: unknown[]) => JSON.stringify(parts) }))
jest.mock('./SplitEditor', () => (props: any) => { mockProps.split = props; return null })
jest.mock('./ProjectSelect', () => () => null)
jest.mock('./CreditInstallmentSelector', () => () => null)

beforeEach(() => {
  mockState.writes.length = 0
  mockState.seq = 0
  mockProps.split = null
  let n = 0
  ;(global as any).crypto = { randomUUID: () => `batch-${++n}` }
  mockState.tables = {
    banks: [{ id: 'b1', name: 'Izmišljena Banka RSD', company_id: 'co', currency: 'RSD' }],
    partners: [], partner_accounts: [],
    pl_categories: [{ id: 'c1', name: 'Kancelarija', sort_order: 1 }],
    pl_subcategories: [],
    departments: [{ id: 'd1', name: 'Uprava', sort_order: 1 }],
    v_invoice_status: [], transactions: [], passthrough: [], credits: [], credit_installments: [],
    invoices: [], invoice_transaction_links: [], pl_splits: [], import_logs: [],
    feature_flags: [], closed_periods: [],
  }
})

// ── Driving the dialog ──────────────────────────────────────────────────────

const DATE = '2026-11-12'

const openDialog = async () => {
  render(<BankStatementDialog onClose={() => {}} onImported={() => {}} />)
  const bankSelect = await screen.findByDisplayValue('Izaberite banku…')
  await screen.findByText('Izmišljena Banka RSD')
  fireEvent.change(bankSelect, { target: { value: 'b1' } })
}

const cell = (placeholder: string, index = 0) =>
  screen.getAllByPlaceholderText(placeholder)[index] as HTMLInputElement
/** The grid line of a row: the strip that is clicked to open it. */
const header = (index = 0) => cell('Opis', index).parentElement as HTMLElement

const describeRow = () => {
  fireEvent.change(header().querySelector('input[type="date"]')!, { target: { value: DATE } })
  fireEvent.change(cell('Opis'), { target: { value: 'Povracaj za reklamaciju' } })
}
const typeIsplata = (v: string, index = 0) => fireEvent.change(cell('Isplata', index), { target: { value: v } })
const typeUplata = (v: string, index = 0) => fireEvent.change(cell('Uplata', index), { target: { value: v } })
const setCurrency = (v: string) => fireEvent.change(header().querySelector('select')!, { target: { value: v } })
/** Opens (or closes) a row's classification panel. */
const toggleRow = (index = 0) => fireEvent.click(header(index))
/** A Podtip card. Its label is also what a row summary can read, so it is looked up under its own title. */
const subtype = (label: '📤 Trošak' | '📥 Prihod') =>
  fireEvent.click(within(screen.getByText('Podtip').nextElementSibling as HTMLElement).getByText(label))
const cashFlow = (label: string) => fireEvent.click(screen.getByText(label))

const quickFill = async () => {
  fireEvent.focus(screen.getByPlaceholderText('⚡ Brza popuna — kliknite ili pretražite…'))
  fireEvent.mouseDown(await screen.findByText('⚡ Kancelarijski materijal'))
  await screen.findByText(/📤 Trošak · Kancelarija \/ Uprava/)
}

/** Picks an option from one of the Trosak panel searchable pickers, found by its empty label. */
const pick = (emptyLabel: string, option: string) => {
  fireEvent.click(screen.getByRole('combobox', { name: emptyLabel }))
  fireEvent.click(screen.getByRole('option', { name: option }))
}

const lineOf = (key: string, amount: number) => ({
  key, amount, pl_category: 'Kancelarija', pl_subcategory: '', department: 'Uprava',
  project_id: null, cf_type: '', note: '',
})
const typeSplit = (lines: any[]) => act(() => { mockProps.split.onChange(lines) })

const warning = () => {
  const box = Array.from(document.querySelectorAll('div'))
    .find(d => (d.textContent || '').startsWith('⚠️ '))
  return box ? (box.textContent || '').replace('⚠️ ', '') : ''
}

const post = async () => {
  fireEvent.click(screen.getByText(/^Proknjiži \(\d+\)$/))
  await waitFor(() =>
    expect(Boolean(screen.queryByText('Izvod je proknjižen.')) || warning() !== '').toBe(true))
}

const wrote = (table: string, op = 'insert') =>
  mockState.writes.filter(w => w.table === table && w.op === op)

const theTransaction = () => {
  const rows = wrote('transactions').flatMap(w => ([] as any[]).concat(w.payload))
  expect(rows).toHaveLength(1)
  return rows[0]
}

const splitRows = () => wrote('pl_splits').flatMap(w => ([] as any[]).concat(w.payload))

// ── 1. Which way a new row goes when nobody says ────────────────────────────

describe('a new row, nothing clicked', () => {
  it('a figure typed into Uplata is revenue', async () => {
    await openDialog()
    describeRow()
    typeUplata('300')
    expect(screen.queryByText(REFUND_TAG)).toBeNull()
    await post()

    const tx = theTransaction()
    expect(tx.type).toBe('direct')
    expect(tx.tx_subtype).toBe('revenue')
    expect(tx.amount).toBe(300)
    expect(tx.amount_rsd).toBe(300)
    expect(tx.cf_type).toBeNull()
    expect(tx).not.toHaveProperty('cf_accrual_from')
  })

  it('a figure typed into Isplata is an expense, as it always was', async () => {
    await openDialog()
    describeRow()
    typeIsplata('300')
    await post()

    const tx = theTransaction()
    expect(tx.tx_subtype).toBe('expense')
    expect(tx.amount).toBe(300)
    expect(tx.amount_rsd).toBe(300)
    expect(tx.amount_eur).toBe(2.56)
    expect(tx.pl_impact).toBe(true)
    expect(tx).not.toHaveProperty('cf_accrual_from')
  })

  it('a figure moved from Uplata to Isplata follows it back to expense', async () => {
    await openDialog()
    describeRow()
    typeUplata('300')
    typeIsplata('300')
    await post()
    const tx = theTransaction()
    expect(tx.tx_subtype).toBe('expense')
    expect(tx.amount).toBe(300)
  })
})

// ── 2. An uplata filed as an expense ────────────────────────────────────────

describe('an uplata filed as an expense is a refund', () => {
  it('is tagged and explained, and stored with a minus as one-time', async () => {
    await openDialog()
    describeRow()
    typeUplata('1199.22')
    toggleRow()
    // Chosen while it was still revenue; a refund is one-time all the same.
    cashFlow('🔁 Ponavljajući')
    subtype('📤 Trošak')

    // Said in words, not by colour alone; the figure stays the green of money in.
    expect(screen.getByText(REFUND_TAG)).toBeInTheDocument()
    expect(screen.getByText(REFUND_LINE_NOTE)).toBeInTheDocument()
    expect(screen.getByText(REFUND_ONE_TIME_NOTE)).toBeInTheDocument()
    expect(screen.queryByText('🔁 Ponavljajući')).toBeNull()
    expect(screen.queryByText('1️⃣ Jednokratni')).toBeNull()
    expect(screen.queryByText('↩️ Refund.')).toBeNull()
    expect(cell('Uplata').value).toBe('1199.22')
    expect(cell('Isplata').value).toBe('')
    expect(cell('Uplata')).toHaveStyle({ color: DIALOG.accent })
    // The split editor works in what a person types: a magnitude.
    expect(mockProps.split.parent.amount).toBe(1199.22)

    await post()
    expect(screen.getByText('Izvod je proknjižen.')).toBeInTheDocument()
    const tx = theTransaction()
    expect(tx.type).toBe('direct')
    expect(tx.tx_subtype).toBe('expense')
    expect(tx.is_advance).toBe(false)
    expect(tx.pl_impact).toBe(true)
    expect(tx.amount).toBe(-1199.22)
    expect(tx.amount_rsd).toBe(-1199.22)
    expect(tx.amount_eur).toBe(-10.23)
    expect(tx.exchange_rate).toBe(1)
    expect(tx.eur_rate).toBe(EUR_RATE)
    expect(tx.cf_type).toBe('one_time')
    expect(tx.cf_frequency).toBeNull()
    expect(tx.cf_next_month_est).toBeNull()
    expect(tx.cf_accrual_from).toBeNull()
    expect(tx.cf_accrual_to).toBeNull()
    expect(tx.cf_capex_months).toBeNull()
    expect(tx.cf_reimbursable_date).toBeNull()
    // The fingerprint is the line as typed, not the booking.
    expect(tx.import_hash).toContain('"1199.22"')
    expect(tx.import_hash).not.toContain('-1199.22')
  })

  it('the Trosak card clicked first, the uplata typed afterwards: the same refund', async () => {
    await openDialog()
    describeRow()
    toggleRow()
    subtype('📤 Trošak')
    typeUplata('1199.22')

    expect(screen.getByText(REFUND_TAG)).toBeInTheDocument()
    await post()
    const tx = theTransaction()
    expect(tx.tx_subtype).toBe('expense')
    expect(tx.amount).toBe(-1199.22)
    expect(tx.amount_rsd).toBe(-1199.22)
    expect(tx.amount_eur).toBe(-10.23)
    expect(tx.cf_type).toBe('one_time')
  })

  it('an isplata filed as an expense is no refund and is written as before', async () => {
    await openDialog()
    describeRow()
    typeIsplata('1784.4')
    toggleRow()
    cashFlow('🔁 Ponavljajući')
    expect(screen.queryByText(REFUND_TAG)).toBeNull()
    expect(screen.queryByText(REFUND_LINE_NOTE)).toBeNull()
    expect(screen.queryByText(REFUND_ONE_TIME_NOTE)).toBeNull()
    expect(cell('Isplata')).toHaveStyle({ color: DIALOG.red })
    await post()

    const tx = theTransaction()
    expect(tx.tx_subtype).toBe('expense')
    expect(tx.amount).toBe(1784.4)
    expect(tx.amount_rsd).toBe(1784.4)
    expect(tx.amount_eur).toBe(15.23)
    expect(tx.exchange_rate).toBe(1)
    expect(tx.cf_type).toBe('recurring')
    expect(tx.cf_frequency).toBe('monthly')
    expect(tx.cf_next_month_est).toBe(1784.4)
    expect(tx).not.toHaveProperty('cf_accrual_from')
  })
})

// ── Review Focus 1: the three figures go together ───────────────────────────

describe('Review Focus 1: a refund keeps all three figures negative', () => {
  it('in dinars', async () => {
    await openDialog()
    describeRow()
    typeUplata('1199.22')
    toggleRow()
    subtype('📤 Trošak')
    await post()

    const tx = theTransaction()
    expect(tx.currency).toBe('RSD')
    expect([tx.amount, tx.amount_rsd, tx.amount_eur]).toEqual([-1199.22, -1199.22, -10.23])
    expect([tx.exchange_rate, tx.eur_rate]).toEqual([1, EUR_RATE])
  })

  it('in euros', async () => {
    await openDialog()
    describeRow()
    setCurrency('EUR')
    typeUplata('1199.22')
    toggleRow()
    subtype('📤 Trošak')
    await post()

    const tx = theTransaction()
    expect(tx.currency).toBe('EUR')
    expect([tx.amount, tx.amount_rsd, tx.amount_eur]).toEqual([-1199.22, -140548.58, -1199.22])
    expect([tx.exchange_rate, tx.eur_rate]).toEqual([EUR_RATE, EUR_RATE])
  })
})

// ── A refund split over P&L lines ───────────────────────────────────────────

describe('a refund split over P and L lines', () => {
  it('lines typed positive are written negative, against a parent negative in all three figures', async () => {
    await openDialog()
    describeRow()
    typeUplata('1199.22')
    toggleRow()
    subtype('📤 Trošak')
    await waitFor(() => expect(mockProps.split).toBeTruthy())
    typeSplit([lineOf('a', 1000), lineOf('b', 199.22)])
    await post()

    expect(screen.getByText('Izvod je proknjižen.')).toBeInTheDocument()
    const tx = theTransaction()
    expect([tx.amount, tx.amount_rsd, tx.amount_eur]).toEqual([-1199.22, -1199.22, -10.23])
    const splits = splitRows()
    expect(splits.map(r => r.amount)).toEqual([-1000, -199.22])
    expect(splits.map(r => r.amount_rsd)).toEqual([-1000, -199.22])
    expect(splits.every(r => r.amount_eur < 0)).toBe(true)
    // The last line is the remainder: the euros add up to the row.
    const eur = splits.reduce((s, r) => s + r.amount_eur, 0)
    expect(Math.round(eur * 100) / 100).toBe(tx.amount_eur)
  })

  it('a split typed on an uplata with nothing clicked is a choice of expense: a refund', async () => {
    // The Podtip cards are locked while a split stands, so a person who
    // fills the split first never gets to click Trosak. Stating a split of
    // expenses is that choice.
    await openDialog()
    describeRow()
    typeUplata('1199.22')
    toggleRow()
    await waitFor(() => expect(mockProps.split).toBeTruthy())
    typeSplit([lineOf('a', 1000), lineOf('b', 199.22)])

    expect(screen.getByText(REFUND_TAG)).toBeInTheDocument()
    await post()
    expect(screen.getByText('Izvod je proknjižen.')).toBeInTheDocument()
    const tx = theTransaction()
    expect(tx.tx_subtype).toBe('expense')
    expect([tx.amount, tx.amount_rsd, tx.amount_eur]).toEqual([-1199.22, -1199.22, -10.23])
    expect(splitRows().map(r => r.amount)).toEqual([-1000, -199.22])
  })

  it('every line of a refund is written one-time, a recurring one included', async () => {
    await openDialog()
    describeRow()
    typeUplata('1199.22')
    toggleRow()
    subtype('📤 Trošak')
    await waitFor(() => expect(mockProps.split).toBeTruthy())
    typeSplit([{ ...lineOf('a', 1000), cf_type: 'recurring' }, lineOf('b', 199.22)])
    await post()

    expect(screen.getByText('Izvod je proknjižen.')).toBeInTheDocument()
    const splits = splitRows()
    expect(splits.map(r => r.amount)).toEqual([-1000, -199.22])
    expect(splits.map(r => r.amount_rsd)).toEqual([-1000, -199.22])
    expect(splits.map(r => r.cf_type)).toEqual(['one_time', 'one_time'])
  })

  it('an ordinary cost split the same way keeps each line cash-flow type', async () => {
    await openDialog()
    describeRow()
    typeIsplata('1199.22')
    toggleRow()
    await waitFor(() => expect(mockProps.split).toBeTruthy())
    typeSplit([{ ...lineOf('a', 1000), cf_type: 'recurring' }, lineOf('b', 199.22)])
    await post()

    expect(screen.getByText('Izvod je proknjižen.')).toBeInTheDocument()
    const splits = splitRows()
    expect(splits.map(r => r.amount)).toEqual([1000, 199.22])
    expect(splits.map(r => r.cf_type)).toEqual(['recurring', null])
  })

  it('lines that do not add up are refused before anything is written', async () => {
    await openDialog()
    describeRow()
    typeUplata('1199.22')
    toggleRow()
    subtype('📤 Trošak')
    await waitFor(() => expect(mockProps.split).toBeTruthy())
    typeSplit([lineOf('a', 1000), lineOf('b', 100)])
    await post()

    // Said in the magnitudes a person typed, and the right way round: short.
    expect(warning()).toContain('Stavke iznose 1.100,00, a ukupno je 1.199,22 — 99,22 nije raspoređeno.')
    expect(screen.queryByText('Izvod je proknjižen.')).toBeNull()
    expect(wrote('transactions')).toHaveLength(0)
    expect(wrote('pl_splits')).toHaveLength(0)
  })
})

// ── D3: once somebody has said what a row is, typing does not change it ────

describe('a subtype chosen is kept whichever box the figure goes into', () => {
  it('Prihod clicked, the amount typed into Isplata: still revenue', async () => {
    await openDialog()
    describeRow()
    toggleRow()
    subtype('📥 Prihod')
    typeIsplata('300')
    await post()
    const tx = theTransaction()
    expect(tx.tx_subtype).toBe('revenue')
    expect(tx.amount).toBe(300)
  })

  it('Trosak clicked on an isplata, the amount moved to Uplata: an expense, so a refund', async () => {
    await openDialog()
    describeRow()
    typeIsplata('300')
    toggleRow()
    subtype('📤 Trošak')
    typeUplata('300')
    expect(screen.getByText(REFUND_TAG)).toBeInTheDocument()
    await post()
    const tx = theTransaction()
    expect(tx.tx_subtype).toBe('expense')
    expect(tx.amount).toBe(-300)
    expect(tx.amount_rsd).toBe(-300)
    expect(tx.amount_eur).toBe(-2.56)
  })

  it('Prihod clicked on an uplata, the amount moved to Isplata: still revenue', async () => {
    await openDialog()
    describeRow()
    typeUplata('300')
    toggleRow()
    subtype('📥 Prihod')
    typeIsplata('300')
    expect(screen.queryByText(REFUND_TAG)).toBeNull()
    await post()
    const tx = theTransaction()
    expect(tx.tx_subtype).toBe('revenue')
    expect([tx.amount, tx.amount_rsd, tx.amount_eur]).toEqual([300, 300, 2.56])
  })

  it('a quick fill is a choice of expense: the amount moved to Uplata stays one', async () => {
    await openDialog()
    describeRow()
    typeIsplata('1784.4')
    toggleRow()
    await quickFill()
    typeUplata('1784.4')

    expect(screen.getByText(REFUND_TAG)).toBeInTheDocument()
    await post()
    const tx = theTransaction()
    expect(tx.tx_subtype).toBe('expense')
    expect(tx.amount).toBe(-1784.4)
    expect(tx.pl_category).toBe('Kancelarija')
    expect(tx.department).toBe('Uprava')
    // The script said recurring; a refund is one-time all the same.
    expect(tx.cf_type).toBe('one_time')
  })
})

// ── Classifying in the Trosak panel is the choice of expense ────────────────

describe('classifying in the Trosak panel is a choice of expense', () => {
  it('a category picked on an isplata, the amount moved to Uplata: a refund', async () => {
    await openDialog()
    describeRow()
    typeIsplata('1199.22')
    toggleRow()
    pick('Izaberite kategoriju…', 'Kancelarija')
    typeUplata('1199.22')

    expect(screen.getByText(REFUND_TAG)).toBeInTheDocument()
    expect(screen.getByText(REFUND_LINE_NOTE)).toBeInTheDocument()
    await post()
    const tx = theTransaction()
    expect(tx.tx_subtype).toBe('expense')
    expect(tx.pl_category).toBe('Kancelarija')
    expect([tx.amount, tx.amount_rsd, tx.amount_eur]).toEqual([-1199.22, -1199.22, -10.23])
  })

  it('a sector picked on an isplata, the amount moved to Uplata: a refund', async () => {
    await openDialog()
    describeRow()
    typeIsplata('1199.22')
    toggleRow()
    pick('Izaberite sektor…', 'Uprava')
    typeUplata('1199.22')

    expect(screen.getByText(REFUND_TAG)).toBeInTheDocument()
    await post()
    const tx = theTransaction()
    expect(tx.tx_subtype).toBe('expense')
    expect(tx.department).toBe('Uprava')
    expect([tx.amount, tx.amount_rsd, tx.amount_eur]).toEqual([-1199.22, -1199.22, -10.23])
  })

  it('a revenue stream picked on an uplata is no choice: moved to Isplata it follows to expense', async () => {
    await openDialog()
    describeRow()
    typeUplata('300')
    toggleRow()
    const streamSelect = screen.getByDisplayValue('Izaberite vrstu prihoda…')
    fireEvent.change(streamSelect, { target: { value: REVENUE_STREAMS[0] } })
    typeIsplata('300')

    expect(screen.queryByText(REFUND_TAG)).toBeNull()
    await post()
    const tx = theTransaction()
    // As before this round: the box decides, the figure stays positive, and
    // the stream typed while it was revenue is still written with it.
    expect(tx.tx_subtype).toBe('expense')
    expect([tx.amount, tx.amount_rsd, tx.amount_eur]).toEqual([300, 300, 2.56])
    expect(tx.revenue_stream).toBe(REVENUE_STREAMS[0])
  })
})

// ── A typed minus ───────────────────────────────────────────────────────────

describe('a typed minus', () => {
  it('is not a valid row and nothing is written', async () => {
    await openDialog()
    describeRow()
    typeUplata('-300')
    expect(screen.getByText('ispravnih: 0')).toBeInTheDocument()
    expect(screen.queryByText(REFUND_TAG)).toBeNull()
    const button = screen.getByText('Proknjiži (0)')
    expect(button).toBeDisabled()
    fireEvent.click(button)
    await act(async () => { await Promise.resolve() })
    expect(wrote('transactions')).toHaveLength(0)
    expect(mockState.writes).toHaveLength(0)
  })
})

// ── Review Focus 5 and 3: a statement reopened ──────────────────────────────

describe('Review Focus 5 and 3: a statement holding a refund and a storno, reopened', () => {
  const BATCH = 'batch-old'
  const stored = (over: Record<string, unknown>): any => ({
    import_batch_id: BATCH, transaction_date: DATE, partner_id: null, statement_number: '7',
    currency: 'RSD', exchange_rate: 1, eur_rate: EUR_RATE, type: 'direct', status: 'posted',
    is_advance: false, pl_impact: true,
    reference_number: null, model: null, account_number: null, revenue_stream: null,
    pl_subcategory: null, dept_subcategory: null, expense_description: null, project_id: null,
    cf_type: null, cf_frequency: null, cf_next_month_est: null,
    ...over,
  })
  const REFUND = stored({
    id: 'tx-refund', note: 'Povracaj za reklamaciju', tx_subtype: 'expense',
    amount: -1199.22, amount_rsd: -1199.22, amount_eur: -10.23,
    pl_category: 'Kancelarija', department: 'Uprava', cf_type: 'one_time',
  })
  // A storno as the payroll import writes it: a direct expense with a minus.
  const STORNO = stored({
    id: 'tx-storno', note: 'Storno: izmišljena obustava', tx_subtype: 'expense',
    amount: -50, amount_rsd: -50, amount_eur: -0.43,
    pl_category: 'Zarade', department: 'Uprava',
  })
  const COST = stored({
    id: 'tx-cost', note: 'Kancelarijski materijal', tx_subtype: 'expense',
    amount: 12500, amount_rsd: 12500, amount_eur: 106.66,
    pl_category: 'Kancelarija', department: 'Uprava',
    cf_type: 'recurring', cf_frequency: 'monthly', cf_next_month_est: 12500,
  })

  const reopen = async (transactions: any[] = [REFUND, STORNO, COST]) => {
    mockState.tables.transactions = transactions
    const log = {
      id: 'log-1', filing_ref: BATCH, company_id: 'co', bank_id: 'b1',
      file_name: 'Izvod #7', import_type: 'manual_statement', note: '', default_currency: 'RSD',
    }
    mockState.tables.import_logs = [log]
    render(<BankStatementDialog onClose={() => {}} onImported={() => {}} editLog={log} />)
    await waitFor(() => expect(cell('Opis', 0).value).toBe(transactions[0].note))
  }

  const save = async () => {
    fireEvent.click(screen.getByText('Sačuvaj izmene'))
    await waitFor(() =>
      expect(Boolean(screen.queryByText(/Izvod je sačuvan/)) || warning() !== '').toBe(true))
  }

  const updateOf = (id: string) => {
    const w = wrote('transactions', 'update').filter(u => u.filters.some(([c, v]) => c === 'id' && v === id))
    expect(w).toHaveLength(1)
    return w[0].payload
  }

  it('shows both in the Uplata column as magnitudes, still expenses, and tagged', async () => {
    await reopen()
    expect([cell('Uplata', 0).value, cell('Isplata', 0).value]).toEqual(['1199.22', ''])
    expect([cell('Uplata', 1).value, cell('Isplata', 1).value]).toEqual(['50', ''])
    expect([cell('Uplata', 2).value, cell('Isplata', 2).value]).toEqual(['', '12500'])
    expect(screen.getAllByText(REFUND_TAG)).toHaveLength(2)
    expect(cell('Uplata', 1)).toHaveStyle({ color: DIALOG.accent })
    // Still expenses: never turned into revenue on the way in.
    expect(screen.queryByText(/📥 Prihod/)).toBeNull()
    expect(screen.getByText('ispravnih: 3')).toBeInTheDocument()
  })

  it('a new figure typed into a reopened refund keeps it an expense', async () => {
    await reopen()
    typeUplata('1100', 0)
    expect(screen.getAllByText(REFUND_TAG)).toHaveLength(2)
    await save()

    const refund = updateOf('tx-refund')
    expect(refund.tx_subtype).toBe('expense')
    expect([refund.amount, refund.amount_rsd, refund.amount_eur]).toEqual([-1100, -1100, -9.39])
  })

  it('Review Focus 1 on the edit save: a refund in euros keeps all three figures negative', async () => {
    const EUR_REFUND = stored({
      id: 'tx-refund', note: 'Povracaj za reklamaciju', tx_subtype: 'expense', currency: 'EUR',
      amount: -1199.22, amount_rsd: -140548.58, amount_eur: -1199.22, exchange_rate: EUR_RATE,
      pl_category: 'Kancelarija', department: 'Uprava', cf_type: 'one_time',
    })
    await reopen([EUR_REFUND])
    expect([cell('Uplata', 0).value, cell('Isplata', 0).value]).toEqual(['1199.22', ''])
    await save()

    const refund = updateOf('tx-refund')
    expect(refund.currency).toBe('EUR')
    expect([refund.amount, refund.amount_rsd, refund.amount_eur]).toEqual([-1199.22, -140548.58, -1199.22])
    expect([refund.exchange_rate, refund.eur_rate]).toEqual([EUR_RATE, EUR_RATE])
  })

  it('a stored refund with stored split lines, saved untouched, writes back the same negative amount', async () => {
    mockState.tables.pl_splits = [
      { id: 'sp-1', source: 'transaction', source_id: 'tx-refund', amount: -1000 },
      { id: 'sp-2', source: 'transaction', source_id: 'tx-refund', amount: -199.22 },
    ]
    await reopen([REFUND])
    await save()

    // The stored lines are neither loaded nor rewritten here; they balance
    // only because the parent goes back exactly as it was.
    const refund = updateOf('tx-refund')
    expect(refund.amount).toBe(REFUND.amount)
    expect(refund.amount_rsd).toBe(REFUND.amount_rsd)
    expect(refund.amount_eur).toBe(REFUND.amount_eur)
    expect(refund.project_id).toBeNull()
    expect(mockState.writes.filter(w => w.table === 'pl_splits')).toHaveLength(0)
  })

  it('saved with nothing changed, writes each back as it was stored', async () => {
    await reopen()
    await save()

    expect(warning()).not.toContain('Stavke bez datuma ili iznosa')
    expect(screen.getByText(/Izvod je sačuvan — izmenjeno stavki: 3/)).toBeInTheDocument()

    const refund = updateOf('tx-refund')
    expect(refund).toMatchObject({
      type: 'direct', tx_subtype: 'expense', is_advance: false, pl_impact: true, currency: 'RSD',
      amount: -1199.22, amount_rsd: -1199.22, amount_eur: -10.23,
      exchange_rate: 1, eur_rate: EUR_RATE,
      pl_category: 'Kancelarija', department: 'Uprava', note: 'Povracaj za reklamaciju',
      cf_type: 'one_time', cf_frequency: null, cf_next_month_est: null, cf_accrual_from: null,
    })

    const storno = updateOf('tx-storno')
    expect(storno).toMatchObject({
      type: 'direct', tx_subtype: 'expense', pl_impact: true,
      amount: -50, amount_rsd: -50, amount_eur: -0.43,
      exchange_rate: 1, eur_rate: EUR_RATE,
      pl_category: 'Zarade', department: 'Uprava', note: 'Storno: izmišljena obustava',
    })
    // A refund is one-time (spec D2). The storno was stored with no cash-flow type; it is one-time now.
    expect(storno).toMatchObject({ cf_type: 'one_time', cf_frequency: null, cf_next_month_est: null })

    // The ordinary cost beside them is written exactly as before.
    const cost = updateOf('tx-cost')
    expect(cost).toMatchObject({
      tx_subtype: 'expense', amount: 12500, amount_rsd: 12500, amount_eur: 106.66,
      cf_type: 'recurring', cf_frequency: 'monthly', cf_next_month_est: 12500,
    })
    expect(cost).not.toHaveProperty('cf_accrual_from')
    expect(Object.keys(cost).sort()).toEqual(Object.keys(refund).filter(k => ![
      'cf_accrual_from', 'cf_accrual_to', 'cf_capex_months', 'cf_reimbursable_date',
    ].includes(k)).sort())
  })

  // ── A row split over P&L lines is changed in the transaction, not here ──
  //
  // The statement editor never loads or writes a row's split lines, and the
  // P&L reads those lines. A split row's amount, side or subtype changed here
  // would leave the lines saying the opposite of the row, so the save is
  // refused whole and points to the transaction.
  describe('a stored split expense', () => {
    const SPLIT = stored({
      id: 'tx-split', note: 'Toneri i papir', tx_subtype: 'expense',
      amount: 1199.22, amount_rsd: 1199.22, amount_eur: 10.23,
      pl_category: null, department: null,
    })
    const REFUSED = 'Stavka 1 je podeljena na više troškova, pa se njen iznos ovde ne menja. '
      + 'Otvorite tu transakciju iz Glavne knjige i izmenite je tamo.'
    const reopenSplit = async () => {
      mockState.tables.pl_splits = [
        { id: 'sp-1', source: 'transaction', source_id: 'tx-split', amount: 1000 },
        { id: 'sp-2', source: 'transaction', source_id: 'tx-split', amount: 199.22 },
      ]
      await reopen([SPLIT, COST])
    }

    it('saved untouched, is written back unchanged and its lines are not written', async () => {
      await reopenSplit()
      await save()

      expect(screen.getByText(/Izvod je sačuvan/)).toBeInTheDocument()
      expect(updateOf('tx-split')).toMatchObject({
        tx_subtype: 'expense', amount: 1199.22, amount_rsd: 1199.22, amount_eur: 10.23, project_id: null,
      })
      expect(mockState.writes.filter(w => w.table === 'pl_splits')).toHaveLength(0)
    })

    it('its figure moved to Uplata is refused whole and nothing is written', async () => {
      await reopenSplit()
      typeUplata('1199.22', 0)
      await save()

      expect(warning()).toBe(REFUSED)
      expect(screen.queryByText(/Izvod je sačuvan/)).toBeNull()
      expect(mockState.writes).toHaveLength(0)
    })

    it('its amount changed is refused whole and nothing is written', async () => {
      await reopenSplit()
      typeIsplata('1100', 0)
      await save()

      expect(warning()).toBe(REFUSED)
      expect(mockState.writes).toHaveLength(0)
    })

    it('only its note changed still saves', async () => {
      await reopenSplit()
      fireEvent.change(cell('Opis', 0), { target: { value: 'Toneri, papir i fascikle' } })
      await save()

      expect(screen.getByText(/Izvod je sačuvan/)).toBeInTheDocument()
      expect(updateOf('tx-split')).toMatchObject({
        note: 'Toneri, papir i fascikle', amount: 1199.22, amount_rsd: 1199.22, amount_eur: 10.23,
      })
      expect(mockState.writes.filter(w => w.table === 'pl_splits')).toHaveLength(0)
    })

    it('an unsplit row beside it can still be turned into a refund', async () => {
      await reopenSplit()
      typeUplata('12500', 1)
      await save()

      expect(screen.getByText(/Izvod je sačuvan/)).toBeInTheDocument()
      expect(updateOf('tx-cost')).toMatchObject({
        tx_subtype: 'expense', amount: -12500, amount_rsd: -12500, amount_eur: -106.66, cf_type: 'one_time',
      })
      expect(updateOf('tx-split')).toMatchObject({ amount: 1199.22, amount_rsd: 1199.22 })
    })
  })
})
