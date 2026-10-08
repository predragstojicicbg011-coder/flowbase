// "Po projektima": contract, billed, advance and collection per project, from
// revenuePage.projectRevenueRows (which reads revenue.projectRevenueSummary).

import React from 'react'
import { rs } from './styles'
import type { ProjectRevenueRow } from '../../services/revenuePage'

type Fmt = (n: number | null | undefined, decimals?: number) => string

const pct = (p: number | null) =>
  p === null ? '—' : `${p.toLocaleString('sr-RS', { minimumFractionDigits: 1, maximumFractionDigits: 1 })}%`

export default function ProjectRevenueTable({ rows, overhead, total, format, currency }: {
  rows: ProjectRevenueRow[]
  overhead: ProjectRevenueRow | null
  total: ProjectRevenueRow
  format: Fmt
  currency: string
}) {
  if (rows.length === 0 && !overhead) {
    return (
      <div style={rs.tableWrap}>
        <div style={rs.emptyState}>
          <div style={rs.emptyTitle}>Još nema izlaznih faktura ni projekata</div>
          <div>Kada dodate projekat i izdate prvu situaciju, ovde se vidi koliko je fakturisano i naplaćeno.</div>
        </div>
      </div>
    )
  }
  return (
    <>
      <div style={rs.tableWrap}>
        <table style={rs.table} aria-label="Prihodi po projektima">
          <thead>
            <tr style={rs.thead}>
              <th style={rs.th}>Projekat</th>
              <th style={rs.thNum}>Ugovorena vrednost</th>
              <th style={rs.thNum}>Fakturisano</th>
              <th style={rs.thNum}>% fakturisano</th>
              <th style={rs.thNum}>Avans primljen</th>
              <th style={rs.thNum}>Avans odbijen</th>
              <th style={rs.thNum}>Avans preostao</th>
              <th style={rs.thNum}>Naplaćeno</th>
              <th style={rs.thNum}>Nenaplaćeno</th>
            </tr>
          </thead>
          <tbody>
            {rows.map((r, i) => <Row key={r.projectId || r.label} r={r} format={format} striped={i % 2 === 1} />)}
            {overhead && <Row r={overhead} format={format} striped={rows.length % 2 === 1} />}
            <Row r={total} format={format} />
          </tbody>
        </table>
      </div>
      {total.unconverted > 0 && (
        <div style={rs.note}>{total.unconverted} iznosa nemaju vrednost u {currency} i računata su kao 0.</div>
      )}
      <div style={rs.note}>
        Fakturisano je ukupno do danas, sa avansom odbijenim na situacijama. Nenaplaćeno = fakturisano − odbijeni avans − naplaćeno.
      </div>
    </>
  )
}

function Row({ r, format, striped }: { r: ProjectRevenueRow; format: Fmt; striped?: boolean }) {
  const total = r.kind === 'total'
  const muted = r.kind === 'overhead'
  const bg = total ? rs.rowTotal : striped ? rs.rowStripe1 : rs.rowStripe0
  const f = (n: number | null) => (n === null ? '—' : format(n, 0))
  return (
    <tr style={{ ...rs.tr, ...bg }}>
      <td style={{ ...rs.td, fontWeight: total ? 600 : 500, color: muted ? '#7A9BB8' : '#DCE9F6', fontStyle: muted ? 'italic' : 'normal' }}>
        {r.label}
      </td>
      <td style={{ ...rs.td, ...rs.num }}>{f(r.contractValue)}</td>
      <td style={{ ...rs.td, ...rs.num, fontWeight: 600 }}>{f(r.billed)}</td>
      <td style={{ ...rs.td, ...rs.num, color: '#7A9BB8' }}>{pct(r.billedPct)}</td>
      <td style={{ ...rs.td, ...rs.num }}>{muted ? '—' : f(r.advanceReceived)}</td>
      <td style={{ ...rs.td, ...rs.num }}>{muted ? '—' : f(r.advanceDeducted)}</td>
      <td style={{ ...rs.td, ...rs.num, color: r.advanceRemaining > 0 ? '#F5A623' : undefined }}>{muted ? '—' : f(r.advanceRemaining)}</td>
      <td style={{ ...rs.td, ...rs.num, color: '#00D47E' }}>{f(r.collected)}</td>
      <td style={{ ...rs.td, ...rs.num, color: r.outstanding > 0 ? '#FF5B5A' : undefined }}>{f(r.outstanding)}</td>
    </tr>
  )
}
