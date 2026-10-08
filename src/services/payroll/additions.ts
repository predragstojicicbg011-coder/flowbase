// ─── Additions to a salary, for one month ───────────────────────────────────
//
// Bonuses, stimulation, compensation for damage. They belong to a MONTH, not
// to a contract: a bonus paid in September is not a term of employment and
// must not reappear in October, which is what putting it in the settings would
// do.
//
// THREE TREATMENTS, AND THE DIFFERENCE BETWEEN THEM IS MOST OF THE MONEY.
// Fifty thousand as salary costs the company about seventy; as other income
// about fifty-six; paid as it stands, fifty. Nothing here picks one — every
// addition carries its own, because a wrong choice changes what is owed to the
// state and the line looks ordinary either way.
//
// NEVER PRORATED BY HOURS. A bonus is the same figure whether somebody worked
// a full month or half of it. The contracted salary prorates and an addition
// does not, which is why it is added AFTER the proration rather than folded
// into the contracted net.

import { fetchAllPages } from '../../utils/fetchAllPages'
import { firstOfMonth } from './timesheets'

export type Treatment = 'salary' | 'other_income' | 'non_taxable'

export interface AdditionRow {
  id: string
  employee_id: string
  /** Always the first of the month. */
  month: string
  kind: 'bonus' | 'stimulation' | 'damages' | 'other'
  /** What appears on the payslip line. */
  label: string
  treatment: Treatment
  amount: number
  currency: string
  note: string | null
}

export const KINDS: { value: AdditionRow['kind']; label: string }[] = [
  { value: 'bonus', label: 'Bonus' },
  { value: 'stimulation', label: 'Stimulation' },
  { value: 'damages', label: 'Compensation for damage' },
  { value: 'other', label: 'Something else' },
]

export const TREATMENTS: { value: Treatment; label: string; detail: string }[] = [
  {
    value: 'salary',
    label: 'Part of the salary',
    detail: 'Joins the gross-up: income tax and both sides of the contributions apply. '
      + 'A bonus and stimulation are this.',
  },
  {
    value: 'other_income',
    label: 'Other income',
    detail: 'Income tax alone, no contributions — the same treatment the travel '
      + 'allowance gets.',
  },
  {
    value: 'non_taxable',
    label: 'Not taxed',
    detail: 'Paid as it stands. Nothing is withheld and nothing is owed on it.',
  },
]

export function treatmentLabel(t: Treatment): string {
  return TREATMENTS.find(x => x.value === t)?.label ?? t
}

export function kindLabel(k: AdditionRow['kind']): string {
  return KINDS.find(x => x.value === k)?.label ?? k
}

/** The additions for one person in one month. */
export function additionsFor(rows: AdditionRow[], employeeId: string, month: string): AdditionRow[] {
  const first = firstOfMonth(month)
  return rows.filter(a => a.employee_id === employeeId && firstOfMonth(a.month) === first)
}

/**
 * An addition in dinars.
 *
 * A euro bonus converts at the rate of the month, the same rule a euro
 * contract and a euro deduction already follow. Where the rate is unknown it
 * comes to NOTHING rather than to a guess, and `unconvertible` is how a caller
 * finds out so it can say so.
 */
export function amountInDinars(a: AdditionRow, rates: Record<string, number> = {}): number {
  if (a.currency === 'RSD') return round2(a.amount)
  const rate = rates[a.currency]
  if (!(rate > 0)) return 0
  return round2(a.amount * rate)
}

export function unconvertible(rows: AdditionRow[], rates: Record<string, number>): AdditionRow[] {
  return rows.filter(a => a.currency !== 'RSD' && !(rates[a.currency] > 0))
}

export interface AdditionTotals {
  /** Joins the gross-up. */
  salary: number
  /** Income tax only, no contributions. */
  otherIncome: number
  /** Paid as it stands. */
  nonTaxable: number
  /** Everything, for a line that just wants the figure. */
  total: number
}

export function totalsFor(rows: AdditionRow[], rates: Record<string, number> = {}): AdditionTotals {
  let salary = 0, otherIncome = 0, nonTaxable = 0
  for (const a of rows) {
    const amount = amountInDinars(a, rates)
    if (a.treatment === 'salary') salary += amount
    else if (a.treatment === 'other_income') otherIncome += amount
    else nonTaxable += amount
  }
  return {
    salary: round2(salary),
    otherIncome: round2(otherIncome),
    nonTaxable: round2(nonTaxable),
    total: round2(salary + otherIncome + nonTaxable),
  }
}

export async function fetchAdditions(client: any, month?: string): Promise<AdditionRow[]> {
  return fetchAllPages<AdditionRow>((from, to) => {
    let q = client.from('payroll_additions').select('*')
      .order('month', { ascending: false }).order('id').range(from, to)
    if (month) q = q.eq('month', firstOfMonth(month))
    return q
  }).catch((e: any) => {
    throw new Error(`The salary additions could not be read: ${e.message || e}`)
  })
}

const round2 = (n: number): number => Math.round(n * 100) / 100
