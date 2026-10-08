import {
  buildTree, totalOf, flatten, findNode, adjustedTotal, excludedTotal,
  withComparison, topMovers, paretoCut, pathFor, monthsIn,
  isExpenseRow, isRevenueRow, rowsFor, byDateDesc, UNASSIGNED, PlEntry,
  contributionsFor, contributesTo, contributionTo, projectRootOf,
  UNKNOWN_PROJECT, BRANCHES, Branch,
} from './expenseTree'
import { OVERHEAD_LABEL } from './projects'

const e = (o: Partial<PlEntry> & { amount_rsd: number }): PlEntry => ({
  pl_category: 'Professional and Production Services',
  pl_subcategory: 'LinkedIn Account Rentals',
  department: 'Sales Expenses',
  dept_subcategory: 'Outsourcing services and Associates',
  expense_description: 'Scaffolding rental',
  pl_date: '2026-09-14',
  ...o,
})

describe('what counts as an expense', () => {
  it('accepts both transaction and invoice expenses', () => {
    expect(isExpenseRow(e({ amount_rsd: 1, tx_type: 'expense' }))).toBe(true)
    expect(isExpenseRow(e({ amount_rsd: 1, tx_type: 'invoice_expense' }))).toBe(true)
  })

  it('rejects cash movements that are not a cost', () => {
    for (const t of ['passthrough', 'credit_payment', 'invoice_payment', 'direct']) {
      expect(isExpenseRow(e({ amount_rsd: 1, tx_type: t }))).toBe(false)
    }
  })

  it('rejects a row with no transaction type rather than guessing', () => {
    expect(isExpenseRow(e({ amount_rsd: 1, tx_type: null }))).toBe(false)
  })

  it('splits a mixed set into the two sides', () => {
    const rows = [
      e({ amount_rsd: 10, tx_type: 'expense' }),
      e({ amount_rsd: 20, tx_type: 'revenue' }),
      e({ amount_rsd: 30, tx_type: 'passthrough' }),
      e({ amount_rsd: 40, tx_type: 'invoice_revenue' }),
    ]
    expect(rowsFor(rows, 'expense')).toHaveLength(1)
    expect(rowsFor(rows, 'revenue')).toHaveLength(2)
    expect(isRevenueRow(rows[1])).toBe(true)
  })
})

describe('byDateDesc', () => {
  it('puts the most recent first', () => {
    const rows = [
      { date: '2026-02-03' }, { date: '2026-07-31' }, { date: '2026-05-07' },
    ]
    expect([...rows].sort(byDateDesc).map(r => r.date))
      .toEqual(['2026-07-31', '2026-05-07', '2026-02-03'])
  })

  it('orders by the business date, not by whatever else is on the row', () => {
    // created_at is deliberately the reverse of the business date here: an
    // invoice for February typed in during August must still sort as February.
    const rows = [
      { date: '2026-02-03', created_at: '2026-08-30' },
      { date: '2026-08-01', created_at: '2026-08-01' },
    ]
    expect([...rows].sort(byDateDesc).map(r => r.date)).toEqual(['2026-08-01', '2026-02-03'])
  })

  it('reads pl_date when that is the field the row carries', () => {
    const rows = [{ pl_date: '2026-01-09' }, { pl_date: '2026-09-14' }]
    expect([...rows].sort(byDateDesc).map(r => r.pl_date)).toEqual(['2026-09-14', '2026-01-09'])
  })

  it('breaks a tie on the larger amount, so the order is stable', () => {
    const rows = [
      { date: '2026-06-05', amount_rsd: 120 },
      { date: '2026-06-05', amount_rsd: 900 },
      { date: '2026-06-05', amount_rsd: 400 },
    ]
    expect([...rows].sort(byDateDesc).map(r => r.amount_rsd)).toEqual([900, 400, 120])
  })

  it('sorts a missing date last rather than dropping the row', () => {
    const rows = [{ date: '' }, { date: '2026-03-01' }, { date: null }]
    expect([...rows].sort(byDateDesc)[0].date).toBe('2026-03-01')
  })
})

describe('pathFor', () => {
  it('uses two levels for the P&L branch', () => {
    expect(pathFor(e({ amount_rsd: 1 }), 'pl'))
      .toEqual(['Professional and Production Services', 'LinkedIn Account Rentals'])
  })

  it('uses three levels for the department branch', () => {
    expect(pathFor(e({ amount_rsd: 1 }), 'department'))
      .toEqual(['Sales Expenses', 'Outsourcing services and Associates', 'Scaffolding rental'])
  })

  it('substitutes Unassigned for a missing level instead of dropping the row', () => {
    const row = e({ amount_rsd: 1, department: null, dept_subcategory: '  ' })
    expect(pathFor(row, 'department'))
      .toEqual([UNASSIGNED, UNASSIGNED, 'Scaffolding rental'])
  })
})

describe('buildTree — the two branches must tie', () => {
  const rows = [
    e({ amount_rsd: 100 }),
    e({ amount_rsd: 250, pl_category: 'Employee and Labour', pl_subcategory: 'Net Salaries', department: null, dept_subcategory: null }),
    e({ amount_rsd: 75, pl_subcategory: 'Affiliates Payment', expense_description: 'Growth Engine' }),
  ]

  it('both branches total the same', () => {
    expect(totalOf(buildTree(rows, 'pl', 'RSD'))).toBe(425)
    expect(totalOf(buildTree(rows, 'department', 'RSD'))).toBe(425)
  })

  it('a row with no department lands under Unassigned, not lost', () => {
    const dept = buildTree(rows, 'department', 'RSD')
    const un = dept.find(n => n.label === UNASSIGNED)
    expect(un).toBeDefined()
    expect(un!.amount).toBe(250)
  })

  it('parent amount equals the sum of its children', () => {
    for (const branch of ['pl', 'department'] as const) {
      flatten(buildTree(rows, branch, 'RSD'))
        .filter(n => n.children.length > 0)
        .forEach(n => {
          expect(n.amount).toBeCloseTo(n.children.reduce((s, c) => s + c.amount, 0), 6)
        })
    }
  })

  it('sorts siblings by amount, largest first', () => {
    const pl = buildTree(rows, 'pl', 'RSD')
    expect(pl.map(n => n.amount)).toEqual([250, 175])
  })

  it('counts rows and accumulates monthly buckets', () => {
    const t = buildTree([
      e({ amount_rsd: 10, pl_date: '2026-07-01' }),
      e({ amount_rsd: 20, pl_date: '2026-08-01' }),
      e({ amount_rsd: 30, pl_date: '2026-08-15' }),
    ], 'pl', 'RSD')
    expect(t[0].count).toBe(3)
    expect(t[0].monthly).toEqual({ '2026-07': 10, '2026-08': 50 })
  })

  it('ignores zero amounts and treats negatives as magnitude', () => {
    const t = buildTree([e({ amount_rsd: 0 }), e({ amount_rsd: -40 })], 'pl', 'RSD')
    expect(totalOf(t)).toBe(40)
    expect(t[0].count).toBe(1)
  })

  it('sums each row’s own EUR figure in the EUR view, never a converted total', () => {
    // Two rows booked at different rates: no single rate turns 23,450 RSD
    // into 200 EUR, so the EUR total can only come from amount_eur.
    const rows = [
      e({ amount_rsd: 11720, amount_eur: 100, pl_date: '2026-07-01' }),
      e({ amount_rsd: 11730, amount_eur: 100, pl_date: '2026-08-01' }),
    ]
    expect(totalOf(buildTree(rows, 'pl', 'RSD'))).toBe(23450)
    expect(totalOf(buildTree(rows, 'pl', 'EUR'))).toBe(200)
    expect(buildTree(rows, 'pl', 'EUR')[0].monthly).toEqual({ '2026-07': 100, '2026-08': 100 })
  })

  it('counts a row with no EUR figure as zero in the EUR view', () => {
    const rows = [e({ amount_rsd: 5000 }), e({ amount_rsd: 11720, amount_eur: 100 })]
    expect(totalOf(buildTree(rows, 'pl', 'EUR'))).toBe(100)
    expect(totalOf(buildTree(rows, 'pl', 'RSD'))).toBe(16720)
  })
})

describe('hiding excludes from the total', () => {
  const rows = [
    e({ amount_rsd: 100, pl_category: 'A', pl_subcategory: 'A1' }),
    e({ amount_rsd: 300, pl_category: 'A', pl_subcategory: 'A2' }),
    e({ amount_rsd: 600, pl_category: 'B', pl_subcategory: 'B1' }),
  ]
  const tree = buildTree(rows, 'pl', 'RSD')

  it('nothing hidden leaves the total intact', () => {
    expect(adjustedTotal(tree, new Set())).toBe(1000)
    expect(excludedTotal(tree, new Set())).toBe(0)
  })

  it('hiding a root removes its whole subtree', () => {
    expect(adjustedTotal(tree, new Set(['B']))).toBe(400)
    expect(excludedTotal(tree, new Set(['B']))).toBe(600)
  })

  it('hiding a child removes only that child', () => {
    const a2 = findNode(tree, 'A › A2')!
    expect(adjustedTotal(tree, new Set([a2.key]))).toBe(700)
  })

  it('does not subtract twice when a child of a hidden parent is also hidden', () => {
    const a2 = findNode(tree, 'A › A2')!
    expect(adjustedTotal(tree, new Set(['A', a2.key]))).toBe(600)
  })

  it('hiding everything leaves zero', () => {
    expect(adjustedTotal(tree, new Set(['A', 'B']))).toBe(0)
  })
})

describe('withComparison', () => {
  const cur = buildTree([
    e({ amount_rsd: 150, pl_category: 'A', pl_subcategory: 'A1' }),
    e({ amount_rsd: 50, pl_category: 'C', pl_subcategory: 'C1' }),
  ], 'pl', 'RSD')
  const prior = buildTree([
    e({ amount_rsd: 100, pl_category: 'A', pl_subcategory: 'A1' }),
    e({ amount_rsd: 80, pl_category: 'B', pl_subcategory: 'B1' }),
  ], 'pl', 'RSD')
  const merged = withComparison(cur, prior)

  it('computes delta and percentage against the prior period', () => {
    const a = merged.find(n => n.label === 'A')!
    expect(a.priorAmount).toBe(100)
    expect(a.delta).toBe(50)
    expect(a.deltaPct).toBe(50)
  })

  it('a new line has no percentage, only an absolute delta', () => {
    const c = merged.find(n => n.label === 'C')!
    expect(c.priorAmount).toBe(0)
    expect(c.delta).toBe(50)
    expect(c.deltaPct).toBeNull()
  })

  it('keeps a line that spent last period and nothing this period', () => {
    const b = merged.find(n => n.label === 'B')!
    expect(b.amount).toBe(0)
    expect(b.priorAmount).toBe(80)
    expect(b.delta).toBe(-80)
    expect(b.deltaPct).toBe(-100)
  })
})

describe('topMovers', () => {
  it('ranks by absolute change, so a large drop outranks a small rise', () => {
    const cur = buildTree([
      e({ amount_rsd: 110, pl_category: 'Small', pl_subcategory: 'x' }),
      e({ amount_rsd: 20, pl_category: 'Big', pl_subcategory: 'y' }),
    ], 'pl', 'RSD')
    const prior = buildTree([
      e({ amount_rsd: 100, pl_category: 'Small', pl_subcategory: 'x' }),
      e({ amount_rsd: 500, pl_category: 'Big', pl_subcategory: 'y' }),
    ], 'pl', 'RSD')
    const movers = topMovers(withComparison(cur, prior), 0, 5)
    expect(movers[0].label).toBe('Big')
    expect(movers[0].delta).toBe(-480)
  })

  it('leaves out lines that did not move', () => {
    const same = buildTree([e({ amount_rsd: 100, pl_category: 'A', pl_subcategory: 'x' })], 'pl', 'RSD')
    expect(topMovers(withComparison(same, same))).toHaveLength(0)
  })
})

describe('paretoCut', () => {
  it('reports how few lines make up most of the spend', () => {
    const rows = [
      e({ amount_rsd: 800, pl_category: 'A', pl_subcategory: 'big' }),
      e({ amount_rsd: 100, pl_category: 'A', pl_subcategory: 'mid' }),
      ...Array.from({ length: 10 }, (_, i) =>
        e({ amount_rsd: 10, pl_category: 'A', pl_subcategory: `tiny${i}` })),
    ]
    const p = paretoCut(buildTree(rows, 'pl', 'RSD'), 80)
    expect(p.total).toBe(1000)
    expect(p.cutoff).toBe(1)          // one line alone clears 80%
    expect(p.sharePct).toBeCloseTo(80, 6)
  })

  it('handles an empty tree', () => {
    const p = paretoCut([], 80)
    expect(p.cutoff).toBe(0)
    expect(p.total).toBe(0)
    expect(p.sharePct).toBe(0)
  })
})

describe('monthsIn', () => {
  it('returns the distinct months, ascending', () => {
    expect(monthsIn([
      e({ amount_rsd: 1, pl_date: '2026-08-02' }),
      e({ amount_rsd: 1, pl_date: '2026-06-30' }),
      e({ amount_rsd: 1, pl_date: '2026-08-20' }),
    ])).toEqual(['2026-06', '2026-08'])
  })
})

describe('the project branch', () => {
  const total = (rows: PlEntry[], b: Branch) => totalOf(buildTree(rows, b, 'RSD'))
  const roots = (rows: PlEntry[], cur: 'RSD' | 'EUR' = 'RSD') =>
    Object.fromEntries(buildTree(rows, 'project', cur).map(n => [n.label, n.amount]))

  it('offers exactly the three filing branches', () => {
    expect([...BRANCHES]).toEqual(['pl', 'department', 'project'])
  })

  it('files a row under its project, then its category and sub-category', () => {
    const row = e({ amount_rsd: 1000, project_id: 'p1', project_name: 'Zgrada A', pl_category: 'Materijal', pl_subcategory: 'Beton' })
    expect(pathFor(row, 'project')).toEqual(['Zgrada A', 'Materijal', 'Beton'])
    const tree = buildTree([row], 'project', 'RSD')
    expect(tree.map(n => n.label)).toEqual(['Zgrada A'])
    expect(tree[0].children[0].children[0].amount).toBe(1000)
  })

  it('puts a row with no project under overhead, never spread over the projects', () => {
    const rows = [
      e({ amount_rsd: 700, project_id: 'p1', project_name: 'Zgrada A' }),
      e({ amount_rsd: 300, project_id: null }),
      e({ amount_rsd: 50, project_id: '  ' }),
    ]
    expect(roots(rows)).toEqual({ 'Zgrada A': 700, [OVERHEAD_LABEL]: 350 })
  })

  it('names a project the view could not name rather than calling it overhead', () => {
    expect(projectRootOf({ project_id: 'p9', project_name: null })).toBe(UNKNOWN_PROJECT)
    expect(projectRootOf({ project_id: null, project_name: 'stale' })).toBe(OVERHEAD_LABEL)
  })

  /**
   * v_pl_entries returns a split document as one row per split line, each
   * with its OWN project. One 1,000 bill split 600 / 300 / 100 across two
   * sites and overhead lands on all three, for its line's amount each.
   */
  it('lets each split line of one document count for its own project and overhead', () => {
    const lines = [
      e({ id: 's1', amount_rsd: 600, amount_eur: 5.12, project_id: 'p1', project_name: 'Zgrada A' }),
      e({ id: 's2', amount_rsd: 300, amount_eur: 2.56, project_id: 'p2', project_name: 'Hala B' }),
      e({ id: 's3', amount_rsd: 100, amount_eur: 0.85, project_id: null }),
    ]
    expect(roots(lines)).toEqual({ 'Zgrada A': 600, 'Hala B': 300, [OVERHEAD_LABEL]: 100 })
    const eur = roots(lines, 'EUR')
    expect(eur['Zgrada A']).toBeCloseTo(5.12, 6)
    expect(eur[OVERHEAD_LABEL]).toBeCloseTo(0.85, 6)
    expect(total(lines, 'project')).toBe(1000)
  })

  it('shows an expense as a cost whichever sign it was stored with', () => {
    expect(roots([e({ amount_rsd: -800, project_id: 'p1', project_name: 'Zgrada A' })]))
      .toEqual({ 'Zgrada A': 800 })
  })

  it('places a row with no category under Unassigned inside its project', () => {
    const row = e({ amount_rsd: 400, project_id: 'p1', project_name: 'Zgrada A', pl_category: '  ', pl_subcategory: null })
    const a = buildTree([row], 'project', 'RSD')[0]
    expect(a.children[0].label).toBe(UNASSIGNED)
    expect(a.children[0].children[0].label).toBe(UNASSIGNED)
  })

  /**
   * The property that makes the tabs one report rather than three opinions.
   * If this ever fails, the screen is lying on at least one tab.
   */
  it('totals the same on all three branches', () => {
    const rows = [
      e({ amount_rsd: 1000, project_id: 'p1', project_name: 'Zgrada A' }),
      e({ amount_rsd: 250, project_id: 'p2', project_name: 'Hala B' }),
      e({ amount_rsd: 80 }),
      e({ amount_rsd: 1000, project_id: 'p1', project_name: 'Zgrada A', department: null, pl_category: null }),
      e({ amount_rsd: -120, project_id: 'p3' }),
    ]
    const totals = BRANCHES.map(b => total(rows, b))
    for (const t of totals) expect(t).toBeCloseTo(totals[0], 6)
    expect(totals[0]).toBe(2450)
  })
})

describe('the rows behind a figure', () => {
  const a1 = e({ amount_rsd: 1000, pl_category: 'Materijal', pl_subcategory: 'Beton', project_id: 'p1', project_name: 'Zgrada A' })
  const ovh = e({ amount_rsd: 500, pl_category: 'Materijal', pl_subcategory: 'Beton', project_id: null })

  it('keeps a row out of every project but its own', () => {
    expect(contributesTo(a1, 'project', ['Zgrada A'], 'RSD')).toBe(true)
    expect(contributesTo(a1, 'project', [OVERHEAD_LABEL], 'RSD')).toBe(false)
    expect(contributesTo(ovh, 'project', [OVERHEAD_LABEL], 'RSD')).toBe(true)
  })

  it('matches on the deeper path too, not just the root', () => {
    expect(contributesTo(a1, 'project', ['Zgrada A', 'Materijal', 'Beton'], 'RSD')).toBe(true)
    expect(contributesTo(a1, 'project', ['Zgrada A', 'Materijal', 'Armatura'], 'RSD')).toBe(false)
  })

  it('reports the whole row on every branch', () => {
    expect(contributionTo(a1, 'project', ['Zgrada A'], 'RSD')).toBe(1000)
    expect(contributionTo(a1, 'pl', ['Materijal'], 'RSD')).toBe(1000)
    expect(contributionTo(a1, 'project', [OVERHEAD_LABEL], 'RSD')).toBe(0)
  })

  it('returns exactly one contribution per row', () => {
    for (const b of BRANCHES) expect(contributionsFor(a1, b, 'RSD')).toHaveLength(1)
  })

  it('does not count a zero row as being under anything', () => {
    expect(contributesTo(e({ amount_rsd: 0, project_id: 'p1', project_name: 'Zgrada A' }), 'project', ['Zgrada A'], 'RSD')).toBe(false)
  })
})
