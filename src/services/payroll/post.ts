// ─── Writing a posting plan to the ledger ───────────────────────────────────
//
// THE MONTH IS CLAIMED BEFORE ANYTHING IS CREATED. The first write is the
// `payroll_postings` row, whose unique index on (company, month, run) is what
// actually stops a month being posted twice — not a check in the page, which a
// double click or a second tab races straight past. If that insert is refused,
// nothing else has happened and the message says so plainly.
//
// Then the invoices, then the transactions, and finally the posting row is
// updated with everything's id so the whole thing can be found and undone. A
// posting that cannot be reversed is one nobody will dare to make.
//
// A REFUSAL PARTWAY THROUGH NAMES WHAT LANDED. supabase-js does not throw, so
// every write here is checked and bound to its step; the alternative is a
// success screen over a half-written payroll, which is how this codebase has
// been bitten before.

import { checkPlan, planTotal, type PostingPlan, type PlannedInvoice } from './posting'
import { bookAmountsAtRate, type BookAmounts } from '../bookAmounts'
import { saveSplits } from '../saveSplits'
import type { SplitLine } from '../expenseSplit'
import { firstOfMonth } from './timesheets'

export interface PostContext {
  companyId: string
  /** The saved run these entries come from. Posting freezes it. */
  runId?: string | null
  /** Датум исплате — the date every invoice carries. */
  paymentDate: string
  /**
   * Датум доспећа — the last working day of the month being posted.
   *
   * Not the last day of the month, and not the same weekday twice: September
   * 2026 ends on a Wednesday and falls due on the 30th; a month ending on a
   * Saturday falls due on the Friday, and one whose last weekday is a holiday
   * falls due before that. `lastWorkingDayOf` works it out.
   */
  dueDate?: string | null
  /**
   * Број фактуре — the month, as `2026-09`.
   *
   * Every row of one payroll carries the same one, which is the point: it is
   * the period's number, not a per-invoice serial, and `invoice_number` is
   * deliberately not unique in this database for exactly this kind of reason.
   */
  invoiceNumber?: string | null
  /** The currency the payroll is posted in — RSD, the currency it is calculated in. */
  currency: string
  /**
   * RSD per 1 EUR on the payment date (NBS middle rate), for `eur_rate` and
   * `amount_eur` on every row written. Payroll is booked in dinars at an
   * exchange_rate of 1; this is only the rate the euro figure beside it is
   * read at. Missing, nothing is written.
   */
  eurRate: number | null
  note?: string | null
}

export interface PostResult {
  postingId: string
  invoiceIds: string[]
  transactionIds: string[]
}

/**
 * Thrown when one of the writes is refused, carrying which one.
 *
 * The step is in the MESSAGE as well as in the field. A caller that does the
 * obvious thing and shows `err.message` would otherwise put "permission
 * denied" on screen during a half-written payroll, which says nothing about
 * what landed and nothing about whether a retry is safe. `step` and `reason`
 * stay separate for a caller that wants to build its own wording.
 */
export class PostStepFailure extends Error {
  constructor(public step: string, public reason: string) {
    super(`It failed writing ${step}: ${reason}`)
    this.name = 'PostStepFailure'
  }
}

export function alreadyPostedMessage(month: string, runLabel: string): string {
  return `${runLabel} for ${month} has already been posted. Nothing was written. `
    + 'A payroll posted twice is not a wrong figure — it is a second complete set of '
    + 'invoices that reconciles against nothing and has to be unpicked by hand from a '
    + 'bank statement months later. Undo the existing posting first if it was wrong.'
}

/**
 * Write the plan.
 *
 * `client` is the supabase client. `plan` must already have passed
 * `checkPlan` — it is checked again here anyway, because the one thing worse
 * than refusing to post is posting something that does not add up.
 */
export async function postPlan(
  client: any, plan: PostingPlan, context: PostContext, runLabel: string,
): Promise<PostResult> {
  const why = checkPlan(plan)
  if (why) throw new Error(why)

  // Every row carries its book amounts, worked out the one way the whole
  // ledger works them out. A missing EUR rate throws here, BEFORE the month
  // is claimed: a payroll written without its euro figure would be correct in
  // dinars and missing from every report read in euros.
  const book = (amount: number): BookAmounts =>
    bookAmountsAtRate(amount, context.currency, null, context.eurRate)
  const postingRates = book(0)
  for (const i of plan.invoices) book(i.amount)
  for (const t of plan.transactions) book(t.amount)

  // 1. Claim the month. This is the guard, and it goes first.
  const { data: posting, error: claimErr } = await client
    .from('payroll_postings')
    .insert({
      company_id: context.companyId,
      period_month: firstOfMonth(plan.month),
      run_key: plan.runKey,
      posted_on: context.paymentDate,
      exchange_rate: postingRates.exchange_rate,
      eur_rate: postingRates.eur_rate,
      total_cost: planTotal(plan),
      run_id: context.runId ?? null,
      note: context.note || null,
    })
    .select('id')
    .single()

  if (claimErr) {
    if (isUniqueViolation(claimErr)) {
      throw new Error(alreadyPostedMessage(plan.month, runLabel))
    }
    throw new PostStepFailure('the posting record', claimErr.message)
  }
  const postingId = posting?.id
  if (!postingId) throw new PostStepFailure('the posting record', 'it returned no id')

  const invoiceIds: string[] = []
  const transactionIds: string[] = []

  // 2. The obligation parent before its children, so no child is an orphan.
  const parent = plan.invoices.find(i => i.kind === 'obligation_parent')
  let parentId: string | null = null
  if (parent) {
    parentId = await insertInvoice(client, parent, context, postingId, null, book)
    invoiceIds.push(parentId)
  }

  for (const invoice of plan.invoices) {
    if (invoice.kind === 'obligation_parent') continue
    const id = await insertInvoice(
      client, invoice, context, postingId,
      invoice.parentRef === 'obligation' ? parentId : null, book)
    invoiceIds.push(id)
  }

  for (const t of plan.transactions) {
    const { data, error } = await client.from('transactions').insert({
      company_id: context.companyId,
      partner_id: null,
      transaction_date: context.paymentDate,
      type: 'direct',
      tx_subtype: 'expense',
      currency: context.currency,
      amount: t.amount,
      ...book(t.amount),
      pl_impact: true,
      pl_category: t.pl_category,
      pl_subcategory: t.pl_subcategory,
      department: t.department,
      dept_subcategory: t.dept_subcategory,
      expense_description: t.expense_description,
      // Overhead. A storno cancels part of an expense booked elsewhere (the
      // FitPass bill, the insurance premium), which is not a site's cost, so
      // its reversal is not one either.
      project_id: null,
      status: 'posted',
      note: t.note,
    }).select('id').single()
    if (error) throw new PostStepFailure('the retained-deduction entries', error.message)
    if (data?.id) transactionIds.push(data.id)
  }

  // 3. Record what was created, so it can be undone.
  //
  // Last rather than first because the ids do not exist until now. If this
  // one write fails the posting still exists and still blocks a duplicate —
  // which is the right way round to fail: recoverable, and never a second
  // payroll.
  const { error: linkErr } = await client
    .from('payroll_postings')
    .update({ created_invoice_ids: invoiceIds, created_transaction_ids: transactionIds })
    .eq('id', postingId)
    .select('id')
  if (linkErr) {
    throw new PostStepFailure(
      'the record of what was created',
      `${linkErr.message}. Everything was posted correctly, but this posting cannot be `
      + 'undone from the page — the entries would have to be removed by hand.')
  }

  // 4. Freeze the run these entries were written from.
  //
  // LAST, because everything before it can still fail and a run frozen over a
  // half-written posting would need unfreezing by hand. The database refuses
  // to touch a posted run's lines from here on, which is what makes "this
  // month reproduces as it was posted" true rather than merely intended.
  if (context.runId) {
    const { data, error: freezeErr } = await client
      .from('payroll_runs')
      .update({ status: 'posted', posted_at: new Date().toISOString(), updated_at: new Date().toISOString() })
      .eq('id', context.runId)
      .select('id')
    if (freezeErr || !data || data.length === 0) {
      throw new PostStepFailure(
        'the lock on the calculated run',
        `${freezeErr?.message ?? 'the update matched no run'}. Everything was posted `
        + 'correctly, but the run is still marked as a draft — so it can be recalculated '
        + 'and would then disagree with the entries just written. Post it again, or '
        + 'delete this posting and start over.')
    }
  }

  return { postingId, invoiceIds, transactionIds }
}

/**
 * The project an invoice carries itself: its one project line's, or null when
 * it has none or is split (the split lines then carry the projects).
 */
export function ownProjectOf(invoice: PlannedInvoice): string | null {
  return invoice.projects.length === 1 ? invoice.projects[0].project_id : null
}

/** The split lines an invoice is written with; empty unless it has two or more projects. */
export function splitLinesFor(invoice: PlannedInvoice): SplitLine[] {
  if (invoice.projects.length < 2) return []
  return invoice.projects.map((p, i) => ({
    key: String(i),
    amount: p.amount,
    pl_category: invoice.pl_category,
    pl_subcategory: invoice.pl_subcategory,
    department: invoice.department ?? '',
    dept_subcategory: invoice.dept_subcategory ?? '',
    expense_description: invoice.expense_description,
    project_id: p.project_id,
    cf_type: invoice.cf_type,
    note: p.project_id ? 'Po satima na projektu' : 'Opšti troškovi — sati van projekata',
  }))
}

async function insertInvoice(
  client: any,
  invoice: PlannedInvoice,
  context: PostContext,
  postingId: string,
  parentId: string | null,
  book: (amount: number) => BookAmounts,
): Promise<string> {
  const booked = book(invoice.amount)
  const { data, error } = await client.from('invoices').insert({
    company_id: context.companyId,
    partner_id: invoice.partnerId,
    invoice_date: context.paymentDate,
    due_date: context.dueDate || null,
    invoice_number: context.invoiceNumber || null,
    type: 'expense',
    pl_category: invoice.pl_category,
    pl_subcategory: invoice.pl_subcategory,
    department: invoice.department,
    dept_subcategory: invoice.dept_subcategory,
    expense_description: invoice.expense_description,
    project_id: ownProjectOf(invoice),
    cf_type: invoice.cf_type,
    cf_frequency: 'monthly',
    // Nothing is expected next month from somebody who has left, and a
    // forecast that goes on predicting their salary does it silently.
    cf_next_month_est: invoice.cf_type === 'recurring' ? invoice.amount : 0,
    currency: context.currency,
    amount: invoice.amount,
    ...booked,
    pl_impact: invoice.pl_impact,
    status: 'unpaid',
    parent_invoice_id: parentId,
    note: `${invoice.note} [posting ${postingId}]`,
  }).select('id').single()

  if (error) throw new PostStepFailure(labelFor(invoice), error.message)
  if (!data?.id) throw new PostStepFailure(labelFor(invoice), 'it returned no id')

  // Shared over several projects: the invoice once, its lines one per
  // project and one for overhead. The dinars and euros of the lines are
  // derived from the invoice's own book figures, the last line taking the
  // rounding, so they sum to it in every column.
  const lines = splitLinesFor(invoice)
  if (lines.length > 0) {
    const saved = await saveSplits(client, 'invoice', data.id, {
      amount: invoice.amount,
      currency: context.currency,
      exchange_rate: booked.exchange_rate,
      eur_rate: booked.eur_rate,
      amount_rsd: booked.amount_rsd,
      amount_eur: booked.amount_eur,
    }, lines)
    if (!saved.ok) {
      throw new PostStepFailure(`the project split of ${labelFor(invoice)}`,
        `${saved.message} The invoice ${data.id} is written and booked to overhead.`)
    }
  }
  return data.id
}

function labelFor(invoice: PlannedInvoice): string {
  return {
    net: 'the net salary invoices',
    third_party: 'the forwarded-deduction invoices',
    other_income: 'the other-income invoices',
    obligation_parent: 'the tax and contributions invoice',
    obligation_child: 'the per-employee tax rows',
  }[invoice.kind]
}

/**
 * Invoices from this posting that a bank payment has been matched to.
 *
 * THE FIRST LINK IN THE CHAIN. Deleting an invoice that a payment is
 * allocated to takes the allocation with it, and the payment is left sitting
 * in the ledger against nothing — reconciled yesterday, unexplained today, and
 * nobody looking at the bank statement would know why. Those have to be
 * detached by hand first, which is a decision about real money and not
 * something an undo button should make.
 */
export async function linkedInvoices(
  client: any, invoiceIds: string[],
): Promise<{ invoiceId: string; transactionId: string; amount: number }[]> {
  if (!invoiceIds || invoiceIds.length === 0) return []
  const { data, error } = await client
    .from('invoice_transaction_links')
    .select('invoice_id, transaction_id, allocated_amount')
    .in('invoice_id', invoiceIds)
  if (error) {
    throw new Error(`Whether these invoices are matched to any payment could not be `
      + `checked (${error.message}). Nothing was deleted: removing an invoice that a `
      + 'payment is allocated to would leave that payment against nothing.')
  }
  return (data || []).map((l: any) => ({
    invoiceId: l.invoice_id,
    transactionId: l.transaction_id,
    amount: Number(l.allocated_amount || 0),
  }))
}

export function stillLinkedMessage(n: number): string {
  return `${n} of these invoices ${n === 1 ? 'is' : 'are'} matched to a bank payment. `
    + 'Nothing was deleted. Removing them would take the allocation with them and leave '
    + `${n === 1 ? 'that payment' : 'those payments'} sitting in the ledger against `
    + 'nothing — reconciled yesterday and unexplained today. Detach them on the '
    + 'transaction first; that is a decision about real money and not one an undo '
    + 'button should make.'
}

/**
 * Undo a posting.
 *
 * FOUR STEPS AND THE ORDER IS THE POINT.
 *
 *   1. Refuse while any invoice is matched to a payment. See above.
 *   2. Remove the invoices, then the transactions.
 *   3. Remove the posting row — LAST, so a failure partway leaves the month
 *      still claimed rather than freed with its entries in place, which would
 *      let a second posting land on top of the first.
 *   4. Put the run back to draft, so it can be recalculated.
 *
 * Step four is the only one that may be skipped without harm: a run left
 * posted with no entries behind it refuses to recalculate, which is annoying
 * and recoverable. Every other order loses something.
 */
export async function undoPosting(
  client: any,
  posting: {
    id: string
    run_id?: string | null
    created_invoice_ids: string[]
    created_transaction_ids: string[]
  },
): Promise<void> {
  const linked = await linkedInvoices(client, posting.created_invoice_ids || [])
  if (linked.length > 0) {
    throw new Error(stillLinkedMessage(new Set(linked.map(l => l.invoiceId)).size))
  }

  if (posting.created_invoice_ids?.length) {
    // The project split lines first. They hang off the invoice by id and
    // nothing removes them with it, so left behind they would be orphans.
    const { error: splitErr } = await client.from('pl_splits')
      .delete().eq('source', 'invoice').in('source_id', posting.created_invoice_ids).select('id')
    if (splitErr) {
      throw new Error(`The project split of these invoices could not be removed `
        + `(${splitErr.message}). Nothing else was deleted and the month is still posted.`)
    }
    const { error } = await client.from('invoices')
      .delete().in('id', posting.created_invoice_ids).select('id')
    if (error) {
      throw new Error(`The invoices could not be removed (${error.message}). `
        + 'The month is still marked as posted, which is deliberate — freeing it now '
        + 'would let a second payroll land on top of the first.')
    }
  }
  if (posting.created_transaction_ids?.length) {
    const { error } = await client.from('transactions')
      .delete().in('id', posting.created_transaction_ids).select('id')
    if (error) {
      throw new Error(`The invoices were removed but the retained-deduction entries `
        + `were not (${error.message}). The month is still marked as posted.`)
    }
  }
  const { error } = await client.from('payroll_postings')
    .delete().eq('id', posting.id).select('id')
  if (error) {
    throw new Error(`Everything was removed, but the month is still marked as posted `
      + `(${error.message}). It will refuse a new posting until that row is gone.`)
  }

  if (posting.run_id) {
    const { error: thawErr } = await client
      .from('payroll_runs')
      .update({ status: 'draft', posted_at: null, updated_at: new Date().toISOString() })
      .eq('id', posting.run_id)
      .select('id')
    if (thawErr) {
      throw new Error(`The entries were removed, but the calculated run is still locked `
        + `(${thawErr.message}). It will refuse to recalculate until it is set back to `
        + 'draft — nothing is lost, but the month cannot be changed yet.')
    }
  }
}

export async function fetchPostings(client: any, companyId: string, month: string): Promise<any[]> {
  const { data, error } = await client
    .from('payroll_postings')
    .select('*')
    .eq('company_id', companyId)
    .eq('period_month', firstOfMonth(month))
  if (error) throw new Error(`The postings for this month could not be read: ${error.message}`)
  return data || []
}

/** Postgres 23505, however this client happens to surface it. */
function isUniqueViolation(error: any): boolean {
  return error?.code === '23505'
    || /duplicate key|unique constraint/i.test(error?.message || '')
}

