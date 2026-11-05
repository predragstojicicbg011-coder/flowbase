import { homeDebt, type HomeCredit, type HomeInstalment } from './homeDebt'

// Invented credits and banks. Display currency RSD; one euro is 117 dinars
// (a round stand-in for today's NBS rate); USD has no rate, so a dollar
// credit cannot be converted.

const TODAY = '2026-11-05'
const toShown = (amount: number, currency: string): number | null =>
  currency === 'RSD' ? amount : currency === 'EUR' ? amount * 117 : null

const credit = (o: Partial<HomeCredit>): HomeCredit => ({
  id: 'k1', company_id: 'comp-a', name: 'Kredit Banka Primer', kind: 'annuity', currency: 'RSD',
  principal_amount: 1200000, disbursement_date: '2026-01-15', maturity_date: null,
  rate_margin: null, status: 'active', ...o,
})

/** Twelve monthly instalments of 100.000 principal and 5.000 interest, Feb 2026 – Jan 2027. */
const schedule = (creditId: string, paidThrough: string): HomeInstalment[] =>
  Array.from({ length: 12 }, (_, i) => {
    const total = 2026 * 12 + 1 + i
    const due = `${Math.floor(total / 12)}-${String((total % 12) + 1).padStart(2, '0')}-15`
    return {
      credit_id: creditId, due_date: due, principal_amount: 100000, interest_amount: 5000,
      status: due <= paidThrough ? 'paid' : 'outstanding', paid_date: due <= paidThrough ? due : null,
    }
  })

const run = (o: {
  credits: HomeCredit[]; instalments?: HomeInstalment[]; months?: string[]
  companyId?: string | null; resets?: Record<string, { effective_from: string; reference_rate: number }[]>
}) => homeDebt({
  credits: o.credits, instalments: o.instalments || [], resets: o.resets || {},
  months: o.months || ['2026-01', '2026-02', '2026-03'], today: TODAY,
  companyId: o.companyId ?? null, toShown, currency: 'RSD',
})

describe('an annuity credit', () => {
  it('is drawn in the month it was disbursed and owed from then on', () => {
    const d = run({ credits: [credit({})], instalments: schedule('k1', '2026-02-15'), months: ['2025-12', '2026-01', '2026-02'] })
    expect(d.months.map(m => m.drawn)).toEqual([0, 1200000, 0])
    expect(d.months.map(m => m.balance)).toEqual([0, 1200000, 1100000])
    expect(d.drawn).toBe(1200000)
  })

  it('splits what fell due into principal and interest, and what of it was paid', () => {
    const d = run({ credits: [credit({})], instalments: schedule('k1', '2026-02-15') })
    expect(d.months[1]).toMatchObject({ principalDue: 100000, interestDue: 5000, principalPaid: 100000, interestPaid: 5000 })
    expect(d.months[2]).toMatchObject({ principalDue: 100000, interestDue: 5000, principalPaid: 0, interestPaid: 0 })
    expect(d.principalDue).toBe(200000)
    expect(d.interestDue).toBe(10000)
  })

  it('keeps an unpaid instalment in the balance after it falls due', () => {
    const d = run({ credits: [credit({})], instalments: schedule('k1', '2026-02-15') })
    // March fell due and was not paid: still owed at the end of March.
    expect(d.months[2].balance).toBe(1100000)
    expect(d.owedAtEnd).toBe(1100000)
  })

  it('reduces the balance in the month the money left, not the month it was due', () => {
    const late = schedule('k1', '2026-02-15').map(i =>
      i.due_date === '2026-02-15' ? { ...i, paid_date: '2026-03-02' } : i)
    const d = run({ credits: [credit({})], instalments: late })
    expect(d.months[1].balance).toBe(1200000)
    expect(d.months[2].balance).toBe(1100000)
  })

  it('measures the current month as of today, not as of its last day', () => {
    const ins = schedule('k1', '2026-10-15').map(i =>
      i.due_date === '2026-11-15' ? { ...i, status: 'paid', paid_date: '2026-11-20' } : i)
    const d = run({ credits: [credit({})], instalments: ins, months: ['2026-10', '2026-11'] })
    expect(d.months.map(m => m.balance)).toEqual([300000, 300000])
  })

  it('carries a credit with no schedule at its principal and says so', () => {
    const d = run({ credits: [credit({ name: 'Kredit bez plana' })] })
    expect(d.months[2].balance).toBe(1200000)
    expect(d.notes.join(' ')).toContain('Kredit bez plana nema unet plan otplate')
  })
})

describe('a revolving line', () => {
  const line = (o: Partial<HomeCredit> = {}) => credit({
    id: 'r1', name: 'Revolving Primer', kind: 'revolving', principal_amount: 600000,
    disbursement_date: '2026-01-10', maturity_date: '2026-03-10', rate_margin: 3, ...o,
  })
  const resets = { r1: [{ effective_from: '2025-12-01', reference_rate: 3 }] }

  it('owes its whole principal until maturity and nothing after', () => {
    const d = run({ credits: [line({ status: 'closed' })], resets, months: ['2026-01', '2026-02', '2026-03', '2026-04'] })
    expect(d.months.map(m => m.balance)).toEqual([600000, 600000, 0, 0])
  })

  it('has interest every month at the margin plus the benchmark, and the principal at maturity', () => {
    const d = run({ credits: [line({ status: 'closed' })], resets })
    // 600.000 at 6% a year is 3.000 a month.
    expect(d.months.map(m => m.interestDue)).toEqual([0, 3000, 3000])
    expect(d.months.map(m => m.principalDue)).toEqual([0, 0, 600000])
  })

  it('says when there is no rate, and still shows the principal at maturity', () => {
    const d = run({ credits: [line({ status: 'closed' })] })
    expect(d.months.map(m => m.interestDue)).toEqual([0, 0, 0])
    expect(d.months[2].principalDue).toBe(600000)
    expect(d.notes.join(' ')).toContain('Kamata za Revolving Primer nije u grafikonu')
  })

  it('carries a line with no maturity in every month, and says so', () => {
    const d = run({ credits: [line({ maturity_date: null })], resets })
    expect(d.months.map(m => m.balance)).toEqual([600000, 600000, 600000])
    expect(d.notes.join(' ')).toContain('Revolving Primer nema datum dospeća')
  })

  it('still owes a line past its maturity that is active, and says so', () => {
    const d = run({ credits: [line({ status: 'active' })], resets, months: ['2026-03', '2026-04'] })
    expect(d.months.map(m => m.balance)).toEqual([600000, 600000])
    expect(d.notes.join(' ')).toContain('Revolving Primer je prošao rok dospeća, a i dalje je aktivan')
  })

  it('stops owing once its principal instalment is paid', () => {
    const paid: HomeInstalment[] = [{
      credit_id: 'r1', due_date: '2026-03-10', principal_amount: 600000, interest_amount: 3000,
      status: 'paid', paid_date: '2026-03-10',
    }]
    const d = run({ credits: [line({ status: 'active' })], instalments: paid, resets, months: ['2026-03', '2026-04'] })
    expect(d.months.map(m => m.balance)).toEqual([0, 0])
    expect(d.months[0]).toMatchObject({ principalPaid: 600000, interestPaid: 3000 })
    expect(d.notes.join(' ')).not.toContain('rok dospeća')
  })
})

describe('currencies and companies', () => {
  it('converts a euro credit at the rate given, and says so', () => {
    const d = run({ credits: [credit({ currency: 'EUR', principal_amount: 10000 })] })
    expect(d.months[0].drawn).toBe(1170000)
    expect(d.notes.join(' ')).toContain('po današnjem kursu NBS')
  })

  it('leaves out a credit it cannot convert and names it', () => {
    const d = run({ credits: [credit({}), credit({ id: 'k2', name: 'Dolarski kredit', currency: 'USD' })] })
    expect(d.months[0].drawn).toBe(1200000)
    expect(d.notes.join(' ')).toContain('Dolarski kredit nije uračunat')
  })

  it('reads only the chosen company', () => {
    const d = run({
      credits: [credit({}), credit({ id: 'k2', company_id: 'comp-b', principal_amount: 999 })],
      companyId: 'comp-a',
    })
    expect(d.drawn).toBe(1200000)
  })

  it('reports an empty book as no book, not as zero debt', () => {
    const d = run({ credits: [] })
    expect(d.hasBook).toBe(false)
    expect(run({ credits: [credit({})] }).hasBook).toBe(true)
  })
})

describe('the window', () => {
  it('draws no month after the current one', () => {
    const d = run({ credits: [credit({})], months: ['2026-11', '2026-12'] })
    expect(d.months.map(m => m.month)).toEqual(['2026-11'])
  })
})
