import React, { useState, useEffect, useCallback, useMemo, useRef } from 'react'
import { supabase } from '../supabase'
import { DIALOG, chrome } from './dialogTheme'
import PartnerDialog from './PartnerDialog'
import InvoiceDialog from './InvoiceDialog'
import { fetchAllPages } from '../utils/fetchAllPages'
import { MONTHS_SHORT_SR } from '../utils/months'
import { fmtLocal } from '../utils/formatters'
import { plural } from '../utils/plural'
import { findLikelyDuplicate, type LedgerInvoice } from '../services/sef/sefDuplicate'
import { matchSupplier, type PartnerLite, type SupplierMatch } from '../services/sef/matchPartner'
import { matchCompany, type CompanyLite } from '../services/sef/matchCompany'
import { proposeClassification, type PastInvoice, type Proposal } from '../services/sef/proposeClassification'
import { parseUbl } from '../services/sef/ublInvoice'
import { draftFromUbl, reviewNotesFor, bookedDateOf } from '../services/sef/draftFromUbl'
import { fetchScripts } from '../services/quickFillStore'
import { getBookRates, rateFor } from '../services/bookAmounts'
import type { ScriptLike } from '../services/expenseSplit'

// The inbox of invoices SEF has sent us.
//
// One asymmetry shapes the whole screen. Fetching an invoice's DOCUMENT moves
// its status in SEF from New to Seen, and the owner's accounting firm reads
// the same mailbox and relies on that status. So everything the owner needs to
// DECIDE — supplier, number, amount, dates — is already on the row, declining
// is a write to our own table and never touches SEF, and "Open and book" says
// what it costs before the click.

interface Props {
  onClose: () => void
  /** Called once an invoice has been booked and its row marked. */
  onImported: () => void
}

type State = 'pending' | 'imported' | 'dismissed'
type Filter = State | 'all'

interface SefRow {
  id: string
  sef_invoice_id: number
  document_number: string | null
  document_type: string | null
  supplier_name: string | null
  supplier_vat_number: string | null
  supplier_registration_number: string | null
  amount: number | null
  currency: string | null
  delivery_date: string | null
  due_date: string | null
  sent_date: string | null
  sef_status: string | null
  state: State
  dismiss_reason: string | null
  dismissed_at: string | null
  imported_at: string | null
  ubl_fetched_at: string | null
}

interface SyncRun {
  started_at: string | null
  finished_at: string | null
  status: string
  error: string | null
}

type LedgerRow = LedgerInvoice & PastInvoice

/** An invoice being booked: the row it came from and what the dialog opens with. */
interface Booking {
  row: SefRow
  draft: Record<string, unknown>
  notes: string[]
  isCreditNote: boolean
}

// Named, not `*`: the table also holds each invoice's whole UBL document and
// its raw overview, and a list of a few thousand rows has no use for either.
const INBOX_COLUMNS = [
  'id', 'sef_invoice_id', 'document_number', 'document_type', 'supplier_name',
  'supplier_vat_number', 'supplier_registration_number', 'amount', 'currency',
  'delivery_date', 'due_date', 'sent_date', 'sef_status', 'state',
  'dismiss_reason', 'dismissed_at', 'imported_at', 'ubl_fetched_at',
].join(', ')

const LEDGER_COLUMNS = [
  'id', 'invoice_number', 'invoice_date', 'amount', 'currency', 'partner_id',
  'pl_category', 'pl_subcategory', 'department', 'dept_subcategory',
  'expense_description', 'cf_type',
].join(', ')

const STALE_AFTER_MS = 2 * 60 * 60 * 1000

/** A calendar date, read from its own digits: `new Date('2026-08-01')` is
 *  midnight UTC and prints as the day before west of Greenwich. */
function fmtDate(value: string | null | undefined): string {
  const m = /^(\d{4})-(\d{2})-(\d{2})/.exec(value || '')
  if (!m) return value || '—'
  return `${Number(m[3])}. ${MONTHS_SHORT_SR[Number(m[2]) - 1]} ${m[1]}.`
}

/** The calendar day a moment fell on in Belgrade. The pull window runs on
 *  Belgrade dates, so a bill sent at 23:30 UTC must read as the next day here
 *  or the screen disagrees with the window that caught it by one day. */
// `en-CA` is not a display format: it is the shortest route to a YYYY-MM-DD
// key, which is what this is compared on. Nothing here reaches the screen.
const belgrade = new Intl.DateTimeFormat('en-CA', { timeZone: 'Europe/Belgrade' })
function belgradeDay(moment: string | null | undefined): string {
  if (!moment) return ''
  const d = new Date(moment)
  return isNaN(d.getTime()) ? '' : belgrade.format(d)
}

function fmtMoment(value: string): string {
  const d = new Date(value)
  if (isNaN(d.getTime())) return value
  return d.toLocaleString('sr-Latn-RS', { day: '2-digit', month: '2-digit', year: 'numeric', hour: '2-digit', minute: '2-digit' })
}

function ago(ms: number): string {
  const minutes = Math.max(0, Math.round(ms / 60000))
  if (minutes < 1) return 'upravo sada'
  if (minutes < 60) return `pre ${minutes} min`
  const hours = Math.round(minutes / 60)
  if (hours < 48) return `pre ${hours} h`
  const days = Math.round(hours / 24)
  return `pre ${days} ${plural(days, 'dan', 'dana', 'dana')}`
}

function fmtAmount(amount: number | null, currency: string | null): string {
  if (amount === null || amount === undefined) return '—'
  // Through the application's own formatter: 1.234,56 RSD.
  return currency ? fmtLocal(Number(amount), currency) : String(amount)
}

const isCreditNote = (r: SefRow) => /credit/i.test(r.document_type || '')

/** A failed call's real reason is in the response body, not in `message`. */
async function reasonFrom(err: any): Promise<string> {
  try {
    const body = await err?.context?.json?.()
    if (body?.error) return String(body.error)
    if (body?.message) return String(body.message)
  } catch { /* the body was not JSON; fall through to the client's own words */ }
  return err?.message || 'Poziv nije uspeo.'
}

const FILTERS: { key: Filter; label: string }[] = [
  { key: 'pending', label: 'Na čekanju' },
  { key: 'imported', label: 'Proknjižene' },
  { key: 'dismissed', label: 'Odbijene' },
  { key: 'all', label: 'Sve' },
]

const EMPTY_TEXT: Record<Filter, string> = {
  pending: 'Ništa ne čeka. Nove fakture se pojavljuju ovde posle sledećeg povlačenja.',
  imported: 'Još ništa nije proknjiženo iz SEF-a.',
  dismissed: 'Nijedna faktura nije odbijena.',
  all: 'Sanduče je prazno.',
}

export default function SefInboxDialog({ onClose, onImported }: Props) {
  const [rows, setRows] = useState<SefRow[]>([])
  const [ledger, setLedger] = useState<LedgerRow[]>([])
  const [partners, setPartners] = useState<PartnerLite[]>([])
  const [companies, setCompanies] = useState<CompanyLite[]>([])
  const [scripts, setScripts] = useState<ScriptLike[]>([])
  const [loading, setLoading] = useState(true)
  const [filter, setFilter] = useState<Filter>('pending')
  const [lastPull, setLastPull] = useState<SyncRun | null>(null)
  const [lastFailure, setLastFailure] = useState<SyncRun | null>(null)
  const [pullFrom, setPullFrom] = useState('')
  const [declining, setDeclining] = useState<SefRow | null>(null)
  const [reason, setReason] = useState('')
  const [newSupplier, setNewSupplier] = useState<SefRow | null>(null)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const [notice, setNotice] = useState('')
  const [booking, setBooking] = useState<Booking | null>(null)
  const [inboxFailed, setInboxFailed] = useState(false)
  // The refusal belongs to the row it is about: a banner at the top of a long
  // scroll is off-screen from the button that was pressed.
  const [rowError, setRowError] = useState<{ id: string; text: string } | null>(null)

  // State is asynchronous and a double click arrives faster than a render, so
  // the guard is a ref. What a second click would cost is a SEF call and a
  // status change somebody else is watching.
  const inFlight = useRef(false)
  // Rows already reported as booked in this session.
  const markedRows = useRef(new Set<string>())
  const mounted = useRef(true)
  useEffect(() => {
    // Set here as well as cleared below: StrictMode runs mount, cleanup, mount
    // in development, and a flag only ever cleared stays false for good.
    mounted.current = true
    return () => { mounted.current = false }
  }, [])

  const load = useCallback(async () => {
    const problems: string[] = []
    const today = new Date().toLocaleDateString('en-CA')

    const [inbox, ledgerRows, partnerRows, companyRows, scriptRows, complete, failed, floor] = await Promise.all([
      // Paged, because PostgREST caps a response at 1000 rows and says nothing.
      // `nullsFirst: false` because a descending sort otherwise puts undated
      // rows above everything that has a date.
      fetchAllPages<SefRow>((from, to) =>
        supabase.from('sef_inbox').select(INBOX_COLUMNS)
          .order('sent_date', { ascending: false, nullsFirst: false }).order('id')
          .range(from, to))
        .catch((e: any) => { problems.push(`Could not read the inbox: ${e?.message || e}`); return null }),
      fetchAllPages<LedgerRow>((from, to) =>
        supabase.from('invoices').select(LEDGER_COLUMNS)
          .eq('type', 'expense')
          // Payroll and split-payment children carry a partner, type 'expense'
          // and a classification of their own. Left in, they enter the
          // per-partner history and make it disagree with itself; every other
          // screen reads through v_invoice_status, which is parent-less only.
          .is('parent_invoice_id', null)
          .order('invoice_date', { ascending: false }).order('id')
          .range(from, to))
        .catch((e: any) => { problems.push(`Could not read the ledger, so duplicates and classifications are not checked: ${e?.message || e}`); return [] as LedgerRow[] }),
      fetchAllPages<PartnerLite>((from, to) =>
        supabase.from('partners').select('id, name, tax_id, registration_number')
          .order('id').range(from, to))
        .catch((e: any) => { problems.push(`Could not read the partners, so suppliers are not matched: ${e?.message || e}`); return [] as PartnerLite[] }),
      // The bill names its addressee by PIB, and the PIB lives on the profile
      // rather than on the company itself. Two small reads joined here, rather
      // than a PostgREST embed whose relationship name this would be guessing
      // at. A profile that cannot be read is reported: without it nothing
      // matches, and a silently empty company field reads as a bill that named
      // nobody.
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
        problems.push(`Could not read the companies, so the bill's addressee is not matched: ${e?.message || e}`)
        return [] as CompanyLite[]
      }),
      fetchScripts(supabase).catch(() => []),
      // One row per day for `sef`, reclaimed on every pass — not a history. The
      // newest COMPLETE row is the best available "last successful pull", and
      // it errs toward understating freshness, which is the safe side.
      Promise.resolve(supabase.from('processor_sync_runs')
        .select('started_at, finished_at, status, error')
        .eq('provider', 'sef').eq('status', 'complete')
        .order('finished_at', { ascending: false, nullsFirst: false }).limit(1))
        .then((r: any) => r.data?.[0] ?? null, () => null),
      Promise.resolve(supabase.from('processor_sync_runs')
        .select('started_at, finished_at, status, error')
        .eq('provider', 'sef').eq('status', 'failed')
        .order('started_at', { ascending: false }).limit(1))
        .then((r: any) => r.data?.[0] ?? null, () => null),
      // `job_config` has RLS and no policy, so a direct read comes back empty
      // and the date would print blank. The function is granted for this. It
      // answers with the LATER of the floor and the range's start, so a range
      // that begins long ago returns the floor itself — which is the date the
      // sentence is about. With no range it would return the 45-day window's
      // start instead.
      Promise.resolve(supabase.rpc('sef_pull_window', { p_from: '1900-01-01', p_to: today }))
        .then((r: any) => r.data?.[0]?.date_from ?? '', () => ''),
    ])

    if (!mounted.current) return
    // A queue that cannot say what is in it must not say there is nothing, so
    // a failed read is remembered and the body shows the failure alone.
    setInboxFailed(!inbox)
    if (inbox) setRows(inbox)
    setLedger(ledgerRows)
    setPartners(partnerRows)
    setCompanies(companyRows)
    setScripts(scriptRows as ScriptLike[])
    setLastPull(complete)
    setLastFailure(failed)
    // 1900 is the stand-in for "no floor configured".
    setPullFrom(floor && floor > '2000' ? floor : '')
    setError(problems.join(' '))
    setLoading(false)
  }, [])

  useEffect(() => { load() }, [load])

  /** Runs one action at a time. Everything that writes, or will fetch, goes through it. */
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
    () => (filter === 'all' ? rows : rows.filter(r => r.state === filter)),
    [rows, filter])

  const ledgerByPartner = useMemo(() => {
    const m = new Map<string, LedgerRow[]>()
    ledger.forEach(i => {
      if (!i.partner_id) return
      const list = m.get(i.partner_id)
      if (list) list.push(i); else m.set(i.partner_id, [i])
    })
    return m
  }, [ledger])

  // Matched for the rows on screen only: it compares one row against every
  // partner, and the full list is rarely what is being looked at.
  const matches = useMemo(() => {
    const m = new Map<string, SupplierMatch | null>()
    visible.forEach(r => m.set(r.id, matchSupplier({
      vatNumber: r.supplier_vat_number,
      registrationNumber: r.supplier_registration_number,
      name: r.supplier_name,
    }, partners)))
    return m
  }, [visible, partners])

  const decline = () => exclusive(async () => {
    if (!declining || !reason.trim()) return
    setError(''); setNotice(''); setRowError(null)
    // `select('id')` so a write that RLS quietly turned into zero rows is
    // told apart from one that worked.
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

  const restore = (row: SefRow) => exclusive(async () => {
    setError(''); setNotice(''); setRowError(null)
    const { data, error: err } = await supabase.from('sef_inbox').update({
      state: 'pending', restored_at: new Date().toISOString(),
    }).eq('id', row.id).select('id')
    // The trigger refuses an imported row whose ledger invoice is still there,
    // and names it. That message is the useful one — shown as it came.
    if (err) { setRowError({ id: row.id, text: err.message }); return }
    if (!data || data.length === 0) { setRowError({ id: row.id, text: 'Ništa nije promenjeno. Faktura je možda uklonjena ili nije vaša da je vratite.' }); return }
    await load()
  })

  /**
   * Fetches the document, reads it, and opens the invoice dialog on a draft.
   *
   * Everything that matters about the fetch is decided before this runs: it is
   * reachable only from a `pending` row, because the fetch is what marks the
   * invoice Seen in SEF and the accounting firm reads the same mailbox. And it
   * runs through `exclusive`, so a second click while the first is in flight
   * is dropped rather than spending another SEF call.
   */
  const openAndBook = (row: SefRow) => exclusive(async () => {
    setError(''); setNotice(''); setRowError(null)

    const { data, error: fnErr } = await supabase.functions
      .invoke('sef-fetch-invoice', { body: { id: row.id } })
    if (fnErr) { setError(await reasonFrom(fnErr)); return }
    if (!data?.ubl_xml) { setError(data?.error || 'Dokument nije mogao da se preuzme.'); return }

    const ubl = parseUbl(String(data.ubl_xml))

    // The document names the invoice it is, and the row names the one that was
    // asked for. A document for another invoice would be booked under this
    // row's header and then linked to it, with nothing to say so. An envelope
    // with no id (a bare Invoice) cannot be checked, and is not refused for it.
    if (ubl.sefPurchaseInvoiceId !== null && ubl.sefPurchaseInvoiceId !== String(row.sef_invoice_id)) {
      await load()
      setError(`SEF returned the document of invoice ${ubl.sefPurchaseInvoiceId}, but this row is invoice ${row.sef_invoice_id}, so nothing was opened.`)
      return
    }
    // The document is stored by now, and the row reads Seen. A document with
    // no amount or no date to book on is not an invoice this can book from, and an
    // empty form would pass for a real booking. Re-reading it costs no SEF
    // call: the fix is a deploy of this application, not another fetch.
    if (ubl.total === null || !bookedDateOf(ubl)) {
      // Reloaded FIRST: `load` rewrites the banner, and would wipe this one.
      await load()
      setError('Dokument je preuzet ali ne može da se pročita kao faktura, pa ništa nije otvoreno. Sačuvan je, pa se ovo ispravlja bez novog poziva SEF-u.')
      return
    }

    // Matched on the document's own supplier, which is the bill; the row's
    // header fields only fill what the document leaves out.
    const match = matchSupplier({
      vatNumber: ubl.supplierVatNumber ?? row.supplier_vat_number,
      registrationNumber: ubl.supplierRegistrationNumber ?? row.supplier_registration_number,
      name: ubl.supplierName ?? row.supplier_name,
    }, partners)
    const partnerId = match?.partnerId ?? null

    const history = partnerId
      ? (ledgerByPartner.get(partnerId) || []).slice()
          .sort((a, b) => (b.invoice_date || '').localeCompare(a.invoice_date || ''))
      : []
    const proposal: Proposal | null = partnerId
      ? proposeClassification(ubl.supplierName || row.supplier_name || '', history, scripts)
      : null

    // What the partner already has saved decides which of several accounts on
    // the bill, if any, is used. A failed read leaves none matched, which is
    // the safe side: the owner then picks.
    let saved: string[] = []
    let savedUnread = false
    if (partnerId && ubl.bankAccounts.length > 1) {
      const { data: accounts, error: accErr } = await supabase
        .from('partner_accounts').select('account_number').eq('partner_id', partnerId)
      if (accErr) savedUnread = true
      else saved = (accounts || []).map((a: any) => a.account_number).filter(Boolean)
    }

    // Whose bill this is, read off the bill. The owner has several companies
    // and the screen behind this dialog may be showing any of them; the
    // document says which one SEF delivered to.
    const companyMatch = matchCompany({
      vatNumber: ubl.customerVatNumber,
      registrationNumber: ubl.customerRegistrationNumber,
    }, companies)
    const companyId = companyMatch?.companyId ?? null

    // The rates the bill is booked at. Its currency and its date of supply
    // both come off the document, so the answer is already determined and
    // there is nothing to ask.
    //
    // ON THE DATE OF SUPPLY, not the issue date: that is the date the invoice
    // is booked on, and a rate taken on another day converts it at a number
    // belonging to a different day's books.
    //
    // `getBookRates` throws when the National Bank has no rate for that day
    // rather than answering with a guess, so there is no fallback to screen
    // out: either both rates are official or neither is carried, the fields
    // stay empty, and the owner presses Preuzmi and is told why. A bill in
    // dinars needs no call at all -- its rate is 1.
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
    } catch {
      // Left to the owner, with the button the invoice dialog already has.
    }

    const notes = reviewNotesFor(ubl, {
      matchedBy: match?.by ?? null, proposal, saved,
      company: {
        by: companyMatch?.by ?? null,
        name: companies.find(c => c.id === companyId)?.name ?? null,
      },
      header: { amount: row.amount, currency: row.currency },
    })
    if (savedUnread) notes.push("Računi ovog dobavljača nisu mogli da se pročitaju, pa nijedan račun sa fakture nije upoređen sa njima.")

    if (!mounted.current) return
    setBooking({
      row, notes, isCreditNote: ubl.isCreditNote,
      draft: draftFromUbl(ubl, row, partnerId, proposal, saved, companyId, rate, eurRate),
    })
  })

  /**
   * The invoice dialog has created an invoice. Mark the queue row against it.
   *
   * THE ORDER IS FIXED: the invoice first, this row second. If this call
   * fails the invoice exists and the row stays pending, and next time it
   * carries the "you already have this" warning. The other order leaves a row
   * marked imported with no invoice behind it, which nothing would ever
   * notice. `writeOrder`'s rule: a failure may leave more than was asked for,
   * never less.
   *
   * Through the rpc and never an update: `authenticated` may write only the
   * decision columns of `sef_inbox`, and the link to an invoice is not one.
   * The rpc raises rather than failing quietly (a row that is not pending, one
   * already linked, an invoice that does not exist), so its message is shown
   * as it came.
   */
  const markImported = async (row: SefRow, invoiceId: string) => {
    // Only the first report counts: a second would be refused by the rpc, and
    // the refusal would read as a failure of a booking that worked.
    if (markedRows.current.has(row.id)) return
    markedRows.current.add(row.id)
    try {
      const { error: rpcErr } = await supabase.rpc('sef_inbox_mark_imported', { p_id: row.id, p_invoice_id: invoiceId })
      if (rpcErr) throw rpcErr
    } catch (e: any) {
      markedRows.current.delete(row.id)
      if (mounted.current) {
        setRowError({
          id: row.id,
          text: `The invoice was saved, but this row could not be marked as booked: ${e?.message || e}`,
        })
      }
      return
    }
    if (!mounted.current) return
    await load()
    onImported()
  }

  const pullNow = () => exclusive(async () => {
    setError(''); setNotice('')
    const { data, error: err } = await supabase.functions.invoke('sef-pull', { body: {} })
    if (err) { setError(await reasonFrom(err)); return }
    if (data?.skipped && data?.message) setNotice(String(data.message))
    await load()
  })

  const stale = lastPull?.finished_at ? Date.now() - new Date(lastPull.finished_at).getTime() > STALE_AFTER_MS : true
  const failedSince = !!lastFailure && (!lastPull?.finished_at
    || new Date(lastFailure.finished_at || lastFailure.started_at || 0).getTime() > new Date(lastPull.finished_at).getTime())
  const pullAmber = stale || failedSince

  const proposalFor = (row: SefRow, match: SupplierMatch | null) => {
    if (!match || row.state !== 'pending') return null
    const history = (ledgerByPartner.get(match.partnerId) || [])
      .slice().sort((a, b) => (b.invoice_date || '').localeCompare(a.invoice_date || ''))
    return proposeClassification(row.supplier_name || '', history, scripts)
  }

  const renderRow = (row: SefRow) => {
    const match = matches.get(row.id) ?? null
    const dup = findLikelyDuplicate(
      { document_number: row.document_number, amount: row.amount, currency: row.currency, partner_id: match?.partnerId ?? null },
      ledger)
    const proposal = proposalFor(row, match)
    const opened = !!row.ubl_fetched_at

    return (
      <div key={row.id} data-row={row.id} style={s.row}>
        <div style={s.rowTop}>
          <div style={{ minWidth: 0, flex: 1 }}>
            <div style={s.supplierLine}>
              <span style={s.supplier}>{row.supplier_name || 'Nepoznat dobavljač'}</span>
              {isCreditNote(row) && <span style={{ ...s.badge, background: DIALOG.blueFill, color: DIALOG.blue }}>Knjižno odobrenje</span>}
              {!match && (
                <button style={s.linkBtn} disabled={busy} onClick={() => setNewSupplier(row)}>Nov dobavljač — napravi</button>
              )}
              {match?.by === 'name' && (
                <span style={{ ...s.badge, background: DIALOG.amberFill, color: DIALOG.amber }}>Prepoznat samo po imenu</span>
              )}
            </div>
            <div style={s.meta}>
              {row.supplier_vat_number ? `PIB ${row.supplier_vat_number}` : 'Bez PIB-a'}
              {' · '}Br. {row.document_number || '—'}
            </div>
            <div style={s.meta}>
              Poslato {fmtDate(belgradeDay(row.sent_date))} · Dospeva {fmtDate(row.due_date)} · SEF status {row.sef_status || '—'}
            </div>
          </div>
          <div style={s.amount}>{fmtAmount(row.amount, row.currency)}</div>
        </div>

        {opened && (
          <div style={{ ...s.flag, color: DIALOG.amber, background: DIALOG.amberFill }}>
            Otvorena — već pregledana na SEF-u
          </div>
        )}
        {dup && <div style={{ ...s.flag, color: DIALOG.amber, background: DIALOG.amberFill }}>{dup.text}</div>}
        {proposal && (
          <div style={{ ...s.flag, color: DIALOG.dim, background: DIALOG.raised }}>
            <span>Predlog: {[proposal.pl_category, proposal.pl_subcategory, proposal.department, proposal.dept_subcategory, proposal.expense_description].filter(Boolean).join(' › ')}. </span>
            <span style={{ color: proposal.basis === 'mixed' ? DIALOG.amber : DIALOG.dim }}>{proposal.reason}</span>
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
              <textarea
                aria-label="Razlog"
                style={s.textarea}
                rows={2}
                value={reason}
                autoFocus
                onChange={e => setReason(e.target.value)} />
            </label>
            <div style={s.hint}>
              Odbijanje ne otvara fakturu, pa SEF ostaje netaknut i računovođa je i dalje vidi kao novu.
            </div>
            <div style={s.actions}>
              <button style={s.btnGhost} disabled={busy} onClick={() => { setDeclining(null); setReason('') }}>Otkaži</button>
              <button style={{ ...s.btnDanger, opacity: !reason.trim() || busy ? 0.5 : 1 }}
                disabled={!reason.trim() || busy} onClick={decline}>Odbij ovu fakturu</button>
            </div>
          </div>
        )}

        {declining?.id !== row.id && (
          <div style={s.actions}>
            {row.state === 'pending' && (
              <>
                <button
                  style={{ ...s.btnPrimary, opacity: busy ? 0.5 : 1 }}
                  disabled={busy}
                  title={opened
                    ? 'Dokument je već preuzet, pa ponovno otvaranje ne menja status na SEF-u'
                    : 'Otvaranje preuzima dokument, čime faktura na SEF-u postaje pregledana'}
                  onClick={() => openAndBook(row)}>Otvori i proknjiži</button>
                <button style={s.btnGhost} disabled={busy}
                  onClick={() => { setDeclining(row); setReason(''); setError(''); setNotice(''); setRowError(null) }}>Odbij</button>
              </>
            )}
            {row.state !== 'pending' && (
              <button style={s.btnGhost} disabled={busy} onClick={() => restore(row)}>Vrati u red</button>
            )}
          </div>
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
              <div style={chrome.headerTitle}>📨 SEF sanduče</div>
              <div style={chrome.headerSub}>Fakture koje su nam poslate preko SEF-a</div>
            </div>
            <button style={chrome.closeBtn} onClick={onClose} aria-label="Zatvori">×</button>
          </div>

          <div style={s.body}>
            <div style={{ ...s.strip, borderColor: pullAmber ? DIALOG.amber : DIALOG.border }}>
              <div style={{ flex: 1, minWidth: 0 }}>
                <div style={{ fontSize: '13px', color: pullAmber ? DIALOG.amber : DIALOG.text, fontWeight: 500 }}>
                  Poslednje uspešno povlačenje: {loading ? '…' : lastPull?.finished_at
                    ? `${fmtMoment(lastPull.finished_at)} (${ago(Date.now() - new Date(lastPull.finished_at).getTime())})`
                    : 'nikad'}
                </div>
                {failedSince && (
                  <div style={{ fontSize: '12px', color: DIALOG.red, marginTop: '4px' }}>
                    Poslednje povlačenje nije uspelo{lastFailure?.error ? `: ${lastFailure.error}` : '.'} Prikazano može biti zastarelo.
                  </div>
                )}
                {!failedSince && stale && !loading && (
                  <div style={{ fontSize: '12px', color: DIALOG.amber, marginTop: '4px' }}>
                    To je pre više od dva sata, pa novije fakture možda još nisu na spisku.
                  </div>
                )}
                {lastPull?.error && (
                  <div style={{ fontSize: '12px', color: DIALOG.dim, marginTop: '4px' }}>Napomena sa tog povlačenja: {lastPull.error}</div>
                )}
                <div style={{ fontSize: '12px', color: DIALOG.dim, marginTop: '4px' }}>
                  {pullFrom ? `Sve fakture poslate nam od ${fmtDate(pullFrom)}` : 'Sve fakture poslate nam'}
                  , ponovo provereno za poslednjih 45 dana. Poređano po datumu slanja.
                </div>
              </div>
              <button style={{ ...s.btnGhost, opacity: busy ? 0.5 : 1 }} disabled={busy} onClick={pullNow}>Povuci sada</button>
            </div>

            {error && <div style={{ ...s.banner, background: DIALOG.redFill, borderColor: DIALOG.redSoft, color: DIALOG.red }}>{error}</div>}
            {notice && <div style={{ ...s.banner, background: DIALOG.amberFill, borderColor: DIALOG.amber, color: DIALOG.amber }}>{notice}</div>}

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
          reviewNotes={booking.notes}
          // Left open until the dialog closes itself, so the owner sees its
          // confirmation; the queue behind it is refreshed by `markImported`.
          onSaved={(invoiceId: string) => markImported(booking.row, invoiceId)}
          onClose={() => { setBooking(null); load() }} />
      )}

      {newSupplier && (
        <PartnerDialog
          initialName={newSupplier.supplier_name || ''}
          initialTaxId={newSupplier.supplier_vat_number || ''}
          initialRegistrationNumber={newSupplier.supplier_registration_number || ''}
          onClose={() => setNewSupplier(null)}
          onSaved={(p: PartnerLite) => { setPartners(prev => [...prev, p]); setNewSupplier(null) }} />
      )}
    </>
  )
}

const s: Record<string, React.CSSProperties> = {
  dialog: { background: DIALOG.panel, borderRadius: '16px', width: '920px', maxWidth: '96vw', maxHeight: '92vh', display: 'flex', flexDirection: 'column', overflow: 'hidden', boxShadow: DIALOG.shadow },
  body: { padding: '1.25rem 1.5rem 1.5rem', overflowY: 'auto', flex: 1, background: DIALOG.panel },
  strip: { display: 'flex', alignItems: 'flex-start', gap: '16px', padding: '12px 14px', border: '0.5px solid', borderRadius: '10px', background: DIALOG.raised, marginBottom: '12px' },
  banner: { fontSize: '12px', lineHeight: 1.5, border: '0.5px solid', borderRadius: '8px', padding: '10px 14px', marginBottom: '12px' },
  chips: { display: 'flex', gap: '6px', marginBottom: '14px' },
  chip: { fontFamily: 'system-ui,sans-serif', fontSize: '12px', fontWeight: 500, padding: '5px 12px', borderRadius: '20px', border: '1px solid', cursor: 'pointer' },
  empty: { fontSize: '13px', color: DIALOG.dim, textAlign: 'center', padding: '36px 0' },
  row: { border: '0.5px solid ' + DIALOG.border, borderRadius: '10px', background: DIALOG.raised, padding: '12px 14px', marginBottom: '10px' },
  rowTop: { display: 'flex', alignItems: 'flex-start', gap: '16px' },
  supplierLine: { display: 'flex', alignItems: 'center', gap: '8px', flexWrap: 'wrap' },
  supplier: { fontSize: '14px', fontWeight: 500, color: DIALOG.text },
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
