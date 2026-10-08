// ── The budget classification key ────────────────────────────────────────────
//
// One key function, used to sum the totals and to pick the rows behind them.
// Two predicates that have to be kept in step will drift; this cannot.
//
// The budget tree groups expenses by the five classification columns. A cell's
// total is the sum of every row whose key matches; the drill-down behind that
// cell is every row whose key matches. Both sides call this, so the list under
// a number is the same set the number was summed from — by construction, not by
// two filters someone has to remember to change together.
//
// The second half of the file answers the other half of the question: given a
// key or a ledger row, WHICH node of the open branch does it sit on. Both
// branches read it, which is what keeps their totals equal.
//
// ── The project is part of the line ──────────────────────────────────────────
//
// A budget line is a classification AND a project: `project_id` on
// budget_adjustments, null meaning an overhead line (Opšti troškovi). The key
// carries it as a sixth segment, `|#<project id>`, written ONLY when there is a
// project. An overhead line's key is therefore exactly the five-segment key it
// always was, so a budget with no projects in it behaves byte for byte as it
// did before projects existed.
//
// The tree does not branch on the project — it is not a level. Lines of
// different projects with the same classification sit on the same node (the
// page narrows to one project with a filter instead), but their KEYS differ,
// so the drill under a node lists each project's rows by its own key, and a
// `set` is measured against its own project's seed only (`seedForEntry`).

import type { Level } from './budgetForecast'

export interface ClassifiedRow {
  pl_category?: string | null
  pl_subcategory?: string | null
  department?: string | null
  dept_subcategory?: string | null
  expense_description?: string | null
  /** The project the line belongs to; null or absent is overhead. */
  project_id?: string | null
}

/** Marks the project segment of a key. Never the first character of a uuid. */
export const PROJECT_SEGMENT = '#'

/**
 * The key's project suffix: `|#<id>` for a project, nothing for overhead.
 * See the note at the top of the file for why overhead adds nothing.
 */
export function projectKeySuffix(projectId: string | null | undefined): string {
  const id = (projectId || '').trim()
  return id ? `|${PROJECT_SEGMENT}${id}` : ''
}

/** The project a classification key belongs to, or null for an overhead line. */
export function projectOfKey(classKey: string): string | null {
  const parts = classKey.split('|')
  const last = parts[parts.length - 1] || ''
  // Only a sixth segment can be the project; a classification value that
  // happens to start with `#` sits in one of the first five.
  if (parts.length <= CLASS_LEVELS.length || !last.startsWith(PROJECT_SEGMENT)) return null
  return last.slice(PROJECT_SEGMENT.length) || null
}

/**
 * The seeded base kept apart by company: `company_id` → classification key →
 * month → amount.
 *
 * The TREE is company-blind on purpose — consolidated, the group's Sales line
 * is both companies' Sales spend and merging them is the whole point. The seed
 * a `set` is MEASURED against cannot be, which is why this shape exists
 * alongside the merged one. See `seedForEntry`.
 */
export type SeedsByCompany = Record<string, Record<string, Record<string, number>>>

/**
 * The five classification columns joined into one key, and the project after
 * them when there is one.
 *
 * `null` and `''` fold to the same `''`: a row with no department and a row
 * with an empty department belong in the same budget line, because neither has
 * been classified.
 */
export function makeClassKey(r: ClassifiedRow): string {
  return classPartsOf(r).join('|') + projectKeySuffix(r.project_id)
}

/** A node of the budget tree, as far as the key walk is concerned. */
export interface KeyedRow {
  key: string
  parent?: string
  classKey?: string
  /**
   * Every classification key summed into this node, when one key is not
   * enough.
   *
   * A branch that shows three of the five levels — department →
   * dept_subcategory → expense_description — puts every row matching those
   * three on one node, whatever its P&L classification. That node's total is
   * summed from several keys, so its drill-down has to list them all; holding
   * one `classKey` per node listed whichever arrived first and lost the rest.
   *
   * `classKey` stays for a node summed from exactly one key. Both are read.
   */
  classKeys?: string[]
}

/**
 * Every classification key that feeds a row's cell — which is what the
 * drill-down under that cell has to list.
 *
 * A row's total is its own direct rows plus everything rolled up from its
 * descendants, so the key set is its own `classKey` plus theirs. A row can be
 * both: `dept:Sales` holds the rows classified no further than the department
 * and still parents the ones carrying a description, so restricting this to
 * childless rows left the direct ones out of the list while they stayed in the
 * total. Do not reinstate that filter as an optimisation — there is a test for
 * exactly this.
 *
 * An unknown `rootKey` yields `[]`, and the caller must read that as "no rows",
 * never as "no filter": an empty key set that is allowed to mean everything is
 * how a drill-down ends up listing the whole month.
 */
export function classKeysUnder(rows: KeyedRow[], rootKey: string): string[] {
  const under = new Set(nodeKeysUnder(rows, rootKey))

  // De-duplicated, because a node may carry a key that one of its descendants
  // carries too, and the caller matches on membership rather than on count.
  const out = new Set<string>()
  for (const r of rows) {
    if (!r.classKey && !r.classKeys?.length) continue
    if (!under.has(r.key)) continue
    if (r.classKey) out.add(r.classKey)
    for (const ck of r.classKeys || []) out.add(ck)
  }
  return Array.from(out)
}

/**
 * The node keys whose figures a row's cell is the sum of: its own and every
 * descendant's.
 *
 * `rollUp` makes a parent the sum of what sits on it plus every child's total,
 * so anything asking "what is this cell made of" has to ask about the whole
 * subtree — the seeded entries under it do, via `classKeysUnder`, and so does
 * the change ledger behind it. A drill that reads one node's own ledger says
 * "Never changed" beside a cell that did change, because the change was
 * recorded on a child.
 *
 * Same walk, same cycle guard, one definition of "under". An unknown
 * `rootKey` yields `[]`.
 */
export function nodeKeysUnder(rows: KeyedRow[], rootKey: string): string[] {
  const byKey = new Map(rows.map(r => [r.key, r]))

  const isSelfOrDescendant = (key: string): boolean => {
    // `seen` is a cycle guard, not a micro-optimisation. The parent links are
    // built from string keys, so a malformed tree can close a loop, and an
    // unguarded walk then spins forever inside a render.
    const seen = new Set<string>()
    let cur: string | undefined = key
    while (cur) {
      if (cur === rootKey) return true
      if (seen.has(cur)) return false
      seen.add(cur)
      cur = byKey.get(cur)?.parent
    }
    return false
  }

  const out = new Set<string>()
  for (const r of rows) {
    if (isSelfOrDescendant(r.key)) out.add(r.key)
  }
  return Array.from(out)
}

// ── Where a thing sits in the open branch ────────────────────────────────────
//
// The two branches are the same five classification levels read in two orders:
// the department branch answers "who spends it", the P&L branch "what kind of
// cost it is". Because they are the same money rearranged, a month's total must
// not move when the toggle flips. No arrangement of the levels may create or
// destroy money.
//
// That invariant survives only if NOTHING is ever dropped for want of a node.
// A row with no department is not missing from the department branch — it goes
// under an explicit `Unassigned` node — and the same has to be true of a change
// recorded against a level the open branch does not show. Skipping such an
// entry, which is what the page used to do, made the two branch totals disagree
// by exactly the amount skipped.
//
// The honest position is: TOTALS MUST AGREE; ROW PLACEMENT MAY DIFFER. A budget
// recorded on the P&L node `Payroll → Salaries` may span Sales and Engineering
// and genuinely cannot be attributed to one department. Showing it under
// `Unassigned` in the department branch is truthful. Dropping it is not.

/**
 * The five classification segments, in the fixed order `makeClassKey` joins
 * them and `budget_adjustments` stores them.
 */
export const CLASS_LEVELS: Level[] = [
  'pl_category', 'pl_subcategory',
  'department', 'dept_subcategory',
  'expense_description',
]

/** The tree's stand-in for a level a row carries no value for. */
export const UNASSIGNED = 'Unassigned'

/** The five classification columns as an array, in `CLASS_LEVELS` order. */
export function classPartsOf(r: ClassifiedRow): string[] {
  return CLASS_LEVELS.map(l => valueOfLevel(r, l))
}

/** One level's raw value off a row: `''` when it carries none. */
function valueOfLevel(r: ClassifiedRow, level: Level): string {
  switch (level) {
    case 'pl_category': return r.pl_category || ''
    case 'pl_subcategory': return r.pl_subcategory || ''
    case 'department': return r.department || ''
    case 'dept_subcategory': return r.dept_subcategory || ''
    case 'expense_description': return r.expense_description || ''
    default: return ''
  }
}

/**
 * One level's value out of a split classification key, as a node label.
 *
 * A level with no value becomes `Unassigned` rather than being skipped, so
 * every key walks its branch's levels in full and lands on a real node. This is
 * the single place that rule lives: the tree walk, the ledger placement and the
 * tests all read it here.
 */
export function valueAt(parts: string[], level: Level): string {
  const i = CLASS_LEVELS.indexOf(level)
  return (i < 0 ? '' : parts[i]) || UNASSIGNED
}

/** A ledger row, narrowed to what deciding its node needs. */
export interface ClassifiedEntry extends ClassifiedRow {
  /** The level the change was recorded at, as stored on the ledger row. */
  level: string
}

/** Where an entry lands in one branch. */
export interface EntryPlacement {
  /** The labels walked down the branch's levels to reach the node. */
  pathLabels: string[]
  /** The node's own level — the last of the branch's levels the walk reached. */
  level: Level
  /** The node key within the branch: prefix it with `${branch}:`. */
  key: string
}

/**
 * How deep into `levels` an entry's node sits.
 *
 * Its own level when the branch shows it. When the branch does not — a P&L
 * sub-category while the department branch is open — the entry still has to go
 * somewhere, so it goes as deep as it can honestly go: the deepest level this
 * branch DOES show that the entry carries a value for, and the first level
 * otherwise, where `Unassigned` takes it.
 */
function placementDepth(entry: ClassifiedEntry, levels: Level[]): number {
  const own = levels.indexOf(entry.level as Level)
  if (own >= 0) return own

  let deepest = -1
  for (let i = 0; i < levels.length; i++) {
    if (valueOfLevel(entry, levels[i])) deepest = i
  }
  return deepest >= 0 ? deepest : 0
}

/**
 * The node a ledger entry belongs on in one branch.
 *
 * Every entry is placed. There is no case that returns nothing: an entry with
 * no value for any level this branch shows lands on the branch's first level
 * under `Unassigned`, which is a real row with a real figure on it.
 */
export function placeEntry(entry: ClassifiedEntry, levels: Level[]): EntryPlacement {
  const depth = placementDepth(entry, levels)
  const pathLabels = levels.slice(0, depth + 1)
    .map(l => valueOfLevel(entry, l) || UNASSIGNED)
  return { pathLabels, level: levels[depth], key: pathLabels.join('|') }
}

/** The branch-local node key an entry lands on. See `placeEntry`. */
export function nodeKeyForEntry(entry: ClassifiedEntry, levels: Level[]): string {
  return placeEntry(entry, levels).key
}

/**
 * The seed a `set` entry is talking about: what the benchmark month carries
 * forward, in one month, for the entry's OWN classification.
 *
 * A `set` says "this line reads X". Read literally against the node it lands
 * on, that means different things in the two branches, because the same entry
 * lands on a node seeded 1000 in the department branch and on one seeded 3000
 * in the P&L branch — the P&L node holds Sales and Engineering salaries
 * together. Replacing a per-node base with X therefore moves the two branch
 * totals by different amounts, and the invariant the whole page rests on —
 * no arrangement of the five levels creates or destroys money — breaks.
 *
 * This is the base that does NOT depend on which branch is open: the seed of
 * the classification the entry itself carries. `amount_rsd - seedForEntry(…)` (or the same in EUR)
 * is then a delta, and a delta contributes the same figure to the total on
 * whichever node it lands on, which is exactly why every `adjust` was already
 * safe.
 *
 * A level the entry carries no value for is not a demand that the seed key
 * carry none either — it is "not classified this far", and it matches any
 * value. A department-level entry is therefore measured against everything
 * seeded to that department, which is the money the old screen's figure for
 * that department was standing in for.
 *
 * With EVERY column empty that rule has nothing left to say. Nothing is
 * compared, everything matches, and the entry is measured against the whole
 * month's seed — so a `set` for 5.000 RSD against a month seeded 200.000 RSD
 * resolves to an adjust of −195.000 RSD and the month reads 5.000 RSD. One figure
 * naming no line swallows every line.
 *
 * This is not a hypothetical row. The carry-across in
 * `20260917130000_budget_adjustments.sql` ends its level ladder with
 * `else 'pl_category'`, so a `budget_entries` row with no classification at
 * all is written as a `set` at `level = 'pl_category'` with all five columns
 * null. An entry that names no classification is measured against no seed: it
 * returns 0, which makes its amount its own delta and adds it to the month
 * rather than replacing it.
 *
 * ── And it is scoped to the entry's own company ──────────────────────────────
 *
 * The tree merges every selected company under one classification key, which
 * is right: consolidated, the group's Sales line IS both companies' Sales
 * spend. The seed a `set` is measured against may not merge with it. A figure
 * recorded on company A's Sales line says what A's Sales line reads and
 * nothing about B's, so it has to be resolved against A's seed alone whether
 * or not B happens to be on screen.
 *
 * Companies A and B each seed `department = Sales` at 1,000 for October, and
 * there is a `set` on A's Sales for 1,200. Alone, A reads 1,200. Consolidated,
 * resolving that `set` against the combined 2,000 turned a +200 into a −800
 * and the group read 1,200 where the right figure is 2,200. A group total is
 * the sum of the companies in it; a seed that widens with the selector is how
 * that stops being true.
 *
 * An entry whose company seeded nothing is measured against nothing, which
 * makes its amount its own delta — the same safe direction an unclassified
 * entry takes.
 *
 * It has to be resolved here, at read time, and could not have been a
 * migration: the seed is `seedFromEntries`' cf_type carry-forward per month,
 * which is not expressible in SQL over the ledger table, and a delta frozen at
 * migration time would go stale the moment a recurring transaction changed.
 */
export function seedForEntry(
  entry: ClassifiedRow & { company_id?: string | null },
  seedsByCompany: SeedsByCompany,
  month: string,
): number {
  const want = classPartsOf(entry)
  // Nothing named, nothing measured against. An empty filter that is allowed
  // to mean "everything" is the same mistake the drill-down's empty key set
  // guards against, one screen over.
  if (!want.some(v => v !== '')) return 0

  const seedsByKey = seedsByCompany[entry.company_id || '']
  if (!seedsByKey) return 0

  // The project is matched EXACTLY, never as a wildcard: an overhead line
  // (no project) is measured against overhead seeds alone, as
  // v_budget_vs_actual compares it with overhead actuals alone. A missing
  // classification level means "not classified this far"; a missing project
  // means "overhead", which is a value.
  const wantProject = (entry.project_id || '').trim() || null

  let total = 0
  for (const classKey of Object.keys(seedsByKey)) {
    if (projectOfKey(classKey) !== wantProject) continue
    const parts = classKey.split('|')
    let matches = true
    for (let i = 0; i < want.length; i++) {
      if (want[i] && parts[i] !== want[i]) { matches = false; break }
    }
    if (matches) total += seedsByKey[classKey][month] || 0
  }
  return total
}

/** The five classification columns a ledger row stores. */
export type Classification = Record<Level, string | null>

/**
 * The project every one of `classKeys` belongs to, or null when they disagree,
 * when there are none, or when they agree on overhead. What a change recorded
 * on a node defaults to when the page is not narrowed to one project.
 */
export function agreedProject(classKeys: string[]): string | null {
  let agreed: string | null = null
  let first = true
  for (const ck of classKeys) {
    const p = projectOfKey(ck)
    if (first) { agreed = p; first = false; continue }
    if (p !== agreed) return null
  }
  return agreed
}

/**
 * The value every one of `classKeys` carries at `level`, or `null` when they
 * disagree — or when there are none to ask.
 */
function agreedValue(classKeys: string[], level: Level): string | null {
  const i = CLASS_LEVELS.indexOf(level)
  if (i < 0) return null

  let agreed: string | null = null
  let first = true
  for (const ck of classKeys) {
    const v = ck.split('|')[i] || ''
    if (first) { agreed = v; first = false; continue }
    if (v !== agreed) return null
  }
  return agreed || null
}

/**
 * The classification columns a change recorded on a node is filed under.
 *
 * The levels the branch shows come from the node's own path, which is what the
 * node IS — never from one of its `classKeys`, because a node is summed from
 * many and any one of them would file the whole line against an arbitrary
 * member of it.
 *
 * The levels the branch does NOT show are taken from the keys when, and only
 * when, every key agrees: a P&L node holding Sales salaries and Engineering
 * salaries records `department: null`, because it honestly spans both; one that
 * happens to hold only Sales records `department: 'Sales'` and therefore lands
 * on the right row in the department branch too. Guessing where the keys
 * disagree would put money on a department that is not paying it; recording
 * nothing where they agree throws away a placement we actually know.
 */
export function classificationFor(
  pathLabels: string[], level: Level, classKeys: string[], levels: Level[],
): Classification {
  const out: Classification = {
    pl_category: null, pl_subcategory: null,
    department: null, dept_subcategory: null, expense_description: null,
  }

  const depth = levels.indexOf(level)
  const take = depth >= 0 ? depth + 1 : pathLabels.length
  pathLabels.slice(0, take).forEach((label, i) => {
    if (!levels[i]) return
    // `Unassigned` is the tree's stand-in for a level the node never had. It is
    // not a value, so it is stored as the null it stands for.
    out[levels[i]] = label === UNASSIGNED ? null : label
  })

  for (const l of CLASS_LEVELS) {
    if (levels.indexOf(l) >= 0) continue
    out[l] = agreedValue(classKeys, l)
  }
  return out
}
