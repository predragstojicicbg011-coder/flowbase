import { deletionWarning, deletionSummary, type DeletionCounts } from './statementDelete'

const counts = (over: Partial<DeletionCounts> = {}): DeletionCounts => ({
  transactions: 12, passthroughs: 0, invoiceIds: [], closing: [], ...over,
})

describe('what the owner is asked before a statement is deleted', () => {
  it('names the statement and what it posted', () => {
    const w = deletionWarning('150-00000000445_140_22.txt', counts())
    expect(w).toMatch(/150-00000000445_140_22\.txt/)
    expect(w).toMatch(/12 transactions/)
    expect(w).toMatch(/cannot be undone/i)
  })

  it('says "this statement" where the log has no name', () => {
    expect(deletionWarning(null, counts())).toMatch(/"this statement"/)
    expect(deletionWarning('', counts())).toMatch(/"this statement"/)
  })

  it('counts one of a thing in the singular', () => {
    const w = deletionWarning('f.txt', counts({ transactions: 1, passthroughs: 1, invoiceIds: ['i1'] }))
    expect(w).toMatch(/1 transaction\b/)
    expect(w).toMatch(/1 pass-through row\b/)
    expect(w).toMatch(/1 invoice allocation\b/)
  })

  it('leaves out pass-through rows and allocations where there are none', () => {
    const w = deletionWarning('f.txt', counts())
    expect(w).not.toMatch(/pass-through/)
    expect(w).not.toMatch(/allocation/)
  })

  /** THE POINT OF THE WARNING. Deleting removes the allocations, so invoices
   *  that read `paid` go back to owing money. "3 invoice allocations" does
   *  not tell anybody which supplier is about to be owed again. */
  it('names the invoices that will stop reading as paid', () => {
    const w = deletionWarning('f.txt', counts({
      invoiceIds: ['i1', 'i2'], closing: ['2026-0412', '2026-0511'],
    }))
    expect(w).toMatch(/2 invoices currently read as paid and will owe money again/)
    expect(w).toMatch(/2026-0412, 2026-0511/)
  })

  it('lists eight of them and counts the rest', () => {
    const many = Array.from({ length: 11 }, (_, i) => `INV-${i + 1}`)
    const w = deletionWarning('f.txt', counts({ invoiceIds: many, closing: many }))
    expect(w).toMatch(/INV-8/)
    expect(w).not.toMatch(/INV-9\b/)
    expect(w).toMatch(/and 3 more/)
  })

  it('says nothing about paid invoices when none of them are', () => {
    const w = deletionWarning('f.txt', counts({ invoiceIds: ['i1'], closing: [] }))
    expect(w).toMatch(/1 invoice allocation/)
    expect(w).not.toMatch(/owe money again/)
  })
})

describe('what it reports afterwards', () => {
  it('reports in the same terms the warning used', () => {
    expect(deletionSummary({
      transactions_deleted: 12, passthroughs_deleted: 2, allocations_removed: 3,
      installments_reopened: 1, invoices_restated: 2,
    })).toBe('Deleted 12 transaction(s), 2 pass-through(s), removed 3 allocation(s), '
      + 'reopened 1 credit instalment(s), and 2 invoice(s) no longer read as they did.')
  })

  it('leaves out what did not happen', () => {
    const t = deletionSummary({ transactions_deleted: 4, allocations_removed: 0 })
    expect(t).toBe('Deleted 4 transaction(s), removed 0 allocation(s).')
  })

  it('survives a result that says nothing at all', () => {
    expect(deletionSummary(null)).toBe('Deleted 0 transaction(s), removed 0 allocation(s).')
  })
})
