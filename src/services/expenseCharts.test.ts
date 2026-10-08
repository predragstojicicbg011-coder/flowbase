import {
  buildTree, withComparison, PlEntry, ComparedNode,
  SOCIAL_GROWTH, AIMFOX,
} from './expenseTree'
import {
  monthlySeries, bridgeSteps, paretoSeries, niceMax, niceFloor, bridgeScale, axisTicks,
  shortMoney, monthLabel, OTHER,
  moverBars, moverScale, quantileEdges, binOf, rowBin, heatGrid, facingRows,
  behaviourOf, branchRoots,
} from './expenseCharts'

const e = (o: Partial<PlEntry> & { amount_rsd: number }): PlEntry => ({
  tx_type: 'expense',
  pl_category: 'A', pl_subcategory: 'A1',
  department: 'D', dept_subcategory: 'D1', expense_description: 'x',
  pl_date: '2026-08-14',
  ...o,
})

describe('monthlySeries', () => {
  it('stacks the EUR figures when the tree was built in EUR', () => {
    const eurTree = buildTree([
      e({ amount_rsd: 11720, amount_eur: 100, pl_category: 'A', pl_date: '2026-07-05' }),
      e({ amount_rsd: 23500, amount_eur: 200, pl_category: 'B', pl_date: '2026-07-09' }),
    ], 'pl', 'EUR')
    const s = monthlySeries(eurTree, ['2026-07'])
    expect(s.points[0].values).toEqual({ B: 200, A: 100 })
    expect(s.max).toBe(300)
  })

  const tree = buildTree([
    e({ amount_rsd: 100, pl_category: 'A', pl_date: '2026-07-05' }),
    e({ amount_rsd: 300, pl_category: 'A', pl_date: '2026-08-05' }),
    e({ amount_rsd: 50, pl_category: 'B', pl_date: '2026-07-09' }),
    e({ amount_rsd: 20, pl_category: 'C', pl_date: '2026-08-09' }),
  ], 'pl', 'RSD')
  const months = ['2026-07', '2026-08']

  it('gives one point per month, in the order asked for', () => {
    expect(monthlySeries(tree, months).points.map(p => p.month)).toEqual(months)
  })

  it('splits each month across the categories', () => {
    const s = monthlySeries(tree, months)
    expect(s.points[0].values).toEqual({ A: 100, B: 50, C: 0 })
    expect(s.points[1].values).toEqual({ A: 300, B: 0, C: 20 })
  })

  it('column totals match the monthly totals', () => {
    const s = monthlySeries(tree, months)
    expect(s.points.map(p => p.total)).toEqual([150, 320])
    expect(s.max).toBe(320)
  })

  it('folds everything past topN into Other, still adding up', () => {
    const s = monthlySeries(tree, months, 1)
    expect(s.keys).toEqual(['A', OTHER])
    expect(s.points[0].values).toEqual({ A: 100, [OTHER]: 50 })
    expect(s.points[1].total).toBe(320)
  })

  it('adds no Other band when everything fits', () => {
    expect(monthlySeries(tree, months, 10).keys).not.toContain(OTHER)
  })

  it('reports a month with no spend as zero rather than skipping it', () => {
    const s = monthlySeries(tree, ['2026-06', ...months])
    expect(s.points[0]).toEqual({ month: '2026-06', values: { A: 0, B: 0, C: 0 }, total: 0 })
  })

  it('survives an empty tree', () => {
    expect(monthlySeries([], months)).toEqual({
      keys: [], max: 0,
      points: [
        { month: '2026-07', values: {}, total: 0 },
        { month: '2026-08', values: {}, total: 0 },
      ],
    })
  })
})

describe('bridgeSteps', () => {
  const cur = buildTree([
    e({ amount_rsd: 150, pl_category: 'A' }),
    e({ amount_rsd: 50, pl_category: 'C' }),
  ], 'pl', 'RSD')
  const prior = buildTree([
    e({ amount_rsd: 100, pl_category: 'A' }),
    e({ amount_rsd: 80, pl_category: 'B' }),
  ], 'pl', 'RSD')
  const steps = bridgeSteps(withComparison(cur, prior))

  it('opens on the prior total and closes on the current one', () => {
    expect(steps[0]).toMatchObject({ label: 'Prior', kind: 'start', end: 180 })
    expect(steps[steps.length - 1]).toMatchObject({ label: 'Current', kind: 'end', end: 200 })
  })

  it('the bars walk from one anchor to the other without a gap', () => {
    // Every middle bar must start where the previous one left off, or the
    // chart tells a story the numbers do not support.
    const middle = steps.slice(1, -1)
    let running = steps[0].end
    for (const st of middle) {
      const next = running + st.delta
      expect(st.start).toBeCloseTo(Math.min(running, next), 6)
      expect(st.end).toBeCloseTo(Math.max(running, next), 6)
      running = next
    }
    expect(running).toBeCloseTo(steps[steps.length - 1].end, 6)
  })

  it('marks rises and falls apart', () => {
    expect(steps.find(s => s.label === 'A')).toMatchObject({ kind: 'up', delta: 50 })
    expect(steps.find(s => s.label === 'B')).toMatchObject({ kind: 'down', delta: -80 })
  })

  it('carries the tree key so a bar can be clicked through', () => {
    expect(steps.find(s => s.label === 'A')!.key).toBe('A')
  })

  it('folds the tail into one Other step and still closes', () => {
    const many = buildTree(
      Array.from({ length: 10 }, (_, i) => e({ amount_rsd: 10 * (i + 1), pl_category: `C${i}` })), 'pl', 'RSD')
    const none = buildTree([], 'pl', 'RSD')
    const s = bridgeSteps(withComparison(many, none), 3)
    expect(s.filter(x => x.kind === 'up' || x.kind === 'down')).toHaveLength(3)
    expect(s.find(x => x.label === OTHER)).toBeDefined()
    expect(s[s.length - 1].end).toBeCloseTo(550, 6)
  })

  it('leaves out the Other step when nothing is left over', () => {
    expect(bridgeSteps(withComparison(cur, prior), 10).find(s => s.label === OTHER)).toBeUndefined()
  })

  it('shows two flat anchors when nothing moved', () => {
    const same = bridgeSteps(withComparison(cur, cur))
    expect(same).toHaveLength(2)
    expect(same[0].end).toBe(same[1].end)
  })
})

describe('paretoSeries', () => {
  const tree = buildTree([
    e({ amount_rsd: 700, pl_subcategory: 'big' }),
    e({ amount_rsd: 200, pl_subcategory: 'mid' }),
    e({ amount_rsd: 100, pl_subcategory: 'small' }),
  ], 'pl', 'RSD')

  it('ranks leaves largest first', () => {
    expect(paretoSeries(tree).map(p => p.label)).toEqual(['big', 'mid', 'small'])
  })

  it('accumulates to 100%', () => {
    const p = paretoSeries(tree)
    expect(p.map(x => x.cumulativePct)).toEqual([70, 90, 100])
    expect(p[2].cumulative).toBe(1000)
  })

  it('caps the list but keeps the share measured against the whole', () => {
    const p = paretoSeries(tree, 2)
    expect(p).toHaveLength(2)
    expect(p[1].cumulativePct).toBe(90)   // not 100 — the tail still counts
  })

  it('returns nothing when there is no spend', () => {
    expect(paretoSeries([])).toEqual([])
    expect(paretoSeries(buildTree([e({ amount_rsd: 0 })], 'pl', 'RSD'))).toEqual([])
  })
})

describe('axis helpers', () => {
  it('rounds a maximum up to a readable step', () => {
    expect(niceMax(0)).toBe(1)
    expect(niceMax(0.7)).toBe(1)
    expect(niceMax(12)).toBe(20)
    expect(niceMax(320)).toBe(500)
    expect(niceMax(1000)).toBe(1000)
    expect(niceMax(146364)).toBe(200000)
  })

  it('never rounds below the value it has to fit', () => {
    for (const v of [1, 7, 99, 101, 2345, 67890, 1234567]) {
      expect(niceMax(v)).toBeGreaterThanOrEqual(v)
    }
  })

  it('produces evenly spaced ticks including both ends', () => {
    expect(axisTicks(320, 4)).toEqual([0, 125, 250, 375, 500])
  })

  it('writes money compactly', () => {
    expect(shortMoney(0)).toBe('0')
    expect(shortMoney(850)).toBe('850')
    expect(shortMoney(1200)).toBe('1,2 hilj.')
    expect(shortMoney(67429)).toBe('67 hilj.')
    expect(shortMoney(2114286)).toBe('2,1 mil.')
    expect(shortMoney(-35858)).toBe('-36 hilj.')
    expect(shortMoney(48_500_000)).toBe('49 mil.')
    expect(shortMoney(1_500_000_000)).toBe('1,5 mlrd.')
  })

  it('names the currency when asked to', () => {
    expect(shortMoney(2114286, 'RSD')).toBe('2,1 mil. RSD')
    expect(shortMoney(-850, 'EUR')).toBe('-850 EUR')
  })

  it('names months, with the year only when asked', () => {
    expect(monthLabel('2026-08')).toBe('Aug')
    expect(monthLabel('2026-08', true)).toBe('Aug ’26')
  })
})

describe('bridgeScale', () => {
  it('keeps a zero baseline when the movement is big enough to read from it', () => {
    const sc = bridgeScale(0, 1000)
    expect(sc.zoomed).toBe(false)
    expect(sc.floor).toBe(0)
  })

  it('lifts the baseline when the steps would otherwise be invisible', () => {
    // The real case: a $263k prior walking to $303k. Measured from zero, a
    // $10k step is a hairline.
    const sc = bridgeScale(263000, 303000)
    expect(sc.zoomed).toBe(true)
    expect(sc.floor).toBeGreaterThan(0)
  })

  it('a lifted baseline still contains the whole walk', () => {
    for (const [lo, hi] of [[263000, 303000], [1_000_000, 1_040_000], [500, 530], [90, 97]]) {
      const sc = bridgeScale(lo, hi)
      expect(sc.floor).toBeLessThanOrEqual(lo)
      expect(sc.top).toBeGreaterThanOrEqual(hi)
    }
  })

  it('the steps a zoomed axis produces are actually visible', () => {
    const sc = bridgeScale(263000, 303000)
    const frac = 10000 / (sc.top - sc.floor)
    expect(frac).toBeGreaterThan(0.05)     // a $10k step gets >5% of the height
  })

  it('gives evenly spaced ticks spanning floor to top', () => {
    const sc = bridgeScale(263000, 303000)
    expect(sc.ticks[0]).toBe(sc.floor)
    expect(sc.ticks[sc.ticks.length - 1]).toBe(sc.top)
    const gaps = sc.ticks.slice(1).map((t, i) => t - sc.ticks[i])
    expect(new Set(gaps.map(g => Math.round(g)))).toHaveProperty('size', 1)
  })

  it('falls back to zero for a flat or empty walk', () => {
    expect(bridgeScale(100, 100).zoomed).toBe(false)
    expect(bridgeScale(0, 0).floor).toBe(0)
  })

  it('rounds a floor down to a readable step', () => {
    expect(niceFloor(0)).toBe(0)
    expect(niceFloor(249000)).toBe(200000)
    expect(niceFloor(6700)).toBe(6500)
  })
})

describe('moverBars', () => {
  const cmp = (over: Partial<ComparedNode> & { label: string; path: string[]; amount: number; priorAmount: number }): ComparedNode => ({
    key: over.path.join(' > '),
    depth: over.path.length - 1,
    count: 1, monthly: {}, children: [],
    delta: over.amount - over.priorAmount,
    deltaPct: over.priorAmount > 0 ? ((over.amount - over.priorAmount) / over.priorAmount) * 100 : null,
    ...over,
  } as ComparedNode)

  const tree: ComparedNode[] = [
    cmp({
      label: 'Marketing', path: ['Marketing'], amount: 50000, priorAmount: 20000,
      children: [
        cmp({ label: 'Ads', path: ['Marketing', 'Ads'], amount: 48000, priorAmount: 10000 }),
        cmp({ label: 'Events', path: ['Marketing', 'Events'], amount: 2000, priorAmount: 10000 }),
      ],
    }),
    cmp({
      label: 'Office', path: ['Office'], amount: 1000, priorAmount: 4000,
      children: [cmp({ label: 'Rent', path: ['Office', 'Rent'], amount: 1000, priorAmount: 4000 })],
    }),
    cmp({ label: 'Legal', path: ['Legal'], amount: 700, priorAmount: 700 }),
  ]

  it('ranks by how big the movement is, not by which way it went', () => {
    expect(moverBars(tree, 0).map(b => b.label)).toEqual(['Marketing', 'Office'])
  })

  it('leaves out a line that did not move at all', () => {
    expect(moverBars(tree, 0).some(b => b.label === 'Legal')).toBe(false)
  })

  it('reaches the level where the line actually is', () => {
    expect(moverBars(tree, 1).map(b => b.label)).toEqual(['Ads', 'Events', 'Rent'])
  })

  it('carries the ancestry, so two lines called Rent are distinguishable', () => {
    const rent = moverBars(tree, 1).find(b => b.label === 'Rent')!
    expect(rent.parent).toEqual(['Office'])
  })

  it('keeps the sign, because the direction is half the story', () => {
    const bars = moverBars(tree, 1)
    expect(bars.find(b => b.label === 'Ads')!.delta).toBe(38000)
    expect(bars.find(b => b.label === 'Events')!.delta).toBe(-8000)
  })

  it('takes the biggest few and stops', () => {
    expect(moverBars(tree, 1, 2).map(b => b.label)).toEqual(['Ads', 'Events'])
  })

  it('measures both sides with one ruler', () => {
    const axis = moverScale(moverBars(tree, 1), 600, 76)
    expect(axis.up).toBe(38000)
    expect(axis.down).toBe(8000)
    // 600 wide, 76 reserved at each end for the figure on the bar.
    expect(axis.perDollar).toBeCloseTo(448 / 46000, 9)
  })

  /**
   * The flaw the rendered chart showed: with the zero line pinned to the
   * middle, a month in which everything rose drew every bar in half the
   * width and left the other half blank.
   */
  it('puts the zero line at the edge when only one side has bars', () => {
    const allUp = moverBars(tree, 1).filter(b => b.delta > 0)
    expect(moverScale(allUp, 600, 76).zeroX).toBe(0)

    const allDown = moverBars(tree, 1).filter(b => b.delta < 0)
    expect(moverScale(allDown, 600, 76).zeroX).toBe(600)
  })

  /**
   * And the flaw that fix introduced: with zero hard against the edge, the
   * longest bar ended exactly at the other edge and the figure printed on it
   * fell outside the chart.
   */
  it('keeps the longest bar clear of the frame on either side', () => {
    const allUp = moverBars(tree, 1).filter(b => b.delta > 0)
    const up = moverScale(allUp, 600, 76)
    expect(up.zeroX + up.up * up.perDollar).toBeCloseTo(524, 6)

    const allDown = moverBars(tree, 1).filter(b => b.delta < 0)
    const down = moverScale(allDown, 600, 76)
    expect(down.zeroX - down.down * down.perDollar).toBeCloseTo(76, 6)
  })

  it('gives each side the width its own extent asks for', () => {
    const axis = moverScale(moverBars(tree, 1), 600, 76)
    expect(axis.zeroX).toBeCloseTo(76 + 8000 * axis.perDollar, 6)
    expect(axis.zeroX).toBeLessThan(300)
  })

  it('still draws bars when the plot is too narrow for two captions', () => {
    const axis = moverScale(moverBars(tree, 1), 100, 76)
    expect(axis.perDollar).toBeGreaterThan(0)
    expect(axis.zeroX).toBeGreaterThan(0)
    expect(axis.zeroX).toBeLessThan(100)
  })

  it('does not divide by a period in which nothing moved', () => {
    expect(moverScale([], 600).perDollar).toBe(0)
    expect(moverScale([], 600).zeroX).toBe(0)
  })
})

// ─── The heatmap ────────────────────────────────────────────────────────────

describe('quantile bins', () => {
  it('cuts a set into steps that hold roughly the same number of cells', () => {
    const values = [1, 2, 3, 4, 5, 6, 7, 8, 9, 10]
    const edges = quantileEdges(values, 5)
    expect(edges).toHaveLength(4)
    const counts = [0, 0, 0, 0, 0]
    values.forEach(v => counts[binOf(v, edges)]++)
    expect(Math.max(...counts) - Math.min(...counts)).toBeLessThanOrEqual(1)
  })

  /**
   * The whole reason for quantiles. On equal slices of the range, nine of
   * these ten cells land in the bottom bin and the grid says nothing.
   */
  it('still separates the small cells when one value dwarfs the rest', () => {
    const skewed = [10, 20, 30, 40, 50, 60, 70, 80, 90, 900000]
    const edges = quantileEdges(skewed, 5)
    const bins = new Set(skewed.map(v => binOf(v, edges)))
    expect(bins.size).toBe(5)
  })

  it('ignores empty months when working out the edges', () => {
    expect(quantileEdges([0, 0, 0, 5], 5).every(v => v > 0)).toBe(true)
  })

  it('has no edges at all for a set with nothing in it', () => {
    expect(quantileEdges([0, 0], 5)).toEqual([])
    expect(binOf(0, [])).toBe(-1)
    expect(binOf(5, [])).toBe(0)
  })

  it('tells an empty cell from a small one', () => {
    const edges = quantileEdges([1, 2, 3, 4, 5], 5)
    expect(binOf(0, edges)).toBe(-1)
    expect(binOf(1, edges)).toBe(0)
  })

  it('reads a cell against its own row when asked to', () => {
    expect(rowBin(100, 100, 5)).toBe(4)
    expect(rowBin(10, 100, 5)).toBe(0)
    expect(rowBin(50, 100, 5)).toBe(2)
    expect(rowBin(0, 100, 5)).toBe(-1)
  })

  it('does not divide by a row that never spent anything', () => {
    expect(rowBin(5, 0, 5)).toBe(0)
  })
})

describe('heatGrid', () => {
  const months = ['2026-01', '2026-02', '2026-03']
  const rows = [
    e({ amount_rsd: 100, pl_category: 'Marketing', pl_subcategory: 'Ads', pl_date: '2026-01-10' }),
    e({ amount_rsd: 300, pl_category: 'Marketing', pl_subcategory: 'Ads', pl_date: '2026-03-10' }),
    e({ amount_rsd: 50, pl_category: 'Marketing', pl_subcategory: 'Events', pl_date: '2026-02-10' }),
    e({ amount_rsd: 900, pl_category: 'Office', pl_subcategory: 'Rent', pl_date: '2026-01-10' }),
  ]
  const tree = buildTree(rows, 'pl', 'RSD')

  it('lays a line out across the months, gaps included', () => {
    const g = heatGrid(tree, months, 1)
    const ads = g.rows.find(r => r.label === 'Ads')!
    expect(ads.values).toEqual([100, 0, 300])
  })

  it('puts the biggest line at the top', () => {
    expect(heatGrid(tree, months, 1).rows[0].label).toBe('Rent')
  })

  it('carries each row its own biggest month, for the per-row scale', () => {
    const ads = heatGrid(tree, months, 1).rows.find(r => r.label === 'Ads')!
    expect(ads.max).toBe(300)
  })

  /** Folding, not dropping — the columns still add to the month. */
  it('sums the lines past the cap into one Other row', () => {
    const g = heatGrid(tree, months, 1, 1)
    expect(g.rows.map(r => r.label)).toEqual(['Rent', 'Other'])
    expect(g.folded).toBe(2)
    const total = g.rows.reduce((s, r) => s + r.total, 0)
    expect(total).toBe(1350)
  })

  it('says so when nothing was folded', () => {
    expect(heatGrid(tree, months, 1).folded).toBe(0)
  })

  it('falls back to the deepest level a shallow branch does have', () => {
    const g = heatGrid(tree, months, 7)
    expect(g.rows.length).toBeGreaterThan(0)
  })

  it('has no rows at all when there is nothing to show', () => {
    expect(heatGrid([], months, 1).rows).toEqual([])
  })

  it('distinguishes two lines of the same name under different parents', () => {
    const same = buildTree([
      e({ amount_rsd: 10, pl_category: 'A', pl_subcategory: 'Fees', pl_date: '2026-01-10' }),
      e({ amount_rsd: 20, pl_category: 'B', pl_subcategory: 'Fees', pl_date: '2026-01-10' }),
    ], 'pl', 'RSD')
    const g = heatGrid(same, months, 1)
    expect(g.rows.map(r => r.parent[0]).sort()).toEqual(['A', 'B'])
    expect(new Set(g.rows.map(r => r.key)).size).toBe(2)
  })
})

// ─── The split, side by side ────────────────────────────────────────────────

describe('facingRows', () => {
  const rows = [
    e({ amount_rsd: 1000, amount: 1000, pl_category: 'Marketing', pl_subcategory: 'Ads', rev_alloc_type: 'byval', rev_alloc_sg: 700, rev_alloc_aimfox: 300 }),
    e({ amount_rsd: 400, pl_category: 'Office', pl_subcategory: 'Rent', rev_alloc_type: 'sg100' }),
    e({ amount_rsd: 250, pl_category: 'Legal', pl_subcategory: 'Advice', rev_alloc_type: 'af100' }),
  ]
  const tree = buildTree(rows, 'stream', 'RSD')
  const chart = () => facingRows(tree, SOCIAL_GROWTH, AIMFOX)

  it('puts each category on both sides of the centre line', () => {
    const marketing = chart().rows.find(r => r.label === 'Marketing')!
    expect(marketing.left).toBe(700)
    expect(marketing.right).toBe(300)
  })

  it('leaves a side at zero where only one stream pays', () => {
    const legal = chart().rows.find(r => r.label === 'Legal')!
    expect(legal.left).toBe(0)
    expect(legal.right).toBe(250)
  })

  it('orders by what the category costs in total, both sides together', () => {
    expect(chart().rows.map(r => r.label)).toEqual(['Marketing', 'Office', 'Legal'])
  })

  it('scales both sides off one number', () => {
    expect(chart().max).toBeGreaterThanOrEqual(700)
  })

  it('carries the node keys, so either half opens its own transactions', () => {
    const marketing = chart().rows.find(r => r.label === 'Marketing')!
    expect(marketing.leftPath).toEqual([SOCIAL_GROWTH, 'Marketing'])
    expect(marketing.rightPath).toEqual([AIMFOX, 'Marketing'])
  })

  it('reports each side its own total', () => {
    expect(chart().leftTotal).toBe(1100)
    expect(chart().rightTotal).toBe(550)
  })

  /**
   * A stream that spent nothing has no node in the tree. Reading the labels
   * off the tree would drop it, and a one-sided chart would read as a
   * complete comparison.
   */
  it('keeps a side that spent nothing at all', () => {
    const oneSided = buildTree([e({ amount_rsd: 500, rev_alloc_type: 'sg100' })], 'stream', 'RSD')
    const c = facingRows(oneSided, SOCIAL_GROWTH, AIMFOX)
    expect(c.rightLabel).toBe(AIMFOX)
    expect(c.rightTotal).toBe(0)
    expect(c.rows.every(r => r.right === 0)).toBe(true)
  })

  it('folds the tail into Other rather than losing it', () => {
    const c = facingRows(tree, SOCIAL_GROWTH, AIMFOX, 1)
    expect(c.rows.map(r => r.label)).toEqual(['Marketing', 'Other'])
    const other = c.rows[1]
    expect(other.left).toBe(400)
    expect(other.right).toBe(250)
  })

  it('does not collapse to a zero axis on an empty period', () => {
    expect(facingRows([], SOCIAL_GROWTH, AIMFOX).max).toBe(1)
  })
})

// ─── The branching tree ─────────────────────────────────────────────────────

describe('behaviourOf', () => {
  const NINE = ['2026-01', '2026-02', '2026-03', '2026-04', '2026-05',
    '2026-06', '2026-07', '2026-08', '2026-09']
  const every = (v: number) => Object.fromEntries(NINE.map(m => [m, v]))

  it('calls a cost that barely moves fixed', () => {
    expect(behaviourOf(every(7400), NINE)).toBe('fixed')
  })

  it('calls a cost that swings variable', () => {
    const swinging = { ...every(1000), '2026-05': 40000, '2026-08': 200 }
    expect(behaviourOf(swinging, NINE)).toBe('variable')
  })

  /**
   * The difference from `costStructure`, and the reason for it: a line that
   * spent in three of nine months is not a fixed cost. Averaged over only the
   * months it appeared in, it looks like one.
   */
  it('counts the months a line was absent, rather than averaging over the rest', () => {
    const threeOfNine = { '2026-01': 5000, '2026-05': 5000, '2026-09': 5000 }
    expect(behaviourOf(threeOfNine, NINE)).toBe('variable')
    // The same three figures judged on their own months would read as fixed.
    expect(behaviourOf(threeOfNine, ['2026-01', '2026-05', '2026-09'])).toBe('fixed')
  })

  it('says nothing about a period too short to judge', () => {
    expect(behaviourOf({ '2026-08': 900 }, ['2026-08'])).toBe('unknown')
    expect(behaviourOf(every(900), ['2026-07', '2026-08'])).toBe('unknown')
  })

  it('says nothing about a line that spent nothing', () => {
    expect(behaviourOf({}, NINE)).toBe('unknown')
    expect(behaviourOf(every(0), NINE)).toBe('unknown')
  })
})

describe('branchRoots', () => {
  const months = ['2026-07', '2026-08', '2026-09']
  const tree = buildTree([
    e({ amount_rsd: 100, pl_category: 'Marketing', pl_subcategory: 'Ads', pl_date: '2026-07-04' }),
    e({ amount_rsd: 100, pl_category: 'Marketing', pl_subcategory: 'Ads', pl_date: '2026-08-04' }),
    e({ amount_rsd: 100, pl_category: 'Marketing', pl_subcategory: 'Ads', pl_date: '2026-09-04' }),
    e({ amount_rsd: 900, pl_category: 'Office', pl_subcategory: 'Rent', pl_date: '2026-07-04' }),
  ], 'pl', 'RSD')

  it('keeps the tree shape the table already shows', () => {
    const roots = branchRoots(tree, months)
    expect(roots.map(r => r.label)).toEqual(['Office', 'Marketing'])
    expect(roots.find(r => r.label === 'Marketing')!.children!.map(c => c.label)).toEqual(['Ads'])
  })

  it('carries the node key through, so a click still finds its transactions', () => {
    const marketing = branchRoots(tree, months).find(r => r.label === 'Marketing')!
    expect(marketing.children![0].key).toBe('Marketing › Ads')
  })

  it('measures each node its own behaviour rather than inheriting a parent’s', () => {
    const roots = branchRoots(tree, months)
    expect(roots.find(r => r.label === 'Marketing')!.behaviour).toBe('fixed')
    expect(roots.find(r => r.label === 'Office')!.behaviour).toBe('variable')
  })

  it('leaves a leaf without an empty children array', () => {
    const leaf = branchRoots(tree, months)[0].children![0]
    expect(leaf.children).toBeUndefined()
  })

  it('does not draw a branch carrying nothing', () => {
    const withZero = buildTree([e({ amount_rsd: 0, pl_category: 'Ghost' })], 'pl', 'RSD')
    expect(branchRoots(withZero, months)).toEqual([])
  })
})
