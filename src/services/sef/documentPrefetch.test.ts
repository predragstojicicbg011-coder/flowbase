import { fetchesQuietly, runLimited } from './documentPrefetch'

const row = (over: Record<string, unknown>) => ({ state: 'pending', ubl_fetched_at: null, sef_status: 'Approved', ...over })

describe('which waiting invoices have their documents fetched without asking', () => {
  it('those SEF has already seen or settled: fetching changes nothing there', () => {
    for (const s of ['Seen', 'Approved', 'approved', 'Rejected', 'Cancelled', 'Storno']) expect(fetchesQuietly(row({ sef_status: s }))).toBe(true)
  })

  it('never a New one, a renotified one or one whose status is not known: those are asked about', () => {
    for (const s of ['New', 'new', 'ReNotified', '', null, 'Sending']) expect(fetchesQuietly(row({ sef_status: s }))).toBe(false)
  })

  it('only a waiting one, never fetched before', () => {
    expect(fetchesQuietly(row({ ubl_fetched_at: '2026-10-21T10:00:00Z' }))).toBe(false)
    expect(fetchesQuietly(row({ state: 'imported' }))).toBe(false)
    expect(fetchesQuietly(row({ state: 'dismissed' }))).toBe(false)
  })
})

describe('fetching a few at a time', () => {
  it('runs every item, never more than the limit at once', async () => {
    let running = 0
    let most = 0
    const done: number[] = []
    await runLimited([1, 2, 3, 4, 5], 2, async n => {
      running++; most = Math.max(most, running)
      await new Promise(r => setTimeout(r, 5))
      done.push(n); running--
    })
    expect(done.sort()).toEqual([1, 2, 3, 4, 5])
    expect(most).toBe(2)
  })

  it('one failure does not stop the others', async () => {
    const done: number[] = []
    await runLimited([1, 2, 3], 1, async n => { if (n === 2) throw new Error('x'); done.push(n) })
    expect(done).toEqual([1, 3])
  })
})
