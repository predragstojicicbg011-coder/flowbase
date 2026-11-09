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

// A generic three-level path. The function is about the sentence, whatever
// the levels are called; the budget's own branches are two levels and one.
const LEVELS = ['Sektor', 'Grupa', 'Stavka']

describe('scopeOfNewLine', () => {
  it('says nothing when nothing has been picked', () => {
    expect(scopeOfNewLine([], LEVELS)).toBeNull()
  })

  it('is quiet when the line lands on the deepest level', () => {
    const scope = scopeOfNewLine(['Marketing', 'SaaS software', 'Figma'], LEVELS)
    expect(scope).not.toBeNull()
    expect(scope!.onParent).toBe(false)
    expect(scope!.text).toContain('stavka')
    expect(scope!.text).toContain('najdublji')
  })

  it('warns, and names what it is NOT on, when a level is left blank', () => {
    const scope = scopeOfNewLine(['Marketing', 'SaaS software'], LEVELS)
    expect(scope!.onParent).toBe(true)
    // The whole point: it must say the figure does not reach the lines below.
    expect(scope!.text).toContain('ne na neku stavku nivoa „stavka“ ispod njega')
    expect(scope!.text).toContain('na sam nivo „grupa“')
  })

  it('warns the same way when only the top level is filled in', () => {
    const scope = scopeOfNewLine(['Marketing'], LEVELS)
    expect(scope!.onParent).toBe(true)
    expect(scope!.text).toContain('na sam nivo „sektor“')
    expect(scope!.text).toContain('ne na neku stavku nivoa „grupa“ ispod njega')
  })

  it('names the next level to pick, so the fix is in the sentence', () => {
    expect(scopeOfNewLine(['Marketing'], LEVELS)!.text)
      .toContain('popunite i polje „grupa“')
  })

  it('does not repeat the label the path already ends with', () => {
    for (const picks of [['Marketing'], ['Marketing', 'SaaS software'], ['Marketing', 'SaaS software', 'Figma']]) {
      const text = scopeOfNewLine(picks, LEVELS)!.text
      expect(text).not.toContain(picks[picks.length - 1])
    }
  })

  it('treats a branch of its own depth on its own terms', () => {
    // The P&L branch is two levels; a sub-category line is a leaf there.
    // A label that opens with an abbreviation keeps its capitals mid-sentence.
    const scope = scopeOfNewLine(['Operating expenses', 'Bank charges'], ['P&L kategorija', 'P&L potkategorija'])
    expect(scope!.onParent).toBe(false)
    expect(scope!.text).toContain('(P&L potkategorija)')
  })

  it('calls a sector line a leaf in the department branch, which has one level', () => {
    const scope = scopeOfNewLine(['Marketing'], ['Sektor'])
    expect(scope!.onParent).toBe(false)
    expect(scope!.text).toContain('(sektor)')
  })

  it('has nothing to say about levels it was not given', () => {
    expect(scopeOfNewLine(['Marketing'], [])).toBeNull()
  })
})

// ─── Arriving pre-filled from the `+` on a tree row ─────────────────────────
//
// The `+` beside a category knows its row as labels and the dialog works in
// rows with ids. Everything that can go wrong here goes wrong quietly: a name
// matched under the wrong parent writes a correct-looking budget line onto a
// category it does not belong to.

describe('resolveSeed', () => {
  const lookups = {
    pl_categories: [
      { id: 'pc1', name: 'General Business', type: 'expense' },
      { id: 'pc2', name: 'Marketing', type: 'expense' },
    ],
    pl_subcategories: [
      { id: 'ps1', name: 'Software', category_id: 'pc1' },
      // The same name under the other category — the trap.
      { id: 'ps2', name: 'General', category_id: 'pc1' },
      { id: 'ps3', name: 'General', category_id: 'pc2' },
    ],
    departments: [
      { id: 'd1', name: 'Development Expenses' },
      { id: 'd2', name: 'CS Expenses' },
    ],
  }
  const PL: Level[] = ['pl_category', 'pl_subcategory']
  const at = (picks: (any | null)[]) => picks.map(p => (p ? p.id : null))

  it('fills in the category the row names, and leaves the sub-category to pick', () => {
    expect(at(resolveSeed(PL, lookups as any, ['General Business']))).toEqual(['pc1', null])
  })

  /**
   * The reason this walks down instead of matching each level on its own: two
   * categories both have a `General`, and the first one stored is not the one
   * that was clicked.
   */
  it('picks the sub-category under the category, not the first of its name', () => {
    expect(at(resolveSeed(PL, lookups as any, ['Marketing', 'General']))).toEqual(['pc2', 'ps3'])
    expect(at(resolveSeed(PL, lookups as any, ['General Business', 'General']))).toEqual(['pc1', 'ps2'])
  })

  /**
   * A node can be in the tree and not in the lookup tables — the tree is built
   * from what was SPENT, and a name can be removed from the lookup after an
   * invoice used it. What resolved is kept; nothing is guessed.
   */
  it('stops where the tables stop, rather than guessing the rest', () => {
    expect(at(resolveSeed(PL, lookups as any, ['General Business', 'A sub-category nobody kept'])))
      .toEqual(['pc1', null])
  })

  it('does not match a child when its parent failed to resolve', () => {
    expect(at(resolveSeed(PL, lookups as any, ['A category nobody kept', 'Software'])))
      .toEqual([null, null])
  })

  it('ignores the case and the stray spaces a label carries', () => {
    expect(at(resolveSeed(PL, lookups as any, ['  general business ', 'SOFTWARE'])))
      .toEqual(['pc1', 'ps1'])
  })

  it('leaves everything for the user when there is no seed at all', () => {
    expect(at(resolveSeed(PL, lookups as any, []))).toEqual([null, null])
  })

  it('does not run past the levels the open branch has', () => {
    expect(at(resolveSeed(['department'] as Level[], lookups as any,
      ['Development Expenses', 'Outsourcing services and Associates'])))
      .toEqual(['d1'])
  })
})
