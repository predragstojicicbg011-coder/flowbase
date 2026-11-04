// The top of Prihodi: what customers owe, what falls due within a week and
// what is late. Each card opens the invoices behind its figure.

import React, { useState } from 'react'
import { rs } from './styles'
import { SefFlagBadge } from './RevenueInvoiceList'
import {
  DUE_SOON_DAYS, receivablesIn, type ReceivableBucket, type ReceivableTotals, type SefFlag,
} from '../../services/receivables'
import { srDateShort, invoiceCount, type RevenueListRow } from '../../services/revenuePage'
import { pickAmount, type DisplayCurrency } from '../../contexts/DisplayCurrencyContext'

type Fmt = (n: number | null | undefined, decimals?: number) => string

const BUCKET_TITLE: Record<ReceivableBucket, string> = {
  all: 'Ukupna potraživanja', dueSoon: `Dospeva u narednih ${DUE_SOON_DAYS} dana`, overdue: 'Kasni',
}

export default function ReceivablesCards({ totals, rows, today, currency, format, flags }: {
  totals: ReceivableTotals
  rows: readonly RevenueListRow[]
  today: string
  currency: DisplayCurrency
  format: Fmt
  flags: ReadonlyMap<string, SefFlag>
}) {
  const [open, setOpen] = useState<ReceivableBucket | null>(null)
  const cards: { bucket: ReceivableBucket; value: number; color?: string }[] = [
    { bucket: 'all', value: totals.total },
    { bucket: 'dueSoon', value: totals.dueSoon, color: totals.dueSoon > 0 ? '#F5A623' : undefined },
    { bucket: 'overdue', value: totals.overdue, color: totals.overdue > 0 ? '#FF5B5A' : undefined },
  ]
  const listed = open ? receivablesIn(rows, open, today) : []
  const pa = totals.proformasAwaiting

  return (
    <div style={{ marginBottom: '1.5rem' }}>
      <div style={{ ...rs.summaryRow, marginBottom: '8px' }}>
        {cards.map(c => (
          <button key={c.bucket} type="button" aria-pressed={open === c.bucket}
            onClick={() => setOpen(open === c.bucket ? null : c.bucket)}
            style={{ ...rs.summaryCard, textAlign: 'left', cursor: 'pointer', font: 'inherit',
              ...(open === c.bucket ? { borderColor: 'rgba(78,168,255,0.5)' } : {}) }}>
            <div style={rs.summaryLabel}>{BUCKET_TITLE[c.bucket]}</div>
            <div style={{ ...rs.summaryVal, ...(c.color ? { color: c.color } : {}) }}>{format(c.value, 0)}</div>
            <div style={rs.summarySub}>{invoiceCount(totals.counts[c.bucket])}</div>
          </button>
        ))}
      </div>
      <div style={rs.note}>
        Predračuni koji čekaju uplatu: {pa.count} · {format(pa.amount, 0)}
      </div>
      {totals.unconverted > 0 && (
        <div style={rs.note}>{totals.unconverted} iznosa nemaju vrednost u {currency} i računata su kao 0.</div>
      )}
      {open && (
        <div style={{ ...rs.tableWrap, marginTop: '10px' }}>
          {listed.length === 0 ? (
            <div style={rs.emptyState}>Nema faktura u ovoj grupi.</div>
          ) : (
            <table style={rs.table} aria-label={`Potraživanja: ${BUCKET_TITLE[open]}`}>
              <thead>
                <tr style={rs.thead}>
                  <th style={rs.th}>Broj</th>
                  <th style={rs.th}>Kupac</th>
                  <th style={rs.th}>Dospeće</th>
                  <th style={rs.thNum}>Za naplatu</th>
                </tr>
              </thead>
              <tbody>
                {listed.map((r, i) => (
                  <tr key={r.id} style={{ ...rs.tr, ...(i % 2 ? rs.rowStripe1 : rs.rowStripe0) }}>
                    <td style={{ ...rs.td, fontFamily: 'monospace', fontSize: '12px' }}>
                      {r.invoice_number || '—'} <SefFlagBadge flag={flags.get(r.id)} />
                    </td>
                    <td style={rs.td}>{r.partner_name || '—'}</td>
                    <td style={{ ...rs.td, whiteSpace: 'nowrap' }}>{srDateShort(r.due_date)}</td>
                    <td style={{ ...rs.td, ...rs.num }}>{format(pickAmount(r, currency, 'remaining'), 0)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </div>
      )}
    </div>
  )
}
