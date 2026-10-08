import React, { useState, useEffect } from 'react'
import { supabase } from '../supabase'
import { PostFailure, reportPostFailure, type CompletedWrite } from '../services/writeOrder'
import { linkAmountsFromOwn } from '../services/invoiceLinks'
import { outstandingOwn, settlementFor } from '../services/settleInvoice'
import {
  allocationCurrency, commonCurrency, formatMoney, toOwn, toRsd,
} from '../services/allocationDisplay'
import { DIALOG } from './dialogTheme'
import { round2 as bookRound2 } from '../services/bookAmounts'
import { fmtMoney } from '../utils/formatters'

interface Props {
  // Can be opened from either side
  sourceType: 'transaction' | 'invoice'
  sourceId: string
  onClose: () => void
  onReconciled: () => void
}

interface LinkRow {
  id: string
  type: 'invoice' | 'transaction'
  date: string
  partner_name: string
  identifier: string   // invoice number or statement number
  currency: string
  amount: number
  /** The row's own book figures and the stored rates they were booked at. */
  amount_rsd: number
  amount_eur: number
  exchange_rate: number | null
  eur_rate: number | null
  /** The invoice's own `paid_amount`, where this row IS the invoice. */
  paid_amount?: number
  /**
   * What the bill this row settles is still owed, IN ITS OWN CURRENCY.
   *
   * The book columns carry two different dates' rates — the invoice's and the
   * payment's. So a euro payment that settled a euro bill to the cent would
   * show a "Remaining" in dinars of the rate move between the two days, for
   * ever. Nothing would be wrong with the books; the yardstick would be.
   */
  outstanding_own: number
  status: string
  pl_category?: string
  revenue_stream?: string
  /** What the person types, and what `allocated_amount` will hold. */
  allocated_own: number
  /**
   * Derived from it at the invoice's stored rate, for the book totals.
   * Never the other way round.
   */
  allocated_rsd: number
}

const round2 = (n: number): number => bookRound2(Number.isFinite(n) ? n : 0)

export default function ReconcilePanel({ sourceType, sourceId, onClose, onReconciled }: Props) {
  const [loading, setLoading] = useState(true)
  const [saving, setSaving] = useState(false)
  // A refused write, where the owner is looking. Three tables move per
  // link, and none of them used to report anything.
  const [saveError, setSaveError] = useState('')
  const [success, setSuccess] = useState(false)

  // Source data (the thing we opened reconcile from)
  const [source, setSource] = useState<any>(null)

  // Candidates to link (opposite side)
  const [candidates, setCandidates] = useState<any[]>([])
  const [searchQuery, setSearchQuery] = useState('')

  // Selected links with allocation
  const [links, setLinks] = useState<LinkRow[]>([])

  // Existing links (already reconciled before)
  const [existingLinks, setExistingLinks] = useState<any[]>([])

  useEffect(() => {
    loadData()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [sourceId, sourceType])

  const loadData = async () => {
    setLoading(true)

    if (sourceType === 'transaction') {
      // Source = Direct transaction
      const { data: tx } = await supabase
        .from('transactions')
        .select(`*, companies(name), partners(name), banks(name)`)
        .eq('id', sourceId)
        .single()
      setSource(tx)

      // Candidates = open invoices for same company
      if (tx?.company_id) {
        const { data: invs } = await supabase
          .from('v_invoice_status')
          .select('*')
          .eq('company_id', tx.company_id)
          .in('calculated_status', ['unpaid', 'partial', 'reconciled'])
          .order('invoice_date', { ascending: false })
        setCandidates(invs || [])
      }

      // Existing links
      const { data: existing } = await supabase
        .from('invoice_transaction_links')
        .select(`*, invoices(invoice_number, invoice_date, currency, amount, partners(name))`)
        .eq('transaction_id', sourceId)
      setExistingLinks(existing || [])

    } else {
      // Source = Invoice
      const { data: inv } = await supabase
        .from('invoices')
        .select(`*, companies(name), partners(name)`)
        .eq('id', sourceId)
        .single()
      // What it already holds, in its own currency. `invoices` does not carry
      // it; the view does, and it is the column the settled/partial rule is
      // decided on. Without it the allocation below cannot know how much of
      // the bill is genuinely left. See services/settleInvoice.ts.
      const { data: held } = await supabase
        .from('v_invoice_status').select('paid_amount').eq('id', sourceId).maybeSingle()
      setSource(inv ? { ...inv, paid_amount: held?.paid_amount ?? 0 } : inv)

      // Candidates = Direct transactions for same company
      if (inv?.company_id) {
        const { data: txs } = await supabase
          .from('transactions')
          .select(`*, companies(name), partners(name), banks(name)`)
          .eq('company_id', inv.company_id)
          .eq('type', 'direct')
          .order('transaction_date', { ascending: false })
        setCandidates(txs || [])
      }

      // Existing links
      const { data: existing } = await supabase
        .from('invoice_transaction_links')
        .select(`*, transactions(transaction_date, statement_number, partners(name))`)
        .eq('invoice_id', sourceId)
      setExistingLinks(existing || [])
    }

    setLoading(false)
  }

  const isLinked = (id: string) => links.some(l => l.id === id)
  const isAlreadyReconciled = (id: string) => existingLinks.some(l =>
    sourceType === 'transaction' ? l.invoice_id === id : l.transaction_id === id
  )

  /**
   * The bill a row settles and the payment that settles it.
   *
   * Which is which depends on the direction the panel was opened from, and
   * getting it round the wrong way is how a figure in one currency once ended
   * up in a column for another. Everything downstream asks this rather than
   * guessing.
   */
  const invoiceFor = (row: any) => (sourceType === 'transaction' ? row : source)
  const paymentFor = (row: any) => (sourceType === 'transaction' ? source : row)

  const addLink = (candidate: any) => {
    if (isLinked(candidate.id) || isAlreadyReconciled(candidate.id)) return

    const invoice = invoiceFor(candidate)
    const payment = paymentFor(candidate)

    // The two directions are mirror images. With a TRANSACTION as the source
    // every row spends the same payment, so what is left of it shrinks as
    // rows are added. With an INVOICE as the source every row settles the
    // same bill, so what the bill is owed shrinks instead. Offering either
    // one twice over is how a picker promises what it will not deliver.
    const takenFromBill = sourceType === 'invoice' ? totalAllocatedOwn : 0
    const takenFromPayment = sourceType === 'transaction'
      // Only the rows denominated in the payment's own currency spend it in
      // that currency; the rest spend it in dinars and are counted there.
      ? links.filter(l => (l.currency || 'RSD') === (source?.currency || 'RSD'))
             .reduce((sum, l) => sum + (l.allocated_own || 0), 0)
      : 0
    const takenRsd = sourceType === 'transaction' ? totalAllocatedRsd : 0

    const held = { ...invoice, paid_amount: (invoice?.paid_amount ?? 0) + takenFromBill }
    let settlement: ReturnType<typeof settlementFor>
    try {
      settlement = settlementFor({
        invoice: held,
        paymentCurrency: payment?.currency,
        paymentOwn: Math.max(0, (payment?.amount ?? 0) - takenFromPayment),
        paymentRsd: Math.max(0, (payment?.amount_rsd ?? 0) - takenRsd),
      })
    } catch (err) {
      // RateUnavailableError: the invoice carries no stored rate, so its
      // allocation cannot be booked. Say so rather than guess.
      setSaveError(err instanceof Error ? err.message : String(err))
      return
    }
    setSaveError('')

    setLinks(prev => [...prev, {
      id: candidate.id,
      type: sourceType === 'transaction' ? 'invoice' : 'transaction',
      date: candidate.invoice_date || candidate.transaction_date,
      partner_name: candidate.partner_name || candidate.partners?.name || '—',
      identifier: candidate.invoice_number || candidate.statement_number || '—',
      currency: candidate.currency,
      amount: candidate.amount,
      amount_rsd: candidate.amount_rsd,
      amount_eur: candidate.amount_eur,
      exchange_rate: candidate.exchange_rate ?? null,
      eur_rate: candidate.eur_rate ?? null,
      paid_amount: candidate.paid_amount ?? 0,
      outstanding_own: outstandingOwn(held),
      status: candidate.calculated_status || candidate.status || candidate.type,
      pl_category: candidate.pl_category || candidate.revenue_stream,
      allocated_own: settlement.own,
      allocated_rsd: settlement.rsd,
    }])
  }

  const removeLink = (id: string) => {
    setLinks(prev => prev.filter(l => l.id !== id))
  }

  /**
   * The person types in the currency of the bill; the dinars follow.
   *
   * That way round, because the typed figure is the one that settles the
   * invoice and the one that is stored. Holding dinars and displaying the
   * conversion makes the field move under the user — type 600 EUR, store
   * 70,500 RSD, redisplay 600.00x.
   */
  const updateAllocation = (id: string, own: number) => {
    setLinks(prev => prev.map(l => l.id === id
      ? { ...l, allocated_own: own, allocated_rsd: toRsd(own, invoiceFor(l) || {}) }
      : l))
  }

  const totalAllocatedOwn = links.reduce((s, l) => s + (l.allocated_own || 0), 0)
  const totalAllocatedRsd = links.reduce((s, l) => s + (l.allocated_rsd || 0), 0)
  const previouslyOwn = existingLinks.reduce((s, l) => s + (l.allocated_amount || 0), 0)
  const previouslyRsd = existingLinks.reduce((s, l) => s + (l.allocated_amount_rsd || 0), 0)

  /**
   * The currency the running totals can honestly be shown in.
   *
   * Only when the source and everything linked to it agree. A payment in
   * dinars against one dinar invoice and one euro invoice has no single
   * currency its total means anything in, and inventing one by converting
   * would put a figure on screen that is nobody's actual money. Null means
   * fall back to dinars (the book) and say so — the same rule the transaction
   * dialog follows, in services/allocationDisplay.ts.
   */
  const barCurrency = sourceType === 'transaction'
    ? commonCurrency(source?.currency, [
        ...links.map(l => ({ currency: l.currency })),
        ...existingLinks.map((l: any) => ({ currency: l.invoices?.currency })),
      ])
    : (source?.currency || 'RSD')

  const sourceTotalShown = barCurrency ? (source?.amount ?? 0) : (source?.amount_rsd ?? 0)
  const allocatedShown = barCurrency ? totalAllocatedOwn : totalAllocatedRsd
  const previouslyShown = barCurrency ? previouslyOwn : previouslyRsd
  const unallocated = round2(sourceTotalShown - allocatedShown - previouslyShown)

  const filteredCandidates = candidates.filter(c => {
    if (!searchQuery) return true
    const partner = c.partner_name || c.partners?.name || ''
    const identifier = c.invoice_number || c.statement_number || ''
    return (
      partner.toLowerCase().includes(searchQuery.toLowerCase()) ||
      identifier.toLowerCase().includes(searchQuery.toLowerCase())
    )
  })

  const handleSave = async () => {
    if (links.length === 0) return

    // Every link booked BEFORE anything is written: an invoice without stored
    // rates cannot be allocated, and finding that out halfway through would
    // leave half a reconciliation behind.
    let booked: ReturnType<typeof linkAmountsFromOwn>[]
    try {
      booked = links.map(link => linkAmountsFromOwn(link.allocated_own, invoiceFor(link) || {}))
    } catch (err) {
      setSaveError(err instanceof Error ? err.message : String(err))
      return
    }

    setSaving(true); setSaveError('')

    // Outside the try so the catch can read it: a refusal partway through a
    // multi-link reconciliation has to say how many already landed.
    const completed: CompletedWrite[] = []

    try {
      for (const [i, link] of links.entries()) {
        const invoiceId = sourceType === 'transaction' ? link.id : sourceId
        const transactionId = sourceType === 'transaction' ? sourceId : link.id

        // Which side of this reconciliation IS the invoice depends on the
        // direction: with a transaction as the source the candidates are
        // invoices, and with an invoice as the source the invoice is the
        // source itself. `invoiceFor` answers that rather than each call site
        // guessing, because getting it round the wrong way is how a figure in
        // one currency once landed in a column for another.
        //
        // THE FIGURE THAT WAS TYPED IS THE FIGURE THAT IS STORED, in the
        // currency of the bill. It goes into `allocated_amount`, the column
        // the settled/partial rule reads, and the dinars and euros are
        // derived from it at the invoice's stored rates. See
        // services/settleInvoice.ts.
        const { error: linkErr } = await supabase.from('invoice_transaction_links').upsert({
          invoice_id: invoiceId,
          transaction_id: transactionId,
          ...booked[i],
        }, { onConflict: 'invoice_id,transaction_id' })
        if (linkErr) throw new PostFailure('the allocation', linkErr.message)
        completed.push({ label: 'allocations', count: completed.length + 1 })

        // Invoice becomes P&L source, transaction loses P&L impact
        const { error: invErr } = await supabase.from('invoices')
          .update({ pl_impact: true })
          .eq('id', invoiceId)
        if (invErr) throw new PostFailure('the invoice P&L flag', invErr.message)

        const { error: txErr } = await supabase.from('transactions')
          .update({ pl_impact: false, status: 'reconciled' })
          .eq('id', transactionId)
        if (txErr) throw new PostFailure('the transaction P&L flag', txErr.message)

        // Refresh invoice status from view
        const { data: invStatus, error: statusErr } = await supabase
          .from('v_invoice_status')
          .select('calculated_status')
          .eq('id', invoiceId)
          .single()
        if (statusErr) throw new PostFailure('the invoice status', statusErr.message)

        if (invStatus) {
          const { error: setErr } = await supabase.from('invoices')
            .update({ status: invStatus.calculated_status })
            .eq('id', invoiceId)
          if (setErr) throw new PostFailure('the invoice status', setErr.message)
        }
      }

      setSuccess(true)
      setTimeout(() => {
        setSuccess(false)
        onReconciled()
        onClose()
      }, 1800)

    } catch (err: any) {
      // supabase-js does not throw, so this catch was dead code for every
      // database refusal — three tables were written per link and none of
      // them was checked, while setSuccess(true) ran unconditionally.
      setSaveError(err instanceof PostFailure
        ? reportPostFailure('The reconciliation', err.step, err.message, completed)
        : `Error: ${err.message}`)
    }
    setSaving(false)
  }

  // ── Helpers ──────────────────────────────────────────────
  const getStatusStyle = (status: string): React.CSSProperties => {
    const map: Record<string, React.CSSProperties> = {
      unpaid: { background: DIALOG.redFill, color: DIALOG.red },
      partial: { background: DIALOG.amberFill, color: DIALOG.amber },
      paid: { background: DIALOG.accentFill, color: DIALOG.accent },
      reconciled: { background: DIALOG.raised, color: DIALOG.dim },
      posted: { background: DIALOG.accentFill, color: DIALOG.accent },
      direct: { background: DIALOG.accentFill, color: DIALOG.accent },
    }
    return map[status] || { background: DIALOG.raised, color: DIALOG.dim }
  }

  // ── Success screen ───────────────────────────────────────
  if (success) return (
    <div style={s.overlay}>
      <div style={{ ...s.panel, display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center', gap: '12px', minHeight: '220px' }}>
        <div style={{ width: '52px', height: '52px', borderRadius: '50%', background: DIALOG.accentFill, display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
          <svg width="26" height="26" viewBox="0 0 24 24" fill="none" stroke={DIALOG.accent} strokeWidth="2.2"><path d="M5 13l4 4L19 7" /></svg>
        </div>
        <div style={{ fontFamily: 'Georgia,serif', fontSize: '20px', color: DIALOG.text }}>Reconciled!</div>
        <div style={{ fontSize: '13px', color: DIALOG.dim, textAlign: 'center' }}>
          {links.length} link(s) created.<br />
          Invoice is now the P&L source. Transaction marked as reconciled.
        </div>
      </div>
    </div>
  )

  return (
    <div style={s.overlay} onClick={onClose}>
      <div style={s.panel} onClick={e => e.stopPropagation()}>

        {/* Header */}
        <div style={s.header}>
          <div>
            <div style={s.headerTitle}>
              {sourceType === 'transaction' ? '🔗 Reconcile transaction with invoice' : '🔗 Reconcile invoice with transaction'}
            </div>
            <div style={s.headerSub}>
              {sourceType === 'transaction'
                ? 'Link this direct transaction to one or more invoices. Invoice will take over P&L.'
                : 'Link this invoice to one or more existing direct transactions.'}
            </div>
          </div>
          <button style={s.closeBtn} onClick={onClose}>×</button>
        </div>

        <div style={s.body}>

          {loading ? (
            <div style={{ padding: '2rem', textAlign: 'center', color: DIALOG.dim, fontSize: '14px' }}>Loading...</div>
          ) : (
            <>
              {/* Source summary */}
              <div style={s.sourceCard}>
                <div style={s.sourceCardLabel}>
                  {sourceType === 'transaction' ? 'Direct transaction' : 'Invoice'}
                </div>
                <div style={s.sourceCardRow}>
                  <div>
                    <div style={s.sourceCardPartner}>{source?.partners?.name || '—'}</div>
                    <div style={s.sourceCardMeta}>
                      {sourceType === 'transaction'
                        ? `${source?.transaction_date} · ${source?.companies?.name} · ${source?.banks?.name}`
                        : `${source?.invoice_date} · ${source?.invoice_number || 'No invoice number'} · ${source?.companies?.name}`
                      }
                    </div>
                    {(source?.pl_category || source?.revenue_stream) && (
                      <div style={s.sourceCardMeta}>
                        P&L: {source?.pl_category || source?.revenue_stream}
                      </div>
                    )}
                  </div>
                  <div style={{ textAlign: 'right' }}>
                    <div style={s.sourceCardAmount}>
                      {fmtMoney(source?.amount || 0, source?.currency || 'RSD')}
                    </div>
                    <div style={s.sourceCardBook}>{fmtMoney(source?.amount_rsd || 0, 'RSD')} · {fmtMoney(source?.amount_eur || 0, 'EUR')}</div>
                  </div>
                </div>

                {/* Already reconciled links */}
                {existingLinks.length > 0 && (
                  <div style={s.existingLinks}>
                    <div style={s.existingLinksLabel}>Already linked</div>
                    {existingLinks.map(el => (
                      <div key={el.id} style={s.existingLinkRow}>
                        <span style={{ fontSize: '12px', color: DIALOG.dim }}>
                          {sourceType === 'transaction'
                            ? `${el.invoices?.partners?.name || '—'} · ${el.invoices?.invoice_number || '—'} · ${el.invoices?.invoice_date}`
                            : `${el.transactions?.partners?.name || '—'} · ${el.transactions?.statement_number || '—'} · ${el.transactions?.transaction_date}`
                          }
                        </span>
                        <span style={{ fontSize: '12px', fontWeight: '500', color: DIALOG.accent }}>
                          {formatMoney(el.allocated_amount || 0,
                            (sourceType === 'transaction' ? el.invoices?.currency : source?.currency) || 'RSD')} allocated
                        </span>
                      </div>
                    ))}
                  </div>
                )}
              </div>

              {/* In the shared currency when the source and everything
                  linked to it agree, which is the ordinary case. When they do
                  not, no single currency these totals mean anything in
                  exists, so they fall back to dinars and say so rather than
                  converting something into nobody's money. */}
              <div style={s.allocBar}>
                <div style={s.allocBarItem}>
                  <span style={s.allocBarLabel}>Total</span>
                  <span style={s.allocBarVal}>{formatMoney(sourceTotalShown, barCurrency || 'RSD')}</span>
                </div>
                <div style={s.allocBarDivider} />
                <div style={s.allocBarItem}>
                  <span style={s.allocBarLabel}>Previously linked</span>
                  <span style={{ ...s.allocBarVal, color: DIALOG.dim }}>
                    {formatMoney(previouslyShown, barCurrency || 'RSD')}
                  </span>
                </div>
                <div style={s.allocBarDivider} />
                <div style={s.allocBarItem}>
                  <span style={s.allocBarLabel}>New allocation</span>
                  <span style={{ ...s.allocBarVal, color: DIALOG.accent }}>
                    {formatMoney(allocatedShown, barCurrency || 'RSD')}
                  </span>
                </div>
                <div style={s.allocBarDivider} />
                <div style={s.allocBarItem}>
                  <span style={s.allocBarLabel}>Remaining</span>
                  <span style={{
                    ...s.allocBarVal,
                    color: Math.abs(unallocated) <= 0.01 ? DIALOG.accent : unallocated < 0 ? DIALOG.red : DIALOG.amber,
                    fontWeight: '600'
                  }}>
                    {formatMoney(unallocated, barCurrency || 'RSD')}
                    {Math.abs(unallocated) <= 0.01 && ' ✓'}
                    {unallocated < 0 && ' ⚠️'}
                  </span>
                </div>
              </div>
              {!barCurrency && (
                <div style={{ fontSize: '10.5px', color: DIALOG.dim, margin: '-6px 0 10px', lineHeight: 1.4 }}>
                  Shown in RSD (book): this {sourceType === 'transaction' ? 'payment' : 'invoice'} and what it is
                  linked to are not all in the same currency.
                </div>
              )}

              {/* P&L reclassification notice */}
              {links.length > 0 && (
                <div style={s.reclassNotice}>
                  <span style={{ fontSize: '15px' }}>📊</span>
                  <div>
                    <div style={{ fontWeight: '500', fontSize: '12px', marginBottom: '2px' }}>P&L will be reclassified</div>
                    <div style={{ fontSize: '11px', opacity: 0.85 }}>
                      {sourceType === 'transaction'
                        ? 'The transaction will lose P&L impact. The linked invoice(s) will become the P&L source with their own categories.'
                        : 'The linked transaction(s) will lose P&L impact. This invoice will be the P&L source.'}
                    </div>
                  </div>
                </div>
              )}

              {/* Search */}
              <div style={{ marginBottom: '10px' }}>
                <input
                  style={s.searchInput}
                  value={searchQuery}
                  onChange={e => setSearchQuery(e.target.value)}
                  placeholder={sourceType === 'transaction'
                    ? 'Search invoices by partner or invoice number...'
                    : 'Search transactions by partner or statement number...'}
                />
              </div>

              {/* Candidates list */}
              <div style={s.candidateList}>
                {filteredCandidates.length === 0 ? (
                  <div style={{ padding: '20px', textAlign: 'center', color: DIALOG.faint, fontSize: '13px' }}>
                    No {sourceType === 'transaction' ? 'invoices' : 'direct transactions'} found for this company.
                  </div>
                ) : (
                  filteredCandidates.map(c => {
                    const linked = isLinked(c.id)
                    const alreadyDone = isAlreadyReconciled(c.id)
                    return (
                      <div key={c.id} style={{
                        ...s.candidateRow,
                        ...(linked ? s.candidateRowLinked : {}),
                        ...(alreadyDone ? s.candidateRowDone : {}),
                      }}>
                        <div style={{ flex: 1, minWidth: 0 }}>
                          <div style={{ display: 'flex', alignItems: 'center', gap: '8px', marginBottom: '3px' }}>
                            <span style={s.candidatePartner}>
                              {c.partner_name || c.partners?.name || '—'}
                            </span>
                            {(c.invoice_number || c.statement_number) && (
                              <span style={s.candidateIdentifier}>
                                {c.invoice_number || c.statement_number}
                              </span>
                            )}
                            <span style={{ ...s.statusBadge, ...getStatusStyle(c.calculated_status || c.status || c.type) }}>
                              {c.calculated_status || c.status || c.type}
                            </span>
                            {alreadyDone && (
                              <span style={{ fontSize: '10px', color: DIALOG.accent, fontWeight: '500' }}>✓ Linked</span>
                            )}
                          </div>
                          <div style={s.candidateMeta}>
                            {c.invoice_date || c.transaction_date}
                            {(c.pl_category || c.revenue_stream) && ` · ${c.pl_category || c.revenue_stream}`}
                            {sourceType === 'transaction' && c.amount !== undefined && (() => {
                              // In the currency of the bill. Read off
                              // `remaining_rsd` this line would carry the gap
                              // between two dates' rates, and show an
                              // amount outstanding on invoices that had been
                              // settled to the cent.
                              const left = outstandingOwn(c)
                              return (
                                <span style={{ color: left > 0.01 ? DIALOG.red : DIALOG.accent }}>
                                  {' · '}Remaining: {formatMoney(left, allocationCurrency(c))}
                                </span>
                              )
                            })()}
                          </div>
                        </div>
                        <div style={{ textAlign: 'right', marginRight: '10px', flexShrink: 0 }}>
                          <div style={s.candidateAmt}>{fmtMoney(c.amount || 0, c.currency || 'RSD')}</div>
                          <div style={s.candidateBook}>{fmtMoney(c.amount_rsd || 0, 'RSD')}</div>
                        </div>
                        {!alreadyDone ? (
                          !linked ? (
                            <button style={s.addBtn} onClick={() => addLink(c)}>+ Link</button>
                          ) : (
                            <button style={s.removeBtn} onClick={() => removeLink(c.id)}>✕ Remove</button>
                          )
                        ) : (
                          <div style={{ width: '72px' }} />
                        )}
                      </div>
                    )
                  })
                )}
              </div>

              {/* Allocation inputs for selected links */}
              {links.length > 0 && (
                <div style={s.allocationSection}>
                  <div style={s.allocationTitle}>Allocation per link</div>
                  {links.map(link => {
                    const cur = allocationCurrency(invoiceFor(link) || {})
                    // What the bill is still owed AFTER this figure. Saying
                    // the result removes the ambiguity about whether the
                    // field means "what to add" or "what this link holds in
                    // total" — it is the second.
                    const left = round2((link.outstanding_own || 0) - (link.allocated_own || 0))
                    return (
                      <div key={link.id} style={s.allocationRow}>
                        <div style={{ flex: 1 }}>
                          <div style={{ fontSize: '13px', fontWeight: '500', color: DIALOG.text }}>{link.partner_name}</div>
                          <div style={{ fontSize: '11px', color: DIALOG.dim }}>
                            {link.identifier !== '—' ? link.identifier + ' · ' : ''}
                            {link.date}
                            {` · Outstanding: ${formatMoney(link.outstanding_own || 0, cur)}`}
                          </div>
                          {Math.abs(left) <= 0.01 ? (
                            <div style={{ fontSize: '11px', color: DIALOG.accent, marginTop: '2px' }}>
                              ✓ Settles this invoice in full
                            </div>
                          ) : (
                            <div style={{ fontSize: '11px', color: left > 0 ? DIALOG.amber : DIALOG.red, marginTop: '2px' }}>
                              {left > 0
                                ? `Leaves ${formatMoney(left, cur)} still owed`
                                : `Allocates ${formatMoney(-left, cur)} more than this invoice is owed`}
                            </div>
                          )}
                        </div>
                        <div style={{ display: 'flex', alignItems: 'center', gap: '6px', flexShrink: 0 }}>
                          <span style={{ fontSize: '12px', color: DIALOG.dim }}>{cur}</span>
                          <input
                            type="number"
                            style={s.allocInput}
                            value={link.allocated_own}
                            onChange={e => updateAllocation(link.id, parseFloat(e.target.value) || 0)}
                            min={0}
                          />
                          {(link.outstanding_own || 0) > 0.01 && (
                            <button
                              style={s.maxBtn}
                              title={`Settle ${formatMoney(link.outstanding_own || 0, cur)}, or as much of it as is left`}
                              onClick={() => updateAllocation(link.id, Math.max(0, Math.min(
                                link.outstanding_own || 0,
                                // What is left of the source, plus what this
                                // row is already holding back from it — in
                                // the bill's currency either way.
                                barCurrency
                                  ? round2(unallocated + link.allocated_own)
                                  : toOwn(round2(unallocated + link.allocated_rsd), invoiceFor(link) || {}))))}
                            >
                              Max
                            </button>
                          )}
                        </div>
                      </div>
                    )
                  })}
                </div>
              )}
            </>
          )}
        </div>

        {/* Footer */}
        {saveError && (
          <div style={{ margin: '0 1.5rem 1rem', background: 'rgba(255,91,90,0.10)', border: '0.5px solid rgba(255,91,90,0.35)', borderRadius: '8px', padding: '10px 14px', fontSize: '13px', color: '#FF5B5A' }}>
            ⚠️ {saveError}
          </div>
        )}

        <div style={s.footer}>
          <div style={{ fontSize: '12px', color: DIALOG.dim }}>
            {links.length === 0
              ? 'Select one or more entries to link'
              : `${links.length} link(s) ready · ${formatMoney(allocatedShown, barCurrency || 'RSD')} allocated`}
          </div>
          <div style={{ display: 'flex', gap: '8px' }}>
            <button style={s.btnGhost} onClick={onClose}>Cancel</button>
            <button
              style={{ ...s.btnPrimary, opacity: links.length === 0 || saving ? 0.5 : 1 }}
              onClick={handleSave}
              disabled={links.length === 0 || saving}
            >
              {saving ? 'Saving...' : `Save & reconcile (${links.length})`}
            </button>
          </div>
        </div>

      </div>
    </div>
  )
}

const s: Record<string, React.CSSProperties> = {
  overlay: { position: 'fixed', inset: 0, colorScheme: 'dark', background: DIALOG.overlay, backdropFilter: 'blur(4px)', display: 'flex', alignItems: 'center', justifyContent: 'center', zIndex: DIALOG.z },
  panel: { background: DIALOG.panel, borderRadius: '16px', width: '860px', maxWidth: '96vw', maxHeight: '92vh', display: 'flex', flexDirection: 'column', overflow: 'hidden' },
  header: { background: DIALOG.panelDeep, padding: '1rem 1.5rem', display: 'flex', alignItems: 'flex-start', justifyContent: 'space-between', gap: '12px' },
  headerTitle: { color: DIALOG.text, fontSize: '15px', fontWeight: '500', marginBottom: '3px' },
  headerSub: { color: 'rgba(255,255,255,0.45)', fontSize: '12px', lineHeight: '1.4' },
  closeBtn: { background: 'none', border: 'none', color: 'rgba(255,255,255,0.5)', fontSize: '22px', cursor: 'pointer', padding: '0 4px', lineHeight: 1, flexShrink: 0 },
  body: { padding: '1.25rem 1.5rem', overflowY: 'auto', flex: 1 },
  footer: { padding: '1rem 1.5rem', borderTop: '0.5px solid ' + DIALOG.border, display: 'flex', alignItems: 'center', justifyContent: 'space-between', background: DIALOG.raised },
  sourceCard: { background: DIALOG.raised, border: '0.5px solid ' + DIALOG.border, borderRadius: '10px', padding: '12px 14px', marginBottom: '12px' },
  sourceCardLabel: { fontSize: '10px', fontWeight: '500', color: DIALOG.dim, textTransform: 'uppercase' as const, letterSpacing: '0.08em', marginBottom: '8px' },
  sourceCardRow: { display: 'flex', alignItems: 'flex-start', justifyContent: 'space-between', gap: '12px' },
  sourceCardPartner: { fontSize: '14px', fontWeight: '500', color: DIALOG.text, marginBottom: '3px' },
  sourceCardMeta: { fontSize: '12px', color: DIALOG.dim, marginBottom: '2px' },
  sourceCardAmount: { fontSize: '15px', fontWeight: '500', color: DIALOG.text },
  sourceCardBook: { fontSize: '12px', color: DIALOG.accent, fontWeight: '500' },
  existingLinks: { marginTop: '10px', paddingTop: '10px', borderTop: '0.5px solid ' + DIALOG.border },
  existingLinksLabel: { fontSize: '10px', fontWeight: '500', color: DIALOG.dim, textTransform: 'uppercase' as const, letterSpacing: '0.07em', marginBottom: '6px' },
  existingLinkRow: { display: 'flex', alignItems: 'center', justifyContent: 'space-between', padding: '4px 0', borderBottom: '0.5px solid #ececec' },
  allocBar: { display: 'flex', alignItems: 'center', background: DIALOG.panel, border: '0.5px solid ' + DIALOG.border, borderRadius: '10px', padding: '10px 16px', marginBottom: '12px', gap: '0' },
  allocBarItem: { display: 'flex', flexDirection: 'column' as const, alignItems: 'center', flex: 1 },
  allocBarLabel: { fontSize: '10px', color: DIALOG.faint, textTransform: 'uppercase' as const, letterSpacing: '0.06em', marginBottom: '3px' },
  allocBarVal: { fontSize: '14px', fontWeight: '500', color: DIALOG.text },
  allocBarDivider: { width: '0.5px', height: '30px', background: DIALOG.border, margin: '0 4px' },
  reclassNotice: { display: 'flex', gap: '10px', alignItems: 'flex-start', background: DIALOG.accentFill, border: '0.5px solid ' + DIALOG.accent, borderRadius: '8px', padding: '10px 12px', marginBottom: '12px', color: DIALOG.accent },
  searchInput: { width: '100%', fontFamily: 'system-ui,sans-serif', fontSize: '13px', padding: '8px 12px', border: '0.5px solid ' + DIALOG.border, borderRadius: '8px', outline: 'none', background: DIALOG.panel, color: DIALOG.text, boxSizing: 'border-box' as const },
  candidateList: { display: 'flex', flexDirection: 'column' as const, gap: '6px', maxHeight: '280px', overflowY: 'auto' as const, marginBottom: '12px' },
  candidateRow: { display: 'flex', alignItems: 'center', gap: '10px', padding: '10px 12px', border: '0.5px solid ' + DIALOG.border, borderRadius: '8px', background: DIALOG.panel },
  candidateRowLinked: { border: '1.5px solid ' + DIALOG.accent, background: DIALOG.accentFill },
  candidateRowDone: { background: DIALOG.raised, opacity: 0.7 },
  candidatePartner: { fontSize: '13px', fontWeight: '500', color: DIALOG.text },
  candidateIdentifier: { fontSize: '11px', color: DIALOG.dim, background: DIALOG.raised, padding: '1px 6px', borderRadius: '4px', fontFamily: 'monospace' },
  candidateMeta: { fontSize: '11px', color: DIALOG.dim },
  candidateAmt: { fontSize: '13px', fontWeight: '500', color: DIALOG.text, whiteSpace: 'nowrap' as const },
  candidateBook: { fontSize: '11px', color: DIALOG.dim },
  statusBadge: { fontSize: '10px', fontWeight: '500', padding: '1px 7px', borderRadius: '20px' },
  addBtn: { fontFamily: 'system-ui,sans-serif', fontSize: '12px', padding: '5px 14px', border: '0.5px solid ' + DIALOG.accent, borderRadius: '6px', background: 'transparent', color: DIALOG.accent, cursor: 'pointer', whiteSpace: 'nowrap' as const, flexShrink: 0 },
  removeBtn: { fontFamily: 'system-ui,sans-serif', fontSize: '12px', padding: '5px 14px', border: '0.5px solid ' + DIALOG.red, borderRadius: '6px', background: 'transparent', color: DIALOG.red, cursor: 'pointer', whiteSpace: 'nowrap' as const, flexShrink: 0 },
  allocationSection: { background: DIALOG.raised, border: '0.5px solid ' + DIALOG.border, borderRadius: '10px', padding: '12px 14px' },
  allocationTitle: { fontSize: '10px', fontWeight: '500', color: DIALOG.dim, textTransform: 'uppercase' as const, letterSpacing: '0.08em', marginBottom: '10px', paddingBottom: '6px', borderBottom: '0.5px solid ' + DIALOG.border },
  allocationRow: { display: 'flex', alignItems: 'center', gap: '12px', paddingBottom: '8px', marginBottom: '8px', borderBottom: '0.5px solid #ececec' },
  allocInput: { fontFamily: 'system-ui,sans-serif', fontSize: '13px', padding: '7px 10px', border: '0.5px solid ' + DIALOG.border, borderRadius: '8px', background: DIALOG.panel, color: DIALOG.text, outline: 'none', width: '110px', textAlign: 'right' as const },
  maxBtn: { fontFamily: 'system-ui,sans-serif', fontSize: '11px', padding: '5px 8px', border: '0.5px solid ' + DIALOG.border, borderRadius: '6px', background: DIALOG.panel, color: DIALOG.dim, cursor: 'pointer' },
  btnGhost: { fontFamily: 'system-ui,sans-serif', fontSize: '13px', padding: '8px 16px', borderRadius: '8px', border: '0.5px solid ' + DIALOG.border, background: 'transparent', color: DIALOG.dim, cursor: 'pointer' },
  btnPrimary: { fontFamily: 'system-ui,sans-serif', fontSize: '13px', padding: '8px 18px', borderRadius: '8px', border: 'none', background: DIALOG.accent, color: DIALOG.onAccent, cursor: 'pointer', fontWeight: '500' },
}