// ─── quickFillStore ─────────────────────────────────────────────────────────
//
// The classification templates a person has set up for themselves.
//
// They live in `public.quick_fill_scripts`. Code has to find a PARTICULAR one
// — the currency-difference template — and then "which script" is a rule, and
// a rule wants one home and a test.

import type { QuickFillScript } from '../data/quickfill'
import { runWrite } from './writeOrder'

/** How a template announces itself as the one for currency differences. */
const CURRENCY_DIFFERENCE = /currency\s*diff|kursn|fx\s*diff|exchange\s*diff/i

/**
 * The template that books a currency difference, if one has been set up.
 *
 * Matched on the name rather than on a fixed id, because the person creates
 * these in the interface and there is no id to agree on beforehand. An exact
 * name would be worse: it would break on a trailing space, which the one in
 * production has.
 *
 * `null` when there is none, and the caller has to say so rather than book
 * something under a classification nobody chose.
 */
export function findCurrencyDifference(scripts: QuickFillScript[]): QuickFillScript | null {
  return scripts.find(s => CURRENCY_DIFFERENCE.test(s.name || '')) ?? null
}

/** Every template, with the currency-difference one first if there is one. */
export function orderedForDifference(scripts: QuickFillScript[]): QuickFillScript[] {
  const match = findCurrencyDifference(scripts)
  if (!match) return scripts
  return [match, ...scripts.filter(s => s.id !== match.id)]
}

// ─── The table ──────────────────────────────────────────────────────────────

/** The columns a template is stored in. `id` is absent on a new one. */
export interface ScriptDraft {
  id?: string
  name: string
  icon: string
  pl_category: string
  pl_subcategory: string
  department: string
  dept_subcategory: string
  expense_description: string
  cf_type: string
  sort_order?: number
}

/** Trimmed and lowercased, which is what the unique index compares. */
export const nameKey = (name: string): string => (name || '').trim().toLowerCase()

/**
 * Why this template cannot be saved, or `null`.
 *
 * A name is the whole of it. Everything else is a classification the template
 * carries forward, and leaving a level blank is a legitimate template — some
 * costs genuinely stop at a department. But an unnamed one cannot be picked
 * from a list, and a duplicate cannot be told from the one it duplicates,
 * which matters more here than usual: the currency-difference control finds
 * its template BY NAME.
 */
export function whyNotSavable(
  draft: ScriptDraft,
  existing: { id: string; name: string }[],
): string | null {
  const name = (draft.name || '').trim()
  if (!name) return 'Dajte šablonu naziv — po njemu ćete ga pronaći, a po nazivu i kontrola za kursnu razliku pronalazi svoj šablon.'
  const clash = existing.find(e => nameKey(e.name) === nameKey(name) && e.id !== draft.id)
  if (clash) return `Već postoji šablon pod nazivom „${clash.name}“. Dva šablona sa istim nazivom ne mogu da se razlikuju.`
  return null
}

/** The order the lists show them in: by `sort_order`, then by name. */
export function sortScripts<T extends { name: string; sort_order?: number }>(scripts: T[]): T[] {
  return [...scripts].sort((a, b) =>
    (a.sort_order ?? 0) - (b.sort_order ?? 0) || (a.name || '').localeCompare(b.name || ''))
}

/** A template stripped to the columns the table has. */
export function toRow(draft: ScriptDraft): Record<string, unknown> {
  return {
    name: (draft.name || '').trim(),
    icon: draft.icon || '',
    pl_category: draft.pl_category || '',
    pl_subcategory: draft.pl_subcategory || '',
    department: draft.department || '',
    dept_subcategory: draft.dept_subcategory || '',
    expense_description: draft.expense_description || '',
    cf_type: draft.cf_type || '',
    sort_order: draft.sort_order ?? 0,
  }
}

// ─── Reaching the table ─────────────────────────────────────────────────────
//
// The client is a parameter rather than a module import, for the same reason
// `writeOrder` takes one: it is what makes these testable without a database.

/**
 * Every template, in the order the lists show them.
 *
 * An error is not thrown. A dialog whose templates could not be read is still
 * a dialog somebody can classify by hand in, and taking it down over a
 * shortcut would be the wrong trade — so it returns nothing and the quick fill
 * simply offers nothing.
 */
export async function fetchScripts(client: any): Promise<QuickFillScript[]> {
  const { data, error } = await client.from('quick_fill_scripts').select('*')
  if (error) return []
  return sortScripts((data || []) as QuickFillScript[]) as QuickFillScript[]
}

/** Insert or update one template, and say why if the database refuses. */
export async function saveScript(
  client: any,
  draft: ScriptDraft,
): Promise<{ ok: boolean; message: string }> {
  const row = toRow(draft)
  return draft.id
    ? runWrite('Čuvanje šablona', client.from('quick_fill_scripts')
        .update({ ...row, updated_at: new Date().toISOString() }).eq('id', draft.id).select('id'))
    : runWrite('Dodavanje šablona', client.from('quick_fill_scripts').insert(row).select('id'))
}

export async function removeScript(
  client: any,
  id: string,
): Promise<{ ok: boolean; message: string }> {
  return runWrite('Brisanje šablona',
    client.from('quick_fill_scripts').delete().eq('id', id).select('id'))
}
