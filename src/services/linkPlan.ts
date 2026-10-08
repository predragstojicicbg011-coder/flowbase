// ─── linkPlan ───────────────────────────────────────────────────────────────
//
// What changes when the invoices a payment closes are edited.
//
// The transaction dialog could add invoices to a payment and never showed the
// ones it already closed, so there was nothing to take away. Now that both are
// possible, saving is no longer "write what is on screen": a link that was
// there and is not any more has to be deleted, and — the part that is easy to
// forget — the invoice it pointed at has to be told.
//
// That is the whole reason this is a function rather than a loop at the call
// site. Writing the new links is obvious and the dialog already did it. The
// invoice that just lost its payment goes back to unpaid, and nothing on
// screen mentions it at the moment of saving, so it is exactly the write that
// gets left out. `toRefresh` carries both sides so the caller cannot.

import { countOf, plural } from '../utils/plural'

export interface Allocation {
  invoiceId: string
  /**
   * What this payment puts against that invoice.
   *
   * IN WHATEVER UNIT THE CALLER SETTLES IN, and nothing here converts it or
   * compares it with anything else — only whether it is more than nothing
   * decides anything. The dialog settles in the currency of the bill, and a
   * field whose name says one currency while it carries another is the exact
   * shape of every unit fault this chain has had.
   */
  allocated: number
}

export interface LinkPlan {
  /** Invoice ids whose link to this payment must be deleted. */
  toRemove: string[]
  /** Links to write. An upsert covers both a new one and a changed amount. */
  toWrite: Allocation[]
  /**
   * Every invoice whose status has to be recomputed — the ones losing the
   * payment as well as the ones gaining it.
   */
  toRefresh: string[]
}

/**
 * The difference between the links a payment had and the ones it should have.
 *
 * An allocation of nothing is a removal, not a link recording zero. Leaving
 * one behind would put a row in the table that claims a payment settles an
 * invoice by no amount, which is not a thing that happened; the invoice reads
 * as unpaid either way, so the row would be clutter that outlives the edit.
 *
 * Duplicates in `after` keep their first occurrence. A picker should not
 * produce them, and if one does the alternative is writing the same link twice
 * and letting the second silently win.
 */
export function planLinkChanges(before: string[], after: Allocation[]): LinkPlan {
  const seen = new Set<string>()
  const toWrite: Allocation[] = []
  for (const a of after) {
    if (!a.invoiceId || seen.has(a.invoiceId)) continue
    seen.add(a.invoiceId)
    if (!(a.allocated > 0)) continue
    toWrite.push({ invoiceId: a.invoiceId, allocated: a.allocated })
  }

  const keeping = new Set(toWrite.map(a => a.invoiceId))
  const beforeUnique: string[] = []
  const wasThere = new Set<string>()
  for (const id of before) {
    if (!id || wasThere.has(id)) continue
    wasThere.add(id)
    beforeUnique.push(id)
  }

  const toRemove = beforeUnique.filter(id => !keeping.has(id))

  // The ones that were there first, so a reader of the list sees what was
  // affected before what was added.
  const toRefresh = [...beforeUnique]
  for (const a of toWrite) if (!wasThere.has(a.invoiceId)) toRefresh.push(a.invoiceId)

  return { toRemove, toWrite, toRefresh }
}

/** Nothing to do at all — the caller can skip every write. */
export function isNoChange(plan: LinkPlan, before: string[]): boolean {
  if (plan.toRemove.length > 0) return false
  if (plan.toWrite.length !== before.length) return false
  const had = new Set(before)
  return plan.toWrite.every(a => had.has(a.invoiceId))
}

/**
 * What to tell the user once it is done.
 *
 * Counts, not names: a payment can touch a dozen invoices and the dialog is
 * closing. The point is that something was detached at all, because that is
 * the half of the edit with no representation on screen afterwards.
 */
export function describeChanges(plan: LinkPlan): string {
  const parts: string[] = []
  if (plan.toWrite.length > 0) {
    const n = plan.toWrite.length
    parts.push(`${plural(n, 'Zatvorena', 'Zatvorene', 'Zatvoreno')} ${countOf(n, 'faktura', 'fakture', 'faktura')}`)
  }
  if (plan.toRemove.length > 0) {
    parts.push(`${countOf(plan.toRemove.length, 'vraćena', 'vraćene', 'vraćeno')} u neplaćene`)
  }
  return parts.length > 0 ? parts.join(', ') + '.' : 'Nijedna faktura nije povezana sa ovim plaćanjem.'
}
