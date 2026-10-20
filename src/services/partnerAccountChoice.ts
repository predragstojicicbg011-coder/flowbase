// ─── Which of a partner's accounts a record is talking about ────────────────
//
// A supplier may have several bank accounts and the bill says which one to pay.
// Choosing the wrong one does not fail: the money leaves, on time, to an
// account that belongs to the right company, and nothing on any screen looks
// unusual until the supplier says they were not paid.
//
// ── The fault this was written for ──────────────────────────────────────────
//
// `InvoiceDialog` and `TransactionDialog` each loaded the partner's accounts
// from an effect keyed on the partner, and set the primary one unconditionally
// when it resolved.
//
// Opening a saved record sets the partner. That fires the effect. The fetch
// resolves AFTER the record has been read into the form, and overwrote the
// account number with the primary — every time, on every open.
//
// It was not a display fault, which is the part that matters. The overwritten
// number is what the next save wrote back, so opening a bill to correct a date
// silently moved it to a different account, and the payment-order export —
// which rightly trusts the number on the invoice over the partner's default —
// exported it.
//
// ── The rule ────────────────────────────────────────────────────────────────
//
// A record that names an account keeps it. The primary is a default for a
// record that names none, and a default is only ever offered, never imposed.
//
// The decision lives here, as one function over plain values, because it is
// the same decision in both dialogs and in the export — and three copies of it
// is three chances for one of them to start paying a different account.

export interface PartnerAccountLite {
  id: string
  account_number: string | null
  model?: string | null
  reference_number?: string | null
  is_primary?: boolean | null
  /** Which bank it is at. Not used in choosing; named beside it on a payment
   *  order, which is the one thing a reader checks an account number against. */
  bank_name?: string | null
}

/** What a saved invoice or transaction already says about where to pay. */
export interface CarriedAccount {
  account_number?: string | null
  model?: string | null
}

export interface AccountChoice {
  /** The id to select in the dropdown. `''` when the number matches none. */
  accountId: string
  accountNumber: string
  model: string
  /**
   * The record carries a number that is not one of the partner's saved
   * accounts — typed by hand, or belonging to one since deleted.
   *
   * Reported rather than silently corrected, so the dropdown can say the
   * number came from the record instead of sitting blank and looking broken.
   */
  typedIn: boolean
}

/**
 * An account number reduced to what it actually is.
 *
 * Serbian account numbers are written `160-0000000000000-11`, and not everyone
 * types the dashes in the same places — or at all. The number is the digits;
 * the rest is typography, and comparing the typography is how a record stops
 * recognising its own account.
 */
export function accountDigits(n: string | null | undefined): string {
  return (n || '').replace(/\D/g, '')
}

/**
 * Whether two written account numbers are the same account.
 *
 * Two empty numbers are NOT a match. Treated as one, every record carrying no
 * account would select whichever saved account also carried none, which is how
 * money ends up at an account nobody chose.
 */
export function sameAccountNumber(
  a: string | null | undefined, b: string | null | undefined,
): boolean {
  const x = canonicalAccount(a)
  return x !== '' && x === canonicalAccount(b)
}

/**
 * An account number in its full form: 18 digits, bank (3) + account (13) +
 * control (2) — the form Halcom takes (cleanAccount). Bills write the same
 * account without the middle part's leading zeros („160-553857-18“), as an
 * IBAN („RS35 1600 …“), with spaces or a trailing blank; compared on digits
 * alone those read as different accounts and the partner's saved one was
 * not recognised.
 */
export function canonicalAccount(n: string | null | undefined): string {
  let raw = (n || '').trim().replace(/\s/g, '')
  if (/^RS\d{2}/i.test(raw)) raw = raw.slice(4)
  // A foreign IBAN or anything with letters: compared whole, as written.
  else if (/[A-Za-z]/.test(raw)) return raw.toUpperCase()
  const parts = raw.split('-').filter(Boolean)
  if (parts.length === 3 && parts.every(p => /^\d+$/.test(p))) {
    // A part longer than its place is not cut to fit: that would read two
    // different accounts as one.
    if (parts[0].length > 3 || parts[1].length > 13 || parts[2].length > 2) return parts.join('')
    return parts[0].padStart(3, '0') + parts[1].padStart(13, '0') + parts[2].padStart(2, '0')
  }
  const digits = raw.replace(/\D/g, '')
  if (digits.length === 18) return digits
  // A Serbian account written without the middle part's leading zeros.
  if (digits.length >= 10 && digits.length < 18) return digits.slice(0, 3) + digits.slice(3, -2).padStart(13, '0') + digits.slice(-2)
  return digits
}

/** The saved account a written number belongs to, or null. */
export function findAccountByNumber(
  accounts: PartnerAccountLite[], number: string | null | undefined,
): PartnerAccountLite | null {
  return accounts.find(a => sameAccountNumber(a.account_number, number)) || null
}

/**
 * The account to offer where a record names none: the primary, or the first.
 *
 * The fallback to the first is not arbitrary — the query orders by
 * `is_primary desc`, so the first is the primary wherever one is flagged, and
 * a partner with no flag at all still has a sensible default rather than none.
 */
export function defaultAccount(accounts: PartnerAccountLite[]): PartnerAccountLite | null {
  return accounts.find(a => a.is_primary) || accounts[0] || null
}

/**
 * What a saved record says about its account — and nothing, where it has no
 * standing to say anything.
 *
 * Three cases, and the middle one is the bug.
 *
 *   no record         a new bill. Nothing is being overwritten, so the
 *                     partner's default is the right answer.
 *
 *   the record's own  opening it to edit. The effect that loads the accounts
 *   partner           is keyed on the partner, and opening a record SETS the
 *                     partner, so it fires here — and must not impose a
 *                     default over the account the record was saved with.
 *
 *   a different       the supplier was changed mid-edit. The old account
 *   partner           belongs to somebody else and naming it would be worse
 *                     than useless, so the new partner's default is right.
 *
 * It takes the partner id separately rather than reading `record.partner_id`
 * alone, because the question is not "what does this record hold" but "is the
 * partner on screen still the one this record was saved against".
 */
export function carriedAccountOf(
  record: {
    partner_id?: string | null
    account_number?: string | null
    model?: string | null
  } | null | undefined,
  partnerId: string,
): CarriedAccount | null {
  if (!record || !partnerId) return null
  if (record.partner_id !== partnerId) return null
  return { account_number: record.account_number, model: record.model }
}

/**
 * Which account a form should show, given the partner's accounts and whatever
 * the record already says.
 *
 * `carried` is what the saved record holds, and is null for a new record or
 * when the user has just picked a different partner — in both of those the
 * default is the right answer and imposing it is not an overwrite.
 *
 * Where the record does name an account, ITS number and ITS model are kept
 * verbatim, even when a saved account matches. The match only decides which
 * row of the dropdown lights up. The record's model is what was agreed for
 * that bill; the account's is a default for the next one.
 *
 * Null means there is nothing to say: no accounts and nothing saved. The
 * caller then falls back to the partner's own fields, which is the only
 * remaining source.
 */
export function chooseAccount(
  accounts: PartnerAccountLite[], carried: CarriedAccount | null,
): AccountChoice | null {
  const saved = carried?.account_number || ''

  if (saved) {
    const match = findAccountByNumber(accounts, saved)
    return {
      accountId: match?.id || '',
      accountNumber: saved,
      model: carried?.model || match?.model || '',
      typedIn: !match,
    }
  }

  const fallback = defaultAccount(accounts)
  if (!fallback) return null
  return {
    accountId: fallback.id,
    accountNumber: fallback.account_number || '',
    model: fallback.model || '',
    typedIn: false,
  }
}
