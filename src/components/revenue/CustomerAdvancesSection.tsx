// "Avansi kupaca": per customer and project, what came in on proformas, what
// advance invoices cover, what final invoices used and what is still open
// (v_customer_advances, 20261104110000_customer_advances.sql).

import React, { useEffect, useState } from 'react'
import { supabase } from '../../supabase'
import { rs } from './styles'
import { fetchAllPages } from '../../utils/fetchAllPages'
import { fmtMoney } from '../../utils/formatters'

type Fmt = (n: number | null | undefined, decimals?: number) => string

interface AdvanceRow {
  company_id: string | null
  partner_id: string | null
  partner_name: string | null
  project_id: string | null
  project_name: string | null
  currency: string | null
  received_on_proformas: number | string | null
  covered: number | string | null
  advance_total: number | string | null
  used: number | string | null
  received_without_advance: number | string | null
  advance_open: number | string | null
}

const n0 = (v: unknown) => { const n = Number(v); return Number.isFinite(n) ? n : 0 }
const EPS = 0.005

export default function CustomerAdvancesSection({ companyId }: {
  companyId: string | null
  /** The page's display formatter; the figures here are in each row's own currency. */
  format?: Fmt
}) {
  const [rows, setRows] = useState<AdvanceRow[] | null>(null)
  const [error, setError] = useState('')

  useEffect(() => {
    let cancelled = false
    fetchAllPages<AdvanceRow>((a, b) => {
      const q: any = supabase.from('v_customer_advances').select('*')
      return (companyId ? q.eq('company_id', companyId) : q)
        .order('partner_name').order('project_name').order('currency').range(a, b)
    })
      .then(d => { if (!cancelled) { setRows(d); setError('') } })
      .catch((e: any) => { if (!cancelled) { setRows([]); setError(`Avansi kupaca nisu učitani: ${e?.message || e}.`) } })
    return () => { cancelled = true }
  }, [companyId])

  if (rows === null) return null
  const money = (v: unknown, cur: string | null) => fmtMoney(n0(v), cur || 'RSD', 0)

  return (
    <>
      {error && <div style={rs.error} role="alert">{error}</div>}
      {rows.length === 0 ? (
        <div style={rs.tableWrap}><div style={rs.emptyState}>Nema avansa kupaca.</div></div>
      ) : (
        <div style={rs.tableWrap}>
          <table style={rs.table} aria-label="Avansi kupaca">
            <thead>
              <tr style={rs.thead}>
                <th style={rs.th}>Kupac</th>
                <th style={rs.th}>Projekat</th>
                <th style={rs.thNum}>Primljeno po predračunima</th>
                <th style={rs.thNum}>Pokriveno avansnim</th>
                <th style={rs.thNum}>Iskorišćeno</th>
                <th style={rs.thNum}>Otvoreno</th>
              </tr>
            </thead>
            <tbody>
              {rows.map((r, n) => {
                const without = n0(r.received_without_advance)
                const open = n0(r.advance_open)
                return (
                  <tr key={`${r.partner_id}|${r.project_id}|${r.currency}`}
                    style={{ ...rs.tr, ...(n % 2 ? rs.rowStripe1 : rs.rowStripe0) }}>
                    <td style={rs.td}>
                      {r.partner_name || '—'}
                      {without > EPS && (
                        <div style={{ ...rs.subCell, color: '#F5A623' }}>
                          {`Primljeno bez avansnog računa: ${money(without, r.currency)}`}
                        </div>
                      )}
                      {open > EPS && (
                        <div style={{ ...rs.subCell, color: '#F5A623' }}>
                          {`Avans čeka konačnu fakturu: ${money(open, r.currency)}`}
                        </div>
                      )}
                    </td>
                    <td style={rs.td}><span style={rs.smallCell}>{r.project_name || '—'}</span></td>
                    <td style={{ ...rs.td, ...rs.num }}>{money(r.received_on_proformas, r.currency)}</td>
                    <td style={{ ...rs.td, ...rs.num }}>{money(r.covered, r.currency)}</td>
                    <td style={{ ...rs.td, ...rs.num }}>{money(r.used, r.currency)}</td>
                    <td style={{ ...rs.td, ...rs.num, fontWeight: 600 }}>{money(open, r.currency)}</td>
                  </tr>
                )
              })}
            </tbody>
          </table>
        </div>
      )}
    </>
  )
}
