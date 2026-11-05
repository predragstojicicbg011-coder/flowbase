// ─── Indebtedness, month by month, from the credit book ─────────────────────
//
// What the home page draws under "Zaduženost": per month of the period, what
// the bank lent, what fell due (principal and interest, and how much of it was
// paid), and how much principal was still owed at the end of the month.
//
// FROM THE CREDIT BOOK, NOT THE LEDGER. `credits` and `credit_installments`
// say what was borrowed and what the bank scheduled, so the chart is there
// for a company that has entered its credits and booked no statement yet. The
// ledger's view of the same loans — drawdowns booked as revenue, principal
// booked as cost — is on the cards above, from homeLedgerFigures.
//
// THE TWO KINDS ARE READ THE WAY THE CREDITS PAGE READS THEM, by the same
// functions, so the two pages cannot tell two stories:
//
//   an annuity   the bank's schedule, from `credit_installments`
//   a revolving  DERIVED from the tranche by `revolvingSchedule` — interest
//                every month at margin + benchmark, the principal at maturity.
//                Never read back from generated instalments for what is due,
//                because counting both would double the line (see Credits.tsx).
//                Generated instalments that were PAID do say what was paid.
//
// WHAT IS OWED AT A POINT is the principal not yet paid by then. For a month
// that has ended the point is its last day; for the current month it is today
// — an instalment due on the 20th has not reduced the debt on the 5th. An
// instalment that fell due and was not paid is still owed.
//
// IN THE DISPLAY CURRENCY, converted the way the Credits page converts: at
// today's NBS rate, through a function the page hands over. A credit that
// cannot be converted is left out of every figure and named, never guessed.
// Because the rate is today's, a converted line can move with the rate; the
// page says so whenever a credit was converted.
//
// Every limit of the figures is said in a note, in Serbian, ready to print.
//
// Pure: no React, no Supabase.

import { revolvingSchedule, rateOn, dueDateIn, type RateReset } from './revolvingCredit'
import { addMonths } from './debtSchedule'
import { round2 } from './bookAmounts'

export interface HomeCredit {
  id: string
  company_id: string | null
  name: string
  kind?: 'annuity' | 'revolving' | null
  currency: string | null
  /** `numeric` may arrive as text. */
  principal_amount: number | string
  disbursement_date: string | null
  maturity_date?: string | null
  rate_margin?: number | string | null
  status?: string | null
}

export interface HomeInstalment {
  credit_id: string
  due_date: string
  principal_amount: number | string | null
  interest_amount: number | string | null
  status: string | null
  paid_date?: string | null
}

/** An amount in a credit's currency, in the display currency; null when it cannot be. */
export type ToShown = (amount: number, currency: string) => number | null

export interface DebtMonth {
  month: string
  /** What the bank lent this month: credits disbursed in it. */
  drawn: number
  /** What fell due this month, by the schedule. */
  principalDue: number
  interestDue: number
  /** Of instalments due this month, what is marked paid. */
  principalPaid: number
  interestPaid: number
  /** Principal still owed at the end of the month — for the current month, today. */
  balance: number
}

export interface HomeDebt {
  /** One per month of the period that has begun, in order. */
  months: DebtMonth[]
  drawn: number
  principalDue: number
  interestDue: number
  principalPaid: number
  interestPaid: number
  /** The balance of the last month: owed at the end of the period. */
  owedAtEnd: number
  /** False when no credit in scope can be drawn: no book, not a debt of zero. */
  hasBook: boolean
  notes: string[]
}

const num = (v: number | string | null | undefined): number => {
  const n = Number(v)
  return Number.isFinite(n) ? n : 0
}

const lastDayOf = (month: string): string => {
  const [y, m] = month.split('-').map(Number)
  return `${month}-${String(new Date(Date.UTC(y, m, 0)).getUTCDate()).padStart(2, '0')}`
}

/** The day a month is measured on: its last day, or today for the current month. */
const pointOf = (month: string, today: string): string =>
  month >= today.slice(0, 7) ? today : lastDayOf(month)

const isPaid = (i: HomeInstalment) => i.status === 'paid'
/** When a paid instalment's money left: its paid date, or its due date when none was recorded. */
const paidOn = (i: HomeInstalment) => i.paid_date || i.due_date

const names = (xs: string[]) => Array.from(new Set(xs)).sort((a, b) => a.localeCompare(b, 'sr')).join(', ')

export function homeDebt(input: {
  credits: readonly HomeCredit[]
  instalments: readonly HomeInstalment[]
  /** Benchmark history per revolving credit id. */
  resets: Readonly<Record<string, RateReset[]>>
  months: readonly string[]
  today: string
  /** null: every company. */
  companyId: string | null
  toShown: ToShown
  /** The display currency's code, to tell which credits were converted. */
  currency: string
}): HomeDebt {
  const { today, toShown } = input
  const months = input.months.filter(m => m <= today.slice(0, 7))
  const inScope = input.credits.filter(c => !input.companyId || c.company_id === input.companyId)

  const curOf = (c: HomeCredit) => (c.currency || 'RSD').toUpperCase()
  const convertible = inScope.filter(c => toShown(1, curOf(c)) !== null)
  const unconverted = inScope.filter(c => toShown(1, curOf(c)) === null)
  const shown = (c: HomeCredit, amount: number) => toShown(amount, curOf(c)) ?? 0

  const byCredit = new Map<string, HomeInstalment[]>()
  for (const i of input.instalments) {
    const list = byCredit.get(i.credit_id)
    if (list) list.push(i)
    else byCredit.set(i.credit_id, [i])
  }

  const out: DebtMonth[] = months.map(month => ({
    month, drawn: 0, principalDue: 0, interestDue: 0, principalPaid: 0, interestPaid: 0, balance: 0,
  }))
  const at = new Map(out.map(m => [m.month, m]))

  const noSchedule: string[] = []
  const unpriced: string[] = []
  const noMaturity: string[] = []
  const pastMaturity: string[] = []
  let converted = false

  for (const c of convertible) {
    const principal = num(c.principal_amount)
    const own = byCredit.get(c.id) || []
    const revolving = c.kind === 'revolving'
    if (curOf(c) !== input.currency.toUpperCase()) converted = true

    // ── Drawn ──
    const disbursed = c.disbursement_date || ''
    if (disbursed && disbursed <= today) {
      const m = at.get(disbursed.slice(0, 7))
      if (m) m.drawn += shown(c, principal)
    }

    // ── Paid, from the instalments marked paid, in the month they were due ──
    for (const i of own) {
      if (!isPaid(i)) continue
      const m = at.get(i.due_date.slice(0, 7))
      if (!m) continue
      m.principalPaid += shown(c, num(i.principal_amount))
      m.interestPaid += shown(c, num(i.interest_amount))
    }

    // ── Due ──
    if (!revolving) {
      if (own.length === 0 && principal > 0) noSchedule.push(c.name)
      for (const i of own) {
        const m = at.get(i.due_date.slice(0, 7))
        if (!m) continue
        m.principalDue += shown(c, num(i.principal_amount))
        m.interestDue += shown(c, num(i.interest_amount))
      }
    } else if (!c.maturity_date) {
      noMaturity.push(c.name)
    } else {
      const fromMonth = disbursed ? addMonths(disbursed.slice(0, 7), 1) : (months[0] || today.slice(0, 7))
      const margin = c.rate_margin === null || c.rate_margin === undefined ? null : num(c.rate_margin)
      const resets = input.resets[c.id] || []
      const rows = revolvingSchedule({
        principal, margin, resets, fromMonth, maturity: c.maturity_date,
        billingDay: Number(disbursed.slice(8, 10)) || undefined,
      })
      const due = rows.length > 0
        ? rows
        : [{ due_date: c.maturity_date, principal_amount: principal, interest_amount: 0 }]
      if (rows.length === 0 && fromMonth <= c.maturity_date.slice(0, 7)
        && rateOn(margin, resets, dueDateIn(fromMonth, 28)) === null) unpriced.push(c.name)
      for (const r of due) {
        const m = at.get(r.due_date.slice(0, 7))
        if (!m) continue
        m.principalDue += shown(c, r.principal_amount)
        m.interestDue += shown(c, r.interest_amount)
      }
    }

    // ── Owed at each month's measuring point ──
    for (const m of out) {
      const point = pointOf(m.month, today)
      if (disbursed && disbursed > point) continue
      let owed: number
      if (!revolving) {
        owed = own.length === 0
          ? principal
          : own.reduce((s, i) => (isPaid(i) && paidOn(i) <= point ? s : s + num(i.principal_amount)), 0)
      } else {
        const repaid = own.some(i => isPaid(i) && num(i.principal_amount) > 0 && paidOn(i) <= point)
        const matured = !!c.maturity_date && c.maturity_date <= point
        if (repaid) owed = 0
        else if (matured && c.status !== 'active') owed = 0
        else {
          owed = principal
          if (matured) pastMaturity.push(c.name)
        }
      }
      m.balance += shown(c, Math.max(owed, 0))
    }
  }

  for (const m of out) {
    m.drawn = round2(m.drawn)
    m.principalDue = round2(m.principalDue)
    m.interestDue = round2(m.interestDue)
    m.principalPaid = round2(m.principalPaid)
    m.interestPaid = round2(m.interestPaid)
    m.balance = round2(m.balance)
  }
  const sum = (k: keyof Omit<DebtMonth, 'month' | 'balance'>) => round2(out.reduce((s, m) => s + m[k], 0))

  const one = (xs: string[]) => new Set(xs).size === 1
  const notes = [
    unconverted.length > 0
      ? `${names(unconverted.map(c => c.name))} ${one(unconverted.map(c => c.name)) ? 'nije uračunat' : 'nisu uračunati'} — danas nema kursa NBS za ${names(unconverted.map(curOf))}.`
      : null,
    noSchedule.length > 0
      ? `${names(noSchedule)} ${one(noSchedule) ? 'nema' : 'nemaju'} unet plan otplate, pa se glavnica vodi kao dug bez otplate.`
      : null,
    noMaturity.length > 0
      ? `${names(noMaturity)} ${one(noMaturity) ? 'nema' : 'nemaju'} datum dospeća, pa se glavnica vodi kao dug u svakom mesecu, a kamata nije u grafikonu.`
      : null,
    unpriced.length > 0
      ? `Kamata za ${names(unpriced)} nije u grafikonu: nema referentne kamatne stope — unesite je na tranši.`
      : null,
    pastMaturity.length > 0
      ? `${names(pastMaturity)} ${one(pastMaturity) ? 'je prošao' : 'su prošli'} rok dospeća, a i dalje ${one(pastMaturity) ? 'je aktivan' : 'su aktivni'}; glavnica se vodi kao dug.`
      : null,
    converted
      ? `Krediti u drugoj valuti preračunati su u ${input.currency} po današnjem kursu NBS, pa se iznos menja i sa kursom.`
      : null,
  ].filter((n): n is string => n !== null)

  return {
    months: out,
    drawn: sum('drawn'),
    principalDue: sum('principalDue'),
    interestDue: sum('interestDue'),
    principalPaid: sum('principalPaid'),
    interestPaid: sum('interestPaid'),
    owedAtEnd: out.length > 0 ? out[out.length - 1].balance : 0,
    hasBook: convertible.length > 0,
    notes,
  }
}
