import { readBrand, shortCompanyName, logoParts, storagePrefixFor, brand } from './brand'

describe('brand', () => {
  it('falls back to the FlowBase defaults', () => {
    const b = readBrand({})
    expect(b.appName).toBe('FlowBase')
    expect(b.companyName).toBe('Demo d.o.o.')
    expect(b.companyShort).toBe('Demo')
    expect(b.logo).toEqual(['Flow', 'Base'])
    expect(b.storagePrefix).toBe('flowbase')
    expect(b.tagline).toContain('Demo')
  })

  it('reads a client from the environment', () => {
    const b = readBrand({
      REACT_APP_APP_NAME: ' AlfaFlow ',
      REACT_APP_COMPANY_NAME: 'Alfa Gradnja doo',
      REACT_APP_TAGLINE: 'Naše finansije.',
    })
    expect(b.appName).toBe('AlfaFlow')
    expect(b.companyShort).toBe('Alfa Gradnja')
    expect(b.logo).toEqual(['Alfa', 'Flow'])
    expect(b.storagePrefix).toBe('alfaflow')
    expect(b.tagline).toBe('Naše finansije.')
  })

  it('takes an explicit short name over the derived one', () => {
    expect(readBrand({ REACT_APP_COMPANY_NAME: 'Alfa Beta d.o.o.', REACT_APP_COMPANY_SHORT: 'AB' }).companyShort).toBe('AB')
  })

  it('shortens common legal suffixes only', () => {
    expect(shortCompanyName('Demo d.o.o.')).toBe('Demo')
    expect(shortCompanyName('Firma DOO')).toBe('Firma')
    expect(shortCompanyName('Firma, a.d.')).toBe('Firma')
    expect(shortCompanyName('Dooley')).toBe('Dooley')
  })

  it('splits names without a second word into one part', () => {
    expect(logoParts('ledger')).toEqual(['ledger', ''])
    expect(storagePrefixFor('!!')).toBe('flowbase')
  })

  it('runs on defaults in tests', () => {
    expect(brand.appName).toBe('FlowBase')
  })
})
