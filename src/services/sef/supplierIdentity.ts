import type { PartnerLite } from './matchPartner'

// ─── Partner zadržava podatke koje mu je faktura dala ───────────────────────
//
// Dobavljač je u knjigama postojao dva puta: jednom pod kratkim imenom bez
// PIB-a, jednom pod punim imenom sa njim. Predračuni su išli jednom, računi
// drugom, pa račun nije mogao da iskoristi predračun koji plaća. Svaka SEF
// faktura imenuje drugu stranu po PIB-u i matičnom broju, i `matchSupplier`
// prepoznaje baš po njima — ali partner koji ih nikad ne DOBIJE ostaje
// prepoznatljiv samo po pisanju imena, a sledeće pisanje pravi sledeći
// duplikat.
//
// Zato: partner napravljen sa SEF fakture pravi se sa njima, a partner na
// koji je faktura proknjižena dobija one koji mu nedostaju. Nikad preko
// vrednosti koju već ima — PIB koji se ne slaže je nečija odluka da se
// pogleda, a ne ovog programa da je presudi.
//
// Ista pravila važe za dobavljača sa ulazne fakture i za kupca sa izlazne:
// `SefSupplier` je druga strana fakture, kako god se zvala.

/** Druga strana kako je SEF dokument imenuje (dobavljač na ulaznoj, kupac na
 *  izlaznoj fakturi). Podaci su gole cifre, kako ih drže `partners.tax_id`
 *  i `registration_number`. */
export interface SefSupplier {
  name: string | null
  taxId: string | null
  registrationNumber: string | null
  address: string | null
  city: string | null
  /** Partner na koji je sanduče prepoznalo ovu fakturu (po PIB-u, matičnom
   *  broju ili imenu); null kad nije prepoznalo nijednog. Samo taj partner,
   *  ili jedan upravo napravljen sa ove fakture, dobija njene podatke:
   *  partner izabran ručno može biti zbirni, a PIB upisan na njega bi na
   *  njega povukao svaku sledeću fakturu ove firme. */
  matchedPartnerId?: string | null
}

const digits = (s: string | null | undefined): string => (s || '').replace(/\D/g, '')

/**
 * JEDNA definicija praznog podatka, za ponudu, zaštićen upis i ponovno
 * čitanje podjednako: u njemu nema cifre. NULL, '', '  ', '-' i 'N/A' su
 * svi prazni; PIB su cifre, pa vrednost bez njih ne nosi nijedan.
 */
export const isEmptyIdentifier = (s: string | null | undefined): boolean => digits(s) === ''

export interface SharedIdentifier {
  field: 'PIB' | 'matični broj'
  value: string
  partners: PartnerLite[]
}

/**
 * Dva ili više partnera već nose PIB sa fakture (ili, kad PIB-a nema ni na
 * fakturi ni kod koga, njen matični broj).
 *
 * To je slučaj u kom `matchSupplier` NAMERNO odgovara null, i u kom bi ponuda
 * „napravi novog partnera“ napravila trećeg. Proverava se istim redom kao
 * `matchSupplier`, pa nikad nije tačno tamo gde je on našao partnera.
 */
export function sharedIdentifier(
  supplier: { vatNumber: string | null; registrationNumber: string | null },
  partners: PartnerLite[],
): SharedIdentifier | null {
  const pib = digits(supplier.vatNumber)
  if (pib) {
    const hits = partners.filter(p => digits(p.tax_id) === pib)
    if (hits.length > 1) return { field: 'PIB', value: pib, partners: hits }
    if (hits.length === 1) return null
  }
  const mb = digits(supplier.registrationNumber)
  if (mb) {
    const hits = partners.filter(p => digits(p.registration_number) === mb)
    if (hits.length > 1) return { field: 'matični broj', value: mb, partners: hits }
  }
  return null
}

const listOf = (names: string[]): string =>
  names.length <= 1 ? names.join('') : `${names.slice(0, -1).join(', ')} i ${names[names.length - 1]}`

const COUNT = ['', 'Jedan', 'Dva', 'Tri', 'Četiri']

/** Jedna rečenica: ko deli podatak, i da se nov partner ne nudi. */
export function sharedIdentifierSentence(s: SharedIdentifier): string {
  const n = s.partners.length
  return `${COUNT[n] || n} partnera imaju ${s.field} ${s.value}: ${listOf(s.partners.map(p => p.name))}. `
    + 'Izaberite pravog ručno i uklonite duplikat u Partnerima; nov partner se ne nudi.'
}

/** Podaci koje čuvanje upisuje partneru. Prazno kad ne upisuje nijedan. */
export interface IdentityFill {
  tax_id?: string
  registration_number?: string
}

type PartnerIds = { id: string; tax_id?: string | null; registration_number?: string | null }

/**
 * Šta bi faktura dodala partneru `partner`: svaki podatak koji partneru
 * nedostaje (`isEmptyIdentifier`), a faktura ga ima.
 *
 * NIŠTA kad partner već ima podatak koji se NE SLAŽE sa fakturom — PIB
 * drugačiji od onog na fakturi, ili matični broj drugačiji od njenog. Upis
 * onog drugog bi tada partneru dao PIB jedne firme i matični broj druge, i
 * svaka sledeća faktura bi ga prepoznala po PIB-u, a na ekranu ništa ne bi
 * to reklo.
 *
 * Ništa ni kad tu vrednost već ima DRUGI partner: to bi stavilo jedan PIB
 * na dva partnera, a to je baš greška zbog koje ovo postoji.
 */
export function identityFill(
  partner: PartnerIds | null | undefined,
  supplier: Pick<SefSupplier, 'taxId' | 'registrationNumber'> | null | undefined,
  partners: PartnerIds[],
): IdentityFill {
  if (!partner || !supplier) return {}
  const pib = digits(supplier.taxId)
  const mb = digits(supplier.registrationNumber)
  const contradicts = (own: string | null | undefined, bill: string) =>
    !isEmptyIdentifier(own) && !!bill && digits(own) !== bill
  if (contradicts(partner.tax_id, pib) || contradicts(partner.registration_number, mb)) return {}

  const fill: IdentityFill = {}
  if (pib && isEmptyIdentifier(partner.tax_id)
      && !partners.some(p => p.id !== partner.id && digits(p.tax_id) === pib)) {
    fill.tax_id = pib
  }
  if (mb && isEmptyIdentifier(partner.registration_number)
      && !partners.some(p => p.id !== partner.id && digits(p.registration_number) === mb)) {
    fill.registration_number = mb
  }
  return fill
}

/** Kaže se ispod partnera pre čuvanja, da upis ne bude iznenađenje. */
export function identityFillSentence(fill: IdentityFill): string | null {
  const parts = [
    fill.tax_id ? `PIB ${fill.tax_id}` : null,
    fill.registration_number ? `matični broj ${fill.registration_number}` : null,
  ].filter(Boolean) as string[]
  if (parts.length === 0) return null
  const text = parts.join(' i ')
  const lead = text.charAt(0).toUpperCase() + text.slice(1)
  return parts.length > 1
    ? `${lead} sa fakture biće upisani kod ovog partnera, koji ih nema.`
    : `${lead} sa fakture biće upisan kod ovog partnera, koji ga nema.`
}

const FIELD_LABEL = { tax_id: 'PIB', registration_number: 'matični broj' } as const

/** Šta nije upisano, i zašto. */
export interface FillFailure {
  /** Polje koje nije uspelo i svako posle njega, nijedno nije upisano. */
  fields: (keyof IdentityFill)[]
  reason: string
}

/** Jedna rečenica za neuspeo upis, koja imenuje samo ono što nije sačuvano. */
export function fillFailureSentence(f: FillFailure): string {
  const what = f.fields.map(k => FIELD_LABEL[k]).join(' i ')
  return f.fields.length > 1
    ? `Faktura je sačuvana, ali ${what} sa fakture nisu upisani kod partnera: ${f.reason}`
    : `Faktura je sačuvana, ali ${what} sa fakture nije upisan kod partnera: ${f.reason}`
}

/**
 * Upisuje dopunu, svako polje kao uporedi-pa-upiši prema vrednosti na kojoj je
 * ponuda napravljena (`seen`): `is null` gde je partner imao NULL, `eq` tačna
 * vrednost gde je imao zamenu ('-', 'N/A' …), i `not like '%_%'` gde je imao
 * ''. Tako se vrednost koju je neko u međuvremenu ukucao nikad ne prepisuje,
 * a zamena se menja kao i NULL. Bez `or=` filtera: svaka zaštita je jedan
 * običan PostgREST operator.
 *
 * Vraća null kad partner na kraju ima podatke, a inače ono što nije upisano.
 * Upis koji ništa nije promenio čita se ponovo: prazan odgovor izgleda isto i
 * za „neko je upisao pre“ i za „RLS je tiho odbio“, a neuspeh je samo drugo.
 */
export async function saveIdentityFill(
  client: any, partnerId: string, fill: IdentityFill,
  seen: { tax_id?: string | null; registration_number?: string | null },
): Promise<FillFailure | null> {
  const fields = (['tax_id', 'registration_number'] as const).filter(f => !!fill[f])
  for (let i = 0; i < fields.length; i++) {
    const field = fields[i]
    const failed = (reason: string): FillFailure => ({ fields: fields.slice(i), reason })
    const was = seen[field] ?? null
    const write = client.from('partners').update({ [field]: fill[field] }).eq('id', partnerId)
    // '' se štiti kao `not like '%_%'` (nijedan znak), a ne kao `eq.` bez
    // ičega posle tačke: svaka zaštita tako ima neprazan operand, i nijedna ne
    // zavisi od toga kako se prazna vrednost čita.
    const guarded = was === null ? write.is(field, null)
      : was === '' ? write.not(field, 'like', '%_%')
      : write.eq(field, was)
    const { data, error } = await guarded.select('id')
    if (error) return failed(error.message || String(error))
    if (data && data.length > 0) continue
    const { data: now, error: readErr } = await client.from('partners').select(field).eq('id', partnerId).maybeSingle()
    if (readErr) return failed(readErr.message || String(readErr))
    if (isEmptyIdentifier(now?.[field])) return failed('Baza nije ništa promenila.')
  }
  return null
}
