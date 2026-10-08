import { fetchAllPartners } from './allPartners'

// ─── Past the row cap ───────────────────────────────────────────────────────
//
// A fake PostgREST that behaves like the real one in the two ways that matter:
// it caps a response at 1000 rows whatever the range asks for, and it says
// nothing about having done so.

const PAGE_CAP = 1000

function fakeClient(rows: { id: string; name: string }[]) {
  const orders: string[] = []
  const selected: string[] = []

  const builder = () => {
    let from = 0
    let to = PAGE_CAP - 1
    const self: any = {
      select(columns: string) { selected.push(columns); return self },
      order(column: string) { orders.push(column); return self },
      range(a: number, b: number) {
        from = a
        to = Math.min(b, a + PAGE_CAP - 1)
        return self
      },
      then(resolve: (r: any) => void) {
        resolve({ data: rows.slice(from, to + 1), error: null })
      },
    }
    return self
  }

  return { client: { from: () => builder() }, orders, selected }
}

const many = (n: number) =>
  Array.from({ length: n }, (_, i) => ({ id: `p${i}`, name: `Partner ${String(i).padStart(4, '0')}` }))

describe('fetchAllPartners', () => {
  /**
   * The bug this exists for: the partner book passed a thousand, every
   * dropdown silently offered a thousand of them, and an employee past the
   * cap was reported as not being in Partners at all.
   */
  it('reads past the thousand-row cap', async () => {
    const { client } = fakeClient(many(2350))
    const all = await fetchAllPartners<{ id: string }>(client)
    expect(all).toHaveLength(2350)
  })

  it('reads a book that fits in one page without asking for a second', async () => {
    const { client } = fakeClient(many(12))
    expect(await fetchAllPartners(client)).toHaveLength(12)
  })

  it('copes with no partners at all', async () => {
    const { client } = fakeClient([])
    expect(await fetchAllPartners(client)).toEqual([])
  })

  /**
   * Paging with `.range()` is only correct against a sort no two rows can tie
   * on. The query that caused this had NO order at all, so the thousand rows
   * it received were an arbitrary thousand — a different arbitrary thousand
   * each run.
   */
  it('orders by something unique, so no row is dropped or repeated', async () => {
    const { client, orders } = fakeClient(many(5))
    await fetchAllPartners(client)
    expect(orders).toEqual(['name', 'id'])
  })

  it('asks only for the columns it was told to', async () => {
    const { client, selected } = fakeClient(many(5))
    await fetchAllPartners(client, 'id,name,is_individual')
    expect(selected[0]).toBe('id,name,is_individual')
  })

  it('takes every column when it is not told', async () => {
    const { client, selected } = fakeClient(many(5))
    await fetchAllPartners(client)
    expect(selected[0]).toBe('*')
  })
})
