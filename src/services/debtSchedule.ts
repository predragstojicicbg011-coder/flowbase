// ─── What the debt costs, month by month ────────────────────────────────────
//
// Two kinds of obligation with completely different shapes, laid on one axis:
//
//   an annuity   repays a little principal every month, and the interest on it
//                shrinks as the balance does
//   a revolving  repays no principal at all, then all of it at once
//
// Drawn together, that second shape is the thing worth seeing. An amortising
// book slopes gently to zero; a revolving book sits flat and then falls off a
// cliff on one day, and the month that cliff lands in is the month the company
// has to have €50,000 in the bank. No table of instalments shows that, and it
// is the first question anybody asks about a revolving line.
//
// Pure arithmetic, no React and no Supabase, because every figure here is a
// figure somebody plans cash around.
//
// ── The two halves come from different places, on purpose ───────────────────
//
// The annuity half is read from `credit_installments`, which is what the bank
// said. The revolving half is DERIVED from the tranches, because its schedule
// may not have been generated yet — and because counting generated revolving
// instalments as well as the tranches they came from would double the debt the
// moment somebody pressed a button.

export interface DueInstalment {
  due_date: string
  principal_amount: number
  interest_amount: number
}

export interface DueRow {
  month: string
  annuityPrincipal: number
  annuityInterest: number
  revolvingPrincipal: number
  revolvingInterest: number
  principal: number
  interest: number
  total: number
}

export interface BalancePoint {
  month: string
  /** Principal still owed at the END of this month. */
  annuity: number
  revolving: number
  total: number
}

const r2 = (n: number) => Math.round(n * 100) / 100

export function addMonths(month: string, n: number): string {
  const [y, m] = month.split('-').map(Number)
  const t = y * 12 + (m - 1) + n
  return `${Math.floor(t / 12)}-${String((t % 12) + 1).padStart(2, '0')}`
}

/** Whole months from `a` to `b`, negative when `b` is earlier. */
export function monthsBetween(a: string, b: string): number {
  const [ay, am] = a.split('-').map(Number)
  const [by, bm] = b.split('-').map(Number)
  return (by * 12 + bm) - (ay * 12 + am)
}

/**
 * One row per month, from `from` for `months` months.
 *
 * EVERY MONTH IN THE RANGE IS PRESENT, including the ones with nothing due.
 * A chart built from only the months that carry a payment draws a smooth line
 * over a six-month gap and says the debt was being serviced throughout it.
 *
 * Anything falling before the window is folded into the first month rather
 * than dropped: an overdue instalment is still owed, and a schedule that
 * quietly omits it understates exactly the figure somebody is checking.
 */
export function monthlyDue(opts: {
  annuity: DueInstalment[]
  revolving: DueInstalment[]
  from: string
  months: number
}): DueRow[] {
  const { from, months } = opts
  const rows: DueRow[] = []
  const index = new Map<string, DueRow>()

  for (let i = 0; i < Math.max(months, 0); i++) {
    const month = addMonths(from, i)
    const row: DueRow = {
      month,
      annuityPrincipal: 0, annuityInterest: 0,
      revolvingPrincipal: 0, revolvingInterest: 0,
      principal: 0, interest: 0, total: 0,
    }
    rows.push(row)
    index.set(month, row)
  }
  if (rows.length === 0) return rows

  const last = rows[rows.length - 1].month

  const put = (list: DueInstalment[], kind: 'annuity' | 'revolving') => {
    for (const i of list) {
      const m = (i.due_date || '').slice(0, 7)
      if (!m) continue
      // Before the window: it is still owed, so it lands on the first month
      // rather than disappearing. After it: genuinely outside what was asked
      // for, and the caller decides the horizon.
      const target = m < from ? rows[0] : index.get(m)
      if (!target || m > last) continue
      const p = Math.abs(i.principal_amount || 0)
      const n = Math.abs(i.interest_amount || 0)
      if (kind === 'annuity') { target.annuityPrincipal += p; target.annuityInterest += n }
      else { target.revolvingPrincipal += p; target.revolvingInterest += n }
    }
  }

  put(opts.annuity, 'annuity')
  put(opts.revolving, 'revolving')

  for (const r of rows) {
    r.annuityPrincipal = r2(r.annuityPrincipal)
    r.annuityInterest = r2(r.annuityInterest)
    r.revolvingPrincipal = r2(r.revolvingPrincipal)
    r.revolvingInterest = r2(r.revolvingInterest)
    r.principal = r2(r.annuityPrincipal + r.revolvingPrincipal)
    r.interest = r2(r.annuityInterest + r.revolvingInterest)
    r.total = r2(r.principal + r.interest)
  }
  return rows
}

/**
 * How much principal is still owed at the end of each month.
 *
 * Interest is not in this at all, and that is the whole distinction: interest
 * is the price of carrying the debt, the balance is the debt. Adding them
 * together gives a curve that falls when interest is paid, which is not
 * something that happens.
 *
 * Never below zero: a schedule that repays more principal than was opened with
 * is a data error, and drawing it as a negative balance turns a fault into a
 * picture of the company lending money to its bank.
 */
export function balanceSeries(
  due: DueRow[], opening: { annuity: number; revolving: number },
): BalancePoint[] {
  let a = opening.annuity
  let r = opening.revolving
  return due.map(row => {
    a = Math.max(r2(a - row.annuityPrincipal), 0)
    r = Math.max(r2(r - row.revolvingPrincipal), 0)
    return { month: row.month, annuity: a, revolving: r, total: r2(a + r) }
  })
}

/**
 * The figures a strip above the charts should carry.
 *
 * `peak` is the single heaviest month and when it falls — the number that
 * decides whether a revolving maturity needs refinancing rather than paying,
 * and the one a run of averages hides completely.
 */
export function debtFigures(due: DueRow[], balance: BalancePoint[]): {
  principal: number
  interest: number
  total: number
  peak: { month: string; amount: number } | null
  next12: number
  clearsIn: number | null
  openingBalance: number
} {
  const principal = r2(due.reduce((s, d) => s + d.principal, 0))
  const interest = r2(due.reduce((s, d) => s + d.interest, 0))

  let peak: { month: string; amount: number } | null = null
  for (const d of due) {
    if (d.total > 0 && (!peak || d.total > peak.amount)) {
      peak = { month: d.month, amount: d.total }
    }
  }

  const next12 = r2(due.slice(0, 12).reduce((s, d) => s + d.total, 0))

  // The first month the balance reaches zero and stays there, counted from
  // the start of the window. Null when it does not clear inside it — which is
  // the honest answer, and better than a number that means "at least this".
  let clearsIn: number | null = null
  for (let i = 0; i < balance.length; i++) {
    if (balance[i].total <= 0) { clearsIn = i + 1; break }
  }

  return {
    principal, interest, total: r2(principal + interest),
    peak, next12, clearsIn,
    openingBalance: balance.length > 0
      ? r2(balance[0].total + due[0].principal)
      : 0,
  }
}

/** Remaining obligation per credit, largest first — where the debt actually is. */
export function byCredit(
  rows: { creditId: string; name: string; kind: 'annuity' | 'revolving'; principal: number; interest: number | null }[],
): { creditId: string; name: string; kind: 'annuity' | 'revolving'; principal: number; interest: number | null; total: number }[] {
  return rows
    .map(r => ({ ...r, total: r2(r.principal + (r.interest ?? 0)) }))
    .sort((a, b) => b.total - a.total || b.principal - a.principal)
}

/**
 * The earliest instalment still to come, whatever order the rows arrive in.
 *
 * This was a `.find` on the page, which was correct only because the query it
 * read came back ordered by due date. The moment that list became the one
 * every row is drawn from — ordered by credit and instalment number instead —
 * the same `.find` named whichever future instalment happened to sort first.
 * It would have been wrong on most days and looked like a date either way.
 */
export function earliestDue(
  rows: { due_date: string }[], onOrAfter: string,
): string {
  return rows.reduce<string>(
    (soonest, r) =>
      r.due_date && r.due_date >= onOrAfter && (!soonest || r.due_date < soonest)
        ? r.due_date : soonest,
    '')
}

/** How many of them are already past due. */
export function overdueCount(rows: { due_date: string }[], today: string): number {
  return rows.filter(r => r.due_date && r.due_date < today).length
}
