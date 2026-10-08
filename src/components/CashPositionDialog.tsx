import React, { useState } from 'react'
import { supabase } from '../supabase'
import { DIALOG, chrome } from './dialogTheme'

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

export default function CashPositionDialog({ onClose, onSaved, current }: {
  onClose: () => void
  onSaved: () => void
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
      setError('Type what is in the accounts. An empty box is not zero — type 0 if that is what you mean.')
      return
    }
    if (!asOf) { setError('Say which day this was read.'); return }
    setSaving(true); setError('')

    // One reading per day: a second is a correction of the first, not a
    // second fact about it. The unique index says so and this lands on it.
    const { error: upErr } = await supabase.from('cash_positions')
      .upsert({ as_of: asOf, amount_usd: parsed, note: note.trim() || null },
        { onConflict: 'as_of' })
    if (upErr) { setError(`Could not save: ${upErr.message}`); setSaving(false); return }
    onSaved()
    onClose()
  }

  return (
    <div style={chrome.overlay}>
      <div style={s.dialog}>
        <div style={chrome.header}>
          <div>
            <div style={chrome.headerTitle}>Cash on hand</div>
            <div style={chrome.headerSub}>What the runway is divided out of</div>
          </div>
          <button style={chrome.closeBtn} onClick={onClose} aria-label="Close">×</button>
        </div>

        <div style={{ padding: '1.5rem', display: 'flex', flexDirection: 'column', gap: '14px' }}>
          <div style={{ fontSize: '12px', color: DIALOG.faint, lineHeight: 1.55 }}>
            There is no cash balance in the ledger to read this from — it records movements,
            and nothing carries an opening figure. So it is asked for, and kept with its date:
            a runway worked out today should still be readable next quarter at the figure it
            was actually worked out from.
          </div>

          <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '12px' }}>
            <div>
              <div style={s.lbl}>Read on</div>
              <input style={s.input} type="date" value={asOf} max={today}
                aria-label="Read on" onChange={e => setAsOf(e.target.value)} />
            </div>
            <div>
              <div style={s.lbl}>Total, all accounts, USD</div>
              <input style={s.input} type="number" value={amount} autoFocus
                aria-label="Total, all accounts, USD"
                onChange={e => setAmount(e.target.value)} placeholder="612400.00" />
            </div>
          </div>

          {current && (
            <div style={{ fontSize: '11.5px', color: DIALOG.dim }}>
              The last reading was ${current.amount.toFixed(2)} on {current.asOf}.
              {current.asOf === asOf && ' Saving replaces it — one reading per day.'}
            </div>
          )}

          <div>
            <div style={s.lbl}>Note</div>
            <input style={s.input} value={note} aria-label="Note"
              onChange={e => setNote(e.target.value)}
              placeholder="Four accounts, EUR and RSD converted at the day's rate" />
          </div>

          {error && (
            <div style={{ background: DIALOG.redFill, border: '0.5px solid ' + DIALOG.redSoft, borderRadius: '8px', padding: '9px 12px', fontSize: '12px', color: DIALOG.red }}>
              ⚠️ {error}
            </div>
          )}
        </div>

        <div style={{ padding: '1rem 1.5rem', borderTop: '0.5px solid ' + DIALOG.border, display: 'flex', justifyContent: 'flex-end', gap: '8px', background: DIALOG.raised }}>
          <button style={s.cancel} onClick={onClose}>Cancel</button>
          <button style={{ ...s.save, opacity: saving ? 0.6 : 1 }} onClick={save} disabled={saving}>
            {saving ? 'Saving…' : 'Save reading'}
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
