import React, { useEffect, useState } from 'react'
import { supabase } from '../supabase'
import { useCompanies } from '../contexts/CompaniesContext'
import { DIALOG, chrome } from './dialogTheme'
import { fmtMoney } from '../utils/formatters'

// ─── Avansi dobavljačima ────────────────────────────────────────────────────
//
// The chain per supplier, from v_supplier_advances (20261021090000): what was
// paid on proformas, how much of it advance invoices cover, how much final
// invoices have used, and what is still open. A remainder is not closed by
// hand (the client's decision): it stays here as a warning until the next
// advance invoice or final invoice resolves it.

interface SupplierRow {
  partner_id: string
  partner_name: string | null
  currency: string | null
  paid_on_proformas: number
  covered: number
  advance_total: number
  used: number
  paid_without_advance: number
  advance_open: number
}

export default function SupplierAdvancesPanel({ onClose }: { onClose: () => void }) {
  const { defaultCompany } = useCompanies()
  const [rows, setRows] = useState<SupplierRow[]>([])
  const [loose, setLoose] = useState<any[]>([])
  const [loading, setLoading] = useState(true)

  useEffect(() => {
    if (!defaultCompany?.id) return
    let cancelled = false
    const load = async () => {
      const [sup, adv] = await Promise.all([
        supabase.from('v_supplier_advances').select('*').eq('company_id', defaultCompany.id).order('partner_name'),
        supabase.from('v_invoice_status')
          .select('id, invoice_number, partner_name, document_type, amount, currency, unlinked, advance_open')
          .eq('company_id', defaultCompany.id).eq('document_type', 'advance_invoice'),
      ])
      if (cancelled) return
      setRows(((sup.data || []) as any[]).map(r => ({
        ...r,
        paid_on_proformas: Number(r.paid_on_proformas) || 0, covered: Number(r.covered) || 0,
        advance_total: Number(r.advance_total) || 0, used: Number(r.used) || 0,
        paid_without_advance: Number(r.paid_without_advance) || 0, advance_open: Number(r.advance_open) || 0,
      })))
      setLoose(((adv.data || []) as any[]).filter(a => a.unlinked))
      setLoading(false)
    }
    load()
    return () => { cancelled = true }
  }, [defaultCompany?.id])

  const money = (n: number, cur: string | null) => fmtMoney(n, cur || 'RSD')
  const th: React.CSSProperties = { textAlign: 'right', fontSize: '11px', color: DIALOG.dim, fontWeight: 500, padding: '6px 8px' }
  const td: React.CSSProperties = { textAlign: 'right', fontSize: '12px', color: DIALOG.text, padding: '6px 8px', whiteSpace: 'nowrap' }
  const warn: React.CSSProperties = { fontSize: '11px', color: DIALOG.amber, marginTop: '2px' }

  return (
    <div style={chrome.overlay}>
      <div style={{ background: DIALOG.panel, borderRadius: '16px', width: '960px', maxWidth: '95vw', maxHeight: '90vh', display: 'flex', flexDirection: 'column', overflow: 'hidden' }}>
        <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', padding: '1rem 1.5rem', borderBottom: '0.5px solid ' + DIALOG.border }}>
          <div>
            <div style={{ fontSize: '15px', fontWeight: 500, color: DIALOG.text }}>Avansi dobavljačima</div>
            <div style={{ fontSize: '12px', color: DIALOG.dim, marginTop: '2px' }}>Plaćeno po predračunima, pokriveno avansnim računima, iskorišćeno konačnim računima</div>
          </div>
          <button aria-label="Zatvori" onClick={onClose} style={{ background: 'none', border: 'none', color: DIALOG.dim, fontSize: '20px', cursor: 'pointer' }}>×</button>
        </div>
        <div style={{ padding: '1rem 1.5rem', overflowY: 'auto' }}>
          {loose.length > 0 && (
            <div style={{ marginBottom: '12px', padding: '8px 12px', borderRadius: '8px', background: DIALOG.amberFill, border: '0.5px solid ' + DIALOG.amber }}>
              {loose.map(a => (
                <div key={a.id} style={{ fontSize: '12px', color: DIALOG.amber }}>
                  Avansni račun {a.invoice_number || 'bez broja'} ({a.partner_name || '—'}) nije vezan za predračun
                </div>
              ))}
            </div>
          )}
          {!loading && rows.length === 0 && loose.length === 0 && (
            <div style={{ padding: '60px', textAlign: 'center', color: DIALOG.dim, fontSize: '13px' }}>Nema avansa dobavljačima.</div>
          )}
          {rows.length > 0 && (
            <table style={{ width: '100%', borderCollapse: 'collapse' }}>
              <thead>
                <tr>
                  <th style={{ ...th, textAlign: 'left' }}>Dobavljač</th>
                  <th style={th}>Plaćeno po predračunima</th>
                  <th style={th}>Pokriveno avansnim</th>
                  <th style={th}>Iskorišćeno konačnim</th>
                  <th style={th}>Avans otvoren</th>
                </tr>
              </thead>
              <tbody>
                {rows.map(r => (
                  <tr key={`${r.partner_id}-${r.currency}`} style={{ borderTop: '0.5px solid ' + DIALOG.border }}>
                    <td style={{ ...td, textAlign: 'left', whiteSpace: 'normal' }}>
                      <div>{r.partner_name || '—'}</div>
                      {r.paid_without_advance > 0.005 && <div style={warn}>Plaćeno bez avansnog računa: {money(r.paid_without_advance, r.currency)}</div>}
                      {r.advance_open > 0.005 && <div style={warn}>Avans čeka konačni račun: {money(r.advance_open, r.currency)}</div>}
                    </td>
                    <td style={td}>{money(r.paid_on_proformas, r.currency)}</td>
                    <td style={td}>{money(r.covered, r.currency)}</td>
                    <td style={td}>{money(r.used, r.currency)}</td>
                    <td style={td}>{money(r.advance_open, r.currency)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </div>
      </div>
    </div>
  )
}
