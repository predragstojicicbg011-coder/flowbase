import { describeChanges, isNoChange, planLinkChanges, type Allocation } from './linkPlan'

const at = (invoiceId: string, allocated = 100): Allocation => ({ invoiceId, allocated })

describe('planLinkChanges', () => {
  it('writes a link the payment did not have', () => {
    const plan = planLinkChanges([], [at('a')])
    expect(plan.toWrite).toEqual([at('a')])
    expect(plan.toRemove).toEqual([])
  })

  it('deletes a link the payment no longer has', () => {
    const plan = planLinkChanges(['a'], [])
    expect(plan.toRemove).toEqual(['a'])
    expect(plan.toWrite).toEqual([])
  })

  it('swaps one invoice for another, which is the whole point', () => {
    const plan = planLinkChanges(['a'], [at('b')])
    expect(plan.toRemove).toEqual(['a'])
    expect(plan.toWrite).toEqual([at('b')])
  })

  it('refreshes BOTH sides of a swap', () => {
    // The invoice losing the payment goes back to unpaid and nothing on screen
    // mentions it when the dialog closes. It is exactly the write that gets
    // forgotten, which is why the plan carries it.
    expect(planLinkChanges(['a'], [at('b')]).toRefresh).toEqual(['a', 'b'])
  })

  it('rewrites a link whose amount changed, without removing it', () => {
    const plan = planLinkChanges(['a'], [at('a', 250)])
    expect(plan.toRemove).toEqual([])
    expect(plan.toWrite).toEqual([{ invoiceId: 'a', allocated: 250 }])
    expect(plan.toRefresh).toEqual(['a'])
  })

  it('treats an allocation of nothing as a detach', () => {
    // A row claiming a payment settles an invoice by zero is not a thing that
    // happened, and the invoice reads unpaid either way.
    const plan = planLinkChanges(['a'], [at('a', 0)])
    expect(plan.toRemove).toEqual(['a'])
    expect(plan.toWrite).toEqual([])
  })

  it('treats a negative allocation the same way rather than writing it', () => {
    expect(planLinkChanges(['a'], [at('a', -50)]).toRemove).toEqual(['a'])
  })

  it('keeps several invoices on one payment', () => {
    const plan = planLinkChanges(['a', 'b'], [at('a', 60), at('b', 40)])
    expect(plan.toRemove).toEqual([])
    expect(plan.toWrite).toHaveLength(2)
    expect(plan.toRefresh).toEqual(['a', 'b'])
  })

  it('removes one of several and leaves the rest alone', () => {
    const plan = planLinkChanges(['a', 'b', 'c'], [at('a'), at('c')])
    expect(plan.toRemove).toEqual(['b'])
    expect(plan.toWrite.map(w => w.invoiceId)).toEqual(['a', 'c'])
    expect(plan.toRefresh).toEqual(['a', 'b', 'c'])
  })

  it('lists what was there before what was added', () => {
    expect(planLinkChanges(['a'], [at('z'), at('a')]).toRefresh).toEqual(['a', 'z'])
  })

  it('never names an invoice twice in the refresh list', () => {
    const plan = planLinkChanges(['a', 'a'], [at('a'), at('a')])
    expect(plan.toRefresh).toEqual(['a'])
    expect(plan.toWrite).toHaveLength(1)
  })

  it('ignores an empty id rather than writing a link to nothing', () => {
    const plan = planLinkChanges([''], [at(''), at('a')])
    expect(plan.toWrite).toEqual([at('a')])
    expect(plan.toRemove).toEqual([])
    expect(plan.toRefresh).toEqual(['a'])
  })

  it('has nothing to do for a payment that closes nothing and never did', () => {
    expect(planLinkChanges([], [])).toEqual({ toRemove: [], toWrite: [], toRefresh: [] })
  })
})

describe('isNoChange', () => {
  it('is true when the same invoices are linked as before', () => {
    const before = ['a', 'b']
    expect(isNoChange(planLinkChanges(before, [at('a'), at('b')]), before)).toBe(true)
  })

  it('is false when one was added', () => {
    const before = ['a']
    expect(isNoChange(planLinkChanges(before, [at('a'), at('b')]), before)).toBe(false)
  })

  it('is false when one was removed', () => {
    const before = ['a', 'b']
    expect(isNoChange(planLinkChanges(before, [at('a')]), before)).toBe(false)
  })

  it('is true even when only an amount moved, because the set is the same', () => {
    // The amount still gets written — `toWrite` carries every link — this only
    // says no invoice changed hands.
    const before = ['a']
    expect(isNoChange(planLinkChanges(before, [at('a', 999)]), before)).toBe(true)
  })
})

describe('describeChanges', () => {
  it('says what was closed and what was released', () => {
    expect(describeChanges(planLinkChanges(['a'], [at('b')])))
      .toBe('1 invoice closed, 1 released back to unpaid.')
  })

  it('pluralises the closed count', () => {
    expect(describeChanges(planLinkChanges([], [at('a'), at('b')])))
      .toBe('2 invoices closed.')
  })

  it('mentions the release even when nothing replaced it', () => {
    expect(describeChanges(planLinkChanges(['a'], [])))
      .toBe('1 released back to unpaid.')
  })

  it('says so plainly when a payment closes nothing', () => {
    expect(describeChanges(planLinkChanges([], [])))
      .toBe('No invoices are linked to this payment.')
  })
})
