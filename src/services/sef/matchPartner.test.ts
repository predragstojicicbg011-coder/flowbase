import { matchSupplier, type PartnerLite } from './matchPartner'

const p = (over: Partial<PartnerLite> & { id: string }): PartnerLite => ({
  name: 'Telekom Srbija', tax_id: '100002887', registration_number: '17162543', ...over,
})

const book = [p({ id: 'tel' }), p({ id: 'eps', name: 'EPS Snabdevanje', tax_id: '103920327', registration_number: '20053658' })]

describe('finding the supplier a bill came from', () => {
  /** The PIB is an identifier, not a name. It is the only key here that cannot
   *  mean two companies. */
  it('matches on the PIB first', () => {
    expect(matchSupplier({ vatNumber: '103920327', registrationNumber: '17162543', name: 'something else' }, book))
      .toEqual({ partnerId: 'eps', by: 'pib' })
  })

  it('ignores punctuation and spacing in the PIB', () => {
    expect(matchSupplier({ vatNumber: ' 100 002 887 ', registrationNumber: null, name: null }, book)?.partnerId)
      .toBe('tel')
  })

  it('falls back to the registration number', () => {
    expect(matchSupplier({ vatNumber: null, registrationNumber: '17162543', name: null }, book))
      .toEqual({ partnerId: 'tel', by: 'registration' })
  })

  /** Weakest, and reported as such so the queue can say the match is by name
   *  — which is how a bill ends up against the wrong company. */
  it('falls back to the folded name, and says that is what it did', () => {
    expect(matchSupplier({ vatNumber: null, registrationNumber: null, name: 'TELEKOM  SRBIJA' }, book))
      .toEqual({ partnerId: 'tel', by: 'name' })
  })

  /**
   * REVIEW FOCUS 1. Every first bill from a new supplier is this. No match is
   * no match: a near-miss filed against a neighbour is money against a company
   * that is not owed it.
   */
  it('returns nothing for a supplier nobody has', () => {
    expect(matchSupplier({ vatNumber: '999999999', registrationNumber: '12345678', name: 'Brand New Doo' }, book))
      .toBeNull()
  })

  it('returns nothing when the bill names no supplier at all', () => {
    expect(matchSupplier({ vatNumber: null, registrationNumber: null, name: null }, book)).toBeNull()
  })

  /** Two partners sharing a PIB is a duplicate somebody should fix, and
   *  guessing between them is not this function's job. */
  it('returns nothing when two partners carry the same PIB', () => {
    expect(matchSupplier({ vatNumber: '100002887', registrationNumber: null, name: null },
      [p({ id: 'a' }), p({ id: 'b' })])).toBeNull()
  })

  /** B1: a bill whose PIB matches nobody must not be filed against a partner
   *  that merely shares its name and carries a different PIB. */
  it('refuses a name match that a conflicting PIB contradicts', () => {
    expect(matchSupplier(
      { vatNumber: '999999999', registrationNumber: null, name: 'Telekom Srbija' }, book))
      .toBeNull()
  })

  /** B1: an ambiguous PIB stops the search rather than falling through to a
   *  weaker key and answering with one of the duplicates. */
  it('stops at an ambiguous PIB instead of falling through to the name', () => {
    expect(matchSupplier(
      { vatNumber: '100002887', registrationNumber: null, name: 'Telekom Srbija' },
      [p({ id: 'a' }), p({ id: 'b', name: 'Telekom Beograd' })])).toBeNull()
  })

  /** The `if (pib)` guard itself: without it, one partner lacking a PIB would
   *  collect every bill that carries none. */
  it('does not match a partner with no PIB to a bill with no PIB', () => {
    expect(matchSupplier(
      { vatNumber: null, registrationNumber: null, name: 'Nobody' },
      [p({ id: 'x', name: 'Someone', tax_id: null, registration_number: null })]))
      .toBeNull()
  })

  /** The veto must not fire on a partner that simply has no identifier of its
   *  own. Partners typed in before PIBs were recorded are exactly that, and
   *  vetoing them would quietly stop matching the oldest suppliers. */
  it('does not veto a partner that carries no identifier', () => {
    expect(matchSupplier(
      { vatNumber: '999999999', registrationNumber: null, name: 'Stari Dobavljac' },
      [p({ id: 'old', name: 'Stari Dobavljac', tax_id: null, registration_number: null })]))
      .toEqual({ partnerId: 'old', by: 'name' })
  })
})
