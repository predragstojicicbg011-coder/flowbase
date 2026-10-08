import React, { useRef, useState, useEffect, useCallback } from 'react'
import { useProjects } from '../contexts/ProjectsContext'
import { projectProfitability, type ProjectProfit } from '../services/projects'
import { useAuth } from '../contexts/AuthContext'
import { useCompanies } from '../contexts/CompaniesContext'
import { supabase } from '../supabase'
import { useNav } from '../navigation'
import type { Page } from '../navigation'
import { fmtMoney } from '../utils/formatters'
import { shortMoney } from '../services/expenseCharts'
import { useDisplayCurrency } from '../contexts/DisplayCurrencyContext'
import MetricCard from '../components/MetricCard'
import { SkeletonRows, Rise, useDrawLength } from '../components/motion'
import { fetchAllPages, countRows } from '../utils/fetchAllPages'

/** 'all' for every company together, otherwise one company's id. */
type Entity = 'all' | string

/** Chip colours, handed out to companies in name order. */
const ENTITY_COLORS = ['#185FA5', '#BA7517', '#D4537E', '#7C3AED', '#0891B2']

// ── Area Chart ───────────────────────────────────────────
function AreaChart({ months, revenues, expenses }: { months: string[]; revenues: number[]; expenses: number[] }) {
  const [hovered, setHovered] = React.useState<number | null>(null)
  const W = 560
  const H = 140
  const padL = 42
  const padR = 16
  const padT = 10
  const padB = 28
  const chartW = W - padL - padR
  const chartH = H - padT - padB
  const max = Math.max(...revenues, ...expenses, 0.01)
  const n = months.length

  const xPos = (i: number) => padL + (i / Math.max(n - 1, 1)) * chartW
  const yPos = (v: number) => padT + (1 - v / max) * chartH

  const revRef = useRef<SVGPolylineElement | null>(null)
  const expRef = useRef<SVGPolylineElement | null>(null)
  useDrawLength(revRef)
  useDrawLength(expRef)

  const revPts = revenues.map((v, i) => `${xPos(i)},${yPos(v)}`).join(' ')
  const expPts = expenses.map((v, i) => `${xPos(i)},${yPos(v)}`).join(' ')

  const revArea = `M ${xPos(0)},${yPos(0)} L ${revPts} L ${xPos(n - 1)},${padT + chartH} L ${xPos(0)},${padT + chartH} Z`
  const expArea = `M ${xPos(0)},${yPos(0)} L ${expPts} L ${xPos(n - 1)},${padT + chartH} L ${xPos(0)},${padT + chartH} Z`

  // Y-axis ticks
  const ticks = [0, 0.25, 0.5, 0.75, 1].map(f => ({ v: max * f, y: padT + (1 - f) * chartH }))

  // Axis ticks carry the scale only; the card above names the currency.
  const fmt = (v: number) => shortMoney(v)

  return (
    <div style={{ position: 'relative' }}>
      <svg width="100%" viewBox={`0 0 ${W} ${H}`} style={{ overflow: 'visible' }}>
        <defs>
          <linearGradient id="revGrad" x1="0" y1="0" x2="0" y2="1">
            <stop offset="0%" stopColor="#00D47E" stopOpacity="0.22" />
            <stop offset="100%" stopColor="#00D47E" stopOpacity="0.02" />
          </linearGradient>
          <linearGradient id="expGrad" x1="0" y1="0" x2="0" y2="1">
            <stop offset="0%" stopColor="#FF5B5A" stopOpacity="0.18" />
            <stop offset="100%" stopColor="#FF5B5A" stopOpacity="0.02" />
          </linearGradient>
        </defs>

        {/* Grid lines */}
        {ticks.map((t, i) => (
          <g key={i}>
            <line x1={padL} y1={t.y} x2={W - padR} y2={t.y} stroke="rgba(255,255,255,0.06)" strokeWidth="1" />
            <text x={padL - 6} y={t.y + 4} textAnchor="end" fontSize="9" fill="rgba(255,255,255,0.30)" fontFamily="system-ui">{fmt(t.v)}</text>
          </g>
        ))}

        {/* Area fills — they fade in behind the lines that draw over them. */}
        <path d={expArea} fill="url(#expGrad)" className="mf-fade" style={{ animationDelay: '600ms' }} />
        <path d={revArea} fill="url(#revGrad)" className="mf-fade" style={{ animationDelay: '600ms' }} />

        {/* Lines. Each draws itself once, and each measures its own length —
            a dash pattern guessed at leaves a gap that never closes. */}
        <polyline ref={expRef} className="mf-draw" points={expPts} fill="none"
          stroke="#FF5B5A" strokeWidth="1.8" strokeLinejoin="round" strokeLinecap="round" opacity="0.8" />
        <polyline ref={revRef} className="mf-draw" points={revPts} fill="none"
          stroke="#00D47E" strokeWidth="2" strokeLinejoin="round" strokeLinecap="round" />

        {/* Month labels */}
        {months.map((m, i) => (
          <text key={m} x={xPos(i)} y={H - 4} textAnchor="middle" fontSize="9" fill={hovered === i ? '#DCE9F6' : 'rgba(255,255,255,0.30)'} fontFamily="system-ui" fontWeight={hovered === i ? '600' : '400'}>{m}</text>
        ))}

        {/* Hover zones + dots */}
        {months.map((m, i) => (
          <g key={`h${i}`}>
            {hovered === i && (
              <>
                <line x1={xPos(i)} y1={padT} x2={xPos(i)} y2={padT + chartH} stroke="rgba(255,255,255,0.10)" strokeWidth="1" strokeDasharray="3,2" />
                <circle cx={xPos(i)} cy={yPos(revenues[i])} r="4" fill="#00D47E" stroke="#0D1B2C" strokeWidth="2" />
                <circle cx={xPos(i)} cy={yPos(expenses[i])} r="4" fill="#FF5B5A" stroke="#0D1B2C" strokeWidth="2" />
                {/* Tooltip */}
                <rect x={Math.min(xPos(i) - 45, W - padR - 95)} y={padT + 4} width="90" height="42" rx="6" fill="#0D1B2A" opacity="0.88" />
                <text x={Math.min(xPos(i), W - padR - 50)} y={padT + 17} textAnchor="middle" fontSize="9.5" fill="#5DCAA5" fontFamily="system-ui" fontWeight="600">{m}</text>
                <text x={Math.min(xPos(i), W - padR - 50)} y={padT + 29} textAnchor="middle" fontSize="8.5" fill="#9FE1CB" fontFamily="system-ui">Rev: {fmt(revenues[i])}</text>
                <text x={Math.min(xPos(i), W - padR - 50)} y={padT + 40} textAnchor="middle" fontSize="8.5" fill="#F5A9A9" fontFamily="system-ui">Exp: {fmt(expenses[i])}</text>
              </>
            )}
            <rect
              x={xPos(i) - (i === 0 ? 0 : chartW / (n - 1) / 2)}
              y={padT}
              width={chartW / Math.max(n - 1, 1)}
              height={chartH}
              fill="transparent"
              style={{ cursor: 'crosshair' }}
              onMouseEnter={() => setHovered(i)}
              onMouseLeave={() => setHovered(null)}
            />
          </g>
        ))}

        {/* Dots at ends */}
        {n > 0 && (
          <>
            <circle cx={xPos(n - 1)} cy={yPos(revenues[n - 1])} r="3" fill="#00D47E" stroke="#0D1B2C" strokeWidth="1.5" />
            <circle cx={xPos(n - 1)} cy={yPos(expenses[n - 1])} r="3" fill="#FF5B5A" stroke="#0D1B2C" strokeWidth="1.5" />
          </>
        )}
      </svg>
    </div>
  )
}

// ── Donut Chart ───────────────────────────────────────────
function DonutChart({ segments }: { segments: { label: string; value: number; color: string }[] }) {
  const total = segments.reduce((s, seg) => s + seg.value, 0)
  if (!total) return <div style={{ width: 120, height: 120, borderRadius: '50%', background: 'rgba(255,255,255,0.06)' }} />
  const r = 45
  const cx = 60
  const cy = 60
  let angle = -90

  const arcs = segments.map(seg => {
    const pct = seg.value / total
    const sweep = pct * 360
    const startRad = (angle * Math.PI) / 180
    const endRad = ((angle + sweep) * Math.PI) / 180
    const x1 = cx + r * Math.cos(startRad)
    const y1 = cy + r * Math.sin(startRad)
    const x2 = cx + r * Math.cos(endRad)
    const y2 = cy + r * Math.sin(endRad)
    const largeArc = sweep > 180 ? 1 : 0
    const d = `M ${cx} ${cy} L ${x1} ${y1} A ${r} ${r} 0 ${largeArc} 1 ${x2} ${y2} Z`
    angle += sweep
    return { ...seg, d, pct }
  })

  return (
    <svg width={120} height={120} viewBox="0 0 120 120">
      {arcs.map((arc, i) => (
        <path key={i} d={arc.d} fill={arc.color} fillOpacity="0.9" stroke="#0D1B2C" strokeWidth="1.5" />
      ))}
      <circle cx={cx} cy={cy} r={28} fill="#0D1B2C" />
      <text x={cx} y={cy - 4} textAnchor="middle" fontSize="10" fill="#7A9BB8" fontFamily="system-ui">EXPENSES</text>
      <text x={cx} y={cy + 10} textAnchor="middle" fontSize="9" fill="rgba(255,255,255,0.30)" fontFamily="system-ui">breakdown</text>
    </svg>
  )
}

// ── Horizontal Bar ────────────────────────────────────────
function HBar({ label, value, max, color, sub }: { label: string; value: number; max: number; color: string; sub?: string }) {
  const { format } = useDisplayCurrency()
  const pct = max > 0 ? Math.min((value / max) * 100, 100) : 0
  return (
    <div style={{ marginBottom: '10px' }}>
      <div style={{ display: 'flex', justifyContent: 'space-between', marginBottom: '4px' }}>
        <span style={{ fontSize: '12px', color: '#DCE9F6', fontWeight: '500', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' as const, maxWidth: '60%' }}>{label}</span>
        <span style={{ fontSize: '12px', color: '#7A9BB8', whiteSpace: 'nowrap' as const }}>{format(value, 0)}{sub ? ` · ${sub}` : ''}</span>
      </div>
      <div style={{ height: '5px', background: 'rgba(255,255,255,0.06)', borderRadius: '3px', overflow: 'hidden' }}>
        <div style={{ height: '100%', width: `${pct}%`, background: color, borderRadius: '3px', transition: 'width 0.6s ease' }} />
      </div>
    </div>
  )
}

export default function Dashboard() {
  const { user } = useAuth()
  const { setPage } = useNav()
  // Every figure sums each row's own amount in the display currency; a row
  // with none counts as zero. Switching currency refetches.
  const { currency, pick, format } = useDisplayCurrency()
  const money = (n: number) => format(n, 0)
  const amt = (row: any): number => pick(row) ?? 0
  const [entity, setEntity] = useState<Entity>('all')
  const [dateFrom, setDateFrom] = useState(() => `${new Date().getFullYear()}-01-01`)
  const [dateTo, setDateTo] = useState(() => new Date().toISOString().split('T')[0])
  const [activeShortcut, setActiveShortcut] = useState('YTD')
  const { companies, defaultCompany, showPicker, loading: companiesLoading } = useCompanies()
  const [loading, setLoading] = useState(true)

  const [metrics, setMetrics] = useState({
    totalRevenue: 0, totalExpenses: 0, netProfit: 0,
    unpaidInvoices: 0, openInvoicesCount: 0, payablesTotal: 0, openPayablesCount: 0,
    overdueCount: 0, unmatchedPassthrough: 0,
    prevRevenue: 0, prevExpenses: 0,
  })
  const [monthlyData, setMonthlyData] = useState<{ month: string; revenue: number; expenses: number }[]>([])
  const [expenseByCategory, setExpenseByCategory] = useState<{ label: string; value: number; color: string }[]>([])
  const [topPartners, setTopPartners] = useState<{ name: string; amount: number; type: string }[]>([])
  const [recentActivity, setRecentActivity] = useState<any[]>([])
  const [alerts, setAlerts] = useState<{ type: 'warn' | 'ok' | 'info'; text: string }[]>([])
  // The period's P&L rows by project, kept so the panel can be priced against
  // the project list whenever that arrives. Overhead is not a project and is
  // not ranked; see projectProfitability.
  const [projectRows, setProjectRows] = useState<any[]>([])
  const { projects } = useProjects()
  const topProjects: ProjectProfit[] = projectProfitability(projectRows, currency, projects).projects
    .filter(p => p.revenue !== 0 || p.directCost !== 0)
    .sort((a, b) => b.margin - a.margin)
    .slice(0, 5)

  // One chip for everything together and one per company. Shown only when
  // there is more than one company; with one, "all" IS that company.
  const entities = [
    { id: 'all' as Entity, name: showPicker ? 'All companies' : (defaultCompany?.name || 'All companies'), sub: 'Consolidated', badge: 'ALL', color: '#1D9E75', bg: 'rgba(29,158,117,0.08)' },
    ...companies.map((c, i) => {
      const color = ENTITY_COLORS[i % ENTITY_COLORS.length]
      return {
        id: c.id as Entity, name: c.name, sub: (c.currencies || []).join('/') || c.currency || '',
        badge: c.currency || '', color, bg: `${color}14`,
      }
    }),
  ]

  const shortcuts = [
    { label: 'This month', from: (() => { const d = new Date(); return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-01` })(), to: new Date().toISOString().split('T')[0] },
    { label: 'This quarter', from: (() => { const d = new Date(); const q = Math.floor(d.getMonth() / 3); return `${d.getFullYear()}-${String(q * 3 + 1).padStart(2, '0')}-01` })(), to: new Date().toISOString().split('T')[0] },
    { label: 'YTD', from: `${new Date().getFullYear()}-01-01`, to: new Date().toISOString().split('T')[0] },
    { label: 'Last month', from: (() => { const d = new Date(); d.setMonth(d.getMonth() - 1); return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-01` })(), to: (() => { const d = new Date(); d.setDate(0); return d.toISOString().split('T')[0] })() },
  ]

  const CATEGORY_COLORS = ['#1D9E75', '#185FA5', '#BA7517', '#D4537E', '#7C3AED', '#0891B2', '#DC2626', '#059669']

  const getCompanyId = useCallback(() => (entity === 'all' ? null : entity), [entity])

  const fetchAll = useCallback(async () => {
    setLoading(true)
    const companyId = getCompanyId()
    const today = new Date().toISOString().split('T')[0]

    try {
      // ── P&L entries for period ──
      const plEntries = await fetchAllPages<any>((from, to) => {
        let q = supabase.from('v_pl_entries')
          .select('tx_type,amount_rsd,amount_eur,pl_date,pl_category,partner_id,project_id,project_name')
          .gte('pl_date', dateFrom).lte('pl_date', dateTo)
        if (companyId) q = q.eq('company_id', companyId)
        return q.order('pl_date').order('id').range(from, to)
      })

      setProjectRows(plEntries || [])

      const revenue = (plEntries || []).filter(e => e.tx_type === 'revenue' || e.tx_type === 'invoice_revenue').reduce((s, e) => s + amt(e), 0)
      const expenses = (plEntries || []).filter(e => e.tx_type === 'expense' || e.tx_type === 'invoice_expense').reduce((s, e) => s + amt(e), 0)

      // ── Monthly breakdown ──
      const monthMap: Record<string, { revenue: number; expenses: number }> = {}
      const start = new Date(dateFrom)
      const end = new Date(dateTo)
      for (let d = new Date(start.getFullYear(), start.getMonth(), 1); d <= end; d.setMonth(d.getMonth() + 1)) {
        const key = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}`
        monthMap[key] = { revenue: 0, expenses: 0 }
      }
      ;(plEntries || []).forEach(e => {
        const key = (e.pl_date || '').slice(0, 7)
        if (!monthMap[key]) monthMap[key] = { revenue: 0, expenses: 0 }
        if (e.tx_type === 'revenue' || e.tx_type === 'invoice_revenue') monthMap[key].revenue += amt(e)
        if (e.tx_type === 'expense' || e.tx_type === 'invoice_expense') monthMap[key].expenses += amt(e)
      })
      const monthly = Object.entries(monthMap).sort(([a], [b]) => a.localeCompare(b)).map(([key, v]) => ({
        month: new Date(key + '-01').toLocaleString('en', { month: 'short' }),
        ...v,
      }))
      setMonthlyData(monthly)

      // ── Expense by category ──
      const catMap: Record<string, number> = {}
      ;(plEntries || []).filter(e => e.tx_type === 'expense' || e.tx_type === 'invoice_expense').forEach(e => {
        const cat = e.pl_category || 'Other'
        catMap[cat] = (catMap[cat] || 0) + amt(e)
      })
      const cats = Object.entries(catMap).sort(([, a], [, b]) => b - a).slice(0, 6).map(([label, value], i) => ({
        label, value, color: CATEGORY_COLORS[i % CATEGORY_COLORS.length]
      }))
      setExpenseByCategory(cats)

      // ── Open invoices ──
      const openInv = await fetchAllPages<any>((from, to) => {
        let q = supabase.from('v_invoice_status')
          .select('type,calculated_status,remaining_rsd,remaining_eur,due_date,partner_name,amount_rsd,amount_eur')
          .in('calculated_status', ['unpaid', 'partial'])
        if (companyId) q = q.eq('company_id', companyId)
        return q.order('due_date', { nullsFirst: false }).order('id').range(from, to)
      })
      // What investors owe us and what we owe suppliers are kept apart: added
      // together they make a number that is neither.
      const receivables = openInv.filter(i => i.type === 'revenue')
      const payables = openInv.filter(i => i.type !== 'revenue')
      const unpaidTotal = receivables.reduce((s, i) => s + (pick(i, 'remaining') ?? 0), 0)
      const payablesTotal = payables.reduce((s, i) => s + (pick(i, 'remaining') ?? 0), 0)
      const overdueCount = receivables.filter(i => i.due_date && i.due_date < today).length
      const overduePayables = payables.filter(i => i.due_date && i.due_date < today).length

      // ── Pass-through unmatched ──
      // Counted server-side: downloading the rows only to measure the array
      // capped this alert at 1000 while the real figure was near 4000.
      const unmatchedPt = await countRows((() => {
        let q = supabase.from('passthrough')
          .select('id', { count: 'exact', head: true }).eq('status', 'unpaired')
        if (companyId) q = q.eq('company_id', companyId)
        return q
      })())

      // ── Top partners by transaction volume ──
      const txData = await fetchAllPages<any>((from, to) => {
        let q = supabase.from('transactions')
          .select('amount_rsd, amount_eur, partners!transactions_partner_id_fkey(name,type)')
          .gte('transaction_date', dateFrom).lte('transaction_date', dateTo)
          .not('partner_id', 'is', null)
        if (companyId) q = q.eq('company_id', companyId)
        return q.order('transaction_date').order('id').range(from, to)
      })
      const partnerMap: Record<string, { amount: number; type: string }> = {}
      txData.forEach((t: any) => {
        const name = t.partners?.name || 'Unknown'
        const type = t.partners?.type || 'vendor'
        if (!partnerMap[name]) partnerMap[name] = { amount: 0, type }
        partnerMap[name].amount += amt(t)
      })
      const topP = Object.entries(partnerMap).sort(([, a], [, b]) => b.amount - a.amount).slice(0, 5).map(([name, v]) => ({ name, ...v }))
      setTopPartners(topP)

      // ── Recent activity ──
      let actQ = supabase.from('transactions')
        .select('transaction_date,type,amount,currency,amount_rsd,amount_eur,partners!transactions_partner_id_fkey(name),companies!transactions_company_id_fkey(name)')
        .order('transaction_date', { ascending: false }).limit(5)
      if (companyId) actQ = actQ.eq('company_id', companyId)
      const { data: actData } = await actQ
      setRecentActivity(actData || [])

      // ── Alerts ──
      const newAlerts: { type: 'warn' | 'ok' | 'info'; text: string }[] = []
      if (overdueCount > 0) newAlerts.push({ type: 'warn', text: `${overdueCount} overdue receivable${overdueCount > 1 ? 's' : ''}` })
      if (overduePayables > 0) newAlerts.push({ type: 'warn', text: `${overduePayables} overdue supplier invoice${overduePayables > 1 ? 's' : ''}` })
      if (receivables.length > 0) newAlerts.push({ type: 'info', text: `${receivables.length} open receivable${receivables.length > 1 ? 's' : ''} · ${money(unpaidTotal)} to collect` })
      if (payables.length > 0) newAlerts.push({ type: 'info', text: `${payables.length} open supplier invoice${payables.length > 1 ? 's' : ''} · ${money(payablesTotal)} to pay` })
      if (unmatchedPt > 0) newAlerts.push({ type: 'warn', text: `${unmatchedPt} unpaired pass-through entries` })
      if (newAlerts.length === 0) newAlerts.push({ type: 'ok', text: 'All clear — no pending alerts' })

      setMetrics({
        totalRevenue: revenue, totalExpenses: expenses, netProfit: revenue - expenses,
        unpaidInvoices: unpaidTotal, openInvoicesCount: receivables.length,
        payablesTotal, openPayablesCount: payables.length,
        overdueCount, unmatchedPassthrough: unmatchedPt,
        prevRevenue: 0, prevExpenses: 0,
      })
      setAlerts(newAlerts)
    } catch (err) { console.error('Dashboard error:', err) }
    setLoading(false)
  }, [dateFrom, dateTo, getCompanyId, currency]) // eslint-disable-line

  useEffect(() => {
    if (!companiesLoading) fetchAll()
  }, [fetchAll, companiesLoading])

  const hour = new Date().getHours()
  const greeting = hour < 12 ? 'Good morning' : hour < 17 ? 'Good afternoon' : 'Good evening'
  const username = user?.email?.split('@')[0] ?? 'admin'
  const margin = metrics.totalRevenue > 0 ? (metrics.netProfit / metrics.totalRevenue * 100) : 0
  const activeEntity = entities.find(e => e.id === entity) || entities[0]

  const sparkRevenue = monthlyData.map(m => m.revenue)
  const sparkExpenses = monthlyData.map(m => m.expenses)
  const maxPartner = topPartners[0]?.amount || 1

  return (
    <div style={s.root} className="app-surface">
      <div style={s.body}>

        {/* HEADER */}
        <div style={{ display: 'flex', alignItems: 'flex-end', justifyContent: 'space-between', marginBottom: '2rem' }}>
          <div>
            <div style={s.greetingDate}>{new Date().toLocaleDateString('en-US', { weekday: 'long', year: 'numeric', month: 'long', day: 'numeric' }).toUpperCase()}</div>
            <h1 style={s.greetingTitle}>{greeting}, <span style={{ color: '#00D47E', fontStyle: 'italic' }}>{username}</span></h1>
          </div>
          {/* Period bar inline */}
          <div style={{ display: 'flex', alignItems: 'center', gap: '8px', flexWrap: 'wrap' as const }}>
            <div style={s.segmented}>
              {shortcuts.map(sc => (
                <button key={sc.label}
                  style={activeShortcut === sc.label ? { ...s.shortcutBtn, ...s.shortcutActive } : s.shortcutBtn}
                  onClick={() => { setDateFrom(sc.from); setDateTo(sc.to); setActiveShortcut(sc.label) }}>
                  {sc.label}
                </button>
              ))}
            </div>
            <input type="date" value={dateFrom} onChange={e => { setDateFrom(e.target.value); setActiveShortcut('') }} style={s.dateInput} />
            <span style={{ color: 'rgba(255,255,255,0.30)', fontSize: '12px' }}>→</span>
            <input type="date" value={dateTo} onChange={e => { setDateTo(e.target.value); setActiveShortcut('') }} style={s.dateInput} />
          </div>
        </div>

        {/* ENTITY SELECTOR — only when there is a company to choose */}
        {showPicker && <div style={s.entityRow}>
          {entities.map(e => {
            const active = entity === e.id
            return (
              <div key={e.id} style={{ ...s.entityChip, ...(active ? { ...s.entityChipActive, borderColor: e.color, background: e.bg } : {}) }}
                onClick={() => setEntity(e.id)}>
                <div style={{ ...s.entityDot, background: active ? e.color : 'rgba(255,255,255,0.15)' }} />
                <div>
                  <div style={{ fontSize: '13px', fontWeight: active ? '600' : '400', color: active ? '#fff' : 'rgba(255,255,255,0.44)' }}>{e.name}</div>
                  <div style={{ fontSize: '10px', color: active ? e.color : '#7A9BB8', fontWeight: '500' }}>{e.sub}</div>
                </div>
                <div style={{ ...s.entityBadgePill, background: active ? e.color : 'rgba(255,255,255,0.06)', color: active ? '#fff' : 'rgba(255,255,255,0.30)' }}>{e.badge}</div>
              </div>
            )
          })}
        </div>}

        {/* TOP METRIC CARDS */}
        {/* Staggered so the row assembles in reading order rather than
            flickering into place all at once. */}
        <div style={s.metricsRow}>
          <Rise delay={0}>
          <MetricCard
            label="Total Revenue"
            value={loading ? '—' : money(metrics.totalRevenue)}
            amount={loading ? undefined : metrics.totalRevenue}
            format={money}
            sub={`YTD ${activeEntity.name}`}
            color="#00D47E"
            darkColor="#00D47E"
            sparklineData={sparkRevenue}
          />
          </Rise>
          <Rise delay={55}>
          <MetricCard
            label="Total Expenses"
            value={loading ? '—' : money(metrics.totalExpenses)}
            amount={loading ? undefined : metrics.totalExpenses}
            format={money}
            sub={metrics.totalRevenue > 0 ? `${((metrics.totalExpenses / metrics.totalRevenue) * 100).toFixed(0)}% of revenue` : 'No revenue'}
            color="#FF5B5A"
            darkColor="#FF5B5A"
            sparklineData={sparkExpenses}
          />
          </Rise>
          <Rise delay={110}>
          <MetricCard
            label="Net Profit / Loss"
            value={loading ? '—' : money(metrics.netProfit)}
            amount={loading ? undefined : metrics.netProfit}
            format={money}
            sub={`${margin.toFixed(1)}% margin`}
            color={metrics.netProfit >= 0 ? '#00D47E' : '#FF5B5A'}
            darkColor={metrics.netProfit >= 0 ? '#00D47E' : '#FF5B5A'}
            sparklineData={monthlyData.map(m => m.revenue - m.expenses)}
          />
          </Rise>
          <Rise delay={165}>
          <MetricCard
            label="Receivables"
            value={loading ? '—' : metrics.openInvoicesCount > 0 ? money(metrics.unpaidInvoices) : fmtMoney(0, currency, 0)}
            sub={`${metrics.openInvoicesCount} open${metrics.overdueCount > 0 ? ` · ${metrics.overdueCount} overdue` : ''} · payables ${money(metrics.payablesTotal)}`}
            color={metrics.overdueCount > 0 ? '#F5A623' : '#00D47E'}
            darkColor={metrics.overdueCount > 0 ? '#F5A623' : '#00D47E'}
            sparklineData={[]}
          />
          </Rise>
        </div>

        {/* MAIN GRID */}
        <div style={s.mainGrid}>

          {/* LEFT COLUMN */}
          <div style={{ display: 'flex', flexDirection: 'column' as const, gap: '14px' }}>

            {/* Revenue vs Expenses Bar Chart */}
            <div style={s.card}>
              <div style={s.cardHeader}>
                <div style={s.cardTitle}>Revenue vs Expenses</div>
                <div style={{ display: 'flex', gap: '12px' }}>
                  <div style={{ display: 'flex', alignItems: 'center', gap: '5px' }}>
                    <div style={{ width: '10px', height: '10px', borderRadius: '2px', background: '#1D9E75', opacity: 0.85 }} />
                    <span style={{ fontSize: '11px', color: '#7A9BB8' }}>Revenue</span>
                  </div>
                  <div style={{ display: 'flex', alignItems: 'center', gap: '5px' }}>
                    <div style={{ width: '10px', height: '10px', borderRadius: '2px', background: '#E24B4A', opacity: 0.7 }} />
                    <span style={{ fontSize: '11px', color: '#7A9BB8' }}>Expenses</span>
                  </div>
                </div>
              </div>
              {loading ? (
                <div style={{ padding: "8px 4px" }}>
                    <SkeletonRows rows={6} height={16} gap={14}
                      widths={[70, 92, 58, 84, 96, 44]} />
                  </div>
              ) : monthlyData.length === 0 ? (
                <div style={s.emptyBox}>No data for selected period</div>
              ) : (
                <div style={{ padding: '0 4px' }}>
                  <AreaChart
                    months={monthlyData.map(m => m.month)}
                    revenues={monthlyData.map(m => m.revenue)}
                    expenses={monthlyData.map(m => m.expenses)}
                  />
                </div>
              )}
            </div>

            {/* Expense Breakdown + Top Partners side by side */}
            <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '14px' }}>

              {/* Expense by Category */}
              <div style={s.card}>
                <div style={s.cardHeader}>
                  <div style={s.cardTitle}>Expense breakdown</div>
                </div>
                {loading ? <SkeletonRows rows={6} /> : expenseByCategory.length === 0 ? (
                  <div style={s.emptyBox}>No expenses</div>
                ) : (
                  <div style={{ display: 'flex', gap: '16px', alignItems: 'flex-start' }}>
                    <DonutChart segments={expenseByCategory} />
                    <div style={{ flex: 1, paddingTop: '8px' }}>
                      {expenseByCategory.map(cat => (
                        <div key={cat.label} style={{ display: 'flex', alignItems: 'center', gap: '6px', marginBottom: '7px' }}>
                          <div style={{ width: '8px', height: '8px', borderRadius: '2px', background: cat.color, flexShrink: 0 }} />
                          <span style={{ fontSize: '11px', color: '#7A9BB8', flex: 1, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' as const }}>{cat.label}</span>
                          <span style={{ fontSize: '11px', fontWeight: '500', color: '#DCE9F6', whiteSpace: 'nowrap' as const }}>{money(cat.value)}</span>
                        </div>
                      ))}
                    </div>
                  </div>
                )}
              </div>

              {/* Top Partners */}
              <div style={s.card}>
                <div style={s.cardHeader}>
                  <div style={s.cardTitle}>Top partners</div>
                  <span style={{ fontSize: '10px', color: 'rgba(255,255,255,0.30)' }}>by volume</span>
                </div>
                {loading ? <SkeletonRows rows={5} /> : topPartners.length === 0 ? (
                  <div style={s.emptyBox}>No partner data</div>
                ) : (
                  <div>
                    {topPartners.map((p, i) => (
                      <HBar
                        key={p.name}
                        label={p.name}
                        value={p.amount}
                        max={maxPartner}
                        color={i === 0 ? '#0C447C' : i === 1 ? '#185FA5' : i === 2 ? '#4A90D9' : '#7FB8EE'}
                        sub={p.type}
                      />
                    ))}
                  </div>
                )}
              </div>
            </div>

            {/* Recent activity */}
            <div style={s.card}>
              <div style={s.cardHeader}>
                <div style={s.cardTitle}>Recent transactions</div>
                <button style={s.cardLink} onClick={() => setPage('transactions')}>View all →</button>
              </div>
              {loading ? <SkeletonRows rows={5} height={14} /> : recentActivity.length === 0 ? (
                <div style={s.emptyBox}>No transactions yet</div>
              ) : (
                <table style={{ width: '100%', borderCollapse: 'collapse' as const, fontSize: '12px' }}>
                  <thead>
                    <tr>
                      {['Date', 'Partner', 'Type', 'Amount', currency].map(h => (
                        <th key={h} style={{ textAlign: 'left' as const, padding: '0 0 8px', fontSize: '9.5px', color: 'rgba(255,255,255,0.30)', fontWeight: '600', textTransform: 'uppercase' as const, letterSpacing: '0.09em' }}>{h}</th>
                      ))}
                    </tr>
                  </thead>
                  <tbody>
                    {recentActivity.map((t, i) => (
                      <tr key={i} style={{ borderTop: '1px solid rgba(255,255,255,0.07)' }}>
                        <td style={{ padding: '8px 0', color: '#7A9BB8', whiteSpace: 'nowrap' as const }}>{t.transaction_date}</td>
                        <td style={{ padding: '8px 8px 8px 0', fontWeight: '500', color: '#DCE9F6', maxWidth: '130px', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' as const }}>{(t.partners as any)?.name || '—'}</td>
                        <td style={{ padding: '8px 8px 8px 0' }}>
                          <span style={{ fontSize: '10px', fontWeight: '500', padding: '2px 7px', borderRadius: '20px', background: t.type === 'direct' ? 'rgba(0,212,126,0.12)' : 'rgba(78,168,255,0.13)', color: t.type === 'direct' ? '#00D47E' : '#4EA8FF' }}>
                            {t.type === 'invoice_payment' ? 'Inv. pay' : t.type}
                          </span>
                        </td>
                        <td style={{ padding: '8px 8px 8px 0', fontWeight: '500', color: '#DCE9F6', whiteSpace: 'nowrap' as const }}>{fmtMoney(t.amount || 0, t.currency || 'RSD')}</td>
                        <td style={{ padding: '8px 0', fontWeight: '500', color: '#00D47E', whiteSpace: 'nowrap' as const }}>{format(pick(t))}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              )}
            </div>
          </div>

          {/* RIGHT COLUMN */}
          <div style={{ display: 'flex', flexDirection: 'column' as const, gap: '14px' }}>

            {/* Alerts */}
            <div style={s.card}>
              <div style={s.cardHeader}>
                <div style={s.cardTitle}>Alerts</div>
                <span style={{ fontSize: '10px', background: alerts.some(a => a.type === 'warn') ? '#FCEBEB' : '#E1F5EE', color: alerts.some(a => a.type === 'warn') ? '#A32D2D' : '#085041', padding: '2px 8px', borderRadius: '20px', fontWeight: '500' }}>
                  {alerts.length}
                </span>
              </div>
              {loading ? <SkeletonRows rows={3} height={16} widths={[88, 72, 80]} /> : alerts.map((a, i) => (
                <div key={i} style={{ display: 'flex', alignItems: 'flex-start', gap: '10px', padding: '8px 10px', borderRadius: '8px', marginBottom: '5px', background: a.type === 'ok' ? '#E1F5EE' : a.type === 'warn' ? 'rgba(186,117,23,0.10)' : '#E6F1FB' }}>
                  <div style={{ width: '6px', height: '6px', borderRadius: '50%', marginTop: '5px', flexShrink: 0, background: a.type === 'ok' ? '#1D9E75' : a.type === 'warn' ? '#BA7517' : '#185FA5' }} />
                  <span style={{ fontSize: '11px', color: '#111', lineHeight: '1.5' }}>{a.text}</span>
                </div>
              ))}
            </div>

            {/* Top projects by margin: revenue less the project's own direct
                cost, for the period on screen. Overhead stays off the list —
                it is nobody's margin — and is on the Projects page. */}
            {topProjects.length > 0 && (
              <div style={s.card}>
                <div style={s.cardHeader}>
                  <div style={s.cardTitle}>Top projects by margin</div>
                  <span style={{ fontSize: '11px', color: '#7A9BB8', cursor: 'pointer' }} onClick={() => setPage('projects')}>All →</span>
                </div>
                {topProjects.map(p => (
                  <div key={p.projectId || 'overhead'} style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', padding: '7px 0', borderBottom: '1px solid rgba(255,255,255,0.07)' }}>
                    <span style={{ fontSize: '12px', color: '#DCE9F6', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' as const, maxWidth: '140px' }} title={p.label}>{p.label}</span>
                    <span style={{ fontSize: '12px', fontWeight: '600', color: p.margin >= 0 ? '#00D47E' : '#FF5B5A', whiteSpace: 'nowrap' as const }}>
                      {money(p.margin)}{p.marginPct !== null ? ` · ${p.marginPct.toFixed(1)}%` : ''}
                    </span>
                  </div>
                ))}
              </div>
            )}

            {/* At a glance */}
            <div style={s.card}>
              <div style={s.cardHeader}>
                <div style={s.cardTitle}>At a glance</div>
              </div>
              {[
                { label: 'Net margin', value: `${margin.toFixed(1)}%`, color: margin >= 0 ? '#00D47E' : '#FF5B5A' },
                { label: 'Pass-through unpaired', value: String(metrics.unmatchedPassthrough), color: metrics.unmatchedPassthrough > 0 ? '#F5A623' : '#00D47E' },
                { label: 'Overdue invoices', value: String(metrics.overdueCount), color: metrics.overdueCount > 0 ? '#FF5B5A' : '#00D47E' },
                { label: 'Open invoices', value: String(metrics.openInvoicesCount), color: '#7A9BB8' },
                { label: 'Expense categories', value: String(expenseByCategory.length), color: '#7A9BB8' },
                { label: 'Active partners', value: String(topPartners.length), color: '#7A9BB8' },
              ].map(item => (
                <div key={item.label} style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', padding: '7px 0', borderBottom: '1px solid rgba(255,255,255,0.07)' }}>
                  <span style={{ fontSize: '12px', color: '#7A9BB8' }}>{item.label}</span>
                  <span style={{ fontSize: '13px', fontWeight: '600', color: loading ? '#ccc' : item.color }}>{loading ? '...' : item.value}</span>
                </div>
              ))}
            </div>

            {/* Quick actions */}
            <div style={s.card}>
              <div style={s.cardHeader}>
                <div style={s.cardTitle}>Quick actions</div>
              </div>
              {[
                { label: 'New invoice', icon: '📄', page: 'transactions' as Page, color: '#1D9E75' },
                { label: 'New transaction', icon: '💳', page: 'transactions' as Page, color: '#0C447C' },
                { label: 'Bulk import', icon: '📥', page: 'transactions' as Page, color: '#633806' },
                { label: 'P&L analysis', icon: '📊', page: 'expenses' as Page, color: '#185FA5' },
                { label: 'Cash Flow', icon: '💧', page: 'cashflow' as Page, color: '#0891B2' },
                { label: 'Partners', icon: '🤝', page: 'partners' as Page, color: '#BA7517' },
              ].map(action => (
                <button key={action.label} style={s.quickBtn} onClick={() => setPage(action.page)}>
                  <span style={{ fontSize: '15px' }}>{action.icon}</span>
                  <span style={{ fontSize: '13px', color: '#DCE9F6' }}>{action.label}</span>
                  <span style={{ marginLeft: 'auto', fontSize: '12px', color: 'rgba(255,255,255,0.30)' }}>→</span>
                </button>
              ))}
            </div>

          </div>
        </div>
      </div>
    </div>
  )
}

const s: Record<string, React.CSSProperties> = {
  // The background lives in `.app-surface` rather than here, because an
  // inline colour would paint over it.
  root: { minHeight: '100vh', fontFamily: "'Inter', system-ui, sans-serif" },
  // 1400 left about three hundred pixels of dark margin on a wide screen —
  // not a design decision, a leftover. 1680 uses the room the sidebar does
  // not, and still stops a table growing lines nobody can track across.
  body: { padding: '24px 28px', maxWidth: '1680px', margin: '0 auto' },
  greetingDate: { fontSize: '10px', color: 'rgba(255,255,255,0.30)', letterSpacing: '0.13em', marginBottom: '4px', fontWeight: '600', textTransform: 'uppercase' as const },
  greetingTitle: { fontFamily: "'DM Serif Display', Georgia, serif", fontSize: '28px', fontWeight: '400', color: '#DCE9F6', margin: '0', lineHeight: '1.2' },
  segmented: { display: 'flex', gap: '2px', background: 'rgba(255,255,255,0.08)', borderRadius: '9px', padding: '3px' },
  shortcutBtn: { fontFamily: "'Inter', system-ui, sans-serif", fontSize: '11px', border: 'none', borderRadius: '6px', padding: '5px 11px', background: 'transparent', color: 'rgba(255,255,255,0.44)', cursor: 'pointer', whiteSpace: 'nowrap' as const, fontWeight: '500' },
  shortcutActive: { background: 'rgba(255,255,255,0.16)', color: '#fff', boxShadow: '0 1px 4px rgba(0,0,0,0.12)' },
  dateInput: { fontFamily: "'Inter', system-ui, sans-serif", fontSize: '12px', border: '1px solid rgba(255,255,255,0.075)', borderRadius: '7px', padding: '5px 9px', color: '#DCE9F6', background: '#111F30' },
  entityRow: { display: 'flex', gap: '8px', marginBottom: '16px', flexWrap: 'wrap' as const },
  entityChip: { display: 'flex', alignItems: 'center', gap: '10px', padding: '8px 14px', borderRadius: '9px', background: 'transparent', border: '1px solid rgba(255,255,255,0.10)', cursor: 'pointer', flex: '1', minWidth: '150px', transition: 'border-color 0.15s, background 0.15s' },
  entityChipActive: { border: '1.5px solid', boxShadow: '0 1px 4px rgba(0,0,0,0.3)' },
  entityDot: { width: '7px', height: '7px', borderRadius: '50%', flexShrink: 0 },
  entityBadgePill: { marginLeft: 'auto', fontSize: '9px', fontWeight: '700', padding: '2px 7px', borderRadius: '20px', letterSpacing: '0.06em', flexShrink: 0 },
  metricsRow: { display: 'grid', gridTemplateColumns: 'repeat(4,1fr)', gap: '12px', marginBottom: '14px' },
  mainGrid: { display: 'grid', gridTemplateColumns: '1fr 280px', gap: '12px' },
  card: { background: '#0D1B2C', borderRadius: '10px', padding: '1rem 1.2rem', boxShadow: '0 4px 20px rgba(0,0,0,0.4)', border: '1px solid rgba(255,255,255,0.075)' },
  cardHeader: { display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: '14px' },
  cardTitle: { fontSize: '12px', fontWeight: '600', color: '#DCE9F6', letterSpacing: '-0.01em' },
  cardLink: { fontSize: '12px', color: '#00D47E', background: 'none', border: 'none', cursor: 'pointer', fontFamily: "'Inter', system-ui, sans-serif", padding: 0 },
  loadingBox: { padding: '24px', textAlign: 'center' as const, color: 'rgba(255,255,255,0.30)', fontSize: '12px' },
  emptyBox: { padding: '24px', textAlign: 'center' as const, color: 'rgba(255,255,255,0.30)', fontSize: '12px' },
  quickBtn: { display: 'flex', alignItems: 'center', gap: '10px', width: '100%', background: 'rgba(255,255,255,0.04)', border: '1px solid rgba(255,255,255,0.075)', borderRadius: '8px', padding: '8px 11px', fontFamily: "'Inter', system-ui, sans-serif", cursor: 'pointer', marginBottom: '5px', textAlign: 'left' as const, transition: 'background 0.15s' },
}