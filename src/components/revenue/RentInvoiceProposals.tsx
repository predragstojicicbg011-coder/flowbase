// "Predloži fakture za zakup": the rent invoices a month still needs
// (revenuePlan.rentInvoicesDue), ticked, then issued as revenue invoices.
//
// Each is booked at the NBS rate on its own invoice date (toBookAmounts). A
// day with no rate is reported and that invoice skipped — nothing is guessed.
// The unique index on (lease_id, service_month) refuses a second invoice for
// the same lease and month; that refusal is reported as "already issued",
// not as a failure.
//
// Numbers: InvoiceDialog takes the invoice number by hand and allows none,
// so a proposed invoice carries a provisional `ZAK-<lease>-<YYYY-MM>`
// (revenuePage.provisionalRentNumber), to be replaced with the real number.

import React, { useMemo, useState } from 'react'
import { supabase } from '../../supabase'
import { chrome } from '../dialogTheme'
import { ds, rs } from './styles'
import { toBookAmounts, RateUnavailableError } from '../../services/bookAmounts'
import type { RentInvoiceProposal } from '../../services/revenuePlan'
import {
  invoiceCount, isDuplicateRentError, monthLabelLong, provisionalRentNumber, rentInvoiceRow, srDateShort,
} from '../../services/revenuePage'
import { fmtMoney } from '../../utils/formatters'

interface Outcome { leaseId: string; ok: boolean; message: string }

export default function RentInvoiceProposals({
  month, proposals, tenantName, projectName, companyId, onClose, onCreated,
}: {
  month: string
  proposals: RentInvoiceProposal[]
  tenantName: (id: string) => string
  projectName: (id: string) => string
  companyId: string | null
  onClose: () => void
  onCreated: () => void
}) {
  const [checked, setChecked] = useState<Set<string>>(() => new Set(proposals.map(p => p.lease_id)))
  const [busy, setBusy] = useState(false)
  const [outcomes, setOutcomes] = useState<Outcome[]>([])
  const done = useMemo(() => new Set(outcomes.filter(o => o.ok).map(o => o.leaseId)), [outcomes])

  const toggle = (id: string) => setChecked(s => {
    const n = new Set(s)
    if (n.has(id)) n.delete(id); else n.add(id)
    return n
  })

  const create = async () => {
    if (!companyId) { setOutcomes([{ leaseId: '', ok: false, message: 'Firma nije učitana.' }]); return }
    setBusy(true)
    const out: Outcome[] = []
    for (const p of proposals) {
      if (!checked.has(p.lease_id) || done.has(p.lease_id)) continue
      const who = `${tenantName(p.partner_id)} (${provisionalRentNumber(p.lease_id, p.service_month)})`
      try {
        const book = await toBookAmounts(p.amount, p.currency, p.invoice_date)
        const row = rentInvoiceRow(p, book, companyId)
        const { data, error } = await supabase.from('invoices').insert(row).select('id')
        if (error) {
          out.push({
            leaseId: p.lease_id, ok: false,
            message: isDuplicateRentError(error)
              ? `${who}: faktura za ovaj zakup i mesec već postoji — preskočeno.`
              : `${who}: ${error.message}`,
          })
        } else if (!data || data.length === 0) {
          out.push({ leaseId: p.lease_id, ok: false, message: `${who}: baza nije vratila red (proverite prava pristupa).` })
        } else {
          out.push({ leaseId: p.lease_id, ok: true, message: `${who}: izdata.` })
        }
      } catch (e: any) {
        out.push({
          leaseId: p.lease_id, ok: false,
          message: e instanceof RateUnavailableError
            ? `${who}: ${e.message} — faktura preskočena.`
            : `${who}: ${e?.message || e}`,
        })
      }
    }
    setOutcomes(prev => [...prev, ...out])
    setBusy(false)
    if (out.some(o => o.ok)) onCreated()
  }

  const pending = proposals.filter(p => checked.has(p.lease_id) && !done.has(p.lease_id)).length

  return (
    <div style={chrome.overlay} onMouseDown={e => { if (e.target === e.currentTarget) onClose() }}>
      <div style={{ ...ds.panel, width: '780px' }} role="dialog" aria-label="Predlog faktura za zakup">
        <div style={chrome.header}>
          <div>
            <div style={chrome.headerTitle}>Fakture za zakup — {monthLabelLong(month)}</div>
            <div style={chrome.headerSub}>Aktivni zakupi bez izdate fakture za taj mesec</div>
          </div>
          <button style={chrome.closeBtn} onClick={onClose} aria-label="Zatvori">×</button>
        </div>

        <div style={ds.body}>
          {proposals.length === 0 ? (
            <div style={rs.emptyState}>
              <div style={rs.emptyTitle}>Nema faktura za predlog</div>
              <div>Za {monthLabelLong(month)} su sve fakture za zakup već izdate, ili nema aktivnih zakupa.</div>
            </div>
          ) : (
            <table style={rs.table} aria-label="Predložene fakture">
              <thead>
                <tr style={rs.thead}>
                  <th style={rs.th} />
                  <th style={rs.th}>Zakupac</th>
                  <th style={rs.th}>Objekat</th>
                  <th style={rs.th}>Datum</th>
                  <th style={rs.th}>Dospeće</th>
                  <th style={rs.thNum}>Iznos</th>
                  <th style={rs.th}>Privremeni broj</th>
                </tr>
              </thead>
              <tbody>
                {proposals.map((p, i) => (
                  <tr key={p.lease_id} style={{ ...rs.tr, ...(i % 2 ? rs.rowStripe1 : rs.rowStripe0), opacity: done.has(p.lease_id) ? 0.5 : 1 }}>
                    <td style={rs.td}>
                      <input type="checkbox" checked={checked.has(p.lease_id)} disabled={done.has(p.lease_id) || busy}
                        onChange={() => toggle(p.lease_id)} aria-label={`Izdaj fakturu: ${tenantName(p.partner_id)}`} />
                    </td>
                    <td style={rs.td}>{tenantName(p.partner_id)}</td>
                    <td style={rs.td}><span style={rs.smallCell}>{projectName(p.project_id)}</span></td>
                    <td style={rs.td}>{srDateShort(p.invoice_date)}</td>
                    <td style={rs.td}>{srDateShort(p.due_date)}</td>
                    <td style={{ ...rs.td, ...rs.num }}>{fmtMoney(p.amount, p.currency)}</td>
                    <td style={{ ...rs.td, fontFamily: 'monospace', fontSize: '11.5px' }}>{provisionalRentNumber(p.lease_id, p.service_month)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
          <div style={ds.hint}>
            Broj fakture se u aplikaciji unosi ručno, pa svaka predložena faktura dobija privremeni broj „ZAK-…-GGGG-MM".
            Zamenite ga pravim brojem otvaranjem fakture u listi izlaznih faktura. Iznos se preračunava po kursu NBS na datum fakture.
          </div>
          {outcomes.length > 0 && (
            <div style={outcomes.every(o => o.ok) ? ds.ok : ds.error} role="status">
              {outcomes.map((o, i) => <div key={i}>{o.message}</div>)}
            </div>
          )}
        </div>

        <div style={ds.footer}>
          <span style={{ fontSize: '12px', color: '#7A9BB8' }}>{pending ? `Izabrano: ${invoiceCount(pending)}` : ''}</span>
          <div style={{ display: 'flex', gap: '8px' }}>
            <button style={ds.cancelBtn} onClick={onClose} disabled={busy}>Zatvori</button>
            <button style={ds.saveBtn} onClick={create} disabled={busy || pending === 0}>
              {busy ? 'Izdavanje…' : 'Izdaj izabrane fakture'}
            </button>
          </div>
        </div>
      </div>
    </div>
  )
}
