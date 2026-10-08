import React, { useState, useEffect, useCallback } from 'react'
import { supabase } from '../supabase'
import { SkeletonRows } from '../components/motion'
import { runWrite } from '../services/writeOrder'
import { fetchAllPages } from '../utils/fetchAllPages'
import { useDataRefresh } from '../contexts/DataRefreshContext'
import { useCompanies } from '../contexts/CompaniesContext'
import RevolvingCredits, { summarise, type RevolvingCredit } from '../components/RevolvingCredits'
import DebtPanels from '../components/DebtPanels'
import { defaultMaturity, revolvingSchedule } from '../services/revolvingCredit'
import { earliestDue, overdueCount, type DueInstalment } from '../services/debtSchedule'
import { supabase as db } from '../supabase'
import { fmtMoney, fmtMoneyCompact, fmtNum } from '../utils/formatters'
import { countOf, plural } from '../utils/plural'
import { useDisplayCurrency } from '../contexts/DisplayCurrencyContext'
import { getBookRates, bookAmounts, type BookRates } from '../services/bookAmounts'

// ─── Types ────────────────────────────────────────────────────────────────────
interface Credit {
  id: string
  company_id: string
  name: string
  bank: string
  principal_amount: number
  currency: string
  interest_rate: number
  rate_type: 'fixed' | 'variable'
  rate_description: string
  disbursement_date: string | null
  first_payment_date: string | null
  last_payment_date: string | null
  monthly_annuity: number
  total_installments: number
  status: 'active' | 'closed' | 'restructured'
  notes: string | null
  /**
   * Which kind of obligation this is.
   *
   *   annuity    amortising: every instalment is part principal, part interest
   *   revolving  interest only, and the principal in one payment at maturity
   *
   * Defaulted to `annuity` in the database, so every credit that existed
   * before the distinction did is one — which is what they all are.
   */
  kind?: 'annuity' | 'revolving'
  maturity_date?: string | null
  rate_margin?: number | null
  reference_rate_name?: string | null
}

interface Installment {
  id: string
  credit_id: string
  installment_no: number
  due_date: string
  principal_amount: number
  interest_amount: number
  total_amount: number
  status: 'paid' | 'outstanding'
  transaction_id: string | null
  paid_date: string | null
  paid_amount: number | null
  notes: string | null
}

// ─── Helpers ─────────────────────────────────────────────────────────────────
// A credit's figures are in the credit's own currency — a loan may be indexed
// to EUR or taken in RSD — and are printed with that currency's code. Only the
// page's overview adds credits together, and it converts first.
function fmtIn(n: number, currency: string): string {
  if (n === 0) return '—'
  return fmtMoney(n, currency || 'RSD')
}
function fmtInCompact(n: number, currency: string): string {
  return fmtMoneyCompact(n, currency || 'RSD')
}
/** 'YYYY-MM-DD' → '08.10.2026.', read from the string so no time zone can move the day. */
function fmtDate(iso: string | null | undefined): string {
  if (!iso) return '—'
  return `${iso.slice(8, 10)}.${iso.slice(5, 7)}.${iso.slice(0, 4)}.`
}
function daysUntil(dateStr: string): number {
  return Math.ceil((new Date(dateStr).getTime() - new Date().getTime()) / 86400000)
}
function isOverdue(dateStr: string): boolean {
  return new Date(dateStr) < new Date()
}

// ─── The credit dialog, for adding one and for correcting one ────────────────
//
// One form, not two. A credit was write-once until now: everything the bank
// quotes — the rate above all — had to be right at the moment it was typed or
// it was wrong for good, and the only way to fix a figure was to delete the
// credit and lose its schedule with it.
//
// Adding and correcting ask for exactly the same facts, so they are the same
// form. What differs is where it ends up: an insert, or an update of the row
// handed in.
//
// ─── New Credit Dialog ────────────────────────────────────────────────────────
//
// `Field` and `inp` live OUT HERE, and must stay out here.
//
// Declared inside the dialog, `Field` was a new function on every render, and
// a new function is a new component TYPE. React compares types by reference,
// so a new type is not the old component re-rendered — it is the old one
// unmounted and a replacement mounted in its place. Every keystroke therefore
// threw away the input the caret was sitting in and built another one, and the
// caret went with it: one letter per click, for as long as you had patience.
//
// Out here the function is made once, so the same input stays on screen and
// typing works the way typing works.
const Field = ({ label, children }: { label: string; children: React.ReactNode }) => (
  <div style={{ marginBottom: '16px' }}>
    <div style={{ fontSize: '10px', fontWeight: '600', color: 'rgba(255,255,255,0.30)', letterSpacing: '0.1em', textTransform: 'uppercase' as const, marginBottom: '6px' }}>{label}</div>
    {children}
  </div>
)
const inp: React.CSSProperties = { width: '100%', boxSizing: 'border-box' as const, fontFamily: "'Inter', sans-serif", fontSize: '13px', padding: '9px 12px', border: '1px solid rgba(255,255,255,0.08)', borderRadius: '8px', background: '#111F30', color: '#DCE9F6', outline: 'none' }

export function CreditDialog({ credit, hasSchedule = false, onClose, onSaved }: {
  /** The credit being corrected. Absent means a new one is being added. */
  credit?: Credit | null
  /**
   * Whether instalments have already been written against it.
   *
   * Only used to decide whether the kind may still be changed — see the
   * buttons below. The page knows this already, so it is handed down rather
   * than counted a second time here.
   */
  hasSchedule?: boolean
  onClose: () => void
  onSaved: () => void
}) {
  const editing = !!credit
  const str = (v: unknown) => (v === null || v === undefined ? '' : String(v))

  const [form, setForm] = useState({
    kind: (credit?.kind || 'annuity') as 'annuity' | 'revolving',
    name: str(credit?.name), bank: str(credit?.bank),
    principal_amount: str(credit?.principal_amount), currency: credit?.currency || 'EUR',
    interest_rate: str(credit?.interest_rate),
    rate_type: (credit?.rate_type || 'fixed') as 'fixed' | 'variable',
    rate_description: str(credit?.rate_description),
    disbursement_date: str(credit?.disbursement_date),
    first_payment_date: str(credit?.first_payment_date),
    last_payment_date: str(credit?.last_payment_date),
    monthly_annuity: str(credit?.monthly_annuity),
    total_installments: str(credit?.total_installments),
    maturity_date: str(credit?.maturity_date),
    rate_margin: str(credit?.rate_margin),
    reference_rate_name: credit?.reference_rate_name || '3M EURIBOR',
    notes: str(credit?.notes),
  })

  /**
   * A credit with a schedule cannot change its kind.
   *
   * The two kinds are repaid differently, and the instalments already written
   * say which. Turning an amortising loan with twenty-four instalments into a
   * revolving line nulls the annuity, the rate and the count that explain
   * those rows, and leaves the rows themselves behind — a schedule with
   * nothing left to account for it. Delete the schedule first, deliberately,
   * or make a second credit.
   */
  const kindLocked = editing && hasSchedule
  const revolving = form.kind === 'revolving'
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState('')

  const set = (k: string, v: string) => setForm(f => ({ ...f, [k]: v }))

  const { defaultCompany } = useCompanies()

  /** A credit that did not exist before, under the one company this book has. */
  const addNew = (fields: Record<string, unknown>) =>
    defaultCompany
      ? runWrite('Dodavanje kredita',
        supabase.from('credits').insert({ ...fields, company_id: defaultCompany.id, status: 'active' }))
      : Promise.resolve({ ok: false, message: 'Firma još nije podešena. Dodajte je u Podešavanjima.' })

  const handleSave = async () => {
    if (!form.name || !form.bank || !form.principal_amount) {
      setError('Unesite naziv, banku i iznos glavnice.')
      return
    }
    if (revolving && !form.maturity_date) {
      setError('Unesite dospeće revolving kredita — to je datum kada dospeva glavnica.')
      return
    }
    setSaving(true)

    // What the credit IS. The same fields whether it is being written for the
    // first time or corrected — but NOT `company_id` and NOT `status`: those
    // are settled when a credit is created, and writing `active` back over a
    // closed loan would reopen it.
    const fields = {
      name: form.name,
      bank: form.bank,
      principal_amount: parseFloat(form.principal_amount) || 0,
      currency: form.currency,
      // A revolving line's rate is the margin plus a benchmark that resets;
      // the all-in figure belongs to a month, not to the credit, so nothing
      // is stored here. `credit_rate_resets` carries the benchmark.
      interest_rate: revolving ? null : (parseFloat(form.interest_rate) || null),
      rate_type: revolving ? 'variable' : form.rate_type,
      rate_description: revolving
        ? `${form.reference_rate_name || 'Referentna stopa'} + ${form.rate_margin || '?'}%`
        : (form.rate_description || null),
      disbursement_date: form.disbursement_date || null,
      first_payment_date: revolving ? null : (form.first_payment_date || null),
      last_payment_date: revolving ? form.maturity_date : (form.last_payment_date || null),
      // An annuity's monthly payment and instalment count say nothing about a
      // line whose monthly cost is interest and moves with the benchmark.
      monthly_annuity: revolving ? null : (parseFloat(form.monthly_annuity) || null),
      total_installments: revolving ? null : (parseInt(form.total_installments) || null),
      kind: form.kind,
      maturity_date: revolving ? form.maturity_date : null,
      rate_margin: revolving ? (parseFloat(String(form.rate_margin).replace(',', '.')) || null) : null,
      reference_rate_name: revolving ? (form.reference_rate_name || null) : null,
      notes: form.notes || null,
    }

    const result = credit
      ? await runWrite('Čuvanje kredita',
        supabase.from('credits').update(fields).eq('id', credit.id))
      : await addNew(fields)

    setSaving(false)
    if (!result.ok) { setError(result.message); return }
    onSaved()
    onClose()
  }

  return (
    <div style={{ position: 'fixed', inset: 0, background: 'rgba(0,0,0,0.7)', backdropFilter: 'blur(4px)', display: 'flex', alignItems: 'center', justifyContent: 'center', zIndex: 1100 }}
      onClick={e => { if (e.target === e.currentTarget) onClose() }}>
      <div style={{ background: '#0D1B2C', border: '1px solid rgba(255,255,255,0.10)', borderRadius: '16px', width: '560px', maxWidth: '95vw', maxHeight: '90vh', overflow: 'hidden', display: 'flex', flexDirection: 'column', boxShadow: '0 24px 60px rgba(0,0,0,0.7)' }}>
        {/* Header */}
        <div style={{ background: '#0A1525', padding: '18px 22px', borderBottom: '1px solid rgba(255,255,255,0.06)', display: 'flex', alignItems: 'flex-start', justifyContent: 'space-between', flexShrink: 0 }}>
          <div>
            <div style={{ fontSize: '10px', fontWeight: '600', color: '#4EA8FF', letterSpacing: '0.1em', textTransform: 'uppercase' as const, marginBottom: '4px' }}>{editing ? 'Izmena kredita' : 'Novi kredit'}</div>
            <div style={{ fontFamily: "'DM Serif Display', Georgia, serif", fontSize: '20px', color: '#E8F1FB', fontWeight: '400' }}>{editing ? credit!.name : 'Dodaj kredit'}</div>
          </div>
          <button onClick={onClose} style={{ background: 'rgba(255,255,255,0.05)', border: '1px solid rgba(255,255,255,0.08)', color: '#7A9BB8', width: '30px', height: '30px', borderRadius: '8px', cursor: 'pointer', fontSize: '18px', display: 'flex', alignItems: 'center', justifyContent: 'center' }}>×</button>
        </div>

        {/* Body */}
        <div style={{ padding: '22px', overflowY: 'auto', flex: 1 }}>
          {error && <div style={{ background: 'rgba(255,91,90,0.10)', border: '1px solid rgba(255,91,90,0.3)', borderRadius: '8px', padding: '10px 14px', fontSize: '12px', color: '#FF5B5A', marginBottom: '16px' }}>{error}</div>}

          {/* WHICH KIND, FIRST. The two need different facts — an annuity has a
              schedule of instalments, a revolving line has a maturity and a
              margin — and a form that shows both sets at once is a form where
              half the fields are always wrong. */}
          <div style={{ display: 'flex', gap: '8px', marginBottom: '18px' }}>
            {([
              ['annuity', 'Anuitetni', 'Otplata u ratama'],
              ['revolving', 'Revolving', 'Samo kamata, glavnica o dospeću'],
            ] as const).map(([k, label, hint]) => (
              <button key={k} type="button" disabled={kindLocked}
                onClick={() => set('kind', k)}
                title={kindLocked
                  ? 'Ovaj kredit već ima plan otplate. Dve vrste se otplaćuju različito, pa bi promena ostavila postojeće rate bez objašnjenja.'
                  : undefined}
                style={{
                  flex: 1, textAlign: 'left', cursor: kindLocked ? 'not-allowed' : 'pointer',
                  opacity: kindLocked && form.kind !== k ? 0.4 : 1, borderRadius: '10px',
                  padding: '10px 14px', fontFamily: "'Inter', sans-serif",
                  border: `1px solid ${form.kind === k ? (k === 'revolving' ? '#8B8BFF' : '#4EA8FF') : 'rgba(255,255,255,0.08)'}`,
                  background: form.kind === k
                    ? (k === 'revolving' ? 'rgba(139,139,255,0.12)' : 'rgba(78,168,255,0.12)')
                    : 'transparent',
                  color: form.kind === k ? (k === 'revolving' ? '#8B8BFF' : '#4EA8FF') : '#7A9BB8',
                }}>
                <div style={{ fontSize: '13px', fontWeight: 600 }}>{label}</div>
                <div style={{ fontSize: '10.5px', opacity: 0.8, marginTop: '2px' }}>{hint}</div>
              </button>
            ))}
          </div>

          {kindLocked && (
            <div style={{ fontSize: '11.5px', color: '#7A9BB8', lineHeight: 1.6, margin: '-8px 0 18px' }}>
              Vrsta je zaključana dok postoji plan otplate — upisane rate se otplaćuju
              na jedan način, a druga vrsta ih ne bi objasnila. Sve ostalo možete da
              ispravite.
            </div>
          )}

          <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '0 16px' }}>
            <div style={{ gridColumn: '1 / -1' }}>
              <Field label="Naziv kredita *">
                <input style={inp} placeholder="npr. Intesa 100k — sep 2025" value={form.name} onChange={e => set('name', e.target.value)} />
              </Field>
            </div>
            <Field label="Banka *">
              <input style={inp} placeholder="npr. Intesa Banka" value={form.bank} onChange={e => set('bank', e.target.value)} />
            </Field>
            <Field label="Valuta">
              <select style={inp} value={form.currency} onChange={e => set('currency', e.target.value)}>
                <option value="EUR">EUR</option>
                <option value="RSD">RSD</option>
                {/* A loan in dollars is possible but not expected; kept for one written before. */}
                {form.currency === 'USD' && <option value="USD">USD</option>}
              </select>
            </Field>
            <Field label="Iznos glavnice *">
              <input style={inp} type="number" placeholder="100000" value={form.principal_amount} onChange={e => set('principal_amount', e.target.value)} />
            </Field>
            {!revolving && (
              <Field label="Mesečni anuitet">
                <input style={inp} type="number" placeholder="5009.18" value={form.monthly_annuity} onChange={e => set('monthly_annuity', e.target.value)} />
              </Field>
            )}
            {!revolving && (
              <Field label="Kamatna stopa (%)">
                <input style={inp} type="number" step="0.01" placeholder="5.5" value={form.interest_rate} onChange={e => set('interest_rate', e.target.value)} />
              </Field>
            )}
            {!revolving && (
              <Field label="Vrsta kamatne stope">
                <select style={inp} value={form.rate_type} onChange={e => set('rate_type', e.target.value as any)}>
                  <option value="fixed">Fiksna</option>
                  <option value="variable">Promenljiva</option>
                </select>
              </Field>
            )}
            {!revolving && (
              <div style={{ gridColumn: '1 / -1' }}>
                <Field label="Opis kamatne stope">
                  <input style={inp} placeholder="npr. 3,85% + 3M EURIBOR" value={form.rate_description} onChange={e => set('rate_description', e.target.value)} />
                </Field>
              </div>
            )}

            {/* A revolving line is quoted as a benchmark plus a margin, and
                the benchmark is not a property of the credit — it resets. So
                only the margin is asked for here; the benchmark is entered
                against a date, on the line itself, and can be entered again
                every time it moves. */}
            {revolving && (
              <Field label="Referentna stopa">
                <input style={inp} placeholder="3M EURIBOR" value={form.reference_rate_name} onChange={e => set('reference_rate_name', e.target.value)} />
              </Field>
            )}
            {revolving && (
              <Field label="Marža iznad nje (%)">
                <input style={inp} placeholder="2.95" value={form.rate_margin} onChange={e => set('rate_margin', e.target.value)} />
              </Field>
            )}

            <Field label={revolving ? 'Datum povlačenja' : 'Datum isplate kredita'}>
              <input style={inp} type="date" value={form.disbursement_date}
                onChange={e => {
                  set('disbursement_date', e.target.value)
                  // A revolving line runs a year unless told otherwise, which
                  // is what the bank writes and what the owner will almost
                  // always want — offered, not imposed: the field stays open.
                  if (revolving && e.target.value && !form.maturity_date) {
                    set('maturity_date', defaultMaturity(e.target.value))
                  }
                }} />
            </Field>

            {revolving && (
              <Field label="Dospeće *">
                <input style={inp} type="date" value={form.maturity_date} onChange={e => set('maturity_date', e.target.value)} />
              </Field>
            )}

            {!revolving && (
              <Field label="Broj rata">
                <input style={inp} type="number" placeholder="24" value={form.total_installments} onChange={e => set('total_installments', e.target.value)} />
              </Field>
            )}
            {!revolving && (
              <Field label="Prva rata">
                <input style={inp} type="date" value={form.first_payment_date} onChange={e => set('first_payment_date', e.target.value)} />
              </Field>
            )}
            {!revolving && (
              <Field label="Poslednja rata">
                <input style={inp} type="date" value={form.last_payment_date} onChange={e => set('last_payment_date', e.target.value)} />
              </Field>
            )}
            <div style={{ gridColumn: '1 / -1' }}>
              <Field label="Napomena">
                <textarea style={{ ...inp, height: '72px', resize: 'vertical' as const }} placeholder="Napomena (nije obavezna)…" value={form.notes} onChange={e => set('notes', e.target.value)} />
              </Field>
            </div>
          </div>
        </div>

        {/* Footer */}
        <div style={{ padding: '14px 22px', borderTop: '1px solid rgba(255,255,255,0.06)', background: '#0A1525', display: 'flex', justifyContent: 'flex-end', gap: '10px', flexShrink: 0 }}>
          <button onClick={onClose} style={{ fontFamily: "'Inter',sans-serif", fontSize: '13px', padding: '8px 18px', borderRadius: '8px', border: '1px solid rgba(255,255,255,0.08)', background: 'transparent', color: '#7A9BB8', cursor: 'pointer' }}>Otkaži</button>
          <button onClick={handleSave} disabled={saving} style={{ fontFamily: "'Inter',sans-serif", fontSize: '13px', fontWeight: '600', padding: '8px 20px', borderRadius: '8px', border: 'none', background: '#4EA8FF', color: '#060E1A', cursor: 'pointer', opacity: saving ? 0.6 : 1 }}>
            {saving ? 'Čuvanje…' : editing ? 'Sačuvaj izmene' : 'Sačuvaj kredit'}
          </button>
        </div>
      </div>
    </div>
  )
}

// ─── Edit Interest Dialog ─────────────────────────────────────────────────────
function EditInstallmentDialog({ installment, currency, onClose, onSaved }: {
  installment: Installment
  /** The credit's currency, which the instalment's figures are in. */
  currency: string
  onClose: () => void
  onSaved: () => void
}) {
  const [principal, setPrincipal] = useState(installment.principal_amount.toFixed(2))
  const [interest, setInterest] = useState(installment.interest_amount.toFixed(2))
  const [saving, setSaving] = useState(false)

  const newTotal = (parseFloat(principal) || 0) + (parseFloat(interest) || 0)

  const handleSave = async () => {
    setSaving(true)
    const { ok, message } = await runWrite('Čuvanje rate', supabase.from('credit_installments').update({
      principal_amount: parseFloat(principal) || 0,
      interest_amount: parseFloat(interest) || 0,
      total_amount: newTotal,
      updated_at: new Date().toISOString(),
    }).eq('id', installment.id))
    setSaving(false)
    if (!ok) { window.alert(message); return }
    onSaved()
    onClose()
  }

  return (
    <div style={{ position: 'fixed', inset: 0, background: 'rgba(0,0,0,0.7)', backdropFilter: 'blur(4px)', display: 'flex', alignItems: 'center', justifyContent: 'center', zIndex: 1200 }}
      onClick={e => { if (e.target === e.currentTarget) onClose() }}>
      <div style={{ background: '#0D1B2C', border: '1px solid rgba(255,255,255,0.10)', borderRadius: '14px', width: '400px', padding: '24px', boxShadow: '0 20px 50px rgba(0,0,0,0.6)' }}>
        <div style={{ fontSize: '10px', fontWeight: '600', color: '#4EA8FF', letterSpacing: '0.1em', textTransform: 'uppercase' as const, marginBottom: '4px' }}>Izmena rate</div>
        <div style={{ fontFamily: "'DM Serif Display',Georgia,serif", fontSize: '18px', color: '#E8F1FB', marginBottom: '6px' }}>Rata br. {installment.installment_no}</div>
        <div style={{ fontSize: '12px', color: '#7A9BB8', marginBottom: '20px' }}>Dospeva: {fmtDate(installment.due_date)}</div>

        <div style={{ display: 'flex', flexDirection: 'column' as const, gap: '14px', marginBottom: '20px' }}>
          <div>
            <div style={{ fontSize: '10px', fontWeight: '600', color: 'rgba(255,255,255,0.30)', letterSpacing: '0.1em', textTransform: 'uppercase' as const, marginBottom: '6px' }}>Glavnica ({currency})</div>
            <input
              autoFocus
              type="number" step="0.01"
              value={principal}
              onChange={e => setPrincipal(e.target.value)}
              onKeyDown={e => { if (e.key === 'Escape') onClose() }}
              style={{ width: '100%', boxSizing: 'border-box' as const, fontFamily: "'DM Mono',monospace", fontSize: '18px', padding: '10px 12px', border: '1.5px solid #4EA8FF', borderRadius: '8px', background: '#0A1525', color: '#4EA8FF', outline: 'none' }}
            />
          </div>
          <div>
            <div style={{ fontSize: '10px', fontWeight: '600', color: 'rgba(255,255,255,0.30)', letterSpacing: '0.1em', textTransform: 'uppercase' as const, marginBottom: '6px' }}>Kamata ({currency})</div>
            <input
              type="number" step="0.01"
              value={interest}
              onChange={e => setInterest(e.target.value)}
              onKeyDown={e => { if (e.key === 'Escape') onClose() }}
              style={{ width: '100%', boxSizing: 'border-box' as const, fontFamily: "'DM Mono',monospace", fontSize: '18px', padding: '10px 12px', border: '1.5px solid #F5A623', borderRadius: '8px', background: '#0A1525', color: '#F5A623', outline: 'none' }}
            />
          </div>
        </div>

        <div style={{ background: 'rgba(255,255,255,0.03)', border: '1px solid rgba(255,255,255,0.06)', borderRadius: '8px', padding: '12px 14px', marginBottom: '20px', fontSize: '12px', color: '#7A9BB8', display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
          <span>Novi anuitet</span>
          <span style={{ fontFamily: "'DM Mono',monospace", fontSize: '16px', fontWeight: '600', color: '#E8F1FB' }}>{fmtIn(newTotal, currency)}</span>
        </div>

        <div style={{ display: 'flex', gap: '10px', justifyContent: 'flex-end' }}>
          <button onClick={onClose} style={{ fontFamily: "'Inter',sans-serif", fontSize: '13px', padding: '8px 16px', borderRadius: '8px', border: '1px solid rgba(255,255,255,0.08)', background: 'transparent', color: '#7A9BB8', cursor: 'pointer' }}>Otkaži</button>
          <button onClick={handleSave} disabled={saving} style={{ fontFamily: "'Inter',sans-serif", fontSize: '13px', fontWeight: '600', padding: '8px 18px', borderRadius: '8px', border: 'none', background: '#4EA8FF', color: '#060E1A', cursor: 'pointer', opacity: saving ? 0.6 : 1 }}>
            {saving ? 'Čuvanje…' : 'Sačuvaj'}
          </button>
        </div>
      </div>
    </div>
  )
}

// ─── Credit Row (expandable) ──────────────────────────────────────────────────
export function CreditRow({ credit, installments, onRefresh, onEdit }: {
  credit: Credit
  /** Open the credit itself for correction. */
  onEdit: () => void
  /**
   * This credit's instalments, fetched by the page rather than by the row.
   *
   * They used to be fetched here, on expand, which meant the figures in the
   * collapsed row — outstanding, next payment, how many are paid — were all
   * zero until somebody opened it. The page said one thing shut and another
   * open, and only the second was true.
   */
  installments: Installment[]
  onRefresh: () => void
}) {
  const [expanded, setExpanded] = useState(false)
  const [editingInst, setEditingInst] = useState<Installment | null>(null)
  const [filter, setFilter] = useState<'all' | 'outstanding' | 'paid'>('outstanding')

  const handleExpand = () => setExpanded(e => !e)

  const outstanding = installments.filter(i => i.status === 'outstanding')
  const paid = installments.filter(i => i.status === 'paid')
  const outstandingTotal = outstanding.reduce((s, i) => s + i.total_amount, 0)
  const outstandingPrincipal = outstanding.reduce((s, i) => s + i.principal_amount, 0)
  const nextDue = outstanding.sort((a, b) => a.due_date.localeCompare(b.due_date))[0]

  const filteredInst = filter === 'all' ? installments : installments.filter(i => i.status === filter)

  const isVariable = credit.rate_type === 'variable'
  const accentColor = isVariable ? '#F5A623' : '#4EA8FF'

  return (
    <>
      {/* Main credit row */}
      <div
        onClick={handleExpand}
        style={{
          background: expanded ? '#101F32' : '#0D1B2C',
          border: `1px solid ${expanded ? 'rgba(255,255,255,0.10)' : 'rgba(255,255,255,0.06)'}`,
          borderLeft: `3px solid ${accentColor}`,
          borderRadius: expanded ? '12px 12px 0 0' : '12px',
          padding: '18px 20px',
          cursor: 'pointer',
          transition: 'all 0.18s',
          marginBottom: expanded ? '0' : '8px',
        }}
      >
        <div style={{ display: 'flex', alignItems: 'center', gap: '16px' }}>
          {/* Expand toggle */}
          <div style={{ color: accentColor, fontSize: '12px', width: '16px', flexShrink: 0, opacity: 0.7 }}>
            {expanded ? '▼' : '▶'}
          </div>

          {/* Name + bank */}
          <div style={{ flex: 1, minWidth: 0 }}>
            <div style={{ fontFamily: "'DM Serif Display',Georgia,serif", fontSize: '16px', color: '#E8F1FB', fontWeight: '400', letterSpacing: '-0.01em', marginBottom: '3px' }}>
              {credit.name}
            </div>
            <div style={{ fontSize: '12px', color: '#7A9BB8' }}>
              {credit.bank}
              <span style={{ marginLeft: '10px', fontSize: '10px', fontWeight: '600', padding: '1px 7px', borderRadius: '20px', background: isVariable ? 'rgba(245,166,35,0.12)' : 'rgba(78,168,255,0.12)', color: accentColor, letterSpacing: '0.02em' }}>
                {isVariable ? 'PROM' : 'FIKS'}
              </span>
              <span style={{ marginLeft: '8px', color: 'rgba(255,255,255,0.30)' }}>·</span>
              <span style={{ marginLeft: '8px', color: 'rgba(255,255,255,0.40)', fontSize: '12px' }}>{credit.rate_description}</span>
            </div>
          </div>

          {/* Remaining principal */}
          <div style={{ textAlign: 'right', minWidth: '130px' }}>
            <div style={{ fontSize: '10px', fontWeight: '600', color: 'rgba(255,255,255,0.28)', letterSpacing: '0.1em', textTransform: 'uppercase' as const, marginBottom: '4px' }}>Preostala glavnica</div>
            <div style={{ fontFamily: "'DM Mono',monospace", fontSize: '16px', fontWeight: '500', color: accentColor }}>
              {fmtInCompact(outstandingPrincipal || credit.principal_amount, credit.currency)}
            </div>
          </div>

          {/* Outstanding total */}
          <div style={{ textAlign: 'right', minWidth: '130px' }}>
            <div style={{ fontSize: '10px', fontWeight: '600', color: 'rgba(255,255,255,0.28)', letterSpacing: '0.1em', textTransform: 'uppercase' as const, marginBottom: '4px' }}>Ukupno preostalo</div>
            <div style={{ fontFamily: "'DM Mono',monospace", fontSize: '16px', fontWeight: '500', color: '#E8F1FB' }}>
              {fmtInCompact(outstandingTotal, credit.currency)}
            </div>
          </div>

          {/* Next due */}
          <div style={{ textAlign: 'right', minWidth: '120px' }}>
            <div style={{ fontSize: '10px', fontWeight: '600', color: 'rgba(255,255,255,0.28)', letterSpacing: '0.1em', textTransform: 'uppercase' as const, marginBottom: '4px' }}>Sledeća rata</div>
            {nextDue ? (
              <div>
                <div style={{ fontSize: '13px', color: isOverdue(nextDue.due_date) ? '#FF5B5A' : '#DCE9F6', fontWeight: isOverdue(nextDue.due_date) ? '600' : '400' }}>
                  {fmtDate(nextDue.due_date)}
                </div>
                {nextDue.paid_amount && nextDue.paid_amount > 0 ? (
                  <span style={{ fontSize: '10px', color: '#F5A623', background: 'rgba(245,166,35,0.12)', padding: '1px 6px', borderRadius: '20px', fontWeight: '600' }}>
                    Delimično — plaćeno {fmtMoney(nextDue.paid_amount, credit.currency)}
                  </span>
                ) : isOverdue(nextDue.due_date) ? (
                  <span style={{ fontSize: '10px', color: '#FF5B5A', background: 'rgba(255,91,90,0.12)', padding: '1px 6px', borderRadius: '20px', fontWeight: '600' }}>
                    kasni {countOf(Math.abs(daysUntil(nextDue.due_date)), 'dan', 'dana', 'dana')}
                  </span>
                ) : null}
              </div>
            ) : (
              <div style={{ fontSize: '12px', color: '#00D47E' }}>Plaćeno ✓</div>
            )}
          </div>

          {/* Stats */}
          <div style={{ textAlign: 'right', minWidth: '80px' }}>
            <div style={{ fontSize: '10px', fontWeight: '600', color: 'rgba(255,255,255,0.28)', letterSpacing: '0.1em', textTransform: 'uppercase' as const, marginBottom: '4px' }}>Rate</div>
            <div style={{ fontSize: '12px', color: '#7A9BB8' }}>
              <span style={{ color: '#00D47E', fontWeight: '600' }}>{paid.length}</span> / {installments.length > 0 ? installments.length : credit.total_installments}
            </div>
          </div>
        </div>
      </div>

      {/* Expanded installments */}
      {expanded && (
        <div style={{ background: '#080F1A', border: '1px solid rgba(255,255,255,0.06)', borderTop: 'none', borderRadius: '0 0 12px 12px', marginBottom: '8px', overflow: 'hidden' }}>
          {/* Installments toolbar */}
          <div style={{ padding: '12px 20px', borderBottom: '1px solid rgba(255,255,255,0.05)', display: 'flex', alignItems: 'center', gap: '10px', background: '#0A1525' }}>
            <div style={{ fontSize: '11px', color: 'rgba(255,255,255,0.30)', marginRight: '4px' }}>Prikaži:</div>
            {(['outstanding', 'paid', 'all'] as const).map(f => (
              <button key={f} onClick={e => { e.stopPropagation(); setFilter(f) }}
                style={{ fontFamily: "'Inter',sans-serif", fontSize: '11px', fontWeight: '500', padding: '4px 12px', borderRadius: '20px', border: '1px solid', cursor: 'pointer', background: filter === f ? (f === 'outstanding' ? 'rgba(255,91,90,0.12)' : f === 'paid' ? 'rgba(0,212,126,0.12)' : 'rgba(255,255,255,0.08)') : 'transparent', color: filter === f ? (f === 'outstanding' ? '#FF5B5A' : f === 'paid' ? '#00D47E' : '#DCE9F6') : 'rgba(255,255,255,0.30)', borderColor: filter === f ? (f === 'outstanding' ? 'rgba(255,91,90,0.4)' : f === 'paid' ? 'rgba(0,212,126,0.4)' : 'rgba(255,255,255,0.15)') : 'transparent' }}>
                {f === 'outstanding' ? `Neplaćene (${outstanding.length})` : f === 'paid' ? `Plaćene (${paid.length})` : 'Sve'}
              </button>
            ))}
            {/* TWO edits, a row apart, so each has to say what it changes.
                ✎ on an instalment moves one month's principal and interest;
                this one is the loan — its rate, its annuity, its dates. */}
            <div style={{ marginLeft: 'auto', display: 'flex', alignItems: 'center', gap: '10px' }}>
              <span style={{ fontSize: '11px', color: 'rgba(255,255,255,0.28)' }}>
                ✎ u redu menja samo jednu ratu
              </span>
              <button onClick={e => { e.stopPropagation(); onEdit() }}
                title="Izmeni sam kredit — kamatnu stopu, anuitet, datume"
                style={{ fontFamily: "'Inter',sans-serif", fontSize: '11px', fontWeight: '600', padding: '4px 12px', borderRadius: '8px', border: '1px solid rgba(78,168,255,0.35)', background: 'rgba(78,168,255,0.10)', color: '#4EA8FF', cursor: 'pointer' }}>
                Izmeni kredit
              </button>
            </div>
          </div>

          {/* Table. No loading state: the instalments arrived with the page,
              so opening a row has nothing to wait for. */}
          {(
            <table style={{ width: '100%', borderCollapse: 'collapse' }}>
              <thead>
                <tr style={{ background: '#0A1525' }}>
                  {['#', 'Datum dospeća', 'Glavnica', 'Kamata', 'Anuitet', 'Status', ''].map(h => (
                    <th key={h} style={{ padding: '9px 16px', fontSize: '10px', fontWeight: '600', color: 'rgba(255,255,255,0.25)', textTransform: 'uppercase', letterSpacing: '0.08em', textAlign: h === 'Glavnica' || h === 'Kamata' || h === 'Anuitet' ? 'right' : 'left', borderBottom: '1px solid rgba(255,255,255,0.06)', whiteSpace: 'nowrap' }}>
                      {h}
                    </th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {filteredInst.map((inst, idx) => {
                  const overdue = inst.status === 'outstanding' && isOverdue(inst.due_date)
                  return (
                    <tr key={inst.id} style={{ borderBottom: '0.5px solid rgba(255,255,255,0.03)', background: idx % 2 === 0 ? 'transparent' : 'rgba(255,255,255,0.01)' }}>
                      <td style={{ padding: '9px 16px', fontSize: '12px', color: 'rgba(255,255,255,0.35)', fontFamily: "'DM Mono',monospace" }}>{inst.installment_no}</td>
                      <td style={{ padding: '9px 16px', fontSize: '12px', color: overdue ? '#FF5B5A' : '#DCE9F6', fontWeight: overdue ? '600' : '400' }}>
                        {fmtDate(inst.due_date)}
                        {overdue && <span style={{ marginLeft: '6px', fontSize: '10px', color: '#FF5B5A', background: 'rgba(255,91,90,0.12)', padding: '1px 5px', borderRadius: '10px' }}>u kašnjenju</span>}
                      </td>
                      <td style={{ padding: '9px 16px', textAlign: 'right', fontFamily: "'DM Mono',monospace", fontSize: '12px', color: inst.principal_amount > 0 ? '#4EA8FF' : 'rgba(255,255,255,0.20)' }}>
                        {inst.principal_amount > 0 ? fmtNum(inst.principal_amount) : '—'}
                      </td>
                      <td style={{ padding: '9px 16px', textAlign: 'right', fontFamily: "'DM Mono',monospace", fontSize: '12px', color: '#F5A623' }}>
                        {fmtNum(inst.interest_amount)}
                      </td>
                      <td style={{ padding: '9px 16px', textAlign: 'right', fontFamily: "'DM Mono',monospace", fontSize: '13px', fontWeight: '500', color: '#E8F1FB' }}>
                        {fmtNum(inst.total_amount)}
                      </td>
                      <td style={{ padding: '9px 16px' }}>
                        {(() => {
                          const isPartial = inst.status === 'outstanding' && inst.paid_amount && inst.paid_amount > 0
                          const paidPct = isPartial ? Math.min(100, (inst.paid_amount! / inst.total_amount) * 100) : 0
                          return (
                            <div>
                              <span style={{ fontSize: '10px', fontWeight: '600', padding: '2px 8px', borderRadius: '20px',
                                background: inst.status === 'paid' ? 'rgba(0,212,126,0.12)' : isPartial ? 'rgba(245,166,35,0.12)' : overdue ? 'rgba(255,91,90,0.12)' : 'rgba(255,255,255,0.06)',
                                color: inst.status === 'paid' ? '#00D47E' : isPartial ? '#F5A623' : overdue ? '#FF5B5A' : '#7A9BB8' }}>
                                {inst.status === 'paid' ? 'Plaćeno' : isPartial ? 'Delimično' : overdue ? 'U kašnjenju' : 'Neplaćeno'}
                              </span>
                              {isPartial && (
                                <div style={{ marginTop: '4px', width: '90px' }}>
                                  <div style={{ height: '3px', background: 'rgba(255,255,255,0.08)', borderRadius: '2px', overflow: 'hidden' }}>
                                    <div style={{ height: '100%', width: `${paidPct}%`, background: '#F5A623', borderRadius: '2px' }} />
                                  </div>
                                  <div style={{ fontSize: '9px', color: '#F5A623', marginTop: '2px', fontFamily: "'DM Mono',monospace" }}>
                                    {fmtMoney(inst.paid_amount!, credit.currency)} / {fmtMoney(inst.total_amount, credit.currency)}
                                  </div>
                                </div>
                              )}
                            </div>
                          )
                        })()}
                      </td>
                      <td style={{ padding: '9px 16px', textAlign: 'right' }}>
                        {inst.status === 'outstanding' && (
                          <button
                            onClick={e => { e.stopPropagation(); setEditingInst(inst) }}
                            style={{ fontFamily: "'Inter',sans-serif", fontSize: '11px', fontWeight: '500', padding: '4px 10px', borderRadius: '6px', border: '1px solid rgba(78,168,255,0.3)', background: 'rgba(78,168,255,0.06)', color: '#4EA8FF', cursor: 'pointer' }}>
                            ✎ Izmeni
                          </button>
                        )}
                      </td>
                    </tr>
                  )
                })}
              </tbody>
              {filteredInst.length > 0 && (
                <tfoot>
                  <tr style={{ background: '#060E1A', borderTop: '1px solid rgba(255,255,255,0.08)' }}>
                    <td colSpan={2} style={{ padding: '10px 16px', fontSize: '10px', fontWeight: '700', color: 'rgba(255,255,255,0.30)', textTransform: 'uppercase', letterSpacing: '0.08em' }}>
                      Ukupno ({countOf(filteredInst.length, 'rata', 'rate', 'rata')}, {credit.currency})
                    </td>
                    <td style={{ padding: '10px 16px', textAlign: 'right', fontFamily: "'DM Mono',monospace", fontSize: '13px', fontWeight: '600', color: '#4EA8FF' }}>
                      {fmtNum(filteredInst.reduce((s, i) => s + i.principal_amount, 0))}
                    </td>
                    <td style={{ padding: '10px 16px', textAlign: 'right', fontFamily: "'DM Mono',monospace", fontSize: '13px', fontWeight: '600', color: '#F5A623' }}>
                      {fmtNum(filteredInst.reduce((s, i) => s + i.interest_amount, 0))}
                    </td>
                    <td style={{ padding: '10px 16px', textAlign: 'right', fontFamily: "'DM Mono',monospace", fontSize: '14px', fontWeight: '700', color: '#E8F1FB' }}>
                      {fmtNum(filteredInst.reduce((s, i) => s + i.total_amount, 0))}
                    </td>
                    <td colSpan={2} />
                  </tr>
                </tfoot>
              )}
            </table>
          )}
        </div>
      )}

      {editingInst && (
        <EditInstallmentDialog
          installment={editingInst}
          currency={credit.currency}
          onClose={() => setEditingInst(null)}
          // The page owns the data now, so a saved instalment reloads the
          // page's copy — which also keeps the totals and the charts above in
          // step with the row that just changed. Refetching only this credit
          // would leave both of them stale.
          onSaved={() => { setEditingInst(null); onRefresh() }}
        />
      )}
    </>
  )
}

// ─── Main page ────────────────────────────────────────────────────────────────
export default function Credits() {
  const { defaultCompany } = useCompanies()
  const { versions } = useDataRefresh()
  const { currency: shown } = useDisplayCurrency()

  /**
   * Today's NBS rates, for the overview only.
   *
   * The overview and the charts add credits together, and credits are in
   * different currencies — an indexed loan in EUR, a dinar loan in RSD. They
   * are added in the display currency, each credit's figures converted at
   * today's rate with the same book-amount rule every document uses. A future
   * instalment has no rate yet; today's is the honest stand-in, and it is
   * named under the figures. Without a rate, a credit that would need one is
   * left out of the totals and counted, never added at a guess.
   */
  const [rates, setRates] = useState<BookRates | null>(null)
  useEffect(() => {
    let cancelled = false
    getBookRates(new Date().toISOString().slice(0, 10))
      .then(r => { if (!cancelled) setRates(r) })
      .catch(() => { if (!cancelled) setRates(null) })
    return () => { cancelled = true }
  }, [])

  const [credits, setCredits] = useState<Credit[]>([])
  const [loading, setLoading] = useState(true)
  const [showNewDialog, setShowNewDialog] = useState(false)
  /** The credit being corrected, if any. The same dialog adds and corrects. */
  const [editing, setEditing] = useState<Credit | null>(null)
  const [statusFilter, setStatusFilter] = useState<'active' | 'all'>('active')
  /**
   * Which kind of credit the list below shows.
   *
   * Annuity first, because that is the book — eleven loans against four
   * tranches — and because a page that opens on the smaller half reads as
   * though the smaller half is the story. Both are in the totals above
   * whichever is open: the split is about how much is on screen at once, not
   * about what is owed.
   */
  const [kindTab, setKindTab] = useState<'annuity' | 'revolving'>('annuity')
  /** The outstanding annuity instalments themselves, for the charts. */
  const [annuityDue, setAnnuityDue] = useState<(DueInstalment & { currency: string })[]>([])
  /** Every instalment on the books, fetched once and handed down by credit. */
  const [instalments, setInstalments] = useState<Installment[]>([])
  const [perCreditSums, setPerCreditSums] = useState<Record<string, { principal: number; interest: number }>>({})

  // Aggregate stats from DB
  const [stats, setStats] = useState({ overdueCount: 0, nextDueDate: '' })

  /**
   * The benchmark history, which is what prices the revolving lines.
   *
   * Held on the page rather than only inside the section, because the totals
   * at the top have to say how much is owed — and a revolving line with no
   * benchmark recorded owes a principal and an unknown amount of interest,
   * which is a thing the headline must be able to express.
   */
  const [resets, setResets] = useState<Record<string, { effective_from: string; reference_rate: number }[]>>({})

  const load = useCallback(async () => {
    setLoading(true)
    const { data } = await supabase.from('credits').select('*').order('first_payment_date')
    const all = (data || []) as Credit[]
    setCredits(all)

    const revolvingIds = all.filter(c => c.kind === 'revolving').map(c => c.id)
    const annuityIds = all.filter(c => c.kind !== 'revolving').map(c => c.id)

    // ── Instalments, ANNUITY ONLY ──────────────────────────────────────
    //
    // Generating a revolving schedule writes instalments too, and counting
    // those here as well as counting the tranches below would double the
    // obligation the moment somebody pressed the button. So the instalment
    // sum is the annuity half and the revolving half is computed from the
    // tranches — which also means pressing Generate does not change what the
    // page says is owed, and it should not: a forecast being written down is
    // not a new debt.
    // ── EVERY INSTALMENT, ONCE ─────────────────────────────────────────
    //
    // Each row used to fetch its own on expand, which meant a credit showed
    // nothing about itself — no outstanding figure, no next payment, no
    // progress — until it was opened. The page looked loaded and was not, and
    // the only way to read the book was to click through it.
    //
    // So the page fetches the lot on arrival and hands each row its own. One
    // request instead of one per credit, the collapsed rows carry real
    // figures, and expanding is instant because there is nothing left to wait
    // for.
    //
    // Paged, because PostgREST stops at 1000 rows and says nothing: eleven
    // amortising loans and four revolving schedules pass that without anybody
    // noticing, and the total would simply stop rising.
    const allInst = await fetchAllPages<Installment>((from, to) =>
      supabase.from('credit_installments').select('*')
        // `id` last, and not decoration: paging with .range() is only correct
        // against a sort that is unique. Two instalments sharing a number on
        // one credit — which a regenerated schedule can produce — would put a
        // row on two pages or on none.
        .order('credit_id').order('installment_no').order('id').range(from, to))
    setInstalments(allInst)

    const annuitySet = new Set(annuityIds)
    const currencyOf = new Map(all.map(c => [c.id, (c.currency || 'RSD').toUpperCase()]))
    const instData = allInst.filter(i =>
      i.status === 'outstanding' && annuitySet.has(i.credit_id))
    setAnnuityDue(instData.map(i => ({
      due_date: i.due_date,
      principal_amount: i.principal_amount || 0,
      interest_amount: i.interest_amount || 0,
      currency: currencyOf.get(i.credit_id) || 'RSD',
    })))

    // What each loan still owes, for the By credit panel. Summed here from the
    // rows already fetched rather than by a second grouped query: the same
    // rows, so the bars and the totals above them cannot disagree.
    const sums: Record<string, { principal: number; interest: number }> = {}
    for (const i of instData) {
      const at = (sums[i.credit_id] ||= { principal: 0, interest: 0 })
      at.principal += i.principal_amount || 0
      at.interest += i.interest_amount || 0
    }
    setPerCreditSums(sums)

    if (revolvingIds.length > 0) {
      const { data: resetRows } = await db
        .from('credit_rate_resets')
        .select('credit_id, effective_from, reference_rate')
        .in('credit_id', revolvingIds)
        .order('effective_from')
      const by: Record<string, { effective_from: string; reference_rate: number }[]> = {}
      for (const r of (resetRows || []) as any[]) {
        ;(by[r.credit_id] ||= []).push({
          effective_from: r.effective_from, reference_rate: Number(r.reference_rate),
        })
      }
      setResets(by)
    } else {
      setResets({})
    }

    {
      const today = new Date().toISOString().split('T')[0]
      // The EARLIEST still to come, worked out rather than taken as the first
      // row found — see `earliestDue`, which is where the reason lives and
      // where it is tested. The amounts are summed at render time, in the
      // display currency: see `inShown`.
      setStats({
        overdueCount: overdueCount(instData, today),
        nextDueDate: earliestDue(instData, today),
      })
    }
    setLoading(false)
  }, [])

  useEffect(() => { load() }, [load])

  // Refetch + remount CreditRows when data invalidated from another page
  useEffect(() => {
    // A reload is enough now. The rows used to be remounted with it, because
    // each held its own copy of the data and nothing else would replace it —
    // which also threw away whichever row the reader had open.
    if (versions.credits > 0) load()
  }, [versions.credits, load]) // eslint-disable-line

  const visible = statusFilter === 'active' ? credits.filter(c => c.status === 'active') : credits
  /** The Bank Credits list is the annuity loans, exactly as it was. */
  const filtered = visible.filter(c => c.kind !== 'revolving')
  const revolving = visible.filter(c => c.kind === 'revolving') as unknown as RevolvingCredit[]

  /**
   * What is owed in total: the annuity instalments still outstanding, plus the
   * revolving tranches' principal and the interest still to run on them.
   *
   * `interest` comes back null when any tranche is unpriced, and that null is
   * carried into the headline rather than dropped. A 50.000 EUR line whose cost
   * is not known yet must not be added in as if it were free — the figure
   * shown is then "at least this much", and the card says so.
   */
  const rev = summarise(revolving, resets)

  /**
   * A credit's figure in the display currency, at today's NBS rate; the figure
   * itself when the credit is already in it. Null when it needs a rate there
   * is none of — and that credit is then left out of the overview, counted.
   */
  const inShown = (amount: number, currency: string): number | null => {
    const c = (currency || 'RSD').toUpperCase()
    if (c === shown) return amount
    if (!rates) return null
    try {
      const b = bookAmounts(amount, c, rates)
      return shown === 'RSD' ? b.amount_rsd : b.amount_eur
    } catch {
      return null
    }
  }
  /** Credits the overview could not convert, by id. */
  const unconverted = new Set<string>()
  const creditCurrency = (id: string) => (credits.find(c => c.id === id)?.currency || 'RSD')
  const conv = (id: string, amount: number): number | null => {
    const v = inShown(amount, creditCurrency(id))
    if (v === null) unconverted.add(id)
    return v
  }

  const annuityShown: DueInstalment[] = annuityDue.flatMap(i => {
    const p = inShown(i.principal_amount, i.currency)
    const q = inShown(i.interest_amount, i.currency)
    return p === null || q === null ? [] : [{ due_date: i.due_date, principal_amount: p, interest_amount: q }]
  })

  /**
   * The revolving half of the charts, DERIVED rather than read back.
   *
   * Its instalments may never have been generated, and counting the generated
   * ones as well as the tranches they came from would double the debt the
   * moment somebody pressed the button. So the schedule is computed here from
   * the same function the section uses, and the annuity half — which is what
   * the bank actually scheduled — is read from the table.
   */
  const thisMonth = new Date().toISOString().slice(0, 7)
  const revolvingDue: DueInstalment[] = revolving.flatMap(c => {
    const rows = revolvingSchedule({
      principal: c.principal_amount,
      margin: c.rate_margin,
      resets: resets[c.id] || [],
      fromMonth: thisMonth,
      maturity: c.maturity_date || '',
      billingDay: Number((c.disbursement_date || '').slice(8, 10)) || undefined,
    })
    return rows.flatMap(r => {
      const p = conv(c.id, r.principal_amount)
      const q = conv(c.id, r.interest_amount)
      return p === null || q === null ? [] : [{ due_date: r.due_date, principal_amount: p, interest_amount: q }]
    })
  })

  /**
   * A revolving line with no rate still owes its principal on its maturity
   * date, and the balance chart has to show that cliff. Without this the
   * unpriced tranches would sit flat for ever and the chart would say the
   * money never has to be found.
   */
  const revolvingUnpricedDue: DueInstalment[] = revolving
    .filter(c => revolvingSchedule({
      principal: c.principal_amount, margin: c.rate_margin,
      resets: resets[c.id] || [], fromMonth: thisMonth,
      maturity: c.maturity_date || '',
    }).length === 0 && !!c.maturity_date)
    .flatMap(c => {
      const p = conv(c.id, c.principal_amount)
      return p === null ? [] : [{ due_date: c.maturity_date as string, principal_amount: p, interest_amount: 0 }]
    })

  const annuityPerCredit = perCreditSums
  // Each credit in the display currency; a credit that cannot be converted is
  // left out here and counted in `unconverted`.
  const perCredit = [
    ...filtered.flatMap(c => {
      const p = conv(c.id, annuityPerCredit[c.id]?.principal || 0)
      const q = conv(c.id, annuityPerCredit[c.id]?.interest || 0)
      return p === null || q === null ? [] : [{
        creditId: c.id, name: c.name, kind: 'annuity' as const, principal: p, interest: q as number | null,
      }]
    }),
    ...revolving.flatMap(c => {
      const one = summarise([c], { [c.id]: resets[c.id] || [] })
      const p = conv(c.id, one.principal)
      const q = one.interest === null ? null : conv(c.id, one.interest)
      return p === null || (one.interest !== null && q === null) ? [] : [{
        creditId: c.id, name: c.name, kind: 'revolving' as const, principal: p, interest: q,
      }]
    }),
  ]

  // The overview, from the converted per-credit figures — the same figures
  // the By credit bars are drawn from, so the two cannot disagree. The
  // annuity side counts every annuity credit with an outstanding schedule,
  // whichever filter is open, as it always has.
  const annuityTotals = Object.entries(annuityPerCredit).reduce((t, [id, s]) => {
    const p = conv(id, s.principal)
    const q = conv(id, s.interest)
    if (p === null || q === null) return t
    return { principal: t.principal + p, interest: t.interest + q }
  }, { principal: 0, interest: 0 })
  const revolvingTotals = perCredit.filter(c => c.kind === 'revolving')
    .reduce((t, c) => ({ principal: t.principal + c.principal, interest: t.interest + (c.interest ?? 0) }),
      { principal: 0, interest: 0 })
  const totalPrincipal = annuityTotals.principal + revolvingTotals.principal
  const totalObligation = annuityTotals.principal + annuityTotals.interest
    + revolvingTotals.principal + revolvingTotals.interest
  const unconvertedNote = unconverted.size > 0
    ? `${countOf(unconverted.size, 'kredit', 'kredita', 'kredita')} van ${shown} ${plural(unconverted.size, 'nije uračunat', 'nisu uračunata', 'nije uračunato')} — danas nema kursa NBS`
    : null

  // The background lives in `.app-surface`: an inline colour would paint
  // straight over it.
  return (
    <div className="app-surface"
      style={{ padding: '28px 32px', fontFamily: "'Inter', system-ui, sans-serif", minHeight: '100vh', color: '#DCE9F6' }}>

      {/* ── Header ── */}
      <div style={{ display: 'flex', alignItems: 'flex-end', justifyContent: 'space-between', marginBottom: '28px', gap: '24px' }}>
        <div>
          <div style={{ fontFamily: "'DM Serif Display', Georgia, serif", fontSize: '28px', fontWeight: '400', color: '#E8F1FB', marginBottom: '5px', letterSpacing: '-0.01em' }}>
            Krediti
          </div>
          <div style={{ fontSize: '13px', color: '#7A9BB8' }}>
            Anuitetni i revolving{defaultCompany ? ` · ${defaultCompany.name}` : ''}
          </div>
        </div>
        <button
          onClick={() => setShowNewDialog(true)}
          style={{ fontFamily: "'Inter',sans-serif", fontSize: '13px', fontWeight: '600', padding: '9px 18px', border: 'none', borderRadius: '9px', background: '#4EA8FF', color: '#060E1A', cursor: 'pointer', display: 'flex', alignItems: 'center', gap: '7px' }}>
          + Novi kredit
        </button>
      </div>

      {/* ── KPI strip ── */}
      <div style={{ fontSize: '10px', fontWeight: '600', color: 'rgba(255,255,255,0.22)', letterSpacing: '0.12em', textTransform: 'uppercase', marginBottom: '10px' }}>
        Pregled
      </div>
      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(4,1fr)', gap: '10px', marginBottom: '28px' }}>
        {[
          { label: 'Aktivni krediti', value: loading ? '—' : String(credits.filter(c => c.status === 'active').length), accent: '#4EA8FF', sub: `${filtered.length} ${plural(filtered.length, 'anuitetni', 'anuitetna', 'anuitetnih')} · ${revolving.length} revolving` },
          { label: 'Preostala glavnica', value: loading ? '—' : fmtMoneyCompact(totalPrincipal, shown), accent: '#4EA8FF', sub: unconvertedNote || `anuitetni + revolving, u ${shown} po današnjem kursu NBS` },
          {
            label: 'Ukupna obaveza',
            value: loading ? '—' : (rev.unpriced > 0 || unconverted.size > 0 ? '≥ ' : '') + fmtMoneyCompact(totalObligation, shown),
            accent: '#F5A623',
            sub: rev.unpriced > 0
              ? `${countOf(rev.unpriced, 'revolving kredit', 'revolving kredita', 'revolving kredita')} još bez kamatne stope`
              : 'glavnica + kamata, obe vrste',
          },
          { label: stats.overdueCount > 0 ? 'Rate u kašnjenju' : 'Sledeća rata', value: loading ? '—' : stats.overdueCount > 0 ? String(stats.overdueCount) : fmtDate(stats.nextDueDate), accent: stats.overdueCount > 0 ? '#FF5B5A' : '#00D47E', sub: stats.overdueCount > 0 ? 'zahtevaju pažnju' : 'datum dospeća' },
        ].map(k => (
          <div key={k.label} style={{ background: '#0D1B2C', border: '1px solid rgba(255,255,255,0.06)', borderTop: `2.5px solid ${k.accent}`, borderRadius: '12px', padding: '18px 20px' }}>
            <div style={{ fontSize: '10px', fontWeight: '600', color: 'rgba(255,255,255,0.28)', textTransform: 'uppercase', letterSpacing: '0.11em', marginBottom: '10px' }}>{k.label}</div>
            <div style={{ fontFamily: "'DM Mono','Fira Mono',monospace", fontSize: '24px', fontWeight: '500', color: k.accent, letterSpacing: '-0.02em', lineHeight: 1 }}>{k.value}</div>
            <div style={{ fontSize: '11px', color: 'rgba(255,255,255,0.25)', marginTop: '8px' }}>{k.sub}</div>
          </div>
        ))}
      </div>

      {/* Both kinds on one axis, whichever list is open below. The debt is
          the debt: splitting the charts by the tab would answer "what do my
          annuity loans cost" instead of "what do I owe". */}
      {!loading && (
        <DebtPanels
          annuity={annuityShown}
          revolving={[...revolvingDue, ...revolvingUnpricedDue]}
          opening={{ annuity: annuityTotals.principal, revolving: revolvingTotals.principal }}
          currency={shown}
          credits={perCredit}
          unpriced={rev.unpriced}
        />
      )}

      {/* ── Which half is on screen ── */}
      <div style={{ display: 'flex', alignItems: 'center', gap: '8px', marginTop: '26px', marginBottom: '16px', flexWrap: 'wrap' }}>
        {([
          ['annuity', 'Anuitetni', filtered.length, '#4EA8FF'],
          ['revolving', 'Revolving', revolving.length, '#8B8BFF'],
        ] as const).map(([k, label, count, colour]) => (
          <button key={k} onClick={() => setKindTab(k)}
            style={{
              fontFamily: "'Inter', sans-serif", fontSize: '12.5px', fontWeight: 600,
              padding: '7px 16px', borderRadius: '9px', cursor: 'pointer',
              border: `1px solid ${kindTab === k ? colour : 'rgba(255,255,255,0.08)'}`,
              background: kindTab === k ? `${colour}1F` : 'transparent',
              color: kindTab === k ? colour : '#7A9BB8',
            }}>
            {label}
            <span style={{ marginLeft: '8px', opacity: 0.7, fontWeight: 400 }}>{count}</span>
          </button>
        ))}
        <div style={{ flex: 1, height: '0.5px', background: 'rgba(255,255,255,0.06)' }} />
        <div style={{ fontSize: '11px', color: 'rgba(255,255,255,0.25)' }}>
          Zbirovi iznad obuhvataju obe vrste, bez obzira na to koja je lista otvorena
        </div>
      </div>

      {/* ── Filter bar ── */}
      <div style={{ display: 'flex', alignItems: 'center', gap: '10px', marginBottom: '16px' }}>
        <div style={{ fontSize: '10px', fontWeight: '600', color: 'rgba(255,255,255,0.22)', letterSpacing: '0.12em', textTransform: 'uppercase' }}>
          {kindTab === 'annuity' ? 'Anuitetni krediti' : 'Revolving krediti'}
        </div>
        <div style={{ flex: 1, height: '0.5px', background: 'rgba(255,255,255,0.06)' }} />
        {(['active', 'all'] as const).map(f => (
          <button key={f} onClick={() => setStatusFilter(f)}
            style={{ fontFamily: "'Inter',sans-serif", fontSize: '11px', fontWeight: '500', padding: '4px 12px', borderRadius: '20px', border: '1px solid', cursor: 'pointer', background: statusFilter === f ? 'rgba(78,168,255,0.12)' : 'transparent', color: statusFilter === f ? '#4EA8FF' : 'rgba(255,255,255,0.30)', borderColor: statusFilter === f ? 'rgba(78,168,255,0.4)' : 'transparent' }}>
            {f === 'active' ? 'Aktivni' : 'Svi'}
          </button>
        ))}
      </div>

      {/* ── Credit list ── */}
      {loading ? (
        <div style={{ minHeight: '300px', padding: '22px 20px', background: '#0D1B2C', borderRadius: '12px', border: '1px solid rgba(255,255,255,0.06)' }}>
          <SkeletonRows rows={5} height={54} gap={14} widths={[100, 100, 100, 100, 100]} />
        </div>
      ) : kindTab === 'revolving' ? (
        revolving.length === 0 ? (
          <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center', minHeight: '220px', color: '#7A9BB8', background: '#0D1B2C', borderRadius: '12px', border: '1px solid rgba(255,255,255,0.06)', gap: '10px' }}>
            <div style={{ fontSize: '28px', opacity: 0.3 }}>🔁</div>
            <div style={{ fontSize: '15px', fontWeight: '500', color: '#DCE9F6' }}>Nema revolving kredita</div>
            <div style={{ fontSize: '13px' }}>Dodajte ga preko „+ Novi kredit“ i izaberite Revolving</div>
          </div>
        ) : (
          <RevolvingCredits credits={revolving} onRefresh={load}
            // The tranche hands back its own narrowed shape, so the full row
            // is looked up again here — the dialog edits every column, and
            // half of them are not on `RevolvingCredit`.
            onEdit={c => setEditing(credits.find(x => x.id === c.id) || null)} />
        )
      ) : filtered.length === 0 ? (
        <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center', minHeight: '300px', color: '#7A9BB8', background: '#0D1B2C', borderRadius: '12px', border: '1px solid rgba(255,255,255,0.06)', gap: '10px' }}>
          <div style={{ fontSize: '28px', opacity: 0.3 }}>🏦</div>
          <div style={{ fontSize: '15px', fontWeight: '500', color: '#DCE9F6' }}>Nema kredita</div>
          <div style={{ fontSize: '13px' }}>Dodajte prvi kredit dugmetom „+ Novi kredit“</div>
        </div>
      ) : (
        <div>
          {filtered.map(credit => (
            <CreditRow key={credit.id} credit={credit}
              installments={instalments.filter(i => i.credit_id === credit.id)}
              onRefresh={load}
              onEdit={() => setEditing(credit)} />
          ))}
        </div>
      )}

      {/* Dialogs */}
      {(showNewDialog || editing) && (
        <CreditDialog
          credit={editing}
          // Whether a schedule exists decides only whether the kind may still
          // be changed. The page already has every instalment, so this is
          // read from what it holds rather than counted again.
          hasSchedule={!!editing && instalments.some(i => i.credit_id === editing.id)}
          onClose={() => { setShowNewDialog(false); setEditing(null) }}
          onSaved={load} />
      )}

      <style>{`@keyframes pulse { 0%,100%{opacity:1} 50%{opacity:.4} }`}</style>
    </div>
  )
}