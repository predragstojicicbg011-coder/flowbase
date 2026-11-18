import React from 'react'
import { render, screen, fireEvent, waitFor, cleanup, act, within } from '@testing-library/react'
import TransactionDialog from './TransactionDialog'
import {
  REFUND_SWITCH, REFUND_SWITCH_NOTE, REFUND_ONE_TIME_NOTE, REFUND_CASH_FLOW,
} from '../services/refund'
import { fmtMoney } from '../utils/formatters'

// ── A direct expense marked "Ovo je povraćaj" ───────────────────────────────
//
// Money came back from a supplier. It is booked as a direct expense with a
// minus in all three figures, so it reduces the expense it is filed under
// (services/refund.ts). What a person types is a magnitude; the dialog puts
// the minus on what it WRITES and takes it off what it READS.
//
// This dialog is also how rows already booked are corrected: a refund stored
// as a positive expense is opened, the switch turned on, and saved. So the
// update payloads are compared whole — the refund's is the ordinary edit's,
// with the minus on the figures and the refund's cash flow.
//
// Driven through the real dialog over a mocked database. `whySplitNotSavable`,
// `saveSplits` and the book-amount functions are the real ones; only the split
// editor is a stub, so its lines can be set through its own `onChange`.

/** The props the split editor was last rendered with. */
const mockSplitEditor: { props: any } = { props: null }

jest.mock('../supabase', () => {
  const db: any = { rows: {} as Record<string, any[]>, writes: [] as any[], seq: 0 }

  const make = (table: string) => {
    const st: any = {
      op: 'select', payload: null, filters: [] as [string, any][],
      single: false, head: false, cols: '', order: [] as [string, boolean][],
    }
    const matches = (r: any) => st.filters.every((f: [string, any]) => r[f[0]] === f[1])
    const sorted = (rows: any[]) => {
      if (st.order.length === 0) return rows
      return [...rows].sort((a, b) => {
        for (const [col, asc] of st.order as [string, boolean][]) {
          const x = a[col]
          const y = b[col]
          if (x === y) continue
          if (x === null || x === undefined) return 1
          if (y === null || y === undefined) return -1
          const d = typeof x === 'number' && typeof y === 'number' ? x - y : String(x).localeCompare(String(y))
          if (d !== 0) return asc ? d : -d
        }
        return 0
      })
    }
    function project(row: any) {
      const cols = String(st.cols || '').trim()
      if (!cols || cols.includes('*') || cols.includes('(')) return row
      const names = cols.split(',').map(s2 => s2.trim()).filter(Boolean)
      if (names.some(n => !/^[a-z_][a-z0-9_]*$/i.test(n))) return row
      const out: any = {}
      for (const n of names) out[n] = row[n]
      return out
    }
    const settle = () => {
      if (st.op === 'insert' || st.op === 'upsert') {
        const list = Array.isArray(st.payload) ? st.payload : [st.payload]
        const made = list.map((p: any) => ({ id: `${table}-${++db.seq}`, ...p }))
        db.writes.push({ table, op: st.op, rows: made, payload: st.payload, filters: st.filters })
        db.rows[table] = [...(db.rows[table] || []), ...made]
        const back = made.map(project)
        return { data: st.single ? back[0] : back, error: null }
      }
      if (st.op === 'update') {
        db.writes.push({ table, op: 'update', payload: st.payload, filters: st.filters })
        const hit = (db.rows[table] || []).filter(matches)
        db.rows[table] = (db.rows[table] || []).map((r: any) => (matches(r) ? { ...r, ...st.payload } : r))
        return { data: hit.map((r: any) => project({ ...r, ...st.payload })), error: null }
      }
      if (st.op === 'delete') {
        db.writes.push({ table, op: 'delete', filters: st.filters })
        db.rows[table] = (db.rows[table] || []).filter((r: any) => !matches(r))
        return { data: [], error: null }
      }
      const rows = sorted((db.rows[table] || []).filter(matches)).map(project)
      if (st.single) return { data: rows[0] ?? null, error: null }
      if (st.head) return { data: null, count: rows.length, error: null }
      return { data: rows, count: rows.length, error: null }
    }
    const c: any = {}
    c.select = (cols: string, opts?: any) => {
      st.cols = cols || ''
      if (opts && opts.head) st.head = true
      return c
    }
    c.insert = (payload: any) => { st.op = 'insert'; st.payload = payload; return c }
    c.update = (payload: any) => { st.op = 'update'; st.payload = payload; return c }
    c.upsert = (payload: any) => { st.op = 'upsert'; st.payload = payload; return c }
    c.delete = () => { st.op = 'delete'; return c }
    c.eq = (col: string, v: any) => { st.filters.push([col, v]); return c }
    c.single = () => { st.single = true; return Promise.resolve(settle()) }
    c.maybeSingle = () => { st.single = true; return Promise.resolve(settle()) }
    c.order = (col: string, opts?: { ascending?: boolean }) => {
      st.order.push([col, opts?.ascending !== false])
      return c
    }
    ;['neq', 'gt', 'gte', 'lt', 'lte', 'in', 'is', 'not', 'or', 'filter', 'limit', 'ilike', 'range']
      .forEach(m => { c[m] = () => c })
    c.then = (ok: any, err: any) => Promise.resolve(settle()).then(ok, err)
    return c
  }

  return { supabase: { from: make, rpc: () => Promise.resolve({ data: null, error: null }) }, __db: db }
})
jest.mock('../contexts/CompaniesContext', () => {
  const ctx = {
    companies: [{ id: 'co', name: 'Izmišljena Firma doo', currencies: ['RSD', 'EUR'] }],
    defaultCompany: { id: 'co', name: 'Izmišljena Firma doo' }, showPicker: false, loading: false,
  }
  return { useCompanies: () => ctx }
})
jest.mock('../contexts/ProjectsContext', () => {
  const ctx = { projects: [] }
  return { useProjects: () => ctx }
})
jest.mock('../contexts/SystemCategoriesContext', () => {
  const ctx = { map: {}, loading: false }
  return { useSystemCategories: () => ctx }
})
// 1 EUR = 117.2 RSD on every date.
jest.mock('../services/bookAmounts', () => ({
  ...jest.requireActual('../services/bookAmounts'),
  getBookRates: async (date: string) => ({ date, eurRate: 117.2, usdRate: 100, source: 'test' }),
}))
jest.mock('../services/allPartners', () => ({
  fetchAllPartners: async () => [{ id: 'p1', name: 'Kupac Primer doo' }],
}))
jest.mock('./SplitEditor', () => (props: any) => { mockSplitEditor.props = props; return null })
jest.mock('./ProjectSelect', () => () => null)
jest.mock('./CreditInstallmentSelector', () => () => null)

const db = () => (jest.requireMock('../supabase') as any).__db

// ── The fixtures (invented names only) ──────────────────────────────────────

const ROW_ID = 'tx-stored'

/** A direct expense in dinars as it sits in the ledger: 1199.22 RSD at 117.2. */
const storedRow = (over: Record<string, unknown> = {}) => ({
  id: ROW_ID, company_id: 'co', bank_id: 'b1', partner_id: null,
  transaction_date: '2026-11-12', statement_number: '44',
  type: 'direct', tx_subtype: 'expense', is_advance: false,
  currency: 'RSD', amount: 1199.22, exchange_rate: 1, eur_rate: 117.2,
  amount_rsd: 1199.22, amount_eur: 10.23,
  is_indexed: false, pl_impact: true,
  pl_category: 'Kancelarija', pl_subcategory: null, department: 'Uprava',
  dept_subcategory: null, expense_description: null, revenue_stream: null,
  project_id: null, dept_split_type: 'none',
  cf_type: 'one_time', cf_frequency: null, cf_next_month_est: null,
  cf_accrual_from: null, cf_accrual_to: null, cf_capex_months: null, cf_reimbursable_date: null,
  account_number: null, model: null, reference_number: null,
  note: 'Reklamacija toner', tags: null, status: 'posted',
  ...over,
})

/** The same row stored as a refund: all three figures negative. */
const REFUND_FIGURES = { amount: -1199.22, amount_rsd: -1199.22, amount_eur: -10.23 }

/** The same purchase in euros: 1199.22 EUR at 117.2. */
const EUR_ROW = {
  bank_id: 'b2', currency: 'EUR', amount: 1199.22, exchange_rate: 117.2, eur_rate: 117.2,
  amount_rsd: 140548.58, amount_eur: 1199.22,
}

beforeEach(() => {
  const d = db()
  d.seq = 0
  d.writes.length = 0
  mockSplitEditor.props = null
  d.rows = {
    banks: [
      { id: 'b1', name: 'Izmišljena Banka RSD', company_id: 'co', currency: 'RSD' },
      { id: 'b2', name: 'Izmišljena Banka EUR', company_id: 'co', currency: 'EUR' },
    ],
    pl_categories: [
      { id: 'c1', name: 'Kancelarija', type: 'expense', sort_order: 1 },
      { id: 'c2', name: 'Zarade', type: 'expense', sort_order: 2 },
    ],
    pl_subcategories: [],
    departments: [{ id: 'd1', name: 'Uprava', sort_order: 1 }],
    partner_accounts: [],
    quick_fill_scripts: [{
      id: 'qf-1', name: 'Kancelarijski materijal', icon: '⚡', sort_order: 1,
      pl_category: 'Kancelarija', pl_subcategory: '', department: 'Uprava', cf_type: 'recurring',
    }],
    pl_splits: [], v_invoice_status: [], invoice_transaction_links: [], invoices: [],
    transactions: [storedRow()], passthrough: [],
    credits: [], credit_installments: [],
  }
})

afterEach(cleanup)

// ── Driving the dialog ──────────────────────────────────────────────────────

/** A step in the bar at the top, by its title. */
const goTo = (title: string) => fireEvent.click(screen.getAllByText(title)[0])

/** The select under a label, found by how the label starts. */
const underLabel = (label: string) => {
  const lbl = screen.getAllByText((_t, el) =>
    el?.tagName === 'LABEL' && (el.textContent || '').startsWith(label))[0]
  return lbl.parentElement!.querySelector('select') as HTMLSelectElement
}

const refundSwitch = () => screen.queryByRole('checkbox', { name: REFUND_SWITCH }) as HTMLInputElement | null

/** Lets the dialog read what it reads on open. */
const settle = async () => {
  for (let i = 0; i < 4; i++) {
    // eslint-disable-next-line no-await-in-loop
    await act(async () => { await new Promise(r => setTimeout(r, 0)) })
  }
}

/** A new direct expense, on the classification step, with the rate fetched. */
const openNewDirect = async (amount: string, bank: 'b1' | 'b2' = 'b1') => {
  render(<TransactionDialog onClose={jest.fn()} />)
  await screen.findByText('Nova transakcija')
  await waitFor(() => expect(underLabel('Banka / račun').querySelectorAll('option').length).toBe(3))
  fireEvent.change(underLabel('Banka / račun'), { target: { value: bank } })
  fireEvent.change(underLabel('Valuta'), { target: { value: bank === 'b1' ? 'RSD' : 'EUR' } })

  goTo('Iznos i valuta')
  fireEvent.change(screen.getByPlaceholderText('0.00'), { target: { value: amount } })
  fireEvent.click(screen.getByText('Preuzmi'))
  await screen.findByText('Izvor: test')

  goTo('Tip i klasifikacija')
  fireEvent.click(screen.getByText('Direktna transakcija'))
  await screen.findByText('P&L klasifikacija')
}

/** A stored row opened for editing, on the classification step. */
const openStored = async (row: Record<string, unknown>) => {
  render(<TransactionDialog onClose={jest.fn()} transaction={row} />)
  await screen.findByText('Izmena transakcije')
  await settle()
  goTo('Tip i klasifikacija')
  await settle()
}

/** Kancelarija · Uprava through the quick fill, whose template says recurring. */
const classify = async () => {
  fireEvent.focus(screen.getByPlaceholderText('⚡ Brza popuna — kliknite ili pretražite…'))
  fireEvent.mouseDown(await screen.findByText('⚡ Kancelarijski materijal'))
}

const turnSwitch = (on: boolean) => {
  const box = refundSwitch()
  expect(box).toBeTruthy()
  if (box!.checked !== on) fireEvent.click(box!)
  expect(refundSwitch()!.checked).toBe(on)
}

/** A Podtip chip. */
const subtype = (label: '📤 Trošak' | '📥 Prihod') =>
  fireEvent.click(within(screen.getByText('Podtip').parentElement as HTMLElement).getByText(label))

/** The value beside a label in the review table. */
const reviewValue = (label: string) => {
  const cellOf = screen.getAllByText(label).find(el => el.tagName === 'TD')
  expect(cellOf).toBeTruthy()
  return (cellOf!.nextElementSibling as HTMLElement).textContent
}

/** A figure in the conversion row of the amount step, under its label. */
const stepTwoValue = (label: string) =>
  (screen.getByText(label).nextElementSibling as HTMLElement).textContent

const SAVE = /^(Proknjiži transakciju|Sačuvaj izmene)$/
const DONE = /^Transakcija je (proknjižena|izmenjena)\.$/

/** Press save on the review step and wait for the dialog to say it saved. */
const save = async () => {
  goTo('Pregled')
  fireEvent.click(await screen.findByText(SAVE))
  await waitFor(() => expect(screen.queryByText(DONE)).toBeTruthy())
}

/** Press save on a form that must be refused, and give it every chance to write. */
const saveRefused = async () => {
  goTo('Pregled')
  fireEvent.click(await screen.findByText(SAVE))
  await settle()
  expect(screen.queryByText(DONE)).toBeNull()
}

const wrote = (table: string, op = 'insert') =>
  db().writes.filter((w: any) => w.table === table && w.op === op)

const theInsert = (table = 'transactions') => {
  const tx = wrote(table)
  expect(tx).toHaveLength(1)
  return tx[0].payload
}

const theUpdate = () => {
  const tx = wrote('transactions', 'update')
  expect(tx).toHaveLength(1)
  expect(tx[0].filters).toEqual([['id', ROW_ID]])
  return tx[0].payload
}

/** What the split lines became, in the order written. */
const splitRowsWritten = () => wrote('pl_splits').flatMap((w: any) => w.rows)

const line = (key: string, amount: number) => ({
  key, amount, pl_category: 'Kancelarija', pl_subcategory: '', department: 'Uprava',
  project_id: null, cf_type: '', note: '',
})
const typeSplit = (lines: any[]) => act(() => { mockSplitEditor.props.onChange(lines) })

/** A stored split line of this amount. */
const storedLine = (id: string, order: number, amount: number, rsd: number, eur: number) => ({
  id, source: 'transaction', source_id: ROW_ID, sort_order: order,
  amount, amount_rsd: rsd, amount_eur: eur,
  pl_category: 'Kancelarija', pl_subcategory: null, department: 'Uprava',
  project_id: null, cf_type: null, note: null,
})

/** The split lines as sent to the database (without the ids the mock gives them). */
const splitPayloadsWritten = () =>
  wrote('pl_splits').flatMap((w: any) => ([] as any[]).concat(w.payload))

/** The two stored lines of the 1199.22 row, positive. */
const positiveLines = () => [
  storedLine('s1', 0, 1000, 1000, 8.53),
  storedLine('s2', 1, 199.22, 199.22, 1.7),
]
/** The same two lines stored as a refund. */
const negativeLines = () => [
  storedLine('s1', 0, -1000, -1000, -8.53),
  storedLine('s2', 1, -199.22, -199.22, -1.7),
]
/** Split rows as a refund writes them: the three figures negated and one-time, everything else as it was. */
const negated = (rows: any[]) => rows.map(r => ({
  ...r, amount: -r.amount, amount_rsd: -r.amount_rsd, amount_eur: -r.amount_eur, cf_type: 'one_time',
}))

/**
 * What an ordinary edit of this row writes, nothing changed: the update and
 * the split lines (when `lines` are stored with it). Leaves the database as
 * it found it, so the same row can be opened again.
 */
const ordinaryEditOf = async (row: Record<string, unknown>, lines: any[] = []) => {
  db().rows.transactions = [row]
  db().rows.pl_splits = lines
  await openStored(row)
  if (lines.length > 0) await waitFor(() => expect(mockSplitEditor.props.lines).toHaveLength(lines.length))
  await save()
  const payload = theUpdate()
  const splits = splitPayloadsWritten()
  cleanup()
  db().writes.length = 0
  mockSplitEditor.props = null
  return { payload, splits }
}
const ordinaryUpdateOf = async (row: Record<string, unknown>) => (await ordinaryEditOf(row)).payload

/** The stored row closes a supplier bill. */
const linkABill = () => {
  db().rows.invoice_transaction_links = [{
    invoice_id: 'inv-1', transaction_id: ROW_ID, allocated_amount: 1199.22, allocated_amount_rsd: 1199.22,
    invoices: {
      id: 'inv-1', invoice_number: 'UF-17/2026', invoice_date: '2026-11-01', due_date: '2026-11-15',
      currency: 'RSD', amount: 1199.22, amount_rsd: 1199.22, exchange_rate: 1, eur_rate: 117.2,
      project_id: null, type: 'expense', advance_deducted: 0, partners: { name: 'Dobavljač Primer doo' },
    },
  }]
  db().rows.v_invoice_status = [{
    id: 'inv-1', company_id: 'co', document_type: 'invoice', calculated_status: 'paid',
    amount: 1199.22, paid_amount: 1199.22,
  }]
}

// ── 1, 2, 3: a new direct expense ───────────────────────────────────────────

describe('a new direct transaction', () => {
  it('1. marked as a refund is written with a minus in all three figures and as one-time', async () => {
    await openNewDirect('1199.22')
    await classify()
    expect(refundSwitch()!.checked).toBe(false)
    turnSwitch(true)

    expect(screen.getByText(REFUND_SWITCH_NOTE)).toBeInTheDocument()
    expect(screen.getByText(REFUND_ONE_TIME_NOTE)).toBeInTheDocument()
    expect(screen.queryByText('🔁 Ponavljajući')).toBeNull()
    expect(screen.queryByText('1️⃣ Jednokratni')).toBeNull()
    expect(screen.queryByText('↩️ Refundacija')).toBeNull()
    // What is typed and checked against stays a magnitude.
    expect(mockSplitEditor.props.parent.amount).toBe(1199.22)
    expect(mockSplitEditor.props.parent.amount_rsd).toBe(1199.22)

    goTo('Pregled')
    expect(screen.getByText('Direktna (trošak) · Povraćaj')).toBeInTheDocument()
    // The booked figures as they will be booked; the typed amount as typed.
    expect(reviewValue('Originalni iznos')).toBe(fmtMoney(1199.22, 'RSD'))
    expect(reviewValue('RSD (knjiženo)')).toBe(fmtMoney(-1199.22, 'RSD'))
    expect(reviewValue('EUR')).toBe(fmtMoney(-10.23, 'EUR'))
    expect(reviewValue('Originalni iznos')).not.toContain('-')
    await save()

    const tx = theInsert()
    expect(tx.type).toBe('direct')
    expect(tx.tx_subtype).toBe('expense')
    expect(tx.is_advance).toBe(false)
    expect(tx.pl_impact).toBe(true)
    expect(tx.amount).toBe(-1199.22)
    expect(tx.amount_rsd).toBe(-1199.22)
    expect(tx.amount_eur).toBe(-10.23)
    expect(tx.exchange_rate).toBe(1)
    expect(tx.eur_rate).toBe(117.2)
    expect(tx.pl_category).toBe('Kancelarija')
    expect(tx.department).toBe('Uprava')
    // The template said recurring; a refund is one-time all the same.
    expect(tx).toMatchObject(REFUND_CASH_FLOW)
    expect(tx.cf_type).toBe('one_time')
    expect(tx.cf_frequency).toBeNull()
    expect(tx.cf_next_month_est).toBeNull()
  })

  it('2. without the switch is written exactly as before, with the cash-flow type chosen', async () => {
    await openNewDirect('1199.22')
    await classify()
    expect(screen.getByText(REFUND_SWITCH)).toBeInTheDocument()
    // What the switch does is read before it is turned on.
    expect(screen.getByText(REFUND_SWITCH_NOTE)).toBeInTheDocument()
    expect(screen.queryByText(REFUND_ONE_TIME_NOTE)).toBeNull()
    expect(screen.getByText('🔁 Ponavljajući')).toBeInTheDocument()
    expect(screen.getByText('↩️ Refundacija')).toBeInTheDocument()
    goTo('Pregled')
    expect(screen.getByText('Direktna (trošak)')).toBeInTheDocument()
    expect(reviewValue('Originalni iznos')).toBe(fmtMoney(1199.22, 'RSD'))
    expect(reviewValue('RSD (knjiženo)')).toBe(fmtMoney(1199.22, 'RSD'))
    expect(reviewValue('EUR')).toBe(fmtMoney(10.23, 'EUR'))
    await save()

    const tx = theInsert()
    expect(tx.amount).toBe(1199.22)
    expect(tx.amount_rsd).toBe(1199.22)
    expect(tx.amount_eur).toBe(10.23)
    expect(tx.cf_type).toBe('recurring')
    expect(tx.cf_frequency).toBe('monthly')
    expect(tx.cf_next_month_est).toBe(1199.22)
    expect(tx.cf_accrual_from).toBeNull()
  })

  it.each(['0', ''])('3. an amount of %p with the switch on is refused and nothing is written', async (typed) => {
    await openNewDirect(typed)
    await classify()
    turnSwitch(true)
    await saveRefused()

    expect(screen.getAllByText(/Iznos mora biti veći od 0/).length).toBeGreaterThan(0)
    expect(db().writes).toHaveLength(0)
  })

  it('3b. a typed minus with the switch on is refused and nothing is written', async () => {
    await openNewDirect('-1199.22')
    await classify()
    turnSwitch(true)
    await saveRefused()

    expect(screen.getAllByText(/Iznos mora biti veći od 0/).length).toBeGreaterThan(0)
    expect(db().writes).toHaveLength(0)
  })

  it('4. split lines typed positive are written negative, beside a signed parent', async () => {
    await openNewDirect('1199.22')
    turnSwitch(true)
    typeSplit([line('a', 1000), line('b', 199.22)])
    // The editor is given the magnitude to balance against.
    expect(mockSplitEditor.props.parent.amount).toBe(1199.22)
    await save()

    const tx = theInsert()
    expect(tx.amount).toBe(-1199.22)
    expect(tx.amount_rsd).toBe(-1199.22)
    expect(tx.amount_eur).toBe(-10.23)
    expect(tx).toMatchObject(REFUND_CASH_FLOW)
    const rows = splitRowsWritten()
    expect(rows.map((r: any) => r.amount)).toEqual([-1000, -199.22])
    expect(rows.map((r: any) => r.amount_rsd)).toEqual([-1000, -199.22])
    expect(rows.map((r: any) => r.amount_eur)).toEqual([-8.53, -1.7])
    expect(rows.every((r: any) => r.source_id === wrote('transactions')[0].rows[0].id)).toBe(true)
  })

  it('4b. without the switch the same lines are written positive, as before', async () => {
    await openNewDirect('1199.22')
    typeSplit([line('a', 1000), line('b', 199.22)])
    await save()

    expect(theInsert().amount).toBe(1199.22)
    expect(splitRowsWritten().map((r: any) => r.amount)).toEqual([1000, 199.22])
    expect(splitRowsWritten().map((r: any) => r.amount_eur)).toEqual([8.53, 1.7])
  })

  it('4c. every split line of a refund is written one-time, a recurring one included', async () => {
    await openNewDirect('1199.22')
    turnSwitch(true)
    typeSplit([{ ...line('a', 1000), cf_type: 'recurring' }, line('b', 199.22)])
    await save()

    const rows = splitRowsWritten()
    expect(rows.map((r: any) => r.amount)).toEqual([-1000, -199.22])
    expect(rows.map((r: any) => r.amount_rsd)).toEqual([-1000, -199.22])
    expect(rows.map((r: any) => r.cf_type)).toEqual(['one_time', 'one_time'])
  })

  it('4d. without the switch the same lines keep each its own cash-flow type', async () => {
    await openNewDirect('1199.22')
    typeSplit([{ ...line('a', 1000), cf_type: 'recurring' }, line('b', 199.22)])
    await save()

    const rows = splitRowsWritten()
    expect(rows.map((r: any) => r.amount)).toEqual([1000, 199.22])
    expect(rows.map((r: any) => r.cf_type)).toEqual(['recurring', null])
  })

  it('8. a refund in euros has all three figures negative and both rates positive', async () => {
    await openNewDirect('1199.22', 'b2')
    await classify()
    turnSwitch(true)
    await save()

    const tx = theInsert()
    expect(tx.currency).toBe('EUR')
    expect(tx.amount).toBe(-1199.22)
    expect(tx.amount_rsd).toBe(-140548.58)
    expect(tx.amount_eur).toBe(-1199.22)
    expect(tx.exchange_rate).toBe(117.2)
    expect(tx.eur_rate).toBe(117.2)
    expect(tx).toMatchObject(REFUND_CASH_FLOW)
  })
})

// ── 5, 6: editing a stored row, both ways (D12) ─────────────────────────────

describe('editing a stored row', () => {
  it('a stored row saved unchanged writes back what it was read with', async () => {
    const row = storedRow({ cf_type: 'recurring', cf_frequency: 'monthly', cf_next_month_est: 1199.22 })
    await openStored(row)
    expect(refundSwitch()!.checked).toBe(false)
    goTo('Iznos i valuta')
    expect(stepTwoValue('RSD (knjiženo)')).toBe(fmtMoney(1199.22, 'RSD'))
    expect(stepTwoValue('EUR')).toBe(fmtMoney(10.23, 'EUR'))
    goTo('Pregled')
    expect(reviewValue('RSD (knjiženo)')).toBe(fmtMoney(1199.22, 'RSD'))
    expect(reviewValue('EUR')).toBe(fmtMoney(10.23, 'EUR'))
    await save()

    const p = theUpdate()
    const asStored = Object.fromEntries(Object.keys(p).map(k => [k, (row as any)[k]]))
    expect(p).toEqual(asStored)
  })

  it('5a. a stored refund opens with the switch on and its magnitude in the field', async () => {
    await openStored(storedRow(REFUND_FIGURES))
    expect(refundSwitch()!.checked).toBe(true)
    expect(screen.getByText(REFUND_SWITCH_NOTE)).toBeInTheDocument()
    expect(screen.getByText(REFUND_ONE_TIME_NOTE)).toBeInTheDocument()
    expect(mockSplitEditor.props.parent.amount).toBe(1199.22)
    goTo('Iznos i valuta')
    expect((screen.getByPlaceholderText('0.00') as HTMLInputElement).value).toBe('1199.22')
    // Already a refund here, so the book figures carry the minus they will be booked with.
    expect(stepTwoValue('Originalni iznos')).toBe(fmtMoney(1199.22, 'RSD'))
    expect(stepTwoValue('RSD (knjiženo)')).toBe(fmtMoney(-1199.22, 'RSD'))
    expect(stepTwoValue('EUR')).toBe(fmtMoney(-10.23, 'EUR'))
    goTo('Pregled')
    expect(reviewValue('RSD (knjiženo)')).toBe(fmtMoney(-1199.22, 'RSD'))
    expect(reviewValue('EUR')).toBe(fmtMoney(-10.23, 'EUR'))
  })

  it('5b. a stored refund saved with the switch off is positive and nothing else changes', async () => {
    const ordinary = await ordinaryUpdateOf(storedRow())

    await openStored(storedRow(REFUND_FIGURES))
    turnSwitch(false)
    await save()
    const p = theUpdate()
    expect(p.amount).toBe(1199.22)
    expect(p).toEqual(ordinary)
  })

  it('5c. a stored positive cost saved with the switch on gets a minus and nothing else changes', async () => {
    const recurring = { cf_type: 'recurring', cf_frequency: 'monthly', cf_next_month_est: 1199.22 }
    const ordinary = await ordinaryUpdateOf(storedRow(recurring))

    await openStored(storedRow(recurring))
    expect(refundSwitch()!.checked).toBe(false)
    turnSwitch(true)
    await save()
    const refund = theUpdate()

    expect(ordinary.amount).toBe(1199.22)
    expect(ordinary.cf_type).toBe('recurring')
    expect(refund).toEqual({ ...ordinary, ...REFUND_FIGURES, ...REFUND_CASH_FLOW })
  })

  it('5d. the same in euros: all three figures negative and both rates positive', async () => {
    const ordinary = await ordinaryUpdateOf(storedRow(EUR_ROW))

    await openStored(storedRow(EUR_ROW))
    turnSwitch(true)
    await save()
    const refund = theUpdate()

    expect(refund).toEqual({
      ...ordinary,
      amount: -1199.22, amount_rsd: -140548.58, amount_eur: -1199.22,
      ...REFUND_CASH_FLOW,
    })
    expect(refund.exchange_rate).toBe(117.2)
    expect(refund.eur_rate).toBe(117.2)
  })

  it('5e. a stored positive cost split into lines: the switch puts the minus on the lines too', async () => {
    const ordinary = await ordinaryEditOf(storedRow(), positiveLines())
    expect(ordinary.splits.map((r: any) => r.amount)).toEqual([1000, 199.22])
    db().rows.pl_splits = positiveLines()

    await openStored(storedRow())
    await waitFor(() => expect(mockSplitEditor.props.lines).toHaveLength(2))
    turnSwitch(true)
    await save()

    expect(theUpdate()).toEqual({ ...ordinary.payload, ...REFUND_FIGURES, ...REFUND_CASH_FLOW })
    const rows = splitPayloadsWritten()
    expect(rows).toEqual(negated(ordinary.splits))
    expect(rows.map((r: any) => r.amount)).toEqual([-1000, -199.22])
    expect(rows.map((r: any) => r.amount_rsd)).toEqual([-1000, -199.22])
    expect(rows.map((r: any) => r.amount_eur)).toEqual([-8.53, -1.7])
  })

  it('5f. a stored refund with lines opens them as magnitudes, and with the switch off writes them positive', async () => {
    const ordinary = await ordinaryEditOf(storedRow(), positiveLines())

    db().rows.transactions = [storedRow(REFUND_FIGURES)]
    db().rows.pl_splits = negativeLines()
    await openStored(storedRow(REFUND_FIGURES))
    await waitFor(() => expect(mockSplitEditor.props.lines).toHaveLength(2))
    expect(mockSplitEditor.props.lines.map((l: any) => l.amount)).toEqual([1000, 199.22])
    turnSwitch(false)
    await save()

    expect(theUpdate()).toEqual(ordinary.payload)
    expect(ordinary.payload).toMatchObject({ amount: 1199.22, amount_rsd: 1199.22, amount_eur: 10.23 })
    const rows = splitPayloadsWritten()
    expect(rows).toEqual(ordinary.splits)
    expect(rows.map((r: any) => r.amount)).toEqual([1000, 199.22])
    expect(rows.map((r: any) => r.amount_rsd)).toEqual([1000, 199.22])
    expect(rows.map((r: any) => r.amount_eur)).toEqual([8.53, 1.7])
  })

  it('5g. a stored refund with lines, saved unchanged, keeps every minus', async () => {
    const ordinary = await ordinaryEditOf(storedRow(), positiveLines())

    db().rows.transactions = [storedRow(REFUND_FIGURES)]
    db().rows.pl_splits = negativeLines()
    await openStored(storedRow(REFUND_FIGURES))
    await waitFor(() => expect(mockSplitEditor.props.lines).toHaveLength(2))
    await save()

    expect(theUpdate()).toEqual({ ...ordinary.payload, ...REFUND_FIGURES, ...REFUND_CASH_FLOW })
    const rows = splitPayloadsWritten()
    expect(rows).toEqual(negated(ordinary.splits))
    expect(rows.map((r: any) => r.amount)).toEqual([-1000, -199.22])
    expect(rows.map((r: any) => r.amount_rsd)).toEqual([-1000, -199.22])
    expect(rows.map((r: any) => r.amount_eur)).toEqual([-8.53, -1.7])
  })

  it('6. a payroll storno opened and saved unchanged goes back as it was', async () => {
    const storno = storedRow({
      amount: -50, amount_rsd: -50, amount_eur: -0.43,
      pl_category: 'Zarade', note: 'Storno neto zarade',
      cf_type: 'recurring', cf_frequency: 'monthly', cf_next_month_est: -50,
    })
    db().rows.transactions = [storno]
    await openStored(storno)
    expect(refundSwitch()!.checked).toBe(true)
    goTo('Iznos i valuta')
    expect((screen.getByPlaceholderText('0.00') as HTMLInputElement).value).toBe('50')
    await save()

    const p = theUpdate()
    expect(p.amount).toBe(-50)
    expect(p.amount_rsd).toBe(-50)
    expect(p.amount_eur).toBe(-0.43)
    // Everything it was read with, written back — but its cash flow, which a
    // refund always books as one-time (D2).
    const asStored = Object.fromEntries(Object.keys(p).map(k => [k, (storno as any)[k]]))
    expect(p).toEqual({ ...asStored, ...REFUND_CASH_FLOW })
  })
})

// ── 7: the switch belongs to a direct expense only ─────────────────────────

describe('7. the switch belongs to a direct expense only', () => {
  it('choosing revenue turns it off and writes an ordinary revenue with a positive amount', async () => {
    await openNewDirect('1199.22')
    await classify()
    turnSwitch(true)

    subtype('📥 Prihod')
    expect(refundSwitch()).toBeNull()
    expect(screen.queryByText(REFUND_SWITCH_NOTE)).toBeNull()
    fireEvent.change(underLabel('Vrsta prihoda'), { target: { value: 'Ostalo' } })
    goTo('Pregled')
    expect(screen.getByText('Direktna (prihod)')).toBeInTheDocument()
    await save()

    const tx = theInsert()
    expect(tx.tx_subtype).toBe('revenue')
    expect(tx.amount).toBe(1199.22)
    expect(tx.amount_rsd).toBe(1199.22)
    expect(tx.amount_eur).toBe(10.23)
    expect(tx.cf_type).toBeNull()
    expect(tx.cf_accrual_from).toBeNull()
  })

  it('back to expense after revenue the switch is off and the write is positive', async () => {
    await openNewDirect('1199.22')
    await classify()
    turnSwitch(true)
    subtype('📥 Prihod')
    subtype('📤 Trošak')
    expect(refundSwitch()!.checked).toBe(false)
    await save()

    const tx = theInsert()
    expect(tx.amount).toBe(1199.22)
    expect(tx.amount_rsd).toBe(1199.22)
    expect(tx.cf_type).toBe('recurring')
  })

  it.each([
    ['Plaćanje fakture'],
    ['Prolazna stavka'],
    ['Otplata kredita'],
  ])('the %s card turns it off: back on direct, the write is positive', async (card) => {
    await openNewDirect('1199.22')
    await classify()
    turnSwitch(true)
    fireEvent.click(screen.getByText(card))
    expect(refundSwitch()).toBeNull()
    fireEvent.click(screen.getByText('Direktna transakcija'))
    expect(refundSwitch()!.checked).toBe(false)
    await save()

    const tx = theInsert()
    expect(tx.amount).toBe(1199.22)
    expect(tx.amount_rsd).toBe(1199.22)
    expect(tx.amount_eur).toBe(10.23)
    expect(tx.cf_type).toBe('recurring')
  })

  it('a pass-through after the switch was on is written positive', async () => {
    await openNewDirect('1199.22')
    turnSwitch(true)
    fireEvent.click(screen.getByText('Prolazna stavka'))
    await save()

    expect(wrote('transactions')).toHaveLength(0)
    const pt = theInsert('passthrough')
    expect(pt.amount).toBe(1199.22)
    expect(pt.amount_rsd).toBe(1199.22)
    expect(pt.amount_eur).toBe(10.23)
  })

  it('a stored refund turned into an invoice payment is written as an ordinary payment, with no minus', async () => {
    linkABill()
    db().rows.transactions = [storedRow(REFUND_FIGURES)]
    await openStored(storedRow(REFUND_FIGURES))
    expect(refundSwitch()!.checked).toBe(true)
    fireEvent.click(screen.getByText('Plaćanje fakture'))
    expect(refundSwitch()).toBeNull()
    await save()

    const p = theUpdate()
    expect(p.type).toBe('invoice_payment')
    expect(p.amount).toBe(1199.22)
    expect(p.amount_rsd).toBe(1199.22)
    expect(p.amount_eur).toBe(10.23)
    expect(p.cf_type).toBeNull()
    expect(p.cf_accrual_from).toBeNull()
  })

  it('switching to an invoice payment writes an ordinary payment with a positive amount', async () => {
    db().rows.v_invoice_status = [{
      id: 'inv-9', company_id: 'co', document_type: 'invoice', type: 'revenue', partner_id: 'p1',
      partner_name: 'Kupac Primer doo', invoice_number: 'IF-9/2026', invoice_date: '2026-11-01',
      due_date: '2026-11-20', calculated_status: 'unpaid', currency: 'RSD',
      amount: 1199.22, amount_rsd: 1199.22, exchange_rate: 1, eur_rate: 117.2,
      paid_amount: 0, advance_deducted: 0,
    }]
    render(<TransactionDialog onClose={jest.fn()} />)
    await screen.findByText('Nova transakcija')
    await waitFor(() => expect(underLabel('Banka / račun').querySelectorAll('option').length).toBe(3))
    fireEvent.change(underLabel('Banka / račun'), { target: { value: 'b1' } })
    fireEvent.change(underLabel('Valuta'), { target: { value: 'RSD' } })
    fireEvent.change(screen.getByPlaceholderText('Pretraga partnera…'), { target: { value: 'Kupac' } })
    fireEvent.click(await screen.findByText('Kupac Primer doo'))
    goTo('Iznos i valuta')
    fireEvent.change(screen.getByPlaceholderText('0.00'), { target: { value: '1199.22' } })
    fireEvent.click(screen.getByText('Preuzmi'))
    await screen.findByText('Izvor: test')
    goTo('Tip i klasifikacija')
    fireEvent.click(screen.getByText('Direktna transakcija'))
    turnSwitch(true)
    subtype('📥 Prihod')
    fireEvent.click(await screen.findByText('Prebaci na plaćanje fakture'))
    fireEvent.click(await screen.findByText('+ Dodaj'))
    await save()

    const tx = theInsert()
    expect(tx.type).toBe('invoice_payment')
    expect(tx.tx_subtype).toBe('revenue')
    expect(tx.amount).toBe(1199.22)
    expect(tx.amount_rsd).toBe(1199.22)
    expect(tx.amount_eur).toBe(10.23)
    expect(tx.cf_type).toBeNull()
    expect(tx.cf_frequency).toBeNull()
  })
})

// ── A stored row linked to a bill ───────────────────────────────────────────

describe('a stored row linked to a bill', () => {
  it('a positive direct cost is not offered the switch and its write stays positive', async () => {
    linkABill()
    await openStored(storedRow())
    expect(refundSwitch()).toBeNull()
    expect(screen.queryByText(REFUND_SWITCH)).toBeNull()
    await save()
    expect(theUpdate()).toMatchObject({ amount: 1199.22, amount_rsd: 1199.22, amount_eur: 10.23 })
  })

  it('a refund keeps its sign: shown on, and saved unchanged it carries every minus', async () => {
    linkABill()
    // The same linked row stored positive, edited and saved as it is.
    const ordinary = await ordinaryEditOf(storedRow(), positiveLines())

    db().rows.transactions = [storedRow(REFUND_FIGURES)]
    db().rows.pl_splits = negativeLines()
    await openStored(storedRow(REFUND_FIGURES))
    await waitFor(() => expect(mockSplitEditor.props.lines).toHaveLength(2))
    // The links are read by now: they are what would hide the switch.
    expect(refundSwitch()!.checked).toBe(true)
    await save()

    expect(theUpdate()).toEqual({ ...ordinary.payload, ...REFUND_FIGURES, ...REFUND_CASH_FLOW })
    const rows = splitPayloadsWritten()
    expect(rows).toEqual(negated(ordinary.splits))
    expect(rows.map((r: any) => r.amount)).toEqual([-1000, -199.22])
    expect(rows.map((r: any) => r.amount_rsd)).toEqual([-1000, -199.22])
    expect(rows.map((r: any) => r.amount_eur)).toEqual([-8.53, -1.7])
  })
})

// ── A template saved from the form ──────────────────────────────────────────

describe('a template saved from the form', () => {
  const templateFrom = async (refund: boolean) => {
    await openNewDirect('1199.22')
    await classify()
    if (refund) turnSwitch(true)
    fireEvent.click(screen.getByText('+ Sačuvaj ovu klasifikaciju kao šablon'))
    fireEvent.change(screen.getByPlaceholderText('Naziv šablona…'), { target: { value: 'Vraćen toner' } })
    fireEvent.click(screen.getByText('Sačuvaj'))
    await waitFor(() => expect(wrote('quick_fill_scripts')).toHaveLength(1))
    const row = wrote('quick_fill_scripts')[0].payload
    cleanup()
    db().writes.length = 0
    db().rows.quick_fill_scripts = db().rows.quick_fill_scripts.filter((r: any) => r.name !== 'Vraćen toner')
    return row
  }

  it('a refund saves the same template as an ordinary cost: no amount, no sign and no refund mark', async () => {
    const plain = await templateFrom(false)
    const refund = await templateFrom(true)
    expect(refund).toEqual(plain)
    expect(Object.keys(refund)).not.toContain('amount')
    expect(JSON.stringify(refund)).not.toMatch(/-\d|povra/i)
  })
})
