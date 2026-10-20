import { isPayable } from '../services/documentType'
import React, { useState, useEffect, useCallback, useContext, useRef } from 'react'
import { useNav } from '../navigation'
import type { Page } from '../navigation'
import { supabase } from '../supabase'
import { useCompanies } from '../contexts/CompaniesContext'
import { SkeletonRows } from '../components/motion'
import { fetchAllPages, fetchByIds, countRows } from '../utils/fetchAllPages'
import { outstandingOwn } from '../services/settleInvoice'
import { adjustmentSummary } from '../services/documentType'
import { toRsd, toEur } from '../services/allocationDisplay'
import { fmtMoney, fmtNum } from '../utils/formatters'
import { useDisplayCurrency } from '../contexts/DisplayCurrencyContext'
import { findAccountByNumber, defaultAccount } from '../services/partnerAccountChoice'
import { countOf } from '../utils/plural'
import { HALCOM_SIFRE, buildTkdis, tkdisBytes, tkdisFileName } from '../services/payments/halcomTkdis'
import {
  newLine, lineAmount, lineProblem, remainingAfter, batchesByBank, orderFor, round2,
  type PaymentLine, type PayableBill, type BankBatch,
} from '../services/payments/paymentLines'
import { UnpaidPanelExtensionContext } from '../services/payments/unpaidPanelExtension'

// ── Payment orders: one Halcom file per bank (services/payments) ──────────
//
// A ticked bill is a payment line — an amount (all of what is owed, or part),
// the company account it is paid from, and a payment code. The lines are
// batched by bank, and each bank gets its own TKDIS file whose header names
// that bank's account. See halcomTkdis.ts for why it cannot be one file.

/** Downloads the bank's file under the given name. */
function downloadTkdis(batch: BankBatch, bills: Map<string, PayableBill>, companyProfile: any, companyName: string, date: Date, fileName: string) {
  const text = buildTkdis(
    {
      account_number: batch.bank.account_number,
      name: companyProfile?.full_legal_name || companyName,
      city: companyProfile?.city || 'BEOGRAD',
    },
    batch.lines.map(l => orderFor(l, bills.get(l.invoiceId)!)),
    date,
  )
  const blob = new Blob([tkdisBytes(text)], { type: 'application/octet-stream' })
  const url = URL.createObjectURL(blob)
  const a = document.createElement('a')
  a.href = url
  a.download = fileName
  a.click()
  URL.revokeObjectURL(url)
}

const sifraLabel = (code: string) => HALCOM_SIFRE.find(s => s.value === code)?.label.split(' – ')[1] || code

// ── Unpaid Invoices Panel ────────────────────────────────
/** „1 knjižno odobrenje nije vezano za račun“, „2 knjižna zaduženja nisu vezana za račun“, or both. */
export function unlinkedNotesLabel(notes: { document_type: string }[]): string {
  const credits = notes.filter(n => n.document_type === 'credit_note').length
  const debits = notes.length - credits
  const one = (n: number, a: string, few: string, many: string) => {
    const m10 = n % 10, m100 = n % 100
    return `${n} ${m10 === 1 && m100 !== 11 ? a : m10 >= 2 && m10 <= 4 && (m100 < 12 || m100 > 14) ? few : many}`
  }
  const parts = [
    credits > 0 ? one(credits, 'knjižno odobrenje', 'knjižna odobrenja', 'knjižnih odobrenja') : '',
    debits > 0 ? one(debits, 'knjižno zaduženje', 'knjižna zaduženja', 'knjižnih zaduženja') : '',
  ].filter(Boolean)
  const singular = notes.length === 1 || (credits % 10 === 1 && credits % 100 !== 11 && debits === 0) || (debits % 10 === 1 && debits % 100 !== 11 && credits === 0)
  return `${parts.join(' i ')} ${singular ? 'nije vezano' : 'nisu vezana'} za račun`
}

export function UnpaidInvoicesPanel({ onClose }: { onClose: () => void }) {
  // What is owed prints in the viewer's display currency, beside the bill's own.
  const { currency, pick, format } = useDisplayCurrency()
  const fmt = (n: number | null) => format(n, 0)
  const [invoices, setInvoices] = useState<any[]>([])
  /** Credit and debit notes not linked to a bill yet: never paid, only named. */
  const [unlinkedNotes, setUnlinkedNotes] = useState<any[]>([])
  const [loading, setLoading] = useState(true)
  const [sortBy, setSortBy] = useState<'due_date' | 'amount' | 'partner' | 'bank'>('due_date')
  const [filterStatus, setFilterStatus] = useState<'all' | 'overdue' | 'upcoming'>('all')
  const [search, setSearch] = useState('')
  // What is to be paid: one line per ticked bill, keyed by invoice id.
  const [lines, setLines] = useState<Record<string, PaymentLine>>({})
  // A client app's part in paying (unpaidPanelExtension.ts); null in FlowBase.
  const ext = useContext(UnpaidPanelExtensionContext)
  const [exportError, setExportError] = useState('')
  const [exporting, setExporting] = useState(false)
  const selected = new Set(Object.keys(lines))
  const [bankAccounts, setBankAccounts] = useState<any[]>([])
  // The account a newly ticked bill is paid from: the primary one.
  const [defaultBankId, setDefaultBankId] = useState('')
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
      if (bankData && bankData.length > 0) { setBankAccounts(bankData); setDefaultBankId((bankData.find(b => b.is_primary) || bankData[0]).id) }
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
          .select('id, calculated_status, amount, paid_amount, remaining_rsd, remaining_eur, document_type, adjustments, advance_used, unlinked')
          .eq('company_id', compData.id)
          .in('document_type', ['invoice', 'proforma'])
          .in('calculated_status', ['unpaid', 'partial'])
          .order('due_date', { ascending: true }).order('id')
          .range(from, to))
        // A credit or debit note is never paid on its own: the bill it
        // adjusts is (its notes counted), and one not linked yet waits.
        .then(rows => rows.filter((r: any) => isPayable(r.document_type ?? 'invoice')))

      const { data: loose } = await supabase.from('v_invoice_status')
        .select('id, invoice_number, partner_name, document_type, amount, currency, unlinked')
        .eq('company_id', compData.id)
        .eq('unlinked', true)
      setUnlinkedNotes((loose || []).filter((r: any) => r.unlinked && (r.document_type === 'credit_note' || r.document_type === 'debit_note')))

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
            //
            // Through outstandingOwn on an unpaid bill as well: a revenue
            // billing that deducts an advance is owed `amount −
            // advance_deducted` before anything is paid (`invoices.*` carries
            // advance_deducted).
            //
            // Its credit and debit notes count: a bill of 120.000 with a
            // credit note of −20.000 is owed 100.000.
            adjustments: Number(open?.adjustments) || 0,
            // A final invoice: what supplier advances already paid of it.
            advance_used: Number(open?.advance_used) || 0,
            paid_own: partial ? (Number(open?.paid_amount) || 0) : 0,
            outstanding_own: outstandingOwn({
              ...i,
              amount: (Number(i.amount) || 0) + (Number(open?.adjustments) || 0) - (Number(open?.advance_used) || 0),
              paid_amount: partial ? (open?.paid_amount ?? 0) : 0,
            }),
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
                  bank_name: chosen?.bank_name || 'Sa fakture',
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
      if (sortBy === 'bank') {
        // Ticked bills first, grouped by bank and then by payment code — the
        // way the files will be cut. The rest after, by due date.
        const la = lines[a.id], lb = lines[b.id]
        if (la && !lb) return -1
        if (lb && !la) return 1
        if (la && lb) {
          const ba = bankAccounts.findIndex(x => x.id === la.bankAccountId)
          const bb = bankAccounts.findIndex(x => x.id === lb.bankAccountId)
          if (ba !== bb) return ba - bb
          if (la.paymentCode !== lb.paymentCode) return la.paymentCode.localeCompare(lb.paymentCode)
        }
      }
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
  // ── The bill as a payment line sees it ──────────────────────────────────
  const billOf = (inv: any): PayableBill => ({
    id: inv.id,
    type: inv.type ?? null,
    currency: inv.currency ?? null,
    // Less what is already set aside for this bill elsewhere, so a line can
    // never order more than is left once those are paid.
    outstanding: round2(Math.max(0, (inv.outstanding_own || 0) - (ext?.reserved?.(inv.id) ?? 0))),
    invoice_number: inv.invoice_number ?? null,
    partner_name: inv.partners?.name ?? null,
    partner_address: inv.partners?.address ?? null,
    partner_city: inv.partners?.city ?? null,
    beneficiary_account: invoiceAccountMap[inv.id]?.account_number || inv.account_number || null,
    model: invoiceAccountMap[inv.id]?.model || inv.model || null,
    reference_number: inv.reference_number ?? null,
  })
  const bills = new Map<string, PayableBill>(invoices.map(i => [i.id, billOf(i)]))
  const selectedLines = Object.values(lines)

  // Međuzbir: only what is set aside for payment, not the whole of each bill.
  const selectedTotalRsd = round2(selectedLines.reduce((s, l) => s + (lineAmount(l) ?? 0), 0))
  // The same share of each bill, in the display currency.
  const selectedTotalBook = selectedLines.reduce((s, l) => {
    const inv = invoices.find(i => i.id === l.invoiceId)
    const out = inv?.outstanding_own || 0
    return s + (inv && out > 0 ? (owed(inv) ?? 0) * Math.min(1, (lineAmount(l) ?? 0) / out) : 0)
  }, 0)

  const toggleSelect = (inv: any) => setLines(prev => {
    const n = { ...prev }
    if (n[inv.id]) delete n[inv.id]
    else n[inv.id] = newLine(billOf(inv), defaultBankId)
    return n
  })
  const toggleAll = () => setLines(prev => {
    if (Object.keys(prev).length === filtered.length) return {}
    const n: Record<string, PaymentLine> = {}
    filtered.forEach(i => { n[i.id] = prev[i.id] || newLine(billOf(i), defaultBankId) })
    return n
  })
  const patchLine = (id: string, patch: Partial<PaymentLine>) => {
    const current = lines[id]
    setLines(prev => (prev[id] ? { ...prev, [id]: { ...prev[id], ...patch } } : prev))
    if (current && ('bankAccountId' in patch || 'paymentCode' in patch)) ext?.onLineChange?.({ ...current, ...patch })
  }

  // Lines a client app presets (e.g. bills someone else decided to pay) are
  // ticked once each, for bills this panel lists; unticking one is final
  // until the preset itself changes.
  const appliedPresets = useRef(new Set<string>())
  const presetKey = (l: PaymentLine) => `${l.invoiceId}|${l.amountText}|${l.bankAccountId}|${l.paymentCode}`
  useEffect(() => {
    const fresh = (ext?.presetLines || [])
      .filter(l => !appliedPresets.current.has(presetKey(l)) && invoices.some(i => i.id === l.invoiceId))
    if (fresh.length === 0) return
    fresh.forEach(l => appliedPresets.current.add(presetKey(l)))
    setLines(prev => {
      const n = { ...prev }
      fresh.forEach(l => { n[l.invoiceId] = { ...l } })
      return n
    })
  }, [ext?.presetLines, invoices])
  const patchAll = (patch: Partial<PaymentLine>) => {
    setLines(prev => Object.fromEntries(Object.entries(prev).map(([k, l]) => [k, { ...l, ...patch }])))
    Object.values(lines).forEach(l => ext?.onLineChange?.({ ...l, ...patch }))
  }

  // ── The files: one per bank ─────────────────────────────────────────────
  // A line the client app holds back (with its reason) is no file's.
  const problemOf = (l: PaymentLine): string | null =>
    ext?.exportBlock?.(l.invoiceId)
      ?? (bills.get(l.invoiceId) ? lineProblem(l, bills.get(l.invoiceId)!) : 'Faktura nije pronađena.')
  const batches = batchesByBank(selectedLines.filter(l => !ext?.exportBlock?.(l.invoiceId)), bills, bankAccounts)
  const blocked = selectedLines
    .map(l => ({ l, problem: problemOf(l) }))
    .filter(x => x.problem !== null)

  const handleAccountSelect = (invId: string, accountId: string, partnerId: string) => {
    const accounts = partnerAccountsMap[partnerId] || []
    const acc = accounts.find(a => a.id === accountId)
    if (acc) setInvoiceAccountMap(prev => ({ ...prev, [invId]: { account_number: acc.account_number, model: acc.model || '97', bank_name: acc.bank_name || '' } }))
  }

  // Recorded first (when a client app records files), downloaded second: a
  // file whose record is refused never reaches the bank.
  const handleExport = async (batch: BankBatch) => {
    if (exporting) return
    // Hal E-Bank books an imported file to whatever account is selected at
    // the import — tried, it does not check the file's own (TKDIS carries the
    // payer only in its header). So the person exporting is told which.
    if (!window.confirm(
      `Ovaj fajl uvezite u Halcom SAMO dok je izabran račun:

`
      + `${batch.bank.bank_name || ''}  ${batch.bank.account_number}

`
      + `Halcom ne proverava račun iz fajla: ako je izabran drugi račun, nalozi će biti plaćeni sa njega.`,
    )) return
    setExportError('')
    setExporting(true)
    const date = new Date()
    const fileName = tkdisFileName(batch.bank.bank_name, batch.bank.account_number, date)
    try {
      try {
        await ext?.beforeExport?.(batch, fileName)
      } catch (e) {
        setExportError(`Fajl nije preuzet: ${e instanceof Error ? e.message : String(e)}`)
        return
      }
      downloadTkdis(batch, bills, companyProfile, defaultCompany?.name || '', date, fileName)
      try {
        await ext?.onExported?.(batch, fileName)
      } catch (e) {
        setExportError(`Fajl ${fileName} je preuzet, ali izvoz nije zabeležen: ${e instanceof Error ? e.message : String(e)}`)
      }
    } finally {
      setExporting(false)
    }
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
              Neplaćene fakture
            </div>
            <div style={ps.headerTitle}>{defaultCompany?.name || 'Firma nije podešena'}</div>
            <div style={ps.headerSub}>
              {loading ? 'Učitavanje…' : (
                <span>
                  <span style={{ fontFamily: "'DM Mono', monospace", color: '#F5A623', fontWeight: '600' }}>{fmt(totalUnpaid)}</span>
                  <span style={{ marginLeft: '10px', color: 'rgba(255,255,255,0.30)' }}>· {countOf(filtered.length, 'faktura', 'fakture', 'faktura')}</span>
                  {overdueCount > 0 && <span style={{ marginLeft: '8px', color: '#FF5B5A', fontWeight: '600' }}>· {overdueCount} u kašnjenju</span>}
                </span>
              )}
            </div>
          </div>
          <button style={ps.closeBtn} onClick={onClose}>×</button>
        </div>

        {/* ── Toolbar ── */}
        <div style={ps.toolbar}>
          <input style={ps.searchInput} placeholder="Pretraga po partneru ili broju fakture…" value={search} onChange={e => setSearch(e.target.value)} />
          <select style={ps.sel} value={filterStatus} onChange={e => setFilterStatus(e.target.value as any)}>
            <option value="all">Sve neplaćene</option>
            <option value="overdue">Samo u kašnjenju</option>
            <option value="upcoming">Predstojeće</option>
          </select>
          <select style={ps.sel} value={sortBy} onChange={e => setSortBy(e.target.value as any)}>
            <option value="due_date">Sortiraj: datum dospeća</option>
            <option value="amount">Sortiraj: iznos</option>
            <option value="partner">Sortiraj: partner</option>
            <option value="bank">Grupiši: banka i šifra plaćanja</option>
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
                <div style={{ fontSize: '10px', color: 'rgba(255,255,255,0.3)', marginBottom: '2px' }}>Za plaćanje RSD</div>
                <div style={{ fontFamily: "'DM Mono',monospace", fontSize: '15px', fontWeight: '600', color: '#E8F1FB' }}>
                  {fmtNum(selectedTotalRsd)} RSD
                </div>
              </div>
              {currency !== 'RSD' && (
                <div>
                  <div style={{ fontSize: '10px', color: 'rgba(255,255,255,0.3)', marginBottom: '2px' }}>Ukupno {currency}</div>
                  <div style={{ fontFamily: "'DM Mono',monospace", fontSize: '15px', fontWeight: '600', color: '#00D47E' }}>
                    {fmt(selectedTotalBook)}
                  </div>
                </div>
              )}
              <div style={{ marginLeft: 'auto', display: 'flex', alignItems: 'center', gap: '8px' }}>
                {bankAccounts.length > 1 && (
                  <select aria-label="Banka za sve izabrane" style={{ ...ps.sel, fontSize: '11px' }} value=""
                    onChange={e => { if (e.target.value) patchAll({ bankAccountId: e.target.value }) }}>
                    <option value="">Banka za sve izabrane…</option>
                    {bankAccounts.map(b => <option key={b.id} value={b.id}>{b.bank_name}{b.is_primary ? ' ★' : ''}</option>)}
                  </select>
                )}
                <select aria-label="Šifra za sve izabrane" style={{ ...ps.sel, fontSize: '11px' }} value=""
                  onChange={e => { if (e.target.value) patchAll({ paymentCode: e.target.value }) }}>
                  <option value="">Šifra za sve izabrane…</option>
                  {HALCOM_SIFRE.map(s => <option key={s.value} value={s.value}>{s.label}</option>)}
                </select>
                {ext?.selectionActions?.(selectedLines, () => setLines({}))}
                <button
                  style={{ fontFamily: "'Inter',sans-serif", fontSize: '11px', padding: '5px 12px', border: '1px solid rgba(255,255,255,0.12)', borderRadius: '6px', background: 'transparent', color: '#7A9BB8', cursor: 'pointer' }}
                  onClick={() => setLines({})}>Poništi izbor</button>
              </div>
            </div>
          </div>
        )}

        {/* ── Export bar: one Halcom file per bank ── */}
        <div style={ps.exportBar}>
          <div style={{ display: 'flex', flexDirection: 'column' as const, gap: '4px', minWidth: 0 }}>
            <div style={{ fontSize: '12px', color: '#854F0B', fontWeight: '600' }}>
              Hal E-Bank — nalozi za prenos (TKDIS), jedan fajl po banci
            </div>
            {bankAccounts.length === 0 ? (
              <div style={{ fontSize: '11px', color: '#FF5B5A' }}>⚠ Firma nema tekući račun u RSD</div>
            ) : selected.size === 0 ? (
              <div style={{ fontSize: '11px', color: '#7A6030' }}>Čekirajte fakture koje se plaćaju; za svaku birate iznos, banku i šifru.</div>
            ) : (
              <div style={{ fontSize: '11px', color: '#7A6030' }}>
                U Halcom-u pre uvoza izaberite račun naveden uz fajl. Naziv fajla nosi banku i kraj računa.
                {blocked.length > 0 && (
                  <span style={{ marginLeft: '8px', color: '#FF5B5A', fontWeight: '600' }}>
                    ⚠ {countOf(blocked.length, 'stavka nije spremna', 'stavke nisu spremne', 'stavki nije spremno')} za izvoz
                  </span>
                )}
                {missingAccountCount > 0 && <span style={{ marginLeft: '8px', color: '#FF5B5A', fontWeight: '600' }}>⚠ {missingAccountCount} bez računa primaoca</span>}
              </div>
            )}
            {exportError && <div role="alert" style={{ fontSize: '11px', color: '#FF5B5A', fontWeight: '600' }}>{exportError}</div>}
          </div>
          <div style={{ display: 'flex', flexDirection: 'column' as const, gap: '6px', alignItems: 'flex-end' }}>
            {batches.map(b => (
              <div key={b.bank.id} style={{ display: 'flex', gap: '10px', alignItems: 'center' }}>
                <span style={{ fontSize: '11px', color: '#DCE9F6' }}>
                  <b>{b.bank.bank_name}</b> · {b.bank.account_number} · {countOf(b.lines.length, 'nalog', 'naloga', 'naloga')}
                  {' · '}{b.byCode.map(c => `${c.code} (${c.count})`).join(', ')}
                </span>
                <span style={{ fontFamily: "'DM Mono',monospace", fontSize: '12px', fontWeight: '600', color: '#E8F1FB' }}>{fmtNum(b.total)} RSD</span>
                <button style={{ ...ps.exportBtn, opacity: exporting ? 0.5 : 1 }} disabled={exporting} onClick={() => handleExport(b)}>↓ Izvezi</button>
              </div>
            ))}
          </div>
        </div>

        {unlinkedNotes.length > 0 && (
          <details style={{ margin: '0 0 10px', padding: '8px 12px', borderRadius: '8px', background: 'rgba(245,166,35,0.10)', border: '0.5px solid rgba(245,166,35,0.35)', color: '#F5A623', fontSize: '12px' }}>
            <summary style={{ cursor: 'pointer' }}>{unlinkedNotesLabel(unlinkedNotes)}</summary>
            <div style={{ marginTop: '6px', color: '#DCE9F6' }}>
              Ne nude se za plaćanje dok se ne vežu. Otvorite ih u Glavnoj knjizi i izaberite račun na koji se odnose.
              {unlinkedNotes.map(n => (
                <div key={n.id} style={{ marginTop: '3px', fontFamily: "'DM Mono', monospace", fontSize: '11px' }}>
                  {n.partner_name || '—'} · {n.invoice_number || 'bez broja'} · {fmtMoney(n.amount || 0, n.currency || 'RSD')}
                </div>
              ))}
            </div>
          </details>
        )}

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
              <div style={{ fontSize: '15px', fontWeight: '500', color: '#E8F1FB', marginBottom: '4px' }}>Nema neplaćenih faktura.</div>
              <div style={{ fontSize: '12px', color: '#7A9BB8' }}>Sve fakture su izmirene</div>
            </div>
          ) : (
            <table style={ps.table}>
              <thead>
                <tr style={ps.thead}>
                  <th style={ps.th}>
                    <input type="checkbox" checked={selected.size === filtered.length && filtered.length > 0} onChange={toggleAll} style={{ cursor: 'pointer', accentColor: '#00D47E' }} />
                  </th>
                  <th style={ps.th}>Datum dospeća</th>
                  <th style={ps.th}>Partner</th>
                  <th style={ps.th}>Broj fakture</th>
                  <th style={ps.th}>Tip</th>
                  <th style={{ ...ps.th, textAlign: 'right' as const }}>Iznos</th>
                  <th style={{ ...ps.th, textAlign: 'right' as const }}>{currency}</th>
                  <th style={ps.th}>Račun primaoca</th>
                  <th style={ps.th}>Plaćanje</th>
                  <th style={ps.th}>Preostalo</th>
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
                  const line = lines[inv.id]
                  const problem = line ? problemOf(line) : null
                  const badge = ext?.badge?.(inv.id)
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
                        <input type="checkbox" aria-label={`Plati ${inv.invoice_number || ''}`} checked={isSelected} onChange={() => toggleSelect(inv)} style={{ cursor: 'pointer', accentColor: '#00D47E' }} />
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
                          {inv.document_type === 'proforma' && (
                            <span style={{ fontSize: '9px', fontWeight: '700', padding: '1px 6px', borderRadius: '20px', background: 'rgba(78,168,255,0.15)', color: '#4EA8FF', border: '0.5px solid rgba(78,168,255,0.3)', whiteSpace: 'nowrap' as const }}>
                              PREDRAČUN
                            </span>
                          )}
                          {inv.calculated_status === 'partial' && (
                            <span style={{ fontSize: '9px', fontWeight: '700', padding: '1px 6px', borderRadius: '20px', background: 'rgba(245,166,35,0.15)', color: '#F5A623', border: '0.5px solid rgba(245,166,35,0.3)', whiteSpace: 'nowrap' as const }}>
                              {inv.advance_used > 0 && !(inv.paid_own > 0) ? 'UMANJENO AVANSOM' : inv.adjustments < 0 && !(inv.paid_own > 0) ? 'UMANJENO ODOBRENJEM' : 'DELIMIČNO'}
                            </span>
                          )}
                          {badge && (
                            <span style={{ fontSize: '9px', fontWeight: '700', padding: '1px 6px', borderRadius: '20px', background: 'rgba(78,168,255,0.15)', color: '#4EA8FF', border: '0.5px solid rgba(78,168,255,0.3)', whiteSpace: 'nowrap' as const }}>
                              {badge}
                            </span>
                          )}
                        </div>
                      </td>
                      <td style={ps.td}>
                        <span style={{ fontSize: '10px', fontWeight: '600', padding: '2px 8px', borderRadius: '20px', background: inv.type === 'expense' ? 'rgba(255,91,90,0.12)' : 'rgba(0,212,126,0.12)', color: inv.type === 'expense' ? '#FF5B5A' : '#00D47E', letterSpacing: '0.02em' }}>
                          {inv.type === 'expense' ? 'ulazna' : inv.type === 'revenue' ? 'izlazna' : inv.type}
                        </span>
                      </td>
                      <td style={{ ...ps.td, textAlign: 'right' as const }}>
                        <div>
                          <span style={{ fontSize: '13px', fontWeight: '500', fontFamily: "'DM Mono', monospace", color: '#E8F1FB', whiteSpace: 'nowrap' as const }}>
                            {fmtMoney(inv.amount || 0, inv.currency)}
                          </span>
                          {inv.advance_used > 0 && (
                            <div style={{ fontSize: '10px', color: '#7A9BB8', marginTop: '2px', whiteSpace: 'nowrap' as const }}>
                              avans −{fmtMoney(inv.advance_used, inv.currency || 'RSD')}
                            </div>
                          )}
                          {inv.adjustments !== 0 && inv.adjustments != null && (
                            <div style={{ fontSize: '10px', color: '#7A9BB8', marginTop: '2px', whiteSpace: 'nowrap' as const }}>
                              {adjustmentSummary(inv.amount || 0, inv.adjustments, inv.currency || 'RSD')}
                            </div>
                          )}
                          {inv.calculated_status === 'partial' && (
                            <div style={{ fontSize: '10px', color: '#F5A623', marginTop: '2px', whiteSpace: 'nowrap' as const }}>
                              Preostalo: {fmtMoney(inv.outstanding_own || 0, inv.currency)}
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
                              od {fmt(pick(inv))}
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
                            <option value="">Izaberite račun…</option>
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
                              <span style={{ fontSize: '11px', color: '#FF5B5A', fontWeight: '500' }}>⚠ Nema računa</span>
                            )}
                          </div>
                        )}
                      </td>
                      <td style={ps.td}>
                        {line ? (
                          <div style={{ display: 'flex', flexDirection: 'column' as const, gap: '4px', minWidth: '210px' }}>
                            <div style={{ display: 'flex', alignItems: 'center', gap: '6px' }}>
                              <span style={{ fontSize: '10px', color: 'rgba(255,255,255,0.35)', width: '52px' }}>Plaća se</span>
                              <input aria-label={`Iznos za plaćanje ${inv.invoice_number || ''}`} inputMode="decimal"
                                readOnly={!!ext?.amountLocked?.(inv.id)}
                                style={{ ...ps.sel, width: '110px', fontSize: '12px', padding: '4px 7px', fontFamily: "'DM Mono', monospace", textAlign: 'right' as const, borderColor: problem ? '#FF5B5A' : undefined }}
                                value={line.amountText} onChange={e => patchLine(inv.id, { amountText: e.target.value })} />
                            </div>
                            <div style={{ display: 'flex', alignItems: 'center', gap: '6px' }}>
                              <span style={{ fontSize: '10px', color: 'rgba(255,255,255,0.35)', width: '52px' }}>Ostaje</span>
                              <span style={{ fontSize: '11px', fontFamily: "'DM Mono', monospace", color: remainingAfter(line, billOf(inv)) > 0 ? '#F5A623' : 'rgba(255,255,255,0.35)' }}>
                                {fmtMoney(Math.max(0, remainingAfter(line, billOf(inv))), inv.currency)}
                              </span>
                            </div>
                            <select aria-label={`Banka ${inv.invoice_number || ''}`} style={{ ...ps.sel, fontSize: '11px', padding: '4px 7px' }}
                              value={line.bankAccountId} onChange={e => patchLine(inv.id, { bankAccountId: e.target.value })}>
                              {bankAccounts.map(b => <option key={b.id} value={b.id}>{b.bank_name}{b.is_primary ? ' ★' : ''}</option>)}
                            </select>
                            <select aria-label={`Šifra plaćanja ${inv.invoice_number || ''}`} style={{ ...ps.sel, fontSize: '11px', padding: '4px 7px' }}
                              title={sifraLabel(line.paymentCode)}
                              value={line.paymentCode} onChange={e => patchLine(inv.id, { paymentCode: e.target.value })}>
                              {HALCOM_SIFRE.map(s => <option key={s.value} value={s.value}>{s.label}</option>)}
                            </select>
                            {problem && <span role="alert" style={{ fontSize: '10px', color: '#FF5B5A' }}>{problem}</span>}
                            {ext?.lineActions?.(line)}
                          </div>
                        ) : (
                          <span style={{ fontSize: '11px', color: 'rgba(255,255,255,0.2)' }}>—</span>
                        )}
                      </td>
                      <td style={ps.td}>
                        {days === null ? (
                          <span style={{ fontSize: '11px', color: 'rgba(255,255,255,0.25)' }}>Bez datuma dospeća</span>
                        ) : days < 0 ? (
                          <span style={{ fontSize: '11px', fontWeight: '700', color: '#FF5B5A', background: 'rgba(255,91,90,0.12)', padding: '2px 8px', borderRadius: '20px' }}>kasni {Math.abs(days)} d</span>
                        ) : days === 0 ? (
                          <span style={{ fontSize: '11px', fontWeight: '700', color: '#F5A623', background: 'rgba(245,166,35,0.12)', padding: '2px 8px', borderRadius: '20px' }}>Danas!</span>
                        ) : (
                          <span style={{ fontSize: '11px', color: days <= 7 ? '#F5A623' : 'rgba(255,255,255,0.35)' }}>još {days} d</span>
                        )}
                      </td>
                    </tr>
                  )
                })}
              </tbody>
              <tfoot>
                <tr style={{ background: '#060E1A', borderTop: '2px solid rgba(0,212,126,0.25)' }}>
                  <td colSpan={5} style={{ padding: '12px 16px', fontSize: '10px', fontWeight: '700', color: 'rgba(255,255,255,0.30)', letterSpacing: '0.1em', textTransform: 'uppercase' as const }}>
                    Ukupno ({countOf(filtered.length, 'faktura', 'fakture', 'faktura')})
                  </td>
                  <td style={{ padding: '12px 16px', textAlign: 'right' as const }}></td>
                  <td style={{ padding: '12px 16px', textAlign: 'right' as const, fontFamily: "'DM Mono', monospace", fontSize: '15px', fontWeight: '700', color: '#00D47E' }}>
                    {fmt(totalUnpaid)}
                  </td>
                  <td colSpan={3} style={{ padding: '12px 16px', fontSize: '11px', color: overdueCount > 0 ? '#FF5B5A' : 'rgba(255,255,255,0.25)', fontWeight: overdueCount > 0 ? '600' : '400' }}>
                    {overdueCount > 0 ? `${countOf(overdueCount, 'faktura', 'fakture', 'faktura')} u kašnjenju` : 'Sve na vreme ✓'}
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
            .select('type,calculated_status,remaining_rsd,remaining_eur,due_date')
            .in('calculated_status', ['unpaid', 'partial'])
            .eq('type', 'revenue')
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
    { label: 'Neto dobit (od početka godine)', value: loading ? '…' : fmt(kpis.netProfit),                         sub: `${currentYear}, od početka godine`, up: kpis.netProfit >= 0,      trend: loading ? '' : kpis.netProfit >= 0 ? 'Dobit' : 'Gubitak',    accent: kpis.netProfit >= 0 ? '#00D47E' : '#FF5B5A' },
    { label: 'Ukupni prihodi (od početka godine)', value: loading ? '…' : fmt(kpis.totalRevenue),                  sub: `${currentYear}, od početka godine`, up: true,                     trend: loading ? '' : `troškovi ${fmt(kpis.totalExpenses)}`,           accent: '#00D47E' },
    { label: 'Udeo troškova',       value: loading ? '…' : `${kpis.expenseRatio.toFixed(1).replace('.', ',')}%`,   sub: 'Troškovi / prihodi od početka godine', up: kpis.expenseRatio < 90,   trend: loading ? '' : kpis.expenseRatio < 80 ? 'Zdravo' : kpis.expenseRatio < 90 ? 'Pratiti' : 'Visoko', accent: kpis.expenseRatio < 80 ? '#00D47E' : kpis.expenseRatio < 90 ? '#F5A623' : '#FF5B5A' },
    { label: 'Otvorena potraživanja', value: loading ? '…' : kpis.openInvoicesCount > 0 ? `${kpis.openInvoicesCount} · ${fmt(kpis.openInvoicesAmount)}` : 'Nema', sub: loading ? '' : kpis.overdueCount > 0 ? `${kpis.overdueCount} u kašnjenju` : 'Sve na vreme', up: kpis.overdueCount === 0, trend: loading ? '' : kpis.overdueCount > 0 ? `${kpis.overdueCount} u kašnjenju` : 'Na vreme', accent: kpis.overdueCount > 0 ? '#FF5B5A' : '#4EA8FF' },
  ]

  const reports = [
    { id: 'project-profit',   title: 'Profitabilnost projekata', desc: 'Prihodi, direktni troškovi i marža po gradilištu, sa opštim troškovima u posebnom redu', category: 'P&L', icon: '🏗', color: '#0F6E56', bg: '#E1F5EE', page: 'projects' as Page,     action: null },
    { id: 'pl-by-project',    title: 'Troškovi po projektima', desc: 'Svi troškovi po projektu i kategoriji; Opšti troškovi posebno',   category: 'P&L',        icon: '🧭', color: '#0F6E56', bg: '#E1F5EE', page: 'expenses' as Page,     action: null },
    { id: 'pl-by-dept',       title: 'P&L po sektorima',     desc: 'Struktura troškova po organizacionoj jedinici',                       category: 'P&L',        icon: '👥', color: '#0F6E56', bg: '#E1F5EE', page: 'expenses' as Page,     action: null },
    { id: 'cashflow-monthly', title: 'Mesečni novčani tok',  desc: 'Poslovne i finansijske aktivnosti po periodima',                  category: 'Novčani tok',  icon: '💰', color: '#0C447C', bg: '#E6F1FB', page: 'cashflow' as Page,     action: null },
    { id: 'bank-rec',         title: 'Usaglašavanje sa bankom', desc: 'Izvod naspram proknjiženih transakcija po računu',              category: 'Novčani tok',  icon: '🏦', color: '#0C447C', bg: '#E6F1FB', page: 'cashflow' as Page,     action: null },
    { id: 'passthrough',      title: 'Stanje prolaznih stavki', desc: 'Mesečno stanje prolaznih uplata i isplata',                   category: 'Usklađenost', icon: '⚖️', color: '#633806', bg: '#FAEEDA', page: 'cashflow' as Page,     action: null },
    { id: 'unmatched',        title: 'Neuparene fakture',    desc: 'Neplaćene fakture · izvoz za Hal E-Bank (TKDIS)', category: 'Usklađenost', icon: '⚠️', color: '#854F0B', bg: '#FAEEDA', page: 'reports' as Page,      action: 'unpaid' },
    { id: 'exchange-rates',   title: 'Evidencija kurseva',   desc: 'Kursevi korišćeni po periodu i transakciji',                       category: 'Referentno',  icon: '💱', color: '#444',    bg: '#f0f0ee', page: 'reports' as Page,      action: null },
    { id: 'partner-summary',  title: 'Pregled partnera',     desc: 'Ukupne transakcije po partneru u svim firmama',                     category: 'Referentno',  icon: '🤝', color: '#444',    bg: '#f0f0ee', page: 'partners' as Page,     action: null },
  ]

  const categories = ['P&L', 'Novčani tok', 'Usklađenost', 'Referentno']
  const categoryColors: Record<string, { color: string; bg: string; accent: string }> = {
    'P&L':        { color: '#0F6E56', bg: '#E1F5EE', accent: '#00D47E' },
    'Novčani tok': { color: '#0C447C', bg: '#E6F1FB', accent: '#4EA8FF' },
    'Usklađenost': { color: '#633806', bg: '#FAEEDA', accent: '#F5A623' },
    'Referentno':  { color: '#555',    bg: '#f0f0ee', accent: '#7A9BB8' },
  }

  return (
    <div style={s.root} className="app-surface">
      <div style={s.body}>

        {/* ── Page header ── */}
        <div style={s.pageHeader}>
          <div>
            <div style={s.pageTitle}>Izveštaji</div>
            <div style={s.pageSub}>Finansijski izveštaji i analize · {currentYear}, od početka godine</div>
          </div>
          <div style={{ display: 'flex', gap: '10px', alignItems: 'center' }}>
            {showPicker && (
              <select style={s.filterSelect} value={companyId} onChange={e => setCompanyId(e.target.value)}>
                <option value="all">Sve firme</option>
                {companies.map(c => <option key={c.id} value={c.id}>{c.name}</option>)}
              </select>
            )}
            <button onClick={fetchKpis} style={{ fontFamily: "'Inter', sans-serif", fontSize: '12px', padding: '8px 14px', border: '1px solid rgba(0,212,126,0.3)', borderRadius: '9px', background: 'rgba(0,212,126,0.06)', color: '#00D47E', cursor: 'pointer', fontWeight: '500' }}>↻ Osveži</button>
          </div>
        </div>

        {/* ── KPI section label ── */}
        <div style={{ fontSize: '10px', fontWeight: '600', color: 'rgba(255,255,255,0.22)', letterSpacing: '0.12em', textTransform: 'uppercase' as const, marginBottom: '10px' }}>
          Ključni pokazatelji · {currentYear}, od početka godine
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
            <div style={{ fontSize: '11px', fontWeight: '700', color: '#F5A623', marginBottom: '8px', letterSpacing: '0.04em', textTransform: 'uppercase' as const }}>Potrebna pažnja</div>
            {kpis.overdueCount > 0 && (
              <div style={s.alertRow}>
                <span style={s.alertDot} />
                <span style={{ fontSize: '12px', color: '#DCE9F6' }}>
                  {countOf(kpis.overdueCount, 'faktura je', 'fakture su', 'faktura je')} posle datuma dospeća —{' '}
                  <span style={{ color: '#F5A623', cursor: 'pointer', textDecoration: 'underline', textDecorationColor: 'rgba(245,166,35,0.4)' }} onClick={() => setShowUnpaidPanel(true)}>
                    otvori Neuparene fakture
                  </span>.
                </span>
              </div>
            )}
            {kpis.unmatchedPassthrough > 0 && (
              <div style={s.alertRow}>
                <span style={s.alertDot} />
                <span style={{ fontSize: '12px', color: '#DCE9F6' }}>{countOf(kpis.unmatchedPassthrough, 'prolazna stavka nije uparena', 'prolazne stavke nisu uparene', 'prolaznih stavki nije upareno')} — proverite Novčani tok.</span>
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
              <span style={s.categoryCount}>{countOf(reports.filter(r => r.category === cat).length, 'izveštaj', 'izveštaja', 'izveštaja')}</span>
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
          Otvori →
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