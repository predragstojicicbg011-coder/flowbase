import React from 'react'
import { act, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import Budgeting from './Budgeting'
import { CREDIT_DEPARTMENT } from '../services/creditClassification'

// A thousand commitment rows is a real render, several times over. The default
// five seconds is not about the code under test.
jest.setTimeout(30000)

// ─── A Supabase that behaves like PostgREST ──────────────────────────────────
//
// Faithful in the one respect these tests are about: a response is capped at
// 1000 rows and NOTHING says so. A query that reads one page and sums it looks
// perfectly healthy and is simply short. `.range()` moves the window; without
// it the first thousand rows are all there ever is.
//
// `eq`, `in`, `gte` and `lte` are applied, because a filter that is never sent
// is the other half of the same fault: with a company filter missing, another
// company's rows fill the one page and the selected company's vanish behind
// them.
//
// Every response resolves on a macrotask, so the companies list arrives AFTER
// the first render settles — which is the shape the load effect has to cope
// with, and the shape it did not.

const PAGE_CAP = 1000

interface MockDb {
  rows: Record<string, any[]>
  errors: Record<string, string>
  /**
   * Every request that reached the fake server, for asserting on paging — and
   * on scope: `filters` is what the query narrowed itself to before the cap
   * was applied, which is the difference between a query that asks for one
   * company's rows and one that reads everybody's and throws most away.
   */
  requests: { table: string; from: number; to: number; filters: any[] }[]
  /**
   * Every row that was INSERTED, in order, with the table it landed in.
   *
   * The page reads far more than it writes, so the mock was read-only. Adding
   * a budget line writes to two different kinds of table — the lookup table a
   * new name belongs in and the append-only ledger — and the whole point of
   * the feature is that it writes to BOTH. A mock that cannot tell them apart
   * cannot test the one thing worth testing.
   */
  writes: { table: string; row: any }[]
}

const mockDb: MockDb = { rows: {}, errors: {}, requests: [], writes: [] }
;(global as any).__budgetingMockDb = mockDb

jest.mock('../supabase', () => {
  const db = () => (global as any).__budgetingMockDb as MockDb

  const matches = (row: any, f: any): boolean => {
    const v = row[f.col]
    switch (f.op) {
      case 'eq': return v === f.val
      case 'neq': return v !== f.val
      case 'in': return (f.val as any[]).includes(v)
      case 'is': return f.val === null ? v === null || v === undefined : v === f.val
      case 'gte': return v != null && String(v) >= String(f.val)
      case 'lte': return v != null && String(v) <= String(f.val)
      default: return true
    }
  }

  const makeBuilder = (table: string): any => {
    const filters: any[] = []
    const order: string[] = []
    let from = 0
    let to = Number.MAX_SAFE_INTEGER
    /** The rows an `.insert()` handed over, or null for a plain read. */
    let pending: any[] | null = null
    let wantsOne = false

    const run = () => new Promise<any>(resolve => setTimeout(() => {
      const state = db()

      if (pending) {
        if (state.errors[table]) {
          resolve({ data: null, error: { message: state.errors[table] }, count: null })
          return
        }
        // An id is assigned by the server, as PostgREST does, and the row is
        // readable by every later query — which is what makes "the new name
        // reaches the lookup table" and "the page shows the new row after a
        // reload" the same mock rather than two.
        const existing = state.rows[table] || []
        const saved = pending.map((row, i) => ({ id: `${table}-${existing.length + i + 1}`, ...row }))
        state.rows[table] = [...existing, ...saved]
        for (const row of saved) state.writes.push({ table, row })
        resolve({ data: wantsOne ? saved[0] : saved, error: null, count: saved.length })
        return
      }

      state.requests.push({ table, from, to, filters: filters.map(f => ({ ...f })) })

      if (state.errors[table]) {
        resolve({ data: null, error: { message: state.errors[table] }, count: null })
        return
      }

      let rows = (state.rows[table] || []).filter(r => filters.every(f => matches(r, f)))
      for (const col of [...order].reverse()) {
        rows = [...rows].sort((a, b) => String(a[col]).localeCompare(String(b[col])))
      }
      // The cap. It is not an error and it is not reported; the response is
      // simply shorter than the table.
      const end = Math.min(to, from + PAGE_CAP - 1)
      resolve({ data: rows.slice(from, end + 1), error: null, count: rows.length })
    }, 0))

    const builder: any = new Proxy({}, {
      get(_t, prop: string) {
        if (prop === 'then') return (res: any, rej: any) => run().then(res, rej)
        if (prop === 'catch') return (rej: any) => run().catch(rej)
        if (prop === 'finally') return (cb: any) => run().finally(cb)
        if (prop === 'insert') return (payload: any) => {
          pending = Array.isArray(payload) ? payload : [payload]
          return builder
        }
        if (prop === 'single') return () => { wantsOne = true; return builder }
        if (prop === 'range') return (a: number, b: number) => { from = a; to = b; return builder }
        if (prop === 'order') return (col: string) => { order.push(col); return builder }
        if (prop === 'eq') return (col: string, val: any) => { filters.push({ op: 'eq', col, val }); return builder }
        if (prop === 'neq') return (col: string, val: any) => { filters.push({ op: 'neq', col, val }); return builder }
        if (prop === 'in') return (col: string, val: any) => { filters.push({ op: 'in', col, val }); return builder }
        if (prop === 'is') return (col: string, val: any) => { filters.push({ op: 'is', col, val }); return builder }
        if (prop === 'gte') return (col: string, val: any) => { filters.push({ op: 'gte', col, val }); return builder }
        if (prop === 'lte') return (col: string, val: any) => { filters.push({ op: 'lte', col, val }); return builder }
        return () => builder
      },
    })
    return builder
  }

  return { supabase: { from: (table: string) => makeBuilder(table) } }
})

// The credit schedule prices EUR instalments in dinars at today's NBS rate.
// The real thing calls the NBS over the network; here it is 117 RSD per EUR.
jest.mock('../services/currencyService', () => ({
  ...jest.requireActual('../services/currencyService'),
  getRatesForDate: () => Promise.resolve({
    usdRsdRate: 100, eurRsdRate: 117, date: '2026-09-01', source: 'test', isFallback: false,
  }),
}))

// ─── Fixtures ────────────────────────────────────────────────────────────────

const COMPANY_A = 'company-a'
const COMPANY_B = 'company-b'

/** The month the page benchmarks against: the last closed one. */
const benchmarkMonth = (): string => {
  const now = new Date()
  const d = new Date(now.getFullYear(), now.getMonth() - 1, 1)
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}`
}

/** A month inside the twelve-month horizon. */
const horizonMonth = (n: number): string => {
  const now = new Date()
  const d = new Date(now.getFullYear(), now.getMonth() + n, 1)
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}`
}

const expenseRow = (over: Record<string, any> = {}) => ({
  id: 'tx-1',
  company_id: COMPANY_A,
  amount_rsd: 1000,
  pl_category: 'Operating Expenses',
  pl_subcategory: 'Telecom',
  department: 'Administration',
  dept_subcategory: 'Office',
  expense_description: 'Telekom',
  pl_date: `${benchmarkMonth()}-14`,
  tx_type: 'expense',
  source: 'transaction',
  cf_type: 'recurring',
  cf_frequency: 'monthly',
  ...over,
})

const openInvoice = (i: number, over: Record<string, any> = {}) => ({
  id: `inv-${String(i).padStart(5, '0')}`,
  partner_name: `Supplier ${i}`,
  // Raised before the benchmark month, so no seed carries it and it is a
  // commitment in its own right.
  invoice_date: `${horizonMonth(-3)}-05`,
  due_date: `${horizonMonth(1)}-10`,
  remaining_rsd: 10,
  calculated_status: 'unpaid',
  type: 'expense',
  company_id: COMPANY_A,
  ...over,
})

const seedDb = (over: Partial<MockDb['rows']> = {}) => {
  mockDb.rows = {
    companies: [
      { id: COMPANY_A, name: 'Alpha d.o.o.' },
      { id: COMPANY_B, name: 'Beta d.o.o.' },
    ],
    v_pl_entries: [expenseRow()],
    budget_adjustments: [],
    credit_installments: [],
    v_invoice_status: [],
    // The classification lookups. These are the tables a name has to reach for
    // a future transaction to be classifiable to it — a budget line that exists
    // only in the ledger can never be spent against.
    pl_categories: [
      { id: 'plc-1', name: 'Operating Expenses', type: 'expense', sort_order: 1 },
      { id: 'plc-2', name: 'Revenue', type: 'revenue', sort_order: 2 },
    ],
    pl_subcategories: [
      { id: 'pls-1', name: 'Telecom', category_id: 'plc-1', sort_order: 1 },
    ],
    departments: [
      { id: 'dep-1', name: 'Administration', sort_order: 1 },
      { id: 'dep-2', name: 'Marketing', sort_order: 2 },
    ],
    dept_subcategories: [
      { id: 'dsc-1', name: 'Office', department_id: 'dep-1', sort_order: 1 },
      { id: 'dsc-2', name: 'Events', department_id: 'dep-2', sort_order: 2 },
    ],
    expense_descriptions: [
      { id: 'exd-1', name: 'Telekom', dept_subcategory_id: 'dsc-1', sort_order: 1 },
    ],
    ...over,
  }
  mockDb.errors = {}
  mockDb.requests = []
  mockDb.writes = []
}

beforeEach(() => { seedDb() })

/** A row's twelve-month figure, which is the last cell in it. */
const yearTotalOf = (label: string): string => {
  const tr = screen.getByText(label).closest('tr')
  if (!tr) throw new Error(`there is no ${label} row on screen`)
  const cells = tr.querySelectorAll('td')
  return (cells[cells.length - 1].textContent || '').trim()
}

/**
 * The month columns on screen, in order.
 *
 * The first header row is: the label column, the benchmark column, one
 * `colSpan={3}` cell a month, and the Year column.
 */
const monthHeaders = (): string[] => {
  const head = document.querySelector('thead tr')
  if (!head) throw new Error('the table has no header')
  const ths = Array.from(head.querySelectorAll('th'))
  return ths.slice(2, ths.length - 1).map(th => (th.textContent || '').trim())
}

/** The label the table gives the month we are in. */
const thisMonthLabel = (): string => {
  const SHORT = ['Jan', 'Feb', 'Mar', 'Apr', 'Maj', 'Jun', 'Jul', 'Avg', 'Sep', 'Okt', 'Nov', 'Dec']
  const now = new Date()
  return `${SHORT[now.getMonth()]} ${now.getFullYear()}`
}

/**
 * Render and pick one company from the selector.
 *
 * These tests are about what the queries ask the database for, and several of
 * them are only wrong with a single company selected — an unscoped query is
 * merely wasteful when every company is in scope anyway.
 */
const renderForCompany = async (id: string) => {
  render(<Budgeting />)
  const select = await screen.findByRole('combobox', { name: 'Firme' })
  await waitFor(() => expect(within(select).getByText('Alpha d.o.o.')).toBeInTheDocument())
  fireEvent.change(select, { target: { value: id } })
}

/**
 * Render on the consolidated view and wait for the table.
 *
 * Which is where the budget is. A budget line belongs to the GROUP — the owner
 * budgets consolidated and only consolidated — so everything the budget draws
 * (the estimate and variance columns, the Year total, the Committed row, the
 * add-a-line button) is on this view and only on this view.
 */
const renderConsolidated = async () => {
  render(<Budgeting />)
  await waitFor(() => expect(screen.getByText(/Ukupni troškovi/i)).toBeInTheDocument())
}

/**
 * Opens every folded row, the way a person does.
 *
 * The table now loads with every parent collapsed — several hundred rows of
 * leaf detail answer a question the eleven category rows above them already
 * answer, and Predrag asked for the compact one. Tests about what a LEAF row
 * says therefore have to open the tree first, exactly as a reader would.
 *
 * Repeated, not one pass: opening a category reveals sub-categories that are
 * themselves folded, and one sweep would leave the second level shut.
 */
const expandAll = async () => {
  for (let sweep = 0; sweep < 6; sweep++) {
    const folded = screen.queryAllByText('▶')
    if (folded.length === 0) return
    for (const caret of folded) {
      const cell = caret.closest('td')
      if (cell) await act(async () => { fireEvent.click(cell) })
    }
  }
}

/** The budget figure in the row labelled `label`, for the month `n` ahead. */
const budgetFigure = (label: string, n: number): HTMLElement => {
  const tr = screen.getByText(label).closest('tr')
  if (!tr) throw new Error(`there is no ${label} row on screen`)
  // label, benchmark, then actual / budget / variance for every month.
  const cell = tr.querySelectorAll('td')[3 + 3 * n] as HTMLElement
  return cell.querySelector('span') as HTMLElement
}

// ─── Tests ───────────────────────────────────────────────────────────────────

describe('the Budgeting page and the thousand-row cap', () => {
  it('reads every credit instalment, not the first thousand of them', async () => {
    // The instalments no longer reach the Committed row — they are the
    // estimate on the Loans/Credits rows — so the paging is asserted where
    // they land now. The cap is the same cap either way.
    seedDb({
      credit_installments: Array.from({ length: 1050 }, (_, i) => ({
        id: `inst-${String(i).padStart(5, '0')}`,
        installment_no: i,
        due_date: `${horizonMonth(2)}-05`,
        principal_amount: 10, interest_amount: 0,
        status: 'outstanding',
        credits: { name: 'Intesa 100k', company_id: COMPANY_A, currency: 'EUR' },
      })),
    })
    render(<Budgeting />)

    // 1,050 × 10 EUR at 117 RSD/EUR = 1,228,500 RSD, on the row the
    // principal leg is classified to.
    await waitFor(() => expect(screen.getByText(CREDIT_DEPARTMENT)).toBeInTheDocument())
    await waitFor(() =>
      expect(budgetFigure(CREDIT_DEPARTMENT, 2).textContent).toBe('1.228.500 RSD'))
  })

})

describe('the credit schedule on its own rows', () => {
  // The Committed row is gone. Budgeting is read from the P&L: an invoice
  // dated 31 August is an August cost, whether or not it has been paid and
  // whenever it falls due, and September's figure is August's carried forward
  // by the recurring/one-time rule and nothing else. A due date answers a
  // question this table is not asking; Cash Flow is where it belongs.
  //
  // What survives is the credit schedule, which is not a due-date reading of
  // an invoice but the only expense whose future is stated exactly.

  const oneInstalment = () => seedDb({
    credit_installments: [{
      id: 'inst-1', installment_no: 18,
      due_date: `${horizonMonth(1)}-05`,
      principal_amount: 1000, interest_amount: 0,
      status: 'outstanding',
      credits: { name: 'Intesa 100k', company_id: COMPANY_A, currency: 'EUR' },
    }],
    v_invoice_status: [openInvoice(1, { partner_name: 'Telekom Srbija', remaining_rsd: 420 })],
  })

  it('PUTS THE INSTALMENT ON ITS OWN ROW', async () => {
    oneInstalment()
    render(<Budgeting />)
    // 1,000 EUR at 117 RSD/EUR.
    await waitFor(() => expect(screen.getByText(CREDIT_DEPARTMENT)).toBeInTheDocument())
    await waitFor(() =>
      expect(budgetFigure(CREDIT_DEPARTMENT, 1).textContent).toBe('117.000 RSD'))
  })

  it('DRAWS NO COMMITTED ROW AT ALL any more', async () => {
    oneInstalment()
    render(<Budgeting />)
    await waitFor(() => expect(screen.getByText(/Ukupni troškovi/i)).toBeInTheDocument())
    expect(screen.queryByText(/Committed/i)).not.toBeInTheDocument()
  })

  it('does not read the invoices table for the budget at all', async () => {
    // Paid or unpaid, due when it likes — none of it is a budgeting question.
    oneInstalment()
    render(<Budgeting />)
    await waitFor(() => expect(screen.getByText(/Ukupni troškovi/i)).toBeInTheDocument())
    expect(mockDb.requests.filter(r => r.table === 'v_invoice_status')).toHaveLength(0)
  })

  it('keeps the instalment out of the tree as a row of its own', async () => {
    // It is an amount on a classified row, not a line item with a name.
    oneInstalment()
    render(<Budgeting />)
    await waitFor(() => expect(screen.getByText(CREDIT_DEPARTMENT)).toBeInTheDocument())
    expect(screen.queryByText(/Intesa 100k #18/)).not.toBeInTheDocument()
  })
})

describe('the Budgeting page when a query fails', () => {
  it('stops loading when a fetch throws, instead of showing its loader for ever', async () => {
    // `run()` had no try/catch, so a throw out of `fetchAllPages` skipped
    // `setLoading(false)` and the page sat on its loader with nothing said.
    mockDb.errors['v_pl_entries'] = 'statement timeout'
    await renderForCompany(COMPANY_A)

    await waitFor(() => expect(screen.getByText(/statement timeout/i)).toBeInTheDocument())
    expect(screen.queryByText(/Loading budget data/i)).not.toBeInTheDocument()
  })

  it('does not leave a stale total on screen beside the failure', async () => {
    // A figure from the last good load, sitting under an error message, is
    // read as the current one.
    await renderForCompany(COMPANY_A)
    await waitFor(() => expect(screen.getByText(/Ukupni troškovi/i)).toBeInTheDocument())

    mockDb.errors['v_pl_entries'] = 'statement timeout'
    fireEvent.click(screen.getByText(/Osveži/i))

    await waitFor(() => expect(screen.getByText(/statement timeout/i)).toBeInTheDocument())
    expect(screen.queryByText(/Ukupni troškovi/i)).not.toBeInTheDocument()
  })
})

describe('the Budgeting page in its default consolidated view', () => {
  it('loads without first being told which company to look at', async () => {
    // The load effect early-returns while `companyIds` is empty, and
    // `companyIds` derives from `companies`, which is fetched. On mount the
    // effect's last run happens before that fetch resolves — and `companies`
    // was not in its dependency array, so nothing re-triggered it. The table
    // sat on "No expense data yet" until the user picked a company or hit
    // Refresh.
    render(<Budgeting />)

    await waitFor(() => expect(screen.getByText(/Ukupni troškovi/i)).toBeInTheDocument())
    expect(screen.queryByText(/Još nema podataka o troškovima/i)).not.toBeInTheDocument()
  })

  it('loads once and then stops, rather than re-triggering itself', async () => {
    // The other way this is got wrong: `companyIds` is rebuilt on every
    // render, so depending on it directly is a loop — the effect sets state,
    // the state re-renders, the array is a new object, the effect runs again.
    const reads = () => mockDb.requests.filter(r => r.table === 'v_pl_entries').length

    render(<Budgeting />)
    await waitFor(() => expect(screen.getByText(/Ukupni troškovi/i)).toBeInTheDocument())

    const settled = reads()
    await act(async () => { await new Promise(r => setTimeout(r, 200)) })
    expect(reads()).toBe(settled)
  })
})

describe('the horizon', () => {
  // Thirty-seven columns sharing 2,600px gave each figure 59px, and a figure
  // that does not fit is not abbreviated, it is cut off: `$26.…`. The horizon
  // is what buys the width back, and three months is what the page is actually
  // read for — this month and the next one or two.

  it('shows three months by default, starting with the one we are in', async () => {
    render(<Budgeting />)
    await waitFor(() => expect(screen.getByText(/Ukupni troškovi/i)).toBeInTheDocument())

    expect(monthHeaders()).toHaveLength(3)
    expect(monthHeaders()[0]).toContain(thisMonthLabel())
  })

  it('puts the month we are in in the foreground', async () => {
    // "Which column is now" must not be something a reader works out by
    // counting. It is the first column, and it says so.
    render(<Budgeting />)
    await waitFor(() => expect(screen.getByText(/Ukupni troškovi/i)).toBeInTheDocument())

    const marker = screen.getByText('OVAJ MESEC')
    expect(marker).toBeInTheDocument()
    expect(monthHeaders()[0]).toContain('OVAJ MESEC')
    // One column, not several.
    expect(screen.getAllByText('OVAJ MESEC')).toHaveLength(1)
  })

  it('shows twelve months when asked for twelve', async () => {
    render(<Budgeting />)
    await waitFor(() => expect(screen.getByText(/Ukupni troškovi/i)).toBeInTheDocument())

    fireEvent.click(screen.getByRole('button', { name: '12m' }))
    await waitFor(() => expect(monthHeaders()).toHaveLength(12))
    // And back down again, without the table having to be reloaded.
    fireEvent.click(screen.getByRole('button', { name: '6m' }))
    await waitFor(() => expect(monthHeaders()).toHaveLength(6))
  })

  it('prints figures in full at three months and compact beyond', async () => {
    // The whole point of the narrower horizon. `$6.7K` is the same string for
    // every figure between 6,650 and 6,749; two months an accountant is trying
    // to compare must not read identically when there is room for the digits.
    seedDb({ v_pl_entries: [expenseRow({ amount_rsd: 26432 })] })
    render(<Budgeting />)
    await waitFor(() => expect(screen.getByText(/Ukupni troškovi/i)).toBeInTheDocument())

    expect(screen.getAllByText('26.432 RSD').length).toBeGreaterThan(0)
    expect(screen.queryByText('26,4 hilj. RSD')).not.toBeInTheDocument()

    fireEvent.click(screen.getByRole('button', { name: '12m' }))
    await waitFor(() => expect(screen.getAllByText('26,4 hilj. RSD').length).toBeGreaterThan(0))
    expect(screen.queryByText('26.432 RSD')).not.toBeInTheDocument()
  })

  it('totals twelve months in the Year column while showing three', async () => {
    // A "Year" column that quietly meant "the three months on screen" would be
    // worse than no Year column. One commitment falls inside the window and
    // one falls seven months out; the Year figure is both.
    // One instalment inside the three months on screen and one outside them.
    // 1 EUR and 2 EUR at 117 RSD/EUR: 117 + 234 = 351 RSD, small enough to
    // print the same at every horizon.
    seedDb({
      credit_installments: [
        { id: 'i1', installment_no: 1, due_date: `${horizonMonth(1)}-10`,
          principal_amount: 1, interest_amount: 0, status: 'outstanding',
          credits: { name: 'Intesa 100k', company_id: COMPANY_A, currency: 'EUR' } },
        { id: 'i2', installment_no: 7, due_date: `${horizonMonth(7)}-10`,
          principal_amount: 2, interest_amount: 0, status: 'outstanding',
          credits: { name: 'Intesa 100k', company_id: COMPANY_A, currency: 'EUR' } },
      ],
    })
    render(<Budgeting />)
    await waitFor(() => expect(screen.getByText(CREDIT_DEPARTMENT)).toBeInTheDocument())

    expect(monthHeaders()).toHaveLength(3)
    // Three months on screen, and month seven is not one of them.
    await waitFor(() => expect(yearTotalOf(CREDIT_DEPARTMENT)).toBe('351 RSD'))

    // The header says which twelve months it is, so nobody has to guess.
    expect(screen.getByText('svih 12 meseci')).toBeInTheDocument()

    // And widening the horizon does not change the Year figure — it was
    // always all twelve months.
    fireEvent.click(screen.getByRole('button', { name: '12m' }))
    await waitFor(() => expect(monthHeaders()).toHaveLength(12))
    expect(yearTotalOf(CREDIT_DEPARTMENT)).toBe('351 RSD')
  })

  it('does not re-query the database when the horizon changes', async () => {
    // Twelve months are loaded at every horizon, because the Year column
    // totals twelve at every horizon. The horizon is a view over data already
    // in hand — if it ever starts changing what is fetched, it has to join the
    // load effect's dependencies, and the Year column stops being honest.
    const reads = () => mockDb.requests.filter(r => r.table === 'v_pl_entries').length

    render(<Budgeting />)
    await waitFor(() => expect(screen.getByText(/Ukupni troškovi/i)).toBeInTheDocument())
    const settled = reads()

    fireEvent.click(screen.getByRole('button', { name: '12m' }))
    await waitFor(() => expect(monthHeaders()).toHaveLength(12))
    await act(async () => { await new Promise(r => setTimeout(r, 200)) })
    expect(reads()).toBe(settled)
  })

  it('benchmarks against the last closed month at every horizon', async () => {
    // The benchmark sits BEFORE the horizon and is not part of it. It is one
    // column at three months and the same column at twelve.
    render(<Budgeting />)
    await waitFor(() => expect(screen.getByText(/Ukupni troškovi/i)).toBeInTheDocument())

    const benchLabel = () => {
      const head = document.querySelector('thead tr')
      return ((head as HTMLElement).querySelectorAll('th')[1].textContent || '').trim()
    }
    const before = benchLabel()
    expect(before).toContain('ostvareno')
    expect(screen.getAllByText('REFERENCA')).toHaveLength(1)

    fireEvent.click(screen.getByRole('button', { name: '12m' }))
    await waitFor(() => expect(monthHeaders()).toHaveLength(12))
    expect(benchLabel()).toBe(before)
    expect(screen.getAllByText('REFERENCA')).toHaveLength(1)
  })
})

describe('adding a budget line nothing has been spent on', () => {
  // The tree is built from classifications that already carry spend or a
  // ledger entry, so there was no way at all to budget for something nobody
  // has paid for — which is exactly what planning ahead is.

  /** Open the add-a-line dialog and wait for the classifications to arrive. */
  const openAddLine = async () => {
    fireEvent.click(screen.getByText('+ Dodaj budžetsku stavku'))
    await screen.findByText('Dodaj budžetsku stavku')
  }

  const ledgerWrites = () => mockDb.writes.filter(w => w.table === 'budget_adjustments')

  it('records the line at the deepest level the user filled in', async () => {
    // Marketing → Events, with the description left blank. The entry has to be
    // a `dept_subcategory` row: filed one level deeper it would land on an
    // `Unassigned` description, and one level shallower it would move the whole
    // department.
    await renderConsolidated()

    await openAddLine()
    fireEvent.change(await screen.findByLabelText('Sektor'), { target: { value: 'dep-2' } })
    fireEvent.change(screen.getByLabelText('Podsektor'), { target: { value: 'dsc-2' } })
    fireEvent.change(screen.getByLabelText('Mesec'), { target: { value: horizonMonth(2) } })
    fireEvent.click(screen.getByText('Dalje'))

    fireEvent.change(await screen.findByLabelText('Novi iznos'), { target: { value: '4000' } })
    fireEvent.change(screen.getByLabelText('Razlog'), { target: { value: 'Autumn campaign' } })
    fireEvent.click(screen.getByText('Sačuvaj izmenu'))

    await waitFor(() => expect(ledgerWrites()).toHaveLength(1))
    expect(ledgerWrites()[0].row).toMatchObject({
      // The group's. Not a company's, and not missing: null is what the
      // ledger reads as "this line is the group's".
      company_id: null,
      budget_month: `${horizonMonth(2)}-01`,
      level: 'dept_subcategory',
      department: 'Marketing',
      dept_subcategory: 'Events',
      // Said to be nothing, rather than guessed at. Nothing has been claimed
      // about the description or about the P&L side of this line.
      expense_description: null,
      pl_category: null,
      pl_subcategory: null,
      kind: 'adjust',
      amount_rsd: 4000,
      reason: 'Autumn campaign',
    })
  })

  it('asks nothing about companies, and is live from the moment it opens', async () => {
    // It used to open with a required Company field above everything else, and
    // everything below it dead until the field was answered. The question was
    // wrong on its own terms: the five tables this dialog picks a line out of
    // carry no `company_id` at all, so a new expense description was never a
    // per-company thing — and a budget line is the group's anyway.
    await renderConsolidated()

    await openAddLine()
    await screen.findByLabelText('Sektor')

    expect(screen.queryByLabelText('Firma')).not.toBeInTheDocument()
    expect(screen.queryByText(/pick one in the selector/i)).not.toBeInTheDocument()
    // Nothing is waiting on an answer that is no longer asked for.
    expect(screen.getByLabelText('Sektor')).not.toBeDisabled()
    expect(screen.getByLabelText('Mesec')).not.toBeDisabled()
    // Continue waits on the line being NAMED, which is the one thing a budget
    // line cannot do without — and on nothing else.
    fireEvent.change(screen.getByLabelText('Sektor'), { target: { value: 'dep-2' } })
    expect(screen.getByText('Dalje')).not.toBeDisabled()
    // And it says who the line is for, which is the group.
    expect(screen.getByText(/Beleži se za/i).textContent).toMatch(/grupu/i)
  })

  it('lets a line that is already budgeted be changed, against the group figure', async () => {
    // This used to be refused: the figure Administration → Office reads on the
    // consolidated view is the sum across every company, so a target typed
    // against it was said to be nobody's delta. It is the GROUP's, which is
    // whose budget this is — so the dialog is handed that figure as the
    // current one, exactly as a click on the cell itself would be.
    await renderConsolidated()

    await openAddLine()
    fireEvent.change(await screen.findByLabelText('Sektor'), { target: { value: 'dep-1' } })
    fireEvent.change(screen.getByLabelText('Podsektor'), { target: { value: 'dsc-1' } })

    expect(screen.queryByText(/already budgeted/i)).not.toBeInTheDocument()
    expect(screen.getByText('Dalje')).not.toBeDisabled()

    fireEvent.click(screen.getByText('Dalje'))
    // The seeded figure the line already carries this month, not a zero.
    expect(await screen.findByText('1.000,00 RSD')).toBeInTheDocument()
  })

  it('writes a new name into the lookup table, not only into the ledger', async () => {
    // The half that is easy to leave out. A description that exists only as a
    // budget line cannot be picked when the real invoice arrives: the spend is
    // classified elsewhere and the budgeted row sits at zero actual for ever.
    //
    // On the consolidated view, with no company chosen anywhere: these tables
    // have no `company_id`, so the `+` beside a level has never needed one.
    await renderConsolidated()

    await openAddLine()
    fireEvent.change(await screen.findByLabelText('Sektor'), { target: { value: 'dep-2' } })
    fireEvent.change(screen.getByLabelText('Podsektor'), { target: { value: 'dsc-2' } })

    // The `+` beside the description — the level with no existing value to pick.
    const adders = screen.getAllByTitle('Dodaj novu kategoriju')
    fireEvent.click(adders[adders.length - 1])
    fireEvent.change(screen.getByPlaceholderText(/Novi opis troška/i),
      { target: { value: 'Conference sponsorship' } })
    fireEvent.click(screen.getByText('✓ Dodaj'))

    await waitFor(() =>
      expect(mockDb.writes.filter(w => w.table === 'expense_descriptions')).toHaveLength(1))
    expect(mockDb.writes.find(w => w.table === 'expense_descriptions')?.row).toMatchObject({
      name: 'Conference sponsorship',
      // Under the sub-category it was created in, or the transaction dialog
      // will never offer it.
      dept_subcategory_id: 'dsc-2',
    })

    fireEvent.click(screen.getByText('Dalje'))
    fireEvent.change(await screen.findByLabelText('Novi iznos'), { target: { value: '4000' } })
    fireEvent.change(screen.getByLabelText('Razlog'), { target: { value: 'Conference sponsorship booked' } })
    fireEvent.click(screen.getByText('Sačuvaj izmenu'))

    await waitFor(() => expect(ledgerWrites()).toHaveLength(1))
    expect(ledgerWrites()[0].row).toMatchObject({
      level: 'expense_description',
      department: 'Marketing',
      dept_subcategory: 'Events',
      expense_description: 'Conference sponsorship',
    })
    // And it is still in the lookup table afterwards — which is what makes the
    // real spend classifiable to the same line months later.
    expect((mockDb.rows.expense_descriptions || []).map((d: any) => d.name))
      .toContain('Conference sponsorship')
  })

  it('puts the new line on the page once it is saved', async () => {
    // Nothing new draws it: `ledgerPaths` already builds a row for a node that
    // exists only because something was budgeted against it. What was missing
    // was a way to write that entry.
    await renderConsolidated()
    expect(screen.queryByText('Marketing')).not.toBeInTheDocument()

    await openAddLine()
    fireEvent.change(await screen.findByLabelText('Sektor'), { target: { value: 'dep-2' } })
    fireEvent.change(screen.getByLabelText('Podsektor'), { target: { value: 'dsc-2' } })
    fireEvent.click(screen.getByText('Dalje'))

    fireEvent.change(await screen.findByLabelText('Novi iznos'), { target: { value: '4000' } })
    fireEvent.change(screen.getByLabelText('Razlog'), { target: { value: 'Autumn campaign' } })
    fireEvent.click(screen.getByText('Sačuvaj izmenu'))

    await waitFor(() => expect(screen.getByText('Marketing')).toBeInTheDocument())
    expect(screen.getByText('Events')).toBeInTheDocument()
    expect(screen.getAllByText('4.000 RSD').length).toBeGreaterThan(0)
  })

  it('does not offer a new description under a P&L sub-category it cannot parent', async () => {
    // `expense_descriptions.dept_subcategory_id` points at a department
    // sub-category whichever branch is open. In the P&L branch there is no
    // parent id to insert under, so the description is offered unfiltered and
    // the `+` is not there — rather than writing a lookup row with no parent.
    await renderConsolidated()
    fireEvent.click(screen.getByRole('button', { name: 'P&L' }))
    await waitFor(() => expect(screen.getByText(/Ukupni troškovi/i)).toBeInTheDocument())

    await openAddLine()
    fireEvent.change(await screen.findByLabelText('P&L kategorija'), { target: { value: 'plc-1' } })
    fireEvent.change(screen.getByLabelText('P&L potkategorija'), { target: { value: 'pls-1' } })

    // Two `+` controls, not three: the category and the sub-category can take
    // a new name here; the description cannot.
    expect(screen.getAllByTitle('Dodaj novu kategoriju')).toHaveLength(2)
    expect(screen.getByText(/Pređite na granu Sektor/i)).toBeInTheDocument()
    // The descriptions that do exist are still pickable.
    expect(within(screen.getByLabelText('Opis troška') as HTMLElement)
      .getByText('Telekom')).toBeInTheDocument()
  })
})

describe('a budget line belongs to the group', () => {
  // The owner budgets consolidated and only consolidated: "I don't budget per
  // company. I budget only consolidated." So the consolidated figure IS the
  // budget, a change to it is a group line, and the cell that used to be inert
  // here — on the grounds that a delta against a multi-company sum was nobody's
  // delta — is the only place a budget is set at all.

  const ledgerWrites = () => mockDb.writes.filter(w => w.table === 'budget_adjustments')

  it('opens the change dialog from a budget cell on the consolidated view', async () => {
    await renderConsolidated()
    await waitFor(() => expect(screen.getByText('Administration')).toBeInTheDocument())

    const figure = budgetFigure('Administration', 0)
    expect(figure.getAttribute('title')).toMatch(/Kliknite da izmenite ovaj iznos/i)
    // The refusal that used to live in the title is gone with the guard.
    expect(figure.getAttribute('title')).not.toMatch(/pick one in the selector/i)

    fireEvent.click(figure)
    expect(await screen.findByLabelText('Novi iznos')).toBeInTheDocument()
  })

  it('records a change made there against the group, with no company on it', async () => {
    await renderConsolidated()
    await waitFor(() => expect(screen.getByText('Administration')).toBeInTheDocument())

    fireEvent.click(budgetFigure('Administration', 0))
    fireEvent.change(await screen.findByLabelText('Novi iznos'), { target: { value: '1500' } })
    fireEvent.change(screen.getByLabelText('Razlog'), { target: { value: 'Group plan for the quarter' } })
    fireEvent.click(screen.getByText('Sačuvaj izmenu'))

    await waitFor(() => expect(ledgerWrites()).toHaveLength(1))
    expect(ledgerWrites()[0].row).toMatchObject({
      company_id: null,
      level: 'department',
      department: 'Administration',
      kind: 'adjust',
      amount_rsd: 500,
      reason: 'Group plan for the quarter',
    })
  })

  it('still counts a ledger row that names a company toward the group total', async () => {
    // The rows carried across from `budget_entries` all name one. They are
    // part of the group's budget now, and the consolidated read must return
    // them ALONGSIDE the null ones — `in('company_id', everyCompany)` never
    // matches a null, and would drop every line set since budgets became the
    // group's, silently lowering every carried-over figure.
    seedDb({
      budget_adjustments: [
        {
          id: 'adj-carried', company_id: COMPANY_A,
          budget_month: `${horizonMonth(1)}-01`, level: 'department',
          pl_category: null, pl_subcategory: null,
          department: 'Administration', dept_subcategory: null, expense_description: null,
          kind: 'adjust', amount_rsd: 500,
          reason: 'Carried over from the previous budget screen',
          created_at: '2026-01-01T00:00:00Z',
        },
        {
          id: 'adj-group', company_id: null,
          budget_month: `${horizonMonth(1)}-01`, level: 'department',
          pl_category: null, pl_subcategory: null,
          department: 'Administration', dept_subcategory: null, expense_description: null,
          kind: 'adjust', amount_rsd: 300,
          reason: 'Group plan for the quarter',
          created_at: '2026-02-01T00:00:00Z',
        },
      ],
    })
    await renderConsolidated()
    await waitFor(() => expect(screen.getByText('Administration')).toBeInTheDocument())

    // 1.000 RSD seeded from the benchmark month, plus both entries.
    await waitFor(() => expect(budgetFigure('Administration', 1).textContent).toContain('1.800 RSD'))
  })
})

describe('how much of the table is open when it loads', () => {
  it('OPENS FOLDED, so the eleven rows that answer the question are the eleven on screen', async () => {
    // Several hundred rows of leaf detail answer a question the categories
    // above them already answer. Compact is the readable one, and it is the
    // one that was asked for.
    await renderConsolidated()
    expect(screen.queryAllByText('▶').length).toBeGreaterThan(0)
    expect(screen.queryAllByText('▼')).toHaveLength(0)
  })

  it('opens a category to its children, and they are folded in turn', async () => {
    // Progressive, not all-or-nothing: opening Marketing should not lay out
    // every description under every sub-category at once.
    await renderConsolidated()
    const first = screen.queryAllByText('▶')[0].closest('td')!
    await act(async () => { fireEvent.click(first) })
    expect(screen.queryAllByText('▼')).toHaveLength(1)
  })

  it('does not refold what the reader opened when a figure is changed', async () => {
    // `refreshTick` bumps after every recorded change. Refolding then throws
    // the reader back to the top of the table in the middle of the run of
    // edits they are least able to afford losing their place in.
    await renderConsolidated()
    await expandAll()
    const openBefore = screen.queryAllByText('▼').length
    expect(openBefore).toBeGreaterThan(0)

    await act(async () => { fireEvent.click(screen.getAllByText(/Ukupni troškovi/i)[0]) })
    await waitFor(() => expect(screen.queryAllByText('▼').length).toBe(openBefore))
  })
})

describe('which row a budget change is about to land on', () => {
  // The trap this covers, in full. `Administration → Office → Telekom` is one
  // department, one sub-category, one description: `Office` has exactly ONE
  // child, so `Office` and `Telekom` print the SAME figure, one directly above
  // the other, both green, both clickable. Clicking the parent by mistake is
  // arithmetically correct and completely silent — the money lands on `Office`
  // itself and surfaces afterwards as the direct row, which reads to the owner
  // as "it went in uncategorised".
  //
  // Nothing here refuses a change on a parent. Budgeting on a parent is a
  // supported act — "Marketing: $8,000 without itemising sixty lines". What
  // these pin down is that the dialog SAYS which of the two it is about to
  // change, before the figure is typed.

  const ledgerWrites = () => mockDb.writes.filter(w => w.table === 'budget_adjustments')

  const record = async (to: string) => {
    fireEvent.change(await screen.findByLabelText('Novi iznos'), { target: { value: to } })
    fireEvent.change(screen.getByLabelText('Razlog'), { target: { value: 'Seat added' } })
    fireEvent.click(screen.getByText('Sačuvaj izmenu'))
  }

  it('shows the same figure on a parent with one child as on the child itself', async () => {
    // The premise. If these ever diverge the trap is a different one, and the
    // tests below are testing something other than what happened.
    await renderConsolidated()
    await expandAll()
    await waitFor(() => expect(screen.getByText('Telekom')).toBeInTheDocument())

    expect(budgetFigure('Office', 0).textContent)
      .toBe(budgetFigure('Telekom', 0).textContent)
  })

  it('says the change sits on the parent, and names the line it will not touch', async () => {
    await renderConsolidated()
    await expandAll()
    await waitFor(() => expect(screen.getByText('Office')).toBeInTheDocument())

    fireEvent.click(budgetFigure('Office', 0))
    await screen.findByLabelText('Novi iznos')

    const notice = screen.getByText(/Ova izmena se beleži na samoj stavci Office/i)
    expect(notice).toBeInTheDocument()
    // The child is NAMED. "this row has sub-lines" would leave the owner to
    // work out which of the two identical figures he was looking at.
    expect(notice.textContent).toMatch(/Telekom/)
    expect(notice.textContent).toMatch(/ima jednu stavku ispod sebe/i)
  })

  it('says nothing of the kind on a leaf, which is the common case', async () => {
    await renderConsolidated()
    await expandAll()
    await waitFor(() => expect(screen.getByText('Telekom')).toBeInTheDocument())

    fireEvent.click(budgetFigure('Telekom', 0))
    await screen.findByLabelText('Novi iznos')

    expect(screen.queryByText(/Ova izmena se beleži/i)).not.toBeInTheDocument()
    // It reads differently rather than merely reading less: an absent notice
    // is not a statement, and the two cases have to be told apart at a glance.
    expect(screen.getByText(/Telekom nema stavki ispod sebe/i)).toBeInTheDocument()
  })

  it('counts the lines instead of naming them once there are too many to name', async () => {
    seedDb({
      v_pl_entries: ['Telekom', 'Yettel', 'A1', 'Orion', 'SBB'].map((name, i) => expenseRow({
        id: `tx-${i}`, expense_description: name, amount_rsd: 100,
      })),
    })
    await renderConsolidated()
    await expandAll()
    await waitFor(() => expect(screen.getByText('Office')).toBeInTheDocument())

    fireEvent.click(budgetFigure('Office', 0))
    await screen.findByLabelText('Novi iznos')

    const notice = screen.getByText(/Ova izmena se beleži na samoj stavci Office/i)
    expect(notice.textContent).toMatch(/ima 5 stavki ispod sebe, između ostalih/i)
  })

  it('still writes the leaf change against the description, exactly as before', async () => {
    await renderConsolidated()
    await expandAll()
    await waitFor(() => expect(screen.getByText('Telekom')).toBeInTheDocument())

    fireEvent.click(budgetFigure('Telekom', 0))
    await record('1020')

    await waitFor(() => expect(ledgerWrites()).toHaveLength(1))
    expect(ledgerWrites()[0].row).toMatchObject({
      level: 'expense_description',
      department: 'Administration',
      dept_subcategory: 'Office',
      expense_description: 'Telekom',
      amount_rsd: 20,
    })
  })

  it('still writes the parent change with no description, exactly as before', async () => {
    // The write was never the fault and must not move: a change entered on a
    // parent belongs to the parent, and `expense_description: null` is what
    // says so.
    await renderConsolidated()
    await expandAll()
    await waitFor(() => expect(screen.getByText('Office')).toBeInTheDocument())

    fireEvent.click(budgetFigure('Office', 0))
    await record('1020')

    await waitFor(() => expect(ledgerWrites()).toHaveLength(1))
    expect(ledgerWrites()[0].row).toMatchObject({
      level: 'dept_subcategory',
      department: 'Administration',
      dept_subcategory: 'Office',
      expense_description: null,
      amount_rsd: 20,
    })
  })

  it('tells the hover on a parent apart from the hover on a leaf', async () => {
    await renderConsolidated()
    await expandAll()
    await waitFor(() => expect(screen.getByText('Telekom')).toBeInTheDocument())

    expect(budgetFigure('Office', 0).getAttribute('title'))
      .toMatch(/beleži na samoj stavci Office, ne na stavci ispod nje/i)
    expect(budgetFigure('Telekom', 0).getAttribute('title'))
      .not.toMatch(/samoj stavci/i)
  })
})

describe("the row for a parent's own budget", () => {
  // It rendered `direct — not attributed to a sub-line`, truncated in the
  // label column to `direct — not attributed to a...`, and was read as
  // "uncategorised". It is neither uncategorised nor an error: it is the part
  // of the parent's budget that was entered on the parent.

  const officeDirect = () => seedDb({
    budget_adjustments: [{
      id: 'adj-direct', company_id: null,
      budget_month: `${horizonMonth(0)}-01`, level: 'dept_subcategory',
      pl_category: null, pl_subcategory: null,
      department: 'Administration', dept_subcategory: 'Office', expense_description: null,
      kind: 'adjust', amount_rsd: 20,
      reason: 'Seat added',
      created_at: '2026-01-01T00:00:00Z',
    }],
  })

  it('leads with what the money is, so truncation cannot turn it into "uncategorised"', async () => {
    officeDirect()
    await renderConsolidated()
    await expandAll()

    const label = await screen.findByText(/na samoj stavci Office/i)
    // The meaning is in the opening words, which is the part that survives the
    // ellipsis. The old label spent them on `direct — not attributed to a`.
    expect((label.textContent || '').slice(0, 22)).toBe('na samoj stavci Office')
    expect(label.textContent).not.toMatch(/^direct/)
  })

  it('carries the whole sentence on hover', async () => {
    officeDirect()
    await renderConsolidated()
    await expandAll()

    const label = await screen.findByText(/na samoj stavci Office/i)
    const title = label.getAttribute('title') || ''
    expect(title).toMatch(/Budžetirano na samoj stavci Office/i)
    expect(title).toMatch(/Nije nerazvrstano i nije greška/i)
  })
})

describe('the Budgeting page on a single company', () => {
  // Comparing one company's spend against the group's budget is not a
  // comparison, so it is not drawn. What is left is what a single company can
  // honestly say: the benchmark month and the monthly actuals.

  const headerRow = () => document.querySelector('thead tr') as HTMLElement

  it('shows actuals, and none of the budget the group owns', async () => {
    await renderConsolidated()
    await expandAll()
    // Everything the budget draws is here on the group view.
    expect(screen.getAllByText('PROCENA').length).toBeGreaterThan(0)
    expect(screen.getAllByText('ODST.').length).toBeGreaterThan(0)
    expect(screen.getByText('BUDŽET')).toBeInTheDocument()
    expect(screen.getByText('svih 12 meseci')).toBeInTheDocument()
    expect(screen.getByText('+ Dodaj budžetsku stavku')).toBeInTheDocument()

    fireEvent.change(screen.getByRole('combobox', { name: 'Firme' }), { target: { value: COMPANY_A } })
    // The switch re-queries, so the table is rebuilt before any of this is on
    // screen — the sub-header naming the company is what says it has landed.
    await waitFor(() => expect(screen.getByText('Alpha d.o.o.', { selector: 'th' })).toBeInTheDocument())

    // The budget, the variance and the Year column are gone, and so is the way
    // in to a group-level line.
    expect(screen.queryByText('PROCENA')).not.toBeInTheDocument()
    expect(screen.queryByText('ODST.')).not.toBeInTheDocument()
    expect(screen.queryByText('BUDŽET')).not.toBeInTheDocument()
    expect(screen.queryByText('svih 12 meseci')).not.toBeInTheDocument()
    expect(screen.queryByText('+ Dodaj budžetsku stavku')).not.toBeInTheDocument()

    // What is left is the actuals, benchmarked — the months are still there,
    // one column apiece instead of three.
    expect(screen.getAllByText('OSTVARENO').length).toBe(3)
    expect(screen.getByText('REFERENCA')).toBeInTheDocument()
    expect(within(headerRow()).getByText(/OVAJ MESEC/)).toBeInTheDocument()
    expect(screen.getAllByText('1.000 RSD').length).toBeGreaterThan(0)
    expect(screen.getByText('Administration')).toBeInTheDocument()

    // And one line saying why, rather than a silently shorter table.
    expect(screen.getByText(/Budžeti se postavljaju za grupu/i)).toBeInTheDocument()
    expect(screen.getByText(/P&L analiza/i)).toBeInTheDocument()
  })

  it('brings the budget back when the group is selected again', async () => {
    await renderConsolidated()
    await expandAll()
    fireEvent.change(screen.getByRole('combobox', { name: 'Firme' }), { target: { value: COMPANY_A } })
    await waitFor(() => expect(screen.queryByText('BUDŽET')).not.toBeInTheDocument())

    fireEvent.change(screen.getByRole('combobox', { name: 'Firme' }), { target: { value: '' } })
    await waitFor(() => expect(screen.getByText('BUDŽET')).toBeInTheDocument())
    expect(screen.getByText('svih 12 meseci')).toBeInTheDocument()
    expect(screen.getByText('+ Dodaj budžetsku stavku')).toBeInTheDocument()
    expect(screen.queryByText(/Budžeti se postavljaju za grupu/i)).not.toBeInTheDocument()
  })
})

// ─── One page, no tabs ───────────────────────────────────────────────────────
//
// The revenue forecast and simulation tabs were taken out with the
// subscription machinery they read. What these pin is that the budget table
// opens on its own, with its controls, and nothing points at the tabs that
// went.

describe('the page without tabs', () => {
  it('opens on the budget table, with its own controls', async () => {
    await renderConsolidated()
    await expandAll()
    expect(screen.getByText(/Ukupni troškovi/i)).toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'P&L' })).toBeInTheDocument()
    expect(screen.getByRole('combobox', { name: 'Firme' })).toBeInTheDocument()
  })

  it('offers no revenue forecast or simulation', async () => {
    await renderConsolidated()
    await expandAll()
    expect(screen.queryByRole('button', { name: 'Revenue forecast' })).not.toBeInTheDocument()
    expect(screen.queryByRole('button', { name: 'Simulation' })).not.toBeInTheDocument()
  })
})

describe('adding a line from the row it belongs under', () => {
  // The dialog above exists and works; what it cost was picking a department
  // and a sub-category the reader was already looking at. The `+` on a
  // sub-category row is the same dialog with those two answers already given.

  const plusUnder = (label: string) =>
    screen.queryByRole('button', { name: `Dodaj budžetsku stavku pod ${label}` })

  /**
   * An expense description belongs to a dept. sub-category in the database, so
   * that is the only node in the tree that can own a new child. A `+` on a
   * department would open a dialog with a level still to pick; a `+` on a
   * description would open one with nothing left to add.
   */
  it('offers the plus on a sub-category and nowhere else', async () => {
    await renderConsolidated()
    await expandAll()

    expect(plusUnder('Office')).toBeInTheDocument()
    expect(plusUnder('Administration')).not.toBeInTheDocument()
    expect(plusUnder('Telekom')).not.toBeInTheDocument()
  })

  it('opens the dialog with the row already answered', async () => {
    await renderConsolidated()
    await expandAll()

    fireEvent.click(plusUnder('Office')!)
    await screen.findByText('Dodaj budžetsku stavku')

    expect((await screen.findByLabelText('Sektor') as HTMLSelectElement).value).toBe('dep-1')
    expect((screen.getByLabelText('Podsektor') as HTMLSelectElement).value).toBe('dsc-1')
    // The one thing it was opened to say is the one thing left to say.
    expect((screen.getByLabelText('Opis troška') as HTMLSelectElement).value).toBe('')
  })

  /** The cell folds the row. A button that folds what it just opened is a
   *  button nobody presses twice. */
  it('does not fold the row it was clicked on', async () => {
    await renderConsolidated()
    await expandAll()

    fireEvent.click(plusUnder('Office')!)
    await screen.findByText('Dodaj budžetsku stavku')
    expect(screen.getByText('Telekom')).toBeInTheDocument()
  })

  it('leaves the page button opening an empty dialog', async () => {
    await renderConsolidated()

    fireEvent.click(screen.getByText('+ Dodaj budžetsku stavku'))
    await screen.findByText('Dodaj budžetsku stavku')
    expect((await screen.findByLabelText('Sektor') as HTMLSelectElement).value).toBe('')
  })

  it('records the line under the sub-category it was opened from', async () => {
    await renderConsolidated()
    await expandAll()

    fireEvent.click(plusUnder('Office')!)
    await screen.findByText('Dodaj budžetsku stavku')
    fireEvent.change(await screen.findByLabelText('Opis troška'), { target: { value: 'exd-1' } })
    fireEvent.change(screen.getByLabelText('Mesec'), { target: { value: horizonMonth(2) } })
    fireEvent.click(screen.getByText('Dalje'))

    fireEvent.change(await screen.findByLabelText('Novi iznos'), { target: { value: '750' } })
    fireEvent.change(screen.getByLabelText('Razlog'), { target: { value: 'New retainer' } })
    fireEvent.click(screen.getByText('Sačuvaj izmenu'))

    await waitFor(() =>
      expect(mockDb.writes.filter(w => w.table === 'budget_adjustments')).toHaveLength(1))
    expect(mockDb.writes.filter(w => w.table === 'budget_adjustments')[0].row).toMatchObject({
      level: 'expense_description',
      department: 'Administration',
      dept_subcategory: 'Office',
      expense_description: 'Telekom',
      // A DELTA, and this is the assertion worth having. Telekom already
      // carries a $1,000 seed, so moving it to $750 is −250 — which only
      // comes out right if the seeded path was handed to `currentFor` and
      // read its real figure. Had the dialog assumed a pre-filled line starts
      // at zero it would have written +750 here, and the line would have gone
      // to $1,750 while the dialog said $750.
      amount_rsd: -250,
    })
  })
})

// ── Read in EUR ─────────────────────────────────────────────────────────────
//
// Budgets are planned in RSD and every figure carries EUR beside it. With EUR
// selected the table reads the EUR columns; where the ledger holds an entry
// recorded in dinars only it cannot, and it says so and stays in RSD with RSD
// on every figure — never RSD figures labelled EUR.

describe('the budget read in EUR', () => {
  const { DisplayCurrencyProvider } = jest.requireActual('../contexts/DisplayCurrencyContext')
  const renderIn = async (currency: 'RSD' | 'EUR') => {
    render(<DisplayCurrencyProvider initial={currency}><Budgeting /></DisplayCurrencyProvider>)
    await waitFor(() => expect(screen.getByText(/Ukupni troškovi/i)).toBeInTheDocument())
  }
  const adjustment = (over: Record<string, any>) => ({
    id: 'adj-1', company_id: null,
    budget_month: `${horizonMonth(1)}-01`, level: 'department',
    pl_category: null, pl_subcategory: null,
    department: 'Administration', dept_subcategory: null, expense_description: null,
    kind: 'adjust', reason: 'Plan', created_at: '2026-02-01T00:00:00Z',
    ...over,
  })

  it('seeds from the EUR actuals and replays the EUR ledger figures', async () => {
    seedDb({
      v_pl_entries: [expenseRow({ amount_rsd: 117000, amount_eur: 1000 })],
      budget_adjustments: [adjustment({ amount_rsd: 58500, amount_eur: 500, seed_rsd: 0, seed_eur: 0 })],
    })
    await renderIn('EUR')
    await waitFor(() => expect(screen.getByText('Administration')).toBeInTheDocument())
    // 1,000 EUR seeded on the Telekom line under it + 500 EUR recorded on
    // Administration itself (whose own seed, recorded with the entry, is 0).
    await waitFor(() => expect(budgetFigure('Administration', 1).textContent).toContain('1.500 EUR'))
    expect(screen.queryByText(/ne može da se prikaže u EUR/)).not.toBeInTheDocument()
  })

  it('stays in RSD, and says why, when an entry was recorded in dinars only', async () => {
    seedDb({
      v_pl_entries: [expenseRow({ amount_rsd: 117000, amount_eur: 1000 })],
      budget_adjustments: [adjustment({ amount_rsd: 58500, amount_eur: null })],
    })
    await renderIn('EUR')
    await waitFor(() => expect(screen.getByText('Administration')).toBeInTheDocument())
    await waitFor(() => expect(budgetFigure('Administration', 1).textContent).toContain('175.500 RSD'))
    expect(screen.getByText(/samo u RSD/)).toBeInTheDocument()
  })
})

describe('a budget for one project, or for overhead', () => {
  const ledgerWrites = () => mockDb.writes.filter(w => w.table === 'budget_adjustments')
  const PROJECT = { id: 'p1', company_id: COMPANY_A, name: 'Zgrada A', code: null, kind: 'construction', active: true }

  beforeEach(() => {
    seedDb({
      projects: [PROJECT],
      v_pl_entries: [
        expenseRow(),
        expenseRow({ id: 'tx-2', amount_rsd: 400, project_id: 'p1' }),
      ],
    })
  })

  const pickProject = async (value: string) => {
    const select = await screen.findByRole('combobox', { name: 'Projekat' })
    await waitFor(() => expect(within(select).getByText('Zgrada A')).toBeInTheDocument())
    fireEvent.change(select, { target: { value } })
  }

  it('reads every project together by default, as the page always did', async () => {
    await renderConsolidated()
    await waitFor(() => expect(screen.getByText('Administration')).toBeInTheDocument())
    expect((screen.getByRole('combobox', { name: 'Projekat' }) as HTMLSelectElement).value).toBe('')
    expect(budgetFigure('Administration', 0).textContent).toMatch(/1[.,]?400/)
    const scoped = mockDb.requests.filter(r => r.filters.some(f => f.col === 'project_id'))
    expect(scoped).toEqual([])
  })

  it('narrows the actuals and the ledger to the chosen project', async () => {
    await renderConsolidated()
    await pickProject('p1')
    await waitFor(() => {
      for (const table of ['v_pl_entries', 'budget_adjustments']) {
        expect(mockDb.requests.some(r => r.table === table
          && r.filters.some(f => f.op === 'eq' && f.col === 'project_id' && f.val === 'p1'))).toBe(true)
      }
    })
    await waitFor(() => expect(budgetFigure('Administration', 0).textContent).toMatch(/^400/))
  })

  it('reads overhead as the lines with no project', async () => {
    await renderConsolidated()
    await pickProject('__overhead__')
    await waitFor(() => expect(mockDb.requests.some(r => r.table === 'budget_adjustments'
      && r.filters.some(f => f.op === 'is' && f.col === 'project_id' && f.val === null))).toBe(true))
  })

  it("records a change made on one project's budget for that project, against its own seed", async () => {
    await renderConsolidated()
    await pickProject('p1')
    await waitFor(() => expect(budgetFigure('Administration', 0).textContent).toMatch(/^400/))
    await expandAll()

    // The leaf, where the seed sits: a row pins its OWN seed, not its children's.
    fireEvent.click(budgetFigure('Telekom', 0))
    fireEvent.change(await screen.findByLabelText('Novi iznos'), { target: { value: '1000' } })
    fireEvent.change(screen.getByLabelText('Razlog'), { target: { value: 'Site plan' } })
    fireEvent.click(screen.getByText('Sačuvaj izmenu'))

    await waitFor(() => expect(ledgerWrites()).toHaveLength(1))
    expect(ledgerWrites()[0].row).toMatchObject({
      company_id: null, project_id: 'p1', expense_description: 'Telekom',
      amount_rsd: 600, seed_rsd: 400,
    })
  })

  it('records a change on the all-projects view as overhead, pinning the overhead seed only', async () => {
    await renderConsolidated()
    await waitFor(() => expect(screen.getByText('Administration')).toBeInTheDocument())
    await expandAll()

    fireEvent.click(budgetFigure('Telekom', 0))
    fireEvent.change(await screen.findByLabelText('Novi iznos'), { target: { value: '2000' } })
    fireEvent.change(screen.getByLabelText('Razlog'), { target: { value: 'Group plan' } })
    fireEvent.click(screen.getByText('Sačuvaj izmenu'))

    await waitFor(() => expect(ledgerWrites()).toHaveLength(1))
    expect(ledgerWrites()[0].row).toMatchObject({ project_id: null, amount_rsd: 600, seed_rsd: 1000 })
  })
})
