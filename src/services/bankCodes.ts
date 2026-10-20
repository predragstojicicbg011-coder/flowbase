// ─── bankCodes ──────────────────────────────────────────────────────────────
//
// A Serbian bank account written in full (bank-account-control, 3-13-2) and
// the bank its first three digits name. Only codes known for certain are
// listed; any other gives no name rather than a guessed one.

import { canonicalAccount } from './partnerAccountChoice'

const BANKS: Record<string, string> = {
  '105': 'AIK Banka',
  '160': 'Banca Intesa',
  '165': 'Addiko Bank',
  '170': 'UniCredit Bank',
  '190': 'Alta banka',
  '200': 'Banka Poštanska štedionica',
  '205': 'NLB Komercijalna banka',
  '220': 'ProCredit Bank',
  '265': 'Raiffeisen banka',
  '275': 'OTP banka',
  '325': 'OTP banka',
  '340': 'Erste Bank',
}

/** „160-0000000553857-18“ from any written form; a number too short to be an account stays as written. */
export function formatAccount(n: string | null | undefined): string {
  const c = canonicalAccount(n)
  if (c.length !== 18) return (n || '').trim()
  return `${c.slice(0, 3)}-${c.slice(3, 16)}-${c.slice(16)}`
}

/** The bank the account is at, where its code is known; null otherwise. */
export function bankNameForAccount(n: string | null | undefined): string | null {
  const c = canonicalAccount(n)
  return c.length === 18 ? BANKS[c.slice(0, 3)] ?? null : null
}
