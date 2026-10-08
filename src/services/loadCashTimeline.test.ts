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
