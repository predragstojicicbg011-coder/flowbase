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

import { projectRootOf, type Branch, type ComparedNode, type PlEntry } from './expenseTree'
import type { DisplayCurrency } from '../contexts/DisplayCurrencyContext'

/** The classification levels, in the order they are written out. */
export const CLASS_COLUMNS = [
  'Projekat',
  'P&L kategorija', 'P&L potkategorija',
  'Sektor', 'Podsektor', 'Opis troška',
] as const

export interface SummaryRow {
  'Grana': string
  'Nivo': number
  'Stavka': string
  /** The project (or Opšti troškovi) on the project branch; blank on the others. */
  'Projekat': string
  'P&L kategorija': string
  'P&L potkategorija': string
  'Sektor': string
  'Podsektor': string
  'Opis troška': string
  'Iznos': number
  'Prethodni iznos': number
  'Promena': number
  'Promena %': number | ''
  '% od ukupnog': number
  'Broj transakcija': number
  'Isključeno': string
}

const money2 = (n: number) => Math.round(n * 100) / 100
const pct1 = (n: number) => Math.round(n * 10) / 10

/**
 * Which classification column a branch's level N fills.
 *
 * The branches are the same six levels in a different order and each shows
 * two or three of them, so a node's path has to be mapped back to the columns
 * it actually stands for rather than written into fixed "level 1, 2, 3" slots
 * that mean something different per branch.
 */
export const BRANCH_LEVELS: Record<Branch, readonly string[]> = {
  pl: ['P&L kategorija', 'P&L potkategorija', 'Opis troška'],
  department: ['Sektor', 'Podsektor', 'Opis troška'],
  // The project branch puts the project first and then breaks it down the
  // same way the P&L branch does, so the two can be read side by side.
  project: ['Projekat', 'P&L kategorija', 'P&L potkategorija'],
}

/** What the `Branch` column of a summary sheet says. */
export const BRANCH_NAME: Record<Branch, string> = {
  pl: 'P&L', department: 'Sektor', project: 'Projekat',
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
        'Projekat': '',
        'P&L kategorija': '', 'P&L potkategorija': '',
        'Sektor': '', 'Podsektor': '', 'Opis troška': '',
      }
      n.path.forEach((seg, i) => { if (levels[i]) cls[levels[i]] = seg })

      out.push({
        'Grana': BRANCH_NAME[branch],
        'Nivo': n.depth + 1,
        'Stavka': n.label,
        'Projekat': cls['Projekat'],
        'P&L kategorija': cls['P&L kategorija'],
        'P&L potkategorija': cls['P&L potkategorija'],
        'Sektor': cls['Sektor'],
        'Podsektor': cls['Podsektor'],
        'Opis troška': cls['Opis troška'],
        'Iznos': money2(n.amount),
        'Prethodni iznos': money2(n.priorAmount),
        'Promena': money2(n.delta),
        'Promena %': n.deltaPct === null ? '' : pct1(n.deltaPct),
        '% od ukupnog': total > 0 ? pct1((n.amount / total) * 100) : 0,
        'Broj transakcija': n.count,
        'Isključeno': isExcluded(n.key) ? 'da' : '',
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
  'Datum': string
  'Izvor': string
  'Broj dokumenta': string
  Partner: string
  'Firma': string
  /** The row's own project — a split line's, not its document's — or Opšti troškovi. */
  'Projekat': string
  'P&L kategorija': string
  'P&L potkategorija': string
  'Sektor': string
  'Podsektor': string
  'Opis troška': string
  'Valuta': string
  'Iznos': number | ''
  /** The book figure in dinars. */
  'Iznos RSD': number
  /** The book figure in euros; blank where the row has none yet. */
  'Iznos EUR': number | ''
  'Novčani tok': string
  'Napomena': string
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
        'Datum': d?.date || e.pl_date,
        'Izvor': String(e.source || '').toLowerCase().startsWith('inv') ? 'Faktura' : 'Transakcija',
        'Broj dokumenta': d?.documentNo || '',
        Partner: d?.partner || '',
        'Firma': d?.company || '',
        'Projekat': projectRootOf(e),
        'P&L kategorija': e.pl_category || '',
        'P&L potkategorija': e.pl_subcategory || '',
        'Sektor': e.department || '',
        'Podsektor': e.dept_subcategory || '',
        'Opis troška': e.expense_description || '',
        'Valuta': d?.currency || '',
        'Iznos': d?.amount == null ? '' : money2(d.amount),
        'Iznos RSD': money2(e.amount_rsd || 0),
        'Iznos EUR': e.amount_eur == null ? '' : money2(e.amount_eur),
        'Novčani tok': d?.cfType || '',
        'Napomena': d?.note || '',
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
export function preambleRows(f: PreambleFacts): { 'Polje': string; 'Vrednost': string | number }[] {
  const c = f.currency
  return [
    { 'Polje': 'Izveštaj', 'Vrednost': 'P&L analiza' },
    { 'Polje': 'Period', 'Vrednost': f.period },
    { 'Polje': 'Upoređeno sa', 'Vrednost': f.priorPeriod },
    { 'Polje': 'Firma', 'Vrednost': f.company },
    { 'Polje': 'Napravljeno', 'Vrednost': f.generatedAt },
    { 'Polje': '', 'Vrednost': '' },
    { 'Polje': `Ukupni troškovi (${c})`, 'Vrednost': money2(f.total) },
    { 'Polje': `Ukupno u prethodnom periodu (${c})`, 'Vrednost': money2(f.prior) },
    { 'Polje': `Promena (${c})`, 'Vrednost': money2(f.total - f.prior) },
    { 'Polje': `Isključeno sakrivanjem (${c})`, 'Vrednost': money2(f.excluded) },
    { 'Polje': `Korigovano ukupno (${c})`, 'Vrednost': money2(f.adjusted) },
    { 'Polje': `Nedodeljeno, grana sektora (${c})`, 'Vrednost': money2(f.unassigned) },
    { 'Polje': 'Stavke koje čine 80% troškova', 'Vrednost': f.paretoLines },
    { 'Polje': 'Broj navedenih stavki', 'Vrednost': f.entryCount },
    { 'Polje': '', 'Vrednost': '' },
    { 'Polje': 'List: Po sektorima', 'Vrednost': 'Stablo grupisano prvo po sektoru. Jedan red po stavci, sa svakim nivoom klasifikacije u posebnoj koloni.' },
    { 'Polje': 'List: Po P&L', 'Vrednost': 'Isti novac grupisan po P&L kategoriji. Svaka grana daje isti ukupan iznos.' },
    { 'Polje': 'List: Po projektima', 'Vrednost': 'Isti novac grupisan po projektu, pa po P&L kategoriji. Podeljen dokument se računa na svakom projektu za svoju stavku; redovi bez projekta su Opšti troškovi.' },
    { 'Polje': 'List: Stavke', 'Vrednost': 'Jedan red po transakciji ili fakturi, sa celom klasifikacijom ponovljenom na njemu. Ovo je list za pivot tabelu, filtriranje ili alat za analizu.' },
    { 'Polje': '', 'Vrednost': '' },
    { 'Polje': 'Iznosi', 'Vrednost': `Ukupni iznosi su u ${c}, sabrani iz kolone Iznos ${c} svake stavke. Iznos RSD i Iznos EUR su knjiženi iznosi svake stavke; Valuta i Iznos su iznosi samog dokumenta.` },
    { 'Polje': 'Isključeni redovi', 'Vrednost': 'Stavke sakrivene na ekranu su i dalje navedene, označene u koloni Isključeno, tako da ništa ne nedostaje bez traga.' },
  ]
}
