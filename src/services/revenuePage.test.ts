import {
  OVERHEAD_FILTER, amountToInput, defaultPlanCurrency, invoiceCount, emptyLeaseDraft, filterRevenueInvoices,
  isDuplicateRentError, leaseDraftFromLease, leaseRow, monthLabel, monthsToYearEnd, nextMonths,
  planCellAction, planGrid, planUpsertRow, projectRevenueRows, provisionalRentNumber,
  rentInvoiceRow, revenueStatus, revenueTotals, srDateShort, validateLease, validateLeaseEnd,
  type RevenueListRow,
} from './revenuePage'
import { rentInvoicesDue, type RentalLease } from './revenuePlan'
import type { Project } from './projects'

const project = (o: Partial<Project> = {}): Project => ({
  id: 'p1', company_id: 'c1', name: 'Novi Beograd A1', code: 'NB-01', kind: 'construction',
  investor_partner_id: 'i1', contract_value: 1000000, contract_currency: 'RSD', contract_date: '2026-01-10',
  contract_value_rsd: 1000000, contract_value_eur: 8532.42, payment_days: 45, active: true, note: null, ...o,
})

const inv = (o: Partial<RevenueListRow> = {}): RevenueListRow => ({
  id: 'i1', type: 'revenue', project_id: 'p1', invoice_number: 'S-1', invoice_date: '2026-03-31',
  due_date: '2026-05-15', currency: 'RSD', amount: 300000, amount_rsd: 300000, amount_eur: 2560,
  paid_amount_rsd: 100000, paid_amount_eur: 853, remaining_rsd: 150000, remaining_eur: 1280,
  advance_deducted: 50000, advance_deducted_rsd: 50000, advance_deducted_eur: 427,
  calculated_status: 'partial', partner_name: 'Investitor d.o.o.', revenue_stream: 'Građevinske situacije', ...o,
})

const advance = { project_id: 'p1', currency: 'RSD', amount: 200000, amount_rsd: 200000, amount_eur: 1707, status: 'posted' }

describe('months', () => {
  it('lists n months from the current one, across a year end', () => {
    expect(nextMonths('2026-11-20', 3)).toEqual(['2026-11', '2026-12', '2027-01'])
  })
  it('goes to December', () => {
    expect(monthsToYearEnd('2026-10-08')).toEqual(['2026-10', '2026-11', '2026-12'])
    expect(monthsToYearEnd('2026-12-31')).toEqual(['2026-12'])
  })
  it('labels in Serbian', () => {
    expect(monthLabel('2026-10-01')).toBe('okt 2026')
    expect(srDateShort('2026-03-05')).toBe('05.03.2026.')
    expect(srDateShort(null)).toBe('—')
  })
})

describe('revenueStatus', () => {
  it('maps the view status to the three the page shows', () => {
    expect(revenueStatus('paid')).toBe('paid')
    expect(revenueStatus('partial')).toBe('partial')
    expect(revenueStatus('unpaid')).toBe('unpaid')
    expect(revenueStatus(null)).toBe('unpaid')
  })
})

describe('revenueTotals', () => {
  const rows = [
    inv(),
    inv({ id: 'i2', invoice_date: '2025-12-31', amount_rsd: 500000, paid_amount_rsd: 0, remaining_rsd: 500000 }),
    inv({ id: 'x', type: 'expense', amount_rsd: 999 }),
  ]
  it('bills and collects in the period, owes on everything', () => {
    const t = revenueTotals(rows, [150000, 20000], '2026-01-01', '2026-12-31', 'RSD')
    expect(t.billed).toBe(300000)
    expect(t.collected).toBe(100000)
    expect(t.outstanding).toBe(650000)
    expect(t.advancesRemaining).toBe(170000)
  })
  it('counts rows with no figure in the currency', () => {
    const t = revenueTotals([inv({ amount_eur: null })], [], '', '', 'EUR')
    expect(t.billed).toBe(0)
    expect(t.unconverted).toBe(1)
  })
})

describe('projectRevenueRows', () => {
  it('summarises each project, overhead on its own row, and totals', () => {
    const rows = [inv(), inv({ id: 'o1', project_id: null, amount_rsd: 40000, paid_amount_rsd: 40000, remaining_rsd: 0, advance_deducted_rsd: 0, advance_deducted: 0 })]
    const r = projectRevenueRows([project(), project({ id: 'p2', name: 'Zemun', code: null, active: false })], rows, [advance], 'RSD')
    // The closed project with nothing is left out.
    expect(r.projects.map(p => p.projectId)).toEqual(['p1'])
    const p1 = r.projects[0]
    expect(p1.label).toBe('NB-01 · Novi Beograd A1')
    expect(p1.billed).toBe(300000)
    expect(p1.billedPct).toBe(30)
    expect(p1.advanceReceived).toBe(200000)
    expect(p1.advanceDeducted).toBe(50000)
    expect(p1.advanceRemaining).toBe(150000)
    expect(p1.collected).toBe(100000)
    expect(p1.outstanding).toBe(150000)
    expect(r.overhead?.label).toBe('Opšti troškovi')
    expect(r.overhead?.billed).toBe(40000)
    expect(r.total.billed).toBe(340000)
    expect(r.total.collected).toBe(140000)
    // % of contracts counts only the projects with a contract.
    expect(r.total.billedPct).toBe(30)
    expect(r.total.contractValue).toBe(1000000)
  })
  it('has no overhead row without overhead revenue, and labels a stray project from the view', () => {
    const r = projectRevenueRows([], [inv({ project_id: 'gone', project_name: 'Stari objekat' })], [], 'RSD')
    expect(r.overhead).toBeNull()
    expect(r.projects[0].label).toBe('Stari objekat')
    expect(r.total.billedPct).toBeNull()
  })
})

describe('filterRevenueInvoices', () => {
  const rows = [
    inv({ id: 'a', invoice_date: '2026-01-15', calculated_status: 'paid' }),
    inv({ id: 'b', invoice_date: '2026-02-15', project_id: null, revenue_stream: 'Ostalo' }),
    inv({ id: 'c', invoice_date: '2026-03-15', revenue_stream: 'Zakup', calculated_status: 'unpaid', invoice_number: 'ZAK-1' }),
    inv({ id: 'd', type: 'expense' }),
  ]
  const none = { projectId: '', stream: '', status: '' as const, from: '', to: '' }
  it('returns revenue invoices, newest first', () => {
    expect(filterRevenueInvoices(rows, none).map(r => r.id)).toEqual(['c', 'b', 'a'])
  })
  it('filters by project, overhead, stream, status, period and search', () => {
    expect(filterRevenueInvoices(rows, { ...none, projectId: OVERHEAD_FILTER }).map(r => r.id)).toEqual(['b'])
    expect(filterRevenueInvoices(rows, { ...none, projectId: 'p1' }).map(r => r.id)).toEqual(['c', 'a'])
    expect(filterRevenueInvoices(rows, { ...none, stream: 'Zakup' }).map(r => r.id)).toEqual(['c'])
    expect(filterRevenueInvoices(rows, { ...none, status: 'paid' }).map(r => r.id)).toEqual(['a'])
    expect(filterRevenueInvoices(rows, { ...none, from: '2026-02-01', to: '2026-02-28' }).map(r => r.id)).toEqual(['b'])
    expect(filterRevenueInvoices(rows, { ...none, search: 'zak' }).map(r => r.id)).toEqual(['c'])
  })
})

describe('plan grid', () => {
  const plan = [{ id: 'r1', project_id: 'p1', month: '2026-10-01', amount: 100, currency: 'EUR' as const, amount_rsd: 11720, amount_eur: 100 }]
  const rent = [
    { lease_id: 'l1', project_id: 'p2', month: '2026-11', amount: 500, currency: 'EUR' as const, invoice_date: '2026-11-01', payment_days: 15 },
    { lease_id: 'l2', project_id: 'p2', month: '2026-11', amount: 300, currency: 'EUR' as const, invoice_date: '2026-11-05', payment_days: 15 },
  ]
  it('puts plan rows and summed rent in their cells', () => {
    const g = planGrid(['p1', 'p2'], ['2026-10', '2026-11'], plan, rent)
    expect(g.p1['2026-10'].plan?.id).toBe('r1')
    expect(g.p1['2026-11'].plan).toBeNull()
    expect(g.p2['2026-11'].rent).toEqual([{ amount: 800, currency: 'EUR' }])
  })
  it('defaults the plan currency to the rows, then the contract, then RSD', () => {
    expect(defaultPlanCurrency(project({ contract_currency: 'RSD' }), plan)).toBe('EUR')
    expect(defaultPlanCurrency(project({ id: 'p9', contract_currency: 'EUR' }), plan)).toBe('EUR')
    expect(defaultPlanCurrency(project({ id: 'p9', contract_currency: null }), plan)).toBe('RSD')
  })
  it('reads a typed cell', () => {
    expect(planCellAction(null, '', 'RSD')).toEqual({ kind: 'none' })
    expect(planCellAction({ id: 'r1', amount: 100, currency: 'EUR' }, '  ', 'EUR')).toEqual({ kind: 'delete', id: 'r1' })
    expect(planCellAction({ id: 'r1', amount: 100, currency: 'EUR' }, '100,00', 'EUR')).toEqual({ kind: 'none' })
    expect(planCellAction({ id: 'r1', amount: 100, currency: 'EUR' }, '100', 'RSD')).toEqual({ kind: 'upsert', amount: 100, currency: 'RSD' })
    expect(planCellAction(null, '1.234.567,891', 'RSD')).toEqual({ kind: 'upsert', amount: 1234567.89, currency: 'RSD' })
    expect(planCellAction(null, 'abc', 'RSD').kind).toBe('error')
    expect(planCellAction(null, '-5', 'RSD').kind).toBe('error')
  })
  it('builds the upsert row on the first of the month', () => {
    const row = planUpsertRow('c1', 'p1', '2026-11', 100, 'EUR',
      { eur_rate: 117.2, rate_date: '2026-10-08', amount_rsd: 11720, amount_eur: 100 }, 'now')
    expect(row).toMatchObject({ month: '2026-11-01', amount: 100, currency: 'EUR', rate_date: '2026-10-08', amount_rsd: 11720 })
  })
  it('writes amounts back to inputs without thousands separators', () => {
    expect(amountToInput(1234.5)).toBe('1234,50')
    expect(amountToInput('2000')).toBe('2000')
    expect(amountToInput(null)).toBe('')
  })
})

describe('leases', () => {
  const lease: RentalLease = {
    id: 'abcd1234-ef56-7890-abcd-1234567890ab', project_id: 'p2', tenant_partner_id: 't1',
    monthly_rent: '1500', currency: 'EUR', start_date: '2026-10-16', end_date: null,
    invoice_day: 5, payment_days: 10, active: true,
  }
  it('validates as the table CHECKs do', () => {
    const d = emptyLeaseDraft('p2', '2026-10-08')
    expect(validateLease(d)).toBe('Izaberite zakupca.')
    const ok = { ...d, tenant_partner_id: 't1', monthly_rent: '1.500,00' }
    expect(validateLease(ok)).toBeNull()
    expect(validateLease({ ...ok, monthly_rent: '0' })).toMatch(/veća od nule/)
    expect(validateLease({ ...ok, end_date: '2026-01-01' })).toMatch(/pre nego što počne/)
    expect(validateLease({ ...ok, invoice_day: '29' })).toMatch(/od 1 do 28/)
    expect(validateLease({ ...ok, payment_days: '400' })).toMatch(/od 0 do 365/)
  })
  it('round-trips a lease through the draft into a row', () => {
    const row = leaseRow(leaseDraftFromLease(lease), 'c1', 'now')
    expect(row).toMatchObject({
      company_id: 'c1', project_id: 'p2', tenant_partner_id: 't1', monthly_rent: 1500, currency: 'EUR',
      start_date: '2026-10-16', end_date: null, invoice_day: 5, payment_days: 10, active: true, note: null,
    })
  })
  it('refuses to end a lease before it starts', () => {
    expect(validateLeaseEnd(lease, '2026-10-01')).toMatch(/pre nego što počne/)
    expect(validateLeaseEnd(lease, '2026-12-31')).toBeNull()
    expect(validateLeaseEnd(lease, '')).toMatch(/Unesite/)
  })

  it('makes a prorated rent invoice row with a provisional number', () => {
    const [p] = rentInvoicesDue([lease], '2026-10', [])
    const row = rentInvoiceRow(p, { exchange_rate: 117.2, eur_rate: 117.2, amount_rsd: 93760, amount_eur: 800 }, 'c1')
    expect(row).toMatchObject({
      company_id: 'c1', partner_id: 't1', project_id: 'p2', lease_id: lease.id, service_month: '2026-10-01',
      invoice_number: 'ZAK-ABCD1234-2026-10', invoice_date: '2026-10-05', due_date: '2026-10-15',
      type: 'revenue', revenue_stream: 'Zakup', currency: 'EUR', amount: 774.19, pl_impact: true, status: 'unpaid',
      amount_rsd: 93760, amount_eur: 800,
    })
    expect(provisionalRentNumber('x', '2026-01-01')).toBe('ZAK-X-2026-01')
  })
  it('recognises the duplicate rent invoice refusal', () => {
    expect(isDuplicateRentError({ code: '23505', message: 'x' })).toBe(true)
    expect(isDuplicateRentError({ message: 'duplicate key value violates unique constraint "invoices_lease_month_key"' })).toBe(true)
    expect(isDuplicateRentError({ code: '42501', message: 'rls' })).toBe(false)
    expect(isDuplicateRentError(null)).toBe(false)
  })
})

describe('invoiceCount', () => {
  it('declines faktura', () => {
    expect([1, 2, 4, 5, 11, 12, 21, 22, 25].map(invoiceCount)).toEqual([
      '1 faktura', '2 fakture', '4 fakture', '5 faktura', '11 faktura', '12 faktura', '21 faktura', '22 fakture', '25 faktura',
    ])
  })
})
