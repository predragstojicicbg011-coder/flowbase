// ─── Reading and writing the template of preliminary hours ─────────────────
//
// One row per month in `payroll_preliminary_hours` (20261121090000). The
// database accepts a row only for the running month in Belgrade and stamps
// who saved it and when, so neither is ever sent from here.

import { firstOfMonth } from './timesheets'
import { TEMPLATE_FIELDS, type PreliminaryHoursRow } from './preliminaryHours'
import { TEMPLATE_NOT_SAVED, TEMPLATE_NOT_REMOVED, templateNotRead } from './preliminaryText'

export async function fetchPreliminaryHours(
  client: any, month: string,
): Promise<PreliminaryHoursRow | null> {
  const { data, error } = await client
    .from('payroll_preliminary_hours').select('*')
    .eq('month', firstOfMonth(month))
    .maybeSingle()
  if (error) throw new Error(templateNotRead(error.message))
  if (!data) return null
  // numeric arrives as text from PostgREST; the template is numbers.
  const row = { ...data } as PreliminaryHoursRow
  for (const f of TEMPLATE_FIELDS) row[f] = Number(data[f]) || 0
  return row
}

export async function savePreliminaryHours(client: any, row: PreliminaryHoursRow): Promise<void> {
  const out: Record<string, unknown> = { month: firstOfMonth(row.month), note: row.note || null }
  for (const f of TEMPLATE_FIELDS) out[f] = Number(row[f]) || 0
  const { data, error } = await client
    .from('payroll_preliminary_hours')
    .upsert(out, { onConflict: 'month' })
    .select('month')
  // A refusal by the database (the running-month rule) and a zero-row answer
  // (RLS declining the write) are the same thing to the person saving.
  if (error) throw new Error(`${TEMPLATE_NOT_SAVED} (${error.message})`)
  if (!data || data.length === 0) throw new Error(TEMPLATE_NOT_SAVED)
}

export async function removePreliminaryHours(client: any, month: string): Promise<void> {
  const { data, error } = await client
    .from('payroll_preliminary_hours').delete()
    .eq('month', firstOfMonth(month))
    .select('month')
  if (error) throw new Error(`${TEMPLATE_NOT_REMOVED} (${error.message})`)
  if (!data || data.length === 0) throw new Error(TEMPLATE_NOT_REMOVED)
}
