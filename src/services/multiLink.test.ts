import { allocateAcross } from './multiLink'

// One bill closed by several direct transactions (a bank's monthly fees): each
// transaction pays what it can, in order, until the bill is covered.

const bill = { amount: 1000, amount_rsd: 1000, amount_eur: 8.53, currency: 'RSD', exchange_rate: 1, eur_rate: 117.2 }

describe('allocating one bill across several transactions', () => {
  it('covers the bill with three fee transactions', () => {
    const r = allocateAcross(bill, [{ id: 't1', amount_rsd: 300 }, { id: 't2', amount_rsd: 450 }, { id: 't3', amount_rsd: 250 }])
    expect(r.links.map(l => [l.transactionId, l.allocatedAmount, l.allocatedAmountRsd])).toEqual([['t1', 300, 300], ['t2', 450, 450], ['t3', 250, 250]])
    expect(r.covered).toBe(1000)
    expect(r.left).toBe(0)
  })

  it('leaves the bill partly closed when the transactions come to less', () => {
    const r = allocateAcross(bill, [{ id: 't1', amount_rsd: 300 }, { id: 't2', amount_rsd: 450 }])
    expect(r.covered).toBe(750)
    expect(r.left).toBe(250)
  })

  it('never takes more than the bill: the last one pays only what is left', () => {
    const r = allocateAcross(bill, [{ id: 't1', amount_rsd: 800 }, { id: 't2', amount_rsd: 800 }, { id: 't3', amount_rsd: 50 }])
    expect(r.links.map(l => [l.transactionId, l.allocatedAmountRsd])).toEqual([['t1', 800], ['t2', 200]])
    expect(r.left).toBe(0)
  })

  it('in a foreign currency, in the bill\'s own figures at its rate, closing to the cent', () => {
    const eur = { amount: 100, amount_rsd: 11720, amount_eur: 100, currency: 'EUR', exchange_rate: 117.2, eur_rate: 117.2 }
    const r = allocateAcross(eur, [{ id: 't1', amount_rsd: 5860 }, { id: 't2', amount_rsd: 5860 }])
    expect(r.links.map(l => [l.allocatedAmount, l.allocatedAmountEur])).toEqual([[50, 50], [50, 50]])
    expect(r.left).toBe(0)
  })
})

describe('a transaction in the same currency as the bill', () => {
  it('pays in that currency, so a different booking rate leaves nothing open', () => {
    const eur = { amount: 100, amount_rsd: 11720, amount_eur: 100, currency: 'EUR', exchange_rate: 117.2, eur_rate: 117.2 }
    const r = allocateAcross(eur, [{ id: 't1', amount_rsd: 11710, amount: 100, currency: 'EUR' }])
    expect(r.links.map(l => [l.allocatedAmount, l.allocatedAmountRsd])).toEqual([[100, 11720]])
    expect(r.left).toBe(0)
  })

  it('names the transactions it did not need', () => {
    const r = allocateAcross({ amount: 1000, amount_rsd: 1000, amount_eur: 8.53, currency: 'RSD', exchange_rate: 1, eur_rate: 117.2 },
      [{ id: 't1', amount_rsd: 800 }, { id: 't2', amount_rsd: 800 }, { id: 't3', amount_rsd: 50 }])
    expect(r.unused).toEqual(['t3'])
  })
})

describe('a refund is never a payment', () => {
  const refund = { id: 'r1', type: 'direct', tx_subtype: 'expense', amount: -1199.22, amount_rsd: -1199.22, currency: 'RSD' }
  const pay = { id: 'p1', type: 'direct', tx_subtype: 'expense', amount: 1199.22, amount_rsd: 1199.22, currency: 'RSD' }
  const big = { amount: 1199.22, amount_rsd: 1199.22, amount_eur: 10.23, currency: 'RSD', exchange_rate: 1, eur_rate: 117.2 }

  it('pays nothing and is named among those not used', () => {
    const r = allocateAcross(big, [refund])
    expect(r.links).toEqual([])
    expect(r.unused).toEqual(['r1'])
    expect(r.left).toBe(1199.22)
  })

  it('pays nothing in a foreign currency either', () => {
    const r = allocateAcross({ ...big, currency: 'EUR', amount: 10.23 }, [{ ...refund, currency: 'RSD' }])
    expect(r.links).toEqual([])
    expect(r.unused).toEqual(['r1'])
  })

  it('beside a payment of the same size only the payment closes the bill', () => {
    const r = allocateAcross(big, [refund, pay])
    expect(r.links.map(l => l.transactionId)).toEqual(['p1'])
    expect(r.left).toBe(0)
    expect(r.unused).toEqual(['r1'])
  })

  it('leaves a negative row that is not a direct expense as it was', () => {
    const r = allocateAcross(big, [{ id: 'x1', type: 'direct', tx_subtype: 'revenue', amount: -1199.22, amount_rsd: -1199.22, currency: 'RSD' }])
    expect(r.links.map(l => l.transactionId)).toEqual(['x1'])
  })
})
