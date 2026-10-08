import React, { useState, useEffect, useCallback, useMemo } from 'react'
import { supabase } from '../supabase'
import { useCompanies } from '../contexts/CompaniesContext'
import { proposePairs, summarize, PassthroughRow, MATCH_LIMITS } from '../services/autoMatch'
import { DIALOG } from './dialogTheme'

// ── Pass-through auto-matching ──────────────────────────────────────────────
// The engine only PROPOSES. Nothing is written until the user confirms, and
// only the selected pairs are written.

interface Props { onClose: () => void; onPaired: () => void }

const CONF_STYLE: Record<string, { bg: string; color: string; label: string }> = {
  high:   { bg: 'rgba(0,212,126,0.13)',  color: '#00D47E', label: 'high' },
  medium: { bg: 'rgba(245,166,35,0.13)', color: '#F5A623', label: 'medium' },
  low:    { bg: 'rgba(122,155,184,0.13)', color: '#7A9BB8', label: 'low' },
}

const fmt = (n: number) => '$' + Math.abs(n).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })

export default function AutoMatchPanel({ onClose, onPaired }: Props) {
  const { companies, defaultCompany, showPicker } = useCompanies()
  const [companyId, setCompanyId] = useState('')
  const [rows, setRows] = useState<PassthroughRow[]>([])
  const [loading, setLoading] = useState(false)
  const [selected, setSelected] = useState<Set<string>>(new Set())
  const [posting, setPosting] = useState(false)
  const [result, setResult] = useState<{ ok: number; failed: number } | null>(null)
  const [error, setError] = useState('')
  const [minConfidence, setMinConfidence] = useState<'high' | 'medium' | 'low'>('medium')

  useEffect(() => {
    if (defaultCompany) setCompanyId(prev => prev || defaultCompany.id)
  }, [defaultCompany])

  const load = useCallback(async () => {
    if (!companyId) return
    setLoading(true); setError(''); setResult(null)
    const { data, error: err } = await supabase
      .from('passthrough')
      .select('id, company_id, partner_id, transaction_date, direction, amount, amount_usd, currency, note, reference_number, partners(name)')
      .eq('company_id', companyId)
      .eq('status', 'unpaired')
      .order('transaction_date', { ascending: false })
      .limit(2000)
    if (err) { setError(err.message); setLoading(false); return }
    setRows((data || []).map((r: any) => ({ ...r, partner_name: r.partners?.name ?? null })))
    setLoading(false)
  }, [companyId])

  useEffect(() => { load() }, [load])

  const proposals = useMemo(() => proposePairs(rows), [rows])
  const stats = useMemo(() => summarize(proposals), [proposals])

  const rank = { high: 3, medium: 2, low: 1 }
  const visible = useMemo(
    () => proposals.filter(p => rank[p.confidence] >= rank[minConfidence]),
    [proposals, minConfidence], // eslint-disable-line react-hooks/exhaustive-deps
  )

  // High-confidence proposals are pre-selected; the rest are the user's call.
  useEffect(() => {
    setSelected(new Set(proposals.filter(p => p.confidence === 'high').map(p => p.inRow.id)))
  }, [proposals])

  const toggle = (id: string) => setSelected(prev => {
    const n = new Set(prev)
    if (n.has(id)) n.delete(id); else n.add(id)
    return n
  })

  const chosen = visible.filter(p => selected.has(p.inRow.id))

  const confirmPairs = async () => {
    if (chosen.length === 0) return
    if (!window.confirm(`Pair ${chosen.length} ${chosen.length === 1 ? 'entry pair' : 'entry pairs'}? This modifies data.`)) return
    setPosting(true); setError('')
    let ok = 0, failed = 0

    for (const p of chosen) {
      // Pairing is bidirectional: each side points at the other.
      const a = await supabase.from('passthrough')
        .update({ pair_id: p.outRow.id, status: 'paired' }).eq('id', p.inRow.id)
      const b = await supabase.from('passthrough')
        .update({ pair_id: p.inRow.id, status: 'paired' }).eq('id', p.outRow.id)

      if (a.error || b.error) {
        failed++
        // If one side succeeded and the other did not, roll the first one back —
        // a half-paired record would be invisible to everyone.
        if (!a.error) await supabase.from('passthrough')
          .update({ pair_id: null, status: 'unpaired' }).eq('id', p.inRow.id)
        setError((a.error || b.error)!.message)
      } else ok++
    }

    setPosting(false)
    setResult({ ok, failed })
    if (ok > 0) { onPaired(); load() }
  }

  return (
    <div style={s.overlay} onClick={onClose}>
      <div style={s.modal} onClick={e => e.stopPropagation()}>
        <div style={s.header}>
          <div>
            <div style={s.title}>Pass-through auto-matching</div>
            <div style={s.sub}>
              Proposals are never posted automatically — you confirm them. Limits: amount within{' '}
              {(MATCH_LIMITS.maxRelAmountDiff * 100).toFixed(0)}%, dates within {MATCH_LIMITS.maxDayGap} days.
            </div>
          </div>
          <button style={s.close} onClick={onClose}>×</button>
        </div>

        <div style={s.controls}>
          {showPicker && (
            <select style={s.select} value={companyId} onChange={e => setCompanyId(e.target.value)}>
              {companies.map(c => <option key={c.id} value={c.id}>{c.name}</option>)}
            </select>
          )}
          <select style={s.select} value={minConfidence} onChange={e => setMinConfidence(e.target.value as any)}>
            <option value="high">high confidence only</option>
            <option value="medium">medium and high</option>
            <option value="low">all, including low</option>
          </select>
          <button style={s.ghost} onClick={load} disabled={loading}>{loading ? '…' : 'Refresh'}</button>
        </div>

        <div style={s.statRow}>
          <Stat label="unpaired" value={rows.length} />
          <Stat label="proposals" value={stats.total} />
          <Stat label="high" value={stats.high} color="#00D47E" />
          <Stat label="medium" value={stats.medium} color="#F5A623" />
          <Stat label="low" value={stats.low} color="#7A9BB8" />
        </div>

        {error && <div style={s.error}>{error}</div>}
        {result && (
          <div style={result.failed ? s.error : s.success}>
            Paired: {result.ok}{result.failed ? ` · failed: ${result.failed}` : ''}
          </div>
        )}

        <div style={s.list}>
          {loading ? <div style={s.muted}>Loading…</div>
            : visible.length === 0 ? (
              <div style={s.muted}>
                {rows.length === 0
                  ? 'No unpaired entries for this company.'
                  : `None of the ${rows.length} unpaired entries pass the current limits. Lower the confidence threshold or pair manually.`}
              </div>
            ) : visible.map(p => {
              const cs = CONF_STYLE[p.confidence]
              const isSel = selected.has(p.inRow.id)
              return (
                <div key={p.inRow.id + p.outRow.id}
                  style={{ ...s.card, borderColor: isSel ? 'rgba(0,212,126,0.45)' : 'rgba(255,255,255,0.09)' }}
                  onClick={() => toggle(p.inRow.id)}>
                  <input type="checkbox" checked={isSel} onChange={() => toggle(p.inRow.id)}
                    onClick={e => e.stopPropagation()} style={{ marginTop: '3px' }} />

                  <div style={{ flex: 1, minWidth: 0 }}>
                    <div style={s.pairRow}>
                      <Side dir="IN"  row={p.inRow} />
                      <span style={s.arrow}>↔</span>
                      <Side dir="OUT" row={p.outRow} />
                    </div>
                    <div style={s.reasons}>{p.reasons.join(' · ')}</div>
                  </div>

                  <div style={{ textAlign: 'right', flexShrink: 0 }}>
                    <span style={{ ...s.badge, background: cs.bg, color: cs.color }}>{cs.label}</span>
                    <div style={s.score}>{p.score} pts</div>
                    {p.amountDiffUsd > 0 && <div style={s.diff}>diff {fmt(p.amountDiffUsd)}</div>}
                  </div>
                </div>
              )
            })}
        </div>

        <div style={s.footer}>
          <div style={s.muted}>
            {chosen.length} of {visible.length} selected
          </div>
          <div style={{ display: 'flex', gap: '8px' }}>
            <button style={s.ghost} onClick={onClose}>Close</button>
            <button style={{ ...s.primary, opacity: chosen.length === 0 || posting ? 0.5 : 1 }}
              disabled={chosen.length === 0 || posting}
              onClick={confirmPairs}>
              {posting ? 'Saving…' : `Pair ${chosen.length}`}
            </button>
          </div>
        </div>
      </div>
    </div>
  )
}

function Side({ dir, row }: { dir: string; row: PassthroughRow }) {
  return (
    <div style={{ flex: 1, minWidth: 0 }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: '6px' }}>
        <span style={{ ...s.dirTag, background: dir === 'IN' ? 'rgba(0,212,126,0.15)' : 'rgba(255,91,90,0.15)', color: dir === 'IN' ? '#00D47E' : '#FF5B5A' }}>{dir}</span>
        <span style={s.amount}>{fmt(row.amount_usd)}</span>
      </div>
      <div style={s.meta}>
        {row.transaction_date} · {row.partner_name || '—'}
      </div>
    </div>
  )
}

function Stat({ label, value, color }: { label: string; value: number; color?: string }) {
  return (
    <div style={s.stat}>
      <div style={{ ...s.statVal, color: color || '#DCE9F6' }}>{value}</div>
      <div style={s.statLabel}>{label}</div>
    </div>
  )
}

const s: Record<string, React.CSSProperties> = {
  overlay: { position: 'fixed', inset: 0, colorScheme: 'dark', background: DIALOG.overlay, backdropFilter: 'blur(4px)', display: 'flex', alignItems: 'center', justifyContent: 'center', zIndex: DIALOG.z, padding: '24px' },
  modal: { background: '#0D1B2C', border: '1px solid rgba(255,255,255,0.10)', borderRadius: '14px', width: 'min(940px, 100%)', maxHeight: '88vh', display: 'flex', flexDirection: 'column', fontFamily: "'Inter', system-ui, sans-serif", boxShadow: '0 20px 60px rgba(0,0,0,0.55)' },
  header: { display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start', padding: '18px 22px 14px', borderBottom: '1px solid rgba(255,255,255,0.07)' },
  title: { fontSize: '16px', fontWeight: 600, color: '#DCE9F6' },
  sub: { fontSize: '11.5px', color: '#7A9BB8', marginTop: '4px', maxWidth: '620px', lineHeight: 1.5 },
  close: { background: 'none', border: 'none', color: '#7A9BB8', fontSize: '22px', cursor: 'pointer', lineHeight: 1 },
  controls: { display: 'flex', gap: '9px', padding: '14px 22px 0' },
  select: { background: '#111F30', color: '#DCE9F6', border: '1px solid rgba(255,255,255,0.14)', borderRadius: '8px', padding: '7px 11px', fontSize: '12.5px', fontFamily: "'Inter', system-ui, sans-serif" },
  statRow: { display: 'flex', gap: '20px', padding: '14px 22px 4px' },
  stat: { display: 'flex', flexDirection: 'column' },
  statVal: { fontSize: '19px', fontWeight: 600 },
  statLabel: { fontSize: '10px', color: '#7A9BB8', letterSpacing: '0.05em', textTransform: 'uppercase' },
  list: { flex: 1, overflowY: 'auto', padding: '10px 22px', display: 'flex', flexDirection: 'column', gap: '7px', minHeight: '180px' },
  card: { display: 'flex', gap: '11px', alignItems: 'flex-start', padding: '11px 13px', borderRadius: '10px', border: '1px solid', background: '#111F30', cursor: 'pointer' },
  pairRow: { display: 'flex', alignItems: 'center', gap: '12px' },
  arrow: { color: '#7A9BB8', fontSize: '15px', flexShrink: 0 },
  dirTag: { fontSize: '9.5px', fontWeight: 700, padding: '2px 6px', borderRadius: '4px', letterSpacing: '0.05em' },
  amount: { fontSize: '13px', fontWeight: 600, color: '#DCE9F6', fontFamily: "'DM Mono', monospace" },
  meta: { fontSize: '11px', color: '#7A9BB8', marginTop: '3px', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' },
  reasons: { fontSize: '10.5px', color: '#5DCAA5', marginTop: '6px' },
  badge: { fontSize: '10px', fontWeight: 600, padding: '3px 8px', borderRadius: '5px' },
  score: { fontSize: '10px', color: '#7A9BB8', marginTop: '4px' },
  diff: { fontSize: '10px', color: '#F5A623', marginTop: '2px' },
  footer: { display: 'flex', justifyContent: 'space-between', alignItems: 'center', padding: '14px 22px', borderTop: '1px solid rgba(255,255,255,0.07)' },
  ghost: { background: 'transparent', color: '#7A9BB8', border: '1px solid rgba(255,255,255,0.14)', borderRadius: '8px', padding: '8px 15px', fontSize: '12.5px', cursor: 'pointer', fontFamily: "'Inter', system-ui, sans-serif" },
  primary: { background: '#00D47E', color: '#060E1A', border: 'none', borderRadius: '8px', padding: '8px 18px', fontSize: '12.5px', fontWeight: 600, cursor: 'pointer', fontFamily: "'Inter', system-ui, sans-serif" },
  muted: { fontSize: '12px', color: '#7A9BB8' },
  error: { margin: '12px 22px 0', fontSize: '12px', color: '#FF5B5A', background: 'rgba(255,91,90,0.10)', border: '1px solid rgba(255,91,90,0.28)', borderRadius: '8px', padding: '9px 12px' },
  success: { margin: '12px 22px 0', fontSize: '12px', color: '#00D47E', background: 'rgba(0,212,126,0.10)', border: '1px solid rgba(0,212,126,0.28)', borderRadius: '8px', padding: '9px 12px' },
}
