import { loadBudgetTree, type QueryClient } from './budgetTree'
import { PROJECT_FILTER_OVERHEAD } from './ledgerFilters'
import { testSystemCategoryRows } from './systemCategories.fixture'

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
  const requests: { table: string; filters: Filter[]; select?: string }[] = []
  const client: QueryClient = {
    from(table: string) {
      const filters: Filter[] = []
      let select: string | undefined
      const run = () => {
        requests.push({ table, filters, select })
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
          if (prop === 'select') return (cols: string) => { select = cols; return b }
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
  department: 'Admin',
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
  const { client, requests } = fakeClient({
    credit_installments: [], system_categories: testSystemCategoryRows(CO), ...tables,
  })
  return loadBudgetTree(client, {
    monthKeys: [MONTH], benchmark: BENCH, companyIds: [CO], companyId: '',
    branch: 'department', project,
  }).then(tree => ({ tree, requests }))
}

describe('the budget tree without sub-sectors', () => {
  it('reads neither a sub-sector nor a cost description', async () => {
    const { requests } = await load({ v_pl_entries: ROWS, budget_adjustments: [] })
    for (const table of ['v_pl_entries', 'budget_adjustments']) {
      const r = requests.find(q => q.table === table)! as any
      expect(String(r.select)).not.toMatch(/dept_subcategory|expense_description/)
    }
  })

  it('sums old lines and old actuals that carry a sub-sector under their department', async () => {
    // budget_adjustments and the ledger still hold rows recorded on a
    // sub-sector or a cost description. Every one of them is summed under its
    // department: the total stays, only the finer level is gone.
    const old = (o: Record<string, any>) => ({ ...actual(o), dept_subcategory: o.sub, expense_description: o.desc })
    const actuals = [
      old({ id: 'a', amount_rsd: 1000, sub: 'Office', desc: 'Rent' }),
      old({ id: 'b', amount_rsd: 250, sub: 'Field', desc: 'Fuel' }),
    ]
    const lines = ['dept_subcategory', 'expense_description'].map((level, i) => ({
      id: `adj-${i}`, company_id: null, budget_month: `${MONTH}-01`, level,
      pl_category: 'Opex', pl_subcategory: 'Office',
      department: 'Admin', dept_subcategory: 'Office', expense_description: i ? 'Rent' : null,
      project_id: null, kind: 'adjust', amount_rsd: 100 * (i + 1), amount_eur: null,
      reason: 'old line', created_at: `2026-10-0${i + 1}T10:00:00Z`, seed_rsd: null, seed_eur: null,
    }))
    const { tree } = await load({ v_pl_entries: actuals, budget_adjustments: lines })
    expect(Object.keys(tree.rolledRsd[MONTH]).filter(k => k.startsWith('department:'))).toEqual([NODE])
    expect(tree.rows.map(r => r.key)).toEqual([NODE])
    expect(tree.rolledRsd[MONTH][NODE].budget).toBe(1250 + 100 + 200)
  })
})

describe('a figure pinned before sub-sectors were removed', () => {
  // Every pinned seed (`seed_rsd`, see `pinnedBase`) is the seed of the node
  // the figure was typed on. Before, the department and the P&L sub-category
  // were PARENTS — every actual walked down to a description leaf — so a figure
  // typed on one pinned that parent's own seed, which was always 0, and a
  // figure typed on a sub-sector or a description pinned a node that no longer
  // exists. Both land now on a node holding the whole seed. Honoured, a 0 pin
  // would wipe that seed out and the total would drop by all of it.
  const line = (o: Record<string, any>) => ({
    id: o.id, company_id: null, budget_month: `${MONTH}-01`,
    pl_category: 'Opex', pl_subcategory: 'Office', department: 'Admin',
    project_id: null, kind: 'adjust', amount_eur: null,
    reason: 'old line', created_at: '2026-10-01T10:00:00Z', seed_eur: null, ...o,
  })
  const overheadOnly = [actual({ id: 'ovh', amount_rsd: 1000 })]

  it('does not let a 0 pinned on the old department parent wipe the seed', async () => {
    const { tree } = await load({ v_pl_entries: overheadOnly, budget_adjustments: [
      line({ id: 'a1', level: 'department', amount_rsd: 200, seed_rsd: 0 }),
    ] })
    expect(tree.rolledRsd[MONTH][NODE].budget).toBe(1200)
  })

  it('does not apply a pin taken on a sub-sector or a description to the whole sector', async () => {
    const { tree } = await load({ v_pl_entries: overheadOnly, budget_adjustments: [
      line({ id: 'a1', level: 'dept_subcategory', dept_subcategory: 'Office', amount_rsd: 50, seed_rsd: 0 }),
      line({ id: 'a2', level: 'expense_description', expense_description: 'Rent', amount_rsd: 30,
        seed_rsd: 400, created_at: '2026-10-02T10:00:00Z' }),
    ] })
    // The live seed, and both old changes on top of it: nothing lost.
    expect(tree.rolledRsd[MONTH][NODE].budget).toBe(1080)
  })

  it('still holds a figure pinned on the sector itself', async () => {
    const { tree } = await load({ v_pl_entries: overheadOnly, budget_adjustments: [
      line({ id: 'a1', level: 'department', amount_rsd: 100, seed_rsd: 900 }),
    ] })
    expect(tree.rolledRsd[MONTH][NODE].budget).toBe(1000)
  })
})

describe('the budget tree with projects', () => {
  it('merges every project onto one node when no project is asked for', async () => {
    const { tree } = await load({ v_pl_entries: ROWS, budget_adjustments: [] })
    expect(tree.rolledRsd[MONTH][NODE].budget).toBe(1400)
  })

  it('keeps the seed apart per project, overhead under the empty key', async () => {
    const { tree } = await load({ v_pl_entries: ROWS, budget_adjustments: [] })
    expect(tree.seedByNodeProject.RSD[NODE][MONTH]).toEqual({ '': 1000, p1: 400 })
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
    const leaf = NODE
    const entry = {
      id: 'adj-1', company_id: null, budget_month: `${MONTH}-01`, level: 'department',
      pl_category: null, pl_subcategory: null,
      department: 'Admin',
      project_id: 'p1', kind: 'adjust', amount_rsd: 100, amount_eur: null,
      reason: 'site plan', created_at: '2026-10-01T10:00:00Z', seed_rsd: 300, seed_eur: null,
    }
    const { tree } = await load({ v_pl_entries: ROWS, budget_adjustments: [entry] })
    expect(tree.rolledRsd[MONTH][leaf].budget).toBe(1000 + 300 + 100)
  })

  it('replays an overhead entry exactly as before projects', async () => {
    const leaf = NODE
    const entry = {
      id: 'adj-2', company_id: null, budget_month: `${MONTH}-01`, level: 'department',
      pl_category: null, pl_subcategory: null,
      department: 'Admin',
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

  it('schedules no instalment, and counts it, while the credit system categories are unset', async () => {
    const inst = {
      id: 'i1', installment_no: 1, due_date: `${MONTH}-15`, principal_amount: 900,
      interest_amount: 100, status: 'due', credits: { name: 'Loan', company_id: CO, currency: 'RSD' },
    }
    const { tree } = await load({
      v_pl_entries: [], budget_adjustments: [], credit_installments: [inst], system_categories: [],
    })
    expect(tree.creditScheduled).toBe(0)
    expect(tree.creditUnclassified).toBe(1)
  })
})
