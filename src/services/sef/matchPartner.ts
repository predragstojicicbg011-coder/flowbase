import { foldName } from '../lookupNames'

// Which partner a bill came from.
//
// In this order and no other: the PIB is an identifier and cannot mean two
// companies; the registration number is the same kind of thing; a name is a
// spelling, and spellings drift. The weakest match is REPORTED as the weakest,
// so the queue can say so rather than let a bill land quietly against a
// neighbour.

export interface PartnerLite {
  id: string
  name: string
  tax_id: string | null
  registration_number: string | null
}

export interface SupplierMatch {
  partnerId: string
  /** How it was found. `name` is the weakest and is reported as such. */
  by: 'pib' | 'registration' | 'name'
}

const digits = (s: string | null | undefined): string => (s || '').replace(/\D/g, '')

export function matchSupplier(
  supplier: { vatNumber: string | null; registrationNumber: string | null; name: string | null },
  partners: PartnerLite[],
): SupplierMatch | null {
  const pib = digits(supplier.vatNumber)
  if (pib) {
    const hits = partners.filter(p => digits(p.tax_id) === pib)
    // Two partners on one PIB is a duplicate somebody has to fix. Falling
    // through to a weaker key would then file the bill against whichever of
    // them happens to answer it — the guess this function exists to refuse.
    if (hits.length > 1) return null
    if (hits.length === 1) return { partnerId: hits[0].id, by: 'pib' }
  }

  const mb = digits(supplier.registrationNumber)
  if (mb) {
    const hits = partners.filter(p => digits(p.registration_number) === mb)
    if (hits.length > 1) return null
    if (hits.length === 1) return { partnerId: hits[0].id, by: 'registration' }
  }

  const name = foldName(supplier.name || '')
  if (!name) return null

  // A name is a spelling, so it may only settle the question where nothing
  // CONTRADICTS it. A partner carrying its own PIB that differs from the one
  // on the bill is a different company that happens to be spelt the same.
  const eligible = partners.filter(p =>
    (!pib || !digits(p.tax_id) || digits(p.tax_id) === pib)
    && (!mb || !digits(p.registration_number) || digits(p.registration_number) === mb))

  const hits = eligible.filter(p => foldName(p.name) === name)
  return hits.length === 1 ? { partnerId: hits[0].id, by: 'name' } : null
}
