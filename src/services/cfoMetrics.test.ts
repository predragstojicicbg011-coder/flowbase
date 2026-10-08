import {
  burnAndRunway, concentration, costStructure, monthlyTrend, monthsEndingAt,
  receivables, tornado, type MonthPoint,
} from './cfoMetrics'

const point = (over: Partial<MonthPoint> = {}): MonthPoint => ({
  month: '2026-01', revenue: 0, expenses: 0, result: 0, margin: null, complete: true, ...over,
})

describe('twelve months of in and out', () => {
  it('counts back from the month given, oldest first', () => {
    expect(monthsEndingAt('2026-02', 4)).toEqual(['2025-11', '2025-12', '2026-01', '2026-02'])
  })

  it('separates what came in from what went out', () => {
    const t = monthlyTrend([
      { pl_date: '2026-01-05', amount_usd: 1000, tx_type: 'revenue' },
      { pl_date: '2026-01-09', amount_usd: 500, tx_type: 'invoice_revenue' },
      { pl_date: '2026-01-14', amount_usd: 900, tx_type: 'expense' },
    ], ['2026-01'])
    expect(t[0]).toMatchObject({ revenue: 1500, expenses: 900, result: 600 })
  })

  it('takes an expense at its size whichever sign it arrives with', () => {
    // The ledger books expenses positive in some places and negative in
    // others, and adding a negative to an expense total makes the month look
    // cheaper than it was.
    const t = monthlyTrend([
      { pl_date: '2026-01-14', amount_usd: -900, tx_type: 'expense' },
    ], ['2026-01'])
    expect(t[0].expenses).toBe(900)
  })

  it('MARKS THE MONTH THAT IS STILL RUNNING rather than dropping or hiding it', () => {
    // Dropped, the chart omits the month everyone is actually in. Included
    // silently, three weeks of a month reads as a collapse.
    const t = monthlyTrend([], ['2026-01', '2026-02'], '2026-02')
    expect(t.map(p => p.complete)).toEqual([true, false])
  })

  it('leaves margin null where there was no revenue to divide by', () => {
    // Not zero. A month with costs and no revenue has an undefined margin,
    // and 0% reads as breaking even.
    const t = monthlyTrend([
      { pl_date: '2026-01-14', amount_usd: 900, tx_type: 'expense' },
    ], ['2026-01'])
    expect(t[0].margin).toBeNull()
  })

  it('gives every month asked for, including the empty ones', () => {
    // A month with nothing in it is a gap in the line, and a line drawn
    // straight through a missing month is a claim about it.
    expect(monthlyTrend([], monthsEndingAt('2026-12', 12))).toHaveLength(12)
  })
})

describe('burn, and how long it can go on', () => {
  it('AVERAGES THE LOSING MONTHS, not all of them', () => {
    // A company that loses 200k then makes 190k is not burning 5k. Averaging
    // the good months in is how a runway comes out four times too long — and
    // runway is read for one purpose, deciding when to act.
    const r = burnAndRunway([
      point({ result: -200000 }), point({ result: 190000 }), point({ result: -100000 }),
    ], 600000)
    expect(r.burn).toBe(150000)
    expect(r.months).toBe(4)
  })

  it('leaves out the month that is still running', () => {
    const r = burnAndRunway([
      point({ result: -100000 }), point({ result: -3000, complete: false }),
    ], 500000)
    expect(r.burn).toBe(100000)
    expect(r.monthsUsed).toBe(1)
  })

  it('REFUSES A RUNWAY WITH NO CASH POSITION, and says why', () => {
    // There is no cash balance anywhere in this application; it is a figure
    // somebody reports. A runway computed without one is a number invented on
    // a screen that exists to be trusted.
    const r = burnAndRunway([point({ result: -100000 })], null)
    expect(r.months).toBeNull()
    expect(r.unknown).toMatch(/cash position/i)
    expect(r.burn).toBe(100000)
  })

  it('says there is no burn rather than dividing by zero', () => {
    const r = burnAndRunway([point({ result: 50000 }), point({ result: 20000 })], 600000)
    expect(r.months).toBeNull()
    expect(r.unknown).toMatch(/lost money/i)
  })

  it('has nothing to say about a history of no complete months', () => {
    expect(burnAndRunway([point({ complete: false })], 100).unknown).toMatch(/complete month/i)
  })
})

describe('how much of it is one brand', () => {
  const brands = [
    { label: 'Aimfox', amount: 204513.92 },
    { label: 'Kicksta', amount: 86159.72 },
    { label: 'Nitreo', amount: 10789.02 },
    { label: 'Flock', amount: 8532.11 },
  ]

  it('ranks them and gives each its share of the whole', () => {
    const c = concentration(brands)
    expect(c.shares[0].label).toBe('Aimfox')
    expect(c.topShare).toBeCloseTo(204513.92 / c.total, 6)
  })

  it('says how many brands it takes to reach half the revenue', () => {
    // One is the number that matters, and it is a different sentence from a
    // percentage.
    expect(concentration(brands).brandsToHalf).toBe(1)
  })

  it('TELLS ONE BIG BRAND APART FROM THREE MEDIUM ONES', () => {
    // A top share cannot: 40% is 40% either way, and they are different
    // companies to run. The Herfindahl index is what separates them.
    const lopsided = concentration([
      { label: 'A', amount: 70 }, { label: 'B', amount: 10 },
      { label: 'C', amount: 10 }, { label: 'D', amount: 10 },
    ])
    const even = concentration([
      { label: 'A', amount: 25 }, { label: 'B', amount: 25 },
      { label: 'C', amount: 25 }, { label: 'D', amount: 25 },
    ])
    expect(lopsided.hhi!).toBeGreaterThan(even.hhi!)
    expect(even.hhi!).toBeCloseTo(0.25, 6)
  })

  it('leaves out a brand worth nothing rather than ranking a row of zeros', () => {
    expect(concentration([...brands, { label: 'SocialFollow', amount: 0 }]).shares)
      .toHaveLength(4)
  })

  it('has no opinion about an empty book, rather than a share of zero', () => {
    const c = concentration([])
    expect(c.topShare).toBeNull()
    expect(c.hhi).toBeNull()
  })
})

describe('what the base costs and what clears it', () => {
  // Payroll barely moves; marketing swings by half.
  const history = {
    'Employee and Labour': { '2026-06': 180000, '2026-07': 182000, '2026-08': 179000 },
    'Marketing expenses': { '2026-06': 20000, '2026-07': 62000, '2026-08': 41000 },
    'A new line': { '2026-08': 5000 },
  }
  const planned = [
    { label: 'Employee and Labour', amount: 180430 },
    { label: 'Marketing expenses', amount: 62150 },
    { label: 'A new line', amount: 5000 },
  ]

  it('MEASURES WHETHER A COST MOVES rather than reading a list of names', () => {
    // A list of "fixed" category names is wrong within a quarter of being
    // written, and wrong silently. What makes a cost fixed is that it does not
    // move, and whether it moves is in the ledger.
    const cs = costStructure(history, planned, 300000)
    const by = Object.fromEntries(cs.categories.map(c => [c.label, c.behaviour]))
    expect(by['Employee and Labour']).toBe('fixed')
    expect(by['Marketing expenses']).toBe('variable')
  })

  it('will not judge a category it has barely seen', () => {
    const cs = costStructure(history, planned, 300000)
    expect(cs.categories.find(c => c.label === 'A new line')!.behaviour).toBe('unknown')
    expect(cs.unknown).toBe(5000)
  })

  it('carries what it could not classify on the FIXED side of the break-even', () => {
    // It has to go somewhere, and calling an unmeasured cost variable makes
    // the break-even lower — which is the direction that gets believed.
    const withUnknown = costStructure(history, planned, 300000)
    const withoutUnknown = costStructure(history, planned.slice(0, 2), 300000)
    expect(withUnknown.breakEven!).toBeGreaterThan(withoutUnknown.breakEven!)
  })

  it('works the break-even out of the contribution margin', () => {
    // fixed 180,430 over a margin of 1 − 62,150/300,000
    const cs = costStructure(history, planned.slice(0, 2), 300000)
    expect(cs.contributionMargin).toBeCloseTo(1 - 62150 / 300000, 6)
    expect(cs.breakEven).toBeCloseTo(180430 / (1 - 62150 / 300000), 1)
  })

  it('SAYS THERE IS NO BREAK-EVEN when the variable costs eat the whole dollar', () => {
    // Not a huge number, and not zero. No amount of revenue clears the base,
    // and that is the finding.
    const cs = costStructure(
      { Ads: { a: 100, b: 300, c: 200 } },
      [{ label: 'Ads', amount: 300000 }], 250000)
    expect(cs.contributionMargin!).toBeLessThan(0)
    expect(cs.breakEven).toBeNull()
  })

  it('does not divide by a revenue of nothing', () => {
    const cs = costStructure(history, planned, 0)
    expect(cs.variableRatio).toBeNull()
    expect(cs.breakEven).toBeNull()
  })
})

describe('what moves the result most', () => {
  const drivers = [
    { id: 'rev', label: 'Subscription revenue', effect: (p: number) => 300000 * p },
    { id: 'pay', label: 'Payroll', effect: (p: number) => -180000 * p },
    { id: 'fee', label: 'Processing fees', effect: (p: number) => -13000 * p },
  ]

  it('ranks by how far a driver can move the result, biggest first', () => {
    // The question is not what the result is but what would have to be true
    // for it to be different, and the answer is an ordering.
    expect(tornado(drivers, 0.1).map(b => b.id)).toEqual(['rev', 'pay', 'fee'])
  })

  it('carries both directions, because they are not always symmetric', () => {
    const [rev] = tornado(drivers, 0.1)
    expect(rev.up).toBe(30000)
    expect(rev.down).toBe(-30000)
  })

  it('PUTS THE RESULT ON THE AXIS, NOT THE DRIVER', () => {
    // The live fault rendering caught. Less revenue is worse; less payroll is
    // better. Drawing the `down` move on the left for every row put a green
    // bar on the side the legend calls "result falls" for three rows in five,
    // and the reader believes whichever of position or colour they read first.
    const [rev, pay] = tornado(drivers, 0.1)

    expect(rev.worse).toBe(-30000)      // revenue down is the bad side
    expect(rev.worseDirection).toBe(-1)
    expect(pay.worse).toBe(-18000)      // payroll UP is the bad side
    expect(pay.worseDirection).toBe(1)

    // And it holds for every row: worse is never above zero, better never below.
    for (const b of tornado(drivers, 0.1)) {
      expect(b.worse).toBeLessThanOrEqual(0)
      expect(b.better).toBeGreaterThanOrEqual(0)
    }
  })

  it('keeps worse and better as the two outcomes, whichever move produced them', () => {
    const [pay] = tornado([drivers[1]], 0.1)
    expect(pay.better).toBe(18000)      // payroll down
    expect(Math.abs(pay.worse)).toBe(pay.better)
  })

  it('leaves out a driver that cannot move anything', () => {
    expect(tornado([...drivers, { id: 'nil', label: 'Nothing', effect: () => 0 }], 0.1)
      .map(b => b.id)).not.toContain('nil')
  })
})

describe('money earned and not yet collected', () => {
  const inv = (due: string | null, amount: number) =>
    ({ due_date: due, remaining_usd: amount })

  it('ages what is owed against today', () => {
    const r = receivables([
      inv('2026-10-15', 1000),   // not yet due
      inv('2026-09-20', 2000),   // 6 days
      inv('2026-08-01', 3000),   // 56 days
      inv('2026-05-01', 4000),   // 148 days
    ], '2026-09-26', 900000)

    const by = Object.fromEntries(r.buckets.map(b => [b.label, b.amount]))
    expect(by['Not yet due']).toBe(1000)
    expect(by['1–30 days']).toBe(2000)
    expect(by['31–60 days']).toBe(3000)
    expect(by['Over 90 days']).toBe(4000)
    expect(r.overdue).toBe(9000)
    expect(r.total).toBe(10000)
  })

  it('KEEPS AN INVOICE WITH NO DUE DATE, rather than dropping it from the total', () => {
    // It is money owed either way, and a total that quietly omits the rows
    // with a missing field is wrong in the one direction nobody checks.
    const r = receivables([inv(null, 5000)], '2026-09-26', 900000)
    expect(r.total).toBe(5000)
    expect(r.buckets.find(b => b.label === 'Not yet due')!.amount).toBe(5000)
  })

  it('works DSO off revenue per day over the window', () => {
    // 90,000 owed against 900,000 over 90 days is 9,000 a day — ten days.
    expect(receivables([inv('2026-09-01', 90000)], '2026-09-26', 810000).dso).toBe(10)
  })

  it('LEAVES DSO NULL WHERE THERE IS NO REVENUE to divide by', () => {
    // Infinity is not a large DSO, it is an undefined one, and a huge number
    // where the denominator was zero is how a panel loses its reader.
    expect(receivables([inv('2026-09-01', 90000)], '2026-09-26', 0).dso).toBeNull()
  })

  it('leaves out a line that is already settled', () => {
    expect(receivables([inv('2026-09-01', 0)], '2026-09-26', 900000).total).toBe(0)
  })

  it('counts the invoices in each band as well as their value', () => {
    const r = receivables([inv('2026-08-01', 10), inv('2026-08-02', 20)], '2026-09-26', 1)
    expect(r.buckets.find(b => b.label === '31–60 days')!.count).toBe(2)
  })
})
