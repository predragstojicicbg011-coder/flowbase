// "Izlazne fakture": every revenue invoice, filtered, opening InvoiceDialog
// for edit the way the Ledger does (Transactions.handleEditInvoice).

import React, { useMemo, useState } from 'react'
import { rs } from './styles'
import { SkeletonRows } from '../motion'
import SearchableSelect from '../SearchableSelect'
import { REVENUE_STREAMS } from '../../services/revenueStreams'
import { OVERHEAD_OPTION_LABEL, projectLabel, type Project } from '../../services/projects'
import {
  OVERHEAD_FILTER, STATUS_LABEL, filterRevenueInvoices, invoiceCount, revenueStatus, srDateShort,
  type InvoiceFilter, type RevenueListRow, type RevenueStatus,
} from '../../services/revenuePage'
import { fmtMoney } from '../../utils/formatters'
import { pickAmount, type DisplayCurrency } from '../../contexts/DisplayCurrencyContext'

type Fmt = (n: number | null | undefined, decimals?: number) => string

const STATUS_STYLE: Record<RevenueStatus, React.CSSProperties> = {
  paid: rs.badgePaid, partial: rs.badgePartial, unpaid: rs.badgeUnpaid,
}

export default function RevenueInvoiceList({
  rows, loading, projects, projectName, currency, format, from, to, onPeriod, onOpen,
}: {
  rows: RevenueListRow[]
  loading: boolean
  projects: readonly Project[]
  projectName: (id: string | null, fallback?: string | null) => string
  currency: DisplayCurrency
  format: Fmt
  from: string
  to: string
  onPeriod: (from: string, to: string) => void
  onOpen: (row: RevenueListRow) => void
}) {
  const [projectId, setProjectId] = useState('')
  const [stream, setStream] = useState('')
  const [status, setStatus] = useState<'' | RevenueStatus>('')
  const [search, setSearch] = useState('')

  const filter: InvoiceFilter = { projectId, stream, status, from, to, search }
  const listed = useMemo(() => filterRevenueInvoices(rows, filter), [rows, projectId, stream, status, from, to, search]) // eslint-disable-line react-hooks/exhaustive-deps

  const projectOptions = useMemo(() => [
    { value: OVERHEAD_FILTER, label: OVERHEAD_OPTION_LABEL },
    ...projects.map(p => ({ value: p.id, label: projectLabel(p) })),
  ], [projects])

  const sum = (base: string) => listed.reduce((s, r) => s + (pickAmount(r, currency, base) ?? 0), 0)

  return (
    <>
      <div style={rs.filterBar}>
        <input type="text" placeholder="Pretraži broj fakture ili investitora…" value={search}
          onChange={e => setSearch(e.target.value)} style={rs.searchInput} />
        <SearchableSelect value={projectId} onChange={setProjectId} options={projectOptions}
          allLabel="Svi projekti" searchPlaceholder="Pretraži projekte…" emptyMessage="Nema takvog projekta"
          style={{ minWidth: '200px' }} title="Projekat" />
        <select style={rs.filterInput} value={stream} onChange={e => setStream(e.target.value)} aria-label="Vrsta prihoda">
          <option value="">Sve vrste prihoda</option>
          {REVENUE_STREAMS.map(s => <option key={s} value={s}>{s}</option>)}
        </select>
        <select style={rs.filterInput} value={status} onChange={e => setStatus(e.target.value as '' | RevenueStatus)} aria-label="Status">
          <option value="">Svi statusi</option>
          {(['unpaid', 'partial', 'paid'] as RevenueStatus[]).map(s => <option key={s} value={s}>{STATUS_LABEL[s]}</option>)}
        </select>
        <label style={rs.dateLabel}>Od
          <input type="date" style={rs.filterInput} value={from} onChange={e => onPeriod(e.target.value, to)} />
        </label>
        <label style={rs.dateLabel}>Do
          <input type="date" style={rs.filterInput} value={to} onChange={e => onPeriod(from, e.target.value)} />
        </label>
        <div style={rs.totalBadge}>{invoiceCount(listed.length)}</div>
      </div>

      <div style={rs.tableWrap}>
        {loading ? (
          <div style={{ padding: '18px 16px' }}>
            <SkeletonRows rows={5} height={15} gap={14} widths={[80, 64, 90, 55, 72]} />
          </div>
        ) : listed.length === 0 ? (
          <div style={rs.emptyState}>
            <div style={rs.emptyTitle}>{rows.length === 0 ? 'Još nema izlaznih faktura' : 'Nijedna faktura ne odgovara filterima'}</div>
            {rows.length === 0 && <div>Izlazne fakture (situacije i zakup) unose se kao fakture vrste „prihod" u Knjizi, ili se predlažu za zakup ispod.</div>}
          </div>
        ) : (
          <table style={rs.table} aria-label="Izlazne fakture">
            <thead>
              <tr style={rs.thead}>
                <th style={rs.th}>Broj</th>
                <th style={rs.th}>Datum</th>
                <th style={rs.th}>Investitor / zakupac</th>
                <th style={rs.th}>Projekat</th>
                <th style={rs.th}>Vrsta prihoda</th>
                <th style={rs.thNum}>Iznos</th>
                <th style={rs.thNum}>Avans odbijen</th>
                <th style={rs.thNum}>Za naplatu</th>
                <th style={rs.thNum}>Naplaćeno</th>
                <th style={rs.th}>Status</th>
              </tr>
            </thead>
            <tbody>
              {listed.map((r, i) => {
                const st = revenueStatus(r.calculated_status)
                const own = (r.currency || 'RSD').toUpperCase()
                const deducted = pickAmount(r, currency, 'advance_deducted') ?? 0
                return (
                  <tr key={r.id} style={{ ...rs.tr, ...(i % 2 ? rs.rowStripe1 : rs.rowStripe0), cursor: 'pointer' }}
                    onClick={() => onOpen(r)} title="Otvori fakturu">
                    <td style={{ ...rs.td, fontFamily: 'monospace', fontSize: '12px' }}>{r.invoice_number || '—'}</td>
                    <td style={{ ...rs.td, whiteSpace: 'nowrap' }}>{srDateShort(r.invoice_date)}</td>
                    <td style={rs.td}>{r.partner_name || '—'}</td>
                    <td style={rs.td}><span style={rs.smallCell}>{projectName(r.project_id, r.project_name)}</span></td>
                    <td style={rs.td}>
                      <span style={{ ...rs.badge, ...(r.lease_id ? rs.badgeRent : rs.badgeMuted) }}>{r.revenue_stream || '—'}</span>
                    </td>
                    <td style={{ ...rs.td, ...rs.num }}>
                      <div>{format(pickAmount(r, currency))}</div>
                      {own !== currency && <div style={rs.subCell}>{fmtMoney(Number(r.amount), own)}</div>}
                    </td>
                    <td style={{ ...rs.td, ...rs.num, color: deducted ? '#F5A623' : '#7A9BB8' }}>{deducted ? format(deducted) : '—'}</td>
                    <td style={{ ...rs.td, ...rs.num }}>{format(pickAmount(r, currency, 'remaining'))}</td>
                    <td style={{ ...rs.td, ...rs.num, color: '#00D47E' }}>{format(pickAmount(r, currency, 'paid_amount'))}</td>
                    <td style={rs.td}><span style={{ ...rs.badge, ...STATUS_STYLE[st] }}>{STATUS_LABEL[st]}</span></td>
                  </tr>
                )
              })}
              <tr style={{ ...rs.tr, ...rs.rowTotal }}>
                <td style={{ ...rs.td, fontWeight: 600 }} colSpan={5}>Ukupno</td>
                <td style={{ ...rs.td, ...rs.num, fontWeight: 600 }}>{format(sum('amount'))}</td>
                <td style={{ ...rs.td, ...rs.num, fontWeight: 600 }}>{format(sum('advance_deducted'))}</td>
                <td style={{ ...rs.td, ...rs.num, fontWeight: 600 }}>{format(sum('remaining'))}</td>
                <td style={{ ...rs.td, ...rs.num, fontWeight: 600 }}>{format(sum('paid_amount'))}</td>
                <td style={rs.td} />
              </tr>
            </tbody>
          </table>
        )}
      </div>
      <div style={rs.note}>Klik na fakturu otvara je za izmenu. „Za naplatu" je ono što je preostalo posle odbijenog avansa i uplata.</div>
    </>
  )
}
