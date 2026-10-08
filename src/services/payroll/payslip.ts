// ─── The payslip, as MPP lays it out ────────────────────────────────────────
//
// Built against a real one: "Обрачун зараде и накнаде — Team Regular 2026-08",
// Radović Vladimir. Every figure below was checked against that sheet, and
// the two places worth knowing about are the ones that are not obvious.
//
// THE PARTS ARE A PRESENTATION, NOT A SECOND CALCULATION. MPP shows a gross
// against each part of the salary — regular work, meal, holiday allowance,
// seniority — and those four add up to the gross. They are not four separate
// gross-ups: the whole tax-free relief is applied to the REGULAR WORK line and
// everything else is grossed at the plain factor. On the sheet, 100 of meal
// becomes 142.65, which is 100 / 0.701, while 227,439.15 of regular work
// becomes 319,567.83, which is (227,439.15 − 3,422.10) / 0.701.
//
// So the parts here are worked out the same way and REGULAR WORK TAKES THE
// REMAINDER. That keeps them adding to the gross exactly, whatever rounding or
// a capped contribution base does to the arithmetic — a payslip whose parts do
// not sum to its own total is worse than one that does not show parts.
//
// WHAT IS DELIBERATELY NOT HERE: the employee's home address and their JMBG.
// MPP prints both because MPP produces the document somebody is handed. This
// is a checking tool, and it holds as little about people as it can get away
// with; neither figure helps anybody compare a total against the accountant.

import type { SalaryRunLine } from './runs'
import { deductionAmount, type EmployeeForMonth } from './employees'
import { amountInDinars } from './additions'
import type { PayrollRates } from './engine'

export interface PayslipPart {
  label: string
  /** Blank where a part has no hours of its own, as the allowances do not. */
  hours: number | null
  net: number
  gross: number
}

export interface PayslipRate {
  label: string
  /** As a percentage, the way MPP prints it. */
  percent: number
  amount: number
}

export interface Payslip {
  /** општи подаци */
  contractedNet: number
  seniorityNet: number
  baseNet: number
  serviceYears: number | null
  /** коефицијент минулог рада, as a percentage. */
  seniorityPercent: number | null
  hours: number
  monthHours: number

  /** цена сати */
  workPerHourNet: number
  workPerHourGross: number
  allowancePerHourNet: number
  allowancePerHourGross: number

  /** делови зараде/накнаде */
  parts: PayslipPart[]

  /** зарада, порез и доприноси */
  gross: number
  contributionBase: number
  taxFree: number
  taxBase: number
  employeeCharges: PayslipRate[]
  employeeTotal: number
  net: number
  deductions: { label: string; amount: number; goesTo: 'third_party' | 'employer' }[]
  deductionsTotal: number
  netPaid: number

  /** доприноси на терет послодавца */
  employerCharges: PayslipRate[]
  employerTotal: number

  totalCost: number
}

/**
 * The payslip for one line of one run.
 *
 * `rates` is only used for the percentages MPP prints beside each charge; every
 * amount comes from the line itself, so a payslip cannot disagree with the run
 * it belongs to.
 */
export function payslipFor(
  line: SalaryRunLine,
  person: EmployeeForMonth | undefined,
  rates: PayrollRates,
  seniorityCoefficient: number | null,
  currencyRates: Record<string, number> = {},
): Payslip {
  const l = line.line

  // The factor a net figure is grossed at when it carries no tax relief.
  const employeeShare = rates.pensionEmployee + rates.healthEmployee + rates.unemploymentEmployee
  const factor = 1 - employeeShare - rates.incomeTax

  const grossOf = (net: number) => (factor > 0 ? round2(net / factor) : 0)

  const seniorityForPeriod = line.monthHours > 0
    ? round2(line.seniorityNet * (line.hours / line.monthHours))
    : 0
  // Основна нето зарада за радно време — the contracted net for these hours,
  // less the seniority inside it.
  const baseForPeriod = round2(l.contractedForPeriod - seniorityForPeriod)

  const parts: PayslipPart[] = []
  let accountedGross = 0

  const add = (label: string, net: number, hours: number | null) => {
    if (Math.abs(net) < 0.005) return
    const gross = grossOf(net)
    accountedGross += gross
    parts.push({ label, hours, net: round2(net), gross })
  }

  // Everything except regular work, which takes what is left.
  add('Meal allowance', l.mealAllowance, line.hours || null)
  add('Holiday allowance', l.holidayAllowance, null)
  add('Seniority', seniorityForPeriod, null)
  for (const a of line.additions) {
    // In dinars, by the same function the run used, so the parts cannot
    // disagree with the total they have to add up to.
    add(a.label, amountInDinars(a, currencyRates), null)
  }

  // REGULAR WORK ABSORBS THE REMAINDER, which is what keeps the parts adding
  // to the gross exactly — and is also how MPP arrives at its own figure,
  // since the whole tax-free relief lands on this line.
  parts.unshift({
    label: 'Regular work',
    hours: line.hours || null,
    net: round2(baseForPeriod),
    gross: round2(l.gross - accountedGross),
  })

  const employeeCharges: PayslipRate[] = [
    { label: 'Income tax', percent: pct(rates.incomeTax), amount: l.incomeTax },
    { label: 'Pension, from gross', percent: pct(rates.pensionEmployee), amount: l.pensionEmployee },
    { label: 'Health, from gross', percent: pct(rates.healthEmployee), amount: l.healthEmployee },
    { label: 'Unemployment, from gross', percent: pct(rates.unemploymentEmployee), amount: l.unemploymentEmployee },
  ]

  const employerCharges: PayslipRate[] = [
    { label: 'Pension, on gross', percent: pct(rates.pensionEmployer), amount: l.pensionEmployer },
    { label: 'Health, on gross', percent: pct(rates.healthEmployer), amount: l.healthEmployer },
    { label: 'Unemployment, on gross', percent: pct(rates.unemploymentEmployer), amount: l.unemploymentEmployer },
  ]

  // Each one worked out by the same function the run used, on the same net
  // and the same rates — so the names on the payslip add up to the figure the
  // run withheld rather than to an apportionment nobody checked.
  const carries = line.deductions.total > 0
  const deductions = (carries ? person?.deductions ?? [] : []).map(d => ({
    label: d.label,
    goesTo: d.goes_to,
    amount: deductionAmount(d, person!.net.total, currencyRates),
  }))
  const deductionsTotal = round2(line.deductions.total)

  return {
    contractedNet: line.contractedNet,
    seniorityNet: line.seniorityNet,
    baseNet: round2(line.contractedNet - line.seniorityNet),
    serviceYears: person?.serviceYears ?? null,
    seniorityPercent: person && seniorityCoefficient !== null
      ? round4(person.serviceYears * seniorityCoefficient * 100)
      : null,
    hours: line.hours,
    monthHours: line.monthHours,

    workPerHourNet: perHour(baseForPeriod, line.hours),
    workPerHourGross: perHour(parts[0].gross, line.hours),
    allowancePerHourNet: perHour(l.contractedForPeriod, line.hours),
    allowancePerHourGross: perHour(l.gross - (l.mealAllowance + l.holidayAllowance) / factor, line.hours),

    parts,

    gross: l.gross,
    contributionBase: l.contributionBase,
    taxFree: l.taxFreeForPeriod,
    taxBase: l.taxBase,
    employeeCharges,
    employeeTotal: round2(l.incomeTax + l.employeeContributions),
    net: l.net,
    deductions,
    deductionsTotal,
    netPaid: round2(l.net - deductionsTotal),

    employerCharges,
    employerTotal: l.employerContributions,

    totalCost: l.totalCost,
  }
}

function perHour(amount: number, hours: number): number {
  if (!(hours > 0)) return 0
  return round2(amount / hours)
}

const pct = (rate: number): number => round4(rate * 100)
const round2 = (n: number): number => Math.round(n * 100) / 100
const round4 = (n: number): number => Math.round(n * 10000) / 10000
