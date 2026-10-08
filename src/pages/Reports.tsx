import React, { useState, useEffect, useCallback } from 'react'
import { useNav } from '../navigation'
import type { Page } from '../navigation'
import { supabase } from '../supabase'
import { useCompanies } from '../contexts/CompaniesContext'
import { SkeletonRows } from '../components/motion'
import { fetchAllPages, fetchByIds, countRows } from '../utils/fetchAllPages'
import { outstandingOwn } from '../services/settleInvoice'
import { toRsd, toEur } from '../services/allocationDisplay'
import { fmtMoney, fmtNum } from '../utils/formatters'
import { useDisplayCurrency } from '../contexts/DisplayCurrencyContext'
import { findAccountByNumber, defaultAccount } from '../services/partnerAccountChoice'

// ── Halcom TKDIS format generator ────────────────────────
const HALCOM_SIFRE = [
  { value: '221', label: '221 – Bezgotovinsko (robe i usluge)' },
  { value: '240', label: '240 – Zarade' },
  { value: '253', label: '253 – Javni prihodi' },
  { value: '254', label: '254 – Porezi i doprinosi (objedinjena naplata)' },
  { value: '260', label: '260 – Premije osiguranja' },
  { value: '263', label: '263 – Ostali transferi' },
  { value: '270', label: '270 – Short-term loans' },
  { value: '271', label: '271 – Long-term loans' },
]

function padR(s: string, n: number): string {
  return (s || '').substring(0, n).padEnd(n, ' ')
}
function cleanAccount(acc: string): string {
  // Halcom TKDIS format: tačno 18 cifara bez crtica
  // NBS format sa crticama: BBB-CCCCCCCCCCCCCCC (3+15) ILI BBB-CCCCCCCCCC-KK (stari)
  // Uvijek normalizujemo na 18 cifara: 3 (banka) + 13 (core) + 2 (ctrl) = 18
  const raw = (acc || '').replace(/\s/g, '')
  const digits = raw.replace(/[^0-9]/g, '')
  const parts = raw.split('-').filter(p => p.length > 0)

  if (parts.length === 3) {
    // Stari format sa crticama: BBB-CORE-KK
    const bank = parts[0].padStart(3, '0').slice(-3)
    const ctrl = parts[2].padStart(2, '0').slice(-2)
    const core = parts[1].padStart(13, '0').slice(-13)  // 13 cifara = 18 ukupno
    return bank + core + ctrl
  }
  if (parts.length === 2) {
    // Format BBB-CCCCCCCCCCCCCCC (novi NBS, 3+15)
    const bank = parts[0].padStart(3, '0').slice(-3)
    const rest = parts[1].padStart(15, '0').slice(-15)
    return bank + rest
  }
  // Već bez crtica — pad do 18 cifara
  if (digits.length >= 18) return digits.slice(-18)
  if (digits.length > 5) {
    const bank = digits.slice(0, 3)
    const ctrl = digits.slice(-2)
    const core = digits.slice(3, -2).padStart(13, '0').slice(-13)
    return bank + core + ctrl
  }
  return digits
}
function fmtDatumDDMMYY(date: Date): string {
  const d = String(date.getDate()).padStart(2, '0')
  const m = String(date.getMonth() + 1).padStart(2, '0')
  const y = String(date.getFullYear()).slice(-2)
  return `${d}${m}${y}`
}

/**
 * What a payment order should be written for.
 *
 * The outstanding figure where the panel has one — an invoice part paid is
 * owed the rest of itself, not the whole of itself again.
 */
const payable = (inv: any): number =>
  typeof inv.outstanding_own === 'number' ? inv.outstanding_own : (inv.amount || 0)

function exportHalcom(invoices: any[], companyBankAccount: any, companyProfile: any, companyName: string, halcomSifra: string = '221') {
  if (!companyBankAccount) {
    alert('No company bank account found. Add one under Settings → Company profiles → Bank accounts.')
    return
  }
  const missing = invoices.filter(i => !i.selected_account_number)
  if (missing.length > 0) {
    alert(`${missing.length} invoice(s) have no payee account. Choose an account for each one.`)
    return
  }
  const racunPlatilac = cleanAccount(companyBankAccount.account_number)
  const imeFirma = (companyProfile?.full_legal_name || companyName).toUpperCase()
  const gradFirma = (companyProfile?.city || 'BEOGRAD').toUpperCase()
  const datum = fmtDatumDDMMYY(new Date())
  const brNaloga = invoices.length
  // WHAT IS STILL OWED, not what was billed. This paid `amount` even on an
  // invoice already part paid, so the panel said one figure and the file it
  // produced ordered another — and the one the bank would have acted on was
  // the larger of the two.
  const ukupanIznosPare = invoices.reduce((s, i) => s + Math.round(payable(i) * 100), 0)
  const lines: string[] = []
  lines.push(padR(racunPlatilac, 18) + padR(imeFirma, 35) + padR(gradFirma, 10) + datum + ' '.repeat(98) + 'MULTI E-BANK0')
  lines.push(padR(racunPlatilac, 18) + padR(imeFirma, 35) + padR(gradFirma, 10) + String(ukupanIznosPare).padStart(15, '0') + '0000' + String(brNaloga) + ' '.repeat(96) + '9')
  invoices.forEach(inv => {
    const iznos = Math.round(payable(inv) * 100)
    const svrhaText = `UPLATA PO FAKTURI ${inv.invoice_number || ''}`.toUpperCase().substring(0, 34)
    const svrhaZona = (' '.repeat(25) + svrhaText).padEnd(61, ' ')
    const racunPrimaoca = cleanAccount(inv.selected_account_number || '')
    const poziv = padR(inv.reference_number || inv.invoice_number || '', 23)
    lines.push(padR(racunPrimaoca, 18) + padR((inv.partner_name || '').toUpperCase(), 35) + padR((inv.partner_address || '').toUpperCase(), 35) + padR((inv.partner_city || '').toUpperCase(), 10) + '0' + svrhaZona + '00000 ' + padR(halcomSifra, 3) + '  ' + String(iznos).padStart(13, '0') + '  ' + poziv + datum + '01')
  })
  const content = lines.join('\r\n') + '\r\n\x1a'
  const bytes = new Uint8Array(content.length)
  for (let i = 0; i < content.length; i++) bytes[i] = content.charCodeAt(i) & 0xff
  const blob = new Blob([bytes], { type: 'application/octet-stream' })
  const url = URL.createObjectURL(blob)
  const a = document.createElement('a')
  a.href = url
  a.download = `nalozi_${datum}.txt`
  a.click()
  URL.revokeObjectURL(url)
}

// ── Unpaid Invoices Panel ────────────────────────────────
function UnpaidInvoicesPanel({ onClose }: { onClose: () => void }) {
  // What is owed prints in the viewer's display currency, beside the bill's own.
  const { currency, pick, format } = useDisplayCurrency()
  const fmt = (n: number | null) => format(n, 0)
  const [invoices, setInvoices] = useState<any[]>([])
  const [loading, setLoading] = useState(true)
  const [sortBy, setSortBy] = useState<'due_date' | 'amount' | 'partner'>('due_date')
  const [filterStatus, setFilterStatus] = useState<'all' | 'overdue' | 'upcoming'>('all')
  const [search, setSearch] = useState('')
  const [selected, setSelected] = useState<Set<string>>(new Set())
  const [bankAccounts, setBankAccounts] = useState<any[]>([])
  const [selectedBankId, setSelectedBankId] = useState('')
  const [halcomSifra, setHalcomSifra] = useState('221')
  const [companyProfile, setCompanyProfile] = useState<any>(null)
  const { defaultCompany, loading: companiesLoading } = useCompanies()
  const [invoiceAccountMap, setInvoiceAccountMap] = useState<Record<string, { account_number: string; model: string; bank_name: string }>>({})
  const [partnerAccountsMap, setPartnerAccountsMap] = useState<Record<string, any[]>>({})
  const [asOfDate, setAsOfDate] = useState('')
  const today = new Date().toISOString().split('T')[0]

  useEffect(() => {
    const load = async () => {
      setLoading(true)
      if (companiesLoading) return
      const compData = defaultCompany
      if (!compData) { setLoading(false); return }
      const { data: bankData } = await supabase.from('company_bank_accounts').select('*').eq('company_id', compData.id).eq('currency', 'RSD').order('is_primary', { ascending: false })
      if (bankData && bankData.length > 0) { setBankAccounts(bankData); setSelectedBankId((bankData.find(b => b.is_primary) || bankData[0]).id) }
      const { data: profData } = await supabase.from('company_profiles').select('full_legal_name, city, address').eq('company_id', compData.id).single()
      if (profData) setCompanyProfile(profData)
      // ── Which invoices are open ────────────────────────────────────────
      //
      // The view decides, not `invoices.status`. This page used to select on
      // the stored column and then overwrite the computed status with it —
      // it fetched `calculated_status` in the same breath and threw it away.
      // So every screen in the app read one answer and this one read another,
      // and an invoice closed by a transaction went on being listed here.
      //
      // The stored column is written by the app at post time and never
      // revisited; the view is derived from the links every time it is read.
      // Only one of those can be wrong about a payment recorded afterwards.
      //
      // The full invoice row is still fetched, because the Halcom export needs
      // `account_number`, `model` and `reference_number`, and the payment
      // slips need the partner's address and city. None of those are in the
      // view — it decides which invoices, not what is printed on them.
      const openRows = await fetchAllPages<any>((from, to) =>
        supabase.from('v_invoice_status')
          .select('id, calculated_status, amount, paid_amount, remaining_rsd, remaining_eur')
          .eq('company_id', compData.id)
          .in('calculated_status', ['unpaid', 'partial'])
          .order('due_date', { ascending: true }).order('id')
          .range(from, to))

      const openById = new Map<string, any>(openRows.map(r => [r.id, r]))
      const invData = await fetchByIds<any>(
        openRows.map(r => r.id),
        chunk => supabase.from('invoices')
          .select('*, partners(id, name, address, city)')
          .in('id', chunk)
          .order('due_date', { ascending: true }))

      const invDataWithRemaining = (invData || [])
        .map((i: any) => {
          const open = openById.get(i.id)
          const partial = open?.calculated_status === 'partial'
          return {
            ...i,
            calculated_status: open?.calculated_status ?? i.status,
            // Nothing is owed on an unpaid invoice yet — the whole amount is.
            // `remaining_*` only means something once something is paid.
            remaining_rsd: partial ? (open?.remaining_rsd ?? i.amount_rsd) : 0,
            remaining_eur: partial ? (open?.remaining_eur ?? i.amount_eur) : 0,
            // WHAT IS ACTUALLY OWED, in the currency the bill was written in.
            //
            // `amount - paid_amount`, from the column the settled/partial rule
            // is decided on. Mintflow showed `remaining_usd * exchange_rate`
            // instead, which is the dollar remainder — itself the difference
            // between the invoice's rate and the payment's — multiplied by a
            // THIRD rate. Three rates in one figure, on a screen that
            // generates payment orders.
            outstanding_own: partial
              ? outstandingOwn({ ...i, paid_amount: open?.paid_amount ?? 0 })
              : (i.amount || 0),
          }
        })
        // `fetchByIds` returns chunk by chunk, so the ordering within a chunk
        // survives and the ordering across them does not.
        .sort((a: any, b: any) => (a.due_date || '').localeCompare(b.due_date || ''))
      if (invData.length > 0) {
        setInvoices(invDataWithRemaining)
        const partnerIds = [...new Set(invData.map(i => i.partner_id).filter(Boolean))]
        if (partnerIds.length > 0) {
          const { data: pAccounts } = await supabase.from('partner_accounts').select('*').in('partner_id', partnerIds).eq('currency', 'RSD').order('is_primary', { ascending: false })
          if (pAccounts) {
            const paMap: Record<string, any[]> = {}
            pAccounts.forEach(pa => { if (!paMap[pa.partner_id]) paMap[pa.partner_id] = []; paMap[pa.partner_id].push(pa) })
            setPartnerAccountsMap(paMap)
            const accMap: Record<string, { account_number: string; model: string; bank_name: string }> = {}
            invData.forEach(inv => {
              if (!inv.partner_id) return
              const accounts = paMap[inv.partner_id] || []
              // THE BILL'S OWN ACCOUNT WINS. A supplier may have several,
              // and the one on the invoice is the one they asked to be paid
              // at — the primary is only the answer where the bill names none.
              if (inv.account_number) {
                // Matched back to the saved account so the bank can be named.
                // It said "Iz fakture" before, which is where the number came
                // from and not which bank it is at — the one thing a payment
                // order wants to show beside an account number.
                const chosen = findAccountByNumber(accounts, inv.account_number)
                accMap[inv.id] = {
                  account_number: inv.account_number,
                  model: inv.model || chosen?.model || '97',
                  bank_name: chosen?.bank_name || 'From the invoice',
                }
                return
              }
              const primary = defaultAccount(accounts)
              if (primary) accMap[inv.id] = { account_number: primary.account_number || '', model: primary.model || inv.model || '97', bank_name: primary.bank_name || '' }
            })
            setInvoiceAccountMap(accMap)
          }
        }
      }
      setLoading(false)
    }
    load()
  }, [defaultCompany, companiesLoading]) // eslint-disable-line react-hooks/exhaustive-deps

  const effectiveDate = asOfDate || today
  const filtered = invoices
    .filter(inv => {
      const partner = inv.partners?.name || ''
      const matchSearch = !search || partner.toLowerCase().includes(search.toLowerCase()) || (inv.invoice_number || '').toLowerCase().includes(search.toLowerCase())
      // asOf filter: faktura mora biti izdata prije ili na taj datum i nije bila plaćena tada
      const matchAsOf = !asOfDate || (inv.invoice_date <= asOfDate)
      const isOverdue = inv.due_date && inv.due_date < effectiveDate
      const matchStatus = filterStatus === 'all' || (filterStatus === 'overdue' && isOverdue) || (filterStatus === 'upcoming' && !isOverdue)
      return matchSearch && matchStatus && matchAsOf
    })
    .sort((a, b) => {
      if (sortBy === 'amount') return (pick(b) ?? 0) - (pick(a) ?? 0)
      if (sortBy === 'partner') return (a.partners?.name || '').localeCompare(b.partners?.name || '')
      return (a.due_date || '9999') < (b.due_date || '9999') ? -1 : 1
    })

  // The display-currency figures are derived from what is owed in the bill's
  // own currency, at the invoice's own rates, so the two columns cannot
  // disagree about the same invoice. Null where the invoice carries no EUR
  // figure (no eur_rate) — printed as a dash, counted as zero in the totals.
  const owed = (i: any): number | null => (i.calculated_status === 'partial'
    ? (currency === 'RSD' ? toRsd(i.outstanding_own || 0, i) : toEur(i.outstanding_own || 0, i))
    : pick(i))
  const totalUnpaid = filtered.reduce((s, i) => s + (owed(i) ?? 0), 0)
  const overdueCount = filtered.filter(i => i.due_date && i.due_date < effectiveDate).length
  const selectedInvoices = filtered.filter(i => selected.has(i.id))
  const selectedBank = bankAccounts.find(b => b.id === selectedBankId)

  // Međuzbir selektovanih
  const selectedTotalRsd = selectedInvoices.reduce((s, i) => s + (i.outstanding_own || 0), 0)
  const selectedTotalBook = selectedInvoices.reduce((s, i) => s + (owed(i) ?? 0), 0)

  const toggleSelect = (id: string) => { setSelected(prev => { const n = new Set(prev); n.has(id) ? n.delete(id) : n.add(id); return n }) }
  const toggleAll = () => { if (selected.size === filtered.length) setSelected(new Set()); else setSelected(new Set(filtered.map(i => i.id))) }

  const handleAccountSelect = (invId: string, accountId: string, partnerId: string) => {
    const accounts = partnerAccountsMap[partnerId] || []
    const acc = accounts.find(a => a.id === accountId)
    if (acc) setInvoiceAccountMap(prev => ({ ...prev, [invId]: { account_number: acc.account_number, model: acc.model || '97', bank_name: acc.bank_name || '' } }))
  }

  const handleExport = () => {
    const toExport = (selectedInvoices.length > 0 ? selectedInvoices : filtered).map(i => ({
      ...i, partner_name: i.partners?.name, partner_address: i.partners?.address || '', partner_city: i.partners?.city || '',
      selected_account_number: invoiceAccountMap[i.id]?.account_number || i.account_number || '',
      selected_model: invoiceAccountMap[i.id]?.model || i.model || '97',
    }))
    exportHalcom(toExport, selectedBank, companyProfile, defaultCompany?.name || '', halcomSifra)
  }

  const daysUntilDue = (dueDate: string | null) => {
    if (!dueDate) return null
    return Math.ceil((new Date(dueDate).getTime() - new Date(effectiveDate).getTime()) / 86400000)
  }

  const missingAccountCount = filtered.filter(i => !invoiceAccountMap[i.id]?.account_number && !i.account_number).length

  return (
    <div style={ps.overlay} onClick={onClose}>
      <div style={ps.panel} onClick={e => e.stopPropagation()}>

        {/* ── Header ── */}
        <div style={ps.header}>
          <div>
            <div style={{ fontSize: '10px', fontWeight: '700', color: '#F5A623', letterSpacing: '0.12em', textTransform: 'uppercase' as const, marginBottom: '5px' }}>
              Unpaid invoices
            </div>
            <div style={ps.headerTitle}>{defaultCompany?.name || 'No company set up'}</div>
            <div style={ps.headerSub}>
              {loading ? 'Loading...' : (
                <span>
                  <span style={{ fontFamily: "'DM Mono', monospace", color: '#F5A623', fontWeight: '600' }}>{fmt(totalUnpaid)}</span>
                  <span style={{ marginLeft: '10px', color: 'rgba(255,255,255,0.30)' }}>· {filtered.length} faktura</span>
                  {overdueCount > 0 && <span style={{ marginLeft: '8px', color: '#FF5B5A', fontWeight: '600' }}>· {overdueCount} overdue</span>}
                </span>
              )}
            </div>
          </div>
          <button style={ps.closeBtn} onClick={onClose}>×</button>
        </div>

        {/* ── Toolbar ── */}
        <div style={ps.toolbar}>
          <input style={ps.searchInput} placeholder="Search partner or invoice #..." value={search} onChange={e => setSearch(e.target.value)} />
          <select style={ps.sel} value={filterStatus} onChange={e => setFilterStatus(e.target.value as any)}>
            <option value="all">All unpaid</option>
            <option value="overdue">Overdue only</option>
            <option value="upcoming">Upcoming</option>
          </select>
          <select style={ps.sel} value={sortBy} onChange={e => setSortBy(e.target.value as any)}>
            <option value="due_date">Sort: Due date</option>
            <option value="amount">Sort: Amount</option>
            <option value="partner">Sort: Partner</option>
          </select>
          <div style={{ display: 'flex', alignItems: 'center', gap: '6px', borderLeft: '1px solid rgba(255,255,255,0.08)', paddingLeft: '10px' }}>
            <span style={{ fontSize: '11px', color: 'rgba(255,255,255,0.35)', whiteSpace: 'nowrap' as const }}>Stanje na dan:</span>
            <input
              type="date"
              style={{ ...ps.sel, fontSize: '12px', padding: '5px 8px' }}
              value={asOfDate}
              onChange={e => setAsOfDate(e.target.value)}
            />
            {asOfDate && (
              <button
                style={{ fontFamily: "'Inter',sans-serif", fontSize: '11px', padding: '5px 8px', border: '1px solid rgba(255,255,255,0.1)', borderRadius: '6px', background: 'transparent', color: '#7A9BB8', cursor: 'pointer' }}
                onClick={() => setAsOfDate('')}>✕</button>
            )}
          </div>
        </div>

        {/* ── Subtotal of the selection ── */}
        {selected.size > 0 && (
          <div style={{ display: 'flex', alignItems: 'center', gap: '16px', padding: '10px 18px', background: 'rgba(0,212,126,0.08)', borderBottom: '1px solid rgba(0,212,126,0.2)', flexShrink: 0 }}>
            <div style={{ fontSize: '11px', fontWeight: '700', color: '#00D47E', letterSpacing: '0.08em', textTransform: 'uppercase' as const }}>
              ✓ {selected.size} selektovano
            </div>
            <div style={{ display: 'flex', gap: '20px', flex: 1 }}>
              <div>
                <div style={{ fontSize: '10px', color: 'rgba(255,255,255,0.3)', marginBottom: '2px' }}>Total RSD</div>
                <div style={{ fontFamily: "'DM Mono',monospace", fontSize: '15px', fontWeight: '600', color: '#E8F1FB' }}>
                  {fmtNum(selectedTotalRsd)} RSD
                </div>
              </div>
              {currency !== 'RSD' && (
                <div>
                  <div style={{ fontSize: '10px', color: 'rgba(255,255,255,0.3)', marginBottom: '2px' }}>Total {currency}</div>
                  <div style={{ fontFamily: "'DM Mono',monospace", fontSize: '15px', fontWeight: '600', color: '#00D47E' }}>
                    {fmt(selectedTotalBook)}
                  </div>
                </div>
              )}
              <div style={{ marginLeft: 'auto', display: 'flex', alignItems: 'center', gap: '8px' }}>
                <button
                  style={{ fontFamily: "'Inter',sans-serif", fontSize: '11px', padding: '5px 12px', border: '1px solid rgba(255,255,255,0.12)', borderRadius: '6px', background: 'transparent', color: '#7A9BB8', cursor: 'pointer' }}
                  onClick={() => setSelected(new Set())}>Clear selection</button>
              </div>
            </div>
          </div>
        )}

        {/* ── Export bar ── */}
        <div style={ps.exportBar}>
          <div style={{ display: 'flex', flexDirection: 'column' as const, gap: '4px' }}>
            <div style={{ fontSize: '12px', color: '#854F0B', fontWeight: '600' }}>
              Hal E-Bank — nalog za prenos (TKDIS format)
              {selected.size > 0 && <span style={{ marginLeft: '8px', color: '#7A9BB8', fontWeight: '400' }}>({selected.size} selektovano)</span>}
            </div>
            {bankAccounts.length === 0 ? (
              <div style={{ fontSize: '11px', color: '#FF5B5A' }}>⚠ No RSD company account found</div>
            ) : (
              <div style={{ fontSize: '11px', color: '#7A6030' }}>
                Platilac: {selectedBank?.bank_name} · {selectedBank?.account_number}
                {missingAccountCount > 0 && <span style={{ marginLeft: '8px', color: '#FF5B5A', fontWeight: '600' }}>⚠ {missingAccountCount} without an account</span>}
              </div>
            )}
          </div>
          <div style={{ display: 'flex', gap: '8px', alignItems: 'center' }}>
            {bankAccounts.length > 1 && (
              <select style={{ ...ps.sel, fontSize: '11px' }} value={selectedBankId} onChange={e => setSelectedBankId(e.target.value)}>
                {bankAccounts.map(b => <option key={b.id} value={b.id}>{b.bank_name}{b.is_primary ? ' ★' : ''}</option>)}
              </select>
            )}
            <select style={{ ...ps.sel, fontSize: '11px' }} value={halcomSifra} onChange={e => setHalcomSifra(e.target.value)}>
              {HALCOM_SIFRE.map(s => <option key={s.value} value={s.value}>{s.label}</option>)}
            </select>
            <button style={{ ...ps.exportBtn, opacity: bankAccounts.length === 0 ? 0.5 : 1 }} onClick={handleExport} disabled={bankAccounts.length === 0}>
              ↓ Export {selected.size > 0 ? `${selected.size}` : 'all'} naloga
            </button>
          </div>
        </div>

        {/* ── Table ── */}
        <div style={ps.tableWrap}>
          {loading ? (
            <div style={{ padding: '20px 18px' }}>
              <SkeletonRows rows={8} height={15} gap={14}
                widths={[80, 64, 92, 50, 84, 58, 88, 46]} />
            </div>
          ) : filtered.length === 0 ? (
            <div style={{ padding: '80px', textAlign: 'center' as const }}>
              <div style={{ fontSize: '32px', marginBottom: '12px' }}>✓</div>
              <div style={{ fontSize: '15px', fontWeight: '500', color: '#E8F1FB', marginBottom: '4px' }}>No unpaid invoices.</div>
              <div style={{ fontSize: '12px', color: '#7A9BB8' }}>Every invoice is settled</div>
            </div>
          ) : (
            <table style={ps.table}>
              <thead>
                <tr style={ps.thead}>
                  <th style={ps.th}>
                    <input type="checkbox" checked={selected.size === filtered.length && filtered.length > 0} onChange={toggleAll} style={{ cursor: 'pointer', accentColor: '#00D47E' }} />
                  </th>
                  <th style={ps.th}>Due date</th>
                  <th style={ps.th}>Partner</th>
                  <th style={ps.th}>Invoice no.</th>
                  <th style={ps.th}>Type</th>
                  <th style={{ ...ps.th, textAlign: 'right' as const }}>Amount</th>
                  <th style={{ ...ps.th, textAlign: 'right' as const }}>{currency}</th>
                  <th style={ps.th}>Payee account</th>
                  <th style={ps.th}>Remaining</th>
                </tr>
              </thead>
              <tbody>
                {filtered.map((inv, i) => {
                  const isOverdue = inv.due_date && inv.due_date < effectiveDate
                  const days = daysUntilDue(inv.due_date)
                  const isSelected = selected.has(inv.id)
                  const partnerId = inv.partner_id
                  const partnerAccounts = partnerAccountsMap[partnerId] || []
                  const selectedAcc = invoiceAccountMap[inv.id]
                  const hasAccount = !!(selectedAcc?.account_number || inv.account_number)
                  return (
                    <tr key={inv.id} style={{
                      ...ps.tr,
                      background: isSelected
                        ? 'rgba(245,166,35,0.08)'
                        : isOverdue
                        ? 'rgba(255,91,90,0.05)'
                        : i % 2 === 0 ? '#0D1B2C' : '#0B1826',
                    }}>
                      <td style={ps.td}>
                        <input type="checkbox" checked={isSelected} onChange={() => toggleSelect(inv.id)} style={{ cursor: 'pointer', accentColor: '#00D47E' }} />
                      </td>
                      <td style={ps.td}>
                        <span style={{ fontSize: '12px', fontWeight: isOverdue ? '600' : '400', color: isOverdue ? '#FF5B5A' : '#DCE9F6', whiteSpace: 'nowrap' as const }}>
                          {inv.due_date || '—'}
                        </span>
                      </td>
                      <td style={ps.td}>
                        <span style={{ fontSize: '13px', fontWeight: '500', color: '#E8F1FB' }}>{inv.partners?.name || '—'}</span>
                      </td>
                      <td style={ps.td}>
                        <div style={{ display: 'flex', alignItems: 'center', gap: '5px' }}>
                          <span style={{ fontSize: '11px', fontFamily: "'DM Mono', monospace", background: 'rgba(255,255,255,0.05)', padding: '2px 7px', borderRadius: '5px', color: '#7A9BB8', border: '0.5px solid rgba(255,255,255,0.06)' }}>
                            {inv.invoice_number || '—'}
                          </span>
                          {inv.calculated_status === 'partial' && (
                            <span style={{ fontSize: '9px', fontWeight: '700', padding: '1px 6px', borderRadius: '20px', background: 'rgba(245,166,35,0.15)', color: '#F5A623', border: '0.5px solid rgba(245,166,35,0.3)', whiteSpace: 'nowrap' as const }}>
                              PARTIAL
                            </span>
                          )}
                        </div>
                      </td>
                      <td style={ps.td}>
                        <span style={{ fontSize: '10px', fontWeight: '600', padding: '2px 8px', borderRadius: '20px', background: inv.type === 'expense' ? 'rgba(255,91,90,0.12)' : 'rgba(0,212,126,0.12)', color: inv.type === 'expense' ? '#FF5B5A' : '#00D47E', letterSpacing: '0.02em' }}>
                          {inv.type}
                        </span>
                      </td>
                      <td style={{ ...ps.td, textAlign: 'right' as const }}>
                        <div>
                          <span style={{ fontSize: '13px', fontWeight: '500', fontFamily: "'DM Mono', monospace", color: '#E8F1FB', whiteSpace: 'nowrap' as const }}>
                            {fmtMoney(inv.amount || 0, inv.currency)}
                          </span>
                          {inv.calculated_status === 'partial' && (
                            <div style={{ fontSize: '10px', color: '#F5A623', marginTop: '2px', whiteSpace: 'nowrap' as const }}>
                              Remaining: {fmtMoney(inv.outstanding_own || 0, inv.currency)}
                            </div>
                          )}
                        </div>
                      </td>
                      <td style={{ ...ps.td, textAlign: 'right' as const }}>
                        <div>
                          <span style={{ fontSize: '13px', fontWeight: '600', fontFamily: "'DM Mono', monospace", color: inv.calculated_status === 'partial' ? '#F5A623' : '#00D47E' }}>
                            {fmt(owed(inv))}
                          </span>
                          {inv.calculated_status === 'partial' && (
                            <div style={{ fontSize: '10px', color: 'rgba(255,255,255,0.30)', marginTop: '2px' }}>
                              of {fmt(pick(inv))}
                            </div>
                          )}
                        </div>
                      </td>
                      <td style={ps.td}>
                        {partnerAccounts.length > 1 ? (
                          <select
                            style={{ fontFamily: "'Inter', sans-serif", fontSize: '11px', padding: '4px 7px', border: `0.5px solid ${hasAccount ? 'rgba(255,255,255,0.08)' : '#FF5B5A'}`, borderRadius: '6px', background: '#111F30', color: '#DCE9F6', maxWidth: '200px', cursor: 'pointer', outline: 'none' }}
                            value={partnerAccounts.find(a => a.account_number === selectedAcc?.account_number)?.id || ''}
                            onChange={e => handleAccountSelect(inv.id, e.target.value, partnerId)}
                          >
                            <option value="">Select an account...</option>
                            {partnerAccounts.map(pa => (
                              <option key={pa.id} value={pa.id}>{pa.account_number}{pa.is_primary ? ' ★' : ''}{pa.bank_name ? ` — ${pa.bank_name.substring(0, 20)}` : ''}</option>
                            ))}
                          </select>
                        ) : (
                          <div>
                            {hasAccount ? (
                              <div>
                                <div style={{ fontSize: '11px', fontFamily: "'DM Mono', monospace", color: '#7A9BB8' }}>{selectedAcc?.account_number || inv.account_number}</div>
                                {selectedAcc?.bank_name && <div style={{ fontSize: '10px', color: 'rgba(255,255,255,0.25)', marginTop: '1px' }}>{selectedAcc.bank_name.substring(0, 30)}</div>}
                              </div>
                            ) : (
                              <span style={{ fontSize: '11px', color: '#FF5B5A', fontWeight: '500' }}>⚠ No account</span>
                            )}
                          </div>
                        )}
                      </td>
                      <td style={ps.td}>
                        {days === null ? (
                          <span style={{ fontSize: '11px', color: 'rgba(255,255,255,0.25)' }}>No due date</span>
                        ) : days < 0 ? (
                          <span style={{ fontSize: '11px', fontWeight: '700', color: '#FF5B5A', background: 'rgba(255,91,90,0.12)', padding: '2px 8px', borderRadius: '20px' }}>{Math.abs(days)}d late</span>
                        ) : days === 0 ? (
                          <span style={{ fontSize: '11px', fontWeight: '700', color: '#F5A623', background: 'rgba(245,166,35,0.12)', padding: '2px 8px', borderRadius: '20px' }}>Danas!</span>
                        ) : (
                          <span style={{ fontSize: '11px', color: days <= 7 ? '#F5A623' : 'rgba(255,255,255,0.35)' }}>{days}d preostalo</span>
                        )}
                      </td>
                    </tr>
                  )
                })}
              </tbody>
              <tfoot>
                <tr style={{ background: '#060E1A', borderTop: '2px solid rgba(0,212,126,0.25)' }}>
                  <td colSpan={5} style={{ padding: '12px 16px', fontSize: '10px', fontWeight: '700', color: 'rgba(255,255,255,0.30)', letterSpacing: '0.1em', textTransform: 'uppercase' as const }}>
                    Total ({filtered.length} invoice{filtered.length === 1 ? '' : 's'})
                  </td>
                  <td style={{ padding: '12px 16px', textAlign: 'right' as const }}></td>
                  <td style={{ padding: '12px 16px', textAlign: 'right' as const, fontFamily: "'DM Mono', monospace", fontSize: '15px', fontWeight: '700', color: '#00D47E' }}>
                    {fmt(totalUnpaid)}
                  </td>
                  <td colSpan={2} style={{ padding: '12px 16px', fontSize: '11px', color: overdueCount > 0 ? '#FF5B5A' : 'rgba(255,255,255,0.25)', fontWeight: overdueCount > 0 ? '600' : '400' }}>
                    {overdueCount > 0 ? `${overdueCount} invoice${overdueCount === 1 ? '' : 's'} overdue` : 'All on time ✓'}
                  </td>
                </tr>
              </tfoot>
            </table>
          )}
        </div>
      </div>
    </div>
  )
}

// ── Main Reports page ────────────────────────────────────
export default function Reports() {
  const { setPage } = useNav()
  const [activeReport, setActiveReport] = useState('')
  const [showUnpaidPanel, setShowUnpaidPanel] = useState(false)
  const { companies, showPicker } = useCompanies()
  // The KPIs sum each row's own figure in the display currency.
  const { pick, format } = useDisplayCurrency()
  const fmt = (n: number) => format(n, 0)
  const [companyId, setCompanyId] = useState('all')
  const [loading, setLoading] = useState(true)

  const [kpis, setKpis] = useState({
    netProfit: 0, totalRevenue: 0, totalExpenses: 0, expenseRatio: 0,
    openInvoicesCount: 0, openInvoicesAmount: 0, unmatchedPassthrough: 0, overdueCount: 0,
  })

  const currentYear = new Date().getFullYear()
  const ytdStart = `${currentYear}-01-01`
  const today = new Date().toISOString().split('T')[0]

  const fetchKpis = useCallback(async () => {
    setLoading(true)
    try {
      // All three of these used to read a single 1000-row page. The KPIs on
      // this page are headline numbers, so a silent truncation showed the
      // business as smaller and tidier than it is — unmatched pass-throughs
      // read 1000 while the real figure was near 4000.
      const [plData, invData, unmatchedPassthrough] = await Promise.all([
        fetchAllPages<any>((from, to) => {
          let q = supabase.from('v_pl_entries').select('tx_type,amount_rsd,amount_eur')
            .gte('pl_date', ytdStart).lte('pl_date', today)
          if (companyId !== 'all') q = q.eq('company_id', companyId)
          return q.order('pl_date').order('id').range(from, to)
        }),
        fetchAllPages<any>((from, to) => {
          let q = supabase.from('v_invoice_status')
            .select('calculated_status,remaining_rsd,remaining_eur,due_date')
            .in('calculated_status', ['unpaid', 'partial'])
          if (companyId !== 'all') q = q.eq('company_id', companyId)
          return q.order('due_date', { nullsFirst: false }).order('id').range(from, to)
        }),
        countRows((() => {
          // Only the number is wanted, so count it server-side instead of
          // downloading rows and measuring the array.
          let q = supabase.from('passthrough')
            .select('id', { count: 'exact', head: true }).eq('status', 'unpaired')
          if (companyId !== 'all') q = q.eq('company_id', companyId)
          return q
        })()),
      ])
      const revenue = plData.filter(e => e.tx_type === 'revenue' || e.tx_type === 'invoice_revenue').reduce((s, e) => s + (pick(e) ?? 0), 0)
      const expenses = plData.filter(e => e.tx_type === 'expense' || e.tx_type === 'invoice_expense').reduce((s, e) => s + (pick(e) ?? 0), 0)
      const openAmt = invData.reduce((s, i) => s + (pick(i, 'remaining') ?? 0), 0)
      const overdue = invData.filter(i => i.due_date && i.due_date < today).length
      setKpis({ netProfit: revenue - expenses, totalRevenue: revenue, totalExpenses: expenses, expenseRatio: revenue > 0 ? (expenses / revenue * 100) : 0, openInvoicesCount: invData.length, openInvoicesAmount: openAmt, unmatchedPassthrough, overdueCount: overdue })
    } catch (err) { console.error('Reports KPI fetch error:', err) }
    setLoading(false)
  }, [companyId, ytdStart, today, pick])

  useEffect(() => { fetchKpis() }, [fetchKpis])

  const kpiCards = [
    { label: 'Net Profit (YTD)',    value: loading ? '...' : fmt(kpis.netProfit),                                     sub: `${currentYear} year to date`,  up: kpis.netProfit >= 0,      trend: loading ? '' : kpis.netProfit >= 0 ? 'Profitable' : 'Loss',    accent: kpis.netProfit >= 0 ? '#00D47E' : '#FF5B5A' },
    { label: 'Total Revenue (YTD)', value: loading ? '...' : fmt(kpis.totalRevenue),                                    sub: `${currentYear} year to date`,  up: true,                     trend: loading ? '' : `${fmt(kpis.totalExpenses)} expenses`,           accent: '#00D47E' },
    { label: 'Expense Ratio',       value: loading ? '...' : `${kpis.expenseRatio.toFixed(1)}%`,                        sub: 'Expenses / Revenue YTD',       up: kpis.expenseRatio < 90,   trend: loading ? '' : kpis.expenseRatio < 80 ? 'Healthy' : kpis.expenseRatio < 90 ? 'Watch' : 'High', accent: kpis.expenseRatio < 80 ? '#00D47E' : kpis.expenseRatio < 90 ? '#F5A623' : '#FF5B5A' },
    { label: 'Open Invoices',       value: loading ? '...' : kpis.openInvoicesCount > 0 ? `${kpis.openInvoicesCount} · ${fmt(kpis.openInvoicesAmount)}` : 'None', sub: loading ? '' : kpis.overdueCount > 0 ? `${kpis.overdueCount} overdue` : 'All on time', up: kpis.overdueCount === 0, trend: loading ? '' : kpis.overdueCount > 0 ? `${kpis.overdueCount} overdue` : 'On time', accent: kpis.overdueCount > 0 ? '#FF5B5A' : '#4EA8FF' },
  ]

  const reports = [
    { id: 'project-profit',   title: 'Project Profitability', desc: 'Revenue, direct cost and margin per site, with overhead on its own line', category: 'P&L', icon: '🏗', color: '#0F6E56', bg: '#E1F5EE', page: 'projects' as Page,     action: null },
    { id: 'pl-by-project',    title: 'Cost by Project',      desc: 'Every cost by project and category; Opšti troškovi for overhead',   category: 'P&L',        icon: '🧭', color: '#0F6E56', bg: '#E1F5EE', page: 'expenses' as Page,     action: null },
    { id: 'pl-by-dept',       title: 'P&L by Department',    desc: 'Expense breakdown per organizational unit',                       category: 'P&L',        icon: '👥', color: '#0F6E56', bg: '#E1F5EE', page: 'expenses' as Page,     action: null },
    { id: 'cashflow-monthly', title: 'Monthly Cash Flow',    desc: 'Operating and financing activities by period',                    category: 'Cash Flow',  icon: '💰', color: '#0C447C', bg: '#E6F1FB', page: 'cashflow' as Page,     action: null },
    { id: 'bank-rec',         title: 'Bank Reconciliation',  desc: 'Statement vs. recorded transactions per account',                 category: 'Cash Flow',  icon: '🏦', color: '#0C447C', bg: '#E6F1FB', page: 'cashflow' as Page,     action: null },
    { id: 'passthrough',      title: 'Pass-through Balance', desc: 'Pass-through IN vs. OUT monthly balance',                         category: 'Compliance', icon: '⚖️', color: '#633806', bg: '#FAEEDA', page: 'cashflow' as Page,     action: null },
    { id: 'unmatched',        title: 'Unmatched Invoices',   desc: 'Unpaid invoices · Hal E-Bank TKDIS export', category: 'Compliance', icon: '⚠️', color: '#854F0B', bg: '#FAEEDA', page: 'reports' as Page,      action: 'unpaid' },
    { id: 'exchange-rates',   title: 'Exchange Rate Log',    desc: 'Rates used per period and transaction',                           category: 'Reference',  icon: '💱', color: '#444',    bg: '#f0f0ee', page: 'reports' as Page,      action: null },
    { id: 'partner-summary',  title: 'Partner Summary',      desc: 'Total transactions per partner across all entities',               category: 'Reference',  icon: '🤝', color: '#444',    bg: '#f0f0ee', page: 'partners' as Page,     action: null },
  ]

  const categories = ['P&L', 'Cash Flow', 'Compliance', 'Reference']
  const categoryColors: Record<string, { color: string; bg: string; accent: string }> = {
    'P&L':        { color: '#0F6E56', bg: '#E1F5EE', accent: '#00D47E' },
    'Cash Flow':  { color: '#0C447C', bg: '#E6F1FB', accent: '#4EA8FF' },
    'Compliance': { color: '#633806', bg: '#FAEEDA', accent: '#F5A623' },
    'Reference':  { color: '#555',    bg: '#f0f0ee', accent: '#7A9BB8' },
  }

  return (
    <div style={s.root} className="app-surface">
      <div style={s.body}>

        {/* ── Page header ── */}
        <div style={s.pageHeader}>
          <div>
            <div style={s.pageTitle}>Reports</div>
            <div style={s.pageSub}>Financial reports and analytics · YTD {currentYear}</div>
          </div>
          <div style={{ display: 'flex', gap: '10px', alignItems: 'center' }}>
            {showPicker && (
              <select style={s.filterSelect} value={companyId} onChange={e => setCompanyId(e.target.value)}>
                <option value="all">All companies</option>
                {companies.map(c => <option key={c.id} value={c.id}>{c.name}</option>)}
              </select>
            )}
            <button onClick={fetchKpis} style={{ fontFamily: "'Inter', sans-serif", fontSize: '12px', padding: '8px 14px', border: '1px solid rgba(0,212,126,0.3)', borderRadius: '9px', background: 'rgba(0,212,126,0.06)', color: '#00D47E', cursor: 'pointer', fontWeight: '500' }}>↻ Refresh</button>
          </div>
        </div>

        {/* ── KPI section label ── */}
        <div style={{ fontSize: '10px', fontWeight: '600', color: 'rgba(255,255,255,0.22)', letterSpacing: '0.12em', textTransform: 'uppercase' as const, marginBottom: '10px' }}>
          Key metrics · {currentYear} year to date
        </div>

        {/* ── KPI grid ── */}
        <div style={s.kpiGrid} className="mf-stagger">
          {kpiCards.map(k => (
            <div key={k.label} style={{ ...s.kpiCard, borderTop: `2.5px solid ${k.accent}` }}>
              <div style={s.kpiLabel}>{k.label}</div>
              <div style={{ ...s.kpiValue, color: k.accent }}>{k.value}</div>
              <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginTop: '10px' }}>
                <span style={{ ...s.kpiTrend, color: k.up ? '#00D47E' : '#FF5B5A', background: k.up ? 'rgba(0,212,126,0.12)' : 'rgba(255,91,90,0.12)' }}>
                  {k.up ? '↑' : '↓'} {k.trend}
                </span>
                <span style={{ fontSize: '10.5px', color: 'rgba(255,255,255,0.25)' }}>{k.sub}</span>
              </div>
            </div>
          ))}
        </div>

        {/* ── Alert banner ── */}
        {!loading && (kpis.overdueCount > 0 || kpis.unmatchedPassthrough > 0) && (
          <div style={s.alertBox}>
            <div style={{ fontSize: '11px', fontWeight: '700', color: '#F5A623', marginBottom: '8px', letterSpacing: '0.04em', textTransform: 'uppercase' as const }}>Attention required</div>
            {kpis.overdueCount > 0 && (
              <div style={s.alertRow}>
                <span style={s.alertDot} />
                <span style={{ fontSize: '12px', color: '#DCE9F6' }}>
                  {kpis.overdueCount} invoice{kpis.overdueCount > 1 ? 's' : ''} past due date —{' '}
                  <span style={{ color: '#F5A623', cursor: 'pointer', textDecoration: 'underline', textDecorationColor: 'rgba(245,166,35,0.4)' }} onClick={() => setShowUnpaidPanel(true)}>
                    open Unmatched Invoices
                  </span>.
                </span>
              </div>
            )}
            {kpis.unmatchedPassthrough > 0 && (
              <div style={s.alertRow}>
                <span style={s.alertDot} />
                <span style={{ fontSize: '12px', color: '#DCE9F6' }}>{kpis.unmatchedPassthrough} pass-through entr{kpis.unmatchedPassthrough === 1 ? 'y' : 'ies'} unpaired — review Cash Flow tab.</span>
              </div>
            )}
          </div>
        )}

        {/* ── Report categories ── */}
        {categories.map(cat => (
          <div key={cat} style={s.categorySection}>
            <div style={s.categoryHeader}>
              <div style={{ width: '6px', height: '6px', borderRadius: '50%', background: categoryColors[cat].accent, flexShrink: 0 }} />
              <span style={{ ...s.categoryBadge, color: categoryColors[cat].color, background: categoryColors[cat].bg }}>{cat}</span>
              <span style={s.categoryCount}>{reports.filter(r => r.category === cat).length} reports</span>
              <div style={{ flex: 1, height: '0.5px', background: 'rgba(255,255,255,0.06)' }} />
            </div>
            <div style={s.reportsGrid}>
              {reports.filter(r => r.category === cat).map(report => (
                <ReportCard
                  key={report.id}
                  report={report}
                  active={activeReport === report.id}
                  onClick={() => setActiveReport(activeReport === report.id ? '' : report.id)}
                  onView={() => {
                    if (report.action === 'unpaid') setShowUnpaidPanel(true)
                    else setPage(report.page)
                  }}
                />
              ))}
            </div>
          </div>
        ))}
      </div>

      {showUnpaidPanel && <UnpaidInvoicesPanel onClose={() => setShowUnpaidPanel(false)} />}
    </div>
  )
}

// ── Report Card component ─────────────────────────────────
function ReportCard({ report, active, onClick, onView }: { report: any; active: boolean; onClick: () => void; onView: () => void }) {
  const [hov, setHov] = useState(false)
  return (
    <div
      onMouseEnter={() => setHov(true)}
      onMouseLeave={() => setHov(false)}
      style={{
        ...s.reportCard,
        border: active ? `1.5px solid ${report.color}` : hov ? '1px solid rgba(255,255,255,0.12)' : '1px solid rgba(255,255,255,0.06)',
        background: active ? `${report.color}08` : hov ? '#111F30' : '#0D1B2C',
        transform: hov ? 'translateY(-1px)' : 'none',
      }}
      onClick={onClick}
    >
      <div style={{ ...s.reportIcon, background: active ? `${report.color}22` : report.bg }}>
        <span style={{ fontSize: '18px' }}>{report.icon}</span>
      </div>
      <div style={s.reportInfo}>
        <div style={s.reportTitle}>{report.title}</div>
        <div style={s.reportDesc}>{report.desc}</div>
      </div>
      <div style={{ display: 'flex', flexDirection: 'column' as const, alignItems: 'flex-end', gap: '8px', flexShrink: 0 }}>
        <button
          style={{ ...s.reportBtn, color: report.color, borderColor: report.color + '40', background: active ? `${report.color}18` : report.bg }}
          onClick={e => { e.stopPropagation(); onView() }}>
          View →
        </button>
      </div>
    </div>
  )
}

// ── Styles ───────────────────────────────────────────────
const s: Record<string, React.CSSProperties> = {
  // The background lives in `.app-surface` rather than here: an inline
  // colour would paint straight over it.
  root: { minHeight: '100vh', fontFamily: "'Inter', system-ui, sans-serif" },
  body: { padding: '28px 32px' },
  pageHeader: { display: 'flex', alignItems: 'flex-end', justifyContent: 'space-between', marginBottom: '28px', gap: '24px' },
  pageTitle: { fontFamily: "'DM Serif Display', Georgia, serif", fontSize: '28px', fontWeight: '400', color: '#E8F1FB', marginBottom: '5px', letterSpacing: '-0.01em', lineHeight: 1.1 },
  pageSub: { fontSize: '13px', color: '#7A9BB8', letterSpacing: '0.005em' },
  filterSelect: { fontFamily: "'Inter', sans-serif", fontSize: '13px', border: '1px solid rgba(255,255,255,0.08)', borderRadius: '9px', padding: '8px 14px', outline: 'none', background: '#0D1B2C', color: '#DCE9F6', cursor: 'pointer', minWidth: '180px' },
  kpiGrid: { display: 'grid', gridTemplateColumns: 'repeat(4,1fr)', gap: '10px', marginBottom: '10px' },
  kpiCard: { background: '#0D1B2C', border: '1px solid rgba(255,255,255,0.06)', borderRadius: '12px', padding: '18px 20px', position: 'relative' as const, overflow: 'hidden' },
  kpiLabel: { fontSize: '10px', fontWeight: '600', color: 'rgba(255,255,255,0.28)', textTransform: 'uppercase' as const, letterSpacing: '0.11em', marginBottom: '10px' },
  kpiValue: { fontFamily: "'DM Mono', 'Fira Mono', monospace", fontSize: '26px', fontWeight: '500', letterSpacing: '-0.02em', lineHeight: 1 },
  kpiTrend: { display: 'inline-flex', alignItems: 'center', gap: '4px', fontSize: '10.5px', fontWeight: '600', padding: '3px 9px', borderRadius: '20px' },
  alertBox: { background: 'rgba(245,166,35,0.07)', border: '1px solid rgba(245,166,35,0.20)', borderLeft: '3px solid #F5A623', borderRadius: '10px', padding: '14px 18px', marginBottom: '28px', marginTop: '10px' },
  alertRow: { display: 'flex', alignItems: 'center', gap: '8px', marginBottom: '4px' },
  alertDot: { width: '5px', height: '5px', borderRadius: '50%', background: '#F5A623', flexShrink: 0 },
  categorySection: { marginBottom: '28px' },
  categoryHeader: { display: 'flex', alignItems: 'center', gap: '10px', marginBottom: '12px' },
  categoryBadge: { fontSize: '10px', fontWeight: '700', padding: '3px 10px', borderRadius: '20px', textTransform: 'uppercase' as const, letterSpacing: '0.1em' },
  categoryCount: { fontSize: '11px', color: 'rgba(255,255,255,0.25)', letterSpacing: '0.04em' },
  reportsGrid: { display: 'grid', gridTemplateColumns: 'repeat(2,1fr)', gap: '8px' },
  reportCard: { background: '#0D1B2C', borderRadius: '12px', padding: '16px 18px', display: 'flex', alignItems: 'center', gap: '14px', cursor: 'pointer', transition: 'border-color 0.15s, background 0.15s, transform 0.15s' },
  reportIcon: { width: '42px', height: '42px', borderRadius: '10px', display: 'flex', alignItems: 'center', justifyContent: 'center', flexShrink: 0 },
  reportInfo: { flex: 1, minWidth: 0 },
  reportTitle: { fontSize: '13.5px', fontWeight: '500', color: '#E8F1FB', marginBottom: '3px', letterSpacing: '-0.005em' },
  reportDesc: { fontSize: '11.5px', color: '#7A9BB8', lineHeight: 1.45 },
  reportActions: { display: 'flex', gap: '6px', flexShrink: 0 },
  reportBtn: { fontFamily: "'Inter', sans-serif", fontSize: '11px', fontWeight: '500', padding: '5px 13px', borderRadius: '7px', border: '1px solid', cursor: 'pointer' },
}

const ps: Record<string, React.CSSProperties> = {
  overlay: { position: 'fixed', inset: 0, background: 'rgba(0,0,0,0.72)', backdropFilter: 'blur(6px)', display: 'flex', alignItems: 'flex-start', justifyContent: 'flex-end', zIndex: 1000 },
  panel: { background: '#0B1929', width: '92vw', maxWidth: '1240px', height: '100vh', display: 'flex', flexDirection: 'column', boxShadow: '-8px 0 48px rgba(0,0,0,0.6)', borderLeft: '1px solid rgba(255,255,255,0.06)' },
  header: { background: '#060E1A', padding: '18px 24px', display: 'flex', alignItems: 'flex-start', justifyContent: 'space-between', flexShrink: 0, borderBottom: '1px solid rgba(255,255,255,0.06)' },
  headerTitle: { color: '#E8F1FB', fontFamily: "'DM Serif Display', Georgia, serif", fontSize: '20px', fontWeight: '400', letterSpacing: '-0.01em' },
  headerSub: { color: '#7A9BB8', fontSize: '12px', marginTop: '4px' },
  closeBtn: { background: 'rgba(255,255,255,0.05)', border: '1px solid rgba(255,255,255,0.08)', color: '#7A9BB8', fontSize: '18px', cursor: 'pointer', lineHeight: 1, padding: '0', width: '30px', height: '30px', borderRadius: '8px', display: 'flex', alignItems: 'center', justifyContent: 'center', flexShrink: 0 },
  toolbar: { display: 'flex', gap: '8px', padding: '12px 16px', borderBottom: '1px solid rgba(255,255,255,0.05)', flexShrink: 0, flexWrap: 'wrap' as const, background: '#0D1B2C' },
  searchInput: { flex: 1, fontFamily: "'Inter', sans-serif", fontSize: '13px', border: '1px solid rgba(255,255,255,0.08)', borderRadius: '8px', padding: '7px 12px', outline: 'none', minWidth: '180px', background: '#111F30', color: '#DCE9F6' },
  sel: { fontFamily: "'Inter', sans-serif", fontSize: '13px', border: '1px solid rgba(255,255,255,0.08)', borderRadius: '8px', padding: '7px 10px', outline: 'none', background: '#111F30', color: '#DCE9F6', cursor: 'pointer' },
  exportBar: { display: 'flex', alignItems: 'center', justifyContent: 'space-between', padding: '10px 18px', background: 'rgba(245,166,35,0.07)', borderBottom: '1px solid rgba(245,166,35,0.18)', borderLeft: '3px solid #F5A623', flexShrink: 0, flexWrap: 'wrap' as const, gap: '8px' },
  exportBtn: { fontFamily: "'Inter', sans-serif", fontSize: '12px', fontWeight: '700', padding: '7px 18px', borderRadius: '8px', border: 'none', background: '#F5A623', color: '#060E1A', cursor: 'pointer', letterSpacing: '0.02em' },
  tableWrap: { flex: 1, overflowY: 'auto' as const },
  table: { width: '100%', borderCollapse: 'collapse' as const, fontSize: '13px' },
  thead: { background: '#0A1525', position: 'sticky' as const, top: 0, zIndex: 10 },
  th: { padding: '10px 16px', textAlign: 'left' as const, fontSize: '10px', fontWeight: '600', color: 'rgba(255,255,255,0.25)', textTransform: 'uppercase' as const, letterSpacing: '0.1em', borderBottom: '1px solid rgba(255,255,255,0.06)', whiteSpace: 'nowrap' as const },
  tr: { borderBottom: '0.5px solid rgba(255,255,255,0.04)', transition: 'background 0.1s' },
  td: { padding: '11px 16px', verticalAlign: 'middle' as const },
}