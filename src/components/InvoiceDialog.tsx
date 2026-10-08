import React, { useState, useEffect } from 'react'
import { supabase } from '../supabase'
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
import { bookAmountsAtRate, getBookRates, rateFor, type BookAmounts } from '../services/bookAmounts'
import PartnerDialog from './PartnerDialog'
import { DIALOG, chrome } from './dialogTheme'
import SearchableSelect from './SearchableSelect'
import { reallocateInvoiceLink } from '../services/writeOrder'
import {
  chooseAccount, carriedAccountOf, defaultAccount,
} from '../services/partnerAccountChoice'
import { fmtLocal, fmtMoney, fmtNum } from '../utils/formatters'
import { fetchAllPartners } from '../services/allPartners'
import { DOCUMENT_CURRENCIES } from '../services/bookAmounts'
import { REVENUE_STREAMS } from '../services/revenueStreams'

interface Props {
  onClose: () => void
  invoice?: any
}

interface ValidationErrors { [key: string]: string }

export default function InvoiceDialog({ onClose, invoice }: Props) {
  const [step, setStep] = useState(1)
  const [saving, setSaving] = useState(false)
  const [success, setSuccess] = useState(false)
  const [errors, setErrors] = useState<ValidationErrors>({})
  const [touched, setTouched] = useState<Record<string, boolean>>({})
  const [showValidationSummary, setShowValidationSummary] = useState(false)
  /** What the database refused, shown to the owner instead of logged to a console they never open. */
  const [saveError, setSaveError] = useState('')

  const { companies, defaultCompany, showPicker } = useCompanies()
  const { projects } = useProjects()
  const [partners, setPartners] = useState<any[]>([])
  const [plCategories, setPlCategories] = useState<any[]>([])
  const [plSubcategories, setPlSubcategories] = useState<any[]>([])
  const [departments, setDepartments] = useState<any[]>([])
  const [deptSubcategories, setDeptSubcategories] = useState<any[]>([])
  const [expenseDescriptions, setExpenseDescriptions] = useState<any[]>([])
  const [directTransactions, setDirectTransactions] = useState<any[]>([])
  const [linkedTxId, setLinkedTxId] = useState('')
  const [reconcileSearch, setReconcileSearch] = useState('')
  const [plImpact, setPlImpact] = useState(true)
  const [partnerAccounts, setPartnerAccounts] = useState<any[]>([])
  const [selectedAccountId, setSelectedAccountId] = useState('')

  const [companyId, setCompanyId] = useState('')

  // One company: it is the company, and nobody is asked to choose it.
  useEffect(() => {
    if (!showPicker && defaultCompany) setCompanyId(prev => prev || defaultCompany.id)
  }, [showPicker, defaultCompany])
  const [partnerId, setPartnerId] = useState('')
  const [partnerSearch, setPartnerSearch] = useState('')
  const [newPartnerName, setNewPartnerName] = useState('') // eslint-disable-line
  const [showNewPartner, setShowNewPartner] = useState(false) // eslint-disable-line
  const [partnerDialogOpen, setPartnerDialogOpen] = useState(false)
  const [partnerDialogInitialName, setPartnerDialogInitialName] = useState('')
  const [invoiceNumber, setInvoiceNumber] = useState('')
  const [invoiceDate, setInvoiceDate] = useState(new Date().toISOString().split('T')[0])
  const [dueDate, setDueDate] = useState('')
  const [invType, setInvType] = useState<'expense' | 'revenue'>('expense')
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
  // The site or building this bill belongs to; null is company overhead.
  // Null while the bill is split — the lines carry the projects then.
  const [projectId, setProjectId] = useState<string | null>(null)
  const [deptSplit, setDeptSplit] = useState('none')
  const [note, setNote] = useState('')
  const [tags, setTags] = useState<string[]>([])
  const [accNum, setAccNum] = useState('')
  const [model, setModel] = useState('')
  const [refNum, setRefNum] = useState('')
  const [currency, setCurrency] = useState('')
  const [amount, setAmount] = useState('')
  // RSD per 1 unit of `currency`, and RSD per 1 EUR — fetched from NBS or
  // typed by hand. On a EUR invoice the two are the same number.
  const [exRate, setExRate] = useState('')
  const [eurRate, setEurRate] = useState('')
  const [isIndexed, setIsIndexed] = useState(false)
  const [rateSource, setRateSource] = useState('')
  const [rateMissing, setRateMissing] = useState(false)
  const [fetchingRate, setFetchingRate] = useState(false)

  // Cash Flow Classification
  const [cfType, setCfType] = useState(invoice?.cf_type || '')
  const [cfFrequency, setCfFrequency] = useState(invoice?.cf_frequency || 'monthly')
  const [cfNextMonthEst, setCfNextMonthEst] = useState(invoice?.cf_next_month_est?.toString() || '')
  const [cfAccrualFrom, setCfAccrualFrom] = useState(invoice?.cf_accrual_from || '')
  const [cfAccrualTo, setCfAccrualTo] = useState(invoice?.cf_accrual_to || '')
  const [cfCapexMonths, setCfCapexMonths] = useState(invoice?.cf_capex_months?.toString() || '')
  const [cfReimbursableDate, setCfReimbursableDate] = useState(invoice?.cf_reimbursable_date || '')

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

  /**
   * The costs this one bill is made of, where it is more than one.
   *
   * Empty means what it has always meant: a single expense, classified by the
   * fields below. The split does not replace them — the bill still carries a
   * classification of its own, which is what every reader outside the P&L
   * uses — it says what the P&L should see INSTEAD.
   */
  const [splitLines, setSplitLines] = useState<SplitLine[]>([])

  useEffect(() => {
    if (!invoice?.id) { setSplitLines([]); return }
    let cancelled = false
    loadSplits(supabase, 'invoice', invoice.id).then(rows => {
      if (!cancelled) setSplitLines(linesFrom(rows as any, n => `line-${n}`))
    })
    return () => { cancelled = true }
  }, [invoice?.id])
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
  /** The bill as a split parent: its own figure and its book columns. */
  const splitParent = {
    amount: parseFloat(amount) || 0,
    currency: currency || undefined,
    exchange_rate: book.amounts?.exchange_rate ?? null,
    eur_rate: book.amounts?.eur_rate ?? null,
    amount_rsd: book.amounts?.amount_rsd ?? null,
    amount_eur: book.amounts?.amount_eur ?? null,
  }

  /**
   * Why the split cannot be posted, or null. Guards the button as well as
   * showing in the editor: a reader can reach step 4 without scrolling back,
   * and a bill posted with a split that does not add up is a P&L short by the
   * difference in one category and long in none.
   */
  const whySplit = whySplitNotSavable(splitParent, splitLines)

  const splitActive = splitLines.length > 0

  /** Lines changed in the editor: the project moves between the bill and
   *  its lines by one rule (splitProjectChange) — never on both at once. */
  const changeSplitLines = (next: SplitLine[]) => {
    const out = splitProjectChange(splitLines, next, projectId)
    setSplitLines(out.lines)
    setProjectId(out.parentProjectId)
  }

  /**
   * While a bill is split, its own classification is TAKEN from the split
   * rather than typed.
   *
   * It is still needed — the ledger lists it and the cash side reads it — but
   * two classifications on one screen, one of which the report ignores, is a
   * form that invites somebody to set the wrong one carefully. So the fields
   * below are filled from the biggest line and locked, and say so.
   */
  useEffect(() => {
    const from = classificationFromSplit(splitLines)
    if (!from) return
    setPlCatName(from.pl_category)
    setPlSubName(from.pl_subcategory)
    setDeptName(from.department)
    setDeptSubName(from.dept_subcategory)
    setExpDesc(from.expense_description)
    // The pickers are keyed by id, so the ids follow the names or the
    // controls would show nothing while the payload carried something.
    setPlCatId(plCategories.find(c => c.name === from.pl_category)?.id || '')
    setPlSubId(plSubcategories.find(c => c.name === from.pl_subcategory)?.id || '')
    setDeptId(departments.find(c => c.name === from.department)?.id || '')
    setDeptSubId(deptSubcategories.find(c => c.name === from.dept_subcategory)?.id || '')
  }, [splitLines, plCategories, plSubcategories, departments, deptSubcategories])

  const getPlSubs = (catId: string) => plSubcategories.filter(s => s.category_id === catId)
  const getDeptSubs = (dId: string) => deptSubcategories.filter(s => s.department_id === dId)
  const getExpDescs = (subId: string) => expenseDescriptions.filter(e => e.dept_subcategory_id === subId)
  const revenueStreams = REVENUE_STREAMS

  const runValidation = () => {
    const e: ValidationErrors = {}
    if (!companyId) e.companyId = 'Company is required'
    if (!currency) e.currency = 'Currency is required'
    if (!invoiceDate) e.invoiceDate = 'Invoice date is required'
    if (!partnerId && !(showNewPartner && newPartnerName.trim())) e.partnerId = 'Partner is required'
    if (!amount || parseFloat(amount) <= 0) e.amount = 'Amount must be greater than 0'
    if (currency && parseFloat(amount) > 0 && !book.amounts) e.exRate = book.error || 'Exchange rate is required'
    if (invType === 'expense' && plImpact && !linkedTxId) {
      // A split bill is classified by its lines, and the fields below are
      // filled from them. Demanding them again would refuse a bill that is
      // fully classified, which is how a correct entry comes to look wrong.
      if (!plCatId && !splitActive) e.plCat = 'P&L Category is required'
      if (!deptId && !splitActive) e.dept = 'Department is required'
    }
    if (invType === 'revenue' && !revStream) e.revStream = 'Revenue stream is required'
    return e
  }

  useEffect(() => {
    setErrors(runValidation())
  }, [companyId, currency, invoiceDate, partnerId, newPartnerName, showNewPartner, invType, plCatId, deptId, revStream, amount, exRate, eurRate, plImpact, linkedTxId]) // eslint-disable-line

  useEffect(() => {
    const load = async () => {
      const [
        part,
        { data: plCat }, { data: plSub },
        { data: dept }, { data: deptSub }, { data: expD },
      ] = await Promise.all([
        fetchAllPartners(supabase),
        supabase.from('pl_categories').select('id,name,type,sort_order').order('sort_order'),
        supabase.from('pl_subcategories').select('id,name,category_id,sort_order').order('sort_order'),
        supabase.from('departments').select('id,name,sort_order').order('sort_order'),
        supabase.from('dept_subcategories').select('id,name,department_id,sort_order').order('sort_order'),
        supabase.from('expense_descriptions').select('id,name,dept_subcategory_id,sort_order').order('sort_order'),
      ])
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
    if (!companyId) return
    const load = async () => {
      const { data, error } = await supabase
        .from('transactions')
        .select('id, transaction_date, amount, amount_rsd, amount_eur, currency, pl_category, pl_subcategory, department, dept_subcategory, expense_description, revenue_stream, project_id, dept_split_type, tags, note, exchange_rate, eur_rate, is_indexed, banks(id,name), partners(id,name)')
        .eq('company_id', companyId).eq('type', 'direct').eq('status', 'posted')
        .order('transaction_date', { ascending: false }).limit(150)
      if (error) console.error('transactions load error:', error)
      if (data) setDirectTransactions(data)
    }
    load()
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
      const { data } = await supabase.from('partner_accounts').select('*')
        .eq('partner_id', partnerId).eq('currency', 'RSD').order('is_primary', { ascending: false })
      // A second partner picked before the first resolved would otherwise
      // land its accounts on top of the right ones.
      if (cancelled) return
      const accounts = data || []
      setPartnerAccounts(accounts)

      // What the bill ALREADY says — and only where this is the bill's own
      // partner. Picking a different supplier mid-edit means the old account
      // belongs to somebody else, and the new one's default is then right.
      const carried = carriedAccountOf(invoice, partnerId)

      const chosen = chooseAccount(accounts, carried)
      if (chosen) {
        setSelectedAccountId(chosen.accountId)
        setAccNum(chosen.accountNumber)
        setModel(chosen.model)
      } else if (!carried) {
        const partner = partners.find(p => p.id === partnerId)
        if (partner?.account_number) setAccNum(partner.account_number)
        if (partner?.model) setModel(partner.model)
      }

      // The reference number is a default for a bill that has none, and this
      // resolves long after the closure was made — so it is read from the
      // current value rather than from a `refNum` captured when the partner
      // changed, which is how a stale empty string overwrites a typed one.
      if (!carried) {
        const fallback = defaultAccount(accounts)
        if (fallback?.reference_number) {
          setRefNum(prev => prev || fallback.reference_number || '')
        }
      }
    }
    load()
    return () => { cancelled = true }
  }, [partnerId, invoice]) // eslint-disable-line

  useEffect(() => {
    if (invoiceNumber && !linkedTxId) setRefNum(invoiceNumber)
  }, [invoiceNumber]) // eslint-disable-line

  const handleAccountSelect = (accountId: string) => {
    setSelectedAccountId(accountId)
    const acc = partnerAccounts.find(a => a.id === accountId)
    if (acc) { setAccNum(acc.account_number || ''); setModel(acc.model || '') }
  }

  const handleLinkTransaction = (tx: any) => {
    setLinkedTxId(tx.id); setPlImpact(false)
    if (tx.partners) { setPartnerId(tx.partners.id || ''); setPartnerSearch(tx.partners.name || '') }
    if (tx.pl_category) { const cat = plCategories.find(c => c.name === tx.pl_category); if (cat) { setPlCatId(cat.id); setPlCatName(cat.name) } }
    if (tx.pl_subcategory) { setPlSubName(tx.pl_subcategory); const sub = plSubcategories.find(s => s.name === tx.pl_subcategory); if (sub) setPlSubId(sub.id) }
    if (tx.department) { const dept = departments.find(d => d.name === tx.department); if (dept) { setDeptId(dept.id); setDeptName(dept.name) } }
    if (tx.dept_subcategory) { setDeptSubName(tx.dept_subcategory); const sub = deptSubcategories.find(s => s.name === tx.dept_subcategory); if (sub) setDeptSubId(sub.id) }
    if (tx.expense_description) setExpDesc(tx.expense_description)
    if (tx.revenue_stream) setRevStream(tx.revenue_stream)
    if (tx.project_id) setProjectId(tx.project_id)
    if (tx.dept_split_type) setDeptSplit(tx.dept_split_type)
    if (tx.tags) setTags(tx.tags)
    if (tx.note) setNote(tx.note)
    if (tx.amount) setAmount(tx.amount.toString())
    if (tx.currency) setCurrency(tx.currency)
    if (tx.exchange_rate) { setExRate(tx.exchange_rate.toString()); setRateSource('From transaction') }
    if (tx.eur_rate) setEurRate(tx.eur_rate.toString())
    if (tx.is_indexed !== undefined) setIsIndexed(tx.is_indexed)
    if (invoiceNumber) setRefNum(invoiceNumber)
  }

  const handleUnlink = () => { setLinkedTxId(''); setPlImpact(true) }

  useEffect(() => {
    if (!invoice) return
    setCompanyId(invoice.company_id || ''); setPartnerId(invoice.partner_id || '')
    setPartnerSearch(invoice.partners?.name || ''); setInvoiceNumber(invoice.invoice_number || '')
    setInvoiceDate(invoice.invoice_date || ''); setDueDate(invoice.due_date || '')
    setInvType(invoice.type || 'expense'); setPlCatName(invoice.pl_category || '')
    setPlSubName(invoice.pl_subcategory || ''); setDeptName(invoice.department || '')
    setDeptSubName(invoice.dept_subcategory || ''); setExpDesc(invoice.expense_description || '')
    setRevStream(invoice.revenue_stream || ''); setProjectId(invoice.project_id ?? null)
    setDeptSplit(invoice.dept_split_type || 'none'); setNote(invoice.note || '')
    setTags(invoice.tags || []); setAccNum(invoice.account_number || '')
    setModel(invoice.model || ''); setRefNum(invoice.reference_number || '')
    setCurrency(invoice.currency || ''); setAmount(invoice.amount?.toString() || '')
    setExRate(invoice.exchange_rate?.toString() || ''); setIsIndexed(invoice.is_indexed || false)
    setEurRate(invoice.eur_rate?.toString() || '')
    setPlImpact(invoice.pl_impact !== false)
    setCfType(invoice.cf_type || '')
    setCfFrequency(invoice.cf_frequency || 'monthly')
    setCfNextMonthEst(invoice.cf_next_month_est?.toString() || '')
    setCfAccrualFrom(invoice.cf_accrual_from || '')
    setCfAccrualTo(invoice.cf_accrual_to || '')
    setCfCapexMonths(invoice.cf_capex_months?.toString() || '')
    setCfReimbursableDate(invoice.cf_reimbursable_date || '')
  }, [invoice])

  useEffect(() => { if (invoice && plCategories.length > 0) { const cat = plCategories.find(c => c.name === invoice.pl_category); if (cat) setPlCatId(cat.id) } }, [invoice, plCategories])
  useEffect(() => { if (invoice && plSubcategories.length > 0 && plCatId) { const sub = plSubcategories.find(s => s.name === invoice.pl_subcategory && s.category_id === plCatId); if (sub) setPlSubId(sub.id) } }, [invoice, plSubcategories, plCatId])
  useEffect(() => { if (invoice && departments.length > 0) { const dept = departments.find(d => d.name === invoice.department); if (dept) setDeptId(dept.id) } }, [invoice, departments])
  useEffect(() => { if (invoice && deptSubcategories.length > 0 && deptId) { const sub = deptSubcategories.find(s => s.name === invoice.dept_subcategory && s.department_id === deptId); if (sub) setDeptSubId(sub.id) } }, [invoice, deptSubcategories, deptId])

  const filteredPartners = partners.filter(p => !partnerSearch || p.name.toLowerCase().includes(partnerSearch.toLowerCase()))
  const filteredDirectTx = directTransactions.filter(tx => {
    if (!reconcileSearch) return true
    return (tx.partners?.name || '').toLowerCase().includes(reconcileSearch.toLowerCase()) ||
      (tx.pl_category || '').toLowerCase().includes(reconcileSearch.toLowerCase()) ||
      (tx.transaction_date || '').includes(reconcileSearch)
  })
  const linkedTx = directTransactions.find(t => t.id === linkedTxId)

  const touch = (field: string) => setTouched(prev => ({ ...prev, [field]: true }))
  const fieldErr = (field: string) => touched[field] ? errors[field] : undefined
  const totalErrors = Object.keys(errors).length
  const isValid = totalErrors === 0

  const touchStep = (n: number) => {
    if (n === 1) setTouched(p => ({ ...p, companyId: true, currency: true, invoiceDate: true, partnerId: true }))
    if (n === 2) setTouched(p => ({ ...p, amount: true, exRate: true }))
    if (n === 3) setTouched(p => ({ ...p, plCat: true, dept: true, revStream: true }))
  }

  const stepHasError = (n: number) => {
    const stepFields: Record<number, string[]> = {
      1: ['companyId', 'currency', 'invoiceDate', 'partnerId'],
      2: ['amount', 'exRate'],
      3: ['plCat', 'dept', 'revStream'],
    }
    return (stepFields[n] || []).some(f => !!errors[f])
  }

  // Both NBS rates for the invoice date. An RSD invoice still needs the EUR
  // rate, for amount_eur.
  const fetchRate = async () => {
    if (!currency) return
    setFetchingRate(true)
    try {
      const rates = await getBookRates(invoiceDate)
      setExRate(String(rateFor(currency, rates)))
      setEurRate(String(rates.eurRate))
      setRateSource(rates.source)
      setRateMissing(false)
    } catch (err) {
      // RateUnavailableError, in its own words. Nothing is guessed; the
      // person can retry or type the rate.
      setRateSource(err instanceof Error ? `${err.message} — enter it manually` : 'No official rate — enter it manually')
      setRateMissing(true)
    }
    setFetchingRate(false)
  }

  const toggleTag = (t: string) => setTags(prev => prev.includes(t) ? prev.filter(x => x !== t) : [...prev, t])

  const cfLabel = () => {
    if (!cfType) return '—'
    if (cfType === 'recurring') return `Recurring ${cfFrequency}`
    if (cfType === 'one_time') return 'One-time'
    if (cfType === 'accrual') return `Accrual ${cfAccrualFrom ? `${cfAccrualFrom} → ${cfAccrualTo}` : ''}`
    if (cfType === 'capex') return `CapEx (${cfCapexMonths || '?'} months)`
    if (cfType === 'reimbursable') return `Reimbursable${cfReimbursableDate ? ` by ${cfReimbursableDate}` : ''}`
    return '—'
  }

  const stepTitles = ['Basic information', 'Amount & currency', 'Classification & P&L', 'Review & post']

  const handlePost = async () => {
    setTouched({ companyId: true, currency: true, invoiceDate: true, partnerId: true, plCat: true, dept: true, revStream: true, amount: true, exRate: true })
    const e = runValidation()
    if (Object.keys(e).length > 0) { setShowValidationSummary(true); return }
    const booked = book.amounts
    if (!booked) { setSaveError(book.error || 'Exchange rate is required'); return }
    setSaveError('')
    setSaving(true)
    try {
      let finalPartnerId = partnerId
      if (showNewPartner && newPartnerName) {
        const { data: newP, error: partnerErr } = await supabase.from('partners').insert({ name: newPartnerName }).select().single()
        if (partnerErr) throw partnerErr
        if (!newP?.id) throw new Error('The new partner was saved but the database did not return its id — nothing was posted.')
        finalPartnerId = newP.id
      }
      const effectivePlImpact = linkedTxId ? false : plImpact
      const effectiveStatus = linkedTxId ? 'paid' : 'unpaid'
      // A split bill's projects are on its lines; the bill itself is on none.
      const ownProjectId = splitActive ? null : projectId

      const payload = {
        company_id: companyId || null, partner_id: finalPartnerId || null,
        invoice_number: invoiceNumber || null, invoice_date: invoiceDate,
        due_date: dueDate || null, type: invType,
        pl_category: plCatName || null, pl_subcategory: plSubName || null,
        department: deptName || null, dept_subcategory: deptSubName || null,
        expense_description: expDesc || null,
        revenue_stream: invType === 'revenue' ? (revStream || null) : null,
        project_id: ownProjectId, dept_split_type: deptSplit,
        cf_type: invType === 'expense' ? (cfType || null) : null,
        cf_frequency: cfType === 'recurring' ? cfFrequency : null,
        cf_next_month_est: cfType === 'recurring' ? (cfNextMonthEst ? parseFloat(cfNextMonthEst) : (amount ? parseFloat(amount) : null)) : null,
        cf_accrual_from: cfType === 'accrual' ? (cfAccrualFrom || null) : null,
        cf_accrual_to: cfType === 'accrual' ? (cfAccrualTo || null) : null,
        cf_capex_months: cfType === 'capex' ? (cfCapexMonths ? parseInt(cfCapexMonths) : null) : null,
        cf_reimbursable_date: cfType === 'reimbursable' ? (cfReimbursableDate || null) : null,
        currency, amount: parseFloat(amount),
        exchange_rate: booked.exchange_rate, eur_rate: booked.eur_rate,
        amount_rsd: booked.amount_rsd, amount_eur: booked.amount_eur,
        is_indexed: isIndexed, account_number: accNum || null,
        model: model || null, reference_number: refNum || null,
        note: note || null, tags: tags.length > 0 ? tags : null,
        pl_impact: effectivePlImpact, status: effectiveStatus,
      }

      // `.select('id')` is what turns a zero-row update back into an error.
      // Without it PostgREST answers 200 and an empty list whether or not it
      // changed a thing, and the dialog reported a save that never happened.
      // Same pattern as TransactionDialog's save.
      let invoiceId: string
      if (invoice?.id) {
        const { data: updated, error: updErr } = await supabase.from('invoices').update(payload).eq('id', invoice.id).select('id')
        if (updErr) throw updErr
        if (!updated || updated.length === 0)
          throw new Error(`No invoice with id ${invoice.id} was updated — nothing was saved.`)
        invoiceId = invoice.id
        if (linkedTxId && plCatName) {
          const { data: tx, error: txErr } = await supabase.from('transactions').update({ pl_category: plCatName || null, pl_subcategory: plSubName || null, department: deptName || null, dept_subcategory: deptSubName || null, expense_description: expDesc || null, revenue_stream: revStream || null, project_id: ownProjectId }).eq('id', linkedTxId).select('id')
          if (txErr) throw txErr
          if (!tx || tx.length === 0)
            throw new Error(`The invoice was saved, but no transaction with id ${linkedTxId} was updated — its P&L classification is now out of step with the invoice.`)
        }
      } else {
        const { data: newInv, error: insErr } = await supabase.from('invoices').insert(payload).select().single()
        if (insErr) throw insErr
        // An unchecked insert that returned nothing is how `invoiceId` used to
        // end up undefined, which then made the link write below operate on
        // `invoice_id=undefined` — deleting nothing, inserting nothing, and
        // reporting success.
        if (!newInv?.id) throw new Error('The invoice was not saved — the database returned no row.')
        invoiceId = newInv.id
        if (linkedTxId && plCatName) {
          const { data: tx, error: txErr } = await supabase.from('transactions').update({ pl_category: plCatName || null, pl_subcategory: plSubName || null, department: deptName || null, dept_subcategory: deptSubName || null, expense_description: expDesc || null, project_id: ownProjectId }).eq('id', linkedTxId).select('id')
          if (txErr) throw txErr
          if (!tx || tx.length === 0)
            throw new Error(`The invoice was saved, but no transaction with id ${linkedTxId} was updated — its P&L classification is now out of step with the invoice.`)
        }
      }
      // ── The split, after the bill itself ────────────────────────────
      //
      // After, because a split names the payment it belongs to and there is
      // no id to name until the insert comes back. A failure here is reported
      // rather than thrown: the bill is saved and correct, and what is left
      // is a classification to redo rather than an entry to unpick.
      {
        const outcome = await saveSplits(
          supabase, 'invoice', invoiceId,
          { amount: parseFloat(amount) || 0, currency, ...booked },
          splitLines)
        if (!outcome.ok) {
          setSaving(false)
          setSaveError(outcome.message)
          return
        }
      }

      if (linkedTxId && invoiceId) {
        // Was: delete every link on the invoice, then insert the replacement,
        // neither checked. Between those two calls the invoice had no
        // allocation at all, and a rejected insert made that permanent.
        // `reallocateInvoiceLink` writes the replacement first and only then
        // removes what it supersedes, so a failure leaves the old allocation
        // standing rather than nothing at all.
        const outcome = await reallocateInvoiceLink(supabase, {
          invoiceId,
          transactionId: linkedTxId,
          // The whole bill, so its book columns are the bill's own.
          allocatedAmount: parseFloat(amount),
          allocatedAmountRsd: booked.amount_rsd,
          allocatedAmountEur: booked.amount_eur,
          note: 'Reconciled — P&L already booked via Direct transaction',
        })
        if (!outcome.ok) throw new Error(outcome.message)
      }
      setSuccess(true)
      setTimeout(() => { setSuccess(false); onClose() }, 1500)
    } catch (err: any) {
      // This block used to be unreachable for the failures it was there to
      // catch. supabase-js does not throw: a PostgREST refusal — a closed
      // period, an RLS denial, a bad id — comes back as `{ data: null, error }`
      // and the `await` resolves perfectly happily. So every unchecked write
      // above fell straight through to `setSuccess(true)`, which is why this
      // went unnoticed for as long as it did. Every write above now reads its
      // own `error` and throws it here itself; that, and only that, is what
      // reaches this block.
      setSaveError(err?.message || String(err))
      setSaving(false)
      return
    }
    setSaving(false)
  }

  if (success) return (
    <div style={s.overlay}>
      <div style={{ ...s.dialog, display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center', gap: '1rem', minHeight: '220px' }}>
        <div style={{ width: '48px', height: '48px', borderRadius: '50%', background: DIALOG.accentFill, display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
          <svg width="24" height="24" viewBox="0 0 24 24" fill="none" stroke={DIALOG.accent} strokeWidth="2"><path d="M5 13l4 4L19 7" /></svg>
        </div>
        <div style={{ fontFamily: 'Georgia,serif', fontSize: '20px', color: DIALOG.text }}>{invoice ? 'Invoice updated!' : 'Invoice posted!'}</div>
        <div style={{ fontSize: '13px', color: DIALOG.dim }}>{linkedTxId ? 'Reconciled — P&L synced with Direct transaction.' : 'Saved to P&L successfully.'}</div>
      </div>
    </div>
  )

  const expenseCategories = plCategories.filter(c => c.type !== 'revenue')
  const currentPlSubs = getPlSubs(plCatId)
  const currentDeptSubs = getDeptSubs(deptId)
  const currentExpDescs = getExpDescs(deptSubId)

  // ── Project panel ────────────────────────────
  // One picker; null is company overhead. Hidden while the bill is split,
  // because then each line carries its own project and this one is null.
  const projectPanel = (
    <div style={s.section}>
      <div style={s.sectionTitle}>Project</div>
      {splitActive ? (
        <div style={{ fontSize: '11.5px', color: DIALOG.dim, lineHeight: 1.5 }}>
          This bill is split — each line above carries its own project.
          Remove the split to put the whole bill on one project.
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
      <div style={s.sectionTitle}>Cash flow classification</div>
      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(5,1fr)', gap: '8px' }}>
        {[
          { id: 'recurring', label: '🔁 Recurring', sub: 'Monthly/Qtrly/Yearly' },
          { id: 'one_time', label: '1️⃣ One-time', sub: 'Non-repeating' },
          { id: 'accrual', label: '📅 Accrual', sub: 'Period-based' },
          { id: 'capex', label: '🏗 CapEx', sub: 'Capital expenditure' },
          { id: 'reimbursable', label: '↩️ Reimbursable', sub: 'Expected return' },
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
            {[{ id: 'monthly', label: '📆 Monthly' }, { id: 'quarterly', label: '📊 Quarterly' }, { id: 'yearly', label: '📅 Yearly' }].map(f => (
              <div key={f.id}
                style={{ flex: 1, padding: '8px', border: cfFrequency === f.id ? '2px solid ' + DIALOG.accent : '0.5px solid ' + DIALOG.border, borderRadius: '8px', background: cfFrequency === f.id ? DIALOG.accentFill : DIALOG.raised, cursor: 'pointer', textAlign: 'center' as const, fontSize: '12px', fontWeight: cfFrequency === f.id ? '600' : '400', color: cfFrequency === f.id ? DIALOG.accent : DIALOG.dim }}
                onClick={() => setCfFrequency(f.id)}>{f.label}</div>
            ))}
          </div>
          <div style={s.field}>
            <label style={s.lbl}>Next month estimate ({currency || '—'})</label>
            <div style={{ display: 'flex', gap: '8px', alignItems: 'center' }}>
              <input type="number" style={{ ...s.input, flex: 1 }} value={cfNextMonthEst}
                onChange={e => setCfNextMonthEst(e.target.value)}
                placeholder={amount ? `Auto: ${fmtNum(parseFloat(amount))}` : '0.00'} />
              {!cfNextMonthEst && amount && (
                <button style={s.linkBtn} onClick={() => setCfNextMonthEst(amount)}>Use this amount</button>
              )}
            </div>
            {amount && (
              <div style={{ fontSize: '10px', color: DIALOG.dim, marginTop: '4px' }}>
                Auto: {fmtNum(cfFrequency === 'monthly' ? parseFloat(amount) : cfFrequency === 'quarterly' ? parseFloat(amount) / 3 : parseFloat(amount) / 12)} {currency}/mo
              </div>
            )}
          </div>
        </div>
      )}

      {cfType === 'accrual' && (
        <div style={{ marginTop: '12px', background: DIALOG.raised, borderRadius: '10px', padding: '14px', border: '0.5px solid ' + DIALOG.border }}>
          <div style={s.row2}>
            <div style={s.field}>
              <label style={s.lbl}>From</label>
              <input type="date" style={s.input} value={cfAccrualFrom} onChange={e => setCfAccrualFrom(e.target.value)} />
            </div>
            <div style={s.field}>
              <label style={s.lbl}>To</label>
              <input type="date" style={s.input} value={cfAccrualTo} onChange={e => setCfAccrualTo(e.target.value)} />
            </div>
          </div>
          {cfAccrualFrom && cfAccrualTo && amount && (
            <div style={{ fontSize: '11px', color: DIALOG.accent, marginTop: '4px' }}>
              {(() => { const m = Math.max(1, Math.round((new Date(cfAccrualTo).getTime() - new Date(cfAccrualFrom).getTime()) / (1000*60*60*24*30))); return `Monthly: ${(parseFloat(amount)/m).toFixed(2)} ${currency} × ${m} months` })()}
            </div>
          )}
        </div>
      )}

      {cfType === 'capex' && (
        <div style={{ marginTop: '12px', background: DIALOG.raised, borderRadius: '10px', padding: '14px', border: '0.5px solid ' + DIALOG.border }}>
          <div style={s.field}>
            <label style={s.lbl}>Amortization period (months)</label>
            <input type="number" style={s.input} value={cfCapexMonths} onChange={e => setCfCapexMonths(e.target.value)} placeholder="e.g. 36" min="1" />
            {cfCapexMonths && amount && (
              <div style={{ fontSize: '11px', color: DIALOG.accent, marginTop: '4px' }}>
                Monthly depreciation: {(parseFloat(amount) / parseFloat(cfCapexMonths)).toFixed(2)} {currency}/mo
              </div>
            )}
          </div>
        </div>
      )}

      {cfType === 'reimbursable' && (
        <div style={{ marginTop: '12px', background: DIALOG.raised, borderRadius: '10px', padding: '14px', border: '0.5px solid ' + DIALOG.border }}>
          <div style={s.field}>
            <label style={s.lbl}>Expected reimbursement date</label>
            <input type="date" style={s.input} value={cfReimbursableDate} onChange={e => setCfReimbursableDate(e.target.value)} />
          </div>
        </div>
      )}

      {cfType === 'one_time' && (
        <div style={{ marginTop: '8px', fontSize: '12px', color: DIALOG.dim, background: DIALOG.raised, borderRadius: '8px', padding: '10px 12px' }}>
          One-time expense — will not be included in future month estimates.
        </div>
      )}
    </div>
  )

  return (
    <div style={s.overlay}>
      <div style={s.dialog}>
        <div style={s.header}>
          <div>
            <div style={s.headerTitle}>{invoice ? 'Edit invoice' : 'New invoice'}</div>
            <div style={s.headerSub}>Step {step} of 4 — {stepTitles[step - 1]}</div>
          </div>
          <div style={{ display: 'flex', alignItems: 'center', gap: '12px' }}>
            <div style={{ ...s.invBadge, ...(linkedTxId ? { background: 'rgba(12,68,124,0.2)', color: DIALOG.blue, borderColor: 'rgba(12,68,124,0.3)' } : {}) }}>
              {linkedTxId ? '🔗 Reconciled' : 'P&L Impact'}
            </div>
            <span style={s.logoText}>MCFlow</span>
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

        {saveError && (
          <div style={s.validationBanner}>
            <span>⚠️</span>
            <div style={{ flex: 1 }}>
              <div style={{ fontWeight: '500', fontSize: '12px' }}>The invoice was not posted</div>
              <div style={{ fontSize: '11px', marginTop: '2px', opacity: 0.9 }}>{saveError}</div>
            </div>
            <button style={s.bannerClose} onClick={() => setSaveError('')}>×</button>
          </div>
        )}

        {showValidationSummary && !isValid && (
          <div style={s.validationBanner}>
            <span>⚠️</span>
            <div style={{ flex: 1 }}>
              <div style={{ fontWeight: '500', fontSize: '12px' }}>Fix {totalErrors} error{totalErrors > 1 ? 's' : ''} before posting:</div>
              <div style={{ fontSize: '11px', marginTop: '2px', opacity: 0.9 }}>{Object.values(errors).join(' · ')}</div>
            </div>
            <button style={s.bannerClose} onClick={() => setShowValidationSummary(false)}>×</button>
          </div>
        )}

        <div style={s.body}>

          {/* ── STEP 1 ── */}
          {step === 1 && (
            <>
              {companyId && (
                <div style={{ ...s.reconcileBox, marginBottom: '20px' }}>
                  <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: '10px' }}>
                    <div>
                      <div style={{ fontSize: '13px', fontWeight: '500', color: DIALOG.blue }}>🔗 Link to existing Direct transaction</div>
                      <div style={{ fontSize: '11px', color: DIALOG.blue, marginTop: '2px' }}>Select a Direct tx to auto-fill all fields. Invoice will be marked paid with no duplicate P&L.</div>
                    </div>
                    {linkedTxId && <button style={s.unlinkBtn} onClick={handleUnlink}>✕ Unlink</button>}
                  </div>
                  {linkedTx ? (
                    <div style={s.linkedTxCard}>
                      <div style={{ display: 'flex', alignItems: 'center', gap: '8px' }}>
                        <span style={{ fontSize: '16px' }}>✅</span>
                        <div style={{ flex: 1 }}>
                          <div style={{ fontSize: '13px', fontWeight: '500', color: DIALOG.accent }}>{linkedTx.partners?.name || '—'}</div>
                          <div style={{ fontSize: '11px', color: DIALOG.accent }}>{linkedTx.transaction_date} · {linkedTx.pl_category || '—'} · {linkedTx.banks?.name || '—'} · {fmtMoney(linkedTx.amount_rsd || 0, 'RSD')}</div>
                        </div>
                      </div>
                      <div style={{ ...s.infoBox, marginTop: '10px', background: DIALOG.blueFill, borderColor: DIALOG.blue, color: DIALOG.blue, fontSize: '11px' }}>
                        ℹ️ Fields auto-filled from transaction. You can still edit them below. P&L will be synced on post.
                      </div>
                    </div>
                  ) : (
                    <>
                      <input style={{ ...s.input, marginBottom: '8px', width: '100%', boxSizing: 'border-box' as const }}
                        value={reconcileSearch} onChange={e => setReconcileSearch(e.target.value)} placeholder="Search by partner, category or date..." />
                      {directTransactions.length === 0 ? (
                        <div style={{ fontSize: '12px', color: DIALOG.faint, padding: '8px', textAlign: 'center' as const }}>No Direct transactions for this company yet.</div>
                      ) : (
                        <div style={s.txList}>
                          {filteredDirectTx.slice(0, 8).map(tx => (
                            <div key={tx.id} style={s.txRow} onClick={() => handleLinkTransaction(tx)}>
                              <div style={{ flex: 1 }}>
                                <div style={{ fontSize: '12px', fontWeight: '500', color: DIALOG.text }}>{tx.partners?.name || '—'}</div>
                                <div style={{ fontSize: '11px', color: DIALOG.dim }}>{tx.transaction_date} · {tx.pl_category || '—'} · {tx.banks?.name || '—'}</div>
                              </div>
                              <div style={{ textAlign: 'right' as const, flexShrink: 0 }}>
                                <div style={{ fontSize: '12px', fontWeight: '500', color: DIALOG.red }}>{fmtLocal(tx.amount || 0, tx.currency)}</div>
                                <div style={{ fontSize: '11px', color: DIALOG.dim }}>{fmtMoney(tx.amount_rsd || 0, 'RSD')}</div>
                              </div>
                            </div>
                          ))}
                          {filteredDirectTx.length === 0 && reconcileSearch && (
                            <div style={{ fontSize: '12px', color: DIALOG.faint, padding: '8px', textAlign: 'center' as const }}>No results for "{reconcileSearch}"</div>
                          )}
                        </div>
                      )}
                    </>
                  )}
                </div>
              )}

              <div style={s.section}>
                <div style={s.sectionTitle}>Company & invoice info</div>
                <div style={s.row2}>
                  {showPicker && (
                    <div style={s.field}>
                      <label style={s.lbl}>Company <span style={s.req}>*</span></label>
                      <select style={{ ...s.select, ...(fieldErr('companyId') ? s.inputError : {}) }} value={companyId}
                        onChange={e => { setCompanyId(e.target.value); setCurrency(''); setLinkedTxId(''); touch('companyId') }} onBlur={() => touch('companyId')}>
                        <option value="">Select company...</option>
                        {companies.map(c => <option key={c.id} value={c.id}>{c.name}</option>)}
                      </select>
                      {fieldErr('companyId') && <span style={s.errorMsg}>{fieldErr('companyId')}</span>}
                    </div>
                  )}
                  <div style={s.field}>
                    <label style={s.lbl}>Currency <span style={s.req}>*</span></label>
                    <select style={{ ...s.select, ...(fieldErr('currency') ? s.inputError : {}) }} value={currency}
                      onChange={e => { setCurrency(e.target.value); touch('currency') }} onBlur={() => touch('currency')}>
                      <option value="">Select...</option>
                      {(companies.find(c => c.id === companyId)?.currencies || DOCUMENT_CURRENCIES).map((cur: string) => (
                        <option key={cur}>{cur}</option>
                      ))}
                    </select>
                    {fieldErr('currency') && <span style={s.errorMsg}>{fieldErr('currency')}</span>}
                  </div>
                </div>
                <div style={s.row3}>
                  <div style={s.field}>
                    <label style={s.lbl}>Invoice number</label>
                    <input style={s.input} value={invoiceNumber} onChange={e => { setInvoiceNumber(e.target.value); setRefNum(e.target.value) }} placeholder="e.g. INV-001/2026" />
                  </div>
                  <div style={s.field}>
                    <label style={s.lbl}>Invoice date <span style={s.req}>*</span></label>
                    <input type="date" style={{ ...s.input, ...(fieldErr('invoiceDate') ? s.inputError : {}) }} value={invoiceDate}
                      onChange={e => { setInvoiceDate(e.target.value); touch('invoiceDate') }} onBlur={() => touch('invoiceDate')} />
                    {fieldErr('invoiceDate') && <span style={s.errorMsg}>{fieldErr('invoiceDate')}</span>}
                  </div>
                  <div style={s.field}>
                    <label style={s.lbl}>Due date</label>
                    <input type="date" style={s.input} value={dueDate} onChange={e => setDueDate(e.target.value)} />
                  </div>
                </div>
              </div>

              <div style={s.section}>
                <div style={s.sectionTitle}>Partner & type</div>
                <div style={s.row2}>
                  <div style={s.field}>
                    <label style={s.lbl}>Partner <span style={s.req}>*</span></label>
                    <div style={{ display: 'flex', gap: '6px', alignItems: 'flex-start' }}>
                      <div style={{ flex: 1, position: 'relative' as const }}>
                        <input style={{ ...s.input, ...(fieldErr('partnerId') ? s.inputError : {}) }} value={partnerSearch}
                          onChange={e => { setPartnerSearch(e.target.value); setPartnerId(''); touch('partnerId') }}
                          onBlur={() => touch('partnerId')} placeholder="Search partner..." />
                        {partnerSearch && !partnerId && (
                          <div style={s.dropdown}>
                            {filteredPartners.slice(0, 8).map(p => (
                              <div key={p.id} style={s.dropdownItem} onClick={() => { setPartnerId(p.id); setPartnerSearch(p.name) }}>
                                <div>{p.name}</div>
                                {p.account_number && <div style={{ fontSize: '11px', color: DIALOG.faint }}>{p.account_number}</div>}
                              </div>
                            ))}
                          </div>
                        )}
                        {fieldErr('partnerId') && <span style={s.errorMsg}>{fieldErr('partnerId')}</span>}
                      </div>
                      <button
                        style={{ fontFamily: 'system-ui,sans-serif', fontSize: '20px', width: '36px', height: '36px', border: '0.5px solid ' + DIALOG.border, borderRadius: '8px', background: DIALOG.raised, color: DIALOG.accent, cursor: 'pointer', display: 'flex', alignItems: 'center', justifyContent: 'center', flexShrink: 0 }}
                        onClick={() => { setPartnerDialogInitialName(partnerSearch); setPartnerDialogOpen(true) }}
                        title="Add a new partner (NBS lookup)">+</button>
                    </div>
                  </div>
                  <div style={s.field}>
                    <label style={s.lbl}>Invoice type <span style={s.req}>*</span></label>
                    <div style={s.typeRow}>
                      <div style={{ ...s.typeChip, ...(invType === 'expense' ? s.typeChipExpense : {}) }} onClick={() => setInvType('expense')}>📤 Expense</div>
                      <div style={{ ...s.typeChip, ...(invType === 'revenue' ? s.typeChipRevenue : {}) }} onClick={() => setInvType('revenue')}>📥 Revenue</div>
                    </div>
                  </div>
                </div>
                <div style={s.sectionTitle}>Payment details</div>
                <div style={s.row3}>
                  <div style={s.field}>
                    <label style={s.lbl}>Account number (RSD)</label>
                    {partnerAccounts.length > 1 ? (
                      <>
                        {/* A number that is none of the saved accounts needs a
                            row of its own, or the select lights up the FIRST
                            account instead — a different account from the one
                            that will be paid, shown as though it were chosen. */}
                        <select style={s.select} value={selectedAccountId} onChange={e => handleAccountSelect(e.target.value)}>
                          {!selectedAccountId && <option value="">Typed in — not a saved account</option>}
                          {partnerAccounts.map(acc => (
                            <option key={acc.id} value={acc.id}>{acc.account_number}{acc.bank_name ? ` — ${acc.bank_name}` : ''}{acc.is_primary ? ' ★' : ''}</option>
                          ))}
                        </select>
                        {!selectedAccountId && (
                          <input style={{ ...s.input, marginTop: '4px' }} value={accNum}
                            onChange={e => setAccNum(e.target.value)} placeholder="Partner bank account" />
                        )}
                      </>
                    ) : (
                      <input style={s.input} value={accNum} onChange={e => setAccNum(e.target.value)} placeholder="Partner bank account" />
                    )}
                    {partnerAccounts.length > 0 && <div style={{ fontSize: '10px', color: DIALOG.accent, marginTop: '2px' }}>{partnerAccounts.length} account{partnerAccounts.length > 1 ? 's' : ''} found</div>}
                  </div>
                  <div style={s.field}>
                    <label style={s.lbl}>Model</label>
                    <input style={s.input} value={model} onChange={e => setModel(e.target.value)} placeholder="e.g. 97" />
                  </div>
                  <div style={s.field}>
                    <label style={s.lbl}>Poziv na broj</label>
                    <input style={s.input} value={refNum} onChange={e => setRefNum(e.target.value)} placeholder="Auto = broj fakture" />
                    {invoiceNumber && refNum === invoiceNumber && <div style={{ fontSize: '10px', color: DIALOG.accent, marginTop: '2px' }}>Auto iz broja fakture</div>}
                  </div>
                </div>
              </div>
            </>
          )}

          {/* ── STEP 2 ── */}
          {step === 2 && (
            <div style={s.section}>
              <div style={s.sectionTitle}>Amount & currency conversion</div>
              <div style={s.toggleRow}>
                <span style={s.toggleLabel}>Amount indexed in foreign currency?</span>
                <label style={s.toggle}>
                  <input type="checkbox" checked={isIndexed} onChange={e => setIsIndexed(e.target.checked)} style={{ opacity: 0, width: 0, height: 0 }} />
                  <span style={{ ...s.toggleSlider, background: isIndexed ? DIALOG.accent : DIALOG.border }} />
                </label>
              </div>
              {linkedTxId && (
                <div style={{ ...s.infoBox, marginBottom: '10px', background: DIALOG.blueFill, borderColor: DIALOG.blue, color: DIALOG.blue, fontSize: '11px' }}>
                  🔗 Amount auto-filled from Direct transaction. Edit if invoice amount differs.
                </div>
              )}
              <div style={{ ...s.infoBox, margin: '10px 0' }}>
                {currency === 'RSD'
                  ? 'Booked in RSD; the NBS EUR rate on the invoice date gives the EUR figure.'
                  : `NBS middle rate on the invoice date, in RSD per 1 ${currency || 'unit'}.`}
              </div>
              <div style={s.row2}>
                <div style={s.field}>
                  <label style={s.lbl}>Amount ({currency || '—'}) <span style={s.req}>*</span></label>
                  <input type="number" style={{ ...s.input, ...(fieldErr('amount') ? s.inputError : {}) }} value={amount}
                    onChange={e => { setAmount(e.target.value); touch('amount') }} onBlur={() => touch('amount')} placeholder="0.00" />
                  {fieldErr('amount') && <span style={s.errorMsg}>{fieldErr('amount')}</span>}
                </div>
                <div style={s.field}>
                  <label style={s.lbl}>{currency && currency !== 'RSD' ? `RSD per 1 ${currency}` : 'RSD per 1 EUR'} <span style={s.req}>*</span></label>
                  <div style={{ display: 'flex', gap: '6px' }}>
                    {currency && currency !== 'RSD' ? (
                      <input type="number" style={{ ...s.input, flex: 1, ...(fieldErr('exRate') ? s.inputError : {}) }} value={exRate}
                        onChange={e => { setExRate(e.target.value); touch('exRate') }} onBlur={() => touch('exRate')}
                        placeholder="Click Fetch" />
                    ) : (
                      <input type="number" style={{ ...s.input, flex: 1, ...(fieldErr('exRate') ? s.inputError : {}) }} value={eurRate}
                        onChange={e => { setEurRate(e.target.value); touch('exRate') }} onBlur={() => touch('exRate')}
                        placeholder="Click Fetch" />
                    )}
                    <button style={s.fetchBtn} onClick={fetchRate} disabled={fetchingRate || !currency}>{fetchingRate ? '...' : 'Fetch'}</button>
                  </div>
                  {currency === 'USD' && (
                    <input type="number" style={{ ...s.input, marginTop: '6px' }} value={eurRate}
                      onChange={e => { setEurRate(e.target.value); touch('exRate') }} onBlur={() => touch('exRate')}
                      placeholder="RSD per 1 EUR" aria-label="RSD per 1 EUR" />
                  )}
                  {rateSource && <div style={{ fontSize: '11px', color: rateMissing ? '#FF5B5A' : DIALOG.accent, fontWeight: rateMissing ? 600 : 400, marginTop: '4px' }}>Source: {rateSource}</div>}
                  {fieldErr('exRate') && <span style={s.errorMsg}>{fieldErr('exRate')}</span>}
                </div>
              </div>
              <div style={s.convRow}>
                <div><div style={s.convLabel}>Invoice amount</div><div style={s.convVal}>{amount ? fmtLocal(parseFloat(amount), currency) : '—'}</div></div>
                <div style={{ fontSize: '20px', color: DIALOG.faint, alignSelf: 'flex-end', paddingBottom: '4px' }}>→</div>
                <div><div style={s.convLabel}>RSD (book)</div><div style={{ ...s.convVal, color: DIALOG.accent }}>{book.amounts ? fmtMoney(amountRsd, 'RSD') : '—'}</div></div>
                <div><div style={s.convLabel}>EUR</div><div style={{ ...s.convVal, color: DIALOG.accent }}>{book.amounts ? fmtMoney(amountEur, 'EUR') : '—'}</div></div>
              </div>
              {dueDate && <div style={{ ...s.infoBox, marginTop: '12px', background: DIALOG.amberFill, borderColor: DIALOG.amber, color: DIALOG.amber }}>📅 Due date: <strong>{dueDate}</strong></div>}
            </div>
          )}

          {/* ── STEP 3 ── */}
          {step === 3 && (
            <>
              {/* ONE BILL, SEVERAL COSTS.
                  Above the classification rather than below it, because the
                  first question is how many expenses this is — and if it is
                  more than one, the fields underneath stop being the answer
                  and become the fallback the rest of the application reads. */}
              <SplitEditor
                parent={splitParent}
                lines={splitLines}
                onChange={changeSplitLines}
                companyId={companyId || null}
                scripts={quickFillScripts as any}
                classification={{ plCategories, plSubcategories, departments, deptSubcategories, expenseDescriptions }}
                client={supabase}
                onScriptsChanged={() => { fetchScripts(supabase).then(setQuickFillScripts as any) }}
                hint="One bill, two or more expenses — a laptop and a year of support, say."
              />
              {linkedTxId && (
                <div style={{ ...s.infoBox, marginBottom: '16px', background: DIALOG.blueFill, borderColor: DIALOG.blue, color: DIALOG.blue }}>
                  🔗 Linked to Direct transaction — P&L fields auto-filled. Changes will sync to the transaction on post.
                </div>
              )}
              {invType === 'expense' && (
                <>
                  <div style={{
                    ...s.section,
                    ...(splitActive
                      ? { opacity: 0.5, pointerEvents: 'none' as const, userSelect: 'none' as const }
                      : {}),
                  }}>
                    <div style={s.sectionTitle}>P&L classification</div>
                    {splitActive && (
                      <div style={{ ...s.infoBox, marginBottom: '12px', background: DIALOG.amberFill, borderColor: DIALOG.amber, color: DIALOG.amber }}>
                        Taken from the largest line of the split above, and locked while it
                        stands. The split is what the P&amp;L reads; this is what the ledger
                        lists the bill under. Remove the split to set it by hand.
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
                            placeholder="⚡ Quick fill — click or search…"
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
                                ? <div style={{ padding: '10px 12px', fontSize: '12px', color: DIALOG.dim }}>No matches for "{qfSearch}"</div>
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
                              placeholder="Name this template…"
                              value={templateName}
                              onChange={e => setTemplateName(e.target.value)}
                              onKeyDown={e => { if (e.key === 'Enter') { e.preventDefault(); saveAsTemplate() } }} />
                            <button type="button" style={s.qfSaveBtn} onClick={saveAsTemplate}>Save</button>
                            <button type="button" style={s.qfCancelBtn}
                              onClick={() => { setSavingTemplate(false); setTemplateName('') }}>Cancel</button>
                          </div>
                        ) : (
                          <button type="button" style={s.qfNewBtn}
                            title="Save the classification filled in above as a template, shared with everyone"
                            onClick={() => setSavingTemplate(true)}>
                            + Save this classification as a template
                          </button>
                        )}
                      </div>
                    )}
                    <div style={s.row2}>
                      <div style={s.field}>
                        <label style={s.lbl}>P&L Category {!linkedTxId && <span style={s.req}>*</span>}</label>
                        <div style={{ display: 'flex', gap: '6px', alignItems: 'flex-start' }}>
                        <SearchableSelect value={plCatId}
                          onChange={v => { const cat = plCategories.find(c => c.id === v); setPlCatId(v); setPlCatName(cat?.name || ''); setPlSubId(''); setPlSubName(''); touch('plCat') }}
                          options={expenseCategories.map(c => ({ value: c.id, label: c.name }))}
                          allLabel="Select P&L category..." searchPlaceholder="Type to search categories…"
                          style={{ ...pickerChrome, flex: 1, ...(fieldErr('plCat') ? pickerError : {}) }} />
                        <InlineCategoryAdd table="pl_categories"
                          currentCount={plCategories.length}
                          onAdded={item => { setPlCategories(prev => [...prev, { ...item, type: 'expense', sort_order: prev.length + 1 }]); setPlCatId(item.id); setPlCatName(item.name); setPlSubId(''); setPlSubName('') }} />
                        </div>
                        {fieldErr('plCat') && <span style={s.errorMsg}>{fieldErr('plCat')}</span>}
                      </div>
                      <div style={s.field}>
                        <label style={s.lbl}>P&L Sub-category</label>
                        <div style={{ display: 'flex', gap: '6px', alignItems: 'flex-start' }}>
                        <SearchableSelect value={plSubId}
                          onChange={v => { const sub = plSubcategories.find(s => s.id === v); setPlSubId(v); setPlSubName(sub?.name || '') }}
                          options={currentPlSubs.map(sub => ({ value: sub.id, label: sub.name }))}
                          allLabel="Select sub-category..." searchPlaceholder="Type to search sub-categories…"
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
                        <label style={s.lbl}>Department {!linkedTxId && <span style={s.req}>*</span>}</label>
                        <div style={{ display: 'flex', gap: '6px', alignItems: 'flex-start' }}>
                        <SearchableSelect value={deptId}
                          onChange={v => { const dept = departments.find(d => d.id === v); setDeptId(v); setDeptName(dept?.name || ''); setDeptSubId(''); setDeptSubName(''); setExpDesc(''); touch('dept') }}
                          options={departments.map(d => ({ value: d.id, label: d.name }))}
                          allLabel="Select department..." searchPlaceholder="Type to search departments…"
                          style={{ ...pickerChrome, flex: 1, ...(fieldErr('dept') ? pickerError : {}) }} />
                        <InlineCategoryAdd table="departments"
                          currentCount={departments.length}
                          onAdded={item => { setDepartments(prev => [...prev, { ...item, sort_order: prev.length + 1 }]); setDeptId(item.id); setDeptName(item.name); setDeptSubId(''); setDeptSubName(''); setExpDesc('') }} />
                        </div>
                        {fieldErr('dept') && <span style={s.errorMsg}>{fieldErr('dept')}</span>}
                      </div>
                      <div style={s.field}>
                        <label style={s.lbl}>Dept. sub-category</label>
                        <div style={{ display: 'flex', gap: '6px', alignItems: 'flex-start' }}>
                        <SearchableSelect value={deptSubId}
                          onChange={v => { const sub = deptSubcategories.find(s => s.id === v); setDeptSubId(v); setDeptSubName(sub?.name || ''); setExpDesc('') }}
                          options={currentDeptSubs.map(sub => ({ value: sub.id, label: sub.name }))}
                          allLabel="Select sub-category..." searchPlaceholder="Type to search sub-categories…"
                          disabled={!deptId || currentDeptSubs.length === 0}
                          style={{ ...pickerChrome, flex: 1 }} />
                        <InlineCategoryAdd table="dept_subcategories" parentId={deptId} parentField="department_id"
                          currentCount={currentDeptSubs.length} disabled={!deptId}
                          onAdded={item => { setDeptSubcategories(prev => [...prev, { ...item, department_id: deptId, sort_order: prev.length + 1 }]); setDeptSubId(item.id); setDeptSubName(item.name); setExpDesc('') }} />
                        </div>
                      </div>
                    </div>
                    <div style={s.field}>
                      <label style={s.lbl}>Expense description</label>
                      <div style={{ display: 'flex', gap: '6px', alignItems: 'flex-start' }}>
                        {currentExpDescs.length > 0 ? (
                          <SearchableSelect value={expDesc} onChange={setExpDesc}
                            options={currentExpDescs.map(d => ({ value: d.name, label: d.name }))}
                            allLabel="Select description..." searchPlaceholder="Type to search descriptions…"
                            style={{ ...pickerChrome, flex: 1 }} />
                        ) : (
                          <input style={{ ...s.input, flex: 1 }} value={expDesc} onChange={e => setExpDesc(e.target.value)} placeholder="Enter expense description..." />
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

              {invType === 'revenue' && (
                <div style={s.section}>
                  <div style={s.sectionTitle}>Revenue details</div>
                  <div style={s.field}>
                    <label style={s.lbl}>Revenue stream <span style={s.req}>*</span></label>
                    <select style={{ ...s.select, ...(fieldErr('revStream') ? s.inputError : {}) }} value={revStream}
                      onChange={e => { setRevStream(e.target.value); touch('revStream') }} onBlur={() => touch('revStream')}>
                      <option value="">Select stream...</option>
                      {revenueStreams.map(r => <option key={r}>{r}</option>)}
                    </select>
                    {fieldErr('revStream') && <span style={s.errorMsg}>{fieldErr('revStream')}</span>}
                  </div>
                </div>
              )}
              {invType === 'revenue' && projectPanel}

              <div style={s.section}>
                <div style={s.sectionTitle}>Tags & note</div>
                <div style={s.tagRow}>
                  {['Recurring', 'Prepayment', 'Accrual', 'Capital expenditure', 'Tax deductible', 'Reimbursable'].map(t => (
                    <span key={t} style={{ ...s.tag, ...(tags.includes(t) ? s.tagActive : {}) }} onClick={() => toggleTag(t)}>{t}</span>
                  ))}
                </div>
                <div style={{ marginTop: '12px' }}>
                  <label style={s.lbl}>Note</label>
                  <textarea style={s.textarea} value={note} onChange={e => setNote(e.target.value)} placeholder="Additional notes..." />
                </div>
              </div>
            </>
          )}

          {/* ── STEP 4 ── */}
          {step === 4 && (
            <div style={s.section}>
              <div style={s.sectionTitle}>Review before posting</div>

              {/* The split belongs in the review for the same reason every
                  other figure does: this is the page somebody checks before
                  the entry exists. */}
              {splitLines.length > 0 && (
                <div style={{ ...s.infoBox, marginBottom: '16px', ...(whySplit
                  ? { background: DIALOG.amberFill, borderColor: DIALOG.amber, color: DIALOG.amber }
                  : {}) }}>
                  <div style={{ fontWeight: 500, marginBottom: '4px' }}>
                    Split across {splitLines.length} costs
                  </div>
                  {splitLines.map((l, i) => (
                    <div key={l.key} style={{ fontSize: '11.5px', opacity: 0.9, lineHeight: 1.7 }}>
                      {i + 1}. {[l.pl_category, l.pl_subcategory, l.department, l.expense_description]
                        .filter(Boolean).join(' › ') || 'nothing picked'}
                      {' · '}{projectLabelById(projects, l.project_id)}
                      {' — '}
                      <strong>
                        {currency ? fmtMoney(l.amount || 0, currency) : fmtNum(l.amount || 0)}
                      </strong>
                    </div>
                  ))}
                  {whySplit && <div style={{ fontSize: '11.5px', marginTop: '6px' }}>{whySplit}</div>}
                </div>
              )}

              {isValid ? (
                <div style={{ ...s.infoBox, marginBottom: '16px', display: 'flex', gap: '10px', alignItems: 'center' }}>
                  <span>✅</span>
                  <div>
                    <div style={{ fontWeight: '500', marginBottom: '2px' }}>All fields valid — ready to post</div>
                    <div style={{ fontSize: '11px', opacity: 0.85 }}>{linkedTxId ? 'Invoice will be reconciled. P&L fields synced to Direct transaction.' : `Invoice will impact P&L on date ${invoiceDate}.`}</div>
                  </div>
                </div>
              ) : (
                <div style={{ ...s.validationBanner, marginBottom: '16px', position: 'relative' }}>
                  <span>⚠️</span>
                  <div>
                    <div style={{ fontWeight: '500', fontSize: '12px' }}>{totalErrors} required field{totalErrors > 1 ? 's' : ''} missing</div>
                    <div style={{ fontSize: '11px', marginTop: '2px' }}>{Object.values(errors).join(' · ')}</div>
                  </div>
                </div>
              )}
              {[
                { title: 'Invoice info', rows: [
                  ['Company', companies.find(c => c.id === companyId)?.name || '—'],
                  ['Partner', showNewPartner ? newPartnerName : (partners.find(p => p.id === partnerId)?.name || partnerSearch || '—')],
                  ['Invoice number', invoiceNumber || '—'],
                  ['Invoice date', invoiceDate || '—'],
                  ['Due date', dueDate || '—'],
                  ['Type', invType],
                  ['P&L Impact', linkedTxId ? '❌ None — reconciled with Direct tx' : '✅ Yes'],
                ]},
                { title: 'Amounts', rows: [
                  ['Original amount', amount ? fmtLocal(parseFloat(amount), currency) : '—'],
                  ['Exchange rate', book.amounts ? `${fmtNum(book.amounts.exchange_rate, 4)} RSD/${currency} · EUR ${fmtNum(book.amounts.eur_rate, 4)} (${rateSource || 'Manual'})` : 'N/A'],
                  ['RSD (book)', book.amounts ? fmtMoney(amountRsd, 'RSD') : '—'],
                  ['EUR', book.amounts ? fmtMoney(amountEur, 'EUR') : '—'],
                ]},
                { title: 'P&L & CF classification', rows: [
                  ['P&L Category', plCatName || '—'],
                  ['Department', deptName || '—'],
                  ['Description', expDesc || '—'],
                  ['Project', splitActive ? 'By split line' : projectLabelById(projects, projectId)],
                  ['CF Classification', cfLabel()],
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
            <span style={{ fontSize: '12px', color: DIALOG.dim }}>Step {step} of 4</span>
            {totalErrors > 0 && touched.companyId && (
              <span style={{ fontSize: '11px', color: DIALOG.red, background: DIALOG.redFill, padding: '2px 8px', borderRadius: '20px' }}>
                {totalErrors} field{totalErrors > 1 ? 's' : ''} missing
              </span>
            )}
          </div>
          <div style={{ display: 'flex', gap: '8px' }}>
            {step > 1 && <button style={s.btnGhost} onClick={() => setStep(step - 1)}>Back</button>}
            {step < 4 && <button style={s.btnPrimary} onClick={() => { touchStep(step); setStep(step + 1) }}>Continue</button>}
            {step === 4 && (
              <button
                style={{ ...s.btnPrimary, opacity: saving || whySplit ? 0.55 : 1 }}
                onClick={handlePost}
                disabled={saving || !!whySplit}
                title={whySplit || undefined}>
                {saving ? 'Saving...' : invoice ? 'Update invoice' : 'Post invoice'}
              </button>
            )}
          </div>
        </div>
      </div>

      {partnerDialogOpen && (
        <PartnerDialog
          initialName={partnerDialogInitialName}
          initialAccountNumber=""
          onClose={() => setPartnerDialogOpen(false)}
          onSaved={(newPartner) => {
            setPartners(prev => [...prev, newPartner])
            setPartnerId(newPartner.id)
            setPartnerSearch(newPartner.name)
            setPartnerDialogOpen(false)
          }}
        />
      )}
    </div>
  )
}

const s: Record<string, React.CSSProperties> = {
  ...chrome,

  dialog: { background: DIALOG.panel, borderRadius: '16px', width: '800px', maxWidth: '95vw', maxHeight: '90vh', display: 'flex', flexDirection: 'column', overflow: 'hidden' },

  invBadge: { fontSize: '10px', fontWeight: '500', padding: '3px 8px', borderRadius: '20px', background: 'rgba(29,158,117,0.2)', color: DIALOG.accent, border: '0.5px solid rgba(29,158,117,0.3)' },
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
  dropdown: { position: 'absolute' as const, top: '100%', left: 0, right: 0, background: DIALOG.panel, border: '0.5px solid ' + DIALOG.border, borderRadius: '8px', zIndex: 100, boxShadow: '0 4px 12px rgba(0,0,0,0.08)', marginTop: '2px', maxHeight: '200px', overflowY: 'auto' as const },
  dropdownItem: { padding: '8px 12px', fontSize: '13px', color: DIALOG.text, cursor: 'pointer', borderBottom: '0.5px solid ' + DIALOG.borderSoft },
  linkBtn: { background: 'none', border: 'none', color: DIALOG.accent, fontSize: '12px', cursor: 'pointer', padding: '4px 0', fontFamily: 'system-ui,sans-serif' },
  typeRow: { display: 'flex', gap: '8px' },
  typeChip: { flex: 1, padding: '9px 12px', border: '0.5px solid ' + DIALOG.border, borderRadius: '8px', background: DIALOG.raised, fontSize: '13px', cursor: 'pointer', textAlign: 'center' as const, fontWeight: '500', color: DIALOG.dim },
  typeChipExpense: { border: '2px solid ' + DIALOG.red, background: DIALOG.redFill, color: DIALOG.red },
  typeChipRevenue: { border: '2px solid ' + DIALOG.accent, background: DIALOG.accentFill, color: DIALOG.accent },
  infoBox: { background: DIALOG.accentFill, border: '0.5px solid ' + DIALOG.accent, borderRadius: '8px', padding: '8px 12px', fontSize: '12px', color: DIALOG.accent },
  allocGrid: { display: 'grid', gridTemplateColumns: 'repeat(4,1fr)', gap: '8px' },
  allocBtn: { border: '0.5px solid ' + DIALOG.border, borderRadius: '8px', padding: '8px 6px', background: DIALOG.raised, cursor: 'pointer', textAlign: 'center' as const },
  allocBtnActive: { border: '2px solid ' + DIALOG.accent, background: DIALOG.accentFill },
  allocLabel: { fontSize: '11px', fontWeight: '500', color: DIALOG.text },
  allocSub: { fontSize: '10px', color: DIALOG.dim, marginTop: '2px' },
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
  reconcileBox: { background: DIALOG.blueFill, border: '0.5px solid ' + DIALOG.blue, borderRadius: '10px', padding: '14px 16px' },
  linkedTxCard: { background: DIALOG.accentFill, border: '0.5px solid ' + DIALOG.accent, borderRadius: '8px', padding: '10px 12px' },
  unlinkBtn: { fontFamily: 'system-ui,sans-serif', fontSize: '11px', padding: '4px 10px', border: '0.5px solid ' + DIALOG.red, borderRadius: '6px', background: 'transparent', color: DIALOG.red, cursor: 'pointer', whiteSpace: 'nowrap' as const },
  txList: { display: 'flex', flexDirection: 'column' as const, gap: '4px', maxHeight: '220px', overflowY: 'auto' as const },
  txRow: { display: 'flex', alignItems: 'center', gap: '12px', padding: '8px 10px', border: '0.5px solid ' + DIALOG.border, borderRadius: '8px', background: DIALOG.panel, cursor: 'pointer' },
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
