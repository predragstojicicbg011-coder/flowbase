import React, { useState, useEffect, useCallback, useMemo } from 'react'
import { supabase } from '../supabase'
import { runWrite } from '../services/writeOrder'
import {
  rateOn, revolvingSchedule, outstandingOf, defaultMaturity,
  type RateReset, type ScheduleRow,
} from '../services/revolvingCredit'

// ── Revolving credits ───────────────────────────────────────────────────────
//
// A line the bank keeps open: interest every month, the principal in one
// payment at maturity, and a maturity that is usually rolled rather than met.
//
// It shares `credits` and `credit_installments` with the annuity loans above
// it, which is what makes the total at the top of the page one number rather
// than two added up by the reader — and what makes the Budgeting schedule and
// the Cash Flow timeline know about these the day they are added.
//
// ── Three things the screen must not round away ─────────────────────────────
//
// The rate is EURIBOR plus a margin, and the EURIBOR half is not something
// this application knows until somebody enters it. Unpriced, the monthly
// interest is "—" and the total obligation shows the principal with the
// interest missing rather than a tidy number that is wrong.
//
// The maturity is a fact with a history. Every roll is a row, so "this tranche
// has been extended three times" is answerable — which is the question a bank
// asks before it agrees to a fourth.
//
// And the schedule is generated FROM A MONTH YOU CHOOSE. Interest already paid
// is already in the ledger; regenerating it would put the same obligation on
// the books twice.

export interface RevolvingCredit {
  id: string
  name: string
  bank: string
  principal_amount: number
  currency: string
  disbursement_date: string | null
  maturity_date: string | null
  rate_margin: number | null
  reference_rate_name: string | null
  rate_description: string | null
  status: string
  notes: string | null
}

const fmtEUR = (n: number | null) =>
  n === null ? '—' : '€' + n.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })

const fmtEURCompact = (n: number | null) => {
  if (n === null) return '—'
  if (n >= 1000000) return `€${(n / 1000000).toFixed(1)}M`
  if (n >= 1000) return `€${(n / 1000).toFixed(0)}K`
  return `€${n.toFixed(0)}`
}

const thisMonth = () => new Date().toISOString().slice(0, 7)
const today = () => new Date().toISOString().slice(0, 10)

const daysUntil = (d: string) =>
  Math.ceil((new Date(d).getTime() - new Date().getTime()) / 86400000)

const inp: React.CSSProperties = {
  width: '100%', boxSizing: 'border-box', fontFamily: "'Inter', sans-serif",
  fontSize: '13px', padding: '9px 12px', border: '1px solid rgba(255,255,255,0.08)',
  borderRadius: '8px', background: '#111F30', color: '#DCE9F6', outline: 'none',
}

/** What one tranche is worth to the totals at the top of the page. */
export function summarise(
  credits: RevolvingCredit[], resets: Record<string, RateReset[]>,
): { principal: number; interest: number | null; unpriced: number } {
  let principal = 0
  let interest: number | null = 0
  let unpriced = 0

  for (const c of credits) {
    const owed = outstandingOf({
      principal: c.principal_amount,
      margin: c.rate_margin,
      resets: resets[c.id] || [],
      fromMonth: thisMonth(),
      maturity: c.maturity_date || '',
      billingDay: Number((c.disbursement_date || '').slice(8, 10)) || undefined,
    })
    principal += owed.principal
    if (owed.interest === null) {
      // One unpriced line makes the interest total unknown. Adding the priced
      // ones and calling it the total would understate the obligation by
      // whatever this line costs, which is the direction that flatters.
      unpriced += 1
      interest = null
    } else if (interest !== null) {
      interest += owed.interest
    }
  }

  return {
    principal: Math.round(principal * 100) / 100,
    interest: interest === null ? null : Math.round(interest * 100) / 100,
    unpriced,
  }
}

// ═══ The section ═════════════════════════════════════════════════════════════

export default function RevolvingCredits({ credits, onRefresh, onEdit }: {
  credits: RevolvingCredit[]
  onRefresh: () => void
  /**
   * Open the tranche itself for correction.
   *
   * The page owns that dialog, because it edits every column of `credits` and
   * only half of them are on `RevolvingCredit` — the principal, the margin
   * and the maturity are here, the annuity fields are not.
   */
  onEdit?: (credit: RevolvingCredit) => void
}) {
  const [resets, setResets] = useState<Record<string, RateReset[]>>({})
  const [openId, setOpenId] = useState<string | null>(null)
  const [extending, setExtending] = useState<RevolvingCredit | null>(null)
  const [pricing, setPricing] = useState<RevolvingCredit | null>(null)

  const loadResets = useCallback(async () => {
    const ids = credits.map(c => c.id)
    if (ids.length === 0) { setResets({}); return }
    const { data } = await supabase
      .from('credit_rate_resets')
      .select('credit_id, effective_from, reference_rate')
      .in('credit_id', ids)
      .order('effective_from')
    const by: Record<string, RateReset[]> = {}
    for (const r of (data || []) as any[]) {
      ;(by[r.credit_id] ||= []).push({
        effective_from: r.effective_from,
        reference_rate: Number(r.reference_rate),
      })
    }
    setResets(by)
  }, [credits])

  useEffect(() => { loadResets() }, [loadResets])

  const totals = useMemo(() => summarise(credits, resets), [credits, resets])

  if (credits.length === 0) return null

  return (
    <div>
      <div style={{ display: 'flex', alignItems: 'center', gap: '10px', marginBottom: '14px' }}>
        <div style={{ flex: 1 }} />
        <div style={{ fontSize: '11px', color: '#7A9BB8' }}>
          {credits.length} tranche{credits.length === 1 ? '' : 's'} ·{' '}
          <strong style={{ color: '#DCE9F6' }}>{fmtEURCompact(totals.principal)}</strong> principal
          {totals.interest === null
            ? <span style={{ color: '#F5A623' }}> · interest not priced</span>
            : <> · {fmtEURCompact(totals.interest)} interest to maturity</>}
        </div>
      </div>

      {credits.map(c => (
        <Tranche
          key={c.id}
          credit={c}
          resets={resets[c.id] || []}
          open={openId === c.id}
          onToggle={() => setOpenId(openId === c.id ? null : c.id)}
          onExtend={() => setExtending(c)}
          onPrice={() => setPricing(c)}
          onEdit={onEdit ? () => onEdit(c) : undefined}
          onRefresh={() => { onRefresh(); loadResets() }}
        />
      ))}

      {extending && (
        <ExtendDialog credit={extending}
          onClose={() => setExtending(null)}
          onSaved={() => { setExtending(null); onRefresh() }} />
      )}
      {pricing && (
        <RateDialog credit={pricing}
          onClose={() => setPricing(null)}
          onSaved={() => { setPricing(null); loadResets() }} />
      )}
    </div>
  )
}

// ── One tranche ─────────────────────────────────────────────────────────────

function Tranche({ credit, resets, open, onToggle, onExtend, onPrice, onEdit, onRefresh }: {
  credit: RevolvingCredit
  resets: RateReset[]
  open: boolean
  onToggle: () => void
  onExtend: () => void
  onPrice: () => void
  onEdit?: () => void
  onRefresh: () => void
}) {
  const [history, setHistory] = useState<any[]>([])
  const [existing, setExisting] = useState<number | null>(null)
  const [busy, setBusy] = useState(false)
  const [msg, setMsg] = useState('')

  const billingDay = Number((credit.disbursement_date || '').slice(8, 10)) || undefined
  const request = {
    principal: credit.principal_amount,
    margin: credit.rate_margin,
    resets,
    fromMonth: thisMonth(),
    maturity: credit.maturity_date || '',
    billingDay,
  }
  const rate = rateOn(credit.rate_margin, resets, today())
  const schedule = revolvingSchedule(request)
  const owed = outstandingOf(request)
  const monthly = schedule.find(r => r.principal_amount === 0)?.interest_amount ?? null

  const days = credit.maturity_date ? daysUntil(credit.maturity_date) : null
  const soon = days !== null && days <= 60

  useEffect(() => {
    if (!open) return
    supabase.from('credit_extensions')
      .select('extended_on, previous_maturity, new_maturity, reason')
      .eq('credit_id', credit.id).order('extended_on', { ascending: false })
      .then(({ data }) => setHistory(data || []))
    supabase.from('credit_installments')
      .select('id', { count: 'exact', head: true })
      .eq('credit_id', credit.id).eq('status', 'outstanding')
      .then(({ count }) => setExisting(count ?? 0))
  }, [open, credit.id])

  /**
   * Writes the interest months and the repayment into `credit_installments`.
   *
   * Outstanding rows from this month on are REPLACED, never added to: pressing
   * the button twice, or pressing it again after a rate reset, has to leave
   * one schedule behind rather than two. Paid rows are left exactly where they
   * are — they are what actually happened, and this is a forecast.
   */
  const generate = async () => {
    if (schedule.length === 0) return
    setBusy(true); setMsg('')

    const cutoff = `${thisMonth()}-01`
    const { error: delErr } = await supabase
      .from('credit_installments')
      .delete()
      .eq('credit_id', credit.id)
      .eq('status', 'outstanding')
      .gte('due_date', cutoff)
    if (delErr) { setMsg(delErr.message); setBusy(false); return }

    const rows = schedule.map((r: ScheduleRow) => ({
      credit_id: credit.id,
      installment_no: r.installment_no,
      due_date: r.due_date,
      principal_amount: r.principal_amount,
      interest_amount: r.interest_amount,
      total_amount: r.total_amount,
      status: 'outstanding',
      notes: r.principal_amount > 0
        ? 'Revolving — repayment at maturity'
        : 'Revolving — monthly interest',
    }))

    const { ok, message } = await runWrite('Generate the revolving schedule',
      supabase.from('credit_installments').insert(rows))
    setBusy(false)
    setMsg(ok ? `${rows.length} instalment${rows.length === 1 ? '' : 's'} written.` : message)
    if (ok) onRefresh()
  }

  return (
    <div style={{
      background: '#0D1B2C', border: '1px solid rgba(255,255,255,0.06)',
      borderLeft: `2.5px solid ${soon ? '#F5A623' : '#8B8BFF'}`,
      borderRadius: '12px', marginBottom: '10px', overflow: 'hidden',
    }}>
      <div onClick={onToggle}
        style={{ display: 'grid', gridTemplateColumns: '1.6fr 1fr 1fr 1fr 1fr auto', gap: '14px', alignItems: 'center', padding: '16px 20px', cursor: 'pointer' }}>
        <div>
          <div style={{ fontSize: '14px', color: '#E8F1FB', fontWeight: 500 }}>{credit.name}</div>
          <div style={{ fontSize: '11px', color: '#7A9BB8', marginTop: '3px' }}>
            {credit.bank}
            {credit.disbursement_date && ` · drawn ${credit.disbursement_date}`}
          </div>
        </div>

        <Cell label="Principal" value={fmtEUR(credit.principal_amount)} />

        <Cell label="Rate"
          value={rate === null ? '—' : `${rate.toFixed(2)}%`}
          sub={credit.rate_description || credit.reference_rate_name || ''}
          warn={rate === null} />

        <Cell label="Interest / month"
          value={monthly === null ? '—' : fmtEUR(monthly)}
          sub={monthly === null ? 'enter the benchmark' : ''}
          warn={monthly === null} />

        <Cell label="Matures"
          value={credit.maturity_date || '—'}
          sub={days === null ? '' : days < 0 ? `${-days} days overdue` : `in ${days} days`}
          warn={soon} />

        <div style={{ fontSize: '11px', color: '#7A9BB8' }}>{open ? '▼' : '▶'}</div>
      </div>

      {open && (
        <div style={{ borderTop: '1px solid rgba(255,255,255,0.06)', padding: '16px 20px', background: '#0A1525' }}>
          <div style={{ display: 'flex', gap: '10px', flexWrap: 'wrap', marginBottom: '14px' }}>
            <button onClick={onPrice} style={btn('#4EA8FF')}>
              {rate === null ? 'Enter the benchmark rate' : 'Record a rate reset'}
            </button>
            <button onClick={onExtend} style={btn('#8B8BFF')}>Extend the maturity</button>
            {/* The tranche itself: principal, margin, benchmark name, dates.
                A reset prices a period; this corrects what the line IS. */}
            {onEdit && (
              <button onClick={onEdit} style={btn('#7A9BB8')}
                title="Correct the line itself — principal, margin, benchmark, dates">
                Edit credit
              </button>
            )}
            <button onClick={generate} disabled={busy || schedule.length === 0}
              title={schedule.length === 0
                ? 'The line has no rate yet, so there is no interest to schedule'
                : 'Write the interest months and the repayment into the credit schedule'}
              style={{ ...btn('#00D47E'), opacity: busy || schedule.length === 0 ? 0.45 : 1 }}>
              {busy ? 'Writing…' : 'Generate the schedule'}
            </button>
            {msg && <span style={{ fontSize: '11.5px', color: '#7A9BB8', alignSelf: 'center' }}>{msg}</span>}
          </div>

          <div style={{ fontSize: '11.5px', color: '#7A9BB8', lineHeight: 1.7, marginBottom: '14px' }}>
            Interest only until <strong style={{ color: '#DCE9F6' }}>{credit.maturity_date || 'maturity'}</strong>,
            then <strong style={{ color: '#DCE9F6' }}>{fmtEUR(credit.principal_amount)}</strong> repaid in one payment.
            {' '}Still owed from this month:{' '}
            <strong style={{ color: '#DCE9F6' }}>{fmtEUR(owed.principal)}</strong> principal
            {owed.interest === null
              ? <span style={{ color: '#F5A623' }}> and an unpriced amount of interest — record the benchmark to see it</span>
              : <> plus <strong style={{ color: '#DCE9F6' }}>{fmtEUR(owed.interest)}</strong> interest over {schedule.length} month{schedule.length === 1 ? '' : 's'}</>}
            {existing !== null && existing > 0 && (
              <> · <span style={{ color: '#F5A623' }}>{existing} outstanding instalment{existing === 1 ? '' : 's'} already on the schedule — generating replaces the ones from this month on</span></>
            )}
          </div>

          {history.length > 0 && (
            <div style={{ marginBottom: '6px' }}>
              <div style={{ fontSize: '10px', color: 'rgba(255,255,255,0.28)', textTransform: 'uppercase', letterSpacing: '0.1em', marginBottom: '6px' }}>
                Rolled {history.length} time{history.length === 1 ? '' : 's'}
              </div>
              {history.map((h, i) => (
                <div key={i} style={{ fontSize: '11.5px', color: '#7A9BB8', lineHeight: 1.8 }}>
                  {h.extended_on}: {h.previous_maturity || '—'} → <strong style={{ color: '#DCE9F6' }}>{h.new_maturity}</strong>
                  {h.reason ? ` · ${h.reason}` : ''}
                </div>
              ))}
            </div>
          )}
        </div>
      )}
    </div>
  )
}

const Cell = ({ label, value, sub, warn }: {
  label: string; value: string; sub?: string; warn?: boolean
}) => (
  <div>
    <div style={{ fontSize: '9.5px', color: 'rgba(255,255,255,0.28)', textTransform: 'uppercase', letterSpacing: '0.1em', marginBottom: '4px' }}>{label}</div>
    <div style={{ fontFamily: "'DM Mono','Fira Mono',monospace", fontSize: '13.5px', color: warn ? '#F5A623' : '#DCE9F6' }}>{value}</div>
    {sub && <div style={{ fontSize: '10px', color: 'rgba(255,255,255,0.25)', marginTop: '2px' }}>{sub}</div>}
  </div>
)

const btn = (colour: string): React.CSSProperties => ({
  fontFamily: "'Inter', sans-serif", fontSize: '12px', fontWeight: 600,
  padding: '7px 14px', borderRadius: '8px', border: `1px solid ${colour}44`,
  background: `${colour}1A`, color: colour, cursor: 'pointer',
})

// ── Rolling the maturity ────────────────────────────────────────────────────

function ExtendDialog({ credit, onClose, onSaved }: {
  credit: RevolvingCredit; onClose: () => void; onSaved: () => void
}) {
  const [to, setTo] = useState(
    credit.maturity_date ? defaultMaturity(credit.maturity_date) : '')
  const [reason, setReason] = useState('')
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState('')

  const save = async () => {
    if (!to) { setError('Pick the new maturity date.'); return }
    if (credit.maturity_date && to <= credit.maturity_date) {
      setError('The new maturity has to be later than the current one. To shorten a line, close it and record the repayment.')
      return
    }
    setSaving(true); setError('')

    // The history row first. If the update fails afterwards the ledger shows a
    // roll that did not take, which is visible and fixable; the other order
    // leaves a maturity nobody can account for.
    const { error: logErr } = await supabase.from('credit_extensions').insert({
      credit_id: credit.id,
      extended_on: today(),
      previous_maturity: credit.maturity_date,
      new_maturity: to,
      reason: reason.trim() || null,
    })
    if (logErr) { setError(logErr.message); setSaving(false); return }

    const { ok, message } = await runWrite('Extend the maturity',
      supabase.from('credits').update({ maturity_date: to, last_payment_date: to }).eq('id', credit.id))
    setSaving(false)
    if (!ok) { setError(message); return }
    onSaved()
  }

  return (
    <Dialog kicker="Revolving" title="Extend the maturity" onClose={onClose}>
      {error && <Problem>{error}</Problem>}
      <Field label="Currently matures">
        <div style={{ ...inp, background: 'transparent', color: '#7A9BB8' }}>
          {credit.maturity_date || '—'}
        </div>
      </Field>
      <Field label="New maturity *">
        <input type="date" style={inp} value={to} onChange={e => setTo(e.target.value)} />
      </Field>
      <Field label="Why">
        <input style={inp} placeholder="e.g. rolled for another year" value={reason} onChange={e => setReason(e.target.value)} />
      </Field>
      <div style={{ fontSize: '11.5px', color: '#7A9BB8', lineHeight: 1.6, marginBottom: '16px' }}>
        The roll is recorded as well as applied, so how many times this line has been
        extended stays answerable. Regenerate the schedule afterwards to bill interest
        through to the new date.
      </div>
      <Actions onClose={onClose} onSave={save} saving={saving} label="Extend" />
    </Dialog>
  )
}

// ── Recording a benchmark ───────────────────────────────────────────────────

function RateDialog({ credit, onClose, onSaved }: {
  credit: RevolvingCredit; onClose: () => void; onSaved: () => void
}) {
  /**
   * WHICH FIGURE IS BEING TYPED.
   *
   * The bank quotes a line two ways. The loan agreement says "3M EURIBOR plus
   * 2.95%", and the statement says "5.35%". Both describe the same month, and
   * until now only the first could be entered — so reading the all-in rate off
   * a statement meant subtracting the margin by hand before typing it, which
   * is arithmetic done in the one place nothing checks it.
   *
   * Either may be typed now. What is STORED is the benchmark either way: that
   * is the half that moves, the margin belongs to the credit, and a reset that
   * recorded the total would be wrong the moment the margin was corrected.
   */
  const [mode, setMode] = useState<'benchmark' | 'allin'>('benchmark')
  const [rate, setRate] = useState('')
  const [from, setFrom] = useState(`${thisMonth()}-01`)
  const [note, setNote] = useState('')
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState('')

  const margin = credit.rate_margin
  const typed = parseFloat(rate.replace(',', '.'))
  const benchmark = benchmarkFrom(typed, mode, margin)
  const allIn = benchmark === null || margin == null ? null : round6(benchmark + margin)

  const save = async () => {
    const why = whyNotPriceable(typed, mode, margin, from)
    if (why) { setError(why); return }
    setSaving(true); setError('')
    const { ok, message } = await runWrite('Record the rate reset',
      supabase.from('credit_rate_resets').insert({
        credit_id: credit.id,
        effective_from: from,
        reference_rate: benchmark,
        note: note.trim() || null,
      }))
    setSaving(false)
    if (!ok) { setError(message); return }
    onSaved()
  }

  return (
    <Dialog kicker="Revolving" title="Record a rate reset" onClose={onClose}>
      {error && <Problem>{error}</Problem>}
      <div style={{ display: 'flex', gap: '8px', marginBottom: '16px' }}>
        {([
          ['benchmark', `${credit.reference_rate_name || 'Benchmark'} only`],
          ['allin', 'All-in rate'],
        ] as const).map(([m, label]) => (
          <button key={m} type="button" onClick={() => setMode(m)}
            style={{
              flex: 1, cursor: 'pointer', borderRadius: '9px', padding: '8px 12px',
              fontFamily: "'Inter', sans-serif", fontSize: '12px', fontWeight: 600,
              border: `1px solid ${mode === m ? '#4EA8FF' : 'rgba(255,255,255,0.08)'}`,
              background: mode === m ? 'rgba(78,168,255,0.12)' : 'transparent',
              color: mode === m ? '#4EA8FF' : '#7A9BB8',
            }}>
            {label}
          </button>
        ))}
      </div>
      <Field label={mode === 'benchmark'
        ? `${credit.reference_rate_name || 'Benchmark'} (%) *`
        : 'All-in rate, margin included (%) *'}>
        <input style={inp} placeholder={mode === 'benchmark' ? 'e.g. 2.4' : 'e.g. 5.35'}
          value={rate} onChange={e => setRate(e.target.value)} />
      </Field>
      <Field label="Applies from *">
        <input type="date" style={inp} value={from} onChange={e => setFrom(e.target.value)} />
      </Field>
      <Field label="Note">
        <input style={inp} placeholder="e.g. Q4 reset" value={note} onChange={e => setNote(e.target.value)} />
      </Field>
      <div style={{ fontSize: '11.5px', color: '#7A9BB8', lineHeight: 1.6, marginBottom: '16px' }}>
        Margin <strong style={{ color: '#DCE9F6' }}>{margin ?? '—'}%</strong>
        {benchmark !== null && (
          <> · benchmark <strong style={{ color: '#DCE9F6' }}>{benchmark.toFixed(2)}%</strong></>
        )}
        {allIn !== null && <> · all-in <strong style={{ color: '#DCE9F6' }}>{allIn.toFixed(2)}%</strong></>}.
        {mode === 'allin' && (
          <> {' '}The benchmark is what gets stored — it is the half that moves, and a
          reset holding the total would be wrong the moment the margin was corrected.</>
        )}
        {margin == null && (
          <span style={{ color: '#F5A623' }}> {' '}This line has no margin recorded yet —
          set one with Edit credit, or the all-in rate cannot be split.</span>
        )}
        {' '}Resets are appended, never edited: a month already billed keeps the rate it
        was billed at, and this one prices the months from the date above onward.
      </div>
      <Actions onClose={onClose} onSave={save} saving={saving} label="Record" />
    </Dialog>
  )
}

/** Rates are quoted to two or three places; this keeps a subtraction honest. */
const round6 = (n: number) => Math.round(n * 1e6) / 1e6

/**
 * The benchmark to store, from whichever figure was typed.
 *
 * Null when it cannot be known: nothing typed, or an all-in rate on a line
 * whose margin has never been recorded — in which case the split is a guess,
 * and a guess written into the rate history prices every month after it.
 */
export function benchmarkFrom(
  typed: number, mode: 'benchmark' | 'allin', margin: number | null | undefined,
): number | null {
  if (!Number.isFinite(typed)) return null
  if (mode === 'benchmark') return round6(typed)
  if (margin === null || margin === undefined) return null
  // Negative is allowed and is not a mistake: EURIBOR was below zero for
  // years, and an all-in rate under the margin is how that shows up here.
  return round6(typed - margin)
}

/** Why this reset cannot be recorded, or null. */
export function whyNotPriceable(
  typed: number, mode: 'benchmark' | 'allin',
  margin: number | null | undefined, from: string,
): string | null {
  if (!Number.isFinite(typed)) {
    return mode === 'benchmark'
      ? 'Enter the benchmark rate, e.g. 2.4 for 2.4%.'
      : 'Enter the all-in rate, e.g. 5.35 for 5.35%.'
  }
  if (mode === 'allin' && (margin === null || margin === undefined)) {
    return 'This line has no margin recorded, so an all-in rate cannot be split into one. '
      + 'Set the margin with Edit credit, or enter the benchmark on its own.'
  }
  if (!from) return 'Say which day this rate starts applying.'
  return null
}

// ── Dialog furniture ────────────────────────────────────────────────────────

const Dialog = ({ kicker, title, onClose, children }: {
  kicker: string; title: string; onClose: () => void; children: React.ReactNode
}) => (
  <div style={{ position: 'fixed', inset: 0, background: 'rgba(0,0,0,0.7)', backdropFilter: 'blur(4px)', display: 'flex', alignItems: 'center', justifyContent: 'center', zIndex: 1100 }}
    onClick={e => { if (e.target === e.currentTarget) onClose() }}>
    <div style={{ background: '#0D1B2C', border: '1px solid rgba(255,255,255,0.10)', borderRadius: '16px', width: '460px', maxWidth: '95vw', boxShadow: '0 24px 60px rgba(0,0,0,0.7)' }}>
      <div style={{ background: '#0A1525', padding: '18px 22px', borderBottom: '1px solid rgba(255,255,255,0.06)', display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start' }}>
        <div>
          <div style={{ fontSize: '10px', fontWeight: 600, color: '#8B8BFF', letterSpacing: '0.1em', textTransform: 'uppercase', marginBottom: '4px' }}>{kicker}</div>
          <div style={{ fontFamily: "'DM Serif Display', Georgia, serif", fontSize: '20px', color: '#E8F1FB' }}>{title}</div>
        </div>
        <button onClick={onClose} aria-label="Close"
          style={{ background: 'rgba(255,255,255,0.05)', border: '1px solid rgba(255,255,255,0.08)', color: '#7A9BB8', width: '30px', height: '30px', borderRadius: '8px', cursor: 'pointer', fontSize: '18px' }}>×</button>
      </div>
      <div style={{ padding: '22px' }}>{children}</div>
    </div>
  </div>
)

const Field = ({ label, children }: { label: string; children: React.ReactNode }) => (
  <div style={{ marginBottom: '16px' }}>
    <div style={{ fontSize: '10px', fontWeight: 600, color: 'rgba(255,255,255,0.30)', letterSpacing: '0.1em', textTransform: 'uppercase', marginBottom: '6px' }}>{label}</div>
    {children}
  </div>
)

const Problem = ({ children }: { children: React.ReactNode }) => (
  <div style={{ background: 'rgba(255,91,90,0.10)', border: '1px solid rgba(255,91,90,0.3)', borderRadius: '8px', padding: '10px 14px', fontSize: '12px', color: '#FF5B5A', marginBottom: '16px' }}>
    {children}
  </div>
)

const Actions = ({ onClose, onSave, saving, label }: {
  onClose: () => void; onSave: () => void; saving: boolean; label: string
}) => (
  <div style={{ display: 'flex', gap: '10px', justifyContent: 'flex-end' }}>
    <button onClick={onClose} style={{ fontFamily: "'Inter',sans-serif", fontSize: '13px', padding: '8px 16px', borderRadius: '8px', border: '1px solid rgba(255,255,255,0.08)', background: 'transparent', color: '#7A9BB8', cursor: 'pointer' }}>Cancel</button>
    <button onClick={onSave} disabled={saving}
      style={{ fontFamily: "'Inter',sans-serif", fontSize: '13px', fontWeight: 600, padding: '8px 18px', borderRadius: '8px', border: 'none', background: '#8B8BFF', color: '#060E1A', cursor: 'pointer', opacity: saving ? 0.6 : 1 }}>
      {saving ? 'Saving…' : label}
    </button>
  </div>
)
