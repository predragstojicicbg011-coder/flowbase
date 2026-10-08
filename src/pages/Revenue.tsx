// ─── Prihodi ────────────────────────────────────────────────────────────────
//
// Revenue on the accrual basis (20261008180000_accrual_revenue.sql): a
// revenue invoice — a progress billing ("situacija") or a month's rent — is
// revenue on its date and project; the advance (avans) an investor pays up
// front is a liability that billings deduct; the plan and the leases say what
// is still to be billed.
//
// Sections, top to bottom:
//   summary cards        billed and collected in the period, owed today,
//                        advance not yet deducted, planned to year end
//   Po projektima        revenuePage.projectRevenueRows (projectRevenueSummary)
//   Starost potraživanja revenue.receivablesAging
//   Izlazne fakture      v_invoice_status, opening InvoiceDialog for edit
//   Plan prihoda         revenue_plan per project × 12 months, with the rent forecast
//   Zakup                rental_leases per rental building, and rent invoices
//
// The arithmetic is in services/revenue.ts, revenuePlan.ts and revenuePage.ts.

import React, { useCallback, useEffect, useMemo, useState } from 'react'
import { supabase } from '../supabase'
import { PageHeader } from '../components/PageHeader'
import { SkeletonRows } from '../components/motion'
import InvoiceDialog from '../components/InvoiceDialog'
import ProjectRevenueTable from '../components/revenue/ProjectRevenueTable'
import ReceivablesAgingPanel from '../components/revenue/ReceivablesAgingPanel'
import RevenueInvoiceList from '../components/revenue/RevenueInvoiceList'
import RevenuePlanGrid from '../components/revenue/RevenuePlanGrid'
import LeasesSection from '../components/revenue/LeasesSection'
import { rs } from '../components/revenue/styles'
import { useCompanies } from '../contexts/CompaniesContext'
import { useProjects } from '../contexts/ProjectsContext'
import { useDisplayCurrency } from '../contexts/DisplayCurrencyContext'
import { fetchAllPartners } from '../services/allPartners'
import { fetchAllPages } from '../utils/fetchAllPages'
import { getBookRates, type BookRates } from '../services/bookAmounts'
import { projectLabelById } from '../services/projects'
import { receivablesAging, type AdvanceReceipt } from '../services/revenue'
import {
  plannedRevenueByMonth, type RentalLease, type RevenuePlanRow,
} from '../services/revenuePlan'
import {
  monthsToYearEnd, nextMonths, projectRevenueRows, revenueTotals, srDateShort, type RevenueListRow,
} from '../services/revenuePage'

const isoToday = () => new Date().toISOString().slice(0, 10)
const yearStart = () => `${new Date().getFullYear()}-01-01`

function normaliseLease(r: any): RentalLease {
  return {
    ...r,
    currency: r.currency === 'EUR' ? 'EUR' : 'RSD',
    invoice_day: Number(r.invoice_day) || 1,
    payment_days: Number(r.payment_days ?? 15),
    active: r.active !== false,
    end_date: r.end_date ?? null,
  }
}

export default function Revenue() {
  const { defaultCompany } = useCompanies()
  const { projects } = useProjects()
  const { currency, format } = useDisplayCurrency()
  const companyId = defaultCompany?.id ?? null
  const today = isoToday()

  const [from, setFrom] = useState(yearStart())
  const [to, setTo] = useState(today)

  const [rows, setRows] = useState<RevenueListRow[]>([])
  const [advances, setAdvances] = useState<AdvanceReceipt[]>([])
  const [plan, setPlan] = useState<RevenuePlanRow[]>([])
  const [leases, setLeases] = useState<RentalLease[]>([])
  const [partners, setPartners] = useState<{ id: string; name: string }[]>([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState('')
  const [rates, setRates] = useState<BookRates | null>(null)
  const [rateError, setRateError] = useState('')
  const [editInvoice, setEditInvoice] = useState<any | null>(null)

  const scoped = (q: any) => (companyId ? q.eq('company_id', companyId) : q)

  const loadInvoices = useCallback(async () => {
    const data = await fetchAllPages<RevenueListRow>((a, b) =>
      scoped(supabase.from('v_invoice_status').select('*').eq('type', 'revenue'))
        .order('invoice_date').order('id').range(a, b))
    setRows(data)
  }, [companyId]) // eslint-disable-line react-hooks/exhaustive-deps

  const loadPlan = useCallback(async () => {
    const data = await fetchAllPages<RevenuePlanRow>((a, b) =>
      scoped(supabase.from('revenue_plan').select('*')).order('month').order('id').range(a, b))
    setPlan(data)
  }, [companyId]) // eslint-disable-line react-hooks/exhaustive-deps

  const loadLeases = useCallback(async () => {
    const data = await fetchAllPages<any>((a, b) =>
      scoped(supabase.from('rental_leases').select('*')).order('start_date').order('id').range(a, b))
    setLeases(data.map(normaliseLease))
  }, [companyId]) // eslint-disable-line react-hooks/exhaustive-deps

  const loadAdvances = useCallback(async () => {
    const data = await fetchAllPages<AdvanceReceipt>((a, b) =>
      scoped(supabase.from('transactions')
        .select('id, project_id, currency, amount, amount_rsd, amount_eur, status, deleted_at')
        .eq('is_advance', true)).order('transaction_date').order('id').range(a, b))
    setAdvances(data)
  }, [companyId]) // eslint-disable-line react-hooks/exhaustive-deps

  const guard = useCallback(async (what: string, f: () => Promise<void>) => {
    try { await f() } catch (e: any) { setError(prev => (prev ? `${prev} ` : '') + `${what} nisu učitani: ${e?.message || e}.`) }
  }, [])

  const loadAll = useCallback(async () => {
    setLoading(true)
    setError('')
    await Promise.all([
      guard('Fakture', loadInvoices),
      guard('Avansi', loadAdvances),
      guard('Planovi', loadPlan),
      guard('Zakupi', loadLeases),
    ])
    setLoading(false)
  }, [guard, loadInvoices, loadAdvances, loadPlan, loadLeases])

  useEffect(() => { loadAll() }, [loadAll])

  useEffect(() => {
    fetchAllPartners<{ id: string; name: string }>(supabase, 'id, name')
      .then(setPartners)
      .catch(() => setPartners([]))
  }, [])

  useEffect(() => {
    let cancelled = false
    getBookRates(today)
      .then(r => { if (!cancelled) { setRates(r); setRateError('') } })
      .catch((e: any) => { if (!cancelled) setRateError(e?.message || String(e)) })
    return () => { cancelled = true }
  }, [today])

  const companyProjects = useMemo(
    () => projects.filter(p => !companyId || p.company_id === companyId), [projects, companyId])
  const activeProjects = useMemo(() => companyProjects.filter(p => p.active), [companyProjects])
  const rentalProjects = useMemo(
    () => companyProjects.filter(p => p.kind === 'rental' && (p.active || leases.some(l => l.project_id === p.id))),
    [companyProjects, leases])

  const projectName = useCallback(
    (id: string | null, fallback?: string | null) => projectLabelById(companyProjects, id, fallback),
    [companyProjects])

  const byProject = useMemo(
    () => projectRevenueRows(companyProjects, rows, advances, currency), [companyProjects, rows, advances, currency])
  const totals = useMemo(
    () => revenueTotals(rows, byProject.projects.map(r => r.advanceRemaining), from, to, currency),
    [rows, byProject, from, to, currency])
  const aging = useMemo(() => receivablesAging(rows, today, currency), [rows, today, currency])

  const planMonths = useMemo(() => nextMonths(today, 12), [today])
  const yearEnd = useMemo(() => {
    const r = plannedRevenueByMonth(companyProjects, plan, leases, monthsToYearEnd(today),
      { currency, eurRate: rates?.eurRate ?? null, invoices: rows })
    return Object.values(r.byMonth).reduce((s, n) => s + n, 0)
  }, [companyProjects, plan, leases, today, currency, rates, rows])

  const openInvoice = async (r: RevenueListRow) => {
    const { data, error: e } = await supabase.from('invoices')
      .select('*, companies(name,currencies), partners(name)').eq('id', r.id).single()
    if (e || !data) { setError(`Faktura nije otvorena: ${e?.message || 'nije pronađena'}.`); return }
    setEditInvoice(data)
  }

  const nothingYet = !loading && rows.length === 0 && advances.length === 0 && plan.length === 0 && leases.length === 0

  return (
    <div style={rs.root} className="app-surface">
      <div style={rs.body}>
        <PageHeader title="Prihodi"
          subtitle="Situacije i zakup po projektima — fakturisano, naplaćeno, avansi, potraživanja i plan" />

        {error && <div style={rs.error} role="alert">{error}</div>}
        {nothingYet && (
          <div style={rs.info} role="status">
            Još nema izlaznih faktura, avansa, plana ni zakupa. Situacije se unose kao fakture vrste „prihod",
            avansi kao primljene uplate označene kao avans, a plan i zakupi ovde ispod.
          </div>
        )}

        {loading ? (
          <div style={{ ...rs.tableWrap, padding: '18px 16px', marginBottom: '1.5rem' }}>
            <SkeletonRows rows={3} height={18} gap={14} widths={[60, 80, 70]} />
          </div>
        ) : (
          <div style={rs.summaryRow}>
            <Card label={`Fakturisano u periodu · ${currency}`} value={format(totals.billed, 0)}
              sub={`${srDateShort(from)} – ${srDateShort(to)}`} />
            <Card label="Naplaćeno" value={format(totals.collected, 0)} color="#00D47E"
              sub="na fakturama iz perioda" />
            <Card label="Nenaplaćeno" value={format(totals.outstanding, 0)}
              color={totals.outstanding > 0 ? '#FF5B5A' : undefined} sub="ukupno otvoreno danas" />
            <Card label="Primljeni avansi neodbijeni" value={format(totals.advancesRemaining, 0)}
              color={totals.advancesRemaining > 0 ? '#F5A623' : undefined} sub="obaveza prema investitorima" />
            <Card label="Planirano do kraja godine" value={format(yearEnd, 0)} color="#4EA8FF"
              sub="plan i zakup, bez već fakturisanog" />
          </div>
        )}
        {totals.unconverted > 0 && (
          <div style={{ ...rs.note, marginTop: '-1rem', marginBottom: '1rem' }}>
            {totals.unconverted} iznosa nemaju vrednost u {currency} i računata su kao 0.
          </div>
        )}

        <div style={rs.sectionTitle}>Po projektima</div>
        {loading
          ? <div style={{ ...rs.tableWrap, padding: '18px 16px' }}><SkeletonRows rows={4} height={15} gap={14} /></div>
          : <ProjectRevenueTable rows={byProject.projects} overhead={byProject.overhead} total={byProject.total}
              format={format} currency={currency} />}

        <div style={{ ...rs.sectionTitle, ...rs.section }}>Starost potraživanja</div>
        {!loading && (
          <ReceivablesAgingPanel aging={aging} format={format} currency={currency}
            projectName={id => projectName(id)} />
        )}

        <div style={{ ...rs.sectionTitle, ...rs.section }}>Izlazne fakture</div>
        <RevenueInvoiceList rows={rows} loading={loading} projects={companyProjects} projectName={projectName}
          currency={currency} format={format} from={from} to={to}
          onPeriod={(f, t) => { setFrom(f); setTo(t) }} onOpen={openInvoice} />

        <div style={{ ...rs.sectionTitle, ...rs.section }}>Plan prihoda</div>
        {!loading && (
          <RevenuePlanGrid projects={activeProjects} months={planMonths} plan={plan} leases={leases} invoices={rows}
            currency={currency} format={format} rates={rates} rateError={rateError} companyId={companyId} today={today}
            onChanged={() => { guard('Planovi', loadPlan) }} />
        )}

        <div style={{ ...rs.sectionTitle, ...rs.section }}>Zakup</div>
        {!loading && (
          <LeasesSection rentalProjects={rentalProjects} leases={leases} partners={partners} invoices={rows}
            companyId={companyId} today={today}
            onChanged={() => { guard('Zakupi', loadLeases); guard('Fakture', loadInvoices) }} />
        )}
      </div>

      {editInvoice && (
        <InvoiceDialog invoice={editInvoice} onClose={() => { setEditInvoice(null); loadAll() }} />
      )}
    </div>
  )
}

function Card({ label, value, sub, color }: { label: string; value: string; sub?: string; color?: string }) {
  return (
    <div style={rs.summaryCard}>
      <div style={rs.summaryLabel}>{label}</div>
      <div style={{ ...rs.summaryVal, ...(color ? { color } : {}) }}>{value}</div>
      {sub && <div style={rs.summarySub}>{sub}</div>}
    </div>
  )
}
