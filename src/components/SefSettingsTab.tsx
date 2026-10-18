import React, { useState, useEffect, useCallback } from 'react'
import { supabase } from '../supabase'
import { settingsStyles as s } from '../pages/Settings'
import { readSefDecisionsEnabled, SEF_DECISIONS_FLAG } from '../services/sef/sefDecide'

// ── SEF ────────────────────────────────────────────────────────────────────
// The switch for accepting and rejecting invoices ON SEF from the inbox
// (`feature_flags.sef_decisions_enabled`, migration 20261018140000). Off by
// default: it writes to a register the supplier and the accounting firm read,
// so a client turns it on deliberately. The database lets only the
// administrator change it.

export default function SefSettingsTab({ canEdit }: { canEdit: boolean }) {
  const [enabled, setEnabled] = useState(false)
  const [loading, setLoading] = useState(true)
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState('')

  const load = useCallback(async () => {
    setEnabled(await readSefDecisionsEnabled(supabase))
    setLoading(false)
  }, [])

  useEffect(() => { load() }, [load])

  const toggle = async () => {
    if (!canEdit) return
    const next = !enabled
    if (next && !window.confirm(
      'Uključiti prihvatanje i odbijanje faktura na SEF-u?\n\n' +
      'Knjigovođe tada iz SEF sandučeta mogu da upišu odluku na SEF-u. ' +
      'Dobavljač i računovođa je vide, a prihvatanje je konačno.'
    )) return
    setSaving(true); setError('')
    // `select` so that a write RLS quietly turned into zero rows is told
    // apart from one that worked.
    const { data, error: err } = await supabase
      .from('feature_flags')
      .update({ enabled: next, updated_at: new Date().toISOString() })
      .eq('name', SEF_DECISIONS_FLAG)
      .select('enabled')
    if (err) setError(`Prekidač nije promenjen: ${err.message}`)
    else if (!data || data.length === 0) setError('Prekidač nije promenjen: nema ga u bazi ili nemate pravo da ga menjate.')
    else setEnabled(data[0].enabled === true)
    setSaving(false)
  }

  return (
    <>
      {!canEdit && <div style={s.readOnlyBanner}>👁 Samo pregled — ovaj prekidač menja samo administrator.</div>}

      <div style={{
        ...s.readOnlyBanner,
        background: enabled ? 'rgba(0,212,126,0.10)' : 'rgba(255,255,255,0.04)',
        border: `1px solid ${enabled ? 'rgba(0,212,126,0.30)' : 'rgba(255,255,255,0.12)'}`,
        color: enabled ? '#00D47E' : '#DCE9F6',
        display: 'flex', alignItems: 'center', gap: '14px',
      }}>
        <div style={{ flex: 1 }}>
          <strong>
            {loading ? 'Odlučivanje na SEF-u…'
              : enabled ? 'Odlučivanje na SEF-u je UKLJUČENO' : 'Odlučivanje na SEF-u je ISKLJUČENO'}
          </strong>
          <div style={{ color: '#7A9BB8', marginTop: '3px' }}>
            {enabled
              ? 'U SEF sandučetu, na otvorenoj fakturi, knjigovođe mogu da je prihvate ili odbiju na SEF-u. Prihvatanje je konačno; odbijena faktura može kasnije da se prihvati.'
              : 'Dugmad „Prihvati na SEF-u“ i „Odbij na SEF-u“ u SEF sandučetu su onemogućena. Ništa se ne šalje SEF-u.'}
          </div>
        </div>
        {canEdit && !loading && (
          <button onClick={toggle} disabled={saving}
            style={{
              ...s.deleteBtn,
              border: `1px solid ${enabled ? 'rgba(255,91,90,0.4)' : 'rgba(0,212,126,0.4)'}`,
              background: enabled ? 'rgba(255,91,90,0.10)' : 'rgba(0,212,126,0.10)',
              color: enabled ? '#FF5B5A' : '#00D47E',
              padding: '5px 14px', fontSize: '12px',
              opacity: saving ? 0.5 : 1,
            }}>
            {saving ? '…' : enabled ? 'Isključi' : 'Uključi'}
          </button>
        )}
      </div>

      {error && (
        <div style={{ ...s.readOnlyBanner, background: 'rgba(255,91,90,0.10)', border: '1px solid rgba(255,91,90,0.3)', color: '#FF5B5A' }}>
          {error}
        </div>
      )}
    </>
  )
}
