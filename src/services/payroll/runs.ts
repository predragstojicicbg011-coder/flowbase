// ─── The monthly runs ───────────────────────────────────────────────────────
//
// Two runs a month, and they are two kinds of money rather than two groups of
// people:
//
//   Salaries       everybody, on every paid hour — work and paid leave alike
//   Other income   additions that are not part of a salary, taxed once and
//                  with no contributions
//
// WHAT GOES IN A SALARY IS EVERY PAID HOUR, and that includes ANNUAL LEAVE.
// Worked hours and paid absences go into one line together, each absence
// reduced to what it is worth first, which is what the accountant's sheet does.
//
// EVERY ABSENCE IS PAID AT ITS OWN COEFFICIENT, from the settings for that
// month. Eight hours of sick leave at the employer's expense are worth 5.2 and
// eight hours of annual leave are worth eight, and the difference between them
// is the whole reason the timesheet has a column for each. A category the
// settings do not price contributes NOTHING and is reported by name — a
// coefficient guessed at is a salary guessed at.
//
// A PART MONTH IS A PERIOD, NOT A PERCENTAGE. Each salary passes the engine
// `{ monthHours, workedHours }` and lets it prorate — the contracted net, the
// tax-free allowance, the meal and holiday allowances all scale the same way,
// and that is a property of the engine rather than something re-implemented
// here. Multiplying a finished salary by a fraction instead would prorate the
// tax-free amount twice over and land a few hundred dinars out per person,
// per month, in the direction nobody checks.
//
// THE CONTRIBUTION CEILING IS A LIMIT ON A PERSON'S MONTH, and that is worth
// the two passes it costs. Somebody's month is grossed up with no ceiling
// first; only if the whole of it passes the monthly maximum is a ceiling
// applied, prorated by the hours the salary covers.
//
// Applying a prorated ceiling unconditionally is the mistake this replaces.
// Milosavljević Đuro worked 72 hours in September and was paid a large one-off,
// grossing to 569,091.70 — well under the monthly limit, so MPP charged his
// contributions on all of it. Prorated by his hours the ceiling came to
// 299,790, capping a man who should never have been capped and understating
// his gross by 59,546 dinars.

import {
  salaryLine, otherIncomeLine,
  type PayrollRates, type SalaryLine, type OtherIncomeLine, type BaseLimits,
} from './engine'
import { splitDeductions, type EmployeeForMonth } from './employees'
import {
  additionsFor, amountInDinars, totalsFor, unconvertible, type AdditionRow,
} from './additions'
import {
  effectiveHours, hoursByCategory, unpricedCategories,
  type HoursAtRate, type TimesheetRow,
} from './timesheets'

export type RunKey = 'regular' | 'other'

export const RUN_LABELS: Record<RunKey, string> = {
  regular: 'Zarade',
  other: 'Ostala primanja',
}

export const RUN_DESCRIPTIONS: Record<RunKey, string> = {
  regular: 'Svi zaposleni na obračunu, za svaki plaćeni sat u mesecu.',
  other: 'Dodaci koji nisu deo zarade: ostala primanja, oporezovana jednom i bez '
    + 'doprinosa, i sve što se isplaćuje bez poreza.',
}

export interface SalaryRunLine {
  employeeId: string
  name: string
  code: string | null
  /** Сати у обрачуну — the hours THIS run is calculated on. */
  hours: number
  /** Фонд сати у месецу, the denominator the hours are prorated against. */
  monthHours: number
  /** What those hours were made of, each already at its coefficient. */
  categories: HoursAtRate[]
  /** The contracted net for a full month, in dinars. */
  contractedNet: number
  seniorityNet: number
  line: SalaryLine
  /** Deductions, applied once a month and never twice. See `runsFor`. */
  deductions: { thirdParty: number; employer: number; total: number }
  /** The additions folded into this line's net, by name, for the payslip. */
  additions: AdditionRow[]
}

/** One addition paid outside a salary. */
export interface OtherIncomeRunLine {
  employeeId: string
  name: string
  code: string | null
  line: OtherIncomeLine
}

export interface PayrollRun {
  key: RunKey
  label: string
  salaries: SalaryRunLine[]
  otherIncome: OtherIncomeRunLine[]
  totals: {
    gross: number
    net: number
    incomeTax: number
    employeeContributions: number
    employerContributions: number
    /** What the employer owes. */
    totalCost: number
    deductionsThirdParty: number
    deductionsEmployer: number
  }
}

export interface RunProblem {
  employeeId: string
  name: string
  why: string
}

export interface MonthRuns {
  runs: PayrollRun[]
  /**
   * Anybody who could not be calculated, by name.
   *
   * Returned rather than thrown, because one person without a timesheet must
   * not hide the other twenty-four — but a run with anything in here is not a
   * check of anything, since the missing person makes the total agree with
   * nothing.
   */
  problems: RunProblem[]
}

export interface RunInput {
  people: EmployeeForMonth[]
  timesheets: Record<string, TimesheetRow>
  rates: PayrollRates
  /** Фонд сати у месецу. */
  monthHours: number
  /** The middle rates on the 20th, for euro deductions. */
  currencyRates?: Record<string, number>
  /**
   * Коефицијенти, by settings key, for the month being calculated.
   *
   * Without them every absence is worth nothing and the month is reported as
   * unpriced rather than quietly paid at the wrong rate.
   */
  coefficients?: Record<string, number | null>
  /** Bonuses and the rest, for this month. */
  additions?: AdditionRow[]
  /**
   * `YYYY-MM`, for filtering the additions.
   *
   * The caller usually fetches a single month's worth already, but an
   * addition from the wrong month reaching a salary is a bonus paid twice —
   * so it is filtered here as well rather than trusted.
   */
  month?: string
}

// No seniority coefficient here on purpose: by the time a person reaches a
// run, `EmployeeForMonth.net` has already been split into base and seniority
// by the roster. Passing the coefficient again would be a second place the
// split could be done, and a second place it could be done differently.

/**
 * The runs for a month.
 *
 * ONE SALARY LINE PER PERSON, carrying their deductions and their additions.
 * Deductions are a monthly arrangement — a membership, an insurance premium —
 * not a function of hours, so they come off the month once and in full.
 */
export function runsFor(input: RunInput): MonthRuns {
  const { people, timesheets, rates, monthHours } = input
  const currencyRates = input.currencyRates ?? {}
  const coefficients = input.coefficients ?? {}
  const additions = input.additions ?? []
  const problems: RunProblem[] = []

  const empty = (key: RunKey): PayrollRun => ({
    key, label: RUN_LABELS[key], salaries: [], otherIncome: [], totals: zeroTotals(),
  })
  const runs: Record<RunKey, PayrollRun> = {
    regular: empty('regular'), other: empty('other'),
  }

  for (const p of people) {
    const name = p.employee.full_name
    const t = timesheets[p.employee.id]

    if (!t) {
      problems.push({
        employeeId: p.employee.id, name,
        why: 'Nema evidencije radnog vremena za ovaj mesec, pa zaposleni nije obračunat. '
          + 'Unesite evidenciju i ponovo obračunajte.',
      })
      continue
    }

    const categories = hoursByCategory(t, coefficients)
    // Everything paid, each category already reduced to what it is worth.
    // They are one figure because the calculation does not distinguish them.
    const paid = effectiveHours(t, coefficients)

    const unpriced = unpricedCategories(t, coefficients)
    if (unpriced.length > 0) {
      problems.push({
        employeeId: p.employee.id, name,
        why: `Podešavanja ne određuju koeficijent za ${unpriced.map(u => `${u.label.toLowerCase()} `
          + `(${u.hours} h)`).join(', ')} u ovom mesecu. Ti sati su u iznosima ispod obračunati `
          + 'kao nula, umesto po pretpostavljenoj stopi. Unesite koeficijent na kartici Zarade '
          + 'u Podešavanjima i ponovo obračunajte.',
      })
    }

    if (paid <= 0) {
      // Not a problem: a whole month of sick or unpaid leave is a real month.
      // It produces no salary line because there is nothing to pay at the
      // contracted rate.
      continue
    }

    const mine = input.month
      ? additionsFor(additions, p.employee.id, input.month)
      : additions.filter(a => a.employee_id === p.employee.id)
    const cannotConvert = unconvertible(mine, currencyRates)
    if (cannotConvert.length > 0) {
      problems.push({
        employeeId: p.employee.id, name,
        why: `Dodaci u valuti bez kursa za ovaj mesec (${cannotConvert.length}) nisu uračunati `
          + 'u iznose ispod. Stvarno dugovanje je veće '
          + 'od prikazanog. Unesite kurs i ponovo obračunajte.',
      })
    }
    const extra = totalsFor(mine, currencyRates)

    const deductions = splitDeductions(p.deductions, p.net.total, currencyRates)

    // ── The two passes ────────────────────────────────────────────────────
    //
    // The month grossed with no ceiling, so it can be measured against the
    // monthly limit before it is charged against a share of it.
    const inputFor = (baseLimits?: BaseLimits) => ({
      contractedNet: p.net.total,
      period: { monthHours, workedHours: paid },
      seniorityNet: p.net.seniority,
      additionalNet: extra.salary,
      baseLimits,
    })
    const monthGross = salaryLine(inputFor(), rates).gross

    // The ceiling only exists once the month as a whole passes it. Below it,
    // contributions follow the salary and there is nothing to apply.
    const overCeiling = rates.maximumBase > 0 && monthGross > rates.maximumBase
    const underFloor = rates.minimumBase > 0 && monthGross > 0
      && monthGross < rates.minimumBase
    const share = monthHours > 0 ? paid / monthHours : 0
    const limits: BaseLimits | undefined = overCeiling
      ? { min: 0, max: round2(rates.maximumBase * share) }
      : underFloor
        ? { min: round2(rates.minimumBase * share), max: 0 }
        : undefined

    runs.regular.salaries.push({
      employeeId: p.employee.id, name, code: p.employee.code,
      hours: paid, monthHours,
      // What those hours were made of, so a payslip can show the parts and
      // somebody can see why a month came to less than its fund.
      categories,
      contractedNet: p.net.total,
      seniorityNet: p.net.seniority,
      line: salaryLine(inputFor(limits), rates),
      deductions: {
        thirdParty: deductions.thirdParty, employer: deductions.employer, total: deductions.total,
      },
      additions: mine.filter(a => a.treatment === 'salary'),
    })

    if (deductions.unconvertible.length > 0) {
      problems.push({
        employeeId: p.employee.id, name,
        why: `Obustave u valuti bez kursa za ovaj mesec (${deductions.unconvertible.length}) `
          + 'nisu uračunate u zbirove. Zarada je tačna, '
          + 'ali zadržani iznos nije. Unesite kurs i ponovo obračunajte.',
      })
    }

    // Anything not part of a salary gets its own run. Other income is taxed
    // once with no contributions; the untaxed kind is the same machinery with
    // the whole amount exempt, which leaves the tax at nothing.
    for (const a of mine) {
      if (a.treatment === 'salary') continue
      const amount = amountInDinars(a, currencyRates)
      if (!(amount > 0)) continue
      runs.other.otherIncome.push({
        employeeId: p.employee.id,
        name: `${name} — ${a.label}`,
        code: p.employee.code,
        line: otherIncomeLine(
          { net: amount, taxFree: a.treatment === 'non_taxable' ? amount : 0 },
          rates),
      })
    }
  }

  for (const key of Object.keys(runs) as RunKey[]) total(runs[key])

  return {
    runs: [runs.regular, runs.other],
    problems,
  }
}

/** Every run added together — what the month costs in total. */
export function grandTotal(runs: PayrollRun[]): PayrollRun['totals'] {
  const t = zeroTotals()
  for (const r of runs) {
    for (const k of Object.keys(t) as (keyof PayrollRun['totals'])[]) {
      t[k] = round2(t[k] + r.totals[k])
    }
  }
  return t
}

function total(run: PayrollRun): void {
  const t = zeroTotals()
  for (const s of run.salaries) {
    t.gross += s.line.gross
    t.net += s.line.net
    t.incomeTax += s.line.incomeTax
    t.employeeContributions += s.line.employeeContributions
    t.employerContributions += s.line.employerContributions
    t.totalCost += s.line.totalCost
    t.deductionsThirdParty += s.deductions.thirdParty
    t.deductionsEmployer += s.deductions.employer
  }
  for (const o of run.otherIncome) {
    t.gross += o.line.gross
    t.net += o.line.net
    t.incomeTax += o.line.incomeTax
    t.totalCost += o.line.totalCost
  }
  for (const k of Object.keys(t) as (keyof PayrollRun['totals'])[]) t[k] = round2(t[k])
  run.totals = t
}

function zeroTotals(): PayrollRun['totals'] {
  return {
    gross: 0, net: 0, incomeTax: 0, employeeContributions: 0,
    employerContributions: 0, totalCost: 0,
    deductionsThirdParty: 0, deductionsEmployer: 0,
  }
}

const round2 = (n: number): number => Math.round(n * 100) / 100
