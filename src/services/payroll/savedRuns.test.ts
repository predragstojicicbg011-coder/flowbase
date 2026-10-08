import {
  linesOf, headerOf, byMonth, saveRun, alreadyPostedMessage,
  type SaveContext, type SavedRun,
} from './savedRuns'
import { runsFor, type RunInput } from './runs'
import { splitContractedNet, RATES_2026 } from './engine'
import { emptyTimesheet, type TimesheetRow } from './timesheets'
import type { EmployeeForMonth, EmployeeRow, ContractRow } from './employees'

const MONTH = '2026-09'
const FUND = 176
const RATE = 117.4007

const employee = (over: Partial<EmployeeRow> = {}): EmployeeRow => ({
  id: 'e1', company_id: 'c1', code: 'E003', full_name: 'Popović Vladimir',
  organisational_unit: 'GRAD', hired_on: null, seniority_from: '2022-03-01',
  left_on: null, note: null, deleted_at: null, ...over,
})

const contract = (over: Partial<ContractRow> = {}): ContractRow => ({
  id: 'k1', employee_id: 'e1', valid_from: '2026-09-01', valid_to: null,
  currency: 'EUR', net_amount: 2600, service_years: null,
  note: null, ...over,
})

const person = (over: Partial<EmployeeForMonth> = {}): EmployeeForMonth => ({
  employee: employee(), contract: contract(),
  net: splitContractedNet(Math.round(2600 * RATE * 100) / 100, 4, 0.004),
  deductions: [],
  allocation: {
    id: 'a1', employee_id: 'e1', department: 'Development Expenses',
    dept_subcategory: 'Salary expenses domestic', rev_alloc_type: 'sg100',
    opex_type: 'opex', valid_from: '2026-01-01', valid_to: null, note: null,
  },
  serviceYears: 4, serviceYearsDerived: true, ...over,
})

const sheet = (over: Partial<TimesheetRow> = {}): TimesheetRow =>
  ({ ...emptyTimesheet('e1', MONTH), ...over })

const input = (over: Partial<RunInput> = {}): RunInput => ({
  people: [person()],
  timesheets: { e1: sheet({ regular_hours: 168, vacation_hours: 8 }) },
  rates: RATES_2026, monthHours: FUND, month: MONTH,
  coefficients: { godisnji_odmor: 1 },
  ...over,
})

const context = (over: Partial<SaveContext> = {}): SaveContext => ({
  companyId: 'c1', month: MONTH, exchangeRate: RATE, eurRate: RATE,
  monthHours: FUND,
  people: { e1: person() },
  ...over,
})

const calc = (over: Partial<RunInput> = {}) => runsFor(input(over))
const runOf = (key: string, over: Partial<RunInput> = {}) =>
  calc(over).runs.find(r => r.key === key)!

describe('what a line keeps', () => {
  const run = runOf('regular')
  const [line] = linesOf(run, context())

  it('carries every figure the payslip prints', () => {
    expect(line.employee_name).toBe('Popović Vladimir')
    expect(line.hours).toBe(176)
    expect(line.month_hours).toBe(FUND)
    expect(line.gross).toBe(run.salaries[0].line.gross)
    expect(line.contribution_base).toBeGreaterThan(0)
    expect(line.net).toBeGreaterThan(0)
    expect(line.service_years).toBe(4)
    expect(line.seniority_net).toBeGreaterThan(0)
  })

  it('COPIES the department rather than pointing at it', () => {
    // The allocation may be changed next week. A posted payroll that moved
    // department underneath its own invoices would be worse than none.
    expect(line.department).toBe('Development Expenses')
    expect(line.dept_subcategory).toBe('Salary expenses domestic')
  })

  it('keeps the parts the payslip needs and no row can hold', () => {
    const detail = line.detail as any
    expect(detail.categories.map((c: any) => c.field)).toEqual(['regular_hours', 'vacation_hours'])
    expect(detail.meal_allowance).toBeGreaterThan(0)
    expect(detail.holiday_allowance).toBeGreaterThan(0)
  })

  it('writes an other-income line with no hours and no contributions', () => {
    const [t] = linesOf(runOf('other', {
      additions: [{
        id: 'x1', employee_id: 'e1', month: '2026-09-01', kind: 'other',
        label: 'Referral', treatment: 'other_income', amount: 20000, currency: 'RSD', note: null,
      }],
    }), context())
    expect(t.line_kind).toBe('other')
    expect(t.label).toBe('Other income')
    expect(t.hours).toBe(0)
    expect(t.pension_employee).toBe(0)
    expect(t.net).toBe(20000)
  })
})

describe('the header', () => {
  it('holds the totals, so a list of months needs no lines', () => {
    const run = runOf('regular')
    const h = headerOf(run, context())
    expect(h.period_month).toBe('2026-09-01')
    expect(h.run_key).toBe('regular')
    expect(h.total_cost).toBe(run.totals.totalCost)
  })

  it('records the rate every figure was built on', () => {
    // A recalculation months later must not silently use today's rate, and
    // the only way to notice is to have kept the one that was used.
    expect(headerOf(runOf('regular'), context()).exchange_rate).toBe(RATE)
  })

  it('records the EUR rate the posted rows will carry, and no dollar rate', () => {
    const header: any = headerOf(runOf('regular'), context({ eurRate: 117.2 }))
    expect(header.eur_rate).toBe(117.2)
    expect('usd_rate' in header).toBe(false)
  })
})

describe('saveRun', () => {
  const client = (over: { existing?: any; lineCount?: number; clearError?: any } = {}) => {
    const calls: any = { inserted: [], updated: [], cleared: 0, lines: [] }
    return {
      calls,
      from(table: string) {
        if (table === 'payroll_runs') {
          return {
            select: () => ({ eq: () => ({ eq: () => ({ eq: () => ({
              maybeSingle: async () => ({ data: over.existing ?? null, error: null }),
            }) }) }) }),
            insert(row: any) {
              calls.inserted.push(row)
              return { select: () => ({ single: async () =>
                ({ data: { id: 'r1', ...row }, error: null }) }) }
            },
            update(row: any) {
              calls.updated.push(row)
              return { eq: () => ({ select: () => ({ single: async () =>
                ({ data: { id: over.existing?.id ?? 'r1', ...row }, error: null }) }) }) }
            },
          }
        }
        return {
          delete: () => ({ eq: async () => { calls.cleared += 1; return { error: over.clearError || null } } }),
          insert(rows: any[]) {
            calls.lines.push(...rows)
            const n = over.lineCount ?? rows.length
            return { select: async () =>
              ({ data: Array.from({ length: n }, (_, i) => ({ id: `l${i}` })), error: null }) }
          },
        }
      },
    }
  }

  it('creates a run as a draft, with its lines', async () => {
    const c = client()
    const saved = await saveRun(c, runOf('regular'), context())
    expect(saved.id).toBe('r1')
    expect(c.calls.inserted[0].status).toBe('draft')
    expect(c.calls.lines).toHaveLength(1)
    expect(c.calls.lines[0].run_id).toBe('r1')
  })

  it('REFUSES a posted run before touching anything', async () => {
    // The trigger would refuse it too, but a message about a check constraint
    // is not what somebody pressing Recalculate needs to read.
    const c = client({ existing: { id: 'r1', status: 'posted' } })
    await expect(saveRun(c, runOf('regular'), context()))
      .rejects.toThrow(/has been posted, so it cannot be recalculated/)
    expect(c.calls.updated).toEqual([])
    expect(c.calls.cleared).toBe(0)
  })

  it('replaces the lines of a draft, header first', async () => {
    // Out of date beats absent: a failure while clearing leaves the previous
    // calculation intact rather than an empty run.
    const c = client({ existing: { id: 'r1', status: 'draft' } })
    await saveRun(c, runOf('regular'), context())
    expect(c.calls.updated).toHaveLength(1)
    expect(c.calls.cleared).toBe(1)
    expect(c.calls.lines).toHaveLength(1)
  })

  it('says the old calculation survived when the clear failed', async () => {
    const c = client({ existing: { id: 'r1', status: 'draft' }, clearError: { message: 'nope' } })
    await expect(saveRun(c, runOf('regular'), context()))
      .rejects.toThrow(/still the earlier calculation/)
  })

  it('refuses to call a half-written run saved', async () => {
    // A run missing lines would look complete on a list of months and post
    // short, and the difference is invisible until the ledger disagrees.
    const c = client({ lineCount: 0 })
    await expect(saveRun(c, runOf('regular'), context()))
      .rejects.toThrow(/lines were written/)
  })
})

describe('byMonth', () => {
  const run = (over: Partial<SavedRun>): SavedRun => ({
    id: 'x', company_id: 'c1', period_month: '2026-09-01', run_key: 'regular',
    label: 'Salaries', status: 'draft', exchange_rate: RATE, eur_rate: RATE,
    month_hours: FUND, gross: 0, net: 0, income_tax: 0,
    contributions_employee: 0, contributions_employer: 0,
    total_cost: 0, deductions_third_party: 0, deductions_employer: 0,
    calculated_at: '', posted_at: null, note: null, ...over,
  })

  it('groups the runs into months, newest first', () => {
    const months = byMonth([
      run({ id: 'a', period_month: '2026-08-01' }),
      run({ id: 'b', period_month: '2026-09-01' }),
      run({ id: 'c', period_month: '2026-09-01', run_key: 'other' }),
    ])
    expect(months.map(m => m.month)).toEqual(['2026-09', '2026-08'])
    expect(months[0].runs).toHaveLength(2)
  })

  it('counts what is posted and what is still a draft', () => {
    const [m] = byMonth([
      run({ id: 'a', status: 'posted' }),
      run({ id: 'b', run_key: 'other', status: 'draft' }),
    ])
    expect(m.posted).toBe(1)
    expect(m.draft).toBe(1)
  })

  it('adds the month up, so a list needs no lines', () => {
    const [m] = byMonth([
      run({ id: 'a', total_cost: 100 }),
      run({ id: 'b', run_key: 'other', total_cost: 50 }),
    ])
    expect(m.totalCost).toBe(150)
  })
})

describe('alreadyPostedMessage', () => {
  it('says why it matters, not just that it is locked', () => {
    const m = alreadyPostedMessage('Salaries', '2026-09')
    expect(m).toContain('invoices in the ledger were written from')
    expect(m).toContain('Delete the posting')
  })
})
