import {
  linesOf, headerOf, byMonth, saveRun, alreadyPostedMessage,
  keptWhy, keptState, kindOf, removeRun, monthBadge, NOT_KEPT, KEPT_DIFFERS, POSTED_DIFFERS,
  KEPT_TOTAL_DIFFERS,
  type SaveContext, type SavedRun,
} from './savedRuns'
import {
  KEPT_KIND_DIFFERS, KEPT_RUN_EMPTY, RUN_HAS_POSTING, RUN_NOT_REMOVED,
} from './preliminaryText'
import { runsFor, type RunInput } from './runs'
import { splitContractedNet, RATES_2026 } from './engine'
import { emptyTimesheet, type TimesheetRow } from './timesheets'
import type { EmployeeForMonth, EmployeeRow, ContractRow } from './employees'

const MONTH = '2026-09'
const FUND = 176
const RATE = 117.4007

const employee = (over: Partial<EmployeeRow> = {}): EmployeeRow => ({
  id: 'e1', company_id: 'c1', code: 'E003', full_name: 'Osoba A',
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
    valid_from: '2026-01-01', valid_to: null, note: null,
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
  kind: 'regular',
  ...over,
})

const calc = (over: Partial<RunInput> = {}) => runsFor(input(over))
const runOf = (key: string, over: Partial<RunInput> = {}) =>
  calc(over).runs.find(r => r.key === key)!

describe('what a line keeps', () => {
  const run = runOf('regular')
  const [line] = linesOf(run, context())

  it('carries every figure the payslip prints', () => {
    expect(line.employee_name).toBe('Osoba A')
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
    expect(line).not.toHaveProperty('dept_subcategory')
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
    expect(t.label).toBe('Ostala primanja')
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
      .rejects.toThrow(/je proknjižen, pa ne može ponovo da se obračuna/)
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
      .rejects.toThrow(/sačuvan je i dalje raniji obračun/)
  })

  it('refuses to call a half-written run saved', async () => {
    // A run missing lines would look complete on a list of months and post
    // short, and the difference is invisible until the ledger disagrees.
    const c = client({ lineCount: 0 })
    await expect(saveRun(c, runOf('regular'), context()))
      .rejects.toThrow(/Upisano je \d+ od \d+ stavk[ei]\. Sačuvani obračun je nepotpun/)
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
    expect(m).toContain('napisane fakture u glavnoj knjizi')
    expect(m).toContain('obrišite knjiženje')
  })
})

describe('keptWhy — what the posting panel says about the kept run', () => {
  const money = (n: number) => n.toFixed(2)
  const run = runOf('regular')
  const kept = (over: Partial<SavedRun>): SavedRun => ({
    id: 'k', company_id: 'c1', period_month: '2026-09-01', run_key: 'regular',
    label: 'Zarade', status: 'draft', exchange_rate: RATE, eur_rate: RATE,
    month_hours: FUND, gross: 0, net: 0, income_tax: 0,
    contributions_employee: 0, contributions_employer: 0,
    total_cost: run.totals.totalCost, deductions_third_party: 0, deductions_employer: 0,
    calculated_at: '', posted_at: null, note: null, ...over,
  })
  const drifted = run.totals.totalCost - 100

  it('asks for a calculation when nothing is kept', () => {
    expect(keptWhy(undefined, run, 'regular', money)).toBe(NOT_KEPT)
  })

  it('says nothing about a draft that agrees', () => {
    expect(keptWhy(kept({}), run, 'regular', money)).toBeNull()
  })

  it('asks a drifted draft to be recalculated', () => {
    expect(keptWhy(kept({ total_cost: drifted }), run, 'regular', money))
      .toBe(KEPT_DIFFERS(money(drifted), money(run.totals.totalCost)))
  })

  it('says nothing about a posted run that agrees', () => {
    expect(keptWhy(kept({ status: 'posted' }), run, 'regular', money)).toBeNull()
  })

  it('tells a drifted POSTED run to undo the posting first, never just to recalculate', () => {
    const why = keptWhy(kept({ status: 'posted', total_cost: drifted }), run, 'regular', money)
    expect(why).toBe(POSTED_DIFFERS(money(drifted), money(run.totals.totalCost)))
    expect(POSTED_DIFFERS('1.000,00', '1.100,00')).toBe(
      'Proknjiženo je 1.000,00, a sa današnjim podacima obračun iznosi 1.100,00. '
      + 'Da biste ponovo obračunali, prvo poništite knjiženje.')
  })

  it('tolerates two paras of rounding, as the posting check always has', () => {
    expect(keptWhy(kept({ total_cost: run.totals.totalCost + 0.019 }), run, 'regular', money)).toBeNull()
    expect(keptWhy(kept({ total_cost: run.totals.totalCost + 0.03 }), run, 'regular', money)).not.toBeNull()
  })
})

describe('a kept run carries its kind', () => {
  const money = (n: number) => n.toFixed(2)
  const run = runOf('regular')
  const empty = { ...run, salaries: [], otherIncome: [] }
  const kept = (over: Partial<SavedRun>): SavedRun => ({
    id: 'k', company_id: 'c1', period_month: '2026-09-01', run_key: 'regular',
    label: 'Zarade', status: 'draft', exchange_rate: RATE, eur_rate: RATE,
    month_hours: FUND, gross: 0, net: 0, income_tax: 0,
    contributions_employee: 0, contributions_employer: 0,
    total_cost: run.totals.totalCost, deductions_third_party: 0, deductions_employer: 0,
    calculated_at: '', posted_at: null, note: null, ...over,
  })

  it('the header says the month\'s kind', () => {
    expect(headerOf(run, context({ kind: 'preliminary' })).kind).toBe('preliminary')
    expect(headerOf(run, context()).kind).toBe('regular')
  })

  it('a row kept before the column existed reads as regular', () => {
    expect(kindOf(kept({}))).toBe('regular')
    expect(kindOf(kept({ kind: 'preliminary' }))).toBe('preliminary')
  })

  it('in step needs the same total AND the same kind', () => {
    expect(keptState(null, run, 'regular')).toBe('none')
    expect(keptState(kept({ kind: 'regular' }), run, 'regular')).toBe('in_step')
    expect(keptState(kept({ kind: 'preliminary' }), run, 'regular')).toBe('stale_kind')
    expect(keptState(kept({ kind: 'regular' }), run, 'preliminary')).toBe('stale_kind')
    expect(keptState(kept({ total_cost: 1 }), run, 'regular')).toBe('stale_total')
    expect(keptState(kept({ status: 'posted' }), run, 'preliminary')).toBe('posted')
  })

  it('the tolerance is the panel\'s: two paras are still in step, three are not', () => {
    expect(keptState(kept({ total_cost: run.totals.totalCost + 0.019 }), run, 'regular')).toBe('in_step')
    expect(keptState(kept({ total_cost: run.totals.totalCost + 0.03 }), run, 'regular')).toBe('stale_total')
  })

  it('a kept draft nobody is in any more is empty, not in step', () => {
    expect(keptState(kept({ total_cost: 0 }), empty, 'regular')).toBe('empty')
    expect(keptWhy(kept({ total_cost: 0 }), empty, 'regular', money)).toBe(KEPT_RUN_EMPTY)
    // A posted one stays posted: it is undone, never removed.
    expect(keptState(kept({ status: 'posted' }), empty, 'regular')).toBe('posted')
  })

  it('a draft kept as another kind is to be recalculated, by sentence', () => {
    expect(keptWhy(kept({ kind: 'preliminary' }), run, 'regular', money))
      .toBe(KEPT_KIND_DIFFERS('preliminary', 'regular'))
    expect(KEPT_KIND_DIFFERS('preliminary', 'regular')).toBe(
      'Sačuvani obračun je preliminaran, a obračun ovog meseca je sada redovan. '
      + 'Ponovo obračunajte pre knjiženja.')
  })

  it('the run card\'s sentence is one constant', () => {
    expect(KEPT_TOTAL_DIFFERS('1.000,00', '1.100,00')).toBe(
      'Sačuvani obračun iznosi 1.000,00, a mesec sada iznosi 1.100,00. Nešto se u '
      + 'međuvremenu promenilo — ponovo obračunajte pre knjiženja.')
  })
})

describe('removeRun — a kept draft nobody is in any more', () => {
  const target = { id: 'r9', company_id: 'c1', period_month: '2026-11-01', run_key: 'other' }
  const client = (o: { byId?: any[]; byKey?: any[]; readError?: any; deleted?: any[]; deleteError?: any } = {}) => {
    const calls: any = { deleted: 0, filters: [] as any[] }
    const postings = () => {
      const f: any = {}
      const q: any = {
        eq(col: string, v: any) { f[col] = v; return q },
        limit: async () => {
          calls.filters.push({ ...f })
          if (o.readError) return { data: null, error: o.readError }
          return { data: 'run_id' in f ? (o.byId ?? []) : (o.byKey ?? []), error: null }
        },
      }
      return q
    }
    return {
      calls,
      from(table: string) {
        if (table === 'payroll_postings') return { select: () => postings() }
        const f: any = {}
        const q: any = {
          eq(col: string, v: any) { f[col] = v; return q },
          select: async () => {
            calls.deleted += 1
            calls.deleteFilter = { ...f }
            return { data: o.deleteError ? null : (o.deleted ?? [{ id: 'r9' }]), error: o.deleteError ?? null }
          },
        }
        return { delete: () => q }
      },
    }
  }

  it('removes a draft with no posting, asking for status draft', async () => {
    const c = client()
    await removeRun(c, target)
    expect(c.calls.deleted).toBe(1)
    expect(c.calls.deleteFilter).toEqual({ id: 'r9', status: 'draft' })
    expect(c.calls.filters).toEqual([
      { run_id: 'r9' },
      { company_id: 'c1', period_month: '2026-11-01', run_key: 'other' },
    ])
  })

  it('refuses when a posting names the run, by id or by company, month and run', async () => {
    const byId = client({ byId: [{ id: 'p1' }] })
    await expect(removeRun(byId, target)).rejects.toThrow(RUN_HAS_POSTING)
    expect(byId.calls.deleted).toBe(0)
    const byKey = client({ byKey: [{ id: 'p1' }] })
    await expect(removeRun(byKey, target)).rejects.toThrow(RUN_HAS_POSTING)
    expect(byKey.calls.deleted).toBe(0)
  })

  it('refuses when the postings cannot be read, and when nothing was deleted', async () => {
    await expect(removeRun(client({ readError: { message: 'x' } }), target)).rejects.toThrow(RUN_NOT_REMOVED)
    await expect(removeRun(client({ deleted: [] }), target)).rejects.toThrow(RUN_NOT_REMOVED)
    await expect(removeRun(client({ deleteError: { message: 'x' } }), target)).rejects.toThrow(RUN_NOT_REMOVED)
  })
})

describe('the months list says posted and preliminary together', () => {
  const run = (over: Partial<SavedRun>): SavedRun => ({
    id: 'x', company_id: 'c1', period_month: '2026-11-01', run_key: 'regular',
    label: 'Zarade', status: 'draft', exchange_rate: RATE, eur_rate: RATE,
    month_hours: FUND, gross: 0, net: 0, income_tax: 0,
    contributions_employee: 0, contributions_employer: 0,
    total_cost: 0, deductions_third_party: 0, deductions_employer: 0,
    calculated_at: '', posted_at: null, note: null, ...over,
  })

  it('counts the preliminary runs of a month', () => {
    const [m] = byMonth([run({ kind: 'preliminary' }), run({ id: 'b', run_key: 'other' })])
    expect(m.preliminary).toBe(1)
  })

  it('the badge', () => {
    const badge = (rs: SavedRun[]) => monthBadge(byMonth(rs)[0])
    expect(badge([run({ status: 'posted' })])).toBe('Proknjiženo')
    expect(badge([run({})])).toBe('Nacrt')
    expect(badge([run({ kind: 'preliminary' })])).toBe('Preliminarno')
    expect(badge([run({ status: 'posted' }), run({ id: 'b', run_key: 'other' })])).toBe('Proknjiženo 1 od 2')
    expect(badge([run({ status: 'posted' }), run({ id: 'b', run_key: 'other', kind: 'preliminary' })]))
      .toBe('Proknjiženo 1 od 2 · Preliminarno')
  })
})
