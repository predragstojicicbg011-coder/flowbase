// ─── Prihodi ────────────────────────────────────────────────────────────────
//
// Revenue on the accrual basis (20261008180000_accrual_revenue.sql): a
// revenue invoice — a progress billing ("situacija") or a month's rent — is
// revenue on its date and project; the advance (avans) an investor pays up
// front is a liability that billings deduct; the plan and the leases say what
// is still to be billed.
//
// Sections, top to bottom:
//   three cards          receivables, due within a week, late (receivables.ts)
//   Ko kasni             customers with overdue invoices, card and PDF
//   Po projektima        revenuePage.projectRevenueRows (projectRevenueSummary)
//   Izlazne fakture      v_invoice_status, opening InvoiceDialog for edit,
//                        SEF warnings from sef_inbox
//   Starost potraživanja revenue.receivablesAging
//   Plan prihoda         revenue_plan per project × 12 months, with the rent forecast
//   Zakup                rental_leases per rental building, and rent invoices
//   Avansi kupaca        v_customer_advances: proformas, advance invoices, what is open
//
// The arithmetic is in services/revenue.ts, revenuePlan.ts and revenuePage.ts.

import React, { useCallback, useEffect, useMemo, useState } from 'react'
import { supabase } from '../supabase'
import { PageHeader } from '../components/PageHeader'
import { SkeletonRows } from '../components/motion'
import InvoiceDialog from '../components/InvoiceDialog'
import SefSalesInboxDialog from '../components/SefSalesInboxDialog'
import { useAuth } from '../contexts/AuthContext'
import { plural } from '../utils/plural'
import ProjectRevenueTable from '../components/revenue/ProjectRevenueTable'
import ReceivablesAgingPanel from '../components/revenue/ReceivablesAgingPanel'
import RevenueInvoiceList from '../components/revenue/RevenueInvoiceList'
import RevenuePlanGrid from '../components/revenue/RevenuePlanGrid'
import LeasesSection from '../components/revenue/LeasesSection'
import CustomerAdvancesSection from '../components/revenue/CustomerAdvancesSection'
import ReceivablesCards from '../components/revenue/ReceivablesCards'
import LatePayersTable from '../components/revenue/LatePayersTable'
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
  monthsToYearEnd, nextMonths, projectRevenueRows, type RevenueListRow,
} from '../services/revenuePage'
import { latePayers, receivableTotals, sefFlags } from '../services/receivables'

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
  const { canEdit } = useAuth()
  const { projects } = useProjects()
  const { currency, format } = useDisplayCurrency()
  const companyId = defaultCompany?.id ?? null
  const today = isoToday()

  const [from, setFrom] = useState(yearStart())
  const [to, setTo] = useState(today)

  const [rows, setRows] = useState<RevenueListRow[]>([])
  const [sefRows, setSefRows] = useState<{ imported_invoice_id: string | null; sef_status: string | null }[]>([])
  const [advances, setAdvances] = useState<AdvanceReceipt[]>([])
  const [plan, setPlan] = useState<RevenuePlanRow[]>([])
  const [leases, setLeases] = useState<RentalLease[]>([])
  const [partners, setPartners] = useState<{ id: string; name: string }[]>([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState('')
  const [rates, setRates] = useState<BookRates | null>(null)
  const [rateError, setRateError] = useState('')
  const [editInvoice, setEditInvoice] = useState<any | null>(null)
  const [newInvoice, setNewInvoice] = useState(false)
  const [salesInbox, setSalesInbox] = useState(false)
  const [pulling, setPulling] = useState(false)
  const [pullNotice, setPullNotice] = useState<{ text: string; bad: boolean } | null>(null)

  const scoped = (q: any) => (companyId ? q.eq('company_id', companyId) : q)

  const loadInvoices = useCallback(async () => {
    const data = await fetchAllPages<RevenueListRow>((a, b) =>
      scoped(supabase.from('v_invoice_status').select('*').eq('type', 'revenue'))
        .order('invoice_date').order('id').range(a, b))
    setRows(data)
  }, [companyId]) // eslint-disable-line react-hooks/exhaustive-deps

  // Only the warnings depend on this; a failure leaves the page without them.
  const loadSefStatus = useCallback(async () => {
    const data = await fetchAllPages<{ imported_invoice_id: string | null; sef_status: string | null }>((a, b) =>
      scoped(supabase.from('sef_inbox').select('imported_invoice_id, sef_status').eq('direction', 'sales'))
        .not('imported_invoice_id', 'is', null).order('id').range(a, b))
    setSefRows(data)
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
      guard('SEF status', loadSefStatus),
      guard('Avansi', loadAdvances),
      guard('Planovi', loadPlan),
      guard('Zakupi', loadLeases),
    ])
    setLoading(false)
  }, [guard, loadInvoices, loadSefStatus, loadAdvances, loadPlan, loadLeases])

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
    () => projectRevenueRows(companyProjects, rows, advances, currency, { constructionOnly: true }),
    [companyProjects, rows, advances, currency])
  const receivables = useMemo(() => receivableTotals(rows, today, currency), [rows, today, currency])
  const late = useMemo(() => latePayers(rows, today, currency), [rows, today, currency])
  const flags = useMemo(() => sefFlags(rows, sefRows), [rows, sefRows])
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

  // Pulls the invoices we issued from SEF. A failed call's real reason is in
  // the response body, not in the client's `message`.
  const pullFromSef = async () => {
    setPulling(true); setPullNotice(null)
    try {
      const { data, error: err } = await supabase.functions.invoke('sef-pull-sales', { body: {} })
      let reason = ''
      if (err) {
        try { const b = await (err as any).context?.json?.(); reason = String(b?.error || b?.message || '') } catch { /* not JSON */ }
        reason = reason || (err as any).message || 'Poziv nije uspeo.'
      } else if (data?.error) reason = String(data.error)
      if (reason) { setPullNotice({ text: `Preuzimanje sa SEF-a nije uspelo: ${reason}`, bad: true }); return }
      const n = Number(data?.inserted) || 0
      setPullNotice({
        text: n > 0
          ? `Preuzeto ${n} ${plural(n, 'nova izlazna faktura', 'nove izlazne fakture', 'novih izlaznih faktura')} sa SEF-a. Pogledajte ih u „SEF izlazne“.`
          : 'Nema novih izlaznih faktura na SEF-u.',
        bad: false,
      })
    } catch (e: any) {
      setPullNotice({ text: `Preuzimanje sa SEF-a nije uspelo: ${e?.message || e}`, bad: true })
    } finally { setPulling(false) }
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
            avans kao predračun kupcu koji se zatvara uplatom, pa avansni račun koji konačna faktura koristi,
            a plan i zakupi ovde ispod.
          </div>
        )}

        {loading ? (
          <div style={{ ...rs.tableWrap, padding: '18px 16px', marginBottom: '1.5rem' }}>
            <SkeletonRows rows={3} height={18} gap={14} widths={[60, 80, 70]} />
          </div>
        ) : (
          <ReceivablesCards totals={receivables} rows={rows} today={today} currency={currency} format={format} flags={flags} />
        )}

        <div style={rs.sectionTitle}>Ko kasni</div>
        {!loading && <LatePayersTable payers={late} rows={rows} today={today} flags={flags} format={format} />}

        <div style={{ ...rs.sectionTitle, ...rs.section }}>Po projektima</div>
        {loading
          ? <div style={{ ...rs.tableWrap, padding: '18px 16px' }}><SkeletonRows rows={4} height={15} gap={14} /></div>
          : <ProjectRevenueTable rows={byProject.projects} overhead={byProject.overhead} total={byProject.total}
              format={format} currency={currency} />}

        <div style={{ ...rs.sectionTitle, ...rs.section }}>Izlazne fakture</div>
        <div style={{ display: 'flex', gap: '8px', flexWrap: 'wrap', marginBottom: '10px' }}>
          {canEdit && <button style={rs.newBtn} onClick={() => setNewInvoice(true)}>Nova izlazna faktura</button>}
          {canEdit && <button style={rs.ghostBtn} onClick={() => setSalesInbox(true)}>SEF izlazne</button>}
          <button style={{ ...rs.ghostBtn, opacity: pulling ? 0.5 : 1 }} disabled={pulling} onClick={pullFromSef}>
            {pulling ? 'Preuzimam…' : 'Preuzmi sa SEF-a'}
          </button>
        </div>
        {pullNotice && (
          <div style={pullNotice.bad ? rs.error : rs.info} role={pullNotice.bad ? 'alert' : 'status'}>{pullNotice.text}</div>
        )}
        <RevenueInvoiceList rows={rows} loading={loading} projects={companyProjects} projectName={projectName}
          currency={currency} format={format} from={from} to={to}
          onPeriod={(f, t) => { setFrom(f); setTo(t) }} onOpen={openInvoice} flags={flags} />

        <div style={{ ...rs.sectionTitle, ...rs.section }}>Starost potraživanja</div>
        {!loading && (
          <ReceivablesAgingPanel aging={aging} format={format} currency={currency}
            projectName={id => projectName(id)} />
        )}

        <div style={{ ...rs.sectionTitle, ...rs.section }}>
          Plan prihoda<span> · do kraja godine {format(yearEnd, 0)}</span>
        </div>
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

        <div style={{ ...rs.sectionTitle, ...rs.section }}>Avansi kupaca</div>
        {!loading && <CustomerAdvancesSection companyId={companyId} format={format} />}
      </div>

      {salesInbox && (
        <SefSalesInboxDialog onClose={() => { setSalesInbox(false); loadAll() }} onImported={() => { guard('Fakture', loadInvoices) }} />
      )}
      {newInvoice && (
        <InvoiceDialog invoice={{ type: 'revenue', company_id: companyId }}
          onClose={() => { setNewInvoice(false); loadAll() }} />
      )}
      {editInvoice && (
        <InvoiceDialog invoice={editInvoice} onClose={() => { setEditInvoice(null); loadAll() }} />
      )}
    </div>
  )
}
