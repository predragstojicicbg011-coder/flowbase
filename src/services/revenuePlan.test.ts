import {
  addDays, cashInflowsFromPlan, inflowsByMonth, lastOfMonth, leaseMonthRent, planBookFigures,
  planBookFiguresAtRates, plannedRevenueByMonth, rentForecast, rentInvoicesDue,
  type PlanInvoice, type RentalLease, type RevenuePlanRow,
} from './revenuePlan'

jest.mock('./currencyService', () => {
  const actual = jest.requireActual('./currencyService')
  return {
    ...actual,
    getRatesForDate: async (date: string) => ({ date, eurRsdRate: 117.2, usdRsdRate: 100, source: 'test' }),
  }
})

const lease = (over: Partial<RentalLease> = {}): RentalLease => ({
  id: 'l1', project_id: 'r1', tenant_partner_id: 't1', monthly_rent: 1000, currency: 'EUR',
  start_date: '2026-01-01', end_date: null, invoice_day: 5, payment_days: 15, active: true, ...over,
})

const planRow = (over: Partial<RevenuePlanRow> = {}): RevenuePlanRow => ({
  project_id: 'c1', month: '2026-11-01', amount: 1000000, currency: 'RSD', amount_rsd: 1000000, amount_eur: 8532.42, ...over,
})

const rentInvoice = (month: string, over: Partial<PlanInvoice> = {}): PlanInvoice => ({
  project_id: 'r1', type: 'revenue', invoice_date: `${month}-05`, amount_rsd: 117200, amount_eur: 1000,
  lease_id: 'l1', service_month: `${month}-01`, ...over,
})

describe('dates', () => {
  it('knows month ends, leap years and day arithmetic', () => {
    expect(lastOfMonth('2026-02')).toBe('2026-02-28')
    expect(lastOfMonth('2028-02-01')).toBe('2028-02-29')
    expect(addDays('2026-11-30', 45)).toBe('2027-01-14')
  })
})

describe('leaseMonthRent', () => {
  it('is the full rent for a month covered in full', () => {
    expect(leaseMonthRent(lease(), '2026-10')).toBe(1000)
  })

  it('prorates a month covered in part by calendar days', () => {
    expect(leaseMonthRent(lease({ start_date: '2026-11-16' }), '2026-11')).toBe(500)
    expect(leaseMonthRent(lease({ end_date: '2026-10-10' }), '2026-10')).toBe(322.58)
  })

  it('is nothing outside the lease or for an inactive one', () => {
    expect(leaseMonthRent(lease({ start_date: '2026-12-01' }), '2026-11')).toBe(0)
    expect(leaseMonthRent(lease({ end_date: '2026-09-30' }), '2026-10')).toBe(0)
    expect(leaseMonthRent(lease({ active: false }), '2026-10')).toBe(0)
  })
})

describe('rentInvoicesDue', () => {
  it('proposes one rent invoice per lease with none yet for the month', () => {
    const due = rentInvoicesDue([lease(), lease({ id: 'l2', tenant_partner_id: 't2', currency: 'RSD', monthly_rent: 60000 })],
      '2026-10', [rentInvoice('2026-10')])
    expect(due).toEqual([{
      lease_id: 'l2', project_id: 'r1', partner_id: 't2', type: 'revenue', revenue_stream: 'Zakup',
      service_month: '2026-10-01', invoice_date: '2026-10-05', due_date: '2026-10-20', amount: 60000, currency: 'RSD',
    }])
  })

  it('proposes again a month whose rent invoice was deleted', () => {
    expect(rentInvoicesDue([lease()], '2026-10', [rentInvoice('2026-10', { deleted_at: '2026-10-06' })])).toHaveLength(1)
  })

  it('skips leases that earn nothing in the month', () => {
    expect(rentInvoicesDue([lease({ active: false }), lease({ end_date: '2026-09-30' })], '2026-10', [])).toEqual([])
  })
})

describe('rentForecast', () => {
  it('runs to the end of each lease, skipping months already invoiced', () => {
    const lines = rentForecast([lease({ end_date: '2026-12-15' })], ['2026-10', '2026-11', '2026-12', '2027-01'], [rentInvoice('2026-10')])
    expect(lines.map(l => [l.month, l.amount])).toEqual([['2026-11', 1000], ['2026-12', 483.87]])
    expect(lines[0]).toMatchObject({ invoice_date: '2026-11-05', payment_days: 15, currency: 'EUR' })
  })

  it('runs an open-ended lease through the horizon', () => {
    expect(rentForecast([lease()], ['2026-10', '2026-11', '2026-12'])).toHaveLength(3)
  })
})

describe('plannedRevenueByMonth', () => {
  const projects = [{ id: 'c1', payment_days: 60 }, { id: 'r1', payment_days: 45 }]
  const months = ['2026-10', '2026-11', '2026-12']

  it('takes plan rows in the display currency, with the project payment term', () => {
    const r = plannedRevenueByMonth(projects, [planRow()], [], months, { currency: 'RSD' })
    expect(r.lines).toEqual([{ project_id: 'c1', month: '2026-11', amount: 1000000, source: 'plan', billing_date: '2026-11-30', payment_days: 60 }])
    expect(r.byMonth).toEqual({ '2026-10': 0, '2026-11': 1000000, '2026-12': 0 })
    expect(r.byProjectMonth).toEqual({ c1: { '2026-11': 1000000 } })
  })

  it('deducts what the project already billed in the month from its plan', () => {
    const billed: PlanInvoice[] = [
      { project_id: 'c1', type: 'revenue', invoice_date: '2026-11-20', amount_rsd: 400000, amount_eur: 3412.97 },
      { project_id: 'c1', type: 'expense', invoice_date: '2026-11-20', amount_rsd: 900000, amount_eur: 1 },
      { project_id: 'c1', type: 'revenue', invoice_date: '2026-11-21', amount_rsd: 900000, amount_eur: 1, deleted_at: 'x' },
    ]
    const r = plannedRevenueByMonth(projects, [planRow()], [], months, { currency: 'RSD', invoices: billed })
    expect(r.byMonth['2026-11']).toBe(600000)
    const over = plannedRevenueByMonth(projects, [planRow()], [], months, {
      currency: 'RSD', invoices: [{ ...billed[0], amount_rsd: 1500000 }],
    })
    expect(over.lines).toEqual([])
  })

  it('forecasts rent, converting the other currency at the rate given', () => {
    const r = plannedRevenueByMonth(projects, [], [lease()], months, { currency: 'RSD', eurRate: 117.2 })
    expect(r.byMonth).toEqual({ '2026-10': 117200, '2026-11': 117200, '2026-12': 117200 })
    expect(r.lines[0]).toMatchObject({ source: 'rent', lease_id: 'l1', billing_date: '2026-10-05', payment_days: 15 })
  })

  it('leaves rent out, and says so, when no rate is given for it', () => {
    const r = plannedRevenueByMonth(projects, [], [lease()], months, { currency: 'RSD' })
    expect(r.lines).toEqual([])
    expect(r.notes[0]).toMatch(/3 meseca zakupa u drugoj valuti nisu uračunata/)
  })

  it('never counts a rental month twice: an invoice drops the lease-month, a plan row replaces the rent', () => {
    const r = plannedRevenueByMonth(projects,
      [planRow({ project_id: 'r1', month: '2026-12-01', amount: 500, currency: 'EUR', amount_rsd: 58600, amount_eur: 500 })],
      [lease()], months,
      { currency: 'EUR', invoices: [rentInvoice('2026-10')] })
    expect(r.byMonth).toEqual({ '2026-10': 0, '2026-11': 1000, '2026-12': 500 })
    expect(r.lines.map(l => l.source)).toEqual(['plan', 'rent'])
  })

  it('reports plan rows with no figure in the display currency', () => {
    const r = plannedRevenueByMonth(projects, [planRow({ amount_eur: null })], [], months, { currency: 'EUR' })
    expect(r.lines).toEqual([])
    expect(r.notes[0]).toMatch(/1 stavka plana nema iznos u/)
  })

  it('ignores months outside the horizon', () => {
    const r = plannedRevenueByMonth(projects, [planRow({ month: '2027-03-01' })], [], months, { currency: 'RSD' })
    expect(r.lines).toEqual([])
  })
})

describe('cashInflowsFromPlan', () => {
  it('dates each billing its payment term later, in date order', () => {
    const r = plannedRevenueByMonth([{ id: 'c1', payment_days: 45 }], [planRow({ month: '2026-10-01' })], [lease()],
      ['2026-10'], { currency: 'EUR', eurRate: 117.2 })
    const inflows = cashInflowsFromPlan(r.lines)
    expect(inflows).toEqual([
      { date: '2026-10-20', amount: 1000, project_id: 'r1', source: 'rent', lease_id: 'l1' },
      { date: '2026-12-15', amount: 8532.42, project_id: 'c1', source: 'plan' },
    ])
    expect(inflowsByMonth(inflows, ['2026-10', '2026-11', '2026-12'])).toEqual({ '2026-10': 1000, '2026-11': 0, '2026-12': 8532.42 })
  })
})

describe('planBookFigures', () => {
  it('books a plan amount at the rate of the day it is typed', async () => {
    expect(planBookFiguresAtRates(1000, 'EUR', { date: '2026-10-08', eurRate: 117.2, usdRate: 100 }))
      .toEqual({ eur_rate: 117.2, rate_date: '2026-10-08', amount_rsd: 117200, amount_eur: 1000 })
    await expect(planBookFigures(117200, 'RSD', '2026-10-08'))
      .resolves.toEqual({ eur_rate: 117.2, rate_date: '2026-10-08', amount_rsd: 117200, amount_eur: 1000 })
  })
})
