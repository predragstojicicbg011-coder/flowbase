import { normalizeName, scorePair, proposePairs, summarize, PassthroughRow } from './autoMatch'

const row = (o: Partial<PassthroughRow> & { id: string; direction: 'in' | 'out' }): PassthroughRow => ({
  company_id: 'C1',
  partner_id: null,
  partner_name: null,
  transaction_date: '2026-08-10',
  amount: 1000,
  amount_rsd: 1000,
  amount_eur: 8.53,
  currency: 'RSD',
  note: null,
  reference_number: null,
  ...o,
})

describe('normalizeName', () => {
  it('treats legal forms and punctuation as equal', () => {
    expect(normalizeName('Primer d.o.o. Beograd'))
      .toBe(normalizeName('PRIMER DOO   BEOGRAD'))
  })

  it('strips LLC and dots', () => {
    expect(normalizeName('Social Growth L.L.C-FZ')).toBe('social growth')
  })

  it('empty input yields empty string', () => {
    expect(normalizeName(null)).toBe('')
    expect(normalizeName(undefined)).toBe('')
  })
})

describe('scorePair', () => {
  it('exact amount, same partner, same day -> high', () => {
    const p = scorePair(
      row({ id: 'A', direction: 'in', partner_id: 'P1' }),
      row({ id: 'B', direction: 'out', partner_id: 'P1' }),
    )
    expect(p).not.toBeNull()
    expect(p!.confidence).toBe('high')
    expect(p!.amountDiffRsd).toBe(0)
    expect(p!.dayGap).toBe(0)
  })

  it('different known partners are NOT proposed', () => {
    const p = scorePair(
      row({ id: 'A', direction: 'in', partner_id: 'P1' }),
      row({ id: 'B', direction: 'out', partner_id: 'P2' }),
    )
    expect(p).toBeNull()
  })

  it('amount difference above 3% is not proposed', () => {
    const p = scorePair(
      row({ id: 'A', direction: 'in', partner_id: 'P1', amount_rsd: 1000 }),
      row({ id: 'B', direction: 'out', partner_id: 'P1', amount_rsd: 950 }),
    )
    expect(p).toBeNull()
  })

  it('small amount difference passes as a possible fee', () => {
    const p = scorePair(
      row({ id: 'A', direction: 'in', partner_id: 'P1', amount_rsd: 1000 }),
      row({ id: 'B', direction: 'out', partner_id: 'P1', amount_rsd: 985 }),
    )
    expect(p).not.toBeNull()
    expect(p!.amountDiffRsd).toBe(15)
  })

  it('gap over 45 days is not proposed', () => {
    const p = scorePair(
      row({ id: 'A', direction: 'in', partner_id: 'P1', transaction_date: '2026-06-01' }),
      row({ id: 'B', direction: 'out', partner_id: 'P1', transaction_date: '2026-08-01' }),
    )
    expect(p).toBeNull()
  })

  it('two INs are never a pair', () => {
    expect(scorePair(
      row({ id: 'A', direction: 'in' }),
      row({ id: 'B', direction: 'in' } as any),
    )).toBeNull()
  })

  it('different companies are not paired', () => {
    const p = scorePair(
      row({ id: 'A', direction: 'in', partner_id: 'P1', company_id: 'C1' }),
      row({ id: 'B', direction: 'out', partner_id: 'P1', company_id: 'C2' }),
    )
    expect(p).toBeNull()
  })

  it('zero amount is not paired', () => {
    const p = scorePair(
      row({ id: 'A', direction: 'in', partner_id: 'P1', amount_rsd: 0 }),
      row({ id: 'B', direction: 'out', partner_id: 'P1', amount_rsd: 0 }),
    )
    expect(p).toBeNull()
  })

  it('name matching works when partner_id is missing', () => {
    const p = scorePair(
      row({ id: 'A', direction: 'in', partner_name: 'Primer d.o.o. Beograd' }),
      row({ id: 'B', direction: 'out', partner_name: 'PRIMER DOO BEOGRAD' }),
    )
    expect(p).not.toBeNull()
    expect(p!.reasons).toContain('same partner name')
  })
})

describe('proposePairs - 1:1 assignment', () => {
  it('one IN cannot cover two OUTs', () => {
    const rows = [
      row({ id: 'IN1', direction: 'in', partner_id: 'P1' }),
      row({ id: 'OUT1', direction: 'out', partner_id: 'P1' }),
      row({ id: 'OUT2', direction: 'out', partner_id: 'P1' }),
    ]
    const proposals = proposePairs(rows)
    expect(proposals).toHaveLength(1)
    const usedOut = proposals[0].outRow.id
    expect(['OUT1', 'OUT2']).toContain(usedOut)
  })

  it('picks the stronger pair when there is a choice', () => {
    const rows = [
      row({ id: 'IN1', direction: 'in', partner_id: 'P1', transaction_date: '2026-08-10' }),
      // weaker: wider gap
      row({ id: 'OUT_DALEKO', direction: 'out', partner_id: 'P1', transaction_date: '2026-08-28' }),
      // stronger: same day
      row({ id: 'OUT_BLIZU', direction: 'out', partner_id: 'P1', transaction_date: '2026-08-10' }),
    ]
    const proposals = proposePairs(rows)
    expect(proposals).toHaveLength(1)
    expect(proposals[0].outRow.id).toBe('OUT_BLIZU')
  })

  it('no proposals when there are no candidates', () => {
    expect(proposePairs([])).toEqual([])
    expect(proposePairs([row({ id: 'A', direction: 'in' })])).toEqual([])
  })

  it('compares the RSD book figures, whatever the EUR beside them says', () => {
    // A EUR transfer in and out on different days: the same 1,000 EUR books
    // at two rates. The legs are matched on amount_rsd, the book currency,
    // so toggling the page to EUR can never change which pairs are proposed.
    const p = scorePair(
      row({ id: 'A', direction: 'in', partner_id: 'P1', amount_rsd: 117200, amount_eur: 1000 }),
      row({ id: 'B', direction: 'out', partner_id: 'P1', amount_rsd: 117200, amount_eur: 999.9 }),
    )
    expect(p!.reasons).toContain('exact amount')
    expect(p!.amountDiffRsd).toBe(0)
  })

  it('summarize counts by confidence', () => {
    const rows = [
      row({ id: 'IN1', direction: 'in', partner_id: 'P1' }),
      row({ id: 'OUT1', direction: 'out', partner_id: 'P1' }),
    ]
    const s = summarize(proposePairs(rows))
    expect(s.total).toBe(1)
    expect(s.high).toBe(1)
  })
})
