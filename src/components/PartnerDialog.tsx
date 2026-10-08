import React, { useState, useEffect } from 'react'
import { supabase } from '../supabase'
import { DIALOG } from './dialogTheme'
import { DOCUMENT_CURRENCIES } from '../services/bookAmounts'

interface Props {
  partner?: any
  initialName?: string
  initialAccountNumber?: string
  onClose: () => void
  onSaved: (partner: any) => void
  onDelete?: (id: string, name: string) => void
}

// NBS Merge Dialog — shown when NBS lookup returns data for existing partner
interface NbsMergeProps {
  existingPartner: any
  existingAccounts: any[]
  nbsResult: any
  onConfirm: (fieldsToUpdate: Record<string, boolean>, accountsToAdd: string[]) => void
  onCancel: () => void
}

function NbsMergeDialog({ existingPartner, existingAccounts, nbsResult, onConfirm, onCancel }: NbsMergeProps) {
  const fields: { key: string; label: string; existing: string; nbs: string }[] = [
    { key: 'name', label: 'Naziv', existing: existingPartner.name || '—', nbs: nbsResult.name || '—' },
    { key: 'tax_id', label: 'PIB', existing: existingPartner.tax_id || '—', nbs: nbsResult.pib || '—' },
    { key: 'registration_number', label: 'Matični broj', existing: existingPartner.registration_number || '—', nbs: nbsResult.mb || '—' },
    { key: 'address', label: 'Adresa', existing: existingPartner.address || '—', nbs: nbsResult.address || '—' },
    { key: 'city', label: 'Grad', existing: existingPartner.city || '—', nbs: nbsResult.city || '—' },
  ].filter(f => f.nbs !== '—' && f.nbs !== f.existing)

  const newAccounts = (nbsResult.accounts || []).filter((a: any) =>
    !existingAccounts.some(ea => ea.account_number === a.account)
  )

  const [selectedFields, setSelectedFields] = useState<Record<string, boolean>>(
    Object.fromEntries(fields.map(f => [f.key, true]))
  )
  const [selectedAccounts, setSelectedAccounts] = useState<Record<string, boolean>>(
    Object.fromEntries(newAccounts.map((a: any) => [a.account, true]))
  )

  const toggleField = (key: string) => setSelectedFields(p => ({ ...p, [key]: !p[key] }))
  const toggleAccount = (acc: string) => setSelectedAccounts(p => ({ ...p, [acc]: !p[acc] }))

  const handleConfirm = () => {
    const accountsToAdd = newAccounts.filter((a: any) => selectedAccounts[a.account]).map((a: any) => a.account)
    onConfirm(selectedFields, accountsToAdd)
  }

  const hasChanges = fields.length > 0 || newAccounts.length > 0

  return (
    <div style={{ position: 'fixed', inset: 0, background: DIALOG.overlay, backdropFilter: 'blur(4px)', display: 'flex', alignItems: 'center', justifyContent: 'center', zIndex: 1200 }}>
      <div style={{ background: '#0D1B2C', borderRadius: '14px', width: '600px', maxWidth: '94vw', maxHeight: '80vh', display: 'flex', flexDirection: 'column', border: '1px solid rgba(255,255,255,0.12)', overflow: 'hidden' }}>
        <div style={{ background: '#060E1A', padding: '1rem 1.5rem', display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}>
          <div>
            <div style={{ color: '#DCE9F6', fontSize: '15px', fontWeight: '500' }}>🔄 NBS podaci — pregled izmena</div>
            <div style={{ color: 'rgba(255,255,255,0.4)', fontSize: '12px', marginTop: '2px' }}>Izaberite šta ažurirate</div>
          </div>
          <button style={{ background: 'none', border: 'none', color: 'rgba(255,255,255,0.4)', fontSize: '22px', cursor: 'pointer' }} onClick={onCancel}>×</button>
        </div>

        <div style={{ padding: '1.25rem 1.5rem', overflowY: 'auto', flex: 1 }}>
          {!hasChanges ? (
            <div style={{ padding: '20px', textAlign: 'center', color: '#5DCAA5', fontSize: '13px', background: 'rgba(0,212,126,0.07)', borderRadius: '8px' }}>
              ✓ Podaci iz NBS se slažu sa postojećim — nema šta da se ažurira
            </div>
          ) : (
            <>
              {fields.length > 0 && (
                <div style={{ marginBottom: '20px' }}>
                  <div style={{ fontSize: '11px', fontWeight: '500', color: 'rgba(255,255,255,0.3)', textTransform: 'uppercase', letterSpacing: '0.08em', marginBottom: '10px', paddingBottom: '6px', borderBottom: '1px solid rgba(255,255,255,0.075)' }}>
                    Podaci i adresa
                  </div>
                  <div style={{ display: 'flex', flexDirection: 'column', gap: '6px' }}>
                    {fields.map(f => (
                      <div key={f.key} style={{ display: 'flex', alignItems: 'center', gap: '12px', padding: '10px 12px', borderRadius: '8px', background: selectedFields[f.key] ? 'rgba(0,212,126,0.07)' : 'rgba(255,255,255,0.03)', border: `1px solid ${selectedFields[f.key] ? 'rgba(0,212,126,0.25)' : 'rgba(255,255,255,0.07)'}`, cursor: 'pointer' }}
                        onClick={() => toggleField(f.key)}>
                        <div style={{ width: '18px', height: '18px', borderRadius: '4px', border: `2px solid ${selectedFields[f.key] ? '#00D47E' : 'rgba(255,255,255,0.2)'}`, background: selectedFields[f.key] ? '#00D47E' : 'transparent', display: 'flex', alignItems: 'center', justifyContent: 'center', flexShrink: 0 }}>
                          {selectedFields[f.key] && <svg width="10" height="10" viewBox="0 0 10 10" fill="none"><path d="M2 5l2.5 2.5L8 3" stroke="#060E1A" strokeWidth="1.5" strokeLinecap="round"/></svg>}
                        </div>
                        <div style={{ fontSize: '11px', color: 'rgba(255,255,255,0.3)', width: '110px', flexShrink: 0 }}>{f.label}</div>
                        <div style={{ flex: 1, display: 'grid', gridTemplateColumns: '1fr auto 1fr', gap: '8px', alignItems: 'center' }}>
                          <div style={{ fontSize: '12px', color: '#7A9BB8', textDecoration: 'line-through', opacity: 0.7 }}>{f.existing}</div>
                          <div style={{ fontSize: '14px', color: 'rgba(255,255,255,0.3)' }}>→</div>
                          <div style={{ fontSize: '12px', color: '#00D47E', fontWeight: '500' }}>{f.nbs}</div>
                        </div>
                      </div>
                    ))}
                  </div>
                  {fields.length > 1 && (
                    <button style={{ marginTop: '8px', background: 'none', border: 'none', color: '#7A9BB8', fontSize: '11px', cursor: 'pointer', padding: '4px 0' }}
                      onClick={() => setSelectedFields(Object.fromEntries(fields.map(f => [f.key, !Object.values(selectedFields).every(Boolean)])))}>
                      {Object.values(selectedFields).every(Boolean) ? 'Poništi izbor' : 'Izaberi sve'}
                    </button>
                  )}
                </div>
              )}

              {newAccounts.length > 0 && (
                <div>
                  <div style={{ fontSize: '11px', fontWeight: '500', color: 'rgba(255,255,255,0.3)', textTransform: 'uppercase', letterSpacing: '0.08em', marginBottom: '10px', paddingBottom: '6px', borderBottom: '1px solid rgba(255,255,255,0.075)' }}>
                    Novi računi iz NBS ({newAccounts.length})
                  </div>
                  <div style={{ display: 'flex', flexDirection: 'column', gap: '6px' }}>
                    {newAccounts.map((acc: any) => (
                      <div key={acc.account} style={{ display: 'flex', alignItems: 'center', gap: '12px', padding: '10px 12px', borderRadius: '8px', background: selectedAccounts[acc.account] ? 'rgba(0,212,126,0.07)' : 'rgba(255,255,255,0.03)', border: `1px solid ${selectedAccounts[acc.account] ? 'rgba(0,212,126,0.25)' : 'rgba(255,255,255,0.07)'}`, cursor: 'pointer' }}
                        onClick={() => toggleAccount(acc.account)}>
                        <div style={{ width: '18px', height: '18px', borderRadius: '4px', border: `2px solid ${selectedAccounts[acc.account] ? '#00D47E' : 'rgba(255,255,255,0.2)'}`, background: selectedAccounts[acc.account] ? '#00D47E' : 'transparent', display: 'flex', alignItems: 'center', justifyContent: 'center', flexShrink: 0 }}>
                          {selectedAccounts[acc.account] && <svg width="10" height="10" viewBox="0 0 10 10" fill="none"><path d="M2 5l2.5 2.5L8 3" stroke="#060E1A" strokeWidth="1.5" strokeLinecap="round"/></svg>}
                        </div>
                        <div style={{ flex: 1 }}>
                          <div style={{ fontSize: '13px', fontWeight: '500', color: '#DCE9F6', fontFamily: 'monospace' }}>{acc.account}</div>
                          {acc.bankName && <div style={{ fontSize: '11px', color: '#7A9BB8', marginTop: '2px' }}>{acc.bankName}</div>}
                        </div>
                        <div style={{ fontSize: '10px', padding: '2px 8px', borderRadius: '20px', background: 'rgba(0,212,126,0.12)', color: '#00D47E' }}>Novi</div>
                      </div>
                    ))}
                  </div>
                  {existingAccounts.length > 0 && (
                    <div style={{ marginTop: '8px', fontSize: '11px', color: 'rgba(255,255,255,0.3)' }}>
                      Već uneti računi se ne prikazuju: {existingAccounts.length}
                    </div>
                  )}
                </div>
              )}
            </>
          )}
        </div>

        <div style={{ padding: '1rem 1.5rem', borderTop: '1px solid rgba(255,255,255,0.075)', display: 'flex', gap: '8px', justifyContent: 'flex-end', background: '#111F30' }}>
          <button style={ds.btnGhost} onClick={onCancel}>Otkaži</button>
          {hasChanges && (
            <button style={ds.btnPrimary} onClick={handleConfirm}>
              ✓ Primeni odabrane izmene
            </button>
          )}
          {!hasChanges && (
            <button style={ds.btnPrimary} onClick={onCancel}>Zatvori</button>
          )}
        </div>
      </div>
    </div>
  )
}

export default function PartnerDialog({ partner, initialName = '', initialAccountNumber = '', onClose, onSaved, onDelete }: Props) {
  const [saving, setSaving] = useState(false)
  const [success, setSuccess] = useState(false)
  const [activeTab, setActiveTab] = useState<'info' | 'accounts'>('info')
  const [saveError, setSaveError] = useState('')

  const [name, setName] = useState(partner?.name || initialName)
  const [type, setType] = useState(partner?.type || 'vendor')
  const [taxId, setTaxId] = useState(partner?.tax_id || '')
  const [registrationNumber, setRegistrationNumber] = useState(partner?.registration_number || '')
  const [address, setAddress] = useState(partner?.address || '')
  const [city, setCity] = useState(partner?.city || '')
  const [country, setCountry] = useState(partner?.country || '')
  const [contactName, setContactName] = useState(partner?.contact_name || '')
  const [contactEmail, setContactEmail] = useState(partner?.contact_email || '')
  const [contactPhone, setContactPhone] = useState(partner?.contact_phone || '')
  const [note, setNote] = useState(partner?.note || '')
  const [isActive, setIsActive] = useState(partner?.is_active !== false)
  const [isIndividual, setIsIndividual] = useState(partner?.is_individual === true)

  // NBS lookup
  const [nbsPib, setNbsPib] = useState('')
  const [nbsLoading, setNbsLoading] = useState(false)
  const [nbsResult, setNbsResult] = useState<any>(null)
  const [nbsError, setNbsError] = useState('')
  const [showNbsMerge, setShowNbsMerge] = useState(false)

  // Duplicate detection
  const [duplicateWarning, setDuplicateWarning] = useState<{ partner: any; field: string } | null>(null)

  // Bank accounts
  const [accounts, setAccounts] = useState<any[]>([])
  const [loadingAccounts, setLoadingAccounts] = useState(false)
  const [newAccNum, setNewAccNum] = useState(initialAccountNumber)
  const [newBankName, setNewBankName] = useState('')
  const [newCurrency, setNewCurrency] = useState('RSD')
  const [newModel, setNewModel] = useState('')
  const [addingAccount, setAddingAccount] = useState(false)

  const [savedPartnerId, setSavedPartnerId] = useState(partner?.id || '')

  const fetchAccounts = async (pid?: string) => {
    const id = pid || savedPartnerId || partner?.id
    if (!id) return
    setLoadingAccounts(true)
    const { data } = await supabase.from('partner_accounts').select('*').eq('partner_id', id).order('is_primary', { ascending: false })
    if (data) setAccounts(data)
    setLoadingAccounts(false)
  }

  useEffect(() => {
    if (partner?.id || savedPartnerId) fetchAccounts()
  }, [partner?.id, savedPartnerId]) // eslint-disable-line

  // Check for duplicates by PIB or MB
  const checkDuplicate = async (pib: string, mb: string): Promise<{ partner: any; field: string } | null> => {
    const checks = []
    if (pib?.trim()) checks.push(supabase.from('partners').select('id,name,tax_id,registration_number').eq('tax_id', pib.trim()).neq('id', partner?.id || '00000000-0000-0000-0000-000000000000').limit(1))
    if (mb?.trim()) checks.push(supabase.from('partners').select('id,name,tax_id,registration_number').eq('registration_number', mb.trim()).neq('id', partner?.id || '00000000-0000-0000-0000-000000000000').limit(1))

    for (let i = 0; i < checks.length; i++) {
      const { data } = await checks[i]
      if (data && data.length > 0) {
        return { partner: data[0], field: i === 0 ? 'PIB' : 'matični broj' }
      }
    }
    return null
  }

  const lookupNBS = async () => {
    const mb = nbsPib.trim().replace(/\D/g, '')
    if (!mb || mb.length < 8) return
    setNbsLoading(true); setNbsError(''); setNbsResult(null)
    try {
      const { data, error } = await supabase.functions.invoke('lookup-pib', { body: { mb } })
      if (error) {
        setNbsError(`Greška NBS: ${error.message}`)
      } else if (data?.success && data?.name) {
        setNbsResult(data)
        // If editing existing partner — show merge dialog instead of auto-applying
        if (partner?.id || savedPartnerId) {
          setShowNbsMerge(true)
        } else {
          // New partner — auto-apply all fields
          if (data.name) setName(data.name)
          if (data.pib) setTaxId(data.pib)
          if (data.mb) setRegistrationNumber(data.mb)
          if (data.address) setAddress(data.address)
          if (data.city) setCity(data.city)
          if (!country) setCountry('Srbija')
        }
      } else {
        setNbsError(data?.error || 'U registru NBS nema firme sa tim brojem.')
      }
    } catch (e: any) { setNbsError(`Greška: ${e.message}`) }
    setNbsLoading(false)
  }

  const handleNbsMergeConfirm = async (fieldsToUpdate: Record<string, boolean>, accountsToAdd: string[]) => {
    setShowNbsMerge(false)
    const pid = savedPartnerId || partner?.id

    // Apply selected field updates to form state
    const fieldMap: Record<string, () => void> = {
      name: () => setName(nbsResult.name || ''),
      tax_id: () => setTaxId(nbsResult.pib || ''),
      registration_number: () => setRegistrationNumber(nbsResult.mb || ''),
      address: () => setAddress(nbsResult.address || ''),
      city: () => setCity(nbsResult.city || ''),
    }
    Object.entries(fieldsToUpdate).forEach(([key, selected]) => {
      if (selected && fieldMap[key]) fieldMap[key]()
    })

    // Add selected new accounts immediately if we have a partner ID
    if (pid && accountsToAdd.length > 0) {
      for (const accNum of accountsToAdd) {
        const nbsAcc = nbsResult.accounts?.find((a: any) => a.account === accNum)
        const isPrimary = accounts.length === 0
        await supabase.from('partner_accounts').insert({
          partner_id: pid, account_number: accNum,
          bank_name: nbsAcc?.bankName || null, currency: 'RSD', is_primary: isPrimary,
        })
      }
      fetchAccounts(pid)
    }
  }

  const applyNbsAccount = async (accNumber: string, bankName?: string) => {
    const pid = savedPartnerId || partner?.id
    if (!pid || !accNumber) return
    const exists = accounts.find(a => a.account_number === accNumber)
    if (exists) return
    const isPrimary = accounts.length === 0
    await supabase.from('partner_accounts').insert({
      partner_id: pid, account_number: accNumber, currency: 'RSD',
      is_primary: isPrimary, bank_name: bankName || null,
    })
    fetchAccounts(pid)
  }

  const setPrimary = async (accountId: string) => {
    const pid = savedPartnerId || partner?.id
    if (!pid) return
    await supabase.from('partner_accounts').update({ is_primary: false }).eq('partner_id', pid)
    await supabase.from('partner_accounts').update({ is_primary: true }).eq('id', accountId)
    fetchAccounts(pid)
  }

  const deleteAccount = async (accountId: string) => {
    if (!window.confirm('Obrisati ovaj tekući račun?')) return
    await supabase.from('partner_accounts').delete().eq('id', accountId)
    fetchAccounts()
  }

  const addAccount = async () => {
    const pid = savedPartnerId || partner?.id
    if (!newAccNum.trim() || !pid) return
    setAddingAccount(true)
    const isPrimary = accounts.length === 0
    const { data: newAcc, error } = await supabase.from('partner_accounts').insert({
      partner_id: pid, account_number: newAccNum.trim(),
      bank_name: newBankName.trim() || null, currency: newCurrency,
      model: newModel.trim() || null, is_primary: isPrimary,
    }).select().single()
    if (newAcc) {
      setNewAccNum(''); setNewBankName(''); setNewModel(''); setNewCurrency('RSD')
      fetchAccounts(pid)
    }
    if (error) console.error('addAccount error:', error)
    setAddingAccount(false)
  }

  const handleSave = async () => {
    if (!name.trim()) return
    setSaving(true)
    setSaveError('')

    // Duplicate check
    const dup = await checkDuplicate(taxId, registrationNumber)
    if (dup) {
      setDuplicateWarning(dup)
      setSaving(false)
      return
    }

    const payload = {
      name: name.trim(), type,
      tax_id: taxId || null, registration_number: registrationNumber || null,
      address: address || null, city: city || null, country: country || null,
      contact_name: contactName || null, contact_email: contactEmail || null,
      contact_phone: contactPhone || null, note: note || null, is_active: isActive,
      is_individual: isIndividual,
    }
    if (partner?.id) {
      const { error } = await supabase.from('partners').update(payload).eq('id', partner.id)
      if (error) { setSaveError(`Greška: ${error.message}`); setSaving(false); return }
      setSuccess(true)
      setTimeout(() => { setSuccess(false); onSaved({ ...partner, ...payload }) }, 1200)
    } else {
      const { data: newP, error } = await supabase.from('partners').insert(payload).select().single()
      if (error) { setSaveError(`Greška: ${error.message}`); setSaving(false); return }
      setSavedPartnerId(newP.id)

      // Save all accounts: initialAccountNumber + NBS accounts
      const accountsToSave: { account_number: string; bank_name: string | null; is_primary: boolean }[] = []

      if (initialAccountNumber.trim()) {
        accountsToSave.push({ account_number: initialAccountNumber.trim(), bank_name: null, is_primary: true })
      }

      if (nbsResult?.accounts?.length > 0) {
        nbsResult.accounts.forEach((acc: { account: string; bankName?: string }, idx: number) => {
          const alreadyAdded = accountsToSave.some(a => a.account_number === acc.account)
          if (!alreadyAdded) {
            accountsToSave.push({
              account_number: acc.account,
              bank_name: acc.bankName || null,
              is_primary: accountsToSave.length === 0, // primary only if no other
            })
          }
        })
      }

      if (accountsToSave.length > 0) {
        for (const acc of accountsToSave) {
          await supabase.from('partner_accounts').insert({
            partner_id: newP.id,
            account_number: acc.account_number,
            bank_name: acc.bank_name,
            currency: 'RSD',
            is_primary: acc.is_primary,
          })
        }
        fetchAccounts(newP.id)
        setNewAccNum('')
      }

      setSuccess(true)
      setTimeout(() => { setSuccess(false); onSaved(newP) }, 1200)
    }
    setSaving(false)
  }

  if (success) return (
    <div style={ds.overlay}>
      <div style={{ ...ds.dialog, display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center', gap: '12px', minHeight: '180px' }}>
        <div style={{ width: '48px', height: '48px', borderRadius: '50%', background: 'rgba(0,212,126,0.12)', display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
          <svg width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="#1D9E75" strokeWidth="2"><path d="M5 13l4 4L19 7" /></svg>
        </div>
        <div style={{ fontFamily: 'Georgia,serif', fontSize: '18px', color: '#DCE9F6' }}>
          {partner ? 'Partner je izmenjen.' : 'Partner je dodat.'}
        </div>
        {initialAccountNumber && !partner && (
          <div style={{ fontSize: '12px', color: '#5DCAA5' }}>✓ Račun {initialAccountNumber} je automatski dodat</div>
        )}
      </div>
    </div>
  )

  const currentPartnerId = savedPartnerId || partner?.id

  return (
    <div style={ds.overlay}>
      <div style={ds.dialog}>
        <div style={ds.header}>
          <div style={ds.headerTitle}>{partner ? 'Izmena partnera' : 'Novi partner'}</div>
          <button style={ds.closeBtn} onClick={onClose}>×</button>
        </div>

        {currentPartnerId && (
          <div style={ds.tabBar}>
            <button style={{ ...ds.tab, ...(activeTab === 'info' ? ds.tabActive : {}) }} onClick={() => setActiveTab('info')}>📋 Osnovni podaci</button>
            <button style={{ ...ds.tab, ...(activeTab === 'accounts' ? ds.tabActive : {}) }} onClick={() => setActiveTab('accounts')}>
              🏦 Tekući računi
              {accounts.length > 0 && <span style={ds.tabBadge}>{accounts.length}</span>}
            </button>
          </div>
        )}

        <div style={ds.body}>
          {activeTab === 'info' && (
            <>
              {/* Duplicate warning */}
              {duplicateWarning && (
                <div style={{ marginBottom: '16px', padding: '12px 16px', background: 'rgba(255,91,90,0.10)', border: '1px solid rgba(255,91,90,0.3)', borderRadius: '10px' }}>
                  <div style={{ fontSize: '13px', fontWeight: '500', color: '#FF5B5A', marginBottom: '6px' }}>
                    ⚠️ Već postoji partner sa istim podatkom: {duplicateWarning.field}
                  </div>
                  <div style={{ fontSize: '12px', color: '#DCE9F6' }}>
                    <strong>{duplicateWarning.partner.name}</strong>
                    {duplicateWarning.partner.tax_id && <span style={{ color: '#7A9BB8', marginLeft: '8px' }}>PIB: {duplicateWarning.partner.tax_id}</span>}
                    {duplicateWarning.partner.registration_number && <span style={{ color: '#7A9BB8', marginLeft: '8px' }}>MB: {duplicateWarning.partner.registration_number}</span>}
                  </div>
                  <div style={{ display: 'flex', gap: '8px', marginTop: '10px' }}>
                    <button style={{ ...ds.btnGhost, fontSize: '12px', padding: '5px 12px' }} onClick={() => setDuplicateWarning(null)}>
                      Zanemari i nastavi
                    </button>
                    <button style={{ ...ds.btnPrimary, fontSize: '12px', padding: '5px 12px' }} onClick={() => { setDuplicateWarning(null); onClose() }}>
                      Otvori postojećeg
                    </button>
                  </div>
                </div>
              )}

              <div style={ds.section}>
                <div style={ds.sectionTitle}>🏛 Pretraga NBS — pretražite registar po matičnom broju</div>
                <div style={{ display: 'flex', gap: '8px' }}>
                  <input
                    style={{ ...ds.input, flex: 1, fontFamily: 'monospace', letterSpacing: '0.1em', fontSize: '15px' }}
                    value={nbsPib}
                    onChange={e => { setNbsPib(e.target.value.replace(/\D/g, '').slice(0, 8)); setNbsResult(null); setNbsError('') }}
                    onKeyDown={e => { if (e.key === 'Enter') lookupNBS() }}
                    placeholder="Matični broj (8 cifara)…"
                    maxLength={8}
                  />
                  <button
                    style={{
                      fontFamily: 'system-ui,sans-serif', fontSize: '13px', fontWeight: '600',
                      padding: '8px 20px', borderRadius: '8px', border: 'none', minWidth: '130px',
                      cursor: nbsPib.length >= 8 && !nbsLoading ? 'pointer' : 'not-allowed',
                      background: nbsPib.length >= 8 && !nbsLoading ? '#00D47E' : 'rgba(255,255,255,0.06)',
                      color: nbsPib.length >= 8 && !nbsLoading ? '#060E1A' : '#7A9BB8',
                    }}
                    onClick={lookupNBS} disabled={nbsPib.length < 8 || nbsLoading}>
                    {nbsLoading ? '⏳ Pretraga…' : '🔍 Pretraži NBS'}
                  </button>
                </div>
                <div style={{ marginTop: '6px', fontSize: '11px', color: '#7A9BB8' }}>
                  Unesite matični broj i pritisnite Enter — podaci o firmi se popunjavaju automatski
                </div>

                {nbsError && (
                  <div style={{ marginTop: '10px', padding: '10px 14px', background: 'rgba(255,91,90,0.1)', border: '1px solid rgba(255,91,90,0.25)', borderRadius: '8px', fontSize: '12px', color: '#FF5B5A' }}>
                    ⚠️ {nbsError}
                  </div>
                )}

                {nbsResult && !showNbsMerge && (
                  <div style={{ marginTop: '10px', padding: '14px', background: 'rgba(0,212,126,0.07)', border: '1px solid rgba(0,212,126,0.2)', borderRadius: '10px' }}>
                    <div style={{ display: 'flex', alignItems: 'center', gap: '8px', marginBottom: '10px' }}>
                      <span style={{ fontSize: '18px' }}>✅</span>
                      <div style={{ fontSize: '14px', fontWeight: '600', color: '#00D47E' }}>{nbsResult.name}</div>
                    </div>
                    <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '6px', fontSize: '12px', color: '#7A9BB8', marginBottom: '8px' }}>
                      {nbsResult.pib && <span>PIB: <strong style={{ color: '#DCE9F6', fontFamily: 'monospace' }}>{nbsResult.pib}</strong></span>}
                      {nbsResult.mb && <span>MB: <strong style={{ color: '#DCE9F6', fontFamily: 'monospace' }}>{nbsResult.mb}</strong></span>}
                      {nbsResult.address && <span>Adresa: <strong style={{ color: '#DCE9F6' }}>{nbsResult.address}</strong></span>}
                      {nbsResult.city && <span>Grad: <strong style={{ color: '#DCE9F6' }}>{nbsResult.city}</strong></span>}
                    </div>
                    <div style={{ fontSize: '11px', color: '#5DCAA5' }}>✓ Polja u formi su automatski popunjena</div>

                    {currentPartnerId && (
                      <button style={{ ...ds.accountBtn, marginTop: '10px', color: '#00D47E', borderColor: 'rgba(0,212,126,0.3)' }}
                        onClick={() => setShowNbsMerge(true)}>
                        🔄 Otvori pregled izmena
                      </button>
                    )}

                    {nbsResult.accounts?.length > 0 && !currentPartnerId && (
                      <div style={{ marginTop: '12px', borderTop: '1px solid rgba(0,212,126,0.15)', paddingTop: '10px' }}>
                        <div style={{ fontSize: '11px', color: '#7A9BB8', marginBottom: '6px', fontWeight: '500' }}>
                          Računi iz NBS ({nbsResult.accounts.length}) — dodaju se pri čuvanju
                        </div>
                        {nbsResult.accounts.map((acc: { account: string; bankName: string }) => (
                          <div key={acc.account} style={{ display: 'flex', alignItems: 'center', gap: '8px', padding: '4px 0' }}>
                            <span style={{ fontFamily: 'monospace', fontSize: '12px', color: '#DCE9F6' }}>{acc.account}</span>
                            {acc.bankName && <span style={{ fontSize: '11px', color: '#7A9BB8' }}>{acc.bankName}</span>}
                          </div>
                        ))}
                      </div>
                    )}

                    {nbsResult.accounts?.length > 0 && currentPartnerId && (
                      <div style={{ marginTop: '12px', borderTop: '1px solid rgba(0,212,126,0.15)', paddingTop: '10px' }}>
                        <div style={{ fontSize: '11px', color: '#7A9BB8', marginBottom: '6px', fontWeight: '500' }}>
                          Računi iz NBS ({nbsResult.accounts.length})
                        </div>
                        {nbsResult.accounts.map((acc: { account: string; bankName: string }) => {
                          const exists = accounts.find(a => a.account_number === acc.account)
                          return (
                            <div key={acc.account} style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', padding: '4px 0' }}>
                              <div>
                                <span style={{ fontFamily: 'monospace', fontSize: '12px', color: '#DCE9F6' }}>{acc.account}</span>
                                {acc.bankName && <span style={{ fontSize: '11px', color: '#7A9BB8', marginLeft: '8px' }}>{acc.bankName}</span>}
                              </div>
                              {exists
                                ? <span style={{ fontSize: '10px', color: '#5DCAA5' }}>✓ već dodat</span>
                                : <button style={{ ...ds.accountBtn, color: '#00D47E', borderColor: 'rgba(0,212,126,0.3)' }} onClick={() => applyNbsAccount(acc.account, acc.bankName)}>+ Dodaj</button>
                              }
                            </div>
                          )
                        })}
                      </div>
                    )}
                  </div>
                )}
              </div>

              <div style={ds.section}>
                <div style={ds.sectionTitle}>Osnovni podaci</div>
                <div style={ds.row2}>
                  <div style={ds.field}>
                    <label style={ds.lbl}>Naziv <span style={{ color: '#E24B4A' }}>*</span></label>
                    <input style={ds.input} value={name} onChange={e => setName(e.target.value)} placeholder="Naziv partnera…" />
                  </div>
                  <div style={ds.field}>
                    <label style={ds.lbl}>Tip <span style={{ color: '#E24B4A' }}>*</span></label>
                    <div style={{ display: 'flex', gap: '6px' }}>
                      {[{ id: 'vendor', label: '📤 Dobavljač' }, { id: 'customer', label: '📥 Kupac' }, { id: 'both', label: '🔄 Oba' }, { id: 'company', label: '🏢 Firma' }].map(t => (
                        <div key={t.id} style={{ ...ds.typeChip, ...(type === t.id ? ds.typeChipActive : {}) }} onClick={() => setType(t.id)}>{t.label}</div>
                      ))}
                    </div>
                  </div>
                </div>
                <div style={ds.row2}>
                  <div style={ds.field}>
                    <label style={ds.lbl}>PIB</label>
                    <input style={{ ...ds.input, fontFamily: 'monospace' }} value={taxId} onChange={e => setTaxId(e.target.value)} placeholder="npr. 102937492" />
                  </div>
                  <div style={ds.field}>
                    <label style={ds.lbl}>Matični broj</label>
                    <input style={{ ...ds.input, fontFamily: 'monospace' }} value={registrationNumber} onChange={e => setRegistrationNumber(e.target.value)} placeholder="npr. 12345678" />
                  </div>
                </div>
                <div style={ds.row2}>
                  <div style={ds.field}>
                    <label style={ds.lbl}>Adresa</label>
                    <input style={ds.input} value={address} onChange={e => setAddress(e.target.value)} placeholder="Ulica i broj…" />
                  </div>
                  <div style={ds.field}>
                    <label style={ds.lbl}>Grad</label>
                    <input style={ds.input} value={city} onChange={e => setCity(e.target.value)} placeholder="Grad…" />
                  </div>
                </div>
                <div style={ds.field}>
                  <label style={ds.lbl}>Država</label>
                  <input style={ds.input} value={country} onChange={e => setCountry(e.target.value)} placeholder="npr. Srbija" />
                </div>
              </div>

              <div style={ds.section}>
                <div style={ds.sectionTitle}>Kontakt</div>
                <div style={ds.row3}>
                  <div style={ds.field}><label style={ds.lbl}>Kontakt osoba</label><input style={ds.input} value={contactName} onChange={e => setContactName(e.target.value)} placeholder="Ime i prezime…" /></div>
                  <div style={ds.field}><label style={ds.lbl}>Email</label><input style={ds.input} type="email" value={contactEmail} onChange={e => setContactEmail(e.target.value)} placeholder="email@example.com" /></div>
                  <div style={ds.field}><label style={ds.lbl}>Telefon</label><input style={ds.input} value={contactPhone} onChange={e => setContactPhone(e.target.value)} placeholder="+381..." /></div>
                </div>
              </div>

              <div style={ds.section}>
                <div style={ds.sectionTitle}>Napomena i status</div>
                <div style={ds.field}>
                  <label style={ds.lbl}>Napomena</label>
                  <textarea style={ds.textarea} value={note} onChange={e => setNote(e.target.value)} placeholder="Dodatne napomene…" />
                </div>
                <div style={{ ...ds.toggleRow, marginTop: '10px' }}>
                  <span style={{ fontSize: '13px', color: '#DCE9F6' }}>Aktivan partner</span>
                  <label style={ds.toggle}>
                    <input type="checkbox" checked={isActive} onChange={e => setIsActive(e.target.checked)} style={{ opacity: 0, width: 0, height: 0 }} />
                    <span style={{ ...ds.toggleSlider, background: isActive ? '#1D9E75' : '#ddd' }} />
                  </label>
                </div>
                <div style={{ ...ds.toggleRow, marginTop: '8px' }}>
                  <div>
                    <span style={{ fontSize: '13px', color: '#DCE9F6' }}>👤 Fizičko lice</span>
                    <div style={{ fontSize: '11px', color: '#7A9BB8', marginTop: '2px' }}>Označava zaposlene i fizička lica — prikazuju se u uvozu zarada</div>
                  </div>
                  <label style={ds.toggle}>
                    <input type="checkbox" checked={isIndividual} onChange={e => setIsIndividual(e.target.checked)} style={{ opacity: 0, width: 0, height: 0 }} />
                    <span style={{ ...ds.toggleSlider, background: isIndividual ? '#9D97FF' : '#ddd' }} />
                  </label>
                </div>
              </div>

              {initialAccountNumber && !currentPartnerId && (
                <div style={{ padding: '10px 14px', background: 'rgba(0,212,126,0.07)', border: '1px solid rgba(0,212,126,0.2)', borderRadius: '8px', fontSize: '12px', color: '#5DCAA5' }}>
                  ✓ Račun <strong style={{ fontFamily: 'monospace' }}>{initialAccountNumber}</strong> biće dodat pri čuvanju
                </div>
              )}

              {saveError && (
                <div style={{ padding: '10px 14px', background: 'rgba(255,91,90,0.10)', border: '1px solid rgba(255,91,90,0.3)', borderRadius: '8px', fontSize: '12px', color: '#FF5B5A', marginTop: '10px' }}>
                  ⚠️ {saveError}
                </div>
              )}
            </>
          )}

          {activeTab === 'accounts' && (
            <div style={ds.section}>
              <div style={ds.sectionTitle}>Tekući računi</div>
              {loadingAccounts ? (
                <div style={{ padding: '20px', textAlign: 'center' as const, color: '#7A9BB8', fontSize: '13px' }}>Učitavanje…</div>
              ) : accounts.length === 0 ? (
                <div style={{ padding: '20px', textAlign: 'center' as const, color: 'rgba(255,255,255,0.30)', fontSize: '13px', background: 'rgba(255,255,255,0.04)', borderRadius: '8px', marginBottom: '16px' }}>Još nema tekućih računa.</div>
              ) : (
                <div style={{ marginBottom: '16px', display: 'flex', flexDirection: 'column' as const, gap: '8px' }}>
                  {accounts.map(acc => (
                    <div key={acc.id} style={{ ...ds.accountRow, ...(acc.is_primary ? ds.accountRowPrimary : {}) }}>
                      <div style={{ flex: 1 }}>
                        <div style={{ display: 'flex', alignItems: 'center', gap: '8px' }}>
                          <span style={{ fontSize: '13px', fontWeight: '500', color: '#DCE9F6', fontFamily: 'monospace' }}>{acc.account_number}</span>
                          {acc.is_primary && <span style={{ fontSize: '10px', fontWeight: '500', padding: '1px 7px', borderRadius: '20px', background: 'rgba(0,212,126,0.12)', color: '#00D47E' }}>★ Glavni</span>}
                          <span style={{ fontSize: '10px', padding: '1px 7px', borderRadius: '20px', background: 'rgba(255,255,255,0.06)', color: '#7A9BB8' }}>{acc.currency || 'RSD'}</span>
                        </div>
                        {acc.bank_name && <div style={{ fontSize: '11px', color: '#7A9BB8', marginTop: '2px' }}>{acc.bank_name}</div>}
                      </div>
                      <div style={{ display: 'flex', gap: '6px' }}>
                        {!acc.is_primary && <button style={ds.accountBtn} onClick={() => setPrimary(acc.id)}>★ Postavi kao glavni</button>}
                        <button style={{ ...ds.accountBtn, color: '#FF5B5A', borderColor: '#F5A9A9' }} onClick={() => deleteAccount(acc.id)}>Obriši</button>
                      </div>
                    </div>
                  ))}
                </div>
              )}
              <div style={{ background: 'rgba(255,255,255,0.04)', borderRadius: '10px', padding: '14px', border: '0.5px solid rgba(255,255,255,0.10)' }}>
                <div style={{ fontSize: '11px', fontWeight: '500', color: '#7A9BB8', textTransform: 'uppercase' as const, letterSpacing: '0.07em', marginBottom: '10px' }}>Novi račun</div>
                <div style={ds.row2}>
                  <div style={ds.field}><label style={ds.lbl}>Broj računa *</label><input style={ds.input} value={newAccNum} onChange={e => setNewAccNum(e.target.value)} placeholder="npr. 265-1234567-89" /></div>
                  <div style={ds.field}><label style={ds.lbl}>Banka</label><input style={ds.input} value={newBankName} onChange={e => setNewBankName(e.target.value)} placeholder="npr. Raiffeisen" /></div>
                </div>
                <div style={ds.row2}>
                  <div style={ds.field}><label style={ds.lbl}>Valuta</label>
                    <select style={ds.select} value={newCurrency} onChange={e => setNewCurrency(e.target.value)}>
                      {DOCUMENT_CURRENCIES.map(c => <option key={c}>{c}</option>)}
                    </select>
                  </div>
                  <div style={ds.field}><label style={ds.lbl}>Model</label><input style={ds.input} value={newModel} onChange={e => setNewModel(e.target.value)} placeholder="npr. 97" /></div>
                </div>
                <button style={{ ...ds.btnPrimary, opacity: !newAccNum.trim() || addingAccount || !currentPartnerId ? 0.6 : 1 }}
                  onClick={addAccount} disabled={!newAccNum.trim() || addingAccount || !currentPartnerId}>
                  {addingAccount ? 'Dodavanje…' : '+ Dodaj račun'}
                </button>
              </div>
            </div>
          )}
        </div>

        <div style={ds.footer}>
          <div style={{ display: 'flex', gap: '8px', flex: 1 }}>
            <button style={ds.btnGhost} onClick={onClose}>Otkaži</button>
            {partner?.id && onDelete && (
              <button style={ds.btnDelete} onClick={() => onDelete(partner.id, partner.name)}>🗑 Obriši</button>
            )}
          </div>
          {activeTab === 'info' && (
            <button style={ds.btnPrimary} onClick={handleSave} disabled={saving || !name.trim()}>
              {saving ? 'Čuvanje…' : partner ? 'Sačuvaj izmene' : 'Sačuvaj partnera'}
            </button>
          )}
        </div>
      </div>

      {/* NBS Merge Dialog */}
      {showNbsMerge && nbsResult && (
        <NbsMergeDialog
          existingPartner={{ name, tax_id: taxId, registration_number: registrationNumber, address, city }}
          existingAccounts={accounts}
          nbsResult={nbsResult}
          onConfirm={handleNbsMergeConfirm}
          onCancel={() => setShowNbsMerge(false)}
        />
      )}
    </div>
  )
}

const ds: Record<string, React.CSSProperties> = {
  overlay: { position: 'fixed', inset: 0, colorScheme: 'dark', background: DIALOG.overlay, backdropFilter: 'blur(4px)', display: 'flex', alignItems: 'center', justifyContent: 'center', zIndex: 1100 },
  dialog: { background: '#0D1B2C', borderRadius: '16px', width: '720px', maxWidth: '95vw', maxHeight: '90vh', display: 'flex', flexDirection: 'column', overflow: 'hidden', border: '1px solid rgba(255,255,255,0.10)' },
  header: { background: '#060E1A', padding: '1rem 1.5rem', display: 'flex', alignItems: 'center', justifyContent: 'space-between' },
  headerTitle: { color: '#DCE9F6', fontSize: '15px', fontWeight: '500' },
  closeBtn: { background: 'none', border: 'none', color: 'rgba(255,255,255,0.5)', fontSize: '22px', cursor: 'pointer', padding: '0 4px', lineHeight: 1 },
  tabBar: { display: 'flex', borderBottom: '1px solid rgba(255,255,255,0.075)', background: '#111F30' },
  tab: { fontFamily: 'system-ui,sans-serif', fontSize: '13px', padding: '10px 20px', border: 'none', background: 'transparent', color: '#7A9BB8', cursor: 'pointer', borderBottom: '2px solid transparent', display: 'flex', alignItems: 'center', gap: '6px' },
  tabActive: { color: '#00D47E', borderBottom: '2px solid #00D47E', fontWeight: '500' },
  tabBadge: { fontSize: '10px', background: '#00D47E', color: '#060E1A', borderRadius: '20px', padding: '1px 6px', fontWeight: '500' },
  body: { padding: '1.5rem', overflowY: 'auto', flex: 1 },
  footer: { padding: '1rem 1.5rem', borderTop: '1px solid rgba(255,255,255,0.075)', display: 'flex', justifyContent: 'flex-end', gap: '8px', background: '#111F30' },
  section: { marginBottom: '1.5rem' },
  sectionTitle: { fontSize: '11px', fontWeight: '500', color: 'rgba(255,255,255,0.30)', textTransform: 'uppercase' as const, letterSpacing: '0.08em', marginBottom: '10px', paddingBottom: '6px', borderBottom: '1px solid rgba(255,255,255,0.075)' },
  row2: { display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '12px', marginBottom: '12px' },
  row3: { display: 'grid', gridTemplateColumns: '1fr 1fr 1fr', gap: '12px', marginBottom: '12px' },
  field: { display: 'flex', flexDirection: 'column' as const, gap: '4px' },
  lbl: { fontSize: '11px', fontWeight: '500', color: 'rgba(255,255,255,0.30)', textTransform: 'uppercase' as const, letterSpacing: '0.07em' },
  input: { fontFamily: 'system-ui,sans-serif', fontSize: '13px', padding: '8px 10px', border: '1px solid rgba(255,255,255,0.10)', borderRadius: '8px', background: '#111F30', color: '#DCE9F6', outline: 'none' },
  select: { fontFamily: 'system-ui,sans-serif', fontSize: '13px', padding: '8px 10px', border: '1px solid rgba(255,255,255,0.10)', borderRadius: '8px', background: '#111F30', color: '#DCE9F6', outline: 'none' },
  textarea: { fontFamily: 'system-ui,sans-serif', fontSize: '13px', padding: '8px 10px', border: '1px solid rgba(255,255,255,0.10)', borderRadius: '8px', background: '#111F30', color: '#DCE9F6', outline: 'none', resize: 'vertical' as const, minHeight: '60px' },
  typeChip: { flex: 1, padding: '8px 6px', border: '1px solid rgba(255,255,255,0.10)', borderRadius: '8px', background: 'rgba(255,255,255,0.04)', fontSize: '12px', cursor: 'pointer', textAlign: 'center' as const, color: '#7A9BB8' },
  typeChipActive: { border: '2px solid #00D47E', background: 'rgba(0,212,126,0.12)', color: '#00D47E', fontWeight: '500' },
  toggleRow: { display: 'flex', alignItems: 'center', justifyContent: 'space-between', padding: '8px 12px', background: 'rgba(255,255,255,0.04)', borderRadius: '8px', border: '1px solid rgba(255,255,255,0.075)' },
  toggle: { position: 'relative' as const, width: '36px', height: '20px', cursor: 'pointer', flexShrink: 0 },
  toggleSlider: { position: 'absolute' as const, inset: 0, borderRadius: '10px', transition: 'background 0.2s', display: 'block' },
  accountRow: { display: 'flex', alignItems: 'center', gap: '12px', padding: '10px 12px', border: '1px solid rgba(255,255,255,0.075)', borderRadius: '8px', background: '#111F30' },
  accountRowPrimary: { border: '1.5px solid #00D47E', background: 'rgba(0,212,126,0.06)' },
  accountBtn: { fontFamily: 'system-ui,sans-serif', fontSize: '11px', padding: '4px 10px', border: '1px solid rgba(255,255,255,0.10)', borderRadius: '6px', background: 'transparent', color: '#7A9BB8', cursor: 'pointer', whiteSpace: 'nowrap' as const },
  btnGhost: { fontFamily: 'system-ui,sans-serif', fontSize: '13px', padding: '8px 16px', borderRadius: '8px', border: '1px solid rgba(255,255,255,0.10)', background: 'transparent', color: '#7A9BB8', cursor: 'pointer' },
  btnDelete: { fontFamily: 'system-ui,sans-serif', fontSize: '13px', padding: '8px 16px', borderRadius: '8px', border: '1px solid rgba(255,91,90,0.3)', background: 'rgba(255,91,90,0.08)', color: '#FF5B5A', cursor: 'pointer' },
  btnPrimary: { fontFamily: 'system-ui,sans-serif', fontSize: '13px', padding: '8px 18px', borderRadius: '8px', border: 'none', background: '#00D47E', color: '#060E1A', cursor: 'pointer', fontWeight: '500' },
}