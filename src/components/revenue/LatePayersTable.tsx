// "Ko kasni": the customers with overdue invoices, the largest debt first.
// The customer card carries the statement of open items (IOS); the PDF is the
// customer's oldest overdue invoice.

import React, { useState } from 'react'
import { rs } from './styles'
import { SefFlagBadge } from './RevenueInvoiceList'
import PartnerCardDialog from '../PartnerCardDialog'
import DocumentViewerDialog from '../DocumentViewerDialog'
import { receivablesIn, type LatePayer, type SefFlag } from '../../services/receivables'
import { srDateShort, type RevenueListRow } from '../../services/revenuePage'

type Fmt = (n: number | null | undefined, decimals?: number) => string

export default function LatePayersTable({ payers, rows, today, flags, format }: {
  payers: LatePayer[]
  rows: readonly RevenueListRow[]
  today: string
  flags: ReadonlyMap<string, SefFlag>
  format: Fmt
}) {
  const [card, setCard] = useState<{ id: string; name: string } | null>(null)
  const [pdf, setPdf] = useState<{ id: string; title: string } | null>(null)

  if (payers.length === 0) {
    return (
      <div style={rs.tableWrap}>
        <div style={rs.emptyState}>Nijedan kupac ne kasni.</div>
      </div>
    )
  }
  const overdue = receivablesIn(rows, 'overdue', today)
  const voided = (p: LatePayer) => overdue.some(r =>
    (p.partnerId ? r.partner_id === p.partnerId : !r.partner_id && (r.partner_name || '—') === p.partnerName)
    && flags.get(r.id) === 'voided')

  return (
    <>
      <div style={rs.tableWrap}>
        <table style={rs.table} aria-label="Ko kasni">
          <thead>
            <tr style={rs.thead}>
              <th style={rs.th}>Kupac</th>
              <th style={rs.thNum}>Iznos</th>
              <th style={rs.th}>Najstarije dospeće</th>
              <th style={rs.thNum}>Dana kašnjenja</th>
              <th style={rs.th} />
            </tr>
          </thead>
          <tbody>
            {payers.map((p, i) => (
              <tr key={p.partnerId ?? p.partnerName} style={{ ...rs.tr, ...(i % 2 ? rs.rowStripe1 : rs.rowStripe0) }}>
                <td style={rs.td}>
                  {p.partnerName} {voided(p) && <SefFlagBadge flag="voided" />}
                  {p.count > 1 && <span style={rs.smallCell}> · {p.count} faktura</span>}
                </td>
                <td style={{ ...rs.td, ...rs.num, color: '#FF5B5A', fontWeight: 600 }}>{format(p.amount, 0)}</td>
                <td style={{ ...rs.td, whiteSpace: 'nowrap' }}>{srDateShort(p.oldestDue)}</td>
                <td style={{ ...rs.td, ...rs.num }}>{p.daysLate}</td>
                <td style={{ ...rs.td, whiteSpace: 'nowrap', textAlign: 'right' }}>
                  <button type="button" style={rs.ghostBtn} disabled={!p.partnerId}
                    aria-label={`Kartica ${p.partnerName}`}
                    onClick={() => p.partnerId && setCard({ id: p.partnerId, name: p.partnerName })}>Kartica</button>{' '}
                  <button type="button" style={rs.ghostBtn} aria-label={`PDF najstarije fakture ${p.partnerName}`}
                    onClick={() => setPdf({ id: p.oldestInvoiceId, title: p.partnerName })}>PDF</button>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      {card && <PartnerCardDialog partner={card} onClose={() => setCard(null)} />}
      {pdf && <DocumentViewerDialog invoiceId={pdf.id} title={pdf.title} onClose={() => setPdf(null)} />}
    </>
  )
}
