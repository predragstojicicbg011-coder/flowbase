import { foldName, sameName, findExisting } from './lookupNames'

// ─── What counts as the same name ───────────────────────────────────────────
//
// The rule here is the rule the database enforces: the unique indexes in
// `20260928100000` fold with `lower(regexp_replace(btrim(name), '\s+', ' '))`,
// which is these three tests and no more. If the two ever disagree, the form
// refuses names the database accepts or the other way round — and the second
// of those is how `Salary Expenses Domestic` got in.

describe('foldName', () => {
  it('ignores the capital letter that split one account into two', () => {
    expect(foldName('Salary Expenses Domestic')).toBe(foldName('Salary expenses domestic'))
  })

  it('ignores the space on the end that nobody can see', () => {
    expect(foldName('Salary expenses domestic ')).toBe('salary expenses domestic')
  })

  it('ignores a double space in the middle', () => {
    expect(foldName('Salary  expenses   domestic')).toBe('salary expenses domestic')
  })

  it('folds a tab and a newline the same way it folds a space', () => {
    expect(foldName('Salary\texpenses\ndomestic')).toBe('salary expenses domestic')
  })

  /**
   * Deliberately NOT folded. `Radović` and `Radovic` are one person to a
   * human and two strings to everything else, and merging employees on a rule
   * nobody asked for is a worse fault than the one being prevented.
   */
  it('leaves accents alone, because they are not typing', () => {
    expect(foldName('Radović')).not.toBe(foldName('Radovic'))
  })

  it('does not make two different accounts into one', () => {
    expect(foldName('Salary expenses domestic'))
      .not.toBe(foldName('Salary expenses abroad'))
  })

  it('survives a name that is nothing but spaces', () => {
    expect(foldName('   ')).toBe('')
  })
})

describe('sameName', () => {
  it('is true for the pair that caused all this', () => {
    expect(sameName('Salary Expenses Domestic', 'Salary expenses domestic')).toBe(true)
  })

  it('is false for two accounts that merely look alike', () => {
    expect(sameName('Net Salaries', 'Net salary')).toBe(false)
  })
})

describe('findExisting', () => {
  const rows = [
    { id: 'a', name: 'Net Salaries' },
    { id: 'b', name: 'Tax on salary' },
  ]

  it('finds the row already holding the name, however it was typed', () => {
    expect(findExisting(rows, '  net   SALARIES ')?.id).toBe('a')
  })

  it('finds nothing when the name is genuinely new', () => {
    expect(findExisting(rows, 'Warm meal allowance')).toBeUndefined()
  })

  /**
   * The caller narrows to the parent before calling. Eight departments each
   * have a `SaaS expenses`; searching the whole table would refuse to create
   * the ninth and quietly file next month's spend under another department.
   */
  it('searches only what it was handed', () => {
    expect(findExisting([], 'Net Salaries')).toBeUndefined()
  })
})
