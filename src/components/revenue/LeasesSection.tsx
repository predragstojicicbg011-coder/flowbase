// "Zakup": the leases of each rental building, the lease form, and the rent
// invoices a month still needs.

import React, { useMemo, useState } from 'react'
import { rs } from './styles'
import LeaseDialog from './LeaseDialog'
import RentInvoiceProposals from './RentInvoiceProposals'
import { projectLabel, type Project } from '../../services/projects'
import {
  rentInvoicesDue, type PlanInvoice, type RentalLease, type RentInvoiceProposal,
} from '../../services/revenuePlan'
import { srDateShort } from '../../services/revenuePage'
import { fmtMoney } from '../../utils/formatters'

export default function LeasesSection({
  rentalProjects, leases, partners, invoices, companyId, today, onChanged,
}: {
  rentalProjects: readonly Project[]
  leases: readonly RentalLease[]
  partners: readonly { id: string; name: string }[]
  /** Revenue invoices, for the lease-months already billed. */
  invoices: readonly PlanInvoice[]
  companyId: string | null
  today: string
  onChanged: () => void
}) {
  const [dialog, setDialog] = useState<{ lease: RentalLease | null; projectId: string } | null>(null)
  const [month, setMonth] = useState(today.slice(0, 7))
  const [proposals, setProposals] = useState<{ month: string; list: RentInvoiceProposal[] } | null>(null)

  const partnerName = useMemo(() => {
    const m = new Map(partners.map(p => [p.id, p.name]))
    return (id: string) => m.get(id) || '—'
  }, [partners])
  const projectName = (id: string) => {
    const p = rentalProjects.find(x => x.id === id)
    return p ? projectLabel(p) : '—'
  }

  const propose = () => {
    if (!/^\d{4}-\d{2}$/.test(month)) return
    const ids = new Set(rentalProjects.map(p => p.id))
    setProposals({ month, list: rentInvoicesDue(leases.filter(l => ids.has(l.project_id)), month, invoices) })
  }

  if (rentalProjects.length === 0) {
    return (
      <div style={rs.tableWrap}>
        <div style={rs.emptyState}>
          <div style={rs.emptyTitle}>Nema objekata u zakupu</div>
          <div>Zakupi se vode na projektima vrste „Objekat u zakupu". Dodajte ga na strani Projekti.</div>
        </div>
      </div>
    )
  }

  return (
    <>
      <div style={rs.filterBar}>
        <label style={rs.dateLabel}>Mesec
          <input type="month" style={rs.filterInput} value={month} onChange={e => setMonth(e.target.value)} aria-label="Mesec za fakture zakupa" />
        </label>
        <button style={rs.newBtn} onClick={propose} disabled={!companyId}>Predloži fakture za zakup</button>
      </div>

      {rentalProjects.map(p => {
        const own = leases.filter(l => l.project_id === p.id)
        return (
          <div key={p.id} style={{ marginBottom: '1.25rem' }}>
            <div style={{ display: 'flex', alignItems: 'center', gap: '10px', marginBottom: '8px' }}>
              <div style={{ fontSize: '14px', fontWeight: 600, color: '#DCE9F6' }}>{projectLabel(p)}</div>
              {!p.active && <span style={{ ...rs.badge, ...rs.badgeMuted }}>zatvoren</span>}
              <button style={{ ...rs.ghostBtn, marginLeft: 'auto' }} disabled={!companyId}
                onClick={() => setDialog({ lease: null, projectId: p.id })}>+ Novi zakup</button>
            </div>
            <div style={rs.tableWrap}>
              {own.length === 0 ? (
                <div style={{ ...rs.emptyState, padding: '1.25rem' }}>Još nema zakupaca u ovom objektu.</div>
              ) : (
                <table style={rs.table} aria-label={`Zakupi: ${p.name}`}>
                  <thead>
                    <tr style={rs.thead}>
                      <th style={rs.th}>Zakupac</th>
                      <th style={rs.thNum}>Mesečna zakupnina</th>
                      <th style={rs.th}>Valuta</th>
                      <th style={rs.th}>Od – do</th>
                      <th style={rs.th}>Dan fakturisanja</th>
                      <th style={rs.th}>Rok plaćanja</th>
                      <th style={rs.th}>Aktivan</th>
                    </tr>
                  </thead>
                  <tbody>
                    {own.map((l, i) => {
                      const ended = !!l.end_date && l.end_date < today
                      return (
                        <tr key={l.id} style={{ ...rs.tr, ...(i % 2 ? rs.rowStripe1 : rs.rowStripe0), cursor: 'pointer' }}
                          onClick={() => setDialog({ lease: l, projectId: p.id })} title="Izmeni zakup">
                          <td style={{ ...rs.td, fontWeight: 500 }}>{partnerName(l.tenant_partner_id)}</td>
                          <td style={{ ...rs.td, ...rs.num }}>{fmtMoney(Number(l.monthly_rent), l.currency)}</td>
                          <td style={rs.td}>{l.currency}</td>
                          <td style={{ ...rs.td, whiteSpace: 'nowrap' }}>{srDateShort(l.start_date)} – {l.end_date ? srDateShort(l.end_date) : 'neograničeno'}</td>
                          <td style={rs.td}>{l.invoice_day}.</td>
                          <td style={rs.td}>{l.payment_days} dana</td>
                          <td style={rs.td}>
                            <span style={{ ...rs.badge, ...(l.active && !ended ? rs.badgePaid : rs.badgeMuted) }}>
                              {!l.active ? 'Ne' : ended ? 'Završen' : 'Da'}
                            </span>
                          </td>
                        </tr>
                      )
                    })}
                  </tbody>
                </table>
              )}
            </div>
          </div>
        )
      })}

      {dialog && companyId && (
        <LeaseDialog lease={dialog.lease} projectId={dialog.projectId} rentalProjects={rentalProjects}
          partners={partners} companyId={companyId} today={today}
          onClose={() => setDialog(null)} onSaved={() => { setDialog(null); onChanged() }} />
      )}
      {proposals && (
        <RentInvoiceProposals month={proposals.month} proposals={proposals.list}
          tenantName={partnerName} projectName={projectName} companyId={companyId}
          onClose={() => setProposals(null)} onCreated={onChanged} />
      )}
    </>
  )
}
