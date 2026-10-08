import {
  branchPath, countUnder, keysToDepth, layoutBranches, type BranchNode,
} from './branchTree'

const leaf = (key: string, amount: number): BranchNode => ({ key, label: key, amount })

const ROOTS: BranchNode[] = [
  {
    key: 'emp', label: 'Employee and Labour', amount: 113187.93,
    children: [leaf('Net salaries', 86420.4), leaf('Contributions', 26767.53)],
  },
  {
    key: 'prof', label: 'Professional and Production Services', amount: 99737.0,
    children: [
      leaf('Contractors', 71000.0),
      { key: 'prod', label: 'Production', amount: 28737.0,
        children: [leaf('Studio', 18737.0), leaf('Editing', 10000.0)] },
    ],
  },
  { key: 'gen', label: 'General Business', amount: 26759.0 },
  { key: 'nil', label: 'Budgeted at nothing', amount: 0 },
]

const OPTS = { rowHeight: 30, columnWidth: 200, nodeWidth: 170, maxLinkWidth: 24 }

describe('what is on screen and what is folded away', () => {
  it('starts as the top level alone', () => {
    const l = layoutBranches(ROOTS, new Set(), OPTS)
    expect(l.nodes.map(n => n.key).sort()).toEqual(['emp', 'gen', 'prof'])
    expect(l.links).toEqual([])
  })

  it('SAYS HOW MANY ROWS ARE FOLDED AWAY', () => {
    // Eleven categories with no word about the forty lines under them reads
    // as eleven lines, and a reader has no reason to look further.
    const l = layoutBranches(ROOTS, new Set(), OPTS)
    // Two under emp; four under prof — Contractors, Production, and the two
    // inside Production, because folded away is folded away at every depth.
    expect(l.hidden).toBe(2 + 4)
  })

  it('opens one node without opening its siblings', () => {
    const l = layoutBranches(ROOTS, new Set(['emp']), OPTS)
    expect(l.nodes.map(n => n.key)).toContain('Net salaries')
    expect(l.nodes.map(n => n.key)).not.toContain('Contractors')
  })

  it('opens a branch two deep', () => {
    const l = layoutBranches(ROOTS, new Set(['prof', 'prod']), OPTS)
    expect(l.nodes.map(n => n.key)).toContain('Studio')
    expect(l.nodes.find(n => n.key === 'Studio')!.depth).toBe(2)
  })

  it('leaves out anything budgeted at nothing', () => {
    // A branch of no thickness to a node of no amount is a line to nowhere.
    expect(layoutBranches(ROOTS, new Set(), OPTS).nodes.map(n => n.key))
      .not.toContain('nil')
  })

  it('has nothing to draw for an empty month', () => {
    expect(layoutBranches([], new Set(), OPTS).nodes).toEqual([])
    expect(layoutBranches([leaf('a', 0)], new Set(), OPTS).height).toBe(0)
  })
})

describe('where a node sits', () => {
  it('steps one column per level', () => {
    const l = layoutBranches(ROOTS, new Set(['prof', 'prod']), OPTS)
    const at = (k: string) => l.nodes.find(n => n.key === k)!
    expect(at('prof').x).toBe(0)
    expect(at('prod').x).toBe(200)
    expect(at('Studio').x).toBe(400)
  })

  it('PUTS A PARENT AT THE MIDDLE OF ITS OPEN CHILDREN', () => {
    // Which is what makes a branch read as a branch rather than as a list
    // with lines drawn on it.
    const l = layoutBranches(ROOTS, new Set(['emp']), OPTS)
    const at = (k: string) => l.nodes.find(n => n.key === k)!
    expect(at('emp').y).toBeCloseTo((at('Net salaries').y + at('Contributions').y) / 2, 6)
  })

  it('gives every drawn row its own slot, never two on one line', () => {
    const l = layoutBranches(ROOTS, new Set(['emp', 'prof', 'prod']), OPTS)
    const leaves = l.nodes.filter(n => !n.open)
    const ys = leaves.map(n => n.y).sort((a, b) => a - b)
    for (let i = 1; i < ys.length; i++) {
      expect(ys[i] - ys[i - 1]).toBeGreaterThanOrEqual(OPTS.rowHeight - 1e-6)
    }
  })

  it('grows taller as branches open, and no taller than it needs', () => {
    const shut = layoutBranches(ROOTS, new Set(), OPTS)
    const open = layoutBranches(ROOTS, new Set(['emp', 'prof', 'prod']), OPTS)
    expect(shut.height).toBe(3 * 30)
    expect(open.height).toBeGreaterThan(shut.height)
    // Five leaves under the two openable categories, plus General Business.
    expect(open.height).toBe(6 * 30)
  })
})

describe('how thick a branch is', () => {
  it('draws a branch in proportion to what it carries', () => {
    // The whole reason this is worth drawing rather than listing: a branch
    // carrying half the month should look like it carries half the month.
    const l = layoutBranches(ROOTS, new Set(['emp']), OPTS)
    const salaries = l.links.find(k => k.to === 'Net salaries')!
    const contrib = l.links.find(k => k.to === 'Contributions')!
    expect(salaries.width / contrib.width).toBeCloseTo(86420.4 / 26767.53, 3)
  })

  it('SCALES AGAINST THE WHOLE, not against each parent', () => {
    // Per level, the only child of a tiny category comes out as thick as the
    // biggest category in the month, which says the opposite of the truth
    // about it. Both are their parent's whole amount here, and they must not
    // come out the same width.
    const l = layoutBranches([
      { key: 'huge', label: 'huge', amount: 100000, children: [leaf('h1', 100000)] },
      { key: 'tiny', label: 'tiny', amount: 100, children: [leaf('t1', 100)] },
    ], new Set(['huge', 'tiny']), OPTS)
    const h = l.links.find(k => k.to === 'h1')!
    const t = l.links.find(k => k.to === 't1')!
    expect(h.width).toBe(OPTS.maxLinkWidth)
    expect(t.width).toBeLessThan(h.width / 10)
  })

  it('gives the same amount the same thickness wherever it hangs', () => {
    // The invariant the scaling exists for: thickness means dollars, not
    // "share of whichever parent this happens to be under".
    const l = layoutBranches([
      { key: 'a', label: 'a', amount: 60000, children: [leaf('a1', 30000), leaf('a2', 30000)] },
      { key: 'b', label: 'b', amount: 30000, children: [leaf('b1', 30000)] },
    ], new Set(['a', 'b']), OPTS)
    const w = (k: string) => l.links.find(x => x.to === k)!.width
    expect(w('a1')).toBeCloseTo(w('b1'), 9)
  })

  it('never draws a branch too thin to see or to hover', () => {
    const l = layoutBranches([
      { key: 'a', label: 'a', amount: 100000, children: [leaf('big', 99999), leaf('crumb', 1)] },
    ], new Set(['a']), OPTS)
    expect(l.links.find(k => k.to === 'crumb')!.width).toBeGreaterThanOrEqual(1.5)
  })

  it('leaves the parent horizontally and arrives horizontally', () => {
    // A straight diagonal crosses its neighbours at a shallow angle and two
    // of those are hard to tell apart where they nearly overlap.
    const l = layoutBranches(ROOTS, new Set(['emp']), OPTS)
    const d = branchPath(l.links[0])
    expect(d).toMatch(/^M [\d.]+ [\d.]+ C /)
    // The first control point shares the start's y, the last shares the end's.
    const [, sy, c1y] = /M [\d.]+ ([\d.]+) C [\d.]+ ([\d.]+)/.exec(d)!
    expect(Number(c1y)).toBeCloseTo(Number(sy), 6)
  })
})

describe('opening a whole level at once', () => {
  it('collects the keys that have children, down to the depth asked for', () => {
    expect(keysToDepth(ROOTS, 1)).toEqual(new Set(['emp', 'prof']))
    expect(keysToDepth(ROOTS, 2)).toEqual(new Set(['emp', 'prof', 'prod']))
  })

  it('asks for nothing at depth zero', () => {
    expect(keysToDepth(ROOTS, 0).size).toBe(0)
  })

  it('never names a leaf, which has nothing to open', () => {
    expect(keysToDepth(ROOTS, 5).has('gen')).toBe(false)
  })
})

describe('counting what is under a node', () => {
  it('counts every level, not just the children', () => {
    // Contractors, Production, and Production's own two.
    expect(countUnder(ROOTS[1])).toBe(4)
  })

  it('counts nothing under a leaf', () => {
    expect(countUnder(leaf('a', 10))).toBe(0)
  })

  it('does not count a child worth nothing', () => {
    expect(countUnder({ key: 'p', label: 'p', amount: 10, children: [leaf('z', 0)] })).toBe(0)
  })
})
