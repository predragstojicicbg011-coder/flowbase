import {
  summarise, benchmarkFrom, whyNotPriceable, type RevolvingCredit,
} from './RevolvingCredits'
import type { RateReset } from '../services/revolvingCredit'

jest.mock('../supabase', () => ({ supabase: {} }))

// ─── What the headline is allowed to claim ──────────────────────────────────
//
// The totals at the top of the Credits page add the annuity instalments to
// these tranches. The one thing that must not happen is an unpriced line being
// added in as if its interest were zero: €50,000 of revolving credit showing a
// cost of nothing reads as a cheap facility, and it is simply not known yet.

const far = () => `${new Date().getFullYear() + 3}-10-26`

const tranche = (over: Partial<RevolvingCredit> & { id: string; principal_amount: number }): RevolvingCredit => ({
  name: 'Unicredit revolving', bank: 'Unicredit Banka', currency: 'EUR',
  disbursement_date: '2025-10-30', maturity_date: far(),
  rate_margin: 2.95, reference_rate_name: '3M EURIBOR',
  rate_description: '3M EURIBOR + 2.95%', status: 'active', notes: null,
  ...over,
})

const priced: RateReset[] = [{ effective_from: '2020-01-01', reference_rate: 2.40 }]

describe('summarise', () => {
  it('adds the principals of every tranche', () => {
    const out = summarise(
      [tranche({ id: 'a', principal_amount: 10000 }), tranche({ id: 'b', principal_amount: 20000 })],
      { a: priced, b: priced })
    expect(out.principal).toBe(30000)
    expect(out.unpriced).toBe(0)
  })

  it('adds the interest still to run when every line is priced', () => {
    const out = summarise([tranche({ id: 'a', principal_amount: 10000 })], { a: priced })
    expect(out.interest).not.toBeNull()
    expect(out.interest!).toBeGreaterThan(0)
  })

  /**
   * The point of the whole file. One unpriced line makes the interest total
   * unknown — adding up the priced ones and calling that the total would
   * understate the obligation by whatever the unpriced line costs, which is
   * the direction that flatters.
   */
  it('reports the interest as unknown when any line has no benchmark', () => {
    const out = summarise(
      [tranche({ id: 'a', principal_amount: 10000 }), tranche({ id: 'b', principal_amount: 20000 })],
      { a: priced })
    expect(out.interest).toBeNull()
    expect(out.unpriced).toBe(1)
  })

  it('still counts the principal of an unpriced line — that part is certain', () => {
    const out = summarise([tranche({ id: 'a', principal_amount: 10000 })], {})
    expect(out.principal).toBe(10000)
    expect(out.interest).toBeNull()
  })

  it('has nothing to add when there are no tranches', () => {
    expect(summarise([], {})).toEqual({ principal: 0, interest: 0, unpriced: 0 })
  })

  /** A line with no maturity cannot be scheduled, but it is still owed. */
  it('counts a tranche whose maturity has not been set', () => {
    const out = summarise([tranche({ id: 'a', principal_amount: 10000, maturity_date: null })], { a: priced })
    expect(out.principal).toBe(10000)
    expect(out.interest).toBeNull()
  })
})

// ─── Pricing a line from whichever figure the bank quoted ───────────────────
//
// The agreement says "3M EURIBOR + 2.95%". The statement says "5.35%". Both
// describe the same month. Only the first could be entered before, so reading
// a statement meant subtracting the margin by hand — arithmetic done in the
// one place nothing checks it.

describe('the benchmark that gets stored', () => {
  it('is what was typed, when the benchmark was typed', () => {
    expect(benchmarkFrom(2.4, 'benchmark', 2.95)).toBe(2.4)
  })

  /** The whole reason for the second option: the subtraction happens here. */
  it('is the all-in rate less the margin, when the all-in rate was typed', () => {
    expect(benchmarkFrom(5.35, 'allin', 2.95)).toBe(2.4)
  })

  /**
   * Floating point would otherwise store 2.4000000000000004, which is not
   * wrong by any amount that matters but is wrong on the screen for ever.
   */
  it('does not leave a floating-point tail behind', () => {
    expect(benchmarkFrom(5.35, 'allin', 2.95)).toBe(2.4)
    expect(String(benchmarkFrom(5.35, 'allin', 2.95))).toBe('2.4')
  })

  /**
   * EURIBOR was below zero for years. An all-in rate under the margin is how
   * that arrives here, and refusing it would make those months unrecordable.
   */
  it('allows a negative benchmark', () => {
    expect(benchmarkFrom(2.45, 'allin', 2.95)).toBe(-0.5)
  })

  /** Without a margin the split is a guess, and a guess written into the rate
   *  history prices every month after it. */
  it('is unknown when an all-in rate meets a line with no margin', () => {
    expect(benchmarkFrom(5.35, 'allin', null)).toBeNull()
  })

  it('is unknown when nothing was typed', () => {
    expect(benchmarkFrom(NaN, 'benchmark', 2.95)).toBeNull()
  })
})

describe('what stops a reset being recorded', () => {
  it('nothing, when the figures are there', () => {
    expect(whyNotPriceable(2.4, 'benchmark', 2.95, '2026-10-01')).toBeNull()
  })

  it('names the figure it is actually asking for', () => {
    expect(whyNotPriceable(NaN, 'benchmark', 2.95, '2026-10-01')).toMatch(/benchmark rate/)
    expect(whyNotPriceable(NaN, 'allin', 2.95, '2026-10-01')).toMatch(/all-in rate/)
  })

  /** And says what to do about it, rather than only that it cannot. */
  it('sends you to the margin when an all-in rate cannot be split', () => {
    expect(whyNotPriceable(5.35, 'allin', null, '2026-10-01')).toMatch(/Edit credit/)
  })

  /** A reset with no start date prices nothing. */
  it('insists on a date', () => {
    expect(whyNotPriceable(2.4, 'benchmark', 2.95, '')).toMatch(/starts applying/)
  })
})
