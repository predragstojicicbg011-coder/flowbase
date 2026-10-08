import { loadBudgetTree, type QueryClient } from './budgetTree'
import { PROJECT_FILTER_OVERHEAD } from './ledgerFilters'

// ─── The budget tree, with projects in it ────────────────────────────────────
//
// What these pin down is the project dimension and nothing else: the queries
// narrow to the project asked for, the seed is kept apart per project, and a
// change recorded for one project is replayed on that project's seed alone —
// so pinning a site's figure cannot swallow the overhead seed on the same row.

// No network: the credit schedule's rate is not what is under test.
jest.mock('./bookAmounts', () => ({
  ...jest.requireActual('./bookAmounts'),
  getBookRates: () => Promise.reject(new Error('offline')),
}))

type Filter = { op: string; col: string; val: any }

function fakeClient(tables: Record<string, any[]>) {
  const requests: { table: string; filters: Filter[] }[] = []
  const client: QueryClient = {
    from(table: string) {
      const filters: Filter[] = []
      const run = () => {
        requests.push({ table, filters })
        const rows = (tables[table] || []).filter(r => filters.every(f => {
          const v = r[f.col]
          if (f.op === 'eq') return v === f.val
          if (f.op === 'is') return f.val === null ? v === null || v === undefined : v === f.val
          if (f.op === 'in') return (f.val as any[]).includes(v)
          if (f.op === 'gte') return v != null && String(v) >= String(f.val)
          if (f.op === 'lte') return v != null && String(v) <= String(f.val)
          return true
        }))
        return Promise.resolve({ data: rows, error: null })
      }
      const b: any = new Proxy({}, {
        get(_t, prop: string) {
          if (prop === 'then') return (res: any, rej: any) => run().then(res, rej)
          if (['eq', 'is', 'in', 'gte', 'lte'].includes(prop)) {
            return (col: string, val: any) => { filters.push({ op: prop, col, val }); return b }
          }
          return () => b
        },
      })
      return b
    },
  }
  return { client, requests }
}

const BENCH = '2026-09'
const MONTH = '2026-10'
const CO = 'co-1'

const actual = (over: Record<string, any>) => ({
  id: over.id, company_id: CO, amount_rsd: 0, amount_eur: null,
  pl_category: 'Opex', pl_subcategory: 'Office',
  department: 'Admin', dept_subcategory: 'Office', expense_description: 'Rent',
  pl_date: `${BENCH}-10`, source: 'transaction', tx_type: 'expense',
  cf_type: 'recurring', cf_frequency: 'monthly', project_id: null,
  ...over,
})

const ROWS = [
  actual({ id: 'ovh', amount_rsd: 1000 }),
  actual({ id: 'site', amount_rsd: 400, project_id: 'p1' }),
]

const NODE = 'department:Admin'

const load = (tables: Record<string, any[]>, project?: string) => {
  const { client, requests } = fakeClient({ credit_installments: [], ...tables })
  return loadBudgetTree(client, {
    monthKeys: [MONTH], benchmark: BENCH, companyIds: [CO], companyId: '',
    branch: 'department', project,
  }).then(tree => ({ tree, requests }))
}

describe('the budget tree with projects', () => {
  it('merges every project onto one node when no project is asked for', async () => {
    const { tree } = await load({ v_pl_entries: ROWS, budget_adjustments: [] })
    expect(tree.rolledRsd[MONTH][NODE].budget).toBe(1400)
  })

  it('keeps the seed apart per project, overhead under the empty key', async () => {
    const { tree } = await load({ v_pl_entries: ROWS, budget_adjustments: [] })
    const leaf = 'department:Admin|Office|Rent'
    expect(tree.seedByNodeProject.RSD[leaf][MONTH]).toEqual({ '': 1000, p1: 400 })
  })

  it('narrows the actuals and the ledger to one project', async () => {
    const { tree, requests } = await load({ v_pl_entries: ROWS, budget_adjustments: [] }, 'p1')
    expect(tree.rolledRsd[MONTH][NODE].budget).toBe(400)
    for (const table of ['v_pl_entries', 'budget_adjustments']) {
      const r = requests.find(q => q.table === table)!
      expect(r.filters).toContainEqual({ op: 'eq', col: 'project_id', val: 'p1' })
    }
  })

  it('reads overhead as the lines with no project, not as a project', async () => {
    const { tree, requests } = await load({ v_pl_entries: ROWS, budget_adjustments: [] }, PROJECT_FILTER_OVERHEAD)
    expect(tree.rolledRsd[MONTH][NODE].budget).toBe(1000)
    const r = requests.find(q => q.table === 'budget_adjustments')!
    expect(r.filters).toContainEqual({ op: 'is', col: 'project_id', val: null })
    expect(r.filters.some(f => f.val === PROJECT_FILTER_OVERHEAD)).toBe(false)
  })

  /**
   * The reason the ledger is replayed per project. A site's entry pins the
   * site's seed (400, recorded as 300 when it was typed). Replayed on the
   * node's whole seed, that pin would replace the overhead 1000 as well and
   * the row would read 400. Per project, overhead keeps its live 1000.
   */
  it('replays a project\'s entry on that project\'s seed alone', async () => {
    const leaf = 'department:Admin|Office|Rent'
    const entry = {
      id: 'adj-1', company_id: null, budget_month: `${MONTH}-01`, level: 'expense_description',
      pl_category: null, pl_subcategory: null,
      department: 'Admin', dept_subcategory: 'Office', expense_description: 'Rent',
      project_id: 'p1', kind: 'adjust', amount_rsd: 100, amount_eur: null,
      reason: 'site plan', created_at: '2026-10-01T10:00:00Z', seed_rsd: 300, seed_eur: null,
    }
    const { tree } = await load({ v_pl_entries: ROWS, budget_adjustments: [entry] })
    expect(tree.rolledRsd[MONTH][leaf].budget).toBe(1000 + 300 + 100)
  })

  it('replays an overhead entry exactly as before projects', async () => {
    const leaf = 'department:Admin|Office|Rent'
    const entry = {
      id: 'adj-2', company_id: null, budget_month: `${MONTH}-01`, level: 'expense_description',
      pl_category: null, pl_subcategory: null,
      department: 'Admin', dept_subcategory: 'Office', expense_description: 'Rent',
      project_id: null, kind: 'adjust', amount_rsd: 500, amount_eur: null,
      reason: 'overhead plan', created_at: '2026-10-01T10:00:00Z', seed_rsd: 1000, seed_eur: null,
    }
    const overheadOnly = [actual({ id: 'ovh', amount_rsd: 1000 })]
    const { tree } = await load({ v_pl_entries: overheadOnly, budget_adjustments: [entry] })
    expect(tree.rolledRsd[MONTH][leaf].budget).toBe(1500)
  })

  it('carries no credit schedule into one project\'s budget', async () => {
    const inst = {
      id: 'i1', installment_no: 1, due_date: `${MONTH}-15`, principal_amount: 900,
      interest_amount: 100, status: 'due', credits: { name: 'Loan', company_id: CO, currency: 'RSD' },
    }
    const all = await load({ v_pl_entries: [], budget_adjustments: [], credit_installments: [inst] })
    expect(all.tree.creditScheduled).toBe(1000)
    const one = await load({ v_pl_entries: [], budget_adjustments: [], credit_installments: [inst] }, 'p1')
    expect(one.tree.creditScheduled).toBe(0)
  })
})
