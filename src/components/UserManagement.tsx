import React, { useState, useEffect } from 'react'
import { supabase } from '../supabase'
import { useCompanies } from '../contexts/CompaniesContext'
import { useAuth, UserRole } from '../contexts/AuthContext'
import { DIALOG } from './dialogTheme'

interface UserProfile {
  id: string
  full_name: string | null
  email: string | null
  role: UserRole
  company_access: string[]
  created_at: string
}

const roleColors: Record<UserRole, { bg: string; color: string }> = {
  administrator: { bg: DIALOG.redFill, color: DIALOG.red },
  owner: { bg: DIALOG.amberFill, color: DIALOG.amber },
  manager: { bg: DIALOG.blueFill, color: DIALOG.blue },
  administrative_assistant: { bg: DIALOG.accentFill, color: DIALOG.accent },
}

const roleLabels: Record<UserRole, string> = {
  administrator: 'Administrator',
  owner: 'Owner',
  manager: 'Manager',
  administrative_assistant: 'Admin Assistant',
}

const rolePermissions: Record<UserRole, { dataEntry: string; reports: string; settings: string; admin: string }> = {
  administrator: { dataEntry: 'Full', reports: 'Full', settings: 'Full', admin: 'Full' },
  owner: { dataEntry: 'Full', reports: 'Full', settings: 'Limited', admin: '—' },
  manager: { dataEntry: '—', reports: 'Assigned only', settings: '—', admin: '—' },
  administrative_assistant: { dataEntry: 'Full', reports: 'Limited', settings: '—', admin: '—' },
}

export default function UserManagement() {
  const { canManageUsers, profile: currentProfile } = useAuth()
  const [users, setUsers] = useState<UserProfile[]>([])
  const { companies } = useCompanies()
  const [loading, setLoading] = useState(true)
  const [editUser, setEditUser] = useState<UserProfile | null>(null)
  const [showEditDialog, setShowEditDialog] = useState(false)
  const [showInviteDialog, setShowInviteDialog] = useState(false)
  const [search, setSearch] = useState('')

  const fetchUsers = async () => {
    setLoading(true)
    const { data } = await supabase
      .from('profiles')
      .select('*')
      .order('created_at', { ascending: false })
    if (data) setUsers(data)
    setLoading(false)
  }

  useEffect(() => {
    fetchUsers()
  }, [])

  const filtered = users.filter(u =>
    !search ||
    (u.full_name || '').toLowerCase().includes(search.toLowerCase()) ||
    (u.email || '').toLowerCase().includes(search.toLowerCase())
  )

  if (!canManageUsers) {
    return (
      <div style={s.noAccess}>
        <div style={{ fontSize: '32px', marginBottom: '12px' }}>🔒</div>
        <div style={{ fontSize: '15px', fontWeight: '500', color: DIALOG.text, marginBottom: '6px' }}>Access restricted</div>
        <div style={{ fontSize: '13px', color: DIALOG.dim }}>Only administrators can manage users.</div>
      </div>
    )
  }

  return (
    <div>
      {/* Header */}
      <div style={s.tabHeader}>
        <div>
          <div style={s.tabTitle}>User management</div>
          <div style={s.tabSub}>{users.length} users · Role-based access control</div>
        </div>
        <button style={s.inviteBtn} onClick={() => setShowInviteDialog(true)}>
          + Invite user
        </button>
      </div>

      {/* Role permissions reference */}
      <div style={s.permCard}>
        <div style={s.permTitle}>Role permissions overview</div>
        <table style={s.permTable}>
          <thead>
            <tr>
              <th style={s.permTh}>Role</th>
              <th style={s.permTh}>Data Entry</th>
              <th style={s.permTh}>Reports</th>
              <th style={s.permTh}>Settings</th>
              <th style={s.permTh}>Admin</th>
            </tr>
          </thead>
          <tbody>
            {(Object.entries(rolePermissions) as [UserRole, any][]).map(([role, perms]) => (
              <tr key={role} style={s.permRow}>
                <td style={s.permTd}>
                  <span style={{ ...s.roleBadge, background: roleColors[role].bg, color: roleColors[role].color }}>
                    {roleLabels[role]}
                  </span>
                </td>
                {[perms.dataEntry, perms.reports, perms.settings, perms.admin].map((p, i) => (
                  <td key={i} style={{ ...s.permTd, textAlign: 'center' }}>
                    {p === '—'
                      ? <span style={{ color: DIALOG.red, fontSize: '13px' }}>✕</span>
                      : <span style={{ fontSize: '12px', color: DIALOG.accent, background: DIALOG.accentFill, padding: '2px 8px', borderRadius: '20px' }}>{p}</span>
                    }
                  </td>
                ))}
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      {/* Search */}
      <div style={{ marginBottom: '12px' }}>
        <input style={s.searchInput} value={search} onChange={e => setSearch(e.target.value)}
          placeholder="Search by name or email..." />
      </div>

      {/* Users list */}
      {loading ? (
        <div style={s.emptyState}>Loading users...</div>
      ) : filtered.length === 0 ? (
        <div style={s.emptyState}>No users found.</div>
      ) : (
        <div style={s.userList}>
          {filtered.map(u => (
            <div key={u.id} style={{ ...s.userCard, ...(u.id === currentProfile?.id ? s.userCardSelf : {}) }}>
              <div style={s.userAvatar}>
                {(u.full_name || u.email || '?').substring(0, 2).toUpperCase()}
              </div>
              <div style={{ flex: 1 }}>
                <div style={{ display: 'flex', alignItems: 'center', gap: '8px', marginBottom: '3px' }}>
                  <span style={s.userName}>{u.full_name || '—'}</span>
                  {u.id === currentProfile?.id && (
                    <span style={s.youBadge}>You</span>
                  )}
                  <span style={{ ...s.roleBadge, background: roleColors[u.role]?.bg, color: roleColors[u.role]?.color }}>
                    {roleLabels[u.role]}
                  </span>
                </div>
                <div style={s.userEmail}>{u.email || '—'}</div>
                <div style={s.userCompanies}>
                  {u.role === 'administrator' || u.role === 'owner'
                    ? <span style={{ color: DIALOG.accent, fontSize: '11px' }}>✓ All companies</span>
                    : u.company_access.length === 0
                      ? <span style={{ color: DIALOG.faint, fontSize: '11px' }}>No company assigned</span>
                      : u.company_access.map(cId => {
                          const c = companies.find(c => c.id === cId)
                          return c ? (
                            <span key={cId} style={s.companyTag}>{c.name}</span>
                          ) : null
                        })
                  }
                </div>
              </div>
              {u.id !== currentProfile?.id && (
                <button style={s.editBtn} onClick={() => { setEditUser(u); setShowEditDialog(true) }}>
                  Edit
                </button>
              )}
            </div>
          ))}
        </div>
      )}

      {/* Edit dialog */}
      {showEditDialog && editUser && (
        <EditUserDialog
          user={editUser}
          companies={companies}
          onClose={() => { setShowEditDialog(false); setEditUser(null) }}
          onSaved={() => { setShowEditDialog(false); setEditUser(null); fetchUsers() }}
        />
      )}

      {/* Invite dialog */}
      {showInviteDialog && (
        <InviteUserDialog
          onClose={() => setShowInviteDialog(false)}
          onSaved={() => { setShowInviteDialog(false); fetchUsers() }}
        />
      )}
    </div>
  )
}

// ── Edit User Dialog ─────────────────────────────────────
function EditUserDialog({ user, companies, onClose, onSaved }: {
  user: UserProfile
  companies: any[]
  onClose: () => void
  onSaved: () => void
}) {
  const [role, setRole] = useState<UserRole>(user.role)
  const [companyAccess, setCompanyAccess] = useState<string[]>(user.company_access || [])
  const [saving, setSaving] = useState(false)
  const [success, setSuccess] = useState(false)

  const toggleCompany = (cId: string) => {
    setCompanyAccess(prev =>
      prev.includes(cId) ? prev.filter(x => x !== cId) : [...prev, cId]
    )
  }

  const allAccessRoles: UserRole[] = ['administrator', 'owner']
  const needsCompanySelection = !allAccessRoles.includes(role)

  const handleSave = async () => {
    setSaving(true)
    await supabase.from('profiles').update({
      role,
      company_access: needsCompanySelection ? companyAccess : [],
    }).eq('id', user.id)
    setSuccess(true)
    setTimeout(() => { setSuccess(false); onSaved() }, 1200)
    setSaving(false)
  }

  if (success) return (
    <div style={ds.overlay}>
      <div style={{ ...ds.dialog, display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center', gap: '12px', minHeight: '180px' }}>
        <div style={{ width: '48px', height: '48px', borderRadius: '50%', background: DIALOG.accentFill, display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
          <svg width="24" height="24" viewBox="0 0 24 24" fill="none" stroke={DIALOG.accent} strokeWidth="2"><path d="M5 13l4 4L19 7" /></svg>
        </div>
        <div style={{ fontFamily: 'Georgia,serif', fontSize: '18px', color: DIALOG.text }}>User updated!</div>
      </div>
    </div>
  )

  return (
    <div style={ds.overlay}>
      <div style={ds.dialog}>
        <div style={ds.header}>
          <div style={ds.headerTitle}>Edit user — {user.full_name || user.email}</div>
          <button style={ds.closeBtn} onClick={onClose}>×</button>
        </div>

        <div style={ds.body}>
          {/* User info */}
          <div style={ds.userInfoRow}>
            <div style={ds.bigAvatar}>{(user.full_name || user.email || '?').substring(0, 2).toUpperCase()}</div>
            <div>
              <div style={{ fontSize: '15px', fontWeight: '500', color: DIALOG.text }}>{user.full_name || '—'}</div>
              <div style={{ fontSize: '13px', color: DIALOG.dim }}>{user.email}</div>
            </div>
          </div>

          {/* Role selector */}
          <div style={ds.section}>
            <div style={ds.sectionTitle}>Role</div>
            <div style={ds.roleGrid}>
              {(Object.entries(roleLabels) as [UserRole, string][]).map(([r, label]) => (
                <div key={r}
                  style={{ ...ds.roleCard, ...(role === r ? { border: `2px solid ${roleColors[r].color}`, background: roleColors[r].bg } : {}) }}
                  onClick={() => setRole(r)}>
                  <div style={{ ...ds.roleBadgeInner, background: roleColors[r].bg, color: roleColors[r].color }}>
                    {label}
                  </div>
                  <div style={ds.rolePerms}>
                    <span>Entry: {rolePermissions[r].dataEntry}</span>
                    <span>Reports: {rolePermissions[r].reports}</span>
                  </div>
                </div>
              ))}
            </div>
          </div>

          {/* Company access */}
          {needsCompanySelection && (
            <div style={ds.section}>
              <div style={ds.sectionTitle}>Company access</div>
              <div style={{ fontSize: '12px', color: DIALOG.dim, marginBottom: '10px' }}>
                Select which companies this user can access.
              </div>
              <div style={ds.companyList}>
                {companies.map(c => (
                  <div key={c.id}
                    style={{ ...ds.companyRow, ...(companyAccess.includes(c.id) ? ds.companyRowActive : {}) }}
                    onClick={() => toggleCompany(c.id)}>
                    <div style={ds.checkbox}>
                      {companyAccess.includes(c.id) && <span style={{ color: DIALOG.accent, fontSize: '12px' }}>✓</span>}
                    </div>
                    <span style={{ fontSize: '13px', color: DIALOG.text }}>{c.name}</span>
                  </div>
                ))}
              </div>
              {companyAccess.length === 0 && (
                <div style={{ fontSize: '11px', color: DIALOG.red, marginTop: '6px' }}>
                  ⚠️ No company selected — user won't see any data.
                </div>
              )}
            </div>
          )}

          {!needsCompanySelection && (
            <div style={{ ...ds.infoBox }}>
              ✓ {roleLabels[role]}s have access to all companies automatically.
            </div>
          )}
        </div>

        <div style={ds.footer}>
          <button style={ds.btnGhost} onClick={onClose}>Cancel</button>
          <button style={ds.btnPrimary} onClick={handleSave} disabled={saving}>
            {saving ? 'Saving...' : 'Save changes'}
          </button>
        </div>
      </div>
    </div>
  )
}

// ── Invite User Dialog ───────────────────────────────────
function InviteUserDialog({ onClose, onSaved }: { onClose: () => void; onSaved: () => void }) {
  const [email, setEmail] = useState('')
  const [fullName, setFullName] = useState('')
  const [sending, setSending] = useState(false)
  const [sent, setSent] = useState(false)
  const [error, setError] = useState('')

  const handleInvite = async () => {
    if (!email.trim()) { setError('Email is required'); return }
    setSending(true)
    setError('')
    try {
      // Use Supabase admin invite
      const { error: inviteError } = await supabase.auth.admin.inviteUserByEmail(email.trim(), {
        data: { full_name: fullName.trim() || null }
      })
      if (inviteError) throw inviteError
      setSent(true)
      setTimeout(() => { setSent(false); onSaved() }, 2000)
    } catch (err: any) {
      setError(err.message || 'Failed to send invite. Make sure you have admin access.')
    }
    setSending(false)
  }

  if (sent) return (
    <div style={ds.overlay}>
      <div style={{ ...ds.dialog, display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center', gap: '12px', minHeight: '180px' }}>
        <div style={{ width: '48px', height: '48px', borderRadius: '50%', background: DIALOG.accentFill, display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
          <svg width="24" height="24" viewBox="0 0 24 24" fill="none" stroke={DIALOG.accent} strokeWidth="2"><path d="M5 13l4 4L19 7" /></svg>
        </div>
        <div style={{ fontFamily: 'Georgia,serif', fontSize: '18px', color: DIALOG.text }}>Invite sent!</div>
        <div style={{ fontSize: '13px', color: DIALOG.dim }}>User will receive an email to set their password.</div>
      </div>
    </div>
  )

  return (
    <div style={ds.overlay}>
      <div style={{ ...ds.dialog, maxWidth: '480px' }}>
        <div style={ds.header}>
          <div style={ds.headerTitle}>Invite new user</div>
          <button style={ds.closeBtn} onClick={onClose}>×</button>
        </div>
        <div style={ds.body}>
          <div style={ds.section}>
            <div style={ds.sectionTitle}>User details</div>
            <div style={ds.field}>
              <label style={ds.lbl}>Full name</label>
              <input style={ds.input} value={fullName} onChange={e => setFullName(e.target.value)} placeholder="e.g. Marko Marković" />
            </div>
            <div style={{ ...ds.field, marginTop: '10px' }}>
              <label style={ds.lbl}>Email <span style={{ color: DIALOG.red }}>*</span></label>
              <input style={{ ...ds.input, ...(error ? { border: '1.5px solid ' + DIALOG.red } : {}) }}
                type="email" value={email} onChange={e => { setEmail(e.target.value); setError('') }}
                placeholder="email@example.com" />
              {error && <span style={{ fontSize: '11px', color: DIALOG.red, marginTop: '4px' }}>{error}</span>}
            </div>
          </div>
          <div style={ds.infoBox}>
            📧 An invitation email will be sent. The user will set their own password. You can assign their role after they accept.
          </div>
        </div>
        <div style={ds.footer}>
          <button style={ds.btnGhost} onClick={onClose}>Cancel</button>
          <button style={ds.btnPrimary} onClick={handleInvite} disabled={sending}>
            {sending ? 'Sending...' : 'Send invite'}
          </button>
        </div>
      </div>
    </div>
  )
}

// ── Styles ───────────────────────────────────────────────
const s: Record<string, React.CSSProperties> = {
  tabHeader: { display: 'flex', alignItems: 'flex-start', justifyContent: 'space-between', marginBottom: '1.5rem' },
  tabTitle: { fontSize: '16px', fontWeight: '500', color: DIALOG.text, marginBottom: '4px' },
  tabSub: { fontSize: '13px', color: DIALOG.dim },
  inviteBtn: { background: DIALOG.accent, color: DIALOG.onAccent, border: 'none', borderRadius: '8px', padding: '9px 16px', fontFamily: 'system-ui,sans-serif', fontSize: '13px', fontWeight: '500', cursor: 'pointer' },
  permCard: { background: DIALOG.panel, border: '0.5px solid ' + DIALOG.border, borderRadius: '12px', padding: '14px 16px', marginBottom: '1.5rem' },
  permTitle: { fontSize: '11px', fontWeight: '500', color: DIALOG.dim, textTransform: 'uppercase' as const, letterSpacing: '0.08em', marginBottom: '12px' },
  permTable: { width: '100%', borderCollapse: 'collapse' as const, fontSize: '12px' },
  permTh: { padding: '6px 12px', textAlign: 'left' as const, fontSize: '10px', fontWeight: '500', color: DIALOG.dim, textTransform: 'uppercase' as const, letterSpacing: '0.08em', borderBottom: '0.5px solid ' + DIALOG.border },
  permRow: { borderBottom: '0.5px solid ' + DIALOG.borderSoft },
  permTd: { padding: '8px 12px' },
  roleBadge: { fontSize: '10px', fontWeight: '500', padding: '2px 8px', borderRadius: '20px', whiteSpace: 'nowrap' as const },
  searchInput: { fontFamily: 'system-ui,sans-serif', fontSize: '13px', border: '0.5px solid ' + DIALOG.border, borderRadius: '8px', padding: '8px 12px', outline: 'none', background: DIALOG.panel, color: DIALOG.text, width: '100%', boxSizing: 'border-box' as const },
  userList: { display: 'flex', flexDirection: 'column' as const, gap: '8px' },
  userCard: { display: 'flex', alignItems: 'center', gap: '14px', background: DIALOG.panel, border: '0.5px solid ' + DIALOG.border, borderRadius: '12px', padding: '14px 16px' },
  userCardSelf: { border: '0.5px solid ' + DIALOG.accent, background: DIALOG.accentFill },
  userAvatar: { width: '38px', height: '38px', borderRadius: '50%', background: DIALOG.panelDeep, display: 'flex', alignItems: 'center', justifyContent: 'center', fontSize: '12px', fontWeight: '600', color: DIALOG.text, flexShrink: 0 },
  userName: { fontSize: '14px', fontWeight: '500', color: DIALOG.text },
  youBadge: { fontSize: '10px', fontWeight: '500', padding: '1px 7px', borderRadius: '20px', background: DIALOG.accentFill, color: DIALOG.accent },
  userEmail: { fontSize: '12px', color: DIALOG.dim, marginBottom: '6px' },
  userCompanies: { display: 'flex', flexWrap: 'wrap' as const, gap: '4px' },
  companyTag: { fontSize: '10px', fontWeight: '500', padding: '2px 8px', borderRadius: '20px', background: DIALOG.raised, color: DIALOG.dim },
  editBtn: { fontFamily: 'system-ui,sans-serif', fontSize: '12px', padding: '6px 14px', border: '0.5px solid ' + DIALOG.border, borderRadius: '8px', background: 'transparent', color: DIALOG.dim, cursor: 'pointer' },
  emptyState: { padding: '2rem', textAlign: 'center' as const, color: DIALOG.dim, fontSize: '13px' },
  noAccess: { padding: '3rem', textAlign: 'center' as const },
}

const ds: Record<string, React.CSSProperties> = {
  overlay: { position: 'fixed', inset: 0, colorScheme: 'dark', background: DIALOG.overlay, backdropFilter: 'blur(4px)', display: 'flex', alignItems: 'center', justifyContent: 'center', zIndex: DIALOG.z },
  dialog: { background: DIALOG.panel, borderRadius: '16px', width: '640px', maxWidth: '95vw', maxHeight: '90vh', display: 'flex', flexDirection: 'column', overflow: 'hidden' },
  header: { background: DIALOG.panelDeep, padding: '1rem 1.5rem', display: 'flex', alignItems: 'center', justifyContent: 'space-between' },
  headerTitle: { color: DIALOG.text, fontSize: '15px', fontWeight: '500' },
  closeBtn: { background: 'none', border: 'none', color: 'rgba(255,255,255,0.5)', fontSize: '22px', cursor: 'pointer', padding: '0 4px', lineHeight: 1 },
  body: { padding: '1.5rem', overflowY: 'auto', flex: 1 },
  footer: { padding: '1rem 1.5rem', borderTop: '0.5px solid ' + DIALOG.border, display: 'flex', justifyContent: 'flex-end', gap: '8px', background: DIALOG.raised },
  section: { marginBottom: '1.5rem' },
  sectionTitle: { fontSize: '11px', fontWeight: '500', color: DIALOG.dim, textTransform: 'uppercase' as const, letterSpacing: '0.08em', marginBottom: '10px', paddingBottom: '6px', borderBottom: '0.5px solid ' + DIALOG.border },
  userInfoRow: { display: 'flex', alignItems: 'center', gap: '14px', padding: '12px 14px', background: DIALOG.raised, borderRadius: '10px', marginBottom: '1.5rem' },
  bigAvatar: { width: '44px', height: '44px', borderRadius: '50%', background: DIALOG.panelDeep, display: 'flex', alignItems: 'center', justifyContent: 'center', fontSize: '14px', fontWeight: '600', color: DIALOG.text, flexShrink: 0 },
  roleGrid: { display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '8px' },
  roleCard: { border: '0.5px solid ' + DIALOG.border, borderRadius: '10px', padding: '12px', background: DIALOG.raised, cursor: 'pointer' },
  roleBadgeInner: { fontSize: '11px', fontWeight: '500', padding: '3px 10px', borderRadius: '20px', display: 'inline-block', marginBottom: '6px' },
  rolePerms: { display: 'flex', gap: '8px', fontSize: '10px', color: DIALOG.dim },
  companyList: { display: 'flex', flexDirection: 'column' as const, gap: '6px' },
  companyRow: { display: 'flex', alignItems: 'center', gap: '10px', padding: '10px 12px', border: '0.5px solid ' + DIALOG.border, borderRadius: '8px', background: DIALOG.panel, cursor: 'pointer' },
  companyRowActive: { border: '1.5px solid ' + DIALOG.accent, background: DIALOG.accentFill },
  checkbox: { width: '18px', height: '18px', borderRadius: '4px', border: '1.5px solid ' + DIALOG.border, display: 'flex', alignItems: 'center', justifyContent: 'center', flexShrink: 0 },
  infoBox: { background: DIALOG.accentFill, border: '0.5px solid ' + DIALOG.accent, borderRadius: '8px', padding: '10px 12px', fontSize: '12px', color: DIALOG.accent },
  field: { display: 'flex', flexDirection: 'column' as const, gap: '4px' },
  lbl: { fontSize: '11px', fontWeight: '500', color: DIALOG.dim, textTransform: 'uppercase' as const, letterSpacing: '0.07em' },
  input: { fontFamily: 'system-ui,sans-serif', fontSize: '13px', padding: '8px 10px', border: '0.5px solid ' + DIALOG.border, borderRadius: '8px', background: DIALOG.panel, color: DIALOG.text, outline: 'none' },
  btnGhost: { fontFamily: 'system-ui,sans-serif', fontSize: '13px', padding: '8px 16px', borderRadius: '8px', border: '0.5px solid ' + DIALOG.border, background: 'transparent', color: DIALOG.dim, cursor: 'pointer' },
  btnPrimary: { fontFamily: 'system-ui,sans-serif', fontSize: '13px', padding: '8px 18px', borderRadius: '8px', border: 'none', background: DIALOG.accent, color: DIALOG.onAccent, cursor: 'pointer', fontWeight: '500' },
}