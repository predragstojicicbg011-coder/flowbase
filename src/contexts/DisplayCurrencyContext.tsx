// ─── DisplayCurrencyContext ─────────────────────────────────────────────────
//
// Which of the two book currencies the pages show: RSD (the books) or EUR
// (the index). Every money row stores both — `amount_rsd` and `amount_eur`,
// `allocated_amount_rsd` and `allocated_amount_eur`, and so on — so switching
// is a choice of column, never a conversion at display time.
//
// The choice is per viewer, remembered in localStorage under
// `<app>_display_currency` (e.g. `alfaflow_display_currency`). Storage may be missing or throw (a private
// window, blocked site data); the app then starts in RSD and the toggle still
// works for the session.
//
// Use:
//
//   const { currency, pick, field, format } = useDisplayCurrency()
//   pick(row)                     → row.amount_rsd or row.amount_eur
//   pick(row, 'allocated_amount') → row.allocated_amount_rsd / _eur
//   field('paid_amount')          → 'paid_amount_rsd' / 'paid_amount_eur'
//   format(n)                     → fmtMoney(n, currency)
//
// `pick` returns null where the row has no figure in that currency (a budget
// line planned only in RSD has no EUR yet) — show it as a dash, do not add it
// as zero without thinking about it.
//
// Outside a provider the hook answers RSD with a setter that does nothing,
// so a component under test renders without one.

import React, { createContext, useCallback, useContext, useMemo, useState } from 'react'
import { fmtMoney } from '../utils/formatters'
import { brand } from '../config/brand'

export type DisplayCurrency = 'RSD' | 'EUR'
export const DISPLAY_CURRENCIES: readonly DisplayCurrency[] = ['RSD', 'EUR']
export const DISPLAY_CURRENCY_KEY = `${brand.storagePrefix}_display_currency`
export const DEFAULT_DISPLAY_CURRENCY: DisplayCurrency = 'RSD'

/** The column holding `base` in `currency`: amount → amount_rsd / amount_eur. */
export function amountField(currency: DisplayCurrency, base = 'amount'): string {
  return `${base}_${currency.toLowerCase()}`
}

/**
 * `row[base_rsd]` or `row[base_eur]`, as a number.
 *
 * Numeric columns can arrive from PostgREST as strings; they are read as
 * numbers. Missing, null or unreadable is null.
 */
export function pickAmount(row: object | null | undefined, currency: DisplayCurrency, base = 'amount'): number | null {
  if (!row) return null
  const v = (row as Record<string, unknown>)[amountField(currency, base)]
  if (v === null || v === undefined || v === '') return null
  const n = typeof v === 'number' ? v : Number(v)
  return Number.isFinite(n) ? n : null
}

function readStored(): DisplayCurrency {
  try {
    const v = window.localStorage.getItem(DISPLAY_CURRENCY_KEY)
    return v === 'EUR' || v === 'RSD' ? v : DEFAULT_DISPLAY_CURRENCY
  } catch {
    return DEFAULT_DISPLAY_CURRENCY
  }
}

function writeStored(c: DisplayCurrency): void {
  try {
    window.localStorage.setItem(DISPLAY_CURRENCY_KEY, c)
  } catch {
    // Not remembered; still applies for this session.
  }
}

export interface DisplayCurrencyValue {
  currency: DisplayCurrency
  setCurrency: (c: DisplayCurrency) => void
  pick: (row: object | null | undefined, base?: string) => number | null
  field: (base?: string) => string
  format: (n: number | null | undefined, decimals?: number) => string
}

function valueFor(currency: DisplayCurrency, setCurrency: (c: DisplayCurrency) => void): DisplayCurrencyValue {
  return {
    currency,
    setCurrency,
    pick: (row, base = 'amount') => pickAmount(row, currency, base),
    field: (base = 'amount') => amountField(currency, base),
    format: (n, decimals = 2) => fmtMoney(n, currency, decimals),
  }
}

const DisplayCurrencyContext = createContext<DisplayCurrencyValue>(
  valueFor(DEFAULT_DISPLAY_CURRENCY, () => {}),
)

export function DisplayCurrencyProvider({ children, initial }: {
  children: React.ReactNode
  /** For tests; otherwise read from localStorage. */
  initial?: DisplayCurrency
}) {
  const [currency, setState] = useState<DisplayCurrency>(() => initial ?? readStored())

  const setCurrency = useCallback((c: DisplayCurrency) => {
    if (c !== 'RSD' && c !== 'EUR') return
    setState(c)
    writeStored(c)
  }, [])

  const value = useMemo(() => valueFor(currency, setCurrency), [currency, setCurrency])

  return (
    <DisplayCurrencyContext.Provider value={value}>
      {children}
    </DisplayCurrencyContext.Provider>
  )
}

export function useDisplayCurrency(): DisplayCurrencyValue {
  return useContext(DisplayCurrencyContext)
}
