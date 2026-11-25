import {
  deletionWarning, deletionSummary, gatherDeletion, UNLINKED_WARNING, UNLINKED_UNKNOWN,
  type DeletionCounts,
} from './statementDelete'

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
 *  `transactions` read narrowed to `pl_impact = true` (`transactions:legs`),
 *  the credit bank lines the one narrowed to `pl_impact` not true
 *  (`transactions:lines`). */
const client = (answers: Record<string, any>) => ({
  from: (table: string) => {
    const chain: any = {}
    let key = table
    for (const m of ['select', 'is', 'in']) chain[m] = () => chain
    chain.eq = (col: string, v: unknown) => {
      if (col === 'pl_impact' && v === true) key = `${table}:legs`
      return chain
    }
    chain.not = (col: string, op: string, v: unknown) => {
      if (col === 'pl_impact' && op === 'is' && v === true) key = `${table}:lines`
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

// ── A credit payment posted before its legs carried the batch ─────────────
//
// In MCFlow (and any FlowBase client) every statement posted before
// 20261125090000 has credit bank lines whose legs carry no batch and whose
// instalment was never stamped. Deleting such a statement cannot find them:
// the legs stay in the P&L and the instalment stays paid, and a re-import of
// the same file (its fingerprints are freed) pays the NEXT instalment. The
// warning has to say so before the owner agrees.

describe('a credit payment the delete cannot reach', () => {
  const base = {
    transactions: { count: 3, error: null },
    'transactions:legs': { count: 0, error: null },
    passthrough: { count: 0, error: null },
    invoice_transaction_links: { data: [], error: null },
  }

  it('counts the credit bank lines no instalment points to', async () => {
    const c = await gatherDeletion(client({
      ...base,
      'transactions:lines': { data: [{ id: 'old-line' }, { id: 'new-line' }], error: null },
      credit_installments: { data: [{ transaction_id: 'new-line' }], error: null },
    }), 'batch-1')
    expect(c.unlinkedCreditLines).toBe(1)
  })

  it('does not count a new line whose instalment remembers only the second of two new lines', async () => {
    // One instalment paid by two lines of this statement: the instalment
    // points at the second, but both wrote stamped legs beside themselves.
    const c = await gatherDeletion(client({
      ...base,
      'transactions:legs': {
        count: 2,
        data: [
          { transaction_date: '2026-10-13', bank_id: 'b1', partner_id: 'p1' },
          { transaction_date: '2026-10-14', bank_id: 'b1', partner_id: 'p1' },
        ],
        error: null,
      },
      'transactions:lines': {
        data: [
          { id: 'first', transaction_date: '2026-10-13', bank_id: 'b1', partner_id: 'p1' },
          { id: 'second', transaction_date: '2026-10-14', bank_id: 'b1', partner_id: 'p1' },
        ],
        error: null,
      },
      credit_installments: { data: [{ transaction_id: 'second' }], error: null },
    }), 'batch-1')
    expect(c.unlinkedCreditLines).toBe(0)
    expect(deletionWarning('izvod.txt', c)).not.toMatch(/nisu vezane|proveriti/)
  })

  it('still counts an old line beside a new one on another day', async () => {
    const c = await gatherDeletion(client({
      ...base,
      'transactions:legs': { count: 1, data: [{ transaction_date: '2026-10-14', bank_id: 'b1', partner_id: 'p1' }], error: null },
      'transactions:lines': {
        data: [
          { id: 'old', transaction_date: '2026-10-13', bank_id: 'b1', partner_id: 'p1' },
          { id: 'new', transaction_date: '2026-10-14', bank_id: 'b1', partner_id: 'p1' },
        ],
        error: null,
      },
      credit_installments: { data: [{ transaction_id: 'new' }], error: null },
    }), 'batch-1')
    expect(c.unlinkedCreditLines).toBe(1)
  })

  it('cannot tell when the leg read fails', async () => {
    const c = await gatherDeletion(client({
      ...base,
      'transactions:legs': { count: null, data: null, error: { message: 'Failed to fetch' } },
      'transactions:lines': { data: [{ id: 'old', transaction_date: '2026-10-13', bank_id: 'b1', partner_id: 'p1' }], error: null },
      credit_installments: { data: [], error: null },
    }), 'batch-1')
    expect(c.unlinkedCreditLines).toBeNull()
  })

  it('counts none when the statement has no credit bank line', async () => {
    const c = await gatherDeletion(client(base), 'batch-1')
    expect(c.unlinkedCreditLines).toBe(0)
  })

  it('cannot tell when a read fails', async () => {
    const c1 = await gatherDeletion(client({
      ...base, 'transactions:lines': { data: null, error: { message: 'Failed to fetch' } },
    }), 'batch-1')
    expect(c1.unlinkedCreditLines).toBeNull()
    const c2 = await gatherDeletion(client({
      ...base,
      'transactions:lines': { data: [{ id: 'old-line' }], error: null },
      credit_installments: { data: null, error: { message: 'Failed to fetch' } },
    }), 'batch-1')
    expect(c2.unlinkedCreditLines).toBeNull()
  })

  it('warns, in Serbian, what the delete leaves behind and what to do before re-importing', () => {
    const w = deletionWarning('izvod.txt', counts({ transactions: 3, unlinkedCreditLines: 2 }))
    expect(w).toContain('Stavki otplate kredita koje nisu vezane za svoju ratu: 2.\n' + UNLINKED_WARNING)
    expect(UNLINKED_WARNING).toBe(
      'Proknjižene su pre nego što je izvod pamtio svoje redove glavnice i kamate, pa ih ovo brisanje '
      + 'NE uklanja i NE vraća njihove rate na neplaćene. Pre nego što isti izvod ponovo uvezete, ručno '
      + 'obrišite te redove glavnice i kamate (strana Transakcije), a njihove rate vratite na neplaćene '
      + 'dugmetom „Vrati na neplaćeno“ na strani Krediti — inače će otplata biti proknjižena dvaput, a kao '
      + 'plaćena biće označena sledeća rata.')
    // Still the last word.
    expect(w.endsWith('Ovo se ne može poništiti odavde.')).toBe(true)
  })

  it('says it could not check when the count is unknown', () => {
    expect(deletionWarning('izvod.txt', counts({ unlinkedCreditLines: null }))).toContain(UNLINKED_UNKNOWN)
    // And names the button that does by hand what the delete cannot.
    expect(UNLINKED_UNKNOWN.endsWith('Rata se vraća dugmetom „Vrati na neplaćeno“ na strani Krediti.')).toBe(true)
  })

  it('says nothing when every credit line is linked, or the count predates the check', () => {
    expect(deletionWarning('izvod.txt', counts({ unlinkedCreditLines: 0 }))).not.toMatch(/nisu vezane|proveriti/)
    expect(deletionWarning('izvod.txt', counts())).not.toMatch(/nisu vezane|proveriti/)
  })

  it('reports a credit reopened', () => {
    expect(deletionSummary({ transactions_deleted: 3, allocations_removed: 0, installments_reopened: 1, credits_reopened: 1 },
      { creditLegs: 2 }))
      .toBe('Obrisano transakcija: 1, redova glavnice i kamate iz otplata kredita: 2, '
        + 'uklonjeno raspodela: 0, ponovo otvoreno rata kredita: 1, ponovo otvoreno kredita: 1.')
  })
})
