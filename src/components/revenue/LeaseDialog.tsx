// Add, edit or end one lease in a rental building. The rules are
// revenuePage.validateLease (the table's CHECKs, in Serbian); the tenant is
// picked from the partner book the way ProjectDialog picks the investor.

import React, { useMemo, useState } from 'react'
import { supabase } from '../../supabase'
import { DIALOG, chrome } from '../dialogTheme'
import SearchableSelect from '../SearchableSelect'
import { ds } from './styles'
import { projectLabel, type Project } from '../../services/projects'
import type { RentalLease } from '../../services/revenuePlan'
import {
  emptyLeaseDraft, leaseDraftFromLease, leaseRow, validateLease, validateLeaseEnd, type LeaseDraft,
} from '../../services/revenuePage'

export default function LeaseDialog({
  lease, projectId, rentalProjects, partners, companyId, today, onClose, onSaved,
}: {
  lease: RentalLease | null
  /** The building a new lease is for. */
  projectId: string
  rentalProjects: readonly Project[]
  partners: readonly { id: string; name: string }[]
  companyId: string
  today: string
  onClose: () => void
  onSaved: () => void
}) {
  const [draft, setDraft] = useState<LeaseDraft>(() => (lease ? leaseDraftFromLease(lease) : emptyLeaseDraft(projectId, today)))
  const [endDate, setEndDate] = useState(today)
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState('')

  const partnerOptions = useMemo(() => partners.map(p => ({ value: p.id, label: p.name })), [partners])
  const set = <K extends keyof LeaseDraft>(k: K, v: LeaseDraft[K]) => setDraft(d => ({ ...d, [k]: v }))

  const write = async (label: string, row: Record<string, unknown>, id?: string) => {
    setSaving(true)
    setError('')
    try {
      const q = id
        ? supabase.from('rental_leases').update(row).eq('id', id).select('id')
        : supabase.from('rental_leases').insert(row).select('id')
      const { data, error: e } = await q
      if (e) { setError(`${label} nije uspelo: ${e.message}`); return }
      if (!data || data.length === 0) { setError(`${label} nije uspelo: nijedan red nije sačuvan (proverite prava pristupa).`); return }
      onSaved()
    } catch (e: any) {
      setError(e?.message || String(e))
    } finally {
      setSaving(false)
    }
  }

  const save = async () => {
    const why = validateLease(draft)
    if (why) { setError(why); return }
    await write(lease ? 'Čuvanje zakupa' : 'Dodavanje zakupa', leaseRow(draft, companyId, new Date().toISOString()), lease?.id)
  }

  const endLease = async () => {
    if (!lease) return
    const why = validateLeaseEnd(lease, endDate)
    if (why) { setError(why); return }
    await write('Završetak zakupa', { end_date: endDate, updated_at: new Date().toISOString() }, lease.id)
  }

  return (
    <div style={chrome.overlay} onMouseDown={e => { if (e.target === e.currentTarget) onClose() }}>
      <div style={ds.panel} role="dialog" aria-label={lease ? 'Izmena zakupa' : 'Novi zakup'}>
        <div style={chrome.header}>
          <div>
            <div style={chrome.headerTitle}>{lease ? 'Izmena zakupa' : 'Novi zakup'}</div>
            <div style={chrome.headerSub}>Zakupac u objektu u zakupu</div>
          </div>
          <button style={chrome.closeBtn} onClick={onClose} aria-label="Zatvori">×</button>
        </div>

        <div style={ds.body}>
          <label style={ds.field}>
            <span style={ds.lbl}>Objekat <span style={ds.req}>*</span></span>
            <select style={ds.input} value={draft.project_id} onChange={e => set('project_id', e.target.value)}>
              {rentalProjects.map(p => <option key={p.id} value={p.id}>{projectLabel(p)}</option>)}
            </select>
          </label>

          <div style={ds.field}>
            <span style={ds.lbl}>Zakupac <span style={ds.req}>*</span></span>
            <SearchableSelect value={draft.tenant_partner_id}
              onChange={v => set('tenant_partner_id', v)}
              options={partnerOptions} allLabel="— izaberite zakupca —"
              searchPlaceholder="Pretraži partnere…" emptyMessage="Nema takvog partnera"
              style={{ width: '100%' }} title="Zakupac" />
          </div>

          <div style={ds.row}>
            <label style={{ ...ds.field, flex: 2 }}>
              <span style={ds.lbl}>Mesečna zakupnina <span style={ds.req}>*</span></span>
              <input style={ds.input} inputMode="decimal" value={draft.monthly_rent} placeholder="0,00"
                onChange={e => set('monthly_rent', e.target.value)} aria-label="Mesečna zakupnina" />
            </label>
            <label style={{ ...ds.field, flex: 1 }}>
              <span style={ds.lbl}>Valuta</span>
              <select style={ds.input} value={draft.currency} onChange={e => set('currency', e.target.value as 'RSD' | 'EUR')}>
                <option value="RSD">RSD</option>
                <option value="EUR">EUR</option>
              </select>
            </label>
          </div>

          <div style={ds.row}>
            <label style={{ ...ds.field, flex: 1 }}>
              <span style={ds.lbl}>Od <span style={ds.req}>*</span></span>
              <input style={ds.input} type="date" value={draft.start_date} onChange={e => set('start_date', e.target.value)} />
            </label>
            <label style={{ ...ds.field, flex: 1 }}>
              <span style={ds.lbl}>Do</span>
              <input style={ds.input} type="date" value={draft.end_date} onChange={e => set('end_date', e.target.value)} />
            </label>
          </div>
          <div style={ds.hint}>Bez datuma završetka zakup traje neograničeno. Mesec koji zakup pokriva delimično računa se srazmerno danima.</div>

          <div style={ds.row}>
            <label style={{ ...ds.field, flex: 1 }}>
              <span style={ds.lbl}>Dan fakturisanja (1–28)</span>
              <input style={ds.input} inputMode="numeric" value={draft.invoice_day}
                onChange={e => set('invoice_day', e.target.value.replace(/[^\d]/g, ''))} />
            </label>
            <label style={{ ...ds.field, flex: 1 }}>
              <span style={ds.lbl}>Rok plaćanja (dana)</span>
              <input style={ds.input} inputMode="numeric" value={draft.payment_days}
                onChange={e => set('payment_days', e.target.value.replace(/[^\d]/g, ''))} />
            </label>
          </div>

          <label style={ds.field}>
            <span style={ds.lbl}>Napomena</span>
            <textarea style={{ ...ds.input, minHeight: '56px', resize: 'vertical' }} value={draft.note}
              onChange={e => set('note', e.target.value)} />
          </label>

          <label style={ds.check}>
            <input type="checkbox" checked={draft.active} onChange={e => set('active', e.target.checked)} />
            <span>Aktivan — predlaže fakture i ulazi u prognozu</span>
          </label>

          {lease && (
            <div style={ds.endBox}>
              <label style={{ ...ds.field, flex: 1 }}>
                <span style={ds.lbl}>Završi zakup na dan</span>
                <input style={ds.input} type="date" value={endDate} onChange={e => setEndDate(e.target.value)} />
              </label>
              <button style={ds.dangerBtn} onClick={endLease} disabled={saving}>Završi zakup</button>
              <div style={{ ...ds.hint, flexBasis: '100%', color: DIALOG.faint }}>
                Zakupnina se računa do tog dana; posle njega nema predloga ni prognoze.
              </div>
            </div>
          )}

          {error && <div style={ds.error} role="alert">{error}</div>}
        </div>

        <div style={ds.footer}>
          <span />
          <div style={{ display: 'flex', gap: '8px' }}>
            <button style={ds.cancelBtn} onClick={onClose} disabled={saving}>Otkaži</button>
            <button style={ds.saveBtn} onClick={save} disabled={saving}>{saving ? 'Čuvanje…' : 'Sačuvaj'}</button>
          </div>
        </div>
      </div>
    </div>
  )
}
