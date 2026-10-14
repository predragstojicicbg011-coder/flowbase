import { classificationKey } from '../budgetForecast'
import { foldName } from '../lookupNames'
import { plural } from '../../utils/plural'
import type { ScriptLike } from '../expenseSplit'

// A proposal is a proposal. It arrives with its reason attached and the owner
// confirms it, because a classification filled in silently is one nobody
// checked — and the fault it produces is a second heading beside a real one,
// each holding part of the month, neither looking wrong.

export interface PastInvoice {
  invoice_date: string
  pl_category: string | null
  pl_subcategory: string | null
  department: string | null
  dept_subcategory: string | null
  expense_description: string | null
  cf_type?: string | null
}

export interface Proposal {
  pl_category: string | null
  pl_subcategory: string | null
  department: string | null
  dept_subcategory: string | null
  expense_description: string | null
  /** `null` is "not known"; an empty string would read as "set to nothing". */
  cf_type: string | null
  /** Shown beside the figures. A proposal with no reason is a filled field. */
  reason: string
  /** `history` is strong, `mixed` says the supplier is not consistent,
   *  `script` came from a quick-fill template. */
  basis: 'history' | 'mixed' | 'script'
}

const CARRIES = (p: { pl_category: string | null }) => !!p.pl_category

// A proposal may only pre-fill a state that is complete on its own. An
// accrual or a capex needs its dates or its month count, and nothing
// downstream requires them, so carried over they can be booked with no period
// at all. Left null, the owner chooses and supplies what they need.
const cfToCarry = (v: string | null | undefined): string | null =>
  v && v !== 'accrual' && v !== 'capex' ? v : null

/**
 * Words that say what KIND of company this is, not which one.
 *
 * Nearly every Serbian company name carries one, so a supplier matched on
 * `doo` alone is matched to the whole country.
 */
const LEGAL_FORMS = new Set([
  // Latin, after punctuation and diacritics are stripped: `doo`, `d.o.o.` and
  // `D.O.O.` all arrive here as `doo`, and `preduzeće` as `preduzece`.
  'doo', 'ood', 'dooel', 'ogranak', 'preduzece', 'drustvo',
  // Cyrillic, which `bareWord` cannot reach: ћ and ђ have no decomposition,
  // and the script is different anyway. Companies are registered in both.
  // Both spellings of `предузеће` are deliberate: the one with ћ is the word,
  // and the one with ц is what a source that has lost its diacritics produces.
  'доо', 'оод', 'дооел', 'огранак', 'предузеће', 'предузеце', 'друштво',
])

/**
 * A word reduced to its letters and digits, with diacritics folded away.
 *
 * The stop-list above is a lookup, so `Doo.` with a full stop, `preduzeće`
 * with its ć, and Cyrillic `ДОО` all walked straight past it. Serbian company
 * names are registered in both scripts and punctuated however the registrar
 * felt that day.
 */
function bareWord(w: string): string {
  return w.normalize('NFD').replace(/[\u0300-\u036f]/g, '')
    .replace(/[^\p{L}\p{N}]/gu, '')
}

/** A name reduced to the words that identify a particular company. */
function identifyingWords(name: string): string[] {
  return foldName(name).split(' ')
    .map(bareWord)
    .filter(w => w.length > 2 && !LEGAL_FORMS.has(w))
}

export function proposeClassification(
  supplierName: string,
  history: PastInvoice[],
  scripts: ScriptLike[],
): Proposal | null {
  const usable = history.filter(CARRIES)
    .sort((a, b) => (b.invoice_date || '').localeCompare(a.invoice_date || ''))

  if (usable.length > 0) {
    const newest = usable[0]
    const recent = usable.slice(0, 5)
    const key = (p: PastInvoice) => classificationKey(p)
    const agreed = recent.every(p => key(p) === key(newest))

    return {
      pl_category: newest.pl_category,
      pl_subcategory: newest.pl_subcategory,
      department: newest.department,
      dept_subcategory: newest.dept_subcategory,
      expense_description: newest.expense_description,
      // Not part of `agreed` below: that comparison is about where a bill is
      // FILED, and two bills filed alike can differ in being capex.
      cf_type: cfToCarry(newest.cf_type),
      basis: agreed ? 'history' : 'mixed',
      reason: agreed
        ? `Poslednj${recent.length === 1 ? 'a' : 'e'} ${recent.length} klasifikovan${recent.length === 1 ? 'a' : 'e'} ${plural(recent.length, 'faktura', 'fakture', 'faktura')} dobavljača ${supplierName} knjižena ${recent.length === 1 ? 'je' : 'su'} ovde.`
        : `Fakture dobavljača ${supplierName} knjižene su različito — ovo je najskorija, od ${newest.invoice_date || 'nepoznatog datuma'}. Proverite.`,
    }
  }

  // A name is matched WORD BY WORD, and only when both sides have something
  // to say. `''.includes` is true of everything, so a bill with no supplier
  // name used to match the first template on the list and be told it matched
  // "on the supplier's name" — a reason claiming more than the data supports.
  // And a substring match makes the template `Gas` fit `Vegas Doo`.
  const wantWords = identifyingWords(supplierName)

  const hit = wantWords.length === 0 ? undefined : scripts.find(s => {
    const words = identifyingWords(s.name || '')
    if (words.length === 0) return false
    const [shorter, longer] = words.length <= wantWords.length
      ? [words, wantWords] : [wantWords, words]
    return shorter.every(w => longer.includes(w))
  })
  if (hit && hit.pl_category) {
    return {
      pl_category: hit.pl_category ?? null,
      pl_subcategory: hit.pl_subcategory ?? null,
      department: hit.department ?? null,
      dept_subcategory: hit.dept_subcategory ?? null,
      expense_description: hit.expense_description ?? null,
      cf_type: cfToCarry(hit.cf_type),
      basis: 'script',
      reason: `Iz šablona „${hit.name}“, prepoznatog po imenu dobavljača.`,
    }
  }

  return null
}
