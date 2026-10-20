import React, { useEffect, useMemo, useState } from 'react'
import { supabase } from '../supabase'
import { useCompanies } from '../contexts/CompaniesContext'
import { DIALOG, chrome } from './dialogTheme'
import { fmtMoney } from '../utils/formatters'
import { buildPartnerCard } from '../services/partnerCard'
import { loadPartnerCard, type PartnerCardData } from '../services/loadPartnerCard'
import InvoiceDocumentsDialog from './InvoiceDocumentsDialog'

// ─── Kartica partnera ───────────────────────────────────────────────────────
//
// Every change with one partner in date order, with the running balance, for
// reconciling with the partner's own card (layout A, agreed 20.10.2026).
// Advances to suppliers and direct payments are listed below the balance and
// do not move it. The 📎 opens the bill and the supplier's attachments.

const dateSr = (d: string | null) => (d ? d.split('-').reverse().join('.') : '—')

export default function PartnerCardDialog({ partner, onClose }: { partner: { id: string; name: string }; onClose: () => void }) {
  const { companies, defaultCompany, showPicker } = useCompanies()
  const [companyId, setCompanyId] = useState<string>(defaultCompany?.id || '')
  const [from, setFrom] = useState('')
  const [to, setTo] = useState(new Date().toISOString().split('T')[0])
  const [data, setData] = useState<PartnerCardData | null>(null)
  const [error, setError] = useState('')
  const [docsId, setDocsId] = useState<string | null>(null)

  useEffect(() => { if (!companyId && defaultCompany?.id) setCompanyId(defaultCompany.id) }, [defaultCompany?.id]) // eslint-disable-line

  useEffect(() => {
    let cancelled = false
    setData(null); setError('')
    loadPartnerCard(supabase, partner.id, companyId || null)
      .then(d => { if (!cancelled) setData(d) })
      .catch(err => { if (!cancelled) setError(err instanceof Error ? err.message : String(err)) })
    return () => { cancelled = true }
  }, [partner.id, companyId])

  const card = useMemo(() => data && buildPartnerCard(data, { from: from || null, to: to || null }), [data, from, to])
  const money = (n: number) => fmtMoney(n, 'RSD')
  const clip = (id: string | null) => id && data?.withDocs.has(id)
    ? <button aria-label="Račun i prilozi" title="Račun i prilozi" onClick={() => setDocsId(id)}
        style={{ background: 'none', border: 'none', cursor: 'pointer', fontSize: '13px', padding: 0 }}>📎</button>
    : null

  const th: React.CSSProperties = { textAlign: 'left', fontSize: '11px', color: DIALOG.dim, fontWeight: 500, padding: '6px 8px', whiteSpace: 'nowrap' }
  const td: React.CSSProperties = { fontSize: '12px', color: DIALOG.text, padding: '6px 8px', borderTop: '0.5px solid ' + DIALOG.border, verticalAlign: 'top' }
  const num: React.CSSProperties = { ...td, textAlign: 'right', whiteSpace: 'nowrap', fontVariantNumeric: 'tabular-nums' }
  const box: React.CSSProperties = { marginTop: '14px', padding: '10px 12px', borderRadius: '8px', border: '0.5px solid ' + DIALOG.border }
  const input: React.CSSProperties = { background: DIALOG.raised, border: '0.5px solid ' + DIALOG.border, borderRadius: '6px', color: DIALOG.text, padding: '5px 8px', fontSize: '12px' }

  return (
    <div style={chrome.overlay}>
      <div style={{ background: DIALOG.panel, borderRadius: '16px', width: '1000px', maxWidth: '96vw', maxHeight: '92vh', display: 'flex', flexDirection: 'column', overflow: 'hidden' }}>
        <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', padding: '1rem 1.5rem', borderBottom: '0.5px solid ' + DIALOG.border, gap: '12px', flexWrap: 'wrap' }}>
          <div>
            <div style={{ fontSize: '15px', fontWeight: 500, color: DIALOG.text }}>Kartica — {partner.name}</div>
            <div style={{ fontSize: '12px', color: DIALOG.dim, marginTop: '2px' }}>Sve promene sa partnerom i saldo, za usaglašavanje stanja</div>
          </div>
          <div style={{ display: 'flex', alignItems: 'center', gap: '8px', fontSize: '12px', color: DIALOG.dim }}>
            {showPicker && (
              <select aria-label="Firma" style={input} value={companyId} onChange={e => setCompanyId(e.target.value)}>
                {companies.map(c => <option key={c.id} value={c.id}>{c.name}</option>)}
              </select>
            )}
            <label>Od <input aria-label="Od" type="date" style={input} value={from} onChange={e => setFrom(e.target.value)} /></label>
            <label>Do <input aria-label="Do" type="date" style={input} value={to} onChange={e => setTo(e.target.value)} /></label>
            <button aria-label="Zatvori" onClick={onClose} style={{ background: 'none', border: 'none', color: DIALOG.dim, fontSize: '20px', cursor: 'pointer' }}>×</button>
          </div>
        </div>

        <div style={{ padding: '1rem 1.5rem', overflowY: 'auto' }}>
          {error && <div style={{ color: DIALOG.red, fontSize: '12px' }}>Kartica nije učitana: {error}</div>}
          {!card && !error && <div style={{ color: DIALOG.dim, fontSize: '12px' }}>Učitavanje…</div>}
          {card && (
            <>
              <table style={{ width: '100%', borderCollapse: 'collapse' }}>
                <thead>
                  <tr>
                    <th style={th}>Datum</th><th style={th}>Promena</th><th style={th}></th>
                    <th style={{ ...th, textAlign: 'right' }}>Duguje</th>
                    <th style={{ ...th, textAlign: 'right' }}>Potražuje</th>
                    <th style={{ ...th, textAlign: 'right' }}>Saldo</th>
                  </tr>
                </thead>
                <tbody>
                  {from && (
                    <tr>
                      <td style={{ ...td, color: DIALOG.dim }}>{dateSr(from)}</td>
                      <td style={{ ...td, color: DIALOG.dim }}>Početni saldo</td><td style={td}></td>
                      <td style={num}></td><td style={num}></td>
                      <td style={num}>{money(card.opening)}</td>
                    </tr>
                  )}
                  {card.rows.map((r, i) => (
                    <tr key={i}>
                      <td style={{ ...td, whiteSpace: 'nowrap' }}>{dateSr(r.date)}</td>
                      <td style={td}>
                        {r.label}
                        {r.refers && !r.label.endsWith(r.refers) && <span style={{ marginLeft: '6px', fontSize: '10.5px', color: DIALOG.dim }}>· {r.refers}</span>}
                      </td>
                      <td style={td}>{clip(r.documentId)}</td>
                      <td style={num}>{r.debit ? money(r.debit) : ''}</td>
                      <td style={num}>{r.credit ? money(r.credit) : ''}</td>
                      <td style={num}>{money(r.balance)}</td>
                    </tr>
                  ))}
                  {card.rows.length === 0 && (
                    <tr><td style={{ ...td, color: DIALOG.dim }} colSpan={6}>Nema promena u ovom periodu.</td></tr>
                  )}
                </tbody>
              </table>

              <div style={{ display: 'flex', justifyContent: 'space-between', marginTop: '10px', padding: '10px 12px', borderRadius: '8px', fontSize: '14px', fontWeight: 600, color: DIALOG.text,
                background: card.closing > 0.005 ? 'rgba(255,91,90,0.12)' : card.closing < -0.005 ? 'rgba(0,212,126,0.12)' : DIALOG.raised }}>
                <span>{card.verdict}{to ? ` na ${dateSr(to)}` : ''}</span>
                <span>{money(Math.abs(card.closing))}</span>
              </div>

              {(card.advances.invoices.length > 0 || card.advances.proformaPayments.length > 0) && (
                <div style={box}>
                  <div style={{ fontSize: '12px', fontWeight: 600, color: DIALOG.text, marginBottom: '6px' }}>Avansi kod dobavljača (ne ulaze u saldo)</div>
                  {card.advances.proformaPayments.map((p, i) => (
                    <div key={`p${i}`} style={{ display: 'flex', justifyContent: 'space-between', fontSize: '12px', color: DIALOG.text, padding: '2px 0' }}>
                      <span>{dateSr(p.date)} · Isplata po predračunu {p.invoice_number || 'bez broja'} — {p.bank || 'banka'} {clip(p.documentId)}</span>
                      <span>{money(p.amount)}</span>
                    </div>
                  ))}
                  {card.advances.invoices.map(a => (
                    <div key={a.id} style={{ display: 'flex', justifyContent: 'space-between', fontSize: '12px', color: DIALOG.text, padding: '2px 0' }}>
                      <span>{dateSr(a.date)} · Avansni račun {a.invoice_number || 'bez broja'}{a.priorPeriod ? ' (iz ranijeg perioda)' : ''} · {money(a.amount)} · iskorišćeno {money(a.used)} {clip(a.id)}</span>
                      <span style={{ fontWeight: 600 }}>otvoreno {money(a.open)}</span>
                    </div>
                  ))}
                  {card.advances.paidWithoutAdvance > 0.005 && (
                    <div style={{ fontSize: '11px', color: DIALOG.amber, marginTop: '4px' }}>
                      Plaćeno po predračunima bez avansnog računa: {money(card.advances.paidWithoutAdvance)}
                    </div>
                  )}
                </div>
              )}

              {card.direct.length > 0 && (
                <div style={box}>
                  <div style={{ fontSize: '12px', fontWeight: 600, color: DIALOG.text, marginBottom: '6px' }}>Direktna plaćanja bez računa (ne menjaju saldo)</div>
                  {card.direct.map(t => (
                    <div key={t.id} style={{ display: 'flex', justifyContent: 'space-between', fontSize: '12px', color: DIALOG.text, padding: '2px 0' }}>
                      <span>{dateSr(t.date)} · {t.direction === 'in' ? 'Uplata' : 'Isplata'} — {t.bank || 'banka'}{t.note ? ` · „${t.note}“` : ''}</span>
                      <span>{money(t.amount)}</span>
                    </div>
                  ))}
                </div>
              )}
            </>
          )}
        </div>
      </div>
      {docsId && <InvoiceDocumentsDialog invoiceId={docsId} onClose={() => setDocsId(null)} />}
    </div>
  )
}
