// ─── bookAmounts ────────────────────────────────────────────────────────────
//
// How a money row is booked: in dinars, with euros beside them.
//
// FlowBase keeps its books in RSD (BOOK_CURRENCY), the functional currency of a
// Serbian company, and carries EUR (INDEX_CURRENCY) on every row because that
// is how contracts, loans and management read figures. A document may be in
// RSD, EUR or USD (DOCUMENT_CURRENCIES); USD is only ever the currency a
// document or payment is written in, never a reporting currency.
//
// ── THE CONTRACT ────────────────────────────────────────────────────────────
//
// Every money row stores:
//
//   amount         the document's own figure, in `currency`
//   currency       one of DOCUMENT_CURRENCIES
//   exchange_rate  RSD per 1 unit of `currency` — the NBS middle rate on the
//                  document date. RSD → 1. EUR → eur_rate.
//   eur_rate       RSD per 1 EUR on that same date
//   amount_rsd     round2(amount * exchange_rate)
//   amount_eur     round2(amount_rsd / eur_rate) — and for a EUR document
//                  exactly `amount`, so nothing drifts by a cent going
//                  EUR → RSD → EUR
//
// Rounding is half away from zero, the way Postgres `round(numeric, 2)` does,
// so a credit note (negative amount) books as the exact mirror of the invoice
// it reverses.
//
// Functions:
//
//   getBookRates(date)                        → { date, eurRate, usdRate, source }
//       NBS rates for a date (weekends step back to Friday, holidays up to
//       three days in the edge function). Throws RateUnavailableError —
//       "Kurs NBS nije dostupan za 03.10.2026." — rather than guess.
//
//   bookAmounts(amount, currency, rates)      → BookAmounts            (pure)
//       The four stored columns from fetched rates.
//
//   bookAmountsAtRate(amount, currency, exchangeRate, eurRate) → BookAmounts
//       The same from rates already in hand — typed by a person, or read off
//       a stored row. For EUR, exchangeRate and eurRate must agree; eurRate
//       wins when exchangeRate is missing.
//
//   toBookAmounts(amount, currency, date)     → BookAmounts & { rates }
//       getBookRates + bookAmounts, for a dialog's save path.
//
//   partBookAmounts(partAmount, parent)       → { amount_rsd, amount_eur }
//       A part of a document — an allocation, a P&L split line, an
//       instalment — in the parent's currency, booked at the parent's STORED
//       exchange_rate and eur_rate. Never refetch a rate for a part: the parts
//       must add up to the parent.
//
//   partFromRsd(amountRsd, parent)            → { amount, amount_rsd, amount_eur }
//       The other direction: a figure known in RSD (a dinar payment settling
//       a EUR invoice) expressed in the parent's own currency, which is what
//       `invoice_transaction_links.allocated_amount` holds.
//
//   rsdToEur(amountRsd, eurRate) / eurToRsd(amountEur, eurRate)
//       The single conversion a row's figures need once they are in RSD.
//
//   rowRates(row)                             → { exchangeRate, eurRate }
//       A stored row's rates, with RSD's exchange_rate of 1 filled in.
//
// Anything missing — a rate, a usable amount, a known currency — throws
// RateUnavailableError. A book figure computed from a guessed rate looks
// exactly like a correct one, which is why nothing here guesses.
//
// Display: `pickAmount(row, currency, base)` in
// src/contexts/DisplayCurrencyContext.tsx reads `${base}_rsd` / `${base}_eur`.

import { getRatesForDate, RateUnavailableError, nbsUnavailable, toIsoDate } from './currencyService'

export { RateUnavailableError } from './currencyService'

export const DOCUMENT_CURRENCIES = ['RSD', 'EUR', 'USD'] as const
export type DocumentCurrency = typeof DOCUMENT_CURRENCIES[number]

/** The currency the books are kept in. Every `amount_rsd` is in it. */
export const BOOK_CURRENCY = 'RSD' as const
/** The second currency every row carries, as `amount_eur`. */
export const INDEX_CURRENCY = 'EUR' as const

export function isDocumentCurrency(c: unknown): c is DocumentCurrency {
  return typeof c === 'string' && (DOCUMENT_CURRENCIES as readonly string[]).includes(c)
}

export interface BookRates {
  /** The NBS list the rates are from — a Friday, when a Sunday was asked. */
  date: string
  /** RSD per 1 EUR. */
  eurRate: number
  /** RSD per 1 USD. */
  usdRate: number
  source: string
}

/** The four columns every money row stores beside `amount` and `currency`. */
export interface BookAmounts {
  exchange_rate: number
  eur_rate: number
  amount_rsd: number
  amount_eur: number
}

/** What a stored row carries, for converting a part of it. */
export interface RatedRow {
  currency?: string | null
  exchange_rate?: number | string | null
  eur_rate?: number | string | null
}

/**
 * Two decimals, half away from zero — Postgres `round(x, 2)`.
 *
 * Goes through the decimal exponent rather than `* 100`, because 1.005 * 100
 * is 100.49999… in binary and would round down.
 */
export function round2(n: number): number {
  if (!Number.isFinite(n)) return n
  const s = String(Math.abs(n))
  // A string already in exponent form (1e-7, 1e+21) cannot take another one.
  const abs = s.includes('e')
    ? Math.round(Math.abs(n) * 100) / 100
    : Number(Math.round(Number(`${s}e2`)) + 'e-2')
  const r = n < 0 ? -abs : abs
  return r === 0 ? 0 : r   // never -0
}

function usableRate(r: unknown): number | null {
  const n = typeof r === 'string' ? Number(r) : r
  return typeof n === 'number' && Number.isFinite(n) && n > 0 ? n : null
}

function missing(what: string): RateUnavailableError {
  return new RateUnavailableError(what)
}

function checkAmount(amount: number): number {
  if (typeof amount !== 'number' || !Number.isFinite(amount)) {
    throw missing(`Iznos nije broj: ${String(amount)}`)
  }
  return amount
}

function checkCurrency(currency: string): DocumentCurrency {
  const c = (currency || '').toUpperCase()
  if (!isDocumentCurrency(c)) throw missing(`Nepodržana valuta: ${currency || '(prazno)'}`)
  return c
}

/** RSD per 1 unit of `currency`, from a day's rates. */
export function rateFor(currency: string, rates: Pick<BookRates, 'eurRate' | 'usdRate'>): number {
  const c = checkCurrency(currency)
  if (c === 'RSD') return 1
  const r = usableRate(c === 'EUR' ? rates.eurRate : rates.usdRate)
  if (r === null) throw missing(`Nema kursa za ${c}`)
  return r
}

/**
 * The stored columns from rates already in hand.
 *
 * `exchangeRate` is RSD per unit of `currency` (ignored for RSD, which is 1;
 * for EUR it falls back to `eurRate` and must otherwise be the same number).
 */
export function bookAmountsAtRate(
  amount: number, currency: string, exchangeRate: number | null | undefined, eurRate: number | null | undefined,
): BookAmounts {
  checkAmount(amount)
  const c = checkCurrency(currency)
  const eur = usableRate(eurRate)
  if (eur === null) throw missing('Nema kursa za EUR')

  if (c === 'RSD') {
    const rsd = round2(amount)
    return { exchange_rate: 1, eur_rate: eur, amount_rsd: rsd, amount_eur: round2(rsd / eur) }
  }

  if (c === 'EUR') {
    const own = usableRate(exchangeRate)
    if (own !== null && Math.abs(own - eur) > 1e-9) {
      throw missing(`Kurs za EUR (${own}) i EUR kurs (${eur}) se ne slažu`)
    }
    return { exchange_rate: eur, eur_rate: eur, amount_rsd: round2(amount * eur), amount_eur: round2(amount) }
  }

  const rate = usableRate(exchangeRate)
  if (rate === null) throw missing(`Nema kursa za ${c}`)
  const rsd = round2(amount * rate)
  return { exchange_rate: rate, eur_rate: eur, amount_rsd: rsd, amount_eur: round2(rsd / eur) }
}

/** The stored columns from a day's rates (`getBookRates`). Pure. */
export function bookAmounts(
  amount: number, currency: string, rates: Pick<BookRates, 'eurRate' | 'usdRate'>,
): BookAmounts {
  const c = checkCurrency(currency)
  // Only the rates this currency needs are checked: an RSD or EUR document
  // does not fail for want of a USD rate.
  const own = c === 'USD' ? rateFor(c, rates) : null
  return bookAmountsAtRate(amount, c, own, rates.eurRate)
}

/** NBS rates for a date. Throws RateUnavailableError, never guesses. */
export async function getBookRates(date: string): Promise<BookRates> {
  const iso = toIsoDate(date)
  let r
  try {
    r = await getRatesForDate(iso)
  } catch (err) {
    if (err instanceof RateUnavailableError) throw err
    throw nbsUnavailable(iso)
  }
  const eurRate = usableRate(r.eurRsdRate)
  const usdRate = usableRate(r.usdRsdRate)
  if (eurRate === null || usdRate === null) throw nbsUnavailable(iso)
  return { date: r.date, eurRate, usdRate, source: r.source }
}

/** Fetch the day's rates and book the amount. */
export async function toBookAmounts(
  amount: number, currency: string, date: string,
): Promise<BookAmounts & { rates: BookRates }> {
  checkAmount(amount)
  checkCurrency(currency)
  const rates = await getBookRates(date)
  return { ...bookAmounts(amount, currency, rates), rates }
}

/**
 * A stored row's rates. RSD's exchange_rate is 1 whatever is stored; a EUR
 * row's exchange_rate falls back to its eur_rate and vice versa.
 */
export function rowRates(row: RatedRow): { exchangeRate: number; eurRate: number } {
  const c = checkCurrency(row.currency || BOOK_CURRENCY)
  let own = c === 'RSD' ? 1 : usableRate(row.exchange_rate)
  let eur = usableRate(row.eur_rate)
  if (c === 'EUR') {
    own = own ?? eur
    eur = eur ?? own
  }
  if (own === null) throw missing(`Red u ${c} nema exchange_rate`)
  if (eur === null) throw missing('Red nema eur_rate')
  return { exchangeRate: own, eurRate: eur }
}

/**
 * A part of a document (in the document's currency), booked at the
 * document's stored rates.
 */
export function partBookAmounts(partAmount: number, parent: RatedRow): { amount_rsd: number; amount_eur: number } {
  checkAmount(partAmount)
  const c = checkCurrency(parent.currency || BOOK_CURRENCY)
  const { exchangeRate, eurRate } = rowRates(parent)
  const b = bookAmountsAtRate(partAmount, c, c === 'EUR' ? eurRate : exchangeRate, eurRate)
  return { amount_rsd: b.amount_rsd, amount_eur: b.amount_eur }
}

/**
 * A figure known in RSD, expressed in the parent document's own currency.
 *
 * `amount` is what `allocated_amount` stores; `amount_rsd` is the RSD figure
 * as given (it is the one that was paid); `amount_eur` is exactly `amount`
 * when the parent is in EUR.
 */
export function partFromRsd(amountRsd: number, parent: RatedRow): { amount: number; amount_rsd: number; amount_eur: number } {
  checkAmount(amountRsd)
  const c = checkCurrency(parent.currency || BOOK_CURRENCY)
  const { exchangeRate, eurRate } = rowRates(parent)
  const rsd = round2(amountRsd)
  const own = c === 'RSD' ? rsd : round2(rsd / exchangeRate)
  return { amount: own, amount_rsd: rsd, amount_eur: c === 'EUR' ? own : round2(rsd / eurRate) }
}

/** RSD → EUR at a row's eur_rate. */
export function rsdToEur(amountRsd: number, eurRate: number | string | null | undefined): number {
  checkAmount(amountRsd)
  const eur = usableRate(eurRate)
  if (eur === null) throw missing('Nema kursa za EUR')
  return round2(amountRsd / eur)
}

/** EUR → RSD at a row's eur_rate. */
export function eurToRsd(amountEur: number, eurRate: number | string | null | undefined): number {
  checkAmount(amountEur)
  const eur = usableRate(eurRate)
  if (eur === null) throw missing('Nema kursa za EUR')
  return round2(amountEur * eur)
}
