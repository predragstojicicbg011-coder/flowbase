// ─── invoiceClaims ──────────────────────────────────────────────────────────
//
// What the rows of one unposted batch have already spoken for.
//
// A bulk import or a bank statement is resolved row by row, but nothing is
// written until the whole thing is posted. Until then every row is offered the
// same list of open invoices, so the same invoice can be ticked on three rows
// while two other invoices are never ticked at all. Nothing says so. At post
// time the allocator walks the rows in order, gives the first row as much of
// the invoice as it can cover, and hands the later rows an invoice with
// nothing left — which is exactly the state Predrag kept finding afterwards.
//
// So this is the allocator's arithmetic, run early. It answers one question —
// how much of each invoice is still free, given what the *other* rows have
// already claimed — and the picker uses the answer to stop offering what it is
// not going to deliver.
//
// It is deliberately the same rule the poster uses: a row pays its invoices in
// the order they were ticked, each takes what it can up to its own remainder,
// and a row never allocates more than its own amount. Any other rule here
// would produce a picker that disagrees with the posting it is predicting.
//
// **The caller picks the unit, and must keep it consistent for a given
// invoice.** Bulk Import works in the book currency (RSD), because
// `remaining_rsd` is what its picker shows and what its running totals add
// up. The bank statement dialog works in the invoice's own currency, because
// that is the amount a row actually types. Nothing here converts anything —
// quietly meaning one currency while being handed another is how a figure
// once came out wrong by a factor of a hundred, and it is not going to start
// here.
//
// `EPSILON` is the slack that keeps a rounding remainder from reading as an
// open invoice: one para (0.01), the floor `v_invoice_status` applies when it
// decides an invoice is settled, so the picker and the database agree about
// what is still open.

import { fmtRSD } from '../utils/formatters'

/** Under this much left, an invoice is closed. The poster uses the same cut. */
export const EPSILON = 0.01

export interface ClaimRow {
  /** Whatever identifies the row in its dialog. Opaque here. */
  id: string
  /** The payment this row represents, in the caller's unit. Never negative. */
  amount: number
  /** The invoices it will pay, in the order they were ticked. */
  invoiceIds: string[]
}

export interface OpenInvoice {
  id: string
  /** What the database says is still owed, before this batch. */
  remaining: number
}

export interface Claim {
  /** How much of this invoice is spoken for by the rows considered. */
  claimed: number
  /** The rows that claimed it, in the order they did. */
  rowIds: string[]
}

/**
 * How much each row allocates to each invoice, by the poster's own rule.
 *
 * Rows are walked in the order given — which is the order they are posted —
 * and each one spends its amount across its ticked invoices until either the
 * money or the invoices run out. An invoice already emptied by an earlier row
 * absorbs nothing, which is the whole point: the second row to tick it gets
 * what is actually left, not a second full copy.
 */
export function claimsFor(rows: ClaimRow[], invoices: OpenInvoice[]): Map<string, Claim> {
  const free = new Map(invoices.map(i => [i.id, Math.max(0, i.remaining)]))
  const claims = new Map<string, Claim>()

  for (const row of rows) {
    let budget = Math.max(0, row.amount)
    for (const invoiceId of row.invoiceIds) {
      if (budget <= EPSILON) break
      // An id the open list does not know — a stale tick, an invoice closed by
      // someone else since the dialog opened — claims nothing rather than
      // throwing. The picker cannot show it either way.
      const left = free.get(invoiceId)
      if (left === undefined || left <= EPSILON) continue

      const take = Math.min(budget, left)
      free.set(invoiceId, left - take)
      budget -= take

      const existing = claims.get(invoiceId)
      if (existing) {
        existing.claimed += take
        existing.rowIds.push(row.id)
      } else {
        claims.set(invoiceId, { claimed: take, rowIds: [row.id] })
      }
    }
  }
  return claims
}

export interface FreeAmount {
  /** How much is still available to the row asking. */
  remaining: number
  /** True when there is nothing left for it to pay. */
  exhausted: boolean
  /** The other rows holding it, so the picker can say who. */
  claimedBy: string[]
}

/**
 * What is left of one invoice for one row, ignoring that row's own claim.
 *
 * Excluding the asking row is what makes the answer stable while the user
 * works: ticking an invoice must not immediately make it look unavailable to
 * the row that just ticked it, and unticking it must give the full amount
 * straight back.
 */
export function freeForRow(
  invoice: OpenInvoice,
  rows: ClaimRow[],
  rowId: string,
): FreeAmount {
  const others = rows.filter(r => r.id !== rowId)
  const claim = claimsFor(others, [invoice]).get(invoice.id)
  const claimed = claim?.claimed ?? 0
  const remaining = Math.max(0, Math.max(0, invoice.remaining) - claimed)
  return {
    remaining,
    exhausted: remaining <= EPSILON,
    claimedBy: claim?.rowIds ?? [],
  }
}

/**
 * Every invoice another row has fully spoken for.
 *
 * The picker disables exactly these. An invoice only *partly* claimed stays
 * pickable — two payments closing one invoice inside a single statement is
 * ordinary, and refusing it would be a worse bug than the one being fixed.
 */
export function exhaustedFor(
  invoices: OpenInvoice[],
  rows: ClaimRow[],
  rowId: string,
): Set<string> {
  const out = new Set<string>()
  for (const inv of invoices) {
    if (freeForRow(inv, rows, rowId).exhausted) out.add(inv.id)
  }
  return out
}

/**
 * The line the picker shows under an invoice another row has taken.
 *
 * `labelFor` turns a row id into something a person recognises — a line
 * number, a date, a partner — because a uuid would explain nothing.
 *
 * `format` renders the remainder in whatever unit the caller has been using,
 * for the same reason this module does no conversion of its own.
 */
export function claimNotice(
  free: FreeAmount,
  labelFor: (rowId: string) => string,
  format: (amount: number) => string = n => fmtRSD(n),
): string | null {
  if (free.claimedBy.length === 0) return null
  const who = free.claimedBy.map(labelFor).join(', ')
  return free.exhausted
    ? `Already fully covered by ${who} in this batch`
    : `${format(free.remaining)} left — the rest is claimed by ${who}`
}


/**
 * Whether the picker should leave an invoice out of its list entirely.
 *
 * Greying it was the first answer and it was not enough. Where this matters
 * most is a partner with six identical open bills against six identical
 * payments, and one greyed row among six identical ones is a distinction
 * nobody makes at a glance — which is how the same invoice gets closed twice
 * while another stays open, and the statement still reconciles to the penny.
 *
 * Two things keep it on screen regardless:
 *
 *   the row has already ticked it, because a picker that hides what it is
 *   showing as chosen is a picker nobody believes
 *
 *   the user asked to see them, because the claim on the other line may
 *   itself be the mistake being hunted
 */
export function isHiddenForRow(
  free: FreeAmount, isPicked: boolean, showTaken: boolean,
): boolean {
  return !showTaken && !isPicked && free.exhausted
}
