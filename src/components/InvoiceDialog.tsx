import React, { useState, useEffect } from 'react'
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
import { REVENUE_STREAMS, streamForProjectKind } from '../services/revenueStreams'
import {
  advanceDeductionBook, projectAdvanceBalance, validateAdvanceDeduction,
  type AdvanceDeduction, type AdvanceReceipt,
} from '../services/revenue'
import { round2 } from '../services/bookAmounts'
import { countOf } from '../utils/plural'

/** Display labels for the stored tag keys; the keys stay as they are in the data. */
const TAG_LABEL: Record<string, string> = {
  Recurring: 'Ponavljajući', Prepayment: 'Unapred plaćeno', Accrual: 'Razgraničenje',
  'Capital expenditure': 'Kapitalni izdatak', 'Tax deductible': 'Poreski priznat', Reimbursable: 'Refundacija',
}

interface Props {
  onClose: () => void
  invoice?: any
  /**
   * The id of the invoice this dialog just created.
   *
   * Handed over rather than found again: a caller that looks up "the invoice
   * just written" by number links the wrong one as soon as two bills share a
   * number. It is awaited, so whatever the caller does finishes before the
   * dialog reports success -- but a failure in it is the caller's to show.
   * The invoice exists by then, and reading it as "not posted" would invite a
   * second click and a second invoice.
   */
  onSaved?: (invoiceId: string) => void | Promise<void>
  /** Lines shown above every step: what the person confirming should have
   *  read first, such as a proposed classification and the reason for it. */
  reviewNotes?: string[]
  /** The invoice is a credit note, so its amount must be NEGATIVE where every
   *  other invoice's must be greater than zero. */
  creditNote?: boolean
}

interface ValidationErrors { [key: string]: string }

export default function InvoiceDialog({ onClose, invoice, onSaved, reviewNotes, creditNote }: Props) {
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
  // Whether the user picked the stream themselves. Until they do, a revenue
  // invoice's stream follows its project's kind (a site bills progress, a
  // building rent) — see streamForProjectKind.
  const [revStreamChosen, setRevStreamChosen] = useState(false)
  // ── The advance this billing deducts (Odbijeni avans) ──────────────────
  // Typed in the invoice's currency. Only on a revenue invoice that is on
  // one project and not split (CHECK invoices_advance_deducted_check); the
  // project's advance balance comes from its is_advance receipts less what
  // its other billings already deducted (revenue.projectAdvanceBalance).
  const [advanceInput, setAdvanceInput] = useState('')
  const [projectAdvances, setProjectAdvances] = useState<AdvanceReceipt[]>([])
  const [projectDeductions, setProjectDeductions] = useState<AdvanceDeduction[]>([])
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

  /** Whether this bill may deduct an advance at all. */
  const advanceEligible = invType === 'revenue' && !splitActive && !!projectId && (parseFloat(amount) || 0) > 0
  /** The deduction as it will be saved, in the invoice's currency: 0 where not allowed. */
  const advanceOwn = advanceEligible ? round2(Math.max(0, parseFloat(advanceInput) || 0)) : 0
  /** The project's advance still to deduct, this bill's own old deduction left out. */
  const advanceBalance = projectId
    ? projectAdvanceBalance(projectId, projectAdvances, projectDeductions.filter(d => !invoice?.id || d.id !== invoice.id))
    : null
  /** What the investor is billed to pay: the amount less the advance. */
  const amountDue = round2((parseFloat(amount) || 0) - advanceOwn)
  /** The deduction's book figures at this invoice's rates, for the totals. */
  const advanceBook = (() => {
    if (!(advanceOwn > 0) || !book.amounts) return null
    try {
      return advanceDeductionBook(advanceOwn, { currency, exchange_rate: book.amounts.exchange_rate, eur_rate: book.amounts.eur_rate })
    } catch { return null }
  })()

  const runValidation = () => {
    const e: ValidationErrors = {}
    if (!companyId) e.companyId = 'Firma je obavezna'
    if (!currency) e.currency = 'Valuta je obavezna'
    if (!invoiceDate) e.invoiceDate = 'Datum fakture je obavezan'
    if (!partnerId && !(showNewPartner && newPartnerName.trim())) e.partnerId = 'Partner je obavezan'
    // A credit note is a negative figure by design; reading it as "not
    // greater than zero" would refuse every one. The same rule turned over
    // refuses one booked positive -- the fault the sign exists to prevent.
    if (creditNote) {
      if (!amount || !(parseFloat(amount) < 0)) e.amount = 'Knjižno odobrenje mora imati negativan iznos'
    } else if (!amount || parseFloat(amount) <= 0) e.amount = 'Iznos mora biti veći od 0'
    if (currency && parseFloat(amount) > 0 && !book.amounts) e.exRate = book.error || 'Kurs je obavezan'
    if (invType === 'expense' && plImpact && !linkedTxId) {
      // A split bill is classified by its lines, and the fields below are
      // filled from them. Demanding them again would refuse a bill that is
      // fully classified, which is how a correct entry comes to look wrong.
      if (!plCatId && !splitActive) e.plCat = 'P&L kategorija je obavezna'
      if (!deptId && !splitActive) e.dept = 'Sektor je obavezan'
    }
    if (invType === 'revenue' && !revStream) e.revStream = 'Vrsta prihoda je obavezna'
    if (advanceOwn > 0) {
      const why = validateAdvanceDeduction({
        invoice: {
          id: invoice?.id, type: invType, project_id: projectId, amount: parseFloat(amount) || 0,
          currency: currency || 'RSD',
          exchange_rate: book.amounts?.exchange_rate ?? null, eur_rate: book.amounts?.eur_rate ?? null,
        },
        advanceDeducted: advanceOwn,
        advances: projectAdvances,
        deductions: projectDeductions,
      })
      if (why) e.advance = why
    }
    return e
  }

  useEffect(() => {
    setErrors(runValidation())
  }, [companyId, currency, invoiceDate, partnerId, newPartnerName, showNewPartner, invType, plCatId, deptId, revStream, amount, exRate, eurRate, plImpact, linkedTxId, advanceInput, projectId, splitLines, projectAdvances, projectDeductions]) // eslint-disable-line

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

  // The project's advances and the billings that already deduct them, read
  // whenever the project of a revenue invoice changes.
  useEffect(() => {
    if (invType !== 'revenue' || !projectId) { setProjectAdvances([]); setProjectDeductions([]); return }
    let cancelled = false
    const load = async () => {
      const [adv, ded] = await Promise.all([
        supabase.from('transactions')
          .select('id, project_id, currency, amount, amount_rsd, amount_eur, status, deleted_at')
          .eq('project_id', projectId).eq('is_advance', true),
        supabase.from('invoices')
          .select('id, project_id, currency, advance_deducted, advance_deducted_rsd, advance_deducted_eur, deleted_at')
          .eq('project_id', projectId).gt('advance_deducted', 0),
      ])
      if (cancelled) return
      if (adv.error || ded.error) console.warn('advance balance load error:', (adv.error || ded.error)?.message)
      setProjectAdvances((adv.data || []) as AdvanceReceipt[])
      setProjectDeductions((ded.data || []) as AdvanceDeduction[])
    }
    load()
    return () => { cancelled = true }
  }, [invType, projectId])

  // A revenue invoice's stream follows its project's kind until the user
  // picks one: 'Građevinske situacije' on a construction site, 'Zakup' on a
  // rental building.
  useEffect(() => {
    if (invType !== 'revenue' || revStreamChosen || !projectId) return
    const kind = projects.find(p => p.id === projectId)?.kind
    const stream = streamForProjectKind(kind)
    if (stream && stream !== revStream) setRevStream(stream)
  }, [invType, projectId, projects, revStreamChosen]) // eslint-disable-line

  useEffect(() => {
    if (!companyId) return
    const load = async () => {
      const { data, error } = await supabase
        .from('transactions')
        .select('id, transaction_date, is_advance, amount, amount_rsd, amount_eur, currency, pl_category, pl_subcategory, department, dept_subcategory, expense_description, revenue_stream, project_id, dept_split_type, tags, note, exchange_rate, eur_rate, is_indexed, banks(id,name), partners(id,name)')
        .eq('company_id', companyId).eq('type', 'direct').eq('status', 'posted')
        .order('transaction_date', { ascending: false }).limit(150)
      if (error) console.error('transactions load error:', error)
      // An advance carries no P&L and is never an invoice's payment: a
      // billing uses it through advance_deducted only.
      if (data) setDirectTransactions(data.filter((t: any) => !t.is_advance))
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
    if (tx.exchange_rate) { setExRate(tx.exchange_rate.toString()); setRateSource('iz transakcije') }
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
    // An existing bill's stream is the user's, not the project's default.
    setRevStreamChosen(!!invoice.revenue_stream)
    setAdvanceInput(Number(invoice.advance_deducted) > 0 ? String(invoice.advance_deducted) : '')
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
      (tx.transaction_date || '').includes(reconcileSearch) ||
      // A transaction with no partner on it cannot be found by name, and that
      // is the one that has to be linked by hand. Both figures on the row are
      // offered, because he types whichever he is reading.
      matchesAmount(reconcileSearch, tx.amount, tx.amount_rsd)
  })
  const linkedTx = directTransactions.find(t => t.id === linkedTxId)

  const touch = (field: string) => setTouched(prev => ({ ...prev, [field]: true }))
  const fieldErr = (field: string) => touched[field] ? errors[field] : undefined
  const totalErrors = Object.keys(errors).length
  const isValid = totalErrors === 0

  const touchStep = (n: number) => {
    if (n === 1) setTouched(p => ({ ...p, companyId: true, currency: true, invoiceDate: true, partnerId: true }))
    if (n === 2) setTouched(p => ({ ...p, amount: true, exRate: true }))
    if (n === 3) setTouched(p => ({ ...p, plCat: true, dept: true, revStream: true, advance: true }))
  }

  const stepHasError = (n: number) => {
    const stepFields: Record<number, string[]> = {
      1: ['companyId', 'currency', 'invoiceDate', 'partnerId'],
      2: ['amount', 'exRate'],
      3: ['plCat', 'dept', 'revStream', 'advance'],
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
      setRateSource(err instanceof Error ? `${err.message} — unesite ga ručno` : 'Nema zvaničnog kursa — unesite ga ručno')
      setRateMissing(true)
    }
    setFetchingRate(false)
  }

  const toggleTag = (t: string) => setTags(prev => prev.includes(t) ? prev.filter(x => x !== t) : [...prev, t])

  const cfLabel = () => {
    if (!cfType) return '—'
    if (cfType === 'recurring') return `Ponavljajući, ${cfFrequency === 'monthly' ? 'mesečno' : cfFrequency === 'quarterly' ? 'kvartalno' : cfFrequency === 'yearly' ? 'godišnje' : cfFrequency}`
    if (cfType === 'one_time') return 'Jednokratni'
    if (cfType === 'accrual') return `Razgraničenje ${cfAccrualFrom ? `${cfAccrualFrom} → ${cfAccrualTo}` : ''}`
    if (cfType === 'capex') return `Kapitalni izdatak (${cfCapexMonths || '?'} mes.)`
    if (cfType === 'reimbursable') return `Refundacija${cfReimbursableDate ? ` do ${cfReimbursableDate}` : ''}`
    return '—'
  }

  const stepTitles = ['Osnovni podaci', 'Iznos i valuta', 'Klasifikacija i P&L', 'Pregled i knjiženje']

  const handlePost = async () => {
    setTouched({ companyId: true, currency: true, invoiceDate: true, partnerId: true, plCat: true, dept: true, revStream: true, amount: true, exRate: true, advance: true })
    const e = runValidation()
    if (Object.keys(e).length > 0) { setShowValidationSummary(true); return }
    const booked = book.amounts
    if (!booked) { setSaveError(book.error || 'Kurs je obavezan'); return }
    setSaveError('')
    setSaving(true)
    try {
      let finalPartnerId = partnerId
      if (showNewPartner && newPartnerName) {
        const { data: newP, error: partnerErr } = await supabase.from('partners').insert({ name: newPartnerName }).select().single()
        if (partnerErr) throw partnerErr
        if (!newP?.id) throw new Error('Novi partner je sačuvan, ali baza nije vratila njegov ID — ništa nije proknjiženo.')
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
        // The advance this billing uses up, at the invoice's own rates
        // (three zeros when it deducts none — which is also what a bill that
        // stopped being a single-project revenue invoice must say, or the
        // CHECK refuses it). lease_id and service_month are never written
        // here: a rent invoice keeps them through an edit.
        ...advanceDeductionBook(advanceOwn, booked),
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
          throw new Error(`Faktura ${invoice.id} nije izmenjena — ništa nije sačuvano.`)
        invoiceId = invoice.id
        if (linkedTxId && plCatName) {
          const { data: tx, error: txErr } = await supabase.from('transactions').update({ pl_category: plCatName || null, pl_subcategory: plSubName || null, department: deptName || null, dept_subcategory: deptSubName || null, expense_description: expDesc || null, revenue_stream: revStream || null, project_id: ownProjectId }).eq('id', linkedTxId).select('id')
          if (txErr) throw txErr
          if (!tx || tx.length === 0)
            throw new Error(`Faktura je sačuvana, ali transakcija ${linkedTxId} nije izmenjena — njena P&L klasifikacija se sada ne slaže sa fakturom.`)
        }
      } else {
        const { data: newInv, error: insErr } = await supabase.from('invoices').insert(payload).select().single()
        if (insErr) throw insErr
        // An unchecked insert that returned nothing is how `invoiceId` used to
        // end up undefined, which then made the link write below operate on
        // `invoice_id=undefined` — deleting nothing, inserting nothing, and
        // reporting success.
        if (!newInv?.id) throw new Error('Faktura nije sačuvana — baza nije vratila red.')
        invoiceId = newInv.id
        // From here the invoice EXISTS, whatever the steps below do. Handed
        // over now so a later failure cannot leave it unlinked.
        if (onSaved) {
          try { await onSaved(newInv.id) } catch { /* the caller shows its own failure; see `onSaved` above */ }
        }
        if (linkedTxId && plCatName) {
          const { data: tx, error: txErr } = await supabase.from('transactions').update({ pl_category: plCatName || null, pl_subcategory: plSubName || null, department: deptName || null, dept_subcategory: deptSubName || null, expense_description: expDesc || null, project_id: ownProjectId }).eq('id', linkedTxId).select('id')
          if (txErr) throw txErr
          if (!tx || tx.length === 0)
            throw new Error(`Faktura je sačuvana, ali transakcija ${linkedTxId} nije izmenjena — njena P&L klasifikacija se sada ne slaže sa fakturom.`)
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
          note: 'Upareno — P&L je već proknjižen kroz direktnu transakciju',
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
        <div style={{ fontFamily: 'Georgia,serif', fontSize: '20px', color: DIALOG.text }}>{invoice ? 'Faktura je izmenjena.' : 'Faktura je proknjižena.'}</div>
        <div style={{ fontSize: '13px', color: DIALOG.dim }}>{linkedTxId ? 'Uparena — P&L je usklađen sa direktnom transakcijom.' : 'Uspešno sačuvano u P&L.'}</div>
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
      <div style={s.sectionTitle}>Projekat</div>
      {splitActive ? (
        <div style={{ fontSize: '11.5px', color: DIALOG.dim, lineHeight: 1.5 }}>
          Faktura je podeljena — svaka stavka iznad nosi svoj projekat.
          Uklonite podelu da biste celu fakturu stavili na jedan projekat.
        </div>
      ) : invoice?.lease_id ? (
        <>
          <ProjectSelect value={projectId} onChange={() => {}} companyId={companyId || null}
            style={pickerChrome} disabled title="Faktura za zakup pripada projektu ugovora o zakupu" />
          <div style={{ fontSize: '11.5px', color: DIALOG.dim, marginTop: '6px', lineHeight: 1.5 }}>
            Faktura za zakup pripada projektu ugovora o zakupu — projekat se ne menja ovde.
          </div>
        </>
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
              {(() => { const m = Math.max(1, Math.round((new Date(cfAccrualTo).getTime() - new Date(cfAccrualFrom).getTime()) / (1000*60*60*24*30))); return `Mesečno: ${fmtNum(parseFloat(amount)/m)} ${currency} × ${m} mes.` })()}
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
            <div style={s.headerTitle}>{invoice ? 'Izmena fakture' : 'Nova faktura'}</div>
            <div style={s.headerSub}>Korak {step} od 4 — {stepTitles[step - 1]}</div>
          </div>
          <div style={{ display: 'flex', alignItems: 'center', gap: '12px' }}>
            <div style={{ ...s.invBadge, ...(linkedTxId ? { background: 'rgba(12,68,124,0.2)', color: DIALOG.blue, borderColor: 'rgba(12,68,124,0.3)' } : {}) }}>
              {linkedTxId ? '🔗 Uparena' : 'Utiče na P&L'}
            </div>
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

        {saveError && (
          <div style={s.validationBanner}>
            <span>⚠️</span>
            <div style={{ flex: 1 }}>
              <div style={{ fontWeight: '500', fontSize: '12px' }}>Faktura nije proknjižena</div>
              <div style={{ fontSize: '11px', marginTop: '2px', opacity: 0.9 }}>{saveError}</div>
            </div>
            <button style={s.bannerClose} onClick={() => setSaveError('')}>×</button>
          </div>
        )}

        {reviewNotes && reviewNotes.length > 0 && (
          <div data-testid="review-notes" style={{ ...s.validationBanner, background: DIALOG.raised, borderColor: DIALOG.border, color: DIALOG.text }}>
            <div style={{ flex: 1, fontSize: '12px', lineHeight: 1.5 }}>
              {reviewNotes.map((n, i) => <div key={i} style={{ marginTop: i ? '4px' : 0 }}>{n}</div>)}
            </div>
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
              {companyId && (
                <div style={{ ...s.reconcileBox, marginBottom: '20px' }}>
                  <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: '10px' }}>
                    <div>
                      <div style={{ fontSize: '13px', fontWeight: '500', color: DIALOG.blue }}>🔗 Poveži sa postojećom direktnom transakcijom</div>
                      <div style={{ fontSize: '11px', color: DIALOG.blue, marginTop: '2px' }}>Izaberite direktnu transakciju da se sva polja popune automatski. Faktura će biti označena kao plaćena, bez dvostrukog P&L.</div>
                    </div>
                    {linkedTxId && <button style={s.unlinkBtn} onClick={handleUnlink}>✕ Raskini vezu</button>}
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
                        ℹ️ Polja su popunjena iz transakcije. I dalje ih možete menjati ispod. P&L se usklađuje pri knjiženju.
                      </div>
                    </div>
                  ) : (
                    <>
                      <input style={{ ...s.input, marginBottom: '8px', width: '100%', boxSizing: 'border-box' as const }}
                        value={reconcileSearch} onChange={e => setReconcileSearch(e.target.value)} placeholder="Pretraga po partneru, kategoriji, datumu ili iznosu…" />
                      {directTransactions.length === 0 ? (
                        <div style={{ fontSize: '12px', color: DIALOG.faint, padding: '8px', textAlign: 'center' as const }}>Ova firma još nema direktnih transakcija.</div>
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
                            <div style={{ fontSize: '12px', color: DIALOG.faint, padding: '8px', textAlign: 'center' as const }}>Nema rezultata za „{reconcileSearch}“</div>
                          )}
                        </div>
                      )}
                    </>
                  )}
                </div>
              )}

              <div style={s.section}>
                <div style={s.sectionTitle}>Firma i podaci o fakturi</div>
                <div style={s.row2}>
                  {showPicker && (
                    <div style={s.field}>
                      <label style={s.lbl}>Firma <span style={s.req}>*</span></label>
                      <select style={{ ...s.select, ...(fieldErr('companyId') ? s.inputError : {}) }} value={companyId}
                        onChange={e => { setCompanyId(e.target.value); setCurrency(''); setLinkedTxId(''); touch('companyId') }} onBlur={() => touch('companyId')}>
                        <option value="">Izaberite firmu…</option>
                        {companies.map(c => <option key={c.id} value={c.id}>{c.name}</option>)}
                      </select>
                      {fieldErr('companyId') && <span style={s.errorMsg}>{fieldErr('companyId')}</span>}
                    </div>
                  )}
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
                </div>
                <div style={s.row3}>
                  <div style={s.field}>
                    <label style={s.lbl}>Broj fakture</label>
                    <input style={s.input} value={invoiceNumber} onChange={e => { setInvoiceNumber(e.target.value); setRefNum(e.target.value) }} placeholder="npr. F-001/2026" />
                  </div>
                  <div style={s.field}>
                    <label style={s.lbl}>Datum fakture <span style={s.req}>*</span></label>
                    <input type="date" style={{ ...s.input, ...(fieldErr('invoiceDate') ? s.inputError : {}) }} value={invoiceDate}
                      onChange={e => { setInvoiceDate(e.target.value); touch('invoiceDate') }} onBlur={() => touch('invoiceDate')} />
                    {fieldErr('invoiceDate') && <span style={s.errorMsg}>{fieldErr('invoiceDate')}</span>}
                  </div>
                  <div style={s.field}>
                    <label style={s.lbl}>Datum dospeća</label>
                    <input type="date" style={s.input} value={dueDate} onChange={e => setDueDate(e.target.value)} />
                  </div>
                </div>
              </div>

              <div style={s.section}>
                <div style={s.sectionTitle}>Partner i tip</div>
                <div style={s.row2}>
                  <div style={s.field}>
                    <label style={s.lbl}>Partner <span style={s.req}>*</span></label>
                    <div style={{ display: 'flex', gap: '6px', alignItems: 'flex-start' }}>
                      <div style={{ flex: 1, position: 'relative' as const }}>
                        <input style={{ ...s.input, ...(fieldErr('partnerId') ? s.inputError : {}) }} value={partnerSearch}
                          onChange={e => { setPartnerSearch(e.target.value); setPartnerId(''); touch('partnerId') }}
                          onBlur={() => touch('partnerId')} placeholder="Pretraga partnera…" />
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
                        title="Dodaj novog partnera (pretraga NBS)">+</button>
                    </div>
                  </div>
                  <div style={s.field}>
                    <label style={s.lbl}>Tip fakture <span style={s.req}>*</span></label>
                    <div style={s.typeRow}>
                      <div style={{ ...s.typeChip, ...(invType === 'expense' ? s.typeChipExpense : {}) }} onClick={() => { if (!invoice?.lease_id) setInvType('expense') }} title={invoice?.lease_id ? 'Faktura za zakup je uvek izlazna' : undefined}>📤 Ulazna</div>
                      <div style={{ ...s.typeChip, ...(invType === 'revenue' ? s.typeChipRevenue : {}) }} onClick={() => setInvType('revenue')}>📥 Izlazna</div>
                    </div>
                  </div>
                </div>
                <div style={s.sectionTitle}>Podaci za plaćanje</div>
                <div style={s.row3}>
                  <div style={s.field}>
                    <label style={s.lbl}>Broj računa (RSD)</label>
                    {partnerAccounts.length > 1 ? (
                      <>
                        {/* A number that is none of the saved accounts needs a
                            row of its own, or the select lights up the FIRST
                            account instead — a different account from the one
                            that will be paid, shown as though it were chosen. */}
                        <select style={s.select} value={selectedAccountId} onChange={e => handleAccountSelect(e.target.value)}>
                          {!selectedAccountId && <option value="">Uneto ručno — nije sačuvan račun</option>}
                          {partnerAccounts.map(acc => (
                            <option key={acc.id} value={acc.id}>{acc.account_number}{acc.bank_name ? ` — ${acc.bank_name}` : ''}{acc.is_primary ? ' ★' : ''}</option>
                          ))}
                        </select>
                        {!selectedAccountId && (
                          <input style={{ ...s.input, marginTop: '4px' }} value={accNum}
                            onChange={e => setAccNum(e.target.value)} placeholder="Tekući račun partnera" />
                        )}
                      </>
                    ) : (
                      <input style={s.input} value={accNum} onChange={e => setAccNum(e.target.value)} placeholder="Tekući račun partnera" />
                    )}
                    {partnerAccounts.length > 0 && <div style={{ fontSize: '10px', color: DIALOG.accent, marginTop: '2px' }}>Pronađeno računa: {partnerAccounts.length}</div>}
                  </div>
                  <div style={s.field}>
                    <label style={s.lbl}>Model</label>
                    <input style={s.input} value={model} onChange={e => setModel(e.target.value)} placeholder="npr. 97" />
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
              <div style={s.sectionTitle}>Iznos i preračun valute</div>
              <div style={s.toggleRow}>
                <span style={s.toggleLabel}>Iznos indeksiran u stranoj valuti?</span>
                <label style={s.toggle}>
                  <input type="checkbox" checked={isIndexed} onChange={e => setIsIndexed(e.target.checked)} style={{ opacity: 0, width: 0, height: 0 }} />
                  <span style={{ ...s.toggleSlider, background: isIndexed ? DIALOG.accent : DIALOG.border }} />
                </label>
              </div>
              {linkedTxId && (
                <div style={{ ...s.infoBox, marginBottom: '10px', background: DIALOG.blueFill, borderColor: DIALOG.blue, color: DIALOG.blue, fontSize: '11px' }}>
                  🔗 Iznos je preuzet iz direktne transakcije. Izmenite ga ako se iznos fakture razlikuje.
                </div>
              )}
              <div style={{ ...s.infoBox, margin: '10px 0' }}>
                {currency === 'RSD'
                  ? 'Knjiži se u RSD; iznos u EUR daje kurs NBS za EUR na datum fakture.'
                  : `Srednji kurs NBS na datum fakture, u RSD za 1 ${currency || 'jedinicu'}.`}
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
                <div><div style={s.convLabel}>Iznos fakture</div><div style={s.convVal}>{amount ? fmtLocal(parseFloat(amount), currency) : '—'}</div></div>
                <div style={{ fontSize: '20px', color: DIALOG.faint, alignSelf: 'flex-end', paddingBottom: '4px' }}>→</div>
                <div><div style={s.convLabel}>RSD (knjiženo)</div><div style={{ ...s.convVal, color: DIALOG.accent }}>{book.amounts ? fmtMoney(amountRsd, 'RSD') : '—'}</div></div>
                <div><div style={s.convLabel}>EUR</div><div style={{ ...s.convVal, color: DIALOG.accent }}>{book.amounts ? fmtMoney(amountEur, 'EUR') : '—'}</div></div>
              </div>
              {dueDate && <div style={{ ...s.infoBox, marginTop: '12px', background: DIALOG.amberFill, borderColor: DIALOG.amber, color: DIALOG.amber }}>📅 Datum dospeća: <strong>{dueDate}</strong></div>}
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
              {/* A rent invoice stays on its lease's project, whole. */}
              {!invoice?.lease_id && <SplitEditor
                parent={splitParent}
                lines={splitLines}
                onChange={changeSplitLines}
                companyId={companyId || null}
                scripts={quickFillScripts as any}
                classification={{ plCategories, plSubcategories, departments, deptSubcategories, expenseDescriptions }}
                client={supabase}
                onScriptsChanged={() => { fetchScripts(supabase).then(setQuickFillScripts as any) }}
                hint="Jedna faktura, dva ili više troškova — npr. laptop i godinu dana podrške."
              />}
              {linkedTxId && (
                <div style={{ ...s.infoBox, marginBottom: '16px', background: DIALOG.blueFill, borderColor: DIALOG.blue, color: DIALOG.blue }}>
                  🔗 Povezano sa direktnom transakcijom — P&L polja su popunjena automatski. Izmene se pri knjiženju prenose na transakciju.
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
                    <div style={s.sectionTitle}>P&L klasifikacija</div>
                    {splitActive && (
                      <div style={{ ...s.infoBox, marginBottom: '12px', background: DIALOG.amberFill, borderColor: DIALOG.amber, color: DIALOG.amber }}>
                        Preuzeto iz najveće stavke podele iznad i zaključano dok podela postoji.
                        P&amp;L čita podelu; ovo je ono pod čim glavna knjiga vodi fakturu.
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
                        <label style={s.lbl}>P&L kategorija {!linkedTxId && <span style={s.req}>*</span>}</label>
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
                        <label style={s.lbl}>Sektor {!linkedTxId && <span style={s.req}>*</span>}</label>
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

              {invType === 'revenue' && (
                <div style={s.section}>
                  <div style={s.sectionTitle}>Podaci o prihodu</div>
                  <div style={s.field}>
                    <label style={s.lbl}>Vrsta prihoda <span style={s.req}>*</span></label>
                    <select style={{ ...s.select, ...(fieldErr('revStream') ? s.inputError : {}) }} value={revStream}
                      onChange={e => { setRevStream(e.target.value); setRevStreamChosen(true); touch('revStream') }} onBlur={() => touch('revStream')}>
                      <option value="">Izaberite vrstu prihoda…</option>
                      {revenueStreams.map(r => <option key={r}>{r}</option>)}
                    </select>
                    {fieldErr('revStream') && <span style={s.errorMsg}>{fieldErr('revStream')}</span>}
                  </div>
                  {invoice?.lease_id && (
                    <div style={{ fontSize: '11.5px', color: DIALOG.dim, marginTop: '6px', lineHeight: 1.5 }}>
                      Faktura zakupa{invoice.service_month ? ` za ${String(invoice.service_month).slice(0, 7)}` : ''} — ostaje vezana za ugovor o zakupu i svoj mesec.
                    </div>
                  )}
                </div>
              )}
              {invType === 'revenue' && projectPanel}

              {invType === 'revenue' && (
                <div style={s.section}>
                  <div style={s.sectionTitle}>Odbijeni avans</div>
                  {!advanceEligible ? (
                    <div style={{ fontSize: '11.5px', color: DIALOG.dim, lineHeight: 1.5 }}>
                      Avans se odbija samo na izlaznoj fakturi koja je na jednom projektu i nije podeljena.
                    </div>
                  ) : (
                    <>
                      <div style={{ fontSize: '11.5px', color: DIALOG.dim, marginBottom: '8px', lineHeight: 1.5 }}>
                        Preostali avans na projektu:{' '}
                        <strong style={{ color: DIALOG.text }}>
                          {!advanceBalance || (advanceBalance.received_rsd === 0 && advanceBalance.deducted_rsd === 0)
                            ? 'nema primljenog avansa'
                            : advanceBalance.currency && advanceBalance.remaining !== null
                              ? fmtMoney(advanceBalance.remaining, advanceBalance.currency)
                              : `${fmtMoney(advanceBalance.remaining_rsd, 'RSD')} · ${fmtMoney(advanceBalance.remaining_eur, 'EUR')}`}
                        </strong>
                      </div>
                      <div style={{ display: 'flex', gap: '8px', alignItems: 'center' }}>
                        <input type="number" min="0" step="0.01"
                          style={{ ...s.input, flex: 1, ...(fieldErr('advance') ? s.inputError : {}) }}
                          value={advanceInput}
                          onChange={e => { setAdvanceInput(e.target.value); touch('advance') }}
                          onBlur={() => touch('advance')}
                          placeholder={`0.00 ${currency || ''}`} />
                        {advanceBalance && advanceBalance.currency === (currency || 'RSD') && (advanceBalance.remaining || 0) > 0 && (
                          <button style={s.linkBtn} onClick={() => {
                            const max = Math.min(advanceBalance.remaining || 0, parseFloat(amount) || 0)
                            setAdvanceInput(String(round2(max))); touch('advance')
                          }}>Odbij preostali</button>
                        )}
                      </div>
                      {fieldErr('advance') && <span style={s.errorMsg}>{fieldErr('advance')}</span>}
                      {advanceOwn > 0 && (
                        <div style={{ fontSize: '11.5px', color: DIALOG.dim, marginTop: '6px' }}>
                          Za naplatu: <strong style={{ color: DIALOG.text }}>{fmtMoney(amountDue, currency || 'RSD')}</strong>
                          {' '}(prihod ostaje pun iznos fakture)
                        </div>
                      )}
                    </>
                  )}
                </div>
              )}

              <div style={s.section}>
                <div style={s.sectionTitle}>Oznake i napomena</div>
                <div style={s.tagRow}>
                  {['Recurring', 'Prepayment', 'Accrual', 'Capital expenditure', 'Tax deductible', 'Reimbursable'].map(t => (
                    <span key={t} style={{ ...s.tag, ...(tags.includes(t) ? s.tagActive : {}) }} onClick={() => toggleTag(t)}>{TAG_LABEL[t] || t}</span>
                  ))}
                </div>
                <div style={{ marginTop: '12px' }}>
                  <label style={s.lbl}>Napomena</label>
                  <textarea style={s.textarea} value={note} onChange={e => setNote(e.target.value)} placeholder="Dodatne napomene…" />
                </div>
              </div>
            </>
          )}

          {/* ── STEP 4 ── */}
          {step === 4 && (
            <div style={s.section}>
              <div style={s.sectionTitle}>Pregled pre knjiženja</div>

              {/* The split belongs in the review for the same reason every
                  other figure does: this is the page somebody checks before
                  the entry exists. */}
              {splitLines.length > 0 && (
                <div style={{ ...s.infoBox, marginBottom: '16px', ...(whySplit
                  ? { background: DIALOG.amberFill, borderColor: DIALOG.amber, color: DIALOG.amber }
                  : {}) }}>
                  <div style={{ fontWeight: 500, marginBottom: '4px' }}>
                    Podela na {countOf(splitLines.length, 'trošak', 'troška', 'troškova')}
                  </div>
                  {splitLines.map((l, i) => (
                    <div key={l.key} style={{ fontSize: '11.5px', opacity: 0.9, lineHeight: 1.7 }}>
                      {i + 1}. {[l.pl_category, l.pl_subcategory, l.department, l.expense_description]
                        .filter(Boolean).join(' › ') || 'ništa nije izabrano'}
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
                    <div style={{ fontWeight: '500', marginBottom: '2px' }}>Sva polja su ispravna — spremno za knjiženje</div>
                    <div style={{ fontSize: '11px', opacity: 0.85 }}>{linkedTxId ? 'Faktura će biti uparena. P&L polja se usklađuju sa direktnom transakcijom.' : `Faktura utiče na P&L na datum ${invoiceDate}.`}</div>
                  </div>
                </div>
              ) : (
                <div style={{ ...s.validationBanner, marginBottom: '16px', position: 'relative' }}>
                  <span>⚠️</span>
                  <div>
                    <div style={{ fontWeight: '500', fontSize: '12px' }}>Nedostaju obavezna polja: {totalErrors}</div>
                    <div style={{ fontSize: '11px', marginTop: '2px' }}>{Object.values(errors).join(' · ')}</div>
                  </div>
                </div>
              )}
              {[
                { title: 'Podaci o fakturi', rows: [
                  ['Firma', companies.find(c => c.id === companyId)?.name || '—'],
                  ['Partner', showNewPartner ? newPartnerName : (partners.find(p => p.id === partnerId)?.name || partnerSearch || '—')],
                  ['Broj fakture', invoiceNumber || '—'],
                  ['Datum fakture', invoiceDate || '—'],
                  ['Datum dospeća', dueDate || '—'],
                  ['Tip', invType === 'revenue' ? 'Izlazna' : 'Ulazna'],
                  ['Uticaj na P&L', linkedTxId ? '❌ Nema — upareno sa direktnom transakcijom' : '✅ Da'],
                ]},
                { title: 'Iznosi', rows: [
                  ['Originalni iznos', amount ? fmtLocal(parseFloat(amount), currency) : '—'],
                  ['Kurs', book.amounts ? `${fmtNum(book.amounts.exchange_rate, 4)} RSD/${currency} · EUR ${fmtNum(book.amounts.eur_rate, 4)} (${rateSource || 'ručno'})` : 'nije dostupno'],
                  ['RSD (knjiženo)', book.amounts ? fmtMoney(amountRsd, 'RSD') : '—'],
                  ['EUR', book.amounts ? fmtMoney(amountEur, 'EUR') : '—'],
                  ...(advanceOwn > 0 ? [
                    ['Odbijeni avans', `${fmtMoney(advanceOwn, currency || 'RSD')}${advanceBook && currency !== 'RSD' ? ` · ${fmtMoney(advanceBook.advance_deducted_rsd, 'RSD')}` : ''}`],
                    ['Za naplatu', `${fmtMoney(amountDue, currency || 'RSD')}${advanceBook && book.amounts ? ` · ${fmtMoney(round2(amountRsd - advanceBook.advance_deducted_rsd), 'RSD')} · ${fmtMoney(round2(amountEur - advanceBook.advance_deducted_eur), 'EUR')}` : ''}`],
                  ] : []),
                ]},
                { title: 'P&L i novčani tok', rows: [
                  ['P&L kategorija', plCatName || '—'],
                  ['Sektor', deptName || '—'],
                  ['Opis', expDesc || '—'],
                  ['Projekat', splitActive ? 'Po stavkama podele' : projectLabelById(projects, projectId)],
                  ['Novčani tok', cfLabel()],
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
            {totalErrors > 0 && touched.companyId && (
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
                {saving ? 'Čuvanje…' : invoice ? 'Sačuvaj izmene' : 'Proknjiži fakturu'}
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
