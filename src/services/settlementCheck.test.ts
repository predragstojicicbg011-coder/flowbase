import {
  describeMismatches, expectedStatus, mismatches,
  type Expectation,
} from './settlementCheck'

const exp = (over: Partial<Expectation> = {}): Expectation => ({
  invoiceId: 'i1', invoiceNumber: 'R23/59-2026', amount: 712112.44, allocated: 712112.44, ...over,
})

describe('expectedStatus', () => {
  it('is paid when the allocation covers the invoice', () => {
    expect(expectedStatus(1000, 1000)).toBe('paid')
  })

  it('is paid inside the para the view allows', () => {
    expect(expectedStatus(1000, 999.99)).toBe('paid')
  })

  it('is partial just outside it', () => {
    // It used to take 999.00 to read partial here, because the tolerance was
    // a tenth of a percent of the bill rather than a fixed para. That slack
    // grew with the invoice: 12,500 dinars on one of twelve and a half
    // million. See services/settleInvoice.ts.
    expect(expectedStatus(1000, 999.5)).toBe('partial')
    expect(expectedStatus(1000, 998)).toBe('partial')
  })

  it('is unpaid when nothing is allocated', () => {
    expect(expectedStatus(1000, 0)).toBe('unpaid')
    expect(expectedStatus(1000, -5)).toBe('unpaid')
  })

  it('calls an over-allocation paid rather than inventing a fourth answer', () => {
    // The view says paid too. Over-allocation is a different fault and is not
    // this check's business to rename.
    expect(expectedStatus(1000, 1500)).toBe('paid')
  })
})

describe('mismatches', () => {
  it('says nothing when the database agrees', () => {
    expect(mismatches([exp()], { i1: 'paid' })).toEqual([])
  })

  it('stays quiet when the dialog expected partial and got partial', () => {
    // The real case, had the figures been honest: 706,038.40 against
    // 712,112.44 IS partial, and the dialog should not cry about being right.
    expect(mismatches([exp({ allocated: 706038.40 })], { i1: 'partial' })).toEqual([])
  })

  it('reports an invoice promised as paid that came back partial', () => {
    // Which is exactly what a stale remainder produced: every write succeeded
    // and the invoice was still short.
    expect(mismatches([exp()], { i1: 'partial' })).toEqual([{
      invoiceId: 'i1', invoiceNumber: 'R23/59-2026', expected: 'paid', actual: 'partial',
    }])
  })

  it('reports an invoice the view has no row for', () => {
    expect(mismatches([exp()], {})[0].actual).toBe('missing')
  })

  it('checks every invoice, not just the first to fail', () => {
    const out = mismatches(
      [exp({ invoiceId: 'a' }), exp({ invoiceId: 'b' }), exp({ invoiceId: 'c' })],
      { a: 'partial', b: 'paid', c: 'unpaid' })
    expect(out.map(m => m.invoiceId)).toEqual(['a', 'c'])
  })

  it('has nothing to check when the payment closes nothing', () => {
    expect(mismatches([], { i1: 'partial' })).toEqual([])
  })
})

describe('describeMismatches', () => {
  it('says nothing at all when there is nothing wrong', () => {
    expect(describeMismatches([])).toBe('')
  })

  it('names the invoice, because opening it is the next thing to do', () => {
    const text = describeMismatches(mismatches([exp()], { i1: 'partial' }))
    expect(text).toContain('R23/59-2026')
    expect(text).toContain('expected to be paid and is partial')
    expect(text).toContain('Everything was written')
  })

  it('falls back to the id when the invoice has no number', () => {
    expect(describeMismatches(mismatches([exp({ invoiceNumber: null })], { i1: 'partial' })))
      .toContain('i1')
  })

  it('lists several rather than stopping at one', () => {
    const text = describeMismatches(mismatches(
      [exp({ invoiceId: 'a', invoiceNumber: 'A-1' }), exp({ invoiceId: 'b', invoiceNumber: 'B-2' })],
      { a: 'partial', b: 'unpaid' }))
    expect(text).toContain('A-1')
    expect(text).toContain('B-2')
  })
})
