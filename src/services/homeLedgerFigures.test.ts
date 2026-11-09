import {
  homeLedgerFigures, principalHeadingOf, type PlRow, type PrincipalHeading,
} from './homeLedgerFigures'
import { REVENUE_STREAM } from './revenueStreams'

// Invented companies and figures. Company A keeps its loan principal under
// "Finansiranje › Glavnica", company B under "Krediti › Otplata"; interest sits
// beside the principal in the same category, which is exactly the case a rule
// written by category alone would get wrong.

const A = 'comp-a'
const B = 'comp-b'

const PRINCIPAL_A: PrincipalHeading = { pl_category: 'Finansiranje', pl_subcategory: 'Glavnica' }
const PRINCIPAL_B: PrincipalHeading = { pl_category: 'Krediti', pl_subcategory: 'Otplata' }

const row = (o: Partial<PlRow>): PlRow => ({
  company_id: A, tx_type: 'revenue', amount_rsd: 0, amount_eur: 0,
  pl_date: '2026-03-10', pl_category: null, pl_subcategory: null, revenue_stream: null,
  ...o,
})

const MONTHS = ['2026-03', '2026-04']

const figures = (rows: PlRow[], principalByCompany: Record<string, PrincipalHeading | null> = { [A]: PRINCIPAL_A }) =>
  homeLedgerFigures(rows, { months: MONTHS, currency: 'RSD', principalByCompany })

describe('loans are not revenue', () => {
  it('leaves a drawdown booked under Krediti out of revenue and reports it', () => {
    const f = figures([
      row({ amount_rsd: 500000, revenue_stream: REVENUE_STREAM.construction }),
      row({ amount_rsd: 2000000, revenue_stream: REVENUE_STREAM.loans }),
    ])
    expect(f.revenue).toBe(500000)
    expect(f.loansDrawn).toBe(2000000)
    expect(f.months[0].revenue).toBe(500000)
  })

  it('keeps every other stream, and revenue with no stream, as revenue', () => {
    const f = figures([
      row({ amount_rsd: 100, revenue_stream: REVENUE_STREAM.rental }),
      row({ amount_rsd: 20, revenue_stream: REVENUE_STREAM.vatRefund }),
      row({ amount_rsd: 3, revenue_stream: REVENUE_STREAM.interest }),
      row({ amount_rsd: 4, revenue_stream: null }),
    ])
    expect(f.revenue).toBe(127)
    expect(f.loansDrawn).toBe(0)
  })
})

describe('principal is not cost, interest is', () => {
  it('takes the mapped principal heading out of expenses and keeps interest beside it', () => {
    const f = figures([
      row({ tx_type: 'expense', amount_rsd: 300000, pl_category: 'Finansiranje', pl_subcategory: 'Glavnica' }),
      row({ tx_type: 'expense', amount_rsd: 40000, pl_category: 'Finansiranje', pl_subcategory: 'Kamata' }),
      row({ tx_type: 'expense', amount_rsd: 60000, pl_category: 'Materijal', pl_subcategory: 'Beton' }),
    ])
    expect(f.expenses).toBe(100000)
    expect(f.principalRepaid).toBe(300000)
    expect(f.expenseByCategory).toEqual([
      { label: 'Materijal', value: 60000 },
      { label: 'Finansiranje', value: 40000 },
    ])
  })

  it('does not take the subcategory alone: the same word under another category stays a cost', () => {
    const f = figures([
      row({ tx_type: 'expense', amount_rsd: 700, pl_category: 'Zakup', pl_subcategory: 'Glavnica' }),
    ])
    expect(f.expenses).toBe(700)
    expect(f.principalRepaid).toBe(0)
  })

  it('matches the category alone when the mapping names no subcategory', () => {
    const f = figures([
      row({ tx_type: 'expense', amount_rsd: 900, pl_category: 'Finansiranje', pl_subcategory: 'Bilo koja' }),
    ], { [A]: { pl_category: 'Finansiranje', pl_subcategory: null } })
    expect(f.principalRepaid).toBe(900)
    expect(f.expenses).toBe(0)
  })

  it('reads each company by its own mapping', () => {
    const f = figures([
      row({ company_id: A, tx_type: 'expense', amount_rsd: 10, pl_category: 'Finansiranje', pl_subcategory: 'Glavnica' }),
      row({ company_id: B, tx_type: 'expense', amount_rsd: 20, pl_category: 'Krediti', pl_subcategory: 'Otplata' }),
      // Company B's row under company A's heading is an ordinary cost for B.
      row({ company_id: B, tx_type: 'expense', amount_rsd: 5, pl_category: 'Finansiranje', pl_subcategory: 'Glavnica' }),
    ], { [A]: PRINCIPAL_A, [B]: PRINCIPAL_B })
    expect(f.principalRepaid).toBe(30)
    expect(f.expenses).toBe(5)
  })

  it('names a company with no mapping and leaves its expenses whole rather than guessing', () => {
    const f = figures([
      row({ company_id: B, tx_type: 'expense', amount_rsd: 800, pl_category: 'Krediti', pl_subcategory: 'Otplata' }),
    ], { [A]: PRINCIPAL_A, [B]: null })
    expect(f.expenses).toBe(800)
    expect(f.principalRepaid).toBe(0)
    expect(f.unmappedCompanies).toEqual([B])
  })

  it('treats a company the mapping does not mention as unmapped', () => {
    const f = figures([
      row({ company_id: B, tx_type: 'expense', amount_rsd: 15, pl_category: 'Krediti', pl_subcategory: 'Otplata' }),
    ], { [A]: PRINCIPAL_A })
    expect(f.expenses).toBe(15)
    expect(f.unmappedCompanies).toEqual([B])
  })
})

describe('net profit and the months', () => {
  it('is corrected revenue less corrected expenses, in total and per month', () => {
    const f = figures([
      row({ pl_date: '2026-03-05', amount_rsd: 1000, revenue_stream: REVENUE_STREAM.construction }),
      row({ pl_date: '2026-03-06', amount_rsd: 5000, revenue_stream: REVENUE_STREAM.loans }),
      row({ pl_date: '2026-04-07', tx_type: 'expense', amount_rsd: 300, pl_category: 'Materijal' }),
      row({ pl_date: '2026-04-08', tx_type: 'expense', amount_rsd: 2000, pl_category: 'Finansiranje', pl_subcategory: 'Glavnica' }),
      row({ pl_date: '2026-04-09', tx_type: 'expense', amount_rsd: 50, pl_category: 'Finansiranje', pl_subcategory: 'Kamata' }),
    ])
    expect(f.net).toBe(650)
    expect(f.months).toEqual([
      { month: '2026-03', revenue: 1000, expenses: 0, net: 1000 },
      { month: '2026-04', revenue: 0, expenses: 350, net: -350 },
    ])
  })

  it('has every month of the window, even an empty one', () => {
    expect(figures([]).months.map(m => m.month)).toEqual(MONTHS)
  })

  it('reads the display currency column, and a row without it counts as zero', () => {
    const f = homeLedgerFigures([
      row({ amount_rsd: 117000, amount_eur: 1000, revenue_stream: REVENUE_STREAM.construction }),
      row({ amount_rsd: 5000, amount_eur: null, revenue_stream: REVENUE_STREAM.construction }),
    ], { months: MONTHS, currency: 'EUR', principalByCompany: { [A]: PRINCIPAL_A } })
    expect(f.revenue).toBe(1000)
  })

  it('accepts numeric amounts that arrive as text', () => {
    const f = figures([row({ amount_rsd: '1234.5' as any, revenue_stream: REVENUE_STREAM.rental })])
    expect(f.revenue).toBe(1234.5)
  })
})

describe('the principal heading of a mapping', () => {
  it('is the category and subcategory of the credit_principal role', () => {
    expect(principalHeadingOf({
      credit_principal: {
        pl_category: ' Finansiranje ', pl_subcategory: 'Glavnica', department: 'Uprava',
      },
    })).toEqual({ pl_category: 'Finansiranje', pl_subcategory: 'Glavnica' })
  })

  it('is null when the role has no category', () => {
    expect(principalHeadingOf({})).toBeNull()
    expect(principalHeadingOf(null)).toBeNull()
    expect(principalHeadingOf({
      credit_principal: {
        pl_category: '  ', pl_subcategory: 'Glavnica', department: null,
      },
    })).toBeNull()
  })

  it('carries no subcategory when the mapping has none', () => {
    expect(principalHeadingOf({
      credit_principal: {
        pl_category: 'Finansiranje', pl_subcategory: '', department: null,
      },
    })).toEqual({ pl_category: 'Finansiranje', pl_subcategory: null })
  })
})

describe('principal and interest told apart', () => {
  const opts = (principal: PrincipalHeading | null, interest: PrincipalHeading | null) => ({
    months: MONTHS, currency: 'RSD' as const,
    principalByCompany: { [A]: principal }, interestByCompany: { [A]: interest },
  })
  const rows = [
    row({ tx_type: 'expense', amount_rsd: 300, pl_category: 'Finansiranje', pl_subcategory: 'Glavnica' }),
    row({ tx_type: 'expense', amount_rsd: 40, pl_category: 'Finansiranje', pl_subcategory: 'Kamata' }),
  ]

  it('never takes a row under the interest heading as principal', () => {
    const f = homeLedgerFigures(rows, opts(PRINCIPAL_A, { pl_category: 'Finansiranje', pl_subcategory: 'Kamata' }))
    expect(f.principalRepaid).toBe(300)
    expect(f.expenses).toBe(40)
    expect(f.ambiguousCompanies).toEqual([])
  })

  it('treats a company as unmapped when principal has no subcategory and interest is in the same category', () => {
    const f = homeLedgerFigures(rows, opts(
      { pl_category: 'Finansiranje', pl_subcategory: null },
      { pl_category: 'Finansiranje', pl_subcategory: 'Kamata' }))
    expect(f.principalRepaid).toBe(0)
    expect(f.expenses).toBe(340)
    expect(f.ambiguousCompanies).toEqual([A])
    expect(f.unmappedCompanies).toEqual([])
  })

  it('treats identical principal and interest headings as unmapped too', () => {
    const f = homeLedgerFigures(rows, opts(PRINCIPAL_A, PRINCIPAL_A))
    expect(f.principalRepaid).toBe(0)
    expect(f.ambiguousCompanies).toEqual([A])
  })

  it('treats interest mapped to the whole principal category as unmapped', () => {
    const f = homeLedgerFigures(rows, opts(PRINCIPAL_A, { pl_category: 'Finansiranje', pl_subcategory: null }))
    expect(f.principalRepaid).toBe(0)
    expect(f.ambiguousCompanies).toEqual([A])
  })

  it('keeps a category-only principal heading when interest is elsewhere', () => {
    const f = homeLedgerFigures(rows, opts(
      { pl_category: 'Finansiranje', pl_subcategory: null },
      { pl_category: 'Kamate', pl_subcategory: 'Bankarske' }))
    expect(f.principalRepaid).toBe(340)
    expect(f.ambiguousCompanies).toEqual([])
  })
})
