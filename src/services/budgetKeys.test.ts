import {
  makeClassKey, classKeysUnder, valueAt, placeEntry, nodeKeyForEntry,
  classificationFor, seedForEntry, nodeKeysUnder, UNASSIGNED,
  type ClassifiedEntry, type SeedsByCompany,
} from './budgetKeys'
import {
  applyLedger, rollUp,
  type Adjustment, type ForecastNode, type Level,
} from './budgetForecast'

/** The two orders the five classification levels are read in. */
type Branch = 'department' | 'pl'

describe('the budget classification key', () => {
  it('folds null and empty string into the same key', () => {
    const withNulls = makeClassKey({
      pl_category: 'Operating Expenses',
      pl_subcategory: null,
      department: null,
      dept_subcategory: null,
      expense_description: null,
    })
    const withEmpties = makeClassKey({
      pl_category: 'Operating Expenses',
      pl_subcategory: '',
      department: '',
      dept_subcategory: '',
      expense_description: '',
    })
    expect(withNulls).toBe(withEmpties)
    expect(withNulls).toBe('Operating Expenses||||')
  })

  it('treats a missing property the same as a null one', () => {
    expect(makeClassKey({ pl_category: 'Payroll' }))
      .toBe(makeClassKey({
        pl_category: 'Payroll', pl_subcategory: null, department: null,
        dept_subcategory: null, expense_description: null,
      }))
  })

  it('gives an all-empty row the empty key', () => {
    expect(makeClassKey({})).toBe('||||')
    expect(makeClassKey({
      pl_category: null, pl_subcategory: null, department: null,
      dept_subcategory: null, expense_description: null,
    })).toBe('||||')
  })

  it('keeps the five segments in classification order', () => {
    expect(makeClassKey({
      pl_category: 'a', pl_subcategory: 'b', department: 'c',
      dept_subcategory: 'd', expense_description: 'e',
    })).toBe('a|b|c|d|e')
  })

  // Known limitation: `|` is the separator, so a classification value
  // containing one produces a key that splits into more than five segments,
  // and two different classifications can produce the same key. Fixing it
  // means escaping the separator here and re-parsing everything built from a
  // key.
  it('is ambiguous for a value containing a literal pipe (known limitation)', () => {
    const collision = makeClassKey({ pl_category: 'a|b', pl_subcategory: 'c' })
    const other = makeClassKey({ pl_category: 'a', pl_subcategory: 'b|c' })
    expect(collision).toBe('a|b|c|||')
    expect(other).toBe(collision)
  })

  it('leaves a pipe-bearing value intact in the key it produces', () => {
    // The row is not dropped and the value is not escaped: it is carried into
    // the key verbatim, which is exactly why the segments no longer line up.
    expect(makeClassKey({ department: 'R&D | Platform' }))
      .toBe('||R&D | Platform||')
    // Five segments were joined; six come back out.
    expect(makeClassKey({ department: 'R&D | Platform' }).split('|'))
      .toHaveLength(6)
  })
})

describe('the keys under a budget row', () => {
  // The shape Budgeting builds: `cat:` → `dept:` → `leaf:`, each row carrying
  // the classification key its own cells were summed from.
  const tree = [
    { key: 'cat:Opex', classKey: 'Opex||||' },
    { key: 'dept:Opex||Sales', parent: 'cat:Opex', classKey: 'Opex||Sales||' },
    { key: 'leaf:Opex||Sales||Ads', parent: 'dept:Opex||Sales', classKey: 'Opex||Sales||Ads' },
    { key: 'dept:Opex||Legal', parent: 'cat:Opex', classKey: 'Opex||Legal||' },
  ]

  // The regression commit 219e466 fixed. `dept:Opex||Sales` holds rows
  // classified no further than the department AND parents the ones with a
  // description; a `!hasChildren` filter drops the former from the drill-down
  // while they stay in the total the drill-down was opened from.
  it('returns both a node own key and its children keys', () => {
    expect(classKeysUnder(tree, 'dept:Opex||Sales').sort())
      .toEqual(['Opex||Sales||', 'Opex||Sales||Ads'])
  })

  it('reaches a key several levels below the root', () => {
    expect(classKeysUnder(tree, 'cat:Opex').sort())
      .toEqual(['Opex||||', 'Opex||Legal||', 'Opex||Sales||', 'Opex||Sales||Ads'].sort())
  })

  it('does not reach across to a sibling branch', () => {
    expect(classKeysUnder(tree, 'dept:Opex||Legal')).toEqual(['Opex||Legal||'])
  })

  it('returns nothing for a leaf, not even its siblings', () => {
    expect(classKeysUnder(tree, 'leaf:Opex||Sales||Ads')).toEqual(['Opex||Sales||Ads'])
  })

  it('returns an empty list for a key that is not in the tree', () => {
    // The drill-down turns this into "no rows". It must never be read as
    // "no filter", which would list the whole month.
    expect(classKeysUnder(tree, 'dept:Nope')).toEqual([])
    expect(classKeysUnder([], 'cat:Opex')).toEqual([])
  })

  it('skips a row that carries no classification key', () => {
    const rows = [
      { key: 'cat:Opex' },
      { key: 'dept:Opex||Sales', parent: 'cat:Opex', classKey: 'Opex||Sales||' },
    ]
    expect(classKeysUnder(rows, 'cat:Opex')).toEqual(['Opex||Sales||'])
  })

  it('returns every key a node was summed from, not just the first', () => {
    // A branch showing three of the five levels puts every row matching those
    // three on one node whatever its P&L classification, so the node's total
    // is summed from several keys and its drill-down must list all of them.
    const branchTree = [
      { key: 'department:Sales', classKeys: ['Opex||Sales||', 'Other||Sales||'] },
      {
        key: 'department:Sales|Ads', parent: 'department:Sales',
        classKeys: ['Opex||Sales||Ads', 'Other||Sales||Ads'],
      },
    ]
    expect(classKeysUnder(branchTree, 'department:Sales').sort())
      .toEqual(['Opex||Sales||', 'Opex||Sales||Ads', 'Other||Sales||', 'Other||Sales||Ads'])
  })

  it('lists a key held by both a node and its child only once', () => {
    const rows = [
      { key: 'root', classKeys: ['A||||'] },
      { key: 'child', parent: 'root', classKey: 'A||||' },
    ]
    expect(classKeysUnder(rows, 'root')).toEqual(['A||||'])
  })

  it('lists the node keys of the subtree, which is what a cell is summed from', () => {
    expect(nodeKeysUnder(tree, 'dept:Opex||Sales').sort())
      .toEqual(['dept:Opex||Sales', 'leaf:Opex||Sales||Ads'])
    expect(nodeKeysUnder(tree, 'cat:Opex')).toHaveLength(4)
    expect(nodeKeysUnder(tree, 'leaf:Opex||Sales||Ads')).toEqual(['leaf:Opex||Sales||Ads'])
    expect(nodeKeysUnder(tree, 'dept:Nope')).toEqual([])
  })

  it('gathers a subtree ledger that adds up to the movement the cell made', () => {
    // The drill's Changes section is scoped the way its seeded section is,
    // because `rollUp` makes a cell the sum of its own figure and every
    // descendant's. Reading one node's own ledger said "Never changed" beside
    // a parent whose child had been adjusted.
    const rows = [
      { key: 'Sales' },
      { key: 'Sales|Reps', parent: 'Sales' },
    ]
    const ledgerByNode: Record<string, Adjustment[]> = {
      'Sales|Reps': [{
        id: 'a1', kind: 'adjust', amount_usd: 250,
        reason: 'Two more reps', created_at: '2026-01-01T00:00:00Z',
      }],
    }
    const nodes: ForecastNode[] = [
      { key: 'Sales', label: 'Sales', level: 'department', parent: null, seed: 1000, ledger: 0, actual: 0 },
      { key: 'Sales|Reps', label: 'Reps', level: 'dept_subcategory', parent: 'Sales', seed: 400, ledger: 250, actual: 0 },
    ]
    const parent = rollUp(nodes).find(n => n.key === 'Sales')!
    const under = nodeKeysUnder(rows, 'Sales')

    // The node's own ledger is empty; the cell moved all the same.
    expect(ledgerByNode['Sales']).toBeUndefined()

    const seeded = nodes.filter(n => under.includes(n.key)).reduce((s, n) => s + n.seed, 0)
    const movement = under
      .flatMap(k => ledgerByNode[k] || [])
      .reduce((s, a) => s + a.amount_usd, 0)
    expect(movement).toBe(250)
    expect(parent.budget - seeded).toBe(movement)
  })

  it('terminates on a parent chain that forms a cycle', () => {
    // Row keys are strings, so nothing in the type system prevents a loop. An
    // unguarded ancestor walk hangs the render thread; this must return.
    const cyclic = [
      { key: 'a', parent: 'b', classKey: 'A||||' },
      { key: 'b', parent: 'a', classKey: 'B||||' },
      { key: 'c', parent: 'c', classKey: 'C||||' },
      { key: 'root', classKey: 'R||||' },
    ]
    expect(classKeysUnder(cyclic, 'root')).toEqual(['R||||'])
    // A root inside the cycle is still found, once, without looping.
    expect(classKeysUnder(cyclic, 'a').sort()).toEqual(['A||||', 'B||||'])
    expect(classKeysUnder(cyclic, 'c')).toEqual(['C||||'])
    expect(nodeKeysUnder(cyclic, 'root')).toEqual(['root'])
    expect(nodeKeysUnder(cyclic, 'a').sort()).toEqual(['a', 'b'])
  })
})

// ─── Where a ledger entry lands, and why the two branches still agree ─────────

const DEPT: Level[] = ['department', 'dept_subcategory', 'expense_description']
const PL: Level[] = ['pl_category', 'pl_subcategory', 'expense_description']
const LEVELS: Record<Branch, Level[]> = { department: DEPT, pl: PL }

describe('placing a ledger entry in a branch', () => {
  const entry = (over: Partial<ClassifiedEntry> = {}): ClassifiedEntry => ({
    level: 'department', pl_category: null, pl_subcategory: null,
    department: null, dept_subcategory: null, expense_description: null, ...over,
  })

  it('places an entry at its own level when the branch shows that level', () => {
    const e = entry({ level: 'dept_subcategory', department: 'Sales', dept_subcategory: 'Reps' })
    expect(placeEntry(e, DEPT)).toEqual({
      pathLabels: ['Sales', 'Reps'], level: 'dept_subcategory', key: 'Sales|Reps',
    })
  })

  it('places an entry recorded at a level the branch does not show, rather than dropping it', () => {
    // This is the bug. `dept_subcategory` is not one of the P&L branch levels,
    // and the page used to `continue` past it — so the amount was in the
    // department branch total and absent from the P&L one, and the two
    // disagreed by exactly that amount. It must be PLACED, not skipped.
    const e = entry({
      level: 'dept_subcategory', department: 'Sales', dept_subcategory: 'Reps',
      pl_category: 'Payroll', pl_subcategory: 'Salaries',
    })
    // As deep as it can honestly go in the P&L ordering: it carries a P&L
    // category and sub-category, so it lands on that node — the right row.
    expect(nodeKeyForEntry(e, PL)).toBe('Payroll|Salaries')
    expect(nodeKeyForEntry(e, DEPT)).toBe('Sales|Reps')
  })

  it('lands an entry with no value for any level of the branch under Unassigned', () => {
    // No department and no dept_subcategory: the department branch has nowhere
    // honest to file it, so it goes on the FIRST level under `Unassigned` — a
    // real row carrying a real figure — and never nowhere.
    const e = entry({ level: 'pl_subcategory', pl_category: 'Payroll', pl_subcategory: 'Salaries' })
    const placed = placeEntry(e, DEPT)
    expect(placed.key).toBe('Unassigned')
    expect(placed.pathLabels).toEqual(['Unassigned'])
    expect(placed.level).toBe('department')
  })

  it('uses Unassigned for a level between the ones the entry does carry', () => {
    // Exactly what `valueAt` does for a source row, so the entry lands on the
    // same node the tree already built for keys with that hole in them.
    const e = entry({ level: 'expense_description', expense_description: 'Laptops' })
    expect(placeEntry(e, DEPT).pathLabels).toEqual(['Unassigned', 'Unassigned', 'Laptops'])
  })

  it('never returns an empty placement, whatever the entry carries', () => {
    for (const levels of [DEPT, PL]) {
      const placed = placeEntry(entry({ level: 'nonsense_level' }), levels)
      expect(placed.pathLabels.length).toBeGreaterThan(0)
      expect(placed.key).toBe(UNASSIGNED)
    }
  })
})

describe('the classification a change is filed under', () => {
  it('takes the shown levels from the node path, not from any one class key', () => {
    const c = classificationFor(['Sales', 'Reps'], 'dept_subcategory',
      ['Payroll|Salaries|Sales|Reps|Base pay'], DEPT)
    expect(c.department).toBe('Sales')
    expect(c.dept_subcategory).toBe('Reps')
    // Deeper than the node itself: the node does not claim a description.
    expect(c.expense_description).toBeNull()
  })

  it('records a hidden level every class key agrees on', () => {
    // A P&L node holding only Sales rows genuinely IS Sales, so recording the
    // department lands the change on the right row in the other branch too.
    const c = classificationFor(['Payroll', 'Salaries'], 'pl_subcategory', [
      'Payroll|Salaries|Sales|Reps|Base pay',
      'Payroll|Salaries|Sales|Reps|Bonus',
    ], PL)
    expect(c.department).toBe('Sales')
    expect(c.dept_subcategory).toBe('Reps')
  })

  it('records null for a hidden level the class keys disagree on', () => {
    // Salaries spanning Sales and Engineering cannot be attributed to one
    // department. Guessing would put the money on a department not paying it.
    const c = classificationFor(['Payroll', 'Salaries'], 'pl_subcategory', [
      'Payroll|Salaries|Sales|Reps|Base pay',
      'Payroll|Salaries|Engineering|Backend|Base pay',
    ], PL)
    expect(c.department).toBeNull()
    expect(c.dept_subcategory).toBeNull()
    expect(c.pl_category).toBe('Payroll')
    expect(c.pl_subcategory).toBe('Salaries')
  })

  it('records null for a hidden level when the node has no class keys at all', () => {
    // A row that exists only because something was budgeted against it.
    const c = classificationFor(['Sales'], 'department', [], DEPT)
    expect(c.department).toBe('Sales')
    expect(c.pl_category).toBeNull()
    expect(c.pl_subcategory).toBeNull()
  })

  it('stores Unassigned as the null it stands for', () => {
    const c = classificationFor(['Unassigned'], 'department', [], DEPT)
    expect(c.department).toBeNull()
  })

  it('records null where the keys carry nothing — an empty segment is not a value', () => {
    const c = classificationFor(['Payroll', 'Salaries'], 'pl_subcategory',
      ['Payroll|Salaries|||'], PL)
    expect(c.department).toBeNull()
  })
})

describe('the seed a set entry is measured against', () => {
  const MONTH = '2026-03'
  const CO = 'company-1'
  const seedsByKey: Record<string, Record<string, number>> = {
    'Payroll|Salaries|Sales|Reps|Base pay': { [MONTH]: 120000 },
    'Payroll|Salaries|Engineering|Backend|Base pay': { [MONTH]: 80000 },
  }
  const seedsByCompany: SeedsByCompany = { [CO]: seedsByKey }

  it('is everything under the classification the entry does name', () => {
    // A level the entry carries no value for is "not classified this far", so
    // a department-level entry is measured against everything seeded to that
    // department. This is the rule the whole function exists for.
    expect(seedForEntry({ company_id: CO, department: 'Sales' }, seedsByCompany, MONTH)).toBe(120000)
    expect(seedForEntry({ company_id: CO, pl_category: 'Payroll' }, seedsByCompany, MONTH)).toBe(200000)
  })

  it('is nothing for a company that seeded nothing', () => {
    expect(seedForEntry({ company_id: 'other', department: 'Sales' }, seedsByCompany, MONTH)).toBe(0)
  })

  it('is nothing at all for an entry that names no classification', () => {
    // Reachable from live data, not hypothetical: the carry-across in
    // 20260917130000_budget_adjustments.sql falls through to `else
    // 'pl_category'`, so a budget_entries row with no classification at all
    // becomes a `set` at level 'pl_category' with five null columns.
    //
    // "Not classified this far, matches any value" applied to every column at
    // once compares nothing and matches everything, and the entry is measured
    // against the WHOLE MONTH's seed. One such row for $5,000 against a month
    // seeded $200,000 resolved to an adjust of -195,000 and the month read
    // $5,000 instead of $205,000 — the figure swallowed the month.
    expect(seedForEntry({ company_id: CO }, seedsByCompany, MONTH)).toBe(0)
    expect(seedForEntry({
      company_id: CO,
      pl_category: null, pl_subcategory: null,
      department: null, dept_subcategory: null, expense_description: null,
    }, seedsByCompany, MONTH)).toBe(0)
    expect(seedForEntry({
      company_id: CO,
      pl_category: '', pl_subcategory: '',
      department: '', dept_subcategory: '', expense_description: '',
    }, seedsByCompany, MONTH)).toBe(0)
  })

  it('is nothing for a month nothing was seeded into', () => {
    expect(seedForEntry({ company_id: CO, department: 'Sales' }, seedsByCompany, '2026-04')).toBe(0)
  })

  it('is the entry own company seed, never the seed of every company on screen', () => {
    // Consolidated, the tree merges both companies under one classification
    // key. The seed a `set` is MEASURED against may not merge with them: a
    // figure recorded on company A's Sales line says what A's Sales line
    // reads, and resolving it against A+B turns a +200 into a -800.
    const twoCompanies: SeedsByCompany = {
      A: { '||Sales||': { [MONTH]: 1000 } },
      B: { '||Sales||': { [MONTH]: 1000 } },
    }
    expect(seedForEntry({ company_id: 'A', department: 'Sales' }, twoCompanies, MONTH)).toBe(1000)
    expect(seedForEntry({ company_id: 'B', department: 'Sales' }, twoCompanies, MONTH)).toBe(1000)
  })
})

describe('the invariant: the two branches total the same', () => {
  // The seeded base, as classification keys. The same money whichever order
  // the levels are read in.
  const seeds: Record<string, number> = {
    'Payroll|Salaries|Sales|Reps|Base pay': 1000,
    'Payroll|Salaries|Engineering|Backend|Base pay': 2000,
    'Opex|Software|||': 500,
  }

  /** One month of it, in the shape `seedFromEntries` returns and the page holds. */
  const MONTH = '2026-03'
  /** This block is one company; the consolidated case has its own block below. */
  const CO = 'company-1'
  const seedsByCompany: SeedsByCompany = {
    [CO]: Object.fromEntries(
      Object.entries(seeds).map(([classKey, amount]) => [classKey, { [MONTH]: amount }])),
  }

  /**
   * What the page total row reads for one branch, built the way Budgeting
   * builds it: walk every key down the branch levels, credit the seed to the
   * key final node, place every ledger entry, roll up, sum the roots.
   */
  function branchTotal(branch: Branch, entries: ClassifiedEntry[]): number {
    const levels = LEVELS[branch]
    const rows: Record<string, ForecastNode> = {}
    const seedByNode: Record<string, number> = {}

    const ensure = (key: string, level: Level, label: string, parent: string | null) => {
      if (!rows[key]) rows[key] = { key, label, level, parent, seed: 0, ledger: 0, actual: 0 }
    }

    for (const ck of Object.keys(seeds)) {
      const parts = ck.split('|')
      const labels: string[] = []
      let parent: string | null = null
      let nodeKey = ''
      for (const level of levels) {
        labels.push(valueAt(parts, level))
        nodeKey = `${branch}:${labels.join('|')}`
        ensure(nodeKey, level, labels[labels.length - 1], parent)
        parent = nodeKey
      }
      seedByNode[nodeKey] = (seedByNode[nodeKey] || 0) + seeds[ck]
    }

    const ledger: Record<string, Adjustment[]> = {}
    for (const e of entries) {
      const placed = placeEntry(e, levels)
      const nodeKey = `${branch}:${placed.key}`
      // `ledgerPaths`: a figure in the total always has a row on screen.
      let parent: string | null = null
      for (let i = 0; i < placed.pathLabels.length; i++) {
        const key = `${branch}:${placed.pathLabels.slice(0, i + 1).join('|')}`
        ensure(key, levels[i], placed.pathLabels[i], parent)
        parent = key
      }
      if (!ledger[nodeKey]) ledger[nodeKey] = []
      ledger[nodeKey].push(e as unknown as Adjustment)
    }

    const nodes = Object.values(rows).map(n => {
      const seed = seedByNode[n.key] || 0
      // Budgeting resolves every `set` into a branch-independent delta before
      // the ledger reaches `applyLedger`. This harness calls the same function
      // rather than restating the rule: a second copy of it is how a harness
      // stops describing the page it is supposed to be testing.
      const resolved = (ledger[n.key] || []).map(a => a.kind !== 'set' ? a : {
        ...a,
        kind: 'adjust' as const,
        amount_usd: a.amount_usd
          - seedForEntry(a as unknown as ClassifiedEntry, seedsByCompany, MONTH),
      })
      return { ...n, seed, ledger: applyLedger(seed, resolved) - seed }
    })
    return rollUp(nodes).filter(n => !n.parent).reduce((s, n) => s + n.budget, 0)
  }

  const adjustment = (
    over: Partial<ClassifiedEntry> & Partial<Adjustment> & { amount_usd: number },
  ): ClassifiedEntry => ({
    id: 'a1', kind: 'adjust', reason: 'because', created_at: '2026-01-01T00:00:00Z',
    company_id: CO,
    level: 'department', pl_category: null, pl_subcategory: null,
    department: null, dept_subcategory: null, expense_description: null,
    ...over,
  } as unknown as ClassifiedEntry)

  it('agrees before anything is recorded', () => {
    expect(branchTotal('department', [])).toBe(3500)
    expect(branchTotal('pl', [])).toBe(3500)
  })

  it('agrees after a change recorded at dept_subcategory, which the P&L branch does not show', () => {
    // The regression this describe block exists for. The P&L branch used to
    // skip this entry outright, and its total stayed at 3500 while the
    // department branch read 3650.
    const e = adjustment({
      level: 'dept_subcategory', amount_usd: 150,
      department: 'Sales', dept_subcategory: 'Reps',
      pl_category: 'Payroll', pl_subcategory: 'Salaries',
    })
    expect(branchTotal('department', [e])).toBe(3650)
    expect(branchTotal('pl', [e])).toBe(3650)
  })

  it('agrees after a change recorded at pl_subcategory, which the department branch does not show', () => {
    const e = adjustment({
      level: 'pl_subcategory', amount_usd: 300,
      pl_category: 'Payroll', pl_subcategory: 'Salaries',
    })
    expect(branchTotal('pl', [e])).toBe(3800)
    expect(branchTotal('department', [e])).toBe(3800)
  })

  it('agrees for a change recorded at every one of the five levels', () => {
    const all: Level[] = [
      'pl_category', 'pl_subcategory', 'department', 'dept_subcategory', 'expense_description',
    ]
    for (const level of all) {
      const e = adjustment({
        level, amount_usd: 77,
        pl_category: 'Payroll', pl_subcategory: 'Salaries',
        department: 'Sales', dept_subcategory: 'Reps', expense_description: 'Base pay',
      })
      expect(branchTotal('department', [e])).toBe(branchTotal('pl', [e]))
      expect(branchTotal('pl', [e])).toBe(3577)
    }
  })

  it('round trip: recorded against a node in one branch, read in the other, the totals still match', () => {
    // Record a change on the P&L node `Payroll → Salaries`, which spans Sales
    // and Engineering. `classificationFor` is what the dialog stores and
    // `placeEntry` is what the page reads back — this is the whole loop, and it
    // is the test that would have caught the skip.
    const classKeys = [
      'Payroll|Salaries|Sales|Reps|Base pay',
      'Payroll|Salaries|Engineering|Backend|Base pay',
    ]
    const stored = classificationFor(['Payroll', 'Salaries'], 'pl_subcategory', classKeys, PL)
    // It spans two departments, so it names neither.
    expect(stored.department).toBeNull()

    const e = adjustment({ ...stored, level: 'pl_subcategory', amount_usd: 420 })

    // Where the user sees it: on the node it was recorded against in the P&L
    // branch, and under `Unassigned` in the department branch — truthfully,
    // because no single department is paying it.
    expect(nodeKeyForEntry(e, PL)).toBe('Payroll|Salaries')
    expect(nodeKeyForEntry(e, DEPT)).toBe('Unassigned')

    expect(branchTotal('pl', [e])).toBe(3920)
    expect(branchTotal('department', [e])).toBe(3920)
  })

  // ── Carried-over `set` entries ─────────────────────────────────────────────
  //
  // 20260917130000_budget_adjustments.sql carried every budget_entries row
  // across as an opening `set`, so `set` rows are live data, not a shape only
  // the dialog could produce. An `adjust` contributes the same delta whichever
  // node it lands on, which is why the tests above pass. A `set` does not.

  it('agrees after a set, where the node it lands on is seeded differently in the two branches', () => {
    // The department branch puts this on `Sales|Reps|Base pay`, seeded 1000.
    // The P&L branch puts it on `Payroll|Salaries|Base pay`, seeded 3000 -
    // Sales and Engineering salaries are one node there.
    const e = adjustment({
      kind: 'set', level: 'expense_description', amount_usd: 5000,
      pl_category: 'Payroll', pl_subcategory: 'Salaries',
      department: 'Sales', dept_subcategory: 'Reps', expense_description: 'Base pay',
    })
    expect(branchTotal('department', [e])).toBe(branchTotal('pl', [e]))
    // 3500 seeded, less the 1000 this entry's own classification carries,
    // plus the 5000 it says the line reads.
    expect(branchTotal('department', [e])).toBe(7500)
  })

  it('agrees after a set followed by an adjust', () => {
    const s = adjustment({
      id: 'a1', created_at: '2026-01-01T00:00:00Z',
      kind: 'set', level: 'expense_description', amount_usd: 5000,
      pl_category: 'Payroll', pl_subcategory: 'Salaries',
      department: 'Sales', dept_subcategory: 'Reps', expense_description: 'Base pay',
    })
    const a = adjustment({
      id: 'a2', created_at: '2026-02-01T00:00:00Z',
      kind: 'adjust', level: 'expense_description', amount_usd: 250,
      pl_category: 'Payroll', pl_subcategory: 'Salaries',
      department: 'Sales', dept_subcategory: 'Reps', expense_description: 'Base pay',
    })
    expect(branchTotal('department', [s, a])).toBe(branchTotal('pl', [s, a]))
    expect(branchTotal('department', [s, a])).toBe(7750)
  })

  it('agrees for the carried-over shape: a set on a node seeded in one branch and unseeded in the other', () => {
    // Exactly what the migration produced - a fully classified budget_entries
    // row carried across as one opening `set` at expense_description. Marketing
    // has no history, so the department branch node is unseeded, while the P&L
    // node it shares with Sales and Engineering is seeded 3000.
    const e = adjustment({
      kind: 'set', level: 'expense_description', amount_usd: 800,
      pl_category: 'Payroll', pl_subcategory: 'Salaries',
      department: 'Marketing', dept_subcategory: null, expense_description: 'Base pay',
    })
    expect(branchTotal('department', [e])).toBe(branchTotal('pl', [e]))
    // Nothing is seeded to Marketing, so the whole 800 is new money.
    expect(branchTotal('department', [e])).toBe(4300)
  })

  it('does not let a set with no classification at all swallow the month', () => {
    // The other shape the migration produced: a budget_entries row carrying no
    // classification falls through `else 'pl_category'` and lands here as a
    // `set` at pl_category with five null columns. Measured against the whole
    // month it resolved to 5000 - 3500 = 1500 and the month read 5000 instead
    // of 8500 — the seeded 3500 vanished behind one unclassified figure.
    const e = adjustment({
      kind: 'set', level: 'pl_category', amount_usd: 5000,
      pl_category: null, pl_subcategory: null,
      department: null, dept_subcategory: null, expense_description: null,
    })
    expect(branchTotal('department', [e])).toBe(branchTotal('pl', [e]))
    expect(branchTotal('department', [e])).toBe(8500)
  })

  it('round trip: a node spanning one department only lands on that department row', () => {
    const stored = classificationFor(['Opex', 'Software'], 'pl_subcategory',
      ['Opex|Software|Sales|Reps|Seats'], PL)
    expect(stored.department).toBe('Sales')

    const e = adjustment({ ...stored, level: 'pl_subcategory', amount_usd: 60 })
    expect(nodeKeyForEntry(e, DEPT)).toBe('Sales|Reps')
    expect(branchTotal('pl', [e])).toBe(3560)
    expect(branchTotal('department', [e])).toBe(3560)
  })
})

describe('the invariant: a group total is the sum of the companies in it', () => {
  // Consolidated, the tree merges every selected company under one
  // classification key — which is right, because the group's Sales line IS
  // both companies' Sales spend. The seed a `set` is measured against may not
  // merge with it: a figure recorded on company A's Sales line says what A's
  // Sales line reads, and nothing about B's.
  //
  // Companies A and B each seed `department = Sales` at 1,000 for October.
  // A `set` on A's Sales for 1,200. Alone, A reads 1,200. Consolidated, the
  // group must read 2,200 — 1,200 for A and B's untouched 1,000 — and it read
  // 1,200, because the set was resolved against the combined 2,000 and came
  // out as −800.
  const MONTH = '2026-10'
  const seedRows = [
    { company_id: 'A', classKey: '||Sales||', amount: 1000 },
    { company_id: 'B', classKey: '||Sales||', amount: 1000 },
  ]

  const setOnA = {
    id: 'a1', kind: 'set', amount_usd: 1200, reason: 'because',
    created_at: '2026-01-01T00:00:00Z', company_id: 'A', level: 'department',
    pl_category: null, pl_subcategory: null,
    department: 'Sales', dept_subcategory: null, expense_description: null,
  }

  /**
   * What the page total reads with these companies selected, built the way
   * `Budgeting` builds it: seed each selected company separately, merge them
   * into the tree, resolve every `set` against its OWN company's seed, roll
   * up, sum the roots.
   */
  function pageTotal(companies: string[], entries: typeof setOnA[]): number {
    const rows: Record<string, ForecastNode> = {}
    const seedByNode: Record<string, number> = {}
    const seedsByCompany: SeedsByCompany = {}

    const walk = (labels: string[]): string => {
      let parent: string | null = null
      let nodeKey = ''
      for (let i = 0; i < labels.length; i++) {
        nodeKey = labels.slice(0, i + 1).join('|')
        if (!rows[nodeKey]) {
          rows[nodeKey] = {
            key: nodeKey, label: labels[i], level: DEPT[i], parent,
            seed: 0, ledger: 0, actual: 0,
          }
        }
        parent = nodeKey
      }
      return nodeKey
    }

    for (const s of seedRows) {
      if (!companies.includes(s.company_id)) continue
      if (!seedsByCompany[s.company_id]) seedsByCompany[s.company_id] = {}
      const perKey = seedsByCompany[s.company_id]
      if (!perKey[s.classKey]) perKey[s.classKey] = {}
      perKey[s.classKey][MONTH] = (perKey[s.classKey][MONTH] || 0) + s.amount
      // The tree itself is company-blind: one Sales node for the group.
      const parts = s.classKey.split('|')
      const nodeKey = walk(DEPT.map(l => valueAt(parts, l)))
      seedByNode[nodeKey] = (seedByNode[nodeKey] || 0) + s.amount
    }

    const ledger: Record<string, Adjustment[]> = {}
    for (const e of entries) {
      if (!companies.includes(e.company_id)) continue
      const placed = placeEntry(e as unknown as ClassifiedEntry, DEPT)
      walk(placed.pathLabels)
      // The same resolution `Budgeting` does, calling the same function rather
      // than restating the rule.
      const resolved = e.kind !== 'set' ? e : {
        ...e,
        kind: 'adjust',
        amount_usd: e.amount_usd
          - seedForEntry(e as unknown as ClassifiedEntry, seedsByCompany, MONTH),
      }
      if (!ledger[placed.key]) ledger[placed.key] = []
      ledger[placed.key].push(resolved as unknown as Adjustment)
    }

    const nodes = Object.values(rows).map(n => {
      const seed = seedByNode[n.key] || 0
      return { ...n, seed, ledger: applyLedger(seed, ledger[n.key] || []) - seed }
    })
    return rollUp(nodes).filter(n => !n.parent).reduce((s, n) => s + n.budget, 0)
  }

  it('reads the changed figure for the company the change was recorded on', () => {
    expect(pageTotal(['A'], [setOnA])).toBe(1200)
  })

  it('leaves the other company alone', () => {
    expect(pageTotal(['B'], [setOnA])).toBe(1000)
  })

  it('totals the group as the sum of its companies', () => {
    expect(pageTotal(['A', 'B'], [setOnA]))
      .toBe(pageTotal(['A'], [setOnA]) + pageTotal(['B'], [setOnA]))
    expect(pageTotal(['A', 'B'], [setOnA])).toBe(2200)
  })

  it('totals the group as the sum of its companies with nothing recorded at all', () => {
    expect(pageTotal(['A', 'B'], [])).toBe(pageTotal(['A'], []) + pageTotal(['B'], []))
  })
})
