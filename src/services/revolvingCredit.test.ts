import {
  rateOn, monthlyInterest, addMonths, dueDateIn,
  revolvingSchedule, outstandingOf, defaultMaturity,
  type RateReset,
} from './revolvingCredit'

// The four tranches this was written for: 3M EURIBOR + 2.95%, all maturing
// 2027-10-26.
const MARGIN = 2.95
const RESETS: RateReset[] = [
  { effective_from: '2026-07-01', reference_rate: 2.10 },
  { effective_from: '2026-10-01', reference_rate: 2.40 },
]

describe('the rate in force', () => {
  it('is the margin plus the benchmark, not the margin', () => {
    expect(rateOn(MARGIN, RESETS, '2026-08-15')).toBe(5.05)
  })

  it('takes the latest reset on or before the date, not the latest of all', () => {
    expect(rateOn(MARGIN, RESETS, '2026-09-30')).toBe(5.05)
    expect(rateOn(MARGIN, RESETS, '2026-10-01')).toBe(5.35)
  })

  /**
   * The whole reason the benchmark is a series. Applied backwards, a reset
   * reprices interest that was already paid at a rate nobody charged.
   */
  it('does not price a month that predates every reset', () => {
    expect(rateOn(MARGIN, RESETS, '2026-01-15')).toBeNull()
  })

  /**
   * `EURIBOR + 2.95%` with no EURIBOR on file is unpriced. Returning the
   * margin would understate every month by the whole benchmark and look
   * exactly like a real rate.
   */
  it('refuses to treat the margin on its own as a rate', () => {
    expect(rateOn(MARGIN, [], '2026-10-01')).toBeNull()
  })

  it('has nothing to say about a line with no margin', () => {
    expect(rateOn(null, RESETS, '2026-10-01')).toBeNull()
    expect(rateOn(undefined, RESETS, '2026-10-01')).toBeNull()
  })

  it('ignores a reset with no usable number in it', () => {
    expect(rateOn(MARGIN, [{ effective_from: '2026-08-01', reference_rate: NaN }], '2026-09-01'))
      .toBeNull()
  })
})

describe('monthly interest', () => {
  it('is a twelfth of the annual rate on the whole principal', () => {
    // 10,000 at 5.05% = 505 a year = 42.08 a month.
    expect(monthlyInterest(10000, 5.05)).toBe(42.08)
  })

  it('reads the rate as a percentage, not a fraction', () => {
    expect(monthlyInterest(12000, 6)).toBe(60)
  })

  it('is nothing on a line that has not been drawn', () => {
    expect(monthlyInterest(0, 5.05)).toBe(0)
  })
})

describe('month arithmetic', () => {
  it('crosses a year boundary', () => {
    expect(addMonths('2026-11', 3)).toBe('2027-02')
    expect(addMonths('2027-01', -2)).toBe('2026-11')
  })

  /**
   * A line billed on the 30th must be billed on the 28th of February, not on
   * the 2nd of March — a date that rolled into the next month would put the
   * payment in the wrong period on every page that reads it.
   */
  it('keeps a billing day inside its own month', () => {
    expect(dueDateIn('2027-02', 30)).toBe('2027-02-28')
    expect(dueDateIn('2028-02', 30)).toBe('2028-02-29')
    expect(dueDateIn('2026-11', 26)).toBe('2026-11-26')
  })
})

describe('the schedule', () => {
  const base = {
    principal: 10000,
    margin: MARGIN,
    resets: RESETS,
    fromMonth: '2026-09',
    maturity: '2027-10-26',
    billingDay: 26,
  }

  it('bills interest every month and the principal once', () => {
    const rows = revolvingSchedule(base)
    expect(rows.filter(r => r.principal_amount > 0)).toHaveLength(1)
    expect(rows[rows.length - 1].due_date).toBe('2027-10-26')
    expect(rows[rows.length - 1].principal_amount).toBe(10000)
  })

  it('runs from the month asked for to the month of maturity, inclusive', () => {
    const rows = revolvingSchedule(base)
    expect(rows[0].due_date).toBe('2026-09-26')
    // Sep 2026 to Oct 2027 is fourteen months.
    expect(rows).toHaveLength(14)
  })

  /**
   * The first three tranches were drawn in 2025 and their interest is already
   * in the ledger as transactions. Regenerating those months would put the
   * same obligation on the books twice.
   */
  it('does not reach back before the month it was asked for', () => {
    expect(revolvingSchedule(base).some(r => r.due_date < '2026-09-01')).toBe(false)
  })

  it('prices each month at the rate in force in it', () => {
    const rows = revolvingSchedule(base)
    // September 2026 is still on the 2.10 reset: 2.95 + 2.10 = 5.05.
    expect(rows[0].interest_amount).toBe(42.08)
    // October 2026 onwards is 2.40: 2.95 + 2.40 = 5.35 → 44.58.
    expect(rows[1].interest_amount).toBe(44.58)
  })

  it('puts the final interest on the same payment as the principal', () => {
    const last = revolvingSchedule(base).slice(-1)[0]
    expect(last.interest_amount).toBe(44.58)
    expect(last.total_amount).toBe(10044.58)
  })

  it('numbers the rows in order, from where it was told to start', () => {
    const rows = revolvingSchedule({ ...base, startNo: 7 })
    expect(rows[0].installment_no).toBe(7)
    expect(rows[1].installment_no).toBe(8)
  })

  /** Unpriced means unpriced. A schedule half of which is guessed is not one. */
  it('produces nothing at all when the line has no benchmark', () => {
    expect(revolvingSchedule({ ...base, resets: [] })).toEqual([])
    expect(revolvingSchedule({ ...base, margin: null })).toEqual([])
  })

  it('produces nothing for a line already past its maturity', () => {
    expect(revolvingSchedule({ ...base, fromMonth: '2027-11' })).toEqual([])
  })

  it('bills a line maturing this month once, with everything on it', () => {
    const rows = revolvingSchedule({ ...base, fromMonth: '2027-10' })
    expect(rows).toHaveLength(1)
    expect(rows[0].total_amount).toBe(10044.58)
  })

  it('falls back to the maturity day when no billing day is given', () => {
    const rows = revolvingSchedule({ ...base, billingDay: undefined })
    expect(rows[0].due_date).toBe('2026-09-26')
  })
})

describe('what is still owed', () => {
  const base = {
    principal: 20000,
    margin: MARGIN,
    resets: RESETS,
    fromMonth: '2026-10',
    maturity: '2027-10-26',
    billingDay: 17,
  }

  it('adds the principal to the interest still to come', () => {
    const owed = outstandingOf(base)
    expect(owed.principal).toBe(20000)
    // Thirteen months at 5.35% on 20,000 = 89.17 each.
    expect(owed.interest).toBe(1159.21)
    expect(owed.total).toBe(21159.21)
  })

  /**
   * The principal is certain and the interest is not. Averaging the unknown
   * away into one number would make a 50.000 EUR obligation read as if its cost
   * were known.
   */
  it('still states the principal when the line is unpriced', () => {
    const owed = outstandingOf({ ...base, resets: [] })
    expect(owed.principal).toBe(20000)
    expect(owed.interest).toBeNull()
    expect(owed.total).toBeNull()
  })
})

describe('the maturity a new line gets', () => {
  it('is a year from the draw', () => {
    expect(defaultMaturity('2026-09-17')).toBe('2027-09-17')
  })

  it('does not fall off the end of February', () => {
    expect(defaultMaturity('2028-02-29')).toBe('2029-02-28')
  })

  it('says nothing when there is no draw date yet', () => {
    expect(defaultMaturity('')).toBe('')
  })
})
