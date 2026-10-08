import { whyNotRecordable, parseTarget, scopeOfChange } from './BudgetChangeDialog'
import { deltaForTarget } from '../services/budgetForecast'

// The module imports the real Supabase client to append its ledger row. The
// two refusals tested here happen before anything is written, so the client is
// stubbed away rather than rendered against — the same trick EntriesModal's
// test uses to reach `buildEntryItems`.
jest.mock('../supabase', () => ({ supabase: {} }))

const change = (over: Partial<{ reason: string; delta: number | null }> = {}) => ({
  reason: 'Rate up 8% from October', delta: 200, ...over,
})

describe('what the change dialog refuses to record', () => {
  it('records a change that names a reason and a difference', () => {
    expect(whyNotRecordable(change())).toBeNull()
  })

  it('refuses a change with no stated reason', () => {
    expect(whyNotRecordable(change({ reason: '' }))).toMatch(/Navedite razlog izmene/)
  })

  it('refuses a reason that is only whitespace', () => {
    // The point of the ledger is the reason. A figure moved by 200 RSD with a
    // space typed into the box is exactly the record it exists to prevent, and
    // ' ' is truthy, so a plain falsiness check lets it straight through.
    expect(whyNotRecordable(change({ reason: '   \n\t ' }))).toMatch(/Navedite razlog izmene/)
  })

  it('asks nothing about a company — the line belongs to the group', () => {
    // There used to be a refusal here: a ledger row needed one `company_id`
    // and the consolidated view had none to give. A budget line is the group's
    // now, the row carries `company_id: null`, and the only view that draws a
    // budget cell is the consolidated one. Nothing about the selector can stop
    // a change being recorded.
    expect(whyNotRecordable(change())).toBeNull()
    expect(JSON.stringify(whyNotRecordable({ reason: '', delta: 200 })))
      .not.toMatch(/company|firm/i)
  })

  it('refuses a change to the figure already there', () => {
    expect(whyNotRecordable(change({ delta: 0 }))).toMatch(/već postojeći iznos/)
  })
})

describe('the figure typed into the amount box', () => {
  it('reads a plain number', () => {
    expect(parseTarget('1200')).toBe(1200)
    expect(parseTarget('1200.55')).toBe(1200.55)
    expect(parseTarget('-40')).toBe(-40)
    expect(parseTarget(' 12 ')).toBe(12)
  })

  it('reads a typed zero as zero — that is how you budget nothing', () => {
    expect(parseTarget('0')).toBe(0)
    expect(parseTarget('0.00')).toBe(0)
  })

  it('reads an empty box as no figure at all, NOT as zero', () => {
    // `parseFloat('') || 0` made clearing the box a target of zero, i.e. a
    // delta of minus the whole current figure. An empty box means "I have not
    // typed anything".
    expect(parseTarget('')).toBeNull()
    expect(parseTarget('   ')).toBeNull()
  })

  it('reads an unparseable box as no figure either', () => {
    expect(parseTarget('abc')).toBeNull()
    expect(parseTarget('-')).toBeNull()
    expect(parseTarget('1,200')).toBeNull()
    // `parseFloat` would have returned 12 for this and recorded a figure
    // nobody typed.
    expect(parseTarget('12abc')).toBeNull()
  })
})

describe('what the change dialog refuses when no figure is typed', () => {
  it('refuses a change with an empty amount box, and says an empty box is not zero', () => {
    const refusal = whyNotRecordable(change({ delta: null }))
    expect(refusal).toMatch(/Prazno polje nije nula/)
  })

  it('still asks for the reason first, so a blank form is not merely missing a figure', () => {
    expect(whyNotRecordable({ reason: '', delta: null }))
      .toMatch(/Navedite razlog izmene/)
  })

  it('keeps a typed zero recordable — it is a deliberate figure', () => {
    // Zeroing a line is a real thing to want. It is the EMPTY box that is
    // refused, not the target of zero.
    const delta = deltaForTarget(500, parseTarget('0') as number)
    expect(delta).toBe(-500)
    expect(whyNotRecordable(change({ delta }))).toBeNull()
  })
})

describe('what the dialog says the change is about to land on', () => {
  // The header says "Change budget — SaaS expenses". That names the row and
  // says nothing about the consequence, and a parent with exactly one child
  // prints the SAME figure as that child one line above it — two identical
  // green numbers, both clickable, nothing between them. This is the sentence
  // that tells them apart.

  it('names the parent and the single line the change will not touch', () => {
    const scope = scopeOfChange('SaaS expenses', ['Figma'])
    expect(scope?.tone).toBe('parent')
    expect(scope?.text).toMatch(/SaaS expenses ima jednu stavku ispod sebe — Figma/)
    expect(scope?.text).toMatch(/beleži na samoj stavci SaaS expenses, ne na Figma/)
  })

  it('names the children while there are few enough to name', () => {
    const scope = scopeOfChange('SaaS expenses', ['Figma', 'Linear', 'Notion'])
    expect(scope?.text).toMatch(/ima 3 stavke ispod sebe — Figma, Linear, Notion/)
    expect(scope?.text).toMatch(/ne na stavkama ispod nje/)
  })

  it('counts them once naming sixty of them would be worse than counting', () => {
    // "Marketing: 8.000.000 RSD without itemising sixty lines" is a supported thing
    // to do. Sixty names in a notice is a wall, and a wall is not read.
    const scope = scopeOfChange('Marketing', Array.from({ length: 60 }, (_, i) => `Line ${i + 1}`))
    expect(scope?.text).toMatch(/ima 60 stavki ispod sebe, između ostalih Line 1, Line 2, Line 3\./)
    expect(scope?.text).not.toMatch(/Line 4/)
  })

  it('says something different, not nothing, about a leaf', () => {
    // An absent notice is not a statement. If the leaf case were silent then
    // the only signal would be the presence of a box, and a user who has never
    // seen the parent case has nothing to compare against.
    const scope = scopeOfChange('Figma', [])
    expect(scope?.tone).toBe('leaf')
    expect(scope?.text).toMatch(/Figma nema stavki ispod sebe/)
    expect(scope?.text).not.toMatch(/samoj stavci/)
  })

  it('says nothing at all when the caller has no tree to answer from', () => {
    // `AddBudgetLineDialog` builds a path the user typed rather than picking a
    // row off the tree, so it does not know. Guessing "leaf" there would state
    // something false about a path that may well have lines under it.
    expect(scopeOfChange('Administration → Office', undefined)).toBeNull()
    expect(scopeOfChange('Administration → Office', null)).toBeNull()
  })

  it('does not refuse, hedge, or ask for a confirmation', () => {
    // Budgeting on a parent is deliberate and supported. The fault was that it
    // happened silently — not that it happened.
    const scope = scopeOfChange('Marketing', ['Ads', 'Events'])
    expect(scope?.text).not.toMatch(/cannot|are you sure|confirm/i)
  })
})
