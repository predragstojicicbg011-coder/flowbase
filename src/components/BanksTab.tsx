import React, { useState, useEffect, useCallback } from 'react'
import { supabase } from '../supabase'
import { useCompanies } from '../contexts/CompaniesContext'
import { settingsStyles as s } from '../pages/Settings'
import { DOCUMENT_CURRENCIES } from '../services/bookAmounts'
import { countOf } from '../utils/plural'

// ── Banks and payment methods ───────────────────────────────────────────────
// Until this tab existed the banks table was only ever read — adding one meant
// a database migration.
//
// Deleting is deliberately restricted: a bank referenced by transactions,
// invoices or pass-throughs cannot be removed, because that would orphan
// financial records. Deactivating hides it from the pickers while leaving
// history intact, and is the right move in almost every case.

interface Bank {
  id: string
  company_id: string
  name: string
  type: string | null
  currencies: string[] | null
  is_active: boolean
}

const TYPES = [
  { value: 'bank', label: 'Tekući račun' },
  { value: 'payment_method', label: 'Način plaćanja' },
]
const CURRENCIES = DOCUMENT_CURRENCIES

const emptyDraft = (companyId: string): Omit<Bank, 'id'> => ({
  company_id: companyId, name: '', type: 'bank', currencies: ['USD'], is_active: true,
})

export default function BanksTab({ canEdit }: { canEdit: boolean }) {
  const { companies, defaultCompany, showPicker } = useCompanies()
  const [banks, setBanks] = useState<Bank[]>([])
  const [usage, setUsage] = useState<Record<string, number>>({})
  const [selected, setSelected] = useState<Bank | null>(null)
  const [draft, setDraft] = useState<Omit<Bank, 'id'> | null>(null)
  const [loading, setLoading] = useState(true)
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState('')
  const [notice, setNotice] = useState('')

  const load = useCallback(async () => {
    setLoading(true); setError('')
    const { data: bs, error: err } = await supabase
      .from('banks').select('id, company_id, name, type, currencies, is_active').order('name')
    if (err) setError(err.message)
    setBanks(bs || [])
    setLoading(false)

    // How many records point at each bank — drives whether delete is offered.
    const counts: Record<string, number> = {}
    await Promise.all((bs || []).map(async (b) => {
      const [t, i, p] = await Promise.all([
        supabase.from('transactions').select('id', { count: 'exact', head: true }).eq('bank_id', b.id),
        supabase.from('invoices').select('id', { count: 'exact', head: true }).eq('bank_id', b.id),
        supabase.from('passthrough').select('id', { count: 'exact', head: true }).eq('bank_id', b.id),
      ])
      counts[b.id] = (t.count || 0) + (i.count || 0) + (p.count || 0)
    }))
    setUsage(counts)
  }, [])

  useEffect(() => { load() }, [load])

  const startNew = () => {
    setSelected(null)
    setDraft(emptyDraft(defaultCompany?.id || ''))
    setError(''); setNotice('')
  }

  const select = (b: Bank) => {
    setSelected(b)
    setDraft({ ...b, currencies: b.currencies || [] })
    setError(''); setNotice('')
  }

  const patch = (p: Partial<Omit<Bank, 'id'>>) => setDraft(d => d ? { ...d, ...p } : d)

  const toggleCurrency = (c: string) => {
    if (!draft) return
    const cur = draft.currencies || []
    patch({ currencies: cur.includes(c) ? cur.filter(x => x !== c) : [...cur, c] })
  }

  const save = async () => {
    if (!draft || !canEdit) return
    const name = draft.name.trim()
    if (!name) { setError('Unesite naziv.'); return }
    if (!draft.company_id) { setError('Izaberite firmu.'); return }

    const clash = banks.find(b =>
      b.company_id === draft.company_id &&
      b.name.trim().toLowerCase() === name.toLowerCase() &&
      b.id !== selected?.id)
    if (clash) { setError(`${name} već postoji za ovu firmu.`); return }

    setSaving(true); setError(''); setNotice('')
    const payload = {
      company_id: draft.company_id,
      name,
      type: draft.type,
      currencies: draft.currencies?.length ? draft.currencies : null,
      is_active: draft.is_active,
    }
    const { error: err } = selected
      ? await supabase.from('banks').update(payload).eq('id', selected.id)
      : await supabase.from('banks').insert(payload)

    if (err) setError(err.message)
    else { setNotice(selected ? 'Sačuvano.' : `${name} je dodata.`); setDraft(null); setSelected(null); load() }
    setSaving(false)
  }

  const remove = async () => {
    if (!selected || !canEdit) return
    const used = usage[selected.id] || 0
    if (used > 0) {
      setError(`${selected.name} se koristi u ${countOf(used, 'zapisu', 'zapisa', 'zapisa')} i ne može da se obriše. Umesto toga je deaktivirajte.`)
      return
    }
    if (!window.confirm(`Obrisati ${selected.name}? Nijedan zapis je ne koristi.`)) return
    setSaving(true); setError('')
    const { error: err } = await supabase.from('banks').delete().eq('id', selected.id)
    if (err) setError(err.message)
    else { setNotice(`${selected.name} je obrisana.`); setDraft(null); setSelected(null); load() }
    setSaving(false)
  }

  const byCompany = companies.map(c => ({
    company: c,
    items: banks.filter(b => b.company_id === c.id),
  }))
  const orphans = banks.filter(b => !companies.some(c => c.id === b.company_id))

  return (
    <>
      {!canEdit && <div style={s.readOnlyBanner}>👁 Samo pregled — banke mogu da uređuju samo administratori.</div>}

      {error && (
        <div style={{ ...s.readOnlyBanner, background: 'rgba(255,91,90,0.10)', border: '1px solid rgba(255,91,90,0.3)', color: '#FF5B5A' }}>
          {error}
        </div>
      )}
      {notice && (
        <div style={{ ...s.readOnlyBanner, background: 'rgba(0,212,126,0.10)', border: '1px solid rgba(0,212,126,0.3)', color: '#00D47E' }}>
          {notice}
        </div>
      )}

      <div style={s.twoCol}>
        <div style={s.colPanel}>
          <div style={s.colHeader}>
            <div style={s.colTitle}>Banke i načini plaćanja</div>
            <span style={s.colCount}>{banks.length}</span>
          </div>

          {loading ? <div style={s.loading}>Učitavanje…</div> : (
            <div style={s.itemList}>
              {byCompany.map(({ company, items }) => (
                <div key={company.id}>
                  <div style={{
                    padding: '7px 14px', background: '#111F30',
                    fontSize: '10px', fontWeight: 600, letterSpacing: '0.07em',
                    textTransform: 'uppercase', color: 'rgba(255,255,255,0.30)',
                  }}>
                    {company.name}
                  </div>
                  {items.length === 0 ? (
                    <div style={{ ...s.itemRow, cursor: 'default', color: 'rgba(255,255,255,0.30)', fontSize: '12px' }}>
                      još nijedna
                    </div>
                  ) : items.map(b => (
                    <div key={b.id}
                      style={{ ...s.itemRow, ...(selected?.id === b.id ? s.itemRowActive : {}) }}
                      onClick={() => select(b)}>
                      <div>
                        <div style={{ ...s.itemName, opacity: b.is_active ? 1 : 0.45 }}>
                          {b.name}{b.is_active ? '' : ' · neaktivna'}
                        </div>
                        <div style={{ fontSize: '10px', color: 'rgba(255,255,255,0.30)' }}>
                          {TYPES.find(t => t.value === b.type)?.label || b.type || '—'}
                          {b.currencies?.length ? ` · ${b.currencies.join('/')}` : ''}
                          {usage[b.id] ? ` · ${countOf(usage[b.id], 'zapis', 'zapisa', 'zapisa')}` : ' · ne koristi se'}
                        </div>
                      </div>
                    </div>
                  ))}
                </div>
              ))}
              {orphans.length > 0 && (
                <div style={{ ...s.itemRow, cursor: 'default', color: '#F5A623', fontSize: '11px' }}>
                  ⚠ {countOf(orphans.length, 'banka pripada', 'banke pripadaju', 'banaka pripada')} firmi koja više ne postoji
                </div>
              )}
            </div>
          )}

          {canEdit && (
            <div style={s.addRow}>
              <button style={s.addBtn} onClick={startNew}>+ Nova banka</button>
            </div>
          )}
        </div>

        <div style={s.colPanel}>
          <div style={s.colHeader}>
            <div style={s.colTitle}>
              {draft ? (selected ? `Izmena — ${selected.name}` : 'Nova banka') : 'Izaberite banku'}
            </div>
          </div>

          {!draft ? (
            <div style={s.emptyHint}>← Izaberite banku za izmenu ili dodajte novu</div>
          ) : (
            <div style={{ padding: '14px 16px', display: 'flex', flexDirection: 'column', gap: '14px' }}>
              <div style={s.formField}>
                <label style={s.formLabel}>Naziv</label>
                <input style={s.formInput} value={draft.name} disabled={!canEdit}
                  placeholder="npr. Banca Intesa"
                  onChange={e => patch({ name: e.target.value })} />
              </div>

              {showPicker && (
                <div style={s.formField}>
                  <label style={s.formLabel}>Firma</label>
                  <select style={s.formInput} value={draft.company_id} disabled={!canEdit}
                    onChange={e => patch({ company_id: e.target.value })}>
                    {companies.map(c => <option key={c.id} value={c.id}>{c.name}</option>)}
                  </select>
                </div>
              )}

              <div style={s.formField}>
                <label style={s.formLabel}>Tip</label>
                <select style={s.formInput} value={draft.type || 'bank'} disabled={!canEdit}
                  onChange={e => patch({ type: e.target.value })}>
                  {TYPES.map(t => <option key={t.value} value={t.value}>{t.label}</option>)}
                </select>
              </div>

              <div style={s.formField}>
                <label style={s.formLabel}>Valute</label>
                <div style={{ display: 'flex', gap: '6px', flexWrap: 'wrap' }}>
                  {CURRENCIES.map(c => {
                    const on = (draft.currencies || []).includes(c)
                    return (
                      <button key={c} disabled={!canEdit} onClick={() => toggleCurrency(c)}
                        style={{
                          fontSize: '12px', padding: '6px 14px', borderRadius: '7px',
                          border: `1px solid ${on ? 'rgba(0,212,126,0.45)' : 'rgba(255,255,255,0.12)'}`,
                          background: on ? 'rgba(0,212,126,0.12)' : '#111F30',
                          color: on ? '#00D47E' : '#7A9BB8',
                          cursor: canEdit ? 'pointer' : 'default',
                          fontFamily: "'Inter', system-ui, sans-serif",
                        }}>
                        {c}
                      </button>
                    )
                  })}
                </div>
              </div>

              <div style={s.formField}>
                <label style={s.formLabel}>Status</label>
                <button disabled={!canEdit} onClick={() => patch({ is_active: !draft.is_active })}
                  style={{
                    alignSelf: 'flex-start',
                    fontSize: '12px', padding: '7px 16px', borderRadius: '7px',
                    border: `1px solid ${draft.is_active ? 'rgba(0,212,126,0.45)' : 'rgba(255,91,90,0.45)'}`,
                    background: draft.is_active ? 'rgba(0,212,126,0.10)' : 'rgba(255,91,90,0.10)',
                    color: draft.is_active ? '#00D47E' : '#FF5B5A',
                    cursor: canEdit ? 'pointer' : 'default',
                    fontFamily: "'Inter', system-ui, sans-serif",
                  }}>
                  {draft.is_active ? 'Aktivna' : 'Neaktivna'}
                </button>
                <div style={{ fontSize: '11px', color: '#7A9BB8', marginTop: '5px', lineHeight: 1.5 }}>
                  Neaktivna banka ostaje na svim postojećim zapisima, ali se ne nudi u izboru.
                </div>
              </div>

              {canEdit && (
                <div style={{ display: 'flex', gap: '8px', alignItems: 'center', paddingTop: '4px' }}>
                  <button style={{ ...s.addBtn, opacity: saving ? 0.5 : 1 }} disabled={saving} onClick={save}>
                    {saving ? 'Čuvanje…' : selected ? 'Sačuvaj izmene' : 'Dodaj banku'}
                  </button>
                  <button style={{ ...s.addBtn, background: 'transparent', color: '#7A9BB8', border: '1px solid rgba(255,255,255,0.14)' }}
                    onClick={() => { setDraft(null); setSelected(null); setError(''); setNotice('') }}>
                    Otkaži
                  </button>
                  {selected && (
                    <button style={{ ...s.deleteBtn, marginLeft: 'auto', padding: '7px 14px', fontSize: '12px' }}
                      disabled={saving} onClick={remove}
                      title={usage[selected.id] ? 'Koriste je postojeći zapisi — deaktivirajte je' : 'Nigde se ne koristi'}>
                      Obriši
                    </button>
                  )}
                </div>
              )}
            </div>
          )}
        </div>
      </div>
    </>
  )
}
