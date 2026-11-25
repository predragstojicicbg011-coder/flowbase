import React from 'react'
import { render, screen, fireEvent, waitFor, cleanup, act } from '@testing-library/react'
import TransactionDialog from './TransactionDialog'

// ── A payment is never allocated beyond itself (20261125100000) ─────────────
//
// The dialog writes every link of its payment, one request each, and the
// database judges each write by itself. So the whole set is asked before the
// first write -- counted as the database counts: in dinars as the payment sees
// each link, a payroll child (it mirrors its parent's share) not counted -- and
// only a RAISE over what the payment opened with is refused. A payment already
// over can be re-saved unchanged or lowered.
//
// Driven through the real dialog over a mocked database (the harness of
// TransactionDialog.refund.render.test.tsx). Invented names only.

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
jest.mock('./SplitEditor', () => () => null)
jest.mock('./ProjectSelect', () => () => null)
jest.mock('./CreditInstallmentSelector', () => () => null)

const db = () => (jest.requireMock('../supabase') as any).__db

const ROW_ID = 'tx-pay'

const storedPayment = (amount: number) => ({
  id: ROW_ID, company_id: 'co', bank_id: 'b1', partner_id: null,
  transaction_date: '2026-11-12', statement_number: '44',
  type: 'invoice_payment', tx_subtype: 'expense', is_advance: false,
  currency: 'RSD', amount, exchange_rate: 1, eur_rate: 117.2,
  amount_rsd: amount, amount_eur: Math.round((amount / 117.2) * 100) / 100,
  is_indexed: false, pl_impact: false,
  pl_category: null, pl_subcategory: null, department: null,
  dept_subcategory: null, expense_description: null, revenue_stream: null,
  project_id: null, dept_split_type: 'none',
  cf_type: null, cf_frequency: null, cf_next_month_est: null,
  cf_accrual_from: null, cf_accrual_to: null, cf_capex_months: null, cf_reimbursable_date: null,
  account_number: null, model: null, reference_number: null,
  note: 'Placanje', tags: null, status: 'posted',
})

const bill = (id: string, number: string, amount: number, parent: string | null = null) => ({
  id, invoice_number: number, invoice_date: '2026-11-01', due_date: '2026-11-15', currency: 'RSD', amount, amount_rsd: amount,
  exchange_rate: 1, eur_rate: 117.2, project_id: null, type: 'expense', advance_deducted: 0, parent_invoice_id: parent,
  partners: { name: 'Izmisljeni Dobavljac doo' },
})
const linkOf = (inv: any, allocated: number) => ({
  invoice_id: inv.id, transaction_id: ROW_ID, allocated_amount: allocated, allocated_amount_rsd: allocated, allocated_amount_eur: allocated / 117.2, invoices: inv,
})

const seed = (payment: number, links: any[], statuses: any[]) => {
  const d = db()
  d.seq = 0
  d.writes.length = 0
  d.rows = {
    banks: [{ id: 'b1', name: 'Izmisljena Banka RSD', company_id: 'co', currency: 'RSD' }],
    pl_categories: [], pl_subcategories: [], departments: [], partner_accounts: [], quick_fill_scripts: [],
    pl_splits: [], v_invoice_status: statuses, invoice_transaction_links: links, invoices: [],
    transactions: [storedPayment(payment)], passthrough: [], credits: [], credit_installments: [],
  }
}

afterEach(cleanup)

const goTo = (title: string) => fireEvent.click(screen.getAllByText(title)[0])
const settle = async () => {
  for (let i = 0; i < 4; i++) {
    // eslint-disable-next-line no-await-in-loop
    await act(async () => { await new Promise(r => setTimeout(r, 0)) })
  }
}
const SAVE = /^(Proknjiži transakciju|Sačuvaj izmene)$/
const DONE = /^Transakcija je (proknjižena|izmenjena)\.$/

const openStored = async () => {
  render(<TransactionDialog onClose={jest.fn()} transaction={db().rows.transactions[0]} />)
  await screen.findByText('Izmena transakcije')
  await settle()
  goTo('Tip i klasifikacija')
  await settle()
}
const allocationFields = () => Array.from(document.querySelectorAll('input[type="number"]'))
  .filter(el => (el as HTMLInputElement).style.width === '130px') as HTMLInputElement[]
const writesTo = (table: string) => db().writes.filter((w: any) => w.table === table)

describe('a payroll payment stored with its parent and child links', () => {
  it('re-saves (a changed note): the child mirrors its parent and is not counted twice', async () => {
    const parent = bill('par', 'PL-11', 1000)
    const child = bill('chi', 'PL-11-1', 1000, 'par')
    seed(1000, [linkOf(parent, 1000), linkOf(child, 1000)], [{ id: 'par', amount: 1000, paid_amount: 1000 }, { id: 'chi', amount: 1000, paid_amount: 1000 }])
    await openStored()
    expect(allocationFields()).toHaveLength(2)
    goTo('Pregled')
    fireEvent.click(await screen.findByText(SAVE))
    await waitFor(() => expect(screen.queryByText(DONE)).toBeTruthy())
  })
})

describe('a payment already allocated beyond itself (written before the guard)', () => {
  const b1 = bill('b1', 'B-700', 700)
  const b2 = bill('b2', 'B-900', 900)
  beforeEach(() => seed(700, [linkOf(b1, 700), linkOf(b2, 700)], [{ id: 'b1', amount: 700, paid_amount: 700 }, { id: 'b2', amount: 900, paid_amount: 700 }]))

  it('re-saves unchanged', async () => {
    await openStored()
    goTo('Pregled')
    fireEvent.click(await screen.findByText(SAVE))
    await waitFor(() => expect(screen.queryByText(DONE)).toBeTruthy())
  })

  it('re-saves lowered', async () => {
    await openStored()
    fireEvent.change(allocationFields()[1], { target: { value: '100' } })
    goTo('Pregled')
    fireEvent.click(await screen.findByText(SAVE))
    await waitFor(() => expect(screen.queryByText(DONE)).toBeTruthy())
  })

  it('raised, is refused with the figures, and nothing is written', async () => {
    await openStored()
    fireEvent.change(allocationFields()[1], { target: { value: '701' } })
    goTo('Pregled')
    fireEvent.click(await screen.findByText(SAVE))
    expect(await screen.findByText('Fakture na ovom plaćanju su raspoređene 1.401,00 RSD, više od samog plaćanja (700,00 RSD). Ništa nije sačuvano. Smanjite raspodelu: plaćanje se ne raspoređuje preko onoga što je plaćeno.')).toBeInTheDocument()
    await settle()
    expect(screen.queryByText(DONE)).toBeNull()
    expect(writesTo('transactions')).toHaveLength(0)
    expect(writesTo('invoice_transaction_links')).toHaveLength(0)
  })
})
