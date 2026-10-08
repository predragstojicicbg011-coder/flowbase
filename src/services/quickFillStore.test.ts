import {
  findCurrencyDifference, orderedForDifference,
  sortScripts, toRow, whyNotSavable, type ScriptDraft,
} from './quickFillStore'
import type { QuickFillScript } from '../data/quickfill'

const script = (id: string, name: string): QuickFillScript => ({
  id, name, icon: '', pl_category: 'Banking and Finance', pl_subcategory: '',
  department: '', dept_subcategory: '', expense_description: '',
  cf_type: '',
})

describe('findCurrencyDifference', () => {
  it('finds the template by what it is called', () => {
    const found = findCurrencyDifference([script('a', 'Bank fee'), script('b', 'Currency Differences')])
    expect(found?.id).toBe('b')
  })

  it('tolerates the trailing space the real one has', () => {
    expect(findCurrencyDifference([script('b', 'Currency Differences ')])?.id).toBe('b')
  })

  it('does not care about case or the singular', () => {
    expect(findCurrencyDifference([script('b', 'currency difference')])?.id).toBe('b')
  })

  it('recognises the Serbian name and the usual abbreviations', () => {
    expect(findCurrencyDifference([script('b', 'Kursne razlike')])?.id).toBe('b')
    expect(findCurrencyDifference([script('c', 'FX difference')])?.id).toBe('c')
  })

  it('says there is none rather than picking something close', () => {
    // Booking under a classification nobody chose is worse than refusing.
    expect(findCurrencyDifference([script('a', 'Bank fee'), script('b', 'Currency exchange')])).toBeNull()
    expect(findCurrencyDifference([])).toBeNull()
  })
})

describe('orderedForDifference', () => {
  it('puts the currency template first so it is the obvious choice', () => {
    const all = [script('a', 'Bank fee'), script('b', 'Currency Differences'), script('c', 'Rent')]
    expect(orderedForDifference(all).map(s => s.id)).toEqual(['b', 'a', 'c'])
  })

  it('changes nothing when there is no such template', () => {
    const all = [script('a', 'Bank fee'), script('c', 'Rent')]
    expect(orderedForDifference(all).map(s => s.id)).toEqual(['a', 'c'])
  })
})

// ─── The table ──────────────────────────────────────────────────────────────

describe('whyNotSavable', () => {
  const existing = [{ id: 'a', name: 'Bank fee' }, { id: 'b', name: 'Currency Differences' }]
  const draft = (over: Partial<ScriptDraft> = {}): ScriptDraft => ({
    name: 'Rent', icon: '', pl_category: '', pl_subcategory: '', department: '',
    dept_subcategory: '', expense_description: '',
    cf_type: '', ...over,
  })

  it('saves a template that only has a name', () => {
    // Leaving a level blank is legitimate: some costs stop at a department.
    expect(whyNotSavable(draft(), existing)).toBeNull()
  })

  it('refuses one with no name', () => {
    expect(whyNotSavable(draft({ name: '   ' }), existing)).toMatch(/name/i)
  })

  it('refuses a duplicate name, and names the one it clashes with', () => {
    // Matters more than usual here: the currency-difference control finds its
    // template BY NAME.
    expect(whyNotSavable(draft({ name: 'bank FEE ' }), existing)).toContain('Bank fee')
  })

  it('lets a template keep its own name while being edited', () => {
    expect(whyNotSavable(draft({ id: 'a', name: 'Bank fee' }), existing)).toBeNull()
  })
})

describe('sortScripts', () => {
  it('orders by sort_order, then by name', () => {
    const out = sortScripts([
      { name: 'Zebra', sort_order: 1 },
      { name: 'Apple', sort_order: 2 },
      { name: 'Beta', sort_order: 1 },
    ])
    expect(out.map(x => x.name)).toEqual(['Beta', 'Zebra', 'Apple'])
  })

  it('treats a missing order as the front', () => {
    expect(sortScripts([{ name: 'B', sort_order: 5 }, { name: 'A' }]).map(x => x.name))
      .toEqual(['A', 'B'])
  })

  it('does not disturb the array it was given', () => {
    const input = [{ name: 'B' }, { name: 'A' }]
    sortScripts(input)
    expect(input.map(x => x.name)).toEqual(['B', 'A'])
  })
})

describe('toRow', () => {
  it('trims the name and fills the defaults the table expects', () => {
    const row = toRow({
      name: '  Rent  ', icon: '', pl_category: 'Overheads', pl_subcategory: '',
      department: '', dept_subcategory: '', expense_description: '',
      cf_type: '',
    })
    expect(row.name).toBe('Rent')
    expect(row.cf_type).toBe('')
    expect(row.sort_order).toBe(0)
  })

  it('carries no id, so the same shape serves an insert and an update', () => {
    expect(Object.keys(toRow({
      id: 'x', name: 'Rent', icon: '', pl_category: '', pl_subcategory: '',
      department: '', dept_subcategory: '', expense_description: '',
      cf_type: '',
    }))).not.toContain('id')
  })

  /** A template is a classification. A project is chosen per document, and
   *  the columns that used to allocate (rev_alloc, opex_type) are gone. */
  it('writes no allocation and no project', () => {
    const keys = Object.keys(toRow({
      name: 'Rent', icon: '', pl_category: '', pl_subcategory: '',
      department: '', dept_subcategory: '', expense_description: '', cf_type: '',
    }))
    expect(keys).not.toContain('rev_alloc')
    expect(keys).not.toContain('opex_type')
    expect(keys).not.toContain('project_id')
  })
})
