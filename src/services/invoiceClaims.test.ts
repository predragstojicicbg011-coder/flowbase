import {
  EPSILON, claimNotice, claimsFor, exhaustedFor, freeForRow,
  isHiddenForRow,
  type ClaimRow, type OpenInvoice,
} from './invoiceClaims'

const inv = (id: string, remaining: number): OpenInvoice => ({ id, remaining })
const row = (id: string, amount: number, ...invoiceIds: string[]): ClaimRow =>
  ({ id, amount, invoiceIds })

// Three identical invoices, which is the case Predrag hit: the same rent, the
// same amount, the same partner, three months open at once.
const THREE = [inv('a', 500), inv('b', 500), inv('c', 500)]

describe('claimsFor', () => {
  it('claims nothing when no row has ticked anything', () => {
    expect(claimsFor([row('r1', 500)], THREE).size).toBe(0)
  })

  it('gives a row the invoice it ticked, up to its own amount', () => {
    const claims = claimsFor([row('r1', 500, 'a')], THREE)
    expect(claims.get('a')).toEqual({ claimed: 500, rowIds: ['r1'] })
  })

  it('never lets a row allocate more than it is paying', () => {
    // A 300 RSD payment against a 500 RSD invoice leaves 200 for someone else.
    expect(claimsFor([row('r1', 300, 'a')], THREE).get('a')!.claimed).toBe(300)
  })

  it('spends a row across its invoices in the order they were ticked', () => {
    // 800 over two invoices of 500: the first is closed, the second half paid.
    const claims = claimsFor([row('r1', 800, 'a', 'b')], THREE)
    expect(claims.get('a')!.claimed).toBe(500)
    expect(claims.get('b')!.claimed).toBe(300)
  })

  it('hands the second row what the first actually left, not a second copy', () => {
    // THE BUG. Both rows tick invoice `a`; between them they have 1,000, and
    // `a` is worth 500. The second row must not read as covering it again.
    const claims = claimsFor([row('r1', 500, 'a'), row('r2', 500, 'a')], THREE)
    expect(claims.get('a')).toEqual({ claimed: 500, rowIds: ['r1'] })
  })

  it('records both rows when two of them genuinely split one invoice', () => {
    const claims = claimsFor([row('r1', 200, 'a'), row('r2', 300, 'a')], THREE)
    expect(claims.get('a')).toEqual({ claimed: 500, rowIds: ['r1', 'r2'] })
  })

  it('ignores a tick for an invoice the open list does not have', () => {
    // Closed by someone else while the dialog sat open. It claims nothing and
    // does not consume the row's budget.
    const claims = claimsFor([row('r1', 500, 'gone', 'a')], THREE)
    expect(claims.has('gone')).toBe(false)
    expect(claims.get('a')!.claimed).toBe(500)
  })

  it('treats a negative or zero payment as claiming nothing', () => {
    expect(claimsFor([row('r1', 0, 'a'), row('r2', -40, 'b')], THREE).size).toBe(0)
  })

  it('does not claim a cent that rounding left behind', () => {
    // The poster settles in the invoice's own currency, so a closed invoice
    // can still show a fraction of a para here. It is not an open invoice.
    const claims = claimsFor([row('r1', 500, 'a')], [inv('a', 500 + EPSILON / 2)])
    expect(claims.get('a')!.claimed).toBeLessThanOrEqual(500 + EPSILON)
    expect(freeForRow(inv('a', 500 + EPSILON / 2), [row('r1', 500, 'a')], 'r2').exhausted).toBe(true)
  })
})

describe('freeForRow', () => {
  const rows = [row('r1', 500, 'a'), row('r2', 200, 'b')]

  it('ignores the asking row, so ticking does not hide what you just ticked', () => {
    // r1 holds all of `a`, but from r1's own seat `a` is entirely available.
    expect(freeForRow(inv('a', 500), rows, 'r1')).toEqual({
      remaining: 500, exhausted: false, claimedBy: [],
    })
  })

  it('reports an invoice another row has emptied as exhausted', () => {
    const free = freeForRow(inv('a', 500), rows, 'r2')
    expect(free.exhausted).toBe(true)
    expect(free.remaining).toBe(0)
    expect(free.claimedBy).toEqual(['r1'])
  })

  it('leaves a partly claimed invoice open, at what is actually left', () => {
    const free = freeForRow(inv('b', 500), rows, 'r1')
    expect(free.exhausted).toBe(false)
    expect(free.remaining).toBe(300)
    expect(free.claimedBy).toEqual(['r2'])
  })

  it('never reports a negative remainder', () => {
    const greedy = [row('r1', 900, 'a')]
    expect(freeForRow(inv('a', 500), greedy, 'r2').remaining).toBe(0)
  })
})

describe('exhaustedFor', () => {
  it('names only the invoices with nothing left for the asking row', () => {
    const rows = [row('r1', 500, 'a'), row('r2', 200, 'b')]
    expect(Array.from(exhaustedFor(THREE, rows, 'r3')).sort()).toEqual(['a'])
  })

  it('excludes nothing from the row that made the claims', () => {
    const rows = [row('r1', 1500, 'a', 'b', 'c')]
    expect(exhaustedFor(THREE, rows, 'r1').size).toBe(0)
  })

  it('shuts the whole list when earlier rows cover all of it', () => {
    const rows = [row('r1', 500, 'a'), row('r2', 500, 'b'), row('r3', 500, 'c')]
    expect(exhaustedFor(THREE, rows, 'r4').size).toBe(3)
  })
})

describe('claimNotice', () => {
  const label = (id: string) => 'line ' + id.replace('r', '')

  it('says nothing about an invoice nobody else has touched', () => {
    expect(claimNotice({ remaining: 500, exhausted: false, claimedBy: [] }, label)).toBeNull()
  })

  it('names who covered it, so the row is findable', () => {
    expect(claimNotice({ remaining: 0, exhausted: true, claimedBy: ['r1'] }, label))
      .toBe('Already fully covered by line 1 in this batch')
  })

  it('says how much is left when the claim is partial', () => {
    expect(claimNotice({ remaining: 300, exhausted: false, claimedBy: ['r2'] }, label))
      .toBe('300,00 RSD left — the rest is claimed by line 2')
  })

  it('lists every claimant rather than just the first', () => {
    expect(claimNotice({ remaining: 0, exhausted: true, claimedBy: ['r1', 'r2'] }, label))
      .toBe('Already fully covered by line 1, line 2 in this batch')
  })
})

describe('claimNotice in a unit that is not dinars', () => {
  const label = (id: string) => 'line ' + id.replace('r', '')
  const eur = (n: number) => `${n.toFixed(2)} EUR`

  it('renders the remainder the way the caller has been showing it', () => {
    // The bank statement dialog reasons in the invoice's own currency, so a
    // dinar code here would be a lie about what the number is.
    expect(claimNotice({ remaining: 120000, exhausted: false, claimedBy: ['r2'] }, label, eur))
      .toBe('120000.00 EUR left — the rest is claimed by line 2')
  })

  it('needs no formatter for the exhausted case, which names no amount', () => {
    expect(claimNotice({ remaining: 0, exhausted: true, claimedBy: ['r1'] }, label, eur))
      .toBe('Already fully covered by line 1 in this batch')
  })
})


describe('what the picker leaves out', () => {
  const free = (remaining: number, claimedBy: string[] = []) =>
    ({ remaining, exhausted: remaining <= EPSILON, claimedBy })

  it('hides an invoice another line has spent in full', () => {
    expect(isHiddenForRow(free(0, ['r1']), false, false)).toBe(true)
  })

  it('keeps one that still has money left on it', () => {
    expect(isHiddenForRow(free(120, ['r1']), false, false)).toBe(false)
  })

  /** A picker that hides what it is showing as chosen is a picker nobody
   *  believes — and unticking it would then be impossible. */
  it('never hides an invoice this row has ticked', () => {
    expect(isHiddenForRow(free(0, ['r1']), true, false)).toBe(false)
  })

  /** The claim on the other line may itself be the mistake being hunted. */
  it('shows everything when the user asks for it', () => {
    expect(isHiddenForRow(free(0, ['r1']), false, true)).toBe(false)
  })

  it('keeps an untouched invoice on screen', () => {
    expect(isHiddenForRow(free(500), false, false)).toBe(false)
  })
})


describe('a row whose amount is not known', () => {
  const invoices = [
    { id: 'a', remaining: 4941.37 },
    { id: 'b', remaining: 29.5 },
  ]

  /**
   * The regression this exists for. The bulk import compares claims in
   * dinars, and the dinar figure is attached by the analysis step. A row
   * that never went through it claimed ZERO — so a line plainly closing a
   * 505,023 RSD invoice spoke for nothing, and that invoice went on being
   * offered to every other line of the statement.
   *
   * Infinity is how "I do not know how much, but it closes this" is said.
   */
  it('takes the whole invoice rather than none of it', () => {
    const claims = claimsFor(
      [{ id: 'r1', amount: Number.POSITIVE_INFINITY, invoiceIds: ['a'] }],
      invoices)
    expect(claims.get('a')!.claimed).toBe(4941.37)
    expect(freeForRow(invoices[0], [{ id: 'r1', amount: Number.POSITIVE_INFINITY, invoiceIds: ['a'] }], 'r2').exhausted)
      .toBe(true)
  })

  /** A zero claim is what let the same invoice be closed twice. */
  it('is not what a zero claim does', () => {
    const rows = [{ id: 'r1', amount: 0, invoiceIds: ['a'] }]
    expect(claimsFor(rows, invoices).get('a')).toBeUndefined()
    expect(freeForRow(invoices[0], rows, 'r2').exhausted).toBe(false)
  })

  it('still leaves the row that made the claim able to see it', () => {
    const rows = [{ id: 'r1', amount: Number.POSITIVE_INFINITY, invoiceIds: ['a'] }]
    expect(freeForRow(invoices[0], rows, 'r1').exhausted).toBe(false)
  })

  it('spends itself across everything it ticked', () => {
    const rows = [{ id: 'r1', amount: Number.POSITIVE_INFINITY, invoiceIds: ['a', 'b'] }]
    const claims = claimsFor(rows, invoices)
    expect(claims.get('a')!.claimed).toBe(4941.37)
    expect(claims.get('b')!.claimed).toBe(29.5)
  })

  it('does not stop a later row taking what an unknown one left', () => {
    const rows = [
      { id: 'r1', amount: Number.POSITIVE_INFINITY, invoiceIds: ['a'] },
      { id: 'r2', amount: 29.5, invoiceIds: ['b'] },
    ]
    expect(claimsFor(rows, invoices).get('b')!.claimed).toBe(29.5)
    expect(freeForRow(invoices[1], rows, 'r3').exhausted).toBe(true)
  })
})
