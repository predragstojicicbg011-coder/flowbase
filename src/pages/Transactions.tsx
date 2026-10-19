import React, { useState, useEffect, useMemo, useCallback } from 'react'
import { useAuth } from '../contexts/AuthContext'
import { useCompanies } from '../contexts/CompaniesContext'
import { supabase } from '../supabase'
import { SkeletonRows } from '../components/motion'
import { softDeleteRow } from '../services/writeOrder'
import { useDataRefresh } from '../contexts/DataRefreshContext'
import { fetchAllPages } from '../utils/fetchAllPages'
import InvoiceDialog from '../components/InvoiceDialog'
import TransactionDialog from '../components/TransactionDialog'
import PassthroughDialog from '../components/PassthroughDialog'
import ReconcilePanel from '../components/ReconcilePanel'
import BulkImport from '../components/BulkImport'
import SefInboxDialog from '../components/SefInboxDialog'
import InvoiceDocumentsDialog from '../components/InvoiceDocumentsDialog'
import DocumentTypeTag from '../components/DocumentTypeTag'
import { invoicesWithDocuments } from '../services/sef/invoiceDocuments'
import BankStatementDialog from '../components/BankStatementDialog'
import AutoMatchPanel from '../components/AutoMatchPanel'
import PayrollImportDialog from '../components/PayrollImportDialog'
import SearchableSelect, { type SelectOption } from '../components/SearchableSelect'
import { fmtMoney } from '../utils/formatters'
import { useDisplayCurrency } from '../contexts/DisplayCurrencyContext'
import { useProjects } from '../contexts/ProjectsContext'
import { OVERHEAD_LABEL, projectLabel, projectLabelById } from '../services/projects'
import {
  PROJECT_FILTER_OVERHEAD,
  TABS, CURRENCIES, REVENUE_STREAMS, PRESET_LABELS,
  emptyFiltersByTab, buildPredicates, activeChips, clearFields, clearTab,
  presetRange, dateColumn, plCategoryColumn,
  lastPageIndex, pageLabel, hasPrevPage, hasNextPage,
  type Tab, type FilterState, type DatePreset, type Predicate,
} from '../services/ledgerFilters'
import { deleteTransactionSafely } from '../services/writeOrder'
import { countOf, plural } from '../utils/plural'

// Which table each tab reads, and with which embeds. The filter itself is not
// here — it comes from `buildPredicates`, which is under test — so this stays
// the only place that knows a tab's shape.
/** How stored status and type values read on screen; the values stay English. */
const VALUE_LABEL: Record<string, string> = {
  unpaid: 'neplaćeno', partial: 'delimično', paid: 'plaćeno', overpaid: 'preplaćeno', reconciled: 'usaglašeno',
  unpaired: 'neupareno', paired: 'upareno', balanced: 'usklađeno',
  expense: 'ulazna', revenue: 'izlazna',
  direct: 'direktna', invoice_payment: 'plać. fakture', credit_payment: 'otplata kredita',
  transfer: 'prenos', intercompany: 'između firmi', passthrough: 'prolazna',
}
const valueLabel = (v: string | null | undefined): string => (v && VALUE_LABEL[v]) || v || '—'

const TAB_QUERY: Record<Tab, { table: string; select: string }> = {
  invoices: { table: 'v_invoice_status', select: '*' },
  transactions: {
    table: 'transactions',
    select: '*, companies!transactions_company_id_fkey(name), banks!transactions_bank_id_fkey(name), partners!transactions_partner_id_fkey(name)',
  },
  passthrough: { table: 'passthrough', select: '*, companies(name), banks(name), partners(name)' },
}

/** A classification list: the name is both the stored value and the label. */
const nameOpts = (names: string[]): SelectOption[] => names.map(n => ({ value: n, label: n }))

/** Walk a predicate list onto a PostgREST builder. Server-side, always. */
function applyPredicates(query: any, preds: Predicate[]): any {
  let q = query
  preds.forEach(p => {
    if (p.op === 'or') q = q.or(p.value)
    else if (p.op === 'in') q = q.in(p.column, p.value)
    else q = q[p.op](p.column, p.value)
  })
  return q
}

// `.range()` is only sound against a deterministic sort. The date alone is not
// unique, so two rows sharing a date could appear on both pages or on neither
// — and the totals below page through the whole result set, where that would
// quietly double-count. `id` is the tiebreak.
const ordered = (q: any, tab: Tab) =>
  q.order(dateColumn(tab), { ascending: false }).order('id')

export default function Transactions() {
  const { user } = useAuth()
  const { companies, showPicker } = useCompanies()
  // Book figures print, total and filter in the viewer's display currency:
  // amount_rsd / amount_eur, remaining_rsd / remaining_eur.
  const { currency, pick, field, format } = useDisplayCurrency()

  const { invalidate } = useDataRefresh()
  const [activeTab, setActiveTab] = useState<Tab>('invoices')
  const [showMenu, setShowMenu] = useState<string | null>(null)

  const [showInvoiceDialog, setShowInvoiceDialog] = useState(false)
  const [showTransactionDialog, setShowTransactionDialog] = useState(false)
  const [showPassthroughDialog, setShowPassthroughDialog] = useState(false)
  const [showBulkImport, setShowBulkImport] = useState(false)
  const [showSefInbox, setShowSefInbox] = useState(false)
  const [showBankStatement, setShowBankStatement] = useState(false)
  /** An `import_logs` row the statement editor should open straight onto. */
  const [editStatementLog, setEditStatementLog] = useState<any>(null)
  const [showPayrollImport, setShowPayrollImport] = useState(false)
  const [showAutoMatch, setShowAutoMatch] = useState(false)
  const [editInvoice, setEditInvoice] = useState<any>(null)
  // The invoice whose SEF documents are open, and which shown invoices have them.
  const [docsInvoiceId, setDocsInvoiceId] = useState<string | null>(null)
  const [withSef, setWithSef] = useState<Set<string>>(new Set())
  const [editTransaction, setEditTransaction] = useState<any>(null)
  const [editPassthrough, setEditPassthrough] = useState<any>(null)
  const [reconcileSource, setReconcileSource] = useState<{ type: 'transaction' | 'invoice'; id: string } | null>(null)

  // ── Filteri ───────────────────────────────────────────────────────────────
  // One state per tab, remembered across a tab switch. They used to be one
  // shared set, so a status picked on Invoices followed you to Pass-through
  // and matched nothing there — the same variable meant two different columns.
  const [filters, setFilters] = useState(emptyFiltersByTab())
  const [pages, setPages] = useState<Record<Tab, number>>({ invoices: 0, transactions: 0, passthrough: 0 })
  const [refreshTick, setRefreshTick] = useState(0)
  const f = filters[activeTab]

  const patchTab = useCallback((tab: Tab, patch: Partial<FilterState>) => {
    setFilters(prev => ({ ...prev, [tab]: { ...prev[tab], ...patch } }))
    // Page 0, always: page 3 of the old result set is not page 3 of the new one.
    setPages(prev => (prev[tab] === 0 ? prev : { ...prev, [tab]: 0 }))
  }, [])
  const setFilter = (patch: Partial<FilterState>) => patchTab(activeTab, patch)

  // The only other writer of `pages`, besides the filter-changed reset above.
  // Per tab, like the filters themselves: paging one tab must not move another.
  const goToPage = useCallback((tab: Tab, page: number) => {
    setPages(prev => (prev[tab] === page ? prev : { ...prev, [tab]: page }))
  }, [])

  const [rows, setRows] = useState<Record<Tab, any[]>>({ invoices: [], transactions: [], passthrough: [] })
  const [counts, setCounts] = useState<Record<Tab, number>>({ invoices: 0, transactions: 0, passthrough: 0 })
  const [loading, setLoading] = useState(true)
  const [fetchError, setFetchError] = useState('')

  const PAGE_SIZE = 50
  const today = useMemo(() => new Date().toISOString().slice(0, 10), [])

  // ── Lookups ───────────────────────────────────────────────────────────────
  // Loaded once for the whole page, not per tab switch: the cascading pickers
  // on two of the three tabs read the same five classification tables.
  const [lk, setLk] = useState<{
    partners: any[]; banks: any[]
    departments: any[]; deptSubs: any[]; expDescs: any[]; plCats: any[]; plSubs: any[]
  }>({ partners: [], banks: [], departments: [], deptSubs: [], expDescs: [], plCats: [], plSubs: [] })
  const [lkReady, setLkReady] = useState(false)

  useEffect(() => {
    let cancelled = false
    const load = async () => {
      const rowsOf = (p: any) => p.then((r: any) => r.data || [])
      const [banks, plCats, plSubs, departments, deptSubs, expDescs, partners] = await Promise.all([
        rowsOf(supabase.from('banks').select('id,name,company_id').order('name')),
        rowsOf(supabase.from('pl_categories').select('id,name,type,sort_order').order('sort_order')),
        rowsOf(supabase.from('pl_subcategories').select('id,name,category_id,sort_order').order('sort_order')),
        rowsOf(supabase.from('departments').select('id,name,sort_order').order('sort_order')),
        rowsOf(supabase.from('dept_subcategories').select('id,name,department_id,sort_order').order('sort_order')),
        rowsOf(supabase.from('expense_descriptions').select('id,name,dept_subcategory_id,sort_order').order('sort_order')),
        // Paged. The partner list is both the Partner picker's options and the
        // way free text reaches a partner name, and PostgREST's 1000-row cap
        // would have silently made both of those stop at the letter M.
        fetchAllPages<any>((from, to) =>
          supabase.from('partners').select('id,name').order('name').order('id').range(from, to)),
      ])
      if (cancelled) return
      setLk({ banks, plCats, plSubs, departments, deptSubs, expDescs, partners })
      setLkReady(true)
    }
    load()
    return () => { cancelled = true }
  }, [])

  // A partner name is a foreign key away, and filtering on an embedded
  // `partners.name` empties the embed without dropping the parent row. The
  // names are already in memory, so the ids cost nothing and no longer stop
  // at the 500 the old query asked for.
  const partnerIdsFor = useCallback((term: string): string[] => {
    const q = term.trim().toLowerCase()
    if (!q) return []
    return lk.partners.filter(p => (p.name || '').toLowerCase().includes(q)).map(p => p.id)
  }, [lk.partners])

  const predsFor = useCallback((tab: Tab): Predicate[] =>
    buildPredicates(tab, filters[tab], { today, partnerIds: partnerIdsFor(filters[tab].search), currency }),
  [filters, today, partnerIdsFor, currency])

  // ── The page of rows ──────────────────────────────────────────────────────
  useEffect(() => {
    if (!lkReady) return
    let cancelled = false
    const tab = activeTab
    const page = pages[tab]
    const cfg = TAB_QUERY[tab]
    setLoading(true); setFetchError('')
    ordered(applyPredicates(supabase.from(cfg.table).select(cfg.select), predsFor(tab)), tab)
      .range(page * PAGE_SIZE, (page + 1) * PAGE_SIZE - 1)
      .then(({ data, error }: any) => {
        if (cancelled) return
        // The old code did `if (!error && data)` and otherwise left the
        // previous rows on screen with no hint that the query had failed.
        if (error) { setFetchError(error.message || String(error)); setLoading(false); return }
        setRows(prev => ({ ...prev, [tab]: data || [] }))
        setLoading(false)
      })
    return () => { cancelled = true }
  }, [activeTab, pages, predsFor, lkReady, refreshTick, PAGE_SIZE])

  // ── The badge on the tabs you are NOT looking at ──────────────────────────
  // Counted server-side with `head: true` — no rows cross the wire. Each tab
  // is counted through its OWN filters, so the badge on a tab you are not
  // looking at is still the number you would see if you went there. The
  // active tab is deliberately absent: its count comes from the effect below,
  // with the sum, so the two can never be one generation apart.
  useEffect(() => {
    if (!lkReady) return
    let cancelled = false
    const others = TABS.filter(t => t !== activeTab)
    Promise.all(others.map(async tab => {
      const cfg = TAB_QUERY[tab]
      const { count } = await applyPredicates(
        supabase.from(cfg.table).select('id', { count: 'exact', head: true }), predsFor(tab))
      return [tab, count || 0] as [Tab, number]
    })).then(pairs => {
      if (cancelled) return
      setCounts(prev => {
        const next = { ...prev }
        pairs.forEach(([tab, c]) => { next[tab] = c })
        return next
      })
    }).catch(() => { /* the list fetch above surfaces the same failure */ })
    return () => { cancelled = true }
  }, [activeTab, predsFor, lkReady, refreshTick])

  // ── The count and the sum behind it ───────────────────────────────────────
  //
  // Every matching row, not the page on screen. Summing the 50 rows rendered
  // and calling it the total is the bug this codebase has shipped three times
  // already (run-rate forecast, pending reconcile, P&L totals), and a wrong
  // number presented as a right one is worse than no number.
  //
  // `fetchAllPages` and not an RPC: the helper is already the codebase's one
  // answer to PostgREST's 1000-row cap and it is already tested, whereas a
  // `sum()` RPC would be a migration that cannot be applied or verified from
  // here — and until it were applied by hand the figure would simply be an
  // error on screen. The cost is one round trip per 1000 matching rows.
  //
  // The count and the sum are resolved TOGETHER, from one predicate list, and
  // published in one setState. Two independent queries would land at two
  // different moments and the line would spend that gap asserting a count and
  // a sum that were never true at the same time.
  //
  // It cannot silently cap either: `rows` is how many rows the sum actually
  // saw, `count` is what the server says matched, and the render says so when
  // they part rather than showing the short figure as the total.
  const [totals, setTotals] = useState<{ status: 'loading' | 'ready' | 'error'; sum: number; rows: number }>(
    { status: 'loading', sum: 0, rows: 0 })

  useEffect(() => {
    if (!lkReady) return
    let cancelled = false
    const tab = activeTab
    const cfg = TAB_QUERY[tab]
    const preds = predsFor(tab)
    setTotals(t => ({ ...t, status: 'loading' }))
    Promise.all([
      applyPredicates(supabase.from(cfg.table).select('id', { count: 'exact', head: true }), preds)
        .then((r: any) => { if (r.error) throw r.error; return r.count || 0 }),
      fetchAllPages<Record<string, number | null>>((from, to) =>
        ordered(applyPredicates(supabase.from(cfg.table).select(field()), preds), tab).range(from, to)),
    ]).then(([count, all]) => {
      if (cancelled) return
      setCounts(prev => ({ ...prev, [tab]: count }))
      setTotals({ status: 'ready', rows: all.length, sum: all.reduce((acc, r) => acc + (pick(r) ?? 0), 0) })
    }).catch(() => { if (!cancelled) setTotals({ status: 'error', sum: 0, rows: 0 }) })
    return () => { cancelled = true }
  }, [activeTab, predsFor, lkReady, refreshTick, field, pick])

  const refresh = useCallback(() => setRefreshTick(t => t + 1), [])

  const fetchAll = () => {
    refresh()
    // Knjizenje kroz bulk/izvod/payroll moze da zatvori rate kredita —
    // signaliziraj Credits stranici da se osvezi.
    invalidate('credits'); invalidate('transactions'); invalidate('invoices')
  }

  // ── The free text, debounced ──────────────────────────────────────────────
  // Committed 300ms after the last keystroke. Every keystroke costs a list
  // query, three counts and a full sum; per letter that is not a search, it is
  // a stampede.
  //
  // The draft carries the tab it was typed on. Without that, switching tabs
  // inside the 300ms window commits half a word into the tab you just opened.
  const [draft, setDraft] = useState<{ tab: Tab; value: string }>({ tab: 'invoices', value: '' })
  useEffect(() => { setDraft({ tab: activeTab, value: filters[activeTab].search }) }, [activeTab]) // eslint-disable-line
  useEffect(() => {
    if (draft.tab !== activeTab) return
    if (draft.value === filters[draft.tab].search) return
    const t = setTimeout(() => patchTab(draft.tab, { search: draft.value }), 300)
    return () => clearTimeout(t)
  }, [draft, activeTab, filters, patchTab])

  const handleEditInvoice = async (inv: any) => {
    const { data } = await supabase.from('invoices').select('*, companies(name,currencies), partners(name)').eq('id', inv.id).single()
    if (data) { setEditInvoice(data); setShowInvoiceDialog(true) }
    setShowMenu(null)
  }

  const handleEditTransaction = async (t: any) => {
    const { data } = await supabase.from('transactions').select('*, companies(name,currencies), banks(name), partners(name)').eq('id', t.id).single()
    if (data) { setEditTransaction(data); setShowTransactionDialog(true) }
    setShowMenu(null)
  }

  const handleEditPassthrough = async (p: any) => {
    const { data } = await supabase.from('passthrough').select('*, companies(name,currencies), banks(name), partners(name)').eq('id', p.id).single()
    if (data) { setEditPassthrough(data); setShowPassthroughDialog(true) }
    setShowMenu(null)
  }

  // Soft delete: red ostaje u bazi (nevidljiv kroz API zahvaljujuci
  // restriktivnoj RLS politici), pa se greska moze vratiti. Vidi migraciju
  // 20260826120000_audit_and_soft_delete.sql.
  const softDelete = async (table: 'invoices' | 'transactions' | 'passthrough', id: string) => {
    // Through the database, not with an update from here: the restrictive
    // hide-deleted policy refuses the very write it exists to support. See
    // 20260921090000.
    const { ok, message } = await softDeleteRow(supabase, table, id, user?.id ?? null)
    const error = ok ? null : { message }
    if (error) {
      // Trigger za zakljucan period vraca gresku ovdje.
      window.alert(error.message)
      return false
    }
    return true
  }

  const deleteInvoice = async (id: string) => {
    if (!window.confirm('Obrisati ovu fakturu? To može da utiče na P&L.')) return
    if (!await softDelete('invoices', id)) return
    invalidate('invoices')
    refresh(); setShowMenu(null)
  }

  // Brisanje transakcije je tri upisa u tri tabele. Ranije su prva dva —
  // odvezivanje rata kredita i brisanje alokacija faktura — isla PRVA i bez
  // provjere greske, a soft delete, jedini koji triger za zatvoren period
  // odbija, isao POSLIJE. U zatvorenom mjesecu to je znacilo: rate i alokacije
  // obrisane, transakcija ostala, poruka "period je zakljucan", i tiho izgubljen
  // kreditni raspored. Redosljed i atomicnost su sada u `writeOrder`, zajedno
  // sa tacnom porukom za svaki korak koji moze da padne.
  const deleteTransaction = async (id: string) => {
    if (!window.confirm('Obrisati ovu transakciju?')) return
    const outcome = await deleteTransactionSafely(supabase, { transactionId: id, deletedBy: user?.id ?? null })
    if (!outcome.ok) { window.alert(outcome.message); return }
    // Signal other pages to refetch
    invalidate('credits')
    invalidate('transactions')
    invalidate('invoices')
    refresh(); setShowMenu(null)
  }

  const deletePassthrough = async (id: string) => {
    if (!window.confirm('Obrisati ovu prolaznu stavku?')) return
    if (!await softDelete('passthrough', id)) return
    refresh(); setShowMenu(null)
  }

  const invoiceStatusColors: Record<string, { bg: string; color: string }> = {
    unpaid: { bg: 'rgba(255,91,90,0.13)', color: '#FF5B5A' },
    partial: { bg: 'rgba(245,166,35,0.13)', color: '#F5A623' },
    paid: { bg: 'rgba(0,212,126,0.12)', color: '#00D47E' },
    overpaid: { bg: 'rgba(78,168,255,0.13)', color: '#4EA8FF' },
    overdue: { bg: 'rgba(255,91,90,0.20)', color: '#FF5B5A' },
    reconciled: { bg: 'rgba(255,255,255,0.06)', color: '#7A9BB8' },
  }
  const txTypeColors: Record<string, { bg: string; color: string }> = {
    invoice_payment: { bg: 'rgba(78,168,255,0.13)', color: '#4EA8FF' },
    direct: { bg: 'rgba(0,212,126,0.12)', color: '#00D47E' },
    transfer: { bg: 'rgba(245,166,35,0.13)', color: '#F5A623' },
    intercompany: { bg: 'rgba(212,83,126,0.13)', color: '#D4537E' },
  }
  const ptStatusColors: Record<string, { bg: string; color: string }> = {
    unpaired: { bg: 'rgba(255,91,90,0.13)', color: '#FF5B5A' },
    paired: { bg: 'rgba(245,166,35,0.13)', color: '#F5A623' },
    balanced: { bg: 'rgba(0,212,126,0.12)', color: '#00D47E' },
  }

  // Server-side filtriranje — data je već filtrirana; ovo su samo imena.
  const filteredInvoices = rows.invoices

  // Which invoices on this page have documents (SEF or uploaded), so their row shows 📎. A
  // failure only hides the clip; the menu's „Dokumenti“ still works.
  const invoiceIdsKey = filteredInvoices.map((i: any) => i.id).join(',')
  useEffect(() => {
    let live = true
    const ids = invoiceIdsKey ? invoiceIdsKey.split(',') : []
    invoicesWithDocuments(supabase, ids).then(set => { if (live) setWithSef(set) }).catch(() => {})
    return () => { live = false }
  }, [invoiceIdsKey])
  const filteredTransactions = rows.transactions
  const filteredPassthroughs = rows.passthrough

  // Summary stats — fetch aggregate data separately (not filtered)
  const [summaryStats, setSummaryStats] = useState({ unpaidTotal: 0, overdueCount: 0, unpairedPt: 0, directWithPL: 0, unpaidCount: 0 })
  useEffect(() => {
    const fetchStats = async () => {
      const today = new Date().toISOString().split('T')[0]
      // NAPOMENA: `count` se mora citati iz `count`, ne iz `data.length` —
      // PostgREST vraca najvise 1000 redova, pa je `.length` bio odsjecen
      // i metrika je pokazivala tacno 1000 umjesto stvarnog broja.
      const [{ data: unpaidData }, { count: ptCount }, { count: directCount }] = await Promise.all([
        supabase.from('v_invoice_status').select('remaining_rsd,remaining_eur,due_date,calculated_status').in('calculated_status', ['unpaid', 'partial']),
        supabase.from('passthrough').select('id', { count: 'exact', head: true }).eq('status', 'unpaired'),
        supabase.from('transactions').select('id', { count: 'exact', head: true }).eq('type', 'direct').eq('pl_impact', true).neq('status', 'reconciled'),
      ])
      const unpaidTotal = (unpaidData || []).reduce((s, i: any) => s + (pick(i, 'remaining') ?? 0), 0)
      const overdueCount = (unpaidData || []).filter(i => i.due_date && i.due_date < today).length
      setSummaryStats({
        unpaidTotal,
        overdueCount,
        unpairedPt: ptCount || 0,
        directWithPL: directCount || 0,
        unpaidCount: (unpaidData || []).length,
      })
    }
    fetchStats()
  }, [field, pick])
  const { unpaidTotal, overdueCount, unpairedPt, directWithPL } = summaryStats

  // Switching tabs no longer wipes anything: each tab keeps the filters it was
  // left with, and cannot inherit the other tab's.
  const handleTabChange = (tab: Tab) => { setActiveTab(tab); setShowMenu(null) }

  // ── Picker options ────────────────────────────────────────────────────────
  // Read off the lookup tables, not off the 50 rows on screen. The old P&L
  // dropdown listed the categories present in the current page, so a category
  // you could not see was a category you could not filter by.
  const deptId = useMemo(
    () => lk.departments.find(d => d.name === f.department)?.id || '', [lk.departments, f.department])
  const deptSubOpts = useMemo(
    () => lk.deptSubs.filter(x => x.department_id === deptId), [lk.deptSubs, deptId])
  const plCatId = useMemo(
    () => lk.plCats.find(c => c.name === f.plCategory)?.id || '', [lk.plCats, f.plCategory])
  const plSubOpts = useMemo(
    () => lk.plSubs.filter(x => x.category_id === plCatId), [lk.plSubs, plCatId])
  // Its own dropdown, and deliberately not narrowed by the department above
  // it: a row whose description and department disagree is exactly the row
  // this filter is used to find.
  const expDescOpts = useMemo(
    () => Array.from(new Set(lk.expDescs.map(d => d.name).filter(Boolean))).sort(), [lk.expDescs])
  const bankOpts = useMemo(
    () => (f.companyId ? lk.banks.filter(b => b.company_id === f.companyId) : lk.banks), [lk.banks, f.companyId])
  const plCatOpts = useMemo(() => {
    if (plCategoryColumn(activeTab, f) === 'revenue_stream') return [...REVENUE_STREAMS]
    return lk.plCats.filter(c => c.type !== 'revenue').map(c => c.name)
  }, [activeTab, f, lk.plCats])

  // ── Options for the searchable pickers ────────────────────────────────────
  // Mapped once per lookup change rather than per render: these are the long
  // lists — partners alone runs to several hundred — and the control filters
  // over whatever array it is handed.
  const partnerOpts = useMemo<SelectOption[]>(
    () => lk.partners.map(p => ({ value: p.id, label: p.name || '' })), [lk.partners])
  const expDescSelOpts = useMemo<SelectOption[]>(() => nameOpts(expDescOpts), [expDescOpts])
  const departmentOpts = useMemo<SelectOption[]>(
    () => nameOpts(lk.departments.map(d => d.name)), [lk.departments])
  const deptSubSelOpts = useMemo<SelectOption[]>(
    () => nameOpts(deptSubOpts.map(d => d.name)), [deptSubOpts])
  const plCatSelOpts = useMemo<SelectOption[]>(() => nameOpts(plCatOpts), [plCatOpts])
  const plSubSelOpts = useMemo<SelectOption[]>(
    () => nameOpts(plSubOpts.map(x => x.name)), [plSubOpts])

  // Every project, closed ones too: an old bill on a closed site must still
  // be findable. Narrowed to the company filter when one is set.
  const { projects } = useProjects()
  const projectSelOpts: SelectOption[] = useMemo(() => [
    { value: PROJECT_FILTER_OVERHEAD, label: OVERHEAD_LABEL },
    ...projects
      .filter(p => !f.companyId || p.company_id === f.companyId)
      .map(p => ({ value: p.id, label: p.active ? projectLabel(p) : `${projectLabel(p)} (zatvoren)` })),
  ], [projects, f.companyId])

  const chipNames = useMemo(() => ({
    company: (id: string) => companies.find(c => c.id === id)?.name || '',
    project: (id: string) => projectLabelById(projects, id),
    partner: (id: string) => lk.partners.find(p => p.id === id)?.name || '',
    bank: (id: string) => lk.banks.find(b => b.id === id)?.name || '',
  }), [lk, companies, projects])
  const chips = useMemo(() => activeChips(activeTab, f, chipNames, currency), [activeTab, f, chipNames, currency])

  const clearAll = () => {
    setDraft({ tab: activeTab, value: '' })
    patchTab(activeTab, clearTab(activeTab, filters[activeTab]))
  }

  // ── The filter controls ───────────────────────────────────────────────────
  const opt = (v: string, l?: string) => <option key={v} value={v}>{l || v}</option>
  const picker = (
    value: string, patch: (v: string) => Partial<FilterState>,
    placeholder: string, options: React.ReactNode, extra?: React.CSSProperties,
  ) => (
    <select style={{ ...s.filterSelect, ...extra }} value={value}
      onChange={e => setFilter(patch(e.target.value))}>
      <option value="">{placeholder}</option>
      {options}
    </select>
  )
  // The same shape as `picker`, for the lists too long to scan: partner,
  // expense description, department, dept sub-category, P&L category and P&L
  // sub-category. The short ones above — company, currency, status,
  // direction, type, the date preset — stay native `<select>`s: they are
  // three to five options and a text box over them would be noise.
  //
  // It is the control that changed, not the filter. The value handed back is
  // the same string the `<option>` carried, so `buildPredicates` is untouched.
  const searchPicker = (
    value: string, patch: (v: string) => Partial<FilterState>,
    allLabel: string, options: SelectOption[], extra?: React.CSSProperties,
  ) => (
    <SearchableSelect value={value} onChange={v => setFilter(patch(v))}
      options={options} allLabel={allLabel} title={allLabel}
      style={{ ...filterSearchStyle, ...extra }} />
  )
  const toggle = (isOn: boolean, label: string, patch: Partial<FilterState>, color: string) => (
    <button style={{
      ...s.filterSelect, cursor: 'pointer', whiteSpace: 'nowrap' as const,
      ...(isOn ? { color, border: `1px solid ${color}`, background: 'rgba(255,255,255,0.04)' } : {}),
    }} onClick={() => setFilter(patch)}>
      {isOn ? '☑' : '☐'} {label}
    </button>
  )

  const classificationPickers = (
    <>
      {searchPicker(f.projectId, v => ({ projectId: v }), 'Svi projekti',
        projectSelOpts, { maxWidth: '210px' })}
      {searchPicker(f.expenseDescription, v => ({ expenseDescription: v }), 'Svi opisi troškova',
        expDescSelOpts, { maxWidth: '210px' })}
      {searchPicker(f.department, v => ({ department: v, deptSubcategory: '' }), 'Svi sektori',
        departmentOpts)}
      {searchPicker(f.deptSubcategory, v => ({ deptSubcategory: v }),
        deptId ? 'Svi podsektori' : 'Podsektor',
        deptSubSelOpts,
        !deptId || deptSubOpts.length === 0 ? { opacity: 0.45 } : undefined)}
      {searchPicker(f.plCategory, v => ({ plCategory: v, plSubcategory: '' }),
        plCategoryColumn(activeTab, f) === 'revenue_stream' ? 'Sve vrste prihoda' : 'Sve P&L kategorije',
        plCatSelOpts)}
      {plCategoryColumn(activeTab, f) === 'pl_category' &&
        searchPicker(f.plSubcategory, v => ({ plSubcategory: v }),
          plCatId ? 'Sve P&L potkategorije' : 'P&L potkategorija',
          plSubSelOpts,
          !plCatId || plSubOpts.length === 0 ? { opacity: 0.45 } : undefined)}
    </>
  )

  const countWord = (n: number) => activeTab === 'invoices' ? plural(n, 'faktura', 'fakture', 'faktura')
    : activeTab === 'transactions' ? plural(n, 'transakcija', 'transakcije', 'transakcija')
      : plural(n, 'stavka', 'stavke', 'stavki')
  const matched = counts[activeTab]
  // The sum pages through every matching row; the count is a server-side
  // count of the same predicate. If the sum saw fewer rows than the count, it
  // is short and says so rather than presenting a smaller figure as the total.
  const sumShort = totals.status === 'ready' && totals.rows < matched

  // ── Paging, for the controls under the table ──────────────────────────────
  // Position is derived from `matched`, the same server-side count the result
  // bar reads — not from the length of the page in hand, which would still
  // read 50 on the last page's 50th row shy of the count.
  const page = pages[activeTab]
  const lastPage = lastPageIndex(matched, PAGE_SIZE)
  const canGoPrev = hasPrevPage(page)
  const canGoNext = hasNextPage(page, PAGE_SIZE, matched)
  const showPager = totals.status === 'ready' && !loading && matched > 0

  return (
    <div style={s.root} className="app-surface" onClick={() => setShowMenu(null)}>
      <div style={s.body}>
        <div style={s.pageHeader}>
          <div>
            <div style={s.pageTitle}>Glavna knjiga</div>
            <div style={s.pageSub}>Fakture, transakcije i prolazne stavke svih firmi</div>
          </div>
          <div style={s.btnGroup}>
            <button style={s.btnInvoice} className="mf-primary-action"
              onClick={() => { setEditInvoice(null); setShowInvoiceDialog(true) }}>📄 Nova faktura</button>
            <button style={s.btnTransaction} className="mf-primary-action"
              onClick={() => { setEditTransaction(null); setShowTransactionDialog(true) }}>💳 Nova transakcija</button>
            {/* The four ways entries arrive. One control, because they are one
                kind of thing -- not four more actions competing with the two
                above them. */}
            <div className="mf-intake">
              <button className="mf-intake-btn" onClick={() => setShowBankStatement(true)}>🏦 Izvod</button>
              <span className="mf-intake-divider" />
              <button className="mf-intake-btn" onClick={() => setShowBulkImport(true)}>📥 Grupni uvoz</button>
              <span className="mf-intake-divider" />
              <button className="mf-intake-btn" onClick={() => setShowSefInbox(true)}>📨 SEF sanduče</button>
              <span className="mf-intake-divider" />
              <button className="mf-intake-btn" onClick={() => setShowPayrollImport(true)}>📊 Uvoz zarada</button>
            </div>
          </div>
        </div>

        <div style={s.summaryRow} className="mf-stagger">
          <div style={s.summaryCard}>
            <div style={s.summaryLabel}>Otvorene fakture</div>
            <div style={s.summaryVal}>{format(unpaidTotal, 0)}</div>
            <div style={s.summarySub}>{countOf(summaryStats.unpaidCount, 'neplaćena faktura', 'neplaćene fakture', 'neplaćenih faktura')}</div>
          </div>
          <div style={{ ...s.summaryCard, ...(overdueCount > 0 ? s.summaryCardAlert : {}) }}>
            <div style={s.summaryLabel}>U kašnjenju</div>
            <div style={{ ...s.summaryVal, ...(overdueCount > 0 ? { color: '#FF5B5A' } : {}) }}>{overdueCount}</div>
            <div style={s.summarySub}>{overdueCount > 0 ? 'Fakture posle datuma dospeća' : 'Sve fakture su na vreme'}</div>
          </div>
          <div style={{ ...s.summaryCard, ...(directWithPL > 0 ? s.summaryCardWarn : {}) }}>
            <div style={s.summaryLabel}>Čeka uparivanje</div>
            <div style={{ ...s.summaryVal, ...(directWithPL > 0 ? { color: '#F5A623' } : {}) }}>{directWithPL}</div>
            <div style={s.summarySub}>{directWithPL > 0 ? 'Direktne transakcije bez fakture' : 'Sve direktne transakcije su uparene'}</div>
          </div>
          <div style={{ ...s.summaryCard, ...(unpairedPt > 0 ? s.summaryCardWarn : {}) }}>
            <div style={s.summaryLabel}>Neuparene prolazne stavke</div>
            <div style={{ ...s.summaryVal, ...(unpairedPt > 0 ? { color: '#F5A623' } : {}) }}>{unpairedPt}</div>
            {unpairedPt > 0 ? (
              <button style={s.autoMatchBtn} onClick={() => setShowAutoMatch(true)}>
                ⚡ Auto-upari →
              </button>
            ) : (
              <div style={s.summarySub}>Sve prolazne stavke su uparene</div>
            )}
          </div>
        </div>

        <div style={s.tabBar}>
          <div style={{ display: 'flex', gap: 0 }}>
            {([
              { id: 'invoices', label: '📄 Fakture', count: counts.invoices },
              { id: 'transactions', label: '💳 Transakcije', count: counts.transactions },
              { id: 'passthrough', label: '⚡ Prolazne stavke', count: counts.passthrough },
            ] as { id: Tab; label: string; count: number }[]).map(tab => (
              <button key={tab.id}
                style={{ ...s.tab, ...(activeTab === tab.id ? s.tabActive : {}) }}
                onClick={() => handleTabChange(tab.id)}>
                {tab.label}
                <span style={{ ...s.tabCount, ...(activeTab === tab.id ? s.tabCountActive : {}) }}>
                  {activeTab === tab.id && totals.status === 'loading' ? '…' : tab.count.toLocaleString('sr-RS')}
                </span>
              </button>
            ))}
          </div>
        </div>

        {/* ── What is applied, and what it adds up to ────────────────────
            Above the controls on purpose: the answer first, the knobs second.
            The figure covers the whole matching set, not the page below it. */}
        <div style={s.resultBar}>
          <div style={s.resultFigure}>
            {/* The count and the sum arrive together, and neither is shown
                before the other. Rendering last generation's count beside a
                fresh list is the same lie in miniature: a number on screen
                that no longer describes what is under it. */}
            {totals.status === 'loading'
              ? <span style={s.resultMuted}>brojanje…</span>
              : <>
                <span style={s.resultCount}>{matched.toLocaleString('sr-RS')} {countWord(matched)}</span>
                <span style={s.resultDot}>·</span>
              </>}
            {totals.status === 'loading' ? null
              : totals.status === 'error' ? <span style={{ ...s.resultMuted, color: '#FF5B5A' }}>broj nije dostupan</span>
                : <span style={s.resultSum} title={sumShort
                  ? `Sabrano ${totals.rows.toLocaleString('sr-RS')} od ${matched.toLocaleString('sr-RS')} odgovarajućih redova — ukupno je najmanje ovoliko.`
                  : `Svih ${totals.rows.toLocaleString('sr-RS')} odgovarajućih redova, ne samo strana ispod.`}>
                  {sumShort ? '≥ ' : ''}{format(totals.sum, 0)}
                </span>}
            {sumShort && (
              <span style={s.resultWarn}>
                sabrano {totals.rows.toLocaleString('sr-RS')} od {matched.toLocaleString('sr-RS')}
              </span>
            )}
            {/* Position now lives in the pager under the table — saying it
                here too would be the same fact printed in two places. */}
          </div>

          <div style={s.chipWrap}>
            {chips.map(chip => (
              <span key={chip.id} style={s.chip}>
                {chip.label}
                <button style={s.chipX} title="Ukloni ovaj filter"
                  onClick={() => patchTab(activeTab, clearFields(filters[activeTab], chip.clears))}>
                  ✕
                </button>
              </span>
            ))}
            {chips.length > 0 && (
              <button style={s.clearAll} onClick={clearAll}>✕ Poništi filtere</button>
            )}
          </div>
        </div>

        {fetchError && (
          <div style={s.errorBar}>Kartica nije učitana: {fetchError}</div>
        )}

        <div style={s.filterBar}>
          <div style={{ display: 'flex', gap: '8px', alignItems: 'center', flexWrap: 'wrap' as const, width: '100%' }}>
            {/* Shared by all three tabs */}
            <input type="text"
              placeholder={activeTab === 'invoices'
                ? 'Partner, broj fakture, napomena, opis, poziv na broj, račun…'
                : 'Partner, napomena, opis, poziv na broj, račun…'}
              value={draft.tab === activeTab ? draft.value : f.search}
              onChange={e => setDraft({ tab: activeTab, value: e.target.value })}
              style={{ ...s.searchInput, flex: 1, minWidth: '220px' }} />

            {showPicker && picker(f.companyId, v => ({ companyId: v, bankId: '' }), 'Sve firme',
              companies.map(c => opt(c.id, c.name)))}

            <select style={s.filterSelect} value={f.datePreset}
              onChange={e => {
                const preset = e.target.value as DatePreset
                if (preset === 'custom') { setFilter({ datePreset: 'custom' }); return }
                const r = presetRange(preset, today)
                setFilter({ datePreset: preset, dateFrom: r.from, dateTo: r.to })
              }}>
              {(Object.keys(PRESET_LABELS) as DatePreset[]).map(p => opt(p, PRESET_LABELS[p]))}
            </select>
            <input type="date" title={activeTab === 'invoices' ? 'Datum fakture od' : 'Datum od'}
              style={{ ...s.filterSelect, color: f.dateFrom ? '#DCE9F6' : '#7A9BB8' }}
              value={f.dateFrom} onChange={e => setFilter({ dateFrom: e.target.value, datePreset: 'custom' })} />
            <input type="date" title={activeTab === 'invoices' ? 'Datum fakture do' : 'Datum do'}
              style={{ ...s.filterSelect, color: f.dateTo ? '#DCE9F6' : '#7A9BB8' }}
              value={f.dateTo} onChange={e => setFilter({ dateTo: e.target.value, datePreset: 'custom' })} />

            <input type="text" inputMode="decimal" placeholder={`Min ${currency}`} title={`Najmanji iznos u ${currency}`}
              style={{ ...s.filterSelect, width: '92px' }}
              value={f.amountFrom} onChange={e => setFilter({ amountFrom: e.target.value })} />
            <input type="text" inputMode="decimal" placeholder={`Max ${currency}`} title={`Najveći iznos u ${currency}`}
              style={{ ...s.filterSelect, width: '92px' }}
              value={f.amountTo} onChange={e => setFilter({ amountTo: e.target.value })} />

            {picker(f.currency, v => ({ currency: v }), 'Sve valute', CURRENCIES.map(c => opt(c)))}

            {/* ── Transactions ─────────────────────────────────────────── */}
            {activeTab === 'transactions' && <>
              {picker(f.direction, v => ({ direction: v, plCategory: '', plSubcategory: '' }), 'Troškovi i prihodi',
                [opt('expense', 'Trošak'), opt('revenue', 'Prihod')])}
              {picker(f.txType, v => ({ txType: v }), 'Svi tipovi',
                [opt('direct', 'Direktna'), opt('invoice_payment', 'Plaćanje fakture'), opt('credit_payment', 'Otplata kredita')])}
              {classificationPickers}
              {toggle(f.unclassified, 'Neklasifikovano', { unclassified: !f.unclassified }, '#F5A623')}
            </>}

            {/* ── Invoices ─────────────────────────────────────────────── */}
            {activeTab === 'invoices' && <>
              {picker(f.direction, v => ({ direction: v }), 'Troškovi i prihodi',
                [opt('expense', 'Trošak'), opt('revenue', 'Prihod')])}
              {/* Three, because three is what `v_invoice_status` can answer.
                  This filtered on `calculated_status`, and the view produces
                  only unpaid, partial and paid — so `Overpaid` and
                  `Reconciled` were choices that always came back empty. */}
              {picker(f.invoiceStatus, v => ({ invoiceStatus: v }), 'Svi statusi',
                [opt('unpaid', 'Neplaćeno'), opt('partial', 'Delimično'), opt('paid', 'Plaćeno')])}
              {toggle(f.overdue, 'U kašnjenju', { overdue: !f.overdue }, '#FF5B5A')}
              <input type="date" title="Datum dospeća od"
                style={{ ...s.filterSelect, color: f.dueFrom ? '#DCE9F6' : '#7A9BB8' }}
                value={f.dueFrom} onChange={e => setFilter({ dueFrom: e.target.value })} />
              <input type="date" title="Datum dospeća do"
                style={{ ...s.filterSelect, color: f.dueTo ? '#DCE9F6' : '#7A9BB8' }}
                value={f.dueTo} onChange={e => setFilter({ dueTo: e.target.value })} />
              {searchPicker(f.partnerId, v => ({ partnerId: v }), 'Svi partneri',
                partnerOpts, { maxWidth: '190px' })}
              {classificationPickers}
            </>}

            {/* ── Pass-through ─────────────────────────────────────────── */}
            {activeTab === 'passthrough' && <>
              {picker(f.ptStatus, v => ({ ptStatus: v }), 'Svi statusi',
                [opt('unpaired', 'Neupareno'), opt('paired', 'Upareno'), opt('balanced', 'Usklađeno')])}
              {picker(f.ptDirection, v => ({ ptDirection: v }), 'Uplate i isplate',
                [opt('in', 'Uplata'), opt('out', 'Isplata')])}
              <input type="month" title="Period od"
                style={{ ...s.filterSelect, color: f.periodFrom ? '#DCE9F6' : '#7A9BB8' }}
                value={f.periodFrom} onChange={e => setFilter({ periodFrom: e.target.value })} />
              <input type="month" title="Period do"
                style={{ ...s.filterSelect, color: f.periodTo ? '#DCE9F6' : '#7A9BB8' }}
                value={f.periodTo} onChange={e => setFilter({ periodTo: e.target.value })} />
              {searchPicker(f.partnerId, v => ({ partnerId: v }), 'Svi partneri',
                partnerOpts, { maxWidth: '190px' })}
              {picker(f.bankId, v => ({ bankId: v }), 'Sve banke', bankOpts.map(b => opt(b.id, b.name)))}
            </>}
          </div>
        </div>
                <div style={s.tableWrap}>
          {loading ? (
            <div style={{ padding: '18px 16px' }}>
              <SkeletonRows rows={10} height={15} gap={14}
                widths={[80, 62, 90, 48, 84, 56, 88, 44, 76, 66]} />
            </div>
          ) : activeTab === 'invoices' && (
            filteredInvoices.length === 0 ? (
              <div style={s.emptyState}>
                <div style={{ fontSize: '32px', marginBottom: '12px' }}>📄</div>
                <div style={{ fontSize: '15px', fontWeight: '500', color: '#DCE9F6', marginBottom: '6px' }}>Još nema faktura</div>
                <div style={{ fontSize: '13px', color: '#7A9BB8', marginBottom: '20px' }}>Kliknite „Nova faktura“ da dodate prvu P&L stavku.</div>
                <button style={s.btnInvoice} onClick={() => setShowInvoiceDialog(true)}>📄 Nova faktura</button>
              </div>
            ) : (
              <table style={s.table}>
                <thead>
                  <tr style={s.thead}>
                    <th style={s.th}>Datum fakture</th><th style={s.th}>Datum dospeća</th><th style={s.th}>Partner</th>
                    <th style={s.th}>Broj fakture</th><th style={s.th}>Tip</th><th style={s.th}>P&L kategorija</th>
                    <th style={s.th}>Projekat</th><th style={s.th}>Firma</th><th style={{ ...s.th, textAlign: 'right' as const }}>Iznos</th>
                    <th style={{ ...s.th, textAlign: 'right' as const }}>Preostalo</th><th style={s.th}>Status</th><th style={s.th}></th>
                  </tr>
                </thead>
                <tbody>
                  {filteredInvoices.map((inv, i) => {
                    const isOverdue = inv.due_date && new Date(inv.due_date) < new Date() && ['unpaid', 'partial'].includes(inv.calculated_status)
                    return (
                      <tr key={inv.id} style={{ ...s.tr, background: i % 2 === 0 ? '#0D1B2C' : '#111F30' }}>
                        <td style={s.td}><span style={s.dateCell}>{inv.invoice_date}</span></td>
                        <td style={s.td}><span style={{ ...s.dateCell, color: isOverdue ? '#FF5B5A' : '#7A9BB8', fontWeight: isOverdue ? '600' : '400' }}>{inv.due_date || '—'}{isOverdue && ' ⚠️'}</span></td>
                        <td style={s.td}><span style={s.partnerCell}>{inv.partner_name || '—'}</span></td>
                        <td style={s.td}>
                          <span style={s.invNumCell}>{inv.invoice_number || '—'}</span>
                          <DocumentTypeTag documentType={inv.document_type} unlinked={inv.unlinked} />
                          {withSef.has(inv.id) && (
                            <button style={s.docsBtn} title="Račun i prilozi" aria-label="Dokumenti fakture"
                              onClick={e => { e.stopPropagation(); setDocsInvoiceId(inv.id) }}>📎</button>
                          )}
                        </td>
                        <td style={s.td}><span style={{ ...s.badge, background: inv.type === 'expense' ? '#FCEBEB' : '#E1F5EE', color: inv.type === 'expense' ? '#A32D2D' : '#085041' }}>{valueLabel(inv.type)}</span></td>
                        <td style={s.td}><span style={s.catCell}>{inv.pl_category || inv.revenue_stream || '—'}</span></td>
                        <td style={s.td}><span style={s.compCell}>{projectLabelById(projects, inv.project_id, inv.project_name)}</span></td>
                        <td style={s.td}><span style={s.compCell}>{inv.company_name || '—'}</span></td>
                        <td style={{ ...s.td, textAlign: 'right' as const }}><span style={s.amtCell}>{fmtMoney(inv.amount || 0, inv.currency)}</span></td>
                        <td style={{ ...s.td, textAlign: 'right' as const }}><span style={{ ...s.amtCell, color: (pick(inv, 'remaining') ?? 0) > 0.01 ? '#FF5B5A' : '#00D47E' }}>{format(pick(inv, 'remaining'))}</span></td>
                        <td style={s.td}><span style={{ ...s.badge, background: invoiceStatusColors[inv.calculated_status]?.bg, color: invoiceStatusColors[inv.calculated_status]?.color }}>{valueLabel(inv.calculated_status)}</span></td>
                        <td style={s.td} onClick={e => e.stopPropagation()}>
                          <div style={{ position: 'relative' }}>
                            <button style={s.editBtn} onClick={() => setShowMenu(showMenu === inv.id ? null : inv.id)}>···</button>
                            {showMenu === inv.id && (
                              <div style={s.contextMenu}>
                                <div style={s.contextItem} onClick={() => handleEditInvoice(inv)}>✏️ Izmeni</div>
                                <div style={s.contextItem} onClick={() => { setDocsInvoiceId(inv.id); setShowMenu(null) }}>📎 Dokumenti</div>
                                <div style={s.contextItem} onClick={() => { setReconcileSource({ type: 'invoice', id: inv.id }); setShowMenu(null) }}>🔗 Upari</div>
                                <div style={{ ...s.contextItem, color: '#FF5B5A' }} onClick={() => deleteInvoice(inv.id)}>🗑 Obriši</div>
                              </div>
                            )}
                          </div>
                        </td>
                      </tr>
                    )
                  })}
                </tbody>
              </table>
            )
          )}

          {!loading && activeTab === 'transactions' && (
            filteredTransactions.length === 0 ? (
              <div style={s.emptyState}>
                <div style={{ fontSize: '32px', marginBottom: '12px' }}>💳</div>
                <div style={{ fontSize: '15px', fontWeight: '500', color: '#DCE9F6', marginBottom: '6px' }}>Još nema transakcija</div>
                <div style={{ fontSize: '13px', color: '#7A9BB8', marginBottom: '20px' }}>Kliknite „Nova transakcija“ ili koristite grupni uvoz.</div>
                <div style={{ display: 'flex', gap: '10px', justifyContent: 'center', flexWrap: 'wrap' as const }}>
                  <button style={s.btnTransaction} className="mf-primary-action"
                    onClick={() => setShowTransactionDialog(true)}>💳 Nova transakcija</button>
                  <div className="mf-intake">
                    <button className="mf-intake-btn" onClick={() => setShowBankStatement(true)}>🏦 Izvod</button>
                    <span className="mf-intake-divider" />
                    <button className="mf-intake-btn" onClick={() => setShowBulkImport(true)}>📥 Grupni uvoz</button>
                    <span className="mf-intake-divider" />
                    <button className="mf-intake-btn" onClick={() => setShowPayrollImport(true)}>📊 Uvoz zarada</button>
                  </div>
                </div>
              </div>
            ) : (
              <table style={s.table}>
                <thead>
                  <tr style={s.thead}>
                    <th style={s.th}>Datum</th><th style={s.th}>Partner</th><th style={s.th}>Tip</th>
                    <th style={s.th}>P&L / faktura</th><th style={s.th}>Projekat</th><th style={s.th}>Napomena</th><th style={s.th}>Firma</th>
                    <th style={s.th}>Banka</th><th style={{ ...s.th, textAlign: 'right' as const }}>Iznos</th>
                    <th style={{ ...s.th, textAlign: 'right' as const }}>{currency}</th><th style={s.th}>P&L</th><th style={s.th}></th>
                  </tr>
                </thead>
                <tbody>
                  {filteredTransactions.map((t, i) => (
                    <tr key={t.id} style={{ ...s.tr, background: i % 2 === 0 ? '#0D1B2C' : '#111F30' }}>
                      <td style={s.td}><span style={s.dateCell}>{t.transaction_date}</span></td>
                      <td style={s.td}><span style={s.partnerCell}>{t.partners?.name || '—'}</span></td>
                      <td style={s.td}><span style={{ ...s.badge, background: txTypeColors[t.type]?.bg, color: txTypeColors[t.type]?.color }}>{valueLabel(t.type)}</span></td>
                      <td style={s.td}><span style={s.catCell}>{t.pl_impact ? (t.pl_category || t.revenue_stream || '—') : <span style={{ color: 'rgba(255,255,255,0.30)', fontSize: '11px' }}>preko fakture</span>}</span></td>
                      <td style={s.td}><span style={s.compCell}>{projectLabelById(projects, t.project_id)}</span></td>
                      <td style={s.td}><span style={s.descCell}>{t.note || '—'}</span></td>
                      <td style={s.td}><span style={s.compCell}>{t.companies?.name || '—'}</span></td>
                      <td style={s.td}><span style={s.compCell}>{t.banks?.name || '—'}</span></td>
                      <td style={{ ...s.td, textAlign: 'right' as const }}><span style={s.amtCell}>{fmtMoney(t.amount || 0, t.currency)}</span></td>
                      <td style={{ ...s.td, textAlign: 'right' as const }}><span style={s.bookCell}>{format(pick(t))}</span></td>
                      <td style={s.td}>{t.pl_impact ? <span style={{ ...s.badge, background: '#E1F5EE', color: '#085041' }}>✓ P&L</span> : <span style={{ ...s.badge, background: 'rgba(255,255,255,0.06)', color: 'rgba(255,255,255,0.30)' }}>Samo novac</span>}</td>
                      <td style={s.td} onClick={e => e.stopPropagation()}>
                        <div style={{ position: 'relative' }}>
                          <button style={s.editBtn} onClick={() => setShowMenu(showMenu === t.id ? null : t.id)}>···</button>
                          {showMenu === t.id && (
                            <div style={s.contextMenu}>
                              <div style={s.contextItem} onClick={() => handleEditTransaction(t)}>✏️ Izmeni</div>
                              {t.type === 'direct' && <div style={s.contextItem} onClick={() => { setReconcileSource({ type: 'transaction', id: t.id }); setShowMenu(null) }}>🔗 Upari</div>}
                              <div style={{ ...s.contextItem, color: '#FF5B5A' }} onClick={() => deleteTransaction(t.id)}>🗑 Obriši</div>
                            </div>
                          )}
                        </div>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            )
          )}

          {!loading && activeTab === 'passthrough' && (
            filteredPassthroughs.length === 0 ? (
              <div style={s.emptyState}>
                <div style={{ fontSize: '32px', marginBottom: '12px' }}>⚡</div>
                <div style={{ fontSize: '15px', fontWeight: '500', color: '#DCE9F6', marginBottom: '6px' }}>Nema prolaznih stavki</div>
                <div style={{ fontSize: '13px', color: '#7A9BB8', marginBottom: '20px' }}>Koristite „Nova transakcija“ i izaberite tip Prolazna stavka.</div>
              </div>
            ) : (
              <table style={s.table}>
                <thead>
                  <tr style={s.thead}>
                    <th style={s.th}>Datum</th><th style={s.th}>Period</th><th style={s.th}>Partner</th>
                    <th style={s.th}>Smer</th><th style={s.th}>Firma</th><th style={s.th}>Banka</th>
                    <th style={s.th}>Napomena</th><th style={{ ...s.th, textAlign: 'right' as const }}>Iznos</th>
                    <th style={{ ...s.th, textAlign: 'right' as const }}>{currency}</th><th style={s.th}>Status</th><th style={s.th}></th>
                  </tr>
                </thead>
                <tbody>
                  {filteredPassthroughs.map((p, i) => (
                    <tr key={p.id} style={{ ...s.tr, background: i % 2 === 0 ? '#0D1B2C' : '#111F30' }}>
                      <td style={s.td}><span style={s.dateCell}>{p.transaction_date}</span></td>
                      <td style={s.td}><span style={s.dateCell}>{p.period_month}</span></td>
                      <td style={s.td}><span style={s.partnerCell}>{p.partners?.name || '—'}</span></td>
                      <td style={s.td}><span style={{ ...s.badge, background: p.direction === 'in' ? '#E1F5EE' : '#FCEBEB', color: p.direction === 'in' ? '#085041' : '#A32D2D' }}>{p.direction === 'in' ? '📥 UPLATA' : '📤 ISPLATA'}</span></td>
                      <td style={s.td}><span style={s.compCell}>{p.companies?.name || '—'}</span></td>
                      <td style={s.td}><span style={s.compCell}>{p.banks?.name || '—'}</span></td>
                      <td style={s.td}><span style={s.descCell}>{p.note || '—'}</span></td>
                      <td style={{ ...s.td, textAlign: 'right' as const }}><span style={s.amtCell}>{fmtMoney(p.amount || 0, p.currency)}</span></td>
                      <td style={{ ...s.td, textAlign: 'right' as const }}><span style={s.bookCell}>{format(pick(p))}</span></td>
                      <td style={s.td}><span style={{ ...s.badge, background: ptStatusColors[p.status]?.bg, color: ptStatusColors[p.status]?.color }}>{valueLabel(p.status)}</span></td>
                      <td style={s.td} onClick={e => e.stopPropagation()}>
                        <div style={{ position: 'relative' }}>
                          <button style={s.editBtn} onClick={() => setShowMenu(showMenu === p.id ? null : p.id)}>···</button>
                          {showMenu === p.id && (
                            <div style={s.contextMenu}>
                              <div style={s.contextItem} onClick={() => handleEditPassthrough(p)}>✏️ Izmeni</div>
                              <div style={{ ...s.contextItem, color: '#FF5B5A' }} onClick={() => deletePassthrough(p.id)}>🗑 Obriši</div>
                            </div>
                          )}
                        </div>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            )
          )}

          {showPager && (
            <div style={s.pagination}>
              <button style={{ ...s.pageBtn, ...(canGoPrev ? {} : s.pageBtnDisabled) }}
                disabled={!canGoPrev} onClick={() => goToPage(activeTab, 0)} title="Prva strana">
                ⏮ Prva
              </button>
              <button style={{ ...s.pageBtn, ...(canGoPrev ? {} : s.pageBtnDisabled) }}
                disabled={!canGoPrev} onClick={() => goToPage(activeTab, page - 1)}>
                ← Prethodna
              </button>
              <span style={s.pageInfo}>{pageLabel(page, PAGE_SIZE, matched)}</span>
              <button style={{ ...s.pageBtn, ...(canGoNext ? {} : s.pageBtnDisabled) }}
                disabled={!canGoNext} onClick={() => goToPage(activeTab, page + 1)}>
                Sledeća →
              </button>
              <button style={{ ...s.pageBtn, ...(canGoNext ? {} : s.pageBtnDisabled) }}
                disabled={!canGoNext} onClick={() => goToPage(activeTab, lastPage)} title="Poslednja strana">
                Poslednja ⏭
              </button>
            </div>
          )}
        </div>
      </div>

      {docsInvoiceId && (
        <InvoiceDocumentsDialog invoiceId={docsInvoiceId} onClose={() => setDocsInvoiceId(null)}
          onLinked={() => setWithSef(prev => new Set(prev).add(docsInvoiceId))} />
      )}
      {(showInvoiceDialog || editInvoice) && (
        <InvoiceDialog onClose={() => { setShowInvoiceDialog(false); setEditInvoice(null); refresh() }} invoice={editInvoice} />
      )}
      {(showTransactionDialog || editTransaction) && (
        <TransactionDialog onClose={() => { setShowTransactionDialog(false); setEditTransaction(null); refresh(); invalidate('credits') }} transaction={editTransaction} sourceTable="transactions" />
      )}
      {(showPassthroughDialog || editPassthrough) && (
        <PassthroughDialog onClose={() => { setShowPassthroughDialog(false); setEditPassthrough(null); refresh() }} passthrough={editPassthrough} />
      )}
      {reconcileSource && (
        <ReconcilePanel sourceType={reconcileSource.type} sourceId={reconcileSource.id} onClose={() => setReconcileSource(null)} onReconciled={() => fetchAll()} />
      )}
      {showBulkImport && (
        <BulkImport
          onClose={() => setShowBulkImport(false)}
          onImported={() => fetchAll()}
          // Changing what an import posted is the statement editor's job, and
          // it already reopens a batch properly. The import closes and hands
          // the statement over rather than opening a dialog inside a dialog.
          onEditStatement={log => { setShowBulkImport(false); setEditStatementLog(log); setShowBankStatement(true) }} />
      )}
      {showSefInbox && (
        <SefInboxDialog
          onClose={() => setShowSefInbox(false)}
          // Not closed on a booking: the owner works through a queue, and
          // closing here would cut the invoice dialog's confirmation short
          // and send him back to reopen the inbox after every one.
          onImported={() => fetchAll()} />
      )}
      {showAutoMatch && (
        <AutoMatchPanel
          onClose={() => setShowAutoMatch(false)}
          onPaired={() => { refresh(); invalidate('transactions') }}
        />
      )}
      {showBankStatement && (
        <BankStatementDialog
          onClose={() => { setShowBankStatement(false); setEditStatementLog(null) }}
          onImported={() => fetchAll()}
          editLog={editStatementLog} />
      )}
      {showPayrollImport && (
        <PayrollImportDialog onClose={() => setShowPayrollImport(false)} onPosted={() => { setShowPayrollImport(false); fetchAll() }} />
      )}
    </div>
  )
}

const s: Record<string, React.CSSProperties> = {
  // The background lives in `.app-surface` rather than here: an inline
  // colour would paint straight over it.
  root: { minHeight: '100vh', fontFamily: "'Inter', system-ui, sans-serif" },
  body: { padding: '24px 28px' },
  pageHeader: { display: 'flex', alignItems: 'flex-start', justifyContent: 'space-between', marginBottom: '1.5rem' },
  pageTitle: { fontFamily: "'DM Serif Display', Georgia, serif", fontSize: '24px', fontWeight: '400', color: '#DCE9F6', marginBottom: '4px' },
  pageSub: { fontSize: '13px', color: '#7A9BB8' },
  btnGroup: { display: 'flex', gap: '10px', alignItems: 'center', flexWrap: 'wrap' as const },
  btnInvoice: { background: '#00D47E', color: '#060E1A', border: 'none', borderRadius: '8px', padding: '9px 16px', fontFamily: 'system-ui,sans-serif', fontSize: '13px', fontWeight: '500', cursor: 'pointer' },
  btnTransaction: { background: '#185FA5', color: '#fff', border: 'none', borderRadius: '8px', padding: '9px 16px', fontFamily: 'system-ui,sans-serif', fontSize: '13px', fontWeight: '500', cursor: 'pointer' },
  summaryRow: { display: 'grid', gridTemplateColumns: 'repeat(4,1fr)', gap: '12px', marginBottom: '1.5rem' },
  summaryCard: { background: '#0D1B2C', border: '1px solid rgba(255,255,255,0.075)', borderRadius: '10px', padding: '14px 16px' },
  summaryCardAlert: { border: '1px solid rgba(255,91,90,0.3)', background: 'rgba(255,91,90,0.07)' },
  autoMatchBtn: {
    marginTop: '4px', background: 'transparent', border: 'none', padding: 0,
    color: '#F5A623', fontSize: '11px', fontWeight: 600, cursor: 'pointer',
    fontFamily: "'Inter', system-ui, sans-serif", textAlign: 'left',
  },
  summaryCardWarn: { border: '1px solid rgba(245,166,35,0.3)', background: 'rgba(245,166,35,0.07)' },
  summaryLabel: { fontSize: '10px', fontWeight: '500', color: 'rgba(255,255,255,0.30)', textTransform: 'uppercase' as const, letterSpacing: '0.08em', marginBottom: '6px' },
  summaryVal: { fontSize: '22px', fontWeight: '500', color: '#DCE9F6', marginBottom: '4px' },
  summarySub: { fontSize: '11px', color: '#7A9BB8' },
  tabBar: { display: 'flex', alignItems: 'center', borderBottom: '0.5px solid rgba(255,255,255,0.075)', marginBottom: '1rem' },
  tab: { fontFamily: 'system-ui,sans-serif', fontSize: '13px', padding: '10px 18px', border: 'none', background: 'transparent', color: '#7A9BB8', cursor: 'pointer', borderBottom: '2px solid transparent', marginBottom: '-0.5px', display: 'flex', alignItems: 'center', gap: '6px' },
  tabActive: { color: '#DCE9F6', borderBottomColor: '#00D47E', fontWeight: '500' },
  tabCount: { fontSize: '10px', fontWeight: '500', padding: '1px 6px', borderRadius: '10px', background: 'rgba(255,255,255,0.06)', color: 'rgba(255,255,255,0.30)' },
  tabCountActive: { background: 'rgba(0,212,126,0.12)', color: '#00D47E' },
  filterBar: { display: 'flex', alignItems: 'center', gap: '10px', marginBottom: '1rem', flexWrap: 'wrap' as const },
  resultBar: { display: 'flex', alignItems: 'center', gap: '10px', marginBottom: '10px', flexWrap: 'wrap' as const },
  resultFigure: { display: 'flex', alignItems: 'baseline', gap: '7px', background: '#0D1B2C', border: '1px solid rgba(255,255,255,0.075)', borderRadius: '8px', padding: '8px 14px', whiteSpace: 'nowrap' as const },
  resultCount: { fontSize: '13px', fontWeight: '500', color: '#DCE9F6' },
  resultDot: { fontSize: '13px', color: 'rgba(255,255,255,0.30)' },
  resultSum: { fontSize: '14px', fontWeight: '600', color: '#00D47E', fontFamily: "'DM Mono', 'Fira Mono', monospace" },
  resultMuted: { fontSize: '12px', color: '#7A9BB8' },
  resultWarn: { fontSize: '10px', fontWeight: '600', padding: '1px 7px', borderRadius: '4px', background: 'rgba(245,166,35,0.15)', color: '#F5A623' },
  chipWrap: { display: 'flex', alignItems: 'center', gap: '6px', flexWrap: 'wrap' as const, flex: 1 },
  chip: { display: 'inline-flex', alignItems: 'center', gap: '6px', fontSize: '11.5px', color: '#DCE9F6', background: 'rgba(78,168,255,0.10)', border: '1px solid rgba(78,168,255,0.30)', borderRadius: '20px', padding: '4px 6px 4px 11px', whiteSpace: 'nowrap' as const },
  chipX: { background: 'none', border: 'none', color: '#7A9BB8', cursor: 'pointer', fontSize: '11px', lineHeight: 1, padding: '2px 4px', fontFamily: "'Inter', system-ui, sans-serif" },
  clearAll: { fontFamily: 'system-ui,sans-serif', fontSize: '11.5px', cursor: 'pointer', color: '#FF5B5A', border: '1px solid rgba(255,91,90,0.3)', background: 'rgba(255,91,90,0.08)', borderRadius: '20px', padding: '4px 11px', whiteSpace: 'nowrap' as const },
  errorBar: { border: '1px solid rgba(255,91,90,0.3)', background: 'rgba(255,91,90,0.08)', color: '#FF5B5A', borderRadius: '8px', padding: '9px 14px', fontSize: '12px', marginBottom: '10px' },
  searchInput: { fontFamily: 'system-ui,sans-serif', fontSize: '13px', border: '1px solid rgba(255,255,255,0.075)', borderRadius: '8px', padding: '8px 12px', outline: 'none', background: '#0D1B2C', color: '#DCE9F6', flex: '1', minWidth: '200px' },
  filterSelect: { fontFamily: 'system-ui,sans-serif', fontSize: '13px', border: '1px solid rgba(255,255,255,0.075)', borderRadius: '8px', padding: '8px 12px', outline: 'none', background: '#0D1B2C', color: '#DCE9F6', cursor: 'pointer' },
  totalBadge: { fontSize: '13px', color: '#7A9BB8', background: '#0D1B2C', border: '1px solid rgba(255,255,255,0.075)', borderRadius: '8px', padding: '8px 12px', marginLeft: 'auto', whiteSpace: 'nowrap' as const },
  tableWrap: { background: '#0D1B2C', border: '1px solid rgba(255,255,255,0.075)', borderRadius: '10px', overflow: 'visible' },
  table: { width: '100%', borderCollapse: 'collapse' as const, fontSize: '13px' },
  thead: { background: '#111F30' },
  th: { padding: '10px 12px', textAlign: 'left' as const, fontSize: '10px', fontWeight: '500', color: 'rgba(255,255,255,0.30)', textTransform: 'uppercase' as const, letterSpacing: '0.08em', borderBottom: '1px solid rgba(255,255,255,0.075)', whiteSpace: 'nowrap' as const },
  tr: { borderBottom: '0.5px solid rgba(255,255,255,0.05)' },
  td: { padding: '10px 12px', verticalAlign: 'middle' as const, color: '#DCE9F6' },
  emptyState: { padding: '3rem', textAlign: 'center' as const },
  dateCell: { fontSize: '12px', color: '#7A9BB8', whiteSpace: 'nowrap' as const },
  partnerCell: { fontSize: '13px', fontWeight: '500', color: '#DCE9F6' },
  docsBtn: { marginLeft: '6px', background: 'none', border: 'none', cursor: 'pointer', fontSize: '13px', padding: 0 },
  invNumCell: { fontSize: '11px', color: '#7A9BB8', fontFamily: 'monospace', background: 'rgba(255,255,255,0.05)', padding: '2px 6px', borderRadius: '4px' },
  catCell: { fontSize: '11px', color: '#7A9BB8' },
  descCell: { fontSize: '11px', color: '#7A9BB8', maxWidth: '140px', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' as const, display: 'block' },
  compCell: { fontSize: '11px', color: '#7A9BB8' },
  amtCell: { fontSize: '13px', fontWeight: '500', color: '#DCE9F6', whiteSpace: 'nowrap' as const },
  bookCell: { fontSize: '13px', fontWeight: '500', color: '#00D47E', whiteSpace: 'nowrap' as const },
  badge: { fontSize: '10px', fontWeight: '500', padding: '2px 8px', borderRadius: '20px', textTransform: 'capitalize' as const, whiteSpace: 'nowrap' as const },
  editBtn: { background: 'none', border: '1px solid rgba(255,255,255,0.10)', borderRadius: '6px', padding: '4px 8px', cursor: 'pointer', color: '#7A9BB8', fontSize: '14px' },
  contextMenu: { position: 'absolute' as const, right: 0, top: '100%', marginTop: '4px', background: '#0D1B2C', border: '1px solid rgba(255,255,255,0.10)', borderRadius: '8px', zIndex: 9999, minWidth: '140px', boxShadow: '0 4px 20px rgba(0,0,0,0.4)' },
  contextItem: { padding: '8px 14px', fontSize: '13px', color: '#DCE9F6', cursor: 'pointer', borderBottom: '0.5px solid rgba(255,255,255,0.05)' },
  pagination: { display: 'flex', alignItems: 'center', justifyContent: 'center', gap: '16px', padding: '14px 16px', borderTop: '1px solid rgba(255,255,255,0.07)', background: '#0A1525' },
  pageBtn: { fontFamily: 'system-ui,sans-serif', fontSize: '13px', padding: '7px 16px', border: '1px solid rgba(255,255,255,0.10)', borderRadius: '8px', background: 'transparent', color: '#DCE9F6', cursor: 'pointer' },
  pageBtnDisabled: { opacity: 0.35, cursor: 'not-allowed' },
  pageInfo: { fontSize: '12px', color: '#7A9BB8', minWidth: '110px', textAlign: 'center' as const },
}

// The searchable pickers wear exactly the chrome of the native selects beside
// them — derived from `s.filterSelect` rather than copied, so the bar cannot
// end up with two heights or two borders after someone edits one of them.
//
// The one change is the border: `SearchableSelect` repaints only its colour
// when the list opens, and React warns about mixing the `border` shorthand
// with a longhand on the same element. Dropping the shorthand here is what
// `ignoreRestSiblings` in the lint config is for.
// eslint-disable-next-line @typescript-eslint/no-unused-vars
const { border: _filterBorder, ...filterChrome } = s.filterSelect
const filterSearchStyle: React.CSSProperties = {
  ...filterChrome,
  borderWidth: '1px', borderStyle: 'solid', borderColor: 'rgba(255,255,255,0.075)',
}
