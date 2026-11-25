import { deletionWarning, deletionSummary, gatherDeletion, type DeletionCounts } from './statementDelete'

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

// ── A credit payment is one line, not three ───────────────────────────────
//
// Since 20261125090000 the principal and interest legs a credit payment posts
// carry the statement's batch, so the delete takes them. Counted with the
// lines, one credit payment read "transakcija: 3".

/** A client that answers each read by table; the leg count is the
 *  `transactions` read narrowed to `pl_impact = true` (`transactions:legs`). */
const client = (answers: Record<string, any>) => ({
  from: (table: string) => {
    const chain: any = {}
    let key = table
    for (const m of ['select', 'is', 'in']) chain[m] = () => chain
    chain.eq = (col: string, v: unknown) => {
      if (col === 'pl_impact' && v === true) key = `${table}:legs`
      return chain
    }
    chain.then = (ok: any, bad: any) =>
      Promise.resolve(answers[key] ?? { data: [], count: 0, error: null }).then(ok, bad)
    return chain
  },
})

describe('the credit legs, counted apart from the lines', () => {
  const base = {
    passthrough: { count: 0, error: null },
    invoice_transaction_links: { data: [], error: null },
  }

  it('counts one credit payment as one transaction and two legs', async () => {
    const c = await gatherDeletion(client({
      ...base,
      transactions: { count: 3, error: null },
      'transactions:legs': { count: 2, error: null },
    }), 'batch-1')
    expect(c.transactions).toBe(1)
    expect(c.creditLegs).toBe(2)
  })

  it('counts every row a line when the leg count cannot be read', async () => {
    const c = await gatherDeletion(client({
      ...base,
      transactions: { count: 3, error: null },
      'transactions:legs': { count: null, error: { message: 'Failed to fetch' } },
    }), 'batch-1')
    expect(c.transactions).toBe(3)
    expect(c.creditLegs).toBe(0)
  })

  it('names the legs in the warning, apart from the transactions', () => {
    const w = deletionWarning('izvod.txt', counts({ transactions: 1, creditLegs: 2 }))
    expect(w).toContain('· transakcija: 1\n· redova glavnice i kamate iz otplata kredita: 2')
  })

  it('says nothing about legs when there are none', () => {
    expect(deletionWarning('izvod.txt', counts({ creditLegs: 0 }))).not.toMatch(/glavnice/)
  })

  it('splits what the database deleted back into lines and legs', () => {
    // `transactions_deleted` counts every row of the batch, legs included.
    expect(deletionSummary({ transactions_deleted: 3, allocations_removed: 0, installments_reopened: 1 },
      { creditLegs: 2 }))
      .toBe('Obrisano transakcija: 1, redova glavnice i kamate iz otplata kredita: 2, '
        + 'uklonjeno raspodela: 0, ponovo otvoreno rata kredita: 1.')
  })

  it('reads as before without the counts', () => {
    expect(deletionSummary({ transactions_deleted: 3, allocations_removed: 0 }))
      .toBe('Obrisano transakcija: 3, uklonjeno raspodela: 0.')
  })
})
