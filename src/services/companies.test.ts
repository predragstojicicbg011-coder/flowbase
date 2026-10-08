import { pickDefaultCompany, showCompanyPicker, type Company } from './companies'

const co = (id: string, name: string): Company => ({ id, name })

describe('pickDefaultCompany', () => {
  it('is the only company when there is one', () => {
    expect(pickDefaultCompany([co('m', 'Milinković Company doo')])?.id).toBe('m')
  })

  it('is the first in name order when there are several', () => {
    // The list arrives ordered by name, which is the order every picker showed.
    expect(pickDefaultCompany([co('a', 'Alpha d.o.o.'), co('b', 'Beta d.o.o.')])?.id).toBe('a')
  })

  it('is nothing at all with no companies, rather than a made-up one', () => {
    expect(pickDefaultCompany([])).toBeNull()
  })
})

describe('showCompanyPicker', () => {
  it('asks nothing when there is nothing to choose between', () => {
    expect(showCompanyPicker([])).toBe(false)
    expect(showCompanyPicker([co('m', 'Milinković Company doo')])).toBe(false)
  })

  it('offers the choice from two companies on', () => {
    expect(showCompanyPicker([co('a', 'Alpha d.o.o.'), co('b', 'Beta d.o.o.')])).toBe(true)
  })
})
