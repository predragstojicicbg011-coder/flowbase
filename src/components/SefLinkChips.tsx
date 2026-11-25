import React, { useState } from 'react'
import { supabase } from '../supabase'
import { openInNewTab, sefPdfUrl } from '../services/sef/sefPdf'
import { sefLinkLabel, type CreditSefLink } from '../services/sef/creditSefLinks'

// The SEF interest invoices linked to one instalment, each opening its PDF in
// a new tab the way the SEF inbox does. Reads storage only, never SEF.

export default function SefLinkChips({ links }: { links: CreditSefLink[] }) {
  const [refused, setRefused] = useState('')
  if (links.length === 0) return null
  const open = async (l: CreditSefLink) => {
    setRefused('')
    const why = await openInNewTab(() => sefPdfUrl(supabase, { pdf_path: l.pdfPath }))
    if (why) setRefused(why)
  }
  return (
    <div style={{ display: 'flex', flexWrap: 'wrap', alignItems: 'center', gap: '6px' }}>
      {links.map(l => l.pdfPath
        ? (
          <button key={l.inboxId} title="Otvori PDF fakture"
            onClick={e => { e.stopPropagation(); open(l) }}
            style={chip}>
            {sefLinkLabel(l)}
          </button>
        )
        : <span key={l.inboxId} style={{ ...chip, cursor: 'default', opacity: 0.75 }}>{`${sefLinkLabel(l)} (PDF nije sačuvan)`}</span>)}
      {refused && <span role="alert" style={{ fontSize: '11px', color: '#FF5B5A' }}>{refused}</span>}
    </div>
  )
}

const chip: React.CSSProperties = {
  fontFamily: "'Inter',sans-serif", fontSize: '11px', fontWeight: 500, padding: '3px 10px', borderRadius: '20px',
  border: '1px solid rgba(139,139,255,0.35)', background: 'rgba(139,139,255,0.10)', color: '#A9A9FF', cursor: 'pointer',
}
