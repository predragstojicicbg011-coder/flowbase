// ─── ProjectDialog ──────────────────────────────────────────────────────────
//
// Add or edit one project. The rules — required fields, duplicates, how a
// contract value is booked — are in services/projects.ts; this is the form.
//
// The contract value is converted to RSD and EUR at the NBS rate on the
// contract date (today when none is given) only when the value, its currency
// or its date changed. Re-saving a project to fix its note must not quietly
// re-book its contract at today's rate.

import React, { useEffect, useMemo, useState } from 'react'
import { supabase } from '../supabase'
import { DIALOG, chrome } from './dialogTheme'
import SearchableSelect from './SearchableSelect'
import { fetchAllPartners } from '../services/allPartners'
import { runWrite } from '../services/writeOrder'
import {
  CONTRACT_CURRENCIES, PROJECT_KINDS, PROJECT_KIND_LABEL,
  contractBookFigures, draftFromProject, emptyDraft, parseContractValue, projectRow, validateProject,
  type ContractBook, type ContractCurrency, type Project, type ProjectDraft, type ProjectKind,
} from '../services/projects'

interface Props {
  project: Project | null
  companyId: string
  /** The company's projects, for the duplicate checks. */
  existing: readonly Project[]
  onClose: () => void
  onSaved: () => void
}

const today = () => new Date().toISOString().slice(0, 10)

/** Whether the stored book figures still describe the draft's contract. */
export function bookStillValid(p: Project | null, d: ProjectDraft): boolean {
  if (!p || p.contract_value === null || p.contract_value_rsd === null || p.contract_value_eur === null) return false
  const v = parseContractValue(d.contract_value)
  return v === p.contract_value
    && d.contract_currency === p.contract_currency
    && (d.contract_date || p.contract_date || '') === (p.contract_date || '')
}

export default function ProjectDialog({ project, companyId, existing, onClose, onSaved }: Props) {
  const [draft, setDraft] = useState<ProjectDraft>(() => (project ? draftFromProject(project) : emptyDraft()))
  const [partners, setPartners] = useState<{ id: string; name: string }[]>([])
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState('')

  useEffect(() => {
    fetchAllPartners<{ id: string; name: string }>(supabase, 'id, name')
      .then(setPartners)
      .catch((e: any) => setError(`Partneri nisu učitani: ${e?.message || e}`))
  }, [])

  const partnerOptions = useMemo(() => partners.map(p => ({ value: p.id, label: p.name })), [partners])
  const set = <K extends keyof ProjectDraft>(k: K, v: ProjectDraft[K]) => setDraft(d => ({ ...d, [k]: v }))

  const save = async () => {
    const why = validateProject(draft, existing)
    if (why) { setError(why); return }
    setSaving(true)
    setError('')
    try {
      const value = parseContractValue(draft.contract_value)
      let book: ContractBook | null = null
      if (value !== null) {
        book = bookStillValid(project, draft)
          ? { contract_date: project!.contract_date || today(), contract_value_rsd: project!.contract_value_rsd!, contract_value_eur: project!.contract_value_eur! }
          : await contractBookFigures(value, draft.contract_currency, draft.contract_date || today())
      }
      const row = projectRow(draft, companyId, book)
      const res = project
        ? await runWrite('Čuvanje projekta', supabase.from('projects').update(row).eq('id', project.id))
        : await runWrite('Dodavanje projekta', supabase.from('projects').insert(row))
      if (!res.ok) { setError(res.message); return }
      onSaved()
    } catch (e: any) {
      setError(e?.message || String(e))
    } finally {
      setSaving(false)
    }
  }

  const remove = async () => {
    if (!project) return
    if (!window.confirm(`Obrisati projekat „${project.name}"? Projekat sa knjiženjima ne može da se obriše — zatvorite ga umesto toga.`)) return
    setSaving(true)
    const res = await runWrite('Brisanje projekta', supabase.from('projects').delete().eq('id', project.id))
    setSaving(false)
    if (!res.ok) { setError(res.message); return }
    onSaved()
  }

  const rental = draft.kind === 'rental'

  return (
    <div style={chrome.overlay} onMouseDown={e => { if (e.target === e.currentTarget) onClose() }}>
      <div style={s.panel} role="dialog" aria-label={project ? 'Izmena projekta' : 'Novi projekat'}>
        <div style={chrome.header}>
          <div>
            <div style={chrome.headerTitle}>{project ? 'Izmena projekta' : 'Novi projekat'}</div>
            <div style={chrome.headerSub}>Gradilište ili objekat u zakupu</div>
          </div>
          <button style={chrome.closeBtn} onClick={onClose} aria-label="Zatvori">×</button>
        </div>

        <div style={s.body}>
          <div style={s.row}>
            <label style={{ ...s.field, flex: 2 }}>
              <span style={s.lbl}>Naziv <span style={s.req}>*</span></span>
              <input style={s.input} value={draft.name} autoFocus
                onChange={e => set('name', e.target.value)} placeholder="npr. Stambeni objekat Novi Beograd" />
            </label>
            <label style={{ ...s.field, flex: 1 }}>
              <span style={s.lbl}>Šifra</span>
              <input style={s.input} value={draft.code} onChange={e => set('code', e.target.value)} placeholder="npr. NB-01" />
            </label>
          </div>

          <div style={s.field}>
            <span style={s.lbl}>Vrsta <span style={s.req}>*</span></span>
            <div style={s.segment}>
              {PROJECT_KINDS.map(k => (
                <button key={k} type="button"
                  style={{ ...s.segBtn, ...(draft.kind === k ? s.segBtnOn : {}) }}
                  onClick={() => set('kind', k as ProjectKind)}>
                  {PROJECT_KIND_LABEL[k]}
                </button>
              ))}
            </div>
          </div>

          <div style={s.field}>
            <span style={s.lbl}>Investitor {rental ? <span style={s.opt}>(nije obavezno)</span> : <span style={s.req}>*</span>}</span>
            <SearchableSelect value={draft.investor_partner_id}
              onChange={v => set('investor_partner_id', v)}
              options={partnerOptions} allLabel="— bez investitora —"
              searchPlaceholder="Pretraži partnere…" emptyMessage="Nema takvog partnera"
              style={{ width: '100%' }} />
          </div>

          <div style={s.row}>
            <label style={{ ...s.field, flex: 2 }}>
              <span style={s.lbl}>Vrednost ugovora {rental && <span style={s.opt}>(nije obavezno)</span>}</span>
              <input style={s.input} inputMode="decimal" value={draft.contract_value}
                onChange={e => set('contract_value', e.target.value)} placeholder="0,00" />
            </label>
            <label style={{ ...s.field, flex: 1 }}>
              <span style={s.lbl}>Valuta</span>
              <select style={s.input} value={draft.contract_currency}
                onChange={e => set('contract_currency', e.target.value as ContractCurrency)}>
                {CONTRACT_CURRENCIES.map(c => <option key={c} value={c}>{c}</option>)}
              </select>
            </label>
            <label style={{ ...s.field, flex: 1.3 }}>
              <span style={s.lbl}>Datum ugovora</span>
              <input style={s.input} type="date" value={draft.contract_date}
                onChange={e => set('contract_date', e.target.value)} />
            </label>
          </div>
          <div style={s.hint}>
            Vrednost se preračunava u RSD i EUR po srednjem kursu NBS na datum ugovora, a bez datuma na današnji dan.
          </div>

          <label style={s.field}>
            <span style={s.lbl}>Napomena</span>
            <textarea style={{ ...s.input, minHeight: '64px', resize: 'vertical' }} value={draft.note}
              onChange={e => set('note', e.target.value)} />
          </label>

          <label style={s.check}>
            <input type="checkbox" checked={draft.active} onChange={e => set('active', e.target.checked)} />
            <span>Aktivan — nudi se pri knjiženju</span>
          </label>

          {error && <div style={s.error} role="alert">{error}</div>}
        </div>

        <div style={s.footer}>
          {project
            ? <button style={s.deleteBtn} onClick={remove} disabled={saving}>Obriši</button>
            : <span />}
          <div style={{ display: 'flex', gap: '8px' }}>
            <button style={s.cancelBtn} onClick={onClose} disabled={saving}>Otkaži</button>
            <button style={s.saveBtn} onClick={save} disabled={saving}>{saving ? 'Čuvanje…' : 'Sačuvaj'}</button>
          </div>
        </div>
      </div>
    </div>
  )
}

const s: Record<string, React.CSSProperties> = {
  panel: {
    background: DIALOG.panel, borderRadius: '14px', width: '620px', maxWidth: '94vw', maxHeight: '90vh',
    display: 'flex', flexDirection: 'column', border: `1px solid ${DIALOG.border}`, overflow: 'hidden',
    boxShadow: DIALOG.shadow, fontFamily: "'Inter', system-ui, sans-serif",
  },
  body: { padding: '1.25rem 1.5rem', overflowY: 'auto', display: 'flex', flexDirection: 'column', gap: '14px' },
  row: { display: 'flex', gap: '12px', flexWrap: 'wrap' },
  field: { display: 'flex', flexDirection: 'column', gap: '6px', minWidth: '140px' },
  lbl: { fontSize: '11px', fontWeight: '500', color: DIALOG.dim, textTransform: 'uppercase', letterSpacing: '0.06em' },
  req: { color: DIALOG.red },
  opt: { color: DIALOG.faint, textTransform: 'none', letterSpacing: 0 },
  input: {
    fontFamily: 'system-ui,sans-serif', fontSize: '13px', border: `1px solid ${DIALOG.border}`,
    borderRadius: '8px', padding: '8px 12px', outline: 'none', background: DIALOG.raised, color: DIALOG.text,
    width: '100%', boxSizing: 'border-box',
  },
  segment: { display: 'flex', gap: '6px' },
  segBtn: {
    flex: 1, padding: '8px 12px', borderRadius: '8px', border: `1px solid ${DIALOG.border}`,
    background: DIALOG.raised, color: DIALOG.dim, fontSize: '13px', cursor: 'pointer',
  },
  segBtnOn: { background: DIALOG.accentFill, color: DIALOG.accent, borderColor: DIALOG.accentSoft },
  hint: { fontSize: '11.5px', color: DIALOG.faint, marginTop: '-6px' },
  check: { display: 'flex', alignItems: 'center', gap: '8px', fontSize: '13px', color: DIALOG.text, cursor: 'pointer' },
  error: {
    fontSize: '12.5px', color: DIALOG.red, background: DIALOG.redFill, border: `1px solid ${DIALOG.redSoft}`,
    borderRadius: '8px', padding: '8px 12px',
  },
  footer: {
    background: DIALOG.panelDeep, padding: '0.9rem 1.5rem', display: 'flex',
    alignItems: 'center', justifyContent: 'space-between', borderTop: `1px solid ${DIALOG.borderSoft}`,
  },
  cancelBtn: {
    background: 'transparent', border: `1px solid ${DIALOG.border}`, color: DIALOG.dim,
    borderRadius: '8px', padding: '8px 16px', fontSize: '13px', cursor: 'pointer',
  },
  saveBtn: {
    background: DIALOG.accent, color: DIALOG.onAccent, border: 'none', borderRadius: '8px',
    padding: '8px 18px', fontSize: '13px', fontWeight: '500', cursor: 'pointer',
  },
  deleteBtn: {
    background: 'transparent', border: `1px solid ${DIALOG.redSoft}`, color: DIALOG.red,
    borderRadius: '8px', padding: '8px 14px', fontSize: '13px', cursor: 'pointer',
  },
}
