// ─── Projekti ───────────────────────────────────────────────────────────────
//
// The construction sites and rental buildings, and what each of them earned
// over a period: its revenue less its own direct costs, from v_pl_entries.
// Costs and income with no project are company overhead and get their own
// row — they are not spread over the projects (see services/projects.ts).

import React, { useCallback, useEffect, useMemo, useState } from 'react'
import { supabase } from '../supabase'
import { SkeletonRows } from '../components/motion'
import { PageHeader } from '../components/PageHeader'
import ProjectDialog from '../components/ProjectDialog'
import { useCompanies } from '../contexts/CompaniesContext'
import { useProjects } from '../contexts/ProjectsContext'
import { useDisplayCurrency } from '../contexts/DisplayCurrencyContext'
import { fetchAllPartners } from '../services/allPartners'
import { fetchAllPages } from '../utils/fetchAllPages'
import { fmtMoney } from '../utils/formatters'
import {
  PROJECT_KIND_LABEL, projectLabel, projectProfitability,
  type PlEntryForProject, type Project, type ProjectProfit,
} from '../services/projects'

const isoToday = () => new Date().toISOString().slice(0, 10)
const yearStart = () => `${new Date().getFullYear()}-01-01`

function fetchPlEntries(dateFrom: string, dateTo: string, companyId: string | null): Promise<PlEntryForProject[]> {
  return fetchAllPages<PlEntryForProject>((from, to) => {
    let q = supabase.from('v_pl_entries')
      .select('id, tx_type, amount_rsd, amount_eur, project_id, project_name')
      .gte('pl_date', dateFrom).lte('pl_date', dateTo)
    if (companyId) q = q.eq('company_id', companyId)
    return q.order('pl_date').order('id').range(from, to)
  })
}

export default function Projects() {
  const { defaultCompany } = useCompanies()
  const { projects, loading, error: loadError, refresh } = useProjects()
  const { currency, format } = useDisplayCurrency()
  const companyId = defaultCompany?.id ?? null

  const [partners, setPartners] = useState<Map<string, string>>(new Map())
  const [search, setSearch] = useState('')
  const [showInactive, setShowInactive] = useState(false)
  const [editing, setEditing] = useState<Project | null>(null)
  const [dialogOpen, setDialogOpen] = useState(false)

  const [dateFrom, setDateFrom] = useState(yearStart())
  const [dateTo, setDateTo] = useState(isoToday())
  const [entries, setEntries] = useState<PlEntryForProject[]>([])
  const [entriesLoading, setEntriesLoading] = useState(true)
  const [entriesError, setEntriesError] = useState('')

  useEffect(() => {
    fetchAllPartners<{ id: string; name: string }>(supabase, 'id, name')
      .then(rows => setPartners(new Map(rows.map(r => [r.id, r.name]))))
      .catch(() => setPartners(new Map()))
  }, [])

  const loadEntries = useCallback(async () => {
    if (!dateFrom || !dateTo) return
    setEntriesLoading(true)
    try {
      setEntries(await fetchPlEntries(dateFrom, dateTo, companyId))
      setEntriesError('')
    } catch (e: any) {
      setEntries([])
      setEntriesError(`Knjiženja nisu učitana: ${e?.message || e}`)
    } finally {
      setEntriesLoading(false)
    }
  }, [dateFrom, dateTo, companyId])

  useEffect(() => { loadEntries() }, [loadEntries])

  const companyProjects = useMemo(
    () => projects.filter(p => !companyId || p.company_id === companyId), [projects, companyId])

  const listed = useMemo(() => {
    const q = search.trim().toLowerCase()
    return companyProjects.filter(p =>
      (showInactive || p.active) &&
      (!q || projectLabel(p).toLowerCase().includes(q)
        || (partners.get(p.investor_partner_id || '') || '').toLowerCase().includes(q)))
  }, [companyProjects, search, showInactive, partners])

  const profit = useMemo(
    () => projectProfitability(entries, currency, companyProjects), [entries, currency, companyProjects])

  // A closed project with nothing in the period is noise; one with entries is not.
  const profitRows = profit.projects.filter(r => {
    const p = companyProjects.find(x => x.id === r.projectId)
    return (p?.active ?? false) || r.revenue !== 0 || r.directCost !== 0
  })

  const openNew = () => { setEditing(null); setDialogOpen(true) }
  const openEdit = (p: Project) => { setEditing(p); setDialogOpen(true) }
  const onSaved = async () => { setDialogOpen(false); setEditing(null); await refresh(); loadEntries() }

  const active = companyProjects.filter(p => p.active)

  return (
    <div style={s.root} className="app-surface">
      <div style={s.body}>
        <PageHeader title="Projekti" subtitle="Gradilišta i objekti u zakupu — prihodi, direktni troškovi i marža po projektu"
          right={<button style={s.newBtn} onClick={openNew} disabled={!companyId}>+ Novi projekat</button>} />

        <div style={s.summaryRow}>
          <Summary label="Aktivni projekti" value={String(active.length)} />
          <Summary label="Gradilišta" value={String(active.filter(p => p.kind === 'construction').length)} />
          <Summary label="Objekti u zakupu" value={String(active.filter(p => p.kind === 'rental').length)} />
          <Summary label={`Marža ukupno · ${currency}`} value={format(profit.total.margin, 0)}
            color={profit.total.margin < 0 ? '#FF5B5A' : '#00D47E'} />
        </div>

        {loadError && <div style={s.error} role="alert">{loadError}</div>}

        <div style={s.sectionTitle}>Projekti</div>
        <div style={s.filterBar}>
          <input type="text" placeholder="Pretraži naziv, šifru ili investitora…" value={search}
            onChange={e => setSearch(e.target.value)} style={s.searchInput} />
          <label style={s.checkLabel}>
            <input type="checkbox" checked={showInactive} onChange={e => setShowInactive(e.target.checked)} />
            Prikaži i zatvorene
          </label>
          <div style={s.totalBadge}>{listed.length} projekata</div>
        </div>

        <div style={s.tableWrap}>
          {loading ? (
            <div style={{ padding: '18px 16px' }}>
              <SkeletonRows rows={5} height={15} gap={14} widths={[78, 60, 84, 50, 40]} />
            </div>
          ) : listed.length === 0 ? (
            <div style={s.emptyState}>
              <div style={{ fontSize: '15px', fontWeight: '500', color: '#DCE9F6', marginBottom: '6px' }}>
                {companyProjects.length === 0 ? 'Još nema projekata' : 'Nijedan projekat ne odgovara pretrazi'}
              </div>
              {companyProjects.length === 0 && (
                <>
                  <div style={{ fontSize: '13px', color: '#7A9BB8', marginBottom: '20px' }}>
                    Dodajte prvo gradilište ili objekat u zakupu.
                  </div>
                  <button style={s.newBtn} onClick={openNew} disabled={!companyId}>+ Novi projekat</button>
                </>
              )}
            </div>
          ) : (
            <table style={s.table}>
              <thead>
                <tr style={s.thead}>
                  <th style={s.th}>Naziv</th>
                  <th style={s.th}>Vrsta</th>
                  <th style={s.th}>Investitor</th>
                  <th style={{ ...s.th, textAlign: 'right' }}>Vrednost ugovora</th>
                  <th style={s.th}>Status</th>
                </tr>
              </thead>
              <tbody>
                {listed.map((p, i) => (
                  <tr key={p.id} style={{ ...s.tr, background: i % 2 === 0 ? '#0D1B2C' : '#111F30', cursor: 'pointer' }}
                    onClick={() => openEdit(p)}>
                    <td style={s.td}>
                      <div style={{ fontWeight: 600, color: '#00D47E' }}>{p.name}</div>
                      {p.code && <div style={s.subCell}>{p.code}</div>}
                    </td>
                    <td style={s.td}>
                      <span style={{ ...s.badge, ...(p.kind === 'rental' ? s.badgeRental : s.badgeSite) }}>
                        {PROJECT_KIND_LABEL[p.kind]}
                      </span>
                    </td>
                    <td style={s.td}><span style={s.smallCell}>{partners.get(p.investor_partner_id || '') || '—'}</span></td>
                    <td style={{ ...s.td, ...s.num }}>
                      {p.contract_value !== null && p.contract_currency ? fmtMoney(p.contract_value, p.contract_currency) : '—'}
                    </td>
                    <td style={s.td}>
                      <span style={{ ...s.badge, ...(p.active ? s.badgeActive : s.badgeClosed) }}>
                        {p.active ? 'Aktivan' : 'Zatvoren'}
                      </span>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </div>

        <div style={{ ...s.sectionTitle, marginTop: '2rem' }}>Profitabilnost po projektu</div>
        <div style={s.filterBar}>
          <label style={s.dateLabel}>Od
            <input type="date" style={s.filterInput} value={dateFrom} onChange={e => setDateFrom(e.target.value)} />
          </label>
          <label style={s.dateLabel}>Do
            <input type="date" style={s.filterInput} value={dateTo} onChange={e => setDateTo(e.target.value)} />
          </label>
          <div style={s.totalBadge}>Iznosi u {currency}</div>
        </div>

        {entriesError && <div style={s.error} role="alert">{entriesError}</div>}

        <div style={s.tableWrap}>
          {entriesLoading ? (
            <div style={{ padding: '18px 16px' }}>
              <SkeletonRows rows={4} height={15} gap={14} widths={[70, 90, 80, 60]} />
            </div>
          ) : (
            <table style={s.table}>
              <thead>
                <tr style={s.thead}>
                  <th style={s.th}>Projekat</th>
                  <th style={{ ...s.th, textAlign: 'right' }}>Prihodi</th>
                  <th style={{ ...s.th, textAlign: 'right' }}>Direktni troškovi</th>
                  <th style={{ ...s.th, textAlign: 'right' }}>Marža</th>
                  <th style={{ ...s.th, textAlign: 'right' }}>Marža %</th>
                </tr>
              </thead>
              <tbody>
                {profitRows.map((r, i) => <ProfitRow key={r.projectId || i} r={r} format={format} striped={i % 2 === 1} />)}
                <ProfitRow r={profit.overhead} format={format} striped={profitRows.length % 2 === 1} muted />
                <ProfitRow r={profit.total} format={format} total />
              </tbody>
            </table>
          )}
        </div>
        {profit.total.unconverted > 0 && (
          <div style={s.note}>
            {profit.total.unconverted} knjiženja nemaju iznos u {currency} i računata su kao 0.
          </div>
        )}
        <div style={s.note}>
          Opšti troškovi su prihodi i troškovi bez projekta. Ne raspoređuju se na projekte.
        </div>
      </div>

      {dialogOpen && companyId && (
        <ProjectDialog project={editing} companyId={companyId} existing={companyProjects}
          onClose={() => { setDialogOpen(false); setEditing(null) }} onSaved={onSaved} />
      )}
    </div>
  )
}

function Summary({ label, value, color }: { label: string; value: string; color?: string }) {
  return (
    <div style={s.summaryCard}>
      <div style={s.summaryLabel}>{label}</div>
      <div style={{ ...s.summaryVal, ...(color ? { color } : {}) }}>{value}</div>
    </div>
  )
}

function ProfitRow({ r, format, striped, muted, total }: {
  r: ProjectProfit
  format: (n: number | null | undefined, decimals?: number) => string
  striped?: boolean
  muted?: boolean
  total?: boolean
}) {
  const marginColor = r.margin < 0 ? '#FF5B5A' : r.margin > 0 ? '#00D47E' : '#7A9BB8'
  return (
    <tr style={{
      ...s.tr,
      background: total ? '#060E1A' : striped ? '#111F30' : '#0D1B2C',
      ...(total ? { borderTop: '1px solid rgba(255,255,255,0.12)' } : {}),
    }}>
      <td style={{ ...s.td, fontWeight: total ? 600 : 500, color: muted ? '#7A9BB8' : '#DCE9F6', fontStyle: muted ? 'italic' : 'normal' }}>
        {r.label}
      </td>
      <td style={{ ...s.td, ...s.num }}>{format(r.revenue, 0)}</td>
      <td style={{ ...s.td, ...s.num }}>{format(r.directCost, 0)}</td>
      <td style={{ ...s.td, ...s.num, color: marginColor, fontWeight: 600 }}>{format(r.margin, 0)}</td>
      <td style={{ ...s.td, ...s.num, color: '#7A9BB8' }}>
        {r.marginPct === null ? '—' : `${r.marginPct.toLocaleString('sr-RS', { minimumFractionDigits: 1, maximumFractionDigits: 1 })}%`}
      </td>
    </tr>
  )
}

const s: Record<string, React.CSSProperties> = {
  // The background lives in `.app-surface`, as on the other pages.
  root: { minHeight: '100vh', fontFamily: "'Inter', system-ui, sans-serif" },
  body: { padding: '24px 28px' },
  newBtn: { background: '#00D47E', color: '#060E1A', border: 'none', borderRadius: '8px', padding: '9px 18px', fontFamily: 'system-ui,sans-serif', fontSize: '13px', fontWeight: '500', cursor: 'pointer', boxShadow: '0 2px 8px rgba(0,212,126,0.3)' },
  summaryRow: { display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(180px, 1fr))', gap: '12px', marginBottom: '1.5rem' },
  summaryCard: { background: '#0D1B2C', border: '1px solid rgba(255,255,255,0.075)', borderRadius: '10px', padding: '14px 16px', boxShadow: '0 4px 20px rgba(0,0,0,0.4)' },
  summaryLabel: { fontSize: '10px', fontWeight: '600', color: 'rgba(255,255,255,0.30)', textTransform: 'uppercase', letterSpacing: '0.08em', marginBottom: '6px' },
  summaryVal: { fontSize: '24px', fontWeight: '600', color: '#DCE9F6', fontVariantNumeric: 'tabular-nums' },
  sectionTitle: { fontSize: '11px', fontWeight: '600', color: 'rgba(255,255,255,0.30)', textTransform: 'uppercase', letterSpacing: '0.1em', marginBottom: '10px' },
  filterBar: { display: 'flex', alignItems: 'center', gap: '10px', marginBottom: '1rem', flexWrap: 'wrap' },
  searchInput: { fontFamily: 'system-ui,sans-serif', fontSize: '13px', border: '1px solid rgba(255,255,255,0.075)', borderRadius: '8px', padding: '8px 12px', outline: 'none', background: '#0D1B2C', color: '#DCE9F6', flex: '1', minWidth: '200px' },
  filterInput: { fontFamily: 'system-ui,sans-serif', fontSize: '13px', border: '1px solid rgba(255,255,255,0.075)', borderRadius: '8px', padding: '7px 10px', outline: 'none', background: '#0D1B2C', color: '#DCE9F6', colorScheme: 'dark' },
  dateLabel: { display: 'flex', alignItems: 'center', gap: '8px', fontSize: '12px', color: '#7A9BB8' },
  checkLabel: { display: 'flex', alignItems: 'center', gap: '6px', fontSize: '13px', color: '#7A9BB8', cursor: 'pointer' },
  totalBadge: { fontSize: '13px', color: '#7A9BB8', background: '#0D1B2C', border: '1px solid rgba(255,255,255,0.075)', borderRadius: '8px', padding: '8px 12px', marginLeft: 'auto', whiteSpace: 'nowrap', fontWeight: '500' },
  tableWrap: { background: '#0D1B2C', border: '1px solid rgba(255,255,255,0.075)', borderRadius: '10px', overflowX: 'auto', boxShadow: '0 4px 20px rgba(0,0,0,0.4)' },
  table: { width: '100%', borderCollapse: 'collapse', fontSize: '13px' },
  thead: { background: '#060E1A' },
  th: { padding: '11px 12px', textAlign: 'left', fontSize: '10px', fontWeight: '600', color: 'rgba(255,255,255,0.30)', textTransform: 'uppercase', letterSpacing: '0.08em', borderBottom: '1px solid rgba(255,255,255,0.075)', whiteSpace: 'nowrap' },
  tr: { borderBottom: '0.5px solid rgba(255,255,255,0.05)' },
  td: { padding: '10px 12px', verticalAlign: 'middle', color: '#DCE9F6' },
  num: { textAlign: 'right', fontVariantNumeric: 'tabular-nums', whiteSpace: 'nowrap' },
  subCell: { fontSize: '11px', color: '#7A9BB8', marginTop: '1px', fontFamily: 'monospace' },
  smallCell: { fontSize: '12px', color: '#7A9BB8' },
  emptyState: { padding: '3rem', textAlign: 'center', color: '#7A9BB8', fontSize: '14px' },
  badge: { fontSize: '11px', fontWeight: '500', padding: '3px 9px', borderRadius: '20px', whiteSpace: 'nowrap' },
  badgeSite: { background: 'rgba(230,180,50,0.12)', color: '#E6B432' },
  badgeRental: { background: 'rgba(78,168,255,0.13)', color: '#4EA8FF' },
  badgeActive: { background: 'rgba(0,212,126,0.12)', color: '#00D47E' },
  badgeClosed: { background: 'rgba(255,255,255,0.06)', color: '#7A9BB8' },
  error: { fontSize: '12.5px', color: '#FF5B5A', background: 'rgba(255,91,90,0.10)', border: '1px solid rgba(255,91,90,0.35)', borderRadius: '8px', padding: '8px 12px', marginBottom: '1rem' },
  note: { fontSize: '12px', color: 'rgba(255,255,255,0.35)', marginTop: '8px' },
}
