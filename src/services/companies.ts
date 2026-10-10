// ─── The legal entities the books are kept for ──────────────────────────────
//
// FlowBase keeps the `companies` table and every `company_id` column, because
// the same code is the starting point for clients who run several entities.
// A typical client runs one. With one company there is nothing to choose,
// so no screen asks: the one company is simply the company.
//
// The rule lives here, once, instead of in every page that used to read the
// table for itself:
//
//   - the list is ordered by name, as every picker showed it;
//   - the default is the first company — the only one, in the one-company
//     case, which is the case this app is built for;
//   - a picker is shown only when there are at least two companies to pick
//     between.

import { supabase } from '../supabase'

export interface Company {
  id: string
  name: string
  group_id?: string | null
  country?: string | null
  currency?: string | null
  currencies?: string[] | null
}

/** Every company, ordered by name. Throws on a failed read. */
export async function fetchCompanies(): Promise<Company[]> {
  const { data, error } = await supabase.from('companies').select('*').order('name')
  if (error) throw new Error(error.message)
  return (data || []) as Company[]
}

/** The company to use when nobody has chosen one, or null with none at all. */
export function pickDefaultCompany(companies: Company[]): Company | null {
  return companies[0] ?? null
}

/** Whether there is anything to choose between. */
export function showCompanyPicker(companies: Company[]): boolean {
  return companies.length > 1
}
