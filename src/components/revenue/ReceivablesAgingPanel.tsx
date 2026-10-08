// "Starost potraživanja": what investors and tenants owe, by how late it is
// (revenue.receivablesAging), with each bucket opening into its invoices.

import React, { useState } from 'react'
import { rs } from './styles'
import { AGING_BUCKETS, AGING_LABEL, type Aging, type AgingBucket } from '../../services/revenue'
import { invoiceCount, srDateShort } from '../../services/revenuePage'

type Fmt = (n: number | null | undefined, decimals?: number) => string

const BUCKET_COLOUR: Record<AgingBucket, string> = {
  notDue: '#00D47E', d0_30: '#DCE9F6', d31_60: '#F5A623', d61_90: '#FF8A4C', d90plus: '#FF5B5A',
}

export default function ReceivablesAgingPanel({ aging, format, projectName, currency }: {
  aging: Aging
  format: Fmt
  projectName: (id: string | null) => string
  currency: string
}) {
  const [open, setOpen] = useState<AgingBucket | null>(null)

  if (aging.items.length === 0) {
    return (
      <div style={rs.tableWrap}>
        <div style={rs.emptyState}>
          <div style={rs.emptyTitle}>Nema otvorenih potraživanja</div>
          <div>Sve izlazne fakture su naplaćene ili pokrivene avansom.</div>
        </div>
      </div>
    )
  }

  const items = open ? aging.items.filter(i => i.bucket === open) : []
  return (
    <>
      <div style={rs.summaryRow}>
        {AGING_BUCKETS.map(b => {
          const x = aging.buckets[b]
          const on = open === b
          return (
            <button key={b} type="button" onClick={() => setOpen(on ? null : b)} aria-expanded={on}
              aria-label={`${AGING_LABEL[b]}: ${invoiceCount(x.count)}`}
              style={{
                ...rs.summaryCard, textAlign: 'left', cursor: x.count ? 'pointer' : 'default',
                borderColor: on ? BUCKET_COLOUR[b] : 'rgba(255,255,255,0.075)',
              }}>
              <div style={rs.summaryLabel}>{AGING_LABEL[b]}</div>
              <div style={{ ...rs.summaryVal, fontSize: '19px', color: x.total > 0 ? BUCKET_COLOUR[b] : '#7A9BB8' }}>
                {format(x.total, 0)}
              </div>
              <div style={rs.summarySub}>{invoiceCount(x.count)}{x.count ? (on ? ' · sakrij' : ' · prikaži') : ''}</div>
            </button>
          )
        })}
        <div style={{ ...rs.summaryCard, background: '#060E1A' }}>
          <div style={rs.summaryLabel}>Ukupno za naplatu</div>
          <div style={{ ...rs.summaryVal, fontSize: '19px' }}>{format(aging.total, 0)}</div>
          <div style={rs.summarySub}>{invoiceCount(aging.items.length)}</div>
        </div>
      </div>

      {open && (
        <div style={rs.tableWrap}>
          <table style={rs.table} aria-label={`Potraživanja: ${AGING_LABEL[open]}`}>
            <thead>
              <tr style={rs.thead}>
                <th style={rs.th}>Investitor / zakupac</th>
                <th style={rs.th}>Broj fakture</th>
                <th style={rs.th}>Projekat</th>
                <th style={rs.th}>Dospeće</th>
                <th style={rs.thNum}>Dana kašnjenja</th>
                <th style={rs.thNum}>Za naplatu</th>
              </tr>
            </thead>
            <tbody>
              {items.map((i, n) => (
                <tr key={i.id} style={{ ...rs.tr, ...(n % 2 ? rs.rowStripe1 : rs.rowStripe0) }}>
                  <td style={rs.td}>{i.partnerName}</td>
                  <td style={{ ...rs.td, fontFamily: 'monospace', fontSize: '12px' }}>{i.invoiceNumber || '—'}</td>
                  <td style={rs.td}><span style={rs.smallCell}>{projectName(i.projectId)}</span></td>
                  <td style={rs.td}>{srDateShort(i.due)}</td>
                  <td style={{ ...rs.td, ...rs.num, color: i.daysPastDue > 0 ? BUCKET_COLOUR[i.bucket] : '#7A9BB8' }}>
                    {i.daysPastDue < 0 ? `za ${-i.daysPastDue}` : i.daysPastDue}
                  </td>
                  <td style={{ ...rs.td, ...rs.num, fontWeight: 600 }}>{format(i.amount)}</td>
                </tr>
              ))}
              <tr style={{ ...rs.tr, ...rs.rowTotal }}>
                <td style={{ ...rs.td, fontWeight: 600 }} colSpan={5}>Ukupno — {AGING_LABEL[open]}</td>
                <td style={{ ...rs.td, ...rs.num, fontWeight: 600 }}>{format(aging.buckets[open].total)}</td>
              </tr>
            </tbody>
          </table>
        </div>
      )}
      {aging.unconverted > 0 && (
        <div style={rs.note}>{invoiceCount(aging.unconverted)} bez iznosa u {currency} nije uključeno.</div>
      )}
    </>
  )
}
