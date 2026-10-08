// ─── The payroll engine ─────────────────────────────────────────────────────
//
// What this is for, because it changes what "correct" means.
//
// MCFlow does not file returns and does not pay anybody. This module exists
// to work out what a month SHOULD cost and to be checked against what the
// accountant's software (MPP / Mali privredni savetnik, PSIT 2.4) produced.
// So the standard it is held to is "the same figure as MPP", not "a defensible
// reading of the regulation". A number that is arguably right and differs from
// MPP is a failed check, not a disagreement.
//
// Which is why every rule here was derived from real exports and is proved by
// a test that reproduces a real month to the cent — five of them, covering all
// four calculations the company runs each month plus maternity leave. The
// export names all 245 intermediate columns, so nothing had to be guessed.
//
// ONE MACHINE, THREE WAYS IN. The tax and contribution arithmetic is the same
// everywhere; the calculations differ only in how they arrive at a gross:
//
//   salary         from a contracted NET, grossed up
//   sick leave     from an averaged allowance per hour, floored at the minimum
//   other income   from a net, grossed up for tax alone — no contributions
//
// WHAT IS NOT IN HERE, and must not be added by guesswork: overtime, night
// work, redistribution of hours, and the other coefficients the settings carry
// but no export has yet exercised. `unprovenRule` marks the one place a rule
// exists without a real month behind it, and it refuses rather than returning
// a figure. In a module whose whole purpose is checking somebody else's
// arithmetic, a silent guess is the worst thing it could produce.

export interface PayrollRates {
  /** Стопа пореза на зараде. */
  incomeTax: number
  /** Стопе доприноса из бруто — на терет запосленог. */
  pensionEmployee: number
  healthEmployee: number
  unemploymentEmployee: number
  /** Стопе доприноса на бруто — на терет послодавца. */
  pensionEmployer: number
  healthEmployer: number
  unemploymentEmployer: number
  /** Неопорезиви део зараде, за пун фонд сати. */
  taxFreeAmount: number
  /** Минимална нето зарада по часу. */
  minimumNetPerHour: number
  /** Минимална и максимална основица за доприносе, месечне. */
  minimumBase: number
  maximumBase: number
  /** Месечни износи, прорачунавају се по сатима. */
  mealAllowance: number
  holidayAllowance: number
}

/** The rates in force for the company as of 2026-08, from Podešavanja.xlsx. */
export const RATES_2026: PayrollRates = {
  incomeTax: 0.10,
  pensionEmployee: 0.14,
  healthEmployee: 0.0515,
  unemploymentEmployee: 0.0075,
  pensionEmployer: 0.10,
  healthEmployer: 0.0515,
  unemploymentEmployer: 0,
  taxFreeAmount: 34221,
  minimumNetPerHour: 371,
  minimumBase: 51297,
  maximumBase: 732820,
  mealAllowance: 100,
  holidayAllowance: 100,
}

const round2 = (n: number): number => Math.round(n * 100) / 100

/**
 * The floor and ceiling contributions are charged between, for THIS run.
 *
 * ALREADY DECIDED BY THE CALLER, and deliberately not worked out here. The
 * ceiling is a limit on a PERSON'S MONTH, not on a calculation — so whether it
 * applies at all depends on what their other runs came to, which a function
 * looking at one run cannot know.
 *
 * This engine used to prorate the monthly ceiling and apply it to every run
 * unconditionally. Milosavljević Đuro's September is what that costs: 72 hours
 * and a large one-off payment, grossing to 569,091.70 — comfortably under the
 * monthly 732,820, so MPP charged his contributions on all of it. Prorated,
 * the ceiling came to 299,790 and this capped him there, understating his
 * gross by 59,546 dinars on a line that looked entirely ordinary.
 *
 * Leaving it undefined means no limit, which is the safe default now that the
 * expensive mistake is known to be capping somebody who should not be.
 */
export interface BaseLimits {
  min: number
  max: number
}

/** Everything taken out of gross, and everything added on top of it. */
export interface Charges {
  gross: number
  /** Бруто мање неопорезиви део. Never below zero. */
  taxBase: number
  incomeTax: number
  pensionEmployee: number
  healthEmployee: number
  unemploymentEmployee: number
  /** Збир доприноса из бруто. */
  employeeContributions: number
  pensionEmployer: number
  healthEmployer: number
  unemploymentEmployer: number
  /** Збир доприноса на бруто. */
  employerContributions: number
  /**
   * Основица за доприносе — what the contributions were actually charged on.
   *
   * The same as the gross for almost everybody, and the whole point of the
   * field is the case where it is not: above the ceiling, contributions stop
   * following the salary. Carried out so a line can show both and the
   * difference is visible rather than inferred from a total that looks low.
   */
  contributionBase: number
  /** Нето износ — бруто мање порез и доприноси из бруто. */
  net: number
  /**
   * Укупан износ — what the employer actually owes.
   *
   * Gross plus the employer's contributions. This is the figure that reaches
   * the general ledger.
   */
  totalCost: number
}

/**
 * The charges on a gross amount.
 *
 * `taxFree` is passed rather than read from the rates because it is prorated
 * by hours — a half month of work carries half the tax-free allowance, which
 * the export shows as "неопорезив део зараде за фонд сати (процењен)".
 */
export function chargesOn(
  gross: number,
  rates: PayrollRates,
  taxFree: number,
  limits?: BaseLimits,
): Charges {
  const taxBase = Math.max(0, gross - taxFree)
  const incomeTax = taxBase * rates.incomeTax

  // THE TAX FOLLOWS THE SALARY AND THE CONTRIBUTIONS DO NOT. Above the
  // ceiling they stop rising, which is the one place these two figures come
  // apart — and the only reason the base is a separate number at all.
  const base = contributionBase(gross, limits)

  const pensionEmployee = base * rates.pensionEmployee
  const healthEmployee = base * rates.healthEmployee
  const unemploymentEmployee = base * rates.unemploymentEmployee
  const pensionEmployer = base * rates.pensionEmployer
  const healthEmployer = base * rates.healthEmployer
  const unemploymentEmployer = base * rates.unemploymentEmployer

  const employeeContributions = pensionEmployee + healthEmployee + unemploymentEmployee
  const employerContributions = pensionEmployer + healthEmployer + unemploymentEmployer

  return {
    gross: round2(gross),
    taxBase: round2(taxBase),
    incomeTax: round2(incomeTax),
    pensionEmployee: round2(pensionEmployee),
    healthEmployee: round2(healthEmployee),
    unemploymentEmployee: round2(unemploymentEmployee),
    employeeContributions: round2(employeeContributions),
    pensionEmployer: round2(pensionEmployer),
    healthEmployer: round2(healthEmployer),
    unemploymentEmployer: round2(unemploymentEmployer),
    employerContributions: round2(employerContributions),
    contributionBase: round2(base),
    net: round2(gross - incomeTax - employeeContributions),
    totalCost: round2(gross + employerContributions),
  }
}

/** The gross, held between the floor and the ceiling. */
export function contributionBase(gross: number, limits?: BaseLimits): number {
  if (!limits) return gross
  if (limits.max > 0 && gross > limits.max) return limits.max
  if (limits.min > 0 && gross < limits.min) return limits.min
  return gross
}

/**
 * The gross that produces a given net.
 *
 *   net = gross − (gross − taxFree)·t − base·(pio + zdr + nez)
 *
 * WHICH ONLY INVERTS IN CLOSED FORM WHILE base IS THE GROSS. Below the
 * ceiling, base = gross and the whole thing collapses to
 *
 *   gross = (net − taxFree·t) / (1 − t − contributions)
 *
 * Above it, the contributions are a CONSTANT — they have stopped following
 * the salary — and the shape changes completely:
 *
 *   gross = (net − taxFree·t + base·contributions) / (1 − t)
 *
 * So it solves the simple one, asks whether the answer is actually inside the
 * limits, and re-solves against the fixed base if it is not. Two shapes, and
 * using the first where the second applies is how Stevanović Strahinja's
 * September came out at 922,821 instead of 873,444 — fifty thousand dinars of
 * gross, on a line that looks entirely ordinary.
 */
export function grossFromNet(
  net: number, rates: PayrollRates, taxFree: number, limits?: BaseLimits,
): number {
  const employeeShare = rates.pensionEmployee + rates.healthEmployee + rates.unemploymentEmployee
  const factor = 1 - employeeShare - rates.incomeTax
  if (factor <= 0) return 0

  const free = (net - taxFree * rates.incomeTax) / factor
  if (!limits) return free

  const base = contributionBase(free, limits)
  if (base === free) return free

  // The base is fixed now, so the contributions are a known amount and only
  // the tax still moves with the salary.
  const taxFactor = 1 - rates.incomeTax
  if (taxFactor <= 0) return 0
  return (net - taxFree * rates.incomeTax + base * employeeShare) / taxFactor
}

/** The net a given gross leaves. The inverse of the above, for floors. */
export function netFromGross(
  gross: number, rates: PayrollRates, taxFree: number, limits?: BaseLimits,
): number {
  const employeeShare = rates.pensionEmployee + rates.healthEmployee + rates.unemploymentEmployee
  const base = contributionBase(gross, limits)
  return gross * (1 - rates.incomeTax) + taxFree * rates.incomeTax - base * employeeShare
}

// ─── Seniority, and what a contract actually says ───────────────────────────

/**
 * Минули рад as a fraction of the base net.
 *
 * Years of service times the coefficient — 0.004 a year at this company, so
 * six years is 2.4%. Proved against all fourteen employees of August 2026:
 * every one of their seniority figures is the base net times this.
 *
 * Years are stored as MPP reports them rather than derived from a joining
 * date. MPP gives an integer and nothing in the exports says how it rounds a
 * part year, so deriving it would be a guess sitting under every salary.
 */
export function seniorityRate(years: number, coefficientPerYear: number): number {
  if (!(years > 0) || !(coefficientPerYear > 0)) return 0
  return years * coefficientPerYear
}

/**
 * Whole years from a date to a date. Anniversaries, not 365-day blocks.
 *
 * MPP's seniority figure, reproduced for all fourteen employees of the August
 * 2026 export: the completed years since "датум почетка последњег ангажовања".
 * Somebody who joined on the 11th of June 2020 is credited with six years on
 * the 1st of August 2026 and seven from the 11th of June 2027.
 *
 * Deliberately not `(a - b) / 365.25`, which drifts by a day either side of an
 * anniversary and would move somebody between six and seven years depending on
 * the leap years in between.
 */
export function wholeYearsBetween(from: string, to: string): number {
  if (!from || !to) return 0
  const [fy, fm, fd] = from.slice(0, 10).split('-').map(Number)
  const [ty, tm, td] = to.slice(0, 10).split('-').map(Number)
  if (!fy || !ty) return 0
  let years = ty - fy
  if (tm < fm || (tm === fm && td < fd)) years -= 1
  return Math.max(0, years)
}

export interface ContractedNet {
  /** Основна нето зарада — what the contract is worth before seniority. */
  base: number
  /** Минули рад (нето) — the part of the total that seniority accounts for. */
  seniority: number
  /** Укупан нето износ (месечни, уговорени) — the two together. */
  total: number
}

/**
 * Splitting a contracted figure into its base and its seniority.
 *
 * THE CONTRACT INCLUDES SENIORITY, which is the thing to get right. The
 * payslip reads "Уговорена месечна зарада 352.075,80 (3.000,00 EUR, курс
 * 117,3586)" and that 352,075.80 is the TOTAL — base 350,673.11 plus 1,402.69
 * of seniority for one year. So the base is found by dividing, not by adding.
 *
 * Getting this backwards would pay every employee their seniority twice, and
 * the error would grow with length of service — largest for the people
 * longest at the company, which is where it would be least noticed and most
 * resented.
 */
export function splitContractedNet(
  total: number,
  years: number,
  coefficientPerYear: number,
): ContractedNet {
  const rate = seniorityRate(years, coefficientPerYear)
  const base = total / (1 + rate)
  return { base: round2(base), seniority: round2(total - base), total: round2(total) }
}

/**
 * A contract agreed in euros, in dinars for a given month.
 *
 * The company contracts in euros and converts at the middle rate on the
 * 20th. The rate is passed in rather than fetched, because which rate applied
 * to a past month is a fact about that month — looking it up at calculation
 * time would make a recalculation of August depend on when it was run.
 */
export function contractInDinars(amountEur: number, rateOnThe20th: number): number {
  if (!(rateOnThe20th > 0)) return 0
  return round2(amountEur * rateOnThe20th)
}

// ─── The three ways in ──────────────────────────────────────────────────────

export interface Period {
  /** Фонд сати у месецу — the month's full working hours. */
  monthHours: number
  /** Сати радника у обрачуну — what this calculation covers. */
  workedHours: number
}

/** Everything prorated by hours, which is how a month is split across runs. */
function prorate(value: number, p: Period): number {
  if (!(p.monthHours > 0)) return 0
  return value * (p.workedHours / p.monthHours)
}

export interface SalaryInput {
  /** Укупан нето износ (месечни, уговорени) — for a FULL month. */
  contractedNet: number
  period: Period
  /** Минули рад (нето) — already included in `contractedNet`. */
  seniorityNet?: number
  /** Whether meal and holiday allowance are added on top of the net. */
  withAllowances?: boolean
  /**
   * Основица за доприносе, floor and ceiling, for this run.
   *
   * Left out means no limit. Whether a ceiling applies is a fact about the
   * person's whole month, so the caller decides it — see `runsFor`.
   */
  baseLimits?: BaseLimits
  /**
   * Додаци — a bonus or stimulation, in dinars, NOT prorated.
   *
   * Added after the proration and before the gross-up, so tax and both sides'
   * contributions apply to it. Fifty thousand is fifty thousand whether
   * somebody worked the whole month or half of it: prorating an addition
   * would quietly pay half a bonus to somebody who took a fortnight off.
   */
  additionalNet?: number
}

export interface SalaryLine extends Charges {
  /** Нето износ без обустава, before anything is withheld. */
  contractedForPeriod: number
  /** Додаци included in this line's net, at full value and never prorated. */
  additionalNet: number
  mealAllowance: number
  holidayAllowance: number
  taxFreeForPeriod: number
}

/**
 * A salary run for one person, for the hours this calculation covers.
 *
 * The contract is for a full month and the hours are an input, so a month
 * that is part work and part leave prorates the SAME contracted salary rather
 * than dividing it beforehand.
 */
export function salaryLine(input: SalaryInput, rates: PayrollRates): SalaryLine {
  const p = input.period
  const contractedForPeriod = prorate(input.contractedNet, p)
  const meal = input.withAllowances === false ? 0 : prorate(rates.mealAllowance, p)
  const holiday = input.withAllowances === false ? 0 : prorate(rates.holidayAllowance, p)
  const taxFreeForPeriod = prorate(rates.taxFreeAmount, p)

  const limits = input.baseLimits
  const additional = input.additionalNet ?? 0
  const net = contractedForPeriod + meal + holiday + additional
  const gross = grossFromNet(net, rates, taxFreeForPeriod, limits)

  return {
    ...chargesOn(gross, rates, taxFreeForPeriod, limits),
    contractedForPeriod: round2(contractedForPeriod),
    additionalNet: round2(additional),
    mealAllowance: round2(meal),
    holidayAllowance: round2(holiday),
    taxFreeForPeriod: round2(taxFreeForPeriod),
  }
}

export interface SickLeaveInput {
  /** Месечни износ накнаде (из просека) — from the employee's own average. */
  monthlyAllowance: number
  period: Period
  /** Коефицијент усклађивања — 1.00 for maternity, 0.65 for ordinary sick pay. */
  coefficient?: number
}

export interface SickLeaveLine extends Charges {
  grossPerHour: number
  /** True when the minimum wage lifted the figure above the average. */
  raisedToMinimum: boolean
  taxFreeForPeriod: number
}

/**
 * Sick or maternity leave, which starts from a gross rather than a net.
 *
 * The allowance comes from the employee's own average earnings, so there is no
 * contract to gross up — the hourly gross is derived directly and then FLOORED
 * at the statutory minimum wage. In the May 2026 maternity run the floor is
 * what binds: the average gives 495.73 per hour and the minimum 500.19, and
 * MPP pays the minimum.
 *
 * The minimum gross per hour is not a setting. It is derived from the minimum
 * NET per hour, which is, so that the two cannot drift apart.
 */
export function sickLeaveLine(input: SickLeaveInput, rates: PayrollRates): SickLeaveLine {
  const p = input.period
  const coefficient = input.coefficient ?? 1
  const taxFreeForPeriod = prorate(rates.taxFreeAmount, p)
  const taxFreePerHour = p.workedHours > 0 ? taxFreeForPeriod / p.workedHours : 0

  const fromAverage = p.monthHours > 0
    ? (input.monthlyAllowance * coefficient) / p.monthHours
    : 0
  const minimumGrossPerHour = grossFromNet(rates.minimumNetPerHour, rates, taxFreePerHour)

  const grossPerHour = Math.max(fromAverage, minimumGrossPerHour)
  const gross = grossPerHour * p.workedHours

  return {
    ...chargesOn(gross, rates, taxFreeForPeriod),
    grossPerHour: round2(grossPerHour),
    raisedToMinimum: minimumGrossPerHour > fromAverage,
    taxFreeForPeriod: round2(taxFreeForPeriod),
  }
}

export interface OtherIncomeInput {
  /** Нето износ другог прихода. */
  net: number
  /** The part that is not taxed — all of it for a non-taxable addition. */
  taxFree?: number
}

export interface OtherIncomeLine {
  net: number
  taxableNet: number
  gross: number
  incomeTax: number
  totalCost: number
}

/**
 * Other income, which is taxed once and carries no contributions.
 *
 * 3,000 net becomes 3,333.33 gross and 333.33 of tax — the net grossed up for
 * tax alone. No pension, no health, no unemployment on either side, which is
 * the whole reason it is a separate run rather than a line on the salary.
 */
export function otherIncomeLine(input: OtherIncomeInput, rates: PayrollRates): OtherIncomeLine {
  const taxFree = input.taxFree ?? 0
  const taxableNet = Math.max(0, input.net - taxFree)
  const gross = taxableNet / (1 - rates.incomeTax)
  const tax = gross * rates.incomeTax
  return {
    net: round2(input.net),
    taxableNet: round2(taxableNet),
    gross: round2(gross + taxFree),
    incomeTax: round2(tax),
    totalCost: round2(gross + taxFree),
  }
}

// ─── The line this module will not cross ────────────────────────────────────

/**
 * Refuses a case no real month has exercised.
 *
 * The settings carry coefficients for overtime, night work, shift work,
 * redistribution and a dozen kinds of absence. Every one of them is a rule
 * this engine could implement from the number alone — and not one of them has
 * appeared in an export yet, so not one of them has ever been checked against
 * MPP.
 *
 * This module exists to check somebody else's arithmetic. A figure it produced
 * from an unverified rule would look exactly like a figure it produced from a
 * proven one, and the first time they disagreed nobody would know which to
 * believe. So it says so instead, and the rule gets written when there is a
 * month to prove it against.
 */
export function unprovenRule(name: string): never {
  throw new Error(
    `${name} is not implemented: no payroll export has exercised it yet, so there is `
    + 'nothing to check the rule against. Send a month that contains it and it becomes '
    + 'a tested case. Guessing here would produce a figure indistinguishable from a '
    + 'verified one.')
}
