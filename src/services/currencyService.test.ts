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
    return { ok: true, status: 200, json: async () => ({ exchange_middle: middle, parity: opts.parity ?? 1, date }) }
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
