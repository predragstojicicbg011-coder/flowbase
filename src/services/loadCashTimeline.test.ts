import { loadCashTimeline, type CashRequest } from './loadCashTimeline'
import { loadBudgetTree } from './budgetTree'

jest.mock('./budgetTree', () => ({ loadBudgetTree: jest.fn() }))
const mockedBudget = loadBudgetTree as jest.MockedFunction<typeof loadBudgetTree>

/** A PostgREST-ish query: every filter returns itself, awaiting it gives no rows. */
function emptyQuery(): any {
  const q: any = {}
  for (const m of ['select', 'gte', 'lte', 'eq', 'or', 'in', 'order', 'range']) q[m] = () => q
  q.maybeSingle = () => Promise.resolve({ data: null, error: null })
  q.then = (ok: any, bad: any) => Promise.resolve({ data: [], error: null }).then(ok, bad)
  return q
}
const client = { from: () => emptyQuery() }

const req = (currency: 'RSD' | 'EUR'): CashRequest => ({
  currentMonth: '2026-10', today: '2026-10-08', benchmark: '2026-09',
  companyIds: [], back: 1, forward: 1, currency,
})

/** A one-root budget of 1,170 RSD a month, with whatever reading it says it has. */
function budget(currency: 'RSD' | 'EUR', eurUnavailable: string | null): any {
  const node = (b: number) => ({ root: { budget: b, actualTotal: 0, direct: 0 } })
  const rolled = { '2026-10': node(currency === 'RSD' ? 1170 : 10), '2026-11': node(currency === 'RSD' ? 1170 : 10) }
  return {
    rows: [{ key: 'root', label: 'Costs', level: 'category', hasChildren: false }],
    rolled, currency, eurUnavailable,
  }
}

const UNAVAILABLE = '2 budget figures were recorded in RSD only, so this budget cannot be read in EUR '
  + 'without dropping them. It is shown in RSD.'

describe('loadCashTimeline — the budget is read in the timeline\'s currency', () => {
  beforeEach(() => mockedBudget.mockReset())

  it('asks the budget for the requested currency', async () => {
    mockedBudget.mockResolvedValue(budget('EUR', null))
    await loadCashTimeline(client, req('EUR'))
    expect(mockedBudget.mock.calls[0][1]).toMatchObject({ currency: 'EUR', branch: 'pl', companyId: '' })
  })

  it('uses the EUR budget when it could be read in EUR', async () => {
    mockedBudget.mockResolvedValue(budget('EUR', null))
    const { timeline } = await loadCashTimeline(client, req('EUR'))
    const nov = timeline.months.find(m => m.month === '2026-11')!
    expect(nov.outflow).toBe(10)
    expect(timeline.problems.join(' ')).not.toMatch(/budget could not be read/)
  })

  it('uses the RSD budget on an RSD timeline', async () => {
    mockedBudget.mockResolvedValue(budget('RSD', UNAVAILABLE))
    const { timeline } = await loadCashTimeline(client, req('RSD'))
    const nov = timeline.months.find(m => m.month === '2026-11')!
    expect(nov.outflow).toBe(1170)
    expect(timeline.problems.join(' ')).not.toMatch(/budget could not be read/)
  })

  it('never puts dinars on a EUR line: the projected outflow is left out, and said', async () => {
    mockedBudget.mockResolvedValue(budget('RSD', UNAVAILABLE))
    const { timeline } = await loadCashTimeline(client, req('EUR'))
    const nov = timeline.months.find(m => m.month === '2026-11')!
    expect(nov.outflow).toBe(0)
    const note = timeline.problems.find(p => /budget could not be read in EUR/.test(p))
    expect(note).toBeDefined()
    expect(note).toContain('recorded in RSD only')
    expect(note).not.toContain('It is shown in RSD')
  })
})

describe('loadCashTimeline — the inflow ahead', () => {
  beforeEach(() => mockedBudget.mockReset())

  /** A query whose awaited rows depend on the table. */
  function tableClient(tables: Record<string, any[]>) {
    return {
      from: (table: string) => {
        const q: any = {}
        for (const m of ['select', 'gte', 'lte', 'eq', 'or', 'in', 'order']) q[m] = () => q
        q.range = (lo: number) => lo === 0 ? q : { then: (ok: any) => Promise.resolve({ data: [], error: null }).then(ok) }
        q.maybeSingle = () => Promise.resolve({ data: null, error: null })
        q.then = (ok: any, bad: any) => Promise.resolve({ data: tables[table] || [], error: null }).then(ok, bad)
        return q
      },
    }
  }

  it('is open revenue invoices at their due date plus the plan not yet billed', async () => {
    mockedBudget.mockResolvedValue(budget('RSD', null))
    const c = tableClient({
      v_invoice_status: [
        // Open: 400 still owed, due in November.
        { type: 'revenue', calculated_status: 'unpaid', partner_name: 'Investitor', due_date: '2026-11-10',
          invoice_date: '2026-10-05', project_id: 'p1', remaining_rsd: 400, remaining_eur: 3.4, amount_rsd: 1000, amount_eur: 8.5 },
      ],
      projects: [{ id: 'p1', name: 'Zgrada A', payment_days: 0, company_id: 'c1' }],
      // October plan of 1,000, of which 1,000 already billed (the invoice above): nothing left.
      // November plan of 2,000, payment term 0 → expected 2026-11-30.
      revenue_plan: [
        { project_id: 'p1', month: '2026-10-01', amount: 1000, currency: 'RSD', amount_rsd: 1000, amount_eur: 8.5 },
        { project_id: 'p1', month: '2026-11-01', amount: 2000, currency: 'RSD', amount_rsd: 2000, amount_eur: 17 },
      ],
    })
    const { timeline, datedIn } = await loadCashTimeline(c, req('RSD'))
    const nov = timeline.months.find(m => m.month === '2026-11')!
    expect(nov.inflow).toBe(2400)
    expect(datedIn['2026-11'].items.map(i => i.kind).sort()).toEqual(['invoice', 'plan'])
    expect(datedIn['2026-10']).toBeUndefined()
    expect(timeline.problems.join(' ')).not.toMatch(/nothing yet/)
  })
})
