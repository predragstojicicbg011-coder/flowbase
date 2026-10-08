import React, { useState, useEffect, useCallback, useMemo } from 'react'
import * as XLSX from 'xlsx'
import { supabase } from '../supabase'
import { SkeletonRows } from '../components/motion'
import { fetchAllPages } from '../utils/fetchAllPages'
import { useDataRefresh } from '../contexts/DataRefreshContext'
import { useCompanies } from '../contexts/CompaniesContext'
import { EntriesModal, useEntryEditor, em } from '../components/EntriesModal'
import { MonthlyEntryList } from '../components/MonthlyEntryList'
import { useDisplayCurrency } from '../contexts/DisplayCurrencyContext'
import { useProjects } from '../contexts/ProjectsContext'
import { OVERHEAD_LABEL, projectLabel } from '../services/projects'
import { PROJECT_FILTER_OVERHEAD, matchesProjectFilter, projectFilterLabel } from '../services/ledgerFilters'
import { KeyFigures, ChartDeck } from '../components/ExpenseVisuals'
import {
  buildTree, withComparison, paretoCut, flatten, findNode,
  contributesTo, BRANCHES, BRANCH_LABEL, BRANCH_COLUMNS,
  adjustedTotal, excludedTotal, totalOf, monthsIn, isExpenseRow,
  Branch, PlEntry, ComparedNode, UNASSIGNED,
} from '../services/expenseTree'
import {
  summaryRows, entryRows, preambleRows, type EntryDetail,
} from '../services/expenseExport'

// ── P&L Analysis ────────────────────────────────────────────────────────────
//
// A management report, not a data dump. It is built around the three questions
// that actually get asked in the room:
//
//   where does the money go   → treemap + tree table
//   what changed and why      → movers, ranked by contribution to the change
//   can I trust this number   → reconciliation strip, and drill to the rows
//
// THREE branches, three lenses on one number:
//
//   P&L category      what kind of cost
//   Department        who spends it
//   Project           which site or building it was spent on — or
//                     Opšti troškovi, the company's overhead
//
// They always tie. Rows missing a level are put under an explicit Unassigned
// node rather than dropped. Every row is FILED, never divided: a document
// shared by several projects arrives from v_pl_entries as one row per split
// line, each with its own project (see services/expenseTree.ts).
//
// A project filter narrows the whole page — every branch, the charts and the
// export — to one project, or to overhead alone.
//
// ── Why this page absorbed the P&L page ─────────────────────────────────────
//
// The old P&L page carried its analyses as extra columns beside a statement
// whose other figures had stopped being trustworthy. The analyses were the
// part worth keeping, so they moved here, where the tree, the comparison, the
// hide-a-line arithmetic and the drill-down already exist and are tested. One
// report, three tabs, one total.


const pct = (n: number | null, dp = 1) => n === null ? '—' : `${n > 0 ? '+' : ''}${n.toFixed(dp)}%`

/** Month keys for a period, plus the comparable prior period of equal length. */
function periodRange(mode: 'month' | 'quarter' | 'ytd', anchor: string) {
  const [y, m] = anchor.split('-').map(Number)
  const iso = (yy: number, mm: number, d: number) =>
    `${yy}-${String(mm).padStart(2, '0')}-${String(d).padStart(2, '0')}`
  const lastDay = (yy: number, mm: number) => new Date(Date.UTC(yy, mm, 0)).getUTCDate()

  if (mode === 'month') {
    const pm = m === 1 ? 12 : m - 1
    const py = m === 1 ? y - 1 : y
    return {
      from: iso(y, m, 1), to: iso(y, m, lastDay(y, m)),
      priorFrom: iso(py, pm, 1), priorTo: iso(py, pm, lastDay(py, pm)),
      label: anchor, priorLabel: `${py}-${String(pm).padStart(2, '0')}`,
    }
  }
  if (mode === 'quarter') {
    const q = Math.floor((m - 1) / 3)
    const qs = q * 3 + 1
    const pq = q === 0 ? 3 : q - 1
    const py = q === 0 ? y - 1 : y
    const pqs = pq * 3 + 1
    return {
      from: iso(y, qs, 1), to: iso(y, qs + 2, lastDay(y, qs + 2)),
      priorFrom: iso(py, pqs, 1), priorTo: iso(py, pqs + 2, lastDay(py, pqs + 2)),
      label: `${y} Q${q + 1}`, priorLabel: `${py} Q${pq + 1}`,
    }
  }
  return {
    from: iso(y, 1, 1), to: iso(y, m, lastDay(y, m)),
    priorFrom: iso(y - 1, 1, 1), priorTo: iso(y - 1, m, lastDay(y - 1, m)),
    label: `${y} YTD`, priorLabel: `${y - 1} YTD`,
  }
}

function fetchEntries(dateFrom: string, dateTo: string, companyId: string): Promise<PlEntry[]> {
  return fetchAllPages<PlEntry>((from, to) => {
    // `project_id` / `project_name` are the row's own — a split line's, not
    // its document's — and are what the project branch and filter read.
    let q = supabase.from('v_pl_entries')
      .select('id, tx_type, amount, amount_rsd, amount_eur, pl_category, pl_subcategory, department, dept_subcategory, expense_description, pl_date, company_id, source, project_id, project_name')
      .gte('pl_date', dateFrom).lte('pl_date', dateTo)
    if (companyId !== 'all') q = q.eq('company_id', companyId)
    return q.order('pl_date').order('id').range(from, to)
  })
}

export default function ExpenseAnalysis() {
  const { companies, defaultCompany, showPicker } = useCompanies()
  // Every tree below sums each row's own figure in the display currency.
  const { currency, format, pick } = useDisplayCurrency()
  const money = (n: number, dp = 0) => format(n, dp)
  const [companyId, setCompanyId] = useState('all')
  // With one company, "all" is that company and is called by its name.
  const companyName = companyId === 'all'
    ? (showPicker ? 'All companies' : defaultCompany?.name || 'All companies')
    : companies.find(c => c.id === companyId)?.name || ''
  const [mode, setMode] = useState<'month' | 'quarter' | 'ytd'>('ytd')
  const [anchor, setAnchor] = useState(new Date().toISOString().slice(0, 7))
  const [branch, setBranch] = useState<Branch>('pl')
  // '' all, PROJECT_FILTER_OVERHEAD overhead only, or a project id.
  const [projectFilter, setProjectFilter] = useState('')
  const { projects } = useProjects()
  const projectChoices = useMemo(
    () => projects.filter(p => companyId === 'all' || p.company_id === companyId),
    [projects, companyId])
  const projectFilterName = projectFilterLabel(
    projectFilter, id => { const p = projects.find(x => x.id === id); return p ? projectLabel(p) : '' })

  const [current, setCurrent] = useState<PlEntry[]>([])
  const [prior, setPrior] = useState<PlEntry[]>([])
  const [loading, setLoading] = useState(true)
  // The export fetches every entry's detail, so it is no longer instant.
  const [exporting, setExporting] = useState(false)
  const [error, setError] = useState('')

  const [expanded, setExpanded] = useState<Set<string>>(new Set())
  const [hidden, setHidden] = useState<Set<string>>(new Set())
  const [selected, setSelected] = useState<string | null>(null)
  const [search, setSearch] = useState('')

  // Clicking a line opens the same drill-down Budgeting uses: the entries
  // first, editing second. Seeing which of forty-four rows you are about to
  // change is the point of the step.
  //
  // The list itself is `MonthlyEntryList`, which takes the complete row set
  // below and does its own per-month reads — see that file for why the totals
  // and the fetches are deliberately kept apart.
  const { invalidate } = useDataRefresh()
  const { openEntry, editorNode, busyId, error: editError } = useEntryEditor(() => {
    invalidate('credits')
    load()
  })

  const range = useMemo(() => periodRange(mode, anchor), [mode, anchor])

  const load = useCallback(async () => {
    setLoading(true); setError('')
    try {
      const [cur, pri] = await Promise.all([
        fetchEntries(range.from, range.to, companyId),
        fetchEntries(range.priorFrom, range.priorTo, companyId),
      ])
      setCurrent(cur); setPrior(pri)
    } catch (e: any) { setError(e.message || String(e)) }
    setLoading(false)
  }, [range, companyId])

  useEffect(() => { load() }, [load])

  // The same expense definition the P&L page uses, so the two pages agree.
  // Pass-throughs, credit payments and invoice payments carry their own
  // tx_type and are correctly left out — they move cash, not cost.
  //
  // `side` in the service is where the revenue half plugs in later: swap this
  // predicate for the revenue tx_types and nothing else has to change.
  //
  // The project filter applies to both periods, so the comparison stays like
  // for like.
  const inScope = useCallback(
    (e: PlEntry) => isExpenseRow(e) && matchesProjectFilter(e.project_id, projectFilter),
    [projectFilter])
  const curExp = useMemo(() => current.filter(inScope), [current, inScope])
  const priorExp = useMemo(() => prior.filter(inScope), [prior, inScope])

  const tree = useMemo(() => buildTree(curExp, branch, currency), [curExp, branch, currency])
  const priorTree = useMemo(() => buildTree(priorExp, branch, currency), [priorExp, branch, currency])
  // Rows with no figure in the display currency count as zero — said, not hidden.
  const missingFigure = useMemo(() => curExp.filter(e => pick(e) === null).length, [curExp, pick])
  const compared = useMemo(() => withComparison(tree, priorTree), [tree, priorTree])

  const total = useMemo(() => totalOf(tree), [tree])
  const adjusted = useMemo(() => adjustedTotal(tree, hidden), [tree, hidden])
  const excluded = useMemo(() => excludedTotal(tree, hidden), [tree, hidden])
  const priorTotal = useMemo(() => totalOf(priorTree), [priorTree])
  const pareto = useMemo(() => paretoCut(tree, 80), [tree])
  const months = useMemo(() => monthsIn(curExp), [curExp])
  const monthlyTotals = useMemo(
    () => months.map(m => tree.reduce((sum, n) => sum + (n.monthly[m] || 0), 0)),
    [tree, months])
  const leafCount = useMemo(
    () => flatten(tree).filter(n => n.children.length === 0).length,
    [tree])

  // The two branches always tie by construction. What the strip is really for
  // is the Unassigned figure: the share of spend that cannot be put in front of
  // an owner. Built once here rather than inline in the markup, because at
  // ~5,500 rows two tree builds per keystroke is felt.
  const recon = useMemo(() => {
    const plTotal = totalOf(buildTree(curExp, 'pl', currency))
    const deptTree = buildTree(curExp, 'department', currency)
    return {
      plTotal,
      deptTotal: totalOf(deptTree),
      projectTotal: totalOf(buildTree(curExp, 'project', currency)),
      unassigned: deptTree.find(n => n.label === UNASSIGNED)?.amount || 0,
    }
  }, [curExp, currency])
  const unassigned = recon.unassigned

  /**
   * How far the open branch is from the P&L total.
   *
   * Every branch files the same rows, so this should be zero. It is kept as
   * a guard: if a branch ever drops or doubles a row, the page says so
   * rather than showing two totals that silently disagree.
   */
  const drift = total - recon.plTotal
  const drifting = Math.abs(drift) >= 0.01

  const toggle = (set: Set<string>, key: string, apply: (s: Set<string>) => void) => {
    const n = new Set(set)
    if (n.has(key)) n.delete(key); else n.add(key)
    apply(n)
  }

  const selectedNode = selected ? findNode(tree, selected) : null
  // Unsorted: only the length is read here, and `buildEntryItems` now sorts its
  // own input before capping, so a pre-sort would change nothing but the cost.
  //
  // `contributesTo` and not a second copy of the path rule written out here.
  // The copy fell out of step on one case: a category of nothing but spaces is
  // `Unassigned` to the tree, because the service trims before it decides the
  // value is empty, and was `''` to the copy, which fell back first and
  // trimmed after. Those rows were in the node's total and missing from the
  // list underneath it. Now the list is by construction the set the node was
  // summed from.
  const drillRows = useMemo(() => {
    if (!selectedNode) return []
    return curExp.filter(e => contributesTo(e, branch, selectedNode.path, currency))
  }, [selectedNode, curExp, branch, currency])

  /**
   * The whole report, in a file someone else can work with.
   *
   * Five sheets, and the split matters: a preamble that says what the file is,
   * the tree in EVERY branch so the reader is not stuck with whichever one
   * happened to be open, and every entry on its own row with its full
   * classification repeated onto it. That last sheet is the one a pivot or an
   * analysis tool can use — a tree cannot be pivoted.
   *
   * The entries are fetched here rather than reused from the drill, which caps
   * at DRILL_CAP for rendering. An export that silently stopped at 300 rows
   * would be the worst kind of wrong: a complete-looking file that is not.
   */
  const exportXlsx = async () => {
    setExporting(true)
    try {
      const treeFor = (b: Branch) =>
        withComparison(buildTree(curExp, b, currency), buildTree(priorExp, b, currency))
      const isExcluded = (key: string) => hidden.has(key)

      // Details come from the two base tables the view is built from, by id.
      // Chunked because a URL carrying thousands of uuids is rejected long
      // before PostgREST looks at it.
      const detail = new Map<string, EntryDetail>()
      const ids = curExp.filter(e => !!e.id)
      const isInvoice = (e: PlEntry) => String(e.source || '').toLowerCase().startsWith('inv')
      const CHUNK = 150

      const load = async (
        table: 'transactions' | 'invoices',
        rows: PlEntry[],
        dateCol: 'transaction_date' | 'invoice_date',
        docCol: string,
      ) => {
        for (let i = 0; i < rows.length; i += CHUNK) {
          const batch = rows.slice(i, i + CHUNK).map(r => r.id as string)
          const { data, error } = await supabase.from(table)
            .select(`id, ${dateCol}, ${docCol}, amount, currency, note, cf_type, partners(name), companies(name)`)
            .in('id', batch)
          if (error) throw error
          for (const r of (data || []) as any[]) {
            detail.set(r.id, {
              id: r.id,
              date: r[dateCol],
              partner: (r.partners as any)?.name || '',
              company: (r.companies as any)?.name || '',
              documentNo: r[docCol] || '',
              currency: r.currency || '',
              amount: r.amount ?? null,
              note: r.note || '',
              cfType: r.cf_type || '',
            })
          }
        }
      }

      await load('transactions', ids.filter(e => !isInvoice(e)), 'transaction_date', 'reference_number')
      await load('invoices', ids.filter(isInvoice), 'invoice_date', 'invoice_number')

      const entries = entryRows(curExp, detail)

      const wb = XLSX.utils.book_new()
      XLSX.utils.book_append_sheet(wb, XLSX.utils.json_to_sheet(preambleRows({
        period: range.label,
        priorPeriod: range.priorLabel,
        company: projectFilter ? `${companyName} · ${projectFilterName}` : companyName,
        total, prior: priorTotal, excluded, adjusted, unassigned,
        paretoLines: pareto.cutoff,
        entryCount: entries.length,
        generatedAt: new Date().toISOString().slice(0, 16).replace('T', ' '),
        currency,
      })), 'Read me')
      // Every branch, not whichever one happened to be open. A reader who
      // opens the file a week later has no idea which tab it was exported from.
      const SHEETS: [Branch, string][] = [
        ['pl', 'By P&L'],
        ['department', 'By department'],
        ['project', 'By project'],
      ]
      for (const [b, sheet] of SHEETS) {
        XLSX.utils.book_append_sheet(wb, XLSX.utils.json_to_sheet(
          summaryRows(treeFor(b), b, total, isExcluded)), sheet)
      }
      XLSX.utils.book_append_sheet(wb, XLSX.utils.json_to_sheet(entries), 'Entries')

      XLSX.writeFile(wb, `pl-analysis-${range.label.replace(/\s+/g, '-')}.xlsx`)
    } catch (err: any) {
      setError(`Export failed: ${err.message}`)
    }
    setExporting(false)
  }

  const matchesSearch = (n: ComparedNode): boolean => {
    if (!search.trim()) return true
    const q = search.toLowerCase()
    if (n.path.join(' ').toLowerCase().includes(q)) return true
    return n.children.some(matchesSearch)
  }

  const renderRows = (nodes: ComparedNode[]): React.ReactNode[] =>
    nodes.filter(matchesSearch).flatMap(n => {
      const isHidden = hidden.has(n.key)
      const isOpen = expanded.has(n.key) || (!!search.trim() && n.children.length > 0)
      const share = total > 0 ? (n.amount / total) * 100 : 0
      const spark = months.map(m => n.monthly[m] || 0)
      const sparkMax = Math.max(...spark, 1)

      const row = (
        <tr key={n.key}
          style={{
            ...s.row,
            opacity: isHidden ? 0.35 : 1,
            background: selected === n.key ? 'rgba(0,212,126,0.07)' : undefined,
          }}>
          <td style={{ ...s.td, paddingLeft: `${12 + n.depth * 20}px` }}>
            <div style={{ display: 'flex', alignItems: 'center', gap: '7px' }}>
              {n.children.length > 0 ? (
                <button style={s.caret} onClick={() => toggle(expanded, n.key, setExpanded)}>
                  {isOpen ? '▾' : '▸'}
                </button>
              ) : <span style={{ width: '14px' }} />}
              <span
                onClick={() => setSelected(selected === n.key ? null : n.key)}
                style={{
                  cursor: 'pointer',
                  color: n.label === UNASSIGNED ? '#F5A623' : '#DCE9F6',
                  fontWeight: n.depth === 0 ? 600 : 400,
                  textDecoration: isHidden ? 'line-through' : undefined,
                }}>
                {n.label}
              </span>
              {n.label === UNASSIGNED && (
                <span style={s.warnPill} title="These rows carry no department — they cannot be reported by owner">
                  unclassified
                </span>
              )}
            </div>
          </td>
          <td style={{ ...s.td, ...s.num, fontWeight: n.depth === 0 ? 600 : 400 }}>{money(n.amount)}</td>
          <td style={{ ...s.td, ...s.num, color: '#7A9BB8' }}>{share.toFixed(1)}%</td>
          <td style={{ ...s.td, ...s.num, color: '#7A9BB8' }}>{money(n.priorAmount)}</td>
          <td style={{ ...s.td, ...s.num, color: n.delta > 0 ? '#FF5B5A' : n.delta < 0 ? '#00D47E' : '#7A9BB8' }}>
            {n.delta === 0 ? '—' : money(n.delta)}
          </td>
          <td style={{ ...s.td, ...s.num, color: n.delta > 0 ? '#FF5B5A' : n.delta < 0 ? '#00D47E' : '#7A9BB8', fontSize: '11px' }}>
            {pct(n.deltaPct)}
          </td>
          <td style={{ ...s.td, width: '92px' }}>
            <Spark values={spark} max={sparkMax} rising={n.delta > 0} />
          </td>
          <td style={{ ...s.td, ...s.num, color: 'rgba(255,255,255,0.30)', fontSize: '11px' }}>{n.count}</td>
          <td style={{ ...s.td, textAlign: 'right' }}>
            <button style={s.hideBtn} onClick={() => toggle(hidden, n.key, setHidden)}
              title={isHidden ? 'Include in total' : 'Exclude from total'}>
              {isHidden ? 'show' : 'hide'}
            </button>
          </td>
        </tr>
      )
      return isOpen ? [row, ...renderRows(n.children)] : [row]
    })

  return (
    <div style={s.root} className="app-surface">
      <div style={s.body}>
        <div style={s.pageHeader}>
          <div>
            <div style={s.pageTitle}>P&amp;L Analysis</div>
            <div style={s.pageSub}>
              {loading ? 'Loading…'
                : `${companyName}${projectFilter ? ` · ${projectFilterName}` : ''} · ${range.label} vs ${range.priorLabel} · ${curExp.length.toLocaleString()} entries · ${currency}`
                  + (missingFigure > 0 ? ` · ${missingFigure.toLocaleString()} with no ${currency} figure, counted as zero` : '')}
            </div>
          </div>
          <div style={{ display: 'flex', gap: '8px', alignItems: 'center', flexWrap: 'wrap' }}>
            {showPicker && (
              <select style={s.sel} value={companyId} onChange={e => setCompanyId(e.target.value)}>
                <option value="all">All companies</option>
                {companies.map(c => <option key={c.id} value={c.id}>{c.name}</option>)}
              </select>
            )}
            <select style={s.sel} value={projectFilter} title="Project"
              onChange={e => { setProjectFilter(e.target.value); setSelected(null) }}>
              <option value="">All projects</option>
              <option value={PROJECT_FILTER_OVERHEAD}>{OVERHEAD_LABEL}</option>
              {projectChoices.map(p => (
                <option key={p.id} value={p.id}>{projectLabel(p)}{p.active ? '' : ' (zatvoren)'}</option>
              ))}
            </select>
            <select style={s.sel} value={mode} onChange={e => setMode(e.target.value as any)}>
              <option value="month">Monthly</option>
              <option value="quarter">Quarterly</option>
              <option value="ytd">Year to date</option>
            </select>
            <input type="month" style={s.sel} value={anchor} onChange={e => setAnchor(e.target.value)} />
            <button style={s.exportBtn} onClick={exportXlsx} disabled={loading || exporting || total === 0}>
              {exporting ? 'Exporting…' : '⬇ Export'}
            </button>
          </div>
        </div>

        {error && <div style={{ ...s.banner, borderColor: 'rgba(255,91,90,0.3)', background: 'rgba(255,91,90,0.08)', color: '#FF5B5A' }}>{error}</div>}

        {/* The figures that stay on screen no matter which chart is open:
            the number, its movement, whether it is stable month to month, how
            concentrated it is, and how much of it has no owner. */}
        <KeyFigures
          total={total}
          priorTotal={priorTotal}
          adjusted={adjusted}
          excluded={excluded}
          unassigned={unassigned}
          reconciled={Math.abs(recon.plTotal - recon.deptTotal) < 0.01}
          months={months}
          monthlyTotals={monthlyTotals}
          paretoCutoff={pareto.cutoff}
          paretoShare={pareto.sharePct}
          leafCount={leafCount}
          periodLabel={range.label}
          priorLabel={range.priorLabel}
        />

        <div style={s.toolbar}>
          {/* One row of tabs over one total. The order runs from the most
              descriptive question to the most managerial: what kind of cost,
              who spent it, and which site it was spent on. */}
          <div style={s.branchToggle}>
            {BRANCHES.map(b => (
              <button key={b}
                style={{ ...s.branchBtn, ...(branch === b ? s.branchBtnOn : {}) }}
                onClick={() => { setBranch(b); setSelected(null) }}>
                {BRANCH_ICON[b]} {BRANCH_LABEL[b]}
              </button>
            ))}
          </div>
          <input style={{ ...s.sel, minWidth: '240px' }} placeholder="Search any level…"
            value={search} onChange={e => setSearch(e.target.value)} />
          <div style={{ marginLeft: 'auto', display: 'flex', gap: '6px' }}>
            <button style={s.ghost} onClick={() => setExpanded(new Set(flatten(tree).map(n => n.key)))}>Expand all</button>
            <button style={s.ghost} onClick={() => setExpanded(new Set())}>Collapse</button>
            {hidden.size > 0 && <button style={s.ghost} onClick={() => setHidden(new Set())}>Show all ({hidden.size})</button>}
          </div>
        </div>

        {loading ? (
          <div style={{ ...s.tableWrap, marginBottom: '14px', padding: '20px' }}>
            <SkeletonRows rows={1} height={190} gap={0} widths={[100]} />
          </div>
        ) : (
          <ChartDeck
            branch={branch}
            tree={tree}
            compared={compared}
            months={months}
            hidden={hidden}
            selected={selected}
            onSelect={setSelected}
            periodLabel={range.label}
            priorLabel={range.priorLabel}
          />
        )}

        {drifting && (
          <div style={{ ...s.banner, borderColor: 'rgba(245,166,35,0.35)', background: 'rgba(245,166,35,0.08)', color: '#F5A623' }}>
            This view totals {money(total)}, {money(Math.abs(drift))} {drift > 0 ? 'more' : 'less'} than
            the {money(recon.plTotal)} the other tabs show. Every tab files the same rows, so this is a
            fault in the report, not in the books — please report it.
          </div>
        )}

        <div style={s.tableWrap}>
          <div style={{ overflowX: 'auto' }}>
            <table style={s.table}>
              <thead>
                <tr style={s.theadRow}>
                  <th style={{ ...s.th, minWidth: '300px' }}>{BRANCH_COLUMNS[branch]}</th>
                  <th style={{ ...s.th, textAlign: 'right' }}>Amount</th>
                  <th style={{ ...s.th, textAlign: 'right' }}>% total</th>
                  <th style={{ ...s.th, textAlign: 'right' }}>{range.priorLabel}</th>
                  <th style={{ ...s.th, textAlign: 'right' }}>Change</th>
                  <th style={{ ...s.th, textAlign: 'right' }}>%</th>
                  <th style={s.th}>Trend</th>
                  <th style={{ ...s.th, textAlign: 'right' }}>Tx</th>
                  <th style={{ ...s.th, textAlign: 'right' }} />
                </tr>
              </thead>
              <tbody>
                {loading
                  ? <tr><td colSpan={9} style={{ padding: '18px 16px' }}>
                      <SkeletonRows rows={7} height={14} gap={13}
                        widths={[88, 56, 92, 50, 80, 44, 84]} />
                    </td></tr>
                  : compared.length === 0
                    ? <tr><td colSpan={9} style={s.loading}>No expenses in this period.</td></tr>
                    : renderRows(compared)}
              </tbody>
              {!loading && compared.length > 0 && (
                <tfoot>
                  <tr style={s.totalRow}>
                    <td style={{ ...s.td, fontWeight: 600 }}>{hidden.size > 0 ? 'Adjusted total' : 'Total'}</td>
                    <td style={{ ...s.td, ...s.num, fontWeight: 600 }}>{money(adjusted)}</td>
                    <td colSpan={7} style={s.td} />
                  </tr>
                </tfoot>
              )}
            </table>
          </div>
        </div>

        {selectedNode && !editorNode && (
          <EntriesModal
            kicker="ACTUAL TRANSACTIONS"
            title={selectedNode.label}
            subtitle={
              <>
                {selectedNode.path.join(' › ')}
                <span style={{ marginLeft: '12px', color: '#FF5B5A', fontWeight: '600', fontFamily: "'DM Mono', monospace" }}>
                  {money(selectedNode.amount)} total
                </span>
                <span style={{ marginLeft: '10px' }}>
                  {total > 0 ? ((selectedNode.amount / total) * 100).toFixed(1) : '0'}% of {range.label}
                </span>
              </>
            }
            footerLeft={
              `${drillRows.length.toLocaleString()} transaction${drillRows.length !== 1 ? 's' : ''} · `
              + `grouped by month, newest first · amounts in ${currency} · click Edit to modify`
            }
            onClose={() => setSelected(null)}>

            {editError && <div style={em.errorBox}>{editError}</div>}

            {/* The complete row set, not a page of it. Every month header is
                counted and totalled from this in memory; only the entries
                inside an opened month are fetched. */}
            <MonthlyEntryList
              rows={drillRows}
              client={supabase}
              onEdit={openEntry}
              busyId={busyId}
              money={money}
            />
          </EntriesModal>
        )}

        {editorNode}

        <div style={s.footnote}>
          All three tabs read the same rows, so they always total the same. A row missing a
          department is placed under <strong>Unassigned</strong> rather than dropped, which is why the
          department view reconciles. <strong>By project</strong> files each row under its own project;
          a document split across several projects counts on each for its split line, and a row with
          no project is <strong>{OVERHEAD_LABEL}</strong> — overhead is never spread over the projects.
          Hiding a line removes it from the total so you can ask what spend looks like without it;
          the excluded amount stays on screen.
        </div>
      </div>
    </div>
  )
}

/** A row-sized area line. Bars at this size collapse into a solid block and
 *  stop carrying any shape at all, which is the only thing they are there for. */
function Spark({ values, max, rising }: { values: number[]; max: number; rising: boolean }) {
  const W = 84, H = 20
  if (values.length === 0) return <svg width={W} height={H} />
  const col = rising ? '#FF5B5A' : '#4EA8FF'
  if (values.length === 1) {
    return (
      <svg width={W} height={H} style={{ display: 'block' }}>
        <rect x={W / 2 - 3} y={H - 2 - (values[0] / max) * (H - 4)} width="6"
          height={Math.max((values[0] / max) * (H - 4), 1)} fill={col} opacity="0.7" />
      </svg>
    )
  }
  const x = (i: number) => (i / (values.length - 1)) * (W - 2) + 1
  const y = (v: number) => H - 2 - (v / max) * (H - 5)
  const line = values.map((v, i) => `${i === 0 ? 'M' : 'L'}${x(i).toFixed(1)},${y(v).toFixed(1)}`).join(' ')
  return (
    <svg width={W} height={H} style={{ display: 'block' }}>
      <path d={`${line} L${x(values.length - 1).toFixed(1)},${H} L${x(0).toFixed(1)},${H} Z`}
        fill={col} opacity="0.14" />
      <path d={line} fill="none" stroke={col} strokeWidth="1.3" strokeLinejoin="round" opacity="0.9" />
    </svg>
  )
}

/** One glyph per tab. Kept beside the styles rather than in the service:
 *  the service is tested arithmetic and has no business owning an emoji. */
const BRANCH_ICON: Record<Branch, string> = {
  pl: '📊', department: '🏢', project: '🏗',
}

const s: Record<string, React.CSSProperties> = {
  // The background lives in `.app-surface` rather than here: an inline
  // colour would paint straight over it.
  root: { minHeight: '100vh', fontFamily: "'Inter', system-ui, sans-serif" },
  body: { padding: '24px 28px' },
  pageHeader: { display: 'flex', alignItems: 'flex-start', justifyContent: 'space-between', marginBottom: '1.2rem', gap: '16px', flexWrap: 'wrap' },
  pageTitle: { fontFamily: "'DM Serif Display', Georgia, serif", fontSize: '24px', fontWeight: '400', color: '#DCE9F6', marginBottom: '4px' },
  pageSub: { fontSize: '13px', color: '#7A9BB8' },
  sel: { fontFamily: 'system-ui,sans-serif', fontSize: '13px', border: '1px solid rgba(255,255,255,0.075)', borderRadius: '8px', padding: '8px 12px', outline: 'none', background: '#0D1B2C', color: '#DCE9F6', cursor: 'pointer' },
  exportBtn: { fontFamily: "'Inter', system-ui, sans-serif", fontSize: '12.5px', fontWeight: 600, border: 'none', borderRadius: '8px', padding: '9px 16px', background: '#00D47E', color: '#060E1A', cursor: 'pointer' },
  banner: { border: '1px solid', borderRadius: '8px', padding: '10px 14px', fontSize: '12px', marginBottom: '14px' },
  reconStrip: { display: 'flex', background: '#0D1B2C', border: '1px solid rgba(255,255,255,0.075)', borderRadius: '10px', marginBottom: '14px', overflow: 'hidden' },
  reconCell: { flex: 1, padding: '12px 16px', borderRight: '1px solid rgba(255,255,255,0.06)' },
  reconLabel: { fontSize: '10px', color: 'rgba(255,255,255,0.30)', textTransform: 'uppercase', letterSpacing: '0.07em', marginBottom: '5px' },
  reconVal: { fontSize: '15px', fontWeight: 600, color: '#DCE9F6' },
  headline: { display: 'flex', gap: '28px', alignItems: 'flex-start', flexWrap: 'wrap', background: '#0D1B2C', border: '1px solid rgba(255,255,255,0.075)', borderRadius: '10px', padding: '16px 20px', marginBottom: '14px' },
  hLabel: { fontSize: '10px', color: 'rgba(255,255,255,0.30)', textTransform: 'uppercase', letterSpacing: '0.07em', marginBottom: '4px' },
  hValue: { fontSize: '30px', fontWeight: 600, color: '#DCE9F6', fontFamily: "'DM Mono', 'Fira Mono', monospace" },
  toolbar: { display: 'flex', gap: '10px', alignItems: 'center', marginBottom: '12px', flexWrap: 'wrap' },
  branchToggle: { display: 'flex', gap: 0, borderRadius: '8px', overflow: 'hidden', border: '1px solid rgba(255,255,255,0.10)' },
  branchBtn: { fontFamily: "'Inter', system-ui, sans-serif", fontSize: '12.5px', padding: '8px 16px', border: 'none', background: '#0D1B2C', color: '#7A9BB8', cursor: 'pointer' },
  branchBtnOn: { background: 'rgba(0,212,126,0.14)', color: '#00D47E', fontWeight: 600 },
  ghost: { background: 'transparent', color: '#7A9BB8', border: '1px solid rgba(255,255,255,0.12)', borderRadius: '7px', padding: '7px 13px', fontSize: '12px', cursor: 'pointer', fontFamily: "'Inter', system-ui, sans-serif" },
  treemapWrap: { background: '#0D1B2C', border: '1px solid rgba(255,255,255,0.075)', borderRadius: '10px', padding: '8px', marginBottom: '14px' },
  tableWrap: { background: '#0D1B2C', border: '1px solid rgba(255,255,255,0.075)', borderRadius: '10px', overflow: 'hidden' },
  table: { width: '100%', borderCollapse: 'collapse', fontSize: '13px' },
  theadRow: { background: '#060E1A' },
  th: { padding: '10px 12px', textAlign: 'left', fontSize: '10px', fontWeight: '500', color: 'rgba(255,255,255,0.30)', textTransform: 'uppercase', letterSpacing: '0.08em', whiteSpace: 'nowrap' },
  row: { borderBottom: '0.5px solid rgba(255,255,255,0.04)' },
  td: { padding: '7px 12px', color: '#DCE9F6', fontSize: '12.5px', whiteSpace: 'nowrap' },
  num: { textAlign: 'right', fontFamily: "'DM Mono', 'Fira Mono', monospace" },
  totalRow: { background: '#060E1A', borderTop: '2px solid rgba(255,255,255,0.14)' },
  caret: { background: 'none', border: 'none', color: '#7A9BB8', cursor: 'pointer', padding: 0, fontSize: '11px', width: '14px' },
  hideBtn: { background: 'transparent', border: '1px solid rgba(255,255,255,0.12)', borderRadius: '5px', color: '#7A9BB8', fontSize: '10px', padding: '2px 8px', cursor: 'pointer', fontFamily: "'Inter', system-ui, sans-serif" },
  warnPill: { fontSize: '9.5px', fontWeight: 600, padding: '1px 6px', borderRadius: '4px', background: 'rgba(245,166,35,0.15)', color: '#F5A623' },
  loading: { padding: '2rem', textAlign: 'center', color: '#7A9BB8', fontSize: '13px' },
  footnote: { fontSize: '11px', color: '#7A9BB8', marginTop: '14px', lineHeight: 1.7, maxWidth: '980px' },
}
