import React, { useState, useEffect, useCallback, useMemo, useRef } from 'react'
import { supabase } from '../supabase'
import { DIALOG, chrome } from './dialogTheme'
import PartnerDialog from './PartnerDialog'
import InvoiceDialog from './InvoiceDialog'
import { fetchAllPages } from '../utils/fetchAllPages'
import { MONTHS_SHORT_SR } from '../utils/months'
import { fmtLocal } from '../utils/formatters'
import { findLikelyDuplicate, type LedgerInvoice } from '../services/sef/sefDuplicate'
import { matchSupplier, type PartnerLite, type SupplierMatch } from '../services/sef/matchPartner'
import { matchCompany, type CompanyLite } from '../services/sef/matchCompany'
import { parseUbl } from '../services/sef/ublInvoice'
import { bookedDateOf } from '../services/sef/draftFromUbl'
import {
  salesDraftFromUbl, salesBookingRefusal, salesReviewNotes, isVoidedOnSef, voidedLabel,
} from '../services/sef/salesDraft'
import {
  sefPdfUrl, sefObjectUrl, attachmentsByInbox, attachmentLabel, ATTACHMENT_COLUMNS, type SefAttachmentRow,
} from '../services/sef/sefPdf'
import { getBookRates, rateFor } from '../services/bookAmounts'
import { fetchProjects, type Project } from '../services/projects'
import type { RentalLease } from '../services/revenuePlan'
import { proposeLease, proposeProject } from '../services/revenueClassification'

// The inbox of invoices WE issued, as SEF lists them (direction 'sales').
//
// The mirror of the purchase inbox, without what only a received invoice
// needs: nothing here accepts or rejects on SEF, and nothing warns about the
// "New" status, because the PDFs and the document are stored when the invoice
// is pulled and booking reads our own table, never SEF.

interface Props {
  onClose: () => void
  /** Called once an invoice has been booked or linked and its row marked. */
  onImported: () => void
}

type State = 'pending' | 'imported' | 'dismissed'
type Filter = State | 'all'

interface SalesRow {
  id: string
  sef_invoice_id: number
  document_number: string | null
  document_type: string | null
  customer_name: string | null
  customer_vat_number: string | null
  customer_registration_number: string | null
  amount: number | null
  currency: string | null
  issue_date: string | null
  due_date: string | null
  sent_date: string | null
  sef_status: string | null
  sef_comment: string | null
  state: State
  dismiss_reason: string | null
  dismissed_at: string | null
  imported_at: string | null
  pdf_path: string | null
}

interface Booking {
  row: SalesRow
  draft: Record<string, unknown>
  notes: string[]
  isCreditNote: boolean
  documents: { label: string; open: () => void }[]
}

// Named, not `*`: the table also holds each invoice's whole UBL document.
const INBOX_COLUMNS = [
  'id', 'sef_invoice_id', 'document_number', 'document_type', 'customer_name',
  'customer_vat_number', 'customer_registration_number', 'amount', 'currency',
  'issue_date', 'due_date', 'sent_date', 'sef_status', 'sef_comment', 'state',
  'dismiss_reason', 'dismissed_at', 'imported_at', 'pdf_path',
].join(', ')

const LEDGER_COLUMNS = 'id, invoice_number, invoice_date, amount, currency, partner_id, project_id, lease_id, service_month'

/** A revenue invoice in the books: for the duplicate check and for classifying the next one. */
type LedgerRow = LedgerInvoice & { project_id?: string | null; lease_id?: string | null; service_month?: string | null }

function fmtDate(value: string | null | undefined): string {
  const m = /^(\d{4})-(\d{2})-(\d{2})/.exec(value || '')
  if (!m) return value || '—'
  return `${Number(m[3])}. ${MONTHS_SHORT_SR[Number(m[2]) - 1]} ${m[1]}.`
}

// `en-CA` is only the shortest route to a YYYY-MM-DD key in Belgrade time.
const belgrade = new Intl.DateTimeFormat('en-CA', { timeZone: 'Europe/Belgrade' })
function belgradeDay(moment: string | null | undefined): string {
  if (!moment) return ''
  const d = new Date(moment)
  return isNaN(d.getTime()) ? '' : belgrade.format(d)
}

function fmtAmount(amount: number | null, currency: string | null): string {
  if (amount === null || amount === undefined) return '—'
  return currency ? fmtLocal(Number(amount), currency) : String(amount)
}

const isCreditNote = (r: SalesRow) => /credit/i.test(r.document_type || '')

const FILTERS: { key: Filter; label: string }[] = [
  { key: 'pending', label: 'Na čekanju' },
  { key: 'imported', label: 'Proknjižene' },
  { key: 'dismissed', label: 'Odbijene' },
  { key: 'all', label: 'Sve' },
]

const EMPTY_TEXT: Record<Filter, string> = {
  pending: 'Ništa ne čeka. Nove izlazne fakture se pojavljuju ovde posle sledećeg preuzimanja sa SEF-a.',
  imported: 'Još nijedna izlazna faktura sa SEF-a nije proknjižena.',
  dismissed: 'Nijedna faktura nije odbijena.',
  all: 'Sanduče izlaznih faktura je prazno.',
}

export default function SefSalesInboxDialog({ onClose, onImported }: Props) {
  const [rows, setRows] = useState<SalesRow[]>([])
  const [ledger, setLedger] = useState<LedgerRow[]>([])
  const [leases, setLeases] = useState<RentalLease[]>([])
  const [projects, setProjects] = useState<Project[]>([])
  const [partners, setPartners] = useState<PartnerLite[]>([])
  const [companies, setCompanies] = useState<CompanyLite[]>([])
  const [attachments, setAttachments] = useState<Map<string, SefAttachmentRow[]>>(new Map())
  const [attachmentsOpen, setAttachmentsOpen] = useState<string | null>(null)
  const [loading, setLoading] = useState(true)
  const [inboxFailed, setInboxFailed] = useState(false)
  const [filter, setFilter] = useState<Filter>('pending')
  const [declining, setDeclining] = useState<SalesRow | null>(null)
  const [reason, setReason] = useState('')
  const [newCustomer, setNewCustomer] = useState<SalesRow | null>(null)
  const [booking, setBooking] = useState<Booking | null>(null)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const [rowError, setRowError] = useState<{ id: string; text: string } | null>(null)

  const inFlight = useRef(false)
  const markedRows = useRef(new Set<string>())
  const mounted = useRef(true)
  useEffect(() => {
    mounted.current = true
    return () => { mounted.current = false }
  }, [])

  const load = useCallback(async () => {
    const problems: string[] = []
    const [inbox, ledgerRows, partnerRows, companyRows, attachmentRows, leaseRows, projectRows] = await Promise.all([
      fetchAllPages<SalesRow>((from, to) =>
        supabase.from('sef_inbox').select(INBOX_COLUMNS)
          .eq('direction', 'sales')
          .order('issue_date', { ascending: false, nullsFirst: false }).order('id')
          .range(from, to))
        .catch((e: any) => { problems.push(`Sanduče nije pročitano: ${e?.message || e}`); return null }),
      fetchAllPages<LedgerRow>((from, to) =>
        supabase.from('invoices').select(LEDGER_COLUMNS)
          .eq('type', 'revenue')
          .is('parent_invoice_id', null)
          .order('invoice_date', { ascending: false }).order('id')
          .range(from, to))
        .catch((e: any) => { problems.push(`Knjige nisu pročitane, pa duplikati nisu provereni: ${e?.message || e}`); return [] as LedgerRow[] }),
      fetchAllPages<PartnerLite>((from, to) =>
        supabase.from('partners').select('id, name, tax_id, registration_number')
          .order('id').range(from, to))
        .catch((e: any) => { problems.push(`Partneri nisu pročitani, pa kupci nisu prepoznati: ${e?.message || e}`); return [] as PartnerLite[] }),
      Promise.all([
        Promise.resolve(supabase.from('companies').select('id, name').order('name')),
        Promise.resolve(supabase.from('company_profiles').select('company_id, pib, mb')),
      ]).then(([c, prof]: any[]) => {
        if (c.error) throw c.error
        if (prof.error) throw prof.error
        const byCompany = new Map<string, any>()
        ;(prof.data || []).forEach((r: any) => byCompany.set(r.company_id, r))
        return (c.data || []).map((r: any) => ({
          id: r.id, name: r.name,
          pib: byCompany.get(r.id)?.pib ?? null,
          mb: byCompany.get(r.id)?.mb ?? null,
        })) as CompanyLite[]
      }).catch((e: any) => {
        problems.push(`Firme nisu pročitane, pa prodavac sa fakture nije prepoznat: ${e?.message || e}`)
        return [] as CompanyLite[]
      }),
      fetchAllPages<SefAttachmentRow>((from, to) =>
        supabase.from('sef_inbox_attachments').select(ATTACHMENT_COLUMNS)
          .order('id').range(from, to))
        .catch((e: any) => { problems.push(`Prilozi nisu pročitani: ${e?.message || e}`); return [] as SefAttachmentRow[] }),
      fetchAllPages<RentalLease>((from, to) =>
        supabase.from('rental_leases').select('*').order('id').range(from, to))
        .catch((e: any) => { problems.push(`Zakupi nisu pročitani, pa zakup nije predložen: ${e?.message || e}`); return [] as RentalLease[] }),
      fetchProjects(supabase)
        .catch((e: any) => { problems.push(`Projekti nisu pročitani, pa projekat nije predložen: ${e?.message || e}`); return [] as Project[] }),
    ])

    if (!mounted.current) return
    setInboxFailed(!inbox)
    if (inbox) setRows(inbox)
    setLedger(ledgerRows)
    setLeases(leaseRows)
    setProjects(projectRows)
    setPartners(partnerRows)
    setCompanies(companyRows)
    setAttachments(attachmentsByInbox(attachmentRows))
    setError(problems.join(' '))
    setLoading(false)
  }, [])

  useEffect(() => { load() }, [load])

  const exclusive = async (fn: () => Promise<void>) => {
    if (inFlight.current) return
    inFlight.current = true
    setBusy(true)
    try { await fn() } finally {
      inFlight.current = false
      if (mounted.current) setBusy(false)
    }
  }

  const counts = useMemo(() => {
    const c: Record<Filter, number> = { pending: 0, imported: 0, dismissed: 0, all: rows.length }
    rows.forEach(r => { c[r.state] += 1 })
    return c
  }, [rows])

  const visible = useMemo(
    () => (filter === 'all' ? rows : rows.filter(r => r.state === filter)), [rows, filter])

  const matches = useMemo(() => {
    const m = new Map<string, SupplierMatch | null>()
    visible.forEach(r => m.set(r.id, matchSupplier({
      vatNumber: r.customer_vat_number,
      registrationNumber: r.customer_registration_number,
      name: r.customer_name,
    }, partners)))
    return m
  }, [visible, partners])

  const decline = () => exclusive(async () => {
    if (!declining || !reason.trim()) return
    setError(''); setRowError(null)
    const { data, error: err } = await supabase.from('sef_inbox').update({
      state: 'dismissed',
      dismiss_reason: reason.trim(),
      dismissed_at: new Date().toISOString(),
    }).eq('id', declining.id).select('id')
    if (err) { setRowError({ id: declining.id, text: err.message }); return }
    if (!data || data.length === 0) { setRowError({ id: declining.id, text: 'Ništa nije promenjeno. Faktura je možda uklonjena ili nije vaša da je odbijete.' }); return }
    setDeclining(null); setReason('')
    await load()
  })

  const restore = (row: SalesRow) => exclusive(async () => {
    setError(''); setRowError(null)
    const { data, error: err } = await supabase.from('sef_inbox').update({
      state: 'pending', restored_at: new Date().toISOString(),
    }).eq('id', row.id).select('id')
    if (err) { setRowError({ id: row.id, text: err.message }); return }
    if (!data || data.length === 0) { setRowError({ id: row.id, text: 'Ništa nije promenjeno. Faktura je možda uklonjena ili nije vaša da je vratite.' }); return }
    await load()
  })

  const openSigned = async (rowId: string, sign: () => Promise<string | null>) => {
    setRowError(null)
    const tab = window.open('', '_blank')
    try {
      const url = await sign()
      if (!url) throw new Error('PDF nije dostupan.')
      if (tab) { tab.opener = null; tab.location.href = url } else window.open(url, '_blank', 'noopener')
    } catch (e) {
      tab?.close()
      setRowError({ id: rowId, text: `PDF ne može da se otvori: ${e instanceof Error ? e.message : String(e)}` })
    }
  }
  const showPdf = (row: SalesRow) => openSigned(row.id, () => sefPdfUrl(supabase, row))
  const showAttachment = (row: SalesRow, a: SefAttachmentRow) => openSigned(row.id, () => sefObjectUrl(supabase, a.path))

  /**
   * Reads the stored document of the row (our own table, no SEF call), drafts
   * a revenue invoice and opens the invoice dialog on it.
   */
  const book = (row: SalesRow) => exclusive(async () => {
    setError(''); setRowError(null)
    const { data, error: readErr } = await supabase.from('sef_inbox').select('ubl_xml').eq('id', row.id).maybeSingle()
    const xml = (data as any)?.ubl_xml
    if (readErr || !xml) {
      setRowError({ id: row.id, text: readErr?.message || 'Dokument ove fakture nije sačuvan, pa ne može da se proknjiži.' })
      return
    }
    let ubl
    try { ubl = parseUbl(String(xml)) } catch {
      setRowError({ id: row.id, text: 'Dokument ne može da se pročita kao faktura.' })
      return
    }

    const refusal = salesBookingRefusal(ubl, row)
    if (refusal) { setRowError({ id: row.id, text: refusal }); return }

    const match = matchSupplier({
      vatNumber: ubl.customerVatNumber ?? row.customer_vat_number,
      registrationNumber: ubl.customerRegistrationNumber ?? row.customer_registration_number,
      name: ubl.customerName ?? row.customer_name,
    }, partners)

    // The seller is us: the company is the one whose PIB is the seller's.
    const companyMatch = matchCompany({
      vatNumber: ubl.supplierVatNumber,
      registrationNumber: ubl.supplierRegistrationNumber,
    }, companies)
    const companyId = companyMatch?.companyId ?? null

    // On the date of supply, like the purchase side. Without an official rate
    // the fields stay empty and the owner presses Preuzmi in the dialog.
    let rate: number | null = null
    let eurRate: number | null = null
    try {
      const day = bookedDateOf(ubl)
      if (day) {
        const rates = await getBookRates(day)
        const r = rateFor(ubl.currency || row.currency || 'RSD', rates)
        if (Number.isFinite(r) && r > 0) rate = r
        if (Number.isFinite(rates.eurRate) && rates.eurRate > 0) eurRate = rates.eurRate
      }
    } catch { /* left to the owner */ }

    const notes = salesReviewNotes(ubl, {
      matchedBy: match?.by ?? null,
      company: {
        by: companyMatch?.by ?? null,
        name: companies.find(c => c.id === companyId)?.name ?? null,
      },
    })

    // What the invoice is: rent from a lease first, then a project. Only a
    // suggestion: the person confirms or changes it in the dialog.
    const draft = salesDraftFromUbl(ubl, row, match?.partnerId ?? null, companyId, rate, eurRate)
    {
      const partnerId = match?.partnerId ?? null
      // The notes and line names. Not the number: IF-12/2026 is not December.
      const text = ubl.advanceText
      const asLease = ubl.isCreditNote || ubl.isDebitNote || ubl.isAdvanceInvoice ? null : proposeLease({
        partnerId, net: ubl.net, gross: ubl.grossTotal ?? ubl.total, currency: ubl.currency || row.currency,
        date: bookedDateOf(ubl) || '', text,
      }, leases, ledger.map(l => ({
        project_id: l.project_id ?? null, type: 'revenue', invoice_date: l.invoice_date || '',
        lease_id: l.lease_id ?? null, service_month: l.service_month ?? null,
      })))
      if (asLease) {
        Object.assign(draft, {
          revenue_kind: 'lease', lease_id: asLease.leaseId, service_month: asLease.serviceMonth,
          project_id: asLease.projectId, classification_why: `Zakup: ${asLease.why}`,
        })
        notes.push(`Predlog razvrstavanja — zakup: ${asLease.why}`)
        if (asLease.alreadyBilled) notes.push('Za taj mesec već postoji faktura za ovaj zakup. Proverite da nije ista faktura.')
      } else {
        const asProject = proposeProject({ partnerId, number: ubl.invoiceNumber, text }, projects, ledger.map(l => ({
          partner_id: l.partner_id, project_id: l.project_id ?? null, invoice_date: l.invoice_date, lease_id: l.lease_id ?? null,
        })))
        if (asProject) {
          Object.assign(draft, {
            revenue_kind: 'project', project_id: asProject.projectId, classification_why: `Projekat: ${asProject.why}`,
          })
          notes.push(`Predlog razvrstavanja — projekat: ${asProject.why}`)
        } else {
          notes.push('Razvrstavanje nije predloženo: izaberite projekat, zakup ili prodaju usluga.')
        }
      }
    }

    const documents = [
      ...(row.pdf_path ? [{ label: 'Faktura (SEF)', open: () => showPdf(row) }] : []),
      ...(attachments.get(row.id) || []).map(a => ({ label: attachmentLabel(a), open: () => showAttachment(row, a) })),
    ]

    if (!mounted.current) return
    setBooking({
      row, notes, isCreditNote: ubl.isCreditNote, documents,
      draft,
    })
  })

  /**
   * An invoice was created (or an existing one chosen): mark the row against
   * it. The invoice first, the row second, so a failure leaves more than was
   * asked for and never less. Through the rpc, which raises on a refusal.
   */
  const markImported = async (row: SalesRow, invoiceId: string, what: string) => {
    if (markedRows.current.has(row.id)) return
    markedRows.current.add(row.id)
    try {
      const { error: rpcErr } = await supabase.rpc('sef_inbox_mark_imported', { p_id: row.id, p_invoice_id: invoiceId })
      if (rpcErr) throw rpcErr
    } catch (e: any) {
      markedRows.current.delete(row.id)
      if (mounted.current) {
        setRowError({ id: row.id, text: `${what}, ali red nije mogao da se označi kao proknjižen: ${e?.message || e}` })
      }
      return
    }
    if (!mounted.current) return
    await load()
    onImported()
  }

  const link = (row: SalesRow, invoiceId: string) => exclusive(async () => {
    setError(''); setRowError(null)
    await markImported(row, invoiceId, 'Faktura je povezana')
  })

  const renderRow = (row: SalesRow) => {
    const match = matches.get(row.id) ?? null
    const voided = isVoidedOnSef(row.sef_status)
    const voidText = voidedLabel(row.sef_status)
    const paid = /^paid$/i.test((row.sef_status || '').trim())
    const dup = row.state === 'pending' && !voided
      ? findLikelyDuplicate(
        { document_number: row.document_number, amount: row.amount, currency: row.currency, partner_id: match?.partnerId ?? null },
        ledger)
      : null
    const rowAttachments = attachments.get(row.id) || []

    return (
      <div key={row.id} data-row={row.id} style={s.row}>
        <div style={s.rowTop}>
          <div style={{ minWidth: 0, flex: 1 }}>
            <div style={s.line}>
              <span style={s.customer}>{row.customer_name || 'Nepoznat kupac'}</span>
              {isCreditNote(row) && <span style={{ ...s.badge, background: DIALOG.blueFill, color: DIALOG.blue }}>Knjižno odobrenje</span>}
              {/prepayment/i.test(row.document_type || '') && <span style={{ ...s.badge, background: DIALOG.amberFill, color: DIALOG.amber }}>Avansni račun</span>}
              {voidText && <span style={{ ...s.badge, background: DIALOG.redFill, color: DIALOG.red }}>{voidText}</span>}
              {paid && <span style={{ ...s.badge, background: DIALOG.accentFill, color: DIALOG.accent }}>Plaćena (SEF)</span>}
              {!match && row.state === 'pending' && !voided && (
                <button style={s.linkBtn} disabled={busy} onClick={() => setNewCustomer(row)}>Dodaj kupca</button>
              )}
              {match?.by === 'name' && (
                <span style={{ ...s.badge, background: DIALOG.amberFill, color: DIALOG.amber }}>Prepoznat samo po nazivu</span>
              )}
            </div>
            <div style={s.meta}>
              {row.customer_vat_number ? `PIB ${row.customer_vat_number}` : 'Bez PIB-a'}
              {' · '}Br. {row.document_number || '—'}
            </div>
            <div style={s.meta}>
              Izdata {fmtDate(row.issue_date || belgradeDay(row.sent_date))} · Dospeva {fmtDate(row.due_date)} · SEF status {paid ? 'Plaćena' : (row.sef_status || '—')}
            </div>
          </div>
          <div style={s.amount}>{fmtAmount(row.amount, row.currency)}</div>
        </div>

        {dup && (
          <div style={{ ...s.flag, color: DIALOG.amber, background: DIALOG.amberFill }}>
            Već imate fakturu {dup.invoice.invoice_number} od {fmtDate(dup.invoice.invoice_date)} istog kupca.
          </div>
        )}
        {row.state === 'dismissed' && (
          <div style={{ ...s.flag, color: DIALOG.dim, background: DIALOG.raised }}>
            Odbijena{row.dismissed_at ? ` ${fmtDate(belgradeDay(row.dismissed_at))}` : ''}: {row.dismiss_reason}
          </div>
        )}
        {row.state === 'imported' && (
          <div style={{ ...s.flag, color: DIALOG.accent, background: DIALOG.accentFill }}>
            Proknjižena{row.imported_at ? ` ${fmtDate(belgradeDay(row.imported_at))}` : ''}
          </div>
        )}
        {rowError?.id === row.id && (
          <div role="alert" style={{ ...s.flag, color: DIALOG.red, background: DIALOG.redFill }}>{rowError.text}</div>
        )}

        {declining?.id === row.id && (
          <div style={s.declinePanel}>
            <label style={s.lbl}>
              Zašto je odbijate?
              <textarea aria-label="Razlog" style={s.textarea} rows={2} value={reason} autoFocus
                onChange={e => setReason(e.target.value)} />
            </label>
            <div style={s.actions}>
              <button style={s.btnGhost} disabled={busy} onClick={() => { setDeclining(null); setReason('') }}>Otkaži</button>
              <button style={{ ...s.btnDanger, opacity: !reason.trim() || busy ? 0.5 : 1 }}
                disabled={!reason.trim() || busy} onClick={decline}>Odbij ovu fakturu</button>
            </div>
          </div>
        )}

        {declining?.id !== row.id && (
          <div style={s.actions}>
            {row.state === 'pending' && dup && !voided && (
              <button style={s.btnGhost} disabled={busy} onClick={() => link(row, dup.invoice.id)}>Poveži sa postojećom</button>
            )}
            {row.state === 'pending' && !voided && (
              <button style={{ ...s.btnPrimary, opacity: busy ? 0.5 : 1 }} disabled={busy}
                onClick={() => book(row)}>Proknjiži</button>
            )}
            {row.state === 'pending' && (
              <button style={s.btnGhost} disabled={busy}
                onClick={() => { setDeclining(row); setReason(''); setError(''); setRowError(null) }}>Odbij</button>
            )}
            {row.state !== 'pending' && (
              <button style={s.btnGhost} disabled={busy} onClick={() => restore(row)}>Vrati u red</button>
            )}
            {row.pdf_path
              ? <button style={s.btnGhost} onClick={() => showPdf(row)}>Prikaži fakturu</button>
              : <span style={{ ...s.hint, marginTop: 0, alignSelf: 'center' }}>PDF nije dostupan</span>}
            {rowAttachments.length > 0 && (
              <button style={s.btnGhost} aria-expanded={attachmentsOpen === row.id}
                onClick={() => setAttachmentsOpen(attachmentsOpen === row.id ? null : row.id)}>
                Prilozi ({rowAttachments.length})
              </button>
            )}
          </div>
        )}
        {attachmentsOpen === row.id && rowAttachments.length > 0 && (
          <ul aria-label="Prilozi fakture" style={{ margin: '6px 0 0', paddingLeft: '18px', fontSize: '12px' }}>
            {rowAttachments.map(a => (
              <li key={a.id}>
                <button style={s.linkBtn} onClick={() => showAttachment(row, a)}>{attachmentLabel(a)}</button>
              </li>
            ))}
          </ul>
        )}
      </div>
    )
  }

  return (
    <>
      <div style={chrome.overlay}>
        <div style={s.dialog}>
          <div style={chrome.header}>
            <div>
              <div style={chrome.headerTitle}>📤 SEF izlazne fakture</div>
              <div style={chrome.headerSub}>Fakture koje ste izdali preko SEF-a</div>
            </div>
            <button style={chrome.closeBtn} onClick={onClose} aria-label="Zatvori">×</button>
          </div>

          <div style={s.body}>
            {error && <div style={{ ...s.banner, background: DIALOG.redFill, borderColor: DIALOG.redSoft, color: DIALOG.red }}>{error}</div>}

            {!loading && inboxFailed && (
              <div style={s.empty}>
                Sanduče nije moglo da se pročita, pa se ne zna šta čeka.
                <div style={{ marginTop: '10px' }}>
                  <button style={s.btnGhost} disabled={busy} onClick={() => { setLoading(true); load() }}>Pokušaj ponovo</button>
                </div>
              </div>
            )}

            {!inboxFailed && <div style={s.chips}>
              {FILTERS.map(f => (
                <button key={f.key} onClick={() => setFilter(f.key)}
                  style={{
                    ...s.chip,
                    background: filter === f.key ? 'rgba(255,255,255,0.08)' : 'transparent',
                    color: filter === f.key ? DIALOG.text : DIALOG.faint,
                    borderColor: filter === f.key ? 'rgba(255,255,255,0.15)' : 'transparent',
                  }}>
                  <span>{f.label}</span>
                  <span style={{ marginLeft: '6px', opacity: 0.7 }}>{counts[f.key]}</span>
                </button>
              ))}
            </div>}

            {loading && <div style={s.empty}>Učitavanje…</div>}
            {!loading && !inboxFailed && visible.length === 0 && <div style={s.empty}>{EMPTY_TEXT[filter]}</div>}
            {!loading && !inboxFailed && visible.map(renderRow)}
          </div>
        </div>
      </div>

      {booking && (
        <InvoiceDialog
          invoice={booking.draft}
          creditNote={booking.isCreditNote}
          sourceDocuments={booking.documents}
          reviewNotes={booking.notes}
          onSaved={(invoiceId: string) => markImported(booking.row, invoiceId, 'Faktura je sačuvana')}
          onClose={() => { setBooking(null); load() }} />
      )}

      {newCustomer && (
        <PartnerDialog
          initialName={newCustomer.customer_name || ''}
          initialTaxId={newCustomer.customer_vat_number || ''}
          initialRegistrationNumber={newCustomer.customer_registration_number || ''}
          onClose={() => setNewCustomer(null)}
          onSaved={(p: PartnerLite) => { setPartners(prev => [...prev, p]); setNewCustomer(null) }} />
      )}
    </>
  )
}

const s: Record<string, React.CSSProperties> = {
  dialog: { background: DIALOG.panel, borderRadius: '16px', width: '920px', maxWidth: '96vw', maxHeight: '92vh', display: 'flex', flexDirection: 'column', overflow: 'hidden', boxShadow: DIALOG.shadow },
  body: { padding: '1.25rem 1.5rem 1.5rem', overflowY: 'auto', flex: 1, background: DIALOG.panel },
  banner: { fontSize: '12px', lineHeight: 1.5, border: '0.5px solid', borderRadius: '8px', padding: '10px 14px', marginBottom: '12px' },
  chips: { display: 'flex', gap: '6px', marginBottom: '14px' },
  chip: { fontFamily: 'system-ui,sans-serif', fontSize: '12px', fontWeight: 500, padding: '5px 12px', borderRadius: '20px', border: '1px solid', cursor: 'pointer' },
  empty: { fontSize: '13px', color: DIALOG.dim, textAlign: 'center', padding: '36px 0' },
  row: { border: '0.5px solid ' + DIALOG.border, borderRadius: '10px', background: DIALOG.raised, padding: '12px 14px', marginBottom: '10px' },
  rowTop: { display: 'flex', alignItems: 'flex-start', gap: '16px' },
  line: { display: 'flex', alignItems: 'center', gap: '8px', flexWrap: 'wrap' },
  customer: { fontSize: '14px', fontWeight: 500, color: DIALOG.text },
  meta: { fontSize: '12px', color: DIALOG.dim, marginTop: '3px' },
  amount: { fontSize: '15px', fontWeight: 600, color: DIALOG.text, whiteSpace: 'nowrap' },
  badge: { fontSize: '10px', fontWeight: 500, padding: '2px 8px', borderRadius: '20px' },
  flag: { fontSize: '12px', lineHeight: 1.5, borderRadius: '6px', padding: '6px 10px', marginTop: '8px' },
  actions: { display: 'flex', gap: '8px', justifyContent: 'flex-end', marginTop: '10px' },
  declinePanel: { marginTop: '10px', paddingTop: '10px', borderTop: '0.5px solid ' + DIALOG.border },
  lbl: { display: 'block', fontSize: '12px', color: DIALOG.dim },
  hint: { fontSize: '11px', color: DIALOG.faint, marginTop: '6px' },
  textarea: { display: 'block', width: '100%', boxSizing: 'border-box', marginTop: '6px', background: DIALOG.panel, color: DIALOG.text, border: '1px solid ' + DIALOG.border, borderRadius: '8px', padding: '8px 10px', fontFamily: 'system-ui,sans-serif', fontSize: '13px', resize: 'vertical' },
  btnPrimary: { background: DIALOG.accent, color: DIALOG.onAccent, border: 'none', borderRadius: '8px', padding: '7px 14px', fontFamily: 'system-ui,sans-serif', fontSize: '12px', fontWeight: 600, cursor: 'pointer' },
  btnGhost: { background: 'transparent', color: DIALOG.dim, border: '1px solid ' + DIALOG.border, borderRadius: '8px', padding: '7px 14px', fontFamily: 'system-ui,sans-serif', fontSize: '12px', fontWeight: 500, cursor: 'pointer' },
  btnDanger: { background: DIALOG.redFill, color: DIALOG.red, border: '1px solid ' + DIALOG.redSoft, borderRadius: '8px', padding: '7px 14px', fontFamily: 'system-ui,sans-serif', fontSize: '12px', fontWeight: 600, cursor: 'pointer' },
  linkBtn: { background: 'none', border: 'none', color: DIALOG.accent, fontFamily: 'system-ui,sans-serif', fontSize: '12px', cursor: 'pointer', padding: 0, textDecoration: 'underline' },
}
