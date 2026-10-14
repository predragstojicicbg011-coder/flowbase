import { editedAmounts, amountText, correctLine } from './statementLineEdit'

const none = { debit: null, credit: null }

describe('correcting the two amount fields of a bank line', () => {
  it('puts a typed figure on the side it was typed on', () => {
    expect(editedAmounts('debit', '1250.5', none)).toEqual({ debit: 1250.5, credit: null })
    expect(editedAmounts('credit', '99', none)).toEqual({ debit: null, credit: 99 })
  })

  /** A bank line is money out or money in, never both. */
  it('empties the other side when one is filled', () => {
    expect(editedAmounts('debit', '300', { debit: null, credit: 500 }))
      .toEqual({ debit: 300, credit: null })
    expect(editedAmounts('credit', '300', { debit: 500, credit: null }))
      .toEqual({ debit: null, credit: 300 })
  })

  /** Typed, so it clears the other side like any other figure — the same
   *  rule the statement dialog has, where the test is on the text. */
  it('treats a typed zero as something typed', () => {
    expect(editedAmounts('debit', '0', { debit: null, credit: 500 }))
      .toEqual({ debit: 0, credit: null })
  })

  /** Emptying a box is not a request for the opposite figure back. */
  it('leaves the other side alone when a field is cleared', () => {
    expect(editedAmounts('debit', '', { debit: 300, credit: null }))
      .toEqual({ debit: null, credit: null })
    expect(editedAmounts('debit', '', { debit: null, credit: 500 }))
      .toEqual({ debit: null, credit: 500 })
  })

  it('keeps nothing from text that is not a number', () => {
    expect(editedAmounts('debit', 'abc', none)).toEqual({ debit: null, credit: null })
  })

  it('reads a negative correction as typed', () => {
    expect(editedAmounts('credit', '-12.5', none)).toEqual({ debit: null, credit: -12.5 })
  })
})

describe('what the box shows', () => {
  it('shows a figure, and nothing for an absent one', () => {
    expect(amountText(1250.5)).toBe('1250.5')
    expect(amountText(0)).toBe('0')
    expect(amountText(null)).toBe('')
    expect(amountText(undefined)).toBe('')
    expect(amountText(NaN)).toBe('')
  })
})

describe('correcting one line of an import', () => {
  const rows = () => ([
    { parsed: { id: 'a', date: '2026-10-01', debit: 100, credit: null, description: 'FEE' },
      import_hash: 'hash-a', already_imported: false, override_note: 'keep me' },
    { parsed: { id: 'b', date: '2026-10-02', debit: null, credit: 50, description: 'IN' },
      import_hash: 'hash-b', already_imported: true, override_note: '' },
  ])

  it('changes the row it names', () => {
    const out = correctLine(rows(), 'a', { description: 'Bank charge' })
    expect(out[0].parsed.description).toBe('Bank charge')
    expect(out[0].parsed.date).toBe('2026-10-01')
  })

  it('leaves every other row alone', () => {
    const out = correctLine(rows(), 'a', { description: 'Bank charge' })
    expect(out[1]).toEqual(rows()[1])
  })

  it('keeps everything about the row that is not the line', () => {
    const out = correctLine(rows(), 'a', { debit: 120 })
    expect(out[0].override_note).toBe('keep me')
  })

  /** THE POINT OF THIS FUNCTION. The fingerprint is taken once, from the
   *  file. Recomputed after a correction, a row that got attention would look
   *  like one nobody had seen, and the same statement could be imported
   *  twice — on exactly the rows somebody had been careful with. */
  it('does not touch the row fingerprint or what it decided about it', () => {
    const out = correctLine(rows(), 'b', { date: '2026-09-30', credit: 999 })
    expect(out[1].import_hash).toBe('hash-b')
    expect(out[1].already_imported).toBe(true)
  })

  it('does nothing at all for an id that is not there', () => {
    expect(correctLine(rows(), 'nope', { description: 'x' })).toEqual(rows())
  })

  it('does not mutate what it was given', () => {
    const before = rows()
    correctLine(before, 'a', { description: 'Bank charge' })
    expect(before[0].parsed.description).toBe('FEE')
  })
})
