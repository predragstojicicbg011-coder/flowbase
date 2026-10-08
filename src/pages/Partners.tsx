import React, { useState, useEffect } from 'react'
import { supabase } from '../supabase'
import { SkeletonRows } from '../components/motion'
import { runWrite } from '../services/writeOrder'
import PartnerDialog from '../components/PartnerDialog'
import { fetchAllPartners } from '../services/allPartners'

export default function Partners() {
  const [partners, setPartners] = useState<any[]>([])
  const [loading, setLoading] = useState(true)
  const [search, setSearch] = useState('')
  const [filterType, setFilterType] = useState('all')
  const [filterIndividual, setFilterIndividual] = useState('all')
  const [showDialog, setShowDialog] = useState(false)
  const [editPartner, setEditPartner] = useState<any>(null)

  const fetchPartners = async () => {
    setLoading(true)
    // Paged: the totals above this list read 1000 for both Total and
    // Active, which is not a coincidence — it is the row cap, and the
    // count of a truncated list is a count of the truncation.
    const data = await fetchAllPartners(supabase)
    setPartners(data)
    setLoading(false)
  }

  useEffect(() => { fetchPartners() }, [])

  const deletePartner = async (id: string, name: string) => {
    const [{ count: txCount }, { count: invCount }, { count: ptCount }] = await Promise.all([
      supabase.from('transactions').select('id', { count: 'exact', head: true }).eq('partner_id', id),
      supabase.from('invoices').select('id', { count: 'exact', head: true }).eq('partner_id', id),
      supabase.from('passthrough').select('id', { count: 'exact', head: true }).eq('partner_id', id),
    ])
    const total = (txCount || 0) + (invCount || 0) + (ptCount || 0)
    if (total > 0) {
      const plural = (n: number, word: string) => `${n} ${word}${n === 1 ? '' : 's'}`
      const details = [
        txCount ? plural(txCount, 'transaction') : '',
        invCount ? plural(invCount, 'invoice') : '',
        ptCount ? plural(ptCount, 'pass-through') : '',
      ].filter(Boolean).join(', ')
      window.alert(`"${name}" cannot be deleted — it is still linked to ${details}. Remove those links first.`)
      return
    }
    if (!window.confirm(`Obrisati partnera "${name}"? Ova akcija ce obrisati i sve bankove racune partnera.`)) return
    // The partner goes first. The other order removes the accounts and then
    // discovers it may not remove the partner, leaving them stripped of their
    // bank details for nothing.
    const gone = await runWrite('Delete the partner', supabase.from('partners').delete().eq('id', id))
    if (!gone.ok) { window.alert(gone.message); return }
    const accounts = await runWrite('Remove the bank accounts',
      supabase.from('partner_accounts').delete().eq('partner_id', id))
    if (!accounts.ok) {
      window.alert(`${accounts.message}

The partner was deleted; their bank accounts were left behind.`)
    }
    fetchPartners()
  }

  const filtered = partners.filter(p => {
    const matchType = filterType === 'all' || p.type === filterType
    const matchSearch = !search ||
      p.name.toLowerCase().includes(search.toLowerCase()) ||
      (p.tax_id || '').toLowerCase().includes(search.toLowerCase()) ||
      (p.contact_email || '').toLowerCase().includes(search.toLowerCase())
    const matchIndividual = filterIndividual === 'all' ||
      (filterIndividual === 'individual' && p.is_individual === true) ||
      (filterIndividual === 'company' && p.is_individual !== true)
    return matchType && matchSearch && matchIndividual
  })

  const typeColors: Record<string, { bg: string; color: string }> = {
    vendor: { bg: 'rgba(255,91,90,0.13)', color: '#FF5B5A' },
    customer: { bg: 'rgba(0,212,126,0.12)', color: '#00D47E' },
    both: { bg: 'rgba(78,168,255,0.13)', color: '#4EA8FF' },
    company: { bg: 'rgba(255,255,255,0.06)', color: '#7A9BB8' },
  }
  const typeLabels: Record<string, string> = {
    vendor: 'Vendor', customer: 'Customer', both: 'Both', company: 'Company',
  }

  return (
    <div style={s.root} className="app-surface">
      <div style={s.body}>
        <div style={s.pageHeader}>
          <div>
            <div style={s.pageTitle}>Partners</div>
            <div style={s.pageSub}>Vendors, customers and all business contacts</div>
          </div>
          <button style={s.newBtn} onClick={() => { setEditPartner(null); setShowDialog(true) }}>
            + New partner
          </button>
        </div>

        <div style={s.summaryRow}>
          <div style={s.summaryCard}>
            <div style={s.summaryLabel}>Total partners</div>
            <div style={s.summaryVal}>{partners.length}</div>
          </div>
          <div style={s.summaryCard}>
            <div style={s.summaryLabel}>Vendors</div>
            <div style={{ ...s.summaryVal, color: '#FF5B5A' }}>
              {partners.filter(p => p.type === 'vendor' || p.type === 'both').length}
            </div>
          </div>
          <div style={s.summaryCard}>
            <div style={s.summaryLabel}>Customers</div>
            <div style={{ ...s.summaryVal, color: '#00D47E' }}>
              {partners.filter(p => p.type === 'customer' || p.type === 'both').length}
            </div>
          </div>
          <div style={s.summaryCard}>
            <div style={s.summaryLabel}>Active</div>
            <div style={s.summaryVal}>{partners.filter(p => p.is_active !== false).length}</div>
          </div>
          <div style={s.summaryCard}>
            <div style={s.summaryLabel}>Individuals</div>
            <div style={{ ...s.summaryVal, color: '#9D97FF' }}>{partners.filter(p => p.is_individual === true).length}</div>
          </div>
        </div>

        <div style={s.filterBar}>
          <input type="text" placeholder="Search name, tax ID or email..."
            value={search} onChange={e => setSearch(e.target.value)} style={s.searchInput} />
          <select value={filterType} onChange={e => setFilterType(e.target.value)} style={s.filterSelect}>
            <option value="all">All types</option>
            <option value="vendor">Vendors</option>
            <option value="customer">Customers</option>
            <option value="both">Both</option>
            <option value="company">Company</option>
          </select>
          <select value={filterIndividual} onChange={e => setFilterIndividual(e.target.value)} style={s.filterSelect}>
            <option value="all">All entities</option>
            <option value="individual">👤 Individuals only</option>
            <option value="company">🏢 Companies only</option>
          </select>
          <div style={s.totalBadge}>{filtered.length} partners</div>
        </div>

        <div style={s.tableWrap}>
          {loading ? (
            <div style={{ padding: '18px 16px' }}>
              <SkeletonRows rows={7} height={15} gap={14}
                widths={[78, 90, 56, 84, 62, 88, 50]} />
            </div>
          ) : filtered.length === 0 ? (
            <div style={s.emptyState}>
              <div style={{ fontSize: '32px', marginBottom: '12px' }}>🤝</div>
              <div style={{ fontSize: '15px', fontWeight: '500', color: '#DCE9F6', marginBottom: '6px' }}>No partners yet</div>
              <div style={{ fontSize: '13px', color: '#7A9BB8', marginBottom: '20px' }}>Add your first vendor or customer.</div>
              <button style={s.newBtn} onClick={() => setShowDialog(true)}>+ New partner</button>
            </div>
          ) : (
            <table style={s.table}>
              <thead>
                <tr style={s.thead}>
                  <th style={s.th}>Name</th>
                  <th style={s.th}>Type</th>
                  <th style={s.th}>Tax ID / PIB</th>
                  <th style={s.th}>City</th>
                  <th style={s.th}>Contact</th>
                  <th style={s.th}>Email</th>
                  <th style={s.th}>Phone</th>
                  <th style={s.th}>Status</th>
                  <th style={s.th}></th>
                </tr>
              </thead>
              <tbody>
                {filtered.map((p, i) => (
                  <tr key={p.id} style={{ ...s.tr, background: i % 2 === 0 ? '#0D1B2C' : '#111F30', cursor: 'pointer' }}
                    onClick={() => { setEditPartner(p); setShowDialog(true) }}>
                    <td style={s.td}>
                      <div style={{ fontWeight: '600', fontSize: '13px', color: '#00D47E' }}>{p.name}</div>
                      {p.address && <div style={{ fontSize: '11px', color: '#7A9BB8', marginTop: '1px' }}>{p.address}</div>}
                    </td>
                    <td style={s.td}>
                      <div style={{ display: 'flex', gap: '4px', flexWrap: 'wrap' as const }}>
                        <span style={{ ...s.badge, background: typeColors[p.type || 'vendor']?.bg || 'rgba(255,255,255,0.06)', color: typeColors[p.type || 'vendor']?.color || '#666' }}>
                          {typeLabels[p.type || 'vendor'] || p.type}
                        </span>
                        {p.is_individual && <span style={{ ...s.badge, background: 'rgba(157,151,255,0.12)', color: '#9D97FF' }}>👤 Individual</span>}
                      </div>
                    </td>
                    <td style={s.td}><span style={s.monoCell}>{p.tax_id || '—'}</span></td>
                    <td style={s.td}><span style={s.smallCell}>{p.city || '—'}</span></td>
                    <td style={s.td}><span style={s.smallCell}>{p.contact_name || '—'}</span></td>
                    <td style={s.td}><span style={s.smallCell}>{p.contact_email || '—'}</span></td>
                    <td style={s.td}><span style={s.smallCell}>{p.contact_phone || '—'}</span></td>
                    <td style={s.td}>
                      <span style={{ ...s.badge, background: p.is_active !== false ? 'rgba(0,212,126,0.12)' : 'rgba(255,255,255,0.06)', color: p.is_active !== false ? '#085041' : '#888' }}>
                        {p.is_active !== false ? 'Active' : 'Inactive'}
                      </span>
                    </td>
                    <td style={s.td} onClick={e => e.stopPropagation()}>
                      <button style={s.deleteBtn} onClick={() => deletePartner(p.id, p.name)}>🗑</button>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </div>
      </div>

      {showDialog && (
        <PartnerDialog
          partner={editPartner}
          onClose={() => { setShowDialog(false); setEditPartner(null) }}
          onSaved={() => { setShowDialog(false); setEditPartner(null); fetchPartners() }}
          onDelete={async (id, name) => { setShowDialog(false); setEditPartner(null); await deletePartner(id, name) }}
        />
      )}
    </div>
  )
}


const s: Record<string, React.CSSProperties> = {
  // The background lives in `.app-surface` rather than here: an inline
  // colour would paint straight over it.
  root: { minHeight: '100vh', fontFamily: "'Inter', system-ui, sans-serif" },
  body: { padding: '24px 28px' },
  pageHeader: { display: 'flex', alignItems: 'flex-start', justifyContent: 'space-between', marginBottom: '1.5rem' },
  pageTitle: { fontFamily: "'DM Serif Display', Georgia, serif", fontSize: '24px', fontWeight: '400', color: '#DCE9F6', marginBottom: '4px' },
  pageSub: { fontSize: '13px', color: '#7A9BB8' },
  newBtn: { background: '#00D47E', color: '#060E1A', border: 'none', borderRadius: '8px', padding: '9px 18px', fontFamily: 'system-ui,sans-serif', fontSize: '13px', fontWeight: '500', cursor: 'pointer', boxShadow: '0 2px 8px rgba(0,212,126,0.3)' },
  summaryRow: { display: 'grid', gridTemplateColumns: 'repeat(5,1fr)', gap: '12px', marginBottom: '1.5rem' },
  summaryCard: { background: '#0D1B2C', border: '1px solid rgba(255,255,255,0.075)', borderRadius: '10px', padding: '14px 16px', boxShadow: '0 4px 20px rgba(0,0,0,0.4)' },
  summaryLabel: { fontSize: '10px', fontWeight: '600', color: 'rgba(255,255,255,0.30)', textTransform: 'uppercase' as const, letterSpacing: '0.08em', marginBottom: '6px' },
  summaryVal: { fontSize: '26px', fontWeight: '600', color: '#DCE9F6' },
  filterBar: { display: 'flex', alignItems: 'center', gap: '10px', marginBottom: '1rem', flexWrap: 'wrap' as const },
  searchInput: { fontFamily: 'system-ui,sans-serif', fontSize: '13px', border: '1px solid rgba(255,255,255,0.075)', borderRadius: '8px', padding: '8px 12px', outline: 'none', background: '#0D1B2C', color: '#DCE9F6', flex: '1', minWidth: '200px' },
  filterSelect: { fontFamily: 'system-ui,sans-serif', fontSize: '13px', border: '1px solid rgba(255,255,255,0.075)', borderRadius: '8px', padding: '8px 12px', outline: 'none', background: '#0D1B2C', color: '#DCE9F6', cursor: 'pointer' },
  totalBadge: { fontSize: '13px', color: '#7A9BB8', background: '#0D1B2C', border: '1px solid rgba(255,255,255,0.075)', borderRadius: '8px', padding: '8px 12px', marginLeft: 'auto', whiteSpace: 'nowrap' as const, fontWeight: '500' },
  tableWrap: { background: '#0D1B2C', border: '1px solid rgba(255,255,255,0.075)', borderRadius: '10px', overflow: 'visible', boxShadow: '0 4px 20px rgba(0,0,0,0.4)' },
  table: { width: '100%', borderCollapse: 'collapse' as const, fontSize: '13px' },
  thead: { background: '#060E1A' },
  th: { padding: '11px 12px', textAlign: 'left' as const, fontSize: '10px', fontWeight: '600', color: 'rgba(255,255,255,0.30)', textTransform: 'uppercase' as const, letterSpacing: '0.08em', borderBottom: '1px solid rgba(255,255,255,0.075)', whiteSpace: 'nowrap' as const },
  tr: { borderBottom: '0.5px solid rgba(255,255,255,0.05)' },
  td: { padding: '10px 12px', verticalAlign: 'middle' as const },
  emptyState: { padding: '3rem', textAlign: 'center' as const, color: '#7A9BB8', fontSize: '14px' },
  badge: { fontSize: '11px', fontWeight: '500', padding: '3px 9px', borderRadius: '20px', whiteSpace: 'nowrap' as const },
  monoCell: { fontSize: '12px', fontFamily: 'monospace', color: '#7A9BB8', background: 'rgba(255,255,255,0.05)', padding: '2px 6px', borderRadius: '4px', border: '0.5px solid rgba(255,255,255,0.10)' },
  smallCell: { fontSize: '12px', color: '#7A9BB8' },
  deleteBtn: { background: 'none', border: 'none', cursor: 'pointer', fontSize: '14px', padding: '4px', opacity: 0.3 },
}
