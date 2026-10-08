// ─── A revolving credit's obligation ────────────────────────────────────────
//
// An annuity credit's schedule is given by the bank and typed in. A revolving
// line has no schedule to type: it is interest every month at a rate that
// moves, and the principal in one payment at a maturity that is usually
// rolled. So the schedule is DERIVED, and this is where.
//
// Pure arithmetic — no React, no Supabase — because every figure it produces
// ends up in the Budgeting credit schedule and the Cash Flow timeline, where
// being wrong is expensive and being wrong quietly is worse.
//
// ── The rate is a series ────────────────────────────────────────────────────
//
// 3M EURIBOR + 2.95%: the margin is fixed for the life of the line, the
// benchmark resets quarterly. The rate in force for a month is the margin plus
// the most recent reset on or before that month — never the latest reset
// applied backwards, which would reprice interest that was already paid.
//
// ── An unknown rate is not zero ─────────────────────────────────────────────
//
// With no benchmark recorded, the monthly interest is UNKNOWN, and everything
// here returns null or an empty schedule rather than a figure. A 50.000 EUR
// obligation showing 0,00 EUR of interest reads as a cheap line of credit; one
// showing "—" reads as a question, which is what it is.

export interface RateReset {
  /** 'YYYY-MM-DD' — the first day this benchmark applies. */
  effective_from: string
  /** The benchmark alone, in percent. 2.1 means 2.1%, not 0.021. */
  reference_rate: number
}

export interface ScheduleRow {
  installment_no: number
  due_date: string
  principal_amount: number
  interest_amount: number
  total_amount: number
}

const r2 = (n: number) => Math.round(n * 100) / 100

/**
 * The all-in annual rate in force on a date, or null if nothing prices it.
 *
 * The margin alone is not a rate. A line quoted as "EURIBOR + 2.95%" with no
 * EURIBOR on file is unpriced, and returning 2.95 would understate every month
 * of it by the whole benchmark.
 */
export function rateOn(
  margin: number | null | undefined,
  resets: RateReset[],
  onDate: string,
): number | null {
  if (margin == null || !Number.isFinite(margin)) return null
  const applicable = resets
    .filter(r => r.effective_from <= onDate && Number.isFinite(r.reference_rate))
    .sort((a, b) => a.effective_from.localeCompare(b.effective_from))
  const latest = applicable[applicable.length - 1]
  if (!latest) return null
  return Math.round((margin + latest.reference_rate) * 10000) / 10000
}

/** One month's interest on a principal, at an annual percentage rate. */
export function monthlyInterest(principal: number, annualRatePct: number): number {
  if (!(principal > 0) || !Number.isFinite(annualRatePct)) return 0
  return r2((principal * (annualRatePct / 100)) / 12)
}

/** Days in a month, so a due day of 30 does not fall off the end of February. */
function lastDayOf(year: number, month1: number): number {
  return new Date(Date.UTC(year, month1, 0)).getUTCDate()
}

/** 'YYYY-MM' plus n months. */
export function addMonths(month: string, n: number): string {
  const [y, m] = month.split('-').map(Number)
  const total = y * 12 + (m - 1) + n
  return `${Math.floor(total / 12)}-${String((total % 12) + 1).padStart(2, '0')}`
}

/**
 * The due date in a month, keeping the day the line is billed on.
 *
 * Clamped to the month's length rather than rolling into the next one: a line
 * drawn on the 30th is billed on the 28th of February, not the 2nd of March,
 * and a date that silently moved into the following month would put the
 * payment in the wrong period on every page that reads it.
 */
export function dueDateIn(month: string, day: number): string {
  const [y, m] = month.split('-').map(Number)
  const d = Math.min(Math.max(day, 1), lastDayOf(y, m))
  return `${month}-${String(d).padStart(2, '0')}`
}

export interface ScheduleRequest {
  principal: number
  margin: number | null | undefined
  resets: RateReset[]
  /** 'YYYY-MM' — the first month to bill. History is not regenerated. */
  fromMonth: string
  /** 'YYYY-MM-DD' — when the principal falls due. */
  maturity: string
  /** Which day of the month interest is billed on; the draw day by default. */
  billingDay?: number
  /** Where to number from, so a regenerated tail continues rather than restarts. */
  startNo?: number
}

/**
 * Interest every month to maturity, then the principal.
 *
 * ── Why it starts at a month you choose ─────────────────────────────────────
 *
 * The first three tranches were drawn in 2025 and their interest has been paid
 * ever since — those payments are transactions in the ledger already.
 * Regenerating them here would put the same obligation on the books twice, in
 * Budgeting and in Cash Flow, and the total would be wrong by a year of
 * interest in the direction that looks prudent.
 *
 * ── The final row ───────────────────────────────────────────────────────────
 *
 * The maturity row carries the principal AND that period's interest, because
 * that is one payment to the bank on one day. Split across two rows the
 * payment matching would have to decide which of two same-day instalments a
 * single bank line belongs to, and `allocatePayment` is built to split one.
 */
export function revolvingSchedule(req: ScheduleRequest): ScheduleRow[] {
  const { principal, margin, resets, fromMonth, maturity } = req
  if (!(principal > 0) || !maturity || !fromMonth) return []

  const maturityMonth = maturity.slice(0, 7)
  if (maturityMonth < fromMonth) return []

  // Unpriced for the very first month means unpriced, full stop. A schedule
  // half of which is guessed is not a schedule.
  if (rateOn(margin, resets, dueDateIn(fromMonth, 28)) === null) return []

  const billingDay = req.billingDay && req.billingDay > 0
    ? req.billingDay
    : Number(maturity.slice(8, 10)) || 1

  const rows: ScheduleRow[] = []
  let no = req.startNo ?? 1
  let month = fromMonth

  while (month < maturityMonth) {
    const due = dueDateIn(month, billingDay)
    const rate = rateOn(margin, resets, due)
    const interest = rate === null ? 0 : monthlyInterest(principal, rate)
    rows.push({
      installment_no: no++,
      due_date: due,
      principal_amount: 0,
      interest_amount: interest,
      total_amount: interest,
    })
    month = addMonths(month, 1)
  }

  const finalRate = rateOn(margin, resets, maturity)
  const finalInterest = finalRate === null ? 0 : monthlyInterest(principal, finalRate)
  rows.push({
    installment_no: no,
    due_date: maturity,
    principal_amount: r2(principal),
    interest_amount: finalInterest,
    total_amount: r2(principal + finalInterest),
  })

  return rows
}

/**
 * What a revolving line still owes: the principal, plus the interest to come.
 *
 * `interest` is null when the line is unpriced, and the caller shows that as
 * "—" beside a principal that is known — which is the true state of the thing
 * and not something to average away into one number.
 */
export function outstandingOf(req: ScheduleRequest): {
  principal: number
  interest: number | null
  total: number | null
} {
  const rows = revolvingSchedule(req)
  if (rows.length === 0) {
    return { principal: r2(req.principal || 0), interest: null, total: null }
  }
  const interest = r2(rows.reduce((s, r) => s + r.interest_amount, 0))
  const principal = r2(rows.reduce((s, r) => s + r.principal_amount, 0))
  return { principal, interest, total: r2(principal + interest) }
}

/** The maturity a new revolving line gets: a year from the draw. */
export function defaultMaturity(drawnOn: string): string {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(drawnOn)) return ''
  const [y, m, d] = drawnOn.split('-').map(Number)
  const day = Math.min(d, lastDayOf(y + 1, m))
  return `${y + 1}-${String(m).padStart(2, '0')}-${String(day).padStart(2, '0')}`
}
