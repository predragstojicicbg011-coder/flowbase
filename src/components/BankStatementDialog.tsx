import React, { useState, useEffect, useCallback, useMemo } from 'react'
import { supabase } from '../supabase'
import { useCompanies } from '../contexts/CompaniesContext'
import InlineCategoryAdd from './InlineCategoryAdd'

import { importRowHash } from '../utils/importHash'
import { fetchAllPages } from '../utils/fetchAllPages'
import { softDeleteRow } from '../services/writeOrder'
import CreditInstallmentSelector from './CreditInstallmentSelector'
import { DIALOG, chrome } from './dialogTheme'
import SearchableSelect from './SearchableSelect'
import { REVENUE_STREAMS } from '../services/revenueStreams'
import {
  claimNotice, freeForRow, isHiddenForRow, type ClaimRow, type OpenInvoice,
} from '../services/invoiceClaims'
import { differenceFor, entryNote, isBookable } from '../services/currencyDifference'
import {
  ADVANCE_BADGE_STYLE, ADVANCE_LABEL, doubleCountHint, effectiveAdvance, receiptShape, whyAdvanceNotSavable,
} from '../services/advanceReceipt'
import {
  describeMismatches, mismatches, type Expectation, type Settlement,
} from '../services/settlementCheck'
import { formatMoney, toOwn, toRsd } from '../services/allocationDisplay'
import { invoiceRates, linkAmountsFromOwn } from '../services/invoiceLinks'
import { outstandingOwn, settlementFor } from '../services/settleInvoice'
import {
  fetchScripts, saveScript, removeScript, orderedForDifference, findCurrencyDifference,
} from '../services/quickFillStore'
import { CREDIT_PRINCIPAL, CREDIT_INTEREST, creditNote, allocatePayment } from '../services/creditClassification'
import { creditLegBooker, checkCreditCurrency } from '../services/creditPayment'
import {
  txToSeed, passthroughToSeed, allowedTypes, statementSpan, statementLabel,
  invoiceStatus, rowAmount, type RowSeed, type RowSource,
} from '../services/statementEdit'
import { fetchAllPartners } from '../services/allPartners'
import SplitEditor from './SplitEditor'
import ProjectSelect from './ProjectSelect'
import { projectIdFromInput, projectIdToInput } from '../services/projects'
import {
  whySplitNotSavable, classificationFromSplit, splitProjectChange, type SplitLine,
} from '../services/expenseSplit'
import { saveSplits } from '../services/saveSplits'
import {
  DOCUMENT_CURRENCIES, bookAmounts, getBookRates, partBookAmounts, partFromRsd,
  type BookAmounts, type BookRates,
} from '../services/bookAmounts'
import { fmtMoney, fmtNum } from '../utils/formatters'
// credit payment P&L logic is inline

/** How many posted statements the history list shows before "Load more". */
const HISTORY_PAGE = 8

interface Props {
  onClose: () => void
  onImported: () => void
}

interface StatementRow {
  id: string
  // Set only when the row is a stored row being edited. Its absence is what
  // makes a row an insert rather than an update.
  tx_id?: string
  source?: RowSource
  /** Credit payments are shown while editing but never changed here. */
  locked?: boolean
  date: string
  partner_name: string
  partner_id: string | null
  description: string
  debit: string
  credit: string
  currency: string
  reference_number: string
  model: string
  account_number: string
  // Classification
  tx_type: 'direct' | 'invoice_payment' | 'passthrough' | 'credit_payment'
  tx_subtype: 'expense' | 'revenue'
  pt_direction: 'in' | 'out'
  pt_period: string
  linked_invoice_id: string
  /**
   * The costs this one line is made of, where it is more than one.
   *
   * On the ROW rather than in a map beside it, for the same reason every
   * other classification field is: a statement is edited row by row, rows are
   * added and removed, and a second structure keyed by row id is a second
   * thing to keep in step. Empty means a single expense.
   */
  pl_splits: SplitLine[]
  /**
   * A posted row, reopened for editing, that already has split lines stored.
   * This dialog does not load or rewrite them, so the row must not gain a
   * project of its own on top: its projects are on those lines, and a second
   * one would count the cost twice.
   */
  stored_split: boolean
  /** Book the leftover against this invoice as a currency difference. */
  fx_book: boolean
  /** Which quick-fill template classifies it. Empty means the default one. */
  fx_script_id: string
  pl_category_id: string
  pl_category_name: string
  pl_subcategory_id: string
  pl_subcategory_name: string
  department_id: string
  department_name: string
  dept_subcategory_id: string
  dept_subcategory_name: string
  expense_description: string
  revenue_stream: string
  /** The row's project: an id, or '' for company overhead. '' while split. */
  project_id: string
  cf_type: string
  cf_frequency: string
  cf_next_month_est: string
  note: string
  selected_credit_id: string
  selected_installment_ids: string[]
  /** An advance received (avans): kept only while the row is a direct revenue receipt. */
  is_advance: boolean
}


let rowCounter = 0
/** Today, in the form every row's date input uses. */
const todayISO = new Date().toISOString().split('T')[0]

function makeRow(defaultCurrency = 'RSD', date = ''): StatementRow {
  rowCounter++
  return {
    id: `row_${rowCounter}`,
    date: date || todayISO,
    partner_name: '', partner_id: null, description: '',
    debit: '', credit: '',
    currency: defaultCurrency,
    reference_number: '', model: '', account_number: '',
    tx_type: 'direct', tx_subtype: 'expense',
    pt_direction: 'out', pt_period: new Date().toISOString().slice(0, 7),
    linked_invoice_id: '', fx_book: false, fx_script_id: '',
    pl_splits: [], stored_split: false,
    pl_category_id: '', pl_category_name: '',
    pl_subcategory_id: '', pl_subcategory_name: '',
    department_id: '', department_name: '',
    dept_subcategory_id: '', dept_subcategory_name: '',
    expense_description: '', revenue_stream: '',
    project_id: '',
    cf_type: '', cf_frequency: 'monthly', cf_next_month_est: '',
    note: '',
    selected_credit_id: '',
    selected_installment_ids: [],
    is_advance: false,
  }
}

export default function BankStatementDialog({ onClose, onImported }: Props) {
  const { companies, defaultCompany, showPicker } = useCompanies()
  const [company, setCompany] = useState('')

  // One company: it is the company, and nobody is asked to choose it.
  useEffect(() => {
    if (!showPicker && defaultCompany) setCompany(prev => prev || defaultCompany.id)
  }, [showPicker, defaultCompany])
  const [bank, setBank] = useState('')
  const [statementNumber, setStatementNumber] = useState('')
  /**
   * The date on the statement, carried to every row that still follows it.
   *
   * Changing it does NOT overwrite a row somebody has dated by hand. Only the
   * rows still showing the previous header date move — a statement usually
   * shares one date and occasionally does not, and a header that flattens a
   * deliberate edit teaches people not to use it.
   */
  const [statementDate, setStatementDate] = useState('')
  const [defaultCurrency, setDefaultCurrency] = useState('RSD')
  const [banks, setBanks] = useState<any[]>([])
  const [allBanks, setAllBanks] = useState<any[]>([])
  const [openInvoices, setOpenInvoices] = useState<any[]>([])
  const [partners, setPartners] = useState<any[]>([])
  const [allPartnerAccounts, setAllPartnerAccounts] = useState<any[]>([])
  const [partnerSearch, setPartnerSearch] = useState<Record<string, string>>({})
  const [plCategories, setPlCategories] = useState<any[]>([])
  const [plSubcategories, setPlSubcategories] = useState<any[]>([])
  const [departments, setDepartments] = useState<any[]>([])
  const [deptSubcategories, setDeptSubcategories] = useState<any[]>([])
  const [expenseDescriptions, setExpenseDescriptions] = useState<any[]>([])
  const [rows, setRows] = useState<StatementRow[]>([makeRow(), makeRow(), makeRow()])
  const [expandedRow, setExpandedRow] = useState<string | null>(null)
  const [posting, setPosting] = useState(false)
  const [credits, setCredits] = useState<any[]>([])
  const [rowInstallments, setRowInstallments] = useState<Record<string, any[]>>({})

  // ── Quick Fill Scripts ────────────────────────────────────────────────────
  interface QuickFillScript {
    id: string; name: string; icon: string
    pl_category: string; pl_subcategory: string
    department: string; dept_subcategory: string
    expense_description: string; cf_type: string
  }

  const [qfSearch, setQfSearch] = useState<Record<string, string>>({})
  const [qfOpen, setQfOpen] = useState<string | null>(null)

  // The templates are shared now — see 20260922140000 — so a change here is a
  // change for everyone, and the table is the thing that decides whether it
  // was allowed. `runWrite` inside `saveScript` is what turns a refusal into a
  // sentence instead of a list that quietly does not change.
  const refreshQfScripts = useCallback(async () => {
    setQuickFillScriptsState(await fetchScripts(supabase) as QuickFillScript[])
  }, [])

  const persistQfScript = async (draft: QuickFillScript) => {
    const { ok, message } = await saveScript(supabase, draft as any)
    if (!ok) { window.alert(message); return false }
    await refreshQfScripts()
    return true
  }

  const removeQfScript = async (id: string) => {
    const { ok, message } = await removeScript(supabase, id)
    if (!ok) { window.alert(message); return }
    await refreshQfScripts()
  }
  const [quickFillScriptsState, setQuickFillScriptsState] = useState<QuickFillScript[]>([])
  const quickFillScripts = quickFillScriptsState
  useEffect(() => { refreshQfScripts() }, [refreshQfScripts])
  const [qfDialogOpen, setQfDialogOpen] = useState(false)
  const [qfEditing, setQfEditing] = useState<QuickFillScript | null>(null)
  const EMPTY_SCRIPT: QuickFillScript = { id: '', name: '', icon: '⚡', pl_category: '', pl_subcategory: '', department: '', dept_subcategory: '', expense_description: '', cf_type: 'recurring' }

  // ── Posted statements ─────────────────────────────────────────────────────
  const [importHistory, setImportHistory] = useState<any[]>([])
  /** Bumped to make the history effect run again after a statement is deleted. */
  const [historyRefresh, setHistoryRefresh] = useState(0)
  const [historyExpanded, setHistoryExpanded] = useState(false)
  const [historyLimit, setHistoryLimit] = useState(HISTORY_PAGE)
  const [historyTotal, setHistoryTotal] = useState(0)
  const [historyLoading, setHistoryLoading] = useState(false)
  // Bumped after a save, so the list redraws without reopening the dialog.
  const [historyVersion, setHistoryVersion] = useState(0)

  // Statements posted before their rows were tracked as a batch. They cannot
  // be filtered or reopened, so they are kept out of the main list and shown
  // on request rather than hidden.
  const [unlinkedCount, setUnlinkedCount] = useState(0)
  const [unlinkedLogs, setUnlinkedLogs] = useState<any[]>([])
  const [showUnlinked, setShowUnlinked] = useState(false)
  const [unlinkedLimit, setUnlinkedLimit] = useState(HISTORY_PAGE)

  // ── Editing a posted statement ────────────────────────────────────────────
  interface EditTarget {
    logId: string
    batchId: string
    label: string
    lockedCount: number
    /**
     * The months the editable rows sat in when the statement was opened.
     *
     * Needed because the period-lock trigger checks the date a row is moving
     * FROM as well as the one it is moving to, and once the grid has been
     * edited the old date is gone. Locked rows are excluded — they are never
     * written, so a closed month of theirs must not block the rest.
     */
    originalMonths: string[]
  }
  const [editing, setEditing] = useState<EditTarget | null>(null)
  const [editDescription, setEditDescription] = useState('')
  const [loadingStatement, setLoadingStatement] = useState(false)
  /** The statement being deleted, once its consequences have been counted. */
  const [deleting, setDeleting] = useState<string | null>(null)
  const [notice, setNotice] = useState('')
  // Rows dropped while editing. They are soft-deleted on save, not before, so
  // closing the dialog without saving changes nothing.
  const [removedRows, setRemovedRows] = useState<{ id: string; source: RowSource }[]>([])

  const applyQuickFillRow = (rowId: string, scriptId: string) => {
    const script = quickFillScripts.find(sc => sc.id === scriptId)
    if (!script) return
    const matchCat = plCategories.find(c => c.name === script.pl_category)
    const matchDept = departments.find(d => d.name === script.department)
    const matchSub = plSubcategories.find(s => s.name === script.pl_subcategory && s.category_id === matchCat?.id)
    const matchDeptSub = deptSubcategories.find(s => s.name === script.dept_subcategory && s.department_id === matchDept?.id)
    updateRow(rowId, {
      pl_category_id: matchCat?.id || '',
      pl_category_name: matchCat?.name || script.pl_category,
      pl_subcategory_id: matchSub?.id || '',
      pl_subcategory_name: matchSub?.name || script.pl_subcategory,
      department_id: matchDept?.id || '',
      department_name: matchDept?.name || script.department,
      dept_subcategory_id: matchDeptSub?.id || '',
      dept_subcategory_name: matchDeptSub?.name || script.dept_subcategory,
      expense_description: script.expense_description || '',
      cf_type: script.cf_type || '',
    })
  }
  const [posted, setPosted] = useState(false)
  const [error, setError] = useState('')
  const [invoiceSearch, setInvoiceSearch] = useState<Record<string, string>>({})
  /**
   * Per row: whether the picker still lists invoices another line has taken.
   *
   * OUT OF THE LIST, not greyed in it — the same change as the bulk import,
   * for the same reason. Greying one of two identical invoices is a
   * distinction nobody makes at a glance, and the list is longest precisely
   * when the invoices repeat: six identical open bills and six identical
   * payments, which is the case where closing one twice leaves another
   * outstanding and still reconciles to the penny.
   *
   * A toggle and not a hard filter: what is hidden is said, and reachable,
   * because the claim on the other line may itself be the mistake.
   */
  const [showTaken, setShowTaken] = useState<Record<string, boolean>>({})

  useEffect(() => {
    const load = async () => {
      const [
        { data: bnk }, part,
        { data: plCat }, { data: plSub },
        { data: dept }, { data: deptSub }, { data: expDesc },
        { data: pacc },
      ] = await Promise.all([
        supabase.from('banks').select('*').order('name'),
        fetchAllPartners(supabase),
        supabase.from('pl_categories').select('id,name,sort_order').order('sort_order'),
        supabase.from('pl_subcategories').select('id,name,category_id,sort_order').order('sort_order'),
        supabase.from('departments').select('id,name,sort_order').order('sort_order'),
        supabase.from('dept_subcategories').select('id,name,department_id,sort_order').order('sort_order'),
        supabase.from('expense_descriptions').select('id,name,dept_subcategory_id,sort_order').order('sort_order'),
        supabase.from('partner_accounts').select('id,partner_id,account_number,bank_name,currency,is_primary').order('is_primary', { ascending: false }),
      ])
      if (bnk) setAllBanks(bnk)
      if (part) setPartners(part)
      if (plCat) setPlCategories(plCat)
      if (plSub) setPlSubcategories(plSub)
      if (dept) setDepartments(dept)
      if (deptSub) setDeptSubcategories(deptSub)
      if (expDesc) setExpenseDescriptions(expDesc)
      if (pacc) setAllPartnerAccounts(pacc)
      const { data: creds } = await supabase
        .from('credits').select('id,name,bank,rate_description,currency')
        .eq('status', 'active').order('name')
      // A credit's figures are in its own currency; a missing one reads as
      // RSD, as in useCreditPayment.
      if (creds) setCredits(creds.map((c: any) => ({ ...c, currency: c.currency || 'RSD' })))
    }
    load()
  }, [])

  useEffect(() => {
    if (company) setBanks(allBanks.filter(b => b.company_id === company))
    else setBanks([])
  }, [company, allBanks])

  // Changing the account or the currency starts the list again from the top;
  // otherwise "Load more" would carry a page count over to a different list.
  useEffect(() => { setHistoryLimit(HISTORY_PAGE) }, [company, bank, defaultCurrency])

  useEffect(() => {
    if (!company || !bank) { setImportHistory([]); setHistoryTotal(0); return }
    let cancelled = false

    const fetchHistory = async () => {
      setHistoryLoading(true)
      const base = () => supabase
        .from('import_logs')
        .select('*', { count: 'exact' })
        .eq('company_id', company)
        .eq('bank_id', bank)
        .eq('import_type', 'manual_statement')

      // The main list is statements whose rows can still be found: they have a
      // batch id, so they carry a currency and can be reopened. Statements
      // without one are counted separately and shown on request — mixing them
      // in would leave the currency filter looking broken, because there is
      // nothing to filter them by.
      //
      // `default_currency.is.null` stays in the OR for the rare linked
      // statement whose rows are all gone, so it is not hidden outright.
      let res = await base()
        .not('filing_ref', 'is', null)
        .or(`default_currency.eq.${defaultCurrency},default_currency.is.null`)
        .order('created_at', { ascending: false })
        .range(0, historyLimit - 1)

      // Until the migration adding the column has been pushed, that filter is
      // a 42703. Fall back to the unfiltered list rather than showing nothing.
      if (res.error) {
        res = await base().order('created_at', { ascending: false }).range(0, historyLimit - 1)
      }
      if (cancelled) return

      setImportHistory(res.data || [])
      setHistoryTotal(res.count ?? (res.data || []).length)
      if ((res.data || []).length > 0) setHistoryExpanded(true)

      const { count: unlinked } = await supabase
        .from('import_logs')
        .select('id', { count: 'exact', head: true })
        .eq('company_id', company)
        .eq('bank_id', bank)
        .eq('import_type', 'manual_statement')
        .is('filing_ref', null)
      if (cancelled) return
      setUnlinkedCount(unlinked || 0)
      setHistoryLoading(false)
    }

    fetchHistory()
    return () => { cancelled = true }
  }, [company, bank, defaultCurrency, historyLimit, historyVersion, historyRefresh])

  // Fetched only once the group is opened — most of the time nobody looks.
  useEffect(() => {
    if (!company || !bank || !showUnlinked) return
    let cancelled = false
    supabase.from('import_logs').select('*')
      .eq('company_id', company)
      .eq('bank_id', bank)
      .eq('import_type', 'manual_statement')
      .is('filing_ref', null)
      .order('created_at', { ascending: false })
      .range(0, unlinkedLimit - 1)
      .then(({ data }) => { if (!cancelled) setUnlinkedLogs(data || []) })
    return () => { cancelled = true }
  }, [company, bank, showUnlinked, unlinkedLimit, historyVersion])

  useEffect(() => { setShowUnlinked(false); setUnlinkedLimit(HISTORY_PAGE) }, [company, bank])

  useEffect(() => {
    if (!company) return
    supabase.from('v_invoice_status').select('*').eq('company_id', company)
      .in('calculated_status', ['unpaid', 'partial']).order('due_date', { ascending: true })
      .then(({ data }) => { if (data) setOpenInvoices(data) })
  }, [company])

  const getPlSubs = (catId: string) => plSubcategories.filter(s => s.category_id === catId)
  const getDeptSubs = (dId: string) => deptSubcategories.filter(s => s.department_id === dId)
  const getExpDescs = (subId: string) => expenseDescriptions.filter(e => e.dept_subcategory_id === subId)
  const normalizeAccountNumber = (acc: string): string => {
    if (!acc) return ''
    const a = acc.trim().replace(/\s/g, '')
    const parts = a.split('-')
    if (parts.length === 3) {
      const bank = parts[0].replace(/^0+/, '') || '0'
      const core = parts[1].replace(/^0+/, '') || '0'
      const ctrl = parts[2].replace(/^0+/, '') || '0'
      return `${bank}|${core}|${ctrl}`
    } else if (parts.length === 2) {
      const bank = parts[0].replace(/^0+/, '') || '0'
      const full = parts[1]
      if (full.length >= 3) {
        const core = full.slice(0, -2).replace(/^0+/, '') || '0'
        const ctrl = full.slice(-2).replace(/^0+/, '') || '0'
        return `${bank}|${core}|${ctrl}`
      }
      return `${bank}|${full.replace(/^0+/, '') || '0'}`
    }
    return a.replace(/\D/g, '').replace(/^0+/, '') || '0'
  }

  const getPartnerAccounts = (partnerId: string | null) => {
    if (!partnerId) return []
    return allPartnerAccounts.filter(pa => pa.partner_id === partnerId)
  }

  const loadRowInstallments = async (rowId: string, creditId: string) => {
    if (!creditId) return
    const { data } = await supabase
      .from('credit_installments')
      .select('id,installment_no,due_date,principal_amount,interest_amount,total_amount,status')
      .eq('credit_id', creditId).eq('status', 'outstanding').order('due_date')
    if (data) setRowInstallments(prev => ({ ...prev, [rowId]: data }))
  }

  const applyStatementDate = (next: string) => {
    const previous = statementDate
    setStatementDate(next)
    if (!next) return
    setRows(prev => prev.map(r =>
      // Untouched means: still showing whatever the header said last, or the
      // default it was created with.
      (!previous || r.date === previous || r.date === todayISO) && !r.locked
        ? { ...r, date: next }
        : r))
  }

  /**
   * Delete a statement and everything it created.
   *
   * The counting happens first and out loud. This removes transactions, the
   * invoice allocations they carried, and the credit instalments they closed
   * — which means invoices that read `paid` go back to owing money. Nobody
   * should discover that afterwards, so the confirmation names the figures
   * before anything is touched.
   *
   * The deletion itself is one call: `delete_statement_cascade` does it in a
   * single database transaction, so a closed period refuses the whole batch
   * rather than leaving half a statement behind.
   */
  const deleteStatement = async (log: any) => {
    const batchId: string = log.filing_ref
    if (!batchId || deleting) return
    setError(''); setNotice('')
    setDeleting(batchId)
    try {
      const [{ count: txCount }, { count: ptCount }, { data: links }] = await Promise.all([
        supabase.from('transactions').select('id', { count: 'exact', head: true })
          .eq('import_batch_id', batchId).is('deleted_at', null),
        supabase.from('passthrough').select('id', { count: 'exact', head: true })
          .eq('import_batch_id', batchId).is('deleted_at', null),
        supabase.from('invoice_transaction_links')
          .select('invoice_id, transactions!inner(import_batch_id)')
          .eq('transactions.import_batch_id', batchId),
      ])

      const invoiceIds = Array.from(new Set((links || []).map((l: any) => l.invoice_id)))
      const { data: affected } = invoiceIds.length > 0
        ? await supabase.from('v_invoice_status')
            .select('invoice_number, calculated_status').in('id', invoiceIds)
        : { data: [] as any[] }
      const closing = (affected || []).filter((i: any) => i.calculated_status === 'paid')

      const lines = [
        `Delete "${log.file_name || 'this statement'}" and everything it posted?`,
        '',
        `· ${txCount ?? 0} transaction${txCount === 1 ? '' : 's'}`,
      ]
      if ((ptCount ?? 0) > 0) lines.push(`· ${ptCount} pass-through row${ptCount === 1 ? '' : 's'}`)
      if (invoiceIds.length > 0) {
        lines.push(`· ${invoiceIds.length} invoice allocation${invoiceIds.length === 1 ? '' : 's'}`)
        if (closing.length > 0) {
          lines.push('')
          lines.push(`${closing.length} invoice${closing.length === 1 ? '' : 's'} currently read as paid and will owe money again:`)
          lines.push(closing.slice(0, 8).map((i: any) => i.invoice_number || '(no number)').join(', ')
            + (closing.length > 8 ? `, and ${closing.length - 8} more` : ''))
        }
      }
      lines.push('')
      lines.push('This cannot be undone from here.')

      if (!window.confirm(lines.join('\n'))) { setDeleting(null); return }

      const { data, error: rpcErr } = await supabase.rpc('delete_statement_cascade', {
        p_batch_id: batchId,
        p_deleted_by: null,
      })
      if (rpcErr) throw rpcErr

      const r = (data || {}) as any
      setNotice(
        `Deleted ${r.transactions_deleted ?? 0} transaction(s)`
        + ((r.passthroughs_deleted ?? 0) > 0 ? `, ${r.passthroughs_deleted} pass-through(s)` : '')
        + `, removed ${r.allocations_removed ?? 0} allocation(s)`
        + ((r.installments_reopened ?? 0) > 0 ? `, reopened ${r.installments_reopened} credit instalment(s)` : '')
        + ((r.invoices_restated ?? 0) > 0 ? `, and ${r.invoices_restated} invoice(s) no longer read as they did` : '')
        + '.')
      setHistoryRefresh(n => n + 1)
      onImported()
    } catch (err: any) {
      setError(`The statement was not deleted: ${err.message}`)
    }
    setDeleting(null)
  }

  const addRow = () => setRows(prev => [...prev, makeRow(defaultCurrency, statementDate)])

  const removeRow = (id: string) => {
    const row = rows.find(r => r.id === id)
    if (row?.locked) return
    // Remember it so the save can soft-delete it. Dropping it from the grid
    // alone would leave the stored row behind.
    if (row?.tx_id) {
      const txId = row.tx_id
      const src = row.source || 'transactions'
      setRemovedRows(prev => [...prev, { id: txId, source: src }])
    }
    setRows(prev => prev.filter(r => r.id !== id))
  }

  const updateRow = (id: string, updates: Partial<StatementRow>) => {
    setRows(prev => prev.map(r => (r.id === id ? (r.locked ? r : { ...r, ...updates }) : r)))
  }

  /**
   * A reopened row stores its classification as names; the dropdowns bind to
   * ids. Anything the lookup tables no longer hold keeps its name and shows up
   * as unselected rather than being silently blanked.
   */
  const resolveLookupIds = (seed: RowSeed) => {
    const cat = plCategories.find(c => c.name === seed.pl_category_name)
    const sub = plSubcategories.find(s => s.name === seed.pl_subcategory_name && s.category_id === cat?.id)
    const dept = departments.find(d => d.name === seed.department_name)
    const dsub = deptSubcategories.find(s => s.name === seed.dept_subcategory_name && s.department_id === dept?.id)
    return {
      pl_category_id: cat?.id || '',
      pl_subcategory_id: sub?.id || '',
      department_id: dept?.id || '',
      dept_subcategory_id: dsub?.id || '',
    }
  }

  const exitEdit = () => {
    setEditing(null)
    setEditDescription('')
    setRemovedRows([])
    setExpandedRow(null)
    setRows([makeRow(defaultCurrency), makeRow(defaultCurrency), makeRow(defaultCurrency)])
    setStatementNumber('')
    setError('')
  }

  /** Reopen a posted statement: load its rows back into the grid. */
  const startEdit = async (log: any) => {
    const batchId: string | null = log.filing_ref || null
    if (!batchId) {
      setError('This entry was posted before statements were tracked as a batch, so its rows cannot be traced back. Edit those transactions individually instead.')
      return
    }
    setLoadingStatement(true); setError(''); setNotice('')
    try {
      // Deleted rows are hidden by a restrictive policy, so these come back
      // already filtered. Paged, and ordered by id last so the sort is unique:
      // a statement long enough to cross the row cap would otherwise repeat
      // rows and drop others. See fetchAllPages.
      const [txRows, ptRows] = await Promise.all([
        fetchAllPages<any>((from, to) => supabase.from('transactions').select('*')
          .eq('import_batch_id', batchId)
          .order('transaction_date').order('created_at').order('id').range(from, to)),
        fetchAllPages<any>((from, to) => supabase.from('passthrough').select('*')
          .eq('import_batch_id', batchId)
          .order('transaction_date').order('created_at').order('id').range(from, to)),
      ])
      if (txRows.length === 0 && ptRows.length === 0) {
        setError('This statement has no rows left — they were deleted or moved elsewhere.')
        setLoadingStatement(false)
        return
      }

      // Which invoice each payment row closed. Without this the link is
      // invisible in the grid and would be dropped on the next save.
      const linkByTx: Record<string, string> = {}
      const splitTx = new Set<string>()
      const txIds = txRows.map(t => t.id)
      if (txIds.length > 0) {
        const { data: links } = await supabase
          .from('invoice_transaction_links')
          .select('invoice_id,transaction_id')
          .in('transaction_id', txIds)
        for (const l of links || []) linkByTx[l.transaction_id] = l.invoice_id

        const { data: splitRows, error: splitErr } = await supabase
          .from('pl_splits').select('source_id')
          .eq('source', 'transaction').in('source_id', txIds)
        if (splitErr) throw splitErr
        for (const sp of splitRows || []) splitTx.add(sp.source_id)

        // An invoice these rows already settled is no longer open, so the
        // picker would not list it. Add it back or the selection reads blank.
        const invIds = Array.from(new Set(Object.values(linkByTx)))
        if (invIds.length > 0) {
          const { data: linked } = await supabase.from('v_invoice_status').select('*').in('id', invIds)
          if (linked && linked.length > 0) {
            setOpenInvoices(prev => {
              const seen = new Set(prev.map(i => i.id))
              return [...prev, ...linked.filter(i => !seen.has(i.id))]
            })
          }
        }
      }

      const nameOf = (pid: string | null) => partners.find(p => p.id === pid)?.name || ''
      const seeds: RowSeed[] = [
        ...txRows.map(t => ({
          ...txToSeed(t, nameOf(t.partner_id)),
          linked_invoice_id: linkByTx[t.id] || '',
          stored_split: splitTx.has(t.id),
        })),
        ...ptRows.map(p => passthroughToSeed(p, nameOf(p.partner_id))),
      ]

      const loaded = seeds.map(seed => ({
        ...makeRow(seed.currency),
        ...seed,
        ...resolveLookupIds(seed),
        id: `row_${++rowCounter}`,
      }))

      setRows(loaded)
      setRemovedRows([])
      setExpandedRow(null)
      setStatementNumber(String(log.file_name || '').replace(/^Statement #/, '').replace(/^Izvod #/, '').trim())
      setEditDescription(log.note || '')
      if (log.default_currency) setDefaultCurrency(log.default_currency)
      setEditing({
        logId: log.id,
        batchId,
        label: log.file_name || 'Manual entry',
        lockedCount: loaded.filter(r => r.locked).length,
        originalMonths: Array.from(new Set(
          loaded.filter(r => !r.locked && r.date).map(r => r.date.slice(0, 7))
        )),
      })
      setPartnerSearch({})
    } catch (err: any) {
      setError(`Could not open this statement: ${err.message}`)
    }
    setLoadingStatement(false)
  }

  const validRows = rows.filter(r => r.date && (parseFloat(r.debit) > 0 || parseFloat(r.credit) > 0))
  const editableRows = rows.filter(r => !r.locked)
  const totalDebit = rows.reduce((s, r) => s + (parseFloat(r.debit) || 0), 0)
  const totalCredit = rows.reduce((s, r) => s + (parseFloat(r.credit) || 0), 0)

  // ── What this statement has already spoken for ──────────────────────────
  //
  // Nothing is written until the statement is posted, so until then every row
  // is offered the same open invoices. With three identical invoices open —
  // the same rent, three months — it was easy to tick the same one on two
  // rows and leave the third untouched, and nothing said so.
  //
  // The arithmetic runs in the INVOICE's own currency. A row's payment is the
  // figure typed into it, in the row's currency, and the rate that would
  // convert it is only fetched at post time. Where the two currencies differ
  // the amount is unknown here, and the row is taken to settle the invoice in
  // full — which is what a cross-currency payment against one invoice is.
  const claimRows = useMemo<ClaimRow[]>(() => rows
    .filter(r => r.tx_type === 'invoice_payment' && r.linked_invoice_id && !r.locked)
    .map(r => {
      const inv = openInvoices.find(i => i.id === r.linked_invoice_id)
      const typed = parseFloat(r.debit) || parseFloat(r.credit) || 0
      return {
        id: r.id,
        amount: inv && inv.currency === r.currency && typed > 0 ? typed : Number.POSITIVE_INFINITY,
        invoiceIds: [r.linked_invoice_id],
      }
    }), [rows, openInvoices])

  /** A row id means nothing to a person; its position in the statement does. */
  const claimRowLabel = useCallback((rowId: string) => {
    const idx = rows.findIndex(r => r.id === rowId)
    return idx >= 0 ? `line ${idx + 1}` : 'another line'
  }, [rows])

  /**
   * One invoice's remainder, in its own currency, and what the statement has
   * left of it. Read from what the bill holds (`amount - paid_amount`), the
   * same figure the settled/partial rule is decided on.
   */
  const invoiceClaim = useCallback((inv: any, rowId: string) => {
    const remaining = outstandingOwn(inv)
    const free = freeForRow({ id: inv.id, remaining } as OpenInvoice, claimRows, rowId)
    const format = (n: number) => formatMoney(n, inv.currency || 'RSD')
    return { free, notice: claimNotice(free, claimRowLabel, format) }
  }, [claimRows, claimRowLabel])

  /**
   * The leftover on a row that closes one invoice, and what to do with it.
   *
   * An invoice in (or indexed to) a foreign currency is settled at a rate it
   * was not raised at, so in dinars it never lands exactly. Everything is
   * worked out in RSD, the book currency the row and the invoice are both
   * expressed in. See services/currencyDifference.ts.
   *
   * A PREVIEW. The row's own NBS rate is fetched at post time, so here the
   * row is valued at the INVOICE's stored rate for the row's currency (RSD is
   * 1; the invoice's own currency is its exchange_rate; EUR is its eur_rate).
   * The posting recomputes the difference at the row's actual rate. A USD row
   * against a non-USD invoice has no stored rate to preview with.
   */
  const fxFor = useCallback((row: StatementRow) => {
    const inv = openInvoices.find(i => i.id === row.linked_invoice_id)
    if (!inv || row.tx_type !== 'invoice_payment') return null
    const own = parseFloat(row.debit) || parseFloat(row.credit) || 0
    if (own <= 0) return null
    const rowCur = row.currency || defaultCurrency
    const rates = invoiceRates(inv)
    if (!rates) return null
    const rowRate = rowCur === 'RSD' ? 1
      : rowCur === (inv.currency || 'RSD') ? rates.exchangeRate
      : rowCur === 'EUR' ? rates.eurRate
      : null
    if (rowRate === null) return null
    const rowParent = { currency: rowCur, exchange_rate: rowRate, eur_rate: rates.eurRate }
    let rowRsd: number
    try { rowRsd = partBookAmounts(own, rowParent).amount_rsd } catch { return null }
    const outstandingRsd = toRsd(outstandingOwn(inv), inv)
    const allocRsd = Math.min(rowRsd, outstandingRsd)
    const difference = differenceFor({
      invoiceShortfall: outstandingRsd - allocRsd,
      paymentUnallocated: rowRsd - allocRsd,
      currency: 'RSD',
      invoiceType: inv.type ?? null,
    })
    let lossOwn = 0
    try { lossOwn = partFromRsd(difference.amount, rowParent).amount } catch { lossOwn = 0 }
    return {
      inv,
      difference,
      // The linked side is the rest of the invoice and belongs in its
      // currency; a surplus is part of this bank line and belongs in the
      // currency the bank moved.
      amountOwn: difference.linksToInvoice ? toOwn(difference.amount, inv) : lossOwn,
      currency: difference.linksToInvoice ? (inv.currency || rowCur) : rowCur,
    }
  }, [openInvoices, defaultCurrency])

  const fxScripts = useMemo(() => orderedForDifference(quickFillScripts), [quickFillScripts])

  const getRowSummary = (row: StatementRow) => {
    if (row.tx_type === 'credit_payment') return `🏦 Credit payment${row.selected_credit_id ? ' · ' + (credits.find(c => c.id === row.selected_credit_id)?.name || '') : ''}`
    if (row.tx_type === 'passthrough') return `🔄 Pass-through ${row.pt_direction === 'in' ? 'IN' : 'OUT'}`
    if (row.tx_type === 'invoice_payment') {
      const inv = openInvoices.find(i => i.id === row.linked_invoice_id)
      return `💳 Invoice payment${inv ? ` · ${inv.partner_name}` : ''}`
    }
    if (row.tx_subtype === 'revenue' && effectiveAdvance(row.tx_type, row.tx_subtype, row.is_advance)) return `📥 ${ADVANCE_LABEL}`
    if (row.tx_subtype === 'revenue') return `📥 Revenue${row.revenue_stream ? ` · ${row.revenue_stream}` : ''}`
    const parts = [row.pl_category_name, row.department_name].filter(Boolean)
    return `📤 Expense${parts.length ? ` · ${parts.join(' / ')}` : ' · unclassified'}`
  }

  /**
   * A row's four stored columns at the NBS rates for its date, memoised per
   * date for the run.
   *
   * Throws RateUnavailableError when NBS has nothing for a date. Refusing to
   * post beats posting a figure that is wrong, which is what a hardcoded
   * fallback rate once did here, leaving no trace.
   */
  const makeBooker = () => {
    const rateCache: Record<string, Promise<BookRates>> = {}
    return async (amount: number, cur: string, date: string): Promise<BookAmounts> => {
      if (!rateCache[date]) rateCache[date] = getBookRates(date)
      let rates: BookRates
      try {
        rates = await rateCache[date]
      } catch (err) {
        delete rateCache[date]
        throw err
      }
      return bookAmounts(amount, cur, rates)
    }
  }

  /** The partner a row names, looked up or created. */
  const resolvePartnerId = async (row: StatementRow): Promise<string | null> => {
    if (row.partner_id) return row.partner_id
    const name = row.partner_name.trim()
    if (!name) return null
    const { data: existing } = await supabase.from('partners').select('id').ilike('name', name).single()
    if (existing) return existing.id
    const { data: created } = await supabase.from('partners').insert({ name }).select().single()
    return created?.id ?? null
  }

  /** Set an invoice's status from everything currently allocated against it. */
  const refreshInvoiceStatus = async (invoiceId: string) => {
    const { data: inv } = await supabase.from('invoices').select('amount, amount_rsd, advance_deducted').eq('id', invoiceId).single()
    if (!inv) return
    const { data: allocations } = await supabase.from('invoice_transaction_links')
      .select('allocated_amount').eq('invoice_id', invoiceId)
    const total = (allocations || []).reduce((s: number, r: any) => s + (r.allocated_amount || 0), 0)
    await supabase.from('invoices').update({
      status: invoiceStatus(total, inv.amount || 0, inv.amount_rsd, inv.advance_deducted),
    }).eq('id', invoiceId)
  }

  /**
   * What the row is, in the columns that decide it: an advance is a direct
   * revenue receipt with no P&L; an invoice payment carries its invoice's
   * side, so the cash line reads a receipt as an inflow. See
   * services/advanceReceipt.ts.
   */
  const shapeOf = (row: StatementRow) => receiptShape({
    type: row.tx_type,
    subtype: row.tx_subtype,
    isAdvance: row.is_advance,
    bankSide: parseFloat(row.debit) > 0 ? 'expense' : 'revenue',
    invoiceType: openInvoices.find(i => i.id === row.linked_invoice_id)?.type ?? null,
  })

  /** The first advance among `list` that cannot be saved, said with its line. */
  const advanceProblem = (list: StatementRow[]): string | null => {
    for (const row of list) {
      const why = whyAdvanceNotSavable({
        type: row.tx_type, subtype: row.tx_subtype, isAdvance: row.is_advance,
        projectId: projectIdFromInput(row.project_id),
        splitLines: row.pl_splits.length + (row.stored_split ? 1 : 0),
      })
      if (why) return `Line ${row.date} ${row.description || ''}: ${why}`
    }
    return null
  }

  const handlePost = async () => {
    if (!company || !bank) { setError('Please select company and bank.'); return }
    {
      const why = advanceProblem(validRows)
      if (why) { setError(`${why} Nothing was saved.`); return }
    }
    if (validRows.length === 0) { setError('Add at least one row with a date and amount.'); return }
    setPosting(true); setError('')
    // Every write below can succeed while the result is still not what the
    // rows promised. Collected as they go, checked once at the end.
    const settlementExpectations: Expectation[] = []

    const bookRow = makeBooker()

    // Pre-flight: check every rate BEFORE the first write, so a statement
    // cannot end up half in the database and half not.
    try {
      for (const row of validRows) {
        const { amount } = rowAmount(row)
        await bookRow(amount, row.currency || defaultCurrency, row.date)
        if (row.tx_type === 'credit_payment' && row.selected_installment_ids.length > 0) {
          const credit = credits.find((c: any) => c.id === row.selected_credit_id)
          checkCreditCurrency(credit?.currency, credit?.name)
        }
      }
    } catch (err: any) {
      setError(`${err.message}. Nothing was saved.`)
      setPosting(false)
      return
    }

    // Idempotency: every source row gets a fingerprint. Re-importing the same
    // statement produces the same fingerprints and the database rejects it
    // (unique index) instead of creating duplicates. See
    // 20260826100000_import_idempotency.sql.
    const importBatchId = crypto.randomUUID()
    let skippedDuplicates = 0

    try {
      for (let rowIndex = 0; rowIndex < validRows.length; rowIndex++) {
        const row = validRows[rowIndex]
        const importHash = await importRowHash([
          company, bank, statementNumber, rowIndex,
          row.date, row.debit, row.credit, row.currency || defaultCurrency,
          row.description, row.reference_number, row.account_number,
        ])
        const isExpense = parseFloat(row.debit) > 0
        const amount = isExpense ? parseFloat(row.debit) : parseFloat(row.credit)
        const cur = row.currency || defaultCurrency
        const rowBook = await bookRow(amount, cur, row.date)

        const partnerId: string | null = await resolvePartnerId(row)

        if (row.tx_type === 'passthrough') {
          const { error: ptErr } = await supabase.from('passthrough').insert({
            import_hash: importHash, import_batch_id: importBatchId,
            company_id: company, bank_id: bank, partner_id: partnerId,
            transaction_date: row.date, direction: row.pt_direction,
            period_month: row.pt_period || null,
            currency: cur, amount, ...rowBook,
            note: row.note || row.description || null,
            account_number: row.account_number || null,
            model: row.model || null, reference_number: row.reference_number || null,
            status: 'unpaired',
          })
          if (ptErr) {
            if (ptErr.code === '23505') { skippedDuplicates++; continue }
            throw ptErr
          }
          continue
        }

        const isDirectWithPL = row.tx_type === 'direct'
        // Only a direct row has a P&L of its own to put on a project, and a
        // split row's projects are on its lines.
        const rowProjectId = isDirectWithPL && row.pl_splits.length === 0 && !row.stored_split
          ? projectIdFromInput(row.project_id) : null

        // Refused before the row is written rather than after. A statement
        // posts many rows in a loop, and a split that cannot be stored would
        // otherwise leave this line booked as one expense while every line
        // before it went in correctly — a mess to find and worse to undo.
        const whyThisSplit = isDirectWithPL
          ? whySplitNotSavable({ amount, currency: cur, ...rowBook }, row.pl_splits)
          : null
        if (whyThisSplit) {
          throw new Error(`Line ${row.date} ${row.description || ''}: ${whyThisSplit}`)
        }

        const { data: newTx, error: txErr } = await supabase.from('transactions').insert({
          import_hash: importHash, import_batch_id: importBatchId,
          company_id: company, bank_id: bank, partner_id: partnerId,
          transaction_date: row.date, statement_number: statementNumber || null,
          type: row.tx_type, tx_subtype: shapeOf(row).tx_subtype, is_advance: shapeOf(row).is_advance,
          currency: cur, amount, ...rowBook,
          pl_impact: shapeOf(row).pl_impact,
          pl_category: isDirectWithPL ? (row.pl_category_name || null) : null,
          pl_subcategory: isDirectWithPL ? (row.pl_subcategory_name || null) : null,
          department: isDirectWithPL ? (row.department_name || null) : null,
          dept_subcategory: isDirectWithPL ? (row.dept_subcategory_name || null) : null,
          expense_description: isDirectWithPL ? (row.expense_description || null) : null,
          revenue_stream: isDirectWithPL ? (row.revenue_stream || null) : null,
          project_id: rowProjectId,
          cf_type: isDirectWithPL && row.tx_subtype === 'expense' ? (row.cf_type || null) : null,
          cf_frequency: row.cf_type === 'recurring' ? row.cf_frequency : null,
          cf_next_month_est: row.cf_type === 'recurring' ? (row.cf_next_month_est ? parseFloat(row.cf_next_month_est) : (parseFloat(row.debit) || null)) : null,
          account_number: row.account_number || null,
          model: row.model || null, reference_number: row.reference_number || null,
          note: row.note || row.description || null, status: 'posted',
        }).select().single()

        if (txErr) {
          // 23505 = unique violation on import_hash -> already imported before
          if (txErr.code === '23505') { skippedDuplicates++; continue }
          throw txErr
        }

        // ── The split, once the row has an id to belong to ──────────────
        //
        // Thrown rather than reported: a statement posts in a loop, and a
        // line whose split failed is a line booked as one expense among
        // dozens booked correctly. Stopping names it; carrying on hides it.
        if (isDirectWithPL && row.pl_splits.length > 0 && newTx?.id) {
          const outcome = await saveSplits(
            supabase, 'transaction', newTx.id,
            { amount, currency: cur, ...rowBook }, row.pl_splits)
          if (!outcome.ok) throw new Error(`Line ${row.date}: ${outcome.message}`)
        }

        if (row.tx_type === 'credit_payment' && row.selected_installment_ids.length > 0) {
          // Each leg is a row in the credit's own currency at this bank line's
          // rates, the last one taking the rounding, so the legs add up to the
          // line - services/creditPayment.ts.
          const credit = credits.find((c: any) => c.id === row.selected_credit_id)
          const creditName = credit?.name || 'Credit'
          const legs = creditLegBooker(credit?.currency, rowBook, creditName)

          // What this bank line actually paid, in the credit's currency. Until now this was
          // ignored and the installment's FULL principal and FULL interest were
          // booked for every line matched to it — so a statement that splits an
          // installment into a principal line and an interest line booked the
          // whole installment twice.
          // amount_rsd for an RSD credit, amount_eur for a EUR one (exactly
          // `amount` on a EUR line).
          let remaining = legs.payable

          for (const instId of row.selected_installment_ids) {
            if (remaining <= 0.005) break

            const { data: inst } = await supabase
              .from('credit_installments')
              .select('id, installment_no, principal_amount, interest_amount, paid_amount, status')
              .eq('id', instId).single()
            if (!inst) continue

            const already = inst.paid_amount || 0
            const duePrincipal = Math.max(0, (inst.principal_amount || 0) - already)
            const dueInterest = Math.max(0, (inst.interest_amount || 0) - Math.max(0, already - (inst.principal_amount || 0)))
            const split = allocatePayment(remaining, duePrincipal, dueInterest)
            const paidHere = split.principal + split.interest
            if (paidHere <= 0) continue
            remaining -= paidHere

            if (split.principal > 0) {
              await supabase.from('transactions').insert({
                company_id: company, bank_id: bank,
                partner_id: partnerId, transaction_date: row.date,
                statement_number: statementNumber || null,
                type: 'credit_payment', tx_subtype: 'expense',
                ...legs.book(split.principal),
                pl_impact: true, ...CREDIT_PRINCIPAL,
                cf_type: 'recurring', cf_frequency: 'monthly',
                note: creditNote('principal', creditName, inst.installment_no, split.principal, row.note || row.description, legs.currency),
                status: 'posted',
              })
            }
            if (split.interest > 0) {
              await supabase.from('transactions').insert({
                company_id: company, bank_id: bank,
                partner_id: partnerId, transaction_date: row.date,
                statement_number: statementNumber || null,
                type: 'credit_payment', tx_subtype: 'expense',
                ...legs.book(split.interest),
                pl_impact: true, ...CREDIT_INTEREST,
                cf_type: 'recurring', cf_frequency: 'monthly',
                note: creditNote('interest', creditName, inst.installment_no, split.interest, row.note || row.description, legs.currency),
                status: 'posted',
              })
            }

            // Track what has been paid rather than declaring the installment
            // settled: the second line of a split installment has to find the
            // remainder still outstanding, or it books the whole thing again.
            const totalPaid = Math.round((already + paidHere) * 100) / 100
            const settled = totalPaid >= ((inst.principal_amount || 0) + (inst.interest_amount || 0)) - 0.01
            await supabase.from('credit_installments').update({
              status: settled ? 'paid' : 'outstanding',
              paid_date: settled ? row.date : null,
              paid_amount: totalPaid,
              updated_at: new Date().toISOString(),
            }).eq('id', instId)
          }
          if (row.selected_credit_id) {
            const { data: rem } = await supabase.from('credit_installments').select('id')
              .eq('credit_id', row.selected_credit_id).eq('status', 'outstanding')
            if (rem && rem.length === 0)
              await supabase.from('credits')
                .update({ status: 'closed', updated_at: new Date().toISOString() })
                .eq('id', row.selected_credit_id)
          }
          continue
        }

        if (row.tx_type === 'invoice_payment' && row.linked_invoice_id && newTx?.id) {
          // Fetch invoice to determine correct rate
          const { data: inv } = await supabase.from('invoices')
            .select('id, invoice_number, type, amount, amount_rsd, amount_eur, currency, exchange_rate, eur_rate, is_indexed, project_id, advance_deducted')
            .eq('id', row.linked_invoice_id).single()

          if (inv) {
            // `allocated_amount` is in the INVOICE's currency, and
            // `allocated_amount_rsd` / `_eur` are that figure at the
            // INVOICE's stored rates (`linkAmountsFromOwn`).
            //
            // What was here before took a rate that depended on `is_indexed`:
            // the row's own rate for an indexed invoice, the invoice's for the
            // rest. For a EUR payment against a dinar invoice the first of
            // those produced EUR and wrote it into the dinar column — a link
            // recording 6,074 against a bill of 712,957, with the book side
            // perfectly correct. That is the fault behind every "remaining 0
            // and still partial" invoice we had been chasing.
            //
            // The comment on it said it was there to "avoid FX partial
            // closing", which it did by making the arithmetic agree with the
            // wrong thing. The gap it was hiding is real and is now booked as
            // a currency difference instead.

            // What the invoice still wants, so a row bigger than the bill does
            // not allocate more to it than it is worth. This used to assign the
            // whole row regardless — `allocOrig = amount` — which over-allocated
            // every payment that exceeded its invoice.
            const { data: invStatus } = await supabase.from('v_invoice_status')
              .select('paid_amount').eq('id', inv.id).maybeSingle()

            // WHERE THE ROW AND THE BILL SHARE A CURRENCY, NOTHING IS
            // CONVERTED. Comparing the row in the book currency at the ROW
            // date's rate against the invoice at the INVOICE date's would
            // leave a bill paid in full reading short, and offer the gap as a
            // currency difference. See services/settleInvoice.ts.
            const rowRsd = rowBook.amount_rsd
            const alreadyOwn = Math.max(0, invStatus?.paid_amount ?? 0)
            const settlement = settlementFor({
              invoice: { ...inv, paid_amount: alreadyOwn },
              paymentCurrency: row.currency || defaultCurrency,
              paymentOwn: amount,
              paymentRsd: rowRsd,
            })
            const allocOrig = settlement.own
            const allocRsd = settlement.rsd

            // What this invoice will hold once the writes below are done:
            // whatever already settled part of it, plus this row, plus a
            // currency gain if one is booked against it. Checked afterwards
            // against what the database actually says — see
            // services/settlementCheck.ts.
            let willHold = alreadyOwn + allocOrig

            await supabase.from('invoice_transaction_links').insert({
              invoice_id: row.linked_invoice_id, transaction_id: newTx.id,
              ...linkAmountsFromOwn(allocOrig, inv),
            })

            // ── The currency difference ──────────────────────────────────
            //
            // A gain is linked, because nothing else will close the rest of
            // the invoice. A loss is not: the invoice is already settled and
            // the surplus is part of this same bank line.
            // The shortfall in the bill's own currency, converted once to RSD
            // at the invoice's rate — not read off the book remainder, which
            // carries every earlier payment's rate.
            const shortfallOwn = settlement.leftOnInvoice
            const difference = differenceFor({
              invoiceShortfall: toRsd(shortfallOwn, inv),
              // The line at its own rate, less the allocation at the invoice's.
              paymentUnallocated: rowRsd - allocRsd,
              currency: 'RSD',
              // A receipt short of a revenue billing is a loss, not a gain.
              invoiceType: inv.type ?? null,
            })
            const fxScript = quickFillScripts.find(sc => sc.id === row.fx_script_id)
              || findCurrencyDifference(quickFillScripts)

            if (row.fx_book && isBookable(difference) && fxScript) {
              // The LINKED side - the rest of the invoice: a gain on a
              // supplier's bill, a loss on a revenue billing.
              const isGain = difference.linksToInvoice
              const rowParent = { currency: cur, exchange_rate: rowBook.exchange_rate, eur_rate: rowBook.eur_rate }
              const fxOwn = isGain
                // The gain IS the rest of the bill, to the para.
                ? shortfallOwn
                // A loss is part of this bank line, at the line's rate.
                : partFromRsd(difference.amount, rowParent).amount
              const fxCurrency = isGain ? (inv.currency || cur) : cur
              // A gain is a part of the invoice, booked at its stored rates;
              // a loss a part of the bank line, at the line's.
              const fxParent = isGain ? { ...inv, currency: fxCurrency } : rowParent
              const fxBook = partBookAmounts(fxOwn, fxParent)
              const fxRates = isGain
                ? { exchange_rate: inv.exchange_rate, eur_rate: inv.eur_rate }
                : { exchange_rate: rowBook.exchange_rate, eur_rate: rowBook.eur_rate }

              const { data: fxTx, error: fxErr } = await supabase.from('transactions').insert({
                company_id: company, bank_id: bank,
                partner_id: partnerId || null,
                transaction_date: row.date,
                statement_number: statementNumber || null,
                type: 'direct',
                tx_subtype: difference.direction === 'revenue' ? 'revenue' : 'expense',
                currency: fxCurrency,
                amount: fxOwn,
                ...fxRates,
                amount_rsd: fxBook.amount_rsd,
                amount_eur: fxBook.amount_eur,
                pl_impact: true,
                pl_category: fxScript.pl_category || null,
                pl_subcategory: fxScript.pl_subcategory || null,
                department: fxScript.department || null,
                dept_subcategory: fxScript.dept_subcategory || null,
                expense_description: fxScript.expense_description || null,
                // On the bill's project: the difference is part of what that
                // bill cost or earned.
                project_id: inv.project_id ?? null,
                // A gain never touched the bank — see services/cashBasis.ts.
                cf_type: isGain ? 'accrual' : (fxScript.cf_type || null),
                status: 'posted',
                note: entryNote(inv.invoice_number || null, difference),
              }).select('id').single()
              if (fxErr) throw new Error(`The currency difference could not be posted: ${fxErr.message}`)

              if (difference.linksToInvoice && fxTx?.id) {
                const { error: fxLinkErr } = await supabase.from('invoice_transaction_links').insert({
                  invoice_id: inv.id, transaction_id: fxTx.id,
                  ...linkAmountsFromOwn(shortfallOwn, inv),
                })
                if (fxLinkErr) throw new Error(`The currency difference was posted but could not be linked to the invoice: ${fxLinkErr.message}`)
                willHold += shortfallOwn
              }
            }

            settlementExpectations.push({
              invoiceId: inv.id,
              invoiceNumber: inv.invoice_number || null,
              amount: inv.amount || 0,
              allocated: willHold,
              amountRsd: inv.amount_rsd ?? null,
              advanceDeducted: Number(inv.advance_deducted) || 0,
            })

            // Status follows what is allocated, in the invoice's own currency.
            await refreshInvoiceStatus(row.linked_invoice_id)
          }
        }
      }

      // Record the batch, so the statement can be found and reopened later.
      const span = statementSpan(validRows)
      await supabase.from('import_logs').insert({
        company_id: company,
        bank_id: bank,
        import_type: 'manual_statement',
        file_name: statementLabel(statementNumber),
        date_from: span.date_from,
        date_to: span.date_to,
        row_count: validRows.length - skippedDuplicates,
        default_currency: defaultCurrency,
        note: skippedDuplicates > 0
          ? `${validRows.length - skippedDuplicates} rows posted, ${skippedDuplicates} skipped as already imported`
          : `${validRows.length} rows posted manually`,
        filing_ref: importBatchId,
      })
      if (skippedDuplicates > 0) {
        setError(`Note: ${skippedDuplicates} of ${validRows.length} rows had already been imported and were skipped.`)
      }
      // Did the invoices end up where the rows said they would? Nothing here
      // can be undone by this point; this exists so nobody walks away from a
      // green tick that was not earned.
      if (settlementExpectations.length > 0) {
        const { data: after } = await supabase.from('v_invoice_status')
          .select('id, calculated_status')
          .in('id', settlementExpectations.map(e => e.invoiceId))
        const actual: Record<string, Settlement | undefined> = {}
        for (const r of after || []) actual[r.id] = r.calculated_status as Settlement
        const bad = describeMismatches(mismatches(settlementExpectations, actual))
        if (bad) {
          setError(bad)
          setPosting(false)
          return
        }
      }

      setPosted(true)
      setTimeout(() => { onImported(); onClose() }, 1500)
    } catch (err: any) {
      setError(`Error: ${err.message}`)
    }
    setPosting(false)
  }

  /**
   * Save changes to a statement that was already posted.
   *
   * Every row it holds is updated in place, so the corrections reach the
   * transactions this statement produced rather than creating a second set
   * beside them. Rows dropped from the grid are soft-deleted, rows typed into
   * it are inserted under the same batch id, and the log entry is rewritten to
   * match what the statement now holds.
   *
   * Credit-payment rows are skipped entirely — see `statementEdit.ts` for why.
   */
  const handleSaveEdit = async () => {
    if (!editing) return
    const editable = rows.filter(r => !r.locked)
    const incomplete = editable.filter(r => !(r.date && (parseFloat(r.debit) > 0 || parseFloat(r.credit) > 0)))
    if (incomplete.length > 0) {
      setError(`${incomplete.length} row${incomplete.length !== 1 ? 's are' : ' is'} missing a date or an amount. Fill them in or remove them.`)
      return
    }
    {
      const why = advanceProblem(editable)
      if (why) { setError(`${why} Nothing was changed.`); return }
    }
    // The type cards already refuse this, but the check is repeated here
    // because getting it wrong writes a row into the wrong table and leaves
    // the original behind.
    const misplaced = editable.filter(r => !allowedTypes(r).includes(r.tx_type))
    if (misplaced.length > 0) {
      setError('A posted row cannot be changed to that transaction type. Remove it and enter a new one instead.')
      return
    }

    setPosting(true); setError(''); setNotice('')

    const bookRow = makeBooker()
    try {
      for (const row of editable) await bookRow(rowAmount(row).amount, row.currency || defaultCurrency, row.date)
    } catch (err: any) {
      setError(`${err.message}. Nothing was changed.`)
      setPosting(false)
      return
    }

    // A save is many writes and not one transaction, so anything certain to be
    // refused is checked before the first one. A closed month is the likeliest:
    // the trigger would reject it partway through and leave half the statement
    // corrected. Both the months rows are moving TO and the months they are
    // moving FROM count, which is what the trigger itself checks.
    try {
      const months = new Set<string>(editing.originalMonths)
      for (const row of editable) if (row.date) months.add(row.date.slice(0, 7))
      const { data: flag } = await supabase.from('feature_flags').select('enabled').eq('name', 'period_lock').single()
      if (flag?.enabled !== false && months.size > 0) {
        const { data: closed } = await supabase.from('closed_periods')
          .select('period').eq('company_id', company)
          .in('period', Array.from(months).map(m => `${m}-01`))
        if (closed && closed.length > 0) {
          const list = closed.map((c: any) => String(c.period).slice(0, 7)).sort().join(', ')
          setError(`Period ${list} is locked for this company — nothing was changed. Unlock it in Settings and try again.`)
          setPosting(false)
          return
        }
      }
    } catch {
      // The pre-check is a courtesy. If it cannot run, the trigger still holds.
    }

    // Every invoice whose allocations this save disturbs, recomputed once at
    // the end. Doing it per row would leave an invoice wrong in between.
    const touchedInvoices = new Set<string>()

    try {
      // ── Rows dropped from the grid ────────────────────────────────────────
      for (const removed of removedRows) {
        if (removed.source === 'transactions') {
          const { data: links } = await supabase.from('invoice_transaction_links')
            .select('invoice_id').eq('transaction_id', removed.id)
          for (const l of links || []) touchedInvoices.add(l.invoice_id)
          await supabase.from('invoice_transaction_links').delete().eq('transaction_id', removed.id)
        }
        const del = await softDeleteRow(supabase, removed.source, removed.id)
        if (!del.ok) throw new Error(del.message)
      }

      // ── Rows the statement still holds ────────────────────────────────────
      for (const row of editable) {
        const { amount } = rowAmount(row)
        const cur = row.currency || defaultCurrency
        const rowBook = await bookRow(amount, cur, row.date)
        const partnerId = await resolvePartnerId(row)

        if (row.tx_type === 'passthrough') {
          const payload = {
            company_id: company, bank_id: bank, partner_id: partnerId,
            transaction_date: row.date, direction: row.pt_direction,
            period_month: row.pt_period || null,
            currency: cur, amount, ...rowBook,
            note: row.note || row.description || null,
            account_number: row.account_number || null,
            model: row.model || null, reference_number: row.reference_number || null,
          }
          if (row.tx_id) {
            const { error: ptErr } = await supabase.from('passthrough').update(payload).eq('id', row.tx_id)
            if (ptErr) throw ptErr
          } else {
            // No import_hash: a row typed into an existing statement has no
            // source file line to be idempotent against.
            const { error: ptErr } = await supabase.from('passthrough')
              .insert({ ...payload, import_batch_id: editing.batchId, status: 'unpaired' })
            if (ptErr) throw ptErr
          }
          continue
        }

        const isDirectWithPL = row.tx_type === 'direct'
        // Only a direct row has a P&L of its own to put on a project, and a
        // split row's projects are on its lines.
        const rowProjectId = isDirectWithPL && row.pl_splits.length === 0 && !row.stored_split
          ? projectIdFromInput(row.project_id) : null

        const payload = {
          company_id: company, bank_id: bank, partner_id: partnerId,
          transaction_date: row.date, statement_number: statementNumber || null,
          type: row.tx_type, tx_subtype: shapeOf(row).tx_subtype, is_advance: shapeOf(row).is_advance,
          currency: cur, amount, ...rowBook,
          pl_impact: shapeOf(row).pl_impact,
          pl_category: isDirectWithPL ? (row.pl_category_name || null) : null,
          pl_subcategory: isDirectWithPL ? (row.pl_subcategory_name || null) : null,
          department: isDirectWithPL ? (row.department_name || null) : null,
          dept_subcategory: isDirectWithPL ? (row.dept_subcategory_name || null) : null,
          expense_description: isDirectWithPL ? (row.expense_description || null) : null,
          revenue_stream: isDirectWithPL ? (row.revenue_stream || null) : null,
          project_id: rowProjectId,
          cf_type: isDirectWithPL && row.tx_subtype === 'expense' ? (row.cf_type || null) : null,
          cf_frequency: row.cf_type === 'recurring' ? row.cf_frequency : null,
          cf_next_month_est: row.cf_type === 'recurring'
            ? (row.cf_next_month_est ? parseFloat(row.cf_next_month_est) : (amount || null))
            : null,
          account_number: row.account_number || null,
          model: row.model || null, reference_number: row.reference_number || null,
          note: row.note || row.description || null, status: 'posted',
        }

        let txId = row.tx_id
        if (txId) {
          const { error: txErr } = await supabase.from('transactions').update(payload).eq('id', txId)
          if (txErr) throw txErr
        } else {
          const { data: created, error: txErr } = await supabase.from('transactions')
            .insert({ ...payload, import_batch_id: editing.batchId }).select().single()
          if (txErr) throw txErr
          txId = created?.id
        }
        if (!txId) continue

        // The link is rebuilt rather than patched: the row may have been
        // pointed at a different invoice, or stopped being a payment at all.
        const { data: oldLinks } = await supabase.from('invoice_transaction_links')
          .select('invoice_id').eq('transaction_id', txId)
        for (const l of oldLinks || []) touchedInvoices.add(l.invoice_id)
        await supabase.from('invoice_transaction_links').delete().eq('transaction_id', txId)

        if (row.tx_type === 'invoice_payment' && row.linked_invoice_id) {
          const { data: inv } = await supabase.from('invoices')
            .select('id, amount, amount_rsd, amount_eur, currency, exchange_rate, eur_rate, is_indexed, advance_deducted')
            .eq('id', row.linked_invoice_id).single()
          if (inv) {
            // The same unit fault as the posting path above: `allocated_amount`
            // is in the INVOICE's currency, and this once wrote the ROW's. A
            // EUR payment against a dinar invoice recorded 6,074 against a bill
            // of 712,957. `linkAmountsFromOwn` fills all three columns from one
            // invoice-currency figure at the invoice's rates.
            // Settled in the bill's own currency where the row is in it,
            // so re-saving a statement does not shave a dinar off what the
            // row already closed. See services/settleInvoice.ts.
            const edited = settlementFor({
              invoice: inv,
              paymentCurrency: row.currency || defaultCurrency,
              paymentOwn: amount,
              paymentRsd: rowBook.amount_rsd,
            })
            const { error: linkErr } = await supabase.from('invoice_transaction_links').insert({
              invoice_id: row.linked_invoice_id, transaction_id: txId,
              ...linkAmountsFromOwn(edited.own, inv),
            })
            if (linkErr) throw linkErr
            touchedInvoices.add(row.linked_invoice_id)
          }
        }
      }

      for (const invoiceId of Array.from(touchedInvoices)) await refreshInvoiceStatus(invoiceId)

      // ── The log entry, rewritten to match what the statement now holds ────
      const span = statementSpan(rows)
      const { error: logErr } = await supabase.from('import_logs').update({
        file_name: statementLabel(statementNumber),
        date_from: span.date_from,
        date_to: span.date_to,
        row_count: span.row_count,
        default_currency: defaultCurrency,
        note: editDescription.trim() || `${span.row_count} rows entered manually`,
      }).eq('id', editing.logId)
      if (logErr) throw logErr

      const changed = editable.length
      const dropped = removedRows.length
      setNotice(
        `Statement saved — ${changed} row${changed !== 1 ? 's' : ''} updated` +
        (dropped > 0 ? `, ${dropped} removed` : '') +
        (editing.lockedCount > 0 ? `, ${editing.lockedCount} credit row${editing.lockedCount !== 1 ? 's' : ''} left untouched` : '') + '.'
      )
      exitEdit()
      setHistoryVersion(v => v + 1)
      onImported()
    } catch (err: any) {
      setError(`Error: ${err.message}`)
    }
    setPosting(false)
  }

  if (posted) return (
    <div style={s.overlay}>
      <div style={{ ...s.dialog, alignItems: 'center', justifyContent: 'center', gap: '16px', minHeight: '220px' }}>
        <div style={{ width: '48px', height: '48px', borderRadius: '50%', background: DIALOG.accentFill, display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
          <svg width="24" height="24" viewBox="0 0 24 24" fill="none" stroke={DIALOG.accent} strokeWidth="2"><path d="M5 13l4 4L19 7" /></svg>
        </div>
        <div style={{ fontFamily: 'Georgia,serif', fontSize: '20px', color: DIALOG.text }}>Statement posted!</div>
        <div style={{ fontSize: '13px', color: DIALOG.dim }}>{validRows.length} transaction{validRows.length !== 1 ? 's' : ''} added.</div>
      </div>
    </div>
  )

  return (
    <div style={s.overlay}>
      <div style={s.dialog}>
        <div style={s.header}>
          <div>
            <div style={s.headerTitle}>Manual bank statement entry</div>
            <div style={s.headerSub}>Enter transactions row by row — click a row to classify it</div>
          </div>
          <div style={{ display: 'flex', alignItems: 'center', gap: '10px' }}>
            <div style={s.plBadge}>P&amp;L Impact</div>
            <span style={s.logoText}>MCFlow</span>
            <button style={s.closeBtn} onClick={onClose}>×</button>
          </div>
        </div>

        <div style={s.body}>
          {/* Statement details */}
          <div style={s.section}>
            <div style={s.sectionTitle}>Statement details</div>
            <div style={{ display: 'grid', gridTemplateColumns: showPicker ? '1fr 1fr 160px 120px' : '1fr 160px 120px', gap: '12px' }}>
              {showPicker && (
                <div style={s.field}>
                  <label style={s.lbl}>Company <span style={s.req}>*</span></label>
                  {/* Locked while editing: the account is what scopes the batch,
                      and moving a posted statement to another one is not an edit. */}
                  <select style={s.select} value={company} onChange={e => setCompany(e.target.value)} disabled={!!editing}>
                    <option value="">Select company...</option>
                    {companies.map(c => <option key={c.id} value={c.id}>{c.name}</option>)}
                  </select>
                </div>
              )}
              <div style={s.field}>
                <label style={s.lbl}>Bank account <span style={s.req}>*</span></label>
                <select style={s.select} value={bank} onChange={e => setBank(e.target.value)} disabled={!company || !!editing}>
                  <option value="">Select bank...</option>
                  {banks.map(b => <option key={b.id} value={b.id}>{b.name}</option>)}
                </select>
              </div>
              <div style={s.field}>
                <label style={s.lbl}>Statement #</label>
                <input style={s.input} value={statementNumber} onChange={e => setStatementNumber(e.target.value)} placeholder="e.g. 2026-05" />
              </div>
              <div style={s.field}>
                <label style={s.lbl}>Statement date</label>
                <input type="date" style={s.input} value={statementDate}
                  onChange={e => applyStatementDate(e.target.value)} />
                <span style={{ fontSize: '10px', color: DIALOG.dim, marginTop: '3px', lineHeight: 1.4 }}>
                  Carried to every row that still follows it. A row you date yourself keeps its own.
                </span>
              </div>
              <div style={s.field}>
                <label style={s.lbl}>Default currency</label>
                <select style={s.select} value={defaultCurrency} onChange={e => setDefaultCurrency(e.target.value)}>
                  {DOCUMENT_CURRENCIES.map(c => <option key={c}>{c}</option>)}
                </select>
              </div>
            </div>
          </div>

          {/* Posted statements for this account */}
          {company && bank && !editing && (
            <div style={{ ...s.section, marginTop: '-8px' }}>
              <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', cursor: 'pointer', paddingBottom: '6px', borderBottom: '0.5px solid ' + DIALOG.border, marginBottom: '10px' }}
                onClick={() => setHistoryExpanded(prev => !prev)}>
                <div style={{ fontSize: '10px', fontWeight: '600', color: DIALOG.dim, textTransform: 'uppercase' as const, letterSpacing: '0.08em' }}>
                  🕐 Posted statements — this account · {defaultCurrency}
                  {historyTotal > 0 && <span style={{ marginLeft: '8px', background: DIALOG.accentFill, color: DIALOG.accent, padding: '1px 7px', borderRadius: '20px', fontSize: '10px' }}>{historyTotal}</span>}
                </div>
                <span style={{ fontSize: '10px', color: DIALOG.dim }}>{historyExpanded ? '▲ Hide' : '▼ Show'}</span>
              </div>
              {historyExpanded && (
                importHistory.length === 0 ? (
                  <div style={{ fontSize: '12px', color: DIALOG.faint, padding: '10px 12px', background: DIALOG.raised, borderRadius: '8px', border: '0.5px solid ' + DIALOG.border }}>
                    {historyLoading ? 'Loading…' : `No statements posted in ${defaultCurrency} for this account yet.`}
                  </div>
                ) : (
                  <div style={{ display: 'flex', flexDirection: 'column' as const, gap: '5px' }}>
                    {importHistory.map(log => (
                      <div key={log.id} style={{ display: 'flex', alignItems: 'center', gap: '12px', padding: '8px 12px', background: DIALOG.raised, borderRadius: '8px', border: '0.5px solid ' + DIALOG.border }}>
                        <div style={{ flex: 1, minWidth: 0 }}>
                          <div style={{ fontSize: '12px', fontWeight: '500', color: DIALOG.text }}>
                            {log.file_name || 'Manual entry'}
                            {log.default_currency && (
                              <span style={{ marginLeft: '8px', fontSize: '10px', color: DIALOG.dim, fontWeight: '400' }}>{log.default_currency}</span>
                            )}
                          </div>
                          <div style={{ fontSize: '10px', color: DIALOG.dim, marginTop: '2px', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' as const }}>
                            {log.date_from && log.date_to ? `${log.date_from} → ${log.date_to}` : log.date_from || '—'}
                            {log.row_count ? ` · ${log.row_count} rows` : ''}
                            {log.note ? ` · ${log.note}` : ''}
                          </div>
                        </div>
                        <div style={{ fontSize: '11px', color: DIALOG.dim, whiteSpace: 'nowrap' as const }}>
                          {new Date(log.created_at).toLocaleDateString('en-GB')}
                        </div>
                        <div style={{ fontSize: '10px', padding: '2px 8px', borderRadius: '20px', background: DIALOG.accentFill, color: DIALOG.accent, whiteSpace: 'nowrap' as const }}>✓ Posted</div>
                        {/* Without a batch id nothing ties the statement's rows
                            together, so there is no statement to reopen. Say so
                            here rather than offering a button that cannot work. */}
                        {log.filing_ref ? (
                          <>
                            <button
                              style={{ fontFamily: 'system-ui,sans-serif', fontSize: '11px', padding: '4px 11px', border: '0.5px solid ' + DIALOG.border, borderRadius: '6px', background: 'transparent', color: DIALOG.dim, cursor: loadingStatement ? 'wait' : 'pointer', whiteSpace: 'nowrap' as const }}
                              disabled={loadingStatement}
                              onClick={() => startEdit(log)}>✎ Edit</button>
                            <button
                              style={{ fontFamily: 'system-ui,sans-serif', fontSize: '11px', padding: '4px 11px', border: '0.5px solid ' + DIALOG.red, borderRadius: '6px', background: 'transparent', color: DIALOG.red, cursor: deleting ? 'wait' : 'pointer', whiteSpace: 'nowrap' as const, opacity: deleting === log.filing_ref ? 0.6 : 1 }}
                              disabled={!!deleting}
                              title="Delete this statement and every transaction, allocation and instalment it created"
                              onClick={() => deleteStatement(log)}>
                              {deleting === log.filing_ref ? '…' : '🗑 Delete'}
                            </button>
                          </>
                        ) : (
                          <span style={{ fontSize: '10px', color: DIALOG.faint, padding: '4px 6px', whiteSpace: 'nowrap' as const }}
                            title="This statement was posted before its rows were tracked as a batch, so they cannot be traced back to it. Edit those transactions individually.">
                            not linked
                          </span>
                        )}
                      </div>
                    ))}

                    {/* Paged rather than capped: the whole history is reachable
                        without the list taking over the dialog. */}
                    {importHistory.length < historyTotal && (
                      <button
                        style={{ marginTop: '4px', fontFamily: 'system-ui,sans-serif', fontSize: '11px', padding: '7px', border: '0.5px solid ' + DIALOG.border, borderRadius: '8px', background: 'transparent', color: DIALOG.dim, cursor: historyLoading ? 'wait' : 'pointer', width: '100%' }}
                        disabled={historyLoading}
                        onClick={() => setHistoryLimit(n => n + HISTORY_PAGE)}>
                        {historyLoading ? 'Loading…' : `Load more — ${historyTotal - importHistory.length} older`}
                      </button>
                    )}
                    {importHistory.length >= historyTotal && historyTotal > HISTORY_PAGE && (
                      <div style={{ fontSize: '10px', color: DIALOG.faint, textAlign: 'center' as const, paddingTop: '4px' }}>
                        All {historyTotal} shown
                      </div>
                    )}
                  </div>
                )
              )}

              {/* Statements posted before their rows were tracked as a batch.
                  Nothing ties those rows to the entry, so they cannot be
                  filtered by currency or reopened — but they are still history
                  and should not simply disappear. */}
              {historyExpanded && unlinkedCount > 0 && (
                <div style={{ marginTop: '8px', paddingTop: '8px', borderTop: '0.5px solid ' + DIALOG.borderSoft }}>
                  <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: '10px', cursor: 'pointer' }}
                    onClick={() => setShowUnlinked(v => !v)}>
                    <span style={{ fontSize: '10px', color: DIALOG.faint }}>
                      {unlinkedCount} older statement{unlinkedCount !== 1 ? 's' : ''} not linked to their rows — no currency, cannot be reopened
                    </span>
                    <span style={{ fontSize: '10px', color: DIALOG.dim, whiteSpace: 'nowrap' as const }}>
                      {showUnlinked ? '▲ Hide' : '▼ Show'}
                    </span>
                  </div>

                  {showUnlinked && (
                    <div style={{ display: 'flex', flexDirection: 'column' as const, gap: '4px', marginTop: '8px' }}>
                      {unlinkedLogs.map(log => (
                        <div key={log.id} style={{ display: 'flex', alignItems: 'center', gap: '12px', padding: '7px 12px', background: DIALOG.panel, borderRadius: '8px', border: '0.5px solid ' + DIALOG.borderSoft, opacity: 0.75 }}>
                          <div style={{ flex: 1, minWidth: 0 }}>
                            <div style={{ fontSize: '12px', color: DIALOG.dim }}>{log.file_name || 'Manual entry'}</div>
                            <div style={{ fontSize: '10px', color: DIALOG.faint, marginTop: '2px', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' as const }}>
                              {log.date_from && log.date_to ? `${log.date_from} → ${log.date_to}` : log.date_from || '—'}
                              {log.row_count ? ` · ${log.row_count} rows` : ''}
                            </div>
                          </div>
                          <div style={{ fontSize: '11px', color: DIALOG.faint, whiteSpace: 'nowrap' as const }}>
                            {new Date(log.created_at).toLocaleDateString('en-GB')}
                          </div>
                          <span style={{ fontSize: '10px', color: DIALOG.faint, whiteSpace: 'nowrap' as const }}
                            title="Edit these transactions individually from the Transactions page.">
                            not linked
                          </span>
                        </div>
                      ))}
                      {unlinkedLogs.length < unlinkedCount && (
                        <button
                          style={{ marginTop: '2px', fontFamily: 'system-ui,sans-serif', fontSize: '11px', padding: '6px', border: '0.5px solid ' + DIALOG.borderSoft, borderRadius: '8px', background: 'transparent', color: DIALOG.faint, cursor: 'pointer', width: '100%' }}
                          onClick={() => setUnlinkedLimit(n => n + HISTORY_PAGE)}>
                          Load more — {unlinkedCount - unlinkedLogs.length} older
                        </button>
                      )}
                    </div>
                  )}
                </div>
              )}
            </div>
          )}

          {/* Editing a posted statement */}
          {editing && (
            <div style={{ ...s.section, marginTop: '-8px' }}>
              <div style={{ background: DIALOG.blueFill, border: '0.5px solid rgba(78,168,255,0.3)', borderRadius: '10px', padding: '12px 14px' }}>
                <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: '12px', marginBottom: '10px' }}>
                  <div style={{ minWidth: 0 }}>
                    <div style={{ fontSize: '13px', fontWeight: '600', color: DIALOG.blue }}>✎ Editing {editing.label}</div>
                    <div style={{ fontSize: '11px', color: DIALOG.dim, marginTop: '3px' }}>
                      Changes are written to the transactions this statement already posted.
                      {editing.lockedCount > 0 && ` ${editing.lockedCount} credit row${editing.lockedCount !== 1 ? 's are' : ' is'} locked — settle those from the credit screen.`}
                    </div>
                  </div>
                  <button style={{ ...s.btnGhost, fontSize: '12px', padding: '6px 14px', whiteSpace: 'nowrap' as const }} onClick={exitEdit}>
                    ✕ Cancel edit
                  </button>
                </div>
                <div style={s.field}>
                  <label style={s.lbl}>Statement description</label>
                  <input style={{ ...s.input, width: '100%', boxSizing: 'border-box' as const }}
                    value={editDescription}
                    onChange={e => setEditDescription(e.target.value)}
                    placeholder="What this statement covers" />
                </div>
              </div>
            </div>
          )}

          {/* Rows */}
          <div style={s.section}>
            <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: '10px' }}>
              <div style={s.sectionTitle}>
                {editing ? 'Statement rows — click a row to reclassify it' : 'Transactions — click row to classify'}
              </div>
              <div style={{ display: 'flex', gap: '8px', alignItems: 'center' }}>
                <span style={{ fontSize: '11px', color: DIALOG.dim }}>{validRows.length} valid</span>
                <button style={s.addRowBtn} onClick={addRow}>+ Add row</button>
              </div>
            </div>

            <div style={{ display: 'flex', flexDirection: 'column' as const, gap: '6px' }}>
              {rows.map((row) => {
                const isExpanded = expandedRow === row.id
                const hasAmount = parseFloat(row.debit) > 0 || parseFloat(row.credit) > 0
                const isValid = row.date && hasAmount
                const plSubs = getPlSubs(row.pl_category_id)
                const deptSubs = getDeptSubs(row.department_id)
                const expDescs = getExpDescs(row.dept_subcategory_id)
                const linkedInvoice = openInvoices.find(i => i.id === row.linked_invoice_id)
                const rowPartnerAccounts = getPartnerAccounts(row.partner_id)

                // A credit payment is shown so the statement reads complete,
                // but it settles installments and writes principal and interest
                // rows of its own that carry no batch id. Editing the row we
                // can see would leave the rows we cannot see saying otherwise.
                if (row.locked) {
                  const { amount } = rowAmount(row)
                  return (
                    <div key={row.id} style={{
                      border: '1px solid ' + DIALOG.border, borderRadius: '10px',
                      background: DIALOG.panel, padding: '10px 12px',
                      display: 'flex', alignItems: 'center', gap: '12px',
                    }}>
                      <span style={{ fontSize: '13px' }}>🏦</span>
                      <div style={{ minWidth: 0, flex: 1 }}>
                        <div style={{ fontSize: '12px', color: DIALOG.text, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' as const }}>
                          {row.description || 'Credit payment'}
                        </div>
                        <div style={{ fontSize: '10px', color: DIALOG.dim, marginTop: '2px' }}>
                          {row.date} · {fmtMoney(amount, row.currency || defaultCurrency)}
                        </div>
                      </div>
                      <div style={{ fontSize: '10px', padding: '2px 9px', borderRadius: '20px', background: DIALOG.blueFill, color: DIALOG.blue, whiteSpace: 'nowrap' as const }}
                        title="Credit payments settle installments and post their own principal and interest rows. Change them from the credit screen.">
                        🔒 Credit — not editable here
                      </div>
                    </div>
                  )
                }

                return (
                  <div key={row.id} style={{
                    border: isExpanded ? '1.5px solid ' + DIALOG.accent : isValid ? '1px solid ' + DIALOG.accentSoft : '1px solid ' + DIALOG.border,
                    borderRadius: '10px',
                    // NOTE: no overflow:hidden here so dropdowns can overlay other rows
                    background: DIALOG.raised,
                  }}>
                    {/* Row header — always visible */}
                    <div style={{ display: 'grid', gridTemplateColumns: '130px 1fr 1fr 100px 100px 70px auto 32px', gap: '6px', alignItems: 'center', padding: '8px 10px', cursor: 'pointer' }}
                      onClick={() => setExpandedRow(isExpanded ? null : row.id)}>
                      <input type="date" style={s.cellInput} value={row.date}
                        onChange={e => { e.stopPropagation(); updateRow(row.id, { date: e.target.value }) }}
                        onClick={e => e.stopPropagation()} />

                      {/* Partner search with dropdown */}
                      <div style={{ position: 'relative' as const }} onClick={e => e.stopPropagation()}>
                        <input style={s.cellInput} value={partnerSearch[row.id] ?? row.partner_name}
                          onChange={e => {
                            setPartnerSearch(prev => ({ ...prev, [row.id]: e.target.value }))
                            updateRow(row.id, { partner_name: e.target.value, partner_id: null })
                          }}
                          placeholder="Partner name" />
                        {(partnerSearch[row.id] ?? '').length > 0 && !row.partner_id && (
                          <div style={{ position: 'absolute' as const, top: '100%', left: 0, right: 0, background: DIALOG.panel, border: '1px solid ' + DIALOG.border, borderRadius: '6px', zIndex: 200, boxShadow: '0 8px 24px rgba(0,0,0,0.15)', maxHeight: '200px', overflowY: 'auto' as const }}>
                            {partners.filter(p => p.name.toLowerCase().includes((partnerSearch[row.id] ?? '').toLowerCase())).slice(0, 8).map(p => (
                              <div key={p.id} style={{ padding: '7px 10px', fontSize: '12px', cursor: 'pointer', borderBottom: '0.5px solid ' + DIALOG.borderSoft, display: 'flex', flexDirection: 'column' as const }}
                                onMouseDown={e => {
                                  e.preventDefault()
                                  updateRow(row.id, { partner_name: p.name, partner_id: p.id })
                                  setPartnerSearch(prev => ({ ...prev, [row.id]: p.name }))
                                }}>
                                <span style={{ fontWeight: '500', color: DIALOG.text }}>{p.name}</span>
                                {allPartnerAccounts.filter(pa => pa.partner_id === p.id).length > 0 && (
                                  <span style={{ fontSize: '10px', color: '#7A9BB8' }}>
                                    {allPartnerAccounts.filter(pa => pa.partner_id === p.id).length} account(s)
                                  </span>
                                )}
                              </div>
                            ))}
                            {partners.filter(p => p.name.toLowerCase().includes((partnerSearch[row.id] ?? '').toLowerCase())).length === 0 && (
                              <div style={{ padding: '7px 10px', fontSize: '12px', color: DIALOG.faint }}>New partner: "{partnerSearch[row.id]}"</div>
                            )}
                          </div>
                        )}
                      </div>

                      <input style={s.cellInput} value={row.description}
                        onChange={e => { e.stopPropagation(); updateRow(row.id, { description: e.target.value }) }}
                        onClick={e => e.stopPropagation()} placeholder="Description" />
                      <input type="number" style={{ ...s.cellInput, color: parseFloat(row.debit) > 0 ? DIALOG.red : DIALOG.text }}
                        value={row.debit} placeholder="Debit (out)"
                        onChange={e => { e.stopPropagation(); updateRow(row.id, { debit: e.target.value, credit: e.target.value ? '' : row.credit }) }}
                        onClick={e => e.stopPropagation()} />
                      <input type="number" style={{ ...s.cellInput, color: parseFloat(row.credit) > 0 ? DIALOG.accent : DIALOG.text }}
                        value={row.credit} placeholder="Credit (in)"
                        onChange={e => { e.stopPropagation(); updateRow(row.id, { credit: e.target.value, debit: e.target.value ? '' : row.debit }) }}
                        onClick={e => e.stopPropagation()} />
                      <select style={s.cellInput} value={row.currency}
                        onChange={e => { e.stopPropagation(); updateRow(row.id, { currency: e.target.value }) }}
                        onClick={e => e.stopPropagation()}>
                        {DOCUMENT_CURRENCIES.map(c => <option key={c}>{c}</option>)}
                      </select>
                      <div style={{ fontSize: '10px', color: DIALOG.dim, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' as const }}>
                        {hasAmount && effectiveAdvance(row.tx_type, row.tx_subtype, row.is_advance) && (
                          <span style={{ ...ADVANCE_BADGE_STYLE, marginRight: '4px' }}>{ADVANCE_LABEL}</span>
                        )}
                        {hasAmount ? getRowSummary(row) : <span style={{ color: DIALOG.faint }}>click to classify</span>}
                      </div>
                      <button style={{ background: 'none', border: 'none', color: DIALOG.faint, fontSize: '15px', cursor: 'pointer', padding: '2px' }}
                        onClick={e => { e.stopPropagation(); removeRow(row.id) }}>×</button>
                    </div>

                    {/* Expanded classification panel */}
                    {isExpanded && (
                      <div style={{ padding: '14px 16px', borderTop: '0.5px solid ' + DIALOG.border, background: DIALOG.panel, borderRadius: '0 0 9px 9px' }}>

                        {/* Transaction type */}
                        <div style={s.classTitle}>Transaction type</div>
                        <div style={{ display: 'grid', gridTemplateColumns: 'repeat(4, 1fr)', gap: '8px', marginBottom: '14px' }}>
                          {[
                            { id: 'direct', icon: '⚡', label: 'Direct transaction', sub: 'Impacts P&L directly', activeColor: DIALOG.accent, activeBg: DIALOG.accentFill },
                            { id: 'invoice_payment', icon: '💳', label: 'Invoice payment', sub: 'Closes open invoices', activeColor: DIALOG.blue, activeBg: DIALOG.blueFill },
                            { id: 'passthrough', icon: '🔄', label: 'Pass-through', sub: 'Money in transit', activeColor: DIALOG.amber, activeBg: DIALOG.amberFill },
                            { id: 'credit_payment', icon: '🏦', label: 'Credit payment', sub: 'Close installments', activeColor: DIALOG.blue, activeBg: DIALOG.blueFill },
                          ].map(t => {
                            // While editing, a saved row cannot change what
                            // table it lives in, and a credit payment cannot
                            // change at all. See allowedTypes for why.
                            const selectable = !editing || allowedTypes(row).includes(t.id as any)
                            const active = row.tx_type === t.id
                            return (
                              <div key={t.id} style={{
                                border: active ? `1.5px solid ${t.activeColor}` : '0.5px solid ' + DIALOG.border,
                                background: active ? t.activeBg : DIALOG.raised,
                                borderRadius: '8px', padding: '9px 11px',
                                cursor: selectable ? 'pointer' : 'not-allowed',
                                opacity: selectable ? 1 : 0.4,
                              }}
                                title={selectable ? undefined : 'A posted row cannot be changed to this type'}
                                onClick={() => { if (selectable) updateRow(row.id, { tx_type: t.id as any }) }}>
                                <div style={{ display: 'flex', alignItems: 'center', gap: '7px' }}>
                                  <span style={{ fontSize: '13px' }}>{t.icon}</span>
                                  <span style={{ fontSize: '12px', fontWeight: '600', color: active ? t.activeColor : DIALOG.text }}>{t.label}</span>
                                </div>
                                <div style={{ fontSize: '10px', color: DIALOG.dim, marginTop: '3px' }}>{t.sub}</div>
                              </div>
                            )
                          })}
                        </div>

                        {/* Pass-through */}
                        {row.tx_type === 'passthrough' && (
                          <>
                            <div style={s.classTitle}>Pass-through details</div>
                            <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '10px', marginBottom: '14px' }}>
                              <div style={s.field}>
                                <label style={s.lbl}>Direction</label>
                                <div style={{ display: 'flex', gap: '8px' }}>
                                  {[{ id: 'in', label: '📥 IN' }, { id: 'out', label: '📤 OUT' }].map(d => (
                                    <div key={d.id} style={{ flex: 1, textAlign: 'center' as const, padding: '8px', borderRadius: '8px', cursor: 'pointer', fontSize: '13px', fontWeight: '500',
                                      border: row.pt_direction === d.id ? `2px solid ${d.id === 'in' ? DIALOG.accent : DIALOG.red}` : '0.5px solid ' + DIALOG.border,
                                      background: row.pt_direction === d.id ? (d.id === 'in' ? DIALOG.accentFill : DIALOG.redFill) : DIALOG.raised,
                                      color: row.pt_direction === d.id ? (d.id === 'in' ? DIALOG.accent : DIALOG.red) : DIALOG.dim,
                                    }} onClick={() => updateRow(row.id, { pt_direction: d.id as any })}>{d.label}</div>
                                  ))}
                                </div>
                              </div>
                              <div style={s.field}>
                                <label style={s.lbl}>Period</label>
                                <input type="month" style={s.input} value={row.pt_period} onChange={e => updateRow(row.id, { pt_period: e.target.value })} />
                              </div>
                            </div>
                          </>
                        )}

                        {/* Invoice payment */}
                        {row.tx_type === 'invoice_payment' && (
                          <>
                            <div style={s.classTitle}>Link to open invoice</div>
                            <div style={{ marginBottom: '14px' }}>
                              {openInvoices.length === 0 ? (
                                <div style={{ fontSize: '12px', color: DIALOG.faint, padding: '8px', background: DIALOG.raised, borderRadius: '8px' }}>
                                  No open invoices for this company. Select a company first.
                                </div>
                              ) : (
                                <>
                                  <input
                                    style={{ ...s.input, marginBottom: '8px', width: '100%', boxSizing: 'border-box' as const }}
                                    value={invoiceSearch[row.id] || ''}
                                    onChange={e => { e.stopPropagation(); setInvoiceSearch(prev => ({ ...prev, [row.id]: e.target.value })) }}
                                    onClick={e => e.stopPropagation()}
                                    placeholder="Search partner or invoice #..."
                                  />
                                  {(() => {
                                    // Counted over the same list the picker draws
                                    // from, so the number and the absence cannot
                                    // disagree with each other.
                                    const hidden = openInvoices.filter(inv =>
                                      row.linked_invoice_id !== inv.id
                                      && invoiceClaim(inv, row.id).free.exhausted).length
                                    if (hidden === 0) return null
                                    return (
                                      <div style={{ fontSize: '11px', color: DIALOG.dim, marginBottom: '8px', display: 'flex', alignItems: 'center', gap: '8px' }}>
                                        <span>
                                          {hidden} invoice{hidden === 1 ? '' : 's'} already taken by another line
                                          {showTaken[row.id] ? ' — shown, greyed out' : ' — hidden'}
                                        </span>
                                        <button
                                          style={{ background: 'transparent', border: '0.5px solid ' + DIALOG.border, borderRadius: '6px', color: DIALOG.dim, fontSize: '10.5px', padding: '2px 8px', cursor: 'pointer', fontFamily: "'Inter', system-ui, sans-serif" }}
                                          onClick={e => { e.stopPropagation(); setShowTaken(prev => ({ ...prev, [row.id]: !prev[row.id] })) }}>
                                          {showTaken[row.id] ? 'Hide them' : 'Show them'}
                                        </button>
                                      </div>
                                    )
                                  })()}
                                  <div style={{ maxHeight: '220px', overflowY: 'auto' as const, display: 'flex', flexDirection: 'column' as const, gap: '4px' }}>
                                    <div
                                      style={{ padding: '7px 10px', borderRadius: '7px', border: !row.linked_invoice_id ? '1.5px solid ' + DIALOG.accent : '0.5px solid ' + DIALOG.border, background: !row.linked_invoice_id ? DIALOG.accentFill : DIALOG.raised, cursor: 'pointer', fontSize: '12px', color: DIALOG.dim }}
                                      onClick={e => { e.stopPropagation(); updateRow(row.id, { linked_invoice_id: '' }) }}>
                                      — No invoice (standalone) —
                                    </div>
                                    {openInvoices
                                      .filter(inv => {
                                        const q = (invoiceSearch[row.id] || '').toLowerCase()
                                        if (!q) return true
                                        return (inv.partner_name || '').toLowerCase().includes(q) || (inv.invoice_number || '').toLowerCase().includes(q)
                                      })
                                      .filter(inv => !isHiddenForRow(
                                        invoiceClaim(inv, row.id).free,
                                        row.linked_invoice_id === inv.id,
                                        !!showTaken[row.id]))
                                      .map(inv => {
                                        const selected = row.linked_invoice_id === inv.id
                                        const remOwn = outstandingOwn(inv)
                                        // Another line of this statement may already cover it.
                                        const { free, notice } = invoiceClaim(inv, row.id)
                                        const taken = free.exhausted && !selected
                                        return (
                                          <div key={inv.id}
                                            style={{ padding: '8px 10px', borderRadius: '7px', border: selected ? '1.5px solid ' + DIALOG.accent : '0.5px solid ' + DIALOG.border, background: selected ? DIALOG.accentFill : DIALOG.raised, cursor: taken ? 'not-allowed' : 'pointer', opacity: taken ? 0.45 : 1 }}
                                            onClick={e => {
                                              e.stopPropagation()
                                              // Already settled by another line here. Picking it would
                                              // post nothing and leave the invoice it displaced open.
                                              if (taken) return
                                              updateRow(row.id, { linked_invoice_id: inv.id })
                                            }}>
                                            <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start', gap: '8px' }}>
                                              <div style={{ minWidth: 0, flex: 1 }}>
                                                <div style={{ display: 'flex', alignItems: 'center', gap: '6px', flexWrap: 'wrap' as const }}>
                                                  <span style={{ fontSize: '12px', fontWeight: '600', color: DIALOG.text }}>{inv.partner_name || '—'}</span>
                                                  {inv.invoice_number && <span style={{ fontSize: '10px', color: DIALOG.dim, background: DIALOG.raised, padding: '1px 6px', borderRadius: '4px', fontFamily: 'monospace' }}>{inv.invoice_number}</span>}
                                                </div>
                                                <div style={{ fontSize: '10px', color: DIALOG.dim, marginTop: '2px' }}>
                                                  {inv.invoice_date}{inv.due_date ? ` · Due: ${inv.due_date}` : ''}
                                                </div>
                                                {inv.expense_description && <div style={{ fontSize: '10px', color: DIALOG.dim, fontStyle: 'italic', marginTop: '1px' }}>{inv.expense_description}</div>}
                                              </div>
                                              <div style={{ textAlign: 'right' as const, flexShrink: 0 }}>
                                                <div style={{ fontSize: '12px', fontWeight: '600', color: DIALOG.text }}>{fmtMoney(inv.amount || 0, inv.currency || 'RSD')}</div>
                                                <div style={{ fontSize: '10px', color: remOwn > 0 ? DIALOG.red : DIALOG.accent, marginTop: '1px' }}>
                                                  Rem: {fmtMoney(remOwn, inv.currency || 'RSD')}
                                                </div>
                                              </div>
                                            </div>
                                            {notice && !selected && (
                                              <div style={{ fontSize: '10px', color: DIALOG.amber, marginTop: '4px' }}>{notice}</div>
                                            )}
                                          </div>
                                        )
                                    })}
                                  </div>
                                </>
                              )}
                              {linkedInvoice && (
                                <div style={{ marginTop: '8px', background: DIALOG.blueFill, border: '0.5px solid ' + DIALOG.blue, borderRadius: '8px', padding: '8px 12px', fontSize: '12px', color: DIALOG.blue }}>
                                  💳 Closes: <strong>{linkedInvoice.partner_name}</strong>
                                  {linkedInvoice.invoice_number && ` · ${linkedInvoice.invoice_number}`}
                                  {' · '}<strong>{fmtMoney(linkedInvoice.amount || 0, linkedInvoice.currency || 'RSD')}</strong>
                                  {' · '}Rem: <strong>{fmtMoney(outstandingOwn(linkedInvoice), linkedInvoice.currency || 'RSD')}</strong>
                                </div>
                              )}
                              {(() => {
                                // An invoice indexed to another currency never
                                // settles exactly. What is left is not a part
                                // payment.
                                const fx = fxFor(row)
                                if (!fx) return null
                                if (fx.difference.kind === 'allocate-first') return null
                                if (!isBookable(fx.difference)) return null
                                const script = fxScripts.find(sc => sc.id === row.fx_script_id)
                                  || findCurrencyDifference(fxScripts)
                                return (
                                  <div style={s.fxBox}>
                                    <label style={s.fxHead}>
                                      <input type="checkbox" checked={row.fx_book}
                                        onChange={e => updateRow(row.id, { fx_book: e.target.checked })}
                                        style={{ accentColor: DIALOG.accent, cursor: 'pointer' }} />
                                      <span>
                                        Book the {fx.difference.kind === 'gain' ? 'gain' : 'shortfall'} of{' '}
                                        <strong>{formatMoney(fx.amountOwn, fx.currency)}</strong> as a currency difference
                                      </span>
                                    </label>
                                    <div style={s.fxNote}>{fx.difference.note}</div>
                                    {row.fx_book && (
                                      <>
                                        <div style={{ display: 'flex', alignItems: 'center', gap: '8px', marginTop: '8px' }}>
                                          <span style={{ fontSize: '11.5px', color: DIALOG.dim, whiteSpace: 'nowrap' as const }}>Classify as</span>
                                          <select style={{ ...s.select, flex: 1 }} value={script?.id || ''}
                                            onChange={e => updateRow(row.id, { fx_script_id: e.target.value })}>
                                            {fxScripts.length === 0 && <option value="">No quick-fill templates saved</option>}
                                            {fxScripts.map(sc => (
                                              <option key={sc.id} value={sc.id}>{sc.name} — {sc.pl_category}</option>
                                            ))}
                                          </select>
                                        </div>
                                        {!script && (
                                          <div style={{ ...s.fxNote, color: DIALOG.red }}>
                                            No template is set up for currency differences, so there is no
                                            classification to book this under. Create one called "Currency
                                            Differences" with the + New button above.
                                          </div>
                                        )}
                                      </>
                                    )}
                                  </div>
                                )
                              })()}
                            </div>
                          </>
                        )}

                        {/* Direct — subtype */}
                        {row.tx_type === 'direct' && (
                          <>
                            {/* ONE LINE OF THE STATEMENT, SEVERAL COSTS.
                                Only on a direct row: an invoice payment has
                                no P&L of its own to divide — it closes a bill
                                classified when it was raised. */}
                            {!effectiveAdvance(row.tx_type, row.tx_subtype, row.is_advance) && <SplitEditor
                              parent={{
                                amount: parseFloat(row.debit) || parseFloat(row.credit) || 0,
                                // The book figures are worked out at post
                                // time from the official rate for the day, so
                                // they are not known here. The lines still
                                // have to add up in the currency the bank
                                // moved, which is the figure a person is
                                // looking at.
                                currency: row.currency || undefined,
                              }}
                              lines={row.pl_splits}
                              onChange={lines => {
                                // The row's own classification follows the
                                // biggest line, because the ledger lists it
                                // and a row showing nothing under P&L
                                // Category reads as one somebody forgot.
                                const from = classificationFromSplit(lines)
                                // The project moves between the row and its
                                // lines by one rule — never on both at once.
                                const moved = splitProjectChange(
                                  row.pl_splits, lines, projectIdFromInput(row.project_id))
                                updateRow(row.id, {
                                  pl_splits: moved.lines,
                                  project_id: projectIdToInput(moved.parentProjectId),
                                  ...(from ? {
                                    pl_category_name: from.pl_category,
                                    pl_subcategory_name: from.pl_subcategory,
                                    department_name: from.department,
                                    dept_subcategory_name: from.dept_subcategory,
                                    expense_description: from.expense_description,
                                  } : {}),
                                })
                              }}
                              companyId={company || null}
                              scripts={quickFillScripts as any}
                              classification={{ plCategories, plSubcategories, departments, deptSubcategories, expenseDescriptions }}
                              client={supabase}
                              onScriptsChanged={refreshQfScripts}
                              hint="One bank line, two or more expenses — each with its own classification."
                            />}

                            {row.pl_splits.length > 0 && (
                              <div style={{ fontSize: '11.5px', color: DIALOG.amber, margin: '2px 0 10px', lineHeight: 1.55 }}>
                                The classification below is taken from the largest line of the
                                split and locked while it stands. The split is what the P&amp;L
                                reads; this is what the ledger lists the line under. Each line
                                carries its own project.
                              </div>
                            )}
                            <div style={{
                              ...(row.pl_splits.length > 0
                                ? { opacity: 0.5, pointerEvents: 'none' as const, userSelect: 'none' as const }
                                : {}),
                            }}>
                            <div style={s.classTitle}>Subtype</div>
                            <div style={{ display: 'flex', gap: '8px', marginBottom: '14px' }}>
                              {[{ id: 'expense', label: '📤  Expense' }, { id: 'revenue', label: '📥  Revenue' }].map(sub => (
                                <div key={sub.id} style={{ flex: 1, textAlign: 'center' as const, padding: '9px', borderRadius: '8px', cursor: 'pointer', fontSize: '13px', fontWeight: '500',
                                  border: row.tx_subtype === sub.id ? `1.5px solid ${sub.id === 'expense' ? DIALOG.red : DIALOG.accent}` : '0.5px solid ' + DIALOG.border,
                                  background: row.tx_subtype === sub.id ? (sub.id === 'expense' ? DIALOG.redFill : DIALOG.accentFill) : DIALOG.raised,
                                  color: row.tx_subtype === sub.id ? (sub.id === 'expense' ? DIALOG.red : DIALOG.accent) : DIALOG.dim,
                                }} onClick={() => updateRow(row.id, { tx_subtype: sub.id as any })}>{sub.label}</div>
                              ))}
                            </div>

                            {/* Expense classification */}
                            {row.tx_subtype === 'expense' && (
                              <>
                                <div style={s.classTitle}>P&L Classification</div>
                                <div style={{ marginBottom: '10px', display: 'flex', gap: '6px', alignItems: 'flex-start' }}>
                                  <div style={{ flex: 1, position: 'relative' as const }}>
                                    <div style={{ position: 'relative' as const }}>
                                      <input
                                        style={{ width: '100%', boxSizing: 'border-box' as const, fontFamily: 'system-ui,sans-serif', fontSize: '12px', padding: '7px 28px 7px 10px', border: `1px solid ${qfOpen === row.id ? DIALOG.accent : 'rgba(29,158,117,0.3)'}`, borderRadius: '8px', background: 'rgba(29,158,117,0.05)', color: DIALOG.accent, outline: 'none' }}
                                        value={qfSearch[row.id] || ''}
                                        onChange={e => setQfSearch(prev => ({ ...prev, [row.id]: e.target.value }))}
                                        onFocus={() => setQfOpen(row.id)}
                                        onBlur={() => setTimeout(() => setQfOpen(null), 150)}
                                        placeholder="⚡ Quick fill — click or search…"
                                      />
                                      <span style={{ position: 'absolute' as const, right: '10px', top: '50%', transform: 'translateY(-50%)', fontSize: '10px', color: DIALOG.accent, pointerEvents: 'none' as const }}>
                                        {qfOpen === row.id ? '▲' : '▼'}
                                      </span>
                                    </div>
                                    {qfOpen === row.id && (
                                      <div style={{ position: 'absolute' as const, top: '100%', left: 0, right: 0, background: DIALOG.panel, border: '0.5px solid ' + DIALOG.accent, borderRadius: '8px', zIndex: 300, maxHeight: '200px', overflowY: 'auto' as const, marginTop: '2px', boxShadow: '0 8px 24px rgba(0,0,0,0.12)' }}>
                                        {(() => {
                                          const filtered = quickFillScripts.filter(sc =>
                                            !(qfSearch[row.id]) ||
                                            sc.name.toLowerCase().includes((qfSearch[row.id] || '').toLowerCase()) ||
                                            sc.pl_category.toLowerCase().includes((qfSearch[row.id] || '').toLowerCase()) ||
                                            sc.department.toLowerCase().includes((qfSearch[row.id] || '').toLowerCase())
                                          )
                                          return filtered.length === 0
                                            ? <div style={{ padding: '10px 12px', fontSize: '12px', color: DIALOG.dim }}>No matches for "{qfSearch[row.id]}"</div>
                                            : filtered.map(sc => (
                                                <div key={sc.id}
                                                  style={{ padding: '8px 12px', cursor: 'pointer', borderBottom: '0.5px solid ' + DIALOG.borderSoft, display: 'flex', flexDirection: 'column' as const, gap: '2px' }}
                                                  onMouseDown={e => {
                                                    e.preventDefault()
                                                    applyQuickFillRow(row.id, sc.id)
                                                    setQfSearch(prev => ({ ...prev, [row.id]: '' }))
                                                    setQfOpen(null)
                                                  }}>
                                                  <span style={{ fontSize: '12px', fontWeight: '500', color: DIALOG.accent }}>{sc.icon} {sc.name}</span>
                                                  <span style={{ fontSize: '10px', color: DIALOG.dim }}>{sc.pl_category}{sc.dept_subcategory ? ` · ${sc.dept_subcategory}` : ''}</span>
                                                </div>
                                              ))
                                        })()}
                                      </div>
                                    )}
                                  </div>
                                  <button
                                    style={{ fontFamily: 'system-ui,sans-serif', fontSize: '11px', padding: '5px 10px', border: '1px solid rgba(29,158,117,0.3)', borderRadius: '6px', background: 'rgba(29,158,117,0.08)', color: DIALOG.accent, cursor: 'pointer', whiteSpace: 'nowrap' as const, flexShrink: 0 }}
                                    onClick={e => { e.stopPropagation(); setQfEditing({ ...EMPTY_SCRIPT, id: `script_${Date.now()}` }); setQfDialogOpen(true) }}>
                                    + New
                                  </button>
                                  <button
                                    style={{ fontFamily: 'system-ui,sans-serif', fontSize: '11px', padding: '5px 10px', border: '0.5px solid ' + DIALOG.border, borderRadius: '6px', background: 'transparent', color: DIALOG.dim, cursor: 'pointer', whiteSpace: 'nowrap' as const, flexShrink: 0 }}
                                    onClick={e => { e.stopPropagation(); setQfEditing(null); setQfDialogOpen(true) }}>
                                    ✎ Edit
                                  </button>
                                </div>
                                <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '10px', marginBottom: '10px' }}>
                                  <div style={s.field}>
                                    <label style={s.lbl}>P&L Category</label>
                                    <div style={{ display: 'flex', gap: '6px', alignItems: 'flex-start' }}>
                                    <SearchableSelect value={row.pl_category_id}
                                      onChange={v => { const c = plCategories.find(x => x.id === v); updateRow(row.id, { pl_category_id: v, pl_category_name: c?.name || '', pl_subcategory_id: '', pl_subcategory_name: '' }) }}
                                      options={plCategories.map(c => ({ value: c.id, label: c.name }))}
                                      allLabel="Select category..." searchPlaceholder="Type to search categories…"
                                      style={{ ...pickerChrome, flex: 1 }} />
                                    <InlineCategoryAdd table="pl_categories"
                                      currentCount={plCategories.length}
                                      onAdded={item => { setPlCategories(prev => [...prev, { ...item, type: 'expense', sort_order: prev.length + 1 }]); updateRow(row.id, { pl_category_id: item.id, pl_category_name: item.name, pl_subcategory_id: '', pl_subcategory_name: '' }) }} />
                                    </div>
                                  </div>
                                  <div style={s.field}>
                                    <label style={s.lbl}>P&L Sub-category</label>
                                    <div style={{ display: 'flex', gap: '6px', alignItems: 'flex-start' }}>
                                    <SearchableSelect value={row.pl_subcategory_id}
                                      onChange={v => { const sub = plSubcategories.find(x => x.id === v); updateRow(row.id, { pl_subcategory_id: v, pl_subcategory_name: sub?.name || '' }) }}
                                      options={plSubs.map(sub => ({ value: sub.id, label: sub.name }))}
                                      allLabel="Select sub-category..." searchPlaceholder="Type to search sub-categories…"
                                      disabled={!row.pl_category_id || plSubs.length === 0}
                                      style={{ ...pickerChrome, flex: 1 }} />
                                    <InlineCategoryAdd table="pl_subcategories" parentId={row.pl_category_id} parentField="category_id"
                                      currentCount={plSubs.length} disabled={!row.pl_category_id}
                                      onAdded={item => { setPlSubcategories(prev => [...prev, { ...item, category_id: row.pl_category_id, sort_order: prev.length + 1 }]); updateRow(row.id, { pl_subcategory_id: item.id, pl_subcategory_name: item.name }) }} />
                                    </div>
                                  </div>
                                </div>

                                <div style={s.classTitle}>Department</div>
                                <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '10px', marginBottom: '10px' }}>
                                  <div style={s.field}>
                                    <label style={s.lbl}>Department</label>
                                    <div style={{ display: 'flex', gap: '6px', alignItems: 'flex-start' }}>
                                    <SearchableSelect value={row.department_id}
                                      onChange={v => { const d = departments.find(x => x.id === v); updateRow(row.id, { department_id: v, department_name: d?.name || '', dept_subcategory_id: '', dept_subcategory_name: '', expense_description: '' }) }}
                                      options={departments.map(d => ({ value: d.id, label: d.name }))}
                                      allLabel="Select department..." searchPlaceholder="Type to search departments…"
                                      style={{ ...pickerChrome, flex: 1 }} />
                                    <InlineCategoryAdd table="departments"
                                      currentCount={departments.length}
                                      onAdded={item => { setDepartments(prev => [...prev, { ...item, sort_order: prev.length + 1 }]); updateRow(row.id, { department_id: item.id, department_name: item.name, dept_subcategory_id: '', dept_subcategory_name: '', expense_description: '' }) }} />
                                    </div>
                                  </div>
                                  <div style={s.field}>
                                    <label style={s.lbl}>Dept. Sub-category</label>
                                    <div style={{ display: 'flex', gap: '6px', alignItems: 'flex-start' }}>
                                    <SearchableSelect value={row.dept_subcategory_id}
                                      onChange={v => { const sub = deptSubcategories.find(x => x.id === v); updateRow(row.id, { dept_subcategory_id: v, dept_subcategory_name: sub?.name || '', expense_description: '' }) }}
                                      options={deptSubs.map(sub => ({ value: sub.id, label: sub.name }))}
                                      allLabel="Select sub-category..." searchPlaceholder="Type to search sub-categories…"
                                      disabled={!row.department_id || deptSubs.length === 0}
                                      style={{ ...pickerChrome, flex: 1 }} />
                                    <InlineCategoryAdd table="dept_subcategories" parentId={row.department_id} parentField="department_id"
                                      currentCount={deptSubs.length} disabled={!row.department_id}
                                      onAdded={item => { setDeptSubcategories(prev => [...prev, { ...item, department_id: row.department_id, sort_order: prev.length + 1 }]); updateRow(row.id, { dept_subcategory_id: item.id, dept_subcategory_name: item.name, expense_description: '' }) }} />
                                    </div>
                                  </div>
                                </div>

                                <div style={{ marginBottom: '10px' }}>
                                  <div style={s.field}>
                                    <label style={s.lbl}>Expense description</label>
                                    <div style={{ display: 'flex', gap: '6px', alignItems: 'flex-start' }}>
                                      {expDescs.length > 0 ? (
                                        <SearchableSelect value={row.expense_description}
                                          onChange={v => updateRow(row.id, { expense_description: v })}
                                          options={expDescs.map(d => ({ value: d.name, label: d.name }))}
                                          allLabel="Select description..." searchPlaceholder="Type to search descriptions…"
                                          style={{ ...pickerChrome, flex: 1 }} />
                                      ) : (
                                        <input style={{ ...s.input, flex: 1 }} value={row.expense_description} onChange={e => updateRow(row.id, { expense_description: e.target.value })} placeholder="e.g. AWS, Telekom, Rent..." />
                                      )}
                                      <InlineCategoryAdd table="expense_descriptions" parentId={row.dept_subcategory_id} parentField="dept_subcategory_id"
                                        currentCount={expDescs.length} disabled={!row.dept_subcategory_id}
                                        onAdded={item => { setExpenseDescriptions(prev => [...prev, { ...item, dept_subcategory_id: row.dept_subcategory_id, sort_order: prev.length + 1 }]); updateRow(row.id, { expense_description: item.name }) }} />
                                    </div>
                                  </div>
                                </div>

                              </>
                            )}

                            {/* Cash Flow Classification */}
                            <div style={s.classTitle}>Cash flow classification</div>
                            <div style={{ display: 'grid', gridTemplateColumns: 'repeat(5,1fr)', gap: '6px', marginBottom: '10px' }}>
                              {[
                                { id: 'recurring', label: '🔁 Recurring' },
                                { id: 'one_time', label: '1️⃣ One-time' },
                                { id: 'accrual', label: '📅 Accrual' },
                                { id: 'capex', label: '🏗 CapEx' },
                                { id: 'reimbursable', label: '↩️ Reimb.' },
                              ].map(a => (
                                <div key={a.id} style={{ ...s.allocBtn, padding: '6px 4px', ...(row.cf_type === a.id ? { border: '2px solid ' + DIALOG.accent, background: DIALOG.accentFill } : {}) }}
                                  onClick={() => updateRow(row.id, { cf_type: row.cf_type === a.id ? '' : a.id })}>
                                  <div style={{ fontSize: '10px', fontWeight: '600', color: row.cf_type === a.id ? DIALOG.accent : DIALOG.text }}>{a.label}</div>
                                </div>
                              ))}
                            </div>
                            {row.cf_type === 'recurring' && (
                              <div style={{ marginBottom: '10px', background: DIALOG.raised, borderRadius: '8px', padding: '12px', border: '0.5px solid ' + DIALOG.border }}>
                                <div style={{ display: 'flex', gap: '6px', marginBottom: '10px' }}>
                                  {[{ id: 'monthly', label: '📆 Monthly' }, { id: 'quarterly', label: '📊 Quarterly' }, { id: 'yearly', label: '📅 Yearly' }].map(f => (
                                    <div key={f.id}
                                      style={{ flex: 1, padding: '7px', border: row.cf_frequency === f.id ? '2px solid ' + DIALOG.accent : '0.5px solid ' + DIALOG.border, borderRadius: '8px', background: row.cf_frequency === f.id ? DIALOG.accentFill : DIALOG.raised, cursor: 'pointer', textAlign: 'center' as const, fontSize: '11px', fontWeight: row.cf_frequency === f.id ? '600' : '400', color: row.cf_frequency === f.id ? DIALOG.accent : DIALOG.dim }}
                                      onClick={() => updateRow(row.id, { cf_frequency: f.id })}>{f.label}</div>
                                  ))}
                                </div>
                                <div style={s.field}>
                                  <label style={s.lbl}>Next month estimate ({row.currency})</label>
                                  <div style={{ display: 'flex', gap: '8px', alignItems: 'center' }}>
                                    <input type="number" style={{ ...s.input, flex: 1 }} value={row.cf_next_month_est}
                                      onChange={e => updateRow(row.id, { cf_next_month_est: e.target.value })}
                                      placeholder={row.debit ? `Auto: ${fmtNum(parseFloat(row.debit))}` : '0.00'} />
                                    {!row.cf_next_month_est && row.debit && (
                                      <button style={{ fontFamily: 'system-ui,sans-serif', fontSize: '11px', padding: '5px 10px', border: '1px solid rgba(29,158,117,0.3)', borderRadius: '6px', background: 'transparent', color: DIALOG.accent, cursor: 'pointer', whiteSpace: 'nowrap' as const }}
                                        onClick={() => updateRow(row.id, { cf_next_month_est: row.debit })}>
                                        Use this amount
                                      </button>
                                    )}
                                  </div>
                                  {row.debit && (
                                    <div style={{ fontSize: '10px', color: DIALOG.dim, marginTop: '4px' }}>
                                      Auto: {row.cf_frequency === 'quarterly'
                                        ? (parseFloat(row.debit) / 3).toFixed(2)
                                        : row.cf_frequency === 'yearly'
                                        ? (parseFloat(row.debit) / 12).toFixed(2)
                                        : fmtNum(parseFloat(row.debit))} {row.currency}/mo
                                    </div>
                                  )}
                                </div>
                              </div>
                            )}
                            {row.cf_type === 'one_time' && (
                              <div style={{ marginBottom: '10px', fontSize: '11px', color: DIALOG.dim, background: DIALOG.raised, borderRadius: '6px', padding: '8px 10px' }}>
                                One-time — won't be included in future estimates.
                              </div>
                            )}

                            {/* Revenue */}
                            {row.tx_subtype === 'revenue' && (
                              <>
                                <label style={{ display: 'flex', gap: '8px', alignItems: 'flex-start', cursor: 'pointer', fontSize: '12px', marginBottom: '8px' }}>
                                  <input type="checkbox" checked={!!row.is_advance}
                                    disabled={row.pl_splits.length > 0 || row.stored_split}
                                    onChange={e => updateRow(row.id, { is_advance: e.target.checked })}
                                    style={{ accentColor: DIALOG.accent, cursor: 'pointer', marginTop: '2px' }} />
                                  <span>
                                    <strong>{ADVANCE_LABEL}</strong> — primljen od investitora
                                    <span style={{ display: 'block', fontSize: '10.5px', color: DIALOG.dim, lineHeight: 1.4 }}>
                                      Obaveza, ne prihod: bez uticaja na bilans uspeha, obavezno na projektu, bez podele i bez povezivanja sa fakturom.
                                    </span>
                                  </span>
                                </label>
                                {effectiveAdvance(row.tx_type, row.tx_subtype, row.is_advance) && !projectIdFromInput(row.project_id) && (
                                  <div style={{ fontSize: '11px', color: DIALOG.red, marginBottom: '8px' }}>
                                    Avans mora biti na projektu — izaberite projekat ispod.
                                  </div>
                                )}
                                {(() => {
                                  const hint = doubleCountHint(
                                    { type: row.tx_type, subtype: row.tx_subtype, isAdvance: row.is_advance },
                                    row.partner_id, openInvoices)
                                  return hint ? (
                                    <div style={{ fontSize: '11px', color: DIALOG.amber, background: DIALOG.amberFill, borderRadius: '6px', padding: '6px 8px', marginBottom: '10px', lineHeight: 1.5 }}>
                                      {hint}{' '}
                                      <span style={{ textDecoration: 'underline', cursor: 'pointer', fontWeight: 600 }}
                                        onClick={() => updateRow(row.id, { tx_type: 'invoice_payment', is_advance: false })}>Prebaci na plaćanje fakture</span>
                                    </div>
                                  ) : null
                                })()}
                                <div style={s.classTitle}>Revenue stream</div>
                                <div style={{ marginBottom: '10px' }}>
                                  <select style={{ ...s.select, width: '100%' }} value={row.revenue_stream} onChange={e => updateRow(row.id, { revenue_stream: e.target.value })}>
                                    <option value="">Select stream...</option>
                                    {REVENUE_STREAMS.map(r => <option key={r}>{r}</option>)}
                                  </select>
                                </div>
                              </>
                            )}

                            {/* Project — one per row; a split row's are on its lines. */}
                            {row.stored_split && (
                              <>
                                <div style={s.classTitle}>Project</div>
                                <div style={{ marginBottom: '10px', fontSize: '12px', color: DIALOG.dim }}>
                                  This row is split across projects. Change the split from the General Ledger.
                                </div>
                              </>
                            )}
                            {row.pl_splits.length === 0 && !row.stored_split && (
                              <>
                                <div style={s.classTitle}>Project</div>
                                <div style={{ marginBottom: '10px' }}>
                                  <ProjectSelect
                                    value={projectIdFromInput(row.project_id)}
                                    onChange={id => updateRow(row.id, { project_id: projectIdToInput(id) })}
                                    companyId={company || null}
                                    style={{ ...pickerChrome, width: '100%' }} />
                                </div>
                              </>
                            )}
                            </div>
                          </>
                        )}

                        {/* Credit payment */}
                        {row.tx_type === 'credit_payment' && (
                          <>
                            <div style={s.classTitle}>Credit installments</div>
                            <div style={{ marginBottom: '14px' }}>
                              <CreditInstallmentSelector
                                credits={credits}
                                selectedCreditId={row.selected_credit_id}
                                onCreditChange={id => {
                                  updateRow(row.id, { selected_credit_id: id, selected_installment_ids: [] })
                                  loadRowInstallments(row.id, id)
                                }}
                                installments={rowInstallments[row.id] || []}
                                selectedInstallmentIds={row.selected_installment_ids}
                                onToggle={id => updateRow(row.id, {
                                  selected_installment_ids: row.selected_installment_ids.includes(id)
                                    ? row.selected_installment_ids.filter((x: string) => x !== id)
                                    : [...row.selected_installment_ids, id]
                                })}
                                onToggleAll={() => {
                                  const all = (rowInstallments[row.id] || []).map((i: any) => i.id)
                                  updateRow(row.id, {
                                    selected_installment_ids:
                                      row.selected_installment_ids.length === all.length ? [] : all
                                  })
                                }}
                                selectedTotal={(rowInstallments[row.id] || [])
                                  .filter((i: any) => row.selected_installment_ids.includes(i.id))
                                  .reduce((s: number, i: any) => s + i.total_amount, 0)}
                              />
                            </div>
                          </>
                        )}

                        {/* Payment reference */}
                        <div style={s.classTitle}>Payment reference</div>
                        <div style={{ display: 'grid', gridTemplateColumns: '1fr 60px 1fr', gap: '10px', marginBottom: '10px' }}>
                          <div style={s.field}>
                            <label style={s.lbl}>Account number {rowPartnerAccounts.length > 0 ? `(${rowPartnerAccounts.length} from partner)` : ''}</label>
                            {rowPartnerAccounts.length > 0 ? (
                              <select style={s.select}
                                value={rowPartnerAccounts.find(a => normalizeAccountNumber(a.account_number) === normalizeAccountNumber(row.account_number))?.account_number || row.account_number}
                                onChange={e => {
                                  const acc = rowPartnerAccounts.find(a => a.account_number === e.target.value)
                                  updateRow(row.id, { account_number: e.target.value, model: acc?.model || row.model })
                                }}>
                                <option value="">— No account —</option>
                                {rowPartnerAccounts.map(acc => (
                                  <option key={acc.id} value={acc.account_number}>
                                    {acc.account_number}{acc.bank_name ? ` (${acc.bank_name})` : ''}{acc.is_primary ? ' ★' : ''}
                                  </option>
                                ))}
                              </select>
                            ) : (
                              <input style={s.input} value={row.account_number} onChange={e => updateRow(row.id, { account_number: e.target.value })} placeholder="265-..." />
                            )}
                          </div>
                          <div style={s.field}>
                            <label style={s.lbl}>Model</label>
                            <input style={s.input} value={row.model} onChange={e => updateRow(row.id, { model: e.target.value })} placeholder="97" />
                          </div>
                          <div style={s.field}>
                            <label style={s.lbl}>Reference number</label>
                            <input style={s.input} value={row.reference_number} onChange={e => updateRow(row.id, { reference_number: e.target.value })} placeholder="Poziv na broj" />
                          </div>
                        </div>

                        <div style={s.field}>
                          <label style={s.lbl}>Note</label>
                          <input style={s.input} value={row.note} onChange={e => updateRow(row.id, { note: e.target.value })} placeholder="Additional note..." />
                        </div>

                        <div style={{ display: 'flex', justifyContent: 'flex-end', marginTop: '12px' }}>
                          <button style={{ fontFamily: 'system-ui,sans-serif', fontSize: '12px', padding: '6px 16px', borderRadius: '8px', border: 'none', background: DIALOG.accent, color: DIALOG.onAccent, cursor: 'pointer' }}
                            onClick={() => setExpandedRow(null)}>✓ Done</button>
                        </div>
                      </div>
                    )}
                  </div>
                )
              })}
            </div>

            <button style={{ ...s.addRowBtn, marginTop: '10px', width: '100%', padding: '10px' }} onClick={addRow}>+ Add row</button>
          </div>

          {notice && (
            <div style={{ background: DIALOG.accentFill, border: '0.5px solid ' + DIALOG.accentSoft, borderRadius: '8px', padding: '10px 14px', fontSize: '13px', color: DIALOG.accent, marginBottom: '12px' }}>✓ {notice}</div>
          )}
          {error && (
            <div style={{ background: DIALOG.redFill, border: '0.5px solid ' + DIALOG.redSoft, borderRadius: '8px', padding: '10px 14px', fontSize: '13px', color: DIALOG.red, marginBottom: '12px' }}>⚠️ {error}</div>
          )}
        </div>

        <div style={s.footer}>
          <div style={{ fontSize: '12px', color: DIALOG.dim }}>
            {editing
              ? `${editableRows.length} row${editableRows.length !== 1 ? 's' : ''} editable` +
                (removedRows.length > 0 ? ` · ${removedRows.length} to remove` : '') +
                (editing.lockedCount > 0 ? ` · ${editing.lockedCount} locked` : '')
              : `${validRows.length} transaction${validRows.length !== 1 ? 's' : ''} ready`}
            {totalDebit > 0 && <span style={{ color: DIALOG.red, marginLeft: '12px' }}>Out: {fmtMoney(totalDebit, defaultCurrency)}</span>}
            {totalCredit > 0 && <span style={{ color: DIALOG.accent, marginLeft: '12px' }}>In: {fmtMoney(totalCredit, defaultCurrency)}</span>}
          </div>
          <div style={{ display: 'flex', gap: '8px' }}>
            <button style={s.btnGhost} onClick={editing ? exitEdit : onClose}>{editing ? 'Discard changes' : 'Cancel'}</button>
            {editing ? (
              <button style={{ ...s.btnPrimary, opacity: posting ? 0.5 : 1 }}
                onClick={handleSaveEdit} disabled={posting}>
                {posting ? 'Saving...' : 'Save changes'}
              </button>
            ) : (
              <button style={{ ...s.btnPrimary, opacity: (!company || !bank || validRows.length === 0 || posting) ? 0.5 : 1 }}
                onClick={handlePost} disabled={!company || !bank || validRows.length === 0 || posting}>
                {posting ? 'Posting...' : `Post ${validRows.length} transaction${validRows.length !== 1 ? 's' : ''}`}
              </button>
            )}
          </div>
        </div>
      </div>

      {/* Quick Fill Script Manager Dialog */}
      {qfDialogOpen && (
        <div style={{ position: 'fixed', inset: 0, background: DIALOG.overlay, backdropFilter: 'blur(4px)', display: 'flex', alignItems: 'center', justifyContent: 'center', zIndex: 1200 }}
          onClick={() => setQfDialogOpen(false)}>
          <div style={{ background: DIALOG.panel, border: '0.5px solid ' + DIALOG.border, borderRadius: '14px', width: '660px', maxWidth: '95vw', maxHeight: '85vh', display: 'flex', flexDirection: 'column' as const, overflow: 'hidden', boxShadow: '0 20px 60px rgba(0,0,0,0.2)' }}
            onClick={e => e.stopPropagation()}>
            <div style={{ background: DIALOG.panelDeep, padding: '14px 20px', display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}>
              <div style={{ color: DIALOG.text, fontSize: '14px', fontWeight: '500' }}>
                {qfEditing && qfEditing.name === '' ? '➕ New script' : qfEditing ? `✎ Edit: ${qfEditing.name}` : '⚡ Quick Fill scripts'}
              </div>
              <button style={{ background: 'none', border: 'none', color: 'rgba(255,255,255,0.5)', fontSize: '20px', cursor: 'pointer' }}
                onClick={() => { setQfDialogOpen(false); setQfEditing(null) }}>×</button>
            </div>
            <div style={{ flex: 1, overflowY: 'auto' as const, padding: '16px 20px' }}>
              {qfEditing ? (
                <div style={{ display: 'flex', flexDirection: 'column' as const, gap: '12px' }}>
                  <div style={{ display: 'grid', gridTemplateColumns: '60px 1fr', gap: '8px' }}>
                    <div>
                      <div style={{ fontSize: '10px', color: DIALOG.dim, marginBottom: '4px', textTransform: 'uppercase' as const }}>Ikona</div>
                      <input style={{ ...s.input, textAlign: 'center' as const, fontSize: '20px' }}
                        value={qfEditing.icon} onChange={e => setQfEditing({ ...qfEditing, icon: e.target.value })} />
                    </div>
                    <div>
                      <div style={{ fontSize: '10px', color: DIALOG.dim, marginBottom: '4px', textTransform: 'uppercase' as const }}>Naziv skripte *</div>
                      <input style={s.input} value={qfEditing.name}
                        onChange={e => setQfEditing({ ...qfEditing, name: e.target.value })}
                        placeholder="e.g. Bank fee — domestic" />
                    </div>
                  </div>
                  <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '8px' }}>
                    <div>
                      <div style={{ fontSize: '10px', color: DIALOG.dim, marginBottom: '4px', textTransform: 'uppercase' as const }}>P&L Category</div>
                      <select style={s.select} value={qfEditing.pl_category}
                        onChange={e => setQfEditing({ ...qfEditing, pl_category: e.target.value, pl_subcategory: '' })}>
                        <option value="">Select...</option>
                        {plCategories.map(c => <option key={c.id} value={c.name}>{c.name}</option>)}
                      </select>
                    </div>
                    <div>
                      <div style={{ fontSize: '10px', color: DIALOG.dim, marginBottom: '4px', textTransform: 'uppercase' as const }}>P&L Sub-category</div>
                      <select style={s.select} value={qfEditing.pl_subcategory}
                        onChange={e => setQfEditing({ ...qfEditing, pl_subcategory: e.target.value })}>
                        <option value="">Select...</option>
                        {plSubcategories.filter(sub => {
                          const cat = plCategories.find(c => c.name === qfEditing.pl_category)
                          return cat && sub.category_id === cat.id
                        }).map(sub => <option key={sub.id} value={sub.name}>{sub.name}</option>)}
                      </select>
                    </div>
                  </div>
                  <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '8px' }}>
                    <div>
                      <div style={{ fontSize: '10px', color: DIALOG.dim, marginBottom: '4px', textTransform: 'uppercase' as const }}>Department</div>
                      <select style={s.select} value={qfEditing.department}
                        onChange={e => setQfEditing({ ...qfEditing, department: e.target.value, dept_subcategory: '', expense_description: '' })}>
                        <option value="">Select...</option>
                        {departments.map(d => <option key={d.id} value={d.name}>{d.name}</option>)}
                      </select>
                    </div>
                    <div>
                      <div style={{ fontSize: '10px', color: DIALOG.dim, marginBottom: '4px', textTransform: 'uppercase' as const }}>Dept. Sub-category</div>
                      <select style={s.select} value={qfEditing.dept_subcategory}
                        onChange={e => setQfEditing({ ...qfEditing, dept_subcategory: e.target.value, expense_description: '' })}>
                        <option value="">Select...</option>
                        {deptSubcategories.filter(sub => {
                          const dept = departments.find(d => d.name === qfEditing.department)
                          return dept && sub.department_id === dept.id
                        }).map(sub => <option key={sub.id} value={sub.name}>{sub.name}</option>)}
                      </select>
                    </div>
                  </div>
                  <div>
                    <div style={{ fontSize: '10px', color: DIALOG.dim, marginBottom: '4px', textTransform: 'uppercase' as const }}>Expense Description</div>
                    {(() => {
                      const parentDept = departments.find(d => d.name === qfEditing.department)
                      const deptSub = deptSubcategories.find(sub =>
                        sub.name === qfEditing.dept_subcategory && sub.department_id === parentDept?.id)
                      const descs = deptSub ? expenseDescriptions.filter(ed => ed.dept_subcategory_id === deptSub.id) : []
                      return descs.length > 0
                        ? <select style={s.select} value={qfEditing.expense_description}
                            onChange={e => setQfEditing({ ...qfEditing, expense_description: e.target.value })}>
                            <option value="">Select...</option>
                            {descs.map(d => <option key={d.id} value={d.name}>{d.name}</option>)}
                          </select>
                        : <input style={s.input} value={qfEditing.expense_description}
                            onChange={e => setQfEditing({ ...qfEditing, expense_description: e.target.value })}
                            placeholder="e.g. AWS, Telekom..." />
                    })()}
                  </div>
                  <div style={{ display: 'grid', gridTemplateColumns: '1fr', gap: '8px' }}>
                    <div>
                      <div style={{ fontSize: '10px', color: DIALOG.dim, marginBottom: '4px', textTransform: 'uppercase' as const }}>CF Type</div>
                      <select style={s.select} value={qfEditing.cf_type}
                        onChange={e => setQfEditing({ ...qfEditing, cf_type: e.target.value })}>
                        <option value="recurring">Recurring</option>
                        <option value="one_time">One-time</option>
                        <option value="accrual">Accrual</option>
                        <option value="capex">CapEx</option>
                        <option value="">— None —</option>
                      </select>
                    </div>
                  </div>
                  <div style={{ display: 'flex', gap: '8px', justifyContent: 'flex-end', paddingTop: '8px', borderTop: '0.5px solid ' + DIALOG.border }}>
                    <button style={{ fontFamily: 'system-ui,sans-serif', fontSize: '12px', padding: '7px 16px', border: '0.5px solid ' + DIALOG.border, borderRadius: '8px', background: 'transparent', color: DIALOG.dim, cursor: 'pointer' }}
                      onClick={() => setQfEditing(null)}>← Back</button>
                    <button
                      style={{ fontFamily: 'system-ui,sans-serif', fontSize: '12px', padding: '7px 16px', border: 'none', borderRadius: '8px', background: DIALOG.accent, color: DIALOG.onAccent, cursor: 'pointer', fontWeight: '600', opacity: !qfEditing.name.trim() ? 0.5 : 1 }}
                      disabled={!qfEditing.name.trim()}
                      onClick={async () => {
                        // An id only means something here if the table already
                        // has it; one the dialog invented for a new template
                        // would make this an update of a row that is not there.
                        const exists = quickFillScripts.some(sc => sc.id === qfEditing.id)
                        if (await persistQfScript(exists ? qfEditing : { ...qfEditing, id: undefined as any })) {
                          setQfEditing(null)
                        }
                      }}>
                      ✓ Save script
                    </button>
                  </div>
                </div>
              ) : (
                <div style={{ display: 'flex', flexDirection: 'column' as const, gap: '6px' }}>
                  {quickFillScripts.map(sc => (
                    <div key={sc.id} style={{ display: 'flex', alignItems: 'center', gap: '10px', padding: '10px 12px', background: DIALOG.raised, border: '0.5px solid ' + DIALOG.border, borderRadius: '8px' }}>
                      <span style={{ fontSize: '18px', width: '28px', textAlign: 'center' as const }}>{sc.icon}</span>
                      <div style={{ flex: 1, minWidth: 0 }}>
                        <div style={{ fontSize: '13px', fontWeight: '500', color: DIALOG.text }}>{sc.name}</div>
                        <div style={{ fontSize: '10px', color: DIALOG.dim, marginTop: '2px' }}>
                          {sc.pl_category}{sc.pl_subcategory ? ` › ${sc.pl_subcategory}` : ''}
                          {sc.department ? ` · ${sc.department}` : ''}{sc.dept_subcategory ? ` › ${sc.dept_subcategory}` : ''}
                        </div>
                      </div>
                      <button style={{ fontFamily: 'system-ui,sans-serif', fontSize: '11px', padding: '4px 10px', border: '0.5px solid ' + DIALOG.border, borderRadius: '6px', background: 'transparent', color: DIALOG.dim, cursor: 'pointer' }}
                        onClick={() => setQfEditing(sc)}>✎ Edit</button>
                      <button style={{ fontFamily: 'system-ui,sans-serif', fontSize: '11px', padding: '4px 10px', border: '0.5px solid ' + DIALOG.redSoft, borderRadius: '6px', background: 'transparent', color: DIALOG.red, cursor: 'pointer' }}
                        onClick={() => { if (window.confirm(`Delete "${sc.name}"?\n\nIt is shared, so it goes for everyone. Entries already classified with it keep their classification.`)) removeQfScript(sc.id) }}>✕</button>
                    </div>
                  ))}
                  {quickFillScripts.length === 0 && (
                    <div style={{ fontSize: '12px', color: DIALOG.faint, padding: '16px', textAlign: 'center' as const, background: DIALOG.raised, borderRadius: '8px' }}>
                      No scripts yet — add the first one below.
                    </div>
                  )}
                  <button style={{ marginTop: '8px', fontFamily: 'system-ui,sans-serif', fontSize: '12px', padding: '8px', border: '0.5px solid ' + DIALOG.accentSoft, borderRadius: '8px', background: 'transparent', color: DIALOG.accent, cursor: 'pointer', width: '100%' }}
                    onClick={() => setQfEditing({ ...EMPTY_SCRIPT, id: `script_${Date.now()}` })}>
                    + Add a script
                  </button>
                </div>
              )}
            </div>
          </div>
        </div>
      )}
    </div>

  )
}

const s: Record<string, React.CSSProperties> = {
  ...chrome,

  dialog: { background: DIALOG.panel, borderRadius: '16px', width: '1000px', maxWidth: '98vw', maxHeight: '90vh', display: 'flex', flexDirection: 'column', overflow: 'hidden' },

  body: { padding: '1.5rem', overflowY: 'auto', flex: 1 },
  footer: { padding: '1rem 1.5rem', borderTop: '0.5px solid ' + DIALOG.border, display: 'flex', alignItems: 'center', justifyContent: 'space-between', background: DIALOG.raised },
  section: { marginBottom: '1.5rem' },
  sectionTitle: { fontSize: '11px', fontWeight: '500', color: DIALOG.dim, textTransform: 'uppercase' as const, letterSpacing: '0.08em', marginBottom: '10px', paddingBottom: '6px', borderBottom: '0.5px solid ' + DIALOG.border },
  classTitle: { fontSize: '10px', fontWeight: '500', color: DIALOG.faint, textTransform: 'uppercase' as const, letterSpacing: '0.08em', marginBottom: '8px', marginTop: '4px', paddingBottom: '4px', borderBottom: '0.5px solid ' + DIALOG.border },
  field: { display: 'flex', flexDirection: 'column' as const, gap: '4px' },
  lbl: { fontSize: '10px', fontWeight: '500', color: DIALOG.dim, textTransform: 'uppercase' as const, letterSpacing: '0.07em' },
  req: { color: DIALOG.red },
  select: { fontFamily: 'system-ui,sans-serif', fontSize: '13px', padding: '8px 10px', border: '0.5px solid ' + DIALOG.border, borderRadius: '8px', background: DIALOG.panel, color: DIALOG.text, outline: 'none' },
  input: { fontFamily: 'system-ui,sans-serif', fontSize: '13px', padding: '8px 10px', border: '0.5px solid ' + DIALOG.border, borderRadius: '8px', background: DIALOG.panel, color: DIALOG.text, outline: 'none' },
  cellInput: { fontFamily: 'system-ui,sans-serif', fontSize: '12px', padding: '5px 7px', border: '0.5px solid ' + DIALOG.border, borderRadius: '6px', background: DIALOG.panel, color: DIALOG.text, outline: 'none', width: '100%' },
  addRowBtn: { fontFamily: 'system-ui,sans-serif', fontSize: '12px', padding: '6px 14px', border: '0.5px solid ' + DIALOG.accent, borderRadius: '6px', background: 'transparent', color: DIALOG.accent, cursor: 'pointer' },
  fxBox: {
    marginTop: '8px', padding: '9px 12px', borderRadius: '8px',
    borderWidth: '0.5px', borderStyle: 'solid', borderColor: DIALOG.border,
    background: DIALOG.raised,
  },
  fxHead: {
    display: 'flex', alignItems: 'flex-start', gap: '8px',
    fontSize: '12px', color: DIALOG.text, lineHeight: 1.5, cursor: 'pointer',
  },
  fxNote: { fontSize: '10.5px', color: DIALOG.dim, lineHeight: 1.5, marginTop: '6px' },
  allocBtn: { border: '0.5px solid ' + DIALOG.border, borderRadius: '8px', padding: '8px 6px', background: DIALOG.raised, cursor: 'pointer', textAlign: 'center' as const },
  allocBtnActive: { border: '2px solid ' + DIALOG.accent, background: DIALOG.accentFill },
  btnGhost: { fontFamily: 'system-ui,sans-serif', fontSize: '13px', padding: '8px 16px', borderRadius: '8px', border: '0.5px solid ' + DIALOG.border, background: 'transparent', color: DIALOG.dim, cursor: 'pointer' },
  btnPrimary: { fontFamily: 'system-ui,sans-serif', fontSize: '13px', padding: '8px 18px', borderRadius: '8px', border: 'none', background: DIALOG.accent, color: DIALOG.onAccent, cursor: 'pointer', fontWeight: '500' },
}

// `SearchableSelect` paints its border with longhands so it can recolour just
// the edge when the list opens, and React warns about mixing those with the
// `border` shorthand on one element. So the shorthand is dropped here and the
// control keeps its own border, which is the same weight and colour.
// eslint-disable-next-line @typescript-eslint/no-unused-vars
const { border: _pickerBorder, ...pickerChrome } = s.select
