import { CASH_ONLY_FILTER, cashOnly, isCashMovement, NON_CASH_CF_TYPES } from './cashBasis'

describe('isCashMovement', () => {
  it('keeps a row with no cash-flow type at all', () => {
    // THE TRAP. 1,345 posted transactions carry no cf_type and are worth
    // $3.9m. A predicate that drops them would take most of the real money
    // out of Cash Flow while looking perfectly reasonable.
    expect(isCashMovement({ cf_type: null })).toBe(true)
    expect(isCashMovement({ cf_type: undefined })).toBe(true)
    expect(isCashMovement({})).toBe(true)
    expect(isCashMovement({ cf_type: '' })).toBe(true)
  })

  it('keeps every type that is a bank movement', () => {
    for (const t of ['recurring', 'one_time', 'capex', 'reimbursable']) {
      expect(isCashMovement({ cf_type: t })).toBe(true)
    }
  })

  it('drops an accrual, which is the marker for a currency gain', () => {
    expect(isCashMovement({ cf_type: 'accrual' })).toBe(false)
  })

  it('drops exactly what the list says and nothing else', () => {
    expect(NON_CASH_CF_TYPES).toEqual(['accrual'])
  })
})

describe('cashOnly', () => {
  it('keeps the real movements and loses the accrual', () => {
    const rows = [
      { id: 1, cf_type: 'recurring' },
      { id: 2, cf_type: null },
      { id: 3, cf_type: 'accrual' },
      { id: 4, cf_type: 'one_time' },
    ]
    expect(cashOnly(rows).map(r => r.id)).toEqual([1, 2, 4])
  })

  it('has nothing to do with an empty list', () => {
    expect(cashOnly([])).toEqual([])
  })
})

describe('the database filter agrees with the predicate', () => {
  it('asks for null OR not-accrual, never a bare neq', () => {
    // `cf_type <> 'accrual'` is NULL for a NULL cf_type, and a NULL predicate
    // excludes the row. The `is.null` half is what keeps the unclassified
    // transactions in.
    expect(CASH_ONLY_FILTER).toContain('cf_type.is.null')
    expect(CASH_ONLY_FILTER).toContain('cf_type.neq.accrual')
  })

  it('names the same type the predicate drops', () => {
    for (const t of NON_CASH_CF_TYPES) expect(CASH_ONLY_FILTER).toContain(`cf_type.neq.${t}`)
  })
})
