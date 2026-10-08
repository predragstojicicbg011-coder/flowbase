// The Prihodi page's styles: the same tokens as Projects.tsx, named once so
// the sections cannot drift apart.

import type { CSSProperties } from 'react'
import { DIALOG } from '../dialogTheme'

export const rs: Record<string, CSSProperties> = {
  root: { minHeight: '100vh', fontFamily: "'Inter', system-ui, sans-serif" },
  body: { padding: '24px 28px' },
  section: { marginTop: '2rem' },
  newBtn: { background: '#00D47E', color: '#060E1A', border: 'none', borderRadius: '8px', padding: '9px 18px', fontFamily: 'system-ui,sans-serif', fontSize: '13px', fontWeight: '500', cursor: 'pointer', boxShadow: '0 2px 8px rgba(0,212,126,0.3)' },
  ghostBtn: { background: 'transparent', border: '1px solid rgba(255,255,255,0.10)', color: '#7A9BB8', borderRadius: '8px', padding: '7px 14px', fontSize: '12.5px', cursor: 'pointer' },
  linkBtn: { background: 'transparent', border: 'none', color: '#4EA8FF', fontSize: '12.5px', cursor: 'pointer', padding: 0 },
  summaryRow: { display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(190px, 1fr))', gap: '12px', marginBottom: '1.5rem' },
  summaryCard: { background: '#0D1B2C', border: '1px solid rgba(255,255,255,0.075)', borderRadius: '10px', padding: '14px 16px', boxShadow: '0 4px 20px rgba(0,0,0,0.4)' },
  summaryLabel: { fontSize: '10px', fontWeight: '600', color: 'rgba(255,255,255,0.30)', textTransform: 'uppercase', letterSpacing: '0.08em', marginBottom: '6px' },
  summaryVal: { fontSize: '22px', fontWeight: '600', color: '#DCE9F6', fontVariantNumeric: 'tabular-nums' },
  summarySub: { fontSize: '11.5px', color: '#7A9BB8', marginTop: '4px' },
  sectionTitle: { fontSize: '11px', fontWeight: '600', color: 'rgba(255,255,255,0.30)', textTransform: 'uppercase', letterSpacing: '0.1em', marginBottom: '10px' },
  filterBar: { display: 'flex', alignItems: 'center', gap: '10px', marginBottom: '1rem', flexWrap: 'wrap' },
  searchInput: { fontFamily: 'system-ui,sans-serif', fontSize: '13px', border: '1px solid rgba(255,255,255,0.075)', borderRadius: '8px', padding: '8px 12px', outline: 'none', background: '#0D1B2C', color: '#DCE9F6', flex: '1', minWidth: '180px' },
  filterInput: { fontFamily: 'system-ui,sans-serif', fontSize: '13px', border: '1px solid rgba(255,255,255,0.075)', borderRadius: '8px', padding: '7px 10px', outline: 'none', background: '#0D1B2C', color: '#DCE9F6', colorScheme: 'dark' },
  dateLabel: { display: 'flex', alignItems: 'center', gap: '8px', fontSize: '12px', color: '#7A9BB8' },
  totalBadge: { fontSize: '13px', color: '#7A9BB8', background: '#0D1B2C', border: '1px solid rgba(255,255,255,0.075)', borderRadius: '8px', padding: '8px 12px', marginLeft: 'auto', whiteSpace: 'nowrap', fontWeight: '500' },
  tableWrap: { background: '#0D1B2C', border: '1px solid rgba(255,255,255,0.075)', borderRadius: '10px', overflowX: 'auto', boxShadow: '0 4px 20px rgba(0,0,0,0.4)' },
  table: { width: '100%', borderCollapse: 'collapse', fontSize: '13px' },
  thead: { background: '#060E1A' },
  th: { padding: '11px 12px', textAlign: 'left', fontSize: '10px', fontWeight: '600', color: 'rgba(255,255,255,0.30)', textTransform: 'uppercase', letterSpacing: '0.08em', borderBottom: '1px solid rgba(255,255,255,0.075)', whiteSpace: 'nowrap' },
  thNum: { padding: '11px 12px', textAlign: 'right', fontSize: '10px', fontWeight: '600', color: 'rgba(255,255,255,0.30)', textTransform: 'uppercase', letterSpacing: '0.08em', borderBottom: '1px solid rgba(255,255,255,0.075)', whiteSpace: 'nowrap' },
  tr: { borderBottom: '0.5px solid rgba(255,255,255,0.05)' },
  td: { padding: '10px 12px', verticalAlign: 'middle', color: '#DCE9F6' },
  num: { textAlign: 'right', fontVariantNumeric: 'tabular-nums', whiteSpace: 'nowrap' },
  subCell: { fontSize: '11px', color: '#7A9BB8', marginTop: '1px' },
  smallCell: { fontSize: '12px', color: '#7A9BB8' },
  emptyState: { padding: '2.5rem', textAlign: 'center', color: '#7A9BB8', fontSize: '14px' },
  emptyTitle: { fontSize: '15px', fontWeight: '500', color: '#DCE9F6', marginBottom: '6px' },
  badge: { fontSize: '11px', fontWeight: '500', padding: '3px 9px', borderRadius: '20px', whiteSpace: 'nowrap' },
  badgePaid: { background: 'rgba(0,212,126,0.12)', color: '#00D47E' },
  badgePartial: { background: 'rgba(245,166,35,0.12)', color: '#F5A623' },
  badgeUnpaid: { background: 'rgba(255,91,90,0.10)', color: '#FF5B5A' },
  badgeMuted: { background: 'rgba(255,255,255,0.06)', color: '#7A9BB8' },
  badgeRent: { background: 'rgba(78,168,255,0.13)', color: '#4EA8FF' },
  error: { fontSize: '12.5px', color: '#FF5B5A', background: 'rgba(255,91,90,0.10)', border: '1px solid rgba(255,91,90,0.35)', borderRadius: '8px', padding: '8px 12px', marginBottom: '1rem' },
  info: { fontSize: '12.5px', color: '#4EA8FF', background: 'rgba(78,168,255,0.10)', border: '1px solid rgba(78,168,255,0.30)', borderRadius: '8px', padding: '8px 12px', marginBottom: '1rem' },
  note: { fontSize: '12px', color: 'rgba(255,255,255,0.35)', marginTop: '8px' },
  rowStripe0: { background: '#0D1B2C' },
  rowStripe1: { background: '#111F30' },
  rowTotal: { background: '#060E1A', borderTop: '1px solid rgba(255,255,255,0.12)' },
}

/** Dialog styles, as ProjectDialog's. */
export const ds: Record<string, CSSProperties> = {
  panel: {
    background: DIALOG.panel, borderRadius: '14px', width: '620px', maxWidth: '94vw', maxHeight: '90vh',
    display: 'flex', flexDirection: 'column', border: `1px solid ${DIALOG.border}`, overflow: 'hidden',
    boxShadow: DIALOG.shadow, fontFamily: "'Inter', system-ui, sans-serif",
  },
  body: { padding: '1.25rem 1.5rem', overflowY: 'auto', display: 'flex', flexDirection: 'column', gap: '14px' },
  row: { display: 'flex', gap: '12px', flexWrap: 'wrap' },
  field: { display: 'flex', flexDirection: 'column', gap: '6px', minWidth: '120px' },
  lbl: { fontSize: '11px', fontWeight: '500', color: DIALOG.dim, textTransform: 'uppercase', letterSpacing: '0.06em' },
  req: { color: DIALOG.red },
  input: {
    fontFamily: 'system-ui,sans-serif', fontSize: '13px', border: `1px solid ${DIALOG.border}`,
    borderRadius: '8px', padding: '8px 12px', outline: 'none', background: DIALOG.raised, color: DIALOG.text,
    width: '100%', boxSizing: 'border-box',
  },
  hint: { fontSize: '11.5px', color: DIALOG.faint },
  check: { display: 'flex', alignItems: 'center', gap: '8px', fontSize: '13px', color: DIALOG.text, cursor: 'pointer' },
  error: {
    fontSize: '12.5px', color: DIALOG.red, background: DIALOG.redFill, border: `1px solid ${DIALOG.redSoft}`,
    borderRadius: '8px', padding: '8px 12px',
  },
  ok: {
    fontSize: '12.5px', color: DIALOG.accent, background: DIALOG.accentFill, border: `1px solid ${DIALOG.accentSoft}`,
    borderRadius: '8px', padding: '8px 12px',
  },
  footer: {
    background: DIALOG.panelDeep, padding: '0.9rem 1.5rem', display: 'flex',
    alignItems: 'center', justifyContent: 'space-between', borderTop: `1px solid ${DIALOG.borderSoft}`, gap: '8px',
  },
  cancelBtn: {
    background: 'transparent', border: `1px solid ${DIALOG.border}`, color: DIALOG.dim,
    borderRadius: '8px', padding: '8px 16px', fontSize: '13px', cursor: 'pointer',
  },
  saveBtn: {
    background: DIALOG.accent, color: DIALOG.onAccent, border: 'none', borderRadius: '8px',
    padding: '8px 18px', fontSize: '13px', fontWeight: '500', cursor: 'pointer',
  },
  dangerBtn: {
    background: 'transparent', border: `1px solid ${DIALOG.redSoft}`, color: DIALOG.red,
    borderRadius: '8px', padding: '8px 14px', fontSize: '13px', cursor: 'pointer',
  },
  endBox: {
    border: `1px solid ${DIALOG.border}`, borderRadius: '10px', padding: '10px 12px', background: DIALOG.raised,
    display: 'flex', alignItems: 'flex-end', gap: '10px', flexWrap: 'wrap',
  },
}
