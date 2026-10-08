import {
  accountDigits, sameAccountNumber, defaultAccount, findAccountByNumber,
  chooseAccount, carriedAccountOf, type PartnerAccountLite,
} from './partnerAccountChoice'

const acc = (over: Partial<PartnerAccountLite> & { id: string }): PartnerAccountLite => ({
  account_number: '160-0000000000000-11', model: '97', reference_number: null,
  is_primary: false, ...over,
})

const primary = acc({ id: 'p', account_number: '160-1111111111111-11', is_primary: true })
const second = acc({ id: 's', account_number: '265-2222222222222-22', model: '00' })
const accounts = [primary, second]

describe('which account a record is talking about', () => {
  /**
   * THE FAULT THIS EXISTS FOR.
   *
   * Both the invoice dialog and the transaction dialog loaded a partner's
   * accounts and set the primary one, unconditionally, from an effect keyed on
   * the partner. Opening a saved record set the partner, which fired that
   * effect, which resolved AFTER the record had been read in and overwrote the
   * account number with the primary.
   *
   * It was not a display fault. The overwritten number is what the next save
   * wrote back, so opening a bill to correct a date moved the money to a
   * different account — and the payment-order export, which rightly trusts the
   * number on the invoice, exported it.
   */
  it('keeps the account the record was saved with', () => {
    const chosen = chooseAccount(accounts, { account_number: '265-2222222222222-22', model: '00' })
    expect(chosen?.accountId).toBe('s')
    expect(chosen?.accountNumber).toBe('265-2222222222222-22')
  })

  it('offers the primary only where the record names no account', () => {
    expect(chooseAccount(accounts, null)?.accountId).toBe('p')
  })

  /** A record saved before there was anything to save is not a record that
   *  wants the primary withheld — it genuinely names nothing. */
  it('offers the primary where the record carries an empty number', () => {
    expect(chooseAccount(accounts, { account_number: '', model: '' })?.accountId).toBe('p')
  })

  /** With no account flagged primary the first is the default, which is what
   *  the query's `is_primary desc` ordering already meant. */
  it('falls back to the first account when none is flagged primary', () => {
    expect(chooseAccount([second, acc({ id: 'x' })], null)?.accountId).toBe('s')
  })

  it('has nothing to say when the partner has no accounts and nothing was saved', () => {
    expect(chooseAccount([], null)).toBeNull()
  })

  /**
   * A number typed by hand, or one belonging to an account since deleted.
   * It is still the number on the bill, so it stands — and the caller is told
   * it matches nothing, so the dropdown can say so instead of sitting blank.
   */
  it('keeps a number that matches no saved account, and says so', () => {
    const chosen = chooseAccount(accounts, { account_number: '340-9999999999999-99', model: '97' })
    expect(chosen?.accountId).toBe('')
    expect(chosen?.accountNumber).toBe('340-9999999999999-99')
    expect(chosen?.typedIn).toBe(true)
  })

  /** Including when the partner has no saved accounts at all, which is the
   *  case for every foreign supplier: the RSD account list comes back empty
   *  and the number on the bill must survive it. */
  it('keeps a saved number when the partner has no accounts', () => {
    const chosen = chooseAccount([], { account_number: 'DE89370400440532013000', model: null })
    expect(chosen?.accountNumber).toBe('DE89370400440532013000')
    expect(chosen?.typedIn).toBe(true)
  })

  /**
   * The record's own model wins. It is what was agreed for that bill, and the
   * account's is only a default for a new one.
   */
  it('keeps the model the record was saved with', () => {
    expect(chooseAccount(accounts, { account_number: '265-2222222222222-22', model: '11' })?.model).toBe('11')
  })

  it('takes the account’s model where the record carries none', () => {
    expect(chooseAccount(accounts, { account_number: '265-2222222222222-22', model: null })?.model).toBe('00')
  })
})

describe('comparing account numbers', () => {
  /** Serbian account numbers are written with dashes, and not always the same
   *  ones. The number is the digits; the punctuation is typography. */
  it('ignores punctuation and spacing', () => {
    expect(sameAccountNumber('160-1111111111111-11', '1601111111111111 11')).toBe(true)
  })

  it('does not call two different accounts the same', () => {
    expect(sameAccountNumber('160-1111111111111-11', '265-2222222222222-22')).toBe(false)
  })

  /**
   * Two empty numbers are not a match. Treated as one, every record carrying
   * no account would select whichever saved account also carried none — which
   * is how money ends up somewhere nobody chose.
   */
  it('never matches on nothing', () => {
    expect(sameAccountNumber('', '')).toBe(false)
    expect(sameAccountNumber(null, '160-1')).toBe(false)
  })

  it('keeps only the digits', () => {
    expect(accountDigits('160-1111111111111-11')).toBe('160111111111111111')
    expect(accountDigits(null)).toBe('')
  })

  it('finds the account a number belongs to', () => {
    expect(findAccountByNumber(accounts, '2652222222222222 22')?.id).toBe('s')
    expect(findAccountByNumber(accounts, '999')).toBeNull()
  })

  it('names the default account of a list', () => {
    expect(defaultAccount(accounts)?.id).toBe('p')
    expect(defaultAccount([])).toBeNull()
  })
})

// ── Whether the record still has standing to name an account ───────────────

describe('what a saved record is allowed to say', () => {
  const bill = { partner_id: 'telekom', account_number: '265-2222222222222-22', model: '11' }

  /** Opening it to edit. The whole point: do not impose a default here. */
  it('speaks for itself while it is still its own partner', () => {
    expect(carriedAccountOf(bill, 'telekom')).toEqual({
      account_number: '265-2222222222222-22', model: '11',
    })
  })

  /**
   * The supplier was changed mid-edit. The old account belongs to somebody
   * else; naming it would be worse than useless, so the new partner's default
   * is right and imposing it is not an overwrite.
   */
  it('says nothing once a different partner is chosen', () => {
    expect(carriedAccountOf(bill, 'eps')).toBeNull()
  })

  /** A new bill. Nothing is being overwritten. */
  it('says nothing when there is no record at all', () => {
    expect(carriedAccountOf(null, 'telekom')).toBeNull()
    expect(carriedAccountOf(undefined, 'telekom')).toBeNull()
  })

  it('says nothing before a partner has been chosen', () => {
    expect(carriedAccountOf(bill, '')).toBeNull()
  })

  /**
   * The two together are the fix, stated end to end: a saved bill reopened
   * keeps its own account, and the same bill pointed at a new supplier takes
   * that supplier's primary.
   */
  it("keeps the bill's account on reopen and the default after a switch", () => {
    const accounts = [
      { id: 'p', account_number: '160-1111111111111-11', is_primary: true },
      { id: 's', account_number: '265-2222222222222-22' },
    ]
    expect(chooseAccount(accounts, carriedAccountOf(bill, 'telekom'))?.accountId).toBe('s')
    expect(chooseAccount(accounts, carriedAccountOf(bill, 'eps'))?.accountId).toBe('p')
  })
})
