import { fetchAllPages } from '../utils/fetchAllPages'

// ─── Every partner, not the first thousand ──────────────────────────────────
//
// PostgREST returns at most 1000 rows and does not say it truncated, and this
// book passed a thousand. Every dropdown that offered partners was therefore
// offering some of them: a partner past the cap could not be selected at all,
// and the Partners page reported "1000" as a total that happened to be the
// limit rather than the count.
//
// It surfaced through payroll. `Hajduk Milica` was in the book, flagged as an
// individual, and the posting panel reported that nobody of that name was in
// Partners — because the panel's query had NO ORDER AT ALL, so the thousand
// rows it received were an arbitrary thousand, different run to run. An
// unordered query past the cap does not truncate the end of a list; it
// truncates a random part of it.
//
// So: paged, and ordered by something unique. `name` for the order a reader
// expects, `id` after it because paging with `.range()` is only correct
// against a sort no two rows can tie on — and two partners genuinely share a
// name often enough that it would drop one and repeat another.

export interface PartnerLite {
  id: string
  name: string
  is_individual?: boolean | null
  [extra: string]: unknown
}

/**
 * The whole partner book.
 *
 * `columns` narrows what comes back where only a name is wanted — a thousand
 * rows of every column is a real cost on a dialog that opens on every click.
 */
export function fetchAllPartners<T = PartnerLite>(
  client: any, columns = '*',
): Promise<T[]> {
  return fetchAllPages<T>((from, to) =>
    client.from('partners').select(columns).order('name').order('id').range(from, to))
}
