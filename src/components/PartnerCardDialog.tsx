import React, { useEffect, useMemo, useState } from 'react'
import { supabase } from '../supabase'
import { useCompanies } from '../contexts/CompaniesContext'
import { DIALOG, chrome } from './dialogTheme'
import { fmtMoney } from '../utils/formatters'
import { buildPartnerCard } from '../services/partnerCard'
import { loadPartnerCard, type CardCurrency, type PartnerCardData } from '../services/loadPartnerCard'
import DocumentViewerDialog from './DocumentViewerDialog'
import { partnerCardPrintHtml } from '../services/partnerCardPrint'
import { iosNumber, iosPrintHtml, openItemsAsOf } from '../services/iosStatement'

// ─── Kartica partnera ───────────────────────────────────────────────────────
//
// Every change with one partner in date order, with the running balance, for
// reconciling with the partner's own card (layout A, agreed 20.10.2026).
// Advances to suppliers and direct payments are listed below the balance and
// do not move it. „PDF“ shows the bill and the supplier's attachments in place.
// In dinars or in euros, as booked.

const dateSr = (d: string | null) => (d ? d.split('-').reverse().join('.') : '—')

export default function PartnerCardDialog({ partner, onClose }: { partner: { id: string; name: string }; onClose: () => void }) {
  const { companies, defaultCompany, showPicker } = useCompanies()
  const [companyId, setCompanyId] = useState<string>(defaultCompany?.id || '')
  const [from, setFrom] = useState('')
  // Today in the local calendar: toISOString() is UTC, a day behind after midnight here.
  const [to, setTo] = useState(() => { const d = new Date(); return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}` })
  const [data, setData] = useState<PartnerCardData | null>(null)
  const [error, setError] = useState('')
  const [viewing, setViewing] = useState<{ id: string; title: string } | null>(null)
  const [currency, setCurrency] = useState<CardCurrency>('RSD')

  useEffect(() => { if (!companyId && defaultCompany?.id) setCompanyId(defaultCompany.id) }, [defaultCompany?.id]) // eslint-disable-line

  useEffect(() => {
    let cancelled = false
    setData(null); setError('')
    loadPartnerCard(supabase, partner.id, companyId || null, currency)
      .then(d => { if (!cancelled) setData(d) })
      .catch(err => { if (!cancelled) setError(err instanceof Error ? err.message : String(err)) })
    return () => { cancelled = true }
  }, [partner.id, companyId, currency])

  const [exporting, setExporting] = useState(false)

  /**
   * The card as it is on screen (company, period) printed from a hidden frame:
   * the print dialog's "Save as PDF" makes the file (the client's choice).
   */
  const exportPdf = async () => {
    if (!card) return
    setExporting(true)
    try {
      const { company, who, today } = await parties()
      const html = partnerCardPrintHtml({
        company: company || { full_legal_name: companies.find(c => c.id === companyId)?.name || '' },
        partner: who || { name: partner.name },
        period: { from: from || null, to: to || null },
        card,
        generatedOn: today,
        currency,
      })
      printInFrame(html, 'Kartica za štampu')
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err))
    } finally {
      setExporting(false)
    }
  }

  /** Both parties for a printed page, and today in the local calendar. */
  const parties = async () => {
    const [{ data: company }, { data: who }] = await Promise.all([
      companyId
        ? supabase.from('company_profiles').select('full_legal_name, address, city, pib, mb').eq('company_id', companyId).maybeSingle()
        : Promise.resolve({ data: null }),
      supabase.from('partners').select('name, tax_id, registration_number, address, city').eq('id', partner.id).maybeSingle(),
    ])
    const d = new Date()
    const today = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`
    return { company: company || { full_legal_name: companies.find(c => c.id === companyId)?.name || '' }, who: who || { name: partner.name }, today }
  }

  /** A page into a hidden frame, which opens the print dialog (Save as PDF). */
  const printInFrame = (html: string, title: string) => {
    document.querySelectorAll(`iframe[title="${title}"]`).forEach(f => f.remove())
    const frame = document.createElement('iframe')
    frame.title = title
    Object.assign(frame.style, { position: 'fixed', width: '0', height: '0', border: '0', right: '0', bottom: '0' })
    frame.srcdoc = html
    document.body.appendChild(frame)
  }

  /**
   * IOS (izvod otvorenih stavki) on the card's end date: the open documents
   * and their total, which is the card's balance on that day; advances apart.
   */
  const exportIos = async () => {
    if (!data) return
    setExporting(true)
    try {
      const { company, who, today } = await parties()
      const asOf = to || today
      const onDay = buildPartnerCard(data, { from: null, to: asOf })
      const html = iosPrintHtml({
        company, partner: who, asOf,
        statement: openItemsAsOf(data, asOf),
        advancesOpen: onDay.advances.invoices.reduce((sum, a) => sum + a.open, 0),
        number: iosNumber((who as any).tax_id, asOf),
        generatedOn: today,
        currency,
      })
      printInFrame(html, 'IOS za štampu')
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err))
    } finally {
      setExporting(false)
    }
  }

  const card = useMemo(() => data && buildPartnerCard(data, { from: from || null, to: to || null }), [data, from, to])
  const money = (n: number) => fmtMoney(n, currency)
  /** The document's PDF, named by its number: on a payment's row it is the bill paid. */
  const clip = (id: string | null) => {
    if (!id || !data?.withDocs.has(id)) return null
    const number = data.documents.find(d => d.id === id)?.invoice_number || 'bez broja'
    return <button aria-label={`PDF ${number}`} title="Prikaži račun i priloge" onClick={() => setViewing({ id, title: `${partner.name} · ${number}` })} style={pdfChip}>PDF</button>
  }

  const th: React.CSSProperties = { textAlign: 'left', fontSize: '11px', color: DIALOG.dim, fontWeight: 500, padding: '6px 8px', whiteSpace: 'nowrap' }
  const td: React.CSSProperties = { fontSize: '12px', color: DIALOG.text, padding: '6px 8px', borderTop: '0.5px solid ' + DIALOG.border, verticalAlign: 'top' }
  const num: React.CSSProperties = { ...td, textAlign: 'right', whiteSpace: 'nowrap', fontVariantNumeric: 'tabular-nums' }
  const box: React.CSSProperties = { marginTop: '14px', padding: '10px 12px', borderRadius: '8px', border: '0.5px solid ' + DIALOG.border }
  const pdfChip: React.CSSProperties = { background: DIALOG.accentFill, border: '0.5px solid ' + DIALOG.accentSoft, color: DIALOG.accent, borderRadius: '5px', padding: '1px 7px', fontSize: '10.5px', fontWeight: 600, cursor: 'pointer', marginLeft: '6px', verticalAlign: 'middle' }
  const input: React.CSSProperties = { background: DIALOG.raised, border: '0.5px solid ' + DIALOG.border, borderRadius: '6px', color: DIALOG.text, padding: '5px 8px', fontSize: '12px' }

  return (
    <div style={chrome.overlay}>
      <div style={{ background: DIALOG.panel, borderRadius: '16px', width: '1000px', maxWidth: '96vw', maxHeight: '92vh', display: 'flex', flexDirection: 'column', overflow: 'hidden' }}>
        <div style={{ padding: '1rem 1.5rem', borderBottom: '0.5px solid ' + DIALOG.border }}>
          <div style={{ display: 'flex', alignItems: 'flex-start', justifyContent: 'space-between', gap: '12px' }}>
            <div>
              <div style={{ fontSize: '15px', fontWeight: 500, color: DIALOG.text }}>Kartica — {partner.name}</div>
              <div style={{ fontSize: '12px', color: DIALOG.dim, marginTop: '2px' }}>Sve promene sa partnerom i saldo, za usaglašavanje stanja</div>
            </div>
            <button aria-label="Zatvori" onClick={onClose} style={{ background: 'none', border: 'none', color: DIALOG.dim, fontSize: '22px', lineHeight: 1, cursor: 'pointer', padding: 0 }}>×</button>
          </div>
          <div style={{ display: 'flex', alignItems: 'center', gap: '8px', fontSize: '12px', color: DIALOG.dim, marginTop: '10px', flexWrap: 'wrap' }}>
            {showPicker && (
              <select aria-label="Firma" style={input} value={companyId} onChange={e => setCompanyId(e.target.value)}>
                {companies.map(c => <option key={c.id} value={c.id}>{c.name}</option>)}
              </select>
            )}
            <select aria-label="Valuta" style={input} value={currency} onChange={e => setCurrency(e.target.value as CardCurrency)}>
              <option value="RSD">RSD</option>
              <option value="EUR">EUR</option>
            </select>
            <label>Od <input aria-label="Od" type="date" style={input} value={from} onChange={e => setFrom(e.target.value)} /></label>
            <label>Do <input aria-label="Do" type="date" style={input} value={to} onChange={e => setTo(e.target.value)} /></label>
            <button onClick={exportPdf} disabled={!card || exporting}
              style={{ ...input, cursor: card ? 'pointer' : 'default', color: DIALOG.accent }}>
              {exporting ? '…' : 'Izvezi PDF'}
            </button>
            <button onClick={exportIos} disabled={!data || exporting} title="Izvod otvorenih stavki na dan „Do“"
              style={{ ...input, cursor: data ? 'pointer' : 'default', color: DIALOG.accent }}>
              IOS
            </button>
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
                    <th style={th}>Datum</th><th style={th}>Promena</th><th style={th}>Dokument</th>
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
      {viewing && <DocumentViewerDialog invoiceId={viewing.id} title={viewing.title} onClose={() => setViewing(null)} />}
    </div>
  )
}
