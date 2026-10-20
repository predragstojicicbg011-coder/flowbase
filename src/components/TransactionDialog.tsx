import { advancePaymentProblem, proformaFromPayment } from '../services/advances'
import { isPayable } from '../services/documentType'
import React, { useState, useMemo, useEffect } from 'react'
import { supabase } from '../supabase'
import { matchesAmount } from '../services/amountSearch'
import { brand } from '../config/brand'
import { useCompanies } from '../contexts/CompaniesContext'
import { fetchScripts, saveScript, whyNotSavable } from '../services/quickFillStore'
import SplitEditor from './SplitEditor'
import {
  linesFrom, whySplitNotSavable, classificationFromSplit, splitProjectChange, type SplitLine,
} from '../services/expenseSplit'
import ProjectSelect from './ProjectSelect'
import { useProjects } from '../contexts/ProjectsContext'
import { projectLabelById } from '../services/projects'
import { saveSplits, loadSplits } from '../services/saveSplits'
import InlineCategoryAdd from './InlineCategoryAdd'

import CreditInstallmentSelector from './CreditInstallmentSelector'
import { useCreditPayment } from './useCreditPayment'
import { chooseAccount, carriedAccountOf } from '../services/partnerAccountChoice'
import { DIALOG, chrome } from './dialogTheme'
import SearchableSelect from './SearchableSelect'
import { REVENUE_STREAMS } from '../services/revenueStreams'
import { linkAmountsFromOwn } from '../services/invoiceLinks'
import { outstandingOwn, settlementFor } from '../services/settleInvoice'
import { planLinkChanges, describeChanges } from '../services/linkPlan'
import {
  allocationCurrency, commonCurrency, formatMoney, toRsd,
} from '../services/allocationDisplay'
import { differenceFor, entryNote, isBookable } from '../services/currencyDifference'
import {
  describeMismatches, mismatches, type Expectation, type Settlement,
} from '../services/settlementCheck'
import { orderedForDifference, findCurrencyDifference } from '../services/quickFillStore'
import { creditLegsFrom, creditNote, allocatePayment, type CreditLegs } from '../services/creditClassification'
import { CREDIT_ROLES } from '../services/systemCategories'
import { useSystemCategories } from '../contexts/SystemCategoriesContext'
import SystemCategoryNotice from './SystemCategoryNotice'
import { creditLegBooker } from '../services/creditPayment'
import { planSave, isCrossTableMove, type TxTable, type TxType } from '../services/transactionMove'
import { softDeleteRow } from '../services/writeOrder'
import { fetchAllPartners } from '../services/allPartners'
import {
  DOCUMENT_CURRENCIES, bookAmountsAtRate, getBookRates, partBookAmounts, partFromRsd, rateFor,
  type BookAmounts,
} from '../services/bookAmounts'
import { fmtMoney, fmtNum } from '../utils/formatters'
import {
  ADVANCE_BADGE_STYLE, ADVANCE_LABEL, doubleCountHint, effectiveAdvance, paymentSubtypeFor, whyAdvanceNotSavable,
} from '../services/advanceReceipt'
import { countOf } from '../utils/plural'

/** Display labels for the stored tag keys; the keys stay as they are in the data. */
const TAG_LABEL: Record<string, string> = {
  Recurring: 'Ponavljajući', Prepayment: 'Unapred plaćeno', Accrual: 'Razgraničenje',
  'Capital expenditure': 'Kapitalni izdatak', 'Tax deductible': 'Poreski priznat', Reimbursable: 'Refundacija',
}

interface Props {
  onClose: () => void
  transaction?: any
  /**
   * Which table `transaction` was read from.
   *
   * The type picker spans two tables, so the save cannot know whether it is
   * updating a row or moving one without being told where the row came from —
   * and the row's own columns do not say. Both callers fetch from
   * `transactions`, which is why that is the default, but the default is a
   * statement about them rather than a guess about the row: hand a
   * `passthrough` row to this dialog and you have to say so.
   */
  sourceTable?: TxTable
}

interface LinkedInvoice {
  invoice_id: string
  invoice_number: string
  partner_name: string
  invoice_date: string
  due_date: string
  currency: string
  amount: number
  /** The invoice's book figure and the stored rates it was booked at. */
  amount_rsd: number
  exchange_rate: number | null
  eur_rate: number | null
  /**
   * What the bill is owed IN ITS OWN CURRENCY, excluding this payment's link.
   *
   * The figure the settled/partial rule is decided on, so it is the figure
   * the field has to be judged against.
   */
  outstanding_own: number
  /**
   * The allocation in RSD at the invoice's stored rate, for the book totals.
   * Derived from what was settled; never the other way.
   */
  allocated_rsd: number
  /**
   * What the field shows, in the invoice's own currency, exactly as typed.
   *
   * Held rather than converted on each render: a field that rewrites a figure
   * after you leave it is how one gets corrected twice.
   */
  allocated_own: number
  /** The bill's project, so a currency difference on it lands on the same site. */
  project_id?: string | null
  /** 'expense' or 'revenue': which way the payment moves cash, and which way a currency difference goes. */
  type?: string | null
  /** A revenue billing's advance deducted, own currency: settled, but not by this or any payment. */
  advance_deducted?: number | null
}

interface ValidationErrors { [key: string]: string }


export default function TransactionDialog({ onClose, transaction, sourceTable = 'transactions' }: Props) {
  // The row being edited, and where it lives. Null on both counts for a new
  // transaction, which is an insert and can never be a move.
  const rowId: string | null = transaction?.id ?? null
  const rowTable: TxTable | null = rowId ? sourceTable : null
  const rowType: TxType | null = !rowId
    ? null
    : rowTable === 'passthrough'
      ? 'passthrough'
      : ((transaction.type as TxType) || 'direct')

  const [step, setStep] = useState(1)
  const [saving, setSaving] = useState(false)
  const [success, setSuccess] = useState(false)
  // Set only when the save moved the row between tables, so the confirmation
  // says what actually happened rather than "updated".
  const [movedTo, setMovedTo] = useState<TxTable | null>(null)
  const [errors, setErrors] = useState<ValidationErrors>({})
  const [touched, setTouched] = useState<Record<string, boolean>>({})
  const [showValidationSummary, setShowValidationSummary] = useState(false)
  const [postError, setPostError] = useState('')

  const { companies, defaultCompany, showPicker } = useCompanies()
  /** Where a credit instalment's two legs post — see services/systemCategories. */
  const systemCategories = useSystemCategories()
  const { projects } = useProjects()
  const [banks, setBanks] = useState<any[]>([])
  const [allBanks, setAllBanks] = useState<any[]>([])
  const [partners, setPartners] = useState<any[]>([])
  const [openInvoices, setOpenInvoices] = useState<any[]>([])
  const [plCategories, setPlCategories] = useState<any[]>([])
  const [plSubcategories, setPlSubcategories] = useState<any[]>([])
  const [departments, setDepartments] = useState<any[]>([])
  const [deptSubcategories, setDeptSubcategories] = useState<any[]>([])
  const [expenseDescriptions, setExpenseDescriptions] = useState<any[]>([])

  // Step 1
  const [companyId, setCompanyId] = useState('')

  // One company: it is the company, and nobody is asked to choose it.
  useEffect(() => {
    if (!showPicker && defaultCompany) setCompanyId(prev => prev || defaultCompany.id)
  }, [showPicker, defaultCompany])
  const [bankId, setBankId] = useState('')
  const [currency, setCurrency] = useState('')
  const [txDate, setTxDate] = useState(new Date().toISOString().split('T')[0])
  const [statement, setStatement] = useState('')
  const [partnerId, setPartnerId] = useState('')
  const [partnerSearch, setPartnerSearch] = useState('')
  const [newPartnerName, setNewPartnerName] = useState('')
  const [showNewPartner, setShowNewPartner] = useState(false)
  const [showBankFields, setShowBankFields] = useState(false)
  const [accNum, setAccNum] = useState('')
  const [model, setModel] = useState('')
  const [refNum, setRefNum] = useState('')
  const [partnerAccounts, setPartnerAccounts] = useState<any[]>([])
  const [selectedAccountId, setSelectedAccountId] = useState('')

  // Step 3
  const [txType, setTxType] = useState<'invoice_payment' | 'direct' | 'passthrough' | 'credit_payment'>('invoice_payment')
  const [ptDirection, setPtDirection] = useState<'in' | 'out'>('out')
  const [ptPeriodMonth, setPtPeriodMonth] = useState(new Date().toISOString().slice(0, 7))
  const [directSubtype, setDirectSubtype] = useState<'expense' | 'revenue'>('expense')
  // An advance received (avans): a direct revenue receipt on a project, not
  // revenue. Only kept while the row is a direct revenue receipt — see
  // services/advanceReceipt.ts.
  const [isAdvanceFlag, setIsAdvanceFlag] = useState<boolean>(!!transaction?.is_advance)
  const advance = effectiveAdvance(txType, directSubtype, isAdvanceFlag)
  const [linkedInvoices, setLinkedInvoices] = useState<LinkedInvoice[]>([])
  /**
   * The invoices this payment closed when the dialog opened.
   *
   * Kept apart from `linkedInvoices` because saving needs the difference, not
   * the result: an invoice removed from the list has a row to delete and a
   * status to put back, and neither is visible in what is on screen at the end.
   */
  const [originalLinkIds, setOriginalLinkIds] = useState<string[]>([])
  /** The same rows, so a released invoice can be named rather than counted. */
  const [originalLinks, setOriginalLinks] = useState<{ invoice_id: string; invoice_number: string }[]>([])
  const [linksLoading, setLinksLoading] = useState(false)
  /** What the save did to the links, shown on the success screen. */
  const [linkSummary, setLinkSummary] = useState('')
  /** Set when the database does not agree with what the dialog promised. */
  const [settlementWarning, setSettlementWarning] = useState('')
  /** Whether to book the leftover as a currency difference when posting. */
  const [bookDifference, setBookDifference] = useState(false)
  const [differenceScriptId, setDifferenceScriptId] = useState('')
  const [invoiceSearch, setInvoiceSearch] = useState('')

  // Credit payment
  const {
    credits, selectedCreditId, setSelectedCreditId,
    creditInstallments, selectedInstallmentIds,
    toggleInstallment, toggleAll: toggleAllInstallments,
    selectedTotal: creditSelectedTotal, selectedCurrency: creditCurrency, reset: resetCredit,
  } = useCreditPayment()

  const [plCatId, setPlCatId] = useState('')
  const [plCatName, setPlCatName] = useState('')
  const [plSubId, setPlSubId] = useState('')
  const [plSubName, setPlSubName] = useState('')
  const [deptId, setDeptId] = useState('')
  const [deptName, setDeptName] = useState('')
  const [deptSubId, setDeptSubId] = useState('')
  const [deptSubName, setDeptSubName] = useState('')
  const [expDesc, setExpDesc] = useState('')
  const [revStream, setRevStream] = useState('')
  // The site or building this payment belongs to; null is company overhead.
  // Null while the payment is split — the lines carry the projects then.
  const [projectId, setProjectId] = useState<string | null>(null)
  const [deptSplit, setDeptSplit] = useState('none')
  const [note, setNote] = useState('')
  const [tags, setTags] = useState<string[]>([])

  // Cash Flow Classification
  const [cfType, setCfType] = useState(transaction?.cf_type || '')
  const [cfFrequency, setCfFrequency] = useState(transaction?.cf_frequency || 'monthly')
  const [cfNextMonthEst, setCfNextMonthEst] = useState(transaction?.cf_next_month_est?.toString() || '')
  const [cfAccrualFrom, setCfAccrualFrom] = useState(transaction?.cf_accrual_from || '')
  const [cfAccrualTo, setCfAccrualTo] = useState(transaction?.cf_accrual_to || '')
  const [cfCapexMonths, setCfCapexMonths] = useState(transaction?.cf_capex_months?.toString() || '')
  const [cfReimbursableDate, setCfReimbursableDate] = useState(transaction?.cf_reimbursable_date || '')

  // ── Quick Fill Scripts ──────────────────────────────────────────────────
  interface QuickFillScript {
    id: string; name: string; icon: string
    pl_category: string; pl_subcategory: string
    department: string; dept_subcategory: string
    expense_description: string; cf_type: string
  }
  // Read from the shared table rather than from this browser — see
  // 20260922140000. Nothing is thrown when it cannot be read: a dialog whose
  // templates are missing is still one somebody can classify by hand in, and
  // taking it down over a shortcut would be the wrong trade.
  const [quickFillScripts, setQuickFillScripts] = useState<QuickFillScript[]>([])
  useEffect(() => { fetchScripts(supabase).then(setQuickFillScripts) }, [])
  const [qfSearch, setQfSearch] = useState('')
  const [qfOpen, setQfOpen] = useState(false)

  /** Naming a template made from what is on the form right now. */
  const [savingTemplate, setSavingTemplate] = useState(false)
  const [templateName, setTemplateName] = useState('')

  /**
   * The classification currently filled in, saved as a template.
   *
   * Stored as NAMES rather than ids, which is how a template is applied: the
   * dialogs look the names up again when they read one. An id would break the
   * moment a category is renamed, and a renamed category is exactly when the
   * template should still work.
   */
  const saveAsTemplate = async () => {
    const draft = {
      name: templateName,
      icon: '⚡',
      pl_category: plCatName || '',
      pl_subcategory: plSubName || '',
      department: deptName || '',
      dept_subcategory: deptSubName || '',
      expense_description: expDesc || '',
      cf_type: cfType || '',
    }
    const why = whyNotSavable(draft, quickFillScripts)
    if (why) { window.alert(why); return }
    const { ok, message } = await saveScript(supabase, draft)
    if (!ok) { window.alert(message); return }
    setQuickFillScripts(await fetchScripts(supabase) as QuickFillScript[])
    setTemplateName('')
    setSavingTemplate(false)
  }

  const applyQuickFill = (scriptId: string) => {
    const script = quickFillScripts.find(sc => sc.id === scriptId)
    if (!script) return
    const matchCat = plCategories.find(c => c.name === script.pl_category)
    const matchDept = departments.find(d => d.name === script.department)
    const matchSub = plSubcategories.find(s => s.name === script.pl_subcategory && s.category_id === matchCat?.id)
    const matchDeptSub = deptSubcategories.find(s => s.name === script.dept_subcategory && s.department_id === matchDept?.id)
    if (matchCat) { setPlCatId(matchCat.id); setPlCatName(matchCat.name) }
    if (matchSub) { setPlSubId(matchSub.id); setPlSubName(matchSub.name) }
    if (matchDept) { setDeptId(matchDept.id); setDeptName(matchDept.name) }
    if (matchDeptSub) { setDeptSubId(matchDeptSub.id); setDeptSubName(matchDeptSub.name) }
    setExpDesc(script.expense_description || '')
    setCfType(script.cf_type || '')
  }

  // Step 2
  const [amount, setAmount] = useState('')
  // RSD per 1 unit of `currency`, and RSD per 1 EUR — fetched from NBS or
  // typed by hand. On a EUR payment the two are the same number.
  const [exRate, setExRate] = useState('')
  const [eurRate, setEurRate] = useState('')
  const [isIndexed, setIsIndexed] = useState(false)
  const [rateSource, setRateSource] = useState('')
  const [rateMissing, setRateMissing] = useState(false)
  const [fetchingRate, setFetchingRate] = useState(false)

  // The four stored columns, from the rates in hand (bookAmountsAtRate, so a
  // hand-typed rate is booked exactly like a fetched one). A missing rate is
  // an error to show, never a figure to guess.
  const book: { amounts: BookAmounts | null; error: string } = (() => {
    const a = parseFloat(amount)
    if (!currency || !(a > 0)) return { amounts: null, error: '' }
    const own = currency === 'RSD' ? 1 : parseFloat(exRate)
    const eur = currency === 'EUR' ? parseFloat(exRate) : parseFloat(eurRate)
    try {
      return { amounts: bookAmountsAtRate(a, currency, own, eur), error: '' }
    } catch (err) {
      return { amounts: null, error: err instanceof Error ? err.message : String(err) }
    }
  })()
  const amountRsd = book.amounts?.amount_rsd ?? 0
  const amountEur = book.amounts?.amount_eur ?? 0
  /** This payment as a parent row: for its split lines and its own parts. */
  const paymentRow = {
    amount: parseFloat(amount) || 0,
    currency: currency || undefined,
    exchange_rate: book.amounts?.exchange_rate ?? null,
    eur_rate: book.amounts?.eur_rate ?? null,
    amount_rsd: book.amounts?.amount_rsd ?? null,
    amount_eur: book.amounts?.amount_eur ?? null,
  }

  /**
   * The costs this one payment is made of, where it is more than one.
   *
   * Empty means a single expense, classified by the fields below. A split does
   * not replace them: the transaction still carries a classification of its
   * own, which is what the cash side and the reconciliation read. It says what
   * the P&L should see instead.
   */
  const [splitLines, setSplitLines] = useState<SplitLine[]>([])

  useEffect(() => {
    if (!rowId) { setSplitLines([]); return }
    let cancelled = false
    loadSplits(supabase, 'transaction', rowId).then(rows => {
      if (!cancelled) setSplitLines(linesFrom(rows as any, n => `line-${n}`))
    })
    return () => { cancelled = true }
  }, [rowId])

  /**
   * Why the split cannot be posted, or null. Guards the button too.
   *
   * Only a direct transaction has one. Lines left over from before the type
   * was changed are not written and must not block the save either — a
   * payment refused because of a split it will not carry is a dead end with
   * nothing on screen to explain it.
   */
  const whySplit = txType === 'direct'
    ? whySplitNotSavable(paymentRow, splitLines)
    : null

  const splitActive = txType === 'direct' && splitLines.length > 0

  /** Lines changed in the editor: the project moves between the payment and
   *  its lines by one rule (splitProjectChange) — never on both at once. */
  const changeSplitLines = (next: SplitLine[]) => {
    const out = splitProjectChange(splitLines, next, projectId)
    setSplitLines(out.lines)
    setProjectId(out.parentProjectId)
  }

  /**
   * While a payment is split, its own classification is TAKEN from the split
   * rather than typed — the ledger lists it and the cash side reads it, but
   * two classifications on one screen, one of which the report ignores, is a
   * form that invites somebody to set the wrong one carefully.
   */
  useEffect(() => {
    const from = classificationFromSplit(splitLines)
    if (!from || txType !== 'direct') return
    setPlCatName(from.pl_category)
    setPlSubName(from.pl_subcategory)
    setDeptName(from.department)
    setDeptSubName(from.dept_subcategory)
    setExpDesc(from.expense_description)
    setPlCatId(plCategories.find(c => c.name === from.pl_category)?.id || '')
    setPlSubId(plSubcategories.find(c => c.name === from.pl_subcategory)?.id || '')
    setDeptId(departments.find(c => c.name === from.department)?.id || '')
    setDeptSubId(deptSubcategories.find(c => c.name === from.dept_subcategory)?.id || '')
  }, [splitLines, txType, plCategories, plSubcategories, departments, deptSubcategories])

  /** What is allocated, in RSD at each invoice's stored rate. */
  const totalAllocatedRsd = linkedInvoices.reduce((s, i) => s + (i.allocated_rsd || 0), 0)
  /** The same totals in the shared currency, when there is one to share. */
  const allocCurrency = commonCurrency(currency, linkedInvoices)
  const totalAllocatedOwn = linkedInvoices.reduce((s, i) => s + (i.allocated_own || 0), 0)
  const unallocatedOwn = (parseFloat(amount) || 0) - totalAllocatedOwn
  /** In RSD: the payment at its own rate, less the allocations at the invoices'. */
  const unallocatedRsd = amountRsd - totalAllocatedRsd

  const expenseCategories = plCategories.filter(c => c.type !== 'revenue')
  const getPlSubs = (catId: string) => plSubcategories.filter(s => s.category_id === catId)
  const getDeptSubs = (dId: string) => deptSubcategories.filter(s => s.department_id === dId)
  const getExpDescs = (subId: string) => expenseDescriptions.filter(e => e.dept_subcategory_id === subId)

  const currentPlSubs = getPlSubs(plCatId)
  const currentDeptSubs = getDeptSubs(deptId)
  const currentExpDescs = getExpDescs(deptSubId)

  const runValidation = () => {
    const e: ValidationErrors = {}
    if (!companyId) e.companyId = 'Firma je obavezna'
    if (!bankId) e.bankId = 'Banka je obavezna'
    if (!currency) e.currency = 'Valuta je obavezna'
    if (!txDate) e.txDate = 'Datum transakcije je obavezan'
    if (!amount || parseFloat(amount) <= 0) e.amount = 'Iznos mora biti veći od 0'
    if (currency && parseFloat(amount) > 0 && !book.amounts) e.exRate = book.error || 'Kurs je obavezan'
    if (txType === 'invoice_payment' && linkedInvoices.length === 0) e.linkedInvoices = 'Izaberite bar jednu fakturu koju plaćanje zatvara'
    if (txType === 'credit_payment' && selectedInstallmentIds.length === 0) e.creditInstallments = 'Izaberite bar jednu ratu'
    if (txType === 'direct') {
      if (directSubtype === 'expense') {
        // A split payment is classified by its lines, and the fields below
        // are filled from them. Demanding them again would refuse a payment
        // that is fully classified.
        if (!plCatId && !splitActive) e.plCat = 'P&L kategorija je obavezna'
        if (!deptId && !splitActive) e.dept = 'Sektor je obavezan'
      }
      if (directSubtype === 'revenue' && !revStream && !isAdvanceFlag) e.revStream = 'Vrsta prihoda je obavezna'
      const whyAdvance = whyAdvanceNotSavable({
        type: txType, subtype: directSubtype, isAdvance: isAdvanceFlag, projectId,
        splitLines: splitLines.length,
      })
      if (whyAdvance) e.advance = whyAdvance
    }
    return e
  }

  useEffect(() => {
    setErrors(runValidation())
  }, [companyId, bankId, currency, txDate, amount, exRate, eurRate, txType, linkedInvoices, selectedInstallmentIds, directSubtype, plCatId, deptId, revStream, isAdvanceFlag, projectId, splitLines]) // eslint-disable-line

  useEffect(() => {
    const load = async () => {
      const [
        { data: bnk }, part,
        { data: plCat }, { data: plSub },
        { data: dept }, { data: deptSub }, { data: expD },
      ] = await Promise.all([
        supabase.from('banks').select('*').order('name'),
        fetchAllPartners(supabase),
        supabase.from('pl_categories').select('id,name,type,sort_order').order('sort_order'),
        supabase.from('pl_subcategories').select('id,name,category_id,sort_order').order('sort_order'),
        supabase.from('departments').select('id,name,sort_order').order('sort_order'),
        supabase.from('dept_subcategories').select('id,name,department_id,sort_order').order('sort_order'),
        supabase.from('expense_descriptions').select('id,name,dept_subcategory_id,sort_order').order('sort_order'),
      ])
      if (bnk) setAllBanks(bnk)
      if (part) setPartners(part)
      if (plCat) setPlCategories(plCat)
      if (plSub) setPlSubcategories(plSub)
      if (dept) setDepartments(dept)
      if (deptSub) setDeptSubcategories(deptSub)
      if (expD) setExpenseDescriptions(expD)
    }
    load()
  }, [])

  useEffect(() => {
    if (companyId) {
      setBanks(allBanks.filter(b => b.company_id === companyId))
      if (!transaction) { setBankId(''); setCurrency('') }
    }
  }, [companyId, allBanks, transaction])

  useEffect(() => {
    if (!companyId) return
    const fetchOpenInvoices = async () => {
      const { data } = await supabase
        .from('v_invoice_status').select('*').eq('company_id', companyId)
        .in('calculated_status', ['unpaid', 'partial', 'overpaid'])
        .order('due_date', { ascending: true })
      // A credit or debit note is settled through its bill, never by a payment.
      if (data) setOpenInvoices(data.filter((i: any) => isPayable(i.document_type ?? 'invoice')))
      // Advance invoices booked before their payment: this payment can pay one.
      const { data: adv } = await supabase.from('v_invoice_status').select('*').eq('company_id', companyId)
        .eq('document_type', 'advance_invoice').eq('unlinked', true)
      setUnlinkedAdvances((adv || []).filter((a: any) => a.unlinked))
    }
    fetchOpenInvoices()
  }, [companyId])

  /**
   * The partner's accounts, and which one this record is talking about.
   *
   * THE DEFAULT IS OFFERED, NEVER IMPOSED. This effect is keyed on the
   * partner, and opening a saved record SETS the partner — so it fires on
   * every open, resolves after the record has been read into the form, and
   * used to overwrite the account with the partner's primary one.
   *
   * That was not a display fault. The overwritten number is what the next save
   * wrote back, so opening a bill to correct a date moved it to a different
   * account, and the payment-order export — which rightly trusts the number on
   * the invoice — exported it. See `chooseAccount`, where the rule lives.
   */
  useEffect(() => {
    if (!partnerId) { setPartnerAccounts([]); setSelectedAccountId(''); return }
    let cancelled = false
    const load = async () => {
      const { data } = await supabase
        .from('partner_accounts').select('*').eq('partner_id', partnerId).eq('currency', 'RSD')
        .order('is_primary', { ascending: false })
      if (cancelled) return
      const accounts = data || []
      setPartnerAccounts(accounts)

      const carried = carriedAccountOf(transaction, partnerId)

      const chosen = chooseAccount(accounts, carried)
      if (!chosen) { setSelectedAccountId(''); return }

      setSelectedAccountId(chosen.accountId)
      setAccNum(chosen.accountNumber)
      setModel(chosen.model)
      setShowBankFields(true)

      if (!carried) {
        const fallback = accounts.find((a: any) => a.is_primary) || accounts[0]
        if (fallback?.reference_number) {
          setRefNum((prev: string) => prev || fallback.reference_number || '')
        }
      }
    }
    load()
    return () => { cancelled = true }
  }, [partnerId, transaction]) // eslint-disable-line

  useEffect(() => {
    if (!transaction) return
    setCompanyId(transaction.company_id || '')
    setBankId(transaction.bank_id || '')
    setCurrency(transaction.currency || '')
    setStatement(transaction.statement_number || '')
    setTxDate(transaction.transaction_date || '')
    setPartnerId(transaction.partner_id || '')
    setPartnerSearch(transaction.partners?.name || '')
    // A pass-through row has no `type` column — the table it is in is its type.
    setTxType(rowType || 'invoice_payment')
    setPtDirection(transaction.direction === 'in' ? 'in' : 'out')
    if (transaction.period_month || transaction.transaction_date)
      setPtPeriodMonth(String(transaction.period_month || transaction.transaction_date).slice(0, 7))
    setDirectSubtype(transaction.tx_subtype || 'expense')
    setIsAdvanceFlag(!!transaction.is_advance)
    setNote(transaction.note || '')
    setAmount(transaction.amount?.toString() || '')
    setExRate(transaction.exchange_rate?.toString() || '')
    setEurRate(transaction.eur_rate?.toString() || '')
    setIsIndexed(transaction.is_indexed || false)
    setPlCatName(transaction.pl_category || '')
    setPlSubName(transaction.pl_subcategory || '')
    setDeptName(transaction.department || '')
    setDeptSubName(transaction.dept_subcategory || '')
    setExpDesc(transaction.expense_description || '')
    setRevStream(transaction.revenue_stream || '')
    setProjectId(transaction.project_id ?? null)
    setDeptSplit(transaction.dept_split_type || 'none')
    setTags(transaction.tags || [])
    setAccNum(transaction.account_number || '')
    setModel(transaction.model || '')
    setRefNum(transaction.reference_number || '')
    setCfType(transaction.cf_type || '')
    setCfFrequency(transaction.cf_frequency || 'monthly')
    setCfNextMonthEst(transaction.cf_next_month_est?.toString() || '')
    setCfAccrualFrom(transaction.cf_accrual_from || '')
    setCfAccrualTo(transaction.cf_accrual_to || '')
    setCfCapexMonths(transaction.cf_capex_months?.toString() || '')
    setCfReimbursableDate(transaction.cf_reimbursable_date || '')
  }, [transaction, rowType])

  useEffect(() => {
    if (transaction && plCategories.length > 0) {
      const cat = plCategories.find(c => c.name === transaction.pl_category)
      if (cat) setPlCatId(cat.id)
    }
  }, [transaction, plCategories])
  useEffect(() => {
    if (transaction && plSubcategories.length > 0 && plCatId) {
      const sub = plSubcategories.find(s => s.name === transaction.pl_subcategory && s.category_id === plCatId)
      if (sub) setPlSubId(sub.id)
    }
  }, [transaction, plSubcategories, plCatId])
  useEffect(() => {
    if (transaction && departments.length > 0) {
      const dept = departments.find(d => d.name === transaction.department)
      if (dept) setDeptId(dept.id)
    }
  }, [transaction, departments])
  useEffect(() => {
    if (transaction && deptSubcategories.length > 0 && deptId) {
      const sub = deptSubcategories.find(s => s.name === transaction.dept_subcategory && s.department_id === deptId)
      if (sub) setDeptSubId(sub.id)
    }
  }, [transaction, deptSubcategories, deptId])

  const filteredPartners = partners.filter(p =>
    !partnerSearch || p.name.toLowerCase().includes(partnerSearch.toLowerCase())
  )
  const filteredOpenInvoices = openInvoices.filter(inv => {
    if (!invoiceSearch) return true
    return (inv.partner_name || '').toLowerCase().includes(invoiceSearch.toLowerCase()) ||
      (inv.invoice_number || '').toLowerCase().includes(invoiceSearch.toLowerCase()) ||
      matchesAmount(invoiceSearch, inv.amount, inv.amount_rsd, inv.remaining_rsd)
  })

  const touch = (field: string) => setTouched(prev => ({ ...prev, [field]: true }))
  const fieldErr = (field: string) => touched[field] ? errors[field] : undefined
  const totalErrors = Object.keys(errors).length
  const isValid = totalErrors === 0

  const touchStep = (n: number) => {
    if (n === 1) setTouched(p => ({ ...p, companyId: true, bankId: true, currency: true, txDate: true }))
    if (n === 2) setTouched(p => ({ ...p, amount: true, exRate: true }))
    if (n === 3) setTouched(p => ({ ...p, linkedInvoices: true, creditInstallments: true, plCat: true, dept: true, revStream: true, advance: true }))
  }
  const stepHasError = (n: number) => {
    const stepFields: Record<number, string[]> = {
      1: ['companyId', 'bankId', 'currency', 'txDate'],
      2: ['amount', 'exRate'],
      3: ['linkedInvoices', 'creditInstallments', 'plCat', 'dept', 'revStream', 'advance'],
    }
    return (stepFields[n] || []).some(f => !!errors[f])
  }

  // ── What this payment already closes ────────────────────────────────────
  //
  // The dialog used to open with an empty list however many invoices the
  // payment was against, so editing one meant guessing what it had been. The
  // links are read back with the invoice they point at, and the ids are kept
  // separately as the starting point to compare against on save.
  useEffect(() => {
    if (!rowId || rowTable !== 'transactions') return
    let cancelled = false
    const load = async () => {
      setLinksLoading(true)
      const { data, error } = await supabase
        .from('invoice_transaction_links')
        .select('invoice_id, allocated_amount, allocated_amount_rsd, invoices(id, invoice_number, invoice_date, due_date, currency, amount, amount_rsd, exchange_rate, eur_rate, project_id, type, advance_deducted, partners(name))')
        .eq('transaction_id', rowId)
      // What is actually left on each of them. The invoice's own amount is not
      // that: a partly paid invoice would show its full value as outstanding,
      // at the exact moment someone is deciding how much to allocate.
      const ids = (data || []).map((l: any) => l.invoice_id)
      const { data: statuses } = ids.length > 0
        ? await supabase.from('v_invoice_status').select('id, amount, paid_amount').in('id', ids)
        : { data: [] as any[] }
      // `paid_amount` is the view's sum of `allocated_amount` — the invoice's
      // own currency, and the column the settled/partial rule reads. The
      // book remainder beside it cannot answer the same question: it carries
      // the rates of every payment that went against the bill.
      const paidById = new Map<string, number>((statuses || []).map((r: any) => [r.id, r.paid_amount || 0]))
      if (cancelled) { return }
      if (error) {
        // Not fatal: the payment can still be edited. But it must not look as
        // though it closes nothing, which is the state this whole effect
        // exists to stop.
        setPostError(`Fakture koje ovo plaćanje zatvara nisu mogle da se učitaju: ${error.message}`)
        setLinksLoading(false)
        return
      }
      const rows = (data || []).map((l: any) => ({
        invoice_id: l.invoice_id,
        invoice_number: l.invoices?.invoice_number || '—',
        partner_name: l.invoices?.partners?.name || '—',
        invoice_date: l.invoices?.invoice_date,
        due_date: l.invoices?.due_date,
        currency: l.invoices?.currency,
        amount: l.invoices?.amount,
        amount_rsd: l.invoices?.amount_rsd,
        exchange_rate: l.invoices?.exchange_rate ?? null,
        eur_rate: l.invoices?.eur_rate ?? null,
        project_id: l.invoices?.project_id ?? null,
        type: l.invoices?.type ?? null,
        advance_deducted: Number(l.invoices?.advance_deducted) || 0,
        // What the bill is owed with this payment's own link taken back out,
        // which is what the figure beside it has to be judged against.
        outstanding_own: outstandingOwn({
          currency: l.invoices?.currency,
          amount: l.invoices?.amount,
          paid_amount: (paidById.get(l.invoice_id) ?? 0) - (l.allocated_amount || 0),
          advance_deducted: l.invoices?.advance_deducted,
        }),
        allocated_rsd: l.allocated_amount_rsd || 0,
        // What the field shows and the user edits, in the invoice's own
        // currency — READ STRAIGHT OUT OF THE COLUMN that holds it. Seeding it
        // from the book column instead would put a round trip in on every reopen.
        allocated_own: l.allocated_amount || 0,
      }))
      setLinkedInvoices(rows as any)
      setOriginalLinkIds(rows.map(r => r.invoice_id))
      setOriginalLinks(rows.map(r => ({ invoice_id: r.invoice_id, invoice_number: r.invoice_number })))
      setLinksLoading(false)
    }
    load()
    return () => { cancelled = true }
  }, [rowId, rowTable])

  // ── The currency difference ─────────────────────────────────────────────
  //
  // An invoice in (or indexed to) a foreign currency is booked at one rate
  // and settled at another, so in RSD it never lands exactly. What is left —
  // in RSD, the book currency both sides share — is worked out in
  // services/currencyDifference.ts, which also decides which way it goes and
  // whether it has to be linked to close the invoice.
  //
  // Offered only when the payment closes ONE invoice. With several, which of
  // them the difference belongs to is a judgement, and guessing it would put a
  // figure in the P&L against a bill nobody chose.
  // The dialog already reads the templates; this only reorders them so the
  // currency-difference one is the obvious choice.
  const fxScripts = useMemo(() => orderedForDifference(quickFillScripts), [quickFillScripts])
  const fxInvoice = linkedInvoices.length === 1 ? linkedInvoices[0] : null
  // The shortfall is asked in the invoice's own currency and converted to RSD
  // at the invoice's rate, not read off the book remainder. Read off the
  // book, a euro payment that settled a euro bill to the cent would still
  // show a gap — the rate had moved between the two dates — and the dialog
  // would offer to book it as a gain.
  const fxShortfallOwn = fxInvoice
    ? Math.round(((fxInvoice.outstanding_own || 0) - (fxInvoice.allocated_own || 0)) * 100) / 100
    : 0
  const fxShortfallRsd = fxInvoice ? toRsd(Math.max(0, fxShortfallOwn), fxInvoice) : 0
  const fxDifference = differenceFor({
    invoiceShortfall: fxShortfallRsd,
    // A surplus is the payment at its own rate less the allocations at the
    // invoice's. Only meaningful in a currency other than the bill's: a
    // same-currency surplus is an unallocated part, not a rate difference.
    paymentUnallocated: fxInvoice ? unallocatedRsd : 0,
    currency: 'RSD',
    // A receipt short of a revenue billing is a loss, not a gain.
    invoiceType: fxInvoice?.type ?? null,
  })
  /** The same figure in the currency the created entry will carry. */
  const fxAmountOwn = (() => {
    if (!fxInvoice) return 0
    // The linked side IS the rest of the bill, to the cent, in the bill's
    // currency — a gain on a supplier's bill, a loss on a revenue billing.
    if (fxDifference.linksToInvoice) return Math.max(0, fxShortfallOwn)
    // A loss is part of this bank line, in the payment's currency at its rate.
    try {
      return partFromRsd(fxDifference.amount, paymentRow).amount
    } catch {
      return 0
    }
  })()
  const fxCurrency = !fxInvoice ? currency
    : fxDifference.linksToInvoice ? allocationCurrency(fxInvoice) : currency
  const fxScript = fxScripts.find(sc => sc.id === differenceScriptId)
    || findCurrencyDifference(fxScripts)

  /** Invoices this payment closed that are no longer on the list. */
  const releasing = originalLinks.filter(o => !linkedInvoices.some(l => l.invoice_id === o.invoice_id))

  const isInvoiceLinked = (id: string) => linkedInvoices.some(l => l.invoice_id === id)
  /**
   * What ticking an invoice should put in the field.
   *
   * IN THE CURRENCY OF THE BILL. A dinar payment against a dinar bill needs
   * no rate at all: it pays what it pays, up to what is owed. Routing it
   * through the book currency compared the payment date's rate against the invoice
   * date's and left the bill short by whatever had moved between them — a
   * remainder that then offered itself as a currency difference, though
   * dinars had settled a dinar bill in full.
   */
  /** Why a proforma could not be made from this payment. */
  const [proformaWhy, setProformaWhy] = useState('')
  /** A proforma proposed from this payment, written when the payment is posted. */
  const [pendingProforma, setPendingProforma] = useState<Record<string, unknown> | null>(null)
  /** Advance invoices with no proforma yet, and the one this payment pays. */
  const [unlinkedAdvances, setUnlinkedAdvances] = useState<any[]>([])
  const [paysAdvance, setPaysAdvance] = useState<{ id: string; amount: number; invoice_number: string | null } | null>(null)

  /**
   * Money released to a supplier with no proforma: the proforma is PROPOSED
   * here and written only when the payment is saved (a cancelled payment
   * leaves nothing payable behind). Until then it stands in the list of open
   * documents under a placeholder id.
   */
  const makeProformaFrom = async (advance?: any) => {
    if (linkedInvoices.some(l => l.invoice_id === 'pending-proforma')) return
    const left = Math.max(0, (parseFloat(amount) || 0) - totalAllocatedOwn)
    if (advance) {
      const why = advancePaymentProblem(left, { invoice_number: advance.invoice_number, amount: Number(advance.amount) || 0, currency: advance.currency }, currency || 'RSD')
      if (why) { setProformaWhy(why); return }
    }
    let eurRate: number | null = null
    try { eurRate = (await getBookRates(txDate)).eurRate } catch { eurRate = null }
    const made = proformaFromPayment({
      companyId: companyId || null, partnerId: advance?.partner_id || partnerId || null, date: txDate,
      amount: left, currency: currency || 'RSD',
      accountNumber: accNum || null, description: note || null, eurRate,
      forAdvance: advance ? (advance.invoice_number || 'bez broja') : null,
    })
    if (!made.ok) { setProformaWhy(made.why); return }
    const r = made.row as any
    const placeholder = {
      ...r, id: 'pending-proforma', invoice_number: 'Novi predračun',
      partner_name: partners.find((p: any) => p.id === partnerId)?.name || '—',
      paid_amount: 0, remaining_rsd: r.amount_rsd, remaining_eur: r.amount_eur, calculated_status: 'unpaid',
      advance_deducted: 0, adjustments: 0, advance_used: 0,
    }
    setPendingProforma(made.row)
    setPaysAdvance(advance ? { id: advance.id, amount: Number(advance.amount) || 0, invoice_number: advance.invoice_number } : null)
    setProformaWhy('')
    setOpenInvoices(prev => [...prev.filter(i => i.id !== 'pending-proforma'), placeholder])
    addInvoiceLink(placeholder)
  }

  const addInvoiceLink = (inv: any) => {
    if (isInvoiceLinked(inv.id)) return
    const outstanding = outstandingOwn(inv)
    let settlement: ReturnType<typeof settlementFor>
    try {
      settlement = settlementFor({
        invoice: inv,
        paymentCurrency: currency,
        paymentOwn: Math.max(0, (parseFloat(amount) || 0) - totalAllocatedOwn),
        paymentRsd: Math.max(0, amountRsd - totalAllocatedRsd),
      })
    } catch (err) {
      // RateUnavailableError: the invoice carries no stored rate, so its
      // allocation cannot be booked. Say so rather than guess.
      setPostError(err instanceof Error ? err.message : String(err))
      return
    }
    setLinkedInvoices(prev => [...prev, {
      invoice_id: inv.id, invoice_number: inv.invoice_number || '—',
      partner_name: inv.partner_name || '—', invoice_date: inv.invoice_date,
      due_date: inv.due_date, currency: inv.currency, amount: inv.amount,
      amount_rsd: inv.amount_rsd,
      exchange_rate: inv.exchange_rate ?? null,
      eur_rate: inv.eur_rate ?? null,
      project_id: inv.project_id ?? null,
      type: inv.type ?? null,
      advance_deducted: Number(inv.advance_deducted) || 0,
      outstanding_own: outstanding,
      allocated_rsd: settlement.rsd,
      allocated_own: settlement.own,
    }])
    touch('linkedInvoices')
  }
  const removeInvoiceLink = (invId: string) => setLinkedInvoices(prev => prev.filter(l => l.invoice_id !== invId))
  /**
   * The user types in the invoice's currency; the dinars follow.
   *
   * `allocated_own` is what the field shows, so it is stored exactly as
   * entered. `allocated_rsd` is derived here, at the invoice's rate, for the
   * running totals. Deriving the other way would redisplay a figure altered.
   */
  const updateAllocated = (invId: string, own: number) => setLinkedInvoices(prev =>
    prev.map(l => l.invoice_id === invId
      ? { ...l, allocated_own: own, allocated_rsd: toRsd(own, l) }
      : l))
  const handleAccountSelect = (accountId: string) => {
    setSelectedAccountId(accountId)
    const acc = partnerAccounts.find((a: any) => a.id === accountId)
    if (acc) { setAccNum(acc.account_number || ''); setModel(acc.model || '') }
  }

  // Both NBS rates for the transaction date. An RSD payment still needs the
  // EUR rate, for amount_eur.
  const fetchRate = async () => {
    if (!currency) return
    setFetchingRate(true)
    try {
      const rates = await getBookRates(txDate)
      setExRate(String(rateFor(currency, rates)))
      setEurRate(String(rates.eurRate))
      setRateSource(rates.source)
      setRateMissing(false)
    } catch (err) {
      // RateUnavailableError, in its own words. Nothing is guessed; the
      // person can retry or type the rate.
      setRateSource(err instanceof Error ? `${err.message} — unesite ga ručno` : 'Nema zvaničnog kursa — unesite ga ručno')
      setRateMissing(true)
    }
    setFetchingRate(false)
  }

  const toggleTag = (t: string) => setTags(prev => prev.includes(t) ? prev.filter(x => x !== t) : [...prev, t])

  const stepTitles = ['Osnovni podaci', 'Iznos i valuta', 'Tip i klasifikacija', 'Pregled']

  const getStatusStyle = (status: string): React.CSSProperties => {
    const map: Record<string, React.CSSProperties> = {
      unpaid: { background: DIALOG.redFill, color: DIALOG.red },
      partial: { background: DIALOG.amberFill, color: DIALOG.amber },
      paid: { background: DIALOG.accentFill, color: DIALOG.accent },
      reconciled: { background: DIALOG.raised, color: DIALOG.dim },
    }
    return map[status] || { background: DIALOG.raised, color: DIALOG.dim }
  }

  const cfLabel = () => {
    if (!cfType) return '—'
    if (cfType === 'recurring') return `Ponavljajući, ${cfFrequency === 'monthly' ? 'mesečno' : cfFrequency === 'quarterly' ? 'kvartalno' : cfFrequency === 'yearly' ? 'godišnje' : cfFrequency}`
    if (cfType === 'one_time') return 'Jednokratni'
    if (cfType === 'accrual') return `Razgraničenje ${cfAccrualFrom ? `${cfAccrualFrom} → ${cfAccrualTo}` : ''}`
    if (cfType === 'capex') return `Kapitalni izdatak (${cfCapexMonths || '?'} mes.)`
    if (cfType === 'reimbursable') return `Refundacija${cfReimbursableDate ? ` do ${cfReimbursableDate}` : ''}`
    return '—'
  }

  const handlePost = async () => {
    // A refusal that does not depend on the form's contents comes before the
    // form is judged. Telling someone to pick an instalment on a row that may
    // not be saved at all is an answer to a question they did not ask.
    const upFront = planSave({ rowId, sourceTable: rowTable, currentType: rowType, nextType: txType })
    if (upFront.kind === 'refuse') { setShowValidationSummary(false); setPostError(upFront.reason); return }

    setTouched({ companyId: true, bankId: true, currency: true, txDate: true, linkedInvoices: true, plCat: true, dept: true, revStream: true, amount: true, exRate: true, advance: true })
    const e = runValidation()
    if (Object.keys(e).length > 0) { setShowValidationSummary(true); return }
    setPostError('')

    // ── Which table is this save actually writing to? ─────────────────────
    //
    // The type picker spans `transactions` and `passthrough`, so changing the
    // type can change the table. Until this check existed, a row moved across
    // was UPDATEd in the table it was moving to, by an id that table does not
    // hold — zero rows changed, and PostgREST calls that a success.
    //
    // Anything that would leave a reference dangling is refused here, before a
    // single row is written.
    let links = 0
    let instalments = 0
    if (rowTable === 'transactions' && isCrossTableMove({ rowId, sourceTable: rowTable, nextType: txType })) {
      const [linkRes, instRes] = await Promise.all([
        supabase.from('invoice_transaction_links')
          .select('invoice_id', { count: 'exact', head: true }).eq('transaction_id', rowId),
        supabase.from('credit_installments')
          .select('id', { count: 'exact', head: true }).eq('transaction_id', rowId),
      ])
      const checkErr = linkRes.error || instRes.error
      if (checkErr) {
        setPostError(`Nije moguće proveriti da li ova transakcija sme da se premesti: ${checkErr.message}. Ništa nije promenjeno.`)
        return
      }
      links = linkRes.count ?? 0
      instalments = instRes.count ?? 0
    }

    const plan = planSave({
      rowId, sourceTable: rowTable, currentType: rowType, nextType: txType,
      invoiceLinkCount: links, settledInstallmentCount: instalments,
    })
    if (plan.kind === 'refuse') { setPostError(plan.reason); return }

    // The book columns of the payment, checked BEFORE anything is written. A
    // credit's instalments are in the credit's own currency (RSD or EUR), and
    // the payment's stored figure in that currency is what they are paid
    // down by — see services/creditPayment.ts.
    const booked = book.amounts
    if (!booked) {
      setPostError(`${book.error || 'Kurs je obavezan'}. Ništa nije proknjiženo.`)
      return
    }
    let creditLegs: ReturnType<typeof creditLegBooker> | null = null
    // The two legs' headings, before anything is written: unset, the payment
    // is refused rather than booked under no heading.
    let creditHeads: CreditLegs | null = null
    if (txType === 'credit_payment') {
      const credit = credits.find(c => c.id === selectedCreditId)
      try {
        creditHeads = creditLegsFrom(systemCategories.map)
      } catch (err: any) {
        setPostError(`${err.message} Ništa nije proknjiženo.`)
        return
      }
      try {
        creditLegs = creditLegBooker(credit?.currency, booked, credit?.name)
      } catch (err: any) {
        setPostError(`${err.message}. Ništa nije proknjiženo.`)
        return
      }
    }

    setSaving(true)
    try {
      let finalPartnerId = partnerId
      if (showNewPartner && newPartnerName) {
        const { data: newP, error: partnerErr } = await supabase.from('partners').insert({ name: newPartnerName }).select().single()
        if (partnerErr) throw partnerErr
        if (newP) finalPartnerId = newP.id
      }
      const isDirectWithPL = txType === 'direct'
      // An advance is a direct revenue receipt, but cash and a liability —
      // never P&L (CHECK transactions_advance_shape).
      const plImpact = isDirectWithPL && !advance

      const payload = {
        company_id: companyId || null, bank_id: bankId || null,
        partner_id: finalPartnerId || null, transaction_date: txDate,
        statement_number: statement || null, type: txType,
        // An invoice payment carries the side of the invoices it settles:
        // the cash line reads a receipt against a revenue billing as an
        // inflow by it (cashTimeline.cashDirection).
        tx_subtype: txType === 'direct' ? directSubtype
          : txType === 'invoice_payment' ? paymentSubtypeFor(linkedInvoices.map(l => l.type)) : null,
        is_advance: advance,
        currency, amount: parseFloat(amount),
        exchange_rate: booked.exchange_rate, eur_rate: booked.eur_rate,
        amount_rsd: booked.amount_rsd, amount_eur: booked.amount_eur,
        is_indexed: isIndexed, pl_impact: plImpact,
        pl_category: isDirectWithPL ? (plCatName || null) : null,
        pl_subcategory: isDirectWithPL ? (plSubName || null) : null,
        department: isDirectWithPL ? (deptName || null) : null,
        dept_subcategory: isDirectWithPL ? (deptSubName || null) : null,
        expense_description: isDirectWithPL ? (expDesc || null) : null,
        revenue_stream: isDirectWithPL ? (revStream || null) : null,
        // Only a direct row has a P&L of its own to put on a project (an
        // invoice payment's project is the invoice's), and a split row's
        // projects are on its lines.
        project_id: isDirectWithPL && !splitActive ? projectId : null,
        dept_split_type: deptSplit,
        cf_type: isDirectWithPL && directSubtype === 'expense' ? (cfType || null) : null,
        cf_frequency: cfType === 'recurring' ? cfFrequency : null,
        cf_next_month_est: cfType === 'recurring' ? (cfNextMonthEst ? parseFloat(cfNextMonthEst) : (amount ? parseFloat(amount) : null)) : null,
        cf_accrual_from: cfType === 'accrual' ? (cfAccrualFrom || null) : null,
        cf_accrual_to: cfType === 'accrual' ? (cfAccrualTo || null) : null,
        cf_capex_months: cfType === 'capex' ? (cfCapexMonths ? parseInt(cfCapexMonths) : null) : null,
        cf_reimbursable_date: cfType === 'reimbursable' ? (cfReimbursableDate || null) : null,
        account_number: accNum || null, model: model || null,
        reference_number: refNum || null, note: note || null,
        tags: tags.length > 0 ? tags : null, status: 'posted',
      }

      if (txType === 'passthrough') {
        // ── Pass-through ──────────────────────────────────────────────────────
        const ptPayload = {
          company_id: companyId || null, bank_id: bankId || null,
          partner_id: finalPartnerId || null, transaction_date: txDate,
          direction: ptDirection, period_month: ptPeriodMonth || null,
          currency, amount: parseFloat(amount),
          exchange_rate: booked.exchange_rate, eur_rate: booked.eur_rate,
          amount_rsd: booked.amount_rsd, amount_eur: booked.amount_eur,
          note: note || null, status: 'unpaired',
          account_number: accNum || null, model: model || null, reference_number: refNum || null,
        }
        if (plan.kind === 'move') {
          // Out of `transactions` and into `passthrough`. Insert first, then
          // soft-delete the source: the other order leaves a window with no
          // row at all, and this one leaves at worst a duplicate we can still
          // take back. If the soft-delete fails the money would be counted
          // twice, so the insert is undone and nothing is reported as saved.
          const { data: moved, error: insErr } = await supabase
            .from('passthrough').insert(ptPayload).select('id').single()
          if (insErr) throw insErr

          // Through the database. An update from here is refused outright:
          // the restrictive hide-deleted policy is checked against the NEW
          // row, and setting `deleted_at` is what makes it fail. See
          // 20260921090000.
          if (!rowId) throw new Error('Ova stavka nema ID, pa ne može da se premesti.')
          const del = await softDeleteRow(supabase, 'transactions', rowId)
          const delErr = del.ok ? null : { message: del.message }
          if (delErr) {
            const { error: undoErr } = await supabase.from('passthrough').delete().eq('id', moved.id)
            throw new Error(undoErr
              ? `Prolazna stavka je napravljena, ali originalna transakcija nije mogla da se ukloni (${delErr.message}), `
                + `a ni nova stavka nije mogla da se povuče (${undoErr.message}). `
                + `Iznos je sada evidentiran dva puta — prolaznu stavku ${moved.id} treba ručno obrisati.`
              : `Originalna transakcija nije mogla da se ukloni (${delErr.message}). `
                + 'Prolazna stavka je povučena — ništa nije promenjeno.')
          }
        } else if (plan.kind === 'update') {
          const { data: updated, error: ptErr } = await supabase
            .from('passthrough').update(ptPayload).eq('id', rowId).select('id')
          if (ptErr) throw ptErr
          if (!updated || updated.length === 0)
            throw new Error(`Prolazna stavka ${rowId} nije izmenjena — ništa nije sačuvano.`)
        } else {
          const { error: ptErr } = await supabase.from('passthrough').insert(ptPayload)
          if (ptErr) throw ptErr
        }

      } else if (txType === 'credit_payment') {
        // ── Credit payment ────────────────────────────────────────────────────
        // Instalments are in the credit's own currency. The payment covers its
        // stored figure in that currency, and each leg is a row in that
        // currency at the payment's rates, the last leg taking the rounding —
        // services/creditPayment.ts.
        if (!creditLegs) throw new Error('Otplata kredita nije pripremljena — ništa nije proknjiženo.')
        const legs = creditLegs
        const creditName = credits.find(c => c.id === selectedCreditId)?.name || 'Kredit'
        let remaining = legs.payable

        // Sort selected installments by due_date (oldest first)
        const sortedInstIds = [...selectedInstallmentIds].sort((a, b) => {
          const ia = creditInstallments.find(i => i.id === a)
          const ib = creditInstallments.find(i => i.id === b)
          return (ia?.due_date || '').localeCompare(ib?.due_date || '')
        })

        // Fetch next outstanding installments for overflow
        const { data: nextInsts, error: nextErr } = await supabase
          .from('credit_installments')
          .select('id, installment_no, due_date, principal_amount, interest_amount, total_amount, status, paid_amount')
          .eq('credit_id', selectedCreditId)
          .eq('status', 'outstanding')
          .order('due_date')
        if (nextErr) throw nextErr

        // Build full ordered list: selected first (sorted), then remaining for overflow
        const selectedSet = new Set(sortedInstIds)
        const overflowIds = (nextInsts || [])
          .filter(i => !selectedSet.has(i.id))
          .map(i => i.id)
        const allInstIds = [...sortedInstIds, ...overflowIds]

        for (const instId of allInstIds) {
          if (remaining <= 0.01) break

          // Get installment data
          const inst = creditInstallments.find(i => i.id === instId)
            || (nextInsts || []).find(i => i.id === instId)
          if (!inst) continue

          // Account for already paid amount (partial from previous payment)
          const alreadyPaid = inst.paid_amount || 0
          const remainingPrincipal = Math.max(0, inst.principal_amount - alreadyPaid)
          const remainingInterest = Math.max(0, inst.interest_amount - Math.max(0, alreadyPaid - inst.principal_amount))
          const remainingTotal = remainingPrincipal + remainingInterest

          if (remainingTotal <= 0.01) continue  // already fully paid

          let instPaid = 0
          const firstTxId: string[] = []

          // Which leg this payment is. Satisfying principal first put an
          // interest-only line on principal and pushed the tail of the
          // principal line onto interest — the two crossed over and, because
          // they were equal, the totals hid it.
          const legSplit = allocatePayment(remaining, remainingPrincipal, remainingInterest)

          // 1. Principal → system category credit_principal
          if (legSplit.principal > 0) {
            const paidPrincipal = legSplit.principal
            const principalMoney = legs.book(paidPrincipal)
            remaining -= paidPrincipal
            instPaid  += paidPrincipal

            const { data: txP, error: txPErr } = await supabase.from('transactions').insert({
              company_id: companyId || null,
              bank_id: bankId || null,
              partner_id: finalPartnerId || null,
              transaction_date: txDate,
              statement_number: statement || null,
              type: 'credit_payment',
              tx_subtype: 'expense',
              ...principalMoney,
              pl_impact: true,
              ...creditHeads!.principal,
              cf_type: 'recurring',
              cf_frequency: 'monthly',
              note: creditNote('principal', creditName, inst.installment_no, paidPrincipal, note, legs.currency),
              status: 'posted',
            }).select('id').single()
            if (txPErr) throw txPErr
            if (txP?.id) firstTxId.push(txP.id)
          }

          // 2. Interest → system category credit_interest
          if (legSplit.interest > 0) {
            const paidInterest = legSplit.interest
            const interestMoney = legs.book(paidInterest)
            remaining -= paidInterest
            instPaid  += paidInterest

            const { error: txIErr } = await supabase.from('transactions').insert({
              company_id: companyId || null,
              bank_id: bankId || null,
              partner_id: finalPartnerId || null,
              transaction_date: txDate,
              statement_number: statement || null,
              type: 'credit_payment',
              tx_subtype: 'expense',
              ...interestMoney,
              pl_impact: true,
              ...creditHeads!.interest,
              cf_type: 'recurring',
              cf_frequency: 'monthly',
              note: creditNote('interest', creditName, inst.installment_no, paidInterest, note, legs.currency),
              status: 'posted',
            })
            if (txIErr) throw txIErr
          }

          // Update installment
          const totalPaid = alreadyPaid + instPaid
          const instStatus = totalPaid >= inst.total_amount - 0.01 ? 'paid' : 'outstanding'

          const { data: instRows, error: instErr } = await supabase.from('credit_installments').update({
            status: instStatus,
            paid_date: instStatus === 'paid' ? txDate : null,
            transaction_id: firstTxId[0] || null,
            paid_amount: Math.round(totalPaid * 100) / 100,
            updated_at: new Date().toISOString(),
          }).eq('id', instId).select('id')
          if (instErr) throw instErr
          if (!instRows || instRows.length === 0)
            throw new Error(`Rata ${inst.installment_no} nije označena kao plaćena — stavke plaćanja za nju su već proknjižene, pa kredit treba ručno proveriti.`)
        }

        // Close credit if all installments paid
        if (selectedCreditId) {
          const { data: remaining, error: remErr } = await supabase
            .from('credit_installments').select('id')
            .eq('credit_id', selectedCreditId).eq('status', 'outstanding')
          if (remErr) throw remErr
          if (remaining && remaining.length === 0) {
            const { error: closeErr } = await supabase.from('credits')
              .update({ status: 'closed', updated_at: new Date().toISOString() })
              .eq('id', selectedCreditId)
            if (closeErr) throw closeErr
          }
        }
      } else {
        // ── Invoice payment or Direct transaction ─────────────────────────────
        let txId: string
        if (plan.kind === 'move') {
          // Out of `passthrough` and into `transactions`. Same order and the
          // same reason as the move the other way.
          const { data: newTx, error: insErr } = await supabase.from('transactions').insert(payload).select('id').single()
          if (insErr) throw insErr
          txId = newTx.id

          if (!rowId) throw new Error('Ova stavka nema ID, pa ne može da se premesti.')
          const del = await softDeleteRow(supabase, 'passthrough', rowId)
          const delErr = del.ok ? null : { message: del.message }
          if (delErr) {
            const { error: undoErr } = await supabase.from('transactions').delete().eq('id', txId)
            throw new Error(undoErr
              ? `Transakcija je napravljena, ali originalna prolazna stavka nije mogla da se ukloni (${delErr.message}), `
                + `a ni nova transakcija nije mogla da se povuče (${undoErr.message}). `
                + `Iznos je sada evidentiran dva puta — transakciju ${txId} treba ručno obrisati.`
              : `Originalna prolazna stavka nije mogla da se ukloni (${delErr.message}). `
                + 'Transakcija je povučena — ništa nije promenjeno.')
          }
        } else if (plan.kind === 'update') {
          // `.select()` is what turns a zero-row update back into an error.
          // Without it this call answers 200 whether or not it changed a thing.
          const { data: updated, error: updErr } = await supabase
            .from('transactions').update(payload).eq('id', rowId).select('id')
          if (updErr) throw updErr
          if (!updated || updated.length === 0)
            throw new Error(`Transakcija ${rowId} nije izmenjena — ništa nije sačuvano.`)
          txId = rowId as string
        } else {
          const { data: newTx, error: insErr } = await supabase.from('transactions').insert(payload).select('id').single()
          if (insErr) throw insErr
          txId = newTx.id
        }
        // ── The split, after the row itself ───────────────────────────
        //
        // After, because a split names the payment it belongs to and there is
        // no id to name until the insert comes back. An invoice payment never
        // carries one: it closes a bill classified when it was raised.
        {
          const outcome = await saveSplits(
            supabase, 'transaction', txId,
            { amount: parseFloat(amount) || 0, currency, ...booked },
            txType === 'direct' ? splitLines : [])
          if (!outcome.ok) {
            setSaving(false)
            setPostError(outcome.message)
            return
          }
        }

        if (txType === 'invoice_payment' && txId) {
          // What changed, not what is on screen. A link that was here and is
          // not any more has a row to delete AND an invoice to put back to
          // unpaid — the half of the edit with nothing left on screen to
          // stand for it. See services/linkPlan.ts.
          const plan = planLinkChanges(
            originalLinkIds,
            // By what it settles, in the bill's own currency: an allocation
            // worth less than a cent is still an allocation, and dropping it
            // for reading as zero in the book would release the invoice.
            linkedInvoices.map(l => ({ invoiceId: l.invoice_id, allocated: l.allocated_own })))

          if (plan.toRemove.length > 0) {
            // `.select()` because a delete that matched nothing is a 200 with
            // an empty body, and silence here would leave an invoice closed by
            // a payment that no longer claims it.
            const { data: removed, error: delErr } = await supabase
              .from('invoice_transaction_links')
              .delete()
              .eq('transaction_id', txId)
              .in('invoice_id', plan.toRemove)
              .select('invoice_id')
            if (delErr) throw delErr
            if (!removed || removed.length < plan.toRemove.length) {
              throw new Error(
                `Očekivano je da se od ovog plaćanja odvoji faktura: ${plan.toRemove.length}, a odvojeno je: ${removed?.length ?? 0}. Ništa drugo nije promenjeno.`)
            }
          }

          // A proforma proposed from this payment is written now, with it.
          let links = linkedInvoices
          let madeProformaId: string | null = null
          if (pendingProforma && links.some(l => l.invoice_id === 'pending-proforma')) {
            const { data: made, error: madeErr } = await supabase.from('invoices').insert(pendingProforma).select('id').single()
            if (madeErr || !made?.id) throw new Error(`Predračun nije napravljen: ${madeErr?.message || 'baza nije vratila red'}`)
            links = links.map(l => l.invoice_id === 'pending-proforma' ? { ...l, invoice_id: made.id } : l)
            madeProformaId = made.id
          }
          for (const link of links.filter(l => l.allocated_own > 0)) {
            // THE FIGURE THAT WAS TYPED IS THE FIGURE THAT IS STORED. It goes
            // into `allocated_amount`, which is the column the settled/partial
            // rule reads, and the dinars and euros are derived from it at the
            // invoice's stored rates.
            const { error: linkErr } = await supabase.from('invoice_transaction_links').upsert({
              invoice_id: link.invoice_id, transaction_id: txId,
              ...linkAmountsFromOwn(link.allocated_own, link),
            }, { onConflict: 'invoice_id,transaction_id' })
            if (linkErr) throw linkErr
          }

          // Every invoice on either side of the change — the ones gaining the
          // payment and the ones that just lost it. The view recomputes from
          // the links, so this is read after they are all written.
          for (const invoiceId of plan.toRefresh) {
            const { data: invStatus, error: statusErr } = await supabase
              .from('v_invoice_status').select('calculated_status').eq('id', invoiceId).maybeSingle()
            if (statusErr) throw statusErr
            if (invStatus) {
              const { error: invErr } = await supabase.from('invoices')
                .update({ status: invStatus.calculated_status }).eq('id', invoiceId)
              if (invErr) throw invErr
            }
          }
          // ── The currency difference ────────────────────────────────────
          //
          // Written after the links, because a gain has to be linked to the
          // invoice for it to close, and because the status refresh below has
          // to see both. A loss is not linked: the invoice is already settled
          // by the payment, and the surplus is part of the same bank line.
          if (bookDifference && fxInvoice && isBookable(fxDifference) && fxScript && fxAmountOwn > 0) {
            // The LINKED side (the invoice short: a gain on a supplier's bill,
            // a loss on a revenue billing) is the rest of the invoice, so it
            // is booked as a part of the invoice at the invoice's stored
            // rates; the surplus side is a part of this bank line, at the
            // payment's. Either way its RSD figure is the difference itself
            // (to the rounding of the part).
            const isGain = fxDifference.linksToInvoice
            const fxParent = isGain ? fxInvoice : { ...paymentRow, ...booked }
            const fxBook = partBookAmounts(fxAmountOwn, { ...fxParent, currency: fxCurrency })
            const fxRates = isGain
              ? { exchange_rate: fxInvoice.exchange_rate, eur_rate: fxInvoice.eur_rate }
              : { exchange_rate: booked.exchange_rate, eur_rate: booked.eur_rate }
            const { data: fxTx, error: fxErr } = await supabase.from('transactions').insert({
              company_id: companyId || null,
              bank_id: bankId || null,
              partner_id: finalPartnerId || null,
              transaction_date: txDate,
              statement_number: statement || null,
              type: 'direct',
              // The economics, from currencyDifference: on a revenue billing
              // a short receipt is a loss.
              tx_subtype: fxDifference.direction === 'revenue' ? 'revenue' : 'expense',
              currency: fxCurrency,
              amount: fxAmountOwn,
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
              project_id: fxInvoice.project_id ?? null,
              // A gain is not cash. Nothing arrived in the bank: the entry
              // exists to extinguish the rest of an invoice the exchange rate
              // made unpayable. `accrual` is the marker for that, so Cash Flow
              // has something to exclude it by.
              //
              // A loss IS cash — it is part of the bank line this payment came
              // from, split off it — so it keeps whatever the template says.
              cf_type: isGain ? 'accrual' : (fxScript.cf_type || null),
              status: 'posted',
              note: entryNote(fxInvoice.invoice_number, fxDifference),
            }).select('id').single()
            if (fxErr) throw fxErr

            if (fxDifference.linksToInvoice && fxTx?.id) {
              // Without this the invoice stays short by exactly the gain and
              // reads partial for ever — the whole reason a gain is booked at
              // all rather than written off.
              const { error: fxLinkErr } = await supabase.from('invoice_transaction_links').insert({
                invoice_id: fxInvoice.invoice_id,
                transaction_id: fxTx.id,
                // The exact remainder, so the bill closes rather than
                // ending a para short of closing.
                ...linkAmountsFromOwn(Math.max(0, fxShortfallOwn), fxInvoice),
              })
              if (fxLinkErr) throw fxLinkErr
            }
          }

          // ── Did it do what it said it would? ──────────────────────────
          //
          // Every write above succeeded; that is not the same as the result
          // being right. The figures this dialog reasoned from were read when
          // it opened, and one stale remainder was enough to leave an invoice
          // short AND book a currency difference in the wrong direction, with
          // nothing refused and a green tick at the end.
          //
          // So the claim is read back in the database's own terms. It cannot
          // undo anything by this point, and it does not pretend to — it says
          // what happened while the person is still here.
          // The advance invoice this payment pays: covered by the proforma
          // just made and paid, in one transaction.
          if (paysAdvance && madeProformaId) {
            const { error: covErr } = await supabase.rpc('replace_advance_links', {
              p_invoice: paysAdvance.id, p_coverage: [{ proforma_id: madeProformaId, amount: paysAdvance.amount }], p_usage: null,
            })
            if (covErr) throw new Error(`Plaćanje je proknjiženo, ali avansni račun ${paysAdvance.invoice_number || ''} nije vezan: ${covErr.message}`)
          }
          const expectations: Expectation[] = links
            .filter(l => l.allocated_own > 0)
            .map(l => ({
              invoiceId: l.invoice_id,
              invoiceNumber: l.invoice_number,
              amount: l.amount || 0,
              // Settled, but not money: the check counts it apart, so the
              // money figure below leaves it out.
              advanceDeducted: l.advance_deducted || 0,
              // All in the bill's own currency, which is the unit the check
              // reads back in. What this payment allocates, what everything
              // else had already settled — `outstanding_own` is net of that —
              // and a currency gain if one is being linked to the same bill.
              allocated: (l.allocated_own || 0)
                + Math.max(0, (l.amount || 0) - (l.advance_deducted || 0) - (l.outstanding_own || 0))
                + (bookDifference && fxInvoice?.invoice_id === l.invoice_id
                   && fxDifference.linksToInvoice ? Math.max(0, fxShortfallOwn) : 0),
            }))

          if (expectations.length > 0) {
            const { data: after } = await supabase.from('v_invoice_status')
              .select('id, calculated_status')
              .in('id', expectations.map(e => e.invoiceId))
            const actual: Record<string, Settlement | undefined> = {}
            for (const r of after || []) actual[r.id] = r.calculated_status as Settlement
            setSettlementWarning(describeMismatches(mismatches(expectations, actual)))
          }

          setLinkSummary(describeChanges(plan))
        }
      }
      if (plan.kind === 'move') setMovedTo(plan.to)
      setSuccess(true)
      // Long enough to read a warning, and no auto-close at all when there is
      // one: a dialog that shuts itself is a dialog that was not read.
      if (!settlementWarning) setTimeout(() => { setSuccess(false); onClose() }, 1500)
    } catch (err: any) {
      console.error(err)
      setPostError(`Transakcija nije proknjižena: ${err?.message || err}`)
    }
    setSaving(false)
  }

  if (success) return (
    <div style={s.overlay}>
      <div style={{ ...s.dialog, display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center', gap: '1rem', minHeight: '220px' }}>
        <div style={{ width: '48px', height: '48px', borderRadius: '50%', background: DIALOG.accentFill, display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
          <svg width="24" height="24" viewBox="0 0 24 24" fill="none" stroke={DIALOG.accent} strokeWidth="2"><path d="M5 13l4 4L19 7" /></svg>
        </div>
        <div style={{ fontFamily: 'Georgia,serif', fontSize: '20px', color: DIALOG.text }}>{movedTo ? 'Transakcija je premeštena.' : transaction ? 'Transakcija je izmenjena.' : 'Transakcija je proknjižena.'}</div>
        {settlementWarning && (
          <div style={{
            fontSize: '12px', lineHeight: 1.5, color: DIALOG.amber, background: DIALOG.amberFill,
            border: '0.5px solid ' + DIALOG.amber, borderRadius: '8px', padding: '10px 14px',
            maxWidth: '520px', textAlign: 'left' as const,
          }}>
            ⚠ {settlementWarning}
          </div>
        )}
        <div style={{ fontSize: '13px', color: DIALOG.dim }}>{
          movedTo === 'passthrough' ? 'Premešteno u prolazne stavke. Originalna transakcija je uklonjena.'
            : movedTo === 'transactions' ? 'Premešteno iz prolaznih stavki. Originalna stavka je uklonjena.'
              : txType === 'invoice_payment' ? (linkSummary || `Ažurirano faktura: ${linkedInvoices.length}.`)
                : 'Proknjiženo u P&L i novčani tok.'
        }</div>
      </div>
    </div>
  )

  // ── Project panel (reusable JSX) ──────
  // One picker; null is company overhead. Hidden while the payment is split,
  // because then each line carries its own project and this one is null.
  const projectPanel = (
    <div style={s.section}>
      <div style={s.sectionTitle}>Projekat</div>
      {splitActive ? (
        <div style={{ fontSize: '11.5px', color: DIALOG.dim, lineHeight: 1.5 }}>
          Plaćanje je podeljeno — svaka stavka iznad nosi svoj projekat.
          Uklonite podelu da biste celo plaćanje stavili na jedan projekat.
        </div>
      ) : (
        <ProjectSelect value={projectId} onChange={setProjectId} companyId={companyId || null}
          style={pickerChrome} />
      )}
    </div>
  )

  // ── Cash Flow Classification panel ──────────────────
  const cfPanel = (
    <div style={s.section}>
      <div style={s.sectionTitle}>Klasifikacija novčanog toka</div>
      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(5,1fr)', gap: '8px' }}>
        {[
          { id: 'recurring', label: '🔁 Ponavljajući', sub: 'Mesečno/kvart./god.' },
          { id: 'one_time', label: '1️⃣ Jednokratni', sub: 'Ne ponavlja se' },
          { id: 'accrual', label: '📅 Razgraničenje', sub: 'Po periodu' },
          { id: 'capex', label: '🏗 Kap. izdatak', sub: 'Kapitalni izdatak' },
          { id: 'reimbursable', label: '↩️ Refundacija', sub: 'Očekuje se povraćaj' },
        ].map(a => (
          <div key={a.id}
            style={{ ...s.allocBtn, ...(cfType === a.id ? { border: '2px solid ' + DIALOG.accent, background: DIALOG.accentFill } : {}) }}
            onClick={() => setCfType(cfType === a.id ? '' : a.id)}>
            <div style={{ fontSize: '11px', fontWeight: '600', color: cfType === a.id ? DIALOG.accent : DIALOG.text }}>{a.label}</div>
            <div style={{ fontSize: '10px', color: DIALOG.dim, marginTop: '2px' }}>{a.sub}</div>
          </div>
        ))}
      </div>

      {cfType === 'recurring' && (
        <div style={{ marginTop: '12px', background: DIALOG.raised, borderRadius: '10px', padding: '14px', border: '0.5px solid ' + DIALOG.border }}>
          <div style={{ display: 'flex', gap: '8px', marginBottom: '12px' }}>
            {[{ id: 'monthly', label: '📆 Mesečno' }, { id: 'quarterly', label: '📊 Kvartalno' }, { id: 'yearly', label: '📅 Godišnje' }].map(f => (
              <div key={f.id}
                style={{ flex: 1, padding: '8px', border: cfFrequency === f.id ? '2px solid ' + DIALOG.accent : '0.5px solid ' + DIALOG.border, borderRadius: '8px', background: cfFrequency === f.id ? DIALOG.accentFill : DIALOG.raised, cursor: 'pointer', textAlign: 'center' as const, fontSize: '12px', fontWeight: cfFrequency === f.id ? '600' : '400', color: cfFrequency === f.id ? DIALOG.accent : DIALOG.dim }}
                onClick={() => setCfFrequency(f.id)}>{f.label}</div>
            ))}
          </div>
          <div style={s.field}>
            <label style={s.lbl}>Procena za sledeći mesec ({currency || '—'})</label>
            <div style={{ display: 'flex', gap: '8px', alignItems: 'center' }}>
              <input type="number" style={{ ...s.input, flex: 1 }} value={cfNextMonthEst}
                onChange={e => setCfNextMonthEst(e.target.value)}
                placeholder={amount ? `Automatski: ${fmtNum(parseFloat(amount))}` : '0.00'} />
              {!cfNextMonthEst && amount && (
                <button style={s.linkBtn} onClick={() => setCfNextMonthEst(amount)}>Preuzmi ovaj iznos</button>
              )}
            </div>
            {amount && (
              <div style={{ fontSize: '10px', color: DIALOG.dim, marginTop: '4px' }}>
                Automatski: {fmtNum(cfFrequency === 'monthly' ? parseFloat(amount) : cfFrequency === 'quarterly' ? parseFloat(amount) / 3 : parseFloat(amount) / 12)} {currency}/mes.
              </div>
            )}
          </div>
        </div>
      )}

      {cfType === 'accrual' && (
        <div style={{ marginTop: '12px', background: DIALOG.raised, borderRadius: '10px', padding: '14px', border: '0.5px solid ' + DIALOG.border }}>
          <div style={s.row2}>
            <div style={s.field}>
              <label style={s.lbl}>Od</label>
              <input type="date" style={s.input} value={cfAccrualFrom} onChange={e => setCfAccrualFrom(e.target.value)} />
            </div>
            <div style={s.field}>
              <label style={s.lbl}>Do</label>
              <input type="date" style={s.input} value={cfAccrualTo} onChange={e => setCfAccrualTo(e.target.value)} />
            </div>
          </div>
          {cfAccrualFrom && cfAccrualTo && amount && (
            <div style={{ fontSize: '11px', color: DIALOG.accent, marginTop: '4px' }}>
              {(() => { const m = Math.max(1, Math.round((new Date(cfAccrualTo).getTime() - new Date(cfAccrualFrom).getTime()) / (1000*60*60*24*30))); return `Mesečno: ${fmtMoney(parseFloat(amount)/m, currency)} × ${m} mes.` })()}
            </div>
          )}
        </div>
      )}

      {cfType === 'capex' && (
        <div style={{ marginTop: '12px', background: DIALOG.raised, borderRadius: '10px', padding: '14px', border: '0.5px solid ' + DIALOG.border }}>
          <div style={s.field}>
            <label style={s.lbl}>Period amortizacije (meseci)</label>
            <input type="number" style={s.input} value={cfCapexMonths} onChange={e => setCfCapexMonths(e.target.value)} placeholder="npr. 36" min="1" />
            {cfCapexMonths && amount && (
              <div style={{ fontSize: '11px', color: DIALOG.accent, marginTop: '4px' }}>
                Mesečna amortizacija: {fmtNum(parseFloat(amount) / parseFloat(cfCapexMonths))} {currency}/mes.
              </div>
            )}
          </div>
        </div>
      )}

      {cfType === 'reimbursable' && (
        <div style={{ marginTop: '12px', background: DIALOG.raised, borderRadius: '10px', padding: '14px', border: '0.5px solid ' + DIALOG.border }}>
          <div style={s.field}>
            <label style={s.lbl}>Očekivani datum refundacije</label>
            <input type="date" style={s.input} value={cfReimbursableDate} onChange={e => setCfReimbursableDate(e.target.value)} />
          </div>
        </div>
      )}

      {cfType === 'one_time' && (
        <div style={{ marginTop: '8px', fontSize: '12px', color: DIALOG.dim, background: DIALOG.raised, borderRadius: '8px', padding: '10px 12px' }}>
          Jednokratni trošak — neće ući u procene za naredne mesece.
        </div>
      )}
    </div>
  )

  return (
    <div style={s.overlay}>
      <div style={s.dialog}>
        <div style={s.header}>
          <div>
            <div style={s.headerTitle}>{transaction ? 'Izmena transakcije' : 'Nova transakcija'}</div>
            <div style={s.headerSub}>Korak {step} od 4 — {stepTitles[step - 1]}</div>
          </div>
          <div style={{ display: 'flex', alignItems: 'center', gap: '10px' }}>
            {txType === 'direct' && <div style={s.plBadge}>Utiče na P&L</div>}
            {txType === 'invoice_payment' && <div style={s.cashBadge}>Samo novčani tok</div>}
            {advance && <span style={{ ...ADVANCE_BADGE_STYLE, marginLeft: '6px' }}>{ADVANCE_LABEL}</span>}
            {txType === 'passthrough' && <div style={{ ...s.cashBadge, background: 'rgba(230,180,50,0.2)', color: DIALOG.amber, border: '0.5px solid rgba(230,180,50,0.3)' }}>Prolazna stavka</div>}
            {txType === 'credit_payment' && <div style={{ ...s.cashBadge, background: 'rgba(78,168,255,0.2)', color: '#4EA8FF', border: '0.5px solid rgba(78,168,255,0.3)' }}>Otplata kredita</div>}
            <span style={s.logoText}>{brand.appName}</span>
            <button style={s.closeBtn} onClick={onClose}>×</button>
          </div>
        </div>

        <div style={s.stepsBar}>
          {stepTitles.map((t, i) => {
            const hasErr = step > i + 1 && stepHasError(i + 1)
            return (
              <React.Fragment key={i}>
                <div style={s.stepItem} onClick={() => { touchStep(step); setStep(i + 1) }}>
                  <div style={{ ...s.stepNum, ...(step === i + 1 ? s.stepActive : {}), ...(step > i + 1 && !hasErr ? s.stepDone : {}), ...(hasErr ? s.stepError : {}) }}>
                    {step > i + 1 ? (hasErr ? '!' : '✓') : i + 1}
                  </div>
                  <span style={{ ...s.stepLabel, ...(step === i + 1 ? { color: DIALOG.accent, fontWeight: '500' } : {}) }}>{t}</span>
                </div>
                {i < 3 && <div style={s.stepDiv} />}
              </React.Fragment>
            )
          })}
        </div>

        {postError && (
          <div style={s.validationBanner}>
            <span>⚠️</span>
            <div style={{ flex: 1, fontSize: '12px', fontWeight: 500 }}>{postError}</div>
            <button style={s.bannerClose} onClick={() => setPostError('')}>×</button>
          </div>
        )}

        {showValidationSummary && !isValid && (
          <div style={s.validationBanner}>
            <span>⚠️</span>
            <div style={{ flex: 1 }}>
              <div style={{ fontWeight: '500', fontSize: '12px' }}>Ispravite pre knjiženja ({countOf(totalErrors, 'greška', 'greške', 'grešaka')}):</div>
              <div style={{ fontSize: '11px', marginTop: '2px', opacity: 0.9 }}>{Object.values(errors).join(' · ')}</div>
            </div>
            <button style={s.bannerClose} onClick={() => setShowValidationSummary(false)}>×</button>
          </div>
        )}

        <div style={s.body}>

          {/* ── STEP 1 ── */}
          {step === 1 && (
            <>
              <div style={s.section}>
                <div style={s.sectionTitle}>Banka i račun</div>
                <div style={s.row2}>
                  {showPicker && (
                    <div style={s.field}>
                      <label style={s.lbl}>Firma <span style={s.req}>*</span></label>
                      <select style={{ ...s.select, ...(fieldErr('companyId') ? s.inputError : {}) }} value={companyId}
                        onChange={e => { setCompanyId(e.target.value); touch('companyId') }} onBlur={() => touch('companyId')}>
                        <option value="">Izaberite firmu…</option>
                        {companies.map(c => <option key={c.id} value={c.id}>{c.name}</option>)}
                      </select>
                      {fieldErr('companyId') && <span style={s.errorMsg}>{fieldErr('companyId')}</span>}
                    </div>
                  )}
                  <div style={s.field}>
                    <label style={s.lbl}>Banka / račun <span style={s.req}>*</span></label>
                    <select style={{ ...s.select, ...(fieldErr('bankId') ? s.inputError : {}) }} value={bankId}
                      onChange={e => { setBankId(e.target.value); touch('bankId') }} onBlur={() => touch('bankId')}>
                      <option value="">Izaberite banku…</option>
                      {banks.map(b => <option key={b.id} value={b.id}>{b.name}</option>)}
                    </select>
                    {fieldErr('bankId') && <span style={s.errorMsg}>{fieldErr('bankId')}</span>}
                  </div>
                </div>
                <div style={s.row2}>
                  <div style={s.field}>
                    <label style={s.lbl}>Valuta <span style={s.req}>*</span></label>
                    <select style={{ ...s.select, ...(fieldErr('currency') ? s.inputError : {}) }} value={currency}
                      onChange={e => { setCurrency(e.target.value); touch('currency') }} onBlur={() => touch('currency')}>
                      <option value="">Izaberite…</option>
                      {(companies.find(c => c.id === companyId)?.currencies || DOCUMENT_CURRENCIES).map((cur: string) => (
                        <option key={cur}>{cur}</option>
                      ))}
                    </select>
                    {fieldErr('currency') && <span style={s.errorMsg}>{fieldErr('currency')}</span>}
                  </div>
                  <div style={s.field}>
                    <label style={s.lbl}>Broj izvoda</label>
                    <input style={s.input} value={statement} onChange={e => setStatement(e.target.value)} placeholder="npr. 2026-001" />
                  </div>
                </div>
              </div>

              <div style={s.section}>
                <div style={s.sectionTitle}>Datum i partner</div>
                <div style={s.row2}>
                  <div style={s.field}>
                    <label style={s.lbl}>Datum transakcije <span style={s.req}>*</span></label>
                    <input type="date" style={{ ...s.input, ...(fieldErr('txDate') ? s.inputError : {}) }} value={txDate}
                      onChange={e => { setTxDate(e.target.value); touch('txDate') }} onBlur={() => touch('txDate')} />
                    {fieldErr('txDate') && <span style={s.errorMsg}>{fieldErr('txDate')}</span>}
                  </div>
                  <div style={s.field}>
                    <label style={s.lbl}>Partner</label>
                    {!showNewPartner ? (
                      <>
                        <input style={s.input} value={partnerSearch}
                          onChange={e => { setPartnerSearch(e.target.value); setPartnerId('') }} placeholder="Pretraga partnera…" />
                        {partnerSearch && !partnerId && (
                          <div style={s.dropdown}>
                            {filteredPartners.slice(0, 6).map(p => (
                              <div key={p.id} style={s.dropdownItem} onClick={() => { setPartnerId(p.id); setPartnerSearch(p.name) }}>{p.name}</div>
                            ))}
                            <div style={{ ...s.dropdownItem, color: DIALOG.accent }} onClick={() => { setShowNewPartner(true); setPartnerSearch('') }}>+ Dodaj novog partnera</div>
                          </div>
                        )}
                      </>
                    ) : (
                      <>
                        <input style={s.input} value={newPartnerName} onChange={e => setNewPartnerName(e.target.value)} placeholder="Naziv novog partnera…" />
                        <button style={s.linkBtn} onClick={() => setShowNewPartner(false)}>← Nazad na pretragu</button>
                      </>
                    )}
                  </div>
                </div>
              </div>

              <div style={s.section}>
                <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: '10px' }}>
                  <div style={s.sectionTitle}>Podaci za plaćanje</div>
                  <button style={s.linkBtn} onClick={() => setShowBankFields(!showBankFields)}>{showBankFields ? '− Sakrij' : '+ Prikaži'}</button>
                </div>
                {showBankFields ? (
                  <div style={s.row3}>
                    <div style={s.field}>
                      <label style={s.lbl}>Broj računa (RSD)</label>
                      {partnerAccounts.length > 1 ? (
                        <>
                          <select style={s.select} value={selectedAccountId} onChange={e => handleAccountSelect(e.target.value)}>
                            {!selectedAccountId && <option value="">Uneto ručno — nije sačuvan račun</option>}
                            {partnerAccounts.map((acc: any) => (
                              <option key={acc.id} value={acc.id}>{acc.account_number}{acc.bank_name ? ` — ${acc.bank_name}` : ''}{acc.is_primary ? ' ★' : ''}</option>
                            ))}
                          </select>
                          {!selectedAccountId && (
                            <input style={{ ...s.input, marginTop: '4px' }} value={accNum}
                              onChange={e => setAccNum(e.target.value)} placeholder="Račun partnera" />
                          )}
                        </>
                      ) : (
                        <input style={s.input} value={accNum} onChange={e => setAccNum(e.target.value)} placeholder="Račun partnera" />
                      )}
                    </div>
                    <div style={s.field}><label style={s.lbl}>Model</label><input style={s.input} value={model} onChange={e => setModel(e.target.value)} placeholder="npr. 97" /></div>
                    <div style={s.field}><label style={s.lbl}>Poziv na broj</label><input style={s.input} value={refNum} onChange={e => setRefNum(e.target.value)} placeholder="Poziv na broj" /></div>
                  </div>
                ) : (
                  <div style={{ fontSize: '12px', color: DIALOG.faint }}>Broj računa, model, poziv na broj.</div>
                )}
              </div>
            </>
          )}

          {/* ── STEP 2 ── */}
          {step === 2 && (
            <div style={s.section}>
              <div style={s.sectionTitle}>Iznos i preračun valute</div>
              <div style={s.toggleRow}>
                <span style={s.toggleLabel}>Iznos indeksiran u stranoj valuti?</span>
                <label style={s.toggle}>
                  <input type="checkbox" checked={isIndexed} onChange={e => setIsIndexed(e.target.checked)} style={{ opacity: 0, width: 0, height: 0 }} />
                  <span style={{ ...s.toggleSlider, background: isIndexed ? DIALOG.accent : DIALOG.border }} />
                </label>
              </div>
              <div style={{ ...s.infoBox, margin: '10px 0' }}>
                {currency === 'RSD'
                  ? `Knjiži se u RSD; iznos u EUR daje kurs NBS za EUR na datum transakcije (${txDate}).`
                  : `Srednji kurs NBS na datum transakcije (${txDate}), u RSD za 1 ${currency || 'jedinicu'}.`}
                {txType === 'credit_payment' && ` Rate se umanjuju za iznos u ${creditCurrency || 'valuti kredita'}.`}
              </div>
              <div style={s.row2}>
                <div style={s.field}>
                  <label style={s.lbl}>Iznos ({currency || '—'}) <span style={s.req}>*</span></label>
                  <input type="number" style={{ ...s.input, ...(fieldErr('amount') ? s.inputError : {}) }} value={amount}
                    onChange={e => { setAmount(e.target.value); touch('amount') }} onBlur={() => touch('amount')} placeholder="0.00" />
                  {fieldErr('amount') && <span style={s.errorMsg}>{fieldErr('amount')}</span>}
                </div>
                <div style={s.field}>
                  <label style={s.lbl}>{currency && currency !== 'RSD' ? `RSD za 1 ${currency}` : 'RSD za 1 EUR'} <span style={s.req}>*</span></label>
                  <div style={{ display: 'flex', gap: '6px' }}>
                    {currency && currency !== 'RSD' ? (
                      <input type="number" style={{ ...s.input, flex: 1, ...(fieldErr('exRate') ? s.inputError : {}) }} value={exRate}
                        onChange={e => { setExRate(e.target.value); touch('exRate') }} onBlur={() => touch('exRate')}
                        placeholder="Kliknite Preuzmi" />
                    ) : (
                      <input type="number" style={{ ...s.input, flex: 1, ...(fieldErr('exRate') ? s.inputError : {}) }} value={eurRate}
                        onChange={e => { setEurRate(e.target.value); touch('exRate') }} onBlur={() => touch('exRate')}
                        placeholder="Kliknite Preuzmi" />
                    )}
                    <button style={s.fetchBtn} onClick={fetchRate} disabled={fetchingRate || !currency}>{fetchingRate ? '...' : 'Preuzmi'}</button>
                  </div>
                  {currency === 'USD' && (
                    <input type="number" style={{ ...s.input, marginTop: '6px' }} value={eurRate}
                      onChange={e => { setEurRate(e.target.value); touch('exRate') }} onBlur={() => touch('exRate')}
                      placeholder="RSD za 1 EUR" aria-label="RSD za 1 EUR" />
                  )}
                  {rateSource && <div style={{ fontSize: '11px', color: rateMissing ? '#FF5B5A' : DIALOG.accent, fontWeight: rateMissing ? 600 : 400, marginTop: '4px' }}>Izvor: {rateSource}</div>}
                  {fieldErr('exRate') && <span style={s.errorMsg}>{fieldErr('exRate')}</span>}
                </div>
              </div>
              <div style={s.convRow}>
                <div><div style={s.convLabel}>Originalni iznos</div><div style={s.convVal}>{amount ? fmtMoney(parseFloat(amount), currency) : '—'}</div></div>
                <div style={{ fontSize: '20px', color: DIALOG.faint, alignSelf: 'flex-end', paddingBottom: '4px' }}>→</div>
                <div><div style={s.convLabel}>RSD (knjiženo)</div><div style={{ ...s.convVal, color: DIALOG.accent }}>{book.amounts ? fmtMoney(amountRsd, 'RSD') : '—'}</div></div>
                <div><div style={s.convLabel}>EUR</div><div style={{ ...s.convVal, color: DIALOG.accent }}>{book.amounts ? fmtMoney(amountEur, 'EUR') : '—'}</div></div>
              </div>
            </div>
          )}

          {/* ── STEP 3 ── */}
          {step === 3 && (
            <>
              {/* ONE PAYMENT, SEVERAL COSTS.
                  Only on a direct transaction: an invoice payment has no P&L
                  of its own to divide — it closes a bill that was classified
                  when it was raised, and splitting it here would book the
                  cost twice. */}
              {txType === 'direct' && !advance && (
                <SplitEditor
                  parent={paymentRow}
                  lines={splitLines}
                  onChange={changeSplitLines}
                  companyId={companyId || null}
                  scripts={quickFillScripts as any}
                  classification={{ plCategories, plSubcategories, departments, deptSubcategories, expenseDescriptions }}
                  client={supabase}
                  onScriptsChanged={() => { fetchScripts(supabase).then(setQuickFillScripts as any) }}
                  hint="Jedno plaćanje, dva ili više troškova — svaki sa svojom klasifikacijom."
                />
              )}

              <div style={s.section}>
                <div style={s.sectionTitle}>Tip transakcije <span style={s.req}>*</span></div>
                <div style={{ ...s.typeGrid, gridTemplateColumns: '1fr 1fr 1fr 1fr' }}>
                  <div style={{ ...s.typeCard, ...(txType === 'invoice_payment' ? s.typeCardPayment : {}) }} onClick={() => setTxType('invoice_payment')}>
                    <div style={{ fontSize: '24px', marginBottom: '6px' }}>💳</div>
                    <div style={s.typeCardTitle}>Plaćanje fakture</div>
                    <div style={s.typeCardSub}>Zatvara jednu ili više otvorenih faktura. Bez novog uticaja na P&L.</div>
                  </div>
                  <div style={{ ...s.typeCard, ...(txType === 'direct' ? s.typeCardDirect : {}) }} onClick={() => setTxType('direct')}>
                    <div style={{ fontSize: '24px', marginBottom: '6px' }}>⚡</div>
                    <div style={s.typeCardTitle}>Direktna transakcija</div>
                    <div style={s.typeCardSub}>Faktura ne postoji niti će postojati. Direktno utiče na P&L.</div>
                  </div>
                  <div style={{ ...s.typeCard, ...(txType === 'passthrough' ? { border: '2px solid ' + DIALOG.amber, background: DIALOG.amberFill } : {}) }} onClick={() => setTxType('passthrough')}>
                    <div style={{ fontSize: '24px', marginBottom: '6px' }}>🔄</div>
                    <div style={s.typeCardTitle}>Prolazna stavka</div>
                    <div style={s.typeCardSub}>Novac u prolazu — bez uticaja na P&L. Uparene UPLATA i ISPLATA.</div>
                  </div>
                  <div style={{ ...s.typeCard, ...(txType === 'credit_payment' ? { border: '2px solid #4EA8FF', background: DIALOG.blueFill } : {}) }} onClick={() => { setTxType('credit_payment'); resetCredit() }}>
                    <div style={{ fontSize: '24px', marginBottom: '6px' }}>🏦</div>
                    <div style={s.typeCardTitle}>Otplata kredita</div>
                    <div style={s.typeCardSub}>Zatvara rate kredita. Označava ih kao plaćene u Kreditima.</div>
                  </div>
                </div>
              </div>

              {txType === 'passthrough' && (
                <div style={s.section}>
                  <div style={s.row2}>
                    <div style={s.field}>
                      <label style={s.lbl}>Smer <span style={s.req}>*</span></label>
                      <div style={{ display: 'flex', gap: '8px' }}>
                        <div style={{ ...s.typeChip, flex: 1, ...(ptDirection === 'in' ? { border: '2px solid ' + DIALOG.accent, background: DIALOG.accentFill, color: DIALOG.accent, fontWeight: '500' } : {}) }}
                          onClick={() => setPtDirection('in')}>📥 UPLATA</div>
                        <div style={{ ...s.typeChip, flex: 1, ...(ptDirection === 'out' ? { border: '2px solid ' + DIALOG.red, background: DIALOG.redFill, color: DIALOG.red, fontWeight: '500' } : {}) }}
                          onClick={() => setPtDirection('out')}>📤 ISPLATA</div>
                      </div>
                    </div>
                    <div style={s.field}>
                      <label style={s.lbl}>Period</label>
                      <input type="month" style={s.input} value={ptPeriodMonth} onChange={e => setPtPeriodMonth(e.target.value)} />
                    </div>
                  </div>
                  <div style={s.field}>
                    <label style={s.lbl}>Napomena</label>
                    <textarea style={{ ...s.textarea, marginTop: '4px' }} value={note} onChange={e => setNote(e.target.value)} placeholder="Opis prolazne stavke…" />
                  </div>
                </div>
              )}

              {txType === 'credit_payment' && (
                <div style={s.section}>
                  <SystemCategoryNotice what="Otplate kredita" roles={CREDIT_ROLES}
                    map={systemCategories.map} loading={systemCategories.loading} />
                  <CreditInstallmentSelector
                    credits={credits}
                    selectedCreditId={selectedCreditId}
                    onCreditChange={setSelectedCreditId}
                    installments={creditInstallments}
                    selectedInstallmentIds={selectedInstallmentIds}
                    onToggle={toggleInstallment}
                    onToggleAll={toggleAllInstallments}
                    selectedTotal={creditSelectedTotal}
                    error={fieldErr('creditInstallments')}
                  />
                </div>
              )}

              {txType === 'invoice_payment' && (
                <div style={s.section}>
                  <div style={{ ...s.infoBox, marginBottom: '12px' }}>
                    Ova transakcija zatvara izabrane fakture. P&L je već proknjižen kada su te fakture proknjižene.
                  </div>
                  {fieldErr('linkedInvoices') && (
                    <div style={{ ...s.infoBox, background: DIALOG.redFill, borderColor: DIALOG.redSoft, color: DIALOG.red, marginBottom: '12px' }}>
                      ⚠️ {fieldErr('linkedInvoices')}
                    </div>
                  )}
                  <div style={{ display: 'flex', alignItems: 'center', gap: '8px', marginBottom: '8px' }}>
                    <button type="button" style={s.linkBtn} onClick={() => makeProformaFrom()}>Nov predračun iz ove uplate</button>
                    {proformaWhy && <span style={{ fontSize: '11px', color: DIALOG.red }}>{proformaWhy}</span>}
                  </div>
                  {!transaction?.id && unlinkedAdvances.filter(a => !partnerId || a.partner_id === partnerId).map(a => (
                    <div key={a.id} style={{ display: 'flex', alignItems: 'center', gap: '8px', marginBottom: '6px', fontSize: '12px', color: DIALOG.text }}>
                      <span style={{ flex: 1 }}>{a.partner_name || '—'} · {a.invoice_number || 'bez broja'} · {formatMoney(Number(a.amount) || 0, a.currency || 'RSD')} · <span style={{ color: DIALOG.amber }}>avansni račun bez predračuna</span></span>
                      <button type="button" style={s.linkBtn} onClick={() => makeProformaFrom(a)}>
                        {paysAdvance?.id === a.id ? '✓ Plaća se ovom uplatom' : 'Plati ovom uplatom'}
                      </button>
                    </div>
                  ))}
                  <input style={{ ...s.input, marginBottom: '10px', width: '100%', boxSizing: 'border-box' as const }}
                    value={invoiceSearch} onChange={e => setInvoiceSearch(e.target.value)}
                    placeholder="Pretraga po partneru, broju fakture ili iznosu…" />
                  {filteredOpenInvoices.length === 0 ? (
                    <div style={{ padding: '20px', textAlign: 'center' as const, color: DIALOG.faint, fontSize: '13px', background: DIALOG.raised, borderRadius: '8px' }}>
                      Ova firma nema otvorenih faktura.
                    </div>
                  ) : (
                    <div style={s.invoiceList}>
                      {filteredOpenInvoices.map(inv => {
                        const linked = isInvoiceLinked(inv.id)
                        // What is left, in the bill's own currency — the same
                        // figure the allocation is judged against.
                        const remOwn = outstandingOwn(inv)
                        return (
                          <div key={inv.id} style={{ ...s.invoiceRow, ...(linked ? s.invoiceRowLinked : {}) }}>
                            <div style={{ flex: 1, minWidth: 0 }}>
                              <div style={{ display: 'flex', alignItems: 'center', gap: '8px', marginBottom: '2px', flexWrap: 'wrap' as const }}>
                                <span style={{ fontSize: '13px', fontWeight: '600', color: DIALOG.text }}>{inv.partner_name || '—'}</span>
                                {inv.invoice_number && <span style={s.invNumBadge}>{inv.invoice_number}</span>}
                                <span style={{ ...s.statusBadge, ...getStatusStyle(inv.calculated_status) }}>{({ paid: 'plaćeno', partial: 'delimično', unpaid: 'neplaćeno', overdue: 'u kašnjenju' } as Record<string, string>)[inv.calculated_status] || inv.calculated_status}</span>
                              </div>
                              <div style={{ fontSize: '11px', color: DIALOG.dim, marginBottom: '2px' }}>
                                {inv.invoice_date}{inv.due_date && ` · Dospeće: ${inv.due_date}`}
                              </div>
                              {inv.expense_description && (
                                <div style={{ fontSize: '11px', color: DIALOG.dim, fontStyle: 'italic' }}>{inv.expense_description}</div>
                              )}
                            </div>
                            <div style={{ textAlign: 'right' as const, marginRight: '10px', flexShrink: 0 }}>
                              <div style={{ fontSize: '13px', fontWeight: '600', color: DIALOG.text }}>
                                {fmtMoney(inv.amount || 0, inv.currency || 'RSD')}
                              </div>
                              <div style={{ fontSize: '11px', color: remOwn > 0 ? DIALOG.red : DIALOG.accent, marginTop: '1px' }}>
                                Preostalo: {fmtMoney(remOwn, inv.currency || 'RSD')}
                              </div>
                            </div>
                            {!linked
                              ? <button style={s.addBtn} onClick={() => addInvoiceLink(inv)}>+ Dodaj</button>
                              : <button style={s.removeBtn} onClick={() => removeInvoiceLink(inv.id)}>✕ Ukloni</button>
                            }
                          </div>
                        )
                      })}
                    </div>
                  )}
                  {linksLoading && (
                    <div style={{ marginTop: '16px', fontSize: '12px', color: DIALOG.dim }}>
                      Učitavanje faktura koje ovo plaćanje zatvara…
                    </div>
                  )}
                  {!linksLoading && linkedInvoices.length === 0 && releasing.length > 0 && (
                    <div style={{ ...s.releaseNotice, marginTop: '16px' }}>
                      Čuvanjem se od ovog plaćanja odvajaju sve fakture koje je zatvaralo — {releasing.map(r => r.invoice_number).join(', ')}.
                      Izaberite bar jednu koju zatvara ili ostavite transakciju kakva jeste.
                    </div>
                  )}
                  {!linksLoading && linkedInvoices.length > 0 && (
                    <div style={{ marginTop: '16px' }}>
                      <div style={s.sectionTitle}>
                        {originalLinkIds.length > 0 ? 'Fakture koje ovo plaćanje zatvara' : 'Raspodela po fakturi'}
                      </div>
                      {linkedInvoices.map(link => (
                        <div key={link.invoice_id} style={s.allocRow}>
                          <div style={{ flex: 1 }}>
                            <div style={{ fontSize: '13px', fontWeight: '500', color: DIALOG.text }}>{link.partner_name}</div>
                            <div style={{ fontSize: '11px', color: DIALOG.dim }}>
                              {link.invoice_number} · Faktura {formatMoney(link.amount ?? 0, allocationCurrency(link))}
                              {' · '}Preostali dug {formatMoney(link.outstanding_own || 0, allocationCurrency(link))}
                            </div>
                            {/* What the invoice is still owed AFTER this figure.
                                The field means "what this link allocates in
                                total", not "what to add", and reading the
                                outstanding figure as the amount to type leaves
                                the invoice short by whatever this link already
                                held. Saying the result removes the ambiguity
                                rather than explaining it. */}
                            {(() => {
                              // In the bill's own currency, because that is
                              // what settles it. Read off the book columns
                              // this line disagreed with the rule the status
                              // is decided by.
                              const left = Math.round(
                                ((link.outstanding_own || 0) - (link.allocated_own || 0)) * 100) / 100
                              if (Math.abs(left) <= 0.01) {
                                return (
                                  <div style={{ fontSize: '11px', color: DIALOG.accent, marginTop: '2px' }}>
                                    ✓ Zatvara ovu fakturu u celosti
                                  </div>
                                )
                              }
                              return (
                                <div style={{ fontSize: '11px', color: left > 0 ? DIALOG.amber : DIALOG.red, marginTop: '2px' }}>
                                  {left > 0
                                    ? `Ostaje dug od ${formatMoney(left, allocationCurrency(link))}`
                                    : `Raspoređuje ${formatMoney(-left, allocationCurrency(link))} više od duga po ovoj fakturi`}
                                </div>
                              )
                            })()}
                          </div>
                          <div style={{ display: 'flex', alignItems: 'center', gap: '6px' }}>
                            <span style={{ fontSize: '12px', color: DIALOG.dim }}>{allocationCurrency(link)}</span>
                            <input type="number" style={{ ...s.input, width: '130px', textAlign: 'right' as const }}
                              value={link.allocated_own ?? 0}
                              onChange={e => updateAllocated(link.invoice_id, parseFloat(e.target.value) || 0)} />
                            <button type="button" style={s.detachBtn}
                              title={`Odvoji ${link.invoice_number} od ovog plaćanja`}
                              onClick={() => removeInvoiceLink(link.invoice_id)}>Odvoji</button>
                          </div>
                        </div>
                      ))}
                      {releasing.length > 0 && (
                        <div style={s.releaseNotice}>
                          Čuvanjem se od ovog plaćanja odvaja {countOf(releasing.length, 'faktura', 'fakture', 'faktura')}
                          — {releasing.map(r => r.invoice_number).join(', ')}.
                          {releasing.length === 1 ? ' Vraća se' : ' Vraćaju se'} u neplaćene, osim ako ih ne pokrije
                          drugo plaćanje.
                        </div>
                      )}
                      {/* In the shared currency when the payment and every
                          invoice agree, which is the ordinary case. When they
                          do not, no single currency these totals mean anything
                          in exists, so they fall back to dinars and say so
                          rather than converting something into nobody's money. */}
                      <div style={s.allocSummaryBox}>
                        <div style={s.allocSummaryRow}>
                          <span>Iznos transakcije</span>
                          <span style={{ fontWeight: '500' }}>{formatMoney(allocCurrency ? (parseFloat(amount) || 0) : amountRsd, allocCurrency || 'RSD')}</span>
                        </div>
                        <div style={s.allocSummaryRow}>
                          <span>Ukupno raspoređeno</span>
                          <span style={{ fontWeight: '500', color: DIALOG.accent }}>{formatMoney(allocCurrency ? totalAllocatedOwn : totalAllocatedRsd, allocCurrency || 'RSD')}</span>
                        </div>
                        {Math.abs(allocCurrency ? unallocatedOwn : unallocatedRsd) > 0.01 && (
                          <div style={{ ...s.allocSummaryRow, color: (allocCurrency ? unallocatedOwn : unallocatedRsd) > 0 ? DIALOG.amber : DIALOG.red }}>
                            <span>{(allocCurrency ? unallocatedOwn : unallocatedRsd) > 0 ? 'Neraspoređeno' : 'Previše raspoređeno'}</span>
                            <span style={{ fontWeight: '500' }}>{formatMoney(Math.abs(allocCurrency ? unallocatedOwn : unallocatedRsd), allocCurrency || 'RSD')}</span>
                          </div>
                        )}
                        {!allocCurrency && linkedInvoices.length > 0 && (
                          <div style={{ fontSize: '10.5px', color: DIALOG.dim, marginTop: '6px', lineHeight: 1.4 }}>
                            Prikazano u RSD (knjiženo): ovo plaćanje i fakture koje zatvara nisu sve u istoj valuti.
                          </div>
                        )}
                      </div>

                      {/* An invoice in, or indexed to, a foreign currency is
                          settled at a different rate than it was raised at, so
                          in dinars it never lands exactly. What is left is not
                          a part payment. */}
                      {fxInvoice && isBookable(fxDifference) && (
                        <div style={s.fxBox}>
                          <label style={s.fxHead}>
                            <input type="checkbox" checked={bookDifference}
                              onChange={e => setBookDifference(e.target.checked)}
                              style={{ accentColor: DIALOG.accent, cursor: 'pointer' }} />
                            <span>
                              Proknjiži {fxDifference.kind === 'gain' ? 'pozitivnu' : 'negativnu'} kursnu razliku od{' '}
                              <strong>{formatMoney(fxAmountOwn, fxCurrency)}</strong>
                            </span>
                          </label>
                          <div style={s.fxNote}>{fxDifference.note}</div>
                          {bookDifference && (
                            <>
                              <div style={{ display: 'flex', alignItems: 'center', gap: '8px', marginTop: '8px' }}>
                                <span style={{ fontSize: '11.5px', color: DIALOG.dim, whiteSpace: 'nowrap' as const }}>Razvrstaj kao</span>
                                <select style={{ ...s.select, flex: 1 }}
                                  value={fxScript?.id || ''}
                                  onChange={e => setDifferenceScriptId(e.target.value)}>
                                  {fxScripts.length === 0 && <option value="">Nema sačuvanih šablona</option>}
                                  {fxScripts.map(sc => (
                                    <option key={sc.id} value={sc.id}>{sc.name} — {sc.pl_category}</option>
                                  ))}
                                </select>
                              </div>
                              {!fxScript && (
                                <div style={{ ...s.fxNote, color: DIALOG.red }}>
                                  Nema šablona za kursne razlike, pa nema klasifikacije pod kojom bi se ovo
                                  proknjižilo. Prvo napravite šablon „Kursne razlike“ u stavci izvoda ili
                                  grupnog uvoza.
                                </div>
                              )}
                              {fxScript && (
                                <div style={s.fxNote}>
                                  Dodatna transakcija ({fxDifference.direction === 'revenue' ? 'prihod' : 'trošak'}) od{' '}
                                  {formatMoney(fxAmountOwn, fxCurrency)} biće proknjižena {txDate} pod{' '}
                                  {fxScript.pl_category}{fxScript.pl_subcategory ? ' / ' + fxScript.pl_subcategory : ''}
                                  {fxDifference.linksToInvoice
                                    ? ' i povezana sa ovom fakturom da bi se ona zatvorila.'
                                    : '. Faktura je već zatvorena samim plaćanjem.'}
                                </div>
                              )}
                            </>
                          )}
                        </div>
                      )}
                      {fxInvoice && fxDifference.kind === 'allocate-first' && (
                        <div style={{ ...s.fxBox, borderColor: DIALOG.amber }}>
                          <div style={{ ...s.fxNote, color: DIALOG.amber, marginTop: 0 }}>{fxDifference.note}</div>
                        </div>
                      )}
                      {linkedInvoices.length > 1 && (parseFloat(amount) || 0) > 0 && Math.abs(unallocatedRsd) > 0.01 && (
                        <div style={s.fxBox}>
                          <div style={{ ...s.fxNote, marginTop: 0 }}>
                            Kursna razlika može da se proknjiži samo kada plaćanje zatvara jednu fakturu — kod
                            više faktura, kojoj razlika pripada je stvar procene, a ne računa.
                          </div>
                        </div>
                      )}
                    </div>
                  )}
                </div>
              )}

              {txType === 'direct' && (
                <>
                  <div style={s.section}>
                    <div style={s.sectionTitle}>Podtip</div>
                    <div style={{ display: 'flex', gap: '8px', marginBottom: '8px' }}>
                      <div style={{ ...s.typeChip, ...(directSubtype === 'expense' ? s.typeChipExpense : {}) }} onClick={() => setDirectSubtype('expense')}>📤 Trošak</div>
                      <div style={{ ...s.typeChip, ...(directSubtype === 'revenue' ? s.typeChipRevenue : {}) }} onClick={() => setDirectSubtype('revenue')}>📥 Prihod</div>
                    </div>
                  </div>

                  {directSubtype === 'expense' && (
                    <>
                      <div style={{
                        ...s.section,
                        ...(splitActive
                          ? { opacity: 0.5, pointerEvents: 'none' as const, userSelect: 'none' as const }
                          : {}),
                      }}>
                        <div style={s.sectionTitle}>P&L klasifikacija</div>
                        {splitActive && (
                          <div style={{ ...s.infoBox, marginBottom: '12px', background: DIALOG.amberFill, borderColor: DIALOG.amber, color: DIALOG.amber }}>
                            Preuzeto iz najveće stavke podele iznad i zaključano dok podela postoji.
                            P&amp;L čita podelu; ovo je ono pod čim glavna knjiga vodi plaćanje.
                            Uklonite podelu da biste ovo podesili ručno.
                          </div>
                        )}
                        {quickFillScripts.length > 0 && (
                          <div style={{ marginBottom: '12px', position: 'relative' as const }}>
                            <div style={{ position: 'relative' as const }}>
                              <input
                                style={{ width: '100%', boxSizing: 'border-box' as const, fontFamily: 'system-ui,sans-serif', fontSize: '12px', padding: '8px 28px 8px 10px', border: `1px solid ${qfOpen ? DIALOG.accent : 'rgba(29,158,117,0.3)'}`, borderRadius: '8px', background: 'rgba(29,158,117,0.05)', color: DIALOG.accent, outline: 'none' }}
                                value={qfSearch}
                                onChange={e => setQfSearch(e.target.value)}
                                onFocus={() => setQfOpen(true)}
                                onBlur={() => setTimeout(() => setQfOpen(false), 150)}
                                placeholder="⚡ Brza popuna — kliknite ili pretražite…"
                              />
                              <span style={{ position: 'absolute' as const, right: '10px', top: '50%', transform: 'translateY(-50%)', fontSize: '10px', color: DIALOG.accent, pointerEvents: 'none' as const }}>
                                {qfOpen ? '▲' : '▼'}
                              </span>
                            </div>
                            {qfOpen && (
                              <div style={{ position: 'absolute' as const, top: '100%', left: 0, right: 0, background: DIALOG.panel, border: '0.5px solid ' + DIALOG.accent, borderRadius: '8px', zIndex: 200, maxHeight: '220px', overflowY: 'auto' as const, marginTop: '2px', boxShadow: '0 8px 24px rgba(0,0,0,0.12)' }}>
                                {(() => {
                                  const filtered = quickFillScripts.filter(sc =>
                                    !qfSearch ||
                                    sc.name.toLowerCase().includes(qfSearch.toLowerCase()) ||
                                    sc.pl_category.toLowerCase().includes(qfSearch.toLowerCase()) ||
                                    sc.department.toLowerCase().includes(qfSearch.toLowerCase())
                                  )
                                  return filtered.length === 0
                                    ? <div style={{ padding: '10px 12px', fontSize: '12px', color: DIALOG.dim }}>Nema rezultata za „{qfSearch}“</div>
                                    : filtered.map(sc => (
                                        <div key={sc.id}
                                          style={{ padding: '9px 12px', cursor: 'pointer', borderBottom: '0.5px solid ' + DIALOG.borderSoft, display: 'flex', flexDirection: 'column' as const, gap: '2px' }}
                                          onMouseDown={e => { e.preventDefault(); applyQuickFill(sc.id); setQfSearch(''); setQfOpen(false) }}>
                                          <span style={{ fontSize: '12px', fontWeight: '500', color: DIALOG.accent }}>{sc.icon} {sc.name}</span>
                                          <span style={{ fontSize: '10px', color: DIALOG.dim }}>{sc.pl_category}{sc.dept_subcategory ? ` · ${sc.dept_subcategory}` : ''}</span>
                                        </div>
                                      ))
                                })()}
                              </div>
                            )}
                            {savingTemplate ? (
                              <div style={{ display: 'flex', alignItems: 'center', gap: '6px', marginTop: '6px' }}>
                                <input autoFocus style={{ ...s.input, flex: 1, fontSize: '12px', padding: '6px 9px' }}
                                  placeholder="Naziv šablona…"
                                  value={templateName}
                                  onChange={e => setTemplateName(e.target.value)}
                                  onKeyDown={e => { if (e.key === 'Enter') { e.preventDefault(); saveAsTemplate() } }} />
                                <button type="button" style={s.qfSaveBtn} onClick={saveAsTemplate}>Sačuvaj</button>
                                <button type="button" style={s.qfCancelBtn}
                                  onClick={() => { setSavingTemplate(false); setTemplateName('') }}>Otkaži</button>
                              </div>
                            ) : (
                              <button type="button" style={s.qfNewBtn}
                                title="Sačuvaj gornju klasifikaciju kao šablon, zajednički za sve"
                                onClick={() => setSavingTemplate(true)}>
                                + Sačuvaj ovu klasifikaciju kao šablon
                              </button>
                            )}
                          </div>
                        )}
                        <div style={s.row2}>
                          <div style={s.field}>
                            <label style={s.lbl}>P&L kategorija <span style={s.req}>*</span></label>
                            <div style={{ display: 'flex', gap: '6px', alignItems: 'flex-start' }}>
                            <SearchableSelect value={plCatId}
                              onChange={v => { const cat = plCategories.find(c => c.id === v); setPlCatId(v); setPlCatName(cat?.name || ''); setPlSubId(''); setPlSubName(''); touch('plCat') }}
                              options={expenseCategories.map(c => ({ value: c.id, label: c.name }))}
                              allLabel="Izaberite P&L kategoriju…" searchPlaceholder="Pretraga kategorija…"
                              style={{ ...pickerChrome, flex: 1, ...(fieldErr('plCat') ? pickerError : {}) }} />
                            <InlineCategoryAdd table="pl_categories"
                              currentCount={plCategories.length}
                              onAdded={item => { setPlCategories(prev => [...prev, { ...item, type: 'expense', sort_order: prev.length + 1 }]); setPlCatId(item.id); setPlCatName(item.name); setPlSubId(''); setPlSubName('') }} />
                            </div>
                            {fieldErr('plCat') && <span style={s.errorMsg}>{fieldErr('plCat')}</span>}
                          </div>
                          <div style={s.field}>
                            <label style={s.lbl}>Potkategorija</label>
                            <div style={{ display: 'flex', gap: '6px', alignItems: 'flex-start' }}>
                            <SearchableSelect value={plSubId}
                              onChange={v => { const sub = plSubcategories.find(s => s.id === v); setPlSubId(v); setPlSubName(sub?.name || '') }}
                              options={currentPlSubs.map(sub => ({ value: sub.id, label: sub.name }))}
                              allLabel="Izaberite potkategoriju…" searchPlaceholder="Pretraga potkategorija…"
                              disabled={!plCatId || currentPlSubs.length === 0}
                              style={{ ...pickerChrome, flex: 1 }} />
                            <InlineCategoryAdd table="pl_subcategories" parentId={plCatId} parentField="category_id"
                              currentCount={currentPlSubs.length} disabled={!plCatId}
                              onAdded={item => { setPlSubcategories(prev => [...prev, { ...item, category_id: plCatId, sort_order: prev.length + 1 }]); setPlSubId(item.id); setPlSubName(item.name) }} />
                            </div>
                          </div>
                        </div>
                        <div style={s.row2}>
                          <div style={s.field}>
                            <label style={s.lbl}>Sektor <span style={s.req}>*</span></label>
                            <div style={{ display: 'flex', gap: '6px', alignItems: 'flex-start' }}>
                            <SearchableSelect value={deptId}
                              onChange={v => { const dept = departments.find(d => d.id === v); setDeptId(v); setDeptName(dept?.name || ''); setDeptSubId(''); setDeptSubName(''); setExpDesc(''); touch('dept') }}
                              options={departments.map(d => ({ value: d.id, label: d.name }))}
                              allLabel="Izaberite sektor…" searchPlaceholder="Pretraga sektora…"
                              style={{ ...pickerChrome, flex: 1, ...(fieldErr('dept') ? pickerError : {}) }} />
                            <InlineCategoryAdd table="departments"
                              currentCount={departments.length}
                              onAdded={item => { setDepartments(prev => [...prev, { ...item, sort_order: prev.length + 1 }]); setDeptId(item.id); setDeptName(item.name); setDeptSubId(''); setDeptSubName(''); setExpDesc('') }} />
                            </div>
                            {fieldErr('dept') && <span style={s.errorMsg}>{fieldErr('dept')}</span>}
                          </div>
                          <div style={s.field}>
                            <label style={s.lbl}>Podsektor</label>
                            <div style={{ display: 'flex', gap: '6px', alignItems: 'flex-start' }}>
                            <SearchableSelect value={deptSubId}
                              onChange={v => { const sub = deptSubcategories.find(s => s.id === v); setDeptSubId(v); setDeptSubName(sub?.name || ''); setExpDesc('') }}
                              options={currentDeptSubs.map(sub => ({ value: sub.id, label: sub.name }))}
                              allLabel="Izaberite potkategoriju…" searchPlaceholder="Pretraga potkategorija…"
                              disabled={!deptId || currentDeptSubs.length === 0}
                              style={{ ...pickerChrome, flex: 1 }} />
                            <InlineCategoryAdd table="dept_subcategories" parentId={deptId} parentField="department_id"
                              currentCount={currentDeptSubs.length} disabled={!deptId}
                              onAdded={item => { setDeptSubcategories(prev => [...prev, { ...item, department_id: deptId, sort_order: prev.length + 1 }]); setDeptSubId(item.id); setDeptSubName(item.name); setExpDesc('') }} />
                            </div>
                          </div>
                        </div>
                        <div style={s.field}>
                          <label style={s.lbl}>Opis troška</label>
                          <div style={{ display: 'flex', gap: '6px', alignItems: 'flex-start' }}>
                            {currentExpDescs.length > 0 ? (
                              <SearchableSelect value={expDesc} onChange={setExpDesc}
                                options={currentExpDescs.map(d => ({ value: d.name, label: d.name }))}
                                allLabel="Izaberite opis…" searchPlaceholder="Pretraga opisa…"
                                style={{ ...pickerChrome, flex: 1 }} />
                            ) : (
                              <input style={{ ...s.input, flex: 1 }} value={expDesc} onChange={e => setExpDesc(e.target.value)} placeholder="Unesite opis troška…" />
                            )}
                            <InlineCategoryAdd table="expense_descriptions" parentId={deptSubId} parentField="dept_subcategory_id"
                              currentCount={currentExpDescs.length} disabled={!deptSubId}
                              onAdded={item => { setExpenseDescriptions(prev => [...prev, { ...item, dept_subcategory_id: deptSubId, sort_order: prev.length + 1 }]); setExpDesc(item.name) }} />
                          </div>
                        </div>
                      </div>

                      {/* ── Project ── */}
                      {projectPanel}

                      {/* ── Cash Flow Classification ── */}
                      {cfPanel}
                    </>
                  )}

                  {directSubtype === 'revenue' && (
                    <>
                    <div style={s.section}>
                      <label style={{ display: 'flex', gap: '8px', alignItems: 'flex-start', cursor: 'pointer', fontSize: '12.5px' }}>
                        <input type="checkbox" checked={isAdvanceFlag}
                          onChange={e => { setIsAdvanceFlag(e.target.checked); touch('advance') }}
                          style={{ accentColor: DIALOG.accent, cursor: 'pointer', marginTop: '2px' }} />
                        <span>
                          <strong>Avans</strong> — primljen od investitora
                          <div style={{ fontSize: '11px', color: DIALOG.dim, marginTop: '2px', lineHeight: 1.4 }}>
                            Obaveza, ne prihod: ne ulazi u bilans uspeha, mora biti na projektu, ne deli se i ne povezuje
                            sa fakturom. Situacije ga kasnije odbijaju kroz „Odbijeni avans”.
                          </div>
                        </span>
                      </label>
                      {fieldErr('advance') && <span style={s.errorMsg}>{fieldErr('advance')}</span>}
                    </div>
                    {(() => {
                      const hint = doubleCountHint(
                        { type: txType, subtype: directSubtype, isAdvance: advance }, partnerId, openInvoices)
                      return hint ? (
                        <div style={{ ...s.infoBox, background: DIALOG.amberFill, borderColor: DIALOG.amber, color: DIALOG.amber, marginBottom: '12px', fontSize: '11.5px', lineHeight: 1.5 }}>
                          {hint}{' '}
                          <span style={{ textDecoration: 'underline', cursor: 'pointer', fontWeight: 600 }}
                            onClick={() => setTxType('invoice_payment')}>Prebaci na plaćanje fakture</span>
                        </div>
                      ) : null
                    })()}
                    <div style={s.section}>
                      <div style={s.sectionTitle}>Podaci o prihodu</div>
                      <div style={s.field}>
                        <label style={s.lbl}>Vrsta prihoda {!advance && <span style={s.req}>*</span>}</label>
                        <select style={{ ...s.select, ...(fieldErr('revStream') ? s.inputError : {}) }} value={revStream}
                          onChange={e => { setRevStream(e.target.value); touch('revStream') }} onBlur={() => touch('revStream')}>
                          <option value="">Izaberite vrstu prihoda…</option>
                          {REVENUE_STREAMS.map(r => <option key={r}>{r}</option>)}
                        </select>
                        {fieldErr('revStream') && <span style={s.errorMsg}>{fieldErr('revStream')}</span>}
                      </div>
                    </div>
                    {projectPanel}
                    </>
                  )}

                  <div style={s.section}>
                    <div style={s.sectionTitle}>Oznake i napomena</div>
                    <div style={s.tagRow}>
                      {['Recurring', 'Prepayment', 'Accrual', 'Capital expenditure', 'Tax deductible', 'Reimbursable'].map(t => (
                        <span key={t} style={{ ...s.tag, ...(tags.includes(t) ? s.tagActive : {}) }} onClick={() => toggleTag(t)}>{TAG_LABEL[t] || t}</span>
                      ))}
                    </div>
                    <div style={{ marginTop: '10px' }}>
                      <label style={s.lbl}>Napomena</label>
                      <textarea style={{ ...s.textarea, marginTop: '4px' }} value={note} onChange={e => setNote(e.target.value)} placeholder="Dodatne napomene…" />
                    </div>
                  </div>
                </>
              )}
            </>
          )}

          {/* ── STEP 4 — Review ── */}
          {step === 4 && (
            <div style={s.section}>
              <div style={s.sectionTitle}>Pregled</div>
              {txType === 'credit_payment' && selectedInstallmentIds.length > 0 && (
                <div style={{ ...s.infoBox, background: DIALOG.blueFill, borderColor: DIALOG.blue, color: DIALOG.blue, marginBottom: '14px', display: 'flex', gap: '10px', alignItems: 'center' }}>
                  <span>🏦</span>
                  <div>
                    <div style={{ fontWeight: '500', marginBottom: '2px' }}>
                      Zatvara se {countOf(selectedInstallmentIds.length, 'rata', 'rate', 'rata')} kredita: {credits.find(c => c.id === selectedCreditId)?.name || '—'}
                    </div>
                    <div style={{ fontSize: '11px', fontFamily: "'DM Mono',monospace" }}>
                      Ukupno: {fmtMoney(creditSelectedTotal, creditCurrency || 'RSD')}
                    </div>
                  </div>
                </div>
              )}
          {isValid ? (
                <div style={{ ...s.infoBox, marginBottom: '14px', display: 'flex', gap: '10px', alignItems: 'center' }}>
                  <span>✅</span>
                  <div>
                    <div style={{ fontWeight: '500', marginBottom: '2px' }}>Sva polja su ispravna — spremno za knjiženje</div>
                    <div style={{ fontSize: '11px', opacity: 0.85 }}>{advance ? 'Avans: novac primljen, obaveza prema investitoru — bez uticaja na bilans uspeha.' : txType === 'direct' ? 'Ova transakcija direktno utiče na P&L.' : txType === 'credit_payment' ? `Pravi P&L stavki: ${selectedInstallmentIds.length * 2} (glavnica i kamata po rati).` : `Ova transakcija zatvara ${countOf(linkedInvoices.length, 'fakturu', 'fakture', 'faktura')}. Bez uticaja na P&L.`}</div>
                  </div>
                </div>
              ) : (
                <div style={{ ...s.validationBanner, marginBottom: '14px', position: 'relative' }}>
                  <span>⚠️</span>
                  <div>
                    <div style={{ fontWeight: '500', fontSize: '12px' }}>Nedostaju obavezna polja: {totalErrors}</div>
                    <div style={{ fontSize: '11px', marginTop: '2px' }}>{Object.values(errors).join(' · ')}</div>
                  </div>
                </div>
              )}
              {[
                { title: 'Podaci o transakciji', rows: [
                  ['Firma', companies.find(c => c.id === companyId)?.name || '—'],
                  ['Banka', banks.find(b => b.id === bankId)?.name || '—'],
                  ['Partner', showNewPartner ? newPartnerName : (partners.find(p => p.id === partnerId)?.name || partnerSearch || '—')],
                  ['Datum', txDate],
                  ['Tip', txType === 'invoice_payment' ? 'Plaćanje fakture' : txType === 'credit_payment' ? 'Otplata kredita' : txType === 'passthrough' ? 'Prolazna stavka' : advance ? `${ADVANCE_LABEL} (bez uticaja na bilans uspeha)` : `Direktna (${directSubtype === 'revenue' ? 'prihod' : 'trošak'})`],
                  ...(advance ? [['Projekat', projectLabelById(projects, projectId)]] : []),
                ]},
                ...(txType === 'invoice_payment' && linkedInvoices.length > 0 ? [{ title: 'Povezane fakture', rows: linkedInvoices.map(l => [`${l.partner_name} (${l.invoice_number})`, `raspoređeno ${formatMoney(l.allocated_own || 0, allocationCurrency(l))}`]) }] : []),
                ...(txType === 'direct' && directSubtype === 'expense' ? [{ title: 'P&L i vrsta troška', rows: [
                  ['P&L kategorija', plCatName || '—'],
                  ['Sektor', deptName || '—'],
                  ['Opis', expDesc || '—'],
                  ['Projekat', splitActive ? 'Po stavkama podele' : projectLabelById(projects, projectId)],
                  ['Novčani tok', cfLabel()],
                ]}] : []),
                { title: 'Iznosi', rows: [
                  ['Originalni iznos', amount ? fmtMoney(parseFloat(amount), currency) : '—'],
                  ['Kurs', book.amounts ? `${fmtNum(book.amounts.exchange_rate, 4)} RSD/${currency} · EUR ${fmtNum(book.amounts.eur_rate, 4)} (${rateSource || 'ručno'})` : 'nije dostupno'],
                  ['RSD (knjiženo)', book.amounts ? fmtMoney(amountRsd, 'RSD') : '—'],
                  ['EUR', book.amounts ? fmtMoney(amountEur, 'EUR') : '—'],
                ]},
              ].map(sec => (
                <div key={sec.title} style={s.reviewSection}>
                  <div style={s.reviewTitle}>{sec.title}</div>
                  <table style={{ width: '100%', borderCollapse: 'collapse' as const, fontSize: '13px' }}>
                    {sec.rows.map(([k, v]) => (
                      <tr key={k}>
                        <td style={{ color: DIALOG.dim, padding: '5px 0', width: '45%', borderBottom: '0.5px solid ' + DIALOG.borderSoft }}>{k}</td>
                        <td style={{ fontWeight: '500', color: DIALOG.text, padding: '5px 0', borderBottom: '0.5px solid ' + DIALOG.borderSoft }}>{v}</td>
                      </tr>
                    ))}
                  </table>
                </div>
              ))}
            </div>
          )}
        </div>

        <div style={s.footer}>
          <div style={{ display: 'flex', alignItems: 'center', gap: '8px' }}>
            <span style={{ fontSize: '12px', color: DIALOG.dim }}>Korak {step} od 4</span>
            {totalErrors > 0 && Object.keys(touched).length > 0 && (
              <span style={{ fontSize: '11px', color: DIALOG.red, background: DIALOG.redFill, padding: '2px 8px', borderRadius: '20px' }}>
                Nedostaje polja: {totalErrors}
              </span>
            )}
          </div>
          <div style={{ display: 'flex', gap: '8px' }}>
            {step > 1 && <button style={s.btnGhost} onClick={() => setStep(step - 1)}>Nazad</button>}
            {step < 4 && <button style={s.btnPrimary} onClick={() => { touchStep(step); setStep(step + 1) }}>Dalje</button>}
            {step === 4 && (
              <button
                style={{ ...s.btnPrimary, opacity: saving || whySplit ? 0.55 : 1 }}
                onClick={handlePost}
                disabled={saving || !!whySplit}
                title={whySplit || undefined}>
                {saving ? 'Čuvanje…' : transaction ? 'Sačuvaj izmene' : 'Proknjiži transakciju'}
              </button>
            )}
          </div>
        </div>
      </div>
    </div>
  )
}

const s: Record<string, React.CSSProperties> = {
  ...chrome,

  dialog: { background: DIALOG.panel, borderRadius: '16px', width: '800px', maxWidth: '95vw', maxHeight: '90vh', display: 'flex', flexDirection: 'column', overflow: 'hidden' },

  stepsBar: { display: 'flex', alignItems: 'center', padding: '0.75rem 1.5rem', borderBottom: '0.5px solid ' + DIALOG.border, gap: 0, overflowX: 'auto' },
  stepItem: { display: 'flex', alignItems: 'center', gap: '6px', cursor: 'pointer', padding: '4px 8px', borderRadius: '8px', whiteSpace: 'nowrap' as const },
  stepNum: { width: '22px', height: '22px', borderRadius: '50%', display: 'flex', alignItems: 'center', justifyContent: 'center', fontSize: '11px', fontWeight: '500', background: DIALOG.raised, color: DIALOG.dim, border: '0.5px solid ' + DIALOG.border, flexShrink: 0 },
  stepActive: { background: DIALOG.accent, color: DIALOG.onAccent, borderColor: DIALOG.accent },
  stepDone: { background: DIALOG.accentFill, color: DIALOG.accent, borderColor: DIALOG.accent },
  stepError: { background: DIALOG.redFill, color: DIALOG.red, borderColor: DIALOG.red },
  stepLabel: { fontSize: '12px', color: DIALOG.dim },
  stepDiv: { width: '20px', height: '0.5px', background: DIALOG.border, flexShrink: 0 },
  validationBanner: { display: 'flex', alignItems: 'flex-start', gap: '10px', background: DIALOG.redFill, borderBottom: '0.5px solid ' + DIALOG.redSoft, padding: '10px 1.5rem', color: DIALOG.red },
  bannerClose: { background: 'none', border: 'none', fontSize: '18px', cursor: 'pointer', color: DIALOG.red, padding: '0', lineHeight: 1 },
  body: { padding: '1.5rem', overflowY: 'auto', flex: 1 },
  footer: { padding: '1rem 1.5rem', borderTop: '0.5px solid ' + DIALOG.border, display: 'flex', alignItems: 'center', justifyContent: 'space-between', background: DIALOG.raised },
  section: { marginBottom: '1.5rem' },
  sectionTitle: { fontSize: '11px', fontWeight: '500', color: DIALOG.dim, textTransform: 'uppercase' as const, letterSpacing: '0.08em', marginBottom: '10px', paddingBottom: '6px', borderBottom: '0.5px solid ' + DIALOG.border },
  row2: { display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '12px', marginBottom: '12px' },
  row3: { display: 'grid', gridTemplateColumns: '1fr 1fr 1fr', gap: '12px', marginBottom: '12px' },
  field: { display: 'flex', flexDirection: 'column' as const, gap: '4px', position: 'relative' as const },
  lbl: { fontSize: '11px', fontWeight: '500', color: DIALOG.dim, textTransform: 'uppercase' as const, letterSpacing: '0.07em' },
  req: { color: DIALOG.red },
  qfNewBtn: {
    fontFamily: 'system-ui,sans-serif', fontSize: '11px', padding: '5px 0',
    border: 'none', background: 'transparent', color: DIALOG.accent,
    cursor: 'pointer', marginTop: '4px', textAlign: 'left' as const,
  },
  qfSaveBtn: {
    fontFamily: 'system-ui,sans-serif', fontSize: '11.5px', padding: '6px 12px',
    border: 'none', borderRadius: '6px', background: DIALOG.accent,
    color: DIALOG.onAccent, fontWeight: '600', cursor: 'pointer', whiteSpace: 'nowrap' as const,
  },
  qfCancelBtn: {
    fontFamily: 'system-ui,sans-serif', fontSize: '11.5px', padding: '6px 10px',
    borderRadius: '6px', border: '0.5px solid ' + DIALOG.border,
    background: 'transparent', color: DIALOG.dim, cursor: 'pointer', whiteSpace: 'nowrap' as const,
  },
  select: { fontFamily: 'system-ui,sans-serif', fontSize: '13px', padding: '8px 10px', border: '0.5px solid ' + DIALOG.border, borderRadius: '8px', background: DIALOG.panel, color: DIALOG.text, outline: 'none' },
  input: { fontFamily: 'system-ui,sans-serif', fontSize: '13px', padding: '8px 10px', border: '0.5px solid ' + DIALOG.border, borderRadius: '8px', background: DIALOG.panel, color: DIALOG.text, outline: 'none' },
  inputError: { border: '1.5px solid ' + DIALOG.red, background: DIALOG.redFill },
  errorMsg: { fontSize: '11px', color: DIALOG.red, marginTop: '2px' },
  textarea: { fontFamily: 'system-ui,sans-serif', fontSize: '13px', padding: '8px 10px', border: '0.5px solid ' + DIALOG.border, borderRadius: '8px', background: DIALOG.panel, color: DIALOG.text, outline: 'none', resize: 'vertical' as const, minHeight: '60px' },
  dropdown: { position: 'absolute' as const, top: '100%', left: 0, right: 0, background: DIALOG.panel, border: '0.5px solid ' + DIALOG.border, borderRadius: '8px', zIndex: 100, boxShadow: '0 4px 12px rgba(0,0,0,0.08)', marginTop: '2px' },
  dropdownItem: { padding: '8px 12px', fontSize: '13px', color: DIALOG.text, cursor: 'pointer', borderBottom: '0.5px solid ' + DIALOG.borderSoft },
  linkBtn: { background: 'none', border: 'none', color: DIALOG.accent, fontSize: '12px', cursor: 'pointer', padding: '4px 0', fontFamily: 'system-ui,sans-serif' },
  typeGrid: { display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '12px' },
  typeCard: { border: '0.5px solid ' + DIALOG.border, borderRadius: '10px', padding: '16px', background: DIALOG.raised, cursor: 'pointer', textAlign: 'center' as const },
  typeCardPayment: { border: '2px solid ' + DIALOG.blue, background: DIALOG.blueFill },
  typeCardDirect: { border: '2px solid ' + DIALOG.accent, background: DIALOG.accentFill },
  typeCardTitle: { fontSize: '13px', fontWeight: '600', color: DIALOG.text, marginBottom: '4px' },
  typeCardSub: { fontSize: '11px', color: DIALOG.dim, lineHeight: '1.4' },
  typeChip: { flex: 1, padding: '9px 12px', border: '0.5px solid ' + DIALOG.border, borderRadius: '8px', background: DIALOG.raised, fontSize: '13px', cursor: 'pointer', textAlign: 'center' as const, fontWeight: '500', color: DIALOG.dim },
  typeChipExpense: { border: '2px solid ' + DIALOG.red, background: DIALOG.redFill, color: DIALOG.red },
  typeChipRevenue: { border: '2px solid ' + DIALOG.accent, background: DIALOG.accentFill, color: DIALOG.accent },
  infoBox: { background: DIALOG.accentFill, border: '0.5px solid ' + DIALOG.accent, borderRadius: '8px', padding: '8px 12px', fontSize: '12px', color: DIALOG.accent },
  invoiceList: { display: 'flex', flexDirection: 'column' as const, gap: '6px', maxHeight: '240px', overflowY: 'auto' as const },
  invoiceRow: { display: 'flex', alignItems: 'center', gap: '10px', padding: '10px 12px', border: '0.5px solid ' + DIALOG.border, borderRadius: '8px', background: DIALOG.panel },
  invoiceRowLinked: { border: '1.5px solid ' + DIALOG.accent, background: DIALOG.accentFill },
  invNumBadge: { fontSize: '11px', color: DIALOG.dim, background: DIALOG.raised, padding: '1px 6px', borderRadius: '4px', fontFamily: 'monospace' },
  statusBadge: { fontSize: '10px', fontWeight: '500', padding: '1px 7px', borderRadius: '20px' },
  addBtn: { fontFamily: 'system-ui,sans-serif', fontSize: '12px', padding: '5px 12px', border: '0.5px solid ' + DIALOG.accent, borderRadius: '6px', background: 'transparent', color: DIALOG.accent, cursor: 'pointer', whiteSpace: 'nowrap' as const },
  removeBtn: { fontFamily: 'system-ui,sans-serif', fontSize: '12px', padding: '5px 12px', border: '0.5px solid ' + DIALOG.red, borderRadius: '6px', background: 'transparent', color: DIALOG.red, cursor: 'pointer', whiteSpace: 'nowrap' as const },
  allocRow: { display: 'flex', alignItems: 'center', gap: '12px', padding: '10px 12px', background: DIALOG.raised, borderRadius: '8px', marginBottom: '6px' },
  fxBox: {
    marginTop: '10px', padding: '10px 12px', borderRadius: '8px',
    borderWidth: '0.5px', borderStyle: 'solid', borderColor: DIALOG.border,
    background: DIALOG.raised,
  },
  fxHead: {
    display: 'flex', alignItems: 'flex-start', gap: '8px',
    fontSize: '12.5px', color: DIALOG.text, lineHeight: 1.5, cursor: 'pointer',
  },
  fxNote: { fontSize: '11px', color: DIALOG.dim, lineHeight: 1.5, marginTop: '6px' },
  detachBtn: {
    fontFamily: 'system-ui,sans-serif', fontSize: '11px', padding: '6px 10px',
    borderRadius: '6px', border: '0.5px solid ' + DIALOG.border,
    background: 'transparent', color: DIALOG.dim, cursor: 'pointer', whiteSpace: 'nowrap' as const,
  },
  releaseNotice: {
    fontSize: '11.5px', lineHeight: 1.5, color: DIALOG.amber,
    background: DIALOG.amberFill, border: '0.5px solid ' + DIALOG.amber,
    borderRadius: '8px', padding: '9px 12px', marginBottom: '10px',
  },
  allocSummaryBox: { background: DIALOG.panel, border: '0.5px solid ' + DIALOG.border, borderRadius: '8px', padding: '10px 14px', marginTop: '8px' },
  allocSummaryRow: { display: 'flex', justifyContent: 'space-between', fontSize: '13px', color: DIALOG.dim, padding: '3px 0', borderBottom: '0.5px solid ' + DIALOG.borderSoft },
  allocGrid: { display: 'grid', gridTemplateColumns: 'repeat(4,1fr)', gap: '8px' },
  allocBtn: { border: '0.5px solid ' + DIALOG.border, borderRadius: '8px', padding: '8px 6px', background: DIALOG.raised, cursor: 'pointer', textAlign: 'center' as const },
  allocBtnActive: { border: '2px solid ' + DIALOG.accent, background: DIALOG.accentFill },
  allocBtnLabel: { fontSize: '11px', fontWeight: '500', color: DIALOG.text },
  allocBtnSub: { fontSize: '10px', color: DIALOG.dim, marginTop: '2px' },
  tagRow: { display: 'flex', flexWrap: 'wrap' as const, gap: '6px' },
  tag: { fontSize: '11px', padding: '4px 10px', borderRadius: '20px', border: '0.5px solid ' + DIALOG.border, background: DIALOG.raised, color: DIALOG.dim, cursor: 'pointer' },
  tagActive: { background: DIALOG.accentFill, borderColor: DIALOG.accent, color: DIALOG.accent },
  toggleRow: { display: 'flex', alignItems: 'center', gap: '10px', padding: '8px 12px', background: DIALOG.raised, borderRadius: '8px', border: '0.5px solid ' + DIALOG.border, marginBottom: '8px' },
  toggleLabel: { fontSize: '13px', color: DIALOG.text, flex: 1 },
  toggle: { position: 'relative' as const, width: '36px', height: '20px', cursor: 'pointer', flexShrink: 0 },
  toggleSlider: { position: 'absolute' as const, inset: 0, borderRadius: '10px', transition: 'background 0.2s', display: 'block' },
  fetchBtn: { fontFamily: 'system-ui,sans-serif', fontSize: '12px', padding: '8px 10px', border: '0.5px solid ' + DIALOG.border, borderRadius: '8px', background: DIALOG.raised, color: DIALOG.dim, cursor: 'pointer' },
  convRow: { display: 'grid', gridTemplateColumns: '1fr auto 1fr', gap: '12px', alignItems: 'center', marginTop: '12px', padding: '12px', background: DIALOG.raised, borderRadius: '8px' },
  convLabel: { fontSize: '11px', color: DIALOG.dim, marginBottom: '4px' },
  convVal: { fontSize: '16px', fontWeight: '500', color: DIALOG.text },
  reviewSection: { background: DIALOG.raised, borderRadius: '8px', padding: '12px', marginBottom: '10px' },
  reviewTitle: { fontSize: '11px', fontWeight: '500', color: DIALOG.dim, textTransform: 'uppercase' as const, letterSpacing: '0.07em', marginBottom: '8px' },
  btnGhost: { fontFamily: 'system-ui,sans-serif', fontSize: '13px', padding: '8px 16px', borderRadius: '8px', border: '0.5px solid ' + DIALOG.border, background: 'transparent', color: DIALOG.dim, cursor: 'pointer' },
  btnPrimary: { fontFamily: 'system-ui,sans-serif', fontSize: '13px', padding: '8px 16px', borderRadius: '8px', border: 'none', background: DIALOG.accent, color: DIALOG.onAccent, cursor: 'pointer', fontWeight: '500' },
}

// `SearchableSelect` paints its border with longhands so it can recolour just
// the edge when the list opens, and React warns about mixing those with the
// `border` shorthand on one element. So the shorthand is dropped here and the
// control keeps its own border, which is the same weight and colour.
// eslint-disable-next-line @typescript-eslint/no-unused-vars
const { border: _pickerBorder, ...pickerChrome } = s.select
/** The invalid state, in longhands for the same reason. */
const pickerError: React.CSSProperties = {
  borderWidth: '1.5px', borderStyle: 'solid', borderColor: DIALOG.red, background: DIALOG.redFill,
}
