import {
  txToSeed, passthroughToSeed, allowedTypes, isRowEditable,
  statementSpan, statementLabel, invoiceStatus, rowAmount,
  editedStatementName, editedStatementNote,
} from './statementEdit'

const expenseTx = {
  id: 'tx-1',
  transaction_date: '2026-06-15',
  partner_id: 'p-1',
  note: 'Telekom monthly',
  amount: 12500,
  currency: 'RSD',
  reference_number: '97-123',
  model: '97',
  account_number: '160-123-11',
  type: 'direct',
  tx_subtype: 'expense',
  pl_category: 'Operating Expenses',
  pl_subcategory: 'Telecom',
  department: 'Administration',
  dept_subcategory: 'Office',
  expense_description: 'Telekom',
  revenue_stream: null,
  project_id: null,
  cf_type: 'recurring',
  cf_frequency: 'monthly',
  cf_next_month_est: 12500,
}

describe('txToSeed', () => {
  it('puts an expense in the debit column and leaves credit empty', () => {
    const seed = txToSeed(expenseTx, 'Telekom Srbija')
    expect(seed.debit).toBe('12500')
    expect(seed.credit).toBe('')
    expect(seed.tx_subtype).toBe('expense')
  })

  it('puts revenue in the credit column instead', () => {
    const seed = txToSeed({ ...expenseTx, tx_subtype: 'revenue', revenue_stream: 'Građevinske situacije' })
    expect(seed.credit).toBe('12500')
    expect(seed.debit).toBe('')
    expect(seed.revenue_stream).toBe('Građevinske situacije')
  })

  it('carries every classification field back onto the row', () => {
    const seed = txToSeed(expenseTx)
    expect(seed.pl_category_name).toBe('Operating Expenses')
    expect(seed.pl_subcategory_name).toBe('Telecom')
    expect(seed.department_name).toBe('Administration')
    expect(seed.dept_subcategory_name).toBe('Office')
    expect(seed.expense_description).toBe('Telekom')
    expect(seed.cf_type).toBe('recurring')
    expect(seed.cf_next_month_est).toBe('12500')
  })

  it('turns nulls into empty strings, because they bind to inputs', () => {
    const seed = txToSeed({ ...expenseTx, reference_number: null, model: null, account_number: null })
    expect(seed.reference_number).toBe('')
    expect(seed.model).toBe('')
    expect(seed.account_number).toBe('')
  })

  it('falls back to a usable default where a stored value is missing', () => {
    const seed = txToSeed({ ...expenseTx, currency: null, cf_frequency: null })
    expect(seed.currency).toBe('RSD')
    expect(seed.cf_frequency).toBe('monthly')
  })

  it('carries the row’s project back onto the grid', () => {
    expect(txToSeed({ ...expenseTx, project_id: 'site-1' }).project_id).toBe('site-1')
  })

  /** Null is company overhead; the grid holds it as the empty choice. */
  it('reads a row on no project as overhead, the empty choice', () => {
    expect(txToSeed(expenseTx).project_id).toBe('')
    expect(txToSeed({ ...expenseTx, project_id: undefined as any }).project_id).toBe('')
  })

  it('carries no allocation fields any more', () => {
    const seed: any = txToSeed(expenseTx)
    for (const k of ['rev_alloc', 'aimfox_val', 'sg_val', 'opex_type', 'opex_val', 'performance_val']) {
      expect(seed).not.toHaveProperty(k)
    }
  })

  it('keeps the partner name it is given, since the row stores only an id', () => {
    expect(txToSeed(expenseTx, 'Telekom Srbija').partner_name).toBe('Telekom Srbija')
    expect(txToSeed(expenseTx).partner_name).toBe('')
  })

  it('locks a credit payment and nothing else', () => {
    expect(txToSeed({ ...expenseTx, type: 'credit_payment' }).locked).toBe(true)
    expect(txToSeed(expenseTx).locked).toBe(false)
    expect(txToSeed({ ...expenseTx, type: 'invoice_payment' }).locked).toBe(false)
  })

  it('records which table the row came from', () => {
    expect(txToSeed(expenseTx).source).toBe('transactions')
  })

  it('does not treat a zero amount as absent', () => {
    expect(txToSeed({ ...expenseTx, amount: 0 }).debit).toBe('0')
  })
})

describe('passthroughToSeed', () => {
  const pt = {
    id: 'pt-1',
    transaction_date: '2026-06-20',
    partner_id: null,
    direction: 'in',
    period_month: '2026-05',
    currency: 'EUR',
    amount: 900,
    note: 'Client funds',
    account_number: null,
    model: null,
    reference_number: null,
  }

  it('reads an incoming pass-through as money in', () => {
    const seed = passthroughToSeed(pt)
    expect(seed.credit).toBe('900')
    expect(seed.debit).toBe('')
    expect(seed.pt_direction).toBe('in')
  })

  it('reads an outgoing pass-through as money out', () => {
    const seed = passthroughToSeed({ ...pt, direction: 'out' })
    expect(seed.debit).toBe('900')
    expect(seed.credit).toBe('')
    expect(seed.pt_direction).toBe('out')
  })

  /** A pass-through never reaches the P&L, so it belongs to no project. */
  it('puts a pass-through on no project', () => {
    expect(passthroughToSeed(pt).project_id).toBe('')
  })

  it('keeps the period the row was filed under, not the date it was paid', () => {
    expect(passthroughToSeed(pt).pt_period).toBe('2026-05')
  })

  it('falls back to the transaction month when no period was filed', () => {
    expect(passthroughToSeed({ ...pt, period_month: null }).pt_period).toBe('2026-06')
  })

  it('leaves the P&L fields empty — a pass-through has no P&L side', () => {
    const seed = passthroughToSeed(pt)
    expect(seed.pl_category_name).toBe('')
    expect(seed.department_name).toBe('')
    expect(seed.expense_description).toBe('')
  })

  it('is never locked, and knows its own table', () => {
    const seed = passthroughToSeed(pt)
    expect(seed.locked).toBe(false)
    expect(seed.source).toBe('passthrough')
  })
})

describe('allowedTypes', () => {
  it('lets a brand new row be anything except a credit payment', () => {
    expect(allowedTypes({})).toEqual(['direct', 'invoice_payment', 'passthrough'])
  })

  it('will not let a saved row cross between the two tables', () => {
    expect(allowedTypes({ tx_id: 'tx-1', source: 'transactions' })).toEqual(['direct', 'invoice_payment'])
    expect(allowedTypes({ tx_id: 'pt-1', source: 'passthrough' })).toEqual(['passthrough'])
  })

  it('offers a locked row nothing to change to', () => {
    expect(allowedTypes({ tx_id: 'tx-1', source: 'transactions', locked: true })).toEqual(['credit_payment'])
  })
})

describe('isRowEditable', () => {
  it('is true unless the row is locked', () => {
    expect(isRowEditable({})).toBe(true)
    expect(isRowEditable({ locked: false })).toBe(true)
    expect(isRowEditable({ locked: true })).toBe(false)
  })
})

describe('statementSpan', () => {
  it('spans from the earliest date to the latest, whatever order they are in', () => {
    expect(statementSpan([{ date: '2026-06-20' }, { date: '2026-06-02' }, { date: '2026-06-11' }]))
      .toEqual({ date_from: '2026-06-02', date_to: '2026-06-20', row_count: 3 })
  })

  it('handles a single row', () => {
    expect(statementSpan([{ date: '2026-06-02' }]))
      .toEqual({ date_from: '2026-06-02', date_to: '2026-06-02', row_count: 1 })
  })

  it('reports no span when nothing is dated', () => {
    expect(statementSpan([{ date: '' }, {}]))
      .toEqual({ date_from: null, date_to: null, row_count: 2 })
  })

  it('counts an empty statement as empty', () => {
    expect(statementSpan([])).toEqual({ date_from: null, date_to: null, row_count: 0 })
  })
})

describe('statementLabel', () => {
  it('names the statement after its number', () => {
    expect(statementLabel('2026-44')).toBe('Izvod #2026-44')
  })

  it('falls back when no number was typed', () => {
    expect(statementLabel('')).toBe('Ručni unos')
    expect(statementLabel('   ')).toBe('Ručni unos')
  })

  it('trims, so a stray space does not become part of the name', () => {
    expect(statementLabel('  2026-44 ')).toBe('Izvod #2026-44')
  })
})

describe('invoiceStatus', () => {
  it('is unpaid when nothing has been allocated', () => {
    expect(invoiceStatus(0, 1000)).toBe('unpaid')
    expect(invoiceStatus(-5, 1000)).toBe('unpaid')
  })

  it('is partial part of the way there', () => {
    expect(invoiceStatus(400, 1000)).toBe('partial')
  })

  it('is paid on the nose', () => {
    expect(invoiceStatus(1000, 1000)).toBe('paid')
  })

  it('is paid a para short, rather than left partial by a rounding artefact', () => {
    expect(invoiceStatus(999.99, 1000)).toBe('paid')
  })

  it('is still partial when the shortfall is real', () => {
    // 999.90 used to read `paid`: the tolerance was a tenth of a percent of
    // the bill, so it grew with it — 12,500 dinars on one of twelve and a
    // half million. It is a para now, whatever the bill.
    expect(invoiceStatus(999.9, 1000)).toBe('partial')
    expect(invoiceStatus(998, 1000)).toBe('partial')
  })

  it('is paid when overpaid', () => {
    expect(invoiceStatus(1200, 1000)).toBe('paid')
  })
})

describe('rowAmount', () => {
  it('reads a debit as money out', () => {
    expect(rowAmount({ debit: '250.50', credit: '' })).toEqual({ amount: 250.5, isExpense: true })
  })

  it('reads a credit as money in', () => {
    expect(rowAmount({ debit: '', credit: '900' })).toEqual({ amount: 900, isExpense: false })
  })

  it('is zero and not an expense when the row is empty', () => {
    expect(rowAmount({})).toEqual({ amount: 0, isExpense: false })
  })

  it('prefers the debit when somehow both are filled', () => {
    expect(rowAmount({ debit: '100', credit: '50' })).toEqual({ amount: 100, isExpense: true })
  })

  it('ignores text that is not a number', () => {
    expect(rowAmount({ debit: 'abc', credit: '' })).toEqual({ amount: 0, isExpense: false })
  })
})

describe('invoiceStatus with an advance deducted', () => {
  it('counts the advance as settled, as v_invoice_status does', () => {
    expect(invoiceStatus(600, 1000, 1000, 400)).toBe('paid')
    expect(invoiceStatus(100, 1000, 1000, '400')).toBe('partial')
    expect(invoiceStatus(0, 1000, 1000, 400)).toBe('unpaid')
  })
})

describe('an advance, reopened', () => {
  it('keeps its flag; anything else reads false', () => {
    const tx = { id: 't', type: 'direct', tx_subtype: 'revenue', amount: 100, is_advance: true, project_id: 'p' }
    expect(txToSeed(tx).is_advance).toBe(true)
    expect(txToSeed({ ...tx, is_advance: undefined }).is_advance).toBe(false)
    expect(passthroughToSeed({ id: 'x', direction: 'in', amount: 1 }).is_advance).toBe(false)
  })
})

describe('what an edited statement’s log is called', () => {
  /** The editor was written for statements typed in by hand. Saving one that
   *  came out of a bank file used to rename it `Izvod #...` and note it as
   *  entered manually, losing the only record of which file those rows came
   *  from on the one screen anybody goes looking. */
  it('keeps the file name for a statement that came from a file', () => {
    expect(editedStatementName(
      { fromFile: true, fileName: '150-000000004457094_140_22.txt' }, '2026-44',
    )).toBe('150-000000004457094_140_22.txt')
  })

  it('does not call a file import a manual entry', () => {
    expect(editedStatementNote({ fromFile: true }, 12)).toBe('Stavki: 12')
    expect(editedStatementNote({ fromFile: true }, 12)).not.toMatch(/Ručno/i)
  })

  it('still names a hand-typed statement by its number', () => {
    expect(editedStatementName({ fromFile: false, fileName: null }, '2026-44'))
      .toBe('Izvod #2026-44')
    expect(editedStatementNote({ fromFile: false }, 2)).toBe('Ručno uneto stavki: 2')
  })

  it('falls back to the number when a file import has lost its name', () => {
    expect(editedStatementName({ fromFile: true, fileName: null }, '2026-44'))
      .toBe('Izvod #2026-44')
    expect(editedStatementName({ fromFile: true, fileName: '' }, '')).toBe('Ručni unos')
  })
})
