import React, { useState, useEffect, useCallback } from 'react'
import { useLocation } from 'react-router-dom'
import { useAuth } from '../contexts/AuthContext'
import { supabase } from '../supabase'
import { useCompanies } from '../contexts/CompaniesContext'
import { SkeletonRows } from '../components/motion'
import { runWrite } from '../services/writeOrder'
import QuickFillTab from '../components/QuickFillTab'
import PayrollSettingsTab from '../components/PayrollSettingsTab'
import UserManagement from '../components/UserManagement'
import ClosedPeriodsTab from '../components/ClosedPeriodsTab'
import BanksTab from '../components/BanksTab'
import SystemCategoriesTab from '../components/SystemCategoriesTab'
import SefSettingsTab from '../components/SefSettingsTab'
import { DOCUMENT_CURRENCIES } from '../services/bookAmounts'
import { countOf } from '../utils/plural'

/** The alert for a classification row that records still point at. */
const inUse = (name: string, n: number, one: string, few: string, many: string) =>
  `„${name}“ ne može da se obriše — koristi se u ${countOf(n, one, few, many)}.`

type SettingsTab = 'companies' | 'banks' | 'pl' | 'departments' | 'descriptions' | 'system' | 'users' | 'periods' | 'templates' | 'payroll' | 'sef'

const TAB_IDS: readonly SettingsTab[] = ['companies', 'banks', 'pl', 'departments', 'descriptions', 'system', 'users', 'periods', 'templates', 'payroll', 'sef']

/** `#/settings?tab=system` opens that tab — the notices on Zarade and Krediti link there. */
function tabFromSearch(search: string): SettingsTab | null {
  const t = new URLSearchParams(search).get('tab')
  return t && (TAB_IDS as readonly string[]).includes(t) ? t as SettingsTab : null
}

/**
 * Run a change and, if the database refuses it, say so.
 *
 * Every mutation on this page is followed by a refetch, so a failure shows up
 * as the list not changing. That is not the same as being told a period is
 * closed or that your role does not allow it, which is what this adds.
 *
 * At module scope because this file holds five tabs and each of them writes.
 */
async function reportWrite(label: string, q: any): Promise<boolean> {
  const { ok, message } = await runWrite(label, q)
  if (!ok) window.alert(message)
  return ok
}

export default function Settings() {
  const { canManageSettings, canManageUsers } = useAuth()
  const location = useLocation()
  const [activeTab, setActiveTab] = useState<SettingsTab>(() => tabFromSearch(location.search) ?? 'companies')
  useEffect(() => {
    const t = tabFromSearch(location.search)
    if (t) setActiveTab(t)
  }, [location.search])

  return (
    <div style={s.root} className="app-surface">
      <div style={s.body}>
        <div style={s.pageHeader}>
          <div>
            <div style={s.pageTitle}>Podešavanja</div>
            <div style={s.pageSub}>Profili firmi, P&L kategorije, sektori i korisnici</div>
          </div>
        </div>

        <div style={s.tabBar}>
          {([
            { id: 'companies',    label: '🏢 Profili firmi',        show: true },
            { id: 'banks',        label: '🏦 Banke',                show: true },
            { id: 'pl',           label: '📊 P&L kategorije',       show: true },
            { id: 'departments',  label: '🏗 Sektori',              show: true },
            { id: 'descriptions', label: '🏷 Opisi troškova',       show: true },
            { id: 'system',       label: '⚙ Sistemske kategorije', show: true },
            { id: 'templates',    label: '⚡ Šabloni brze popune',  show: true },
            { id: 'payroll',      label: '💼 Podešavanja zarada',   show: true },
            { id: 'periods',      label: '🔒 Zaključani periodi',   show: true },
            { id: 'sef',          label: '📨 SEF',                  show: canManageSettings },
            { id: 'users',        label: '👥 Korisnici',            show: canManageUsers },
          ] as { id: SettingsTab; label: string; show: boolean }[]).filter(t => t.show).map(tab => (
            <button key={tab.id}
              style={{ ...s.tab, ...(activeTab === tab.id ? s.tabActive : {}) }}
              onClick={() => setActiveTab(tab.id)}>
              {tab.label}
            </button>
          ))}
        </div>

        {activeTab === 'companies'    && <CompanyProfilesTab canEdit={canManageSettings} />}
        {activeTab === 'banks'        && <BanksTab canEdit={canManageSettings} />}
        {activeTab === 'pl'           && <PLCategoriesTab canEdit={canManageSettings} />}
        {activeTab === 'departments'  && <DepartmentsTab canEdit={canManageSettings} />}
        {activeTab === 'descriptions' && <DescriptionsTab canEdit={canManageSettings} />}
        {activeTab === 'system'       && <SystemCategoriesTab canEdit={canManageSettings} />}
        {activeTab === 'templates'    && <QuickFillTab canEdit={canManageSettings} />}
        {activeTab === 'payroll'      && <PayrollSettingsTab canEdit={canManageSettings} />}
        {activeTab === 'periods'      && <ClosedPeriodsTab canEdit={canManageSettings} />}
        {activeTab === 'sef'          && canManageSettings && <SefSettingsTab canEdit={canManageSettings} />}
        {activeTab === 'users'        && <UserManagement />}
      </div>
    </div>
  )
}

// ── Company Profiles Tab ─────────────────────────────────
function CompanyProfilesTab({ canEdit }: { canEdit: boolean }) {
  const { companies, defaultCompany, showPicker } = useCompanies()
  const [profiles, setProfiles] = useState<Record<string, any>>({})
  const [bankAccounts, setBankAccounts] = useState<Record<string, any[]>>({})
  const [selectedCompany, setSelectedCompany] = useState<any>(null)
  const [loading, setLoading] = useState(true)
  const [saving, setSaving] = useState(false)
  const [saved, setSaved] = useState(false)
  const [fullLegalName, setFullLegalName] = useState('')
  const [address, setAddress] = useState('')
  const [city, setCity] = useState('')
  const [country, setCountry] = useState('Srbija')
  const [pib, setPib] = useState('')
  const [mb, setMb] = useState('')
  const [pdvNumber, setPdvNumber] = useState('')
  const [phone, setPhone] = useState('')
  const [email, setEmail] = useState('')
  const [website, setWebsite] = useState('')
  const [companyBanks, setCompanyBanks] = useState<any[]>([])
  const [newBankName, setNewBankName] = useState('')
  const [newAccountNum, setNewAccountNum] = useState('')
  const [newCurrency, setNewCurrency] = useState('RSD')
  const [newSwift, setNewSwift] = useState('')
  const [newIban, setNewIban] = useState('')
  const [newIsPrimary, setNewIsPrimary] = useState(false)

  useEffect(() => {
    const load = async () => {
      setLoading(true)
      const [{ data: prof }, { data: banks }] = await Promise.all([
        supabase.from('company_profiles').select('*'),
        supabase.from('company_bank_accounts').select('*').order('is_primary', { ascending: false }),
      ])
      if (prof) { const m: Record<string, any> = {}; prof.forEach(p => { m[p.company_id] = p }); setProfiles(m) }
      if (banks) { const m: Record<string, any[]> = {}; banks.forEach(b => { if (!m[b.company_id]) m[b.company_id] = []; m[b.company_id].push(b) }); setBankAccounts(m) }
      setLoading(false)
    }
    load()
  }, [])

  useEffect(() => {
    if (defaultCompany) setSelectedCompany((prev: any) => prev || defaultCompany)
  }, [defaultCompany])

  useEffect(() => {
    if (!selectedCompany) return
    const p = profiles[selectedCompany.id] || {}
    setFullLegalName(p.full_legal_name || ''); setAddress(p.address || ''); setCity(p.city || '')
    setCountry(p.country || 'Srbija'); setPib(p.pib || ''); setMb(p.mb || '')
    setPdvNumber(p.pdv_number || ''); setPhone(p.phone || ''); setEmail(p.email || ''); setWebsite(p.website || '')
    setCompanyBanks(bankAccounts[selectedCompany.id] || [])
  }, [selectedCompany, profiles, bankAccounts])

  const saveProfile = async () => {
    if (!selectedCompany || !canEdit) return
    setSaving(true)
    const payload = {
      company_id: selectedCompany.id, full_legal_name: fullLegalName || null, address: address || null,
      city: city || null, country: country || null, pib: pib || null, mb: mb || null,
      pdv_number: pdvNumber || null, phone: phone || null, email: email || null, website: website || null,
      updated_at: new Date().toISOString(),
    }
    const existing = profiles[selectedCompany.id]
    if (existing) { await supabase.from('company_profiles').update(payload).eq('id', existing.id) }
    else { await supabase.from('company_profiles').insert(payload) }
    const { data } = await supabase.from('company_profiles').select('*')
    if (data) { const m: Record<string, any> = {}; data.forEach(p => { m[p.company_id] = p }); setProfiles(m) }
    setSaving(false); setSaved(true); setTimeout(() => setSaved(false), 2000)
  }

  const addBankAccount = async () => {
    if (!newBankName.trim() || !newAccountNum.trim() || !selectedCompany || !canEdit) return
    const payload = { company_id: selectedCompany.id, bank_name: newBankName.trim(), account_number: newAccountNum.trim(), currency: newCurrency, is_primary: newIsPrimary, swift: newSwift || null, iban: newIban || null }
    if (newIsPrimary) await supabase.from('company_bank_accounts').update({ is_primary: false }).eq('company_id', selectedCompany.id).eq('currency', newCurrency)
    if (!(await reportWrite('Dodavanje tekućeg računa', supabase.from('company_bank_accounts').insert(payload)))) return
    const { data } = await supabase.from('company_bank_accounts').select('*').eq('company_id', selectedCompany.id).order('is_primary', { ascending: false })
    setCompanyBanks(data || []); setBankAccounts(prev => ({ ...prev, [selectedCompany.id]: data || [] }))
    setNewBankName(''); setNewAccountNum(''); setNewCurrency('RSD'); setNewSwift(''); setNewIban(''); setNewIsPrimary(false)
  }

  const deleteBankAccount = async (id: string) => {
    if (!canEdit || !window.confirm('Obrisati ovaj tekući račun?')) return
    if (!(await reportWrite('Brisanje tekućeg računa', supabase.from('company_bank_accounts').delete().eq('id', id)))) return
    const updated = companyBanks.filter(b => b.id !== id)
    setCompanyBanks(updated); setBankAccounts(prev => ({ ...prev, [selectedCompany.id]: updated }))
  }

  const setPrimaryAccount = async (id: string, currency: string) => {
    if (!canEdit) return
    if (!(await reportWrite('Postavljanje glavnog računa', supabase.from('company_bank_accounts').update({ is_primary: false }).eq('company_id', selectedCompany.id).eq('currency', currency)))) return
    if (!(await reportWrite('Postavljanje glavnog računa', supabase.from('company_bank_accounts').update({ is_primary: true }).eq('id', id)))) return
    const { data } = await supabase.from('company_bank_accounts').select('*').eq('company_id', selectedCompany.id).order('is_primary', { ascending: false })
    setCompanyBanks(data || []); setBankAccounts(prev => ({ ...prev, [selectedCompany.id]: data || [] }))
  }

  const currencyColor = (cur: string) => {
    if (cur === 'RSD') return { bg: '#FAEEDA', color: '#633806' }
    if (cur === 'USD') return { bg: '#E6F1FB', color: '#0C447C' }
    if (cur === 'EUR') return { bg: 'rgba(0,212,126,0.12)', color: '#00D47E' }
    return { bg: '#FBEAF0', color: '#72243E' }
  }

  if (loading) return (
    <div style={{ padding: '20px 4px' }}>
      <SkeletonRows rows={6} height={16} gap={15} widths={[86, 58, 92, 50, 78, 66]} />
    </div>
  )

  return (
    <>
      {!canEdit && <div style={s.readOnlyBanner}>👁 Samo pregled — profile firmi mogu da menjaju samo administratori.</div>}
      <div style={{ display: 'grid', gridTemplateColumns: showPicker ? '220px 1fr' : '1fr', gap: '16px', alignItems: 'start' }}>
        {/* The list is a way to choose a company; with one there is no choice. */}
        {showPicker && <div style={s.colPanel}>
          <div style={s.colHeader}><div style={s.colTitle}>Firme</div><span style={s.colCount}>{companies.length}</span></div>
          <div style={s.itemList}>
            {companies.map(c => (
              <div key={c.id} style={{ ...s.itemRow, ...(selectedCompany?.id === c.id ? s.itemRowActive : {}), cursor: 'pointer' }} onClick={() => setSelectedCompany(c)}>
                <div>
                  <div style={s.itemName}>{c.name}</div>
                  <div style={{ fontSize: '10px', color: 'rgba(255,255,255,0.30)', marginTop: '2px' }}>{profiles[c.id] ? '✓ Profil je unet' : 'Profil još nije unet'}</div>
                </div>
              </div>
            ))}
          </div>
        </div>}

        {selectedCompany && (
          <div>
            <div style={{ ...s.colPanel, marginBottom: '16px' }}>
              <div style={s.colHeader}>
                <div style={s.colTitle}>🏢 {selectedCompany.name} — Pravni podaci</div>
                <div style={{ display: 'flex', gap: '8px', alignItems: 'center' }}>
                  {saved && <span style={{ fontSize: '12px', color: '#00D47E', fontWeight: '500' }}>✓ Sačuvano</span>}
                  {canEdit && <button style={s.addBtn} onClick={saveProfile} disabled={saving}>{saving ? 'Čuvanje…' : 'Sačuvaj izmene'}</button>}
                </div>
              </div>
              <div style={{ padding: '16px' }}>
                <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '12px', marginBottom: '12px' }}>
                  {[
                    ['Pun poslovni naziv', fullLegalName, setFullLegalName, 'npr. Firma d.o.o. Beograd'],
                    ['PIB', pib, setPib, 'npr. 109876543'],
                    ['Matični broj (MB)', mb, setMb, 'npr. 21234567'],
                    ['PDV broj', pdvNumber, setPdvNumber, 'npr. RS109876543'],
                    ['Adresa', address, setAddress, 'npr. Bulevar oslobođenja 1'],
                    ['Grad', city, setCity, 'npr. Beograd'],
                    ['Država', country, setCountry, 'npr. Srbija'],
                    ['Telefon', phone, setPhone, 'npr. +381 11 123 4567'],
                    ['Email', email, setEmail, 'npr. office@firma.rs'],
                    ['Veb-sajt', website, setWebsite, 'npr. https://firma.rs'],
                  ].map(([label, value, setter, placeholder]: any) => (
                    <div key={label} style={s.formField}>
                      <label style={s.formLabel}>{label}</label>
                      <input style={s.formInput} value={value} onChange={e => setter(e.target.value)} placeholder={placeholder} disabled={!canEdit} />
                    </div>
                  ))}
                </div>
              </div>
            </div>

            <div style={s.colPanel}>
              <div style={s.colHeader}>
                <div style={s.colTitle}>🏦 Tekući računi</div>
                <span style={s.colCount}>{countOf(companyBanks.length, 'račun', 'računa', 'računa')}</span>
              </div>
              {companyBanks.length === 0
                ? <div style={{ padding: '20px', textAlign: 'center' as const, color: 'rgba(255,255,255,0.30)', fontSize: '13px' }}>Još nema tekućih računa. Dodajte prvi ispod.</div>
                : (
                  <div style={{ padding: '8px 16px' }}>
                    {companyBanks.map(bank => {
                      const cc = currencyColor(bank.currency)
                      return (
                        <div key={bank.id} style={{ display: 'flex', alignItems: 'center', gap: '12px', padding: '10px 0', borderBottom: '0.5px solid rgba(255,255,255,0.05)' }}>
                          <div style={{ flex: 1 }}>
                            <div style={{ display: 'flex', alignItems: 'center', gap: '8px', marginBottom: '3px' }}>
                              <span style={{ fontSize: '13px', fontWeight: '500', color: '#DCE9F6' }}>{bank.bank_name}</span>
                              <span style={{ fontSize: '10px', fontWeight: '500', padding: '1px 7px', borderRadius: '20px', background: cc.bg, color: cc.color }}>{bank.currency}</span>
                              {bank.is_primary && <span style={{ fontSize: '10px', fontWeight: '500', padding: '1px 7px', borderRadius: '20px', background: 'rgba(0,212,126,0.12)', color: '#00D47E' }}>★ Glavni</span>}
                            </div>
                            <div style={{ fontSize: '12px', color: '#7A9BB8', fontFamily: 'monospace' }}>{bank.account_number}</div>
                            {(bank.swift || bank.iban) && <div style={{ fontSize: '11px', color: 'rgba(255,255,255,0.30)', marginTop: '2px' }}>{bank.swift && `SWIFT: ${bank.swift}`}{bank.swift && bank.iban && ' · '}{bank.iban && `IBAN: ${bank.iban}`}</div>}
                          </div>
                          {canEdit && (
                            <div style={{ display: 'flex', gap: '6px' }}>
                              {!bank.is_primary && <button style={{ ...s.iconBtn, fontSize: '11px', padding: '3px 8px', border: '0.5px solid rgba(255,255,255,0.10)', borderRadius: '6px' }} onClick={() => setPrimaryAccount(bank.id, bank.currency)}>Postavi kao glavni</button>}
                              <button style={s.iconBtn} onClick={() => deleteBankAccount(bank.id)}>Obriši</button>
                            </div>
                          )}
                        </div>
                      )
                    })}
                  </div>
                )
              }
              {canEdit && (
                <div style={{ padding: '14px 16px', borderTop: '0.5px solid rgba(255,255,255,0.075)', background: '#111F30' }}>
                  <div style={{ fontSize: '11px', fontWeight: '500', color: '#7A9BB8', textTransform: 'uppercase' as const, letterSpacing: '0.08em', marginBottom: '10px' }}>Dodaj tekući račun</div>
                  <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr 80px', gap: '8px', marginBottom: '8px' }}>
                    <div style={s.formField}><label style={s.formLabel}>Naziv banke</label><input style={s.formInput} value={newBankName} onChange={e => setNewBankName(e.target.value)} placeholder="npr. Raiffeisen Bank" /></div>
                    <div style={s.formField}><label style={s.formLabel}>Broj računa</label><input style={s.formInput} value={newAccountNum} onChange={e => setNewAccountNum(e.target.value)} placeholder="npr. 265-1234567890-12" /></div>
                    <div style={s.formField}><label style={s.formLabel}>Valuta</label><select style={s.formInput} value={newCurrency} onChange={e => setNewCurrency(e.target.value)}>{DOCUMENT_CURRENCIES.map(c => <option key={c}>{c}</option>)}</select></div>
                  </div>
                  <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr auto', gap: '8px', alignItems: 'flex-end' }}>
                    <div style={s.formField}><label style={s.formLabel}>SWIFT (opciono)</label><input style={s.formInput} value={newSwift} onChange={e => setNewSwift(e.target.value)} placeholder="npr. RZBSRSBG" /></div>
                    <div style={s.formField}><label style={s.formLabel}>IBAN (opciono)</label><input style={s.formInput} value={newIban} onChange={e => setNewIban(e.target.value)} placeholder="npr. RS35265…" /></div>
                    <div style={{ display: 'flex', flexDirection: 'column' as const, gap: '6px' }}>
                      <label style={{ ...s.formLabel, display: 'flex', alignItems: 'center', gap: '6px', cursor: 'pointer' }}><input type="checkbox" checked={newIsPrimary} onChange={e => setNewIsPrimary(e.target.checked)} />Glavni</label>
                      <button style={s.addBtn} onClick={addBankAccount}>+ Dodaj račun</button>
                    </div>
                  </div>
                </div>
              )}
            </div>
          </div>
        )}
      </div>
    </>
  )
}

// ── P&L Categories Tab ───────────────────────────────────
function PLCategoriesTab({ canEdit }: { canEdit: boolean }) {
  const [categories, setCategories] = useState<any[]>([])
  const [subcategories, setSubcategories] = useState<any[]>([])
  const [selectedCat, setSelectedCat] = useState<any>(null)
  const [loading, setLoading] = useState(true)
  const [newCatName, setNewCatName] = useState('')
  const [newSubName, setNewSubName] = useState('')
  const [editingId, setEditingId] = useState<string | null>(null)
  const [editingName, setEditingName] = useState('')

  const fetchCategories = useCallback(async () => {
    setLoading(true)
    const { data } = await supabase.from('pl_categories').select('*').order('sort_order')
    if (data) { setCategories(data); if (!selectedCat && data.length > 0) setSelectedCat(data[0]) }
    setLoading(false)
  }, [selectedCat])

  const fetchSubcategories = useCallback(async (catId: string) => {
    const { data } = await supabase.from('pl_subcategories').select('*').eq('category_id', catId).order('sort_order')
    if (data) setSubcategories(data)
  }, [])

  useEffect(() => { fetchCategories() }, []) // eslint-disable-line
  useEffect(() => { if (selectedCat) fetchSubcategories(selectedCat.id) }, [selectedCat]) // eslint-disable-line

  const addCategory = async () => {
    if (!newCatName.trim() || !canEdit) return
    if (!(await reportWrite('Dodavanje kategorije', supabase.from('pl_categories').insert({ name: newCatName.trim(), sort_order: categories.length + 1 })))) return
    setNewCatName(''); fetchCategories()
  }

  const addSubcategory = async () => {
    if (!newSubName.trim() || !selectedCat || !canEdit) return
    if (!(await reportWrite('Dodavanje potkategorije', supabase.from('pl_subcategories').insert({ category_id: selectedCat.id, name: newSubName.trim(), sort_order: subcategories.length + 1 })))) return
    setNewSubName(''); fetchSubcategories(selectedCat.id)
  }

  const updateName = async (table: string, id: string) => {
    if (!editingName.trim() || !canEdit) return
    if (!(await reportWrite('Preimenovanje', supabase.from(table).update({ name: editingName.trim() }).eq('id', id)))) return
    setEditingId(null); setEditingName('')
    if (table === 'pl_categories') fetchCategories()
    else if (selectedCat) fetchSubcategories(selectedCat.id)
  }

  const deleteItem = async (table: string, id: string, name: string) => {
    if (!canEdit) return

    if (table === 'pl_categories') {
      // Proveri transakcije i fakture
      const { count: txCount } = await supabase.from('transactions').select('id', { count: 'exact', head: true }).eq('pl_category', name)
      if (txCount && txCount > 0) { window.alert(inUse(name, txCount, 'transakciji', 'transakcije', 'transakcija')); return }
      const { count: invCount } = await supabase.from('invoices').select('id', { count: 'exact', head: true }).eq('pl_category', name)
      if (invCount && invCount > 0) { window.alert(inUse(name, invCount, 'fakturi', 'fakture', 'faktura')); return }
      if (!window.confirm(`Obrisati kategoriju "${name}" i sve njene potkategorije?`)) return
      // Kaskadno brisanje potkategorija
      if (!(await reportWrite('Brisanje potkategorija', supabase.from('pl_subcategories').delete().eq('category_id', id)))) return
      if (!(await reportWrite('Brisanje kategorije', supabase.from('pl_categories').delete().eq('id', id)))) return
      fetchCategories(); setSelectedCat(null); setSubcategories([])
    } else if (table === 'pl_subcategories') {
      const { count: txCount } = await supabase.from('transactions').select('id', { count: 'exact', head: true }).eq('pl_subcategory', name)
      if (txCount && txCount > 0) { window.alert(inUse(name, txCount, 'transakciji', 'transakcije', 'transakcija')); return }
      const { count: invCount } = await supabase.from('invoices').select('id', { count: 'exact', head: true }).eq('pl_subcategory', name)
      if (invCount && invCount > 0) { window.alert(inUse(name, invCount, 'fakturi', 'fakture', 'faktura')); return }
      if (!window.confirm(`Obrisati potkategoriju "${name}"?`)) return
      if (!(await reportWrite('Brisanje potkategorije', supabase.from('pl_subcategories').delete().eq('id', id)))) return
      if (selectedCat) fetchSubcategories(selectedCat.id)
    }
  }

  if (loading) return (
    <div style={{ padding: '20px 4px' }}>
      <SkeletonRows rows={6} height={16} gap={15} widths={[86, 58, 92, 50, 78, 66]} />
    </div>
  )

  return (
    <>
      {!canEdit && <div style={s.readOnlyBanner}>👁 Samo pregled — kategorije mogu da menjaju samo administratori.</div>}
      <div style={s.twoCol}>
        <div style={s.colPanel}>
          <div style={s.colHeader}><div style={s.colTitle}>P&L kategorije</div><span style={s.colCount}>{categories.length}</span></div>
          <div style={s.itemList}>
            {categories.map(cat => (
              <div key={cat.id} style={{ ...s.itemRow, ...(selectedCat?.id === cat.id ? s.itemRowActive : {}) }} onClick={() => setSelectedCat(cat)}>
                {editingId === cat.id
                  ? <input style={s.inlineInput} value={editingName} onChange={e => setEditingName(e.target.value)} onKeyDown={e => { if (e.key === 'Enter') updateName('pl_categories', cat.id) }} onClick={e => e.stopPropagation()} autoFocus />
                  : <span style={s.itemName}>{cat.name}</span>}
                {canEdit && (
                  <div style={s.itemActions} onClick={e => e.stopPropagation()}>
                    {editingId === cat.id ? <button style={s.saveBtn} onClick={() => updateName('pl_categories', cat.id)}>✓</button> : <button style={s.iconBtn} onClick={() => { setEditingId(cat.id); setEditingName(cat.name) }}>✏️</button>}
                    <button style={s.deleteBtn} onClick={() => deleteItem('pl_categories', cat.id, cat.name)}>Obriši</button>
                  </div>
                )}
              </div>
            ))}
          </div>
          {canEdit && <div style={s.addRow}><input style={s.addInput} value={newCatName} onChange={e => setNewCatName(e.target.value)} placeholder="Nova kategorija…" onKeyDown={e => { if (e.key === 'Enter') addCategory() }} /><button style={s.addBtn} onClick={addCategory}>+ Dodaj</button></div>}
        </div>
        <div style={s.colPanel}>
          <div style={s.colHeader}><div style={s.colTitle}>{selectedCat ? `Potkategorije — ${selectedCat.name}` : 'Izaberite kategoriju'}</div>{selectedCat && <span style={s.colCount}>{subcategories.length}</span>}</div>
          {!selectedCat ? <div style={s.emptyHint}>← Izaberite P&L kategoriju da biste uređivali njene potkategorije</div> : (
            <>
              <div style={s.itemList}>
                {subcategories.map(sub => (
                  <div key={sub.id} style={s.itemRow}>
                    {editingId === sub.id ? <input style={s.inlineInput} value={editingName} onChange={e => setEditingName(e.target.value)} onKeyDown={e => { if (e.key === 'Enter') updateName('pl_subcategories', sub.id) }} autoFocus /> : <span style={s.itemName}>{sub.name}</span>}
                    {canEdit && <div style={s.itemActions}>{editingId === sub.id ? <button style={s.saveBtn} onClick={() => updateName('pl_subcategories', sub.id)}>✓</button> : <button style={s.iconBtn} onClick={() => { setEditingId(sub.id); setEditingName(sub.name) }}>✏️</button>}<button style={s.deleteBtn} onClick={() => deleteItem('pl_subcategories', sub.id, sub.name)}>Obriši</button></div>}
                  </div>
                ))}
              </div>
              {canEdit && <div style={s.addRow}><input style={s.addInput} value={newSubName} onChange={e => setNewSubName(e.target.value)} placeholder="Nova potkategorija…" onKeyDown={e => { if (e.key === 'Enter') addSubcategory() }} /><button style={s.addBtn} onClick={addSubcategory}>+ Dodaj</button></div>}
            </>
          )}
        </div>
      </div>
    </>
  )
}

// ── Departments Tab ──────────────────────────────────────
function DepartmentsTab({ canEdit }: { canEdit: boolean }) {
  const [departments, setDepartments] = useState<any[]>([])
  const [subcategories, setSubcategories] = useState<any[]>([])
  const [selectedDept, setSelectedDept] = useState<any>(null)
  const [loading, setLoading] = useState(true)
  const [newDeptName, setNewDeptName] = useState('')
  const [newSubName, setNewSubName] = useState('')
  const [editingId, setEditingId] = useState<string | null>(null)
  const [editingName, setEditingName] = useState('')

  const fetchDepartments = useCallback(async () => {
    setLoading(true)
    const { data } = await supabase.from('departments').select('*').order('sort_order')
    if (data) { setDepartments(data); if (!selectedDept && data.length > 0) setSelectedDept(data[0]) }
    setLoading(false)
  }, [selectedDept])

  const fetchSubcategories = useCallback(async (deptId: string) => {
    const { data } = await supabase.from('dept_subcategories').select('*').eq('department_id', deptId).order('sort_order')
    if (data) setSubcategories(data)
  }, [])

  useEffect(() => { fetchDepartments() }, []) // eslint-disable-line
  useEffect(() => { if (selectedDept) fetchSubcategories(selectedDept.id) }, [selectedDept]) // eslint-disable-line

  const addDepartment = async () => {
    if (!newDeptName.trim() || !canEdit) return
    if (!(await reportWrite('Dodavanje sektora', supabase.from('departments').insert({ name: newDeptName.trim(), sort_order: departments.length + 1 })))) return
    setNewDeptName(''); fetchDepartments()
  }

  const addSubcategory = async () => {
    if (!newSubName.trim() || !selectedDept || !canEdit) return
    if (!(await reportWrite('Dodavanje podsektora', supabase.from('dept_subcategories').insert({ department_id: selectedDept.id, name: newSubName.trim(), sort_order: subcategories.length + 1 })))) return
    setNewSubName(''); fetchSubcategories(selectedDept.id)
  }

  const updateName = async (table: string, id: string) => {
    if (!editingName.trim() || !canEdit) return
    if (!(await reportWrite('Preimenovanje', supabase.from(table).update({ name: editingName.trim() }).eq('id', id)))) return
    setEditingId(null); setEditingName('')
    if (table === 'departments') fetchDepartments()
    else if (selectedDept) fetchSubcategories(selectedDept.id)
  }

  const deleteItem = async (table: string, id: string, name: string) => {
    if (!canEdit) return

    if (table === 'departments') {
      const { count: txCount } = await supabase.from('transactions').select('id', { count: 'exact', head: true }).eq('department', name)
      if (txCount && txCount > 0) { window.alert(inUse(name, txCount, 'transakciji', 'transakcije', 'transakcija')); return }
      const { count: invCount } = await supabase.from('invoices').select('id', { count: 'exact', head: true }).eq('department', name)
      if (invCount && invCount > 0) { window.alert(inUse(name, invCount, 'fakturi', 'fakture', 'faktura')); return }
      if (!window.confirm(`Obrisati sektor „${name}“ i sve njegove podsektore?`)) return
      // Kaskadno: brisanje expense_descriptions → dept_subcategories → departments
      const { data: subs } = await supabase.from('dept_subcategories').select('id').eq('department_id', id)
      if (subs && subs.length > 0) {
        const subIds = subs.map((s: any) => s.id)
        if (!(await reportWrite('Brisanje opisa troškova', supabase.from('expense_descriptions').delete().in('dept_subcategory_id', subIds)))) return
        if (!(await reportWrite('Brisanje podsektora', supabase.from('dept_subcategories').delete().eq('department_id', id)))) return
      }
      if (!(await reportWrite('Brisanje sektora', supabase.from('departments').delete().eq('id', id)))) return
      fetchDepartments(); setSelectedDept(null); setSubcategories([])
    } else if (table === 'dept_subcategories') {
      const { count: txCount } = await supabase.from('transactions').select('id', { count: 'exact', head: true }).eq('dept_subcategory', name)
      if (txCount && txCount > 0) { window.alert(inUse(name, txCount, 'transakciji', 'transakcije', 'transakcija')); return }
      const { count: invCount } = await supabase.from('invoices').select('id', { count: 'exact', head: true }).eq('dept_subcategory', name)
      if (invCount && invCount > 0) { window.alert(inUse(name, invCount, 'fakturi', 'fakture', 'faktura')); return }
      if (!window.confirm(`Obrisati podsektor „${name}“ i sve njegove opise troškova?`)) return
      // Kaskadno: brisanje expense_descriptions → dept_subcategories
      if (!(await reportWrite('Brisanje opisa troškova', supabase.from('expense_descriptions').delete().eq('dept_subcategory_id', id)))) return
      if (!(await reportWrite('Brisanje podsektora', supabase.from('dept_subcategories').delete().eq('id', id)))) return
      if (selectedDept) fetchSubcategories(selectedDept.id)
    }
  }

  if (loading) return (
    <div style={{ padding: '20px 4px' }}>
      <SkeletonRows rows={6} height={16} gap={15} widths={[86, 58, 92, 50, 78, 66]} />
    </div>
  )

  return (
    <>
      {!canEdit && <div style={s.readOnlyBanner}>👁 Samo pregled — sektore mogu da menjaju samo administratori.</div>}
      <div style={s.twoCol}>
        <div style={s.colPanel}>
          <div style={s.colHeader}><div style={s.colTitle}>Sektori</div><span style={s.colCount}>{departments.length}</span></div>
          <div style={s.itemList}>
            {departments.map(dept => (
              <div key={dept.id} style={{ ...s.itemRow, ...(selectedDept?.id === dept.id ? s.itemRowActive : {}) }} onClick={() => setSelectedDept(dept)}>
                {editingId === dept.id ? <input style={s.inlineInput} value={editingName} onChange={e => setEditingName(e.target.value)} onKeyDown={e => { if (e.key === 'Enter') updateName('departments', dept.id) }} onClick={e => e.stopPropagation()} autoFocus /> : <span style={s.itemName}>{dept.name}</span>}
                {canEdit && (
                  <div style={s.itemActions} onClick={e => e.stopPropagation()}>
                    {editingId === dept.id ? <button style={s.saveBtn} onClick={() => updateName('departments', dept.id)}>✓</button> : <button style={s.iconBtn} onClick={() => { setEditingId(dept.id); setEditingName(dept.name) }}>✏️</button>}
                    <button style={s.deleteBtn} onClick={() => deleteItem('departments', dept.id, dept.name)}>Obriši</button>
                  </div>
                )}
              </div>
            ))}
          </div>
          {canEdit && <div style={s.addRow}><input style={s.addInput} value={newDeptName} onChange={e => setNewDeptName(e.target.value)} placeholder="Novi sektor…" onKeyDown={e => { if (e.key === 'Enter') addDepartment() }} /><button style={s.addBtn} onClick={addDepartment}>+ Dodaj</button></div>}
        </div>
        <div style={s.colPanel}>
          <div style={s.colHeader}><div style={s.colTitle}>{selectedDept ? `Podsektori — ${selectedDept.name}` : 'Izaberite sektor'}</div>{selectedDept && <span style={s.colCount}>{subcategories.length}</span>}</div>
          {!selectedDept ? <div style={s.emptyHint}>← Izaberite sektor da biste uređivali njegove podsektore</div> : (
            <>
              <div style={s.itemList}>
                {subcategories.map(sub => (
                  <div key={sub.id} style={s.itemRow}>
                    {editingId === sub.id ? <input style={s.inlineInput} value={editingName} onChange={e => setEditingName(e.target.value)} onKeyDown={e => { if (e.key === 'Enter') updateName('dept_subcategories', sub.id) }} autoFocus /> : <span style={s.itemName}>{sub.name}</span>}
                    {canEdit && <div style={s.itemActions}>{editingId === sub.id ? <button style={s.saveBtn} onClick={() => updateName('dept_subcategories', sub.id)}>✓</button> : <button style={s.iconBtn} onClick={() => { setEditingId(sub.id); setEditingName(sub.name) }}>✏️</button>}<button style={s.deleteBtn} onClick={() => deleteItem('dept_subcategories', sub.id, sub.name)}>Obriši</button></div>}
                  </div>
                ))}
              </div>
              {canEdit && <div style={s.addRow}><input style={s.addInput} value={newSubName} onChange={e => setNewSubName(e.target.value)} placeholder="Novi podsektor…" onKeyDown={e => { if (e.key === 'Enter') addSubcategory() }} /><button style={s.addBtn} onClick={addSubcategory}>+ Dodaj</button></div>}
            </>
          )}
        </div>
      </div>
    </>
  )
}

// ── Expense Descriptions Tab ─────────────────────────────
function DescriptionsTab({ canEdit }: { canEdit: boolean }) {
  const [subcategories, setSubcategories] = useState<any[]>([])
  const [descriptions, setDescriptions] = useState<any[]>([])
  const [selectedSub, setSelectedSub] = useState<any>(null)
  const [loading, setLoading] = useState(true)
  const [searchSub, setSearchSub] = useState('')
  const [newDescName, setNewDescName] = useState('')
  const [editingId, setEditingId] = useState<string | null>(null)
  const [editingName, setEditingName] = useState('')

  const fetchSubcategories = useCallback(async () => {
    setLoading(true)
    const { data } = await supabase.from('dept_subcategories').select('*, departments(name)').order('name')
    if (data) setSubcategories(data)
    setLoading(false)
  }, [])

  const fetchDescriptions = useCallback(async (subId: string) => {
    const { data } = await supabase.from('expense_descriptions').select('*').eq('dept_subcategory_id', subId).order('sort_order')
    if (data) setDescriptions(data)
  }, [])

  useEffect(() => { fetchSubcategories() }, []) // eslint-disable-line
  useEffect(() => { if (selectedSub) fetchDescriptions(selectedSub.id) }, [selectedSub]) // eslint-disable-line

  const addDescription = async () => {
    if (!newDescName.trim() || !selectedSub || !canEdit) return
    if (!(await reportWrite('Dodavanje opisa troška', supabase.from('expense_descriptions').insert({ dept_subcategory_id: selectedSub.id, name: newDescName.trim(), sort_order: descriptions.length + 1 })))) return
    setNewDescName(''); fetchDescriptions(selectedSub.id)
  }

  const updateName = async (id: string) => {
    if (!editingName.trim() || !canEdit) return
    if (!(await reportWrite('Preimenovanje', supabase.from('expense_descriptions').update({ name: editingName.trim() }).eq('id', id)))) return
    setEditingId(null); setEditingName('')
    if (selectedSub) fetchDescriptions(selectedSub.id)
  }

  const deleteDesc = async (id: string, name: string) => {
    if (!canEdit) return
    const { count: txCount } = await supabase.from('transactions').select('id', { count: 'exact', head: true }).eq('expense_description', name)
    if (txCount && txCount > 0) { window.alert(inUse(name, txCount, 'transakciji', 'transakcije', 'transakcija')); return }
    const { count: invCount } = await supabase.from('invoices').select('id', { count: 'exact', head: true }).eq('expense_description', name)
    if (invCount && invCount > 0) { window.alert(inUse(name, invCount, 'fakturi', 'fakture', 'faktura')); return }
    if (!window.confirm(`Obrisati opis "${name}"?`)) return
    if (!(await reportWrite('Brisanje opisa troška', supabase.from('expense_descriptions').delete().eq('id', id)))) return
    if (selectedSub) fetchDescriptions(selectedSub.id)
  }

  const filteredSubs = subcategories.filter(sub =>
    !searchSub || sub.name.toLowerCase().includes(searchSub.toLowerCase()) ||
    (sub.departments?.name || '').toLowerCase().includes(searchSub.toLowerCase())
  )

  if (loading) return <div style={s.loading}>Učitavanje…</div>

  return (
    <>
      {!canEdit && <div style={s.readOnlyBanner}>👁 Samo pregled — opise mogu da menjaju samo administratori.</div>}
      <div style={s.twoCol}>
        <div style={s.colPanel}>
          <div style={s.colHeader}><div style={s.colTitle}>Podsektori</div><span style={s.colCount}>{subcategories.length}</span></div>
          <div style={{ padding: '8px 12px', borderBottom: '0.5px solid rgba(255,255,255,0.05)' }}>
            <input style={{ ...s.addInput, width: '100%', boxSizing: 'border-box' as const }} value={searchSub} onChange={e => setSearchSub(e.target.value)} placeholder="Pretraga podsektora…" />
          </div>
          <div style={s.itemList}>
            {filteredSubs.map(sub => (
              <div key={sub.id} style={{ ...s.itemRow, ...(selectedSub?.id === sub.id ? s.itemRowActive : {}) }} onClick={() => setSelectedSub(sub)}>
                <div><div style={s.itemName}>{sub.name}</div><div style={{ fontSize: '10px', color: 'rgba(255,255,255,0.30)' }}>{sub.departments?.name}</div></div>
              </div>
            ))}
          </div>
        </div>
        <div style={s.colPanel}>
          <div style={s.colHeader}><div style={s.colTitle}>{selectedSub ? `Opisi troškova — ${selectedSub.name}` : 'Izaberite podsektor'}</div>{selectedSub && <span style={s.colCount}>{descriptions.length}</span>}</div>
          {!selectedSub ? <div style={s.emptyHint}>← Izaberite podsektor da biste uređivali njegove opise troškova</div> : (
            <>
              <div style={s.itemList}>
                {descriptions.map(desc => (
                  <div key={desc.id} style={s.itemRow}>
                    {editingId === desc.id ? <input style={s.inlineInput} value={editingName} onChange={e => setEditingName(e.target.value)} onKeyDown={e => { if (e.key === 'Enter') updateName(desc.id) }} autoFocus /> : <span style={s.itemName}>{desc.name}</span>}
                    {canEdit && <div style={s.itemActions}>{editingId === desc.id ? <button style={s.saveBtn} onClick={() => updateName(desc.id)}>✓</button> : <button style={s.iconBtn} onClick={() => { setEditingId(desc.id); setEditingName(desc.name) }}>✏️</button>}<button style={s.deleteBtn} onClick={() => deleteDesc(desc.id, desc.name)}>Obriši</button></div>}
                  </div>
                ))}
              </div>
              {canEdit && <div style={s.addRow}><input style={s.addInput} value={newDescName} onChange={e => setNewDescName(e.target.value)} placeholder="Novi opis…" onKeyDown={e => { if (e.key === 'Enter') addDescription() }} /><button style={s.addBtn} onClick={addDescription}>+ Dodaj</button></div>}
            </>
          )}
        </div>
      </div>
    </>
  )
}

// Izvezeno da bi tabovi u zasebnim fajlovima koristili isti vizuelni jezik
// (colPanel / colHeader / itemRow / addRow …) umjesto sopstvenih stilova.
export const settingsStyles: Record<string, React.CSSProperties> = {
  // The background lives in `.app-surface` rather than here: an inline
  // colour would paint straight over it.
  root: { minHeight: '100vh', fontFamily: "'Inter', system-ui, sans-serif" },
  body: { padding: '24px 28px' },
  pageHeader: { display: 'flex', alignItems: 'flex-start', justifyContent: 'space-between', marginBottom: '1.5rem' },
  pageTitle: { fontFamily: "'DM Serif Display', Georgia, serif", fontSize: '24px', fontWeight: '400', color: '#DCE9F6', marginBottom: '4px' },
  pageSub: { fontSize: '13px', color: '#7A9BB8' },
  tabBar: { display: 'flex', gap: 0, borderBottom: '1px solid rgba(255,255,255,0.075)', marginBottom: '1.5rem', overflowX: 'auto' as const },
  tab: { fontFamily: 'system-ui,sans-serif', fontSize: '13px', padding: '10px 20px', border: 'none', background: 'transparent', color: '#7A9BB8', cursor: 'pointer', borderBottom: '2px solid transparent', marginBottom: '-0.5px', whiteSpace: 'nowrap' as const },
  tabActive: { color: '#DCE9F6', borderBottomColor: '#00D47E', fontWeight: '500' },
  readOnlyBanner: { background: 'rgba(245,166,35,0.10)', border: '1px solid rgba(245,166,35,0.3)', borderRadius: '8px', padding: '8px 14px', fontSize: '12px', color: '#F5A623', marginBottom: '16px' },
  twoCol: { display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '16px', alignItems: 'start' },
  colPanel: { background: '#0D1B2C', border: '1px solid rgba(255,255,255,0.075)', borderRadius: '10px', overflow: 'hidden' },
  colHeader: { display: 'flex', alignItems: 'center', justifyContent: 'space-between', padding: '12px 16px', borderBottom: '1px solid rgba(255,255,255,0.075)', background: '#111F30' },
  colTitle: { fontSize: '13px', fontWeight: '500', color: '#DCE9F6' },
  colCount: { fontSize: '11px', fontWeight: '500', padding: '2px 8px', borderRadius: '10px', background: 'rgba(0,212,126,0.12)', color: '#00D47E' },
  itemList: { maxHeight: '420px', overflowY: 'auto' as const },
  itemRow: { display: 'flex', alignItems: 'center', justifyContent: 'space-between', padding: '9px 14px', borderBottom: '0.5px solid rgba(255,255,255,0.05)', cursor: 'pointer' },
  itemRowActive: { background: 'rgba(0,212,126,0.06)', borderLeft: '3px solid #00D47E' },
  itemName: { fontSize: '13px', color: '#DCE9F6' },
  itemActions: { display: 'flex', gap: '4px', flexShrink: 0 },
  iconBtn: { background: 'none', border: 'none', cursor: 'pointer', fontSize: '13px', padding: '2px 4px', borderRadius: '4px', opacity: 0.6 },
  saveBtn: { background: '#00D47E', border: 'none', cursor: 'pointer', fontSize: '12px', padding: '2px 8px', borderRadius: '4px', color: '#060E1A' },
  inlineInput: { fontFamily: 'system-ui,sans-serif', fontSize: '13px', padding: '4px 8px', border: '1px solid #00D47E', borderRadius: '6px', outline: 'none', flex: 1, color: '#DCE9F6', background: '#111F30' },
  addRow: { display: 'flex', gap: '6px', padding: '10px 12px', borderTop: '1px solid rgba(255,255,255,0.075)', background: '#111F30' },
  addInput: { fontFamily: 'system-ui,sans-serif', fontSize: '13px', padding: '7px 10px', border: '1px solid rgba(255,255,255,0.10)', borderRadius: '8px', outline: 'none', flex: 1, color: '#DCE9F6', background: '#0D1B2C' },
  addBtn: { fontFamily: 'system-ui,sans-serif', fontSize: '12px', padding: '7px 14px', border: 'none', borderRadius: '8px', background: '#00D47E', color: '#060E1A', cursor: 'pointer', whiteSpace: 'nowrap' as const },
  emptyHint: { padding: '2rem', textAlign: 'center' as const, color: 'rgba(255,255,255,0.30)', fontSize: '13px' },
  loading: { padding: '2rem', textAlign: 'center' as const, color: '#7A9BB8', fontSize: '14px' },
  formField: { display: 'flex', flexDirection: 'column' as const, gap: '4px' },
  formLabel: { fontSize: '10px', fontWeight: '500', color: 'rgba(255,255,255,0.30)', textTransform: 'uppercase' as const, letterSpacing: '0.07em' },
  formInput: { fontFamily: 'system-ui,sans-serif', fontSize: '13px', padding: '7px 10px', border: '1px solid rgba(255,255,255,0.10)', borderRadius: '8px', outline: 'none', color: '#DCE9F6', background: '#111F30' },
  deleteBtn: { fontFamily: 'system-ui,sans-serif', fontSize: '11px', fontWeight: '500', padding: '2px 8px', border: '1px solid rgba(255,91,90,0.4)', borderRadius: '5px', background: 'rgba(255,91,90,0.10)', color: '#FF5B5A', cursor: 'pointer', flexShrink: 0 },
}

const s = settingsStyles
