// ─── Paging past PostgREST's hard row cap ───────────────────────────────────
//
// PostgREST returns at most 1000 rows per response no matter what `.limit()`
// says, and it does not tell you it truncated. A query that reads one page and
// sums it looks perfectly healthy and is simply wrong once the table grows past
// the cap — every total silently stops rising.
//
// This has now bitten this codebase three times (run-rate forecast, pending
// reconcile count, P&L totals), so the fix lives in one place.
//
// Paging with .range() is only correct against a deterministic sort. Without
// an ORDER BY, Postgres may return rows in a different order per request, so a
// row can appear on two pages or on none. Every caller must order by something
// unique — pass `orderBy` and the helper will do it.

export const PAGE_SIZE = 1000

/** Guard against an unbounded loop if a query somehow never shrinks. */
const MAX_ROWS = 200000

export async function fetchAllPages<T>(
  build: (from: number, to: number) => any,
): Promise<T[]> {
  const all: T[] = []
  for (let from = 0; ; from += PAGE_SIZE) {
    const { data, error } = await build(from, from + PAGE_SIZE - 1)
    if (error) throw error
    const batch: T[] = data || []
    all.push(...batch)
    if (batch.length < PAGE_SIZE) break
    if (all.length >= MAX_ROWS) break
  }
  return all
}

/**
 * Exact row count without pulling the rows.
 *
 * `select('id')` followed by `.length` is the other half of the same bug: it
 * caps at 1000 and reports 1000 forever. PostgREST's exact count is read from
 * `count`, never from the data array.
 */
export async function countRows(query: any): Promise<number> {
  const { count, error } = await query
  if (error) throw error
  return count || 0
}

// ─── The other limit on the same path ───────────────────────────────────────
//
// `.in('id', ids)` puts every id in the query string, and a GET long enough is
// refused with a 414 before PostgREST ever reads the filter. About a thousand
// UUIDs is 40KB of URL; the refusal arrives as a network error with nothing in
// it about ids, which is why this is worth a named helper rather than a loop
// written again at each call site.
//
// See DRILL_CAP in components/EntriesModal.tsx, which caps a different query
// for the same reason.

/** UUIDs per request. 200 is about 8KB of query string — comfortably inside. */
export const ID_CHUNK = 200

export function chunkIds<T>(ids: T[], size: number = ID_CHUNK): T[][] {
  if (size < 1) return ids.length ? [ids] : []
  const out: T[][] = []
  for (let i = 0; i < ids.length; i += size) out.push(ids.slice(i, i + size))
  return out
}

/**
 * One query per chunk of ids, concatenated.
 *
 * `build` is handed a chunk and returns the query for it. Order across chunks
 * is the order of `ids`, not of the responses, so a caller that needs a
 * particular order still has to ask for it.
 */
export async function fetchByIds<T>(
  ids: string[],
  build: (chunk: string[]) => any,
  size: number = ID_CHUNK,
): Promise<T[]> {
  const all: T[] = []
  for (const chunk of chunkIds(ids, size)) {
    const { data, error } = await build(chunk)
    if (error) throw error
    all.push(...((data || []) as T[]))
  }
  return all
}
