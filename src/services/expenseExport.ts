// ─── Shaping the Expense Analysis export ────────────────────────────────────
//
// The old export was a picture of the screen: the open branch's tree, one row
// per node, and a short list of headline figures. Useful to look at, useless to
// work with — it carried no transactions at all, so the question the report
// exists to raise ("what is that number made of?") could not be answered from
// the file it produced.
//
// This shapes three things instead, and the split is deliberate:
//
//   the tree      readable. One row per node, but every classification level
//                 in its own column rather than only the two or three the open
//                 branch happens to show. A row carries its whole ancestry, so
//                 it can be read on its own and sorted or filtered without
//                 losing what it belonged to.
//
//   the entries   tidy. One row per transaction or invoice, with the full
//                 classification repeated on it. That repetition is the point:
//                 a denormalised table is what a pivot, a filter or a language
//                 model can actually use. A tree is not.
//
//   the preamble  self-describing. Period, scope, totals and a note saying
//                 what each sheet is. A file handed to something that was not
//                 in the room has to say what it is.
//
// Everything here is a pure function of rows in and rows out, so it is tested
// directly. Fetching lives in the page; `xlsx` is never imported here.

import type { Branch, ComparedNode, PlEntry } from './expenseTree'
import type { DisplayCurrency } from '../contexts/DisplayCurrencyContext'

/** The classification levels, in the order they are written out. */
export const CLASS_COLUMNS = [
  'Allocated to',
  'P&L category', 'P&L sub-category',
  'Department', 'Dept. sub-category', 'Expense description',
] as const

export interface SummaryRow {
  Branch: string
  Level: number
  Line: string
  /** The stream or cost type a share was allocated to; blank on a filing branch. */
  'Allocated to': string
  'P&L category': string
  'P&L sub-category': string
  Department: string
  'Dept. sub-category': string
  'Expense description': string
  Amount: number
  'Prior amount': number
  Change: number
  'Change %': number | ''
  '% of total': number
  Transactions: number
  Excluded: string
}

const money2 = (n: number) => Math.round(n * 100) / 100
const pct1 = (n: number) => Math.round(n * 10) / 10

/**
 * Which classification column a branch's level N fills.
 *
 * The two branches are the same five levels in a different order and each
 * shows three of them, so a node's path has to be mapped back to the columns
 * it actually stands for rather than written into fixed "level 1, 2, 3" slots
 * that mean something different per branch.
 */
export const BRANCH_LEVELS: Record<Branch, readonly string[]> = {
  pl: ['P&L category', 'P&L sub-category', 'Expense description'],
  department: ['Department', 'Dept. sub-category', 'Expense description'],
  // The allocated branches put the share first and then break it down the
  // same way the P&L branch does, so the two can be read side by side.
  stream: ['Allocated to', 'P&L category', 'P&L sub-category'],
  type: ['Allocated to', 'P&L category', 'P&L sub-category'],
}

/** What the `Branch` column of a summary sheet says. */
export const BRANCH_NAME: Record<Branch, string> = {
  pl: 'P&L', department: 'Department',
  stream: 'Revenue stream', type: 'Cost type',
}

/**
 * One row per node, carrying its whole ancestry.
 *
 * `Line` is the node's own label — what the screen shows — and the columns
 * beside it are the path that got there. Both are present because they answer
 * different questions: `Line` reads, the columns group.
 */
export function summaryRows(
  nodes: ComparedNode[],
  branch: Branch,
  total: number,
  isExcluded: (key: string) => boolean,
): SummaryRow[] {
  const levels = BRANCH_LEVELS[branch]
  const out: SummaryRow[] = []

  const walk = (list: ComparedNode[]) => {
    for (const n of list) {
      const cls: Record<string, string> = {
        'Allocated to': '',
        'P&L category': '', 'P&L sub-category': '',
        Department: '', 'Dept. sub-category': '', 'Expense description': '',
      }
      n.path.forEach((seg, i) => { if (levels[i]) cls[levels[i]] = seg })

      out.push({
        Branch: BRANCH_NAME[branch],
        Level: n.depth + 1,
        Line: n.label,
        'Allocated to': cls['Allocated to'],
        'P&L category': cls['P&L category'],
        'P&L sub-category': cls['P&L sub-category'],
        Department: cls.Department,
        'Dept. sub-category': cls['Dept. sub-category'],
        'Expense description': cls['Expense description'],
        Amount: money2(n.amount),
        'Prior amount': money2(n.priorAmount),
        Change: money2(n.delta),
        'Change %': n.deltaPct === null ? '' : pct1(n.deltaPct),
        '% of total': total > 0 ? pct1((n.amount / total) * 100) : 0,
        Transactions: n.count,
        Excluded: isExcluded(n.key) ? 'yes' : '',
      })
      // Depth-first, so a parent is always directly above its children and the
      // sheet reads top down the way the screen does.
      walk(n.children)
    }
  }
  walk(nodes)
  return out
}

export interface EntryDetail {
  id: string
  date: string
  partner: string
  company: string
  documentNo: string
  currency: string
  amount: number | null
  note: string
  cfType: string
}

export interface EntryRowOut {
  Date: string
  Source: string
  'Document no.': string
  Partner: string
  Company: string
  'P&L category': string
  'P&L sub-category': string
  Department: string
  'Dept. sub-category': string
  'Expense description': string
  Currency: string
  Amount: number | ''
  /** The book figure in dinars. */
  'Amount RSD': number
  /** The book figure in euros; blank where the row has none yet. */
  'Amount EUR': number | ''
  'Cash flow': string
  Note: string
}

/**
 * One row per entry, with its classification repeated onto it.
 *
 * Newest first, matching every other list in the app. A row whose detail could
 * not be read back still appears, with the classification and the amount the
 * view gave — dropping it would make the sheet disagree with its own summary,
 * and a total that does not tie is worse than a missing partner name.
 */
export function entryRows(
  entries: PlEntry[],
  detailById: Map<string, EntryDetail>,
): EntryRowOut[] {
  return [...entries]
    .sort((a, b) => (b.pl_date || '').localeCompare(a.pl_date || ''))
    .map(e => {
      const d = e.id ? detailById.get(e.id) : undefined
      return {
        Date: d?.date || e.pl_date,
        Source: String(e.source || '').toLowerCase().startsWith('inv') ? 'Invoice' : 'Transaction',
        'Document no.': d?.documentNo || '',
        Partner: d?.partner || '',
        Company: d?.company || '',
        'P&L category': e.pl_category || '',
        'P&L sub-category': e.pl_subcategory || '',
        Department: e.department || '',
        'Dept. sub-category': e.dept_subcategory || '',
        'Expense description': e.expense_description || '',
        Currency: d?.currency || '',
        Amount: d?.amount == null ? '' : money2(d.amount),
        'Amount RSD': money2(e.amount_rsd || 0),
        'Amount EUR': e.amount_eur == null ? '' : money2(e.amount_eur),
        'Cash flow': d?.cfType || '',
        Note: d?.note || '',
      }
    })
}

export interface PreambleFacts {
  period: string
  priorPeriod: string
  company: string
  total: number
  prior: number
  excluded: number
  adjusted: number
  unassigned: number
  paretoLines: number
  entryCount: number
  generatedAt: string
  /** The currency the totals were summed in — the viewer's display currency. */
  currency: DisplayCurrency
}

/**
 * The sheet that says what the file is.
 *
 * Written as Field/Value pairs rather than prose so it survives being read by
 * something that is not a person, and placed first so it is what opens.
 */
export function preambleRows(f: PreambleFacts): { Field: string; Value: string | number }[] {
  const c = f.currency
  return [
    { Field: 'Report', Value: 'Expense Analysis' },
    { Field: 'Period', Value: f.period },
    { Field: 'Compared with', Value: f.priorPeriod },
    { Field: 'Company', Value: f.company },
    { Field: 'Generated', Value: f.generatedAt },
    { Field: '', Value: '' },
    { Field: `Total expenses (${c})`, Value: money2(f.total) },
    { Field: `Prior period total (${c})`, Value: money2(f.prior) },
    { Field: `Change (${c})`, Value: money2(f.total - f.prior) },
    { Field: `Excluded by hiding (${c})`, Value: money2(f.excluded) },
    { Field: `Adjusted total (${c})`, Value: money2(f.adjusted) },
    { Field: `Unassigned, department branch (${c})`, Value: money2(f.unassigned) },
    { Field: 'Lines making 80% of spend', Value: f.paretoLines },
    { Field: 'Entries listed', Value: f.entryCount },
    { Field: '', Value: '' },
    { Field: 'Sheet: By department', Value: 'The tree grouped department first. One row per line, with every classification level in its own column.' },
    { Field: 'Sheet: By P&L', Value: 'The same money grouped by P&L category. Both branches total the same figure.' },
    { Field: 'Sheet: Entries', Value: 'One row per transaction or invoice, with its full classification repeated on it. This is the sheet to pivot, filter or hand to an analysis tool.' },
    { Field: '', Value: '' },
    { Field: 'Amounts', Value: `Totals are in ${c}, summed from each entry's Amount ${c}. Amount RSD and Amount EUR are the book figures every entry carries; Currency and Amount are the document's own.` },
    { Field: 'Excluded rows', Value: 'Lines hidden on screen are still listed, marked in the Excluded column, so nothing is silently missing.' },
  ]
}
