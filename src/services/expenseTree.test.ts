import {
  buildTree, totalOf, flatten, findNode, adjustedTotal, excludedTotal,
  withComparison, topMovers, paretoCut, pathFor, monthsIn,
  isExpenseRow, isRevenueRow, rowsFor, byDateDesc, UNASSIGNED, PlEntry,
  contributionsFor, contributesTo, contributionTo, isAllocated,
  SOCIAL_GROWTH, AIMFOX, OPEX, PERFORMANCE, Branch,
} from './expenseTree'

const e = (o: Partial<PlEntry> & { amount_usd: number }): PlEntry => ({
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
    expect(isExpenseRow(e({ amount_usd: 1, tx_type: 'expense' }))).toBe(true)
    expect(isExpenseRow(e({ amount_usd: 1, tx_type: 'invoice_expense' }))).toBe(true)
  })

  it('rejects cash movements that are not a cost', () => {
    for (const t of ['passthrough', 'credit_payment', 'invoice_payment', 'direct']) {
      expect(isExpenseRow(e({ amount_usd: 1, tx_type: t }))).toBe(false)
    }
  })

  it('rejects a row with no transaction type rather than guessing', () => {
    expect(isExpenseRow(e({ amount_usd: 1, tx_type: null }))).toBe(false)
  })

  it('splits a mixed set into the two sides', () => {
    const rows = [
      e({ amount_usd: 10, tx_type: 'expense' }),
      e({ amount_usd: 20, tx_type: 'revenue' }),
      e({ amount_usd: 30, tx_type: 'passthrough' }),
      e({ amount_usd: 40, tx_type: 'invoice_revenue' }),
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
      { date: '2026-06-05', amountUsd: 120 },
      { date: '2026-06-05', amountUsd: 900 },
      { date: '2026-06-05', amountUsd: 400 },
    ]
    expect([...rows].sort(byDateDesc).map(r => r.amountUsd)).toEqual([900, 400, 120])
  })

  it('sorts a missing date last rather than dropping the row', () => {
    const rows = [{ date: '' }, { date: '2026-03-01' }, { date: null }]
    expect([...rows].sort(byDateDesc)[0].date).toBe('2026-03-01')
  })
})

describe('pathFor', () => {
  it('uses two levels for the P&L branch', () => {
    expect(pathFor(e({ amount_usd: 1 }), 'pl'))
      .toEqual(['Professional and Production Services', 'LinkedIn Account Rentals'])
  })

  it('uses three levels for the department branch', () => {
    expect(pathFor(e({ amount_usd: 1 }), 'department'))
      .toEqual(['Sales Expenses', 'Outsourcing services and Associates', 'Scaffolding rental'])
  })

  it('substitutes Unassigned for a missing level instead of dropping the row', () => {
    const row = e({ amount_usd: 1, department: null, dept_subcategory: '  ' })
    expect(pathFor(row, 'department'))
      .toEqual([UNASSIGNED, UNASSIGNED, 'Scaffolding rental'])
  })
})

describe('buildTree — the two branches must tie', () => {
  const rows = [
    e({ amount_usd: 100 }),
    e({ amount_usd: 250, pl_category: 'Employee and Labour', pl_subcategory: 'Net Salaries', department: null, dept_subcategory: null }),
    e({ amount_usd: 75, pl_subcategory: 'Affiliates Payment', expense_description: 'Growth Engine' }),
  ]

  it('both branches total the same', () => {
    expect(totalOf(buildTree(rows, 'pl'))).toBe(425)
    expect(totalOf(buildTree(rows, 'department'))).toBe(425)
  })

  it('a row with no department lands under Unassigned, not lost', () => {
    const dept = buildTree(rows, 'department')
    const un = dept.find(n => n.label === UNASSIGNED)
    expect(un).toBeDefined()
    expect(un!.amount).toBe(250)
  })

  it('parent amount equals the sum of its children', () => {
    for (const branch of ['pl', 'department'] as const) {
      flatten(buildTree(rows, branch))
        .filter(n => n.children.length > 0)
        .forEach(n => {
          expect(n.amount).toBeCloseTo(n.children.reduce((s, c) => s + c.amount, 0), 6)
        })
    }
  })

  it('sorts siblings by amount, largest first', () => {
    const pl = buildTree(rows, 'pl')
    expect(pl.map(n => n.amount)).toEqual([250, 175])
  })

  it('counts rows and accumulates monthly buckets', () => {
    const t = buildTree([
      e({ amount_usd: 10, pl_date: '2026-07-01' }),
      e({ amount_usd: 20, pl_date: '2026-08-01' }),
      e({ amount_usd: 30, pl_date: '2026-08-15' }),
    ], 'pl')
    expect(t[0].count).toBe(3)
    expect(t[0].monthly).toEqual({ '2026-07': 10, '2026-08': 50 })
  })

  it('ignores zero amounts and treats negatives as magnitude', () => {
    const t = buildTree([e({ amount_usd: 0 }), e({ amount_usd: -40 })], 'pl')
    expect(totalOf(t)).toBe(40)
    expect(t[0].count).toBe(1)
  })
})

describe('hiding excludes from the total', () => {
  const rows = [
    e({ amount_usd: 100, pl_category: 'A', pl_subcategory: 'A1' }),
    e({ amount_usd: 300, pl_category: 'A', pl_subcategory: 'A2' }),
    e({ amount_usd: 600, pl_category: 'B', pl_subcategory: 'B1' }),
  ]
  const tree = buildTree(rows, 'pl')

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
    e({ amount_usd: 150, pl_category: 'A', pl_subcategory: 'A1' }),
    e({ amount_usd: 50, pl_category: 'C', pl_subcategory: 'C1' }),
  ], 'pl')
  const prior = buildTree([
    e({ amount_usd: 100, pl_category: 'A', pl_subcategory: 'A1' }),
    e({ amount_usd: 80, pl_category: 'B', pl_subcategory: 'B1' }),
  ], 'pl')
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
      e({ amount_usd: 110, pl_category: 'Small', pl_subcategory: 'x' }),
      e({ amount_usd: 20, pl_category: 'Big', pl_subcategory: 'y' }),
    ], 'pl')
    const prior = buildTree([
      e({ amount_usd: 100, pl_category: 'Small', pl_subcategory: 'x' }),
      e({ amount_usd: 500, pl_category: 'Big', pl_subcategory: 'y' }),
    ], 'pl')
    const movers = topMovers(withComparison(cur, prior), 0, 5)
    expect(movers[0].label).toBe('Big')
    expect(movers[0].delta).toBe(-480)
  })

  it('leaves out lines that did not move', () => {
    const same = buildTree([e({ amount_usd: 100, pl_category: 'A', pl_subcategory: 'x' })], 'pl')
    expect(topMovers(withComparison(same, same))).toHaveLength(0)
  })
})

describe('paretoCut', () => {
  it('reports how few lines make up most of the spend', () => {
    const rows = [
      e({ amount_usd: 800, pl_category: 'A', pl_subcategory: 'big' }),
      e({ amount_usd: 100, pl_category: 'A', pl_subcategory: 'mid' }),
      ...Array.from({ length: 10 }, (_, i) =>
        e({ amount_usd: 10, pl_category: 'A', pl_subcategory: `tiny${i}` })),
    ]
    const p = paretoCut(buildTree(rows, 'pl'), 80)
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
      e({ amount_usd: 1, pl_date: '2026-08-02' }),
      e({ amount_usd: 1, pl_date: '2026-06-30' }),
      e({ amount_usd: 1, pl_date: '2026-08-20' }),
    ])).toEqual(['2026-06', '2026-08'])
  })
})

describe('allocated branches', () => {
  const ALL: Branch[] = ['pl', 'department', 'stream', 'type']
  const total = (rows: PlEntry[], b: Branch) => totalOf(buildTree(rows, b))

  it('knows which branches divide a row and which file it', () => {
    expect(isAllocated('stream')).toBe(true)
    expect(isAllocated('type')).toBe(true)
    expect(isAllocated('pl')).toBe(false)
    expect(isAllocated('department')).toBe(false)
  })

  it('gives a whole row to the stream that owns all of it', () => {
    const row = e({ amount_usd: 1000, rev_alloc_type: 'sg100' })
    const tree = buildTree([row], 'stream')
    expect(tree.map(n => n.label)).toEqual([SOCIAL_GROWTH])
    expect(tree[0].amount).toBe(1000)
  })

  it('splits a by-value row across both streams', () => {
    const row = e({
      amount_usd: 1000, amount: 1000,
      rev_alloc_type: 'byval', rev_alloc_sg: 600, rev_alloc_aimfox: 400,
    })
    const by = Object.fromEntries(buildTree([row], 'stream').map(n => [n.label, n.amount]))
    expect(by[SOCIAL_GROWTH]).toBe(600)
    expect(by[AIMFOX]).toBe(400)
  })

  /**
   * The bug this branch inherits a fix for: the split is typed in the
   * currency of the bill. 220,996 RSD split 120,000 / 100,996 against a
   * $2,188 total must read as dollars, not as $120,000.
   */
  it('converts a split typed in the currency of the bill', () => {
    const row = e({
      amount: 220996, amount_usd: 2188,
      rev_alloc_type: 'byval', rev_alloc_sg: 120000, rev_alloc_aimfox: 100996,
    })
    const by = Object.fromEntries(buildTree([row], 'stream').map(n => [n.label, n.amount]))
    expect(by[SOCIAL_GROWTH]).toBeCloseTo(1188.0758, 4)
    expect(by[AIMFOX]).toBeCloseTo(999.9242, 4)
    expect(by[SOCIAL_GROWTH] + by[AIMFOX]).toBeCloseTo(2188, 6)
  })

  it('treats a row classified before the field existed as pure OPEX', () => {
    const tree = buildTree([e({ amount_usd: 500, opex_type: null })], 'type')
    expect(tree.map(n => n.label)).toEqual([OPEX])
    expect(tree[0].amount).toBe(500)
  })

  it('splits performance spend from fixed cost', () => {
    const row = e({
      amount_usd: 800, amount: 800,
      opex_type: 'split', opex_amount: 300, performance_amount: 500,
    })
    const by = Object.fromEntries(buildTree([row], 'type').map(n => [n.label, n.amount]))
    expect(by[OPEX]).toBe(300)
    expect(by[PERFORMANCE]).toBe(500)
  })

  it('shows an expense as a cost whichever sign it was stored with', () => {
    const row = e({
      amount: -800, amount_usd: -800,
      opex_type: 'split', opex_amount: -300, performance_amount: -500,
    })
    const by = Object.fromEntries(buildTree([row], 'type').map(n => [n.label, n.amount]))
    expect(by[OPEX]).toBe(300)
    expect(by[PERFORMANCE]).toBe(500)
  })

  it('breaks each half down by cost category underneath', () => {
    const row = e({
      amount_usd: 1000, amount: 1000, pl_category: 'Marketing', pl_subcategory: 'Ads',
      rev_alloc_type: 'byval', rev_alloc_sg: 600, rev_alloc_aimfox: 400,
    })
    const sg = buildTree([row], 'stream').find(n => n.label === SOCIAL_GROWTH)!
    expect(sg.children.map(c => c.label)).toEqual(['Marketing'])
    expect(sg.children[0].children.map(c => c.label)).toEqual(['Ads'])
    expect(sg.children[0].children[0].amount).toBe(600)
  })

  /**
   * The property that makes the four tabs one report rather than four
   * opinions. If this ever fails, the screen is lying on at least one tab.
   */
  it('totals the same on all four branches', () => {
    const rows = [
      e({ amount_usd: 1000, amount: 1000, rev_alloc_type: 'byval', rev_alloc_sg: 600, rev_alloc_aimfox: 400, opex_type: 'performance' }),
      e({ amount_usd: 250, rev_alloc_type: 'af100', opex_type: 'opex' }),
      e({ amount_usd: 80, amount: 80, opex_type: 'split', opex_amount: 30, performance_amount: 50 }),
      e({ amount_usd: 1000, amount: 1000, rev_alloc_type: 'sg100', department: null, pl_category: null }),
      e({ amount_usd: -120 }),
    ]
    const totals = ALL.map(b => total(rows, b))
    for (const t of totals) expect(t).toBeCloseTo(totals[0], 6)
    expect(totals[0]).toBe(2450)
  })

  it('halves a row nobody classified rather than dropping it', () => {
    const row = e({ amount_usd: 1000, rev_alloc_type: null })
    const by = Object.fromEntries(buildTree([row], 'stream').map(n => [n.label, n.amount]))
    expect(by[SOCIAL_GROWTH]).toBe(500)
    expect(by[AIMFOX]).toBe(500)
  })

  it('places a row with no category under Unassigned inside its stream', () => {
    const row = e({ amount_usd: 400, rev_alloc_type: 'af100', pl_category: '  ', pl_subcategory: null })
    const af = buildTree([row], 'stream').find(n => n.label === AIMFOX)!
    expect(af.children[0].label).toBe(UNASSIGNED)
    expect(af.children[0].children[0].label).toBe(UNASSIGNED)
  })
})

describe('the rows behind an allocated figure', () => {
  const split = e({
    amount_usd: 1000, amount: 1000, pl_category: 'Marketing', pl_subcategory: 'Ads',
    rev_alloc_type: 'byval', rev_alloc_sg: 600, rev_alloc_aimfox: 400,
  })
  const onlySg = e({ amount_usd: 500, pl_category: 'Marketing', pl_subcategory: 'Ads', rev_alloc_type: 'sg100' })

  it('lists a split transaction under both halves', () => {
    expect(contributesTo(split, 'stream', [SOCIAL_GROWTH])).toBe(true)
    expect(contributesTo(split, 'stream', [AIMFOX])).toBe(true)
  })

  it('keeps a whole-row allocation out of the other half', () => {
    expect(contributesTo(onlySg, 'stream', [SOCIAL_GROWTH])).toBe(true)
    expect(contributesTo(onlySg, 'stream', [AIMFOX])).toBe(false)
  })

  it('matches on the deeper path too, not just the root', () => {
    expect(contributesTo(split, 'stream', [AIMFOX, 'Marketing', 'Ads'])).toBe(true)
    expect(contributesTo(split, 'stream', [AIMFOX, 'Marketing', 'Travel'])).toBe(false)
  })

  /**
   * What the drill-down has to say out loud: the list adds up to $1,500 while
   * the figure above it says $1,100, because one of the rows is in the figure
   * for part of its value.
   */
  it('reports the share a row contributes, not the row', () => {
    expect(contributionTo(split, 'stream', [SOCIAL_GROWTH])).toBe(600)
    expect(contributionTo(onlySg, 'stream', [SOCIAL_GROWTH])).toBe(500)
    const shown = contributionTo(split, 'stream', [SOCIAL_GROWTH])
      + contributionTo(onlySg, 'stream', [SOCIAL_GROWTH])
    expect(shown).toBe(1100)
  })

  it('gives the whole row on a filing branch', () => {
    expect(contributionTo(split, 'pl', ['Marketing'])).toBe(1000)
  })

  it('returns both halves of a row even when one of them is nothing', () => {
    const cs = contributionsFor(onlySg, 'stream')
    expect(cs).toHaveLength(2)
    expect(cs[1].amount).toBe(0)
  })
})
