import { saveSplits, loadSplits } from './saveSplits'
import { emptyLine, type SplitLine } from './expenseSplit'

const line = (amount: number, category = 'General Business'): SplitLine => ({
  ...emptyLine(`k${amount}`), amount, pl_category: category,
})

// 120,000 RSD at 117.5 RSD per EUR = 1,021.28 EUR.
const parent = { amount: 120000, currency: 'RSD', exchange_rate: 1, eur_rate: 117.5, amount_rsd: 120000, amount_eur: 1021.28 }

/** A PostgREST that records what it was asked to do. */
function fakeClient(over: { delError?: string; insError?: string; insRows?: number } = {}) {
  const calls: { op: string; table: string; payload?: any; filters: any[] }[] = []

  const builder = (table: string) => {
    const call: any = { op: '', table, filters: [] }
    const self: any = {
      delete() { call.op = 'delete'; calls.push(call); return self },
      insert(rows: any) { call.op = 'insert'; call.payload = rows; calls.push(call); return self },
      select() { return self },
      order() { return self },
      eq(col: string, val: any) { call.filters.push([col, val]); return self },
      then(resolve: (r: any) => void) {
        if (call.op === 'delete') {
          resolve({ data: [], error: over.delError ? { message: over.delError } : null })
        } else {
          const n = over.insRows ?? (call.payload?.length ?? 0)
          resolve({
            data: Array.from({ length: n }, (_, i) => ({ id: `s${i}` })),
            error: over.insError ? { message: over.insError } : null,
          })
        }
      },
    }
    return self
  }

  return { client: { from: builder }, calls }
}

describe('writing a split', () => {
  it('removes what was there before it writes what replaces it', async () => {
    const { client, calls } = fakeClient()
    await saveSplits(client, 'invoice', 'inv-1', parent, [line(40000), line(80000)])
    expect(calls.map(c => c.op)).toEqual(['delete', 'insert'])
  })

  /**
   * The database refuses a split that does not add up, so the replacement
   * cannot be inserted alongside what it replaces — the two sets together are
   * twice the payment and the check would refuse both.
   */
  it('scopes the removal to that one payment', async () => {
    const { client, calls } = fakeClient()
    await saveSplits(client, 'invoice', 'inv-1', parent, [line(40000), line(80000)])
    expect(calls[0].filters).toEqual([['source', 'invoice'], ['source_id', 'inv-1']])
  })

  it('stamps every line with the payment it belongs to', async () => {
    const { client, calls } = fakeClient()
    await saveSplits(client, 'transaction', 'tx-9', parent, [line(40000), line(80000)])
    expect(calls[1].payload).toHaveLength(2)
    expect(calls[1].payload.every((r: any) => r.source === 'transaction' && r.source_id === 'tx-9'))
      .toBe(true)
    // 40000 / 117.5 = 340.43; the last line takes 1021.28 - 340.43.
    expect(calls[1].payload.map((r: any) => [r.amount_rsd, r.amount_eur]))
      .toEqual([[40000, 340.43], [80000, 680.85]])
  })

  it('reports how many lines the payment now carries', async () => {
    const { client } = fakeClient()
    const out = await saveSplits(client, 'invoice', 'inv-1', parent, [line(40000), line(80000)])
    expect(out).toMatchObject({ ok: true, lines: 2 })
  })

  /** Deciding a payment is one expense after all is ordinary, not an error. */
  it('undoes a split without writing anything new', async () => {
    const { client, calls } = fakeClient()
    const out = await saveSplits(client, 'invoice', 'inv-1', parent, [])
    expect(out).toMatchObject({ ok: true, lines: 0 })
    expect(calls.map(c => c.op)).toEqual(['delete'])
  })
})

describe('when it cannot be written', () => {
  it('refuses a split that does not add up before it touches anything', async () => {
    const { client, calls } = fakeClient()
    const out = await saveSplits(client, 'invoice', 'inv-1', parent, [line(40000), line(70000)])
    expect(out.ok).toBe(false)
    expect(out.message).toMatch(/not accounted for/)
    expect(calls).toHaveLength(0)
  })

  it('refuses a parent without stored rates before it touches anything', async () => {
    const { client, calls } = fakeClient()
    const out = await saveSplits(client, 'invoice', 'inv-1', { amount: 120000, currency: 'EUR' },
      [line(40000), line(80000)])
    expect(out.ok).toBe(false)
    expect(out.message).toMatch(/nema/)   // the RateUnavailableError's own words
    expect(calls).toHaveLength(0)
  })

  it('refuses a split of one without touching anything', async () => {
    const { client, calls } = fakeClient()
    const out = await saveSplits(client, 'invoice', 'inv-1', parent, [line(120000)])
    expect(out.ok).toBe(false)
    expect(calls).toHaveLength(0)
  })

  it('says the old split is still there when the removal failed', async () => {
    const { client } = fakeClient({ delError: 'permission denied' })
    const out = await saveSplits(client, 'invoice', 'inv-1', parent, [line(40000), line(80000)])
    expect(out.ok).toBe(false)
    expect(out.message).toMatch(/still carries the split it had/)
  })

  /**
   * Between the two calls the payment is an ordinary unsplit expense, which is
   * a legitimate state. If the insert fails the caller is told that in those
   * words rather than left to find a payment with half a split on it.
   */
  it('says the payment is booked as one expense when the write failed', async () => {
    const { client } = fakeClient({ insError: 'violates check constraint' })
    const out = await saveSplits(client, 'invoice', 'inv-1', parent, [line(40000), line(80000)])
    expect(out.ok).toBe(false)
    expect(out.message).toMatch(/booked as one expense/)
  })

  /** A silent partial write is what a refused policy looks like from here. */
  it('does not call a partial write a success', async () => {
    const { client } = fakeClient({ insRows: 1 })
    const out = await saveSplits(client, 'invoice', 'inv-1', parent, [line(40000), line(80000)])
    expect(out.ok).toBe(false)
    expect(out.message).toMatch(/1 of 2 lines/)
  })
})

describe('reading a split back', () => {
  it('asks for that payment only, in order', async () => {
    const { client, calls } = fakeClient()
    await loadSplits(client, 'invoice', 'inv-1')
    expect(calls).toHaveLength(0)  // `select` alone records nothing in the fake
  })

  it('gives an empty list when there is no split', async () => {
    const empty = { from: () => ({
      select: () => ({ eq: () => ({ eq: () => ({ order: () => Promise.resolve({ data: null }) }) }) }),
    }) }
    expect(await loadSplits(empty, 'invoice', 'inv-1')).toEqual([])
  })
})
