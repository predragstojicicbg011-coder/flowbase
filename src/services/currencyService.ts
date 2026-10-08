// currencyService.ts
//
// NBS middle rates, through the `nbs-rate` Supabase Edge Function (a CORS
// proxy for kurs.resenje.org).
//
// EVERY RATE HERE IS RSD PER 1 UNIT of the currency asked about — what NBS
// publishes, and what `exchange_rate` means on every money row. RSD is 1.
//
// There is no fallback any more. Mintflow fell back to a second proxy and
// then to hardcoded rates (USD 101, EUR 117), which booked a made-up figure
// that looked exactly like a real one. An unavailable rate now throws
// `RateUnavailableError` ("Kurs NBS nije dostupan za …"), which the dialog
// shows; the person can retry or type the rate. The `exchange-rate` function
// source is kept in supabase/functions but nothing calls it.
//
// Bookkeeping code should not call this module directly: use
// `bookAmounts.ts`, which turns these rates into the stored columns.

declare const process: { env: Record<string, string | undefined> }

/** Thrown whenever a rate the books need is not there. Its message is for the screen. */
export class RateUnavailableError extends Error {
  constructor(message: string, public date?: string, public currency?: string) {
    super(message)
    this.name = 'RateUnavailableError'
  }
}

/** `2026-10-03` → `03.10.2026.`, the way a Serbian reader writes a date. */
export function srDate(isoDate: string): string {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(isoDate || '')
  return m ? `${m[3]}.${m[2]}.${m[1]}.` : String(isoDate)
}

export function nbsUnavailable(isoDate: string, currency?: string): RateUnavailableError {
  return new RateUnavailableError(
    `Kurs NBS nije dostupan za ${srDate(isoDate)}${currency ? ` (${currency})` : ''}`,
    isoDate, currency)
}

export interface ExchangeRate {
  from: string
  /** Always 'RSD': the rate is quoted in dinars. */
  to: string
  /** RSD per 1 unit of `from` — what is stored as `exchange_rate`. 1 for RSD. */
  rate: number
  /** The same number as `rate`; kept so older call sites compile. */
  rsdRate: number
  /** The NBS list the rate came from (may be earlier than asked, over a weekend). */
  date: string
  source: string
  /**
   * @deprecated Always false: nothing falls back to a made-up rate any more —
   * a missing rate throws `RateUnavailableError`.
   */
  isFallback: boolean
}

interface NbsQuote { rsdRate: number; date: string; source: string }

// Successful quotes only. A failure is not cached, so the next try asks again.
const rateCache: Map<string, NbsQuote> = new Map()

/** For tests. */
export function clearRateCache(): void {
  rateCache.clear()
}

// Projekat je Create React App (webpack), ne Vite — cita se samo process.env
// sa REACT_APP_ prefiksom.
const SUPABASE_URL = process.env.REACT_APP_SUPABASE_URL || ''
const SUPABASE_ANON_KEY = process.env.REACT_APP_SUPABASE_ANON_KEY || ''
const NBS_PROXY = `${SUPABASE_URL}/functions/v1/nbs-rate`

/** Accepts `2026-10-03` or `03.10.2026`; empty means today. */
export function toIsoDate(date?: string | null): string {
  if (!date) return new Date().toISOString().split('T')[0]
  if (/^\d{4}-\d{2}-\d{2}$/.test(date)) return date
  const parts = date.replace(/\.$/, '').split('.')
  if (parts.length === 3) return `${parts[2]}-${parts[1].padStart(2, '0')}-${parts[0].padStart(2, '0')}`
  return date
}

/**
 * Saturday and Sunday step back to Friday. NBS publishes nothing at the
 * weekend; the edge function also steps back up to three days for holidays.
 * UTC throughout, so the weekday does not depend on the viewer's time zone.
 */
export function nearestBusinessDay(isoDate: string): string {
  const d = new Date(`${isoDate}T00:00:00Z`)
  if (isNaN(d.getTime())) return isoDate
  const day = d.getUTCDay()
  if (day === 0) d.setUTCDate(d.getUTCDate() - 2) // nedelja → petak
  if (day === 6) d.setUTCDate(d.getUTCDate() - 1) // subota → petak
  return d.toISOString().split('T')[0]
}

async function fetchNbsRate(currency: string, isoDate: string): Promise<NbsQuote> {
  const key = `${currency.toUpperCase()}_${isoDate}`
  const cached = rateCache.get(key)
  if (cached) return cached

  const url = `${NBS_PROXY}?currency=${currency.toLowerCase()}&date=${isoDate}`
  let data: any
  try {
    const response = await fetch(url, {
      headers: {
        'apikey': SUPABASE_ANON_KEY,
        'Authorization': `Bearer ${SUPABASE_ANON_KEY}`
      }
    })
    if (!response.ok) throw new Error(`NBS proxy: ${response.status}`)
    data = await response.json()
  } catch (err) {
    console.warn(`[currencyService] NBS ${currency} ${isoDate}:`, err)
    throw nbsUnavailable(isoDate, currency.toUpperCase())
  }

  const middle = Number(data?.exchange_middle)
  const parity = Number(data?.parity) || 1
  if (data?.error || !Number.isFinite(middle) || middle <= 0) {
    console.warn(`[currencyService] NBS ${currency} ${isoDate}: no usable exchange_middle`, data)
    throw nbsUnavailable(isoDate, currency.toUpperCase())
  }

  const rateDate = typeof data.date === 'string' && data.date ? data.date : isoDate
  const quote: NbsQuote = {
    rsdRate: middle / parity,
    date: rateDate,
    source: `NBS srednji kurs (kurs.resenje.org) za ${srDate(rateDate)}`,
  }
  rateCache.set(key, quote)
  return quote
}

/**
 * RSD per 1 unit of `currency` on `date` (weekends step back to Friday).
 *
 * RSD returns 1 without a call. Throws `RateUnavailableError` when NBS has
 * nothing — never a guessed rate.
 */
export async function getRate(
  currency: string,
  date?: string,
  _isIndexed: boolean = false
): Promise<ExchangeRate> {
  const cur = (currency || '').toUpperCase()
  const isoDate = nearestBusinessDay(toIsoDate(date))

  if (cur === 'RSD') {
    return { from: 'RSD', to: 'RSD', rate: 1, rsdRate: 1, date: isoDate, source: 'RSD', isFallback: false }
  }

  const quote = await fetchNbsRate(cur, isoDate)
  return {
    from: cur,
    to: 'RSD',
    rate: quote.rsdRate,
    rsdRate: quote.rsdRate,
    date: quote.date,
    source: quote.source,
    isFallback: false,
  }
}

/**
 * Both rates a book entry needs on one date: RSD per USD and RSD per EUR.
 * Throws `RateUnavailableError` if either is missing.
 */
export async function getRatesForDate(date: string): Promise<{
  usdRsdRate: number
  eurRsdRate: number
  date: string
  source: string
  /** @deprecated Always false; a missing rate throws instead. */
  isFallback: boolean
}> {
  const isoDate = nearestBusinessDay(toIsoDate(date))
  const [usd, eur] = await Promise.all([
    fetchNbsRate('USD', isoDate),
    fetchNbsRate('EUR', isoDate),
  ])
  return {
    usdRsdRate: usd.rsdRate,
    eurRsdRate: eur.rsdRate,
    date: eur.date,
    source: eur.source,
    isFallback: false,
  }
}

// ── Mintflow's USD reporting, kept only so untouched call sites compile ─────

/**
 * @deprecated USD is no longer the reporting currency — use `bookAmounts`
 * (`src/services/bookAmounts.ts`). Units of a currency per 1 USD.
 */
export function perUsdFromRsd(rsdRate: number, usdRsdRate: number): number {
  if (!rsdRate || !usdRsdRate) return 1
  return usdRsdRate / rsdRate
}

/**
 * @deprecated USD is no longer the reporting currency — use `bookAmounts`
 * (`src/services/bookAmounts.ts`). Divides by a units-per-USD rate, which
 * `getRate` no longer returns.
 */
export function convertToUSD(amount: number, currency: string, rate: number): number {
  if (currency === 'USD') return amount
  if (!rate || !isFinite(rate)) return amount
  return amount / rate
}

/**
 * @deprecated Use `rsdToEur` from `src/services/bookAmounts.ts`.
 */
export function convertToEUR(amountUsd: number, eurRsdRate: number, usdRsdRate: number): number {
  if (!eurRsdRate || !usdRsdRate) return NaN
  return (amountUsd * usdRsdRate) / eurRsdRate
}
