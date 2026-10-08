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
import { postingTag } from './partnerMatch'
import { countOf } from '../../utils/plural'

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
    super(`Upis nije uspeo (${step}): ${reason}`)
    this.name = 'PostStepFailure'
  }
}

export function alreadyPostedMessage(month: string, runLabel: string): string {
  return `Obračun „${runLabel}“ za ${month} je već proknjižen. Ništa nije upisano. `
    + 'Dvaput proknjižene zarade su drugi kompletan skup faktura koji se ni sa čim ne '
    + 'uparuje i koji se kasnije ručno razdvaja iz izvoda. Ako je postojeće knjiženje '
    + 'pogrešno, prvo ga poništite.'
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
    throw new PostStepFailure('zapis o knjiženju', claimErr.message)
  }
  const postingId = posting?.id
  if (!postingId) throw new PostStepFailure('zapis o knjiženju', 'nije vraćen ID')

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
    if (error) throw new PostStepFailure('stavke zadržanih obustava', error.message)
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
      'zapis o upisanim stavkama',
      `${linkErr.message}. Sve je ispravno proknjiženo, ali ovo knjiženje ne može da se `
      + 'poništi sa ove strane — stavke bi morale da se uklone ručno.')
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
        'zaključavanje obračuna',
        `${freezeErr?.message ?? 'nijedan obračun nije pronađen'}. Sve je ispravno `
        + 'proknjiženo, ali je obračun i dalje nacrt, pa bi ponovni obračun mogao da se '
        + 'razlikuje od upravo upisanih stavki. Proknjižite ponovo ili obrišite ovo '
        + 'knjiženje i počnite iz početka.')
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
    note: `${invoice.note} ${postingTag(postingId)}`,
  }).select('id').single()

  if (error) throw new PostStepFailure(labelFor(invoice), error.message)
  if (!data?.id) throw new PostStepFailure(labelFor(invoice), 'nije vraćen ID')

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
      throw new PostStepFailure(`podela po projektima: ${labelFor(invoice)}`,
        `${saved.message} Faktura ${data.id} je upisana i proknjižena na opšte troškove.`)
    }
  }
  return data.id
}

function labelFor(invoice: PlannedInvoice): string {
  return {
    net: 'fakture za neto zarade',
    third_party: 'fakture za prosleđene obustave',
    other_income: 'fakture za ostala primanja',
    obligation_parent: 'faktura za porez i doprinose',
    obligation_child: 'stavke poreza po zaposlenom',
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
    throw new Error(`Nije moguće proveriti da li su ove fakture uparene sa plaćanjem `
      + `(${error.message}). Ništa nije obrisano: brisanje uparene fakture ostavilo bi `
      + 'plaćanje bez pokrića. Pokušajte ponovo.')
  }
  return (data || []).map((l: any) => ({
    invoiceId: l.invoice_id,
    transactionId: l.transaction_id,
    amount: Number(l.allocated_amount || 0),
  }))
}

export function stillLinkedMessage(n: number): string {
  return `${countOf(n, 'faktura je uparena', 'fakture su uparene', 'faktura je upareno')} `
    + 'sa plaćanjem iz izvoda. Ništa nije obrisano. Brisanje bi uklonilo i uparivanje, '
    + 'pa bi plaćanje ostalo u knjizi bez pokrića. Prvo raskinite uparivanje na '
    + 'transakciji, pa ponovo poništite knjiženje.'
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
      throw new Error(`Podela ovih faktura po projektima nije obrisana `
        + `(${splitErr.message}). Ništa drugo nije obrisano i mesec je i dalje proknjižen.`)
    }
    const { error } = await client.from('invoices')
      .delete().in('id', posting.created_invoice_ids).select('id')
    if (error) {
      throw new Error(`Fakture nisu obrisane (${error.message}). `
        + 'Mesec je namerno i dalje označen kao proknjižen, da se preko njega ne bi '
        + 'proknjižio drugi obračun. Pokušajte ponovo.')
    }
  }
  if (posting.created_transaction_ids?.length) {
    const { error } = await client.from('transactions')
      .delete().in('id', posting.created_transaction_ids).select('id')
    if (error) {
      throw new Error(`Fakture su obrisane, ali stavke zadržanih obustava nisu `
        + `(${error.message}). Mesec je i dalje označen kao proknjižen.`)
    }
  }
  const { error } = await client.from('payroll_postings')
    .delete().eq('id', posting.id).select('id')
  if (error) {
    throw new Error(`Sve je obrisano, ali je mesec i dalje označen kao proknjižen `
      + `(${error.message}). Novo knjiženje neće biti moguće dok se taj zapis ne ukloni.`)
  }

  if (posting.run_id) {
    const { error: thawErr } = await client
      .from('payroll_runs')
      .update({ status: 'draft', posted_at: null, updated_at: new Date().toISOString() })
      .eq('id', posting.run_id)
      .select('id')
    if (thawErr) {
      throw new Error(`Stavke su obrisane, ali je obračun i dalje zaključan `
        + `(${thawErr.message}). Ponovni obračun neće biti moguć dok se ne vrati u `
        + 'nacrt — ništa nije izgubljeno, ali mesec još ne može da se menja.')
    }
  }
}

export async function fetchPostings(client: any, companyId: string, month: string): Promise<any[]> {
  const { data, error } = await client
    .from('payroll_postings')
    .select('*')
    .eq('company_id', companyId)
    .eq('period_month', firstOfMonth(month))
  if (error) throw new Error(`Knjiženja za ovaj mesec nisu učitana: ${error.message}`)
  return data || []
}

/** Postgres 23505, however this client happens to surface it. */
function isUniqueViolation(error: any): boolean {
  return error?.code === '23505'
    || /duplicate key|unique constraint/i.test(error?.message || '')
}

