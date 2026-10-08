import {
  addMonths, monthsBetween, monthlyDue, balanceSeries, debtFigures, byCredit,
  earliestDue, overdueCount,
} from './debtSchedule'

const ann = (due_date: string, principal_amount: number, interest_amount: number) =>
  ({ due_date, principal_amount, interest_amount })

describe('month arithmetic', () => {
  it('crosses a year boundary in both directions', () => {
    expect(addMonths('2026-11', 3)).toBe('2027-02')
    expect(addMonths('2027-02', -3)).toBe('2026-11')
  })

  it('counts whole months between two of them', () => {
    expect(monthsBetween('2026-10', '2027-10')).toBe(12)
    expect(monthsBetween('2027-10', '2026-10')).toBe(-12)
    expect(monthsBetween('2026-10', '2026-10')).toBe(0)
  })
})

describe('what falls due each month', () => {
  const base = {
    annuity: [
      ann('2026-10-15', 1000, 120),
      ann('2026-11-15', 1010, 110),
      ann('2027-01-15', 1030, 90),
    ],
    revolving: [
      ann('2026-10-26', 0, 44.58),
      ann('2026-11-26', 0, 44.58),
      ann('2026-12-26', 0, 44.58),
      ann('2027-01-26', 10000, 44.58),
    ],
    from: '2026-10',
    months: 4,
  }

  it('keeps the two kinds apart and also adds them up', () => {
    const [oct] = monthlyDue(base)
    expect(oct.annuityPrincipal).toBe(1000)
    expect(oct.revolvingInterest).toBe(44.58)
    expect(oct.principal).toBe(1000)
    expect(oct.interest).toBe(164.58)
    expect(oct.total).toBe(1164.58)
  })

  /**
   * A chart built from only the months that carry a payment draws a smooth
   * line across a gap and says the debt was being serviced throughout it.
   */
  it('gives every month in the range a row, including the empty ones', () => {
    const rows = monthlyDue(base)
    expect(rows.map(r => r.month)).toEqual(['2026-10', '2026-11', '2026-12', '2027-01'])
    const dec = rows[2]
    expect(dec.annuityPrincipal).toBe(0)
    expect(dec.revolvingInterest).toBe(44.58)
  })

  it('shows the whole revolving principal landing in one month', () => {
    const jan = monthlyDue(base)[3]
    expect(jan.revolvingPrincipal).toBe(10000)
    expect(jan.total).toBe(11164.58)
  })

  /** An overdue instalment is still owed. Dropped, it understates exactly
   *  the figure somebody opened the page to check. */
  it('folds anything already overdue into the first month', () => {
    const rows = monthlyDue({ ...base, annuity: [ann('2026-05-15', 900, 80), ...base.annuity] })
    expect(rows[0].annuityPrincipal).toBe(1900)
    expect(rows[0].annuityInterest).toBe(200)
  })

  it('leaves out what falls beyond the horizon asked for', () => {
    const rows = monthlyDue({ ...base, months: 2 })
    expect(rows).toHaveLength(2)
    expect(rows.reduce((s, r) => s + r.revolvingPrincipal, 0)).toBe(0)
  })

  it('reads a credit note as an obligation, not as a negative one', () => {
    const rows = monthlyDue({ ...base, annuity: [ann('2026-10-15', -500, -20)], revolving: [] })
    expect(rows[0].annuityPrincipal).toBe(500)
    expect(rows[0].annuityInterest).toBe(20)
  })

  it('has no rows when no horizon was asked for', () => {
    expect(monthlyDue({ ...base, months: 0 })).toEqual([])
  })

  it('ignores an instalment with no date rather than bucketing it somewhere', () => {
    const rows = monthlyDue({ ...base, annuity: [ann('', 999, 9)], revolving: [] })
    expect(rows.reduce((s, r) => s + r.total, 0)).toBe(0)
  })
})

describe('the balance', () => {
  const due = monthlyDue({
    annuity: [ann('2026-10-15', 1000, 120), ann('2026-11-15', 1000, 110)],
    revolving: [ann('2026-11-26', 10000, 44.58)],
    from: '2026-10',
    months: 3,
  })

  it('falls only by the principal repaid, never by the interest', () => {
    const b = balanceSeries(due, { annuity: 5000, revolving: 10000 })
    expect(b[0].annuity).toBe(4000)
    expect(b[0].revolving).toBe(10000)
    expect(b[0].total).toBe(14000)
  })

  /** The shape worth drawing: flat, then a cliff on one day. */
  it('shows a revolving line dropping to nothing in one month', () => {
    const b = balanceSeries(due, { annuity: 5000, revolving: 10000 })
    expect(b[1].revolving).toBe(0)
    expect(b[1].annuity).toBe(3000)
  })

  it('holds the last balance through a month with nothing due', () => {
    const b = balanceSeries(due, { annuity: 5000, revolving: 10000 })
    expect(b[2].total).toBe(b[1].total)
  })

  /**
   * Repaying more principal than was opened with is a data error. Drawn as a
   * negative balance it turns a fault into a picture of the company lending
   * money to its bank.
   */
  it('does not go below zero when the schedule overshoots', () => {
    const b = balanceSeries(due, { annuity: 500, revolving: 10000 })
    expect(b[1].annuity).toBe(0)
  })
})

describe('the figures above the charts', () => {
  const due = monthlyDue({
    annuity: [ann('2026-10-15', 1000, 120), ann('2026-11-15', 1000, 110)],
    revolving: [ann('2026-12-26', 10000, 44.58)],
    from: '2026-10',
    months: 14,
  })
  const balance = balanceSeries(due, { annuity: 2000, revolving: 10000 })
  const f = debtFigures(due, balance)

  it('separates what is repaid from what it costs to carry', () => {
    expect(f.principal).toBe(12000)
    expect(f.interest).toBe(274.58)
    expect(f.total).toBe(12274.58)
  })

  /**
   * The month a revolving maturity lands in is the month the money has to be
   * there, and a run of averages hides it completely.
   */
  it('names the single heaviest month', () => {
    expect(f.peak).toEqual({ month: '2026-12', amount: 10044.58 })
  })

  it('adds up only the first twelve months for the near-term figure', () => {
    expect(f.next12).toBe(12274.58)
  })

  it('says how many months until the debt is clear', () => {
    expect(f.clearsIn).toBe(3)
  })

  it('leaves it null when the debt does not clear inside the window', () => {
    const long = monthlyDue({ annuity: [ann('2026-10-15', 100, 10)], revolving: [], from: '2026-10', months: 3 })
    expect(debtFigures(long, balanceSeries(long, { annuity: 99999, revolving: 0 })).clearsIn).toBeNull()
  })

  it('has nothing to say about an empty schedule', () => {
    const none = debtFigures([], [])
    expect(none.peak).toBeNull()
    expect(none.total).toBe(0)
    expect(none.openingBalance).toBe(0)
  })
})

describe('where the debt sits', () => {
  it('ranks the credits by what is still owed on them', () => {
    const out = byCredit([
      { creditId: 'a', name: 'Intesa 100k', kind: 'annuity', principal: 40000, interest: 3000 },
      { creditId: 'b', name: 'Unicredit revolving', kind: 'revolving', principal: 20000, interest: 1159 },
      { creditId: 'c', name: 'OTP 60k', kind: 'annuity', principal: 50000, interest: 2000 },
    ])
    expect(out.map(r => r.name)).toEqual(['OTP 60k', 'Intesa 100k', 'Unicredit revolving'])
    expect(out[0].total).toBe(52000)
  })

  /** An unpriced line still has a principal, and it still has to be ranked. */
  it('ranks a line whose interest is not known yet on its principal', () => {
    const out = byCredit([
      { creditId: 'a', name: 'Small', kind: 'annuity', principal: 1000, interest: 50 },
      { creditId: 'b', name: 'Unpriced', kind: 'revolving', principal: 20000, interest: null },
    ])
    expect(out[0].name).toBe('Unpriced')
    expect(out[0].total).toBe(20000)
    expect(out[0].interest).toBeNull()
  })
})

describe('the next instalment', () => {
  const rows = [
    { due_date: '2027-03-10' },
    { due_date: '2026-11-15' },
    { due_date: '2026-09-01' },
    { due_date: '2026-12-26' },
  ]

  /** The regression this exists for: an unordered list must still give the
   *  nearest date, not the first one that happens to be in the future. */
  it('is the earliest still to come, whatever order the rows are in', () => {
    expect(earliestDue(rows, '2026-10-01')).toBe('2026-11-15')
  })

  it('counts today itself as still to come', () => {
    expect(earliestDue(rows, '2026-11-15')).toBe('2026-11-15')
  })

  it('is empty when everything is already past', () => {
    expect(earliestDue(rows, '2028-01-01')).toBe('')
    expect(earliestDue([], '2026-10-01')).toBe('')
  })

  it('skips a row with no date rather than sorting it to the front', () => {
    expect(earliestDue([{ due_date: '' }, ...rows], '2026-10-01')).toBe('2026-11-15')
  })

  it('counts what is already overdue', () => {
    expect(overdueCount(rows, '2026-12-01')).toBe(2)
    expect(overdueCount(rows, '2026-01-01')).toBe(0)
  })
})
