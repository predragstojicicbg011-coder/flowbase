import {
  employedOn, contractOn, deductionsOn, deductionAmount, splitDeductions,
  employeesForMonth, amountInDinars, whyContractNotSavable, supersedeContract,
  rateDateFor, serviceYearsFor, absenceOn, absenceLabel, ABSENCE_REASONS,
  employedDuring, endOfMonthFor, coveringMonth, deductionWarning, looksLikeSameParty,
  soleCompanyOf, contractGaps, editingContractLeaves,
  type EmployeeRow, type ContractRow, type DeductionRow, type AbsenceRow,
} from './employees'

const AUGUST = '2026-08-01'
const COEF = 0.004
const RATES = { EUR: 117.3586 }

const employee = (over: Partial<EmployeeRow> = {}): EmployeeRow => ({
  id: 'e1', company_id: 'c1', code: 'E001', full_name: 'Petrović Ana',
  organisational_unit: 'Gradilište',
  hired_on: null, seniority_from: '2025-06-02', left_on: null, note: null,
  deleted_at: null, ...over,
})

const contract = (over: Partial<ContractRow> = {}): ContractRow => ({
  id: 'k1', employee_id: 'e1', valid_from: '2026-01-01', valid_to: null,
  currency: 'EUR', net_amount: 3000, service_years: null,
  note: null, ...over,
})

const deduction = (over: Partial<DeductionRow> = {}): DeductionRow => ({
  id: 'd1', employee_id: 'e1', label: 'Loan', goes_to: 'third_party',
  payee: 'Bank', amount: 10000, currency: 'RSD', percent_of_net: null,
  valid_from: '2026-01-01', valid_to: null, is_active: true, note: null, ...over,
})

describe('employedOn', () => {
  it('counts somebody hired before the month', () => {
    expect(employedOn(employee({ hired_on: '2025-03-01' }), AUGUST)).toBe(true)
  })

  it('leaves out somebody not yet hired', () => {
    expect(employedOn(employee({ hired_on: '2026-09-01' }), AUGUST)).toBe(false)
  })

  it('still counts the month somebody left in', () => {
    // `left_on` is the last day worked, and that month is paid.
    expect(employedOn(employee({ left_on: '2026-08-20' }), AUGUST)).toBe(true)
  })

  it('leaves out somebody who left before the month', () => {
    expect(employedOn(employee({ left_on: '2026-07-31' }), AUGUST)).toBe(false)
  })

  it('leaves out a deleted record', () => {
    expect(employedOn(employee({ deleted_at: '2026-02-02' }), AUGUST)).toBe(false)
  })
})

describe('the contract in force', () => {
  const contracts = [
    contract({ id: 'old', valid_from: '2025-01-01', valid_to: '2026-06-01', net_amount: 2500 }),
    contract({ id: 'new', valid_from: '2026-06-01', valid_to: null, net_amount: 3000 }),
  ]

  it('gives the one that applied, not the latest', () => {
    // The reason contracts are dated at all: recalculating March must not use
    // the June pay rise.
    expect(contractOn(contracts, 'e1', '2026-03-01')?.id).toBe('old')
    expect(contractOn(contracts, 'e1', AUGUST)?.id).toBe('new')
  })

  it('gives nothing before the first contract', () => {
    expect(contractOn(contracts, 'e1', '2024-01-01')).toBeNull()
  })

  it('does not hand over another employee contract', () => {
    expect(contractOn(contracts, 'someone-else', AUGUST)).toBeNull()
  })
})

describe('amountInDinars', () => {
  it('converts a euro contract at the rate of the 20th', () => {
    expect(amountInDinars(contract(), RATES)).toBeCloseTo(352075.80, 2)
  })

  it('leaves a dinar contract alone, with no rate needed', () => {
    expect(amountInDinars(contract({ currency: 'RSD', net_amount: 120000 }), {})).toBe(120000)
  })

  it('returns nothing when the rate for the month is unknown', () => {
    expect(amountInDinars(contract(), {})).toBeNull()
  })
})

describe('deductions', () => {
  it('takes a fixed amount as it stands', () => {
    expect(deductionAmount(deduction({ amount: 10000 }), 250000)).toBe(10000)
  })

  it('takes a percentage of the net actually payable', () => {
    expect(deductionAmount(deduction({ amount: null, percent_of_net: 0.10 }), 250000)).toBe(25000)
  })

  it('never deducts more than the net', () => {
    // A negative payslip is not a thing, and it would flow into the ledger as
    // one rather than stopping anything.
    expect(deductionAmount(deduction({ amount: 400000 }), 250000)).toBe(250000)
  })

  it('splits what leaves the company from what stays', () => {
    // The whole reason the column exists: one is a payable, the other is not,
    // and booking them alike misstates the month.
    const split = splitDeductions([
      deduction({ id: 'a', goes_to: 'third_party', amount: 10000 }),
      deduction({ id: 'b', goes_to: 'employer', amount: 4000 }),
      deduction({ id: 'c', goes_to: 'third_party', amount: null, percent_of_net: 0.02 }),
    ], 250000)
    expect(split.thirdParty).toBe(15000)
    expect(split.employer).toBe(4000)
    expect(split.total).toBe(19000)
  })

  it('leaves out a deduction that had finished', () => {
    const ended = deduction({ valid_from: '2025-01-01', valid_to: '2026-07-01' })
    expect(deductionsOn([ended], 'e1', AUGUST)).toEqual([])
  })

  it('keeps several running at once', () => {
    // Two loans at the same time is ordinary, which is why there is no overlap
    // constraint on this table.
    expect(deductionsOn([deduction({ id: 'a' }), deduction({ id: 'b' })], 'e1', AUGUST)).toHaveLength(2)
  })
})

describe('employeesForMonth', () => {
  const input = { date: AUGUST, seniorityCoefficient: COEF, rates: RATES }

  it('gives the contracted net split into base and seniority', () => {
    const { people } = employeesForMonth([employee()], [contract()], [], input)
    expect(people).toHaveLength(1)
    expect(people[0].net.total).toBeCloseTo(352075.80, 2)
    expect(people[0].net.base).toBeCloseTo(350673.11, 2)
    expect(people[0].net.seniority).toBeCloseTo(1402.69, 2)
  })

  it('reports somebody with no contract instead of leaving them out quietly', () => {
    // Someone silently missing from a payroll is exactly what a check against
    // the accountant is meant to catch, and it would agree with itself.
    const { people, problems } = employeesForMonth([employee()], [], [], input)
    expect(people).toEqual([])
    expect(problems).toHaveLength(1)
    expect(problems[0].employee.full_name).toBe('Petrović Ana')
    expect(problems[0].why).toContain('Nijedan ugovor ne pokriva')
  })

  it('refuses a euro contract with no rate for the month, and says why', () => {
    const { people, problems } = employeesForMonth(
      [employee()], [contract()], [], { ...input, rates: {} })
    expect(people).toEqual([])
    expect(problems[0].why).toContain('Nema kursa za EUR')
    expect(problems[0].why).toContain('pretpostavljenom kursu')
  })

  it('does not complain about somebody who had already left', () => {
    // No contract and no complaint — they are simply not on this payroll.
    const gone = employee({ left_on: '2026-03-31' })
    expect(employeesForMonth([gone], [], [], input))
      .toEqual({ people: [], problems: [], offPayroll: [] })
  })

  it('carries each person deductions for that month', () => {
    const { people } = employeesForMonth(
      [employee()], [contract()],
      [deduction(), deduction({ id: 'd2', valid_to: '2026-02-01' })], input)
    expect(people[0].deductions.map(d => d.id)).toEqual(['d1'])
  })
})

describe('whyContractNotSavable', () => {
  const existing = [contract({ id: 'k1', valid_from: '2026-01-01', valid_to: null })]

  it('accepts a contract starting where the last one ended', () => {
    const closed = [contract({ id: 'k1', valid_to: '2026-09-01' })]
    expect(whyContractNotSavable(
      { valid_from: '2026-09-01', valid_to: null, net_amount: 3200 }, closed)).toBeNull()
  })

  it('refuses a period already covered, and names it', () => {
    const why = whyContractNotSavable(
      { valid_from: '2026-06-01', valid_to: null, net_amount: 3200 }, existing)
    expect(why).toContain('01.01.2026.')
    expect(why).toContain('dve zarade')
  })

  it('lets a contract be edited without clashing with itself', () => {
    expect(whyContractNotSavable(
      { id: 'k1', valid_from: '2026-01-01', valid_to: null, net_amount: 3000 }, existing)).toBeNull()
  })

  it('refuses a contract with no amount', () => {
    expect(whyContractNotSavable(
      { valid_from: '2027-01-01', valid_to: null, net_amount: '' }, existing))
      .toMatch(/ugovoreni neto iznos/)
  })

  it('refuses a range that ends before it starts', () => {
    expect(whyContractNotSavable(
      { valid_from: '2027-06-01', valid_to: '2027-01-01', net_amount: 3000 }, []))
      .toMatch(/posle datuma početka/)
  })
})

describe('supersedeContract', () => {
  it('ends the old contract on the day the new one starts', () => {
    // A pay rise closes the old row; it never edits it. Editing would rewrite
    // what the earlier months cost.
    expect(supersedeContract(contract({ id: 'k1' }), '2026-09-01'))
      .toEqual({ id: 'k1', valid_to: '2026-09-01' })
  })
})

describe('rateDateFor', () => {
  it('takes the rate of the 20th, whichever day of the month is asked for', () => {
    // Kalemar always converts at the 20th, so a run must not depend on
    // the day somebody happened to open the page.
    expect(rateDateFor('2026-08')).toBe('2026-08-20')
    expect(rateDateFor('2026-08-01')).toBe('2026-08-20')
  })
})

describe('serviceYearsFor', () => {
  it('counts the years from the seniority date when nothing overrides it', () => {
    const { years, derived } = serviceYearsFor(
      employee({ seniority_from: '2020-03-04' }), contract(), AUGUST)
    expect(years).toBe(6)
    expect(derived).toBe(true)
  })

  it('goes up on the anniversary without anybody editing anything', () => {
    // The reason this is derived at all: a stored number is true for one month
    // and then silently underpays, in a column nobody would think to look at.
    const e = employee({ seniority_from: '2022-03-01' })
    expect(serviceYearsFor(e, contract(), '2027-02-01').years).toBe(4)
    expect(serviceYearsFor(e, contract(), '2027-03-01').years).toBe(5)
  })

  it('uses the contract figure when one was entered by hand', () => {
    // The override exists for where MPP disagrees, and MPP is the standard.
    const { years, derived } = serviceYearsFor(
      employee({ seniority_from: '2020-03-04' }),
      contract({ service_years: 9 }), AUGUST)
    expect(years).toBe(9)
    expect(derived).toBe(false)
  })

  it('treats an override of zero as an override, not as absent', () => {
    expect(serviceYearsFor(
      employee({ seniority_from: '2015-01-01' }),
      contract({ service_years: 0 }), AUGUST)).toEqual({ years: 0, derived: false })
  })

  it('gives no seniority to somebody with no seniority date', () => {
    expect(serviceYearsFor(employee({ seniority_from: null }), contract(), AUGUST).years).toBe(0)
  })

  it('reaches the roster, so a month shows the years it used', () => {
    const { people } = employeesForMonth(
      [employee({ seniority_from: '2020-03-04' })], [contract()], [],
      { date: AUGUST, seniorityCoefficient: COEF, rates: RATES })
    expect(people[0].serviceYears).toBe(6)
    expect(people[0].serviceYearsDerived).toBe(true)
    // 3000 EUR at 117.3586 is 352,075.80, of which six years is 2.4%.
    expect(people[0].net.seniority).toBeCloseTo(8251.78, 2)
  })
})

describe('employed, and not on this payroll', () => {
  const absence = (over: Partial<AbsenceRow> = {}): AbsenceRow => ({
    id: 'a1', employee_id: 'e1', reason: 'maternity',
    valid_from: '2026-09-01', valid_to: null, note: null, ...over,
  })
  const input = { date: AUGUST, seniorityCoefficient: COEF, rates: RATES }
  const sept = { ...input, date: '2026-09-01' }

  it('takes somebody on maternity leave off the month, by name', () => {
    // The state calculates and pays it. A month that included her would be
    // wrong by a whole person in a direction nobody would question — the
    // figure would simply be there.
    const r = employeesForMonth([employee()], [contract()], [], sept, [], [absence()])
    expect(r.people).toEqual([])
    expect(r.offPayroll).toHaveLength(1)
    expect(r.offPayroll[0].employee.full_name).toBe('Petrović Ana')
    expect(r.offPayroll[0].absence.reason).toBe('maternity')
  })

  it('does NOT report them as a problem', () => {
    // Nothing is wrong. A complaint that cannot be acted on teaches people to
    // ignore the panel it sits in, and that panel is where a genuinely
    // missing person appears.
    const r = employeesForMonth([employee()], [contract()], [], sept, [], [absence()])
    expect(r.problems).toEqual([])
  })

  it('leaves the months before it alone', () => {
    // A period, not a switch. A flag would be true now and wrong for every
    // month before it was set.
    const r = employeesForMonth([employee()], [contract()], [], input, [], [absence()])
    expect(r.people).toHaveLength(1)
    expect(r.offPayroll).toEqual([])
  })

  it('puts them back on the month they return', () => {
    const back = absence({ valid_to: '2027-03-01' })
    const march = { ...input, date: '2027-03-01' }
    expect(employeesForMonth([employee()], [contract()], [], march, [], [back]).people)
      .toHaveLength(1)
  })

  it('reports being off the payroll rather than missing a contract', () => {
    // Checked before the contract on purpose: somebody on leave whose contract
    // has lapsed is on leave. "No contract covers this month" is a thing to go
    // and fix; being on maternity leave is not.
    const r = employeesForMonth([employee()], [], [], sept, [], [absence()])
    expect(r.problems).toEqual([])
    expect(r.offPayroll).toHaveLength(1)
  })

  it('keeps everything about them for when they come back', () => {
    // Not the same as leaving. `left_on` would lose the contract, the
    // department and every deduction, and make the return look like a hire.
    const gone = employee({ left_on: '2026-08-31' })
    expect(employeesForMonth([gone], [contract()], [], sept, [], []).offPayroll).toEqual([])
    expect(employeesForMonth([employee()], [contract()], [], sept, [], [absence()])
      .offPayroll[0].absence.valid_to).toBeNull()
  })
})

describe('absenceOn', () => {
  const rows: AbsenceRow[] = [
    { id: 'a1', employee_id: 'e1', reason: 'maternity',
      valid_from: '2026-09-01', valid_to: '2027-09-01', note: null },
  ]

  it('finds the period covering a month', () => {
    expect(absenceOn(rows, 'e1', '2027-01-01')?.reason).toBe('maternity')
  })

  it('does not cover the month they come back', () => {
    expect(absenceOn(rows, 'e1', '2027-09-01')).toBeNull()
  })

  it('does not hand over somebody else period', () => {
    expect(absenceOn(rows, 'e2', '2027-01-01')).toBeNull()
  })
})

describe('the reasons', () => {
  it('names every one of them in Latin script', () => {
    for (const r of ABSENCE_REASONS) {
      expect(absenceLabel(r.value)).toBe(r.label)
      expect(r.label).not.toMatch(/[Ѐ-ӿ]/)
    }
  })

  it('says plainly that maternity leave is the state paying', () => {
    expect(absenceLabel('maternity')).toContain('isplaćuje država')
  })
})

describe('everybody employed lands in exactly one list', () => {
  // The invariant the employee list is built on. It shows people + offPayroll
  // + problems, so anybody in none of them has a record that exists and no
  // screen that can reach it — which comes back later as a duplicate-key
  // error when somebody tries to create the same person again.
  const input = { date: AUGUST, seniorityCoefficient: COEF, rates: RATES }

  const census = (r: ReturnType<typeof employeesForMonth>) => {
    const ids = [
      ...r.people.map(p => p.employee.id),
      ...r.offPayroll.map(o => o.employee.id),
      ...r.problems.map(p => p.employee.id),
    ]
    return { ids, unique: new Set(ids).size }
  }

  it('places somebody with a contract', () => {
    const r = employeesForMonth([employee()], [contract()], [], input)
    expect(census(r)).toEqual({ ids: ['e1'], unique: 1 })
  })

  it('places somebody with NO contract — a new employee, before anything else', () => {
    // This is the one that was invisible: a person is created, has no
    // contract by definition, and used to appear nowhere in the list.
    const r = employeesForMonth([employee()], [], [], input)
    expect(census(r)).toEqual({ ids: ['e1'], unique: 1 })
    expect(r.problems[0].employee.full_name).toBe('Petrović Ana')
  })

  it('places somebody off the payroll', () => {
    const absence = {
      id: 'a1', employee_id: 'e1', reason: 'maternity' as const,
      valid_from: '2026-01-01', valid_to: null, note: null,
    }
    const r = employeesForMonth([employee()], [contract()], [], input, [], [absence])
    expect(census(r)).toEqual({ ids: ['e1'], unique: 1 })
  })

  it('never places the same person twice', () => {
    const absence = {
      id: 'a1', employee_id: 'e1', reason: 'maternity' as const,
      valid_from: '2026-01-01', valid_to: null, note: null,
    }
    // No contract AND on leave: the leave wins and it is one line, not two.
    const r = employeesForMonth([employee()], [], [], input, [], [absence])
    const c = census(r)
    expect(c.ids.length).toBe(c.unique)
    expect(c.ids).toEqual(['e1'])
  })

  it('places nobody who was not employed that month', () => {
    // They belong to another month, and the page says so separately rather
    // than showing them as a problem with this one.
    const later = employee({ hired_on: '2026-10-01' })
    const r = employeesForMonth([later], [], [], input)
    expect(census(r)).toEqual({ ids: [], unique: 0 })
  })
})

describe('somebody who joined or left mid-month', () => {
  const SEPT = '2026-09-01'
  const input = { date: SEPT, seniorityCoefficient: COEF, rates: RATES }

  // Vučinić Bojana joined on the 7th of September 2026 and worked 144 hours.
  // She was not on September's payroll at all: everything here asked about the
  // FIRST of the month, and she was not employed on it. Her contract and her
  // cost allocation start on the 7th too, so even once she was included she
  // would have arrived with neither of them.
  const joiner = employee({ hired_on: '2026-09-07', seniority_from: '2026-09-07' })
  const theirContract = contract({ valid_from: '2026-09-07', currency: 'RSD', net_amount: 99790 })

  it('puts them on the month they joined', () => {
    const r = employeesForMonth([joiner], [theirContract], [], input)
    expect(r.people).toHaveLength(1)
    expect(r.problems).toEqual([])
  })

  it('finds the contract that starts mid-month', () => {
    const r = employeesForMonth([joiner], [theirContract], [], input)
    expect(r.people[0].contract.valid_from).toBe('2026-09-07')
  })

  it('finds the allocation that starts with them', () => {
    // Otherwise they arrive with no department, and posting refuses a person
    // who is in fact configured.
    const alloc = {
      id: 'al1', employee_id: 'e1', department: 'Office & Administration',
      dept_subcategory: 'Salary expenses domestic',
      valid_from: '2026-09-07', valid_to: null, note: null,
    }
    const r = employeesForMonth([joiner], [theirContract], [], input, [alloc])
    expect(r.people[0].allocation?.department).toBe('Office & Administration')
  })

  it('keeps somebody who left mid-month on that month', () => {
    // Milosavljević Đuro left on the 12th and is paid for September.
    const leaver = employee({ left_on: '2026-09-12' })
    expect(employeesForMonth([leaver], [contract()], [], input).people).toHaveLength(1)
  })

  it('drops them from the month after', () => {
    const leaver = employee({ left_on: '2026-09-12' })
    const october = { ...input, date: '2026-10-01' }
    const r = employeesForMonth([leaver], [contract()], [], october)
    expect(r.people).toEqual([])
    expect(r.problems).toEqual([])
  })

  it('REFUSES a month with two contracts in it', () => {
    // A pay rise partway through. Choosing between them quietly is choosing
    // between two salaries.
    const r = employeesForMonth([employee()], [
      contract({ id: 'a', valid_from: '2026-01-01', valid_to: '2026-09-15' }),
      contract({ id: 'b', valid_from: '2026-09-15', valid_to: null }),
    ], [], input)
    expect(r.people).toEqual([])
    expect(r.problems[0].why).toContain('2 ugovora')
    expect(r.problems[0].why).toContain('dve zarade')
  })
})

describe('employedDuring', () => {
  it('counts anybody whose employment touches the month', () => {
    expect(employedDuring(employee({ hired_on: '2026-09-07' }), '2026-09-01', '2026-09-30')).toBe(true)
    expect(employedDuring(employee({ left_on: '2026-09-12' }), '2026-09-01', '2026-09-30')).toBe(true)
  })

  it('leaves out a month entirely before or after them', () => {
    expect(employedDuring(employee({ hired_on: '2026-10-01' }), '2026-09-01', '2026-09-30')).toBe(false)
    expect(employedDuring(employee({ left_on: '2026-08-31' }), '2026-09-01', '2026-09-30')).toBe(false)
  })
})

describe('endOfMonthFor', () => {
  it('finds the last day, February and all', () => {
    expect(endOfMonthFor('2026-09-01')).toBe('2026-09-30')
    expect(endOfMonthFor('2026-02-15')).toBe('2026-02-28')
    expect(endOfMonthFor('2028-02-01')).toBe('2028-02-29')
  })
})

describe('coveringMonth', () => {
  const rows = [
    { valid_from: '2026-01-01', valid_to: '2026-09-07' },
    { valid_from: '2026-09-07', valid_to: null },
  ]

  it('returns everything that touches the month, not just the first day', () => {
    expect(coveringMonth(rows, '2026-09-01', '2026-09-30')).toHaveLength(2)
  })

  it('leaves out one that ended before it', () => {
    expect(coveringMonth(rows, '2026-10-01', '2026-10-31')).toHaveLength(1)
  })

  it('leaves out one that ends on the first of the month', () => {
    // `[from, to)` throughout: a row ending on the 1st covers nothing in it.
    expect(coveringMonth([{ valid_from: '2026-01-01', valid_to: '2026-09-01' }],
      '2026-09-01', '2026-09-30')).toEqual([])
  })
})

describe('what is wrong with a deduction', () => {
  it('has nothing to say about a deduction that is filled in', () => {
    expect(deductionWarning(deduction({ amount: 1000, goes_to: 'employer' }))).toBeNull()
    expect(deductionWarning(deduction({
      amount: 2500, goes_to: 'third_party', payee: 'Erste Bank',
    }))).toBeNull()
  })

  it('says a third party with nobody named would be owed to no one', () => {
    // `goes_to` decides whether the amount becomes a payable. One owed to
    // nobody is a figure in the ledger with no creditor.
    const w = deductionWarning(deduction({ amount: 2500, goes_to: 'third_party', payee: null }))
    expect(w).toMatch(/primalac nije naveden/)
  })

  it('counts an empty payee as no payee', () => {
    expect(deductionWarning(deduction({
      amount: 2500, goes_to: 'third_party', payee: '   ',
    }))).toMatch(/primalac nije naveden/)
  })

  it('says a row with neither an amount nor a percentage deducts nothing', () => {
    // It does not refuse — `deductionAmount` returns 0 and the person is
    // simply paid more, with nothing anywhere saying why.
    const w = deductionWarning(deduction({ amount: null, percent_of_net: null }))
    expect(w).toMatch(/ništa ne obustavlja/)
  })

  it('says which one wins when both are set', () => {
    // The amount does. That is fine until somebody edits the percentage and
    // nothing changes.
    const w = deductionWarning(deduction({ amount: 1000, percent_of_net: 0.02 }))
    expect(w).toMatch(/procenat se zanemaruje/)
    // And it is the truth about the engine, not a guess at it.
    expect(deductionAmount(deduction({ amount: 1000, percent_of_net: 0.02 }), 100000)).toBe(1000)
  })

  it('reports the emptiest fault first, because it is the one that hides', () => {
    // A third party with no payee AND no amount deducts nothing at all; the
    // missing payee is the lesser of the two and would mask it.
    const w = deductionWarning(deduction({
      amount: null, percent_of_net: null, goes_to: 'third_party', payee: null,
    }))
    expect(w).toMatch(/ništa ne obustavlja/)
  })
})

describe('whether two names are plainly the same party', () => {
  it('sees through the legal form and the town', () => {
    // The register writes the company one way and the companies table
    // another. No exact comparison will ever say these are the same.
    expect(looksLikeSameParty('KALEMAR D.O.O., Beograd', 'Kalemar LLC')).toBe(true)
  })

  it('does not eat the `ad` inside Beograd', () => {
    // `a.d.` is a legal form and `Beograd` ends in those two letters. Without
    // a word boundary the comparison mangles the very names it lines up.
    expect(looksLikeSameParty('Beograd Fond', 'Kalemar LLC')).toBe(false)
  })

  it('says no to two different parties', () => {
    expect(looksLikeSameParty('Wiener Städtische osiguranje', 'Kalemar LLC')).toBe(false)
    expect(looksLikeSameParty('Fitpass d.o.o.', 'Kalemar LLC')).toBe(false)
  })

  it('says no when either side is missing', () => {
    expect(looksLikeSameParty(null, 'Kalemar LLC')).toBe(false)
    expect(looksLikeSameParty('Kalemar', null)).toBe(false)
    expect(looksLikeSameParty('   ', 'Kalemar LLC')).toBe(false)
  })
})

describe('a deduction forwarded to the company paying it', () => {
  const policy = () => deduction({
    goes_to: 'third_party', amount: 57.8, currency: 'EUR',
    payee: 'KALEMAR D.O.O., Beograd',
  })

  it('says so, because it would book a payable owed to itself', () => {
    // The seven private health policies came out of the MPP register naming
    // KALEMAR, because the register records who PAYS. Reclassified as
    // forwarded on, the payee has to become whoever receives the money.
    expect(deductionWarning(policy(), 'Kalemar LLC'))
      .toMatch(/firma koja je isplaćuje/)
  })

  it('has nothing to say once a real recipient is named', () => {
    expect(deductionWarning({ ...policy(), payee: 'Wiener Städtische osiguranje' },
      'Kalemar LLC')).toBeNull()
  })

  it('has nothing to say about a deduction that stays with the employer', () => {
    // There the payee IS this company, and that is the whole point of it.
    expect(deductionWarning({ ...policy(), goes_to: 'employer' }, 'Kalemar LLC')).toBeNull()
  })

  it('stays quiet when nobody said who the payer is', () => {
    expect(deductionWarning(policy())).toBeNull()
  })
})


describe('which company the payroll page should open on', () => {
  it('picks the one company every employee belongs to', () => {
    expect(soleCompanyOf([{ company_id: 'a' }, { company_id: 'a' }])).toBe('a')
  })

  it('PICKS NOTHING once a second company files', () => {
    // Naming Kalemar in the code would be right today and wrong,
    // silently, the morning a second company starts: the selector would keep
    // pointing at the first and a whole company's payroll would be a click
    // nobody knew to make.
    expect(soleCompanyOf([{ company_id: 'a' }, { company_id: 'b' }])).toBeNull()
  })

  it('ignores an employee with no company rather than counting it as another', () => {
    // A missing field is not a company.
    expect(soleCompanyOf([{ company_id: 'a' }, { company_id: null }, {}])).toBe('a')
  })

  it('picks nothing from nobody', () => {
    expect(soleCompanyOf([])).toBeNull()
  })
})

// ─── Correcting a contract rather than superseding it ───────────────────────

describe('contract gaps', () => {
  const c = (id: string, from: string, to: string | null): ContractRow => ({
    id, employee_id: 'e1', valid_from: from, valid_to: to,
    currency: 'EUR', net_amount: 1000, service_years: null, note: null,
  })

  /** Half-open intervals: one ends on the day the next begins, and that is
   *  continuous rather than a one-day hole. */
  it('sees no gap where one contract ends the day the next starts', () => {
    expect(contractGaps([c('a', '2025-01-01', '2026-08-01'), c('b', '2026-08-01', null)]))
      .toEqual([])
  })

  it('finds the days nobody is under contract', () => {
    expect(contractGaps([c('a', '2025-01-01', '2026-06-01'), c('b', '2026-08-01', null)]))
      .toEqual([{ from: '2026-06-01', to: '2026-08-01' }])
  })

  it('reads them in date order whatever order they arrive in', () => {
    expect(contractGaps([c('b', '2026-08-01', null), c('a', '2025-01-01', '2026-06-01')]))
      .toEqual([{ from: '2026-06-01', to: '2026-08-01' }])
  })

  it('leaves an overlap to the check that refuses it', () => {
    expect(contractGaps([c('a', '2025-01-01', null), c('b', '2026-08-01', null)])).toEqual([])
  })

  it('has nothing to say about one contract, or none', () => {
    expect(contractGaps([c('a', '2025-01-01', null)])).toEqual([])
    expect(contractGaps([])).toEqual([])
  })
})

describe('what editing a contract leaves behind', () => {
  const c = (id: string, from: string, to: string | null): ContractRow => ({
    id, employee_id: 'e1', valid_from: from, valid_to: to,
    currency: 'EUR', net_amount: 1000, service_years: null, note: null,
  })
  const book = [c('a', '2025-01-01', '2026-08-01'), c('b', '2026-08-01', null)]

  it('says nothing when only the amount is being corrected', () => {
    expect(editingContractLeaves(book, { id: 'b', valid_from: '2026-08-01', valid_to: null }, '2026-09-29'))
      .toEqual([])
  })

  /**
   * The one that matters: ending the open contract leaves the person with no
   * contract, and a payroll run reports the people it found rather than the
   * ones it did not.
   */
  it('warns that ending the current contract drops the person from payroll', () => {
    const notes = editingContractLeaves(
      book, { id: 'b', valid_from: '2026-08-01', valid_to: '2026-09-01' }, '2026-09-29')
    expect(notes.some(n => /ispada iz/.test(n))).toBe(true)
  })

  it('names the days a moved start date leaves uncovered', () => {
    const notes = editingContractLeaves(
      book, { id: 'b', valid_from: '2026-10-01', valid_to: null }, '2026-09-29')
    expect(notes.some(n => /od 01\.08\.2026\. do 01\.10\.2026\./.test(n))).toBe(true)
  })

  it('says a moved contract will not reproduce the months already run', () => {
    const notes = editingContractLeaves(
      book, { id: 'b', valid_from: '2026-07-01', valid_to: null }, '2026-09-29')
    expect(notes.some(n => /više neće dati isti rezultat/.test(n))).toBe(true)
  })

  it('does not claim a move when the dates are untouched', () => {
    const notes = editingContractLeaves(
      book, { id: 'a', valid_from: '2025-01-01', valid_to: '2026-08-01' }, '2026-09-29')
    expect(notes.some(n => /više neće dati isti rezultat/.test(n))).toBe(false)
  })
})
