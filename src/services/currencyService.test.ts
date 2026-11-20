import {
  getRate, getRatesForDate, clearRateCache, toIsoDate, nearestBusinessDay, srDate,
  RateUnavailableError, convertToUSD, perUsdFromRsd,
} from './currencyService'

// Every rate here is RSD per 1 unit, as NBS publishes it.

const realFetch = (global as any).fetch

function nbs(rates: Record<string, number | null>, opts: { parity?: number } = {}) {
  return jest.fn(async (url: string) => {
    const cur = /currency=(\w+)/.exec(url)![1].toUpperCase()
    const date = /date=([\d-]+)/.exec(url)![1]
    const middle = rates[cur]
    if (middle === undefined) throw new Error('network down')
    if (middle === null) return { ok: false, status: 500, json: async () => ({ error: 'No rate' }) }
    // Shaped as the service answers a published weekday: `date` echoes the
    // day asked, `date_from` is the day the list applies from.
    return { ok: true, status: 200, json: async () => ({ exchange_middle: middle, parity: opts.parity ?? 1, date, date_from: date }) }
  })
}

beforeEach(() => {
  clearRateCache()
  jest.spyOn(console, 'warn').mockImplementation(() => {})
})
afterEach(() => {
  (global as any).fetch = realFetch
  jest.restoreAllMocks()
})

describe('dates', () => {
  it('reads ISO and Serbian dates', () => {
    expect(toIsoDate('2026-10-07')).toBe('2026-10-07')
    expect(toIsoDate('07.10.2026')).toBe('2026-10-07')
    expect(toIsoDate('7.10.2026.')).toBe('2026-10-07')
  })

  it('steps a weekend back to Friday, whatever the time zone', () => {
    expect(nearestBusinessDay('2026-10-03')).toBe('2026-10-02') // Saturday
    expect(nearestBusinessDay('2026-10-04')).toBe('2026-10-02') // Sunday
    expect(nearestBusinessDay('2026-10-05')).toBe('2026-10-05') // Monday
  })

  it('writes a date the Serbian way', () => {
    expect(srDate('2026-10-07')).toBe('07.10.2026.')
  })
})

describe('getRate', () => {
  it('is 1 for RSD without asking anybody', async () => {
    const f = nbs({});
    (global as any).fetch = f
    await expect(getRate('RSD', '2026-10-07')).resolves.toMatchObject({ rate: 1, to: 'RSD', isFallback: false })
    expect(f).not.toHaveBeenCalled()
  })

  it('returns RSD per unit for EUR and USD', async () => {
    (global as any).fetch = nbs({ EUR: 117.17, USD: 100.42 })
    expect((await getRate('EUR', '2026-10-07')).rate).toBe(117.17)
    expect((await getRate('USD', '2026-10-07')).rate).toBe(100.42)
  })

  it('divides by parity', async () => {
    (global as any).fetch = nbs({ JPY: 68.5 }, { parity: 100 })
    expect((await getRate('JPY', '2026-10-07')).rate).toBeCloseTo(0.685, 6)
  })

  it('caches a good answer', async () => {
    const f = nbs({ EUR: 117.17 });
    (global as any).fetch = f
    await getRate('EUR', '2026-10-07')
    await getRate('EUR', '2026-10-07')
    expect(f).toHaveBeenCalledTimes(1)
  })

  it('throws instead of falling back to a made-up rate', async () => {
    (global as any).fetch = nbs({ EUR: null })
    await expect(getRate('EUR', '2026-10-07')).rejects.toThrow(RateUnavailableError)
    ;(global as any).fetch = nbs({})
    await expect(getRate('USD', '2026-10-07')).rejects.toThrow('Kurs NBS nije dostupan za 07.10.2026. (USD)')
  })

  it('does not cache a failure', async () => {
    (global as any).fetch = nbs({ EUR: null })
    await expect(getRate('EUR', '2026-10-07')).rejects.toThrow()
    ;(global as any).fetch = nbs({ EUR: 117.17 })
    expect((await getRate('EUR', '2026-10-07')).rate).toBe(117.17)
  })

  it('asks only the NBS proxy, never the old exchange-rate fallback', async () => {
    const f = nbs({ EUR: null });
    (global as any).fetch = f
    await expect(getRate('EUR', '2026-10-07')).rejects.toThrow()
    expect(f.mock.calls.every(c => String(c[0]).includes('/nbs-rate'))).toBe(true)
  })
})

describe('getRatesForDate', () => {
  it('returns RSD per USD and RSD per EUR', async () => {
    (global as any).fetch = nbs({ EUR: 117.17, USD: 100.42 })
    await expect(getRatesForDate('2026-10-07')).resolves.toMatchObject({
      usdRsdRate: 100.42, eurRsdRate: 117.17, date: '2026-10-07', isFallback: false,
    })
  })

  it('throws when either is missing', async () => {
    (global as any).fetch = nbs({ EUR: 117.17, USD: null })
    await expect(getRatesForDate('2026-10-07')).rejects.toThrow(RateUnavailableError)
  })
})

describe('the deprecated USD helpers', () => {
  it('still compute what they always did', () => {
    expect(perUsdFromRsd(117.4, 101)).toBeCloseTo(0.8603, 4)
    expect(convertToUSD(1200, 'USD', 1)).toBe(1200)
    expect(convertToUSD(500, 'EUR', 0)).toBe(500)
  })
})

describe('the day a rate is from (quotedOn)', () => {
  // Payloads shaped EXACTLY as kurs.resenje.org answers through `nbs-rate`:
  // `date` ECHOES the day that was asked, `date_from` is the day the list
  // really applies from. A day with no list of its own (a weekend, a holiday,
  // a day not yet published) is answered with the latest list.
  type Answer = { date: string; date_from?: string }
  let answers: Record<string, Answer>
  let calls: string[]

  const service = () => {
    (global as any).fetch = async (url: string) => {
      calls.push(String(url))
      const cur = /currency=(\w+)/.exec(url)![1].toUpperCase()
      const a = answers[cur]
      return {
        ok: true, status: 200,
        json: async () => ({
          code: cur, date: a.date, ...(a.date_from === undefined ? {} : { date_from: a.date_from }),
          number: 1, parity: 1,
          exchange_buy: cur === 'EUR' ? 116.85 : 99.7,
          exchange_middle: cur === 'EUR' ? 117.2 : 100.0,
          exchange_sell: cur === 'EUR' ? 117.55 : 100.3,
        }),
      }
    }
  }
  const both = (a: Answer) => { answers = { EUR: a, USD: a } }

  beforeEach(() => { calls = []; service() })

  it('a weekday 20th, once published, is quoted on the 20th and kept', async () => {
    both({ date: '2026-11-20', date_from: '2026-11-20' })
    const r = await getRatesForDate('2026-11-20')
    expect(r.quotedOn).toBe('2026-11-20')
    expect(r.eurRsdRate).toBe(117.2)
    await getRatesForDate('2026-11-20')
    expect(calls).toHaveLength(2)   // EUR and USD once each: the second ask is the cache's
  })

  it('asked the 20th on the 3rd: the service echoes the 20th, the list is the 2nd\'s, and it is not kept', async () => {
    both({ date: '2026-11-20', date_from: '2026-11-02' })
    const r = await getRatesForDate('2026-11-20')
    expect(r.date).toBe('2026-11-20')
    expect(r.quotedOn).toBe('2026-11-02')
    // On the 20th itself the page must ask again, not be served the 2nd's list.
    both({ date: '2026-11-20', date_from: '2026-11-20' })
    expect((await getRatesForDate('2026-11-20')).quotedOn).toBe('2026-11-20')
    expect(calls).toHaveLength(4)
  })

  it('a day answered with the list of the day before is quoted on that day', async () => {
    both({ date: '2026-04-20', date_from: '2026-04-19' })
    const r = await getRatesForDate('2026-04-20')
    expect(r.date).toBe('2026-04-20')
    expect(r.quotedOn).toBe('2026-04-19')
  })

  it('a Saturday 20th is asked as the Friday, and quoted on it', async () => {
    both({ date: '2026-06-19', date_from: '2026-06-19' })
    const r = await getRatesForDate('2026-06-20')
    expect(calls[0]).toContain('date=2026-06-19')
    expect(r.quotedOn).toBe('2026-06-19')
  })

  it('no date_from is no quoted day, whatever date says, and nothing is kept', async () => {
    both({ date: '2026-11-20' })
    expect((await getRatesForDate('2026-11-20')).quotedOn).toBeUndefined()
    await getRatesForDate('2026-11-20')
    expect(calls).toHaveLength(4)
  })

  it('a date_from that is not a real YYYY-MM-DD is no quoted day', async () => {
    both({ date: '2026-11-20', date_from: '2026-02-30' })
    expect((await getRatesForDate('2026-11-20')).quotedOn).toBeUndefined()
    clearRateCache()
    both({ date: '2026-11-20', date_from: 'yesterday' })
    expect((await getRatesForDate('2026-11-20')).quotedOn).toBeUndefined()
  })

  it('EUR and USD from different days give the earlier; one without a day gives none', async () => {
    answers = { EUR: { date: '2026-11-20', date_from: '2026-11-19' }, USD: { date: '2026-11-20', date_from: '2026-11-17' } }
    expect((await getRatesForDate('2026-11-20')).quotedOn).toBe('2026-11-17')
    clearRateCache()
    answers = { EUR: { date: '2026-11-20' }, USD: { date: '2026-11-20', date_from: '2026-11-20' } }
    expect((await getRatesForDate('2026-11-20')).quotedOn).toBeUndefined()
  })

  it('getRate says the day too', async () => {
    both({ date: '2026-11-20', date_from: '2026-11-18' })
    expect((await getRate('EUR', '2026-11-20')).quotedOn).toBe('2026-11-18')
  })
})
