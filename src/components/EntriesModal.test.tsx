import { buildEntryItems, DRILL_CAP } from './EntriesModal'

// The module imports the real Supabase client for `useEntryEditor`, and the
// two dialogs it opens drag in half the app. None of that is needed to test
// `buildEntryItems`, which takes its client as an argument precisely so it can
// be driven by the stub below.
jest.mock('../supabase', () => ({ supabase: {} }))
jest.mock('./TransactionDialog', () => ({ __esModule: true, default: () => null }))
jest.mock('./InvoiceDialog', () => ({ __esModule: true, default: () => null }))

/**
 * A client that answers `.from(t).select(…).in('id', ids)` out of a lookup,
 * returning the rows in the order the ids were asked for — which is how a real
 * `.in()` behaves least helpfully: it promises no ordering at all.
 */
const stubClient = (byId: Record<string, any>) => ({
  from: (_table: string) => ({
    select: (_cols: string) => ({
      in: (_col: string, ids: string[]) =>
        Promise.resolve({ data: ids.map(id => byId[id]).filter(Boolean), error: null }),
    }),
  }),
})

const day = (n: number) => `2026-03-${String(n).padStart(2, '0')}`

/** 1,100 expense rows across March, ascending by date — as a paged read returns them. */
const ascendingMonth = () => {
  const rows: { id: string; source: string; pl_date: string }[] = []
  const tx: Record<string, any> = {}
  for (let i = 0; i < 1100; i++) {
    const id = `t${String(i).padStart(4, '0')}`
    const d = day(1 + Math.floor(i / 40))   // 40 rows a day, days 1–28
    rows.push({ id, source: 'transaction', pl_date: d })
    tx[id] = {
      id, transaction_date: d, amount: 100, amount_usd: 100, currency: 'USD',
      pl_category: 'Opex', department: 'Sales', expense_description: 'Ads',
      cf_type: null, note: null, partners: { name: `Vendor ${i}` },
    }
  }
  return { rows, tx }
}

describe('building the entries behind a drill-down', () => {
  it('keeps the newest rows when the input arrives oldest-first', async () => {
    const { rows, tx } = ascendingMonth()

    const { items, total, capped } = await buildEntryItems(rows, stubClient(tx))

    expect(total).toBe(1100)
    expect(capped).toBe(true)
    expect(items).toHaveLength(DRILL_CAP)

    // The regression: slicing before sorting kept rows 0–299, which are the
    // 1st to the 8th of the month, and then sorted those newest-first so the
    // list looked right while missing the last three weeks entirely.
    expect(items[0].date).toBe(day(28))
    expect(items[items.length - 1].date).toBe(day(21))
    expect(items.map(i => i.date)).not.toContain(day(1))
    expect(items.map(i => i.id)).toContain('t1099')
    expect(items.map(i => i.id)).not.toContain('t0000')
  })

  it('returns the list newest-first', async () => {
    const { rows, tx } = ascendingMonth()
    const { items } = await buildEntryItems(rows, stubClient(tx))
    const dates = items.map(i => i.date)
    expect([...dates].sort().reverse()).toEqual(dates)
  })

  it('does not reorder the caller array', async () => {
    const { rows, tx } = ascendingMonth()
    const before = rows.map(r => r.id)
    await buildEntryItems(rows, stubClient(tx))
    expect(rows.map(r => r.id)).toEqual(before)
  })

  it('interleaves invoices and transactions by date', async () => {
    const rows = [
      { id: 'a', source: 'transaction', pl_date: day(1) },
      { id: 'b', source: 'invoice', pl_date: day(2) },
      { id: 'c', source: 'transaction', pl_date: day(3) },
    ]
    const client = stubClient({
      a: { id: 'a', transaction_date: day(1), amount: 1, amount_usd: 1, currency: 'USD', partners: null },
      b: { id: 'b', invoice_date: day(2), invoice_number: 'INV-1', amount: 2, amount_usd: 2, currency: 'USD', partners: null },
      c: { id: 'c', transaction_date: day(3), amount: 3, amount_usd: 3, currency: 'USD', partners: null },
    })

    const { items, capped } = await buildEntryItems(rows, client)

    expect(capped).toBe(false)
    expect(items.map(i => i.id)).toEqual(['c', 'b', 'a'])
    expect(items[1].edit).toEqual({ table: 'invoices', id: 'b' })
  })

  it('reports an uncapped list as the whole list', async () => {
    const rows = [{ id: 'a', source: 'transaction', pl_date: day(1) }]
    const client = stubClient({
      a: { id: 'a', transaction_date: day(1), amount: 1, amount_usd: 1, currency: 'USD', partners: null },
    })
    const { items, total, capped } = await buildEntryItems(rows, client)
    expect(total).toBe(1)
    expect(capped).toBe(false)
    expect(items).toHaveLength(1)
  })
})
