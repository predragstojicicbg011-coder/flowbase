// ─── Months and filters for a drill-down list ───────────────────────────────
//
// Pure logic — no UI, no database — so the figures a reader trusts can be
// tested. The component above this file does the fetching and the rendering.
//
// The problem this exists to solve: a drill-down on a busy line returns over a
// thousand rows, and a thousand rows in one scroll is not a list, it is a wall.
// Grouping them by month turns it back into something a person can navigate,
// and a filter lets them jump to a vendor or to one particular payment.
//
// The rule the whole design turns on:
//
//   A TOTAL THE USER READS MUST NEVER COME FROM A CAPPED FETCH.
//
// See `groupByMonth` for what that means in practice.

/**
 * The shape both a `v_pl_entries` row and a built `EntryItem` satisfy, so one
 * grouping serves the rows a page already holds and the detail it fetched.
 */
export interface DatedRow {
  pl_date?: string | null
  date?: string | null
  amount_usd?: number | null
  amountUsd?: number | null
}

export interface MonthGroup<T> {
  /** 'YYYY-MM' — sortable, and what the detail cache is keyed by. */
  key: string
  /** 'September 2026'. */
  label: string
  /** Entries in the month. */
  count: number
  /** Their total, in USD. */
  total: number
  /** The rows themselves, newest first. */
  rows: T[]
}

const MONTHS = [
  'January', 'February', 'March', 'April', 'May', 'June',
  'July', 'August', 'September', 'October', 'November', 'December',
]

/** 'YYYY-MM' for a row, or '' when it carries no usable date. */
export function monthKeyOf(row: DatedRow): string {
  const d = row.pl_date ?? row.date ?? ''
  return /^\d{4}-\d{2}/.test(d) ? d.slice(0, 7) : ''
}

/**
 * 'September 2026'.
 *
 * Built from the string rather than from a `Date`, because `new Date('2026-09')`
 * is parsed as UTC midnight and then printed in the local zone — which west of
 * Greenwich makes September's heading read August.
 */
export function monthLabel(key: string): string {
  const m = /^(\d{4})-(\d{2})$/.exec(key)
  if (!m) return 'Undated'
  return `${MONTHS[Number(m[2]) - 1] || m[2]} ${m[1]}`
}

/** The USD amount of a row, whichever of the two names it carries it under. */
export function amountOf(row: DatedRow): number {
  return row.amount_usd ?? row.amountUsd ?? 0
}

function byRowDateDesc(a: DatedRow, b: DatedRow): number {
  const da = a.pl_date ?? a.date ?? ''
  const db = b.pl_date ?? b.date ?? ''
  if (da !== db) return db < da ? -1 : 1
  return Math.abs(amountOf(b)) - Math.abs(amountOf(a))
}

/**
 * Rows into months, newest month first, each month's rows newest first.
 *
 * ── The count and the total on every month header are computed HERE, in
 * memory, from the COMPLETE row set the caller already holds — never from the
 * detail fetch, which is capped at `DRILL_CAP` and would quietly under-report
 * a busy month the moment the cap bit. A figure a reader adds up in their head
 * has to be the whole figure, or it is worse than no figure at all.
 *
 * That is the point of splitting this out: the headers are correct before a
 * single detail row has been fetched, and they stay correct whether or not any
 * month is ever expanded. The fetch adds names to rows; it never adds up to
 * anything the user is shown. ──
 *
 * Rows with no usable date collect into one trailing 'Undated' group rather
 * than being dropped, so the month counts always add up to the node total.
 */
export function groupByMonth<T extends DatedRow>(rows: T[]): MonthGroup<T>[] {
  const byKey = new Map<string, T[]>()
  for (const r of rows) {
    const k = monthKeyOf(r)
    const list = byKey.get(k)
    if (list) list.push(r)
    else byKey.set(k, [r])
  }

  return [...byKey.entries()]
    // Descending — newest first, which is the order every other list in this
    // app uses. '' (undated) sorts last, because the empty string is below
    // every real key.
    .sort((a, b) => (a[0] < b[0] ? 1 : a[0] > b[0] ? -1 : 0))
    .map(([key, list]) => ({
      key,
      label: monthLabel(key),
      count: list.length,
      // The MAGNITUDE, because that is what the tree these rows were selected
      // from sums — `buildTree` adds `Math.abs(amount_usd)`. Summing the signed
      // value instead makes a month holding one refund come out short of the
      // figure in the modal header by twice that refund, and a reader who adds
      // the months up and misses the header total has no way to find out why.
      // The two have to be the same arithmetic or they are two numbers.
      total: list.reduce((s, r) => s + Math.abs(amountOf(r)), 0),
      rows: [...list].sort(byRowDateDesc),
    }))
}

// ── The filter ──────────────────────────────────────────────────────────────
//
// One box, two jobs, because the two things a reader comes here to find are a
// vendor and one particular payment. Which job is meant is decided by whether
// what was typed parses as a number, so nobody has to pick a mode first:
//
//   Slack          text     vendor name, note, or expense description
//   500            amount   rounds to $500 — 499.50 to 500.50
//   500.00         amount   to the cent — 499.995 to 500.005
//   >1000  >=1000  amount   larger than
//   <50    <=50    amount   smaller than
//   $1,200         amount   the $ and the separators are ignored
//   "500px         text     a leading quote forces text
//
// The quote escape exists for the day a vendor is named after a number. It is
// cheap, and without it that vendor is simply unfindable.

export type FilterKind = 'none' | 'text' | 'amount'

export interface AmountTest {
  op: '=' | '>' | '>=' | '<' | '<='
  value: number
  /** Half a unit of the last digit typed — what "rounds to" means here. */
  tolerance: number
}

export interface ParsedFilter {
  kind: FilterKind
  /** Lower-cased needle, for `kind === 'text'`. */
  text: string
  amount: AmountTest | null
}

export const NO_FILTER: ParsedFilter = { kind: 'none', text: '', amount: null }

const AMOUNT_RE = /^(>=|<=|>|<|=)?\s*\$?\s*(\d[\d,\s]*(?:\.\d+)?)$/

export function parseFilter(raw: string): ParsedFilter {
  const q = (raw || '').trim()
  if (!q) return NO_FILTER

  if (q.startsWith('"')) {
    const text = q.slice(1).replace(/"$/, '').trim().toLowerCase()
    return text ? { kind: 'text', text, amount: null } : NO_FILTER
  }

  const m = AMOUNT_RE.exec(q)
  if (m) {
    const digits = m[2].replace(/[,\s]/g, '')
    const value = Number(digits)
    if (Number.isFinite(value)) {
      const dp = digits.includes('.') ? digits.split('.')[1].length : 0
      return {
        kind: 'amount',
        text: '',
        amount: {
          op: (m[1] as AmountTest['op']) || '=',
          value,
          tolerance: 0.5 * Math.pow(10, -dp),
        },
      }
    }
  }

  return { kind: 'text', text: q.toLowerCase(), amount: null }
}

/**
 * Whether an amount satisfies the test.
 *
 * Compared on the absolute value. An expense arrives positive from one table
 * and can arrive negative from another depending on how it was entered, and a
 * reader typing `1200` means the twelve-hundred-dollar payment either way —
 * having to know the sign convention of the table underneath would be a bad
 * trade for a search box.
 */
export function matchesAmount(amount: number | null | undefined, test: AmountTest | null): boolean {
  if (!test) return true
  const a = Math.abs(amount ?? 0)
  switch (test.op) {
    case '>': return a > test.value
    case '>=': return a >= test.value
    case '<': return a < test.value
    case '<=': return a <= test.value
    default: return Math.abs(a - test.value) < test.tolerance
  }
}

/** Whether any of the given strings contains the needle. */
export function matchesText(needle: string, fields: (string | null | undefined)[]): boolean {
  if (!needle) return true
  return fields.some(f => !!f && f.toLowerCase().includes(needle))
}

/**
 * The text a row can be searched by.
 *
 * `expense_description` rides on the row the page already holds. The rest — vendor
 * name, note, the classification path — exist only on the detail fetched for
 * that row's month, which is why a text search has to make sure every month's
 * detail is loaded before it can honestly claim to have searched.
 */
export interface RowText {
  expense_description?: string | null
  title?: string | null
  note?: string | null
  path?: string | null
}

export type FilterableRow = DatedRow & { id?: string; expense_description?: string | null }

export function rowMatches(
  row: FilterableRow,
  detail: RowText | undefined,
  filter: ParsedFilter,
): boolean {
  if (filter.kind === 'none') return true
  if (filter.kind === 'amount') return matchesAmount(amountOf(row), filter.amount)
  return matchesText(filter.text, [row.expense_description, detail?.title, detail?.note, detail?.path])
}

/**
 * Applies the filter to a row set.
 *
 * `detailFor` hands back whatever detail has been fetched for a row, or
 * undefined when none has. An amount filter never consults it, which is why
 * month counts and totals move the instant a number is typed with nothing
 * fetched at all.
 */
export function filterRows<T extends FilterableRow>(
  rows: T[],
  filter: ParsedFilter,
  detailFor: (row: T) => RowText | undefined = () => undefined,
): T[] {
  if (filter.kind === 'none') return rows
  // The amount branch is spelled out rather than left to `rowMatches` so that
  // `detailFor` is not even called: an amount filter has to hold while nothing
  // has been fetched, and a predicate that reaches for the detail anyway is
  // one refactor away from becoming a predicate that needs it.
  if (filter.kind === 'amount') return rows.filter(r => matchesAmount(amountOf(r), filter.amount))
  return rows.filter(r => rowMatches(r, detailFor(r), filter))
}

/** What the line under the filter box reports. */
export function summarise(groups: MonthGroup<any>[]): { months: number; count: number; total: number } {
  const live = groups.filter(g => g.count > 0)
  return {
    months: live.length,
    count: live.reduce((s, g) => s + g.count, 0),
    total: live.reduce((s, g) => s + g.total, 0),
  }
}
