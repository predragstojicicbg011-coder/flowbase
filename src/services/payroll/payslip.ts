// ─── The payslip, as MPP lays it out ────────────────────────────────────────
//
// Built against a real one: "Обрачун зараде и накнаде — Team Regular 2026-08",
// Person A. Every figure below was checked against that sheet, and
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
import { fmtNum } from '../../utils/formatters'
import { srDate } from '../../utils/months'

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
  add('Topli obrok', l.mealAllowance, line.hours || null)
  add('Regres', l.holidayAllowance, null)
  add('Minuli rad', seniorityForPeriod, null)
  for (const a of line.additions) {
    // In dinars, by the same function the run used, so the parts cannot
    // disagree with the total they have to add up to.
    add(a.label, amountInDinars(a, currencyRates), null)
  }

  // REGULAR WORK ABSORBS THE REMAINDER, which is what keeps the parts adding
  // to the gross exactly — and is also how MPP arrives at its own figure,
  // since the whole tax-free relief lands on this line.
  parts.unshift({
    label: 'Redovan rad',
    hours: line.hours || null,
    net: round2(baseForPeriod),
    gross: round2(l.gross - accountedGross),
  })

  const employeeCharges: PayslipRate[] = [
    { label: 'Porez na zarade', percent: pct(rates.incomeTax), amount: l.incomeTax },
    { label: 'Doprinos za PIO', percent: pct(rates.pensionEmployee), amount: l.pensionEmployee },
    { label: 'Doprinos za zdravstveno osiguranje', percent: pct(rates.healthEmployee), amount: l.healthEmployee },
    { label: 'Doprinos za slučaj nezaposlenosti', percent: pct(rates.unemploymentEmployee), amount: l.unemploymentEmployee },
  ]

  const employerCharges: PayslipRate[] = [
    { label: 'Doprinos za PIO', percent: pct(rates.pensionEmployer), amount: l.pensionEmployer },
    { label: 'Doprinos za zdravstveno osiguranje', percent: pct(rates.healthEmployer), amount: l.healthEmployer },
    { label: 'Doprinos za slučaj nezaposlenosti', percent: pct(rates.unemploymentEmployer), amount: l.unemploymentEmployer },
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

// ─── The payslip as rows, for the dialog and for the printed page ─────────
//
// ONE LIST OF ROWS, so the screen and the paper cannot disagree about what a
// payslip says: every label and every formatted figure is decided here, and
// `PayslipDialog` and `payrollPrint` only lay them out.

/** A row: its number, its label and its cells, already formatted. */
export type PayslipRowView =
  | { kind: 'row'; n?: number; label: string; cells: string[]; bold?: boolean; indent?: boolean; highlight?: boolean }
  | { kind: 'note'; text: string }

export interface PayslipSectionView {
  title: string
  /** How many figure cells each row carries: one value, two, or a rate and two. */
  layout: 'one' | 'two' | 'three'
  /** One heading per figure cell. */
  columns?: string[]
  rows: PayslipRowView[]
}

/** Hours as the payslip shows them; blank where a part has none. */
export const payslipHours = (n: number | null): string => (n === null ? '' : n.toLocaleString('sr-RS',
  { minimumFractionDigits: 2, maximumFractionDigits: 2 }))

/** A percentage as the payslip shows it. */
export const payslipPercent = (n: number): string => n.toLocaleString('sr-RS',
  { minimumFractionDigits: 2, maximumFractionDigits: 2 })

export const PAYSLIP_COST_LABEL = 'Ukupan trošak poslodavca za ovog zaposlenog u mesecu'

/** Whether the contribution base is not the gross: the floor or the ceiling moved it. */
export const baseDiffers = (base: number, gross: number): boolean => Math.abs(base - gross) > 0.005

/** The third cell of a deduction forwarded to somebody else. */
export const THIRD_PARTY = 'trećem licu'

/**
 * The charge sections' headings: one per cell of a three-cell row, so each
 * sits over its own figures — the rate, the amount, and the third column (who
 * a deduction goes to), which has no heading.
 */
export const CHARGE_COLUMNS = ['Stopa', 'Ukupno', '']

/** Every section of the payslip, in the order MPP prints them. */
export function payslipSections(
  p: Payslip, person: EmployeeForMonth | undefined, currencyRates: Record<string, number>,
): PayslipSectionView[] {
  const money = (n: number) => fmtNum(n)
  const contract = person?.contract
  const row = (n: number | undefined, label: string, cells: string[],
    o: { bold?: boolean; indent?: boolean; highlight?: boolean } = {}): PayslipRowView =>
    ({ kind: 'row', n, label, cells, ...o })
  const charge = (c: PayslipRate) => row(undefined, c.label,
    [payslipPercent(c.percent), money(c.amount), ''], { indent: true })

  const general: PayslipRowView[] = [
    row(1, 'Ugovorena mesečna neto zarada, ukupno', [money(p.contractedNet)]),
    ...(contract ? [{
      kind: 'note' as const,
      text: `${money(contract.net_amount)} ${contract.currency}`
        + (contract.currency !== 'RSD' && currencyRates[contract.currency]
          ? `, po kursu ${money(currencyRates[contract.currency])}` : '')
        + ` od ${srDate(contract.valid_from)}`
        + (contract.valid_to ? ` do ${srDate(contract.valid_to)}` : ' nadalje'),
    }] : []),
    row(2, 'Minuli rad, mesečno neto, sadržan u ugovorenom iznosu', [money(p.seniorityNet)]),
    row(3, 'Osnovna neto zarada za radno vreme', [money(p.baseNet)]),
    row(4, 'Koeficijent minulog rada', [p.seniorityPercent === null ? '—'
      : `${payslipHours(p.serviceYears)}   ${payslipPercent(p.seniorityPercent)}`]),
    row(5, 'Sati u obračunu', [payslipHours(p.hours)]),
    row(6, 'Fond sati u mesecu', [payslipHours(p.monthHours)]),
  ]

  const salary: PayslipRowView[] = [
    row(1, 'Bruto zarada', ['', money(p.gross), ''], { bold: true }),
    row(2, 'Osnovica za doprinose', ['', money(p.contributionBase), ''],
      { highlight: baseDiffers(p.contributionBase, p.gross) }),
    row(3, 'Neoporezivi iznos', ['', money(p.taxFree), '']),
    row(4, 'Poreska osnovica', ['', money(p.taxBase), '']),
    row(5, 'Porez i doprinosi na teret zaposlenog', ['', money(p.employeeTotal), ''], { bold: true }),
    ...p.employeeCharges.map(charge),
    row(6, 'Neto zarada', ['', money(p.net), ''], { bold: true }),
    ...(p.deductionsTotal > 0 ? [
      row(7, 'Obustave', ['', money(p.deductionsTotal), ''], { bold: true }),
      ...p.deductions.map(d => row(undefined, d.label,
        ['', money(d.amount), d.goesTo === 'third_party' ? THIRD_PARTY : ''], { indent: true })),
      row(8, 'Za isplatu', ['', money(p.netPaid), ''], { bold: true }),
    ] : []),
  ]

  return [
    { title: 'Opšti podaci', layout: 'one', rows: general },
    {
      title: 'Cena rada po satu', layout: 'two', columns: ['Neto', 'Bruto'],
      rows: [
        row(1, 'Rad, po satu', [money(p.workPerHourNet), money(p.workPerHourGross)]),
        row(2, 'Naknada, po satu', [money(p.allowancePerHourNet), money(p.allowancePerHourGross)]),
      ],
    },
    {
      title: 'Delovi zarade', layout: 'three', columns: ['Sati', 'Neto', 'Bruto'],
      rows: p.parts.map((part, i) => row(i + 1, part.label,
        [payslipHours(part.hours), money(part.net), money(part.gross)])),
    },
    { title: 'Zarada, porez i doprinosi', layout: 'three', columns: CHARGE_COLUMNS, rows: salary },
    {
      title: 'Doprinosi na teret poslodavca', layout: 'three', columns: CHARGE_COLUMNS,
      rows: [
        row(1, 'Doprinosi na teret poslodavca', ['', money(p.employerTotal), ''], { bold: true }),
        ...p.employerCharges.map(charge),
      ],
    },
  ]
}

function perHour(amount: number, hours: number): number {
  if (!(hours > 0)) return 0
  return round2(amount / hours)
}

const pct = (rate: number): number => round4(rate * 100)
const round2 = (n: number): number => Math.round(n * 100) / 100
const round4 = (n: number): number => Math.round(n * 10000) / 10000
