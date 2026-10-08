import React, { useState, useEffect } from 'react'
import { supabase } from '../supabase'
import { SkeletonRows } from '../components/motion'
import { runWrite } from '../services/writeOrder'
import { fmtMoney, fmtNum } from '../utils/formatters'
import { useDisplayCurrency } from '../contexts/DisplayCurrencyContext'

const BRANDS = ['Kicksta', 'Flock', 'Nitreo', 'Kenji', 'Upleap', 'EngagementBoost', 'Upgram', 'SocialFollow', 'Aimfox']
const STATUS_COLORS: Record<string, { bg: string; color: string }> = {
  open: { bg: 'rgba(245,166,35,0.13)', color: '#F5A623' }, partial: { bg: 'rgba(78,168,255,0.13)', color: '#4EA8FF' },
  collected: { bg: 'rgba(0,212,126,0.12)', color: '#00D47E' }, cancelled: { bg: 'rgba(255,91,90,0.13)', color: '#FF5B5A' },
}
const STREAM_COLORS: Record<string, { bg: string; color: string }> = {
  aimfox: { bg: 'rgba(99,91,255,0.15)', color: '#9D97FF' }, social_growth: { bg: 'rgba(0,212,126,0.12)', color: '#00D47E' },
  other: { bg: 'rgba(255,255,255,0.06)', color: '#7A9BB8' },
}
const COLL_STATUS_COLORS: Record<string, { bg: string; color: string }> = {
  unmatched: { bg: 'rgba(245,166,35,0.13)', color: '#F5A623' }, partial: { bg: 'rgba(78,168,255,0.13)', color: '#4EA8FF' },
  matched: { bg: 'rgba(0,212,126,0.12)', color: '#00D47E' },
}

export default function Revenue() {
  const [subTab, setSubTab] = useState<'entries' | 'collections'>('entries')
  const [showMenu, setShowMenu] = useState<string | null>(null)
  const [showEntryDialog, setShowEntryDialog] = useState(false)
  const [showCollectionDialog, setShowCollectionDialog] = useState(false)
  const [showReconcileDialog, setShowReconcileDialog] = useState<any>(null)
  const [editEntry, setEditEntry] = useState<any>(null)
  const [editCollection, setEditCollection] = useState<any>(null)
  const [search, setSearch] = useState('')
  const [filterStream, setFilterStream] = useState('all')
  const [filterBrand, setFilterBrand] = useState('all')
  const [filterStatus, setFilterStatus] = useState('all')
  const [entries, setEntries] = useState<any[]>([])
  const [collections, setCollections] = useState<any[]>([])
  const [loading, setLoading] = useState(true)
  // Every entry and collection carries its book figure in RSD and in EUR
  // (`amount_rsd` / `amount_eur`, `collected_rsd` / `collected_eur` …), so the
  // page reads the display currency's column — never a conversion.
  const { currency, pick } = useDisplayCurrency()
  const money = (n: number | null | undefined) => fmtMoney(n ?? 0, currency, 0)
  const amt = (row: any, base = 'amount') => pick(row, base) || 0

  const fetchEntries = async () => {
    setLoading(true)
    const { data, error } = await supabase.from('v_revenue_entry_status').select('*').order('period_month', { ascending: false })
    if (!error && data) setEntries(data)
    setLoading(false)
  }
  const fetchCollections = async () => {
    setLoading(true)
    const { data, error } = await supabase.from('revenue_collections')
      .select('*, companies(name), banks(name)').order('transaction_date', { ascending: false })
    if (!error && data) setCollections(data)
    setLoading(false)
  }
  const fetchAll = () => { fetchEntries(); fetchCollections() }
  useEffect(() => { fetchAll() }, []) // eslint-disable-line

  const deleteEntry = async (id: string) => {
    if (!window.confirm('Delete this revenue entry?')) return
    const { ok, message } = await runWrite('Delete the revenue entry',
      supabase.from('revenue_entries').delete().eq('id', id))
    if (!ok) { window.alert(message); return }
    fetchEntries(); setShowMenu(null)
  }
  const deleteCollection = async (id: string) => {
    if (!window.confirm('Delete this collection?')) return
    const { ok, message } = await runWrite('Delete the collection',
      supabase.from('revenue_collections').delete().eq('id', id))
    if (!ok) { window.alert(message); return }
    fetchCollections(); setShowMenu(null)
  }

  const filteredEntries = entries.filter(e =>
    (filterStream === 'all' || e.revenue_stream === filterStream) &&
    (filterBrand === 'all' || e.brand === filterBrand) &&
    (filterStatus === 'all' || e.calculated_status === filterStatus) &&
    (!search || (e.brand||'').toLowerCase().includes(search.toLowerCase()) ||
      (e.notes||'').toLowerCase().includes(search.toLowerCase()) ||
      (e.invoice_ref||'').toLowerCase().includes(search.toLowerCase()))
  )
  const filteredCollections = collections.filter(c =>
    (filterStatus === 'all' || c.status === filterStatus) &&
    (!search || (c.reference||'').toLowerCase().includes(search.toLowerCase()) ||
      (c.notes||'').toLowerCase().includes(search.toLowerCase()))
  )

  const totalOpen = entries.filter(e => e.calculated_status === 'open').reduce((s,e) => s+amt(e), 0)
  const totalPartialRemaining = entries.filter(e => e.calculated_status === 'partial').reduce((s,e) => s+amt(e, 'remaining'), 0)
  const totalCollected = entries.filter(e => e.calculated_status === 'collected').reduce((s,e) => s+amt(e), 0)
  const unmatchedCount = collections.filter(c => c.status === 'unmatched').length

  const brandTotals = BRANDS.map(brand => ({
    brand, stream: brand === 'Aimfox' ? 'aimfox' : 'social_growth',
    total: entries.filter(e => e.brand === brand).reduce((s,e) => s+amt(e), 0),
    collected: entries.filter(e => e.brand === brand).reduce((s,e) => s+amt(e, 'collected'), 0),
    count: entries.filter(e => e.brand === brand).length,
  })).filter(b => b.count > 0).sort((a,b) => b.total-a.total)
  const maxBrand = brandTotals[0]?.total || 1

  return (
    <div style={s.root} className="app-surface" onClick={() => setShowMenu(null)}>
      <div style={s.body}>
        <div style={s.pageHeader}>
          <div>
            <div style={s.pageTitle}>Revenue</div>
            <div style={s.pageSub}>Receivables and collections by brand and stream</div>
          </div>
          <div style={s.btnGroup}>
            <button style={s.btnEntry} onClick={() => { setEditEntry(null); setShowEntryDialog(true) }}>📈 New entry</button>
            <button style={s.btnCollection} onClick={() => { setEditCollection(null); setShowCollectionDialog(true) }}>💰 New collection</button>
          </div>
        </div>

        <div style={s.summaryRow} className="mf-stagger">
          <div style={{ ...s.summaryCard, borderTop: '2px solid #F5A623' }}>
            <div style={s.summaryLabel}>Open (uncollected)</div>
            <div style={{ ...s.summaryVal, color: '#F5A623' }}>{money(totalOpen)}</div>
            <div style={s.summarySub}>{entries.filter(e => e.calculated_status === 'open').length} entries pending</div>
          </div>
          <div style={{ ...s.summaryCard, borderTop: '2px solid #4EA8FF' }}>
            <div style={s.summaryLabel}>Partially collected</div>
            <div style={{ ...s.summaryVal, color: '#4EA8FF' }}>{money(totalPartialRemaining)}</div>
            <div style={s.summarySub}>{entries.filter(e => e.calculated_status === 'partial').length} entries · remaining</div>
          </div>
          <div style={{ ...s.summaryCard, borderTop: '2px solid #00D47E' }}>
            <div style={s.summaryLabel}>Collected</div>
            <div style={{ ...s.summaryVal, color: '#00D47E' }}>{money(totalCollected)}</div>
            <div style={s.summarySub}>{entries.filter(e => e.calculated_status === 'collected').length} entries closed</div>
          </div>
          <div style={{ ...s.summaryCard, ...(unmatchedCount > 0 ? s.summaryCardWarn : {}), borderTop: `2px solid ${unmatchedCount > 0 ? '#F5A623' : 'rgba(255,255,255,0.1)'}` }}>
            <div style={s.summaryLabel}>Unmatched collections</div>
            <div style={{ ...s.summaryVal, ...(unmatchedCount > 0 ? { color: '#F5A623' } : {}) }}>{unmatchedCount}</div>
            <div style={s.summarySub}>{unmatchedCount > 0 ? 'Processor receipts not matched' : 'All collections matched'}</div>
          </div>
        </div>

        {brandTotals.length > 0 && (
          <div style={s.brandWidget}>
            <div style={s.brandWidgetTitle}>Brand breakdown · {entries.length} total entries</div>
            <div style={{ display: 'flex', gap: '10px', flexWrap: 'wrap' as const }}>
              {brandTotals.map(b => (
                <div key={b.brand} style={{ ...s.brandCard, ...(filterBrand === b.brand ? s.brandCardActive : {}) }} onClick={() => setFilterBrand(filterBrand === b.brand ? 'all' : b.brand)}>
                  <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: '6px' }}>
                    <span style={{ fontSize: '12px', fontWeight: '600', color: '#DCE9F6' }}>{b.brand}</span>
                    <span style={{ ...s.badge, ...STREAM_COLORS[b.stream] }}>{b.stream === 'aimfox' ? 'AF' : 'SG'}</span>
                  </div>
                  <div style={{ fontSize: '15px', fontWeight: '600', color: '#00D47E', marginBottom: '4px' }}>{money(b.total)}</div>
                  <div style={{ height: '3px', background: 'rgba(255,255,255,0.07)', borderRadius: '2px', overflow: 'hidden', marginBottom: '5px' }}>
                    <div style={{ height: '100%', width: `${(b.total/maxBrand)*100}%`, background: b.stream === 'aimfox' ? '#9D97FF' : '#00D47E', borderRadius: '2px' }} />
                  </div>
                  <div style={{ fontSize: '10px', color: '#7A9BB8' }}>{b.count} entr{b.count>1?'ies':'y'} · {money(b.collected)} collected</div>
                </div>
              ))}
            </div>
          </div>
        )}

        <div style={s.subTabBar}>
          <button style={{ ...s.subTab, ...(subTab === 'entries' ? s.subTabActive : {}) }} onClick={() => setSubTab('entries')}>
            Entries — receivables <span style={{ ...s.subTabCount, ...(subTab==='entries'?{background:'rgba(157,151,255,0.2)',color:'#9D97FF'}:{}) }}>{entries.length}</span>
          </button>
          <button style={{ ...s.subTab, ...(subTab === 'collections' ? s.subTabActive : {}) }} onClick={() => setSubTab('collections')}>
            Collections <span style={{ ...s.subTabCount, ...(subTab==='collections'?{background:'rgba(157,151,255,0.2)',color:'#9D97FF'}:{}) }}>{collections.length}</span>
          </button>
        </div>

        <div style={s.filterBar}>
          <input type="text" placeholder={subTab==='entries'?'Search brand, ref, notes...':'Search reference, notes...'} value={search} onChange={e => setSearch(e.target.value)} style={s.searchInput} />
          {subTab === 'entries' && (<>
            <select value={filterStream} onChange={e => setFilterStream(e.target.value)} style={s.filterSelect}>
              <option value="all">All streams</option><option value="aimfox">Aimfox</option><option value="social_growth">Social Growth</option><option value="other">Other</option>
            </select>
            <select value={filterBrand} onChange={e => setFilterBrand(e.target.value)} style={s.filterSelect}>
              <option value="all">All brands</option>{BRANDS.map(b => <option key={b} value={b}>{b}</option>)}
            </select>
          </>)}
          <select value={filterStatus} onChange={e => setFilterStatus(e.target.value)} style={s.filterSelect}>
            <option value="all">All statuses</option>
            {subTab === 'entries' ? <><option value="open">Open</option><option value="partial">Partial</option><option value="collected">Collected</option><option value="cancelled">Cancelled</option></>
              : <><option value="unmatched">Unmatched</option><option value="partial">Partial</option><option value="matched">Matched</option></>}
          </select>
          <div style={s.totalBadge}>
            {subTab === 'entries'
              ? <>{filteredEntries.length} entries · <strong>{money(filteredEntries.reduce((s,e) => s+amt(e),0))}</strong></>
              : <>{filteredCollections.length} collections · <strong>{money(filteredCollections.reduce((s,c) => s+amt(c),0))}</strong></>}
          </div>
        </div>

        {subTab === 'entries' && (
          <div style={s.tableWrap}>
            {loading ? (
              <div style={{ padding: '18px 16px' }}>
                <SkeletonRows rows={8} height={15} gap={14}
                  widths={[84, 58, 90, 52, 78, 46, 86, 64]} />
              </div>
            )
            : filteredEntries.length === 0 ? (
              <div style={s.emptyState}>
                <div style={{ fontSize:'32px',marginBottom:'12px' }}>📈</div>
                <div style={{ fontSize:'15px',fontWeight:'500',color:'#DCE9F6',marginBottom:'6px' }}>No revenue entries yet</div>
                <div style={{ fontSize:'13px',color:'#7A9BB8',marginBottom:'20px' }}>Add your first revenue entry manually.</div>
                <button style={s.btnEntry} onClick={() => { setEditEntry(null); setShowEntryDialog(true) }}>📈 New entry</button>
              </div>
            ) : (
              <table style={s.table}>
                <thead><tr style={s.thead}>
                  <th style={s.th}>Period</th><th style={s.th}>Brand</th><th style={s.th}>Stream</th><th style={s.th}>Source</th><th style={s.th}>Ref</th>
                  <th style={{ ...s.th, textAlign:'right' as const }}>Amount {currency}</th><th style={{ ...s.th, textAlign:'right' as const }}>Collected</th>
                  <th style={{ ...s.th, textAlign:'right' as const }}>Remaining</th><th style={s.th}>Status</th><th style={s.th}></th>
                </tr></thead>
                <tbody>
                  {filteredEntries.map((e,i) => (
                    <tr key={e.id} style={{ ...s.tr, background: i%2===0?'#0D1B2C':'#111F30' }}>
                      <td style={s.td}><span style={s.dateCell}>{e.period_month}</span></td>
                      <td style={s.td}><span style={{ fontSize:'13px',fontWeight:'600',color:'#DCE9F6' }}>{e.brand}</span></td>
                      <td style={s.td}><span style={{ ...s.badge, ...(STREAM_COLORS[e.revenue_stream]||STREAM_COLORS.other) }}>{e.revenue_stream==='aimfox'?'Aimfox':e.revenue_stream==='social_growth'?'Social Growth':'Other'}</span></td>
                      <td style={s.td}><span style={{ ...s.badge, background:'rgba(255,255,255,0.06)',color:'#7A9BB8' }}>{e.source}</span></td>
                      <td style={s.td}><span style={s.monoCell}>{e.invoice_ref||'—'}</span></td>
                      <td style={{ ...s.td, textAlign:'right' as const }}><span style={s.amtCell}>{money(amt(e))}</span></td>
                      <td style={{ ...s.td, textAlign:'right' as const }}><span style={{ ...s.amtCell,color:'#00D47E' }}>{money(amt(e, 'collected'))}</span></td>
                      <td style={{ ...s.td, textAlign:'right' as const }}><span style={{ ...s.amtCell,color:amt(e, 'remaining')>0.01?'#F5A623':'#7A9BB8' }}>{money(amt(e, 'remaining'))}</span></td>
                      <td style={s.td}><span style={{ ...s.badge, ...(STATUS_COLORS[e.calculated_status]||{}) }}>{e.calculated_status}</span></td>
                      <td style={s.td} onClick={ev => ev.stopPropagation()}>
                        <div style={{ position:'relative' }}>
                          <button style={s.editBtn} onClick={() => setShowMenu(showMenu===e.id?null:e.id)}>···</button>
                          {showMenu===e.id && <div style={s.contextMenu}>
                            <div style={s.contextItem} onClick={() => { setEditEntry(e); setShowEntryDialog(true); setShowMenu(null) }}>✏️ Edit</div>
                            <div style={s.contextItem} onClick={() => { setShowReconcileDialog(e); setShowMenu(null) }}>🔗 Match collection</div>
                            <div style={{ ...s.contextItem,color:'#FF5B5A' }} onClick={() => deleteEntry(e.id)}>🗑 Delete</div>
                          </div>}
                        </div>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            )}
          </div>
        )}

        {subTab === 'collections' && (
          <div style={s.tableWrap}>
            {loading ? (
              <div style={{ padding: '18px 16px' }}>
                <SkeletonRows rows={8} height={15} gap={14}
                  widths={[84, 58, 90, 52, 78, 46, 86, 64]} />
              </div>
            )
            : filteredCollections.length === 0 ? (
              <div style={s.emptyState}>
                <div style={{ fontSize:'32px',marginBottom:'12px' }}>💰</div>
                <div style={{ fontSize:'15px',fontWeight:'500',color:'#DCE9F6',marginBottom:'6px' }}>No collections yet</div>
                <div style={{ fontSize:'13px',color:'#7A9BB8',marginBottom:'20px' }}>Add one with 💰 New collection.</div>
                <button style={s.btnCollection} onClick={() => { setEditCollection(null); setShowCollectionDialog(true) }}>💰 New collection</button>
              </div>
            ) : (
              <table style={s.table}>
                <thead><tr style={s.thead}>
                  <th style={s.th}>Date</th><th style={s.th}>Source</th><th style={s.th}>Brand</th><th style={s.th}>Reference</th>
                  <th style={{ ...s.th, textAlign:'right' as const }}>Amount</th><th style={{ ...s.th, textAlign:'right' as const }}>{currency}</th>
                  <th style={s.th}>Status</th><th style={s.th}></th>
                </tr></thead>
                <tbody>
                  {filteredCollections.map((c,i) => {
                    let brandLabel = ''
                    try { brandLabel = JSON.parse(c.notes||'{}').brand||'' } catch {}
                    return (
                      <tr key={c.id} style={{ ...s.tr, background: i%2===0?'#0D1B2C':'#111F30' }}>
                        <td style={s.td}><span style={s.dateCell}>{(c.transaction_date||'').slice(0,10)}</span></td>
                        <td style={s.td}>
                          <span style={{ ...s.badge, ...STREAM_COLORS.other }}>{c.processor || '—'}</span>
                        </td>
                        <td style={s.td}>
                          {brandLabel ? <span style={{ ...s.badge, ...STREAM_COLORS[brandLabel==='Aimfox'?'aimfox':'social_growth'] }}>{brandLabel}</span>
                            : <span style={{ color:'rgba(255,255,255,0.20)',fontSize:'12px' }}>—</span>}
                        </td>
                        <td style={s.td}><span style={s.monoCell}>{(c.reference||'—').slice(0,24)}</span></td>
                        <td style={{ ...s.td, textAlign:'right' as const }}><span style={s.amtCell}>{fmtNum(c.amount||0)} {c.currency}</span></td>
                        <td style={{ ...s.td, textAlign:'right' as const }}>
                          <span style={{ ...s.amtCell, color:amt(c)<0?'#FF5B5A':'#00D47E' }}>{money(amt(c))}</span>
                        </td>
                        <td style={s.td}><span style={{ ...s.badge, ...(COLL_STATUS_COLORS[c.status]||{}) }}>{c.status}</span></td>
                        <td style={s.td} onClick={ev => ev.stopPropagation()}>
                          <div style={{ position:'relative' }}>
                            <button style={s.editBtn} onClick={() => setShowMenu(showMenu===c.id?null:c.id)}>···</button>
                            {showMenu===c.id && <div style={s.contextMenu}>
                              <div style={s.contextItem} onClick={() => { setEditCollection(c); setShowCollectionDialog(true); setShowMenu(null) }}>✏️ Edit</div>
                              <div style={{ ...s.contextItem,color:'#FF5B5A' }} onClick={() => deleteCollection(c.id)}>🗑 Delete</div>
                            </div>}
                          </div>
                        </td>
                      </tr>
                    )
                  })}
                </tbody>
              </table>
            )}
          </div>
        )}
      </div>

      {showEntryDialog && <RevenueEntryDialog entry={editEntry} onClose={() => { setShowEntryDialog(false); setEditEntry(null) }} onSaved={() => { setShowEntryDialog(false); setEditEntry(null); fetchEntries() }} />}
      {showCollectionDialog && <RevenueCollectionDialog collection={editCollection} onClose={() => { setShowCollectionDialog(false); setEditCollection(null) }} onSaved={() => { setShowCollectionDialog(false); setEditCollection(null); fetchCollections() }} />}
      {showReconcileDialog && <RevenueReconcileDialog entry={showReconcileDialog} onClose={() => setShowReconcileDialog(null)} onSaved={() => { setShowReconcileDialog(null); fetchAll() }} />}
    </div>
  )
}

function RevenueEntryDialog({ entry, onClose }: any) {
  return (
    <div style={{ position:'fixed', inset:0, background:'rgba(0,0,0,0.65)', display:'flex', alignItems:'center', justifyContent:'center', zIndex:1000 }}>
      <div style={{ background:'#0D1B2C', border:'1px solid rgba(255,255,255,0.1)', borderRadius:'16px', padding:'2.5rem', width:'520px', textAlign:'center' as const }}>
        <div style={{ fontSize:'36px', marginBottom:'14px' }}>📈</div>
        <div style={{ fontSize:'18px', fontWeight:'500', color:'#DCE9F6', marginBottom:'8px' }}>Revenue Entry</div>
        <div style={{ fontSize:'13px', color:'#7A9BB8', marginBottom:'8px' }}>{entry?'Edit entry':'New entry'}</div>
        <div style={{ fontSize:'12px', color:'rgba(157,151,255,0.8)', background:'rgba(157,151,255,0.08)', border:'1px solid rgba(157,151,255,0.2)', borderRadius:'8px', padding:'10px 16px', marginBottom:'24px' }}>Step 3 — coming soon</div>
        <button onClick={onClose} style={{ background:'#9D97FF', color:'#060E1A', border:'none', borderRadius:'8px', padding:'9px 24px', cursor:'pointer', fontFamily:'system-ui,sans-serif', fontSize:'13px', fontWeight:'600' }}>Close</button>
      </div>
    </div>
  )
}
function RevenueCollectionDialog({ collection, onClose }: any) {
  return (
    <div style={{ position:'fixed', inset:0, background:'rgba(0,0,0,0.65)', display:'flex', alignItems:'center', justifyContent:'center', zIndex:1000 }}>
      <div style={{ background:'#0D1B2C', border:'1px solid rgba(255,255,255,0.1)', borderRadius:'16px', padding:'2.5rem', width:'520px', textAlign:'center' as const }}>
        <div style={{ fontSize:'36px', marginBottom:'14px' }}>💰</div>
        <div style={{ fontSize:'18px', fontWeight:'500', color:'#DCE9F6', marginBottom:'8px' }}>Revenue Collection</div>
        <div style={{ fontSize:'13px', color:'#7A9BB8', marginBottom:'8px' }}>{collection?'Edit collection':'New collection'}</div>
        <div style={{ fontSize:'12px', color:'rgba(0,212,126,0.8)', background:'rgba(0,212,126,0.08)', border:'1px solid rgba(0,212,126,0.2)', borderRadius:'8px', padding:'10px 16px', marginBottom:'24px' }}>Step 4 — coming soon</div>
        <button onClick={onClose} style={{ background:'#00D47E', color:'#060E1A', border:'none', borderRadius:'8px', padding:'9px 24px', cursor:'pointer', fontFamily:'system-ui,sans-serif', fontSize:'13px', fontWeight:'600' }}>Close</button>
      </div>
    </div>
  )
}
function RevenueReconcileDialog({ entry, onClose }: any) {
  return (
    <div style={{ position:'fixed', inset:0, background:'rgba(0,0,0,0.65)', display:'flex', alignItems:'center', justifyContent:'center', zIndex:1000 }}>
      <div style={{ background:'#0D1B2C', border:'1px solid rgba(255,255,255,0.1)', borderRadius:'16px', padding:'2.5rem', width:'520px', textAlign:'center' as const }}>
        <div style={{ fontSize:'36px', marginBottom:'14px' }}>🔗</div>
        <div style={{ fontSize:'18px', fontWeight:'500', color:'#DCE9F6', marginBottom:'8px' }}>Match Collection</div>
        <div style={{ fontSize:'13px', color:'#7A9BB8', marginBottom:'8px' }}>Entry: <strong style={{ color:'#DCE9F6' }}>{entry?.brand} · {entry?.period_month}</strong></div>
        <div style={{ fontSize:'12px', color:'rgba(78,168,255,0.8)', background:'rgba(78,168,255,0.08)', border:'1px solid rgba(78,168,255,0.2)', borderRadius:'8px', padding:'10px 16px', marginBottom:'24px' }}>Step 5 — coming soon</div>
        <button onClick={onClose} style={{ background:'#185FA5', color:'#fff', border:'none', borderRadius:'8px', padding:'9px 24px', cursor:'pointer', fontFamily:'system-ui,sans-serif', fontSize:'13px', fontWeight:'600' }}>Close</button>
      </div>
    </div>
  )
}

const s: Record<string, React.CSSProperties> = {
  // The background lives in `.app-surface` rather than here: an inline
  // colour would paint straight over it.
  root: { minHeight:'100vh', fontFamily:"'Inter', system-ui, sans-serif" },
  body: { padding:'24px 28px' },
  pageHeader: { display:'flex', alignItems:'flex-start', justifyContent:'space-between', marginBottom:'1.5rem' },
  pageTitle: { fontFamily:'Georgia,serif', fontSize:'26px', fontWeight:'400', color:'#DCE9F6', marginBottom:'4px' },
  pageSub: { fontSize:'13px', color:'#7A9BB8' },
  btnGroup: { display:'flex', gap:'8px' },
  btnEntry: { background:'#9D97FF', color:'#060E1A', border:'none', borderRadius:'8px', padding:'9px 16px', fontFamily:'system-ui,sans-serif', fontSize:'13px', fontWeight:'600', cursor:'pointer' },
  btnCollection: { background:'transparent', color:'#00D47E', border:'1px solid rgba(0,212,126,0.35)', borderRadius:'8px', padding:'9px 16px', fontFamily:'system-ui,sans-serif', fontSize:'13px', fontWeight:'500', cursor:'pointer' },
  summaryRow: { display:'grid', gridTemplateColumns:'repeat(4,1fr)', gap:'12px', marginBottom:'1.5rem' },
  summaryCard: { background:'#0D1B2C', border:'1px solid rgba(255,255,255,0.075)', borderRadius:'10px', padding:'14px 16px' },
  summaryCardWarn: { border:'1px solid rgba(245,166,35,0.3)', background:'rgba(245,166,35,0.05)' },
  summaryLabel: { fontSize:'10px', fontWeight:'500', color:'rgba(255,255,255,0.30)', textTransform:'uppercase' as const, letterSpacing:'0.08em', marginBottom:'6px' },
  summaryVal: { fontSize:'22px', fontWeight:'500', color:'#DCE9F6', marginBottom:'4px' },
  summarySub: { fontSize:'11px', color:'#7A9BB8' },
  brandWidget: { background:'#0D1B2C', border:'1px solid rgba(255,255,255,0.075)', borderRadius:'10px', padding:'14px 16px', marginBottom:'16px' },
  brandWidgetTitle: { fontSize:'10px', fontWeight:'600', color:'rgba(255,255,255,0.30)', textTransform:'uppercase' as const, letterSpacing:'0.1em', marginBottom:'12px' },
  brandCard: { background:'rgba(255,255,255,0.03)', border:'1px solid rgba(255,255,255,0.06)', borderRadius:'8px', padding:'10px 12px', cursor:'pointer', minWidth:'130px', flex:'1', transition:'border 0.15s' },
  brandCardActive: { border:'1px solid rgba(157,151,255,0.4)', background:'rgba(157,151,255,0.06)' },
  subTabBar: { display:'flex', gap:'4px', marginBottom:'14px', background:'rgba(255,255,255,0.04)', borderRadius:'8px', padding:'4px', width:'fit-content' },
  subTab: { fontFamily:'system-ui,sans-serif', fontSize:'12px', padding:'7px 16px', border:'none', background:'transparent', color:'#7A9BB8', cursor:'pointer', borderRadius:'6px', fontWeight:'500', display:'flex', alignItems:'center', gap:'8px' },
  subTabActive: { background:'rgba(157,151,255,0.12)', color:'#9D97FF' },
  subTabCount: { fontSize:'10px', background:'rgba(255,255,255,0.07)', color:'#7A9BB8', padding:'1px 7px', borderRadius:'10px' },
  filterBar: { display:'flex', alignItems:'center', gap:'10px', marginBottom:'1rem', flexWrap:'wrap' as const },
  searchInput: { fontFamily:'system-ui,sans-serif', fontSize:'13px', border:'1px solid rgba(255,255,255,0.075)', borderRadius:'8px', padding:'8px 12px', outline:'none', background:'#0D1B2C', color:'#DCE9F6', flex:'1', minWidth:'200px' },
  filterSelect: { fontFamily:'system-ui,sans-serif', fontSize:'13px', border:'1px solid rgba(255,255,255,0.075)', borderRadius:'8px', padding:'8px 12px', outline:'none', background:'#0D1B2C', color:'#DCE9F6', cursor:'pointer' },
  totalBadge: { fontSize:'13px', color:'#7A9BB8', background:'#0D1B2C', border:'1px solid rgba(255,255,255,0.075)', borderRadius:'8px', padding:'8px 12px', marginLeft:'auto', whiteSpace:'nowrap' as const },
  tableWrap: { background:'#0D1B2C', border:'1px solid rgba(255,255,255,0.075)', borderRadius:'10px', overflow:'visible' },
  table: { width:'100%', borderCollapse:'collapse' as const, fontSize:'13px' },
  thead: { background:'#111F30' },
  th: { padding:'10px 12px', textAlign:'left' as const, fontSize:'10px', fontWeight:'500', color:'rgba(255,255,255,0.30)', textTransform:'uppercase' as const, letterSpacing:'0.08em', borderBottom:'1px solid rgba(255,255,255,0.075)', whiteSpace:'nowrap' as const },
  tr: { borderBottom:'0.5px solid rgba(255,255,255,0.05)' },
  td: { padding:'10px 12px', verticalAlign:'middle' as const, color:'#DCE9F6' },
  emptyState: { padding:'3rem', textAlign:'center' as const },
  dateCell: { fontSize:'12px', color:'#7A9BB8', whiteSpace:'nowrap' as const },
  monoCell: { fontSize:'11px', color:'#7A9BB8', fontFamily:'monospace', background:'rgba(255,255,255,0.05)', padding:'2px 6px', borderRadius:'4px' },
  amtCell: { fontSize:'13px', fontWeight:'500', color:'#DCE9F6', whiteSpace:'nowrap' as const },
  badge: { fontSize:'10px', fontWeight:'500', padding:'2px 8px', borderRadius:'20px', whiteSpace:'nowrap' as const },
  editBtn: { background:'none', border:'1px solid rgba(255,255,255,0.10)', borderRadius:'6px', padding:'4px 8px', cursor:'pointer', color:'#7A9BB8', fontSize:'14px' },
  contextMenu: { position:'fixed' as const, background:'#0D1B2C', border:'1px solid rgba(255,255,255,0.10)', borderRadius:'8px', zIndex:9999, minWidth:'150px', boxShadow:'0 4px 20px rgba(0,0,0,0.5)' },
  contextItem: { padding:'8px 14px', fontSize:'13px', color:'#DCE9F6', cursor:'pointer', borderBottom:'0.5px solid rgba(255,255,255,0.05)' },
}
