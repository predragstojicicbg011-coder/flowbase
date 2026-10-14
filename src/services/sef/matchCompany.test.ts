import { matchCompany, CompanyLite } from './matchCompany'

const co = (id: string, name: string, pib: string | null, mb: string | null): CompanyLite =>
  ({ id, name, pib, mb })

const PRIMALAC = co('c1', 'Primalac d.o.o.', '100000001', '20000001')
const OTHER = co('c2', 'Constel Group d.o.o.', '100200300', '09876543')

describe('matchCompany', () => {
  it('finds the company the bill is addressed to by PIB', () => {
    expect(matchCompany({ vatNumber: '100000001', registrationNumber: null },
      [OTHER, PRIMALAC])).toEqual({ companyId: 'c1', by: 'pib' })
  })

  it('reads a PIB through the country prefix and any punctuation', () => {
    // The document carries `RS100000001`; Settings holds the bare digits.
    expect(matchCompany({ vatNumber: 'RS100000001', registrationNumber: null },
      [PRIMALAC])).toEqual({ companyId: 'c1', by: 'pib' })
    expect(matchCompany({ vatNumber: '100000001', registrationNumber: null },
      [co('c1', 'Primalac', 'RS 100-000-001', null)]))
      .toEqual({ companyId: 'c1', by: 'pib' })
  })

  it('refuses to choose when two companies carry the same PIB, and does not fall through', () => {
    // Settings has a duplicate. `b` would be reached by registration number,
    // and reaching it would book the bill against a company nobody picked.
    const a = co('a', 'Primalac', '100000001', '11111111')
    const b = co('b', 'Primalac (old)', '100000001', '20000001')
    expect(matchCompany({ vatNumber: '100000001', registrationNumber: '20000001' }, [a, b]))
      .toBeNull()
  })

  it('uses the registration number when the bill carries no PIB', () => {
    expect(matchCompany({ vatNumber: null, registrationNumber: '20000001' },
      [OTHER, PRIMALAC])).toEqual({ companyId: 'c1', by: 'registration' })
  })

  it('still tries the registration number when the PIB matches nothing', () => {
    expect(matchCompany({ vatNumber: '999999999', registrationNumber: '20000001' },
      [PRIMALAC])).toEqual({ companyId: 'c1', by: 'registration' })
  })

  it('refuses two companies on one registration number', () => {
    const a = co('a', 'One', null, '20000001')
    const b = co('b', 'Two', null, '20000001')
    expect(matchCompany({ vatNumber: null, registrationNumber: '20000001' }, [a, b])).toBeNull()
  })

  it('never matches on the name, however exactly it is spelt', () => {
    // The supplier typed the owner's company name perfectly and gave no
    // identifier that matches. Spelling does not decide which book a cost
    // lands in.
    expect(matchCompany({ vatNumber: null, registrationNumber: null },
      [co('c1', 'PRIMALAC DOO BEOGRAD', '100000001', '20000001')])).toBeNull()
    expect(matchCompany({ vatNumber: '000000000', registrationNumber: '00000000' },
      [co('c1', 'PRIMALAC DOO BEOGRAD', '100000001', '20000001')])).toBeNull()
  })

  it('returns null when no company has an identifier to match against', () => {
    expect(matchCompany({ vatNumber: '100000001', registrationNumber: '20000001' },
      [co('c1', 'Primalac', null, null)])).toBeNull()
  })

  it('returns null on an empty list', () => {
    expect(matchCompany({ vatNumber: '100000001', registrationNumber: null }, [])).toBeNull()
  })
})
