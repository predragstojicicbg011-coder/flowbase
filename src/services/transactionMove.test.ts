import {
  tableForType, isCrossTableMove, moveRefusal, planSave,
} from './transactionMove'

describe('tableForType', () => {
  it('puts pass-through in its own table', () => {
    expect(tableForType('passthrough')).toBe('passthrough')
  })
  it('puts every other type in transactions', () => {
    expect(tableForType('direct')).toBe('transactions')
    expect(tableForType('invoice_payment')).toBe('transactions')
    expect(tableForType('credit_payment')).toBe('transactions')
  })
})

describe('isCrossTableMove', () => {
  it('direct → pass-through crosses tables', () => {
    expect(isCrossTableMove({
      rowId: 'tx-1', sourceTable: 'transactions', currentType: 'direct', nextType: 'passthrough',
    })).toBe(true)
  })

  it('pass-through → direct crosses tables', () => {
    expect(isCrossTableMove({
      rowId: 'pt-1', sourceTable: 'passthrough', currentType: 'passthrough', nextType: 'direct',
    })).toBe(true)
  })

  it('direct → invoice payment stays in one table', () => {
    expect(isCrossTableMove({
      rowId: 'tx-1', sourceTable: 'transactions', currentType: 'direct', nextType: 'invoice_payment',
    })).toBe(false)
  })

  it('a brand-new row is never a move, whatever its type', () => {
    expect(isCrossTableMove({ nextType: 'passthrough' })).toBe(false)
    expect(isCrossTableMove({ rowId: null, sourceTable: null, nextType: 'direct' })).toBe(false)
  })
})

describe('moveRefusal', () => {
  it('lets an unencumbered transaction go', () => {
    expect(moveRefusal({
      rowId: 'tx-1', sourceTable: 'transactions', currentType: 'direct', nextType: 'passthrough',
      invoiceLinkCount: 0, settledInstallmentCount: 0,
    })).toBeNull()
  })

  it('refuses a row that pays an invoice, and says which invoice count', () => {
    const reason = moveRefusal({
      rowId: 'tx-1', sourceTable: 'transactions', currentType: 'invoice_payment', nextType: 'passthrough',
      invoiceLinkCount: 2,
    })
    expect(reason).toContain('2 invoices')
    expect(reason).toContain('Pass-through')
  })

  it('refuses a row that settled credit instalments', () => {
    const reason = moveRefusal({
      rowId: 'tx-1', sourceTable: 'transactions', currentType: 'direct', nextType: 'passthrough',
      settledInstallmentCount: 1,
    })
    expect(reason).toContain('1 credit instalment')
  })

  it('refuses a credit payment outright', () => {
    const reason = moveRefusal({
      rowId: 'tx-1', sourceTable: 'transactions', currentType: 'credit_payment', nextType: 'passthrough',
    })
    expect(reason).toContain('credit payment')
    expect(reason).toContain('Bank Credits')
  })

  it('counts missing from the context are treated as none, not as unknown', () => {
    expect(moveRefusal({
      rowId: 'tx-1', sourceTable: 'transactions', currentType: 'direct', nextType: 'passthrough',
    })).toBeNull()
  })
})

describe('planSave', () => {
  it('a brand-new row is an insert into the table its type belongs to', () => {
    expect(planSave({ nextType: 'direct' })).toEqual({ kind: 'insert', table: 'transactions' })
    expect(planSave({ nextType: 'passthrough' })).toEqual({ kind: 'insert', table: 'passthrough' })
    expect(planSave({ nextType: 'credit_payment' })).toEqual({ kind: 'insert', table: 'transactions' })
  })

  it('direct → pass-through is a move out of transactions', () => {
    expect(planSave({
      rowId: 'tx-1', sourceTable: 'transactions', currentType: 'direct', nextType: 'passthrough',
      invoiceLinkCount: 0, settledInstallmentCount: 0,
    })).toEqual({ kind: 'move', from: 'transactions', to: 'passthrough' })
  })

  it('pass-through → direct is a move out of passthrough', () => {
    expect(planSave({
      rowId: 'pt-1', sourceTable: 'passthrough', currentType: 'passthrough', nextType: 'direct',
    })).toEqual({ kind: 'move', from: 'passthrough', to: 'transactions' })
  })

  it('pass-through → invoice payment is also a move', () => {
    expect(planSave({
      rowId: 'pt-1', sourceTable: 'passthrough', currentType: 'passthrough', nextType: 'invoice_payment',
    })).toEqual({ kind: 'move', from: 'passthrough', to: 'transactions' })
  })

  it('direct → invoice payment is an update, not a move', () => {
    expect(planSave({
      rowId: 'tx-1', sourceTable: 'transactions', currentType: 'direct', nextType: 'invoice_payment',
    })).toEqual({ kind: 'update', table: 'transactions' })
  })

  it('a pass-through saved as a pass-through is an update of the pass-through table', () => {
    expect(planSave({
      rowId: 'pt-1', sourceTable: 'passthrough', currentType: 'passthrough', nextType: 'passthrough',
    })).toEqual({ kind: 'update', table: 'passthrough' })
  })

  it('a row with invoice links may not move', () => {
    const plan = planSave({
      rowId: 'tx-1', sourceTable: 'transactions', currentType: 'invoice_payment', nextType: 'passthrough',
      invoiceLinkCount: 1,
    })
    expect(plan.kind).toBe('refuse')
    if (plan.kind === 'refuse') expect(plan.reason).toContain('1 invoice')
  })

  it('a row with invoice links may still be updated inside its own table', () => {
    expect(planSave({
      rowId: 'tx-1', sourceTable: 'transactions', currentType: 'invoice_payment', nextType: 'direct',
      invoiceLinkCount: 1,
    })).toEqual({ kind: 'update', table: 'transactions' })
  })

  it('a row that settled instalments may not move', () => {
    const plan = planSave({
      rowId: 'tx-1', sourceTable: 'transactions', currentType: 'direct', nextType: 'passthrough',
      settledInstallmentCount: 3,
    })
    expect(plan.kind).toBe('refuse')
    if (plan.kind === 'refuse') expect(plan.reason).toContain('3 credit instalments')
  })

  it('a credit payment may not move', () => {
    const plan = planSave({
      rowId: 'tx-1', sourceTable: 'transactions', currentType: 'credit_payment', nextType: 'passthrough',
    })
    expect(plan.kind).toBe('refuse')
    if (plan.kind === 'refuse') expect(plan.reason).toContain('credit payment')
  })

  it('a credit payment may not be turned into a direct transaction either', () => {
    const plan = planSave({
      rowId: 'tx-1', sourceTable: 'transactions', currentType: 'credit_payment', nextType: 'direct',
    })
    expect(plan.kind).toBe('refuse')
  })

  it('a saved row may not be turned into a credit payment', () => {
    const plan = planSave({
      rowId: 'tx-1', sourceTable: 'transactions', currentType: 'direct', nextType: 'credit_payment',
    })
    expect(plan.kind).toBe('refuse')
    if (plan.kind === 'refuse') expect(plan.reason).toContain('new transaction')
  })

  it('a saved credit payment is not re-posted by saving it again', () => {
    const plan = planSave({
      rowId: 'tx-1', sourceTable: 'transactions', currentType: 'credit_payment', nextType: 'credit_payment',
    })
    expect(plan.kind).toBe('refuse')
  })

  it('never plans an update against a table the row is not in', () => {
    const cases: Array<[('transactions' | 'passthrough'), ('direct' | 'invoice_payment' | 'passthrough')]> = [
      ['transactions', 'direct'], ['transactions', 'invoice_payment'], ['transactions', 'passthrough'],
      ['passthrough', 'direct'], ['passthrough', 'invoice_payment'], ['passthrough', 'passthrough'],
    ]
    for (const [sourceTable, nextType] of cases) {
      const plan = planSave({ rowId: 'row-1', sourceTable, currentType: null, nextType })
      if (plan.kind === 'update') expect(plan.table).toBe(sourceTable)
      if (plan.kind === 'move') expect(plan.from).toBe(sourceTable)
    }
  })
})
