import React, { useState } from 'react'
import { supabase } from '../supabase'
import { DIALOG, chrome } from './dialogTheme'
import { toBookAmounts } from '../services/bookAmounts'
import { fmtRSD } from '../utils/formatters'

// ─── What is in the accounts, and when it was read ──────────────────────────
//
// Runway is cash divided by burn. Burn is in the ledger. Cash is not — there
// is no balance anywhere in this application: `transactions` records
// movements, nothing carries an opening figure, and summing every movement
// ever posted gives net movement since the ledger began, which is a balance
// only if it began at zero. It did not.
//
// So it is asked for, and the answer is DATED. A cash position is a fact about
// a moment, not a property of the company: 612k on the 25th of September is a
// reading. Stored as one editable figure it would make last quarter's runway
// unreconstructible the moment somebody updated it — the same reason budget
// figures are a ledger rather than one overwritten number.
//
// The panel shows the date beside the figure, because a reading three weeks
// old is still the best answer available and its age is part of what it means.
//
// The reading is typed in dinars, the currency the books are kept in, and the
// EUR figure beside it is worked out at the NBS rate of the day it was read.

export default function CashPositionDialog({ onClose, onSaved, current }: {
  onClose: () => void
  onSaved: () => void
  /** The latest reading, in RSD. */
  current: { amount: number; asOf: string } | null
}) {
  const today = new Date().toISOString().slice(0, 10)
  const [asOf, setAsOf] = useState(today)
  const [amount, setAmount] = useState(current ? current.amount.toFixed(2) : '')
  const [note, setNote] = useState('')
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState('')

  const parsed = amount.trim() === '' ? null : Number(amount.trim())
  const usable = parsed !== null && Number.isFinite(parsed) && parsed >= 0

  const save = async () => {
    // An empty box is not zero. Zero cash is a real and serious reading and a
    // person who means it types 0; a blank means they have not answered.
    if (!usable) {
      setError('Unesite stanje na računima. Prazno polje nije nula — unesite 0 ako je to stanje.')
      return
    }
    if (!asOf) { setError('Unesite datum na koji je stanje očitano.'); return }
    setSaving(true); setError('')

    let amountEur: number
    try {
      amountEur = (await toBookAmounts(parsed as number, 'RSD', asOf)).amount_eur
    } catch (e: any) {
      setError(`Nije sačuvano: ${e?.message || String(e)}`)
      setSaving(false)
      return
    }

    // One reading per day: a second is a correction of the first, not a
    // second fact about it. The unique index says so and this lands on it.
    const { error: upErr } = await supabase.from('cash_positions')
      .upsert({ as_of: asOf, amount_rsd: parsed, amount_eur: amountEur, note: note.trim() || null },
        { onConflict: 'as_of' })
    if (upErr) { setError(`Čuvanje nije uspelo: ${upErr.message}`); setSaving(false); return }
    onSaved()
    onClose()
  }

  return (
    <div style={chrome.overlay}>
      <div style={s.dialog}>
        <div style={chrome.header}>
          <div>
            <div style={chrome.headerTitle}>Stanje novca</div>
            <div style={chrome.headerSub}>Osnovica za izračun koliko dugo novac traje</div>
          </div>
          <button style={chrome.closeBtn} onClick={onClose} aria-label="Zatvori">×</button>
        </div>

        <div style={{ padding: '1.5rem', display: 'flex', flexDirection: 'column', gap: '14px' }}>
          <div style={{ fontSize: '12px', color: DIALOG.faint, lineHeight: 1.55 }}>
            Glavna knjiga ne sadrži stanje novca — beleži samo promene, a nijedna stavka ne nosi
            početno stanje. Zato se stanje unosi ručno i čuva sa datumom: proračun urađen danas
            treba i sledećeg kvartala da se čita prema iznosu iz kog je zaista izračunat.
          </div>

          <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '12px' }}>
            <div>
              <div style={s.lbl}>Stanje na dan</div>
              <input style={s.input} type="date" value={asOf} max={today}
                aria-label="Stanje na dan" onChange={e => setAsOf(e.target.value)} />
            </div>
            <div>
              <div style={s.lbl}>Ukupno, svi računi, RSD</div>
              <input style={s.input} type="number" value={amount} autoFocus
                aria-label="Ukupno, svi računi, RSD"
                onChange={e => setAmount(e.target.value)} placeholder="71850000.00" />
            </div>
          </div>

          {current && (
            <div style={{ fontSize: '11.5px', color: DIALOG.dim }}>
              Poslednje uneto stanje: {fmtRSD(current.amount)} na dan {current.asOf}.
              {current.asOf === asOf && ' Čuvanje ga zamenjuje — jedno stanje po danu.'}
            </div>
          )}

          <div>
            <div style={s.lbl}>Napomena</div>
            <input style={s.input} value={note} aria-label="Napomena"
              onChange={e => setNote(e.target.value)}
              placeholder="Četiri računa, EUR i RSD preračunati po kursu na taj dan" />
          </div>

          {error && (
            <div style={{ background: DIALOG.redFill, border: '0.5px solid ' + DIALOG.redSoft, borderRadius: '8px', padding: '9px 12px', fontSize: '12px', color: DIALOG.red }}>
              ⚠️ {error}
            </div>
          )}
        </div>

        <div style={{ padding: '1rem 1.5rem', borderTop: '0.5px solid ' + DIALOG.border, display: 'flex', justifyContent: 'flex-end', gap: '8px', background: DIALOG.raised }}>
          <button style={s.cancel} onClick={onClose}>Otkaži</button>
          <button style={{ ...s.save, opacity: saving ? 0.6 : 1 }} onClick={save} disabled={saving}>
            {saving ? 'Čuvanje…' : 'Sačuvaj stanje'}
          </button>
        </div>
      </div>
    </div>
  )
}

const s: Record<string, React.CSSProperties> = {
  dialog: {
    background: DIALOG.panel, border: '0.5px solid ' + DIALOG.border, borderRadius: '14px',
    width: '470px', maxWidth: '92vw', maxHeight: '88vh', overflow: 'auto',
    boxShadow: '0 24px 64px rgba(0,0,0,0.55)',
  },
  lbl: {
    fontSize: '10px', fontWeight: 500, color: DIALOG.faint, marginBottom: '5px',
    textTransform: 'uppercase', letterSpacing: '0.07em',
  },
  input: {
    width: '100%', boxSizing: 'border-box', fontFamily: 'system-ui,sans-serif',
    fontSize: '13px', padding: '8px 10px', borderRadius: '8px', outline: 'none',
    border: '1px solid ' + DIALOG.border, background: DIALOG.raised, color: DIALOG.text,
  },
  cancel: {
    fontSize: '12px', padding: '8px 14px', borderRadius: '8px', cursor: 'pointer',
    border: '1px solid ' + DIALOG.border, background: 'transparent', color: DIALOG.dim,
  },
  save: {
    fontSize: '12px', padding: '8px 16px', borderRadius: '8px', cursor: 'pointer',
    border: 'none', background: DIALOG.accent, color: '#060E1A', fontWeight: 600,
  },
}
