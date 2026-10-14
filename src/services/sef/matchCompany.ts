// Which of the owner's own companies a bill is addressed to.
//
// SEF delivers to a legal person, and the bill names that person by PIB. The
// owner runs several companies, so this is not a formality: booked against the
// wrong one, an expense lands in the wrong P&L, the wrong VAT return and the
// wrong cash plan, and nothing on the screen looks unusual.
//
// PIB first, then the registration number — both are identifiers, and an
// identifier cannot mean two companies.
//
// THERE IS NO MATCH BY NAME, deliberately. The supplier types the customer's
// name, and suppliers type it however they like: `PRIMALAC DOO BEOGRAD`,
// `Primalac d.o.o.`, with and without the seat. Choosing which of the
// owner's entities carries a cost by comparing somebody else's spelling is
// precisely the guess that must not be made here. Unmatched is a blank field
// the owner fills in once, which is cheap; a wrong company is a wrong book.

export interface CompanyLite {
  id: string
  name: string
  /** `company_profiles.pib` — bare digits as entered in Settings. */
  pib: string | null
  /** `company_profiles.mb` — the registration number. */
  mb: string | null
}

export interface CustomerMatch {
  companyId: string
  by: 'pib' | 'registration'
}

const digits = (s: string | null | undefined): string => (s || '').replace(/\D/g, '')

export function matchCompany(
  customer: { vatNumber: string | null; registrationNumber: string | null },
  companies: CompanyLite[],
): CustomerMatch | null {
  const pib = digits(customer.vatNumber)
  if (pib) {
    const hits = companies.filter(c => digits(c.pib) === pib)
    // Two companies on one PIB is a mistake in Settings that somebody has to
    // fix. Falling through to the registration number would book the bill
    // against whichever of them answers first.
    if (hits.length > 1) return null
    if (hits.length === 1) return { companyId: hits[0].id, by: 'pib' }
  }

  const mb = digits(customer.registrationNumber)
  if (mb) {
    const hits = companies.filter(c => digits(c.mb) === mb)
    if (hits.length > 1) return null
    if (hits.length === 1) return { companyId: hits[0].id, by: 'registration' }
  }

  return null
}
