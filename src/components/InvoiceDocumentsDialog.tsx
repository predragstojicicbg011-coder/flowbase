import React, { useCallback, useEffect, useRef, useState } from 'react'
import { supabase } from '../supabase'
import { useAuth } from '../contexts/AuthContext'
import { DIALOG, chrome } from './dialogTheme'
import { fmtMoney } from '../utils/formatters'
import {
  loadInvoiceDocuments, loadLinkCandidates, linkInvoiceToSef, pdfStateOf,
  type InvoiceDocuments, type LinkCandidate,
} from '../services/sef/invoiceDocuments'
import { sefObjectUrl, attachmentLabel, refetchSefPdf } from '../services/sef/sefPdf'

// ─── A booked invoice's documents ───────────────────────────────────────────
//
// The invoice PDF and the supplier's attachments, opened from the ledger at
// any time after booking. An invoice booked from the SEF inbox is linked
// already. One typed in by hand can be paired here with the SEF row that is
// still waiting for it — which also takes that row out of the queue.
//
// Everyone in the company may look. Pairing and fetching are for those who
// keep the books, and the database checks that again.

interface Props { invoiceId: string; onClose: () => void; onLinked?: () => void }

/** A failed call's real reason is in the response body, not in `message`. */
async function reasonFrom(err: any): Promise<string> {
  try {
    const body = await err?.context?.json?.()
    if (body?.error) return String(body.error)
    if (body?.message) return String(body.message)
  } catch { /* not JSON */ }
  return err?.message || 'Poziv nije uspeo.'
}

const SEF_STATUS: Record<string, string> = {
  new: 'Nova', seen: 'Pregledana', approved: 'Prihvaćena', rejected: 'Odbijena',
  cancelled: 'Otkazana', storno: 'Stornirana',
}
const statusLabel = (s: string | null) => (s ? SEF_STATUS[s.trim().toLowerCase()] || s : '—')

export default function InvoiceDocumentsDialog({ invoiceId, onClose, onLinked }: Props) {
  const { canEdit: keepsBooks } = useAuth()
  const [docs, setDocs] = useState<InvoiceDocuments | null>(null)
  const [candidates, setCandidates] = useState<LinkCandidate[] | null>(null)
  const [error, setError] = useState('')
  const [notice, setNotice] = useState('')
  const [busy, setBusy] = useState(false)
  const inFlight = useRef(false)

  const load = useCallback(async () => {
    setError('')
    try {
      const d = await loadInvoiceDocuments(supabase, invoiceId)
      setDocs(d)
      setCandidates(!d.linked && d.invoice.type === 'expense' ? await loadLinkCandidates(supabase, d.invoice) : null)
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e))
    }
  }, [invoiceId])

  useEffect(() => { load() }, [load])

  /** One action at a time: a second click while SEF is being asked is dropped. */
  const exclusive = async (fn: () => Promise<void>) => {
    if (inFlight.current) return
    inFlight.current = true; setBusy(true); setError(''); setNotice('')
    try { await fn() } catch (e) { setError(e instanceof Error ? e.message : String(e)) }
    finally { inFlight.current = false; setBusy(false) }
  }

  /** The tab is opened before the await, or the browser treats it as a pop-up. */
  const openSigned = async (path: string) => {
    const tab = window.open('', '_blank')
    try {
      const url = await sefObjectUrl(supabase, path)
      if (!url) throw new Error('PDF nije dostupan.')
      if (tab) { tab.opener = null; tab.location.href = url } else window.open(url, '_blank', 'noopener')
    } catch (e) {
      tab?.close()
      setError(`PDF ne može da se otvori: ${e instanceof Error ? e.message : String(e)}`)
    }
  }

  const link = (c: LinkCandidate) => exclusive(async () => {
    if (!window.confirm(`Povezati ovu fakturu sa SEF fakturom ${c.row.document_number || c.row.sef_invoice_id} (${c.row.supplier_name || 'dobavljač'})?\n\nSEF faktura time izlazi iz sandučeta kao proknjižena.`)) return
    await linkInvoiceToSef(supabase, c.row.id, invoiceId)
    await load()
    setNotice('Povezano. Ako PDF još nije preuzet, preuzmite ga ispod.')
    onLinked?.()
  })

  /** Opens a linked row that was never opened — the same fetch the inbox makes. */
  const fetchDocument = () => exclusive(async () => {
    const row = docs?.linked
    if (!row) return
    const state = pdfStateOf(row)
    if (state.kind === 'never_opened' && state.isNew
      && !window.confirm('Na SEF-u je ova faktura još „Nova“. Preuzimanje će je tamo označiti kao pregledanu, i to vidi i knjigovodstvena agencija.\n\nPreuzeti?')) return
    const { data, error: fnErr } = await supabase.functions.invoke('sef-fetch-invoice', { body: { id: row.id } })
    if (fnErr) throw new Error(await reasonFrom(fnErr))
    if (!data || data.error) throw new Error(data?.error || 'Dokument nije mogao da se preuzme.')
    await load()
    setNotice(data.pdf_path ? 'Dokument je preuzet i sačuvan.' : (data.pdf_note || data.pdf_error || 'Dokument je preuzet, ali nema PDF.'))
  })

  /** The PDFs again, for a row opened before they were kept or that kept an attachment. */
  const refetch = () => exclusive(async () => {
    const row = docs?.linked
    if (!row) return
    const r = await refetchSefPdf(supabase, row, reasonFrom)
    await load()
    setNotice(r.note || 'Račun je ponovo preuzet sa SEF-a.')
  })

  const inv = docs?.invoice
  const row = docs?.linked || null
  const state = row ? pdfStateOf(row) : null

  return (
    <div style={chrome.overlay} onClick={onClose}>
      <div style={s.dialog} role="dialog" aria-label="Dokumenti fakture" onClick={e => e.stopPropagation()}>
        <div style={chrome.header}>
          <div>
            <div style={chrome.headerTitle}>Dokumenti fakture{inv?.invoice_number ? ` ${inv.invoice_number}` : ''}</div>
            <div style={chrome.headerSub}>Račun i prilozi dobavljača sa SEF-a</div>
          </div>
          <button style={chrome.closeBtn} onClick={onClose} aria-label="Zatvori">×</button>
        </div>

        <div style={s.body}>
          {error && <div role="alert" style={s.error}>{error}</div>}
          {notice && <div role="status" style={s.notice}>{notice}</div>}
          {!docs && !error && <div style={s.dim}>Učitavanje…</div>}

          {row && (
            <>
              <div style={s.card}>
                <div style={s.title}>{row.supplier_name || 'Dobavljač'} · {row.document_number || `SEF ${row.sef_invoice_id}`}</div>
                <div style={s.dim}>
                  {row.amount !== null ? fmtMoney(row.amount, row.currency || 'RSD') : '—'}
                  {' · '}Status na SEF-u: {statusLabel(row.sef_status)}
                  {row.supplier_vat_number ? ` · PIB ${row.supplier_vat_number}` : ''}
                </div>
              </div>

              <div style={s.section}>Račun</div>
              {row.pdf_path
                ? <button style={s.docBtn} onClick={() => openSigned(row.pdf_path!)}>📄 Prikaži račun (PDF)</button>
                : <div style={s.dim}>PDF računa nije sačuvan.</div>}
              {state?.kind === 'attachment_only' && (
                <div style={s.hint}>Sačuvan je PDF koji je dobavljač priložio, ne SEF-ov prikaz računa.</div>
              )}
              {row.pdf_note && <div style={s.hint}>{row.pdf_note}</div>}

              {keepsBooks && state?.kind === 'never_opened' && (
                <button style={s.actionBtn} disabled={busy} onClick={fetchDocument}>Preuzmi dokument sa SEF-a</button>
              )}
              {keepsBooks && (state?.kind === 'opened_without_pdf' || state?.kind === 'attachment_only') && (
                <button style={s.actionBtn} disabled={busy} onClick={refetch}
                  title="Ponovo preuzima dokument samo radi PDF-a. Ne radi se za fakturu koja je na SEF-u još nova.">
                  Preuzmi račun sa SEF-a
                </button>
              )}

              <div style={s.section}>Prilozi dobavljača ({docs!.attachments.length})</div>
              {docs!.attachments.length === 0
                ? <div style={s.dim}>{row.ubl_fetched_at ? 'Dobavljač nije priložio PDF dokumente.' : 'Prilozi se vide kad se dokument preuzme.'}</div>
                : docs!.attachments.map(a => (
                  <button key={a.id} style={s.docBtn} onClick={() => openSigned(a.path)}>📎 {attachmentLabel(a)}</button>
                ))}
            </>
          )}

          {docs && !row && (
            inv?.type !== 'expense'
              ? <div style={s.dim}>Dokumenti sa SEF-a postoje samo za ulazne fakture.</div>
              : (
                <>
                  <div style={s.dim}>Ova faktura nije povezana sa SEF-om — verovatno je uneta ručno.</div>
                  <div style={s.section}>Moguće SEF fakture iz sandučeta</div>
                  {candidates === null && <div style={s.dim}>Učitavanje…</div>}
                  {candidates?.length === 0 && (
                    <div style={s.dim}>U sandučetu nema SEF fakture na čekanju sa istim PIB-om ili brojem.</div>
                  )}
                  {candidates?.map(c => (
                    <div key={c.row.id} style={s.candidate}>
                      <div style={{ flex: 1, minWidth: 0 }}>
                        <div style={s.title}>{c.row.supplier_name || 'Dobavljač'} · {c.row.document_number || `SEF ${c.row.sef_invoice_id}`}</div>
                        <div style={s.dim}>
                          {c.row.amount !== null ? fmtMoney(c.row.amount, c.row.currency || 'RSD') : '—'}
                          {c.row.sent_date ? ` · stigla ${c.row.sent_date.slice(0, 10)}` : ''}
                          {' · '}{c.reasons.join(', ')}
                        </div>
                      </div>
                      {keepsBooks && (
                        <button style={s.actionBtn} disabled={busy} onClick={() => link(c)}>Poveži</button>
                      )}
                    </div>
                  ))}
                </>
              )
          )}
        </div>
      </div>
    </div>
  )
}

const s: Record<string, React.CSSProperties> = {
  dialog: {
    background: DIALOG.panel, border: '0.5px solid ' + DIALOG.border, borderRadius: '14px',
    width: '560px', maxWidth: '92vw', maxHeight: '88vh', overflow: 'auto', boxShadow: DIALOG.shadow,
  },
  body: { padding: '1.25rem 1.5rem', display: 'flex', flexDirection: 'column', gap: '10px' },
  card: { background: DIALOG.raised, border: `0.5px solid ${DIALOG.borderSoft}`, borderRadius: '10px', padding: '12px 14px' },
  title: { color: DIALOG.text, fontSize: '14px', fontWeight: 500 },
  dim: { color: DIALOG.dim, fontSize: '12px', marginTop: '2px' },
  hint: { color: DIALOG.amber, fontSize: '12px' },
  section: { color: DIALOG.dim, fontSize: '11px', textTransform: 'uppercase', letterSpacing: '0.06em', marginTop: '8px' },
  docBtn: {
    textAlign: 'left', background: DIALOG.raised, border: `0.5px solid ${DIALOG.border}`, color: DIALOG.text,
    borderRadius: '8px', padding: '9px 12px', fontSize: '13px', cursor: 'pointer',
  },
  actionBtn: {
    alignSelf: 'flex-start', background: DIALOG.accentFill, border: `0.5px solid ${DIALOG.accentSoft}`,
    color: DIALOG.accent, borderRadius: '8px', padding: '7px 12px', fontSize: '12px', fontWeight: 500, cursor: 'pointer',
  },
  candidate: {
    display: 'flex', gap: '12px', alignItems: 'center', background: DIALOG.raised,
    border: `0.5px solid ${DIALOG.borderSoft}`, borderRadius: '10px', padding: '10px 12px',
  },
  error: { background: DIALOG.redFill, border: `0.5px solid ${DIALOG.redSoft}`, color: DIALOG.red, borderRadius: '8px', padding: '8px 12px', fontSize: '12px' },
  notice: { background: DIALOG.accentFill, border: `0.5px solid ${DIALOG.accentSoft}`, color: DIALOG.accent, borderRadius: '8px', padding: '8px 12px', fontSize: '12px' },
}
