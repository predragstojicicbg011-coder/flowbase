import React, { useState, useEffect, useCallback } from 'react'
import { supabase } from '../supabase'
import { settingsStyles as s } from '../pages/Settings'
import {
  readSefKeyStatus, saveSefKey, checkSefConnection, describeSefKeyStatus, validateSefKey,
  NOT_CONFIGURED, type SefKeyStatus, type SefEnvironment,
} from '../services/sef/sefKey'

// ── SEF API ključ ──────────────────────────────────────────────────────────
// Every member sees whether a key is set (sef_key_status: last four
// characters, server, who set it). The administrator also sets it
// (sef_set_api_key) and checks it (edge function sef-check). The key typed
// here is sent once and the field is emptied: the database never gives it
// back, so neither does this card.

interface CompanyLite { id: string; name: string }

const card: React.CSSProperties = {
  background: '#0D1B2C', border: '1px solid rgba(255,255,255,0.075)', borderRadius: '10px',
  padding: '14px 16px', marginBottom: '16px', fontSize: '13px', color: '#DCE9F6',
}
const muted: React.CSSProperties = { color: '#7A9BB8', fontSize: '12px', lineHeight: 1.5 }
// Inside a function: `settingsStyles` comes from a module that imports this
// one, so it is not there yet when this module is first evaluated.
const ghostBtn = (): React.CSSProperties => ({
  ...s.addBtn, background: 'transparent', color: '#00D47E', border: '1px solid rgba(0,212,126,0.4)',
})

export default function SefKeyCard({ canSetKey }: { canSetKey: boolean }) {
  const [status, setStatus] = useState<SefKeyStatus>(NOT_CONFIGURED)
  const [loading, setLoading] = useState(true)
  const [loadError, setLoadError] = useState('')
  const [key, setKey] = useState('')
  const [environment, setEnvironment] = useState<SefEnvironment>('production')
  const [companies, setCompanies] = useState<CompanyLite[]>([])
  const [companyId, setCompanyId] = useState('')
  const [saving, setSaving] = useState(false)
  const [checking, setChecking] = useState(false)
  const [notice, setNotice] = useState<{ ok: boolean; text: string } | null>(null)

  const load = useCallback(async () => {
    const r = await readSefKeyStatus(supabase)
    setStatus(r.status)
    setLoadError(r.error || '')
    if (r.status.environment === 'demo' || r.status.environment === 'production') setEnvironment(r.status.environment)
    if (r.status.companyId) setCompanyId(r.status.companyId)
    setLoading(false)
  }, [])

  useEffect(() => { load() }, [load])

  // The pulled invoices are filed under one company. With only one there is
  // nothing to ask; with several the administrator says which.
  useEffect(() => {
    if (!canSetKey) return
    let live = true
    ;(async () => {
      const { data } = await supabase.from('companies').select('id, name').order('name')
      if (live && Array.isArray(data)) setCompanies(data as CompanyLite[])
    })()
    return () => { live = false }
  }, [canSetKey])

  const save = async () => {
    setNotice(null)
    const invalid = validateSefKey(key, environment)
    if (invalid) { setNotice({ ok: false, text: invalid }); return }
    if (companies.length > 1 && !companyId) { setNotice({ ok: false, text: 'Izaberite firmu kojoj ključ pripada.' }); return }
    setSaving(true)
    const r = await saveSefKey(supabase, key, environment, companies.length > 1 ? companyId : null)
    setSaving(false)
    if (!r.ok) { setNotice({ ok: false, text: r.message || 'Ključ nije sačuvan.' }); return }
    setKey('')
    setNotice({ ok: true, text: 'Ključ je sačuvan. Proverite vezu sa SEF-om.' })
    await load()
  }

  const check = async () => {
    setNotice(null)
    setChecking(true)
    const r = await checkSefConnection(supabase)
    setChecking(false)
    setNotice({ ok: r.ok, text: r.message })
  }

  return (
    <div style={card} data-testid="sef-key-card">
      <div style={{ fontWeight: 500, marginBottom: '6px' }}>SEF API ključ</div>

      <div style={{ marginBottom: '8px' }} data-testid="sef-key-status">
        {loading ? 'Učitavanje…' : describeSefKeyStatus(status)}
        {!loading && status.configured && status.companyName && (
          <span style={muted}> · fakture se vode na firmu {status.companyName}</span>
        )}
      </div>
      {loadError && <div style={{ ...muted, color: '#FF5B5A' }}>{loadError}</div>}

      <div style={{ ...muted, marginBottom: canSetKey ? '12px' : 0 }}>
        Ključ se pravi na SEF portalu <strong>ove firme</strong> (Podešavanja → API upravljanje) i važi
        samo za nju — ne unosite ključ druge firme ni knjigovodstvene agencije. Provera veze samo
        pita SEF za spisak današnjih faktura i ne otvara nijednu fakturu, pa im se status ne menja.
      </div>

      {canSetKey && (
        <>
          <div style={{ display: 'flex', gap: '10px', flexWrap: 'wrap', alignItems: 'flex-end' }}>
            <label style={s.formField}>
              <span style={s.formLabel}>Okruženje</span>
              <select value={environment} aria-label="Okruženje"
                onChange={e => setEnvironment(e.target.value as SefEnvironment)} style={s.formInput}>
                <option value="production">Produkcija</option>
                <option value="demo">Demo</option>
              </select>
            </label>
            {companies.length > 1 && (
              <label style={s.formField}>
                <span style={s.formLabel}>Firma</span>
                <select value={companyId} aria-label="Firma"
                  onChange={e => setCompanyId(e.target.value)} style={s.formInput}>
                  <option value="">— izaberite —</option>
                  {companies.map(c => <option key={c.id} value={c.id}>{c.name}</option>)}
                </select>
              </label>
            )}
            <label style={{ ...s.formField, flex: 1, minWidth: '240px' }}>
              <span style={s.formLabel}>{status.configured ? 'Novi ključ' : 'Ključ'}</span>
              <input type="password" value={key} aria-label="SEF API ključ"
                autoComplete="off" spellCheck={false}
                placeholder="xxxxxxxx-xxxx-xxxx-xxxx-xxxxxxxxxxxx"
                onChange={e => setKey(e.target.value)} style={s.formInput} />
            </label>
            <button onClick={save} disabled={saving || !key.trim()}
              style={{ ...s.addBtn, opacity: saving || !key.trim() ? 0.5 : 1 }}>
              {saving ? 'Čuvanje…' : 'Sačuvaj ključ'}
            </button>
            <button onClick={check} disabled={checking || !status.configured}
              style={{ ...ghostBtn(), opacity: checking || !status.configured ? 0.5 : 1 }}>
              {checking ? 'Proveravam…' : 'Proveri vezu'}
            </button>
          </div>
        </>
      )}

      {notice && (
        <div role="status" style={{ marginTop: '10px', fontSize: '12px', color: notice.ok ? '#00D47E' : '#FF5B5A' }}>
          {notice.text}
        </div>
      )}
    </div>
  )
}
