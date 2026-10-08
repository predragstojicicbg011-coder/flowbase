import React, { useState, useEffect, useCallback } from 'react'
import { supabase } from '../supabase'
import { useCompanies } from '../contexts/CompaniesContext'
import { DIALOG } from './dialogTheme'
import SearchableSelect from './SearchableSelect'
import ProjectSelect from './ProjectSelect'
import { obligationRows, obligationTotal, employeesMissingDepartment, obligationClassesFrom } from '../services/payrollAllocation'
import { classificationFor, plPartFor, PAYROLL_ROLES } from '../services/systemCategories'
import { useSystemCategories } from '../contexts/SystemCategoriesContext'
import SystemCategoryNotice from './SystemCategoryNotice'
import { PostFailure, reportPostFailure, type CompletedWrite } from '../services/writeOrder'
import { fetchAllPartners } from '../services/allPartners'
import { BOOK_CURRENCY, bookAmountsAtRate, getBookRates, type BookAmounts } from '../services/bookAmounts'
import { fmtNum, fmtEUR } from '../utils/formatters'
import { countOf, plural } from '../utils/plural'
import { srDate } from '../utils/months'

interface Props {
  onClose: () => void
  onPosted: () => void
}

interface Deduction {
  id: string
  name: string
  amount: string
  partner_id: string
  partner_name: string
}

interface RetainedDeduction {
  id: string
  type: 'penalty' | 'fitpass'
  amount: string
}

interface EmployeeLine {
  id: string
  partner_id: string
  employee_name: string
  department_id: string
  department_name: string
  dept_subcategory_id: string
  dept_subcategory_name: string
  gross_salary: string
  net_salary: string
  tax_on_salary: string
  contrib_employee: string
  contrib_employer: string
  deductions_third_party: Deduction[]
  deductions_retained: RetainedDeduction[]
  /** The project this person's cost goes to; null is overhead. */
  project_id: string | null
  cf_type: string
  cf_frequency: string
  expanded: boolean
  partnerSearch: string
}


let lineCounter = 0
function makeEmployee(): EmployeeLine {
  lineCounter++
  return {
    id: `emp_${lineCounter}`,
    partner_id: '',
    employee_name: '',
    department_id: '',
    department_name: '',
    dept_subcategory_id: '',
    dept_subcategory_name: '',
    gross_salary: '',
    net_salary: '',
    tax_on_salary: '',
    contrib_employee: '',
    contrib_employer: '',
    deductions_third_party: [],
    deductions_retained: [],
    project_id: null,
    cf_type: 'recurring',
    cf_frequency: 'monthly',
    expanded: true,
    partnerSearch: '',
  }
}

let deductionCounter = 0
function makeDeduction(): Deduction {
  deductionCounter++
  return { id: `d_${deductionCounter}`, name: '', amount: '', partner_id: '', partner_name: '' }
}

let retainedCounter = 0
function makeRetained(type: 'penalty' | 'fitpass' = 'fitpass'): RetainedDeduction {
  retainedCounter++
  return { id: `r_${retainedCounter}`, type, amount: '' }
}

export default function PayrollDialog({ onClose, onPosted }: Props) {
  const [step, setStep] = useState(1) // 1=Setup, 2=Employees, 3=Review
  const [posting, setPosting] = useState(false)
  const [posted, setPosted] = useState(false)
  const [error, setError] = useState('')

  // Header fields
  const { companies, defaultCompany, showPicker } = useCompanies()
  /** Where each part posts — the owner's headings, see services/systemCategories. */
  const systemCategories = useSystemCategories()
  const [partners, setPartners] = useState<any[]>([])
  const [departments, setDepartments] = useState<any[]>([])
  const [deptSubcategories, setDeptSubcategories] = useState<any[]>([])

  const [companyId, setCompanyId] = useState('')

  // One company: it is the company, and nobody is asked to choose it.
  useEffect(() => {
    if (!showPicker && defaultCompany) setCompanyId(prev => prev || defaultCompany.id)
  }, [showPicker, defaultCompany])
  const [periodMonth, setPeriodMonth] = useState(new Date().toISOString().slice(0, 7))
  const [paymentDate, setPaymentDate] = useState(new Date().toISOString().split('T')[0])
  const [dueDate, setDueDate] = useState('')
  const [taxFilingRef, setTaxFilingRef] = useState('')
  // Payroll is calculated and posted in dinars, at an exchange_rate of 1.
  // The only rate it needs is the EUR one, for the euro figure every row
  // carries beside its dinars.
  const currency = BOOK_CURRENCY
  const [eurRate, setEurRate] = useState('')
  const [fetchingRate, setFetchingRate] = useState(false)
  const [rateWarning, setRateWarning] = useState('')
  const [note, setNote] = useState('')
  // Partner for tax authority (Poreska uprava) — used on tax/contrib invoice
  const [taxPartnerId, setTaxPartnerId] = useState('')
  const [taxPartnerSearch, setTaxPartnerSearch] = useState('')
  const [taxPartnerDropdown, setTaxPartnerDropdown] = useState(false)

  // Employee lines
  const [employees, setEmployees] = useState<EmployeeLine[]>([makeEmployee()])

  useEffect(() => {
    const load = async () => {
      const [part, { data: dept }, { data: deptSub }] = await Promise.all([
        fetchAllPartners(supabase),
        supabase.from('departments').select('id,name,sort_order').order('sort_order'),
        supabase.from('dept_subcategories').select('id,name,department_id,sort_order').order('sort_order'),
      ])
      if (part) setPartners(part)
      if (dept) setDepartments(dept)
      if (deptSub) setDeptSubcategories(deptSub)
    }
    load()
  }, [])

  // Auto-calculate due date = last working day of period month
  useEffect(() => {
    if (!periodMonth) return
    const [y, m] = periodMonth.split('-').map(Number)
    let d = new Date(y, m, 0) // last day of month
    while (d.getDay() === 0 || d.getDay() === 6) d.setDate(d.getDate() - 1)
    setDueDate(d.toISOString().split('T')[0])
  }, [periodMonth])

  // NBS RSD/EUR on the payment date. With no official rate the field is left
  // empty and posting stays blocked: a guessed rate would give wrong EUR
  // figures that look exactly like right ones.
  const fetchRate = useCallback(async () => {
    if (!paymentDate) return
    setFetchingRate(true)
    try {
      const rates = await getBookRates(paymentDate)
      setEurRate(String(rates.eurRate)); setRateWarning('')
    } catch (err: any) {
      setEurRate('')
      setRateWarning(`⚠ ${err?.message || 'Nema zvaničnog kursa'} — unesite kurs ručno`)
    }
    setFetchingRate(false)
  }, [paymentDate])

  useEffect(() => { fetchRate() }, [fetchRate])

  const getDeptSubs = (deptId: string) => deptSubcategories.filter(s => s.department_id === deptId)

  const updateEmployee = useCallback((id: string, updates: Partial<EmployeeLine>) => {
    setEmployees(prev => prev.map(e => e.id === id ? { ...e, ...updates } : e))
  }, [])

  const addEmployee = () => setEmployees(prev => [...prev, makeEmployee()])
  const removeEmployee = (id: string) => setEmployees(prev => prev.filter(e => e.id !== id))

  const addDeductionThird = (empId: string) => {
    setEmployees(prev => prev.map(e => e.id === empId
      ? { ...e, deductions_third_party: [...e.deductions_third_party, makeDeduction()] }
      : e))
  }
  const removeDeductionThird = (empId: string, dId: string) => {
    setEmployees(prev => prev.map(e => e.id === empId
      ? { ...e, deductions_third_party: e.deductions_third_party.filter(d => d.id !== dId) }
      : e))
  }
  const updateDeductionThird = (empId: string, dId: string, field: keyof Deduction, val: string) => {
    setEmployees(prev => prev.map(e => e.id === empId
      ? { ...e, deductions_third_party: e.deductions_third_party.map(d => d.id === dId ? { ...d, [field]: val } : d) }
      : e))
  }

  const addDeductionRetained = (empId: string) => {
    setEmployees(prev => prev.map(e => e.id === empId
      ? { ...e, deductions_retained: [...e.deductions_retained, makeRetained()] }
      : e))
  }
  const removeDeductionRetained = (empId: string, dId: string) => {
    setEmployees(prev => prev.map(e => e.id === empId
      ? { ...e, deductions_retained: e.deductions_retained.filter(d => d.id !== dId) }
      : e))
  }
  const updateDeductionRetained = (empId: string, dId: string, field: keyof RetainedDeduction, val: string) => {
    setEmployees(prev => prev.map(e => e.id === empId
      ? { ...e, deductions_retained: e.deductions_retained.map(d => d.id === dId ? { ...d, [field]: val } : d) }
      : e))
  }

  // Totals
  const totalNet = employees.reduce((s, e) => s + (parseFloat(e.net_salary) || 0), 0)
  const totalThird = employees.reduce((s, e) => s + e.deductions_third_party.reduce((ss, d) => ss + (parseFloat(d.amount) || 0), 0), 0)
  const totalRetained = employees.reduce((s, e) => s + e.deductions_retained.reduce((ss, d) => ss + (parseFloat(d.amount) || 0), 0), 0)
  const totalTax = employees.reduce((s, e) => s + (parseFloat(e.tax_on_salary) || 0), 0)
  const totalContribEmp = employees.reduce((s, e) => s + (parseFloat(e.contrib_employee) || 0), 0)
  const totalContribEmpr = employees.reduce((s, e) => s + (parseFloat(e.contrib_employer) || 0), 0)
  const totalObligations = totalTax + totalContribEmp + totalContribEmpr
  const totalGross = employees.reduce((s, e) =>
    s +
    (parseFloat(e.net_salary) || 0) +
    (parseFloat(e.tax_on_salary) || 0) +
    (parseFloat(e.contrib_employee) || 0) +
    (parseFloat(e.contrib_employer) || 0) +
    e.deductions_third_party.reduce((ss: number, d: any) => ss + (parseFloat(d.amount) || 0), 0) +
    e.deductions_retained.reduce((ss: number, d: any) => ss + (parseFloat(d.amount) || 0), 0)
  , 0)

  const eurRateNum = parseFloat(eurRate)
  const hasEurRate = eurRateNum > 0
  /** The stored book columns for an RSD figure. Throws without a EUR rate. */
  const book = (amt: number): BookAmounts => bookAmountsAtRate(amt, currency, 1, eurRateNum)

  const handlePost = async () => {
    if (!companyId) { setError('Izaberite firmu.'); return }
    const validEmps = employees.filter(e => e.employee_name && (parseFloat(e.net_salary) > 0 || parseFloat(e.gross_salary) > 0))
    if (validEmps.length === 0) { setError('Dodajte bar jednog zaposlenog sa podacima o zaradi.'); return }
    if (!hasEurRate) { setError('Prvo unesite kurs NBS za EUR na datum isplate — svaka stavka nosi i iznos u EUR.'); return }

    const noDept = employeesMissingDepartment(validEmps)
    if (noDept.length > 0) {
      setError(
        `Nema sektora za: ${noDept.join(', ')}. ` +
        `Njihova zarada i deo poreske prijave završili bi u „Nedodeljeno“. Izaberite sektor.`)
      return
    }

    // Retained deductions, by type, over every line as before.
    const penaltyTotal = employees.reduce((s, e) =>
      s + e.deductions_retained.filter(d => d.type === 'penalty').reduce((ss, d) => ss + (parseFloat(d.amount) || 0), 0), 0)
    const fitpassTotal = employees.reduce((s, e) =>
      s + e.deductions_retained.filter(d => d.type === 'fitpass').reduce((ss, d) => ss + (parseFloat(d.amount) || 0), 0), 0)

    // Every heading this posting will write, resolved BEFORE the first write.
    // An unset system category refuses the whole payroll here, with nothing
    // in the ledger, rather than halfway through it.
    let heads: {
      net: { pl_category: string; pl_subcategory: string }
      obligations: ReturnType<typeof obligationClassesFrom>
      penalty: ReturnType<typeof classificationFor> | null
      fitpass: ReturnType<typeof classificationFor> | null
    }
    try {
      heads = {
        net: plPartFor('payroll_net_salary', systemCategories.map),
        obligations: obligationClassesFrom(systemCategories.map),
        penalty: penaltyTotal > 0 ? classificationFor('payroll_penalty', systemCategories.map) : null,
        fitpass: fitpassTotal > 0 ? classificationFor('payroll_fitpass', systemCategories.map) : null,
      }
    } catch (e: any) {
      setError(`${e?.message || String(e)} Ništa nije proknjiženo.`)
      return
    }
    setPosting(true); setError('')

    // Declared outside the try so the catch can read it. A refusal partway
    // through has to name what already landed, or the owner retries on top
    // of it and the filing is posted twice.
    const completed: CompletedWrite[] = []

    try {
      // 1. Create payroll_record header
      const { data: record, error: recErr } = await supabase.from('payroll_records').insert({
        company_id: companyId,
        period_month: periodMonth,
        payment_date: paymentDate,
        due_date: dueDate || null,
        tax_filing_ref: taxFilingRef || null,
        currency,
        ...book(totalGross),
        note: note || null,
        status: 'posted',
      }).select().single()

      if (recErr) throw new PostFailure('zapis obračuna zarada', recErr.message)
      completed.push({ label: 'zapis obračuna zarada' })

      // 2. Insert payroll_lines
      for (const emp of validEmps) {
        const { error: lineErr } = await supabase.from('payroll_lines').insert({
          payroll_id: record.id,
          partner_id: emp.partner_id || null,
          employee_name: emp.employee_name,
          department_id: emp.department_id || null,
          department_name: emp.department_name || null,
          dept_subcategory_id: emp.dept_subcategory_id || null,
          dept_subcategory_name: emp.dept_subcategory_name || null,
          gross_salary: parseFloat(emp.gross_salary) || 0,
          net_salary: parseFloat(emp.net_salary) || 0,
          tax_on_salary: parseFloat(emp.tax_on_salary) || 0,
          contrib_employee: parseFloat(emp.contrib_employee) || 0,
          contrib_employer: parseFloat(emp.contrib_employer) || 0,
          deductions_third_party: emp.deductions_third_party.map(d => ({ name: d.name, amount: parseFloat(d.amount) || 0 })),
          deductions_retained: emp.deductions_retained.map(d => ({ type: d.type, amount: parseFloat(d.amount) || 0 })),
          cf_type: emp.cf_type,
          cf_frequency: emp.cf_frequency,
        })
        if (lineErr) throw new PostFailure('stavke obračuna', lineErr.message)
      }

      completed.push({ label: plural(validEmps.length, 'stavka obračuna', 'stavke obračuna', 'stavki obračuna'), count: validEmps.length })

      // 3. Create invoices for each employee — Net salary
      for (const emp of validEmps) {
        const netAmt = parseFloat(emp.net_salary) || 0
        if (netAmt <= 0) continue
        const { error: netErr } = await supabase.from('invoices').insert({
          company_id: companyId,
          partner_id: emp.partner_id || null,
          invoice_date: paymentDate,
          due_date: dueDate || null,
          type: 'expense',
          ...heads.net,
          department: emp.department_name || null,
          dept_subcategory: emp.dept_subcategory_name || null,
          expense_description: emp.employee_name,
          project_id: emp.project_id || null,
          cf_type: emp.cf_type || 'recurring',
          cf_frequency: emp.cf_frequency || 'monthly',
          cf_next_month_est: netAmt,
          currency,
          amount: netAmt,
          ...book(netAmt),
          pl_impact: true,
          status: 'unpaid',
          note: `Zarade ${periodMonth} — Neto zarada — ${emp.employee_name}${note ? ' | ' + note : ''}`,
        })
        if (netErr) throw new PostFailure('fakture za neto zarade', netErr.message)
      }

      // 4. Invoices for third-party deductions (per employee per deduction)
      for (const emp of validEmps) {
        for (const ded of emp.deductions_third_party) {
          const dedAmt = parseFloat(ded.amount) || 0
          if (dedAmt <= 0 || !ded.name) continue
          const { error: dedErr } = await supabase.from('invoices').insert({
            company_id: companyId,
            partner_id: ded.partner_id || null,
            invoice_date: paymentDate,
            due_date: dueDate || null,
            type: 'expense',
            ...heads.net,
            department: emp.department_name || null,
            dept_subcategory: emp.dept_subcategory_name || null,
            expense_description: emp.employee_name,
            project_id: emp.project_id || null,
            cf_type: emp.cf_type || 'recurring',
            cf_frequency: emp.cf_frequency || 'monthly',
            cf_next_month_est: dedAmt,
            currency,
            amount: dedAmt,
            ...book(dedAmt),
            pl_impact: true,
            status: 'unpaid',
            note: `Zarade ${periodMonth} — Obustava: ${ded.name} — ${emp.employee_name}${note ? ' | ' + note : ''}`,
          })
          if (dedErr) throw new PostFailure('fakture za obustave', dedErr.message)
        }
      }

      // 5. Retained deductions — storno P&L (direct transaction, no invoice),
      // one per type, totalled above.

      if (penaltyTotal > 0 && heads.penalty) {
        // Negative expense (storno) — posted as direct transaction with negative amount
        const { error: stornoErr } = await supabase.from('transactions').insert({
          company_id: companyId,
            partner_id: null,
          transaction_date: paymentDate,
          type: 'direct',
          tx_subtype: 'expense',
          currency,
          amount: -penaltyTotal, // negative = storno
          ...book(-penaltyTotal),
          pl_impact: true,
          ...heads.penalty,
          note: `Zarade ${periodMonth} — Zadržana obustava (storno): Kazne${note ? ' — ' + note : ''}`,
          status: 'posted',
        })
        if (stornoErr) throw new PostFailure('stavke zadržanih obustava', stornoErr.message)
      }

      if (fitpassTotal > 0 && heads.fitpass) {
        const { error: stornoErr } = await supabase.from('transactions').insert({
          company_id: companyId,
            partner_id: null,
          transaction_date: paymentDate,
          type: 'direct',
          tx_subtype: 'expense',
          currency,
          amount: -fitpassTotal,
          ...book(-fitpassTotal),
          pl_impact: true,
          ...heads.fitpass,
          note: `Zarade ${periodMonth} — Zadržana obustava (storno): FitPass${note ? ' — ' + note : ''}`,
          status: 'posted',
        })
        if (stornoErr) throw new PostFailure('stavke zadržanih obustava', stornoErr.message)
      }

      completed.push({ label: 'fakture za zarade i obustave' })

      // 6. Tax and contributions — one payable, P&L split per employee
      //
      // This used to be a single invoice with department: null, so the whole
      // filing landed under Unassigned even though every employee row above
      // carries a department. Same shape as the payroll import now: the parent
      // is the payable the bank payment matches, the children carry the P&L.
      const totalObl = totalTax + totalContribEmp + totalContribEmpr
      if (totalObl > 0) {
        const { data: parentInv, error: parentErr } = await supabase.from('invoices').insert({
          company_id: companyId,
          partner_id: taxPartnerId || null,
          invoice_date: paymentDate,
          due_date: dueDate || null,
          type: 'expense',
          ...heads.obligations.tax,
          expense_description: `Porez i doprinosi — ${taxFilingRef || periodMonth}`,
          cf_type: 'recurring',
          cf_frequency: 'monthly',
          cf_next_month_est: totalObl,
          currency,
          amount: totalObl,
          ...book(totalObl),
          pl_impact: false,
          status: 'unpaid',
          note: `Zarade ${periodMonth} — Porez ${totalTax.toFixed(0)} + Doprinosi zaposlenog ${totalContribEmp.toFixed(0)} + Doprinosi poslodavca ${totalContribEmpr.toFixed(0)}${note ? ' | ' + note : ''}`,
        }).select('id').single()
        // A failed parent must abort before a single child is written. The
        // children carry `parent_invoice_id`, so without it they are orphans:
        // a filing that looks posted and whose per-employee rows belong to
        // nothing. This used to console.error and carry straight on.
        if (parentErr) throw new PostFailure('faktura za porez i doprinose', parentErr.message)
        const parentId = parentInv?.id
        if (!parentId) throw new PostFailure('faktura za porez i doprinose', 'nije vraćen ID')

        // Here contrib_employee does NOT include the tax — the totals above add
        // the three components — so it is passed through as it stands.
        const rows = obligationRows(validEmps.map(e => ({
          employee_name: e.employee_name,
          department_name: e.department_name,
          dept_subcategory_name: e.dept_subcategory_name,
          tax: parseFloat(e.tax_on_salary) || 0,
          contributionsEmployee: parseFloat(e.contrib_employee) || 0,
          contributionsEmployer: parseFloat(e.contrib_employer) || 0,
        })), heads.obligations)

        const rowsTotal = obligationTotal(rows)
        if (Math.abs(rowsTotal - totalObl) > 0.02) {
          throw new Error(
            `Raspodela obaveze za zarade se ne slaže: stavke ${rowsTotal.toFixed(2)}, ` +
            `obaveza ${totalObl.toFixed(2)}. Dalje ništa nije proknjiženo.`)
        }

        for (const r of rows) {
          const emp = validEmps.find(e => e.employee_name === r.employee_name)
          const { error: childErr } = await supabase.from('invoices').insert({
            company_id: companyId,
            partner_id: taxPartnerId || null,
            invoice_date: paymentDate,
            due_date: dueDate || null,
            type: 'expense',
            pl_category: r.pl_category,
            pl_subcategory: r.pl_subcategory,
            department: r.department,
            dept_subcategory: r.dept_subcategory,
            expense_description: r.expense_description,
            project_id: emp?.project_id || null,
            cf_type: 'recurring',
            cf_frequency: 'monthly',
            cf_next_month_est: r.amount,
            currency,
            amount: r.amount,
            ...book(r.amount),
            pl_impact: true,
            status: 'unpaid',
            parent_invoice_id: parentId || null,
            note: `Zarade ${periodMonth} — ${r.pl_subcategory} — ${r.employee_name}`,
          })
          if (childErr) throw new PostFailure('stavke poreza po zaposlenom', childErr.message)
        }
      }

      setPosted(true)
      setTimeout(() => { onPosted(); onClose() }, 1800)
    } catch (err: any) {
      // supabase-js does not throw, so until the writes above were bound to
      // their errors this catch was dead code for every database refusal and
      // the success screen showed regardless.
      setError(err instanceof PostFailure
        ? reportPostFailure('zarade', err.step, err.message, completed)
        : `Greška: ${err.message}`)
    }
    setPosting(false)
  }

  if (posted) return (
    <div style={s.overlay}>
      <div style={{ ...s.dialog, alignItems: 'center', justifyContent: 'center', gap: '16px', minHeight: '260px' }}>
        <div style={{ width: '56px', height: '56px', borderRadius: '50%', background: 'rgba(0,212,126,0.15)', display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
          <svg width="28" height="28" viewBox="0 0 24 24" fill="none" stroke="#00D47E" strokeWidth="2.5"><path d="M5 13l4 4L19 7" /></svg>
        </div>
        <div style={{ fontSize: '20px', fontWeight: '600', color: '#DCE9F6' }}>Zarade su proknjižene!</div>
        <div style={{ fontSize: '13px', color: '#7A9BB8', textAlign: 'center' }}>
          Zaposleni: {employees.filter(e => e.employee_name).length} · Fakture su napravljene za uparivanje sa plaćanjima.
        </div>
      </div>
    </div>
  )

  const stepTitles = ['Podešavanje obračuna', 'Zaposleni i delovi zarade', 'Pregled i knjiženje']

  return (
    <div style={s.overlay}>
      <div style={s.dialog}>
        {/* Header */}
        <div style={s.header}>
          <div style={{ display: 'flex', alignItems: 'center', gap: '12px' }}>
            <div style={s.headerIcon}>💼</div>
            <div>
              <div style={s.headerTitle}>Knjiženje zarada</div>
              <div style={s.headerSub}>Korak {step} od 3 — {stepTitles[step - 1]}</div>
            </div>
          </div>
          <div style={{ display: 'flex', alignItems: 'center', gap: '12px' }}>
            <span style={s.logoBadge}>MCFlow</span>
            <button style={s.closeBtn} onClick={onClose} aria-label="Zatvori" title="Zatvori">×</button>
          </div>
        </div>

        {/* Steps bar */}
        <div style={s.stepsBar}>
          {stepTitles.map((t, i) => (
            <React.Fragment key={i}>
              <div style={s.stepItem} onClick={() => step > i + 1 && setStep(i + 1)}>
                <div style={{ ...s.stepNum, ...(step === i + 1 ? s.stepActive : {}), ...(step > i + 1 ? s.stepDone : {}) }}>
                  {step > i + 1 ? '✓' : i + 1}
                </div>
                <span style={{ ...s.stepLabel, ...(step === i + 1 ? { color: '#00D47E', fontWeight: '500' } : {}) }}>{t}</span>
              </div>
              {i < 2 && <div style={s.stepDiv} />}
            </React.Fragment>
          ))}
        </div>

        {/* Body */}
        <div style={s.body}>

          {/* ── STEP 1: Setup ── */}
          {step === 1 && (
            <>
              {showPicker && (
                <div style={s.section}>
                  <div style={s.sectionTitle}>Firma</div>
                  <div style={{ maxWidth: '360px' }}>
                    <div style={s.field}>
                      <label style={s.lbl}>Firma <span style={s.req}>*</span></label>
                      <select style={s.select} value={companyId} onChange={e => setCompanyId(e.target.value)}>
                        <option value="">Izaberite firmu…</option>
                        {companies.map(c => <option key={c.id} value={c.id}>{c.name}</option>)}
                      </select>
                    </div>
                  </div>
                </div>
              )}

              <div style={s.section}>
                <div style={s.sectionTitle}>Podaci o prijavi</div>
                <div style={s.grid3}>
                  <div style={s.field}>
                    <label style={s.lbl}>Mesec obračuna <span style={s.req}>*</span></label>
                    <input type="month" style={s.input} value={periodMonth} onChange={e => setPeriodMonth(e.target.value)} />
                  </div>
                  <div style={s.field}>
                    <label style={s.lbl}>Datum isplate <span style={s.req}>*</span></label>
                    <input type="date" style={s.input} value={paymentDate} onChange={e => setPaymentDate(e.target.value)} />
                  </div>
                  <div style={s.field}>
                    <label style={s.lbl}>Datum dospeća fakture</label>
                    <input type="date" style={s.input} value={dueDate} onChange={e => setDueDate(e.target.value)} />
                    <div style={{ fontSize: '10px', color: '#7A9BB8', marginTop: '3px' }}>Automatski: poslednji radni dan u mesecu</div>
                  </div>
                </div>
                <div style={s.grid2}>
                  <div style={s.field}>
                    <label style={s.lbl}>Oznaka poreske prijave</label>
                    <input style={s.input} value={taxFilingRef} onChange={e => setTaxFilingRef(e.target.value)} placeholder="npr. PPP-PD 2026-01 #1" />
                  </div>
                  <div style={s.field}>
                    <label style={s.lbl}>Napomena</label>
                    <input style={s.input} value={note} onChange={e => setNote(e.target.value)} placeholder="Napomena (opciono)…" />
                  </div>
                </div>
              </div>

              <div style={s.section}>
                <div style={s.sectionTitle}>Partneri na fakturama</div>
                <div style={s.grid2}>
                  <div style={s.field}>
                    <label style={s.lbl}>Poreska uprava (partner na fakturi za porez i doprinose)</label>
                    <div style={{ position: 'relative' as const }}>
                      <input style={{ ...s.input, border: taxPartnerId ? '1.5px solid #00D47E' : undefined }}
                        value={taxPartnerSearch}
                        onChange={e => { setTaxPartnerSearch(e.target.value); setTaxPartnerId(''); setTaxPartnerDropdown(true) }}
                        onFocus={() => setTaxPartnerDropdown(true)}
                        onBlur={() => setTimeout(() => setTaxPartnerDropdown(false), 150)}
                        placeholder="npr. Poreska uprava…" />
                      {taxPartnerId && <span style={{ position: 'absolute' as const, right: '10px', top: '50%', transform: 'translateY(-50%)', color: '#00D47E', fontSize: '12px' }}>✓</span>}
                      {taxPartnerDropdown && taxPartnerSearch && (
                        <div style={s.empDropdown}>
                          {partners.filter(p => p.name.toLowerCase().includes(taxPartnerSearch.toLowerCase())).slice(0, 8).map(p => (
                            <div key={p.id} style={s.empDropdownItem}
                              onMouseDown={() => { setTaxPartnerId(p.id); setTaxPartnerSearch(p.name); setTaxPartnerDropdown(false) }}>
                              {p.name}
                            </div>
                          ))}
                          {partners.filter(p => p.name.toLowerCase().includes(taxPartnerSearch.toLowerCase())).length === 0 && (
                            <div style={{ ...s.empDropdownItem, color: '#7A9BB8' }}>Nema poklapanja — knjiži se bez partnera</div>
                          )}
                        </div>
                      )}
                    </div>
                    <div style={{ fontSize: '10px', color: '#7A9BB8', marginTop: '3px' }}>Koristi se na zbirnoj fakturi za porez i doprinose (Poreska uprava objedinjena naplata)</div>
                  </div>
                  <div style={s.field}>
                    <label style={s.lbl}>Kako se biraju partneri</label>
                    <div style={{ fontSize: '12px', color: '#7A9BB8', lineHeight: '1.6', paddingTop: '4px' }}>
                      Fakture za neto zarade → svaki zaposleni (partner) pojedinačno.<br/>
                      Obustave trećim licima → bira se na svakoj obustavi (korak 2).<br/>
                      Porez i doprinosi → jedna faktura Poreskoj upravi izabranoj iznad.
                    </div>
                  </div>
                </div>
              </div>

              <div style={s.section}>
                <div style={s.sectionTitle}>Valuta</div>
                <div style={s.grid2}>
                  <div style={s.field}>
                    <label style={s.lbl}>Valuta</label>
                    <div style={{ ...s.input, cursor: 'default' }}>{currency}</div>
                    <div style={{ fontSize: '10px', color: '#7A9BB8', marginTop: '3px' }}>Zarade se knjiže u dinarima</div>
                  </div>
                  {(
                    <div style={s.field}>
                      <label style={s.lbl}>Kurs EUR (RSD za 1 EUR, NBS na datum isplate)</label>
                      <div style={{ display: 'flex', gap: '6px' }}>
                        <input type="number" style={{ ...s.input, flex: 1 }} value={eurRate}
                          onChange={e => setEurRate(e.target.value)} placeholder="Kliknite „Preuzmi“" />
                        <button style={s.fetchBtn} onClick={fetchRate} disabled={fetchingRate}>
                          {fetchingRate ? '…' : 'Preuzmi kurs NBS'}
                        </button>
                      </div>
                      {rateWarning && <div style={{ fontSize: '11px', color: '#FF5B5A', fontWeight: 600, marginTop: '4px' }}>{rateWarning}</div>}
                    </div>
                  )}
                </div>

                {/* Summary preview */}
                <div style={s.summaryBar}>
                  <div style={s.summaryItem}>
                    <span style={s.summaryLabel}>Zaposleni</span>
                    <span style={s.summaryVal}>{employees.length}</span>
                  </div>
                  <div style={s.summaryDivider} />
                  <div style={s.summaryItem}>
                    <span style={s.summaryLabel}>Period</span>
                    <span style={s.summaryVal}>{periodMonth || '—'}</span>
                  </div>
                  <div style={s.summaryDivider} />
                  <div style={s.summaryItem}>
                    <span style={s.summaryLabel}>Datum dospeća</span>
                    <span style={s.summaryVal}>{dueDate ? srDate(dueDate) : '—'}</span>
                  </div>
                  <div style={s.summaryDivider} />
                  <div style={s.summaryItem}>
                    <span style={s.summaryLabel}>Oznaka prijave</span>
                    <span style={s.summaryVal}>{taxFilingRef || '—'}</span>
                  </div>
                </div>
              </div>
            </>
          )}

          {/* ── STEP 2: Employees ── */}
          {step === 2 && (
            <div style={s.section}>
              <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: '14px' }}>
                <div style={s.sectionTitle}>Delovi zarade po zaposlenom</div>
                <button style={s.addEmpBtn} onClick={addEmployee}>+ Dodaj zaposlenog</button>
              </div>

              {employees.map((emp, idx) => {
                const deptSubs = getDeptSubs(emp.department_id)
                const totalEmp = (parseFloat(emp.net_salary) || 0)
                  + emp.deductions_third_party.reduce((s, d) => s + (parseFloat(d.amount) || 0), 0)
                  + emp.deductions_retained.reduce((s, d) => s + (parseFloat(d.amount) || 0), 0)
                  + (parseFloat(emp.tax_on_salary) || 0)
                  + (parseFloat(emp.contrib_employee) || 0)
                  + (parseFloat(emp.contrib_employer) || 0)

                return (
                  <div key={emp.id} style={s.empCard}>
                    {/* Employee header */}
                    <div style={s.empCardHeader} onClick={() => updateEmployee(emp.id, { expanded: !emp.expanded })}>
                      <div style={{ display: 'flex', alignItems: 'center', gap: '10px', flex: 1 }}>
                        <div style={s.empIndex}>{idx + 1}</div>
                        <div>
                          <div style={{ fontSize: '13px', fontWeight: '600', color: '#DCE9F6' }}>
                            {emp.employee_name || <span style={{ color: 'rgba(255,255,255,0.3)', fontWeight: '400' }}>Zaposleni bez imena</span>}
                          </div>
                          {emp.department_name && <div style={{ fontSize: '11px', color: '#7A9BB8', marginTop: '2px' }}>{emp.department_name}{emp.dept_subcategory_name ? ` / ${emp.dept_subcategory_name}` : ''}</div>}
                        </div>
                      </div>
                      <div style={{ display: 'flex', alignItems: 'center', gap: '12px' }}>
                        {totalEmp > 0 && <span style={{ fontSize: '13px', fontWeight: '600', color: '#00D47E' }}>{fmtNum(totalEmp)} {currency}</span>}
                        <span style={{ fontSize: '11px', color: '#7A9BB8' }}>{emp.expanded ? '▲' : '▼'}</span>
                        <button style={s.removeEmpBtn} aria-label="Ukloni zaposlenog" title="Ukloni zaposlenog" onClick={e => { e.stopPropagation(); removeEmployee(emp.id) }}>×</button>
                      </div>
                    </div>

                    {emp.expanded && (
                      <div style={s.empCardBody}>
                        {/* Employee info */}
                        <div style={s.empSection}>Podaci o zaposlenom</div>
                        <div style={s.grid2}>
                          {/* Partner search */}
                          <div style={s.field}>
                            <label style={s.lbl}>Zaposleni (partner) <span style={s.req}>*</span></label>
                            <div style={{ position: 'relative' }}>
                              <input style={{ ...s.input, border: emp.partner_id ? '1.5px solid #00D47E' : undefined }}
                                value={emp.partnerSearch !== undefined ? emp.partnerSearch : emp.employee_name}
                                onChange={e => {
                                  updateEmployee(emp.id, { partnerSearch: e.target.value, employee_name: e.target.value, partner_id: '' })
                                }}
                                placeholder="Pretraga partnera…" />
                              {emp.partnerSearch && !emp.partner_id && (
                                <div style={s.empDropdown}>
                                  {partners.filter(p => p.name.toLowerCase().includes(emp.partnerSearch.toLowerCase())).slice(0, 8).map(p => (
                                    <div key={p.id} style={s.empDropdownItem}
                                      onMouseDown={e => { e.preventDefault(); updateEmployee(emp.id, { partner_id: p.id, employee_name: p.name, partnerSearch: p.name }) }}>
                                      {p.name}
                                    </div>
                                  ))}
                                  {partners.filter(p => p.name.toLowerCase().includes(emp.partnerSearch.toLowerCase())).length === 0 && (
                                    <div style={{ ...s.empDropdownItem, color: '#7A9BB8', fontStyle: 'italic' }}>
                                      Koristiće se kao slobodan tekst
                                    </div>
                                  )}
                                </div>
                              )}
                            </div>
                          </div>

                          {/* Department */}
                          <div style={s.field}>
                            <label style={s.lbl}>Sektor <span style={s.req}>*</span></label>
                            <SearchableSelect value={emp.department_id}
                              onChange={v => { const d = departments.find(x => x.id === v); updateEmployee(emp.id, { department_id: v, department_name: d?.name || '', dept_subcategory_id: '', dept_subcategory_name: '' }) }}
                              options={departments.map(d => ({ value: d.id, label: d.name }))}
                              allLabel="Izaberite sektor…" searchPlaceholder="Pretraga sektora…"
                              style={pickerChrome} />
                          </div>
                        </div>

                        <div style={s.grid2}>
                          <div style={s.field}>
                            <label style={s.lbl}>Podsektor</label>
                            <select style={s.select} value={emp.dept_subcategory_id}
                              onChange={e => { const sub = deptSubcategories.find(x => x.id === e.target.value); updateEmployee(emp.id, { dept_subcategory_id: e.target.value, dept_subcategory_name: sub?.name || '' }) }}
                              disabled={!emp.department_id || deptSubs.length === 0}>
                              <option value="">Izaberite podsektor…</option>
                              {deptSubs.map(sub => <option key={sub.id} value={sub.id}>{sub.name}</option>)}
                            </select>
                          </div>
                          <div style={s.field}>
                            <label style={s.lbl}>Bruto zarada ({currency}) — automatski</label>
                            <div style={{ ...s.input, background: 'rgba(0,212,126,0.06)', border: '1px solid rgba(0,212,126,0.25)', color: '#00D47E', fontWeight: '600', cursor: 'default' }}>
                              {(
                                (parseFloat(emp.net_salary) || 0) +
                                (parseFloat(emp.tax_on_salary) || 0) +
                                (parseFloat(emp.contrib_employee) || 0) +
                                (parseFloat(emp.contrib_employer) || 0) +
                                emp.deductions_third_party.reduce((s: number, d: any) => s + (parseFloat(d.amount) || 0), 0) +
                                emp.deductions_retained.reduce((s: number, d: any) => s + (parseFloat(d.amount) || 0), 0)
                              ).toLocaleString('sr-RS', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}
                            </div>
                            <div style={{ fontSize: '10px', color: '#7A9BB8', marginTop: '3px' }}>Neto + porez + doprinosi zaposlenog + doprinosi poslodavca + sve obustave</div>
                          </div>
                        </div>

                        {/* Salary components */}
                        <div style={s.empSection}>Delovi zarade</div>
                        <div style={s.grid3}>
                          <div style={s.field}>
                            <label style={s.lbl}>Neto zarada ({currency}) <span style={s.req}>*</span></label>
                            <input type="number" style={{ ...s.input, borderColor: '#00D47E' }} value={emp.net_salary}
                              onChange={e => updateEmployee(emp.id, { net_salary: e.target.value })} placeholder="0.00" />
                            <div style={{ fontSize: '10px', color: '#00D47E', marginTop: '3px' }}>Posle svih obustava</div>
                          </div>
                          <div style={s.field}>
                            <label style={s.lbl}>Porez na zarade ({currency})</label>
                            <input type="number" style={s.input} value={emp.tax_on_salary}
                              onChange={e => updateEmployee(emp.id, { tax_on_salary: e.target.value })} placeholder="0.00" />
                          </div>
                          <div style={s.field}>
                            <label style={s.lbl}>Doprinosi na teret zaposlenog ({currency})</label>
                            <input type="number" style={s.input} value={emp.contrib_employee}
                              onChange={e => updateEmployee(emp.id, { contrib_employee: e.target.value })} placeholder="0.00" />
                          </div>
                        </div>
                        <div style={{ ...s.grid3, marginTop: '8px' }}>
                          <div style={s.field}>
                            <label style={s.lbl}>Doprinosi na teret poslodavca ({currency})</label>
                            <input type="number" style={s.input} value={emp.contrib_employer}
                              onChange={e => updateEmployee(emp.id, { contrib_employer: e.target.value })} placeholder="0.00" />
                          </div>
                        </div>

                        {/* Third-party deductions */}
                        <div style={s.empSection}>
                          <span>Obustave koje se plaćaju trećim licima</span>
                          <button style={s.addSmallBtn} onClick={() => addDeductionThird(emp.id)}>+ Dodaj</button>
                        </div>
                        {emp.deductions_third_party.length === 0
                          ? <div style={s.emptyHint}>Nema obustava trećim licima</div>
                          : emp.deductions_third_party.map(ded => (
                            <div key={ded.id} style={{ ...s.deductionRow, flexWrap: 'wrap' as const }}>
                              <input style={{ ...s.input, flex: 2, minWidth: '160px' }} value={ded.name}
                                onChange={e => updateDeductionThird(emp.id, ded.id, 'name', e.target.value)}
                                placeholder="Naziv obustave (npr. sindikalna članarina)" />
                              <input type="number" style={{ ...s.input, width: '120px' }} value={ded.amount}
                                onChange={e => updateDeductionThird(emp.id, ded.id, 'amount', e.target.value)}
                                placeholder={`Iznos (${currency})`} />
                              <div style={{ position: 'relative' as const, flex: 1, minWidth: '140px' }}>
                                <input style={{ ...s.input, width: '100%', border: ded.partner_id ? '1.5px solid #00D47E' : undefined }}
                                  value={ded.partner_name}
                                  onChange={e => updateDeductionThird(emp.id, ded.id, 'partner_name', e.target.value)}
                                  placeholder="Partner (primalac)" />
                                {ded.partner_name && !ded.partner_id && (
                                  <div style={{ ...s.empDropdown, zIndex: 400 }}>
                                    {partners.filter(p => p.name.toLowerCase().includes(ded.partner_name.toLowerCase())).slice(0, 6).map(p => (
                                      <div key={p.id} style={s.empDropdownItem}
                                        onMouseDown={e => { e.preventDefault(); updateDeductionThird(emp.id, ded.id, 'partner_id', p.id); updateDeductionThird(emp.id, ded.id, 'partner_name', p.name) }}>
                                        {p.name}
                                      </div>
                                    ))}
                                  </div>
                                )}
                              </div>
                              <button style={s.removeSmallBtn} aria-label="Ukloni obustavu" title="Ukloni obustavu" onClick={() => removeDeductionThird(emp.id, ded.id)}>×</button>
                            </div>
                          ))
                        }

                        {/* Retained deductions (storno) */}
                        <div style={s.empSection}>
                          <span>Zadržane obustave (storno u P&L)</span>
                          <button style={s.addSmallBtn} onClick={() => addDeductionRetained(emp.id)}>+ Dodaj</button>
                        </div>
                        {emp.deductions_retained.length === 0
                          ? <div style={s.emptyHint}>Nema zadržanih obustava</div>
                          : emp.deductions_retained.map(ded => (
                            <div key={ded.id} style={s.deductionRow}>
                              <select style={{ ...s.select, flex: 1 }} value={ded.type}
                                onChange={e => updateDeductionRetained(emp.id, ded.id, 'type', e.target.value as any)}>
                                <option value="fitpass">🏋️ FitPass</option>
                                <option value="penalty">⚠️ Kazne i penali</option>
                              </select>
                              <input type="number" style={{ ...s.input, width: '130px' }} value={ded.amount}
                                onChange={e => updateDeductionRetained(emp.id, ded.id, 'amount', e.target.value)}
                                placeholder={`Iznos (${currency})`} />
                              <button style={s.removeSmallBtn} aria-label="Ukloni obustavu" title="Ukloni obustavu" onClick={() => removeDeductionRetained(emp.id, ded.id)}>×</button>
                            </div>
                          ))
                        }

                        {/* Project */}
                        <div style={s.empSection}>Projekat</div>
                        <ProjectSelect value={emp.project_id}
                          onChange={v => updateEmployee(emp.id, { project_id: v })} />

                        <div style={{ display: 'grid', gridTemplateColumns: '1fr', gap: '10px', marginTop: '10px' }}>
                          <div style={s.field}>
                            <label style={s.lbl}>Tip novčanog toka</label>
                            <div style={{ display: 'flex', gap: '6px' }}>
                              {[{ id: 'recurring', label: '🔁 Ponavljajući' }, { id: 'one_time', label: '1️⃣ Jednokratni' }].map(a => (
                                <div key={a.id} style={{ flex: 1, padding: '7px 6px', border: emp.cf_type === a.id ? '2px solid #00D47E' : '1px solid rgba(255,255,255,0.08)', borderRadius: '7px', background: emp.cf_type === a.id ? 'rgba(0,212,126,0.08)' : 'transparent', cursor: 'pointer', textAlign: 'center' as const, fontSize: '11px', fontWeight: '500', color: emp.cf_type === a.id ? '#00D47E' : '#7A9BB8' }}
                                  onClick={() => updateEmployee(emp.id, { cf_type: a.id })}>
                                  {a.label}
                                </div>
                              ))}
                            </div>
                          </div>
                        </div>
                      </div>
                    )}
                  </div>
                )
              })}

              <button style={{ ...s.addEmpBtn, width: '100%', marginTop: '8px', padding: '10px' }} onClick={addEmployee}>
                + Dodaj još jednog zaposlenog
              </button>
            </div>
          )}

          {/* ── STEP 3: Review ── */}
          {step === 3 && (
            <div style={s.section}>
              <div style={s.sectionTitle}>Pregled obračuna — {taxFilingRef || periodMonth}</div>

              {/* Totals summary */}
              <div style={s.reviewGrid}>
                {[
                  { label: 'Neto zarade', val: totalNet, color: '#00D47E', invoiced: true },
                  { label: 'Obustave trećim licima', val: totalThird, color: '#4EA8FF', invoiced: true },
                  { label: 'Zadržane obustave (storno)', val: totalRetained, color: '#FF5B5A', invoiced: false },
                  { label: 'Porez na zarade', val: totalTax, color: '#F5A623', invoiced: true },
                  { label: 'Doprinosi na teret zaposlenog', val: totalContribEmp, color: '#F5A623', invoiced: true },
                  { label: 'Doprinosi na teret poslodavca', val: totalContribEmpr, color: '#F5A623', invoiced: true },
                  { label: 'Ukupne obaveze (porez i doprinosi)', val: totalObligations, color: '#F5A623', invoiced: true },
                  { label: 'Ukupno bruto', val: totalGross, color: '#DCE9F6', invoiced: false },
                ].map(row => (
                  <div key={row.label} style={s.reviewRow}>
                    <span style={{ fontSize: '13px', color: '#7A9BB8' }}>{row.label}</span>
                    <div style={{ display: 'flex', alignItems: 'center', gap: '10px' }}>
                      {row.invoiced && <span style={{ fontSize: '10px', background: 'rgba(0,212,126,0.12)', color: '#00D47E', padding: '1px 7px', borderRadius: '20px' }}>Pravi se faktura</span>}
                      <span style={{ fontSize: '14px', fontWeight: '600', color: row.color }}>
                        {fmtNum(row.val)} {currency}
                      </span>
                      {hasEurRate && <span style={{ fontSize: '11px', color: '#7A9BB8' }}>{fmtEUR(book(row.val).amount_eur)}</span>}
                    </div>
                  </div>
                ))}
              </div>

              {/* Per-employee summary */}
              <div style={{ marginTop: '20px' }}>
                <div style={s.sectionTitle}>Po zaposlenom</div>
                <div style={{ display: 'flex', flexDirection: 'column' as const, gap: '6px' }}>
                  {employees.filter(e => e.employee_name).map(emp => (
                    <div key={emp.id} style={s.empReviewRow}>
                      <div style={{ flex: 1 }}>
                        <div style={{ fontSize: '13px', fontWeight: '500', color: '#DCE9F6' }}>{emp.employee_name}</div>
                        <div style={{ fontSize: '11px', color: '#7A9BB8' }}>{emp.department_name || '—'}{emp.dept_subcategory_name ? ` / ${emp.dept_subcategory_name}` : ''}</div>
                      </div>
                      <div style={{ textAlign: 'right' as const }}>
                        <div style={{ fontSize: '13px', color: '#00D47E', fontWeight: '600' }}>Neto: {fmtNum(parseFloat(emp.net_salary) || 0)} {currency}</div>
                        <div style={{ fontSize: '11px', color: '#7A9BB8' }}>
                          Porez: {fmtNum(parseFloat(emp.tax_on_salary) || 0)} · Dopr. zaposlenog: {fmtNum(parseFloat(emp.contrib_employee) || 0)} · Dopr. poslodavca: {fmtNum(parseFloat(emp.contrib_employer) || 0)}
                        </div>
                        {emp.deductions_third_party.length > 0 && (
                          <div style={{ fontSize: '11px', color: '#4EA8FF' }}>
                            Obustave: {emp.deductions_third_party.map(d => `${d.name} ${d.amount}`).join(' · ')}
                          </div>
                        )}
                        {emp.deductions_retained.length > 0 && (
                          <div style={{ fontSize: '11px', color: '#FF5B5A' }}>
                            Storno: {emp.deductions_retained.map(d => `${d.type === 'penalty' ? 'Kazne' : 'FitPass'} ${d.amount}`).join(' · ')}
                          </div>
                        )}
                      </div>
                    </div>
                  ))}
                </div>
              </div>

              {/* What will be created */}
              <div style={{ ...s.reviewGrid, marginTop: '20px', background: 'rgba(0,212,126,0.05)', border: '1px solid rgba(0,212,126,0.15)' }}>
                <div style={{ gridColumn: '1/-1', fontSize: '11px', fontWeight: '600', color: '#00D47E', textTransform: 'uppercase' as const, letterSpacing: '0.08em' }}>
                  Šta će biti napravljeno
                </div>
                <div style={s.reviewRow}>
                  <span style={{ color: '#7A9BB8', fontSize: '12px' }}>Otvorene fakture (za uparivanje u grupnom uvozu i izvodu)</span>
                  <span style={{ color: '#00D47E', fontWeight: '600' }}>
                    {(() => {
                      const n = employees.filter(e => e.employee_name && parseFloat(e.net_salary) > 0).length + /* net */
                        employees.reduce((s, e) => s + e.deductions_third_party.filter(d => parseFloat(d.amount) > 0 && d.name).length, 0) + /* third party */
                        (totalObligations > 0 ? 1 : 0) /* tax */
                      return countOf(n, 'faktura', 'fakture', 'faktura')
                    })()}
                  </span>
                </div>
                <div style={s.reviewRow}>
                  <span style={{ color: '#7A9BB8', fontSize: '12px' }}>Storno transakcije u P&L (zadržane obustave, bez fakture)</span>
                  <span style={{ color: '#FF5B5A', fontWeight: '600' }}>
                    {countOf(
                      (employees.some(e => e.deductions_retained.some(d => d.type === 'penalty' && parseFloat(d.amount) > 0)) ? 1 : 0) +
                      (employees.some(e => e.deductions_retained.some(d => d.type === 'fitpass' && parseFloat(d.amount) > 0)) ? 1 : 0),
                      'transakcija', 'transakcije', 'transakcija')}
                  </span>
                </div>
              </div>

              <div style={{ marginTop: '14px' }}>
                <SystemCategoryNotice what="Zarade" roles={PAYROLL_ROLES}
                  map={systemCategories.map} loading={systemCategories.loading} />
              </div>

              {error && (
                <div style={{ marginTop: '14px', background: 'rgba(255,91,90,0.1)', border: '1px solid rgba(255,91,90,0.3)', borderRadius: '8px', padding: '10px 14px', fontSize: '13px', color: '#FF5B5A' }}>
                  ⚠️ {error}
                </div>
              )}
            </div>
          )}
        </div>

        {/* Footer */}
        <div style={s.footer}>
          <div style={{ fontSize: '12px', color: '#7A9BB8' }}>
            {step === 2 && `Zaposleni: ${employees.filter(e => e.employee_name).length} · Ukupno bruto: ${fmtNum(totalGross)} ${currency}`}
            {step === 3 && `Spremno za knjiženje — zaposleni: ${employees.filter(e => e.employee_name).length}`}
          </div>
          <div style={{ display: 'flex', gap: '8px' }}>
            <button style={s.btnGhost} onClick={step === 1 ? onClose : () => setStep(step - 1)}>
              {step === 1 ? 'Otkaži' : '← Nazad'}
            </button>
            {step < 3 && (
              <button style={s.btnPrimary} onClick={() => setStep(step + 1)}>
                Dalje →
              </button>
            )}
            {step === 3 && (
              <button style={{ ...s.btnPrimary, opacity: posting ? 0.7 : 1, minWidth: '140px' }}
                onClick={handlePost} disabled={posting || !hasEurRate}>
                {posting ? 'Knjiženje…' : '💼 Proknjiži zarade'}
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
  dialog: { background: '#0D1B2C', border: '1px solid rgba(255,255,255,0.08)', borderRadius: '16px', width: '900px', maxWidth: '96vw', maxHeight: '92vh', display: 'flex', flexDirection: 'column', overflow: 'hidden' },
  header: { background: '#060E1A', padding: '1rem 1.5rem', display: 'flex', alignItems: 'center', justifyContent: 'space-between', borderBottom: '1px solid rgba(255,255,255,0.07)' },
  headerIcon: { fontSize: '22px', width: '40px', height: '40px', borderRadius: '10px', background: 'rgba(0,212,126,0.12)', display: 'flex', alignItems: 'center', justifyContent: 'center' },
  headerTitle: { color: '#DCE9F6', fontSize: '15px', fontWeight: '600' },
  headerSub: { color: '#7A9BB8', fontSize: '12px', marginTop: '2px' },
  logoBadge: { color: '#00D47E', fontFamily: 'Georgia,serif', fontSize: '13px' },
  closeBtn: { background: 'none', border: 'none', color: 'rgba(255,255,255,0.4)', fontSize: '22px', cursor: 'pointer', padding: '0 4px', lineHeight: 1 },
  stepsBar: { display: 'flex', alignItems: 'center', padding: '0.75rem 1.5rem', borderBottom: '1px solid rgba(255,255,255,0.07)', background: '#060E1A', gap: 0 },
  stepItem: { display: 'flex', alignItems: 'center', gap: '6px', cursor: 'pointer', padding: '4px 8px', borderRadius: '8px' },
  stepNum: { width: '22px', height: '22px', borderRadius: '50%', display: 'flex', alignItems: 'center', justifyContent: 'center', fontSize: '11px', fontWeight: '500', background: 'rgba(255,255,255,0.06)', color: '#7A9BB8', border: '1px solid rgba(255,255,255,0.1)', flexShrink: 0 },
  stepActive: { background: '#00D47E', color: '#060E1A', borderColor: '#00D47E' },
  stepDone: { background: 'rgba(0,212,126,0.15)', color: '#00D47E', borderColor: 'rgba(0,212,126,0.4)' },
  stepLabel: { fontSize: '12px', color: '#7A9BB8' },
  stepDiv: { width: '24px', height: '1px', background: 'rgba(255,255,255,0.08)', flexShrink: 0 },
  body: { padding: '1.5rem', overflowY: 'auto', flex: 1 },
  footer: { padding: '1rem 1.5rem', borderTop: '1px solid rgba(255,255,255,0.07)', display: 'flex', alignItems: 'center', justifyContent: 'space-between', background: '#060E1A' },
  section: { marginBottom: '1.5rem' },
  sectionTitle: { fontSize: '10px', fontWeight: '600', color: '#7A9BB8', textTransform: 'uppercase' as const, letterSpacing: '0.1em', marginBottom: '12px', paddingBottom: '6px', borderBottom: '1px solid rgba(255,255,255,0.06)', display: 'flex', alignItems: 'center', justifyContent: 'space-between' },
  grid2: { display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '12px', marginBottom: '12px' },
  grid3: { display: 'grid', gridTemplateColumns: '1fr 1fr 1fr', gap: '12px', marginBottom: '12px' },
  field: { display: 'flex', flexDirection: 'column' as const, gap: '4px' },
  lbl: { fontSize: '10px', fontWeight: '500', color: 'rgba(255,255,255,0.35)', textTransform: 'uppercase' as const, letterSpacing: '0.07em' },
  req: { color: '#FF5B5A' },
  select: { fontFamily: 'system-ui,sans-serif', fontSize: '13px', padding: '8px 10px', border: '1px solid rgba(255,255,255,0.1)', borderRadius: '8px', background: '#111F30', color: '#DCE9F6', outline: 'none' },
  input: { fontFamily: 'system-ui,sans-serif', fontSize: '13px', padding: '8px 10px', border: '1px solid rgba(255,255,255,0.1)', borderRadius: '8px', background: '#111F30', color: '#DCE9F6', outline: 'none' },
  fetchBtn: { fontFamily: 'system-ui,sans-serif', fontSize: '12px', padding: '8px 12px', border: '1px solid rgba(0,212,126,0.3)', borderRadius: '8px', background: 'rgba(0,212,126,0.08)', color: '#00D47E', cursor: 'pointer' },
  summaryBar: { display: 'flex', gap: '0', background: '#060E1A', borderRadius: '10px', border: '1px solid rgba(255,255,255,0.06)', marginTop: '16px', overflow: 'hidden' },
  summaryItem: { flex: 1, padding: '12px 16px', display: 'flex', flexDirection: 'column' as const, gap: '3px' },
  summaryLabel: { fontSize: '10px', color: '#7A9BB8', textTransform: 'uppercase' as const, letterSpacing: '0.07em' },
  summaryVal: { fontSize: '13px', fontWeight: '600', color: '#DCE9F6' },
  summaryDivider: { width: '1px', background: 'rgba(255,255,255,0.06)', flexShrink: 0 },
  addEmpBtn: { fontFamily: 'system-ui,sans-serif', fontSize: '12px', padding: '7px 14px', border: '1px solid rgba(0,212,126,0.4)', borderRadius: '8px', background: 'rgba(0,212,126,0.08)', color: '#00D47E', cursor: 'pointer' },
  empCard: { border: '1px solid rgba(255,255,255,0.08)', borderRadius: '12px', background: '#0D1B2C', marginBottom: '10px', overflow: 'hidden' },
  empCardHeader: { display: 'flex', alignItems: 'center', justifyContent: 'space-between', padding: '12px 16px', cursor: 'pointer', background: '#111F30' },
  empIndex: { width: '24px', height: '24px', borderRadius: '50%', background: 'rgba(0,212,126,0.15)', color: '#00D47E', display: 'flex', alignItems: 'center', justifyContent: 'center', fontSize: '11px', fontWeight: '700', flexShrink: 0 },
  empCardBody: { padding: '16px' },
  empSection: { fontSize: '10px', fontWeight: '600', color: '#7A9BB8', textTransform: 'uppercase' as const, letterSpacing: '0.08em', marginBottom: '10px', marginTop: '16px', paddingBottom: '5px', borderBottom: '1px solid rgba(255,255,255,0.05)', display: 'flex', alignItems: 'center', justifyContent: 'space-between' },
  empDropdown: { position: 'absolute' as const, top: '100%', left: 0, right: 0, background: '#111F30', border: '1px solid rgba(255,255,255,0.12)', borderRadius: '8px', zIndex: 200, boxShadow: '0 8px 24px rgba(0,0,0,0.4)', maxHeight: '200px', overflowY: 'auto' as const, marginTop: '2px' },
  empDropdownItem: { padding: '8px 12px', fontSize: '13px', color: '#DCE9F6', cursor: 'pointer', borderBottom: '1px solid rgba(255,255,255,0.05)' },
  removeEmpBtn: { background: 'none', border: 'none', color: 'rgba(255,91,90,0.5)', fontSize: '18px', cursor: 'pointer', padding: '0 4px', lineHeight: 1 },
  deductionRow: { display: 'flex', gap: '8px', alignItems: 'center', marginBottom: '6px' },
  addSmallBtn: { fontFamily: 'system-ui,sans-serif', fontSize: '11px', padding: '3px 8px', border: '1px solid rgba(0,212,126,0.3)', borderRadius: '5px', background: 'rgba(0,212,126,0.06)', color: '#00D47E', cursor: 'pointer' },
  removeSmallBtn: { background: 'none', border: '1px solid rgba(255,91,90,0.3)', borderRadius: '5px', color: '#FF5B5A', fontSize: '14px', cursor: 'pointer', padding: '2px 8px', lineHeight: 1 },
  emptyHint: { fontSize: '12px', color: 'rgba(255,255,255,0.2)', padding: '6px 0', fontStyle: 'italic' },
  reviewGrid: { background: 'rgba(255,255,255,0.02)', border: '1px solid rgba(255,255,255,0.07)', borderRadius: '10px', padding: '4px 0', overflow: 'hidden' },
  reviewRow: { display: 'flex', alignItems: 'center', justifyContent: 'space-between', padding: '10px 16px', borderBottom: '1px solid rgba(255,255,255,0.04)' },
  empReviewRow: { display: 'flex', alignItems: 'flex-start', gap: '12px', padding: '10px 14px', background: 'rgba(255,255,255,0.02)', borderRadius: '8px', border: '1px solid rgba(255,255,255,0.05)' },
  btnGhost: { fontFamily: 'system-ui,sans-serif', fontSize: '13px', padding: '8px 16px', borderRadius: '8px', border: '1px solid rgba(255,255,255,0.12)', background: 'transparent', color: '#7A9BB8', cursor: 'pointer' },
  btnPrimary: { fontFamily: 'system-ui,sans-serif', fontSize: '13px', padding: '8px 20px', borderRadius: '8px', border: 'none', background: '#00D47E', color: '#060E1A', cursor: 'pointer', fontWeight: '600' },
}

// `SearchableSelect` paints its border with longhands so it can recolour just
// the edge when the list opens, and React warns about mixing those with the
// `border` shorthand on one element. So the shorthand is dropped here and the
// control keeps its own border, which is the same weight and colour.
// eslint-disable-next-line @typescript-eslint/no-unused-vars
const { border: _pickerBorder, ...pickerChrome } = s.select
