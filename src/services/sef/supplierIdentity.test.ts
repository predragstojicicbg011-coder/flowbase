import {
  sharedIdentifier, sharedIdentifierSentence, identityFill, identityFillSentence, saveIdentityFill,
  isEmptyIdentifier, fillFailureSentence, isFromDocument,
} from './supplierIdentity'
import { matchSupplier, type PartnerLite } from './matchPartner'

// Sva imena i brojevi su izmišljeni.

const p = (over: Partial<PartnerLite> & { id: string }): PartnerLite => ({
  name: 'Alfa Doo', tax_id: null, registration_number: null, ...over,
})

describe('partner napravljen iz forme otvorene na fakturi', () => {
  const party = { name: 'Alfa Doo Beograd', taxId: '100000001' }

  it('je sa fakture kad mu je PIB isti, kako god napisan, ili ime isto', () => {
    expect(isFromDocument({ name: 'Drugo ime', tax_id: 'RS 100000001' }, party)).toBe(true)
    expect(isFromDocument({ name: '  alfa doo   BEOGRAD ', tax_id: null }, party)).toBe(true)
  })

  it('nije sa fakture kad je prekucan u drugu firmu', () => {
    expect(isFromDocument({ name: 'Gama Doo', tax_id: null }, party)).toBe(false)
    expect(isFromDocument({ name: 'Gama Doo', tax_id: '100000005' }, party)).toBe(false)
    expect(isFromDocument({ name: '', tax_id: '' }, { name: '', taxId: null })).toBe(false)
    expect(isFromDocument(null, party)).toBe(false)
  })
})

describe('dva partnera na jednom podatku', () => {
  const book = [
    p({ id: 'a', name: 'Alfa Doo', tax_id: '100000001' }),
    p({ id: 'b', name: 'Alfa Doo Beograd', tax_id: 'RS 100000001' }),
    p({ id: 'c', name: 'Beta Doo', tax_id: '100000002', registration_number: '20000002' }),
  ]

  it('nalazi se tamo gde matchSupplier odbija da bira', () => {
    const supplier = { vatNumber: '100000001', registrationNumber: null, name: 'Alfa' }
    expect(matchSupplier(supplier, book)).toBeNull()
    const shared = sharedIdentifier(supplier, book)
    expect(shared?.field).toBe('PIB')
    expect(shared?.partners.map(x => x.id)).toEqual(['a', 'b'])
  })

  it('ne prijavljuje se kad PIB ima jedan partner', () => {
    expect(sharedIdentifier({ vatNumber: '100000002', registrationNumber: null }, book)).toBeNull()
  })

  it('ne prijavljuje se za firmu koju niko nema', () => {
    expect(sharedIdentifier({ vatNumber: '100000009', registrationNumber: '20000009' }, book)).toBeNull()
  })

  it('gleda matični broj samo kad PIB nije pogodio nikoga', () => {
    const twoOnMb = [p({ id: 'x', registration_number: '20000005' }), p({ id: 'y', name: 'Gama', registration_number: '20000005' })]
    expect(sharedIdentifier({ vatNumber: null, registrationNumber: '20000005' }, twoOnMb)?.field).toBe('matični broj')
  })

  it('kaže ko, i da se nov partner ne nudi', () => {
    const shared = sharedIdentifier({ vatNumber: '100000001', registrationNumber: null }, book)!
    expect(sharedIdentifierSentence(shared)).toBe(
      'Dva partnera imaju PIB 100000001: Alfa Doo i Alfa Doo Beograd. '
      + 'Izaberite pravog ručno i uklonite duplikat u Partnerima; nov partner se ne nudi.')
  })

  it('nabraja tri i više', () => {
    const three = [p({ id: 'x', name: 'A' }), p({ id: 'y', name: 'B' }), p({ id: 'z', name: 'C' })]
    expect(sharedIdentifierSentence({ field: 'matični broj', value: '20000005', partners: three })).toBe(
      'Tri partnera imaju matični broj 20000005: A, B i C. '
      + 'Izaberite pravog ručno i uklonite duplikat u Partnerima; nov partner se ne nudi.')
  })
})

describe('šta faktura dodaje svom partneru', () => {
  const bill = { taxId: '100000001', registrationNumber: '20000001' }

  it('popunjava prazan PIB i matični broj', () => {
    const partner = p({ id: 'a' })
    expect(identityFill(partner, bill, [partner])).toEqual({ tax_id: '100000001', registration_number: '20000001' })
  })

  it('nikad ne prepisuje vrednost koju partner već ima', () => {
    const partner = p({ id: 'a', tax_id: '100000777', registration_number: '20000777' })
    expect(identityFill(partner, bill, [partner])).toEqual({})
  })

  it('popunjava samo onaj koji nedostaje', () => {
    const partner = p({ id: 'a', tax_id: '100000001' })
    expect(identityFill(partner, bill, [partner])).toEqual({ registration_number: '20000001' })
  })

  it('prazan tekst smatra praznim', () => {
    const partner = p({ id: 'a', tax_id: '', registration_number: '  ' })
    expect(identityFill(partner, bill, [partner])).toEqual({ tax_id: '100000001', registration_number: '20000001' })
  })

  /** Upis bi stavio jedan PIB na dva partnera — samu grešku. */
  it('ne daje partneru PIB koji već ima drugi partner', () => {
    const partner = p({ id: 'a' })
    const other = p({ id: 'b', name: 'Alfa Doo Beograd', tax_id: '100000001' })
    expect(identityFill(partner, bill, [partner, other])).toEqual({ registration_number: '20000001' })
  })

  it('ne dodaje ništa kad faktura ništa ne navodi', () => {
    const partner = p({ id: 'a' })
    expect(identityFill(partner, { taxId: null, registrationNumber: null }, [partner])).toEqual({})
    expect(identityFill(undefined, bill, [])).toEqual({})
  })

  /** PIB jedne firme i matični broj druge na jednom partneru bi učinili da
   *  ga svaka sledeća faktura prepozna po PIB-u, nevidljivo. */
  it('ne dodaje ništa kad je matični broj partnera tuđi', () => {
    const partner = p({ id: 'a', registration_number: '20000002' })
    expect(identityFill(partner, bill, [partner])).toEqual({})
  })

  it('ne dodaje ništa kad je PIB partnera tuđi', () => {
    const partner = p({ id: 'a', tax_id: '100000002' })
    expect(identityFill(partner, bill, [partner])).toEqual({})
  })

  it('popunjava drugi kad se onaj koji ima slaže, kako god napisan', () => {
    const partner = p({ id: 'a', registration_number: '20 000 001' })
    expect(identityFill(partner, bill, [partner])).toEqual({ tax_id: '100000001' })
  })

  it('zamenu bez cifara smatra praznom, i ne smatra je neslaganjem', () => {
    for (const blank of [null, '', '   ', '-', 'N/A']) expect(isEmptyIdentifier(blank)).toBe(true)
    expect(isEmptyIdentifier('RS100000001')).toBe(false)
    const partner = p({ id: 'a', tax_id: '-', registration_number: 'N/A' })
    expect(identityFill(partner, bill, [partner])).toEqual({ tax_id: '100000001', registration_number: '20000001' })
  })

  it('kaže se jednom jednostavnom rečenicom', () => {
    expect(identityFillSentence({ tax_id: '100000001' }))
      .toBe('PIB 100000001 sa fakture biće upisan kod ovog partnera, koji ga nema.')
    expect(identityFillSentence({ registration_number: '20000001' }))
      .toBe('Matični broj 20000001 sa fakture biće upisan kod ovog partnera, koji ga nema.')
    expect(identityFillSentence({ tax_id: '100000001', registration_number: '20000001' }))
      .toBe('PIB 100000001 i matični broj 20000001 sa fakture biće upisani kod ovog partnera, koji ih nema.')
    expect(identityFillSentence({})).toBeNull()
  })
})

describe('upis dopune', () => {
  /** Zamena koja beleži izmenu i zaštite svakog poziva, a na svaki upis
   *  odgovara redom iz `answers`. */
  const client = (answers: any[], readAnswer: any = { data: null, error: null }) => {
    const calls: any[] = []
    let n = 0
    const from = (table: string) => {
      const call: any = { table, filters: [] }
      calls.push(call)
      const q: any = {
        update: (patch: any) => { call.patch = patch; return q },
        eq: (c: string, v: any) => { call.filters.push(['eq', c, v]); return q },
        is: (c: string, v: any) => { call.filters.push(['is', c, v]); return q },
        not: (c: string, op: string, v: any) => { call.filters.push(['not', c, op, v]); return q },
        or: () => { throw new Error('bez or= filtera') },
        select: () => (call.patch ? Promise.resolve(answers[n++]) : q),
        maybeSingle: () => Promise.resolve(readAnswer),
      }
      return q
    }
    return { from, calls }
  }
  const ok = { data: [{ id: 'a' }], error: null }

  it('svako polje upisuje kao uporedi-pa-upiši prema vrednosti na kojoj je ponuda napravljena', async () => {
    const c = client([ok, ok])
    expect(await saveIdentityFill(c, 'a', { tax_id: '100000001', registration_number: '20000001' }, { tax_id: null, registration_number: 'N/A' })).toBeNull()
    expect(c.calls.map(x => [x.patch, x.filters])).toEqual([
      [{ tax_id: '100000001' }, [['eq', 'id', 'a'], ['is', 'tax_id', null]]],
      [{ registration_number: '20000001' }, [['eq', 'id', 'a'], ['eq', 'registration_number', 'N/A']]],
    ])
  })

  it('prazan tekst štiti operandom koji nije prazan', async () => {
    const c = client([ok])
    await saveIdentityFill(c, 'a', { tax_id: '100000001' }, { tax_id: '' })
    expect(c.calls[0].filters).toEqual([['eq', 'id', 'a'], ['not', 'tax_id', 'like', '%_%']])
  })

  it('za praznu dopunu ne upisuje ništa', async () => {
    const c = client([])
    expect(await saveIdentityFill(c, 'a', {}, {})).toBeNull()
    expect(c.calls).toHaveLength(0)
  })

  it('prijavljuje odbijanje, imenuje polje koje nije uspelo i ona koja nisu pokušana', async () => {
    const c = client([{ data: null, error: { message: 'permission denied' } }])
    const f = await saveIdentityFill(c, 'a', { tax_id: '100000001', registration_number: '20000001' }, {})
    expect(f).toEqual({ fields: ['tax_id', 'registration_number'], reason: 'permission denied' })
    expect(fillFailureSentence(f!)).toBe('Faktura je sačuvana, ali PIB i matični broj sa fakture nisu upisani kod partnera: permission denied')
  })

  it('ne imenuje polje koje je upisano', async () => {
    const c = client([ok, { data: null, error: { message: 'permission denied' } }])
    const f = await saveIdentityFill(c, 'a', { tax_id: '100000001', registration_number: '20000001' }, {})
    expect(fillFailureSentence(f!)).toBe('Faktura je sačuvana, ali matični broj sa fakture nije upisan kod partnera: permission denied')
  })

  it('zadovoljan je kad je neko polje upisao pre', async () => {
    const c = client([{ data: [], error: null }], { data: { tax_id: '100000001' }, error: null })
    expect(await saveIdentityFill(c, 'a', { tax_id: '100000001' }, {})).toBeNull()
  })

  it('prijavljuje upis koji tiho ništa nije promenio, i zamenu i dalje broji kao praznu', async () => {
    const c = client([{ data: [], error: null }], { data: { tax_id: 'N/A' }, error: null })
    expect(await saveIdentityFill(c, 'a', { tax_id: '100000001' }, { tax_id: 'N/A' }))
      .toEqual({ fields: ['tax_id'], reason: 'Baza nije ništa promenila.' })
  })
})
