import { fetchAllPages, countRows, chunkIds, fetchByIds, PAGE_SIZE } from './fetchAllPages'

/** A fake PostgREST source holding `n` rows, recording the ranges asked for. */
function source(n: number) {
  const rows = Array.from({ length: n }, (_, i) => ({ id: i }))
  const calls: [number, number][] = []
  const build = (from: number, to: number) => {
    calls.push([from, to])
    return Promise.resolve({ data: rows.slice(from, to + 1), error: null })
  }
  return { build, calls, rows }
}

describe('fetchAllPages', () => {
  it('returns every row when the table is larger than one page', async () => {
    const s = source(2350)
    const out = await fetchAllPages<{ id: number }>(s.build)
    expect(out).toHaveLength(2350)
    expect(out[0].id).toBe(0)
    expect(out[2349].id).toBe(2349)
  })

  it('asks for consecutive, non-overlapping ranges', async () => {
    const s = source(2350)
    await fetchAllPages(s.build)
    expect(s.calls).toEqual([[0, 999], [1000, 1999], [2000, 2999]])
  })

  it('stops after one request when the table fits in a page', async () => {
    const s = source(12)
    expect(await fetchAllPages(s.build)).toHaveLength(12)
    expect(s.calls).toHaveLength(1)
  })

  it('makes a second request when the first page is exactly full', async () => {
    // The cap gives no signal that it truncated, so a full page always means
    // "ask again" — otherwise a table of exactly 1000 rows looks complete
    // while one of 1001 silently loses the last row.
    const s = source(PAGE_SIZE)
    expect(await fetchAllPages(s.build)).toHaveLength(PAGE_SIZE)
    expect(s.calls).toHaveLength(2)
  })

  it('returns nothing for an empty table', async () => {
    const s = source(0)
    expect(await fetchAllPages(s.build)).toEqual([])
  })

  it('throws rather than returning a short result when a page fails', async () => {
    const build = (from: number) => Promise.resolve(
      from === 0
        ? { data: Array.from({ length: PAGE_SIZE }, (_, i) => ({ id: i })), error: null }
        : { data: null, error: { message: 'connection lost' } })
    await expect(fetchAllPages(build)).rejects.toEqual({ message: 'connection lost' })
  })
})

describe('countRows', () => {
  it('reads the exact count, not the length of the returned data', async () => {
    expect(await countRows(Promise.resolve({ data: [], count: 3940, error: null }))).toBe(3940)
  })

  it('treats a null count as zero', async () => {
    expect(await countRows(Promise.resolve({ data: [], count: null, error: null }))).toBe(0)
  })

  it('throws on error', async () => {
    await expect(countRows(Promise.resolve({ count: null, error: { message: 'nope' } })))
      .rejects.toEqual({ message: 'nope' })
  })
})

// ─── The URL-length limit ───────────────────────────────────────────────────

describe('chunkIds', () => {
  const ids = Array.from({ length: 450 }, (_, i) => `id-${i}`)

  it('splits into chunks of the size given', () => {
    const out = chunkIds(ids, 200)
    expect(out.map(c => c.length)).toEqual([200, 200, 50])
  })

  it('loses nothing and keeps the order', () => {
    expect(chunkIds(ids, 7).flat()).toEqual(ids)
  })

  it('has nothing to chunk when there are no ids', () => {
    expect(chunkIds([], 200)).toEqual([])
  })

  it('returns a single chunk when everything fits', () => {
    expect(chunkIds(['a', 'b'], 200)).toEqual([['a', 'b']])
  })

  it('does not loop forever on a nonsense size', () => {
    expect(chunkIds(['a', 'b'], 0)).toEqual([['a', 'b']])
  })
})

describe('fetchByIds', () => {
  it('asks once per chunk and concatenates in the order of the ids', async () => {
    const asked: string[][] = []
    const out = await fetchByIds<{ id: string }>(
      ['a', 'b', 'c', 'd', 'e'],
      chunk => { asked.push(chunk); return Promise.resolve({ data: chunk.map(id => ({ id })), error: null }) },
      2)
    expect(asked).toEqual([['a', 'b'], ['c', 'd'], ['e']])
    expect(out.map(r => r.id)).toEqual(['a', 'b', 'c', 'd', 'e'])
  })

  it('makes no request at all for an empty list', async () => {
    let calls = 0
    const out = await fetchByIds([], () => { calls++; return Promise.resolve({ data: [], error: null }) })
    expect(calls).toBe(0)
    expect(out).toEqual([])
  })

  it('throws the refusal rather than returning a short list', async () => {
    // A chunk that fails silently would understate the report, which is the
    // failure this whole module exists to stop.
    await expect(fetchByIds(['a', 'b'], () =>
      Promise.resolve({ data: null, error: { message: 'URI too long' } }), 1),
    ).rejects.toMatchObject({ message: 'URI too long' })
  })
})
