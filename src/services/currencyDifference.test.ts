import {
  differenceFor, entryNote, isBookable, TOLERANCE,
} from './currencyDifference'

const at = (invoiceShortfall: number, paymentUnallocated: number, currency = 'RSD') =>
  differenceFor({ invoiceShortfall, paymentUnallocated, currency })

describe('when there is nothing to book', () => {
  it('says so when the payment settles the invoice exactly', () => {
    const d = at(0, 0)
    expect(d.kind).toBe('none')
    expect(d.amount).toBe(0)
    expect(isBookable(d)).toBe(false)
  })

  it('ignores a rounding remainder rather than offering to book a cent', () => {
    expect(at(TOLERANCE / 2, 0).kind).toBe('none')
    expect(at(0, TOLERANCE / 2).kind).toBe('none')
  })

  it('treats a negative figure as nothing, not as the other direction', () => {
    // An over-allocated invoice or an over-spent payment is a different fault
    // and is not this control's business to quietly absorb.
    expect(at(-500, 0).kind).toBe('none')
    expect(at(0, -500).kind).toBe('none')
  })
})

describe('the payment was short of the invoice', () => {
  const d = at(6074.04, 0)

  it('is a gain, because less was paid than was booked', () => {
    expect(d.kind).toBe('gain')
    expect(d.direction).toBe('revenue')
    expect(d.amount).toBeCloseTo(6074.04, 2)
  })

  it('must be linked to the invoice, because nothing else will close it', () => {
    // The asymmetry this module exists for. Leave it unlinked and the invoice
    // reads partial for ever.
    expect(d.linksToInvoice).toBe(true)
  })

  it('names the amount and the currency in the explanation', () => {
    expect(d.note).toContain('6,074.04 RSD')
    expect(d.note).toContain('closes the invoice')
  })
})

describe('the payment was larger than the invoice', () => {
  const d = at(0, 6074.04)

  it('is a loss, because more was paid than was booked', () => {
    expect(d.kind).toBe('loss')
    expect(d.direction).toBe('expense')
    expect(d.amount).toBeCloseTo(6074.04, 2)
  })

  it('must NOT be linked, because the invoice is already closed', () => {
    // Linking it would allocate more to the payment than the bank moved.
    expect(d.linksToInvoice).toBe(false)
  })

  it('says it is splitting one bank line rather than adding a movement', () => {
    expect(d.note).toContain('same bank line')
  })
})

describe('an allocation that has not been finished', () => {
  const d = at(5000, 3000)

  it('refuses to call it a difference', () => {
    // Money left on the payment AND wanted by the invoice is an unfinished
    // edit. Booking anything would paper over it.
    expect(d.kind).toBe('allocate-first')
    expect(d.amount).toBe(0)
    expect(d.direction).toBeNull()
    expect(isBookable(d)).toBe(false)
  })

  it('says what is left on each side, so the fix is in the sentence', () => {
    expect(d.note).toContain('3,000.00 RSD')
    expect(d.note).toContain('5,000.00 RSD')
    expect(d.note).toContain('Allocate what is left')
  })
})

describe('the two directions are never both offered', () => {
  it('is bookable in exactly one direction at a time', () => {
    for (const [short, spare] of [[100, 0], [0, 100], [0, 0], [100, 100]] as const) {
      const d = at(short, spare)
      expect(['none', 'gain', 'loss', 'allocate-first']).toContain(d.kind)
      if (d.kind === 'gain') expect(d.direction).toBe('revenue')
      if (d.kind === 'loss') expect(d.direction).toBe('expense')
      if (!isBookable(d)) expect(d.amount).toBe(0)
    }
  })

  it('never reports a negative amount to book', () => {
    for (const [short, spare] of [[-1, -1], [5, 0], [0, 5], [7, 7]] as const) {
      expect(at(short, spare).amount).toBeGreaterThanOrEqual(0)
    }
  })
})

describe('entryNote', () => {
  it('names the invoice, so the entry explains itself later', () => {
    expect(entryNote('R23/59-2026', at(100, 0)))
      .toBe('Currency difference on R23/59-2026 — paid less than invoiced')
  })

  it('says which way it went for a surplus', () => {
    expect(entryNote('R23/59-2026', at(0, 100)))
      .toBe('Currency difference on R23/59-2026 — paid more than invoiced')
  })

  it('still says something when the invoice has no number', () => {
    expect(entryNote(null, at(100, 0))).toBe('Currency difference — paid less than invoiced')
  })
})

describe('the wording carries no currency when none was given', () => {
  it('leaves the code off rather than guessing at dollars', () => {
    const d = differenceFor({ invoiceShortfall: 100, paymentUnallocated: 0 })
    expect(d.note).toContain('100.00')
    expect(d.note).not.toContain('USD')
  })
})
