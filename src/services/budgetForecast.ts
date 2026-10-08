// ─── Budget forecast arithmetic ─────────────────────────────────────────────
//
// Everything on the Budgeting page that is a table of inputs and outputs lives
// here, with no Supabase import, so it can be tested without a database.
//
// The page supplies rows; this decides what they mean.
//
// ── Currency ────────────────────────────────────────────────────────────────
//
// Budgets are planned in RSD, the currency the books are kept in. Every input
// this arithmetic reads carries its figure in EUR beside the RSD one — actuals
// as `amount_rsd` / `amount_eur`, ledger entries as `amount_rsd` /
// `amount_eur` and `seed_rsd` / `seed_eur` — so the same arithmetic runs in
// either, by reading the other column. Nothing here converts one into the
// other except a credit instalment, which is a schedule in the credit's own
// currency and is priced through `bookAmountsAtRate` like any other document.
//
// The functions take the currency to read as their last argument, defaulting
// to RSD. A figure missing in the currency asked for is never read as zero
// where that would move a typed budget: see `ledgerFigure`.

import { CREDIT_PRINCIPAL, CREDIT_INTEREST } from './creditClassification'
import { bookAmountsAtRate, round2 } from './bookAmounts'
import { projectKeySuffix } from './budgetKeys'

/** The two currencies a budget can be read in. */
export type BudgetCurrency = 'RSD' | 'EUR'

/** `row[base_rsd]` or `row[base_eur]` as a number; null when absent or unreadable. */
export function figureIn(row: object, base: string, currency: BudgetCurrency): number | null {
  const v = (row as Record<string, unknown>)[`${base}_${currency.toLowerCase()}`]
  if (v === null || v === undefined || v === '') return null
  const n = typeof v === 'number' ? v : Number(v)
  return Number.isFinite(n) ? n : null
}

/** A month as 'YYYY-MM'. */
export type MonthKey = string

export type Level =
  | 'pl_category' | 'pl_subcategory'
  | 'department' | 'dept_subcategory'
  | 'expense_description'

/** A row of v_pl_entries, narrowed to what the forecast reads. */
export interface SourceEntry {
  /**
   * Which company the spend belongs to. Optional only because most of what
   * reads a `SourceEntry` does not care; `seedFromEntries` keeps a per-company
   * breakdown from it, and a row without one is filed under `''`.
   */
  company_id?: string | null
  /**
   * The row's own project (a split line's, not its document's); null is
   * overhead. Part of the budget line the row seeds — see `budgetLineKey`.
   */
  project_id?: string | null
  pl_category: string | null
  pl_subcategory: string | null
  department: string | null
  dept_subcategory: string | null
  expense_description: string | null
  /** Book amount in RSD. */
  amount_rsd: number | null
  /** The same in EUR. */
  amount_eur?: number | null
  cf_type: string | null
  cf_frequency: string | null
  pl_date: string
}

/**
 * The five classification levels joined into one key.
 *
 * A missing level stays as an empty segment rather than being dropped, so
 * `A|B|C||` and `A|B|C` can never collide.
 */
export function classificationKey(e: {
  pl_category: string | null
  pl_subcategory: string | null
  department: string | null
  dept_subcategory: string | null
  expense_description: string | null
}): string {
  return [
    e.pl_category || '', e.pl_subcategory || '',
    e.department || '', e.dept_subcategory || '',
    e.expense_description || '',
  ].join('|')
}

/**
 * The budget line a row belongs to: its classification and, when it has one,
 * its project. Exactly `makeClassKey` in ./budgetKeys — an overhead row's key
 * is its bare `classificationKey`, so a budget without projects keys as it
 * always did.
 *
 * `classificationKey` stays classification-only on purpose: the credit check
 * below compares classifications, and a project must never stop an instalment
 * from being recognised as one.
 */
export function budgetLineKey(e: Parameters<typeof classificationKey>[0] & { project_id?: string | null }): string {
  return classificationKey(e) + projectKeySuffix(e.project_id)
}

/**
 * Whether an entry is one leg of a credit instalment payment.
 *
 * Exact, by construction: the two classifications this app writes for the two
 * legs are declared once in `creditClassification` and compared here on all
 * five levels at once, through the same `classificationKey` everything else
 * groups by. A row agreeing on four of the five is not a credit payment and is
 * not treated as one — which is the whole point of matching the classification
 * rather than a name or a substring of one.
 *
 * It exists because a credit payment is the one spend whose FUTURE the app
 * already knows exactly. See the call site in `seedFromEntries`.
 */
export function isCreditPayment(e: {
  pl_category: string | null
  pl_subcategory: string | null
  department: string | null
  dept_subcategory: string | null
  expense_description: string | null
}): boolean {
  const key = classificationKey(e)
  return key === classificationKey(CREDIT_PRINCIPAL)
    || key === classificationKey(CREDIT_INTEREST)
}

export interface SeedResult {
  /** budget line key (`budgetLineKey`) -> month -> seeded amount, every company merged. */
  byKey: Record<string, Record<MonthKey, number>>
  /**
   * The same seeds kept apart: company -> classification key -> month.
   *
   * The merged view is what the TREE is built from, and rightly so: with
   * several companies selected, the group's Sales line is both companies'
   * Sales spend. But a carried-over `set` belongs to one company and says what
   * that company's line reads, so the base it is measured against has to be
   * that company's alone. Resolving it against the merged seed turns a +200
   * into a -800 the moment a second company is on screen. See `seedForEntry`.
   */
  byCompany: Record<string, Record<string, Record<MonthKey, number>>>
  /** Benchmark-month spend that is carried into no month at all. */
  notCarried: number
}

/** Months between two 'YYYY-MM' keys, positive when `b` is later. */
function monthsBetween(a: MonthKey, b: MonthKey): number {
  const [ay, am] = a.split('-').map(Number)
  const [by, bm] = b.split('-').map(Number)
  return (by - ay) * 12 + (bm - am)
}

/**
 * How many months apart two occurrences of a cost are, or 0 when it is carried
 * forward at all.
 *
 * Anything not tagged `recurring` — one-time, capex, an untagged row — has no
 * next occurrence to forecast, so it is not stepped into any month.
 */
export function carryStep(e: { cf_type: string | null; cf_frequency: string | null }): number {
  if (e.cf_type !== 'recurring') return 0
  return e.cf_frequency === 'quarterly' ? 3
    : e.cf_frequency === 'yearly' ? 12
    : 1
}

/**
 * Whether a benchmark-month entry is carried into `month`.
 *
 * The drill under a budget cell lists the entries that seeded it, so it has to
 * ask exactly the question `seedFromEntries` answered. It asks it here rather
 * than in a second copy of the rule — a copy is what lets a list stop matching
 * the number it was opened from.
 */
export function carriesInto(
  e: { cf_type: string | null; cf_frequency: string | null },
  benchmark: MonthKey,
  month: MonthKey,
): boolean {
  const step = carryStep(e)
  if (step === 0) return false
  const gap = monthsBetween(benchmark, month)
  return gap > 0 && gap % step === 0
}

/**
 * What each classification is expected to cost in each month ahead, taken from
 * the benchmark month and the cash-flow classification already on the rows.
 *
 * A quarterly or yearly amount lands in the month it actually falls due. It is
 * deliberately NOT divided across the months in between: spreading it hides
 * that one month takes several times the outflow of its neighbours, which is
 * the thing a cash budget exists to show.
 *
 * Anything not carried forward is summed into `notCarried` rather than quietly
 * dropped, so the page can say how short the forecast is. One exception, and
 * only one: a credit instalment leg, which `commitmentsByMonth` already states
 * exactly. See the note at the check itself.
 */
export function seedFromEntries(
  entries: SourceEntry[],
  months: MonthKey[],
  benchmark: MonthKey,
  currency: BudgetCurrency = 'RSD',
): SeedResult {
  const byKey: Record<string, Record<MonthKey, number>> = {}
  const byCompany: SeedResult['byCompany'] = {}
  let notCarried = 0

  for (const e of entries) {
    if (e.pl_date.slice(0, 7) !== benchmark) continue
    const amount = figureIn(e, 'amount', currency) || 0

    // ── The one spend whose future is KNOWN, not estimated ─────────────────
    //
    // This is not "a special case for credits" and deleting it puts every
    // monthly instalment back on the page twice.
    //
    // A credit payment is posted with `cf_type: 'recurring', monthly` — every
    // dialog that books one does it, and correctly, because that is what the
    // payment IS. But the same instalment ALSO has a dated schedule in
    // `credit_installments`, exact to the cent, principal and interest apart,
    // and `commitmentsByMonth` puts that schedule in the months ahead. Seeding
    // it from the benchmark month as well carries one payment into every month
    // of the horizon underneath the real schedule, and the horizon reads
    // double for it.
    //
    // The invoice overlap is resolved the other way round — the commitment is
    // skipped and the seed kept — because there the seed stands for a
    // recurrence worth keeping. Here it does not: the seed is a worse
    // approximation of the very thing the schedule states exactly, so the
    // schedule wins and the estimate goes.
    //
    // NOT counted in `notCarried`. That number means "this spend appears in no
    // month of the forecast", and a credit instalment appears in every month it
    // falls due — it simply arrives from `commitmentsByMonth` instead of from
    // here. Adding it would send someone looking for a shortfall that is not
    // there. Checked BEFORE `carryStep` for exactly that reason, so a credit
    // leg booked as anything other than recurring is left out too rather than
    // reported missing.
    if (isCreditPayment(e)) continue

    if (carryStep(e) === 0) { notCarried += amount; continue }

    const key = budgetLineKey(e)
    const company = e.company_id || ''
    if (!byCompany[company]) byCompany[company] = {}
    const perCompany = byCompany[company]

    for (const m of months) {
      if (!carriesInto(e, benchmark, m)) continue
      if (!byKey[key]) byKey[key] = {}
      byKey[key][m] = (byKey[key][m] || 0) + amount
      if (!perCompany[key]) perCompany[key] = {}
      perCompany[key][m] = (perCompany[key][m] || 0) + amount
    }
  }

  return { byKey, byCompany, notCarried }
}

/**
 * What the credit schedule puts in each month, on each leg's own row.
 *
 * THE ONE EXPENSE WHOSE FUTURE IS KNOWN TO THE CENT. Every other line in this
 * forecast is the benchmark month carried forward by a cash-flow flag, which
 * is an estimate dressed as a figure. A credit instalment has a dated
 * schedule: principal and interest, apart, on a stated day, agreed with a bank
 * years ago. Estimating it from last month's payment would be replacing the
 * answer with a guess at it.
 *
 * It is keyed on `CREDIT_PRINCIPAL` and `CREDIT_INTEREST` — the same two
 * classifications the three dialogs that book a credit payment write, declared
 * once in `creditClassification`. So the schedule lands on exactly the rows
 * the actual payments land on, in both branches of the tree, and the estimate
 * and the actual beside it are the same two lines.
 *
 * EVERY INSTALMENT IN THE MONTH, whatever its status. An instalment paid on
 * the 3rd cost the same as one still due on the 30th, and a schedule that
 * counts only what is outstanding melts away as the month is paid — the
 * estimate falls to nothing while the actual rises, and the variance reads as
 * an overspend of the whole amount. There are only two statuses, `paid` and
 * `outstanding`, so this is every row of the schedule and nothing else.
 */
export function creditScheduleByMonth(
  installments: Installment[], months: MonthKey[], currency: BudgetCurrency = 'RSD',
): { byKey: Record<string, Record<MonthKey, number>>; total: number; unpriced: string[] } {
  const horizon = new Set(months)
  const byKey: Record<string, Record<MonthKey, number>> = {}
  let total = 0
  /** Instalments that could not be priced in `currency` — no rate for them. */
  const unpriced: string[] = []

  const principalKey = classificationKey(CREDIT_PRINCIPAL)
  const interestKey = classificationKey(CREDIT_INTEREST)

  const add = (key: string, month: MonthKey, amount: number) => {
    const cents = Math.round(amount * 100) / 100
    if (!cents) return
    if (!byKey[key]) byKey[key] = {}
    byKey[key][month] = Math.round(((byKey[key][month] || 0) + cents) * 100) / 100
    total += cents
  }

  for (const i of installments) {
    const month = (i.due_date || '').slice(0, 7)
    if (!month || !horizon.has(month)) continue
    const principal = priceInstallment(i.principal_amount || 0, i, currency)
    const interest = priceInstallment(i.interest_amount || 0, i, currency)
    // Left out, and named, rather than priced at a guess. A forecast figure
    // from a made-up rate looks exactly like one from a real rate.
    if (principal === null || interest === null) { unpriced.push(i.id); continue }
    add(principalKey, month, principal)
    add(interestKey, month, interest)
  }

  return { byKey, total: Math.round(total * 100) / 100, unpriced }
}

/**
 * One leg of an instalment in `currency`.
 *
 * In its own currency it is the scheduled figure as it stands, and needs no
 * rate. Otherwise it is booked at the instalment's planning rates the way any
 * document is (`bookAmountsAtRate`); without them it is null — unpriced.
 */
export function priceInstallment(amount: number, i: Installment, currency: BudgetCurrency): number | null {
  const own = (i.currency || 'RSD').toUpperCase()
  if (own === currency) return round2(amount)
  try {
    const b = bookAmountsAtRate(amount, own, i.exchangeRate, i.eurRate)
    return currency === 'RSD' ? b.amount_rsd : b.amount_eur
  } catch {
    return null
  }
}

/** A credit instalment from the schedule, with the rates to price it. */
export interface Installment {
  id: string
  credit_name: string
  installment_no: number
  due_date: string
  principal_amount: number
  interest_amount: number
  status: string
  /** The credit's currency — what the schedule's figures are in. RSD when absent. */
  currency?: string | null
  /**
   * RSD per 1 unit of `currency`, the rate the horizon is planned at. Nobody
   * knows the rate on a date that has not arrived, so it is one rate for the
   * whole horizon. Null when it could not be read.
   */
  exchangeRate: number | null
  /** RSD per 1 EUR, the same day. Null when it could not be read. */
  eurRate: number | null
}

export interface OpenInvoice {
  id: string
  partner_name: string
  /**
   * The invoice's OWN date — `invoices.invoice_date`, which is what
   * `v_pl_entries` exposes as `pl_date`. Not the due date, and not
   * interchangeable with it: this is the date that decides whether the seed
   * already carries this invoice. See `commitmentsByMonth`.
   */
  invoice_date: string | null
  due_date: string | null
  /** What is still owed, in RSD. */
  remaining_rsd: number
  /** The same in EUR. */
  remaining_eur?: number | null
  /**
   * The invoice's cash-flow classification, which decides whether the seed
   * actually carried it — not merely whether it could have.
   *
   * `seedFromEntries` carries a benchmark-month entry forward only when
   * `cf_type` is `recurring`, and then only into the months its frequency
   * falls on. An invoice dated in the benchmark month that is one-time, or
   * quarterly and not due on a quarter boundary, is carried into NO month —
   * and used to be skipped here anyway, on the date alone. Not doubled: lost.
   */
  cf_type: string | null
  cf_frequency: string | null
  /**
   * Whether this invoice reaches the P&L — `invoices.pl_impact`. It decides
   * whether the seed could ever have seen the invoice, because `v_pl_entries`
   * takes only `pl_impact = true`. See `commitmentsByMonth`.
   */
  pl_impact: boolean
}

// ─── NOT PART OF BUDGETING ──────────────────────────────────────────────────
//
// Everything from here to the end of this section is about what is OWED and
// WHEN — due dates, paid and unpaid. None of it belongs in a budget.
//
// Budgeting is read from the P&L. An invoice dated 31 August is an August
// cost, whether or not it has been paid and whenever it happens to fall due;
// September's figure is August's carried forward by the recurring/one-time
// rule and nothing else. Mixing a due date into that column answers a
// question the column is not asking, and the Committed row did exactly that:
// it took Google's unpaid August invoice, filed it in September by its due
// date, and added it on top of a September estimate that already stood for
// September's Google bill.
//
// It is kept — not deleted — because the question it answers is a real one
// and has a page coming: what leaves the bank, and when. Cash Flow is where
// due dates belong. Until that page reads it, nothing does.

export interface CommitmentItem {
  id: string
  label: string
  /** In the currency `commitmentsByMonth` was asked for. */
  amount: number
  kind: 'installment' | 'invoice'
  /** Its due date has already passed. Owed now, not later. */
  overdue?: boolean
  /** `YYYY-MM` it was actually due, where that is not the month it is filed in. */
  dueMonth?: MonthKey
}

export interface Commitments {
  byMonth: Record<MonthKey, { total: number; items: CommitmentItem[] }>
}

/**
 * What is already owed in each month ahead.
 *
 * These are not estimates and are not seeded from history: a credit instalment
 * has a dated schedule and an unpaid invoice has a due date. Keeping them
 * separate from the seeded base is what lets the drill show a budget that
 * cannot silently absorb a commitment.
 *
 * ── Why this needs the benchmark month ──────────────────────────────────────
 *
 * The seed and this list overlap, and the overlap is not a design choice that
 * can be tidied away — it falls out of what `v_pl_entries` is. That view
 * carries an invoice from the moment it is RAISED, at its `invoice_date`, with
 * no regard to whether it has been paid. `seedFromEntries` reads the benchmark
 * month out of that view, so an invoice dated in the benchmark month is
 * already carried forward into every month ahead by its `cf_type`, paid or
 * not. Adding it here as well, at its `due_date`, puts one bill in one month
 * twice.
 *
 * Telekom is the shape of it: invoice dated 2026-08-20, due 2026-09-20, 49.000 RSD,
 * unpaid, recurring monthly, benchmark 2026-08. September's seed carries 49.000 RSD
 * and September's Committed row carried the same 49.000 RSD, so September read 98.000 RSD
 * for one 49.000 RSD bill.
 *
 * So an invoice whose own date falls in the benchmark month is skipped HERE,
 * where the double entry is, rather than in the seed, where dropping it would
 * lose the recurrence it stands for. An invoice dated in any other month is
 * not seeded and is a genuine commitment — do not widen this to "any unpaid
 * invoice", which is how the Committed row stops showing what is owed.
 *
 * ── How far the overlap reaches: only as far as the seed's own filter ───────
 *
 * All of that holds for invoices the seed can actually SEE. The invoice branch
 * of `v_pl_entries` is `FROM invoices i WHERE i.type = 'expense' AND
 * i.pl_impact = true`, so an invoice outside that filter is in no seed for any
 * month. Skipping it here prevents no double count — it deletes the money from
 * the forecast.
 *
 * A payroll filing is the shape of that one. `PayrollDialog` books the parent
 * payable — the tax and contributions owed to the state — with
 * `pl_impact: false`, and the per-employee P&L rows as `pl_impact: true`
 * children beneath it. The parent is therefore never in `v_pl_entries`, but it
 * is an unpaid invoice carrying an `invoice_date`, so the benchmark rule
 * skipped it anyway and a whole filing dated in the benchmark month vanished
 * from the Committed row. Not doubled: lost.
 *
 * So the skip tests `pl_impact` as well. The caller filters on
 * `type = 'expense'` before this is reached, which is the other half of the
 * seed's filter; between them the skip covers exactly the invoices the seed
 * could have carried, and nothing else. Do not narrow it back to the date
 * alone.
 *
 * The `pl_impact: true` children cannot double-count in their own right:
 * `v_invoice_status` is defined `WHERE i.parent_invoice_id IS NULL`, so they
 * never reach this function.
 */
export function commitmentsByMonth(
  invoices: OpenInvoice[],
  months: MonthKey[],
  benchmark: MonthKey,
  currency: BudgetCurrency = 'RSD',
): Commitments {
  const horizon = new Set(months)
  const byMonth: Commitments['byMonth'] = {}

  const add = (month: MonthKey, item: CommitmentItem) => {
    if (!horizon.has(month)) return
    if (!byMonth[month]) byMonth[month] = { total: 0, items: [] }
    byMonth[month].total += item.amount
    byMonth[month].items.push(item)
  }

  // ── Credit instalments are NOT here any more ────────────────────────────
  //
  // They used to be, and this row carried two banks' instalments beside a
  // small payment-card invoice. Two objections to that and
  // the second is the one that matters.
  //
  // It reads wrong: "Committed" sits under the table as one line with no
  // category, so the largest single outflow of the month was the only one
  // with nowhere to look it up. The credit rows above it estimated NOTHING —
  // a dash in every month — because the seed skips them on the grounds that
  // the schedule states them exactly, and the schedule was being spent on a
  // row that says only a total.
  //
  // And it is the wrong shape. A commitment is money owed that the budget
  // does not otherwise know about. A credit instalment is the opposite: the
  // one expense whose future is known to the cent, split into principal and
  // interest, with a classification already declared for both legs. That
  // belongs IN the budget, on the rows it is classified to — which is what
  // `creditScheduleByMonth` now does.
  //
  // What is left here is what the row was always for: unpaid invoices with a
  // due date, like the payment card.

  // The first month of the horizon, which is where anything already overdue
  // is filed. `months` arrives in order.
  const firstMonth = months[0]

  for (const v of invoices) {
    // No due date means no month to file it under. Guessing one would put real
    // money in the wrong month, which is worse than leaving it out.
    if (!v.due_date) continue
    const dueMonth = v.due_date.slice(0, 7)

    // ── Already in the seed — but ONLY where the seed really carried it ────
    //
    // `pl_impact` and the benchmark date say the seed could have SEEN this
    // invoice. They do not say it carried it. `seedFromEntries` carries a
    // benchmark entry forward only when `cf_type` is `recurring`, and then
    // only into the months its frequency lands on — so a one-time invoice
    // dated in the benchmark month goes into no month of the forecast at all,
    // and a quarterly one goes into one month in three.
    //
    // Skipping those here on the date alone did not prevent a double count.
    // It deleted them: absent from the seed, absent from this row, and
    // present only inside the `notCarried` total under the table, which
    // names no invoice and no month. It is the same fault the `pl_impact`
    // clause was added for, one layer further in.
    //
    // `carriesInto` is the seed's own rule, imported rather than restated,
    // so the two cannot drift into disagreeing about which months overlap.
    const seedCarriesIt = v.pl_impact
      && v.invoice_date
      && v.invoice_date.slice(0, 7) === benchmark
      && carriesInto(v, benchmark, dueMonth)
    if (seedCarriesIt) continue

    // ── Overdue is owed NOW ────────────────────────────────────────────────
    //
    // An invoice whose due date has passed and which is still unpaid was
    // being dropped for falling before the horizon — the one class of
    // commitment that is not a forecast at all but a debt standing today.
    // It is filed in the first month and says so.
    const before = dueMonth < firstMonth
    add(before ? firstMonth : dueMonth, {
      id: v.id,
      label: v.partner_name,
      amount: figureIn(v, 'remaining', currency) || 0,
      kind: 'invoice',
      ...(before ? { overdue: true, dueMonth } : {}),
    })
  }

  return { byMonth }
}

export interface Adjustment {
  id: string
  kind: 'set' | 'adjust'
  /** In RSD — what was typed, or the difference it made. */
  amount_rsd: number
  /**
   * The same in EUR, at the NBS rate of the day it was recorded. Null on an
   * entry recorded in dinars only; such a ledger cannot be read in EUR.
   */
  amount_eur?: number | null
  reason: string
  created_at: string
  /**
   * The project the entry budgets for; null or absent is an overhead line.
   * A node's ledger is replayed per project — see `loadBudgetTree`.
   */
  project_id?: string | null
  /**
   * The seed this entry's node carried, in this month, at the moment the
   * figure was typed, in RSD. `budget_adjustments.seed_rsd`.
   *
   * Null or absent on every entry written before the column existed, and that
   * is not a defect to be filled in: what the seed was on a given afternoon is
   * not recoverable, and inventing it would move money the owner never typed.
   * Those entries keep the old behaviour until the figure is recorded again.
   *
   * See `pinnedBase` for what it is for.
   */
  seed_rsd?: number | null
  /** The same seed in EUR — read off the EUR actuals it was seeded from. */
  seed_eur?: number | null
}

/**
 * Whether every entry carries its figure in `currency`.
 *
 * A ledger with an entry in dinars only cannot be replayed in euros: reading
 * the missing figure as zero would drop a decision somebody typed, and the
 * cell would show a budget nobody set. The page reads such a budget in RSD
 * instead, and says so.
 */
export function ledgerReadableIn(adjustments: Adjustment[], currency: BudgetCurrency): boolean {
  return adjustments.every(a => figureIn(a, 'amount', currency) !== null)
}

/** An entry's amount in `currency`. Throws where it has none — see `ledgerReadableIn`. */
export function ledgerFigure(a: Adjustment, currency: BudgetCurrency): number {
  const n = figureIn(a, 'amount', currency)
  if (n === null) {
    throw new Error(`Izmena budžeta ${a.id} nema iznos u ${currency}, pa se budžet ne može prikazati u ${currency}.`)
  }
  return n
}

/**
 * The base a cell's deltas are replayed on top of.
 *
 * ── THE FAULT THIS EXISTS FOR ────────────────────────────────────────────────
 *
 * The benchmark month is whatever month precedes today. Nobody chooses it and
 * nothing stores it, so it changes by itself at midnight on the 1st — and with
 * it every seed on the page.
 *
 * A typed figure was stored as the difference between it and the seed. That is
 * fine for as long as the seed holds still, and the seed holds still for as
 * long as the month does. Budgeting November during October, the seed was
 * September's spend carried forward; the owner typed 1.450.000 RSD and the cell read
 * 1.450.000 RSD. In November the benchmark became October, the seed became October's
 * spend, and the cell read 1.450.000 RSD plus the difference between two months of
 * actuals — a figure nobody typed, different on every line, and wrong in a
 * direction that depends on which way last month went.
 *
 * ── THE RULE ─────────────────────────────────────────────────────────────────
 *
 * A budget is a decision, not a derived quantity. Once a figure has been typed
 * it reads back as typed until somebody types another one. So each entry
 * records the seed it was measured against, and the most recent recorded seed
 * is the base — the live one is used only for a line nobody has touched, where
 * a fresher benchmark is a better estimate and SHOULD move it.
 *
 * Replaying every delta on the newest base is what makes this exact rather than
 * approximately right. The newest entry's delta was taken against the cell as
 * it stood, which already contained the older deltas, so they have to be
 * replayed for its arithmetic to come out: base + d₁ + d₂ where
 * d₂ = target − (base + d₁) is precisely `target`.
 *
 * It also means one re-typed figure anchors a drifted line again, which is the
 * whole of the repair for everything recorded before this existed.
 */
export function pinnedBase(
  inLedgerOrder: Adjustment[], liveSeed: number, currency: BudgetCurrency = 'RSD',
): number {
  for (let i = inLedgerOrder.length - 1; i >= 0; i--) {
    const pinned = (inLedgerOrder[i] as any)[`seed_${currency.toLowerCase()}`]
    if (pinned === null || pinned === undefined) continue
    // Coerced, and not for tidiness. Postgres `numeric` reaches some clients as
    // a string, and a string base would make the first `value += delta` a
    // concatenation: a base of 11900 and a delta of 500 would read 11900500.
    // A base that cannot be read as a figure is no base at all.
    const n = Number(pinned)
    if (Number.isFinite(n)) return n
  }
  return liveSeed
}

/**
 * What a budget cell reads, from the base it is handed and its change ledger.
 *
 * A figure is never overwritten. The most recent `set` replaces the base;
 * every `adjust` recorded after it moves the running value. A mistake is undone
 * with a counter-entry, not a delete, so the trail stays complete.
 *
 * This used to say a `set` replaces "the seeded base", and that was written
 * when there was one arrangement of the levels to be seeded against. There are
 * two. The department branch and the P&L branch are the same five levels read
 * in two orders, so one entry lands on a node seeded 1000 in one and on a node
 * seeded 3000 in the other — the P&L node holds Sales and Engineering salaries
 * together. A `set` of 5000 replacing a per-node base therefore moved the two
 * branch totals by different amounts, and they disagreed by the difference
 * between the two bases. `set` is the only kind that can do that: an `adjust`
 * contributes its own amount wherever it lands, which is why the branches
 * already agreed for everything the dialog writes.
 *
 * So the honest statement of the contract is the weaker one above: a `set`
 * replaces whatever base the CALLER hands over, and it is the caller's job to
 * hand over a base that does not depend on which branch is open. `Budgeting`
 * does not: it resolves each `set` into a branch-independent delta — the
 * amount less the seed of the entry's own classification, see `seedForEntry` —
 * before the ledger reaches here, so what arrives is an `adjust`. Nothing the
 * app writes is a `set` either; `BudgetChangeDialog` only ever inserts
 * `adjust`. The `set` arm stays because the rows carried over from the old
 * `budget_entries` screen are stored as `set` and this is what they mean.
 *
 * A `set` applies to its own node alone. It never touches a child's figure —
 * a parent is always the sum of what sits under it, by `rollUp`'s one rule. So
 * a `set` landing on a node that has children does not make that node read its
 * own number: it makes it read that number plus whatever the children carry
 * that the entry's own classification did not already account for.
 */
export function applyLedger(
  seededBase: number, adjustments: Adjustment[], currency: BudgetCurrency = 'RSD',
): number {
  const ordered = [...adjustments].sort(inLedgerOrder)

  // Not `seededBase` where anything has been typed: see `pinnedBase`, which is
  // where the reason lives. The live seed moves when the month turns over, and
  // a figure somebody decided on must not move with it.
  let value = pinnedBase(ordered, seededBase, currency)
  for (const a of ordered) {
    const amount = ledgerFigure(a, currency)
    if (a.kind === 'set') value = amount
    else value += amount
  }
  return value
}

/**
 * The order a ledger is replayed in: `created_at`, then `id` to break a tie.
 *
 * Exported because anything DISPLAYING a ledger has to list it in the order it
 * was applied in, and a second copy of the comparator is how a list starts
 * describing a different replay from the one that produced the figure.
 */
export function inLedgerOrder(a: Adjustment, b: Adjustment): number {
  return a.created_at < b.created_at ? -1
    : a.created_at > b.created_at ? 1
    : a.id < b.id ? -1 : 1
}

/**
 * The ledger entry for a figure someone typed.
 *
 * The dialog asks for the number the cell should read, not the difference —
 * working out the difference is arithmetic, and arithmetic is the app's job.
 */
export function deltaForTarget(current: number, target: number): number {
  return Math.round((target - current) * 100) / 100
}

export interface ForecastNode {
  key: string
  label: string
  level: Level
  parent: string | null
  /** Carried forward from the benchmark month for this exact classification. */
  seed: number
  /** What this node's own change ledger resolves to. */
  ledger: number
  /** Spend recorded against this exact classification. */
  actual: number
}

export interface RolledNode extends ForecastNode {
  /** seed + ledger + every child's budget. */
  budget: number
  /** actual + every child's actualTotal. */
  actualTotal: number
  /** What sits on this node itself, shown as its own row under the children. */
  direct: number
}

/**
 * Totals every node from what sits on it and what its children carry.
 *
 *     budget(node) = seed + ledger + sum(budget(child))
 *
 * One rule for every node. A parent is always the sum, which is how the page
 * is used: figures are edited on the children and the parent follows.
 *
 * An amount entered directly on a parent is added, never substituted for the
 * children — it appears as its own visible row so it can never hide inside a
 * subtotal.
 */
export function rollUp(nodes: ForecastNode[]): RolledNode[] {
  const out: Record<string, RolledNode> = {}
  for (const n of nodes) {
    out[n.key] = { ...n, budget: n.seed + n.ledger, actualTotal: n.actual, direct: n.seed + n.ledger }
  }

  // Deepest first, so a child is finished before its parent reads it.
  const depth = (key: string): number => {
    let d = 0
    let cur = out[key]?.parent
    while (cur && out[cur]) { d++; cur = out[cur].parent }
    return d
  }
  const order = Object.keys(out).sort((a, b) => depth(b) - depth(a))

  for (const key of order) {
    const node = out[key]
    const parent = node.parent ? out[node.parent] : undefined
    if (!parent) continue
    parent.budget += node.budget
    parent.actualTotal += node.actualTotal
  }

  return Object.values(out)
}

/** Budget less actual: positive is under budget, negative is over. */
export function variance(budget: number, actual: number): number {
  return budget - actual
}
