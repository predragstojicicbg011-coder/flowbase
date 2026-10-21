import React, { useEffect, useState } from 'react'
import { supabase } from '../supabase'
import { DIALOG, chrome } from './dialogTheme'
import { loadInvoiceDocuments, UPLOAD_BUCKET } from '../services/sef/invoiceDocuments'
import { sefObjectUrl, attachmentLabel, SEF_PDF_URL_SECONDS } from '../services/sef/sefPdf'

// ─── A bill's PDF, read in place ────────────────────────────────────────────
//
// Opened from the partner card and the unpaid list: the invoice PDF and the
// supplier's attachments shown inside the app, over the list one came from,
// so a bill is looked at before it is paid without leaving the list. Pairing
// and uploading stay in InvoiceDocumentsDialog; this only shows.

export interface ViewerDocument { key: string; label: string; path: string; bucket?: string }

/** The bill's documents in the order they are offered: the invoice, its attachments, uploads. */
export function viewerDocuments(d: Awaited<ReturnType<typeof loadInvoiceDocuments>>): ViewerDocument[] {
  const out: ViewerDocument[] = []
  if (d.linked?.pdf_path) out.push({ key: 'sef', label: 'Račun', path: d.linked.pdf_path })
  d.attachments.forEach(a => out.push({ key: `a${a.id}`, label: attachmentLabel(a), path: a.path }))
  d.uploads.forEach(u => out.push({ key: `u${u.id}`, label: u.description ? `${u.filename} — ${u.description}` : u.filename, path: u.path, bucket: UPLOAD_BUCKET }))
  return out
}

export default function DocumentViewerDialog({ invoiceId, title, onClose }: { invoiceId: string; title?: string; onClose: () => void }) {
  const [docs, setDocs] = useState<ViewerDocument[] | null>(null)
  const [current, setCurrent] = useState<string | null>(null)
  const [url, setUrl] = useState<string | null>(null)
  const [error, setError] = useState('')

  useEffect(() => {
    let cancelled = false
    loadInvoiceDocuments(supabase, invoiceId)
      .then(d => {
        if (cancelled) return
        const list = viewerDocuments(d)
        setDocs(list)
        setCurrent(list[0]?.key ?? null)
      })
      .catch(e => { if (!cancelled) setError(e instanceof Error ? e.message : String(e)) })
    return () => { cancelled = true }
  }, [invoiceId])

  useEffect(() => {
    const doc = docs?.find(d => d.key === current)
    if (!doc) return
    let cancelled = false
    setUrl(null); setError('')
    ;(doc.bucket
      ? supabase.storage.from(doc.bucket).createSignedUrl(doc.path, SEF_PDF_URL_SECONDS).then(r => r.data?.signedUrl ?? null)
      : sefObjectUrl(supabase, doc.path))
      .then(u => { if (!cancelled) { if (u) setUrl(u); else setError('PDF nije dostupan.') } })
      .catch(e => { if (!cancelled) setError(`PDF ne može da se otvori: ${e instanceof Error ? e.message : String(e)}`) })
    return () => { cancelled = true }
  }, [docs, current])

  // Esc closes only the viewer, not the list it was opened over.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') { e.stopImmediatePropagation(); onClose() } }
    window.addEventListener('keydown', onKey, true)
    return () => window.removeEventListener('keydown', onKey, true)
  }, [onClose])

  return (
    <div style={{ ...chrome.overlay, zIndex: 1100 }} onClick={e => { e.stopPropagation(); onClose() }}>
      <div role="dialog" aria-label="Pregled dokumenta" onClick={e => e.stopPropagation()}
        style={{ background: DIALOG.panel, border: '0.5px solid ' + DIALOG.border, borderRadius: '14px', width: '1100px', maxWidth: '96vw', height: '92vh', display: 'flex', flexDirection: 'column', overflow: 'hidden', boxShadow: DIALOG.shadow }}>
        <div style={chrome.header}>
          <div style={chrome.headerTitle}>{title || 'Dokument'}</div>
          <div style={{ display: 'flex', alignItems: 'center', gap: '10px' }}>
            {url && <a href={url} target="_blank" rel="noopener noreferrer" style={{ fontSize: '12px', color: DIALOG.accent }}>Otvori u novom tabu ↗</a>}
            <button style={chrome.closeBtn} onClick={onClose} aria-label="Zatvori pregled">×</button>
          </div>
        </div>
        {docs && docs.length > 1 && (
          <div style={{ display: 'flex', gap: '6px', flexWrap: 'wrap', padding: '8px 1.5rem', borderBottom: '0.5px solid ' + DIALOG.border }}>
            {docs.map(d => (
              <button key={d.key} onClick={() => setCurrent(d.key)} aria-pressed={d.key === current}
                style={{ fontSize: '12px', padding: '5px 10px', borderRadius: '6px', cursor: 'pointer',
                  border: '0.5px solid ' + (d.key === current ? DIALOG.accentSoft : DIALOG.border),
                  background: d.key === current ? DIALOG.accentFill : DIALOG.raised,
                  color: d.key === current ? DIALOG.accent : DIALOG.text }}>
                {d.label}
              </button>
            ))}
          </div>
        )}
        <div style={{ flex: 1, minHeight: 0, display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
          {error && <div role="alert" style={{ color: DIALOG.red, fontSize: '13px' }}>{error}</div>}
          {!error && docs && docs.length === 0 && <div style={{ color: DIALOG.dim, fontSize: '13px' }}>Za ovaj račun nema sačuvanog PDF-a.</div>}
          {!error && (!docs || (docs.length > 0 && !url)) && <div style={{ color: DIALOG.dim, fontSize: '13px' }}>Učitavanje…</div>}
          {!error && url && <iframe title="PDF dokument" src={url} style={{ width: '100%', height: '100%', border: 0, background: '#fff' }} />}
        </div>
      </div>
    </div>
  )
}
