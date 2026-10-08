import { rowsFor, whySplitNotSavable, type SplitLine, type SplitParent } from './expenseSplit'

// ─── Writing a split, the same way from every dialog ────────────────────────
//
// Four dialogs book an expense and all four can now split one. The shape of
// the write is identical from each, so it is written once: otherwise the
// fourth copy ends up ordering the two statements differently and nobody
// notices until a split half exists.
//
// ── Why the old lines go first ──────────────────────────────────────────────
//
// The database refuses a split that does not add up to the payment, which is
// the point of it. That means the replacement cannot be inserted alongside
// what it replaces — the two sets together are twice the payment, and the
// check would refuse both.
//
// So the old lines are removed and the new ones written. Between the two
// calls the payment is an ordinary unsplit expense, which is a legitimate
// state rather than a broken one: if the insert then fails, the row is back
// to where it was before anybody split it, and the caller is told so in those
// words rather than left to discover a payment with half a split on it.
//
// PostgREST gives each call its own transaction, so the insert of several
// lines is one transaction and the deferred check sees the whole set at
// commit — which is exactly what it is deferred for.

export type SplitSource = 'transaction' | 'invoice'

export interface SaveSplitsResult {
  ok: boolean
  /** How many lines the payment now carries. Zero means it is not split. */
  lines: number
  message: string
}

/**
 * Replaces whatever split a payment has with the lines given.
 *
 * An empty list is how a split is undone, and it is not an error: somebody
 * deciding a payment is one expense after all is doing something ordinary.
 */
export async function saveSplits(
  client: any,
  source: SplitSource,
  sourceId: string,
  parent: SplitParent,
  lines: SplitLine[],
): Promise<SaveSplitsResult> {
  // Refuse here as well as in the form. The form is what a person sees, and
  // this is what a caller that forgot to look sees.
  const why = whySplitNotSavable(parent, lines)
  if (why) return { ok: false, lines: 0, message: why }

  const { error: delErr } = await client
    .from('pl_splits').delete()
    .eq('source', source).eq('source_id', sourceId)
  if (delErr) {
    return {
      ok: false,
      lines: 0,
      message: `The payment was saved, but its existing split could not be replaced `
        + `(${delErr.message}). It still carries the split it had.`,
    }
  }

  if (lines.length === 0) {
    return { ok: true, lines: 0, message: 'Saved as a single expense.' }
  }

  const rows = rowsFor(parent, lines).map(r => ({ ...r, source, source_id: sourceId }))
  const { data, error: insErr } = await client.from('pl_splits').insert(rows).select('id')

  if (insErr) {
    return {
      ok: false,
      lines: 0,
      message: `The payment was saved, but the split was not (${insErr.message}). `
        + 'It is currently booked as one expense — reopen it and split it again.',
    }
  }
  if (!data || data.length !== rows.length) {
    return {
      ok: false,
      lines: data?.length ?? 0,
      message: `The split was written as ${data?.length ?? 0} of ${rows.length} lines and `
        + 'the database reported no error, which usually means the write was refused. '
        + 'The payment is booked as one expense.',
    }
  }

  return {
    ok: true,
    lines: rows.length,
    message: `Split across ${rows.length} costs.`,
  }
}

/** The split a payment already carries, or an empty list. */
export async function loadSplits(
  client: any, source: SplitSource, sourceId: string,
): Promise<any[]> {
  const { data } = await client
    .from('pl_splits').select('*')
    .eq('source', source).eq('source_id', sourceId)
    .order('sort_order')
  return data || []
}
