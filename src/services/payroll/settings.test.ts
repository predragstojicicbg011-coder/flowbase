import {
  coversDate, missingFor, monthStart, numberFor, overlaps, ratesFor, rowFor,
  supersede, textFor, whyNotSavable, REQUIRED_KEYS, type SettingRow,
} from './settings'
import { salaryLine } from './engine'

const row = (over: Partial<SettingRow> & { setting_key: string }): SettingRow => ({
  group_key: 'rates', label: '', value_numeric: 1, value_text: null,
  valid_from: '2026-01-01', valid_to: null, ...over,
})

/** The real seed, which is what a run in August 2026 reads. */
const SEED_2026: SettingRow[] = [
  row({ setting_key: 'income_tax_rate', value_numeric: 0.10 }),
  row({ setting_key: 'pension_employee_rate', value_numeric: 0.14 }),
  row({ setting_key: 'health_employee_rate', value_numeric: 0.0515 }),
  row({ setting_key: 'unemployment_employee_rate', value_numeric: 0.0075 }),
  row({ setting_key: 'pension_employer_rate', value_numeric: 0.10 }),
  row({ setting_key: 'health_employer_rate', value_numeric: 0.0515 }),
  row({ setting_key: 'unemployment_employer_rate', value_numeric: 0 }),
  row({ setting_key: 'tax_free_amount', value_numeric: 34221 }),
  row({ setting_key: 'minimum_net_per_hour', value_numeric: 371 }),
  row({ setting_key: 'minimum_base', value_numeric: 51297 }),
  row({ setting_key: 'maximum_base', value_numeric: 732820 }),
  row({ setting_key: 'meal_allowance', value_numeric: 100 }),
  row({ setting_key: 'holiday_allowance', value_numeric: 100 }),
]

describe('coversDate', () => {
  const r = row({ setting_key: 'x', valid_from: '2026-01-01', valid_to: '2027-01-01' })

  it('covers the first day it is in force', () => {
    expect(coversDate(r, '2026-01-01')).toBe(true)
  })

  it('does not cover the day it ends', () => {
    // `[from, to)` — the same half-open range the database constraint uses, so
    // a value ending on the first and its successor starting that day do not
    // both claim it.
    expect(coversDate(r, '2027-01-01')).toBe(false)
    expect(coversDate(r, '2026-12-31')).toBe(true)
  })

  it('does not cover anything before it starts', () => {
    expect(coversDate(r, '2025-12-31')).toBe(false)
  })

  it('runs to forever when it has no end', () => {
    expect(coversDate(row({ setting_key: 'x', valid_to: null }), '2099-01-01')).toBe(true)
  })
})

describe('reading a value for a month', () => {
  const rows = [
    row({ setting_key: 'tax_free_amount', value_numeric: 28000, valid_from: '2025-01-01', valid_to: '2026-01-01' }),
    row({ setting_key: 'tax_free_amount', value_numeric: 34221, valid_from: '2026-01-01' }),
    row({ setting_key: 'a_choice', value_numeric: null, value_text: 'да' }),
  ]

  it('gives the figure that was in force, not the latest one', () => {
    // The whole reason for the table's shape: a run for last year has to cost
    // what it cost.
    expect(numberFor(rows, 'tax_free_amount', '2025-06-01')).toBe(28000)
    expect(numberFor(rows, 'tax_free_amount', '2026-08-01')).toBe(34221)
  })

  it('gives nothing for a date before anything was in force', () => {
    expect(numberFor(rows, 'tax_free_amount', '2024-06-01')).toBeNull()
    expect(rowFor(rows, 'tax_free_amount', '2024-06-01')).toBeNull()
  })

  it('reads a text setting as text and not as a number', () => {
    expect(textFor(rows, 'a_choice', '2026-08-01')).toBe('да')
    expect(numberFor(rows, 'a_choice', '2026-08-01')).toBeNull()
  })

  it('gives nothing for a key nobody has set', () => {
    expect(numberFor(rows, 'invented_key', '2026-08-01')).toBeNull()
  })
})

describe('ratesFor', () => {
  it('assembles what the engine needs', () => {
    const rates = ratesFor(SEED_2026, '2026-08-01')
    expect(rates.incomeTax).toBe(0.10)
    expect(rates.taxFreeAmount).toBe(34221)
    expect(rates.minimumNetPerHour).toBe(371)
  })

  it('produces rates that reproduce the real August run', () => {
    // The point of the whole chain: table → rates → engine → MPP's figure.
    const rates = ratesFor(SEED_2026, '2026-08-01')
    const line = salaryLine(
      { contractedNet: 117358.60, period: { monthHours: 168, workedHours: 168 } }, rates)
    expect(line.gross).toBeCloseTo(162819.54, 2)
    expect(line.net).toBeCloseTo(117558.60, 2)
  })

  it('REFUSES a month it has no figures for', () => {
    // Not a fallback to the oldest or newest. A complete, plausible payroll
    // run for a month whose real rates nobody knows is the worst thing this
    // module could produce — it would look exactly like a verified one.
    expect(() => ratesFor(SEED_2026, '2025-06-01')).toThrow(/No payroll settings cover 2025-06-01/)
  })

  it('names every missing setting, not just the first', () => {
    // Somebody filling a gap wants the list, not one round trip per setting.
    const partial = SEED_2026.filter(r =>
      r.setting_key !== 'tax_free_amount' && r.setting_key !== 'meal_allowance')
    try {
      ratesFor(partial, '2026-08-01')
      throw new Error('should have refused')
    } catch (e: any) {
      expect(e.message).toContain('tax_free_amount')
      expect(e.message).toContain('meal_allowance')
    }
  })

  it('accepts a rate of exactly zero as a value, not as absent', () => {
    // Unemployment on the employer's side is 0 at Kalemar, and reading
    // that as "missing" would refuse every real month.
    expect(ratesFor(SEED_2026, '2026-08-01').unemploymentEmployer).toBe(0)
    expect(missingFor(SEED_2026, '2026-08-01')).toEqual([])
  })

  it('knows which settings it cannot do without', () => {
    expect(REQUIRED_KEYS).toContain('income_tax_rate')
    expect(REQUIRED_KEYS).toContain('tax_free_amount')
    expect(missingFor([], '2026-08-01')).toHaveLength(REQUIRED_KEYS.length)
  })
})

describe('monthStart', () => {
  it('reads the settings at the first of the month', () => {
    // A figure that changed mid-month would otherwise give a different answer
    // depending on when the recalculation was asked for.
    expect(monthStart('2026-08')).toBe('2026-08-01')
  })

  it('leaves a full date alone', () => {
    expect(monthStart('2026-08-15')).toBe('2026-08-15')
  })
})

describe('overlaps', () => {
  it('sees two ranges that share a month', () => {
    expect(overlaps('2026-01-01', '2026-06-01', '2026-03-01', null)).toBe(true)
  })

  it('does not see an overlap when one ends where the other begins', () => {
    expect(overlaps('2026-01-01', '2026-06-01', '2026-06-01', null)).toBe(false)
  })

  it('treats two open-ended ranges as overlapping', () => {
    expect(overlaps('2026-01-01', null, '2027-01-01', null)).toBe(true)
  })
})

describe('whyNotSavable', () => {
  const existing = [
    { ...row({ setting_key: 'tax_free_amount', valid_from: '2026-01-01', valid_to: null }), id: 'a' },
  ]

  it('accepts a value that starts where the last one ended', () => {
    const closed = [{ ...existing[0], valid_to: '2027-01-01' }]
    expect(whyNotSavable(
      { setting_key: 'tax_free_amount', valid_from: '2027-01-01', valid_to: null }, closed)).toBeNull()
  })

  it('refuses a period already covered, and says which one', () => {
    const why = whyNotSavable(
      { setting_key: 'tax_free_amount', valid_from: '2026-06-01', valid_to: null }, existing)
    expect(why).toContain('2026-01-01')
    expect(why).toContain('still in force')
    expect(why).toContain('two answers')
  })

  it('lets a row be edited without clashing with itself', () => {
    expect(whyNotSavable(
      { id: 'a', setting_key: 'tax_free_amount', valid_from: '2026-01-01', valid_to: null },
      existing)).toBeNull()
  })

  it('refuses a range that ends before it starts', () => {
    expect(whyNotSavable(
      { setting_key: 'x', valid_from: '2026-06-01', valid_to: '2026-01-01' }, [])).toMatch(/after the start/)
  })

  it('refuses a value with no start date', () => {
    expect(whyNotSavable({ setting_key: 'x', valid_from: '', valid_to: null }, [])).toMatch(/takes effect/)
  })

  it('does not care about a different setting covering the same period', () => {
    expect(whyNotSavable(
      { setting_key: 'meal_allowance', valid_from: '2026-06-01', valid_to: null }, existing)).toBeNull()
  })
})

describe('supersede', () => {
  it('ends the old value on the day the new one starts', () => {
    // How a rate changes: the old row is closed, never edited. Editing it
    // would rewrite what last year cost.
    expect(supersede({ ...existingRow(), id: 'a' }, '2027-01-01'))
      .toEqual({ id: 'a', valid_to: '2027-01-01' })
  })
})

function existingRow(): SettingRow {
  return row({ setting_key: 'tax_free_amount', value_numeric: 34221 })
}

describe('settings that are a choice, not an amount', () => {
  const choice: SettingRow = {
    group_key: 'configuration',
    setting_key: 'topli_obrok_se_racuna_na_osnovu',
    label: 'топли оброк се рачуна на основу',
    label_en: 'Meal allowance is calculated on',
    options: [
      { value: 'свих сати', label: 'All hours' },
      { value: 'сати редовног рада', label: 'Regular hours' },
    ],
    value_numeric: null,
    value_text: 'сати редовног рада',
    valid_from: '2026-01-01',
    valid_to: null,
  }

  it('stores MPP wording, not the English', () => {
    // The English is for reading. The value has to be what MPP means by it,
    // and what every existing row already holds.
    expect(textFor([choice], choice.setting_key, '2026-08-01')).toBe('сати редовног рада')
  })

  it('holds a value that is one of its own options', () => {
    // A stored value outside its own list would be silently replaced the
    // first time somebody opened that dropdown and saved — the migration
    // refuses to create one, and this is the same check in the other place.
    const values = (choice.options as any[]).map(o => o.value)
    expect(values).toContain(choice.value_text)
  })

  it('keeps the two labels apart, so neither has to serve both jobs', () => {
    expect(choice.label_en).not.toBe(choice.label)
    expect(choice.label).toMatch(/[\u0400-\u04FF]/)   // Cyrillic, for their screen
    expect(choice.label_en).not.toMatch(/[\u0400-\u04FF]/)
  })

  it('reads a numeric setting no differently for having no options', () => {
    expect(numberFor(SEED_2026, 'income_tax_rate', '2026-08-01')).toBe(0.10)
    expect(SEED_2026.every(r => !r.options)).toBe(true)
  })
})
