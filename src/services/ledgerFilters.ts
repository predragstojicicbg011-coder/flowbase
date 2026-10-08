// ── Ledger filters ──────────────────────────────────────────────────────────
//
// The Transactions page shows three different things — invoices, transactions
// and pass-throughs — and until now it filtered all three through ONE set of
// variables. Switching tabs carried the filter over, and the carried value
// often meant something else on the other side: `filterType` was
// `invoices.type` on one tab and `transactions.tx_subtype` on another, and
// `filterStatus` was an invoice's payment status on one tab and a
// pass-through's pairing status on another. A status of `paid` carried onto
// the pass-through tab matched nothing and looked like an empty ledger.
//
// So the state is per tab, and the mapping from state to query lives here
// rather than inline in three fetch functions. Three things are pure logic and
// are therefore testable without a database:
//
//   which fields a tab even has          → FIELDS_BY_TAB / appliesTo
//   what query a filter state means      → buildPredicates
//   what the user is told is applied     → activeChips
//
// `buildPredicates` returns a description of the query, not a query. The page
// walks it onto a PostgREST builder. That keeps the column names, the
// operators and the per-tab differences under test, while the page keeps the
// one job it cannot hand over: fetching.
//
// The invariant the tests lean on hardest: a predicate is only emitted for a
// field the tab actually has. Even if a filter value leaks into a tab's state,
// that tab cannot filter on a column it does not own.

import { DOCUMENT_CURRENCIES } from './bookAmounts'

export type Tab = 'invoices' | 'transactions' | 'passthrough'

export const TABS: Tab[] = ['invoices', 'transactions', 'passthrough']

export type DatePreset = 'custom' | 'this_month' | 'last_month' | 'this_quarter' | 'ytd'

/** The document currencies, from the one list in bookAmounts. */
export const CURRENCIES = DOCUMENT_CURRENCIES

/** Duplicated from the dialogs, which each keep their own copy of this list.
 *  Revenue rows carry their classification here and not in `pl_category`. */
export const REVENUE_STREAMS = [
  'Social Growth', 'Aimfox', 'Outsourced Services',
  'VAT Claimed', 'Interest Received', 'Loans', 'Credit', 'Other',
]

/**
 * One shape, one copy per tab.
 *
 * Every field is `''` or `false` when unset — there is no `'all'` sentinel,
 * because two spellings of "not filtering" is how a filter ends up half
 * applied. `isSet` is the only test anything makes.
 */
export interface FilterState {
  // shared by all three tabs
  companyId: string
  datePreset: DatePreset
  dateFrom: string
  dateTo: string
  amountFrom: string
  amountTo: string
  currency: string
  search: string

  // classification — invoices and transactions
  expenseDescription: string
  department: string
  deptSubcategory: string
  plCategory: string
  plSubcategory: string

  // expense / revenue. `invoices.type` on one tab, `transactions.tx_subtype`
  // on the other — the same question asked of two different columns, which is
  // exactly why it may never be shared state again.
  direction: string

  // transactions only
  txType: string
  unclassified: boolean

  // invoices only
  invoiceStatus: string
  overdue: boolean
  dueFrom: string
  dueTo: string

  // invoices and pass-through
  partnerId: string

  // pass-through only
  ptStatus: string
  ptDirection: string
  periodFrom: string
  periodTo: string
  bankId: string
}

export type FilterField = keyof FilterState

export function emptyFilters(): FilterState {
  return {
    companyId: '', datePreset: 'custom', dateFrom: '', dateTo: '',
    amountFrom: '', amountTo: '', currency: '', search: '',
    expenseDescription: '', department: '', deptSubcategory: '',
    plCategory: '', plSubcategory: '', direction: '',
    txType: '', unclassified: false,
    invoiceStatus: '', overdue: false, dueFrom: '', dueTo: '',
    partnerId: '',
    ptStatus: '', ptDirection: '', periodFrom: '', periodTo: '', bankId: '',
  }
}

export function emptyFiltersByTab(): Record<Tab, FilterState> {
  return { invoices: emptyFilters(), transactions: emptyFilters(), passthrough: emptyFilters() }
}

const SHARED: FilterField[] = [
  'companyId', 'datePreset', 'dateFrom', 'dateTo',
  'amountFrom', 'amountTo', 'currency', 'search',
]

const CLASSIFICATION: FilterField[] = [
  'expenseDescription', 'department', 'deptSubcategory', 'plCategory', 'plSubcategory',
]

export const FIELDS_BY_TAB: Record<Tab, FilterField[]> = {
  invoices: [
    ...SHARED, ...CLASSIFICATION,
    'direction', 'invoiceStatus', 'overdue', 'dueFrom', 'dueTo', 'partnerId',
  ],
  transactions: [
    ...SHARED, ...CLASSIFICATION,
    'direction', 'txType', 'unclassified',
  ],
  passthrough: [
    ...SHARED,
    'ptStatus', 'ptDirection', 'periodFrom', 'periodTo', 'partnerId', 'bankId',
  ],
}

export function appliesTo(tab: Tab, field: FilterField): boolean {
  return FIELDS_BY_TAB[tab].indexOf(field) !== -1
}

/** The date column each tab's shared date range means. */
export function dateColumn(tab: Tab): string {
  return tab === 'invoices' ? 'invoice_date' : 'transaction_date'
}

/** The column `direction` means on a tab, or null where the tab has none. */
export function directionColumn(tab: Tab): string | null {
  if (tab === 'invoices') return 'type'
  if (tab === 'transactions') return 'tx_subtype'
  return null
}

/**
 * The free-text columns per tab.
 *
 * Partner is not in here: partner is a foreign key, and filtering on an
 * embedded `partners.name` does NOT drop parent rows — PostgREST empties the
 * embed and leaves the row (and the count) alone. Partner names are resolved
 * to ids first and joined on as `partner_id.in.(…)`.
 *
 * `expense_description` is left off pass-through on purpose: a pass-through is
 * a cash movement with no P&L classification and the table has no such column.
 * Naming a column that does not exist inside an `or=()` is not a no-op — it is
 * a 42703 that fails the whole query.
 *
 * The same trap caught the invoice tab, which reads `v_invoice_status` rather
 * than `invoices`: the view carried neither `reference_number` nor
 * `account_number`, so every search on that tab failed — including a search by
 * partner, whose clause sits in the same `or=()` and went down with it.
 * 20260922120000 added both to the view. Anything added to this list has to
 * exist on the SOURCE each tab reads, which for invoices is the view.
 */
export function searchColumns(tab: Tab): string[] {
  const base = ['note', 'reference_number', 'account_number']
  if (tab === 'passthrough') return base
  if (tab === 'invoices') return base.concat(['expense_description', 'invoice_number'])
  return base.concat(['expense_description'])
}

/**
 * PostgREST splits `or=(…)` on commas, so a term containing a comma or a
 * bracket would tear the clause in half unless it is quoted.
 */
export function orValue(v: string): string {
  return `"%${v.replace(/["\\]/g, '')}%"`
}

/** The `or=(…)` body for a free-text term, or null when there is no term. */
export function searchOr(tab: Tab, search: string, partnerIds: string[]): string | null {
  const term = (search || '').trim()
  if (!term) return null
  const clauses = searchColumns(tab).map(c => `${c}.ilike.${orValue(term)}`)
  if (partnerIds.length > 0) clauses.push(`partner_id.in.(${partnerIds.join(',')})`)
  return clauses.join(',')
}

// ── Date presets ────────────────────────────────────────────────────────────
//
// A preset is resolved to two dates the moment it is picked and those dates
// are what is stored. Nothing re-reads "today" later, so a range cannot move
// under a result that was already counted, and the user can see and edit the
// dates a preset chose.

const pad = (n: number) => String(n).padStart(2, '0')
const iso = (y: number, m: number, d: number) => `${y}-${pad(m)}-${pad(d)}`
const lastDay = (y: number, m: number) => new Date(Date.UTC(y, m, 0)).getUTCDate()

export function presetRange(preset: DatePreset, today: string): { from: string; to: string } {
  if (preset === 'custom') return { from: '', to: '' }
  const parts = today.split('-').map(Number)
  const y = parts[0]
  const m = parts[1]
  if (preset === 'this_month') return { from: iso(y, m, 1), to: iso(y, m, lastDay(y, m)) }
  if (preset === 'last_month') {
    const pm = m === 1 ? 12 : m - 1
    const py = m === 1 ? y - 1 : y
    return { from: iso(py, pm, 1), to: iso(py, pm, lastDay(py, pm)) }
  }
  if (preset === 'this_quarter') {
    const qs = Math.floor((m - 1) / 3) * 3 + 1
    return { from: iso(y, qs, 1), to: iso(y, qs + 2, lastDay(y, qs + 2)) }
  }
  // year to date — up to today, not to the end of the year. A range running
  // into the future would put an empty tail into every average taken off it.
  return { from: iso(y, 1, 1), to: today }
}

export const PRESET_LABELS: Record<DatePreset, string> = {
  custom: 'Custom',
  this_month: 'This month',
  last_month: 'Last month',
  this_quarter: 'This quarter',
  ytd: 'Year to date',
}

// ── Predicates ──────────────────────────────────────────────────────────────

export type Predicate =
  | { op: 'eq'; column: string; value: string | number | boolean }
  | { op: 'gte' | 'lte' | 'lt' | 'gt'; column: string; value: string | number }
  | { op: 'in'; column: string; value: string[] }
  | { op: 'or'; value: string }

export interface BuildContext {
  /** `YYYY-MM-DD`. Only the Overdue toggle reads it. */
  today: string
  /** Partner ids whose name matches the free-text term. */
  partnerIds?: string[]
}

export function isSet(v: string): boolean {
  return typeof v === 'string' && v.trim() !== ''
}

/** A filter amount, or null when the box is empty or not a number. */
export function parseAmount(v: string): number | null {
  if (!isSet(v)) return null
  const n = Number(String(v).replace(/,/g, '').trim())
  return Number.isFinite(n) ? n : null
}

/**
 * Revenue rows classify under `revenue_stream`, expense rows under
 * `pl_category`. The old page had this as a special case buried in the fetch
 * function; it is a property of the filter, so it lives with the filter.
 */
export function plCategoryColumn(tab: Tab, f: FilterState): string {
  return tab === 'transactions' && f.direction === 'revenue' ? 'revenue_stream' : 'pl_category'
}

export function buildPredicates(tab: Tab, f: FilterState, ctx: BuildContext): Predicate[] {
  const out: Predicate[] = []
  const on = (field: FilterField) => appliesTo(tab, field)

  if (on('companyId') && isSet(f.companyId)) {
    // By id. The old page matched `company_name ilike` on part of a name, which is only
    // right until two entities share a word in their name.
    out.push({ op: 'eq', column: 'company_id', value: f.companyId })
  }

  const dcol = dateColumn(tab)
  if (on('dateFrom') && isSet(f.dateFrom)) out.push({ op: 'gte', column: dcol, value: f.dateFrom })
  if (on('dateTo') && isSet(f.dateTo)) out.push({ op: 'lte', column: dcol, value: f.dateTo })

  const lo = on('amountFrom') ? parseAmount(f.amountFrom) : null
  const hi = on('amountTo') ? parseAmount(f.amountTo) : null
  if (lo !== null) out.push({ op: 'gte', column: 'amount_usd', value: lo })
  if (hi !== null) out.push({ op: 'lte', column: 'amount_usd', value: hi })

  if (on('currency') && isSet(f.currency)) out.push({ op: 'eq', column: 'currency', value: f.currency })

  if (on('direction') && isSet(f.direction)) {
    const col = directionColumn(tab)
    if (col) out.push({ op: 'eq', column: col, value: f.direction })
  }

  if (on('txType') && isSet(f.txType)) out.push({ op: 'eq', column: 'type', value: f.txType })

  if (on('expenseDescription') && isSet(f.expenseDescription)) {
    out.push({ op: 'eq', column: 'expense_description', value: f.expenseDescription })
  }
  if (on('department') && isSet(f.department)) {
    out.push({ op: 'eq', column: 'department', value: f.department })
  }
  if (on('deptSubcategory') && isSet(f.deptSubcategory)) {
    out.push({ op: 'eq', column: 'dept_subcategory', value: f.deptSubcategory })
  }
  if (on('plCategory') && isSet(f.plCategory)) {
    out.push({ op: 'eq', column: plCategoryColumn(tab, f), value: f.plCategory })
  }
  if (on('plSubcategory') && isSet(f.plSubcategory) && plCategoryColumn(tab, f) === 'pl_category') {
    // A revenue stream has no sub-category, so the picker is hidden there and
    // a stale value must not silently narrow the result.
    out.push({ op: 'eq', column: 'pl_subcategory', value: f.plSubcategory })
  }

  if (on('unclassified') && f.unclassified) {
    out.push({ op: 'or', value: 'department.is.null,expense_description.is.null' })
  }

  if (on('invoiceStatus') && isSet(f.invoiceStatus)) {
    out.push({ op: 'eq', column: 'calculated_status', value: f.invoiceStatus })
  }
  if (on('overdue') && f.overdue) {
    out.push({ op: 'lt', column: 'due_date', value: ctx.today })
    out.push({ op: 'in', column: 'calculated_status', value: ['unpaid', 'partial'] })
  }
  if (on('dueFrom') && isSet(f.dueFrom)) out.push({ op: 'gte', column: 'due_date', value: f.dueFrom })
  if (on('dueTo') && isSet(f.dueTo)) out.push({ op: 'lte', column: 'due_date', value: f.dueTo })

  if (on('partnerId') && isSet(f.partnerId)) out.push({ op: 'eq', column: 'partner_id', value: f.partnerId })
  if (on('bankId') && isSet(f.bankId)) out.push({ op: 'eq', column: 'bank_id', value: f.bankId })

  if (on('ptStatus') && isSet(f.ptStatus)) out.push({ op: 'eq', column: 'status', value: f.ptStatus })
  if (on('ptDirection') && isSet(f.ptDirection)) out.push({ op: 'eq', column: 'direction', value: f.ptDirection })
  if (on('periodFrom') && isSet(f.periodFrom)) out.push({ op: 'gte', column: 'period_month', value: f.periodFrom })
  if (on('periodTo') && isSet(f.periodTo)) out.push({ op: 'lte', column: 'period_month', value: f.periodTo })

  if (on('search')) {
    const clause = searchOr(tab, f.search, ctx.partnerIds || [])
    if (clause) out.push({ op: 'or', value: clause })
  }

  return out
}

// ── Chips ───────────────────────────────────────────────────────────────────

export interface Chip {
  id: string
  label: string
  /** Every field this chip's ✕ resets. A range is one chip, two fields. */
  clears: FilterField[]
}

/** Id → display name, for the filters that hold a foreign key. */
export interface ChipNames {
  company?: (id: string) => string
  partner?: (id: string) => string
  bank?: (id: string) => string
}

const nameOr = (fn: ((id: string) => string) | undefined, id: string) => {
  const n = fn ? fn(id) : ''
  return n || id
}

const money = (n: number) =>
  '$' + Math.abs(n).toLocaleString('en-US', { maximumFractionDigits: 0 })

const TITLE: Record<string, string> = {
  expense: 'Expense', revenue: 'Revenue',
  direct: 'Direct', invoice_payment: 'Invoice payment', credit_payment: 'Credit payment',
  transfer: 'Transfer', intercompany: 'Intercompany',
  unpaid: 'Unpaid', partial: 'Partial', paid: 'Paid', overpaid: 'Overpaid', reconciled: 'Reconciled',
  unpaired: 'Unpaired', paired: 'Paired', balanced: 'Balanced',
  in: 'In', out: 'Out',
}

const pretty = (v: string) => TITLE[v] || v

function rangeLabel(prefix: string, from: string, to: string): string {
  if (isSet(from) && isSet(to)) return `${prefix}: ${from} → ${to}`
  if (isSet(from)) return `${prefix}: from ${from}`
  return `${prefix}: until ${to}`
}

/**
 * What is applied, in words, so it can be read and removed without opening
 * every dropdown. Only fields the tab owns can produce a chip — a value left
 * over in a field the tab does not use is invisible here for the same reason
 * it is absent from `buildPredicates`.
 */
export function activeChips(tab: Tab, f: FilterState, names: ChipNames = {}): Chip[] {
  const out: Chip[] = []
  const on = (field: FilterField) => appliesTo(tab, field)

  if (on('companyId') && isSet(f.companyId)) {
    out.push({ id: 'company', label: `Company: ${nameOr(names.company, f.companyId)}`, clears: ['companyId'] })
  }

  if (on('dateFrom') && (isSet(f.dateFrom) || isSet(f.dateTo))) {
    const label = f.datePreset !== 'custom'
      ? `Date: ${PRESET_LABELS[f.datePreset]}`
      : rangeLabel('Date', f.dateFrom, f.dateTo)
    out.push({ id: 'date', label, clears: ['dateFrom', 'dateTo', 'datePreset'] })
  }

  const lo = on('amountFrom') ? parseAmount(f.amountFrom) : null
  const hi = on('amountTo') ? parseAmount(f.amountTo) : null
  if (lo !== null || hi !== null) {
    const label = lo !== null && hi !== null ? `Amount: ${money(lo)} – ${money(hi)}`
      : lo !== null ? `Amount: ≥ ${money(lo)}`
        : `Amount: ≤ ${money(hi as number)}`
    out.push({ id: 'amount', label, clears: ['amountFrom', 'amountTo'] })
  }

  if (on('currency') && isSet(f.currency)) {
    out.push({ id: 'currency', label: `Currency: ${f.currency}`, clears: ['currency'] })
  }

  if (on('direction') && isSet(f.direction)) {
    out.push({ id: 'direction', label: `Direction: ${pretty(f.direction)}`, clears: ['direction'] })
  }
  if (on('txType') && isSet(f.txType)) {
    out.push({ id: 'txType', label: `Type: ${pretty(f.txType)}`, clears: ['txType'] })
  }

  if (on('expenseDescription') && isSet(f.expenseDescription)) {
    out.push({ id: 'expenseDescription', label: `Expense: ${f.expenseDescription}`, clears: ['expenseDescription'] })
  }
  if (on('department') && isSet(f.department)) {
    out.push({ id: 'department', label: `Department: ${f.department}`, clears: ['department', 'deptSubcategory'] })
  }
  if (on('deptSubcategory') && isSet(f.deptSubcategory)) {
    out.push({ id: 'deptSubcategory', label: `Dept. sub: ${f.deptSubcategory}`, clears: ['deptSubcategory'] })
  }
  if (on('plCategory') && isSet(f.plCategory)) {
    const prefix = plCategoryColumn(tab, f) === 'revenue_stream' ? 'Revenue stream' : 'P&L'
    out.push({ id: 'plCategory', label: `${prefix}: ${f.plCategory}`, clears: ['plCategory', 'plSubcategory'] })
  }
  if (on('plSubcategory') && isSet(f.plSubcategory) && plCategoryColumn(tab, f) === 'pl_category') {
    out.push({ id: 'plSubcategory', label: `P&L sub: ${f.plSubcategory}`, clears: ['plSubcategory'] })
  }

  if (on('unclassified') && f.unclassified) {
    out.push({ id: 'unclassified', label: 'Unclassified only', clears: ['unclassified'] })
  }

  if (on('invoiceStatus') && isSet(f.invoiceStatus)) {
    out.push({ id: 'invoiceStatus', label: `Status: ${pretty(f.invoiceStatus)}`, clears: ['invoiceStatus'] })
  }
  if (on('overdue') && f.overdue) {
    out.push({ id: 'overdue', label: 'Overdue only', clears: ['overdue'] })
  }
  if (on('dueFrom') && (isSet(f.dueFrom) || isSet(f.dueTo))) {
    out.push({ id: 'due', label: rangeLabel('Due', f.dueFrom, f.dueTo), clears: ['dueFrom', 'dueTo'] })
  }

  if (on('partnerId') && isSet(f.partnerId)) {
    out.push({ id: 'partner', label: `Partner: ${nameOr(names.partner, f.partnerId)}`, clears: ['partnerId'] })
  }
  if (on('bankId') && isSet(f.bankId)) {
    out.push({ id: 'bank', label: `Bank: ${nameOr(names.bank, f.bankId)}`, clears: ['bankId'] })
  }

  if (on('ptStatus') && isSet(f.ptStatus)) {
    out.push({ id: 'ptStatus', label: `Status: ${pretty(f.ptStatus)}`, clears: ['ptStatus'] })
  }
  if (on('ptDirection') && isSet(f.ptDirection)) {
    out.push({ id: 'ptDirection', label: `Direction: ${pretty(f.ptDirection)}`, clears: ['ptDirection'] })
  }
  if (on('periodFrom') && (isSet(f.periodFrom) || isSet(f.periodTo))) {
    out.push({ id: 'period', label: rangeLabel('Period', f.periodFrom, f.periodTo), clears: ['periodFrom', 'periodTo'] })
  }

  if (on('search') && isSet(f.search)) {
    out.push({ id: 'search', label: `Text: “${f.search.trim()}”`, clears: ['search'] })
  }

  return out
}

export function hasActiveFilters(tab: Tab, f: FilterState): boolean {
  return activeChips(tab, f).length > 0
}

/** Reset the named fields to their unset value, leaving everything else. */
export function clearFields(f: FilterState, fields: FilterField[]): FilterState {
  const blank = emptyFilters()
  const next: FilterState = { ...f }
  fields.forEach(field => {
    // The cast is the price of a heterogeneous record; `blank` is the same
    // shape, so the value assigned always has the field's own type.
    ;(next as any)[field] = (blank as any)[field]
  })
  return next
}

/** Everything the tab can filter by, cleared. */
export function clearTab(tab: Tab, f: FilterState): FilterState {
  return clearFields(f, FIELDS_BY_TAB[tab])
}

// ── Paging ──────────────────────────────────────────────────────────────────
//
// The page fetches with `.range(page * PAGE_SIZE, ...)`, but nothing about
// where the last page is, what slice of the count the current page covers, or
// whether next/previous have anywhere left to go needs a database — they are
// functions of (page, pageSize, count). Kept here and tested rather than
// worked out inline in a `<button disabled=...>`, the way the count and the
// sum above are kept out of the fetch functions for the same reason.

/** The last page's 0-based index. Zero results is one (empty) page, not none
 *  — there is nowhere further back than page 0 to land on. */
export function lastPageIndex(count: number, pageSize: number): number {
  if (count <= 0) return 0
  return Math.ceil(count / pageSize) - 1
}

/** The 1-based row range the given page covers, e.g. `{ from: 51, to: 100 }`.
 *  Both are 0 when there is nothing to show. */
export function pageRange(page: number, pageSize: number, count: number): { from: number; to: number } {
  if (count <= 0) return { from: 0, to: 0 }
  const from = page * pageSize + 1
  const to = Math.min((page + 1) * pageSize, count)
  return { from, to }
}

/** `"51–100 of 142"`, or `"0 of 0"` when there is nothing to show. */
export function pageLabel(page: number, pageSize: number, count: number): string {
  if (count <= 0) return '0 of 0'
  const { from, to } = pageRange(page, pageSize, count)
  return `${from}–${to} of ${count}`
}

/** Whether Previous has anywhere to go. */
export function hasPrevPage(page: number): boolean {
  return page > 0
}

/** Whether Next has anywhere to go. */
export function hasNextPage(page: number, pageSize: number, count: number): boolean {
  return page < lastPageIndex(count, pageSize)
}
