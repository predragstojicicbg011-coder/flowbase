import { bankNameForAccount, formatAccount } from './bankCodes'

describe('a bank account, written and named', () => {
  it('is written in the full form, bank-account-control', () => {
    expect(formatAccount('160-553857-18')).toBe('160-0000000553857-18')
    expect(formatAccount('325950070008846789')).toBe('325-9500700088467-89')
    expect(formatAccount('RS35 1600 0000 0055 3857 18')).toBe('160-0000000553857-18')
    expect(formatAccount('12')).toBe('12')
  })

  it('names the bank from the first three digits, where it is known', () => {
    expect(bankNameForAccount('160-553857-18')).toBe('Banca Intesa')
    expect(bankNameForAccount('265-1040310000497-22')).toBe('Raiffeisen banka')
    expect(bankNameForAccount('999-1-11')).toBeNull()
  })
})
