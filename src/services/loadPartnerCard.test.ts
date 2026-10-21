import { loadPartnerCard } from './loadPartnerCard'

// The loader against a fake PostgREST: what it keeps, what it leaves out, and
// that a partner with hundreds of documents is asked about in chunks.

function fakeClient(tables: Record<string, any[]>, calls: { table: string; inSize: number }[]) {
  return {
    from: (table: string) => {
      const q: any = {}
      let inSize = 0
      for (const m of ['select', 'eq', 'is', 'order', 'range']) q[m] = () => q
      q.in = (_c: string, ids: string[]) => { inSize = ids.length; return q }
      q.then = (ok: any, bad: any) => {
        calls.push({ table, inSize })
        return Promise.resolve({ data: tables[table] || [], error: null }).then(ok, bad)
      }
      return q
    },
  }
}

const docs = (n: number) => Array.from({ length: n }, (_, i) => ({
  id: `i${i}`, invoice_number: `F-${i}`, invoice_date: '2026-10-01', type: 'expense', document_type: 'invoice',
  currency: 'RSD', amount: 100, amount_rsd: 100, adjusts_invoice_id: null, prior_period: false, advance_open: null, advance_deducted_rsd: 0,
}))

describe('loading a partner card', () => {
  it('keeps a direct transaction linked to a bill out of "direct payments", and names a currency difference', async () => {
    const calls: any[] = []
    const client = fakeClient({
      v_invoice_status: docs(1),
      invoice_transaction_links: [
        { invoice_id: 'i0', transaction_id: 'fx', allocated_amount_rsd: 3, transactions: { transaction_date: '2026-10-02', deleted_at: null, type: 'direct', tx_subtype: 'revenue', note: 'Kursna razlika po fakturi F-0 — plaćeno manje nego što je fakturisano', banks: null } },
        { invoice_id: 'i0', transaction_id: 'rec', allocated_amount_rsd: 97, transactions: { transaction_date: '2026-10-02', deleted_at: null, type: 'direct', tx_subtype: 'expense', note: null, banks: { name: 'OTP banka' } } },
      ],
      transactions: [
        { id: 'fx', transaction_date: '2026-10-02', amount_rsd: 3, tx_subtype: 'revenue', note: 'Kursna razlika', banks: null },
        { id: 'rec', transaction_date: '2026-10-02', amount_rsd: 97, tx_subtype: 'expense', note: null, banks: { name: 'OTP banka' } },
        { id: 'free', transaction_date: '2026-10-03', amount_rsd: 50, tx_subtype: 'expense', note: 'prevoz', banks: { name: 'OTP banka' } },
      ],
    }, calls)
    const d = await loadPartnerCard(client, 'p1', 'co')
    expect(d.direct.map(t => t.id)).toEqual(['free'])
    expect(d.payments.map(p => [p.transaction_id, p.kind, p.direction])).toEqual([['fx', 'fx', 'in'], ['rec', 'payment', 'out']])
  })

  it('asks which documents have a PDF in chunks', async () => {
    const calls: { table: string; inSize: number }[] = []
    await loadPartnerCard(fakeClient({ v_invoice_status: docs(450) }, calls), 'p1', 'co')
    const sef = calls.filter(c => c.table === 'sef_inbox')
    expect(sef.length).toBeGreaterThan(1)
    expect(Math.max(...sef.map(c => c.inSize))).toBeLessThanOrEqual(200)
  })

  it('in euros, reads every amount from the euro columns', async () => {
    const calls: any[] = []
    const client = fakeClient({
      v_invoice_status: [{ ...docs(1)[0], amount_rsd: 11720, amount_eur: 100, advance_deducted_eur: 0 }],
      invoice_transaction_links: [
        { invoice_id: 'i0', transaction_id: 't1', allocated_amount_rsd: 5860, allocated_amount_eur: 50, transactions: { transaction_date: '2026-10-02', deleted_at: null, type: 'bank', tx_subtype: 'expense', note: null, banks: null } },
      ],
      transactions: [{ id: 'free', transaction_date: '2026-10-03', amount_rsd: -2344, amount_eur: -20, tx_subtype: 'expense', note: null, banks: null }],
    }, calls)
    const d = await loadPartnerCard(client, 'p1', 'co', 'EUR')
    expect(d.documents[0].amount_rsd).toBe(100)
    expect(d.payments[0].amount_rsd).toBe(50)
    expect(d.direct[0].amount_rsd).toBe(20)
  })
})
