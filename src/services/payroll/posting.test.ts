import {
  planFor, planTotal, stornoTotal, checkPlan, unmappedUnits, departmentFor,
  retainedRoleFor, hoursBasisFromRuns, planProjectTotals, type UnitMapping,
} from './posting'
import { TEST_SYSTEM_CATEGORIES as SYSTEM } from '../systemCategories.fixture'
import type { SystemCategoryMap } from '../systemCategories'

/** What the fixture's owner calls the net-salary heading. */
const NET_SUBCATEGORY = SYSTEM.payroll_net_salary!.pl_subcategory
import { runsFor, RUN_LABELS, type RunInput } from './runs'
import { RATES_2026, splitContractedNet } from './engine'
import { emptyTimesheet, type TimesheetRow } from './timesheets'
import type { EmployeeForMonth, EmployeeRow, ContractRow, DeductionRow } from './employees'

const COEF = 0.004
const FUND = 168
const MONTH = '2026-08'

const MAPPING: UnitMapping[] = [
  { organisational_unit: 'GRAD - Gradilište', department: 'Development', dept_subcategory: 'Engineering' },
]

const employee = (over: Partial<EmployeeRow> = {}): EmployeeRow => ({
  id: 'e1', company_id: 'c1', code: 'E002', full_name: 'Gavrilov Dejan',
  organisational_unit: 'GRAD - Gradilište', hired_on: null,
  seniority_from: '2020-03-04', left_on: null, note: null, deleted_at: null, ...over,
})

const contract = (over: Partial<ContractRow> = {}): ContractRow => ({
  id: 'k1', employee_id: 'e1', valid_from: '2026-08-01', valid_to: null,
  currency: 'EUR', net_amount: 1000, service_years: null,
  note: null, ...over,
})

const deduction = (over: Partial<DeductionRow> = {}): DeductionRow => ({
  id: 'd1', employee_id: 'e1', label: 'Fitpass', goes_to: 'employer', payee: null,
  amount: 1000, currency: 'RSD', percent_of_net: null, valid_from: '2023-01-01',
  valid_to: null, is_active: true, note: null, ...over,
})

const person = (over: Partial<EmployeeForMonth> = {}): EmployeeForMonth => {
  const e = over.employee ?? employee()
  const c = over.contract ?? contract()
  return {
    employee: e, contract: c,
    net: splitContractedNet(117358.60, 6, COEF),
    deductions: [], allocation: null,
    serviceYears: 6, serviceYearsDerived: true, ...over,
  }
}

const sheet = (over: Partial<TimesheetRow> = {}): TimesheetRow =>
  ({ ...emptyTimesheet('e1', MONTH), ...over })

/** A run and the plan for it, from one description of a month. */
function plan(
  people: EmployeeForMonth[], timesheets: Record<string, TimesheetRow>, runKey = 'regular',
  over: Partial<RunInput> = {}, system: SystemCategoryMap = SYSTEM,
) {
  const input: RunInput = {
    people, timesheets, rates: RATES_2026, monthHours: FUND,
    currencyRates: { EUR: 117.3586 }, ...over,
  }
  const result = runsFor(input)
  const run = result.runs.find(r => r.key === runKey)!
  const byId: Record<string, EmployeeForMonth> = {}
  for (const p of people) byId[p.employee.id] = p
  return {
    run,
    plan: planFor({
      run, month: MONTH, people: byId, mapping: MAPPING, currencyRates: { EUR: 117.3586 }, system,
    }),
  }
}

describe('the plan adds up to the run', () => {
  it('matches a plain month with no deductions', () => {
    // THE CHECK THAT MATTERS. Everything about which deduction reduces which
    // expense is an argument, and an argument is easy to write convincingly
    // and get backwards. The arithmetic is not.
    const { run, plan: p } = plan([person()], { e1: sheet({ regular_hours: FUND }) })
    expect(planTotal(p)).toBeCloseTo(run.totals.totalCost, 1)
    expect(checkPlan(p)).toBeNull()
  })

  it('matches a month with a third-party deduction', () => {
    const { run, plan: p } = plan(
      [person({ deductions: [deduction({ goes_to: 'third_party', amount: 2500 })] })],
      { e1: sheet({ regular_hours: FUND }) })
    expect(planTotal(p)).toBeCloseTo(run.totals.totalCost, 1)
    expect(checkPlan(p)).toBeNull()
  })

  it('matches a month with a retained deduction, net of what was retained', () => {
    // A retained deduction DOES come off the salary — the employee is not
    // owed it — and the posted total is the run's cost less that amount. The
    // rule was the other way round until the owner pointed out what it was
    // saying: the ledger showed an employee owed 301,000 when 300,000 was
    // going to be paid, and carried a FitPass bill the employee had in fact
    // bought themselves out of their own salary.
    const { run, plan: p } = plan(
      [person({ deductions: [deduction({ goes_to: 'employer', amount: 1000 })] })],
      { e1: sheet({ regular_hours: FUND }) })
    expect(planTotal(p)).toBeCloseTo(run.totals.totalCost - 1000, 1)
    expect(p.expectedTotalCost).toBeCloseTo(run.totals.totalCost - 1000, 1)
    expect(checkPlan(p)).toBeNull()
  })

  it('matches a month of work and leave', () => {
    const { run, plan: p } = plan(
      [person()], { e1: sheet({ regular_hours: 100, vacation_hours: 68 }) }, 'regular',
      { coefficients: { godisnji_odmor: 1 } })
    expect(planTotal(p)).toBeCloseTo(run.totals.totalCost, 1)
    expect(checkPlan(p)).toBeNull()
  })

  it('matches an Other income run', () => {
    const { run, plan: p } = plan(
      [person()], { e1: sheet({ regular_hours: FUND }) }, 'other',
      { additions: [{
        id: 'x1', employee_id: 'e1', month: '2026-08-01', kind: 'other',
        label: 'Referral', treatment: 'other_income', amount: 20000, currency: 'RSD', note: null,
      }] })
    expect(planTotal(p)).toBeCloseTo(run.totals.totalCost, 1)
    expect(checkPlan(p)).toBeNull()
  })
})

describe('what each deduction does to the entries', () => {
  it('splits the salary between the employee and the payee', () => {
    // Two payables that add back to the net. The expense is the whole net
    // whatever happens to it afterwards.
    const { plan: p } = plan(
      [person({ deductions: [deduction({ goes_to: 'third_party', amount: 2500 })] })],
      { e1: sheet({ regular_hours: FUND }) })
    const net = p.invoices.find(i => i.kind === 'net')!
    const forwarded = p.invoices.find(i => i.kind === 'third_party')!
    expect(forwarded.amount).toBe(2500)
    // 117,358.60 contracted plus the meal and holiday allowance the engine
    // adds on top — the same 117,558.60 the engine test grosses up.
    expect(round(net.amount + forwarded.amount)).toBeCloseTo(117558.60, 0)
  })

  it('takes a retained deduction off the salary AND cancels it elsewhere', () => {
    // Both, and the circle only closes with both. The company booked 1,000
    // when it bought the membership; 1,000 is kept out of a 117,558.60 net
    // salary so the employee is owed 116,558.60; and a 1,000 storno cancels
    // the bill the employee paid for themselves. The company is out the
    // salary and nothing else.
    const { plan: p } = plan(
      [person({ deductions: [deduction({ goes_to: 'employer', amount: 1000 })] })],
      { e1: sheet({ regular_hours: FUND }) })
    const net = p.invoices.find(i => i.kind === 'net')!
    expect(net.amount).toBeCloseTo(116558.60, 0)
    expect(p.transactions).toHaveLength(1)
    expect(p.transactions[0].amount).toBe(-1000)
    expect(stornoTotal(p)).toBe(-1000)
  })

  it('leaves the same amount owed however the deduction is routed', () => {
    // A third-party deduction and a retained one both leave the employee
    // owed the same: neither is theirs. Where they differ is what happens to
    // the other side of it — forwarded to a payee, or cancelling an expense.
    const retained = plan(
      [person({ deductions: [deduction({ goes_to: 'employer', amount: 1000 })] })],
      { e1: sheet({ regular_hours: FUND }) }).plan
    const forwarded = plan(
      [person({ deductions: [deduction({ goes_to: 'third_party', amount: 1000 })] })],
      { e1: sheet({ regular_hours: FUND }) }).plan

    const netOf = (x: typeof retained) => x.invoices.find(i => i.kind === 'net')!.amount
    expect(netOf(retained)).toBeCloseTo(netOf(forwarded), 2)

    expect(retained.transactions).toHaveLength(1)
    expect(forwarded.invoices.some(i => i.kind === 'third_party')).toBe(true)
    expect(forwarded.transactions).toHaveLength(0)
  })

  it('keeps the storno out of the total, and counts the retention once', () => {
    // The storno cancels an expense booked elsewhere, so it is not part of
    // what this payroll costs. The retention is already off the salary, so
    // adding the storno here would take it off twice — which is how a
    // double-counted deduction looks from the inside: perfectly tidy.
    const { run, plan: p } = plan(
      [person({ deductions: [deduction({ goes_to: 'employer', amount: 1000 })] })],
      { e1: sheet({ regular_hours: FUND }) })
    expect(planTotal(p)).toBeCloseTo(run.totals.totalCost - 1000, 1)
    expect(planTotal(p) + stornoTotal(p)).toBeCloseTo(run.totals.totalCost - 2000, 1)
  })

  it('sends a retained deduction to its mapped category when one is given', () => {
    const byId = { e1: person({ deductions: [deduction({ label: 'Fitpass', amount: 1000 })] }) }
    const run = runsFor({
      people: [byId.e1], timesheets: { e1: sheet({ regular_hours: FUND }) },
      rates: RATES_2026, monthHours: FUND,
    }).runs.find(r => r.key === 'regular')!
    const p = planFor({
      run, month: MONTH, people: byId, mapping: MAPPING, system: SYSTEM,
      retainedCategories: { Fitpass: { pl_category: 'Zarade', pl_subcategory: 'Rekreacija' } },
    })
    expect(p.transactions[0].pl_subcategory).toBe('Rekreacija')
  })

  it('falls back to a named category rather than to nothing', () => {
    const { plan: p } = plan(
      [person({ deductions: [deduction({ label: 'Something new' })] })],
      { e1: sheet({ regular_hours: FUND }) })
    expect(p.transactions[0].pl_subcategory).toBe(SYSTEM.payroll_retained_fallback!.pl_subcategory)
  })

  it('sends a FitPass withholding where the manual dialog already sends it', () => {
    // The register spells it "Fitpass mesečna članarina". A storno anywhere
    // else would leave the FitPass expense standing with the reversal sitting
    // beside it under another heading.
    const { plan: p } = plan(
      [person({ deductions: [deduction({ label: 'Fitpass mesečna članarina' })] })],
      { e1: sheet({ regular_hours: FUND }) })
    expect(p.transactions[0].pl_subcategory).toBe(SYSTEM.payroll_fitpass!.pl_subcategory)
  })
})

describe('tax and contributions', () => {
  const { plan: p } = plan([person()], { e1: sheet({ regular_hours: FUND }) })

  it('books ONE payable the bank payment can match, with no P&L of its own', () => {
    const parents = p.invoices.filter(i => i.kind === 'obligation_parent')
    expect(parents).toHaveLength(1)
    expect(parents[0].pl_impact).toBe(false)
  })

  it('carries the P&L on children that each have a department', () => {
    const children = p.invoices.filter(i => i.kind === 'obligation_child')
    expect(children.length).toBeGreaterThan(0)
    expect(children.every(c => c.pl_impact && c.department === 'Development')).toBe(true)
  })

  it('charges the run its full tax and contributions', () => {
    const { run, plan: q } = plan([person()], { e1: sheet({ regular_hours: FUND }) })
    const parent = q.invoices.find(i => i.kind === 'obligation_parent')!
    expect(parent.amount).toBeCloseTo(
      run.totals.incomeTax + run.totals.employeeContributions + run.totals.employerContributions, 1)
  })
})

describe('departments', () => {
  it('finds the mapping for a unit', () => {
    expect(departmentFor('GRAD - Gradilište', MAPPING)?.department).toBe('Development')
    expect(departmentFor('UPR - Uprava', MAPPING)).toBeNull()
  })

  it('names the units nothing maps, rather than defaulting them', () => {
    // The payroll import's old bug: one forgotten dropdown put a whole
    // salary and a whole share of the filing into Unassigned, silently.
    const p = person({ employee: employee({ organisational_unit: 'UPR - Uprava' }) })
    const run = runsFor({
      people: [p], timesheets: { e1: sheet({ regular_hours: FUND }) },
      rates: RATES_2026, monthHours: FUND,
    }).runs.find(r => r.key === 'regular')!
    expect(unmappedUnits(run, { e1: p }, MAPPING)).toEqual(['UPR - Uprava'])
  })

  it('refuses a plan whose entries would land in Unassigned', () => {
    const p = person({ employee: employee({ organisational_unit: 'UPR - Uprava' }) })
    const run = runsFor({
      people: [p], timesheets: { e1: sheet({ regular_hours: FUND }) },
      rates: RATES_2026, monthHours: FUND,
    }).runs.find(r => r.key === 'regular')!
    const q = planFor({ run, month: MONTH, people: { e1: p }, mapping: [], system: SYSTEM })
    expect(checkPlan(q)).toContain('bez sektora')
  })
})

describe('checkPlan', () => {
  const good = plan([person()], { e1: sheet({ regular_hours: FUND }) }).plan

  it('passes a plan that adds up', () => {
    expect(checkPlan(good)).toBeNull()
  })

  it('refuses one that does not, and says by how much', () => {
    const broken = { ...good, expectedTotalCost: good.expectedTotalCost + 500 }
    const why = checkPlan(broken)!
    expect(why).toMatch(/-500\.0\d/)
    expect(why).toContain('Ništa nije upisano')
  })

  it('refuses a negative payable', () => {
    // Deductions larger than the salary they come out of. A negative invoice
    // is not a thing, and it would sit in the ledger looking like a credit.
    const broken = {
      ...good,
      invoices: good.invoices.map(i =>
        i.kind === 'net' ? { ...i, amount: -50 } : i),
    }
    expect(checkPlan(broken)).toContain('negativna faktura')
  })
})

describe('the notes', () => {
  it('say which month and which run every entry came from', () => {
    // A posted payroll is found again months later from a bank statement, by
    // somebody who was not here when it was made.
    const { plan: p } = plan(
      [person({ deductions: [deduction({ goes_to: 'third_party', amount: 2500 })] })],
      { e1: sheet({ regular_hours: FUND }) })
    expect(p.invoices.every(i => i.note.includes('2026-08'))).toBe(true)
    expect(p.invoices.every(i => i.note.includes(RUN_LABELS.regular))).toBe(true)
    expect(p.invoices.find(i => i.kind === 'net')!.note).toContain('nakon prosleđenih 2500')
  })

  it('puts every salary entry under one subcategory the P&L already knows', () => {
    const { plan: p } = plan([person()], { e1: sheet({ regular_hours: FUND }) })
    expect(p.invoices.find(i => i.kind === 'net')!.pl_subcategory).toBe(NET_SUBCATEGORY)
  })
})

const round = (n: number) => Math.round(n * 100) / 100

describe('the ledger has to recognise every heading', () => {
  const known = {
    plSubcategories: ['Neto zarade', 'Porez na zarade',
      'Doprinosi na teret zaposlenog',
      'Doprinosi na teret poslodavca'],
    departments: ['Development'],
    deptSubcategories: ['Engineering', 'Zarade u zemlji'],
  }

  it('passes a plan whose every name the ledger already has', () => {
    const { plan: p } = plan([person()], { e1: sheet({ regular_hours: FUND }) })
    expect(checkPlan(p, known)).toBeNull()
  })

  it('refuses a department the ledger has never heard of', () => {
    // The worst outcome available: a name one character out creates a second
    // heading beside the real one and the P&L shows both.
    const { plan: p } = plan([person()], { e1: sheet({ regular_hours: FUND }) })
    const why = checkPlan(p, { ...known, departments: ['Somewhere else'] })!
    expect(why).toContain('Development')
    expect(why).toContain('Ništa nije upisano')
  })

  it('checks nothing when no list is given, so an old caller still works', () => {
    const { plan: p } = plan([person()], { e1: sheet({ regular_hours: FUND }) })
    expect(checkPlan(p)).toBeNull()
  })
})

describe('other income does not post as a salary', () => {
  it('goes to the person’s department, but not among the net salaries', () => {
    const { plan: p } = plan(
      [person()], { e1: sheet({ regular_hours: FUND }) }, 'other',
      { additions: [{
        id: 'x1', employee_id: 'e1', month: '2026-08-01', kind: 'other',
        label: 'Referral', treatment: 'other_income', amount: 20000, currency: 'RSD', note: null,
      }] })
    const o = p.invoices.find(i => i.kind === 'other_income')!
    expect(o.pl_subcategory).toBe('Naknade i ostala primanja')
    expect(o.pl_subcategory).not.toBe(NET_SUBCATEGORY)
    expect(o.department).toBe('Development')
    expect(o.amount).toBe(20000)
    expect(o.note).toContain('Ostala primanja')
  })
})

describe('a salary carries the standard sub-category', () => {
  it('files it under Salary expenses domestic when the allocation says nothing', () => {
    const { plan: p } = plan([person()], { e1: sheet({ regular_hours: FUND }) })
    expect(p.invoices.find(i => i.kind === 'net')!.dept_subcategory).toBe('Engineering')
  })
})

describe('where a retained deduction is cancelled', () => {
  it('sends private health insurance to the heading the ledger has for it', () => {
    // Six are named "Privatno zdravstveno osiguranje <person>" and one
    // "Osigurani članovi porodice …" — all cover somebody's family.
    const { plan: a } = plan(
      [person({ deductions: [deduction({ label: 'Privatno zdravstveno osiguranje Lena Gavrilov' })] })],
      { e1: sheet({ regular_hours: FUND }) })
    expect(a.transactions[0].pl_subcategory).toBe('Privatno zdravstveno osiguranje')

    const { plan: b } = plan(
      [person({ deductions: [deduction({ label: 'Osigurani članovi porodice Jovana' })] })],
      { e1: sheet({ regular_hours: FUND }) })
    expect(b.transactions[0].pl_subcategory).toBe('Privatno zdravstveno osiguranje')
  })

  it('falls back to the fallback role, not to a name written in code', () => {
    // It used to fall back to a Mintflow name; MCFlow's P&L is the owner's own.
    expect(retainedRoleFor('Nešto novo')).toBe('payroll_retained_fallback')
    expect(retainedRoleFor('Fitpass mesečna članarina')).toBe('payroll_fitpass')
    expect(retainedRoleFor('Osigurani članovi porodice Jovana')).toBe('payroll_health_insurance')
  })
})

describe('projects, by hours', () => {
  const build = (projectHours: Record<string, { project_id: string; hours: number }[]>,
    timesheet = sheet({ regular_hours: FUND })) => {
    const input: RunInput = {
      people: [person({ deductions: [deduction({ goes_to: 'third_party', payee: 'Bank' })] })],
      timesheets: { e1: timesheet }, rates: RATES_2026, monthHours: FUND,
      currencyRates: { EUR: 117.3586 }, coefficients: { godisnji_odmor: 1 },
    }
    const result = runsFor(input)
    const run = result.runs.find(r => r.key === 'regular')!
    return {
      run,
      plan: planFor({
        run, month: MONTH, people: { e1: input.people[0] }, mapping: MAPPING,
        currencyRates: { EUR: 117.3586 }, system: SYSTEM,
        projectHours, hoursBasis: hoursBasisFromRuns(result.runs),
      }),
    }
  }

  it('changes only the attribution: the month posts the same total', () => {
    const before = build({})
    const after = build({ e1: [{ project_id: 'a', hours: 100 }, { project_id: 'b', hours: 40 }] })
    expect(planTotal(after.plan)).toBe(planTotal(before.plan))
    expect(checkPlan(after.plan)).toBeNull()
    // Everything overhead without project rows.
    expect(planProjectTotals(before.plan).map(t => t.project_id)).toEqual([null])
  })

  it('splits every one of the person\'s P&L invoices by the same hours, each adding up exactly', () => {
    const { plan: p } = build({ e1: [{ project_id: 'a', hours: 100 }, { project_id: 'b', hours: 40 }] })
    const pl = p.invoices.filter(i => i.pl_impact)
    expect(pl.map(i => i.kind)).toEqual(expect.arrayContaining(['net', 'third_party', 'obligation_child']))
    for (const i of pl) {
      expect(i.projects.map(l => l.project_id)).toEqual(['a', 'b', null])
      expect(Math.round(i.projects.reduce((s, l) => s + l.amount, 0) * 100)).toBe(Math.round(i.amount * 100))
    }
    const totals = planProjectTotals(p)
    const all = totals.reduce((s, t) => s + t.amount, 0)
    expect(totals.find(t => t.project_id === 'a')!.amount / all).toBeCloseTo(100 / FUND, 3)
    // The parent payable is not in the P&L and carries no projects.
    expect(p.invoices.find(i => i.kind === 'obligation_parent')!.projects).toEqual([])
  })

  it('puts the share of paid leave in overhead', () => {
    const { plan: p } = build(
      { e1: [{ project_id: 'a', hours: FUND - 16 }] },
      sheet({ regular_hours: FUND - 16, vacation_hours: 16 }))
    const totals = planProjectTotals(p)
    const all = totals.reduce((s, t) => s + t.amount, 0)
    expect(totals.find(t => t.project_id === null)!.amount / all).toBeCloseTo(16 / FUND, 3)
  })

  it('refuses a month with more hours on projects than worked', () => {
    const { plan: p } = build({ e1: [{ project_id: 'a', hours: FUND + 1 }] })
    expect(p.projectErrors).toHaveLength(1)
    expect(checkPlan(p)).toMatch(/previše/)
  })

  it('writes no allocation codes', () => {
    const { plan: p } = build({})
    for (const i of p.invoices) {
      expect('rev_alloc_type' in i).toBe(false)
      expect('opex_type' in i).toBe(false)
    }
  })
})

describe('the system categories decide every heading', () => {
  const without = (...roles: (keyof typeof SYSTEM)[]): SystemCategoryMap => {
    const m: SystemCategoryMap = { ...SYSTEM }
    for (const r of roles) delete m[r]
    return m
  }

  it('posts under the owner\'s own names and nothing else', () => {
    const { plan: p } = plan([person()], { e1: sheet({ regular_hours: FUND }) })
    const cats = new Set([...p.invoices, ...p.transactions].map(i => i.pl_category))
    expect([...cats]).toEqual(['Zarade'])
    expect(p.invoices.filter(i => i.kind === 'obligation_child').map(i => i.pl_subcategory).sort())
      .toEqual(['Doprinosi na teret poslodavca', 'Doprinosi na teret zaposlenog', 'Porez na zarade'])
    expect(p.classificationErrors).toEqual([])
  })

  it('REFUSES the plan when the net-salary role is not set', () => {
    const { plan: p } = plan([person()], { e1: sheet({ regular_hours: FUND }) }, 'regular', {},
      without('payroll_net_salary'))
    const why = checkPlan(p)!
    expect(why).toContain('Sistemska kategorija „Neto zarade“ nije podešena')
    expect(why).toContain('Podešavanja → Sistemske kategorije')
    expect(why).toContain('Ništa nije upisano')
  })

  it('refuses when a contribution role is not set', () => {
    const { plan: p } = plan([person()], { e1: sheet({ regular_hours: FUND }) }, 'regular', {},
      without('payroll_employer_contributions'))
    expect(checkPlan(p)).toContain('„Doprinosi na teret poslodavca“')
  })

  it('asks only for the roles the month needs', () => {
    // No other income, no retained deduction, every allocation names its
    // podsektor: those three roles may stay unset.
    const { plan: p } = plan([person()], { e1: sheet({ regular_hours: FUND }) }, 'regular', {},
      without('payroll_other_income', 'payroll_retained_fallback', 'payroll_fitpass',
        'payroll_salary_dept_subcategory', 'credit_principal'))
    expect(checkPlan(p)).toBeNull()
  })

  it('refuses a FitPass withholding when the FitPass role is not set', () => {
    const { plan: p } = plan(
      [person({ deductions: [deduction({ label: 'Fitpass mesečna članarina' })] })],
      { e1: sheet({ regular_hours: FUND }) }, 'regular', {}, without('payroll_fitpass'))
    expect(checkPlan(p)).toContain('„FitPass“ nije podešena')
  })

  it('uses the salary podsektor role when the mapping names none', () => {
    const noSub: UnitMapping[] = [{ ...MAPPING[0], dept_subcategory: null }]
    const p = person()
    const run = runsFor({
      people: [p], timesheets: { e1: sheet({ regular_hours: FUND }) },
      rates: RATES_2026, monthHours: FUND,
    }).runs.find(r => r.key === 'regular')!
    const q = planFor({ run, month: MONTH, people: { e1: p }, mapping: noSub, system: SYSTEM })
    expect(q.invoices.find(i => i.kind === 'net')!.dept_subcategory).toBe('Zarade u zemlji')
    const r = planFor({
      run, month: MONTH, people: { e1: p }, mapping: noSub,
      system: without('payroll_salary_dept_subcategory'),
    })
    expect(checkPlan(r)).toContain('„Podsektor za zarade“')
  })

  it('refuses a hand-built plan with a row under no heading', () => {
    const { plan: p } = plan([person()], { e1: sheet({ regular_hours: FUND }) })
    const broken = { ...p, invoices: p.invoices.map(i => i.kind === 'net' ? { ...i, pl_category: '' } : i) }
    expect(checkPlan(broken)).toContain('nema P&L kategoriju')
  })
})
