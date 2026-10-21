// ─── The PDFs of waiting invoices, without being asked ──────────────────────
//
// An invoice's PDF and the supplier's attachments arrive only with its
// document, and the document is fetched by `sef-fetch-invoice`. For a waiting
// invoice SEF has already seen or settled, that fetch changes nothing on SEF,
// so the inbox fetches it as soon as it lists the row: the PDF and the
// attachments are there to look at before anything is booked.
//
// A New invoice is never fetched this way: the fetch would mark it Seen, and
// the accounting firm reads the same mailbox. Nor a renotified one, or one
// whose status is not known — those wait for someone to ask, and are told.

/** SEF statuses a fetch leaves as they are. Anything else is asked about. */
const QUIET_STATUSES = new Set(['seen', 'approved', 'rejected', 'cancelled', 'storno'])

export function fetchesQuietly(row: { state: string | null; ubl_fetched_at: string | null; sef_status: string | null }): boolean {
  return row.state === 'pending'
    && !row.ubl_fetched_at
    && QUIET_STATUSES.has(String(row.sef_status ?? '').trim().toLowerCase())
}

/** Every item through `fn`, at most `limit` at once; a failure is left to `fn` and does not stop the rest. */
export async function runLimited<T>(items: T[], limit: number, fn: (item: T) => Promise<void>): Promise<void> {
  let next = 0
  const worker = async () => {
    while (next < items.length) {
      const item = items[next++]
      try { await fn(item) } catch { /* the next one still runs */ }
    }
  }
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker))
}
