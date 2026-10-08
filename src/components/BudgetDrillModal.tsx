import React, { useState, useEffect } from 'react'
import { supabase } from '../supabase'
import { fetchAllPages } from '../utils/fetchAllPages'
import { fmtMoneyCompact, fmtMoney, type BudgetFigureFormat } from '../utils/formatters'
import { makeClassKey } from '../services/budgetKeys'
import { countOf, plural } from '../utils/plural'
import { srDate } from '../utils/months'
import { carriesInto, isCreditPayment, figureIn, type Adjustment, type BudgetCurrency } from '../services/budgetForecast'
import {
  EntriesModal, EntryRow, useEntryEditor, em,
  EntryItem, buildEntryItems,
} from './EntriesModal'

// ─── The drill under a budget cell ───────────────────────────────────────────
//
// Lifted out of `Budgeting.tsx`, which was carrying it inline while it grew a
// second mode and three sections.
//
// Three questions, one component. An ACTUAL cell asks "what did we spend" and
// is answered with the transactions and invoices behind the number. An ESTIMATE
// cell asks "where did this figure come from" and is answered with the three
// things that make it: the benchmark-month entries carried into this month, the
// payments already owed in it, and every change recorded against it since. A
// COMMITTED cell asks "what is already owed" and is answered with the
// unpaid invoices that month's total is the sum of.
//
// The first two pick their rows from `drill.classKeys` — the key set the cell
// was summed from, resolved by the page against the tree the cell was drawn
// from. Not a filter rebuilt here from the row's label, which is how a
// drill-down starts listing something other than what it was opened from.
//
// `committed` is its own mode rather than a flavour of `estimate` because it
// answers a different question from a different source: a commitment has no
// classification to file it under and is not seeded from anything, so it has no
// `classKeys`, reads no entries and queries nothing. Folding it into `estimate`
// would mean one branch quietly doing none of what the mode is named for.

export interface DrillState {
  /** The tree node the cell belongs to. The ledger is looked up by this. */
  rowKey: string
  rowLabel: string
  month: string
  monthLabel: string
  mode: 'actual' | 'estimate'
  /**
   * Every classification key the clicked cell was summed from. Empty for a
   * `committed` drill, which is not a classification's figure at all.
   */
  classKeys: string[]
}

export default function BudgetDrillModal({
  drill, companyIds, benchmark, benchmarkLabel,
  ledgerEntries,
  currency = 'RSD',
  format = (n: number, showSign?: boolean) => fmtMoneyCompact(n, currency, showSign),
  onClose, onEditDone, onChange,
}: {
  drill: DrillState
  companyIds: string[]
  /** The month the estimate was seeded from — 'YYYY-MM'. */
  benchmark: string
  benchmarkLabel: string
  /** The change ledger for this node and month, exactly as the cell read it. */
  ledgerEntries: Adjustment[]
  /**
   * The currency the table the drill was opened from is shown in. Every entry
   * and ledger figure here is read in it — the stored `_rsd` or `_eur`
   * column, never a conversion.
   */
  currency?: BudgetCurrency
  /**
   * How the page is printing figures right now — full at the three-month
   * horizon, compact beyond it.
   *
   * Handed down rather than chosen here. This modal is opened FROM a cell and
   * restates that cell's total in its own header; picking its own formatter is
   * how the drill comes to say `1,6 hilj. RSD` above a list opened from a cell
   * reading `1.590 RSD`, and a reader then has two figures and no way to tell
   * whether they are the same one.
   */
  format?: BudgetFigureFormat
  onClose: () => void
  onEditDone: () => void
  /** Opens the change dialog for the cell this drill was opened from. */
  onChange?: () => void
}) {
  const [entries, setEntries] = useState<EntryItem[]>([])
  const [matched, setMatched] = useState(0)
  const [capped, setCapped] = useState(false)
  const [loading, setLoading] = useState(true)
  const [loadError, setLoadError] = useState('')
  const { openEntry, editorNode, busyId, error } = useEntryEditor(() => {
    onEditDone()
    setLoading(true)
    setEntries([])
  })

  useEffect(() => {
    const load = async () => {
      setLoading(true)
      setLoadError('')

      // An empty company list means "companies have not loaded yet", never
      // "every company". The `companyIds.length > 0` check on the `.in()` below
      // is not enough on its own: skipping the filter is skipping the scope, so
      // without this guard a drill opened during that first moment would query
      // every company in the database and total them under one company's label.
      // The main load is saved from this by its own early return; this modal
      // has none, so it needs one here.
      if (companyIds.length === 0) {
        setEntries([]); setMatched(0); setCapped(false); setLoading(false)
        return
      }

      // The keys the cell was summed from, not the row key parsed back into
      // filters. A parsed filter set is a second predicate that has to stay
      // in step with the grouping — and it did not: an absent segment was
      // dropped rather than matched as empty, so a department-less line
      // listed the whole category and the "Uncategorized" root, whose every
      // segment is empty, listed the entire month.
      const wanted = new Set(drill.classKeys)

      // The month whose entries are read: its own for an actual, the benchmark
      // for an estimate, because an estimate is made of the benchmark's rows.
      const readMonth = drill.mode === 'actual' ? drill.month : benchmark

      try {
        // No keys means no rows. An empty filter must never mean "everything".
        if (wanted.size === 0 || !readMonth) {
          setEntries([]); setMatched(0); setCapped(false)
          return
        }

        const [yr, mo] = readMonth.split('-').map(Number)
        const lastDay = new Date(yr, mo, 0).getDate()

        // v_pl_entries, not transactions alone — the same universe the totals
        // this modal was opened from are built from (commit 06af949). Reading
        // transactions here left invoice-driven expenses, payroll included, in
        // the total but missing from the list underneath it.
        //
        // Company, tx_type and month only: exactly the scope the totals query
        // uses. Classification is settled in JavaScript below, against the
        // same key function, so the two sets are identical by construction.
        //
        // No `.eq('status', 'posted')`: the view has no status column. Its own
        // `pl_impact = true` filter and the RLS policy hiding soft-deleted rows
        // scope it instead, exactly as they do for the total — the list has to
        // be scoped identically to the number it opened from, or it stops
        // adding up again.
        //
        // COST, known and deliberate: this re-reads the whole month on every
        // click, then throws away every row whose key is not wanted. A month
        // is a few thousand rows, so it is a second or two per drill, every
        // drill. The fix is to carry the entry ids alongside the sums when the
        // tree is built, so this modal fetches by id instead of re-deriving
        // the set — that belongs with the forecast rewrite, which is
        // restructuring how the cells are built anyway. Until then this is
        // slow on purpose, not by oversight.
        const monthRows = await fetchAllPages<any>((from, to) => {
          let q = supabase
            .from('v_pl_entries')
            // cf_type and cf_frequency ride along because the seeded list is
            // the subset of these rows that carries into the month shown.
            // project_id is part of the key the cell was summed by
            // (`makeClassKey`); without it every project row would read as
            // overhead and fall out of the list.
            .select('id, source, pl_category, pl_subcategory, department, dept_subcategory, expense_description, cf_type, cf_frequency, project_id')
            .eq('tx_type', 'expense')
            .gte('pl_date', `${readMonth}-01`)
            .lte('pl_date', `${readMonth}-${String(lastDay).padStart(2, '0')}`)
          // `.in(col, [])` matches nothing, so the filter is skipped when the
          // list is empty — but skipping it matches EVERYTHING, which is only
          // safe because the guard at the top of `load` has already returned.
          if (companyIds.length > 0) q = q.in('company_id', companyIds)

          // .range() needs a deterministic sort, or a row can land on two
          // pages or on none — pl_date alone is not unique.
          return q.order('pl_date').order('id').range(from, to)
        })

        const rows = monthRows
          .filter(r => wanted.has(makeClassKey(r)))
          // An estimate is not the benchmark month: it is the part of it that
          // recurs into this month. `carriesInto` and `isCreditPayment` are the
          // same two rules `seedFromEntries` seeded the figure with, asked once
          // each and used twice, so the list cannot drift from the number above
          // it. A credit instalment leg seeds nothing — its future comes from
          // the schedule, not from here — so listing it under "What seeds this"
          // would show an entry that contributed none of the figure.
          .filter(r => drill.mode === 'actual'
            || (carriesInto(r, benchmark, drill.month) && !isCreditPayment(r)))

        const built = await buildEntryItems(rows, supabase)
        setEntries(built.items)
        setMatched(built.total)
        setCapped(built.capped)
      } catch (e: any) {
        setLoadError(e?.message || String(e))
        setEntries([]); setMatched(0); setCapped(false)
      } finally {
        setLoading(false)
      }
    }
    load()
  }, [drill, companyIds, benchmark]) // eslint-disable-line react-hooks/exhaustive-deps

  const total = entries.reduce((s, e) => s + (figureIn(e, 'amount', currency) || 0), 0)
  // Nothing to scope by yet — render nothing rather than a modal reporting
  // zero transactions for a query that was never allowed to run. See the note
  // in the effect above for why an empty list is not "all companies".
  if (companyIds.length === 0) return null

  if (editorNode) return editorNode

  return (
    <EntriesModal
      kicker={drill.mode === 'actual' ? 'OSTVARENE TRANSAKCIJE' : 'BUDŽETSKA PROCENA'}
      title={drill.rowLabel}
      subtitle={
        <>
          {drill.monthLabel}
          {drill.mode === 'actual' && !loading && (
            <span style={{ marginLeft: '12px', color: '#FF5B5A', fontWeight: '600', fontFamily: "'DM Mono', monospace" }}>
              {/* Capped lists do not add up to the cell, and saying "total"
                  when they do not is how a report loses its reader. */}
              {format(total)}{capped ? ` za ${countOf(entries.length, 'prikazanu stavku', 'prikazane stavke', 'prikazanih stavki')}` : ' ukupno'}
            </span>
          )}
        </>
      }
      footerLeft={drill.mode === 'estimate'
        ? (onChange ? <button style={dm.changeBtn} onClick={onChange}>Izmeni ovaj iznos</button> : undefined)
        : (!loading && entries.length > 0
          ? (capped
            ? `Prikazano ${entries.length.toLocaleString('sr-Latn-RS')} od ${matched.toLocaleString('sr-Latn-RS')} transakcija · kliknite Izmeni za izmenu`
            : `${matched.toLocaleString('sr-Latn-RS')} ${plural(matched, 'transakcija', 'transakcije', 'transakcija')} · kliknite Izmeni za izmenu`)
          : undefined)}
      onClose={onClose}>

      {(loadError || error) && <div style={em.errorBox}>{loadError || error}</div>}

      {loading ? (
        <div style={em.empty}>Učitavanje…</div>
      ) : drill.mode === 'actual' ? (
        entries.length === 0 ? (
          <div style={em.empty}>Nema transakcija za ovu kategoriju i mesec.</div>
        ) : (
          <div style={{ display: 'flex', flexDirection: 'column', gap: '6px' }}>
            {entries.map(item => (
              <EntryRow key={item.id} item={item} onEdit={openEntry} busy={busyId === item.edit.id} />
            ))}
          </div>
        )
      ) : (
        <>
          <div style={em.infoBox}>
            <div style={{ fontSize: '12px', fontWeight: '600', color: '#00D47E', marginBottom: '6px', letterSpacing: '0.04em', textTransform: 'uppercase' }}>Kako nastaje budžetski iznos</div>
            <div style={{ fontSize: '13px', color: '#DCE9F6', lineHeight: 1.55 }}>
              Potrošnja referentnog meseca, preneta dalje prema klasifikaciji novčanog toka koju već ima —
              mesečni troškovi svakog meseca, kvartalni i godišnji u mesecu dospeća, jednokratni i kapitalni nikako.
              Svaka kasnija promena je zabeležena izmena budžeta, a nadređena stavka je zbir svega ispod nje.
            </div>
          </div>

          {/* 1 — the entries the figure was seeded from. */}
          <div style={em.sectionTitle}>Odakle potiče iznos</div>
          {entries.length === 0
            ? <div style={dm.nothing}>U referentnom mesecu ({benchmarkLabel}) nema ponavljajućih troškova za ovu stavku.</div>
            : (
              <div style={{ display: 'flex', flexDirection: 'column', gap: '6px' }}>
                {entries.map(item => (
                  <EntryRow key={item.id} item={item} onEdit={openEntry} busy={busyId === item.edit.id} />
                ))}
              </div>
            )}

          {/* 2 — the ledger. Handed in by the page, so it is literally the set
              `applyLedger` moved the figure with, in the order it read them. */}
          <div style={em.sectionTitle}>Izmene</div>
          {ledgerEntries.length === 0
            ? <div style={dm.nothing}>Nikad menjano — ovo je iznos preuzet iz referentnog meseca.</div>
            : ledgerEntries.map(a => {
              // In the table's currency where the entry has it; otherwise its
              // RSD figure, labelled RSD — never an RSD figure called EUR.
              const own = figureIn(a, 'amount', currency)
              const amount = own ?? Number(a.amount_rsd)
              const unit = own === null ? 'RSD' : currency
              return (
              <div key={a.id} style={{ padding: '9px 0', borderBottom: '0.5px solid rgba(255,255,255,0.06)' }}>
                <div style={{ display: 'flex', justifyContent: 'space-between', fontSize: '12px' }}>
                  <span style={{ color: '#DCE9F6' }}>{a.reason}</span>
                  <span style={{ color: amount > 0 ? '#FF5B5A' : '#00D47E', whiteSpace: 'nowrap' }}>
                    {a.kind === 'set' ? 'postavljeno na ' : amount > 0 ? '+' : ''}
                    {fmtMoney(amount, unit)}
                  </span>
                </div>
                <div style={{ fontSize: '10px', color: '#7A9BB8', marginTop: '2px' }}>
                  {srDate(a.created_at)}
                </div>
              </div>
              )
            })}
        </>
      )}
    </EntriesModal>
  )
}

/**
 * One thing already owed: what it is, which kind it is, and what it costs.
 *
 * Shared by the committed drill and the "already committed" note under an
 * estimate, so the two cannot start describing the same commitment differently.
 * `Intesa 100k #18` or the partner's name, with the kind spelled out beside it
 * — an instalment and an unpaid invoice are owed for different reasons and a
 * reader deciding what to chase needs to know which is which.
 */

const dm: Record<string, React.CSSProperties> = {
  nothing: { fontSize: '12px', color: 'rgba(255,255,255,0.30)', padding: '8px 0' },
  fallback: {
    margin: '6px 0 2px', padding: '7px 10px', borderRadius: '8px',
    background: 'rgba(245,166,35,0.12)', border: '0.5px solid rgba(245,166,35,0.3)',
    fontSize: '11px', color: '#F5A623', lineHeight: 1.5,
  },
  changeBtn: {
    fontFamily: "'Inter', sans-serif", fontSize: '12px', fontWeight: '500',
    padding: '6px 14px', border: '1px solid rgba(0,212,126,0.4)', borderRadius: '8px',
    background: 'rgba(0,212,126,0.08)', color: '#00D47E', cursor: 'pointer',
  },
}
