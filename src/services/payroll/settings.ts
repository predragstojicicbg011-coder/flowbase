// ─── Payroll settings, read for a particular month ──────────────────────────
//
// The engine takes a `PayrollRates`. The table holds fifty-two settings, each
// with the dates it was in force. This is the piece in between, and its whole
// job is to answer "what were the rates in August" rather than "what are the
// rates".
//
// THE IMPORTANT BEHAVIOUR IS THE REFUSAL. Asked for a month it has no figures
// for, it says so and stops. The tempting alternative — fall back to the
// oldest row, or the newest — would produce a complete, plausible payroll run
// for a month whose real rates nobody knows, and in a module built to check
// somebody else's arithmetic that is the worst possible output: a number that
// looks exactly like a verified one.
//
// Dates are compared as `YYYY-MM-DD` strings. Every date here comes from a
// `date` column or a month picker, both of which are already in that form, and
// string comparison on it sorts correctly — where `new Date()` would drag in a
// timezone and could move a run on the first of a month into the one before.

import type { PayrollRates } from './engine'

/** One of the named alternatives a choice-valued setting allows. */
export interface SettingOption {
  /** What is stored — MPP's own wording, because that is what it means by it. */
  value: string
  label: string
}

export interface SettingRow {
  group_key: string
  setting_key: string
  /** MPP's wording, verbatim, for searching the accountant's screen. */
  label: string
  /** What the setting does, in English. Null on a row seeded before it existed. */
  label_en?: string | null
  /** Present only where the setting is a choice between named alternatives. */
  options?: SettingOption[] | string | null
  value_numeric: number | null
  value_text: string | null
  valid_from: string
  /** `null` means still in force. */
  valid_to: string | null
  note?: string | null
}

/** Whether a row covers a date. `[valid_from, valid_to)`, as in the constraint. */
export function coversDate(row: SettingRow, date: string): boolean {
  if (!row.valid_from || date < row.valid_from) return false
  return row.valid_to === null || row.valid_to === undefined || date < row.valid_to
}

/**
 * The row in force for a key on a date, or `null`.
 *
 * The exclusion constraint guarantees at most one, so this does not have to
 * choose between candidates — and if the constraint were ever dropped, taking
 * the first would silently pick one of two truths.
 */
export function rowFor(rows: SettingRow[], key: string, date: string): SettingRow | null {
  return rows.find(r => r.setting_key === key && coversDate(r, date)) ?? null
}

export function numberFor(rows: SettingRow[], key: string, date: string): number | null {
  const row = rowFor(rows, key, date)
  return row && typeof row.value_numeric === 'number' ? row.value_numeric : null
}

export function textFor(rows: SettingRow[], key: string, date: string): string | null {
  const row = rowFor(rows, key, date)
  return row ? row.value_text : null
}

/** The settings without which the engine cannot produce a figure at all. */
export const REQUIRED_KEYS = [
  'income_tax_rate',
  'pension_employee_rate',
  'health_employee_rate',
  'unemployment_employee_rate',
  'pension_employer_rate',
  'health_employer_rate',
  'unemployment_employer_rate',
  'tax_free_amount',
  'minimum_net_per_hour',
  'minimum_base',
  'maximum_base',
  'meal_allowance',
  'holiday_allowance',
] as const

/** Which required settings have no value for this date. */
export function missingFor(rows: SettingRow[], date: string): string[] {
  return REQUIRED_KEYS.filter(k => numberFor(rows, k, date) === null)
}

/**
 * The rates in force on a date.
 *
 * Throws when anything required is missing, naming every one of them rather
 * than the first — somebody correcting a gap wants the whole list, not one
 * round trip per setting.
 */
export function ratesFor(rows: SettingRow[], date: string): PayrollRates {
  const missing = missingFor(rows, date)
  if (missing.length > 0) {
    throw new Error(
      `No payroll settings cover ${date}. Missing: ${missing.join(', ')}. `
      + 'A run cannot be produced for a month whose rates are unknown — the figures '
      + 'would look exactly like verified ones.')
  }
  const n = (k: string) => numberFor(rows, k, date) as number
  return {
    incomeTax: n('income_tax_rate'),
    pensionEmployee: n('pension_employee_rate'),
    healthEmployee: n('health_employee_rate'),
    unemploymentEmployee: n('unemployment_employee_rate'),
    pensionEmployer: n('pension_employer_rate'),
    healthEmployer: n('health_employer_rate'),
    unemploymentEmployer: n('unemployment_employer_rate'),
    taxFreeAmount: n('tax_free_amount'),
    minimumNetPerHour: n('minimum_net_per_hour'),
    minimumBase: n('minimum_base'),
    maximumBase: n('maximum_base'),
    mealAllowance: n('meal_allowance'),
    holidayAllowance: n('holiday_allowance'),
  }
}

/**
 * The first day of a month, which is the date a run is read at.
 *
 * A month is the unit everything here works in, and reading the settings at
 * its first day is what makes a run reproducible: a figure that changed
 * mid-month would otherwise give a different answer depending on when the
 * recalculation happened to be asked for.
 */
export function monthStart(month: string): string {
  return /^\d{4}-\d{2}$/.test(month) ? `${month}-01` : month
}

// ─── Editing ────────────────────────────────────────────────────────────────

/**
 * Why this change cannot be saved, or `null`.
 *
 * The overlap rule is enforced by the database, which is where it belongs —
 * but a constraint violation arrives as a message about a gist index, and the
 * person reading it is trying to correct a tax rate. This says the same thing
 * in their terms, before the write.
 */
export function whyNotSavable(
  draft: { setting_key: string; valid_from: string; valid_to: string | null; id?: string },
  existing: (SettingRow & { id: string })[],
): string | null {
  if (!draft.valid_from) return 'Say which date this value takes effect from.'
  if (draft.valid_to && draft.valid_to <= draft.valid_from) {
    return 'The end date has to be after the start date.'
  }
  const clash = existing.find(r =>
    r.setting_key === draft.setting_key
    && (r as any).id !== draft.id
    && overlaps(r.valid_from, r.valid_to, draft.valid_from, draft.valid_to))
  if (clash) {
    return `Another value for this setting already covers that period `
      + `(${clash.valid_from} → ${clash.valid_to || 'still in force'}). `
      + 'Two values for one month would give two answers, and whichever a run '
      + 'picked up would look perfectly ordinary. End the old one first.'
  }
  return null
}

/** `[a, b)` against `[c, d)`, with `null` meaning open-ended. */
export function overlaps(
  aFrom: string, aTo: string | null,
  bFrom: string, bTo: string | null,
): boolean {
  const aEnd = aTo ?? '9999-12-31'
  const bEnd = bTo ?? '9999-12-31'
  return aFrom < bEnd && bFrom < aEnd
}

/**
 * Closing an open-ended value so a new one can start.
 *
 * The ordinary way a rate changes: January's figure is not edited, it is ended
 * on the day the new one begins. Editing it in place would rewrite what last
 * year cost.
 */
export function supersede(
  current: SettingRow & { id: string },
  newFrom: string,
): { id: string; valid_to: string } {
  return { id: current.id, valid_to: newFrom }
}

export async function fetchSettings(client: any): Promise<(SettingRow & { id: string })[]> {
  const { data, error } = await client
    .from('payroll_settings')
    .select('*')
    .order('group_key')
    .order('label')
    .order('valid_from', { ascending: false })
  if (error) throw new Error(`The payroll settings could not be read: ${error.message}`)
  return (data || []) as (SettingRow & { id: string })[]
}
