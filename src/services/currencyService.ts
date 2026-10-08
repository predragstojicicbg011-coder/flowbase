// currencyService.ts
// Koristi Supabase Edge Function kao proxy za kurs.resenje.org (NBS zvanični srednji kurs)

declare const process: { env: Record<string, string | undefined> }

export interface ExchangeRate {
  from: string
  to: string
  /**
   * Units of this currency per 1 USD — the number to divide an amount by.
   *
   * This is what `exchange_rate` means everywhere it is stored, and what every
   * caller has always passed to convertToUSD. For RSD it was right, because
   * `lookup` below asks NBS for USD and gets RSD-per-USD. For EUR it was not:
   * `rate` held RSD-per-EUR (117.4), so EUR 1,200 was divided by 117.4 and
   * booked as $10.22 instead of $1,394.91 — out by the wrong rate twice over.
   *
   * It now means one thing for every currency.
   */
  rate: number
  /** RSD per unit of this currency — NBS exchange_middle, for display only. */
  rsdRate: number
  /** RSD per USD on this date. */
  usdRate: number
  date: string
  source: string
  isFallback: boolean   // true = not an official rate, a hardcoded value
}

const rateCache: Map<string, ExchangeRate> = new Map()

// Projekat je Create React App (webpack), ne Vite — cita se samo process.env
// sa REACT_APP_ prefiksom. Raniji `import.meta.env` fallback je bio mrtav kod
// i uz to je onemogucavao pokretanje testova (jest ne parsira import.meta).
const SUPABASE_URL = process.env.REACT_APP_SUPABASE_URL || ''
const SUPABASE_ANON_KEY = process.env.REACT_APP_SUPABASE_ANON_KEY || ''
const NBS_PROXY = `${SUPABASE_URL}/functions/v1/nbs-rate`
const FALLBACK_PROXY = `${SUPABASE_URL}/functions/v1/exchange-rate`

function toIsoDate(date: string): string {
  if (!date) return new Date().toISOString().split('T')[0]
  if (/^\d{4}-\d{2}-\d{2}$/.test(date)) return date
  const parts = date.split('.')
  if (parts.length === 3) return `${parts[2]}-${parts[1]}-${parts[0]}`
  return date
}

function nearestBusinessDay(isoDate: string): string {
  const d = new Date(isoDate)
  const day = d.getDay()
  if (day === 0) d.setDate(d.getDate() - 2) // nedelja → petak
  if (day === 6) d.setDate(d.getDate() - 1) // subota → petak
  return d.toISOString().split('T')[0]
}

async function fetchNbsRate(currency: string, isoDate: string): Promise<{ rsdRate: number; source: string }> {
  const url = `${NBS_PROXY}?currency=${currency.toLowerCase()}&date=${isoDate}`

  const response = await fetch(url, {
    headers: {
      'apikey': SUPABASE_ANON_KEY,
      'Authorization': `Bearer ${SUPABASE_ANON_KEY}`
    }
  })

  if (!response.ok) throw new Error(`NBS proxy: ${response.status}`)

  const data = await response.json()
  if (data.error) throw new Error(`NBS proxy error: ${data.error}`)
  if (!data.exchange_middle) throw new Error('Nema exchange_middle u odgovoru')

  return {
    rsdRate: data.exchange_middle / (data.parity || 1),
    source: `NBS (kurs.resenje.org) za ${data.date}`
  }
}

// Ide preko Edge Function-a, ne direktno na exchangerate-api.
// API kljuc zivi u Supabase secrets i nikad ne ulazi u frontend bundle —
// ranije je citan iz REACT_APP_EXCHANGE_API_KEY i bio je javno vidljiv.
async function fetchFallbackRate(currency: string): Promise<{ rsdRate: number; source: string }> {
  const response = await fetch(`${FALLBACK_PROXY}?currency=${encodeURIComponent(currency)}`, {
    headers: {
      apikey: SUPABASE_ANON_KEY,
      Authorization: `Bearer ${SUPABASE_ANON_KEY}`,
    },
  })

  if (!response.ok) throw new Error(`exchange-rate proxy: ${response.status}`)

  const data = await response.json()
  if (data.error) throw new Error(`exchange-rate proxy: ${data.error}`)
  if (typeof data.rsdRate !== 'number' || !isFinite(data.rsdRate) || data.rsdRate <= 0) {
    throw new Error('exchange-rate proxy: neupotrebljiv kurs')
  }

  return { rsdRate: data.rsdRate, source: 'Fallback (exchangerate-api.com)' }
}

export async function getRate(
  currency: string,
  date?: string,
  _isIndexed: boolean = false
): Promise<ExchangeRate> {
  if (currency === 'USD') {
    const d = date ? toIsoDate(date) : new Date().toISOString().split('T')[0]
    return { from: 'USD', to: 'USD', rate: 1, rsdRate: 1, usdRate: 1, date: d, source: 'N/A', isFallback: false }
  }

  const isoDate = nearestBusinessDay(toIsoDate(date || new Date().toISOString().split('T')[0]))
  const cacheKey = `${currency}_${isoDate}`

  if (rateCache.has(cacheKey)) return rateCache.get(cacheKey)!

  let rsdRate: number
  let source: string
  let isFallback = false

  // A RSD-denominated document still has to be converted to USD, and
  // convertToUSD divides by this rate — so what it needs is RSD per USD, not
  // "the RSD rate of RSD", which is what asking NBS for `rsd` means. That call
  // fails, the code falls through to a manual prompt that does not say which
  // rate it wants, and in Serbian practice "kurs" means the EUR rate. That is
  // how payroll ended up converted at 117 instead of ~101 — every amount_usd
  // on those filings is about 14% short.
  const lookup = currency === 'RSD' ? 'USD' : currency

  try {
    const result = await fetchNbsRate(lookup, isoDate)
    rsdRate = result.rsdRate
    source = result.source
  } catch (err) {
    console.warn(`NBS rate fetch failed za ${currency} ${isoDate}:`, err)
    try {
      const result = await fetchFallbackRate(lookup)
      rsdRate = result.rsdRate
      source = result.source
    } catch (err2) {
      console.error('Fallback rate fetch failed:', err2)
      const hardcoded: Record<string, number> = { USD: 101.0, RSD: 101.0, EUR: 117.0, AED: 27.2 }
      rsdRate = hardcoded[lookup] || 101.0
      source = '⚠ HARDCODED FALLBACK — nije zvanicni kurs, proveri rucno'
      isFallback = true
      console.error(
        `[currencyService] Nema zvanicnog kursa za ${currency} ${isoDate}. ` +
        `Koristi se hardkodovana vrednost ${rsdRate}. Iznos NECE biti tacan.`
      )
    }
  }

  // Every foreign currency needs the RSD/USD rate, not just EUR. NBS quotes
  // RSD per unit, so going from EUR to USD means passing through RSD — and
  // without the USD leg the two legs cancel wrongly. This used to run for EUR
  // alone, which left AED and GBP with usdRate set to their own RSD rate and
  // a units-per-USD of 1.
  let usdRate = rsdRate
  if (currency !== 'RSD') {
    try {
      const usdResult = await fetchNbsRate('USD', isoDate)
      usdRate = usdResult.rsdRate
    } catch {
      usdRate = 100.0
      isFallback = true
      console.error(`[currencyService] No RSD/USD rate for ${isoDate}; using 100.0.`)
    }
  }

  const exchangeRate: ExchangeRate = {
    from: currency,
    to: 'USD',
    // RSD is already quoted against USD by the `lookup` swap above, so its
    // rsdRate IS units-per-USD. Every other currency has to cross through RSD.
    rate: currency === 'RSD' ? rsdRate : perUsdFromRsd(rsdRate, usdRate),
    rsdRate,
    usdRate,
    date: isoDate,
    // The rate shown for a foreign currency is now per USD, so 0.86 appears
    // where a Serbian reader expects 117.4. Both NBS quotes are named here so
    // the number on screen can be checked against the ones it came from.
    source: currency === 'RSD'
      ? source
      : `${source} — ${currency} ${rsdRate.toFixed(4)} / USD ${usdRate.toFixed(4)} RSD`,
    isFallback
  }

  // Fallback se NE kesira — inace bi jedan neuspeli poziv zakljucao pogresan
  // kurs za celu sesiju i sledeci pokusaj ga nikad ne bi ispravio.
  if (!isFallback) rateCache.set(cacheKey, exchangeRate)
  return exchangeRate
}

/**
 * Units of `currency` per 1 USD, from the two NBS quotes.
 *
 * NBS publishes RSD per unit, so: 1 USD = usdRsd RSD, 1 unit = rsdRate RSD,
 * therefore 1 USD = usdRsd / rsdRate units. EUR at 117.4 and USD at 101 gives
 * 0.8603 EUR to the dollar.
 */
export function perUsdFromRsd(rsdRate: number, usdRsdRate: number): number {
  if (!rsdRate || !usdRsdRate) return 1
  return usdRsdRate / rsdRate
}

/**
 * An amount in its own currency, in USD.
 *
 * `rate` is units of `currency` per USD — `ExchangeRate.rate`, and the same
 * number stored as `exchange_rate`. Dividing is right for every currency
 * once the rate means the same thing for every currency.
 *
 * The old version listed the currencies it knew and returned the amount
 * unchanged for the rest, so a GBP amount was booked as though a pound were a
 * dollar. Anything that is not USD is now converted, whatever it is.
 */
export function convertToUSD(amount: number, currency: string, rate: number): number {
  if (currency === 'USD') return amount
  if (!rate || !isFinite(rate)) return amount
  return amount / rate
}

export function convertToEUR(amountUsd: number, eurRsdRate: number, usdRsdRate: number): number {
  if (!eurRsdRate || !usdRsdRate) return amountUsd / 1.1
  const amountRsd = amountUsd * usdRsdRate
  return amountRsd / eurRsdRate
}

export async function getRatesForDate(date: string): Promise<{
  usdRsdRate: number
  eurRsdRate: number
  date: string
  source: string
  isFallback: boolean
}> {
  const isoDate = nearestBusinessDay(toIsoDate(date))

  try {
    const [usdResult, eurResult] = await Promise.all([
      fetchNbsRate('USD', isoDate),
      fetchNbsRate('EUR', isoDate)
    ])
    return {
      usdRsdRate: usdResult.rsdRate,
      eurRsdRate: eurResult.rsdRate,
      date: isoDate,
      source: usdResult.source,
      isFallback: false
    }
  } catch (err) {
    console.error(
      `[currencyService] getRatesForDate(${isoDate}) neuspesan — koriste se ` +
      `hardkodovane vrednosti USD=100.0 EUR=117.0. Iznosi NECE biti tacni.`, err
    )
    return {
      usdRsdRate: 100.0, eurRsdRate: 117.0, date: isoDate,
      source: '⚠ HARDCODED FALLBACK — nije zvanicni kurs, proveri rucno',
      isFallback: true,
    }
  }
}