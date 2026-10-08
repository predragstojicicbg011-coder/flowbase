import React, { useEffect, useMemo, useRef, useState } from 'react'
import { DIALOG } from './dialogTheme'
import { countOf, plural } from '../utils/plural'
import {
  EntryRow, em, buildEntryItems, DRILL_CAP,
  type EntryItem, type EditTarget,
} from './EntriesModal'
import {
  groupByMonth, filterRows, parseFilter, summarise,
  type MonthGroup,
} from '../services/entryGroups'
import { useDisplayCurrency } from '../contexts/DisplayCurrencyContext'

// ─── A drill-down list, by month ────────────────────────────────────────────
//
// The body of an `EntriesModal` when the line behind it holds more rows than
// anyone can scroll. Eleven hundred transactions in one list is not a list; it
// is a wall with a scrollbar. Here they arrive as a dozen month headers, each
// carrying its own count and total, and you open the one you came for.
//
// TWO SOURCES, AND THE DIFFERENCE MATTERS
//
//   the headers   come from `rows` — the complete set the page already holds.
//                 Nothing is fetched to draw them and nothing can truncate
//                 them. See `groupByMonth` in ../services/entryGroups.
//
//   the entries   come from `buildEntryItems`, one month at a time, only when
//                 that month is opened. The view carries no partner name or
//                 note, so those have to be read back from `transactions` and
//                 `invoices`, and that read is capped at DRILL_CAP.
//
// So a total is never a fetched figure and a fetch is never a total. That is
// the whole reason the two are split, and it is also what makes the cap stop
// mattering in practice: a month of a 1,137-row line is about ninety rows, far
// under the cap, where the old single fetch hit it on the first click.
//
// NOT ONE BIG FETCH. Batching every id into a single `.in('id', …)` would be
// one round trip instead of twelve, and it is not available: 1,137 UUIDs is
// about 44KB of query string and PostgREST answers a GET that long with a 414
// before it ever reads the filter. A month's worth is about 3.7KB, which is
// comfortably inside every limit on the path.

/** What this list needs from a row. `PlEntry` satisfies it as it stands. */
export interface MonthlyEntryRow {
  id?: string
  source?: string | null
  pl_date: string
  amount_rsd: number | null
  amount_eur?: number | null
  expense_description?: string | null
}

export function MonthlyEntryList({
  rows, client, onEdit, busyId, money,
}: {
  /** Every row behind the line — complete, uncapped, and never fetched from. */
  rows: MonthlyEntryRow[]
  /**
   * The Supabase client, passed in rather than imported, for the same reason
   * `buildEntryItems` takes one: it is what makes this testable without a
   * database.
   */
  client: any
  onEdit: (target: EditTarget) => void
  busyId: string | null
  /** Formats a total; the figures are in the viewer's display currency. */
  money: (n: number) => string
}) {
  // Month totals add each row's own figure in the display currency.
  const { currency } = useDisplayCurrency()
  const groups = useMemo(() => groupByMonth(rows, currency), [rows, currency])

  /**
   * The newest month, opened by default.
   *
   * Every month collapsed would open the drill onto a column of headings and
   * nothing to read; opening all of them is the wall this component replaces.
   * The newest is the one the question is usually about, and on a line of this
   * size it is under a hundred rows — one small query.
   */
  const newest = groups.length > 0 ? [groups[0].key] : []

  const [query, setQuery] = useState('')
  const [applied, setApplied] = useState('')
  const [open, setOpen] = useState<string[]>(newest)
  const [detail, setDetail] = useState<Record<string, EntryItem[]>>({})
  const [capped, setCapped] = useState<Record<string, true>>({})
  const [busyMonths, setBusyMonths] = useState<string[]>([])
  const [scan, setScan] = useState<{ done: number; total: number } | null>(null)
  const [error, setError] = useState('')

  /**
   * Which months have been claimed for loading.
   *
   * A ref and not state: it is read inside the loader to decide what to fetch,
   * and putting it in state would re-run the loader on every completion and
   * restart the very loop that just made progress.
   */
  const loaded = useRef<Set<string>>(new Set())
  /** Bumped when the row set changes, so an in-flight loop knows it is stale. */
  const gen = useRef(0)

  // A new line was drilled: everything fetched for the last one is wrong now.
  // Adjusting state during render rather than in an effect, which is React's
  // documented way to reset on a changed prop — an effect would let one paint
  // of the new line's months go out carrying the old line's entries.
  const [lastRows, setLastRows] = useState(rows)
  if (lastRows !== rows) {
    setLastRows(rows)
    setDetail({}); setCapped({}); setBusyMonths([]); setScan(null); setError('')
    setQuery(''); setApplied('')
    setOpen(newest)
    loaded.current = new Set()
    gen.current += 1
  }

  // Typing is not a query. Without this, "Slack" is five searches, and a text
  // search reads every month.
  useEffect(() => {
    const t = setTimeout(() => setApplied(query), 220)
    return () => clearTimeout(t)
  }, [query])

  const filter = useMemo(() => parseFilter(applied), [applied])

  /** Every entry fetched so far, by id — what a text search looks names up in. */
  const detailById = useMemo(() => {
    const byId = new Map<string, EntryItem>()
    for (const items of Object.values(detail)) for (const it of items) byId.set(it.id, it)
    return byId
  }, [detail])

  /**
   * The matching rows, regrouped.
   *
   * `null` when nothing is typed, which is the difference between "no filter"
   * and "a filter that matched nothing" — the second greys every month out and
   * the first must not.
   */
  const matched = useMemo(() => {
    if (filter.kind === 'none') return null
    return groupByMonth(filterRows(rows, filter, currency, r => (r.id ? detailById.get(r.id) : undefined)), currency)
  }, [rows, filter, detailById, currency])

  const matchedByKey = useMemo(() => {
    const m = new Map<string, MonthGroup<MonthlyEntryRow>>()
    for (const g of matched || []) m.set(g.key, g)
    return m
  }, [matched])

  // Collapsing everything on a filter change and opening the result again
  // below. Without the reset, clearing a search would leave twelve months
  // expanded and eleven hundred rows in the DOM.
  const [lastFilter, setLastFilter] = useState(applied)
  if (lastFilter !== applied) {
    setLastFilter(applied)
    setOpen(parseFilter(applied).kind === 'none' ? newest : [])
  }

  /**
   * Which months need their detail.
   *
   * A text search needs all of them, because the vendor name it searches
   * exists only in the fetched detail. A search that quietly covered only the
   * months already opened would answer "no results" for a vendor that is
   * plainly there, which is worse than having no search at all.
   */
  const needed = useMemo(
    () => (filter.kind === 'text' ? groups.map(g => g.key) : groups.filter(g => open.includes(g.key)).map(g => g.key)),
    [filter.kind, groups, open])
  const neededKey = needed.join('|')

  useEffect(() => {
    const missing = needed.filter(k => !loaded.current.has(k))
    if (missing.length === 0) { setScan(null); return }

    const mine = gen.current
    const stale = () => gen.current !== mine
    const scanning = filter.kind === 'text'

    // One month at a time, on purpose. Each is a small `.in('id', …)`, and
    // firing a dozen at once buys nothing a reader can see while making the
    // failure mode a dozen simultaneous errors.
    const run = async () => {
      if (scanning) setScan({ done: 0, total: missing.length })
      for (let i = 0; i < missing.length; i++) {
        if (stale()) return
        const key = missing[i]
        const group = groups.find(g => g.key === key)
        if (!group) continue
        loaded.current.add(key)
        setBusyMonths(b => (b.includes(key) ? b : [...b, key]))
        try {
          const ids = group.rows.filter((r): r is MonthlyEntryRow & { id: string } => !!r.id)
          const built = await buildEntryItems(ids, client)
          if (stale()) return
          setDetail(d => ({ ...d, [key]: built.items }))
          if (built.capped) setCapped(c => ({ ...c, [key]: true }))
        } catch (e: any) {
          if (stale()) return
          setError(e?.message || String(e))
          // Recorded as empty rather than left unloaded, so the month reports
          // the error once instead of sitting on "Loading…" for ever.
          setDetail(d => ({ ...d, [key]: [] }))
        } finally {
          if (!stale()) setBusyMonths(b => b.filter(x => x !== key))
        }
        if (scanning && !stale()) setScan({ done: i + 1, total: missing.length })
      }
      if (!stale()) setScan(null)
    }
    run()
    // `needed` and `groups` are read through `neededKey`, which is the part of
    // them this has to react to. Listing them would restart the loop on every
    // re-render of the page above.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [neededKey, client])

  /**
   * Once a search has read every month, show what it found.
   *
   * Newest first and only while the running total stays within one fetch's
   * worth — a loose search must not put a thousand rows back on the screen,
   * which is the thing this component exists to stop.
   */
  const openable = useMemo(() => {
    if (!matched || filter.kind !== 'text') return null
    const keys: string[] = []
    let running = 0
    for (const g of matched) {
      if (g.count === 0) continue
      if (keys.length > 0 && running + g.count > DRILL_CAP) break
      keys.push(g.key)
      running += g.count
    }
    return keys
  }, [matched, filter.kind])

  // Read off `detail` rather than off the `scan` counter: a state setter fired
  // inside the loader is not visible to this effect in the same commit, so
  // gating on the counter would open months from a half-read search.
  const allRead = needed.every(k => k in detail)
  const openableKey = (openable || []).join('|')
  useEffect(() => {
    if (!openable || !allRead) return
    setOpen(o => {
      const add = openable.filter(k => !o.includes(k))
      return add.length === 0 ? o : [...o, ...add]
    })
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [openableKey, allRead])

  const toggle = (key: string) =>
    setOpen(o => (o.includes(key) ? o.filter(k => k !== key) : [...o, key]))

  const tally = summarise(matched || groups)
  /**
   * A month whose detail was capped has rows with no vendor name fetched, so
   * a text search did not see them. Said out loud rather than swallowed: an
   * incomplete search that looks complete is the failure this design is most
   * concerned with.
   */
  const searchIncomplete = filter.kind === 'text' && Object.keys(capped).length > 0

  if (groups.length === 0) return <div style={em.empty}>Za ovu liniju nema stavki.</div>

  return (
    <>
      {error && <div style={em.errorBox}>{error}</div>}

      <div style={ml.bar}>
        <input
          style={ml.search}
          value={query}
          onChange={e => setQuery(e.target.value)}
          aria-label="Filtriraj ove transakcije"
          placeholder="Filtriraj po nazivu — ili po iznosu: 500, 500,00, >1000, <=50"
        />
        {query !== '' && (
          <button style={ml.clear} onClick={() => setQuery('')} title="Poništi filter">poništi</button>
        )}
      </div>

      {filter.kind !== 'none' && (
        <div style={ml.note}>
          {scan
            ? `Čitaju se svi meseci da bi pretraga bila potpuna — ${scan.done} od ${scan.total}…`
            : tally.count === 0
              ? `Ništa ne odgovara pretrazi „${applied.trim()}“.`
              : `${tally.count.toLocaleString('sr-RS')} od ${rows.length.toLocaleString('sr-RS')} ${plural(rows.length, 'transakcije', 'transakcije', 'transakcija')}`
                + ` · ${tally.months} od ${groups.length} ${plural(groups.length, 'meseca', 'meseca', 'meseci')}`
                + ` · ${money(tally.total)}`}
        </div>
      )}

      {searchIncomplete && !scan && (
        <div style={ml.warn}>
          ⚠ Bar jedan mesec ima više od {DRILL_CAP} stavki, pa nisu mogli da se učitaju svi nazivi dobavljača.
          U tim redovima pretraga je išla samo po opisu troška — izvezite liniju za potpunu pretragu.
        </div>
      )}

      <div style={{ display: 'flex', flexDirection: 'column', gap: '4px' }}>
        {groups.map(g => {
          const hit = matchedByKey.get(g.key)
          const count = matched ? (hit?.count || 0) : g.count
          const total = matched ? (hit?.total || 0) : g.total
          const dead = count === 0
          const isOpen = open.includes(g.key) && !dead
          const items = detail[g.key]
          const keep = hit ? new Set(hit.rows.map(r => r.id)) : null
          const shown = !items ? [] : keep ? items.filter(i => keep.has(i.id)) : items

          return (
            <div key={g.key} style={{ opacity: dead ? 0.35 : 1 }}>
              <button
                style={{ ...ml.month, ...(isOpen ? ml.monthOpen : {}), cursor: dead ? 'default' : 'pointer' }}
                onClick={() => !dead && toggle(g.key)}
                disabled={dead}
                aria-expanded={isOpen}>
                <span style={ml.caret}>{dead ? '·' : isOpen ? '▾' : '▸'}</span>
                <span style={ml.monthLabel}>{g.label}</span>
                <span style={ml.monthCount}>
                  {count.toLocaleString('sr-RS')} {plural(count, 'stavka', 'stavke', 'stavki')}
                  {matched && count > 0 && g.count !== count && (
                    <span style={ml.ofAll}> od {g.count.toLocaleString('sr-RS')}</span>
                  )}
                </span>
                <span style={ml.monthTotal}>{money(total)}</span>
              </button>

              {isOpen && (
                <div style={ml.monthBody}>
                  {busyMonths.includes(g.key) || !items ? (
                    <div style={ml.loading}>Učitavanje: {g.label}…</div>
                  ) : shown.length === 0 ? (
                    <div style={ml.loading}>
                      {items.length === 0
                        ? 'Stavke ovog meseca nisu mogle da se učitaju.'
                        : 'Nijedna odgovarajuća stavka ovog meseca još nije učitana.'}
                    </div>
                  ) : (
                    <div style={{ display: 'flex', flexDirection: 'column', gap: '6px' }}>
                      {shown.map(item => (
                        <EntryRow key={item.id} item={item} onEdit={onEdit} busy={busyId === item.edit.id} />
                      ))}
                    </div>
                  )}
                  {capped[g.key] && items && items.length > 0 && (
                    <div style={ml.capNote}>
                      {g.label}: {countOf(g.count, 'stavka', 'stavke', 'stavki')}, i ukupan iznos iznad obuhvata
                      svaku od njih — ali prikazano je samo {items.length.toLocaleString('sr-RS')} najnovijih.
                      Izvezite liniju za ostale.
                    </div>
                  )}
                </div>
              )}
            </div>
          )
        })}
      </div>
    </>
  )
}

// The modal's own tokens where there is one, `DIALOG` otherwise. Nothing new:
// a drill-down that invents a colour is a drill-down that stops looking like
// the page it was opened from.
const ml: Record<string, React.CSSProperties> = {
  bar: { display: 'flex', gap: '8px', alignItems: 'center', marginBottom: '10px' },
  search: {
    flex: 1, minWidth: 0, fontFamily: "'Inter', system-ui, sans-serif", fontSize: '12.5px',
    padding: '8px 12px', borderRadius: '8px', outline: 'none',
    border: `1px solid ${DIALOG.border}`, background: DIALOG.raised, color: DIALOG.text,
  },
  clear: {
    fontFamily: "'Inter', system-ui, sans-serif", fontSize: '11px', padding: '6px 12px',
    borderRadius: '7px', border: `1px solid ${DIALOG.border}`,
    background: 'transparent', color: DIALOG.dim, cursor: 'pointer', flexShrink: 0,
  },
  note: { fontSize: '11.5px', color: DIALOG.dim, margin: '0 0 10px 2px' },
  warn: {
    margin: '0 0 10px', padding: '7px 10px', borderRadius: '8px',
    background: DIALOG.amberFill, border: `0.5px solid rgba(245,166,35,0.3)`,
    fontSize: '11px', color: DIALOG.amber, lineHeight: 1.5,
  },
  month: {
    width: '100%', display: 'flex', alignItems: 'center', gap: '10px',
    padding: '9px 14px', borderRadius: '10px', textAlign: 'left',
    border: `1px solid ${DIALOG.borderSoft}`, background: DIALOG.panelDeep,
    fontFamily: "'Inter', system-ui, sans-serif",
  },
  monthOpen: { background: DIALOG.accentTint, borderColor: DIALOG.borderSoft },
  caret: { color: DIALOG.dim, fontSize: '11px', width: '10px', flexShrink: 0 },
  monthLabel: { color: DIALOG.text, fontSize: '13px', fontWeight: 500, flex: 1, minWidth: 0 },
  monthCount: { color: DIALOG.dim, fontSize: '11px', whiteSpace: 'nowrap' },
  ofAll: { color: DIALOG.faint },
  monthTotal: {
    color: DIALOG.red, fontSize: '12.5px', fontWeight: 600,
    fontFamily: "'DM Mono', monospace", whiteSpace: 'nowrap',
    minWidth: '92px', textAlign: 'right',
  },
  monthBody: { padding: '8px 0 12px 14px' },
  loading: { padding: '14px', color: DIALOG.dim, fontSize: '12px' },
  capNote: {
    marginTop: '8px', padding: '8px 10px', borderRadius: '8px',
    background: DIALOG.amberFill, border: `0.5px solid rgba(245,166,35,0.3)`,
    fontSize: '11px', color: DIALOG.amber, lineHeight: 1.5,
  },
}
