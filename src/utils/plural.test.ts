import { plural, pluralForm, countOf } from './plural'

describe('pluralForm', () => {
  it('takes "one" for a last digit of 1, except 11', () => {
    expect([1, 21, 101, 1001].map(pluralForm)).toEqual(['one', 'one', 'one', 'one'])
    expect(pluralForm(11)).toBe('many')
    expect(pluralForm(111)).toBe('many')
  })

  it('takes "few" for 2–4, except 12–14', () => {
    expect([2, 3, 4, 22, 34, 102].map(pluralForm)).toEqual(['few', 'few', 'few', 'few', 'few', 'few'])
    expect([12, 13, 14, 112].map(pluralForm)).toEqual(['many', 'many', 'many', 'many'])
  })

  it('takes "many" for 0 and 5–20', () => {
    expect([0, 5, 9, 10, 15, 20, 25].map(pluralForm)).toEqual(Array(7).fill('many'))
  })

  it('reads a negative count by its size', () => {
    expect(pluralForm(-3)).toBe('few')
  })
})

describe('plural and countOf', () => {
  it('pick the word for the count', () => {
    expect(plural(1, 'faktura', 'fakture', 'faktura')).toBe('faktura')
    expect(plural(3, 'faktura', 'fakture', 'faktura')).toBe('fakture')
    expect(countOf(5, 'stavka', 'stavke', 'stavki')).toBe('5 stavki')
    expect(countOf(21, 'projekat', 'projekta', 'projekata')).toBe('21 projekat')
  })
})
