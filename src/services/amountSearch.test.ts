import { matchesAmount, amountQuery } from './amountSearch'

describe('typing an amount to find a record', () => {
  /** The case this exists for: a direct transaction with no partner on it
   *  cannot be found by name, and 13.056,00 RSD is on the screen. */
  it('finds an amount typed as bare digits', () => {
    expect(matchesAmount('13056', 13056)).toBe(true)
  })

  it('finds it however the separators are typed', () => {
    for (const typed of ['13056', '13056,00', '13056.00', '13.056,00', '13,056.00', '13 056']) {
      expect(matchesAmount(typed, 13056)).toBe(true)
    }
  })

  it('finds it however the amount itself is stored', () => {
    // `numeric` arrives from PostgREST as a string often enough to matter.
    expect(matchesAmount('13056', '13056.00')).toBe(true)
    expect(matchesAmount('13056', 13056.0)).toBe(true)
  })

  it('shrinks the list while he is still typing', () => {
    expect(matchesAmount('1', 13056)).toBe(true)
    expect(matchesAmount('130', 13056)).toBe(true)
    expect(matchesAmount('13056', 13056)).toBe(true)
  })

  it('does not match an amount that is nothing like it', () => {
    expect(matchesAmount('13056', 124.68)).toBe(false)
    expect(matchesAmount('99999', 13056)).toBe(false)
  })

  it('matches any of the amounts a record carries, so either column will do', () => {
    // The row shows 13.056,00 RSD and $124.68; he may type either.
    expect(matchesAmount('124.68', 13056, 124.68)).toBe(true)
    expect(matchesAmount('13056', 13056, 124.68)).toBe(true)
    expect(matchesAmount('777', 13056, 124.68)).toBe(false)
  })

  it('matches a decimal the owner reads off the screen', () => {
    expect(matchesAmount('124.68', 124.68)).toBe(true)
    expect(matchesAmount('12468', 124.68)).toBe(true)
  })

  it('matches on size, whichever side of the ledger the record sits on', () => {
    expect(matchesAmount('13056', -13056)).toBe(true)
  })

  describe('what is NOT an amount', () => {
    /** A query with letters is a name or a document number. Matching those
     *  against money fills the list with records that have nothing to do
     *  with what was typed, and the name search stops being usable. */
    it('is not an invoice number', () => {
      expect(amountQuery('INV-2026')).toBe('')
      expect(matchesAmount('INV-2026', 2026)).toBe(false)
    })

    it('is not a date', () => {
      expect(amountQuery('2026-10-09')).toBe('')
      expect(matchesAmount('2026-10-09', 20261009)).toBe(false)
    })

    it('is not a partner name, even one with a number in it', () => {
      expect(matchesAmount('Telekom', 13056)).toBe(false)
      expect(matchesAmount('A1 Srbija', 1)).toBe(false)
    })

    it('is not an empty or blank query, which would match everything', () => {
      expect(matchesAmount('', 13056)).toBe(false)
      expect(matchesAmount('   ', 13056)).toBe(false)
      expect(matchesAmount(',.', 13056)).toBe(false)
    })
  })

  it('ignores amounts that are missing or unreadable', () => {
    expect(matchesAmount('13056', null, undefined, NaN, 'abc')).toBe(false)
    expect(matchesAmount('13056', null, 13056)).toBe(true)
  })
})
