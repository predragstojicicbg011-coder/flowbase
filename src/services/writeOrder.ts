// ─── The order destructive writes have to happen in ─────────────────────────
//
// Two paths in this app used to throw away what the user had before they had
// established they were allowed to replace it. Both were a sequence of writes
// against several tables, and in both the sequence was back to front.
//
//   Transactions.deleteTransaction
//     unlinked the credit instalments, deleted the invoice allocations, and
//     only then soft-deleted the transaction — which is the only one of the
//     three the period-lock trigger can refuse, and the only one whose error
//     was read. In a closed month the first two had already happened, the
//     third was rejected, the function returned, and the owner was told
//     "Period 2026-01 je zakljucan" about an operation that had in fact
//     destroyed a credit schedule and an invoice allocation on its way to
//     failing.
//
//   InvoiceDialog.handlePost
//     deleted every link on the invoice and then inserted the replacement.
//     Neither call was checked. A rejected insert left the invoice with no
//     allocation at all and the dialog showing "Invoice updated!".
//
// The rule both now follow: NOTHING IS REMOVED UNTIL THE THING THAT REPLACES
// IT — or the permission to remove it — IS IN HAND. A failure may leave the
// user with more than they asked for. It may never leave them with less.
//
// For the delete that means the guarded write goes first: the soft delete is
// what the trigger refuses, so it is what we attempt before touching a link.
// For the reallocation it means there is no destructive order at all —
// upsert the link that should exist, then delete the ones it supersedes.
//
// The decisions live here as plain functions so they can be tested without a
// database, and the two executors below carry them out against whatever
// client they are handed, so the page and the dialog stay thin and the write
// order itself is what the tests assert on.

// ── The client, only as much of it as these two paths use ──────────────────

export interface WriteError {
  message: string
  code?: string | null
}

export interface WriteResult {
  data?: any
  error?: WriteError | null
}

export interface SupabaseLike {
  rpc(fn: string, args: Record<string, unknown>): PromiseLike<WriteResult>
  from(table: string): any
}

/**
 * Whether this error means the database simply does not have the function.
 *
 * PostgREST answers an unknown RPC with `PGRST202`; Postgres itself, if the
 * call reaches it with the wrong signature, with `42883`. Either way the
 * database has not had the migration applied yet, and the caller should fall
 * back rather than report a fault to the owner. Any OTHER error is a real
 * refusal and must be surfaced as one.
 */
export function isMissingFunction(error: WriteError | null | undefined): boolean {
  if (!error) return false
  const code = error.code || ''
  if (code === 'PGRST202' || code === '42883') return true
  const m = (error.message || '').toLowerCase()
  return m.includes('could not find the function')
    || m.includes('does not exist')
    || m.includes('schema cache')
}

// ── Deleting a transaction ─────────────────────────────────────────────────

/** The three tables a transaction delete touches, in the order it touches them. */
export type DeleteStep = 'transaction' | 'invoiceLinks' | 'installments'

/**
 * The order. The soft delete first, because it is the only one of the three
 * the period-lock trigger inspects, and therefore the only one that can turn
 * the whole operation into a refusal. Everything that destroys a reference
 * happens after the refusal could no longer come.
 */
export const DELETE_STEP_ORDER: readonly DeleteStep[] = ['transaction', 'invoiceLinks', 'installments']

export interface ClosedPeriodRow {
  company_id: string
  /** The first day of the closed month, `YYYY-MM-DD`. */
  period: string
}

export interface DeleteContext {
  transactionId: string
  /** The transaction's company, as read back from the row. */
  companyId?: string | null
  /** The transaction's date, `YYYY-MM-DD`, as read back from the row. */
  transactionDate?: string | null
  /** `feature_flags.period_lock`. Undefined when the flag could not be read. */
  periodLockEnabled?: boolean
  /** Whatever `closed_periods` returned for this company. */
  closedPeriods?: ClosedPeriodRow[]
}

export type DeletePlan =
  | { kind: 'refuse'; reason: string }
  | { kind: 'proceed'; steps: readonly DeleteStep[] }

const month = (d: string): string => String(d).slice(0, 7)

/**
 * Whether this transaction may be deleted, and in what order the writes go.
 *
 * The lock check is a courtesy, not the enforcement — the trigger is the
 * enforcement, and it runs whatever this says. What the check buys is the
 * common case answered before any write at all, which matters most on the
 * path that cannot be atomic. When the flag could not be read, or the row
 * carries no company or date, the plan proceeds and lets the database decide;
 * the order is what makes that safe.
 */
export function planDelete(ctx: DeleteContext): DeletePlan {
  const locked = ctx.periodLockEnabled !== false
    && !!ctx.companyId
    && !!ctx.transactionDate
    && (ctx.closedPeriods || []).some(
      cp => cp.company_id === ctx.companyId && month(cp.period) === month(ctx.transactionDate as string),
    )

  if (locked) {
    return {
      kind: 'refuse',
      reason: `Period ${month(ctx.transactionDate as string)} je zaključan za ovu firmu — ništa nije obrisano. `
        + 'Transakcija, njena raspodela na fakture i rate kredita su ostali kakvi su bili. '
        + 'Otključajte period u Podešavanjima i pokušajte ponovo.',
    }
  }

  return { kind: 'proceed', steps: DELETE_STEP_ORDER }
}

/**
 * What to put in front of the owner when one of the three steps fails.
 *
 * The point of each sentence is the same: say what survived. A refusal on the
 * first step has cost nothing and must say so, or the owner goes looking for
 * damage that is not there. A failure on a later step HAS left something
 * dangling, and must name it, or the owner never goes looking for damage that
 * is.
 */
export function reportStepFailure(step: DeleteStep, message: string): string {
  switch (step) {
    case 'transaction':
      return `Transakcija nije obrisana (${message}). `
        + 'Raspodela na fakture i rate kredita su netaknuti — ništa nije izgubljeno.'
    case 'invoiceLinks':
      return 'Transakcija je obrisana, ali njena raspodela na fakture nije mogla da se ukloni '
        + `(${message}). Te fakture je i dalje računaju kao plaćanje, pa će im status `
        + 'biti previsok dok se raspodela ručno ne ukloni. Ništa drugo nije menjano — '
        + 'rate kredita nisu dirane.'
    case 'installments':
      return 'Transakcija je obrisana i raspodela na fakture uklonjena, ali rate kredita '
        + `koje je zatvorila nisu mogle ponovo da se otvore (${message}). I dalje upućuju na obrisanu `
        + 'transakciju i vode se kao plaćene. Ponovo ih otvorite u Kreditima.'
  }
}

export interface DeleteOutcome {
  ok: boolean
  /** What to show the owner. Empty on success. */
  message: string
  /** The steps that actually completed. */
  done: DeleteStep[]
  /** True when all three writes went through the database in one transaction. */
  atomic: boolean
  invoiceLinksRemoved: number
  installmentsUnlinked: number
}

const nothingDone = (message: string): DeleteOutcome => ({
  ok: false, message, done: [], atomic: false, invoiceLinksRemoved: 0, installmentsUnlinked: 0,
})

/**
 * Delete a transaction and everything that references it.
 *
 * The first choice is `delete_transaction_cascade`, which does all three
 * writes inside one database transaction, so the period-lock rejection rolls
 * the instalments and the links back with the soft delete. See migration
 * 20260920090000_delete_transaction_atomically.sql.
 *
 * If that function is not in this database yet — the SQL in this repo is
 * applied by hand, and the front end ships to Vercel the moment `main` moves,
 * so the two are not simultaneous — the fallback does the same three writes
 * from here, in the same order, checking every one. It is not atomic, but it
 * never removes a reference before the delete it belongs to has been accepted.
 */
export async function deleteTransactionSafely(
  client: SupabaseLike,
  opts: { transactionId: string; deletedBy?: string | null },
): Promise<DeleteOutcome> {
  const { data, error } = await client.rpc('delete_transaction_cascade', {
    p_transaction_id: opts.transactionId,
    p_deleted_by: opts.deletedBy ?? null,
  })

  if (!error) {
    return {
      ok: true,
      message: '',
      done: [...DELETE_STEP_ORDER],
      atomic: true,
      invoiceLinksRemoved: Number(data?.invoice_links_removed) || 0,
      installmentsUnlinked: Number(data?.installments_unlinked) || 0,
    }
  }

  // A real refusal — a closed period, RLS, a row that is not there. Nothing
  // ran: that is what putting it in one transaction bought.
  if (!isMissingFunction(error)) {
    return nothingDone(reportStepFailure('transaction', error.message))
  }

  return deleteTransactionInSteps(client, opts)
}

/**
 * The same delete without the RPC, for a database the migration has not
 * reached.
 *
 * The soft delete goes first. Only once the database has accepted it — which
 * is where a closed month, and only a closed month, stops us — do the links
 * and the instalments go.
 */
export async function deleteTransactionInSteps(
  client: SupabaseLike,
  opts: { transactionId: string; deletedBy?: string | null },
): Promise<DeleteOutcome> {
  const id = opts.transactionId

  const read = async () => client.from('transactions')
    .select('id, company_id, transaction_date').eq('id', id).maybeSingle()

  const { data: row, error: readErr } = await read()
  if (readErr) return nothingDone(reportStepFailure('transaction', readErr.message))
  if (!row) {
    return nothingDone(reportStepFailure(
      'transaction',
      `transakcija ${id} nije vidljiva — možda je već obrisana`,
    ))
  }

  // The courtesy check. Cheap, and it turns the overwhelmingly likely failure
  // into a refusal that has provably written nothing at all.
  let periodLockEnabled: boolean | undefined
  let closedPeriods: ClosedPeriodRow[] = []
  try {
    const { data: flag } = await client.from('feature_flags')
      .select('enabled').eq('name', 'period_lock').maybeSingle()
    periodLockEnabled = flag?.enabled !== false
    if (periodLockEnabled && row.company_id) {
      const { data: closed } = await client.from('closed_periods')
        .select('company_id, period').eq('company_id', row.company_id)
      closedPeriods = closed || []
    }
  } catch {
    // If the pre-check cannot run the trigger still holds, and the order below
    // still means a rejection costs nothing.
  }

  const plan = planDelete({
    transactionId: id,
    companyId: row.company_id,
    transactionDate: row.transaction_date,
    periodLockEnabled,
    closedPeriods,
  })
  if (plan.kind === 'refuse') return nothingDone(plan.reason)

  const done: DeleteStep[] = []

  // ── 1. The soft delete ───────────────────────────────────────────────────
  //
  // No `.select('id')` here, unlike every other update-by-id in this codebase.
  // The restrictive policy `transactions_hide_deleted` (migration
  // 20260826120000) hides rows with a `deleted_at`, so asking PostgREST to
  // return the representation of a row we have just soft-deleted returns an
  // empty list on SUCCESS as readily as on a zero-row miss — the pattern would
  // invert into a false alarm. A soft delete is confirmed the other way round:
  // the row must have BECOME invisible.
  const { error: delErr } = await client.from('transactions')
    .update({ deleted_at: new Date().toISOString(), deleted_by: opts.deletedBy ?? null })
    .eq('id', id)
  if (delErr) return nothingDone(reportStepFailure('transaction', delErr.message))

  const { data: stillThere, error: confirmErr } = await read()
  if (!confirmErr && stillThere) {
    return nothingDone(reportStepFailure(
      'transaction',
      `izmena je prijavila uspeh, ali transakcija ${id} i dalje postoji — ništa nije obrisano`,
    ))
  }
  done.push('transaction')

  // ── 2. The invoice allocations ───────────────────────────────────────────
  const { error: linkErr } = await client.from('invoice_transaction_links')
    .delete().eq('transaction_id', id)
  if (linkErr) {
    return { ...nothingDone(reportStepFailure('invoiceLinks', linkErr.message)), done }
  }
  done.push('invoiceLinks')

  // ── 3. The credit instalments ────────────────────────────────────────────
  const { error: instErr } = await client.from('credit_installments')
    .update({
      transaction_id: null,
      paid_amount: 0,
      status: 'outstanding',
      paid_date: null,
      updated_at: new Date().toISOString(),
    })
    .eq('transaction_id', id)
  if (instErr) {
    return { ...nothingDone(reportStepFailure('installments', instErr.message)), done }
  }
  done.push('installments')

  return { ok: true, message: '', done, atomic: false, invoiceLinksRemoved: 0, installmentsUnlinked: 0 }
}

// ── Reallocating an invoice's link ─────────────────────────────────────────

/** The two writes a link reallocation is, in the order that cannot lose one. */
export type LinkStep = 'insertReplacement' | 'removeSuperseded'

export const LINK_STEP_ORDER: readonly LinkStep[] = ['insertReplacement', 'removeSuperseded']

/**
 * What to tell the owner when a link reallocation does not finish.
 *
 * Note which way round the damage runs now. A failed insert has removed
 * nothing, so the invoice keeps the allocation it had. A failed cleanup
 * leaves an EXTRA allocation, which overstates how paid the invoice is — a
 * wrong number the owner can see and correct, rather than a missing one they
 * cannot.
 */
export function reportLinkFailure(step: LinkStep, message: string): string {
  switch (step) {
    case 'insertReplacement':
      return `Faktura nije mogla da se poveže sa tom transakcijom (${message}). `
        + 'Ništa nije uklonjeno — raspodela ove fakture je ista kao pre.'
    case 'removeSuperseded':
      return `Faktura je povezana sa tom transakcijom, ali raspodela koju zamenjuje nije mogla da se ukloni (${message}). `
        + 'Faktura sada računa obe, pa će izgledati više plaćena nego što jeste dok se stara veza ne ukloni.'
  }
}

export interface LinkOutcome {
  ok: boolean
  message: string
  done: LinkStep[]
}

/**
 * Point an invoice at exactly one transaction, without a moment in which it
 * points at none.
 *
 * `upsert` rather than `insert` because the link being written is usually the
 * one already there; `(invoice_id, transaction_id)` is the same unique key
 * TransactionDialog and ReconcilePanel upsert against. The delete that follows
 * is narrowed by `neq` to the links this one supersedes, so re-saving an
 * unchanged invoice is a no-op rather than a delete and a re-insert.
 */
export async function reallocateInvoiceLink(
  client: SupabaseLike,
  link: {
    invoiceId: string
    transactionId: string
    allocatedAmount: number
    allocatedAmountRsd: number
    allocatedAmountEur: number
    note?: string | null
  },
): Promise<LinkOutcome> {
  const { error: upErr } = await client.from('invoice_transaction_links').upsert({
    invoice_id: link.invoiceId,
    transaction_id: link.transactionId,
    allocated_amount: link.allocatedAmount,
    allocated_amount_rsd: link.allocatedAmountRsd,
    allocated_amount_eur: link.allocatedAmountEur,
    note: link.note ?? null,
  }, { onConflict: 'invoice_id,transaction_id' })
  if (upErr) return { ok: false, message: reportLinkFailure('insertReplacement', upErr.message), done: [] }

  const { error: delErr } = await client.from('invoice_transaction_links')
    .delete().eq('invoice_id', link.invoiceId).neq('transaction_id', link.transactionId)
  if (delErr) {
    return { ok: false, message: reportLinkFailure('removeSuperseded', delErr.message), done: ['insertReplacement'] }
  }

  return { ok: true, message: '', done: [...LINK_STEP_ORDER] }
}

// ─── A post that writes several tables in sequence ──────────────────────────
//
// The payroll dialogs, the invoice dialog and the reconcile panel each write
// four or five tables from one submit. None of them read a single `error`, so
// a closed period or an RLS refusal partway through left the earlier writes
// standing and still showed the success screen.
//
// Checking the error is only half of it. A bare "save failed" after three
// tables have been written is its own kind of lie: the owner is told to try
// again, does, and doubles what already landed. So a failure has to name what
// survived it.

/** A write that already succeeded before the failure. */
export interface CompletedWrite {
  /** What it was, in the owner's words — 'the payroll record', 'net salary invoices'. */
  label: string
  /** How many rows, when there was more than one. */
  count?: number
}

function phrase(w: CompletedWrite): string {
  return w.count === undefined ? w.label : `${w.count} ${w.label}`
}

/**
 * What to put in front of the owner when a multi-table post fails partway.
 *
 * Nothing written yet is the good case and has to say so plainly, or the owner
 * goes hunting for damage that is not there. Anything already written has to be
 * listed, or the owner retries on top of it.
 */
export function reportPostFailure(
  what: string,
  failedAt: string,
  message: string,
  completed: CompletedWrite[],
): string {
  const head = `Nije proknjiženo: ${what}. Upis nije uspeo — ${failedAt} (${message}).`
  if (completed.length === 0) {
    return `${head} Ništa nije upisano — možete bezbedno pokušati ponovo.`
  }
  const landed = completed.map(phrase).join(', ')
  return `${head} Već upisano: ${landed}. Uklonite to pre ponovnog pokušaja, `
    + 'inače će knjiženje biti duplirano.'
}

/**
 * Thrown by a multi-table post when one of its writes is refused.
 *
 * It carries the step so the catch can name it without the throw site having
 * to know what else had already landed — the running list of completed writes
 * lives at the top of the post, where it can be kept honest.
 */
export class PostFailure extends Error {
  constructor(public readonly step: string, message: string) {
    super(message)
    this.name = 'PostFailure'
  }
}

// ─── Soft delete has to go through the database ─────────────────────────────
//
// `update ... set deleted_at = now()` from the client is refused. The
// restrictive `*_hide_deleted` policies from 20260826120000 are `for select`,
// and Postgres applies select policies to the NEW row of an update — so the
// one write they exist to support is the one they forbid:
//
//   new row violates row-level security policy "transactions_hide_deleted"
//
// 20260921090000 adds `soft_delete_row`, a `security definer` function that
// re-imposes the role and company checks by hand and does the update with no
// RETURNING. Every soft delete in the app goes through it.

export type SoftDeletable = 'transactions' | 'invoices' | 'passthrough'

export interface SoftDeleteResult {
  ok: boolean
  /** Empty when it worked. */
  message: string
}

export async function softDeleteRow(
  client: SupabaseLike,
  table: SoftDeletable,
  id: string,
  deletedBy?: string | null,
): Promise<SoftDeleteResult> {
  const { data, error } = await client.rpc('soft_delete_row', {
    p_table: table, p_id: id, p_deleted_by: deletedBy ?? null,
  })
  if (error) return { ok: false, message: error.message }
  // The function returns false when the row was already gone. Saying so beats
  // reporting a delete that deleted nothing.
  if (data === false) return { ok: false, message: 'Taj zapis je već obrisan.' }
  return { ok: true, message: '' }
}

/**
 * Run one write and say plainly whether it landed.
 *
 * For the pages that mutate a lookup table and then refetch it. A failure
 * there is not invisible — the list simply does not change — but it is
 * unexplained, and "nothing happened" is a poor way to learn that a period is
 * closed or that your role does not allow it.
 *
 * `label` is what the user was trying to do, in their words, because the
 * PostgREST message alone rarely says.
 */
export async function runWrite(
  label: string,
  q: PromiseLike<{ error: WriteError | null }>,
): Promise<{ ok: boolean; message: string }> {
  const { error } = await q
  if (error) return { ok: false, message: `${label} nije uspelo: ${error.message}` }
  return { ok: true, message: '' }
}
