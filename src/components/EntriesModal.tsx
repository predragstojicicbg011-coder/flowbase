import React, { useState } from 'react'
import { supabase } from '../supabase'
import TransactionDialog from './TransactionDialog'
import InvoiceDialog from './InvoiceDialog'
import { byDateDesc } from '../services/expenseTree'

// ── Entries modal ───────────────────────────────────────────────────────────
//
// The drill-down every report shares: click a line, see the entries behind it,
// then choose one to edit. Overview first, editing second — jumping straight
// into an edit form is disorienting, because you have not yet seen which of the
// forty-four rows you are about to change.
//
// Lifted out of Budgeting so the Budgeting and Expense Analysis drill-downs are
// literally the same component rather than two that merely started out alike.
// Each page still owns its own query; only the chrome, the row and the edit
// flow live here.

export interface EntryBadge {
  label: string
  color: string
  bg: string
}

export const CF_BADGES: Record<string, EntryBadge> = {
  recurring: { label: 'Recurring', color: '#00D47E', bg: 'rgba(0,212,126,0.12)' },
  one_time: { label: 'One-time', color: '#F5A623', bg: 'rgba(245,166,35,0.12)' },
  accrual: { label: 'Accrual', color: '#4EA8FF', bg: 'rgba(78,168,255,0.12)' },
  capex: { label: 'CapEx', color: '#7A9BB8', bg: 'rgba(255,255,255,0.05)' },
  reimbursable: { label: 'Reimb.', color: '#A78BFA', bg: 'rgba(167,139,250,0.12)' },
}

export const INVOICE_BADGE = (label: string): EntryBadge =>
  ({ label, color: '#4EA8FF', bg: 'rgba(78,168,255,0.12)' })

/** Which row in which table the Edit button has to fetch back. */
export interface EditTarget {
  table: 'transactions' | 'invoices'
  id: string
}

export interface EntryItem {
  id: string
  title: string
  date: string
  path?: string
  note?: string | null
  amount: number
  currency: string
  amountUsd?: number | null
  badges?: EntryBadge[]
  edit: EditTarget
}

/**
 * How many entries a drill-down will fetch and show.
 *
 * Nobody reviews six hundred rows in a modal, and the export is there for the
 * full list. The cap also keeps the read-back below two limits that bite
 * silently: PostgREST truncates a response at 1000 rows without saying so, and
 * a GET URL carrying thousands of UUIDs is refused with a 414 long before that.
 *
 * It bounds only the `.in('id', …)` lookup this module performs — not the
 * caller's own query, which routinely returns far more than 1000 rows and has
 * to page through `fetchAllPages` to do so. The cap lives in `buildEntryItems`
 * rather than in each caller so a caller cannot forget it.
 */
export const DRILL_CAP = 300

/**
 * Turns a list of `v_pl_entries` ids into the full rows a drill-down shows.
 *
 * The view carries only what a tree or a budget cell needs to total correctly;
 * the partner, currency and note shown here are read back from the two tables
 * the view is built from. `source` tells the two apart — an invoice-sourced
 * row's id points at `invoices`, not `transactions`.
 *
 * `supabase` is a parameter rather than a module import so the function can be
 * driven by a stub — `EntriesModal.test.tsx` does exactly that, which is how
 * the cap below is tested without a database. (The module itself still imports
 * the real client, which `useEntryEditor` needs.)
 *
 * The cap keeps the MOST RECENT rows, so the input is sorted here rather than
 * trusted to arrive sorted. Slicing first and sorting the survivors is only
 * "most recent" for a caller that already hands over a descending list, and
 * Budgeting does not: its rows come back ordered by `pl_date` ascending,
 * because that ordering is chosen to make `.range()` paging deterministic, not
 * for display. That combination silently showed the first week of a month
 * under a heading claiming the newest 300.
 *
 * Returns the capped `items`, the `total` the caller asked for and whether the
 * cap bit, so the caller can say "showing 300 of 1,284" rather than implying
 * it is showing everything.
 */
export async function buildEntryItems(
  rows: { id: string; source?: string | null; pl_date?: string | null; date?: string | null }[],
  supabase: any,
): Promise<{ items: EntryItem[]; total: number; capped: boolean }> {
  const total = rows.length
  const capped = total > DRILL_CAP
  const page = [...rows].sort(byDateDesc).slice(0, DRILL_CAP)

  const isInvoice = (r: { source?: string | null }) => String(r.source || '').toLowerCase().startsWith('inv')
  const txIds = page.filter(r => r.id && !isInvoice(r)).map(r => r.id)
  const invIds = page.filter(r => r.id && isInvoice(r)).map(r => r.id)

  const [tx, inv] = await Promise.all([
    txIds.length === 0 ? Promise.resolve({ data: [], error: null }) : supabase
      .from('transactions')
      .select('id, transaction_date, amount, amount_usd, currency, pl_category, department, expense_description, cf_type, note, partners(name)')
      .in('id', txIds),
    invIds.length === 0 ? Promise.resolve({ data: [], error: null }) : supabase
      .from('invoices')
      .select('id, invoice_date, invoice_number, amount, amount_usd, currency, pl_category, department, expense_description, note, partners(name)')
      .in('id', invIds),
  ])
  if (tx.error) throw tx.error
  if (inv.error) throw inv.error

  const path = (r: any) => [r.pl_category, r.department && `/ ${r.department}`, r.expense_description]
    .filter(Boolean).join(' ')

  const items = [
    ...((tx.data || []) as any[]).map(r => ({
      id: r.id,
      title: (r.partners as any)?.name || r.expense_description || '—',
      date: r.transaction_date,
      path: path(r),
      note: r.note,
      amount: r.amount,
      currency: r.currency,
      amountUsd: r.amount_usd,
      badges: r.cf_type && CF_BADGES[r.cf_type] ? [CF_BADGES[r.cf_type]] : [],
      edit: { table: 'transactions' as const, id: r.id },
    })),
    ...((inv.data || []) as any[]).map(r => ({
      id: r.id,
      title: (r.partners as any)?.name || r.expense_description || '—',
      date: r.invoice_date,
      path: path(r),
      note: r.note,
      amount: r.amount,
      currency: r.currency,
      amountUsd: r.amount_usd,
      badges: [INVOICE_BADGE(r.invoice_number || 'Invoice')],
      edit: { table: 'invoices' as const, id: r.id },
    })),
    // Still sorted after mapping, and not redundant with the sort above: the
    // two tables are read separately, so this is what interleaves them.
  ].sort(byDateDesc)

  return { items, total, capped }
}

/**
 * Opens the dialog an entry was created in.
 *
 * Deliberately the existing TransactionDialog / InvoiceDialog: a correction
 * made from a report then goes through the same validation, period lock and
 * audit trail as one made on the Transactions page.
 */
export function useEntryEditor(onDone: () => void) {
  const [editingTx, setEditingTx] = useState<any>(null)
  const [editingInvoice, setEditingInvoice] = useState<any>(null)
  const [busyId, setBusyId] = useState<string | null>(null)
  const [error, setError] = useState('')

  const openEntry = async (target: EditTarget) => {
    setBusyId(target.id)
    setError('')
    try {
      const select = target.table === 'invoices'
        ? '*, companies(name,currencies), partners(name)'
        : '*, companies(name,currencies), banks(name), partners(name)'
      const { data, error: err } = await supabase
        .from(target.table).select(select).eq('id', target.id).maybeSingle()
      if (err) throw err
      if (!data) throw new Error('This entry could not be found — it may have been deleted.')
      if (target.table === 'invoices') setEditingInvoice(data); else setEditingTx(data)
    } catch (e: any) {
      setError(e.message || String(e))
    }
    setBusyId(null)
  }

  const finish = () => {
    setEditingTx(null)
    setEditingInvoice(null)
    onDone()
  }

  const editorNode = editingTx
    ? <TransactionDialog transaction={editingTx} onClose={finish} sourceTable="transactions" />
    : editingInvoice
      ? <InvoiceDialog invoice={editingInvoice} onClose={finish} />
      : null

  return { openEntry, editorNode, busyId, error }
}

export function EntriesModal({
  kicker, title, subtitle, footerLeft, onClose, children,
}: {
  kicker: string
  title: string
  subtitle: React.ReactNode
  footerLeft?: React.ReactNode
  onClose: () => void
  children: React.ReactNode
}) {
  return (
    <div style={em.overlay} onClick={e => { if (e.target === e.currentTarget) onClose() }}>
      <div style={em.modal}>
        <div style={em.header}>
          <div>
            <div style={em.headerKicker}>{kicker}</div>
            <div style={em.headerTitle}>{title}</div>
            <div style={em.headerSub}>{subtitle}</div>
          </div>
          <button style={em.closeBtn} onClick={onClose} aria-label="Close">×</button>
        </div>

        <div style={em.body}>{children}</div>

        <div style={em.footer}>
          {footerLeft && <div style={{ fontSize: '12px', color: '#7A9BB8' }}>{footerLeft}</div>}
          <div style={{ marginLeft: 'auto' }}>
            <button style={em.closeFooterBtn} onClick={onClose}>Close</button>
          </div>
        </div>
      </div>
    </div>
  )
}

export function EntryRow({ item, onEdit, busy }: {
  item: EntryItem
  onEdit: (target: EditTarget) => void
  busy?: boolean
}) {
  return (
    <div style={em.txRow}>
      <div style={{ flex: 1, minWidth: 0 }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: '8px', marginBottom: '4px', flexWrap: 'wrap' }}>
          <span style={{ fontSize: '13px', fontWeight: '500', color: '#DCE9F6' }}>{item.title}</span>
          {(item.badges || []).map((b, i) => (
            <span key={i} style={{
              fontSize: '10px', padding: '2px 8px', borderRadius: '20px',
              background: b.bg, color: b.color, fontWeight: '500', letterSpacing: '0.02em',
            }}>{b.label}</span>
          ))}
        </div>
        <div style={{ fontSize: '11px', color: '#7A9BB8' }}>
          {item.date}{item.path && <span> · {item.path}</span>}
        </div>
        {item.note && (
          <div style={{ fontSize: '11px', color: 'rgba(255,255,255,0.30)', marginTop: '3px', fontStyle: 'italic' }}>
            {item.note.slice(0, 80)}{item.note.length > 80 ? '…' : ''}
          </div>
        )}
      </div>
      {/* USD leads, because the total in the header is USD and this column has
          to be the thing that adds up to it. With the original currency bold
          instead, the eye sums 345,492 + 12,436 RSD and reads the header as
          wrong. The original amount stays, one line down. */}
      <div style={{ textAlign: 'right', flexShrink: 0, marginRight: '12px' }}>
        <div style={{ fontSize: '13px', fontWeight: '600', color: '#FF5B5A', fontFamily: "'DM Mono', monospace" }}>
          {item.amountUsd != null
            ? `$${item.amountUsd.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`
            : `${item.amount.toLocaleString()} ${item.currency}`}
        </div>
        {item.currency !== 'USD' && item.amountUsd != null && (
          <div style={{ fontSize: '11px', color: '#7A9BB8', fontFamily: "'DM Mono', monospace" }}>
            {item.amount.toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })} {item.currency}
          </div>
        )}
      </div>
      <button style={em.editBtn} onClick={() => onEdit(item.edit)} disabled={busy}
        title={item.edit.table === 'invoices' ? 'Edit invoice' : 'Edit transaction'}>
        {busy ? '…' : 'Edit'}
      </button>
    </div>
  )
}

export const em: Record<string, React.CSSProperties> = {
  overlay: {
    position: 'fixed', inset: 0,
    background: 'rgba(0,0,0,0.65)',
    backdropFilter: 'blur(4px)',
    display: 'flex', alignItems: 'center', justifyContent: 'center',
    zIndex: 1001,
  },
  modal: {
    background: '#0D1B2C',
    border: '1px solid rgba(255,255,255,0.10)',
    borderRadius: '16px',
    width: '760px', maxWidth: '95vw', maxHeight: '85vh',
    display: 'flex', flexDirection: 'column',
    overflow: 'hidden',
    boxShadow: '0 24px 60px rgba(0,0,0,0.6)',
  },
  header: {
    background: '#0A1525',
    padding: '1.1rem 1.5rem',
    display: 'flex', alignItems: 'flex-start', justifyContent: 'space-between',
    borderBottom: '1px solid rgba(255,255,255,0.06)',
  },
  headerKicker: { color: '#00D47E', fontSize: '10px', fontWeight: '600', letterSpacing: '0.1em', marginBottom: '4px' },
  headerTitle: {
    color: '#DCE9F6', fontFamily: "'DM Serif Display', Georgia, serif",
    fontSize: '18px', fontWeight: '400', marginBottom: '3px', letterSpacing: '-0.01em',
  },
  headerSub: { color: '#7A9BB8', fontSize: '12px' },
  closeBtn: {
    background: 'rgba(255,255,255,0.05)', border: '1px solid rgba(255,255,255,0.08)',
    color: '#7A9BB8', fontSize: '20px', cursor: 'pointer', padding: '0',
    width: '28px', height: '28px', borderRadius: '8px', lineHeight: 1, flexShrink: 0,
    display: 'flex', alignItems: 'center', justifyContent: 'center',
  },
  body: { padding: '1.25rem 1.5rem', overflowY: 'auto', flex: 1 },
  empty: { padding: '40px', textAlign: 'center', color: '#7A9BB8', fontSize: '13px' },
  footer: {
    padding: '0.75rem 1.5rem', borderTop: '1px solid rgba(255,255,255,0.06)',
    display: 'flex', alignItems: 'center', background: '#0A1525',
  },
  txRow: {
    display: 'flex', alignItems: 'center', gap: '12px', padding: '11px 14px',
    border: '1px solid rgba(255,255,255,0.06)', borderRadius: '10px',
    background: '#111F30', marginBottom: '4px',
    transition: 'border-color 0.15s, background 0.15s',
  },
  editBtn: {
    fontFamily: "'Inter', sans-serif", fontSize: '11px', fontWeight: '500',
    padding: '5px 12px', border: '1px solid rgba(0,212,126,0.4)', borderRadius: '6px',
    background: 'rgba(0,212,126,0.08)', color: '#00D47E', cursor: 'pointer',
    whiteSpace: 'nowrap', flexShrink: 0,
  },
  closeFooterBtn: {
    fontFamily: "'Inter', sans-serif", fontSize: '13px', padding: '7px 16px',
    borderRadius: '8px', border: '1px solid rgba(255,255,255,0.08)',
    background: 'transparent', color: '#7A9BB8', cursor: 'pointer',
  },
  /** The rule between two lists that answer different questions. */
  sectionTitle: {
    fontSize: '10px', fontWeight: '500', color: '#7A9BB8',
    textTransform: 'uppercase', letterSpacing: '0.08em',
    margin: '16px 0 6px', paddingBottom: '5px',
    borderBottom: '0.5px solid rgba(255,255,255,0.10)',
  },
  infoBox: {
    background: 'rgba(0,212,126,0.06)', border: '1px solid rgba(0,212,126,0.25)',
    borderRadius: '10px', padding: '14px 16px', marginBottom: '14px',
  },
  errorBox: {
    marginBottom: '10px', padding: '9px 12px', borderRadius: '8px',
    background: 'rgba(255,91,90,0.09)', border: '1px solid rgba(255,91,90,0.3)',
    color: '#FF5B5A', fontSize: '12px',
  },
}
