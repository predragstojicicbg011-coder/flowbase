import { convertToUSD, perUsdFromRsd, convertToEUR } from './currencyService'

// NBS middle rates for a representative day. Both are RSD per unit.
const USD_RSD = 101.0
const EUR_RSD = 117.4

describe('perUsdFromRsd', () => {
  it('crosses EUR to USD through RSD', () => {
    // 1 USD = 101 RSD, 1 EUR = 117.4 RSD, so a dollar buys 0.86 EUR.
    expect(perUsdFromRsd(EUR_RSD, USD_RSD)).toBeCloseTo(0.8603, 4)
  })

  it('gives a rate above 1 for a currency weaker than the dollar', () => {
    expect(perUsdFromRsd(27.2, USD_RSD)).toBeCloseTo(3.7132, 4)
  })

  it('is 1 when a currency is worth exactly a dollar', () => {
    expect(perUsdFromRsd(USD_RSD, USD_RSD)).toBe(1)
  })

  it('refuses to divide by a missing rate', () => {
    expect(perUsdFromRsd(0, USD_RSD)).toBe(1)
    expect(perUsdFromRsd(EUR_RSD, 0)).toBe(1)
  })
})

describe('convertToUSD', () => {
  it('leaves USD alone', () => {
    expect(convertToUSD(1200, 'USD', 1)).toBe(1200)
  })

  it('converts RSD at the RSD/USD rate', () => {
    expect(convertToUSD(235000, 'RSD', USD_RSD)).toBeCloseTo(2326.73, 2)
  })

  it('converts EUR 1,200 to about $1,395, not $10', () => {
    // The bug this covers: EUR 1,200 was divided by 117.4 — the RSD/EUR rate —
    // and booked as $10.22. It has to be divided by EUR-per-USD instead.
    const perUsd = perUsdFromRsd(EUR_RSD, USD_RSD)
    expect(convertToUSD(1200, 'EUR', perUsd)).toBeCloseTo(1394.85, 2)
  })

  it('converts AED', () => {
    expect(convertToUSD(1000, 'AED', perUsdFromRsd(27.2, USD_RSD))).toBeCloseTo(269.31, 2)
  })

  it('converts a currency it was never told about, rather than passing it through', () => {
    // GBP fell off the end of the old if-chain and came back unchanged, so a
    // pound was booked as a dollar.
    expect(convertToUSD(100, 'GBP', 0.79)).toBeCloseTo(126.58, 2)
    expect(convertToUSD(100, 'GBP', 0.79)).not.toBe(100)
  })

  it('returns the amount rather than Infinity when the rate is unusable', () => {
    expect(convertToUSD(500, 'EUR', 0)).toBe(500)
    expect(convertToUSD(500, 'EUR', NaN)).toBe(500)
  })

  it('round-trips against the rate it was given', () => {
    const perUsd = perUsdFromRsd(EUR_RSD, USD_RSD)
    const usd = convertToUSD(1200, 'EUR', perUsd)
    expect(usd * perUsd).toBeCloseTo(1200, 6)
  })
})

describe('convertToEUR', () => {
  it('crosses USD back to EUR through RSD', () => {
    expect(convertToEUR(1394.8515, EUR_RSD, USD_RSD)).toBeCloseTo(1200, 3)
  })

  it('is the inverse of converting EUR to USD', () => {
    const perUsd = perUsdFromRsd(EUR_RSD, USD_RSD)
    const usd = convertToUSD(850, 'EUR', perUsd)
    expect(convertToEUR(usd, EUR_RSD, USD_RSD)).toBeCloseTo(850, 6)
  })
})
