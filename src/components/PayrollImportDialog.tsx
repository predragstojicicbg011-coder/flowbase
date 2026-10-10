import React, { useState, useRef, useCallback, useEffect } from 'react'
import * as XLSX from 'xlsx'
import { supabase } from '../supabase'
import { brand } from '../config/brand'
import { useCompanies } from '../contexts/CompaniesContext'
import { DIALOG } from './dialogTheme'
import ProjectSelect from './ProjectSelect'
import { obligationRows, obligationTotal, employeesMissingDepartment, obligationClassesFrom } from '../services/payrollAllocation'
import { classificationFor, plPartFor, PAYROLL_ROLES } from '../services/systemCategories'
import { useSystemCategories } from '../contexts/SystemCategoriesContext'
import SystemCategoryNotice from './SystemCategoryNotice'
import { PostFailure, reportPostFailure, type CompletedWrite } from '../services/writeOrder'
import { fetchAllPartners } from '../services/allPartners'
import { BOOK_CURRENCY, bookAmountsAtRate, getBookRates, type BookAmounts } from '../services/bookAmounts'
import { fmtNum, fmtEUR } from '../utils/formatters'
import { countOf } from '../utils/plural'
import { srDate } from '../utils/months'

interface Props {
  onClose: () => void
  onPosted: () => void
}

type TaxMode = 'standard' | 'incentive'

interface ParsedDeduction {
  id: string
  name: string
  amount: number
  partner_id: string
  partner_name: string
  type: 'third_party' | 'fitpass' | 'penalty'
}

interface ParsedEmployee {
  id: string
  employee_name: string
  partner_id: string
  net_salary_raw: number
  tax_on_salary_raw: number
  pio_employee_raw: number
  zdravstveno_ee_raw: number
  nezaposlenost_ee_raw: number
  pio_employer_raw: number
  zdravstveno_er_raw: number
  nezaposlenost_er_raw: number
  net_salary: number
  tax_on_salary: number
  contrib_employee: number
  contrib_employer: number
  deductions: ParsedDeduction[]
  gross_salary: number
  department_id: string
  department_name: string
  dept_subcategory_id: string
  dept_subcategory_name: string
  /** The project this person's cost goes to; null is overhead. */
  project_id: string | null
  cf_type: string
  expanded: boolean
  accepted: boolean
  edit_net: string
  edit_tax: string
  edit_contrib_ee: string
  edit_contrib_er: string
}

interface PayrollHeader {
  company_name: string
  period_label: string
  invoice_date: string
  payment_date: string
  tax_filing_ref: string
}

let empCtr = 0
let dedCtr = 0

function parsePayrollXlsx(workbook: XLSX.WorkBook, taxMode: TaxMode): { header: PayrollHeader; employees: ParsedEmployee[] } {
  const ws = workbook.Sheets[workbook.SheetNames[0]]
  const data: any[][] = XLSX.utils.sheet_to_json(ws, { header: 1, defval: null })

  const getNum = (v: any): number => {
    if (v == null) return 0
    const n = parseFloat(String(v).replace(/[^\d.,-]/g, '').replace(',', '.'))
    return isNaN(n) ? 0 : Math.abs(n)
  }

  // The export opens every page with the same line — the employer's name — so
  // the first line of the sheet is what a new page looks like. Matching it,
  // rather than a name written in here, keeps the parser any company's.
  const firstLine = data.map(r => (r && r[0] != null ? String(r[0]).trim() : '')).find(a => a !== '') || ''

  const header: PayrollHeader = {
    company_name: firstLine,
    period_label: '',
    invoice_date: '',
    payment_date: '',
    tax_filing_ref: '',
  }

  const employees: ParsedEmployee[] = []
  // en-dash (–) and regular hyphen
  const empNameRegex = /^\d{3}\s*[\u2013-]\s*(.+)$/u

  let i = 0
  while (i < data.length) {
    const row = data[i]
    if (!row) { i++; continue }
    const cellA = row[0] != null ? String(row[0]).trim() : ''

    if (cellA.startsWith('\u043e\u0431\u0440\u0430\u0447\u0443\u043d:') && !header.period_label) {
      header.period_label = cellA.replace('\u043e\u0431\u0440\u0430\u0447\u0443\u043d:', '').trim()
      header.tax_filing_ref = header.period_label
    }
    if (cellA.startsWith('\u0434\u0430\u0442\u0443\u043c \u043e\u0431\u0440\u0430\u0447\u0443\u043d\u0430:') && !header.invoice_date) {
      header.invoice_date = cellA.replace('\u0434\u0430\u0442\u0443\u043c \u043e\u0431\u0440\u0430\u0447\u0443\u043d\u0430:', '').trim().replace(/\.$/, '')
    }
    if (cellA.startsWith('\u0434\u0430\u0442\u0443\u043c \u0438\u0441\u043f\u043b\u0430\u0442\u0435:') && !header.payment_date) {
      const val = row.find((v: any, idx: number) => idx > 0 && v != null)
      if (val) header.payment_date = String(val).trim().replace(/\.$/, '')
    }

    const empMatch = cellA.match(empNameRegex)
    if (empMatch) {
      const employeeName = empMatch[1].trim()
      empCtr++

      let net_salary_raw = 0
      let tax_on_salary_raw = 0
      let pio_ee_raw = 0
      let zdravstveno_ee_raw = 0
      let nezaposlenost_ee_raw = 0
      let pio_er_raw = 0
      let zdravstveno_er_raw = 0
      let nezaposlenost_er_raw = 0
      const deductions: ParsedDeduction[] = []
      let inDeductions = false
      let inErContrib = false

      let j = i + 1
      while (j < data.length) {
        const r = data[j]
        if (!r) { j++; continue }
        const a = r[0] != null ? String(r[0]).trim() : ''
        const c2 = r[2] != null ? String(r[2]).trim() : ''
        const colN = (row_: any[]): number => {
          const v = row_[14]
          return v != null ? getNum(v) : 0
        }

        if (a.match(empNameRegex) && j > i + 2) break
        if (firstLine && a === firstLine && j > i + 5) break

        // нето за исплату — col0 can be 7 or 8, col2 may have leading apostrophe
        if (c2.replace(/^'/, '').includes('\u043d\u0435\u0442\u043e \u0437\u0430 \u0438\u0441\u043f\u043b\u0430\u0442\u0443')) {
          const v = r[15] != null ? getNum(r[15]) : colN(r)
          net_salary_raw = v
          inDeductions = false
        }

        // обуставе
        if ((a === '7' || a === '8') && c2.replace(/^'/, '').includes('\u043e\u0431\u0443\u0441\u0442\u0430\u0432\u0435')) inDeductions = true

        // deduction lines
        if (inDeductions && a !== '7' && a !== '8' && c2 && !c2.includes('\u0431\u0430\u043d\u043a\u0430')) {
          const amt = colN(r)
          if (amt > 0) {
            dedCtr++
            const isFitpass = c2.toLowerCase().includes('fitpass')
            const isPenalty = c2.toLowerCase().includes('penalty')
            deductions.push({
              id: `ded_${dedCtr}`, name: c2, amount: amt,
              partner_id: '', partner_name: '',
              type: isFitpass ? 'fitpass' : isPenalty ? 'penalty' : 'third_party',
            })
          }
        }

        // порез на зараде col14
        if (c2.includes('\u043f\u043e\u0440\u0435\u0437 \u043d\u0430 \u0437\u0430\u0440\u0430\u0434\u0435')) tax_on_salary_raw = colN(r)
        // ПИО из бруто (EE)
        if (c2.includes('\u041f\u0418\u041e \u0438\u0437 \u0431\u0440\u0443\u0442\u043e')) pio_ee_raw = colN(r)
        // здравствено из бруто
        if (c2.includes('\u0437\u0434\u0440\u0430\u0432\u0441\u0442\u0432\u0435\u043d\u043e \u0438\u0437')) zdravstveno_ee_raw = colN(r)
        // незапосленост из бруто
        if (c2.includes('\u043d\u0435\u0437\u0430\u043f\u043e\u0441\u043b\u0435\u043d\u043e\u0441\u0442 \u0438\u0437')) nezaposlenost_ee_raw = colN(r)

        // доприноси на терет послодавца section
        if (a.includes('\u0434\u043e\u043f\u0440\u0438\u043d\u043e\u0441\u0438 \u043d\u0430 \u0442\u0435\u0440\u0435\u0442 \u043f\u043e\u0441\u043b\u043e\u0434\u0430\u0432\u0446\u0430') && !inErContrib) inErContrib = true
        if (inErContrib) {
          if (c2.includes('\u041f\u0418\u041e \u043d\u0430 \u0431\u0440\u0443\u0442\u043e')) pio_er_raw = colN(r)
          if (c2.includes('\u0437\u0434\u0440\u0430\u0432\u0441\u0442\u0432\u0435\u043d\u043e \u043d\u0430')) zdravstveno_er_raw = colN(r)
          if (c2.includes('\u043d\u0435\u0437\u0430\u043f\u043e\u0441\u043b\u0435\u043d\u043e\u0441\u0442 \u043d\u0430')) nezaposlenost_er_raw = colN(r)
        }

        j++
      }

      const tax = taxMode === 'incentive' ? Math.round(tax_on_salary_raw * 0.3 * 100) / 100 : tax_on_salary_raw
      const pio_ee = taxMode === 'incentive' ? 0 : pio_ee_raw
      const pio_er = taxMode === 'incentive' ? 0 : pio_er_raw
      const contrib_ee = Math.round((tax + pio_ee + zdravstveno_ee_raw + nezaposlenost_ee_raw) * 100) / 100
      const contrib_er = Math.round((pio_er + zdravstveno_er_raw + nezaposlenost_er_raw) * 100) / 100
      const thirdTotal = deductions.filter(d => d.type === 'third_party').reduce((s, d) => s + d.amount, 0)
      const gross = Math.round((net_salary_raw + contrib_ee + contrib_er + thirdTotal) * 100) / 100

      employees.push({
        id: `emp_${empCtr}`, employee_name: employeeName, partner_id: '',
        net_salary_raw, tax_on_salary_raw,
        pio_employee_raw: pio_ee_raw, zdravstveno_ee_raw, nezaposlenost_ee_raw,
        pio_employer_raw: pio_er_raw, zdravstveno_er_raw, nezaposlenost_er_raw,
        net_salary: net_salary_raw, tax_on_salary: tax,
        contrib_employee: contrib_ee, contrib_employer: contrib_er,
        deductions, gross_salary: gross,
        department_id: '', department_name: '',
        dept_subcategory_id: '', dept_subcategory_name: '',
        project_id: null, cf_type: 'recurring',
        expanded: true, accepted: true,
        edit_net: String(net_salary_raw),
        edit_tax: String(tax),
        edit_contrib_ee: String(contrib_ee),
        edit_contrib_er: String(contrib_er),
      })
      i = j; continue
    }
    i++
  }
  return { header, employees }
}


function fmtN(v: number): string {
  return fmtNum(v || 0)
}

function parseSerDate(d: string): string {
  if (!d) return new Date().toISOString().split('T')[0]
  const m = d.replace(/\.$/, '').match(/(\d{1,2})\.(\d{1,2})\.(\d{4})/)
  if (m) return `${m[3]}-${m[2].padStart(2, '0')}-${m[1].padStart(2, '0')}`
  return d
}

function lastWorkDay(isoDate: string): string {
  if (!isoDate) return ''
  const d = new Date(isoDate)
  const last = new Date(d.getFullYear(), d.getMonth() + 1, 0)
  while (last.getDay() === 0 || last.getDay() === 6) last.setDate(last.getDate() - 1)
  return last.toISOString().split('T')[0]
}

export default function PayrollImportDialog({ onClose, onPosted }: Props) {
  const [step, setStep] = useState<'upload' | 'review' | 'posting'>('upload')
  const [taxMode, setTaxMode] = useState<TaxMode>('standard')
  const [header, setHeader] = useState<PayrollHeader | null>(null)
  const [employees, setEmployees] = useState<ParsedEmployee[]>([])
  const [parseError, setParseError] = useState('')
  const [fileName, setFileName] = useState('')
  const [progress, setProgress] = useState(0)
  // A PPP-PD filing is in dinars, and so is the payroll posted from it, at an
  // exchange_rate of 1. The one rate it needs is the EUR one, for the euro
  // figure every row carries beside its dinars.
  const currency = BOOK_CURRENCY
  const [eurRate, setEurRate] = useState('')
  const [fetchingRate, setFetchingRate] = useState(false)
  const [rateWarning, setRateWarning] = useState('')
  const { companies, defaultCompany, showPicker } = useCompanies()
  /** Where each part posts — the owner's headings, see services/systemCategories. */
  const systemCategories = useSystemCategories()
  const [companyId, setCompanyId] = useState('')
  // Preselected: the payroll is the default company's unless somebody picks another.
  React.useEffect(() => {
    if (defaultCompany) setCompanyId(prev => prev || defaultCompany.id)
  }, [defaultCompany])
  const [dueDate, setDueDate] = useState('')
  const [taxFilingRef, setTaxFilingRef] = useState('')
  const [taxRounding, setTaxRounding] = useState('0')
  const [partners, setPartners] = useState<any[]>([])
  const [departments, setDepartments] = useState<any[]>([])
  const [deptSubs, setDeptSubs] = useState<any[]>([])
  const [taxPartnerId, setTaxPartnerId] = useState('')
  const [taxPartnerSearch, setTaxPartnerSearch] = useState('')
  const [taxDropdown, setTaxDropdown] = useState(false)
  const [rawWorkbook, setRawWorkbook] = useState<XLSX.WorkBook | null>(null)
  const [importHistory, setImportHistory] = useState<any[]>([])
  const [historyExpanded, setHistoryExpanded] = useState(false)
  const fileRef = useRef<HTMLInputElement>(null)

  React.useEffect(() => {
    const load = async () => {
      const [part, { data: dept }, { data: ds }] = await Promise.all([
        fetchAllPartners(supabase, 'id,name,is_individual'),
        supabase.from('departments').select('id,name,sort_order').order('sort_order'),
        supabase.from('dept_subcategories').select('id,name,department_id').order('sort_order'),
      ])
      if (part) {
        setPartners(part)
        const pu = part.find((p: any) => p.name.toLowerCase().includes('poreska') || p.name.toLowerCase().includes('objedinjena'))
        if (pu) { setTaxPartnerId(pu.id); setTaxPartnerSearch(pu.name) }
      }
      if (dept) setDepartments(dept)
      if (ds) setDeptSubs(ds)
    }
    load()
  }, [])

  // The payroll imports already made for the chosen company.
  React.useEffect(() => {
    if (!companyId) return
    supabase.from('import_logs')
      .select('*')
      .eq('company_id', companyId)
      .eq('import_type', 'payroll')
      .order('created_at', { ascending: false })
      .limit(50)
      .then(({ data }) => {
        setImportHistory(data || [])
        if (data && data.length > 0) setHistoryExpanded(true)
      })
  }, [companyId])

  const doParseFile = useCallback(async (wb: XLSX.WorkBook, mode: TaxMode) => {
    try {
      const { header: h, employees: emps } = parsePayrollXlsx(wb, mode)
      if (emps.length === 0) { setParseError('U fajlu nije pronađen nijedan zaposleni. Proverite da li je izvoz iz MPP-a.'); return }
      const part = await fetchAllPartners(supabase, 'id,name,is_individual')
      const partList = part || []
      setPartners(partList)
      const matched = emps.map(emp => {
        const nameParts = emp.employee_name.toLowerCase().split(/\s+/).filter((p: string) => p.length > 2)
        // Try exact match first (any word order)
        let found = partList.find((p: any) => {
          const pLower = p.name.toLowerCase()
          return nameParts.every((part: string) => pLower.includes(part))
        })
        // Fallback: match by longest word (usually surname)
        if (!found) {
          const longest = nameParts.reduce((a: string, b: string) => a.length >= b.length ? a : b, '')
          if (longest.length > 4) found = partList.find((p: any) => p.name.toLowerCase().includes(longest))
        }
        return { ...emp, partner_id: found?.id || '', employee_name: found ? found.name : emp.employee_name }
      })
      setHeader(h); setEmployees(matched); setTaxFilingRef(h.tax_filing_ref)
      if (h.invoice_date) setDueDate(lastWorkDay(parseSerDate(h.invoice_date)))
      setStep('review')
    } catch (err: any) { setParseError(`Fajl nije moguće obraditi: ${err.message}`) }
  }, [])

  const handleFile = async (file: File) => {
    setParseError(''); setFileName(file.name)
    try {
      const buf = await file.arrayBuffer()
      const wb = XLSX.read(buf, { type: 'array' })
      setRawWorkbook(wb)
      await doParseFile(wb, taxMode)
    } catch (err: any) { setParseError(`Fajl nije moguće pročitati: ${err.message}`) }
  }

  const handleTaxModeChange = async (mode: TaxMode) => {
    setTaxMode(mode)
    if (rawWorkbook) { empCtr = 0; dedCtr = 0; await doParseFile(rawWorkbook, mode) }
  }

  const updateEmployee = useCallback((id: string, updates: Partial<ParsedEmployee>) => {
    setEmployees(prev => prev.map(e => {
      if (e.id !== id) return e
      const u = { ...e, ...updates }
      const net = parseFloat(u.edit_net) || 0
      const ee = parseFloat(u.edit_contrib_ee) || 0
      const er = parseFloat(u.edit_contrib_er) || 0
      const third = u.deductions.filter(d => d.type === 'third_party').reduce((s, d) => s + d.amount, 0)
      u.net_salary = net; u.contrib_employee = ee; u.contrib_employer = er
      u.gross_salary = Math.round((net + ee + er + third) * 100) / 100
      return u
    }))
  }, [])

  const updateDeduction = (empId: string, dedId: string, updates: Partial<ParsedDeduction>) => {
    setEmployees(prev => prev.map(e => e.id === empId
      ? { ...e, deductions: e.deductions.map(d => d.id === dedId ? { ...d, ...updates } : d) }
      : e))
  }

  // NBS RSD/EUR on the payment date. With no official rate the field stays
  // empty and posting is blocked: a guessed rate would give wrong EUR figures
  // that look exactly like right ones.
  const fetchRate = async () => {
    setFetchingRate(true)
    try {
      const iso = header ? parseSerDate(header.payment_date) : new Date().toISOString().split('T')[0]
      const r = await getBookRates(iso)
      setEurRate(String(r.eurRate)); setRateWarning('')
    } catch (err: any) {
      setEurRate('')
      setRateWarning(`⚠ ${err?.message || 'Nema zvaničnog kursa'} — unesite kurs ručno`)
    }
    setFetchingRate(false)
  }

  // The filing names its payment date; its rate is fetched as soon as it is read.
  useEffect(() => {
    if (header?.payment_date) fetchRate()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [header?.payment_date])

  const accepted = employees.filter(e => e.accepted)
  const payDate = header ? parseSerDate(header.payment_date) : new Date().toISOString().split('T')[0]
  const invDate = header ? parseSerDate(header.invoice_date) : payDate
  const eurRateNum = parseFloat(eurRate)
  const hasEurRate = eurRateNum > 0
  /** The stored book columns for an RSD figure. Throws without a EUR rate. */
  const book = (amt: number): BookAmounts => bookAmountsAtRate(amt, currency, 1, eurRateNum)

  const totalNet = accepted.reduce((s, e) => s + e.net_salary, 0)
  const totalEE = accepted.reduce((s, e) => s + e.contrib_employee, 0)
  const totalER = accepted.reduce((s, e) => s + e.contrib_employer, 0)
  const totalThird = accepted.reduce((s, e) => s + e.deductions.filter(d => d.type === 'third_party').reduce((ss, d) => ss + d.amount, 0), 0)
  const totalRetained = accepted.reduce((s, e) => s + e.deductions.filter(d => d.type !== 'third_party').reduce((ss, d) => ss + d.amount, 0), 0)
  const totalGross = accepted.reduce((s, e) => s + e.gross_salary, 0)
  const totalTaxObl = totalEE + totalER + (parseFloat(taxRounding) || 0)

  const handlePost = async () => {
    if (!companyId) { alert('Izaberite firmu.'); return }
    if (!hasEurRate) { alert('Prvo unesite kurs NBS za EUR na datum isplate — svaka stavka nosi i iznos u EUR.'); return }

    const noDept = employeesMissingDepartment(employees.filter(e => e.accepted))
    if (noDept.length > 0) {
      alert(
        `Zaposleni bez sektora (${noDept.length}):

` +
        `${noDept.join(', ')}

` +
        `Njihova zarada i deo poreske prijave završili bi u „Nedodeljeno“. ` +
        `Izaberite sektor za svakog pre knjiženja.`)
      return
    }

    // Every heading this import will write, resolved BEFORE the first write.
    // An unset system category refuses the whole import here, with nothing in
    // the ledger, rather than partway through it.
    const retainedTypes = new Set(accepted.flatMap(e => e.deductions.map(d => d.type)))
    let heads: {
      net: { pl_category: string; pl_subcategory: string }
      obligations: ReturnType<typeof obligationClassesFrom>
      fitpass: ReturnType<typeof classificationFor> | null
      penalty: ReturnType<typeof classificationFor> | null
    }
    try {
      heads = {
        net: plPartFor('payroll_net_salary', systemCategories.map),
        obligations: obligationClassesFrom(systemCategories.map),
        fitpass: retainedTypes.has('fitpass') ? classificationFor('payroll_fitpass', systemCategories.map) : null,
        penalty: retainedTypes.has('penalty') ? classificationFor('payroll_penalty', systemCategories.map) : null,
      }
    } catch (e: any) {
      alert(`${e?.message || String(e)} Ništa nije proknjiženo.`)
      return
    }

    // Guard: provjeri da li već postoji import za ovaj period
    const periodMonth = invDate.slice(0, 7)
    const { data: existingImport } = await supabase
      .from('import_logs')
      .select('id, created_at, note')
      .eq('company_id', companyId)
      .eq('import_type', 'payroll')
      .eq('period_month', periodMonth)
      .limit(1)
    
    if (existingImport && existingImport.length > 0) {
      const existing = existingImport[0]
      const confirm = window.confirm(
        `⚠️ Zarade za ${periodMonth} su već uvezene.\n\n` +
        `Datum: ${srDate(existing.created_at)}\n` +
        `Napomena: ${existing.note || '—'}\n\n` +
        `Ipak nastaviti? Biće napravljen duplikat.`
      )
      if (!confirm) return
    }

    setStep('posting'); setProgress(0)
    const localPartners = [...partners]

    // Declared outside the try so the catch can read it. A refusal partway
    // through has to name what already landed, or the owner retries on top
    // of it and the filing is imported twice.
    const completed: CompletedWrite[] = []

    try {
      const { data: record, error: recErr } = await supabase.from('payroll_records').insert({
        company_id: companyId, period_month: invDate.slice(0, 7),
        payment_date: payDate, due_date: dueDate || null,
        tax_filing_ref: taxFilingRef || null, currency,
        ...book(totalGross),
        note: `${header?.period_label || ''} — ${taxMode === 'incentive' ? 'Sa poreskim olakšicama' : 'Standardno'}`,
        status: 'posted',
      }).select().single()
      if (recErr) throw new PostFailure('zapis obračuna zarada', recErr.message)
      if (!record?.id) throw new PostFailure('zapis obračuna zarada', 'nije vraćen ID')
      completed.push({ label: 'zapis obračuna zarada' })

      let done = 0
      for (const emp of accepted) {
        let partnerId = emp.partner_id || null
        if (!partnerId && emp.employee_name) {
          const ex = localPartners.find(p => p.name.toLowerCase() === emp.employee_name.toLowerCase())
          if (ex) { partnerId = ex.id }
          else {
            const { data: newP, error: partErr } = await supabase.from('partners').insert({ name: emp.employee_name }).select().single()
            if (partErr) throw new PostFailure('novi partner', partErr.message)
            if (newP) { partnerId = newP.id; localPartners.push(newP) }
          }
        }
        {
          const { error: lineErr } = await supabase.from('payroll_lines').insert({
            payroll_id: record.id, partner_id: partnerId,
            employee_name: emp.employee_name,
            department_id: emp.department_id || null, department_name: emp.department_name || null,
            dept_subcategory_id: emp.dept_subcategory_id || null, dept_subcategory_name: emp.dept_subcategory_name || null,
            gross_salary: emp.gross_salary, net_salary: emp.net_salary,
            tax_on_salary: emp.tax_on_salary, contrib_employee: emp.contrib_employee, contrib_employer: emp.contrib_employer,
            deductions_third_party: emp.deductions.filter(d => d.type === 'third_party').map(d => ({ name: d.name, amount: d.amount, partner_id: d.partner_id })),
            deductions_retained: emp.deductions.filter(d => d.type !== 'third_party').map(d => ({ type: d.type, amount: d.amount })),
            cf_type: emp.cf_type,
          })
          if (lineErr) throw new PostFailure('stavke obračuna', lineErr.message)
        }
        if (emp.net_salary > 0) {
          const { error: invErr } = await supabase.from('invoices').insert({
            company_id: companyId, partner_id: partnerId,
            invoice_date: invDate, due_date: dueDate || null,
            type: 'expense', ...heads.net,
            department: emp.department_name || null, dept_subcategory: emp.dept_subcategory_name || null,
            expense_description: emp.employee_name,
            project_id: emp.project_id || null,
            cf_type: emp.cf_type, cf_frequency: 'monthly', cf_next_month_est: emp.net_salary,
            currency, amount: emp.net_salary, ...book(emp.net_salary),
            pl_impact: true, status: 'unpaid',
            note: `Zarade ${invDate.slice(0, 7)} — Neto zarada — ${emp.employee_name}`,
          })
          if (invErr) throw new PostFailure('fakture za zarade i obustave', invErr.message)
        }
        for (const ded of emp.deductions.filter(d => d.type === 'third_party')) {
          let dPartnerId = ded.partner_id || null
          if (!dPartnerId && ded.partner_name) {
            const ex = localPartners.find(p => p.name.toLowerCase() === ded.partner_name.toLowerCase())
            if (ex) dPartnerId = ex.id
          }
          const { error: invErr } = await supabase.from('invoices').insert({
            company_id: companyId, partner_id: dPartnerId,
            invoice_date: invDate, due_date: dueDate || null,
            type: 'expense', ...heads.net,
            department: emp.department_name || null, dept_subcategory: emp.dept_subcategory_name || null,
            expense_description: emp.employee_name,
            project_id: emp.project_id || null,
            cf_type: emp.cf_type, cf_frequency: 'monthly', cf_next_month_est: ded.amount,
            currency, amount: ded.amount, ...book(ded.amount),
            pl_impact: true, status: 'unpaid',
            note: `Zarade ${invDate.slice(0, 7)} — Obustava: ${ded.name} — ${emp.employee_name}`,
          })
          if (invErr) throw new PostFailure('fakture za zarade i obustave', invErr.message)
        }
        for (const ded of emp.deductions.filter(d => d.type !== 'third_party')) {
          const where = ded.type === 'fitpass' ? heads.fitpass : heads.penalty
          if (!where) throw new Error('Zadržana obustava nema sistemsku kategoriju. Dalje ništa nije proknjiženo.')
          const { error: txErr } = await supabase.from('transactions').insert({
            company_id: companyId, partner_id: null,
            transaction_date: payDate, type: 'direct', tx_subtype: 'expense',
            currency, amount: -ded.amount, ...book(-ded.amount),
            pl_impact: true,
            ...where,
            note: `Zarade ${invDate.slice(0, 7)} — Storno: ${ded.name} — ${emp.employee_name}`, status: 'posted',
          })
          if (txErr) throw new PostFailure('stavke zadržanih obustava', txErr.message)
        }
        done++; setProgress(Math.round((done / accepted.length) * 85))
      }
      if (totalTaxObl > 0) {
        // PARENT invoice — the payable the bank payment matches against. One
        // filing is one payment, so this stays a single row, and it carries no
        // P&L (`pl_impact: false`) — the children below do.
        const { data: parentInv, error: parentErr } = await supabase.from('invoices').insert({
          company_id: companyId, partner_id: taxPartnerId || null,
          invoice_date: invDate, due_date: dueDate || null,
          type: 'expense', ...heads.obligations.tax,
          expense_description: `Objedinjena naplata — ${taxFilingRef || invDate.slice(0, 7)} (${taxMode === 'incentive' ? 'poreske olakšice' : 'standardno'})`,
          cf_type: 'recurring', cf_frequency: 'monthly', cf_next_month_est: totalTaxObl,
          currency, amount: totalTaxObl, ...book(totalTaxObl),
          pl_impact: false, status: 'unpaid',
          note: `Zarade ${invDate.slice(0, 7)} — Poreska uprava objedinjena naplata${(parseFloat(taxRounding) || 0) !== 0 ? ' | zaokruživanje: ' + taxRounding : ''}`,
        }).select('id').single()
        // A refused parent used to be ignored, leaving parentId undefined and
        // every child written with parent_invoice_id: null - orphan rows in a
        // filing that looked posted.
        if (parentErr) throw new PostFailure('faktura za porez i doprinose', parentErr.message)
        const parentId = parentInv?.id
        if (!parentId) throw new PostFailure('faktura za porez i doprinose', 'nije vraćen ID')

        // ── P&L children, one per employee per component ──────────────────
        // The parent above is the payable and carries no P&L. These carry the
        // P&L, and each one knows which employee — and therefore which
        // department — it belongs to. Booking them as three aggregates is what
        // put the whole filing under Unassigned.
        const rows = obligationRows(
          accepted.map(e => ({
            employee_name: e.employee_name,
            department_name: e.department_name,
            dept_subcategory_name: e.dept_subcategory_name,
            tax: e.tax_on_salary,
            // In this path contrib_employee includes the tax — take it out, or
            // the tax is counted twice.
            contributionsEmployee: e.contrib_employee - e.tax_on_salary,
            contributionsEmployer: e.contrib_employer,
          })),
          heads.obligations,
          parseFloat(taxRounding) || 0,
        )

        const rowsTotal = obligationTotal(rows)
        if (Math.abs(rowsTotal - totalTaxObl) > 0.02) {
          throw new Error(
            `Raspodela obaveze za zarade se ne slaže: stavke ${rowsTotal.toFixed(2)}, ` +
            `obaveza ${totalTaxObl.toFixed(2)}. Dalje ništa nije proknjiženo.`)
        }

        const monthRef = taxFilingRef || invDate.slice(0, 7)
        for (const r of rows) {
          const emp = accepted.find(e => e.employee_name === r.employee_name)
          const { error: invErr } = await supabase.from('invoices').insert({
            company_id: companyId, partner_id: taxPartnerId || null,
            invoice_date: invDate, due_date: dueDate || null,
            type: 'expense', pl_category: r.pl_category, pl_subcategory: r.pl_subcategory,
            department: r.department, dept_subcategory: r.dept_subcategory,
            expense_description: r.expense_description,
            project_id: emp?.project_id || null,
            cf_type: 'recurring', cf_frequency: 'monthly', cf_next_month_est: r.amount,
            currency, amount: r.amount, ...book(r.amount),
            pl_impact: true, status: 'unpaid', parent_invoice_id: parentId || null,
            note: `Zarade ${invDate.slice(0, 7)} — ${r.pl_subcategory} — ${r.employee_name}`
                + `${r.carriesRounding ? ` | uključuje zaokruživanje prijave ${taxRounding}` : ''}`
                + ` | ${monthRef}`,
          })
          if (invErr) throw new PostFailure('fakture za zarade i obustave', invErr.message)
        }
      }
      // Log this import
      const { error: logErr } = await supabase.from('import_logs').insert({
        company_id: companyId,
        import_type: 'payroll',
        file_name: fileName,
        period_month: invDate.slice(0, 7),
        filing_ref: taxFilingRef || null,
        row_count: accepted.length,
        note: `Zaposleni: ${accepted.length} · ${taxMode === 'incentive' ? 'Poreske olakšice' : 'Standardno'}`,
      })
      if (logErr) throw new PostFailure('zapis o uvozu', logErr.message)
      setProgress(100)
      setTimeout(() => { onPosted(); onClose() }, 800)
    } catch (err: any) {
      // supabase-js does not throw, so until the writes above were bound to
      // their errors this catch was dead code for every database refusal and
      // the import reported success regardless.
      alert(err instanceof PostFailure
        ? reportPostFailure('uvoz zarada', err.step, err.message, completed)
        : `Greška: ${err.message}`)
      setStep('review')
    }
  }

  if (step === 'posting') return (
    <div style={s.overlay}>
      <div style={{ ...s.dialog, alignItems: 'center', justifyContent: 'center', gap: '20px', minHeight: '260px' }}>
        <div style={{ fontSize: '14px', color: '#7A9BB8' }}>Knjiženje zarada… {progress}%</div>
        <div style={{ width: '320px', height: '6px', background: 'rgba(255,255,255,0.08)', borderRadius: '3px', overflow: 'hidden' }}>
          <div style={{ width: `${progress}%`, height: '100%', background: '#00D47E', transition: 'width 0.4s' }} />
        </div>
      </div>
    </div>
  )

  return (
    <div style={s.overlay}>
      <div style={s.dialog}>
        <div style={s.header}>
          <div style={{ display: 'flex', alignItems: 'center', gap: '12px' }}>
            <div style={s.headerIcon}>📊</div>
            <div>
              <div style={s.headerTitle}>Uvoz zarada — Excel</div>
              <div style={s.headerSub}>{step === 'upload' ? 'Otpremite platne listiće (MPP format)' : `Zaposleni: ${employees.length} · prihvaćeno: ${accepted.length}`}</div>
            </div>
          </div>
          <div style={{ display: 'flex', alignItems: 'center', gap: '10px' }}>
            <span style={s.logoBadge}>{brand.appName}</span>
            <button style={s.closeBtn} onClick={onClose} aria-label="Zatvori" title="Zatvori">×</button>
          </div>
        </div>

        <div style={s.body}>
          {step === 'upload' && (
            <div style={s.section}>
              <div style={s.sectionTitle}>Vrsta poreske prijave</div>
              <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '12px', marginBottom: '20px' }}>
                {([
                  { id: 'standard' as TaxMode, icon: '📋', title: 'Standardno', desc: 'Pun porez i doprinosi kako su prijavljeni. Sve vrednosti iz Excela bez izmena.' },
                  { id: 'incentive' as TaxMode, icon: '🎯', title: 'Sa poreskim olakšicama', desc: 'Porez = 30% prijavljenog. Doprinos za PIO zaposlenog i poslodavca = 0.' },
                ] as { id: TaxMode; icon: string; title: string; desc: string }[]).map(m => (
                  <div key={m.id}
                    style={{ border: taxMode === m.id ? `2px solid ${m.id === 'incentive' ? '#F5A623' : '#00D47E'}` : '1px solid rgba(255,255,255,0.1)', borderRadius: '12px', padding: '16px', cursor: 'pointer', background: taxMode === m.id ? (m.id === 'incentive' ? 'rgba(245,166,35,0.08)' : 'rgba(0,212,126,0.08)') : 'rgba(255,255,255,0.02)' }}
                    onClick={() => setTaxMode(m.id)}>
                    <div style={{ fontSize: '14px', fontWeight: '600', color: taxMode === m.id ? (m.id === 'incentive' ? '#F5A623' : '#00D47E') : '#DCE9F6', marginBottom: '6px' }}>{m.icon} {m.title}</div>
                    <div style={{ fontSize: '12px', color: '#7A9BB8', lineHeight: '1.5' }}>{m.desc}</div>
                  </div>
                ))}
              </div>
              <div style={s.sectionTitle}>Otpremite Excel fajl</div>
              <div style={s.dropZone} onDrop={e => { e.preventDefault(); const f = e.dataTransfer.files[0]; if (f) handleFile(f) }} onDragOver={e => e.preventDefault()} onClick={() => fileRef.current?.click()}>
                <input ref={fileRef} type="file" accept=".xlsx,.xls" style={{ display: 'none' }} onChange={e => { if (e.target.files?.[0]) handleFile(e.target.files[0]) }} />
                <div style={{ fontSize: '32px', marginBottom: '12px' }}>📂</div>
                <div style={{ fontSize: '14px', fontWeight: '600', color: '#DCE9F6', marginBottom: '6px' }}>{fileName || 'Prevucite Excel fajl ili kliknite da ga izaberete'}</div>
                <div style={{ fontSize: '12px', color: '#7A9BB8' }}>Obračun zarada — MPP format (.xlsx)</div>
              </div>
              {parseError && <div style={s.errorBox}>⚠️ {parseError}</div>}
              <div style={{ marginTop: '16px' }}>
                <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', cursor: 'pointer', paddingBottom: '6px', borderBottom: '1px solid rgba(255,255,255,0.06)', marginBottom: '10px' }}
                  onClick={() => setHistoryExpanded(prev => !prev)}>
                  <div style={{ fontSize: '10px', fontWeight: '600', color: '#7A9BB8', textTransform: 'uppercase' as const, letterSpacing: '0.1em' }}>
                    🕐 Prethodni uvozi zarada
                    {importHistory.length > 0 && <span style={{ marginLeft: '8px', background: 'rgba(0,212,126,0.15)', color: '#00D47E', padding: '1px 7px', borderRadius: '20px', fontSize: '10px' }}>{importHistory.length}</span>}
                  </div>
                  <span style={{ fontSize: '10px', color: '#7A9BB8' }}>{historyExpanded ? '▲ Sakrij' : '▼ Prikaži'}</span>
                </div>
                {historyExpanded && (
                  importHistory.length === 0 ? (
                    <div style={{ fontSize: '12px', color: '#7A9BB8', padding: '10px 14px', background: 'rgba(255,255,255,0.03)', borderRadius: '8px', border: '1px solid rgba(255,255,255,0.06)' }}>
                      Nema prethodnih uvoza zarada.
                    </div>
                  ) : (
                    <div style={{ display: 'flex', flexDirection: 'column' as const, gap: '6px', maxHeight: '240px', overflowY: 'auto' as const }}>
                      {importHistory.map(log => (
                        <div key={log.id} style={{ display: 'flex', alignItems: 'center', gap: '12px', padding: '10px 14px', background: 'rgba(255,255,255,0.03)', borderRadius: '8px', border: '1px solid rgba(255,255,255,0.06)' }}>
                          <div style={{ flex: 1 }}>
                            <div style={{ fontSize: '13px', fontWeight: '500', color: '#DCE9F6' }}>
                              {log.period_month || log.file_name || 'Nepoznato'}
                              {log.filing_ref && <span style={{ fontSize: '11px', color: '#7A9BB8', marginLeft: '8px' }}>· {log.filing_ref}</span>}
                            </div>
                            <div style={{ fontSize: '11px', color: '#7A9BB8', marginTop: '2px' }}>{log.note}</div>
                          </div>
                          <div style={{ fontSize: '11px', color: '#7A9BB8', whiteSpace: 'nowrap' as const }}>
                            {srDate(log.created_at)}
                          </div>
                          <div style={{ fontSize: '10px', padding: '2px 8px', borderRadius: '20px', background: 'rgba(0,212,126,0.10)', color: '#00D47E' }}>✓ Proknjiženo</div>
                        </div>
                      ))}
                    </div>
                  )
                )}
              </div>
            </div>
          )}

          {step === 'review' && header && (
            <>
              <SystemCategoryNotice what="Zarade" roles={PAYROLL_ROLES}
                map={systemCategories.map} loading={systemCategories.loading} />
              <div style={s.section}>
                <div style={s.sectionTitle}>Podešavanja</div>
                <div style={{ display: 'grid', gridTemplateColumns: showPicker ? '1fr 1fr 1fr 1fr' : '1fr 1fr 1fr', gap: '10px', marginBottom: '12px' }}>
                  {showPicker && (
                    <div style={s.field}>
                      <label style={s.lbl}>Firma</label>
                      <select style={s.select} value={companyId} onChange={e => setCompanyId(e.target.value)}>
                        <option value="">Izaberite…</option>
                        {companies.map(c => <option key={c.id} value={c.id}>{c.name}</option>)}
                      </select>
                    </div>
                  )}
                  <div style={s.field}>
                    <label style={s.lbl}>Datum dospeća fakture</label>
                    <input type="date" style={s.input} value={dueDate} onChange={e => setDueDate(e.target.value)} />
                  </div>
                  <div style={s.field}>
                    <label style={s.lbl}>Oznaka poreske prijave</label>
                    <input style={s.input} value={taxFilingRef} onChange={e => setTaxFilingRef(e.target.value)} placeholder="npr. PPP-PD 2026-01" />
                  </div>
                  <div style={s.field}>
                    <label style={s.lbl}>Kurs EUR (knjiži se u {currency})</label>
                    <div style={{ display: 'flex', gap: '6px' }}>
                      <input type="number" style={{ ...s.input, flex: 1 }} value={eurRate}
                        onChange={e => setEurRate(e.target.value)} placeholder="RSD za 1 EUR" />
                      <button style={s.fetchBtn} onClick={fetchRate} disabled={fetchingRate}>{fetchingRate ? '…' : 'Preuzmi'}</button>
                    </div>
                    {hasEurRate && (
                      <div style={{ fontSize: '10px', color: '#7A9BB8', marginTop: '2px' }}>
                        1 EUR = {fmtNum(eurRateNum, 4)} RSD — svaka stavka nosi iznos u EUR po ovom kursu
                      </div>
                    )}
                    {rateWarning && <div style={{ fontSize: '11px', color: '#FF5B5A', fontWeight: 600, marginTop: '2px' }}>{rateWarning}</div>}
                  </div>
                </div>
                <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '10px' }}>
                  <div style={s.field}>
                    <label style={s.lbl}>Poreska uprava (partner)</label>
                    <div style={{ position: 'relative' }}>
                      <input style={{ ...s.input, border: taxPartnerId ? '1.5px solid #00D47E' : undefined }}
                        value={taxPartnerSearch}
                        onChange={e => { setTaxPartnerSearch(e.target.value); setTaxPartnerId(''); setTaxDropdown(true) }}
                        onFocus={() => setTaxDropdown(true)} onBlur={() => setTimeout(() => setTaxDropdown(false), 150)}
                        placeholder="Poreska uprava…" />
                      {taxPartnerId && <span style={{ position: 'absolute', right: '10px', top: '50%', transform: 'translateY(-50%)', color: '#00D47E', fontSize: '12px' }}>✓</span>}
                      {taxDropdown && taxPartnerSearch && (
                        <div style={s.dropdown}>
                          {partners.filter(p => p.name.toLowerCase().includes(taxPartnerSearch.toLowerCase())).slice(0, 8).map(p => (
                            <div key={p.id} style={s.dropdownItem} onMouseDown={() => { setTaxPartnerId(p.id); setTaxPartnerSearch(p.name); setTaxDropdown(false) }}>{p.name}</div>
                          ))}
                        </div>
                      )}
                    </div>
                  </div>
                  <div style={s.field}>
                    <label style={s.lbl}>Način oporezivanja</label>
                    <div style={{ display: 'flex', gap: '8px' }}>
                      {(['standard', 'incentive'] as TaxMode[]).map(m => (
                        <div key={m} style={{ flex: 1, padding: '8px', border: taxMode === m ? `2px solid ${m === 'incentive' ? '#F5A623' : '#00D47E'}` : '1px solid rgba(255,255,255,0.1)', borderRadius: '8px', cursor: 'pointer', textAlign: 'center' as const, fontSize: '12px', fontWeight: '500', color: taxMode === m ? (m === 'incentive' ? '#F5A623' : '#00D47E') : '#7A9BB8', background: taxMode === m ? (m === 'incentive' ? 'rgba(245,166,35,0.08)' : 'rgba(0,212,126,0.08)') : 'transparent' }}
                          onClick={() => handleTaxModeChange(m)}>
                          {m === 'standard' ? '📋 Standardno' : '🎯 Olakšice'}
                        </div>
                      ))}
                    </div>
                  </div>
                </div>
              </div>

              <div style={s.section}>
                <div style={s.sectionTitle}>Pregled — prihvaćeno {accepted.length} od {employees.length}</div>
                <div style={s.summaryGrid}>
                  {[
                    { label: 'Neto zarade', val: totalNet, color: '#00D47E', tag: 'fakture' },
                    { label: 'Obustave trećim licima', val: totalThird, color: '#4EA8FF', tag: 'fakture' },
                    { label: 'Zadržane obustave (storno)', val: totalRetained, color: '#FF5B5A', tag: 'storno' },
                    { label: 'Porez i doprinosi na teret zaposlenog', val: totalEE, color: '#F5A623', tag: '' },
                    { label: 'Doprinosi na teret poslodavca', val: totalER, color: '#F5A623', tag: '' },
                    { label: 'Ukupno bruto', val: totalGross, color: '#DCE9F6', tag: '' },
                  ].map(row => (
                    <div key={row.label} style={s.summaryRow}>
                      <div style={{ display: 'flex', alignItems: 'center', gap: '8px' }}>
                        <span style={{ fontSize: '12px', color: '#7A9BB8' }}>{row.label}</span>
                        {row.tag && <span style={{ fontSize: '10px', color: row.color, background: `${row.color}18`, padding: '1px 6px', borderRadius: '20px' }}>{row.tag}</span>}
                      </div>
                      <span style={{ fontWeight: '600', color: row.color, fontSize: '13px' }}>
                        {fmtNum(row.val)} {currency}
                      </span>
                    </div>
                  ))}
                  <div style={{ ...s.summaryRow, borderTop: '1px solid rgba(255,255,255,0.08)', background: 'rgba(245,166,35,0.05)' }}>
                    <div style={{ display: 'flex', alignItems: 'center', gap: '10px', flex: 1 }}>
                      <span style={{ fontSize: '12px', color: '#F5A623', fontWeight: '600' }}>Ukupno — Poreska uprava</span>
                      <span style={{ fontSize: '10px', color: '#7A9BB8' }}>± zaokruživanje:</span>
                      <input type="number" style={{ ...s.input, width: '80px', padding: '3px 6px', fontSize: '12px', border: '1px solid rgba(245,166,35,0.4)' }}
                        value={taxRounding} onChange={e => setTaxRounding(e.target.value)} placeholder="0" />
                    </div>
                    <span style={{ fontWeight: '700', color: '#F5A623', fontSize: '14px' }}>
                      {fmtNum(totalTaxObl)} {currency}
                    </span>
                  </div>
                </div>
              </div>

              <div style={s.section}>
                <div style={s.sectionTitle}>
                  <span>Zaposleni</span>
                  <div style={{ display: 'flex', gap: '6px' }}>
                    <button style={s.smallBtn} onClick={() => setEmployees(prev => prev.map(e => ({ ...e, accepted: true })))}>✓ Prihvati sve</button>
                    <button style={{ ...s.smallBtn, color: '#FF5B5A', borderColor: 'rgba(255,91,90,0.3)' }} onClick={() => setEmployees(prev => prev.map(e => ({ ...e, accepted: false })))}>✕ Odbij sve</button>
                  </div>
                </div>

                {employees.map((emp, idx) => {
                  const empDeptSubs = deptSubs.filter(d => d.department_id === emp.department_id)
                  return (
                    <div key={emp.id} style={{ ...s.empCard, opacity: emp.accepted ? 1 : 0.45, borderColor: emp.accepted ? 'rgba(255,255,255,0.08)' : 'rgba(255,91,90,0.3)' }}>
                      <div style={s.empCardHeader} onClick={() => updateEmployee(emp.id, { expanded: !emp.expanded } as any)}>
                        <div style={{ display: 'flex', alignItems: 'center', gap: '10px', flex: 1 }}>
                          <div style={s.empIdx}>{idx + 1}</div>
                          <div>
                            <div style={{ fontSize: '13px', fontWeight: '600', color: '#DCE9F6' }}>{emp.employee_name}</div>
                            <div style={{ fontSize: '11px', marginTop: '2px', color: emp.partner_id ? '#00D47E' : '#F5A623' }}>
                              {emp.partner_id ? '✓ Partner pronađen' : '⚠ Biće napravljen novi partner'}
                            </div>
                          </div>
                        </div>
                        <div style={{ display: 'flex', alignItems: 'center', gap: '12px' }}>
                          <span style={{ fontSize: '12px', fontWeight: '600', color: '#00D47E' }}>{fmtNum(emp.gross_salary, 0)} {currency}</span>
                          <button style={{ ...s.acceptBtn, background: emp.accepted ? 'rgba(255,91,90,0.12)' : 'rgba(0,212,126,0.15)', color: emp.accepted ? '#FF5B5A' : '#00D47E', borderColor: emp.accepted ? 'rgba(255,91,90,0.4)' : 'rgba(0,212,126,0.4)' }}
                            onClick={e2 => { e2.stopPropagation(); updateEmployee(emp.id, { accepted: !emp.accepted } as any) }}>
                            {emp.accepted ? '✕ Odbij' : '✓ Prihvati'}
                          </button>
                          <span style={{ fontSize: '11px', color: '#7A9BB8' }}>{emp.expanded ? '▲' : '▼'}</span>
                        </div>
                      </div>

                      {emp.expanded && (
                        <div style={s.empBody}>
                          <div style={s.grid2}>
                            <div style={s.field}>
                              <label style={s.lbl}>Partner (zaposleni)</label>
                              <div style={{ position: 'relative' }}>
                                <input style={{ ...s.input, border: emp.partner_id ? '1.5px solid #00D47E' : '1px solid rgba(245,166,35,0.5)' }}
                                  value={emp.employee_name}
                                  onChange={e2 => updateEmployee(emp.id, { employee_name: e2.target.value, partner_id: '' } as any)}
                                  placeholder="Pretraga partnera…" />
                                {!emp.partner_id && emp.employee_name.length > 2 && (
                                  <div style={s.dropdown}>
                                    {partners.filter((p: any) => p.is_individual && p.name.toLowerCase().includes(emp.employee_name.toLowerCase().slice(0, 5))).slice(0, 8).map(p => (
                                      <div key={p.id} style={s.dropdownItem}
                                        onMouseDown={e2 => { e2.preventDefault(); updateEmployee(emp.id, { partner_id: p.id, employee_name: p.name } as any) }}>
                                        {p.name}
                                      </div>
                                    ))}
                                  </div>
                                )}
                              </div>
                            </div>
                            <div style={s.field}>
                              <label style={s.lbl}>Sektor</label>
                              <select style={s.select} value={emp.department_id}
                                onChange={e2 => { const d = departments.find(x => x.id === e2.target.value); updateEmployee(emp.id, { department_id: e2.target.value, department_name: d?.name || '', dept_subcategory_id: '', dept_subcategory_name: '' } as any) }}>
                                <option value="">Izaberite…</option>
                                {departments.map(d => <option key={d.id} value={d.id}>{d.name}</option>)}
                              </select>
                            </div>
                          </div>
                          {emp.department_id && (
                            <div style={{ marginBottom: '10px' }}>
                              <div style={s.field}>
                                <label style={s.lbl}>Podsektor</label>
                                <select style={s.select} value={emp.dept_subcategory_id}
                                  onChange={e2 => { const d = deptSubs.find(x => x.id === e2.target.value); updateEmployee(emp.id, { dept_subcategory_id: e2.target.value, dept_subcategory_name: d?.name || '' } as any) }}>
                                  <option value="">Izaberite…</option>
                                  {empDeptSubs.map(d => <option key={d.id} value={d.id}>{d.name}</option>)}
                                </select>
                              </div>
                            </div>
                          )}

                          <div style={s.empSection}>Delovi zarade (mogu da se menjaju)</div>
                          <div style={{ display: 'grid', gridTemplateColumns: 'repeat(4,1fr)', gap: '8px', marginBottom: '10px' }}>
                            {([
                              { label: 'Neto zarada', key: 'edit_net', color: '#00D47E' },
                              { label: `Porez ${taxMode === 'incentive' ? '(30%)' : ''}`, key: 'edit_tax', color: '#F5A623' },
                              { label: `Dopr. zaposlenog${taxMode === 'incentive' ? ' (bez PIO)' : ''}`, key: 'edit_contrib_ee', color: '#F5A623' },
                              { label: `Dopr. poslodavca${taxMode === 'incentive' ? ' (bez PIO)' : ''}`, key: 'edit_contrib_er', color: '#4EA8FF' },
                            ] as { label: string; key: keyof ParsedEmployee; color: string }[]).map(item => (
                              <div key={String(item.key)} style={{ background: 'rgba(255,255,255,0.03)', borderRadius: '8px', padding: '10px 10px 8px' }}>
                                <div style={{ fontSize: '10px', color: '#7A9BB8', marginBottom: '6px', textTransform: 'uppercase' as const, letterSpacing: '0.06em' }}>{item.label}</div>
                                <input
                                  type="text"
                                  style={{ ...s.input, padding: '5px 8px', fontSize: '13px', fontWeight: '600', color: item.color, border: `1px solid ${item.color}30` }}
                                  value={fmtN(parseFloat(String(emp[item.key])) || 0)}
                                  onFocus={e2 => { (e2.target as any).type = 'number'; e2.target.value = String(emp[item.key]) }}
                                  onBlur={e2 => { (e2.target as any).type = 'text'; e2.target.value = fmtN(parseFloat(e2.target.value) || 0) }}
                                  onChange={e2 => updateEmployee(emp.id, { [item.key]: e2.target.value } as any)} />
                              </div>
                            ))}
                          </div>

                          {emp.deductions.length > 0 && (
                            <>
                              <div style={s.empSection}>Obustave</div>
                              {emp.deductions.map(ded => (
                                <div key={ded.id} style={{ display: 'flex', gap: '8px', alignItems: 'center', marginBottom: '6px', flexWrap: 'wrap' as const }}>
                                  <span style={{ fontSize: '11px', padding: '2px 8px', borderRadius: '20px', whiteSpace: 'nowrap' as const, background: ded.type === 'fitpass' ? 'rgba(78,168,255,0.12)' : 'rgba(0,212,126,0.10)', color: ded.type === 'fitpass' ? '#4EA8FF' : '#00D47E' }}>
                                    {ded.type === 'fitpass' ? '🏋️ FitPass' : '→ treće lice'}
                                  </span>
                                  <input style={{ ...s.input, flex: 2, minWidth: '140px', fontSize: '12px', padding: '5px 8px' }}
                                    value={ded.name} onChange={e2 => updateDeduction(emp.id, ded.id, { name: e2.target.value })} />
                                  <input
                                    type="text"
                                    style={{ ...s.input, width: '120px', fontSize: '13px', fontWeight: '600', color: '#00D47E', border: '1px solid rgba(0,212,126,0.25)' }}
                                    value={fmtN(ded.amount)}
                                    onFocus={e2 => { (e2.target as any).type = 'number'; e2.target.value = String(ded.amount) }}
                                    onBlur={e2 => { (e2.target as any).type = 'text'; e2.target.value = fmtN(parseFloat(e2.target.value) || 0) }}
                                    onChange={e2 => updateDeduction(emp.id, ded.id, { amount: parseFloat(e2.target.value) || 0 })} />
                                  {ded.type === 'third_party' && (
                                    <div style={{ position: 'relative', minWidth: '150px' }}>
                                      <input style={{ ...s.input, fontSize: '11px', padding: '5px 8px', border: ded.partner_id ? '1.5px solid #00D47E' : undefined }}
                                        value={ded.partner_name}
                                        onChange={e2 => updateDeduction(emp.id, ded.id, { partner_name: e2.target.value, partner_id: '' })}
                                        placeholder="Partner (primalac)" />
                                      {ded.partner_name && !ded.partner_id && (
                                        <div style={{ ...s.dropdown, zIndex: 400 }}>
                                          {partners.filter(p => p.name.toLowerCase().includes(ded.partner_name.toLowerCase())).slice(0, 5).map(p => (
                                            <div key={p.id} style={s.dropdownItem}
                                              onMouseDown={e2 => { e2.preventDefault(); updateDeduction(emp.id, ded.id, { partner_id: p.id, partner_name: p.name }) }}>
                                              {p.name}
                                            </div>
                                          ))}
                                        </div>
                                      )}
                                    </div>
                                  )}
                                </div>
                              ))}
                            </>
                          )}

                          <div style={s.empSection}>Projekat</div>
                          <ProjectSelect value={emp.project_id}
                            onChange={v => updateEmployee(emp.id, { project_id: v })} />
                        </div>
                      )}
                    </div>
                  )
                })}
              </div>
            </>
          )}
        </div>

        <div style={s.footer}>
          <div style={{ fontSize: '12px', color: '#7A9BB8' }}>
            {step === 'review' && `Zaposleni: ${accepted.length} · Bruto: ${fmtNum(totalGross, 0)} ${currency} · Faktura za porez: ${fmtNum(totalTaxObl, 0)} ${currency}${hasEurRate ? ` (bruto ${fmtEUR(book(totalGross).amount_eur, 0)})` : ''}`}
            {step === 'upload' && `Način: ${taxMode === 'incentive' ? '🎯 Poreske olakšice' : '📋 Standardno'}`}
          </div>
          <div style={{ display: 'flex', gap: '8px' }}>
            <button style={s.btnGhost} onClick={step === 'upload' ? onClose : () => setStep('upload')}>{step === 'upload' ? 'Otkaži' : '← Nazad'}</button>
            {step === 'review' && (
              <button style={{ ...s.btnPrimary, opacity: (!companyId || accepted.length === 0) ? 0.5 : 1 }}
                onClick={handlePost} disabled={!companyId || accepted.length === 0 || !hasEurRate}>
                📊 Proknjiži ({countOf(accepted.length, 'zaposleni', 'zaposlena', 'zaposlenih')})
              </button>
            )}
          </div>
        </div>
      </div>
    </div>
  )
}

const s: Record<string, React.CSSProperties> = {
  overlay: { position: 'fixed', inset: 0, colorScheme: 'dark', background: DIALOG.overlay, backdropFilter: 'blur(4px)', display: 'flex', alignItems: 'center', justifyContent: 'center', zIndex: DIALOG.z },
  dialog: { background: '#0D1B2C', border: '1px solid rgba(255,255,255,0.08)', borderRadius: '16px', width: '960px', maxWidth: '97vw', maxHeight: '93vh', display: 'flex', flexDirection: 'column', overflow: 'hidden' },
  header: { background: '#060E1A', padding: '1rem 1.5rem', display: 'flex', alignItems: 'center', justifyContent: 'space-between', borderBottom: '1px solid rgba(255,255,255,0.07)' },
  headerIcon: { fontSize: '20px', width: '40px', height: '40px', borderRadius: '10px', background: 'rgba(0,212,126,0.12)', display: 'flex', alignItems: 'center', justifyContent: 'center' },
  headerTitle: { color: '#DCE9F6', fontSize: '15px', fontWeight: '600' },
  headerSub: { color: '#7A9BB8', fontSize: '12px', marginTop: '2px' },
  logoBadge: { color: '#00D47E', fontFamily: 'Georgia,serif', fontSize: '13px' },
  closeBtn: { background: 'none', border: 'none', color: 'rgba(255,255,255,0.4)', fontSize: '22px', cursor: 'pointer', lineHeight: 1 },
  body: { padding: '1.5rem', overflowY: 'auto', flex: 1 },
  footer: { padding: '1rem 1.5rem', borderTop: '1px solid rgba(255,255,255,0.07)', display: 'flex', alignItems: 'center', justifyContent: 'space-between', background: '#060E1A' },
  section: { marginBottom: '1.5rem' },
  sectionTitle: { fontSize: '10px', fontWeight: '600', color: '#7A9BB8', textTransform: 'uppercase' as const, letterSpacing: '0.1em', marginBottom: '12px', paddingBottom: '6px', borderBottom: '1px solid rgba(255,255,255,0.06)', display: 'flex', alignItems: 'center', justifyContent: 'space-between' },
  grid2: { display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '12px', marginBottom: '10px' },
  field: { display: 'flex', flexDirection: 'column' as const, gap: '4px' },
  lbl: { fontSize: '10px', fontWeight: '500', color: 'rgba(255,255,255,0.35)', textTransform: 'uppercase' as const, letterSpacing: '0.07em' },
  select: { fontFamily: 'system-ui,sans-serif', fontSize: '13px', padding: '8px 10px', border: '1px solid rgba(255,255,255,0.1)', borderRadius: '8px', background: '#111F30', color: '#DCE9F6', outline: 'none' },
  input: { fontFamily: 'system-ui,sans-serif', fontSize: '13px', padding: '8px 10px', border: '1px solid rgba(255,255,255,0.1)', borderRadius: '8px', background: '#111F30', color: '#DCE9F6', outline: 'none', width: '100%', boxSizing: 'border-box' as const },
  fetchBtn: { fontFamily: 'system-ui,sans-serif', fontSize: '11px', padding: '8px 10px', border: '1px solid rgba(0,212,126,0.3)', borderRadius: '8px', background: 'rgba(0,212,126,0.08)', color: '#00D47E', cursor: 'pointer', whiteSpace: 'nowrap' as const },
  dropZone: { border: '2px dashed rgba(255,255,255,0.12)', borderRadius: '12px', padding: '3rem', textAlign: 'center' as const, cursor: 'pointer', background: 'rgba(255,255,255,0.02)' },
  dropdown: { position: 'absolute' as const, top: '100%', left: 0, right: 0, background: '#111F30', border: '1px solid rgba(255,255,255,0.12)', borderRadius: '8px', zIndex: 300, boxShadow: '0 8px 24px rgba(0,0,0,0.4)', maxHeight: '200px', overflowY: 'auto' as const, marginTop: '2px' },
  dropdownItem: { padding: '8px 12px', fontSize: '13px', color: '#DCE9F6', cursor: 'pointer', borderBottom: '1px solid rgba(255,255,255,0.05)' },
  errorBox: { marginTop: '12px', background: 'rgba(255,91,90,0.1)', border: '1px solid rgba(255,91,90,0.3)', borderRadius: '8px', padding: '10px 14px', color: '#FF5B5A', fontSize: '13px' },
  summaryGrid: { background: 'rgba(255,255,255,0.02)', border: '1px solid rgba(255,255,255,0.07)', borderRadius: '10px', overflow: 'hidden' },
  summaryRow: { display: 'flex', alignItems: 'center', justifyContent: 'space-between', padding: '9px 16px', borderBottom: '1px solid rgba(255,255,255,0.04)' },
  empCard: { border: '1px solid rgba(255,255,255,0.08)', borderRadius: '12px', background: '#0D1B2C', marginBottom: '8px', overflow: 'visible' },
  empCardHeader: { display: 'flex', alignItems: 'center', justifyContent: 'space-between', padding: '12px 16px', cursor: 'pointer', background: '#111F30', borderRadius: '12px 12px 0 0' },
  empIdx: { width: '24px', height: '24px', borderRadius: '50%', background: 'rgba(0,212,126,0.15)', color: '#00D47E', display: 'flex', alignItems: 'center', justifyContent: 'center', fontSize: '11px', fontWeight: '700', flexShrink: 0 },
  empBody: { padding: '14px 16px' },
  empSection: { fontSize: '10px', fontWeight: '600', color: '#7A9BB8', textTransform: 'uppercase' as const, letterSpacing: '0.08em', marginBottom: '8px', marginTop: '12px', paddingBottom: '4px', borderBottom: '1px solid rgba(255,255,255,0.05)' },
  acceptBtn: { fontFamily: 'system-ui,sans-serif', fontSize: '11px', fontWeight: '600', padding: '4px 12px', borderRadius: '20px', border: '1.5px solid', cursor: 'pointer', background: 'transparent' },
  smallBtn: { fontFamily: 'system-ui,sans-serif', fontSize: '11px', padding: '3px 10px', border: '1px solid rgba(0,212,126,0.3)', borderRadius: '6px', background: 'rgba(0,212,126,0.06)', color: '#00D47E', cursor: 'pointer' },
  btnGhost: { fontFamily: 'system-ui,sans-serif', fontSize: '13px', padding: '8px 16px', borderRadius: '8px', border: '1px solid rgba(255,255,255,0.12)', background: 'transparent', color: '#7A9BB8', cursor: 'pointer' },
  btnPrimary: { fontFamily: 'system-ui,sans-serif', fontSize: '13px', padding: '8px 20px', borderRadius: '8px', border: 'none', background: '#00D47E', color: '#060E1A', cursor: 'pointer', fontWeight: '600' },
}