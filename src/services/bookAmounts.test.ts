import {
  DOCUMENT_CURRENCIES, BOOK_CURRENCY, INDEX_CURRENCY, isDocumentCurrency,
  round2, rateFor, bookAmounts, bookAmountsAtRate, getBookRates, toBookAmounts,
  rowRates, partBookAmounts, partFromRsd, rsdToEur, eurToRsd, RateUnavailableError,
} from './bookAmounts'
import { clearRateCache } from './currencyService'

// A representative NBS day. Both are RSD per 1 unit.
const RATES = { eurRate: 117.1734, usdRate: 100.4215 }

describe('the currencies', () => {
  it('allows RSD, EUR and USD as document currencies, and nothing else', () => {
    expect([...DOCUMENT_CURRENCIES]).toEqual(['RSD', 'EUR', 'USD'])
    expect(isDocumentCurrency('EUR')).toBe(true)
    expect(isDocumentCurrency('AED')).toBe(false)
    expect(isDocumentCurrency('GBP')).toBe(false)
    expect(isDocumentCurrency(undefined)).toBe(false)
  })

  it('keeps the books in RSD and indexes them in EUR', () => {
    expect(BOOK_CURRENCY).toBe('RSD')
    expect(INDEX_CURRENCY).toBe('EUR')
  })
})

describe('round2', () => {
  it('rounds half away from zero, like Postgres', () => {
    expect(round2(1.005)).toBe(1.01)
    expect(round2(-1.005)).toBe(-1.01)
    expect(round2(2.345)).toBe(2.35)
    expect(round2(-2.345)).toBe(-2.35)
  })

  it('never returns minus zero', () => {
    expect(Object.is(round2(-0.001), 0)).toBe(true)
  })

  it('copes with numbers already written in exponent form', () => {
    expect(round2(1e-7)).toBe(0)
    expect(round2(123456789012.345)).toBe(123456789012.35)
  })
})

describe('rateFor', () => {
  it('is 1 for RSD and the day\'s rate otherwise', () => {
    expect(rateFor('RSD', RATES)).toBe(1)
    expect(rateFor('EUR', RATES)).toBe(117.1734)
    expect(rateFor('USD', RATES)).toBe(100.4215)
  })

  it('refuses a currency that is not a document currency', () => {
    expect(() => rateFor('AED', RATES)).toThrow(RateUnavailableError)
  })
})

describe('bookAmounts', () => {
  it('books RSD at 1 and gives its EUR at the day\'s rate', () => {
    expect(bookAmounts(235000, 'RSD', RATES)).toEqual({
      exchange_rate: 1, eur_rate: 117.1734, amount_rsd: 235000, amount_eur: 2005.57,
    })
  })

  it('keeps a EUR document\'s EUR figure exactly as written', () => {
    const b = bookAmounts(1234.56, 'EUR', RATES)
    expect(b.amount_eur).toBe(1234.56)
    expect(b.exchange_rate).toBe(b.eur_rate)
    expect(b.amount_rsd).toBe(144657.59)
  })

  it('does not drift a cent on EUR over many figures', () => {
    for (let cents = 1; cents < 5000; cents += 37) {
      const eur = cents / 100 + 1000
      expect(bookAmounts(eur, 'EUR', { eurRate: 117.3333, usdRate: 0 }).amount_eur).toBe(round2(eur))
    }
  })

  it('books USD through RSD, then to EUR from the rounded RSD', () => {
    const b = bookAmounts(1000, 'USD', RATES)
    expect(b.exchange_rate).toBe(100.4215)
    expect(b.amount_rsd).toBe(100421.5)
    expect(b.amount_eur).toBe(round2(100421.5 / 117.1734))
    expect(b.amount_eur).toBe(857.03)
  })

  it('rounds the RSD figure to the para', () => {
    expect(bookAmounts(0.333, 'RSD', RATES).amount_rsd).toBe(0.33)
    expect(bookAmounts(10.01, 'USD', RATES).amount_rsd).toBe(1005.22)
  })

  it('books a credit note as the exact mirror of the invoice', () => {
    for (const c of DOCUMENT_CURRENCIES) {
      const plus = bookAmounts(1234.565, c, RATES)
      const minus = bookAmounts(-1234.565, c, RATES)
      expect(minus.amount_rsd).toBe(-plus.amount_rsd)
      expect(minus.amount_eur).toBe(-plus.amount_eur)
      expect(minus.exchange_rate).toBe(plus.exchange_rate)
    }
  })

  it('books zero as zero', () => {
    expect(bookAmounts(0, 'USD', RATES)).toMatchObject({ amount_rsd: 0, amount_eur: 0 })
    expect(bookAmounts(0, 'EUR', RATES)).toMatchObject({ amount_rsd: 0, amount_eur: 0 })
  })

  it('does not need a USD rate for an RSD or EUR document', () => {
    expect(() => bookAmounts(100, 'RSD', { eurRate: 117, usdRate: 0 })).not.toThrow()
    expect(() => bookAmounts(100, 'EUR', { eurRate: 117, usdRate: NaN })).not.toThrow()
  })

  it('throws rather than guess when a rate is missing', () => {
    expect(() => bookAmounts(100, 'USD', { eurRate: 117, usdRate: 0 })).toThrow(RateUnavailableError)
    expect(() => bookAmounts(100, 'RSD', { eurRate: 0, usdRate: 100 })).toThrow(RateUnavailableError)
    expect(() => bookAmounts(100, 'EUR', { eurRate: NaN, usdRate: 100 })).toThrow(/EUR/)
  })

  it('throws on an amount that is not a number', () => {
    expect(() => bookAmounts(NaN, 'RSD', RATES)).toThrow(RateUnavailableError)
  })

  it('accepts the currency in lower case', () => {
    expect(bookAmounts(1, 'eur', RATES).amount_eur).toBe(1)
  })
})

describe('bookAmountsAtRate', () => {
  it('uses a rate typed by hand', () => {
    expect(bookAmountsAtRate(100, 'USD', 101, 117)).toEqual({
      exchange_rate: 101, eur_rate: 117, amount_rsd: 10100, amount_eur: 86.32,
    })
  })

  it('ignores whatever is passed as RSD\'s own rate', () => {
    expect(bookAmountsAtRate(500, 'RSD', 117, 117).exchange_rate).toBe(1)
  })

  it('takes EUR\'s rate from eurRate when no own rate is given', () => {
    expect(bookAmountsAtRate(10, 'EUR', null, 117.5).exchange_rate).toBe(117.5)
  })

  it('refuses a EUR document whose two rates disagree', () => {
    expect(() => bookAmountsAtRate(10, 'EUR', 117, 118)).toThrow(RateUnavailableError)
  })

  it('refuses a foreign document without its rate', () => {
    expect(() => bookAmountsAtRate(10, 'USD', null, 117)).toThrow(/USD/)
  })
})

describe('rowRates', () => {
  it('fills in RSD\'s exchange_rate of 1', () => {
    expect(rowRates({ currency: 'RSD', exchange_rate: null, eur_rate: 117 })).toEqual({ exchangeRate: 1, eurRate: 117 })
  })

  it('lets a EUR row\'s two rates stand in for each other', () => {
    expect(rowRates({ currency: 'EUR', exchange_rate: 117, eur_rate: null })).toEqual({ exchangeRate: 117, eurRate: 117 })
    expect(rowRates({ currency: 'EUR', exchange_rate: null, eur_rate: 117 })).toEqual({ exchangeRate: 117, eurRate: 117 })
  })

  it('reads numeric columns that arrive as strings', () => {
    expect(rowRates({ currency: 'USD', exchange_rate: '100.5', eur_rate: '117.25' })).toEqual({ exchangeRate: 100.5, eurRate: 117.25 })
  })

  it('throws when a row is missing what it needs', () => {
    expect(() => rowRates({ currency: 'USD', exchange_rate: null, eur_rate: 117 })).toThrow(RateUnavailableError)
    expect(() => rowRates({ currency: 'RSD', eur_rate: null })).toThrow(RateUnavailableError)
  })
})

describe('partBookAmounts', () => {
  const usdInvoice = { currency: 'USD', exchange_rate: 100.4215, eur_rate: 117.1734 }
  const eurInvoice = { currency: 'EUR', exchange_rate: 117.1734, eur_rate: 117.1734 }

  it('books a part at the parent\'s stored rates', () => {
    expect(partBookAmounts(400, usdInvoice)).toEqual({ amount_rsd: 40168.6, amount_eur: 342.81 })
  })

  it('keeps a EUR part\'s EUR exact', () => {
    expect(partBookAmounts(333.33, eurInvoice).amount_eur).toBe(333.33)
  })

  it('books an RSD part at 1', () => {
    expect(partBookAmounts(1000, { currency: 'RSD', exchange_rate: 1, eur_rate: 117 })).toEqual({ amount_rsd: 1000, amount_eur: 8.55 })
  })

  it('mirrors a negative part', () => {
    expect(partBookAmounts(-400, usdInvoice)).toEqual({ amount_rsd: -40168.6, amount_eur: -342.81 })
  })

  it('throws when the parent has no rate', () => {
    expect(() => partBookAmounts(10, { currency: 'USD', exchange_rate: null, eur_rate: null })).toThrow(RateUnavailableError)
  })
})

describe('partFromRsd', () => {
  it('expresses a dinar payment in the invoice\'s own currency', () => {
    expect(partFromRsd(11717.34, { currency: 'EUR', exchange_rate: 117.1734, eur_rate: 117.1734 }))
      .toEqual({ amount: 100, amount_rsd: 11717.34, amount_eur: 100 })
  })

  it('is the figure itself for an RSD invoice', () => {
    expect(partFromRsd(5000, { currency: 'RSD', exchange_rate: 1, eur_rate: 125 }))
      .toEqual({ amount: 5000, amount_rsd: 5000, amount_eur: 40 })
  })

  it('handles USD invoices through their own rate', () => {
    expect(partFromRsd(10042.15, { currency: 'USD', exchange_rate: 100.4215, eur_rate: 117.1734 }))
      .toEqual({ amount: 100, amount_rsd: 10042.15, amount_eur: 85.7 })
  })
})

describe('rsdToEur and eurToRsd', () => {
  it('convert at the row\'s eur_rate', () => {
    expect(rsdToEur(117173.4, 117.1734)).toBe(1000)
    expect(eurToRsd(1000, 117.1734)).toBe(117173.4)
    expect(rsdToEur(-500, '125')).toBe(-4)
  })

  it('throw without a rate', () => {
    expect(() => rsdToEur(100, null)).toThrow(RateUnavailableError)
    expect(() => eurToRsd(100, 0)).toThrow(RateUnavailableError)
  })
})

describe('getBookRates and toBookAmounts', () => {
  const realFetch = (global as any).fetch

  beforeEach(() => clearRateCache())
  afterEach(() => { (global as any).fetch = realFetch })

  function nbs(rates: Record<string, number | null>) {
    return jest.fn(async (url: string) => {
      const cur = /currency=(\w+)/.exec(url)![1].toUpperCase()
      const date = /date=([\d-]+)/.exec(url)![1]
      const middle = rates[cur]
      if (middle == null) return { ok: false, status: 500, json: async () => ({ error: 'none' }) }
      return { ok: true, status: 200, json: async () => ({ exchange_middle: middle, parity: 1, date }) }
    })
  }

  it('returns both rates for the date', async () => {
    (global as any).fetch = nbs({ EUR: 117.17, USD: 100.42 })
    await expect(getBookRates('2026-10-07')).resolves.toMatchObject({
      date: '2026-10-07', eurRate: 117.17, usdRate: 100.42,
    })
  })

  it('steps a Saturday back to Friday', async () => {
    const f = nbs({ EUR: 117.17, USD: 100.42 });
    (global as any).fetch = f
    const r = await getBookRates('2026-10-03')
    expect(r.date).toBe('2026-10-02')
    expect(f.mock.calls[0][0]).toContain('date=2026-10-02')
  })

  it('throws a message the dialog can show when NBS has nothing', async () => {
    (global as any).fetch = nbs({ EUR: 117.17, USD: null })
    const p = getBookRates('2026-10-07')
    await expect(p).rejects.toThrow(RateUnavailableError)
    await expect(getBookRates('2026-10-07')).rejects.toThrow('Kurs NBS nije dostupan za 07.10.2026.')
  })

  it('books an amount from the fetched rates', async () => {
    (global as any).fetch = nbs({ EUR: 117.17, USD: 100.42 })
    const b = await toBookAmounts(1000, 'USD', '2026-10-07')
    expect(b).toMatchObject({ exchange_rate: 100.42, eur_rate: 117.17, amount_rsd: 100420, amount_eur: 857.05 })
    expect(b.rates.date).toBe('2026-10-07')
  })

  it('refuses an unknown currency before asking NBS', async () => {
    const f = nbs({ EUR: 117.17, USD: 100.42 });
    (global as any).fetch = f
    await expect(toBookAmounts(1, 'GBP', '2026-10-07')).rejects.toThrow(RateUnavailableError)
    expect(f).not.toHaveBeenCalled()
  })
})
