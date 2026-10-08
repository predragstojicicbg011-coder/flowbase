/**
 * What a new budget line is about to do, in words, before it does it.
 *
 * These tests are about the sentence, not the styling: the parent case has to
 * say that the figure will not land on any line underneath, because that is
 * what the owner hit from the change dialog and had no way to see.
 */
import { scopeOfNewLine, resolveSeed } from './AddBudgetLineDialog'
import type { Level } from '../services/budgetForecast'

// The module pulls in the real Supabase client to append its ledger row.
// This function decides a sentence and writes nothing, so the client is
// stubbed away rather than rendered against — as BudgetChangeDialog's own
// test does.
jest.mock('../supabase', () => ({ supabase: {} }))

const LEVELS = ['Sektor', 'Podsektor', 'Opis troška']

describe('scopeOfNewLine', () => {
  it('says nothing when nothing has been picked', () => {
    expect(scopeOfNewLine([], LEVELS)).toBeNull()
  })

  it('is quiet when the line lands on the deepest level', () => {
    const scope = scopeOfNewLine(['Marketing', 'SaaS software', 'Figma'], LEVELS)
    expect(scope).not.toBeNull()
    expect(scope!.onParent).toBe(false)
    expect(scope!.text).toContain('opis troška')
    expect(scope!.text).toContain('najdublji')
  })

  it('warns, and names what it is NOT on, when a level is left blank', () => {
    const scope = scopeOfNewLine(['Marketing', 'SaaS software'], LEVELS)
    expect(scope!.onParent).toBe(true)
    // The whole point: it must say the figure does not reach the lines below.
    expect(scope!.text).toContain('ne na neku stavku nivoa „opis troška“ ispod njega')
    expect(scope!.text).toContain('na sam nivo „podsektor“')
  })

  it('warns the same way when only the top level is filled in', () => {
    const scope = scopeOfNewLine(['Marketing'], LEVELS)
    expect(scope!.onParent).toBe(true)
    expect(scope!.text).toContain('na sam nivo „sektor“')
    expect(scope!.text).toContain('ne na neku stavku nivoa „podsektor“ ispod njega')
  })

  it('names the next level to pick, so the fix is in the sentence', () => {
    expect(scopeOfNewLine(['Marketing'], LEVELS)!.text)
      .toContain('popunite i polje „podsektor“')
  })

  it('does not repeat the label the path already ends with', () => {
    for (const picks of [['Marketing'], ['Marketing', 'SaaS software'], ['Marketing', 'SaaS software', 'Figma']]) {
      const text = scopeOfNewLine(picks, LEVELS)!.text
      expect(text).not.toContain(picks[picks.length - 1])
    }
  })

  it('treats a branch of its own depth on its own terms', () => {
    // The P&L branch is two levels, not three; a category line is a leaf there.
    // A label that opens with an abbreviation keeps its capitals mid-sentence.
    const scope = scopeOfNewLine(['Operating expenses', 'Bank charges'], ['P&L kategorija', 'P&L potkategorija'])
    expect(scope!.onParent).toBe(false)
    expect(scope!.text).toContain('(P&L potkategorija)')
  })

  it('has nothing to say about levels it was not given', () => {
    expect(scopeOfNewLine(['Marketing'], [])).toBeNull()
  })
})

// ─── Arriving pre-filled from the `+` on a tree row ─────────────────────────
//
// The `+` beside a sub-category knows its row as labels and the dialog works
// in rows with ids. Everything that can go wrong here goes wrong quietly: a
// name matched under the wrong parent writes a correct-looking budget line
// onto a department that is not paying it.

describe('resolveSeed', () => {
  const lookups = {
    pl_categories: [{ id: 'pc1', name: 'General Business', type: 'expense' }],
    pl_subcategories: [{ id: 'ps1', name: 'Software', category_id: 'pc1' }],
    departments: [
      { id: 'd1', name: 'Development Expenses' },
      { id: 'd2', name: 'CS Expenses' },
    ],
    dept_subcategories: [
      { id: 's1', name: 'Outsourcing services and Associates', department_id: 'd1' },
      // The same name under the other department — the trap.
      { id: 's2', name: 'General', department_id: 'd1' },
      { id: 's3', name: 'General', department_id: 'd2' },
    ],
    expense_descriptions: [
      { id: 'e1', name: 'MGP25 Cyberint Service', dept_subcategory_id: 's1' },
    ],
  }
  const LEVELS: Level[] = ['department', 'dept_subcategory', 'expense_description']
  const at = (picks: (any | null)[]) => picks.map(p => (p ? p.id : null))

  it('fills in the department and the sub-category the row names', () => {
    expect(at(resolveSeed(LEVELS, lookups as any,
      ['Development Expenses', 'Outsourcing services and Associates'])))
      .toEqual(['d1', 's1', null])
  })

  /**
   * The reason this walks down instead of matching each level on its own: two
   * departments both have a `General`, and the first one stored is not the
   * one that was clicked.
   */
  it('picks the sub-category under the department, not the first of its name', () => {
    expect(at(resolveSeed(LEVELS, lookups as any, ['CS Expenses', 'General'])))
      .toEqual(['d2', 's3', null])
    expect(at(resolveSeed(LEVELS, lookups as any, ['Development Expenses', 'General'])))
      .toEqual(['d1', 's2', null])
  })

  it('fills every level a longer path names', () => {
    expect(at(resolveSeed(LEVELS, lookups as any,
      ['Development Expenses', 'Outsourcing services and Associates', 'MGP25 Cyberint Service'])))
      .toEqual(['d1', 's1', 'e1'])
  })

  /**
   * A node can be in the tree and not in the lookup tables — the tree is built
   * from what was SPENT, and a description can be removed from the lookup
   * after an invoice used it. What resolved is kept; nothing is guessed.
   */
  it('stops where the tables stop, rather than guessing the rest', () => {
    expect(at(resolveSeed(LEVELS, lookups as any,
      ['Development Expenses', 'A sub-category nobody kept'])))
      .toEqual(['d1', null, null])
  })

  it('does not match a child when its parent failed to resolve', () => {
    expect(at(resolveSeed(LEVELS, lookups as any,
      ['A department nobody kept', 'Outsourcing services and Associates'])))
      .toEqual([null, null, null])
  })

  it('ignores the case and the stray spaces a label carries', () => {
    expect(at(resolveSeed(LEVELS, lookups as any,
      ['  development expenses ', 'OUTSOURCING SERVICES AND ASSOCIATES'])))
      .toEqual(['d1', 's1', null])
  })

  it('leaves everything for the user when there is no seed at all', () => {
    expect(at(resolveSeed(LEVELS, lookups as any, []))).toEqual([null, null, null])
  })

  it('does not run past the levels the open branch has', () => {
    expect(resolveSeed(['department'] as Level[], lookups as any,
      ['Development Expenses', 'Outsourcing services and Associates']))
      .toHaveLength(1)
  })

  /**
   * In the P&L branch a description's parent is a P&L sub-category, which does
   * not own it in the database. Nothing filters it, so it must not be matched
   * on its name — the dialog says as much and refuses to add one there.
   */
  it('still fills the P&L branch, where the last level is unowned', () => {
    const PL: Level[] = ['pl_category', 'pl_subcategory', 'expense_description']
    expect(at(resolveSeed(PL, lookups as any, ['General Business', 'Software'])))
      .toEqual(['pc1', 'ps1', null])
  })
})
