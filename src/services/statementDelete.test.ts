import { deletionWarning, deletionSummary, type DeletionCounts } from './statementDelete'

const counts = (over: Partial<DeletionCounts> = {}): DeletionCounts => ({
  transactions: 12, passthroughs: 0, invoiceIds: [], closing: [], ...over,
})

describe('what the owner is asked before a statement is deleted', () => {
  it('names the statement and what it posted', () => {
    const w = deletionWarning('150-00000000445_140_22.txt', counts())
    expect(w).toMatch(/150-00000000445_140_22\.txt/)
    expect(w).toMatch(/transakcija: 12/)
    expect(w).toMatch(/ne može poništiti/i)
  })

  it('says "this statement" where the log has no name', () => {
    expect(deletionWarning(null, counts())).toMatch(/ovaj izvod/)
    expect(deletionWarning('', counts())).toMatch(/ovaj izvod/)
  })

  it('names each count plainly', () => {
    const w = deletionWarning('f.txt', counts({ transactions: 1, passthroughs: 1, invoiceIds: ['i1'] }))
    expect(w).toMatch(/transakcija: 1/)
    expect(w).toMatch(/prolaznih stavki: 1/)
    expect(w).toMatch(/raspodela na fakture: 1/)
  })

  it('leaves out pass-through rows and allocations where there are none', () => {
    const w = deletionWarning('f.txt', counts())
    expect(w).not.toMatch(/prolaznih stavki/)
    expect(w).not.toMatch(/raspodela/)
  })

  /** THE POINT OF THE WARNING. Deleting removes the allocations, so invoices
   *  that read `paid` go back to owing money. "3 invoice allocations" does
   *  not tell anybody which supplier is about to be owed again. */
  it('names the invoices that will stop reading as paid', () => {
    const w = deletionWarning('f.txt', counts({
      invoiceIds: ['i1', 'i2'], closing: ['2026-0412', '2026-0511'],
    }))
    expect(w).toMatch(/vode kao plaćene i ponovo će imati dug \(2/)
    expect(w).toMatch(/2026-0412, 2026-0511/)
  })

  it('lists eight of them and counts the rest', () => {
    const many = Array.from({ length: 11 }, (_, i) => `INV-${i + 1}`)
    const w = deletionWarning('f.txt', counts({ invoiceIds: many, closing: many }))
    expect(w).toMatch(/INV-8/)
    expect(w).not.toMatch(/INV-9\b/)
    expect(w).toMatch(/i još 3/)
  })

  it('says nothing about paid invoices when none of them are', () => {
    const w = deletionWarning('f.txt', counts({ invoiceIds: ['i1'], closing: [] }))
    expect(w).toMatch(/raspodela na fakture: 1/)
    expect(w).not.toMatch(/ponovo će imati dug/)
  })
})

describe('what it reports afterwards', () => {
  it('reports in the same terms the warning used', () => {
    expect(deletionSummary({
      transactions_deleted: 12, passthroughs_deleted: 2, allocations_removed: 3,
      installments_reopened: 1, invoices_restated: 2,
    })).toBe('Obrisano transakcija: 12, prolaznih stavki: 2, uklonjeno raspodela: 3, '
      + 'ponovo otvoreno rata kredita: 1, faktura kojima se promenio status: 2.')
  })

  it('leaves out what did not happen', () => {
    const t = deletionSummary({ transactions_deleted: 4, allocations_removed: 0 })
    expect(t).toBe('Obrisano transakcija: 4, uklonjeno raspodela: 0.')
  })

  it('survives a result that says nothing at all', () => {
    expect(deletionSummary(null)).toBe('Obrisano transakcija: 0, uklonjeno raspodela: 0.')
  })
})
