import React from 'react'
import { useAuth } from '../contexts/AuthContext'
import { useNav } from '../navigation'
import type { Page } from '../navigation'
import DisplayCurrencyToggle from './DisplayCurrencyToggle'

const Icon = ({ children }: { children: React.ReactNode }) => (
  <svg width="16" height="16" viewBox="0 0 16 16" fill="none"
    stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round">
    {children}
  </svg>
)

const ICONS: Record<string, React.ReactNode> = {
  dashboard:    <Icon><rect x="1.5" y="1.5" width="5.5" height="5.5" rx="1.2"/><rect x="9" y="1.5" width="5.5" height="5.5" rx="1.2"/><rect x="1.5" y="9" width="5.5" height="5.5" rx="1.2"/><rect x="9" y="9" width="5.5" height="5.5" rx="1.2"/></Icon>,
  transactions: <Icon><path d="M2 5h12M10.5 2l3.5 3-3.5 3"/><path d="M14 11H2M5.5 8l-3.5 3 3.5 3"/></Icon>,
  revenue:      <Icon><path d="M2 12l4-4 3 3 5-6"/><circle cx="13.5" cy="4.5" r="1.5"/></Icon>,
  pl:           <Icon><path d="M2.5 12V8.5M5.5 12V5M8.5 12V7M11.5 12V3M14.5 12V6"/></Icon>,
  cashflow:     <Icon><path d="M1 10C2.5 7 4.5 6 8 6s5.5 2 7 0"/><path d="M1 14C2.5 11 4.5 10 8 10s5.5 2 7 0"/></Icon>,
  budgeting:    <Icon><rect x="1.5" y="3" width="13" height="10" rx="1.5"/><path d="M5 3v10M1.5 7h13M1.5 11h13"/></Icon>,
  reports:      <Icon><rect x="2.5" y="1.5" width="11" height="13" rx="1.5"/><path d="M5.5 5.5h5M5.5 8h5M5.5 10.5h3"/></Icon>,
  expenses:     <Icon><path d="M1.5 14.5h13"/><rect x="2.5" y="8" width="4" height="4.5" rx="0.8"/><rect x="7.5" y="4.5" width="4" height="8" rx="0.8"/><rect x="12.5" y="2" width="1.5" height="10.5" rx="0.7"/></Icon>,
  partners:     <Icon><circle cx="5.5" cy="5" r="2.5"/><path d="M1 13.5c0-2.5 2-4.5 4.5-4.5s4.5 2 4.5 4.5"/><circle cx="12" cy="5" r="2"/><path d="M14.5 13c0-1.9-1.1-3.5-2.5-4"/></Icon>,
  credits:      <Icon><rect x="1.5" y="4.5" width="13" height="9" rx="1.5"/><path d="M1.5 7.5h13"/><path d="M4.5 10.5h3"/><path d="M9.5 10.5h2"/></Icon>,
  hr:           <Icon><circle cx="8" cy="4.5" r="2.5"/><path d="M2.5 14c0-3 2.4-5.5 5.5-5.5s5.5 2.5 5.5 5.5"/><path d="M11.5 1.5h3M13 0v3"/></Icon>,
  payroll:      <Icon><rect x="1.5" y="3.5" width="13" height="10" rx="1.5"/><path d="M1.5 6.5h13"/><path d="M4.5 10h2M9 10h2.5"/></Icon>,
  settings:     <Icon><circle cx="8" cy="8" r="2.5"/><path d="M8 1.5v1.8M8 12.7v1.8M1.5 8h1.8M12.7 8h1.8M3.6 3.6l1.3 1.3M11.1 11.1l1.3 1.3M3.6 12.4l1.3-1.3M11.1 4.9l1.3-1.3"/></Icon>,
}

/**
 * The order follows the work: put things in, read what they mean, then plan.
 *
 * P&L Analysis sits directly under the General Ledger because it is the ledger
 * read back — the same rows, four ways round. Everything under it is a
 * different question about a different set of rows.
 *
 * `transactions` keeps its key and its `/transactions` URL — only the label
 * changed, twice now — so existing links and bookmarks still land where they
 * did.
 */
const NAV_ITEMS: { key: Page; label: string }[] = [
  { key: 'dashboard',    label: 'Dashboard' },
  { key: 'transactions', label: 'General Ledger' },
  { key: 'expenses',     label: 'P&L Analysis' },
  { key: 'revenue',      label: 'Revenue' },
  { key: 'cashflow',     label: 'Cash Flow' },
  { key: 'budgeting',    label: 'Budgeting & Forecasting' },
  { key: 'reports',      label: 'Reports' },
  { key: 'credits',      label: 'Bank Credits' },
  { key: 'hr',           label: 'HR Administration' },
  { key: 'payroll',      label: 'Payroll' },
  { key: 'partners',     label: 'Partners' },
  { key: 'settings',     label: 'Settings' },
]

export function LogoMark({ size = 26 }: { size?: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 36 36" fill="none">
      <polygon points="18,2 34,30 2,30" fill="none" stroke="#00D47E" strokeWidth="1.8"/>
      <circle cx="18" cy="2" r="2.5" fill="#00D47E"/>
      <circle cx="34" cy="30" r="2" fill="#5DCAA5"/>
      <circle cx="2" cy="30" r="2" fill="#9FE1CB"/>
    </svg>
  )
}

export default function Sidebar() {
  const { user, signOut } = useAuth()
  const { page, setPage } = useNav()
  const initials = user?.email?.substring(0, 2).toUpperCase() ?? 'AD'

  return (
    <aside style={s.sidebar}>
      <div style={s.logoRow}>
        <LogoMark size={26} />
        <span style={s.logoText}>
          MC<span style={{ color: '#00D47E' }}>Flow</span>
        </span>
      </div>

      <nav style={s.nav}>
        {NAV_ITEMS.map(item => {
          const active = page === item.key
          const isRevenue   = item.key === 'revenue'
          const isBudgeting = item.key === 'budgeting'
          const isCredits   = item.key === 'credits'
          return (
            <button
              key={item.key}
              onClick={() => setPage(item.key)}
              style={{
                ...s.navItem,
                background: active
                  ? isRevenue   ? 'rgba(157,151,255,0.12)'
                  : isBudgeting ? 'rgba(230,180,50,0.12)'
                  : isCredits   ? 'rgba(78,168,255,0.12)'
                  : 'rgba(0,212,126,0.10)'
                  : 'transparent',
                color: active ? '#fff' : 'rgba(255,255,255,0.44)',
              }}
            >
              <span style={{
                color: active
                  ? isRevenue   ? '#9D97FF'
                  : isBudgeting ? '#E6B432'
                  : isCredits   ? '#4EA8FF'
                  : '#00D47E'
                  : 'rgba(255,255,255,0.30)',
                display: 'flex'
              }}>
                {ICONS[item.key]}
              </span>
              <span style={{ fontSize: '13px', fontWeight: active ? '500' : '400' }}>
                {item.label}
              </span>
            </button>
          )
        })}
      </nav>

      {/* Which book currency the pages show; remembered per viewer. */}
      <div style={s.currencyRow}>
        <DisplayCurrencyToggle />
      </div>

      <div style={s.userRow}>
        <div style={s.avatar}>{initials}</div>
        <div style={{ flex: 1, minWidth: 0 }}>
          <div style={s.userEmail}>{user?.email}</div>
          <div style={s.userRole}>Administrator</div>
        </div>
        <button style={s.signoutBtn} onClick={signOut} title="Sign out">
          <svg width="14" height="14" viewBox="0 0 16 16" fill="none" stroke="rgba(255,255,255,0.35)" strokeWidth="1.5" strokeLinecap="round">
            <path d="M6 8h8M11 5l3 3-3 3M10 3H3a1 1 0 00-1 1v8a1 1 0 001 1h7"/>
          </svg>
        </button>
      </div>
    </aside>
  )
}

const s: Record<string, React.CSSProperties> = {
  sidebar: {
    width: '208px',
    flexShrink: 0,
    background: '#0A1525',
    borderRight: '1px solid rgba(255,255,255,0.07)',
    display: 'flex',
    flexDirection: 'column',
    height: '100vh',
    position: 'sticky',
    top: 0,
  },
  logoRow: {
    display: 'flex',
    alignItems: 'center',
    gap: '9px',
    padding: '20px 20px 16px',
    borderBottom: '1px solid rgba(255,255,255,0.07)',
  },
  logoText: {
    fontFamily: "'DM Serif Display', Georgia, serif",
    fontSize: '18px',
    fontWeight: '400',
    color: '#fff',
    letterSpacing: '0.01em',
  },
  nav: {
    flex: 1,
    padding: '10px',
    overflowY: 'auto',
  },
  navItem: {
    display: 'flex',
    alignItems: 'center',
    gap: '10px',
    width: '100%',
    padding: '9px 12px',
    borderRadius: '8px',
    border: 'none',
    cursor: 'pointer',
    marginBottom: '2px',
    textAlign: 'left',
    transition: 'background 0.15s, color 0.15s',
    fontFamily: "'Inter', system-ui, sans-serif",
  },
  currencyRow: {
    padding: '10px 16px',
    borderTop: '1px solid rgba(255,255,255,0.07)',
  },
  userRow: {
    display: 'flex',
    alignItems: 'center',
    gap: '10px',
    padding: '14px 16px',
    borderTop: '1px solid rgba(255,255,255,0.07)',
  },
  avatar: {
    width: '30px',
    height: '30px',
    borderRadius: '50%',
    background: '#00D47E',
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'center',
    fontSize: '11px',
    fontWeight: '600',
    color: '#060E1A',
    flexShrink: 0,
  },
  userEmail: {
    fontSize: '11px',
    fontWeight: '500',
    color: '#fff',
    overflow: 'hidden',
    textOverflow: 'ellipsis',
    whiteSpace: 'nowrap',
  },
  userRole: {
    fontSize: '10px',
    color: 'rgba(255,255,255,0.35)',
    letterSpacing: '0.04em',
  },
  signoutBtn: {
    background: 'none',
    border: 'none',
    cursor: 'pointer',
    padding: '4px',
    borderRadius: '6px',
    display: 'flex',
    alignItems: 'center',
    flexShrink: 0,
  },
}