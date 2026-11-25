import {
  rankInstalments, proposeInstalment, differenceSentence, linkToInstalment, loadInstalmentCandidates,
  convert, differs, MATCH_TOLERANCE, matchTolerance, rememberedCreditNames, rememberedSentence,
  type InstalmentCandidate, type InvoiceFacts, type DayRates,
} from './creditInterestLink'

// Invented banks, PIBs, rates and figures throughout.
const COMPANY = 'co-1'

const inst = (over: Partial<InstalmentCandidate>): InstalmentCandidate => ({
  installmentId: 'i-1', creditId: 'cr-1', companyId: COMPANY, creditName: 'Obrtni kredit',
  bank: 'Larkspur banka', creditStatus: 'active', kind: 'annuity', currency: 'EUR',
  lenderPib: null, installmentNo: 1, dueDate: '2026-10-31', interestAmount: 258, paidState: 'paid',
  ...over,
})

const invoice = (over: Partial<InvoiceFacts> = {}): InvoiceFacts => ({
  amount: 262.01, currency: 'EUR', companyId: COMPANY, dates: ['2026-10-31'], supplierPib: '900000017',
  rateDate: '2026-10-31',
  ...over,
})

const RATES: DayRates = { date: '2026-10-31', rsdPer: { RSD: 1, EUR: 117.2, USD: 108.5 } }

describe('ranking the instalments an interest invoice may be for', () => {
  it('leaves out another company, and keeps every currency', () => {
    const got = rankInstalments(invoice(), [
      inst({ installmentId: 'eur' }),
      inst({ installmentId: 'rsd', currency: 'RSD' }),
      inst({ installmentId: 'other', companyId: 'co-2' }),
    ], { rates: RATES })
    expect(got.map(r => r.installmentId).sort()).toEqual(['eur', 'rsd'])
  })

  it('leaves out closed credits unless asked for them', () => {
    const list = [inst({ installmentId: 'open' }), inst({ installmentId: 'closed', creditStatus: 'closed' })]
    expect(rankInstalments(invoice(), list).map(r => r.installmentId)).toEqual(['open'])
    expect(rankInstalments(invoice(), list, { includeClosed: true }).map(r => r.installmentId).sort())
      .toEqual(['closed', 'open'])
  })

  it('puts a matching interest first, even when its date is farther away', () => {
    const got = rankInstalments(invoice({ dates: ['2026-10-31'] }), [
      inst({ installmentId: 'near', interestAmount: 258, dueDate: '2026-10-31' }),
      inst({ installmentId: 'exact', interestAmount: 262.01, dueDate: '2026-07-31' }),
    ])
    expect(got.map(r => r.installmentId)).toEqual(['exact', 'near'])
    expect(got[0].matches).toBe(true)
    expect(got[1].matches).toBe(false)
  })

  it('counts a miss of up to one cent as a match, and no more', () => {
    expect(rankInstalments(invoice({ amount: 262.01 }), [inst({ interestAmount: 262.00 })])[0].matches).toBe(true)
    expect(rankInstalments(invoice({ amount: 262.01 }), [inst({ interestAmount: 262.02 })])[0].matches).toBe(true)
    expect(rankInstalments(invoice({ amount: 262.01 }), [inst({ interestAmount: 261.99 })])[0].matches).toBe(false)
    expect(MATCH_TOLERANCE).toBe(0.01)
  })

  it('then weighs a 1% amount miss lighter than a month', () => {
    const got = rankInstalments(invoice({ amount: 100, dates: ['2026-10-31'] }), [
      inst({ installmentId: 'month-off', interestAmount: 100.5, dueDate: '2026-09-30' }),
      inst({ installmentId: 'one-percent', interestAmount: 101, dueDate: '2026-10-31' }),
    ])
    expect(got.map(r => r.installmentId)).toEqual(['one-percent', 'month-off'])
  })

  it('measures the days to the nearest of the invoice dates', () => {
    const [r] = rankInstalments(invoice({ dates: [null, '2026-11-20', '2026-10-30'] }), [inst({ dueDate: '2026-10-31' })])
    expect(r.days).toBe(1)
    expect(rankInstalments(invoice({ dates: [null] }), [inst({})])[0].days).toBeNull()
  })

  it('says the difference as invoice minus interest, to the cent', () => {
    const [r] = rankInstalments(invoice({ amount: 262.01 }), [inst({ interestAmount: 258 })])
    expect(r.difference).toBe(4.01)
    expect(r.converted).toBeNull()
    expect(r.rateMissing).toBe(false)
    const [s] = rankInstalments(invoice({ amount: 255 }), [inst({ interestAmount: 258 })])
    expect(s.difference).toBe(-3)
  })

  it('calls nothing a match when the invoice names no amount', () => {
    const [r] = rankInstalments(invoice({ amount: null }), [inst({ interestAmount: 0 })])
    expect(r.matches).toBe(false)
  })
})

describe('across currencies', () => {
  const dinars = (amount: number) => invoice({ amount, currency: 'RSD' })

  it('converts the invoice into the credit currency at the day rate, and matches to the cent', () => {
    // 262,01 EUR at 117,2 is 30.707,572 RSD; the bank bills 30.707,57.
    const [r] = rankInstalments(dinars(30707.57), [inst({ interestAmount: 262.01 })], { rates: RATES })
    expect(r.converted).toEqual({ amount: 262.01, rate: 117.2, date: '2026-10-31' })
    expect(r.difference).toBe(0)
    expect(r.matches).toBe(true)
  })

  it('compares a dinar credit with a euro invoice the other way round', () => {
    const [r] = rankInstalments(invoice({ amount: 100 }), [inst({ currency: 'RSD', interestAmount: 11720 })], { rates: RATES })
    expect(r.converted?.amount).toBe(11720)
    expect(r.matches).toBe(true)
  })

  it('converts through dinars between two foreign currencies', () => {
    expect(convert(100, 'USD', 'EUR', RATES)).toEqual({ amount: 92.58, rate: 117.2 / 108.5, date: '2026-10-31' })
  })

  it('without a rate, lists the instalment by its date alone and never calls it a match', () => {
    const got = rankInstalments(dinars(30707.57), [
      inst({ installmentId: 'eur-exact', interestAmount: 262.01, dueDate: '2026-07-31' }),
      inst({ installmentId: 'rsd-near', currency: 'RSD', interestAmount: 99, dueDate: '2026-10-31' }),
    ])
    const eur = got.find(r => r.installmentId === 'eur-exact')!
    expect(eur.rateMissing).toBe(true)
    expect(eur.matches).toBe(false)
    expect(Number.isNaN(eur.difference)).toBe(true)
    expect(differs(30707.57, eur)).toBe(true)
  })

  it('has no rate for a currency NBS was not asked about', () => {
    expect(convert(100, 'CHF', 'EUR', RATES)).toBeNull()
    expect(convert(100, 'RSD', 'EUR', null)).toBeNull()
  })
})

describe('the sentence that says the difference', () => {
  it('names the three figures in one currency', () => {
    expect(differenceSentence({ amount: 262.01, currency: 'EUR' }, inst({ interestAmount: 258 }) as any))
      .toBe('faktura 262,01 EUR, kamata rate 258,00 EUR, razlika 4,01 EUR')
    expect(differenceSentence({ amount: 255, currency: 'EUR' }, inst({ interestAmount: 258 }) as any))
      .toBe('faktura 255,00 EUR, kamata rate 258,00 EUR, razlika -3,00 EUR')
  })

  it('says when there is none, and groups thousands', () => {
    expect(differenceSentence({ amount: 262.01, currency: 'EUR' }, inst({ interestAmount: 262.01 }) as any))
      .toBe('faktura 262,01 EUR, kamata rate 262,01 EUR, bez razlike')
    expect(differenceSentence({ amount: 1262.01, currency: 'EUR' }, inst({ interestAmount: 1258 }) as any))
      .toBe('faktura 1.262,01 EUR, kamata rate 1.258,00 EUR, razlika 4,01 EUR')
  })

  it('says the converted amount, the rate and its day across currencies', () => {
    const [r] = rankInstalments(invoice({ amount: 56130, currency: 'RSD' }), [inst({ interestAmount: 478.94 })], { rates: RATES })
    expect(differenceSentence({ amount: 56130, currency: 'RSD' }, r, '2026-10-31'))
      .toBe('faktura 56.130,00 RSD ≈ 478,92 EUR po srednjem kursu NBS za 31.10.2026. (1 EUR = 117,2000 RSD), kamata rate 478,94 EUR, razlika -0,02 EUR (u okviru tolerancije preračuna od 2,39 EUR)')
  })

  it('says the rate is missing rather than a difference it cannot know', () => {
    const [r] = rankInstalments(invoice({ amount: 56130, currency: 'RSD' }), [inst({ interestAmount: 478.94 })])
    expect(differenceSentence({ amount: 56130, currency: 'RSD' }, r, '2026-10-31'))
      .toBe('faktura 56.130,00 RSD, kamata rate 478,94 EUR; kurs NBS za 31.10.2026. nije dostupan, pa razlika nije izračunata')
  })
})

describe('the proposal from a remembered PIB', () => {
  const remembered = (over: Partial<InstalmentCandidate>) => inst({ lenderPib: '900000017', ...over })

  it('proposes nothing when no credit remembers the PIB, or the invoice has none', () => {
    expect(proposeInstalment(invoice(), [inst({ interestAmount: 262.01 })])).toBeNull()
    expect(proposeInstalment(invoice(), [remembered({ lenderPib: '900000099' })])).toBeNull()
    expect(proposeInstalment(invoice({ supplierPib: null }), [remembered({ interestAmount: 262.01 })])).toBeNull()
  })

  it('proposes nothing from a closed credit, or for another company', () => {
    expect(proposeInstalment(invoice(), [remembered({ creditStatus: 'closed', interestAmount: 262.01 })])).toBeNull()
    expect(proposeInstalment(invoice(), [remembered({ companyId: 'co-2', interestAmount: 262.01 })])).toBeNull()
  })

  it('proposes the best instalment of the credit that remembers the PIB, read by its digits', () => {
    const got = proposeInstalment(invoice({ supplierPib: 'RS 900-000-017' }), [
      inst({ installmentId: 'other-bank', interestAmount: 262.01 }),
      remembered({ installmentId: 'near', interestAmount: 250 }),
      remembered({ installmentId: 'exact', interestAmount: 262.01, dueDate: '2026-11-30' }),
    ])
    expect(got?.installmentId).toBe('exact')
  })

  /**
   * A remembered PIB is not proof the bill is interest: the same bank sends
   * fee invoices. Proposed as a link, a fee would leave P&L, so a link is
   * proposed only when an instalment's interest IS the amount.
   */
  it('proposes nothing when no instalment is within a cent of the amount', () => {
    expect(proposeInstalment(invoice({ amount: 262.01 }), [
      remembered({ installmentId: 'near', interestAmount: 261.99 }),
      remembered({ installmentId: 'far', interestAmount: 150 }),
    ])).toBeNull()
  })

  it('across currencies, proposes only with the rate in hand', () => {
    const dinars = invoice({ amount: 30707.57, currency: 'RSD' })
    expect(proposeInstalment(dinars, [remembered({ interestAmount: 262.01 })])).toBeNull()
    expect(proposeInstalment(dinars, [remembered({ interestAmount: 262.01 })], RATES)?.installmentId).toBe('i-1')
  })
})

describe('linking', () => {
  it('sends the row and the instalment to the function', async () => {
    const rpc = jest.fn().mockResolvedValue({ data: null, error: null })
    await linkToInstalment({ rpc } as any, 'row-1', 'inst-1')
    expect(rpc).toHaveBeenCalledWith('sef_inbox_link_installment', { p_id: 'row-1', p_installment_id: 'inst-1' })
  })

  it('throws the function\'s own sentence', async () => {
    const said = 'Faktura je upućena drugoj firmi, a ne onoj čiji je kredit. Ništa nije povezano.'
    const rpc = jest.fn().mockResolvedValue({ data: null, error: { message: said } })
    await expect(linkToInstalment({ rpc } as any, 'row-1', 'inst-1')).rejects.toThrow(said)
  })
})

describe('reading the candidates', () => {
  const client = (credits: any[], installments: any[]) => ({
    from: (table: string) => {
      const rows = table === 'credits' ? credits : installments
      const q: any = { select: () => q, order: () => q, range: () => Promise.resolve({ data: rows, error: null }) }
      return q
    },
  })

  it('joins each instalment to its credit, with the money as numbers and where it stands', async () => {
    const got = await loadInstalmentCandidates(client(
      [{ id: 'cr-1', company_id: COMPANY, name: 'Obrtni kredit', bank: 'Larkspur banka', currency: 'EUR', status: 'active', kind: 'revolving', lender_pib: '900000017' }],
      [
        { id: 'i-1', credit_id: 'cr-1', installment_no: 3, due_date: '2026-10-31', interest_amount: '262.01', status: 'outstanding', paid_amount: '100.00' },
        { id: 'i-2', credit_id: 'cr-1', installment_no: 4, due_date: '2026-11-30', interest_amount: 1, status: 'paid', paid_amount: 0 },
        { id: 'i-3', credit_id: 'cr-1', installment_no: 5, due_date: '2026-12-31', interest_amount: 1, status: 'outstanding', paid_amount: null },
        { id: 'i-9', credit_id: 'cr-gone', installment_no: 1, due_date: '2026-10-31', interest_amount: 1, status: 'outstanding', paid_amount: null },
      ]) as any)
    expect(got.map(g => [g.installmentId, g.paidState])).toEqual([['i-1', 'partial'], ['i-2', 'paid'], ['i-3', 'unpaid']])
    expect(got[0]).toEqual({
      installmentId: 'i-1', creditId: 'cr-1', companyId: COMPANY, creditName: 'Obrtni kredit',
      bank: 'Larkspur banka', creditStatus: 'active', kind: 'revolving', currency: 'EUR',
      lenderPib: '900000017', installmentNo: 3, dueDate: '2026-10-31', interestAmount: 262.01, paidState: 'partial',
    })
  })
})

describe('the tolerance across currencies (fix round 1)', () => {
  const dinars = (amount: number) => invoice({ amount, currency: 'RSD' })

  it('is 0,5 % of the interest, never less than a cent, and only across currencies', () => {
    expect(matchTolerance(true, 262.01)).toBe(1.31)
    expect(matchTolerance(true, 1)).toBe(0.01)
    expect(matchTolerance(false, 262.01)).toBe(0.01)
  })

  it('counts a 0,07 EUR miss after conversion as a match, and says it is within the tolerance', () => {
    // 30.715,78 RSD at 117,2 is 262,08 EUR; the interest is 262,01 EUR.
    const [r] = rankInstalments(dinars(30715.78), [inst({ interestAmount: 262.01 })], { rates: RATES })
    expect(r.difference).toBe(0.07)
    expect(r.matches).toBe(true)
    expect(differs(30715.78, r)).toBe(true)
    expect(differenceSentence({ amount: 30715.78, currency: 'RSD' }, r, '2026-10-31'))
      .toBe('faktura 30.715,78 RSD ≈ 262,08 EUR po srednjem kursu NBS za 31.10.2026. (1 EUR = 117,2000 RSD), '
        + 'kamata rate 262,01 EUR, razlika 0,07 EUR (u okviru tolerancije preračuna od 1,31 EUR)')
  })

  it('proposes that instalment from a remembered PIB', () => {
    expect(proposeInstalment(dinars(30715.78), [inst({ lenderPib: '900000017', interestAmount: 262.01 })], RATES)?.installmentId)
      .toBe('i-1')
  })

  it('does not match a fee invoice from the same bank', () => {
    const fee = dinars(1500)
    const [r] = rankInstalments(fee, [inst({ interestAmount: 262.01 })], { rates: RATES })
    expect(r.matches).toBe(false)
    expect(differenceSentence({ amount: 1500, currency: 'RSD' }, r, '2026-10-31')).not.toMatch(/tolerancije/)
    expect(proposeInstalment(fee, [inst({ lenderPib: '900000017', interestAmount: 262.01 })], RATES)).toBeNull()
  })

  it('keeps the one-cent rule within one currency', () => {
    expect(rankInstalments(invoice({ amount: 262.08 }), [inst({ interestAmount: 262.01 })])[0].matches).toBe(false)
  })
})

describe('a remembered PIB with no match', () => {
  it('names the credits that remember it, once each, active only', () => {
    const r = (over: Partial<InstalmentCandidate>) => inst({ lenderPib: '900000017', ...over })
    expect(rememberedCreditNames(invoice(), [
      r({ installmentId: 'a' }), r({ installmentId: 'b' }),
      r({ installmentId: 'c', creditName: 'Zatvoren', creditStatus: 'closed' }),
      inst({ installmentId: 'd', creditName: 'Drugi' }),
    ])).toEqual(['Obrtni kredit'])
  })

  it('says to link it if it is interest', () => {
    expect(rememberedSentence(['Obrtni kredit'])).toBe(
      'PIB ovog dobavljača je zapamćen na kreditu „Obrtni kredit“, ali kamata nijedne rate se ne poklapa sa iznosom. '
      + 'Ako je ovo kamata, povežite je sa ratom; ako je provizija ili druga usluga banke, proknjižite je.')
    expect(rememberedSentence(['A', 'B'])).toMatch(/^PIB ovog dobavljača je zapamćen na kreditima „A“, „B“, /)
  })
})
