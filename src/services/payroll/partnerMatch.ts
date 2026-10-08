// ─── Putting the employee on the ledger row ─────────────────────────────────
//
// A posted salary is an expense owed to a person, and the General Ledger has a
// Partner column for exactly that. The payroll posting left it empty: every
// salary invoice it wrote was correct in category, department, amount and
// date, and said nothing about who it was for. Payments entered by hand always
// named the person, so the same cost looked like two different kinds of thing
// depending on how it got there.
//
// ── The discriminator is `is_individual` ────────────────────────────────────
//
// Partners are companies and people in one table, and people are flagged. An
// employee's partner is therefore looked for among the flagged ones only —
// which is what stops `Dejan` the employee being matched to `Dejan d.o.o.`
// the supplier, a mistake that would put a salary on a company's account and
// look perfectly ordinary in every report.
//
// ── Names are compared as sets of words, with the accents folded ────────────
//
// `Jeličić Branislav` in one table and `Branislav Jelicic` in the other are the
// same person twice: payroll exports carry the surname first, and half the
// partner records were typed without diacritics. Comparing the strings finds
// neither. Comparing sorted, accent-folded words finds both.
//
// Folding accents here and NOT in `lookupNames` is deliberate. There the
// question is whether two chart-of-accounts entries are one entry, and folding
// would merge two real accounts on a rule nobody asked for. Here the question
// is which existing person a name refers to, the answer is checked for
// ambiguity before it is used, and an uncertain one is left empty rather than
// guessed.

import { looksLikeSameParty } from './employees'

export interface PartnerLike {
  id: string
  name: string
  is_individual?: boolean | null
}

export type MatchReason =
  /** Exactly one individual partner carries this name. */
  | 'matched'
  /** Nobody does. */
  | 'none'
  /** More than one does, so choosing would be a coin toss. */
  | 'ambiguous'
  /** Somebody does, but they are filed as a company. */
  | 'not_individual'

export interface Match {
  partnerId: string | null
  reason: MatchReason
  /** The partners that matched, for a message that can be acted on. */
  candidates: PartnerLike[]
}

/**
 * Serbian Latin, reduced to the letters underneath.
 *
 * `đ` has no decomposed form, so it is replaced before the combining marks
 * are stripped; everything else falls out of NFD. Cyrillic is deliberately
 * left alone — transliterating it is a guess about which convention was used,
 * and a name that does not match is reported rather than mis-matched.
 */
function foldLetters(text: string): string {
  return text
    .replace(/đ/gi, m => (m === 'Đ' ? 'Dj' : 'dj'))
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase()
}

/**
 * A person's name as a comparable key: the words, folded and sorted.
 *
 * Sorted because the surname comes first in a payroll export and last in most
 * partner records, and neither is wrong.
 */
export function personKey(name: string | null | undefined): string {
  return foldLetters(name || '')
    .replace(/[^\p{L}\p{N}]+/gu, ' ')
    .trim()
    .split(/\s+/)
    .filter(Boolean)
    .sort()
    .join(' ')
}

/**
 * The partner an employee's salary should be booked against.
 *
 * AMBIGUITY IS NOT RESOLVED, it is reported. Two partners called the same
 * thing is a real situation — two people genuinely share a name, or one of
 * them is a duplicate record — and picking the first would file somebody's
 * salary against somebody else for reasons nobody could reconstruct.
 */
export function matchEmployeeToPartner(
  employeeName: string | null | undefined,
  partners: PartnerLike[],
): Match {
  const key = personKey(employeeName)
  if (!key) return { partnerId: null, reason: 'none', candidates: [] }

  const sameName = partners.filter(p => personKey(p.name) === key)
  const individuals = sameName.filter(p => p.is_individual === true)

  if (individuals.length === 1) {
    return { partnerId: individuals[0].id, reason: 'matched', candidates: individuals }
  }
  if (individuals.length > 1) {
    return { partnerId: null, reason: 'ambiguous', candidates: individuals }
  }
  // A partner of that name exists but is filed as a company. Not matched — a
  // salary on a company's account is the mistake `is_individual` exists to
  // prevent — but worth saying, because ticking one box fixes it.
  if (sameName.length > 0) {
    return { partnerId: null, reason: 'not_individual', candidates: sameName }
  }
  return { partnerId: null, reason: 'none', candidates: [] }
}

/** Every employee in a run, matched at once. */
export function matchEmployeesToPartners(
  employees: { id: string; name: string | null | undefined }[],
  partners: PartnerLike[],
): Record<string, string | null> {
  const out: Record<string, string | null> = {}
  for (const e of employees) {
    out[e.id] = matchEmployeeToPartner(e.name, partners).partnerId
  }
  return out
}

/** The ones that could not be matched, with why — for a line on the screen. */
export function unmatchedEmployees(
  employees: { id: string; name: string | null | undefined }[],
  partners: PartnerLike[],
): { id: string; name: string; reason: MatchReason }[] {
  return employees
    .map(e => ({ id: e.id, name: e.name || '', match: matchEmployeeToPartner(e.name, partners) }))
    .filter(r => r.match.partnerId === null)
    .map(r => ({ id: r.id, name: r.name, reason: r.match.reason }))
}

// ── What was already posted without one ─────────────────────────────────────
//
// The rows payroll wrote before this existed carry the person's name in their
// note and nothing in their Partner column. The note's shape is this
// application's own — `<tag> — Net salary — <name>` — so the name can be read
// back out of it and matched exactly as a new posting is, by the same
// function, rather than by a second rule written in SQL that would drift.

/** The legs whose note names a person. */
const NOTE_LEG = /—\s*Net salary\s*—\s*([^[]+?)\s*(?:,\s*after\b|\[|$)/u

/**
 * The employee a posted payroll row was for, read out of its note.
 *
 * Returns null rather than a guess for anything that does not match the
 * shape: an obligation, a deduction, a storno, or a note somebody edited.
 * A backfill that guessed would put a name on a row that is not a salary.
 */
export function employeeNameFromNote(note: string | null | undefined): string | null {
  const found = NOTE_LEG.exec(note || '')
  const name = found?.[1]?.trim()
  return name ? name : null
}


// ── The other two parties a payroll pays ────────────────────────────────────
//
// A salary is owed to the employee, and that is only one of three payees on a
// payroll. The tax and contributions go to the tax authority, always the same
// one. A third-party deduction goes to whoever the arrangement names — an
// insurer, a bank, a court — and that name is already on the deduction in HR
// Administration, as free text.
//
// Both are companies rather than people, so they are matched differently from
// an employee: `looksLikeSameParty` already knows how to read past `d.o.o.`,
// `a.d.` and the rest, and it is the function the reconciliation uses. What is
// added here is the refusal to choose when it matches more than one — the
// substring rule that makes `Generali` find `Generali Osiguranje` also makes
// it find `Generali Investments`, and a deduction on the wrong insurer account
// is a payment nobody can trace.

/** What the obligation rows are always owed to. */
export const TAX_AUTHORITY_NAME = 'Poreska uprava objedinjena naplata'

/** A company payee — a deduction beneficiary, or the tax authority. */
export function matchPayeeToPartner(
  payee: string | null | undefined,
  partners: PartnerLike[],
): Match {
  const wanted = (payee || '').trim()
  if (!wanted) return { partnerId: null, reason: 'none', candidates: [] }

  // Exact first, folded the way company names are typed. A partner whose name
  // IS the payee is the answer even where a looser rule would find three.
  const exact = partners.filter(p => personKey(p.name) === personKey(wanted))
  if (exact.length === 1) return { partnerId: exact[0].id, reason: 'matched', candidates: exact }
  if (exact.length > 1) return { partnerId: null, reason: 'ambiguous', candidates: exact }

  const near = partners.filter(p => looksLikeSameParty(p.name, wanted))
  if (near.length === 1) return { partnerId: near[0].id, reason: 'matched', candidates: near }
  if (near.length > 1) return { partnerId: null, reason: 'ambiguous', candidates: near }
  return { partnerId: null, reason: 'none', candidates: [] }
}

/** The tax authority, by name rather than by a stored id. */
export function findTaxAuthority(partners: PartnerLike[]): Match {
  return matchPayeeToPartner(TAX_AUTHORITY_NAME, partners)
}

/** Deduction id → the partner it is forwarded to, for every active one. */
export function matchDeductionPartners(
  deductions: {
    id: string; goes_to?: string
    payee?: string | null
    payee_partner_id?: string | null
  }[],
  partners: PartnerLike[],
): Record<string, string | null> {
  const known = new Set(partners.map(p => p.id))
  const out: Record<string, string | null> = {}
  for (const d of deductions) {
    // Only the ones that leave the company. An `employer` deduction cancels
    // an expense already booked; it has no payee and wants no partner.
    if (d.goes_to !== 'third_party') continue

    // THE ID WINS where there is one. It was chosen from the partner book by
    // somebody who knew which company they meant, and no amount of clever
    // name matching is better than that.
    //
    // Checked against the book rather than trusted: a partner deleted since
    // leaves an id pointing at nothing, and posting against it would be worse
    // than posting against none.
    if (d.payee_partner_id && known.has(d.payee_partner_id)) {
      out[d.id] = d.payee_partner_id
      continue
    }
    out[d.id] = matchPayeeToPartner(d.payee, partners).partnerId
  }
  return out
}

// ── Reading an already-posted row ───────────────────────────────────────────

export type PostedRow =
  | { kind: 'employee'; name: string }
  | { kind: 'tax' }
  | { kind: 'deduction'; label: string; employee: string }
  | { kind: 'other' }

const DEDUCTION_NOTE = /—\s*Deduction forwarded:\s*(.+?)\s*—\s*([^[]+?)\s*(?:\[|$)/u

/**
 * What a posted payroll row is, from the note this application wrote on it.
 *
 * `other` for anything that does not match a known shape — a storno, a note
 * somebody edited. A backfill that guessed would put a partner on a row that
 * is correct without one.
 */
export function classifyPostedNote(note: string | null | undefined): PostedRow {
  const text = note || ''
  const person = employeeNameFromNote(text)
  if (person) return { kind: 'employee', name: person }
  if (/—\s*Tax and contributions\b/u.test(text)) return { kind: 'tax' }
  const deduction = DEDUCTION_NOTE.exec(text)
  if (deduction) {
    return { kind: 'deduction', label: deduction[1].trim(), employee: deduction[2].trim() }
  }
  return { kind: 'other' }
}


/**
 * The month a posted payroll row is for, read out of its own note.
 *
 * Every one of them opens `Payroll 2026-09 — …`. Taken from the row rather
 * than from whatever month the screen happens to be showing: a run for
 * September written up in October falls due in September, and a backfill that
 * used the open month would give an August row an October due date and be
 * wrong in a way nobody would question.
 */
export function payrollMonthFromNote(note: string | null | undefined): string | null {
  const found = /\bPayroll\s+(\d{4}-\d{2})\b/.exec(note || '')
  return found ? found[1] : null
}
