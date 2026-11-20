import {
  twentiethBusinessDay, rateForMonth, rateBadge, rateNotice, postWaitsForTheTwentieth,
  convertsForeignAmount, RATE_WITHHELD, UNKNOWN_RATE_DAY,
} from './payrollRate'
import { getBookRates } from '../bookAmounts'
import { clearRateCache } from '../currencyService'
import type { HolidayRow } from './holidays'
import type { EmployeeForMonth } from './employees'
import type { AdditionRow } from './additions'

const holiday = (on: string): HolidayRow => ({ holiday_on: on, name: 'Praznik A', kind: 'state' })

describe('twentiethBusinessDay', () => {
  it('is the 20th on a weekday', () => {
    expect(twentiethBusinessDay('2026-11', [])).toBe('2026-11-20')   // Friday
  })

  it('walks a weekend 20th back to the Friday', () => {
    expect(twentiethBusinessDay('2026-06', [])).toBe('2026-06-19')   // Saturday 20th
    expect(twentiethBusinessDay('2026-09', [])).toBe('2026-09-18')   // Sunday 20th
  })

  it('walks back over a public holiday as well', () => {
    expect(twentiethBusinessDay('2026-06', [holiday('2026-06-19')])).toBe('2026-06-18')
    expect(twentiethBusinessDay('2026-11', [holiday('2026-11-20')])).toBe('2026-11-19')
  })
})

describe('rateForMonth', () => {
  it('a weekday 20th quoted on the 20th is the 20th\'s', () => {
    expect(rateForMonth('2026-11', [], { eurRate: 117.2, quotedOn: '2026-11-20' }, '2026-11'))
      .toEqual({ eur: 117.2, quotedOn: '2026-11-20', ofTheTwentieth: true, twentieth: '2026-11-20' })
  })

  it('a Saturday 20th quoted on the Friday is the 20th\'s', () => {
    expect(rateForMonth('2026-06', [], { eurRate: 117.2, quotedOn: '2026-06-19' }, '2026-06').ofTheTwentieth).toBe(true)
  })

  it('a list from the day before the 20th is not the 20th\'s', () => {
    const r = rateForMonth('2026-04', [], { eurRate: 117.2, quotedOn: '2026-04-19' }, '2026-04')
    expect(r.ofTheTwentieth).toBe(false)
    expect(r.quotedOn).toBe('2026-04-19')
  })

  it('a rate with no quoted day is never the 20th\'s in the running month', () => {
    expect(rateForMonth('2026-11', [], { eurRate: 117.2 }, '2026-11'))
      .toEqual({ eur: 117.2, quotedOn: null, ofTheTwentieth: false, twentieth: '2026-11-20' })
  })

  it('the running month before its 20th\'s list is out is still not the 20th\'s', () => {
    const r = rateForMonth('2026-11', [], { eurRate: 117.2, quotedOn: '2026-11-02' }, '2026-11')
    expect(r.ofTheTwentieth).toBe(false)
    expect(postWaitsForTheTwentieth(r)).toContain('Knjiženje je moguće kada NBS objavi taj kurs')
  })

  it('a future month is held to the strict rule as well', () => {
    expect(rateForMonth('2026-12', [], { eurRate: 117.2, quotedOn: '2026-11-19' }, '2026-11')
      .ofTheTwentieth).toBe(false)
  })
})

describe('rateForMonth — a month already past', () => {
  // A past month's 20th has long been published; whatever list the service
  // answers with for it is the one there is. Holding it to the strict rule
  // would refuse it for ever, with a sentence that can never come true.
  it('April 2025: the 20th is a Sunday, Friday the 18th was Good Friday (no row for 2025), '
    + 'the answer is the 17th\'s list — it counts as the 20th\'s', () => {
    expect(twentiethBusinessDay('2025-04', [])).toBe('2025-04-18')
    const r = rateForMonth('2025-04', [], { eurRate: 117.1, quotedOn: '2025-04-17' }, '2026-11')
    expect(r.ofTheTwentieth).toBe(true)
    expect(rateNotice(r)).toBeNull()
    expect(rateBadge(r, n => n.toFixed(2))).toBe('1 EUR = 117.10 RSD, kurs NBS od 17.04.2025.')
  })

  it('a past month whose answer has no date_from counts as the 20th\'s', () => {
    const r = rateForMonth('2026-10', [], { eurRate: 117.2 }, '2026-11')
    expect(r.ofTheTwentieth).toBe(true)
    expect(rateNotice(r)).toBeNull()
  })
})

describe('rateForMonth over the service, payloads as it answers them', () => {
  const realFetch = (global as any).fetch
  beforeEach(() => clearRateCache())
  afterEach(() => { (global as any).fetch = realFetch })

  const answering = (date: string, dateFrom?: string) => {
    (global as any).fetch = async (url: string) => ({
      ok: true, status: 200,
      json: async () => ({
        code: /currency=eur/.test(url) ? 'EUR' : 'USD', date,
        ...(dateFrom === undefined ? {} : { date_from: dateFrom }),
        number: 1, parity: 1, exchange_buy: 116.85,
        exchange_middle: /currency=eur/.test(url) ? 117.2 : 100.0, exchange_sell: 117.55,
      }),
    })
  }
  const monthRate = async (month: string) =>
    rateForMonth(month, [], await getBookRates(`${month}-20`), month)

  it('a weekday 20th once published', async () => {
    answering('2026-11-20', '2026-11-20')
    expect((await monthRate('2026-11')).ofTheTwentieth).toBe(true)
  })

  it('asked the 20th on the 3rd: date is the 20th, date_from the 2nd, so NOT the 20th\'s', async () => {
    answering('2026-11-20', '2026-11-02')
    const r = await monthRate('2026-11')
    expect(r.ofTheTwentieth).toBe(false)
    expect(r.quotedOn).toBe('2026-11-02')
  })

  it('date_from missing: never the 20th\'s', async () => {
    answering('2026-11-20')
    const r = await monthRate('2026-11')
    expect(r.ofTheTwentieth).toBe(false)
    expect(r.quotedOn).toBeNull()
  })
})

describe('what the pages say', () => {
  const money = (n: number) => n.toFixed(2).replace('.', ',')
  const notYet = rateForMonth('2026-11', [], { eurRate: 117.2, quotedOn: '2026-11-02' }, '2026-11')
  const twentieths = rateForMonth('2026-11', [], { eurRate: 117.2, quotedOn: '2026-11-20' }, '2026-11')
  const unknown = rateForMonth('2026-11', [], { eurRate: 117.2 }, '2026-11')

  it('the badge names the day of the rate', () => {
    expect(rateBadge(twentieths, money)).toBe('1 EUR = 117,20 RSD, kurs NBS od 20.11.2026.')
    expect(rateBadge(notYet, money)).toBe('1 EUR = 117,20 RSD, kurs NBS od 02.11.2026.')
    expect(rateBadge(unknown, money)).toBe(`1 EUR = 117,20 RSD, kurs NBS od ${UNKNOWN_RATE_DAY}`)
  })

  it('a rate that is not the 20th\'s says so, and the 20th\'s says nothing', () => {
    expect(rateNotice(notYet)).toBe('Kurs NBS za 20.11.2026. još nije objavljen. '
      + 'Iznosi u evrima preračunati su po kursu od 02.11.2026.')
    expect(rateNotice(unknown)).toBe('Kurs NBS za 20.11.2026. još nije objavljen. '
      + `Iznosi u evrima preračunati su po kursu od ${UNKNOWN_RATE_DAY}.`)
    expect(rateNotice(twentieths)).toBeNull()
  })

  it('the posting refusal names both days', () => {
    expect(postWaitsForTheTwentieth(notYet)).toBe('Obračun koristi kurs od 02.11.2026., a ne kurs '
      + 'za 20.11.2026. Knjiženje je moguće kada NBS objavi taj kurs.')
  })

  it('the HR sentence when no rate can be had', () => {
    expect(RATE_WITHHELD).toBe('Kurs NBS nije dostupan, pa iznosi u evrima nisu prikazani. '
      + 'Svi zaposleni su i dalje na spisku i sati mogu da se unose.')
  })
})

describe('convertsForeignAmount', () => {
  const person = (currency: string, deductionCurrency?: string): EmployeeForMonth => ({
    contract: { currency },
    deductions: deductionCurrency
      ? [{ amount: 10, currency: deductionCurrency, percent_of_net: null }] : [],
  } as unknown as EmployeeForMonth)
  const addition = (currency: string) => ({ currency } as AdditionRow)

  it('is false for a month entirely in dinars', () => {
    expect(convertsForeignAmount([person('RSD', 'RSD')], [addition('RSD')])).toBe(false)
  })

  it('is true for a contract, an addition or a deduction in another currency', () => {
    expect(convertsForeignAmount([person('EUR')], [])).toBe(true)
    expect(convertsForeignAmount([person('RSD')], [addition('EUR')])).toBe(true)
    expect(convertsForeignAmount([person('RSD', 'EUR')], [])).toBe(true)
  })
})
