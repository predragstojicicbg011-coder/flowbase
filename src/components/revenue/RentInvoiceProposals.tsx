// "Meseci bez fakture za zakup": a reminder, nothing more.
//
// It lists the active leases that have no live invoice for the month
// (revenuePlan.rentInvoicesDue). It makes no invoice: rent is invoiced on SEF
// or in Calculus, and the issued invoice is booked from "SEF izlazne", where
// the lease and month are recognised (revenueClassification.proposeLease).

import React from 'react'
import { chrome } from '../dialogTheme'
import { ds, rs } from './styles'
import type { RentInvoiceProposal } from '../../services/revenuePlan'
import { monthLabelLong, srDateShort } from '../../services/revenuePage'
import { fmtMoney } from '../../utils/formatters'

export default function RentInvoiceProposals({
  month, proposals, tenantName, projectName, onClose,
}: {
  month: string
  proposals: RentInvoiceProposal[]
  tenantName: (id: string) => string
  projectName: (id: string) => string
  onClose: () => void
}) {
  return (
    <div style={chrome.overlay} onMouseDown={e => { if (e.target === e.currentTarget) onClose() }}>
      <div style={{ ...ds.panel, width: '720px' }} role="dialog" aria-label="Meseci bez fakture za zakup">
        <div style={chrome.header}>
          <div>
            <div style={chrome.headerTitle}>Meseci bez fakture za zakup — {monthLabelLong(month)}</div>
            <div style={chrome.headerSub}>Aktivni zakupi bez fakture za taj mesec</div>
          </div>
          <button style={chrome.closeBtn} onClick={onClose} aria-label="Zatvori">×</button>
        </div>

        <div style={ds.body}>
          {proposals.length === 0 ? (
            <div style={rs.emptyState}>
              <div style={rs.emptyTitle}>Nema zakupa bez fakture</div>
              <div>Za {monthLabelLong(month)} je za sve zakupe faktura već proknjižena, ili nema aktivnih zakupa.</div>
            </div>
          ) : (
            <table style={rs.table} aria-label="Zakupi bez fakture">
              <thead>
                <tr style={rs.thead}>
                  <th style={rs.th}>Zakupac</th>
                  <th style={rs.th}>Objekat</th>
                  <th style={rs.th}>Dan fakturisanja</th>
                  <th style={rs.thNum}>Zakupnina</th>
                </tr>
              </thead>
              <tbody>
                {proposals.map((p, i) => (
                  <tr key={p.lease_id} style={{ ...rs.tr, ...(i % 2 ? rs.rowStripe1 : rs.rowStripe0) }}>
                    <td style={rs.td}>{tenantName(p.partner_id)}</td>
                    <td style={rs.td}><span style={rs.smallCell}>{projectName(p.project_id)}</span></td>
                    <td style={rs.td}>{srDateShort(p.invoice_date)}</td>
                    <td style={{ ...rs.td, ...rs.num }}>{fmtMoney(p.amount, p.currency)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
          <div style={ds.hint}>
            Faktura za zakup se izdaje na SEF-u ili u Calculus-u; kad stigne, proknjižite je iz „SEF izlazne“.
          </div>
        </div>

        <div style={ds.footer}>
          <span />
          <button style={ds.cancelBtn} onClick={onClose}>Zatvori</button>
        </div>
      </div>
    </div>
  )
}
