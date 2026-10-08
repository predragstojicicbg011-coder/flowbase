import React, { useState, useEffect, useCallback } from 'react'
import { supabase } from '../supabase'
import { useCompanies } from '../contexts/CompaniesContext'
import { settingsStyles as s } from '../pages/Settings'

// ── Accounting period locking ───────────────────────────────────────────────
// A locked month is rejected by the database (trigger enforce_period_lock).
// See migration 20260826100100_period_lock.sql.

interface ClosedPeriod {
  id: string
  company_id: string
  period: string          // 'YYYY-MM-DD', always the first of the month
  closed_at: string
  note: string | null
}

// Strelice za godinu — iconBtn je previse prigusen (opacity 0.6) da bi se
// vidjele, pa im treba vidljiv okvir kao ostalim kontrolama u headeru.
const yearBtn: React.CSSProperties = {
  background: '#0D1B2C',
  border: '1px solid rgba(255,255,255,0.14)',
  borderRadius: '6px',
  color: '#DCE9F6',
  cursor: 'pointer',
  fontSize: '15px',
  lineHeight: 1,
  padding: '2px 9px',
}

const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec']

export default function ClosedPeriodsTab({ canEdit }: { canEdit: boolean }) {
  const { companies, defaultCompany, showPicker } = useCompanies()
  const [companyId, setCompanyId] = useState('')
  const [closed, setClosed] = useState<ClosedPeriod[]>([])
  const [year, setYear] = useState(new Date().getFullYear())
  const [loading, setLoading] = useState(true)
  const [busy, setBusy] = useState<string | null>(null)
  const [error, setError] = useState('')
  // Global switch — disables enforcement across the whole database,
  // independently of which months are locked.
  const [lockEnabled, setLockEnabled] = useState(true)
  const [togglingFlag, setTogglingFlag] = useState(false)

  const loadFlag = useCallback(async () => {
    const { data } = await supabase
      .from('feature_flags').select('enabled').eq('name', 'period_lock').single()
    if (data) setLockEnabled(data.enabled)
  }, [])

  useEffect(() => { loadFlag() }, [loadFlag])

  useEffect(() => {
    if (defaultCompany) setCompanyId(prev => prev || defaultCompany.id)
  }, [defaultCompany])

  const load = useCallback(async () => {
    if (!companyId) return
    setLoading(true)
    const { data, error: err } = await supabase
      .from('closed_periods')
      .select('id, company_id, period, closed_at, note')
      .eq('company_id', companyId)
      .order('period', { ascending: false })
    if (err) setError(err.message)
    setClosed(data || [])
    setLoading(false)
  }, [companyId])

  useEffect(() => { load() }, [load])

  const toggleFlag = async () => {
    if (!canEdit) return
    const next = !lockEnabled
    if (next === false && !window.confirm(
      'Disable period locking for the ENTIRE database?\n\n' +
      'While disabled, locked months can be edited as if they were open. ' +
      'The lock records themselves are kept and take effect again when you re-enable.'
    )) return
    setTogglingFlag(true); setError('')
    const { error: err } = await supabase
      .from('feature_flags')
      .update({ enabled: next, updated_at: new Date().toISOString() })
      .eq('name', 'period_lock')
    if (err) setError(`Could not change the switch: ${err.message}`)
    else setLockEnabled(next)
    setTogglingFlag(false)
  }

  const isClosed = (month: number): ClosedPeriod | undefined => {
    const key = `${year}-${String(month + 1).padStart(2, '0')}-01`
    return closed.find(c => c.period === key)
  }

  const toggle = async (month: number) => {
    if (!canEdit) return
    const key = `${year}-${String(month + 1).padStart(2, '0')}-01`
    const existing = isClosed(month)
    setBusy(key); setError('')

    if (existing) {
      const { error: err } = await supabase.from('closed_periods').delete().eq('id', existing.id)
      if (err) setError(`Unlock failed: ${err.message}`)
    } else {
      const { error: err } = await supabase.from('closed_periods').insert({
        company_id: companyId, period: key, note: null,
      })
      if (err) setError(`Lock failed: ${err.message}`)
    }
    setBusy(null)
    load()
  }

  const unlockById = async (id: string) => {
    if (!canEdit) return
    setBusy(id); setError('')
    const { error: err } = await supabase.from('closed_periods').delete().eq('id', id)
    if (err) setError(`Unlock failed: ${err.message}`)
    setBusy(null)
    load()
  }

  const companyName = companies.find(c => c.id === companyId)?.name || ''

  return (
    <>
      {!canEdit && <div style={s.readOnlyBanner}>👁 Read only — only administrators can lock or unlock periods.</div>}

      <div style={{
        ...s.readOnlyBanner,
        background: lockEnabled ? 'rgba(0,212,126,0.10)' : 'rgba(255,91,90,0.10)',
        border: `1px solid ${lockEnabled ? 'rgba(0,212,126,0.30)' : 'rgba(255,91,90,0.35)'}`,
        color: lockEnabled ? '#00D47E' : '#FF5B5A',
        display: 'flex', alignItems: 'center', gap: '14px',
      }}>
        <div style={{ flex: 1 }}>
          <strong>{lockEnabled ? '🔒 Period locking is ON' : '⚠ Period locking is OFF'}</strong>
          <div style={{ color: '#7A9BB8', marginTop: '3px' }}>
            {lockEnabled
              ? 'The database rejects any change dated inside a locked month.'
              : 'Locked months can currently be edited. Lock records below are kept and apply again once re-enabled.'}
          </div>
        </div>
        {canEdit && (
          <button onClick={toggleFlag} disabled={togglingFlag}
            style={{
              ...s.deleteBtn,
              border: `1px solid ${lockEnabled ? 'rgba(255,91,90,0.4)' : 'rgba(0,212,126,0.4)'}`,
              background: lockEnabled ? 'rgba(255,91,90,0.10)' : 'rgba(0,212,126,0.10)',
              color: lockEnabled ? '#FF5B5A' : '#00D47E',
              padding: '5px 14px', fontSize: '12px',
              opacity: togglingFlag ? 0.5 : 1,
            }}>
            {togglingFlag ? '…' : lockEnabled ? 'Disable' : 'Enable'}
          </button>
        )}
      </div>

      {error && (
        <div style={{ ...s.readOnlyBanner, background: 'rgba(255,91,90,0.10)', border: '1px solid rgba(255,91,90,0.3)', color: '#FF5B5A' }}>
          {error}
        </div>
      )}

      <div style={s.twoCol}>
        <div style={s.colPanel}>
          <div style={s.colHeader}>
            <div style={s.colTitle}>Lock months</div>
            <div style={{ display: 'flex', alignItems: 'center', gap: '6px' }}>
              <button style={yearBtn} onClick={() => setYear(y => y - 1)} title="Previous year">‹</button>
              <span style={{ ...s.colTitle, minWidth: '40px', textAlign: 'center' }}>{year}</span>
              <button style={yearBtn} onClick={() => setYear(y => y + 1)} title="Next year">›</button>
            </div>
          </div>

          {showPicker && (
            <div style={{ padding: '10px 12px', borderBottom: '0.5px solid rgba(255,255,255,0.05)' }}>
              <select style={{ ...s.addInput, width: '100%', boxSizing: 'border-box' }}
                value={companyId} onChange={e => setCompanyId(e.target.value)}>
                {companies.map(c => <option key={c.id} value={c.id}>{c.name}</option>)}
              </select>
            </div>
          )}

          {loading ? <div style={s.loading}>Loading…</div> : (
            <div style={{ display: 'grid', gridTemplateColumns: 'repeat(3, 1fr)', gap: '6px', padding: '12px' }}>
              {MONTHS.map((label, i) => {
                const lock = isClosed(i)
                const key = `${year}-${String(i + 1).padStart(2, '0')}-01`
                return (
                  <button key={label} disabled={!canEdit || busy === key} onClick={() => toggle(i)}
                    title={lock ? `Locked on ${new Date(lock.closed_at).toLocaleDateString('en-GB')}` : 'Open'}
                    style={{
                      display: 'flex', flexDirection: 'column', alignItems: 'flex-start', gap: '2px',
                      padding: '9px 11px', borderRadius: '8px',
                      border: `1px solid ${lock ? 'rgba(255,91,90,0.40)' : 'rgba(255,255,255,0.10)'}`,
                      background: lock ? 'rgba(255,91,90,0.10)' : '#111F30',
                      color: lock ? '#FF5B5A' : '#DCE9F6',
                      fontFamily: "'Inter', system-ui, sans-serif",
                      cursor: canEdit ? 'pointer' : 'default',
                      opacity: busy === key ? 0.5 : 1,
                      textAlign: 'left',
                    }}>
                    <span style={{ fontSize: '13px', fontWeight: 500 }}>{label}</span>
                    <span style={{ fontSize: '10px', color: lock ? '#FF5B5A' : 'rgba(255,255,255,0.30)' }}>
                      {lock ? '🔒 locked' : 'open'}
                    </span>
                  </button>
                )
              })}
            </div>
          )}
        </div>

        <div style={s.colPanel}>
          <div style={s.colHeader}>
            <div style={s.colTitle}>{companyName ? `Locked periods — ${companyName}` : 'Locked periods'}</div>
            <span style={s.colCount}>{closed.length}</span>
          </div>
          {closed.length === 0 ? (
            <div style={s.emptyHint}>No locked periods for this company yet.</div>
          ) : (
            <div style={s.itemList}>
              {closed.map(c => (
                <div key={c.id} style={s.itemRow}>
                  <div>
                    <div style={s.itemName}>{c.period.slice(0, 7)}</div>
                    <div style={{ fontSize: '10px', color: 'rgba(255,255,255,0.30)' }}>
                      locked on {new Date(c.closed_at).toLocaleDateString('en-GB')}
                    </div>
                  </div>
                  {canEdit && (
                    <button style={{ ...s.deleteBtn, opacity: busy === c.id ? 0.5 : 1 }}
                      disabled={busy === c.id}
                      onClick={() => unlockById(c.id)}>
                      Unlock
                    </button>
                  )}
                </div>
              ))}
            </div>
          )}
        </div>
      </div>
    </>
  )
}
