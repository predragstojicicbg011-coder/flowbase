import fs from 'fs'
import path from 'path'
import {
  advanceDeductionBook, agingBucket, daysBetween, projectAdvanceBalance, projectRevenueSummary,
  receivablesAging, validateAdvanceDeduction,
  type AdvanceReceipt, type RevenueInvoiceRow,
} from './revenue'
import { RateUnavailableError } from './bookAmounts'

const adv = (over: Partial<AdvanceReceipt> = {}): AdvanceReceipt => ({
  project_id: 'p1', currency: 'EUR', amount: 100000, amount_rsd: 11720000, amount_eur: 100000, status: 'posted', ...over,
})

const inv = (over: Partial<RevenueInvoiceRow> = {}): RevenueInvoiceRow => ({
  id: 'i1', type: 'revenue', project_id: 'p1', partner_name: 'Investitor', invoice_date: '2026-09-30',
  due_date: '2026-11-14', currency: 'EUR', amount: 50000, amount_rsd: 5860000, amount_eur: 50000,
  paid_amount_rsd: 0, paid_amount_eur: 0, remaining_rsd: 5860000, remaining_eur: 50000,
  advance_deducted: 0, advance_deducted_rsd: 0, advance_deducted_eur: 0, calculated_status: 'unpaid', ...over,
})

describe('advanceDeductionBook', () => {
  it('books a deduction at the invoice stored rates, like any part of it', () => {
    expect(advanceDeductionBook(10000, { currency: 'EUR', exchange_rate: 117.2, eur_rate: 117.2 }))
      .toEqual({ advance_deducted: 10000, advance_deducted_rsd: 1172000, advance_deducted_eur: 10000 })
    expect(advanceDeductionBook(1172000, { currency: 'RSD', exchange_rate: 1, eur_rate: 117.2 }))
      .toEqual({ advance_deducted: 1172000, advance_deducted_rsd: 1172000, advance_deducted_eur: 10000 })
  })

  it('is three zeros for no deduction, without needing a rate', () => {
    expect(advanceDeductionBook(0, { currency: 'EUR' }))
      .toEqual({ advance_deducted: 0, advance_deducted_rsd: 0, advance_deducted_eur: 0 })
  })

  it('refuses an invoice with no rate rather than guess', () => {
    expect(() => advanceDeductionBook(10, { currency: 'EUR' })).toThrow(RateUnavailableError)
  })
})

describe('projectAdvanceBalance', () => {
  it('keeps the balance in the one currency everything is in', () => {
    const b = projectAdvanceBalance('p1', [adv()], [
      inv({ advance_deducted: 30000, advance_deducted_rsd: 3510000, advance_deducted_eur: 30000 }),
      inv({ id: 'i2', advance_deducted: 70000, advance_deducted_rsd: 8211000, advance_deducted_eur: 70000 }),
    ])
    expect(b.currency).toBe('EUR')
    expect(b.received).toBe(100000)
    expect(b.deducted).toBe(100000)
    // The advance is used up in euros; the dinars left over are the rate moving.
    expect(b.remaining).toBe(0)
    expect(b.remaining_rsd).toBe(-1000)
    expect(b.remaining_eur).toBe(0)
  })

  it('has no own-currency figures when currencies are mixed', () => {
    const b = projectAdvanceBalance('p1', [adv(), adv({ currency: 'RSD', amount: 1000, amount_rsd: 1000, amount_eur: 8.53 })], [])
    expect(b.currency).toBeNull()
    expect(b.received).toBeNull()
    expect(b.remaining).toBeNull()
    expect(b.received_rsd).toBe(11721000)
  })

  it('ignores other projects, drafts, deleted receipts and deleted invoices', () => {
    const b = projectAdvanceBalance('p1', [
      adv(), adv({ project_id: 'p2' }), adv({ status: 'draft' }), adv({ deleted_at: '2026-10-01' }),
    ], [inv({ advance_deducted: 5, advance_deducted_rsd: 586, advance_deducted_eur: 5, deleted_at: '2026-10-01' })])
    expect(b.received).toBe(100000)
    expect(b.deducted).toBe(0)
  })
})

describe('validateAdvanceDeduction', () => {
  const invoice = { id: 'new', type: 'revenue', project_id: 'p1', currency: 'EUR', amount: 50000, exchange_rate: 117.2, eur_rate: 117.2 }
  const prior = inv({ id: 'i0', advance_deducted: 80000, advance_deducted_rsd: 9376000, advance_deducted_eur: 80000 })

  it('lets nothing through as nothing', () => {
    expect(validateAdvanceDeduction({ invoice, advanceDeducted: 0, advances: [], deductions: [] })).toBeNull()
    expect(validateAdvanceDeduction({ invoice, advanceDeducted: null, advances: [], deductions: [] })).toBeNull()
  })

  it('accepts up to what remains, to the para, in the shared currency', () => {
    expect(validateAdvanceDeduction({ invoice, advanceDeducted: 20000, advances: [adv()], deductions: [prior] })).toBeNull()
    expect(validateAdvanceDeduction({ invoice, advanceDeducted: 20000.01, advances: [adv()], deductions: [prior] }))
      .toMatch(/veći od preostalog avansa \(20\.000,00 EUR\)/)
  })

  it('does not count the invoice own earlier deduction against itself when editing', () => {
    const self = inv({ id: 'new', advance_deducted: 20000, advance_deducted_rsd: 2344000, advance_deducted_eur: 20000 })
    expect(validateAdvanceDeduction({ invoice, advanceDeducted: 20000, advances: [adv()], deductions: [prior, self] })).toBeNull()
  })

  it('compares in dinars when currencies differ, with one dinar of slack', () => {
    const rsdInvoice = { ...invoice, currency: 'RSD', amount: 5000000, exchange_rate: 1 }
    // 100,000 EUR received at 11,720,000 RSD; 80,000 EUR deducted at 9,376,000 RSD → 2,344,000 left.
    expect(validateAdvanceDeduction({ invoice: rsdInvoice, advanceDeducted: 2344001, advances: [adv()], deductions: [prior] })).toBeNull()
    expect(validateAdvanceDeduction({ invoice: rsdInvoice, advanceDeducted: 2344002, advances: [adv()], deductions: [prior] }))
      .toMatch(/2\.344\.000,00 RSD/)
  })

  it('refuses the shapes the database refuses', () => {
    const base = { advances: [adv()], deductions: [] }
    expect(validateAdvanceDeduction({ ...base, invoice: { ...invoice, type: 'expense' }, advanceDeducted: 1 })).toMatch(/izlaznoj/)
    expect(validateAdvanceDeduction({ ...base, invoice: { ...invoice, project_id: null }, advanceDeducted: 1 })).toMatch(/projektu/)
    expect(validateAdvanceDeduction({ ...base, invoice, advanceDeducted: 50000.01 })).toMatch(/iznosa fakture/)
    expect(validateAdvanceDeduction({ ...base, invoice, advanceDeducted: -1 })).toMatch(/negativan/)
    expect(validateAdvanceDeduction({ ...base, invoice, advanceDeducted: NaN })).toMatch(/broj/)
  })

  it('refuses a deduction on a project that received no advance', () => {
    expect(validateAdvanceDeduction({ invoice, advanceDeducted: 1, advances: [adv({ project_id: 'p2' })], deductions: [] }))
      .toMatch(/nije primljen avans/)
  })
})

describe('projectRevenueSummary', () => {
  const project = { id: 'p1', contract_value: 200000, contract_currency: 'EUR' as const, contract_value_rsd: 23440000, contract_value_eur: 200000 }
  const rows = [
    // Billed 50,000, 10,000 of it from the advance, 25,000 collected, 15,000 owed.
    inv({ advance_deducted: 10000, advance_deducted_rsd: 1172000, advance_deducted_eur: 10000,
      paid_amount_rsd: 2930000, paid_amount_eur: 25000, remaining_rsd: 1758000, remaining_eur: 15000, calculated_status: 'partial' }),
    // Billed 50,000 at a different rate, untouched.
    inv({ id: 'i2', amount_rsd: 5865000, remaining_rsd: 5865000 }),
    // Not this project, not revenue, deleted: none counted.
    inv({ id: 'x1', project_id: 'p2' }),
    inv({ id: 'x2', type: 'expense' }),
    inv({ id: 'x3', deleted_at: '2026-10-01' }),
  ]

  it('adds up the position in the display currency, never converting a sum', () => {
    const s = projectRevenueSummary(project, rows, [adv()], 'EUR')
    expect(s).toMatchObject({
      contractValue: 200000, billedToDate: 100000, billedPct: 50,
      advanceReceived: 100000, advanceDeducted: 10000, advanceRemaining: 90000,
      collected: 25000, outstanding: 65000, unbilled: 100000, unconverted: 0,
    })
    // billed = deducted + collected + outstanding
    expect(s.advanceDeducted + s.collected + s.outstanding).toBe(s.billedToDate)
  })

  it('reads the dinar columns in RSD', () => {
    const s = projectRevenueSummary(project, rows, [adv()], 'RSD')
    expect(s.billedToDate).toBe(11725000)
    expect(s.advanceReceived).toBe(11720000)
    expect(s.advanceRemaining).toBe(11720000 - 1172000)
    // In the contract currency: half the euros, whatever the rate did.
    expect(s.billedPct).toBe(50)
  })

  it('falls back to book figures for the percentage when billings are in another currency', () => {
    const s = projectRevenueSummary(project, [inv({ currency: 'RSD', amount: 11720000, amount_rsd: 11720000, amount_eur: 100000 })], [], 'EUR')
    expect(s.billedPct).toBe(50)
  })

  it('has no percentage or unbilled figure without a contract', () => {
    const s = projectRevenueSummary({ ...project, contract_value: null, contract_currency: null, contract_value_rsd: null, contract_value_eur: null }, rows, [], 'EUR')
    expect(s.billedPct).toBeNull()
    expect(s.unbilled).toBeNull()
    expect(s.contractValue).toBeNull()
  })

  it('sums the plan from a month on, and counts rows it cannot read', () => {
    const plan = [
      { project_id: 'p1', month: '2026-09-01', amount_rsd: 1, amount_eur: 1 },
      { project_id: 'p1', month: '2026-10-01', amount_rsd: 2, amount_eur: 2 },
      { project_id: 'p1', month: '2026-11-01', amount_rsd: 3, amount_eur: null },
      { project_id: 'p2', month: '2026-11-01', amount_rsd: 4, amount_eur: 4 },
    ]
    const s = projectRevenueSummary(project, [], [], 'EUR', { plan, fromMonth: '2026-10' })
    expect(s.planned).toBe(2)
    expect(s.unconverted).toBe(1)
  })
})

describe('receivablesAging', () => {
  it('buckets what is owed by days past due', () => {
    expect(daysBetween('2026-10-01', '2026-10-31')).toBe(30)
    expect(agingBucket(-1)).toBe('notDue')
    expect(agingBucket(0)).toBe('d0_30')
    expect(agingBucket(30)).toBe('d0_30')
    expect(agingBucket(31)).toBe('d31_60')
    expect(agingBucket(90)).toBe('d61_90')
    expect(agingBucket(91)).toBe('d90plus')
  })

  it('reads only open revenue invoices, at their remaining figure', () => {
    const a = receivablesAging([
      inv({ id: 'a', due_date: '2026-10-20', remaining_eur: 100 }),                      // not due
      inv({ id: 'b', due_date: '2026-10-08', remaining_eur: 200 }),                      // due today
      inv({ id: 'c', due_date: '2026-08-01', remaining_eur: 300, calculated_status: 'partial' }), // 68 days
      inv({ id: 'd', due_date: null, invoice_date: '2026-06-01', remaining_eur: 400 }),  // 129 days
      inv({ id: 'e', calculated_status: 'paid', remaining_eur: 0 }),
      inv({ id: 'f', type: 'expense' }),
      inv({ id: 'g', remaining_eur: null }),
    ], '2026-10-08', 'EUR')
    expect(a.buckets.notDue).toEqual({ total: 100, count: 1 })
    expect(a.buckets.d0_30).toEqual({ total: 200, count: 1 })
    expect(a.buckets.d61_90).toEqual({ total: 300, count: 1 })
    expect(a.buckets.d90plus).toEqual({ total: 400, count: 1 })
    expect(a.total).toBe(1000)
    expect(a.unconverted).toBe(1)
    expect(a.items.map(i => i.id)).toEqual(['d', 'c', 'b', 'a'])
  })
})

describe('the migration', () => {
  const sql = fs.readFileSync(
    path.join(__dirname, '../../supabase/migrations/20261008180000_accrual_revenue.sql'), 'utf8')

  it('puts revenue invoices on both invoice legs of v_pl_entries', () => {
    const view = sql.slice(sql.indexOf('CREATE VIEW public.v_pl_entries'), sql.indexOf('CREATE VIEW public.v_project_advances'))
    expect(view.match(/i\.type = ANY \(ARRAY\['expense'::text, 'revenue'::text\]\)/g)).toHaveLength(2)
    expect(view).not.toMatch(/i\.type = 'expense'::text/)
    // Transactions still only with pl_impact: a receipt that settles an invoice has none.
    expect(view.match(/t\.pl_impact = true/g)).toHaveLength(2)
  })

  it('keeps every new view closed to anon and running as the caller', () => {
    for (const v of ['v_invoice_status', 'v_pl_entries', 'v_project_advances']) {
      expect(sql).toMatch(new RegExp(`CREATE VIEW public\\.${v} WITH \\(security_invoker='on'\\)`))
      expect(sql).toMatch(new RegExp(`REVOKE ALL ON TABLE public\\.${v} FROM anon`))
    }
    for (const t of ['rental_leases', 'revenue_plan']) {
      expect(sql).toMatch(new RegExp(`revoke all on table public\\.${t} from anon`))
      expect(sql).toMatch(new RegExp(`alter table public\\.${t} enable row level security`))
    }
  })
})
