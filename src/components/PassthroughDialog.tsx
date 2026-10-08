import React, { useState, useEffect } from 'react'
import { supabase } from '../supabase'
import { useCompanies } from '../contexts/CompaniesContext'
import { PostFailure, reportPostFailure, type CompletedWrite } from '../services/writeOrder'
import { getRate, convertToUSD } from '../services/currencyService'
import { DIALOG } from './dialogTheme'
import { fetchAllPartners } from '../services/allPartners'

interface Props {
  onClose: () => void
  passthrough?: any
}

interface ValidationErrors { [key: string]: string }

export default function PassthroughDialog({ onClose, passthrough }: Props) {
  const [step, setStep] = useState(1)
  const [saving, setSaving] = useState(false)
  const [success, setSuccess] = useState(false)
  // A refused write, in the owner's line of sight. The validation errors
  // above are about the form; this is about the database saying no.
  const [saveError, setSaveError] = useState('')
  const [errors, setErrors] = useState<ValidationErrors>({})
  const [touched, setTouched] = useState<Record<string, boolean>>({})
  const [showValidationSummary, setShowValidationSummary] = useState(false)

  const { companies, defaultCompany, showPicker } = useCompanies()
  const [banks, setBanks] = useState<any[]>([])
  const [allBanks, setAllBanks] = useState<any[]>([])
  const [partners, setPartners] = useState<any[]>([])
  const [unpaired, setUnpaired] = useState<any[]>([])

  // Step 1
  const [companyId, setCompanyId] = useState('')

  // One company: it is the company, and nobody is asked to choose it.
  useEffect(() => {
    if (!showPicker && defaultCompany) setCompanyId(prev => prev || defaultCompany.id)
  }, [showPicker, defaultCompany])
  const [bankId, setBankId] = useState('')
  const [currency, setCurrency] = useState('')
  const [txDate, setTxDate] = useState(new Date().toISOString().split('T')[0])
  const [statement, setStatement] = useState('')
  const [partnerId, setPartnerId] = useState('')
  const [partnerSearch, setPartnerSearch] = useState('')
  const [newPartnerName, setNewPartnerName] = useState('')
  const [showNewPartner, setShowNewPartner] = useState(false)
  const [periodMonth, setPeriodMonth] = useState(new Date().toISOString().slice(0, 7))

  // Step 2
  const [direction, setDirection] = useState<'in' | 'out'>('in')
  const [pairId, setPairId] = useState('')
  const [note, setNote] = useState('')

  // Step 3
  const [amount, setAmount] = useState('')
  const [exRate, setExRate] = useState('')
  const [rateSource, setRateSource] = useState('')
  const [rateIsFallback, setRateIsFallback] = useState(false)
  const [fetchingRate, setFetchingRate] = useState(false)

  const usdAmount = (() => {
    const a = parseFloat(amount) || 0
    const r = parseFloat(exRate) || 0
    return convertToUSD(a, currency, r)
  })()

  // ── Validation ─────────────────────────────────────────
  const runValidation = () => {
    const e: ValidationErrors = {}
    if (!companyId) e.companyId = 'Company is required'
    if (!bankId) e.bankId = 'Bank is required'
    if (!currency) e.currency = 'Currency is required'
    if (!txDate) e.txDate = 'Transaction date is required'
    if (!periodMonth) e.periodMonth = 'Period month is required'
    if (!amount || parseFloat(amount) <= 0) e.amount = 'Amount must be greater than 0'
    if (currency && currency !== 'USD' && (!exRate || parseFloat(exRate) <= 0)) e.exRate = 'Exchange rate is required'
    return e
  }

  useEffect(() => { setErrors(runValidation()) }, [companyId, bankId, currency, txDate, periodMonth, amount, exRate]) // eslint-disable-line react-hooks/exhaustive-deps

  useEffect(() => {
    const load = async () => {
      const [{ data: bnk }, part] = await Promise.all([
        supabase.from('banks').select('*').order('name'),
        fetchAllPartners(supabase),
      ])
      if (bnk) setAllBanks(bnk)
      if (part) setPartners(part)
    }
    load()
  }, [])

  useEffect(() => {
    if (companyId) {
      setBanks(allBanks.filter(b => b.company_id === companyId))
      if (!passthrough) { setBankId(''); setCurrency('') }
    }
  }, [companyId, allBanks, passthrough])

  useEffect(() => {
    if (!companyId) return
    const fetchUnpaired = async () => {
      const { data } = await supabase
        .from('passthrough')
        .select('*, partners(name), banks(name)')
        .eq('company_id', companyId)
        .eq('status', 'unpaired')
        .neq('direction', direction)
        .order('transaction_date', { ascending: false })
      if (data) setUnpaired(data)
    }
    fetchUnpaired()
  }, [companyId, direction])

  useEffect(() => {
    if (passthrough) {
      setCompanyId(passthrough.company_id || '')
      setBankId(passthrough.bank_id || '')
      setCurrency(passthrough.currency || '')
      setTxDate(passthrough.transaction_date || '')
      setStatement(passthrough.statement_number || '')
      setPartnerId(passthrough.partner_id || '')
      setPartnerSearch(passthrough.partners?.name || '')
      setDirection(passthrough.direction || 'in')
      setPairId(passthrough.pair_id || '')
      setPeriodMonth(passthrough.period_month || new Date().toISOString().slice(0, 7))
      setNote(passthrough.note || '')
      setAmount(passthrough.amount?.toString() || '')
      setExRate(passthrough.exchange_rate?.toString() || '')
    }
  }, [passthrough])

  const filteredPartners = partners.filter(p =>
    !partnerSearch || p.name.toLowerCase().includes(partnerSearch.toLowerCase())
  )

  const touch = (field: string) => setTouched(prev => ({ ...prev, [field]: true }))
  const fieldErr = (field: string) => touched[field] ? errors[field] : undefined
  const totalErrors = Object.keys(errors).length
  const isValid = totalErrors === 0

  const touchStep = (s: number) => {
    if (s === 1) setTouched(p => ({ ...p, companyId: true, bankId: true, currency: true, txDate: true, periodMonth: true }))
    if (s === 3) setTouched(p => ({ ...p, amount: true, exRate: true }))
  }

  const stepHasError = (n: number) => {
    const stepFields: Record<number, string[]> = {
      1: ['companyId', 'bankId', 'currency', 'txDate', 'periodMonth'],
      3: ['amount', 'exRate'],
    }
    return (stepFields[n] || []).some(f => !!errors[f])
  }

  const fetchRate = async () => {
    if (!currency || currency === 'USD') { setExRate('1'); setRateSource('N/A'); setRateIsFallback(false); return }
    setFetchingRate(true)
    try {
      const rateData = await getRate(currency, txDate, false)
      setExRate(rateData.rate.toString())
      setRateSource(rateData.source)
      setRateIsFallback(rateData.isFallback)
    } catch (err) {
      // Vidi komentar u InvoiceDialog — hardkodovani kursevi su uklonjeni.
      console.error('[PassthroughDialog] getRate neuspesan:', err)
      setExRate('')
      setRateSource('⚠ No official rate — enter it manually')
      setRateIsFallback(true)
    }
    setFetchingRate(false)
  }

  const stepTitles = ['Basic information', 'Direction & pairing', 'Amount & review']

  const selectedPair = unpaired.find(p => p.id === pairId)
  const balanceDiff = selectedPair ? Math.abs((selectedPair.amount_usd || 0) - usdAmount) : null
  const isBalanced = balanceDiff !== null && balanceDiff < 0.01

  const handlePost = async () => {
    setTouched({ companyId: true, bankId: true, currency: true, txDate: true, periodMonth: true, amount: true, exRate: true })
    const e = runValidation()
    if (Object.keys(e).length > 0) { setShowValidationSummary(true); return }

    setSaving(true); setSaveError('')

    // Outside the try so the catch can read it: a refusal partway through
    // has to say what already landed.
    const completed: CompletedWrite[] = []

    try {
      let finalPartnerId = partnerId
      if (showNewPartner && newPartnerName) {
        const { data: newP, error: partErr } = await supabase.from('partners').insert({ name: newPartnerName }).select().single()
        if (partErr) throw new PostFailure('a new partner', partErr.message)
        if (newP) finalPartnerId = newP.id
      }

      const payload = {
        company_id: companyId || null, bank_id: bankId || null, partner_id: finalPartnerId || null,
        direction, pair_id: pairId || null, period_month: periodMonth,
        currency, amount: parseFloat(amount),
        exchange_rate: parseFloat(exRate) || null, amount_usd: usdAmount,
        transaction_date: txDate, statement_number: statement || null,
        note: note || null, pl_impact: false,
        status: pairId ? 'paired' : 'unpaired',
      }

      let ptId: string
      if (passthrough?.id) {
        const { data: updated, error: upErr } = await supabase.from('passthrough')
          .update(payload).eq('id', passthrough.id).select('id')
        if (upErr) throw new PostFailure('the pass-through entry', upErr.message)
        // A zero-row update is a failure, not a save. It means the row is gone,
        // or RLS refused it — either way nothing was written.
        if (!updated || updated.length === 0)
          throw new PostFailure('the pass-through entry', `no row with id ${passthrough.id} was updated`)
        completed.push({ label: 'the pass-through entry' })
        ptId = passthrough.id
      } else {
        const { data: newPt, error: insErr } = await supabase.from('passthrough').insert(payload).select().single()
        if (insErr) throw new PostFailure('the pass-through entry', insErr.message)
        if (!newPt?.id) throw new PostFailure('the pass-through entry', 'it returned no id')
        completed.push({ label: 'the pass-through entry' })
        ptId = newPt?.id
      }

      if (pairId && ptId) {
        const { error: pairErr } = await supabase.from('passthrough')
          .update({ pair_id: ptId, status: 'paired' }).eq('id', pairId)
        if (pairErr) throw new PostFailure('the pairing', pairErr.message)
        const { data: pairData, error: readErr } = await supabase.from('passthrough').select('amount_usd').eq('id', pairId).single()
        if (readErr) throw new PostFailure('the pairing', readErr.message)
        if (pairData && Math.abs(pairData.amount_usd - usdAmount) < 0.01) {
          const { error: balA } = await supabase.from('passthrough').update({ status: 'balanced' }).eq('id', pairId)
          if (balA) throw new PostFailure('the balanced status', balA.message)
          const { error: balB } = await supabase.from('passthrough').update({ status: 'balanced' }).eq('id', ptId)
          if (balB) throw new PostFailure('the balanced status', balB.message)
        }
      }

      setSuccess(true)
      setTimeout(() => { setSuccess(false); onClose() }, 1500)
    } catch (err: any) {
      // supabase-js does not throw, so this catch was dead code for every
      // database refusal and the success screen showed regardless.
      setSaveError(err instanceof PostFailure
        ? reportPostFailure('The pass-through', err.step, err.message, completed)
        : `Error: ${err.message}`)
    }
    setSaving(false)
  }

  if (success) return (
    <div style={s.overlay}>
      <div style={{ ...s.dialog, display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center', gap: '1rem', minHeight: '220px' }}>
        <div style={{ width: '48px', height: '48px', borderRadius: '50%', background: DIALOG.blueFill, display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
          <svg width="24" height="24" viewBox="0 0 24 24" fill="none" stroke={DIALOG.blue} strokeWidth="2"><path d="M5 13l4 4L19 7" /></svg>
        </div>
        <div style={{ fontFamily: 'Georgia,serif', fontSize: '20px', color: DIALOG.text }}>Pass-through posted!</div>
        <div style={{ fontSize: '13px', color: DIALOG.dim }}>
          {pairId ? (isBalanced ? 'Paired and balanced ✓' : 'Paired — amounts differ, check balance.') : 'Unpaired — waiting for matching entry.'}
        </div>
      </div>
    </div>
  )

  return (
    <div style={s.overlay}>
      <div style={s.dialog}>
        <div style={s.header}>
          <div>
            <div style={s.headerTitle}>{passthrough ? 'Edit pass-through' : 'New pass-through'}</div>
            <div style={s.headerSub}>Step {step} of 3 — {stepTitles[step - 1]}</div>
          </div>
          <div style={{ display: 'flex', alignItems: 'center', gap: '10px' }}>
            <div style={s.ptBadge}>Cash Flow Only</div>
            <span style={s.logoText}>MCFlow</span>
            <button style={s.closeBtn} onClick={onClose}>×</button>
          </div>
        </div>

        {/* Steps bar */}
        <div style={s.stepsBar}>
          {stepTitles.map((t, i) => {
            const hasErr = step > i + 1 && stepHasError(i + 1)
            return (
              <React.Fragment key={i}>
                <div style={s.stepItem} onClick={() => { touchStep(step); setStep(i + 1) }}>
                  <div style={{ ...s.stepNum, ...(step === i + 1 ? s.stepActive : {}), ...(step > i + 1 && !hasErr ? s.stepDone : {}), ...(hasErr ? s.stepError : {}) }}>
                    {step > i + 1 ? (hasErr ? '!' : '✓') : i + 1}
                  </div>
                  <span style={{ ...s.stepLabel, ...(step === i + 1 ? { color: DIALOG.blue, fontWeight: '500' } : {}) }}>{t}</span>
                </div>
                {i < 2 && <div style={s.stepDiv} />}
              </React.Fragment>
            )
          })}
        </div>

        {/* Validation banner */}
        {showValidationSummary && !isValid && (
          <div style={s.validationBanner}>
            <span>⚠️</span>
            <div style={{ flex: 1 }}>
              <div style={{ fontWeight: '500', fontSize: '12px' }}>Fix {totalErrors} error{totalErrors > 1 ? 's' : ''} before posting:</div>
              <div style={{ fontSize: '11px', marginTop: '2px', opacity: 0.9 }}>{Object.values(errors).join(' · ')}</div>
            </div>
            <button style={s.bannerClose} onClick={() => setShowValidationSummary(false)}>×</button>
          </div>
        )}

        <div style={s.body}>

          {/* ── STEP 1 ── */}
          {step === 1 && (
            <>
              <div style={{ ...s.infoBox, marginBottom: '16px' }}>
                Pass-through entries affect <strong>cash flow only</strong> — never P&L. IN and OUT must balance to zero. They may span across months.
              </div>

              <div style={s.section}>
                <div style={s.sectionTitle}>Company & bank</div>
                <div style={s.row2}>
                  {showPicker && (
                    <div style={s.field}>
                      <label style={s.lbl}>Company <span style={s.req}>*</span></label>
                      <select style={{ ...s.select, ...(fieldErr('companyId') ? s.inputError : {}) }} value={companyId}
                        onChange={e => { setCompanyId(e.target.value); touch('companyId') }}
                        onBlur={() => touch('companyId')}>
                        <option value="">Select company...</option>
                        {companies.map(c => <option key={c.id} value={c.id}>{c.name}</option>)}
                      </select>
                      {fieldErr('companyId') && <span style={s.errorMsg}>{fieldErr('companyId')}</span>}
                    </div>
                  )}
                  <div style={s.field}>
                    <label style={s.lbl}>Bank / Account <span style={s.req}>*</span></label>
                    <select style={{ ...s.select, ...(fieldErr('bankId') ? s.inputError : {}) }} value={bankId}
                      onChange={e => { setBankId(e.target.value); touch('bankId') }} onBlur={() => touch('bankId')}>
                      <option value="">Select bank...</option>
                      {banks.map(b => <option key={b.id} value={b.id}>{b.name}</option>)}
                    </select>
                    {fieldErr('bankId') && <span style={s.errorMsg}>{fieldErr('bankId')}</span>}
                  </div>
                </div>
                <div style={s.row2}>
                  <div style={s.field}>
                    <label style={s.lbl}>Currency <span style={s.req}>*</span></label>
                    <select style={{ ...s.select, ...(fieldErr('currency') ? s.inputError : {}) }} value={currency}
                      onChange={e => { setCurrency(e.target.value); touch('currency') }} onBlur={() => touch('currency')}>
                      <option value="">Select...</option>
{(companies.find(c => c.id === companyId)?.currencies || ['USD','RSD','EUR','AED']).map((cur: string) => (
  <option key={cur}>{cur}</option>
))}
                    </select>
                    {fieldErr('currency') && <span style={s.errorMsg}>{fieldErr('currency')}</span>}
                  </div>
                  <div style={s.field}>
                    <label style={s.lbl}>Statement number</label>
                    <input style={s.input} value={statement} onChange={e => setStatement(e.target.value)} placeholder="e.g. 2026-001" />
                  </div>
                </div>
              </div>

              <div style={s.section}>
                <div style={s.sectionTitle}>Date & partner</div>
                <div style={s.row2}>
                  <div style={s.field}>
                    <label style={s.lbl}>Transaction date <span style={s.req}>*</span></label>
                    <input type="date" style={{ ...s.input, ...(fieldErr('txDate') ? s.inputError : {}) }} value={txDate}
                      onChange={e => { setTxDate(e.target.value); touch('txDate') }} onBlur={() => touch('txDate')} />
                    {fieldErr('txDate') && <span style={s.errorMsg}>{fieldErr('txDate')}</span>}
                  </div>
                  <div style={s.field}>
                    <label style={s.lbl}>Period month <span style={s.req}>*</span></label>
                    <input type="month" style={{ ...s.input, ...(fieldErr('periodMonth') ? s.inputError : {}) }} value={periodMonth}
                      onChange={e => { setPeriodMonth(e.target.value); touch('periodMonth') }} onBlur={() => touch('periodMonth')} />
                    {fieldErr('periodMonth') && <span style={s.errorMsg}>{fieldErr('periodMonth')}</span>}
                  </div>
                </div>
                <div style={s.field}>
                  <label style={s.lbl}>Partner</label>
                  {!showNewPartner ? (
                    <>
                      <input style={s.input} value={partnerSearch}
                        onChange={e => { setPartnerSearch(e.target.value); setPartnerId('') }} placeholder="Search partner..." />
                      {partnerSearch && !partnerId && (
                        <div style={s.dropdown}>
                          {filteredPartners.slice(0, 6).map(p => (
                            <div key={p.id} style={s.dropdownItem} onClick={() => { setPartnerId(p.id); setPartnerSearch(p.name) }}>{p.name}</div>
                          ))}
                          <div style={{ ...s.dropdownItem, color: DIALOG.accent }} onClick={() => { setShowNewPartner(true); setPartnerSearch('') }}>+ Add new partner</div>
                        </div>
                      )}
                    </>
                  ) : (
                    <>
                      <input style={s.input} value={newPartnerName} onChange={e => setNewPartnerName(e.target.value)} placeholder="New partner name..." />
                      <button style={s.linkBtn} onClick={() => setShowNewPartner(false)}>← Back to search</button>
                    </>
                  )}
                </div>
              </div>
            </>
          )}

          {/* ── STEP 2 ── */}
          {step === 2 && (
            <>
              <div style={s.section}>
                <div style={s.sectionTitle}>Direction <span style={s.req}>*</span></div>
                <div style={s.dirGrid}>
                  <div style={{ ...s.dirCard, ...(direction === 'in' ? s.dirCardIn : {}) }} onClick={() => { setDirection('in'); setPairId('') }}>
                    <div style={{ fontSize: '28px', marginBottom: '8px' }}>📥</div>
                    <div style={s.dirTitle}>Pass-through IN</div>
                    <div style={s.dirSub}>Money received on behalf of a third party. Will need a matching OUT.</div>
                  </div>
                  <div style={{ ...s.dirCard, ...(direction === 'out' ? s.dirCardOut : {}) }} onClick={() => { setDirection('out'); setPairId('') }}>
                    <div style={{ fontSize: '28px', marginBottom: '8px' }}>📤</div>
                    <div style={s.dirTitle}>Pass-through OUT</div>
                    <div style={s.dirSub}>Money paid out on behalf of a third party. Will need a matching IN.</div>
                  </div>
                </div>
              </div>

              <div style={s.section}>
                <div style={s.sectionTitle}>Pair with existing entry</div>
                <div style={{ fontSize: '12px', color: DIALOG.dim, marginBottom: '12px' }}>
                  Optionally link to an existing unpaired {direction === 'in' ? 'OUT' : 'IN'} entry. Can be done later.
                </div>

                {unpaired.length === 0 ? (
                  <div style={s.emptyState}>No unpaired {direction === 'in' ? 'OUT' : 'IN'} entries found for this company. You can pair later.</div>
                ) : (
                  <div style={s.pairList}>
                    {/* No pair option */}
                    <div style={{ ...s.pairRow, ...(!pairId ? s.pairRowSelected : {}) }} onClick={() => setPairId('')}>
                      <div style={s.pairRadio}><div style={{ ...s.pairRadioInner, ...(!pairId ? s.pairRadioActive : {}) }} /></div>
                      <div style={{ flex: 1 }}>
                        <div style={{ fontSize: '13px', fontWeight: '500', color: DIALOG.dim }}>No pair — post as unpaired</div>
                        <div style={{ fontSize: '11px', color: DIALOG.faint }}>Match later when the other side arrives.</div>
                      </div>
                    </div>
                    {unpaired.map(p => (
                      <div key={p.id} style={{ ...s.pairRow, ...(pairId === p.id ? s.pairRowSelected : {}) }} onClick={() => setPairId(p.id)}>
                        <div style={s.pairRadio}><div style={{ ...s.pairRadioInner, ...(pairId === p.id ? s.pairRadioActive : {}) }} /></div>
                        <div style={{ flex: 1 }}>
                          <div style={{ display: 'flex', alignItems: 'center', gap: '8px' }}>
                            <span style={{ fontSize: '13px', fontWeight: '500', color: DIALOG.text }}>{p.partners?.name || '—'}</span>
                            <span style={s.dirBadge}>{direction === 'in' ? 'OUT' : 'IN'}</span>
                          </div>
                          <div style={{ fontSize: '11px', color: DIALOG.dim, marginTop: '2px' }}>{p.transaction_date} · Period: {p.period_month} · {p.banks?.name}</div>
                        </div>
                        <div style={{ textAlign: 'right' as const }}>
                          <div style={{ fontSize: '13px', fontWeight: '500', color: DIALOG.text }}>{(p.amount || 0).toLocaleString()} {p.currency}</div>
                          <div style={{ fontSize: '11px', color: DIALOG.dim }}>${(p.amount_usd || 0).toFixed(2)}</div>
                        </div>
                      </div>
                    ))}
                  </div>
                )}

                {pairId && usdAmount > 0 && (
                  <div style={{ ...s.balanceBox, marginTop: '12px', ...(isBalanced ? s.balanceBoxOk : s.balanceBoxWarn) }}>
                    {isBalanced
                      ? <>✅ Amounts match — pair will be marked as <strong>balanced</strong>.</>
                      : <>⚠️ Difference of <strong>${balanceDiff?.toFixed(2)}</strong>. Pair will be <strong>paired but not balanced</strong>.</>
                    }
                  </div>
                )}
              </div>

              <div style={s.section}>
                <div style={s.sectionTitle}>Note</div>
                <textarea style={s.textarea} value={note} onChange={e => setNote(e.target.value)} placeholder="Description of this pass-through entry..." />
              </div>
            </>
          )}

          {/* ── STEP 3 ── */}
          {step === 3 && (
            <>
              <div style={s.section}>
                <div style={s.sectionTitle}>Amount & currency conversion</div>
                <div style={{ ...s.infoBox, marginBottom: '12px' }}>
                  {currency === 'USD' ? 'No conversion needed — amount is already in USD.' : `Rate fetched on transaction date (${txDate}).`}
                </div>
                <div style={s.row2}>
                  <div style={s.field}>
                    <label style={s.lbl}>Amount ({currency || '—'}) <span style={s.req}>*</span></label>
                    <input type="number" style={{ ...s.input, ...(fieldErr('amount') ? s.inputError : {}) }} value={amount}
                      onChange={e => { setAmount(e.target.value); touch('amount') }} onBlur={() => touch('amount')} placeholder="0.00" />
                    {fieldErr('amount') && <span style={s.errorMsg}>{fieldErr('amount')}</span>}
                  </div>
                  <div style={s.field}>
                    <label style={s.lbl}>Exchange rate {currency !== 'USD' && <span style={s.req}>*</span>}</label>
                    <div style={{ display: 'flex', gap: '6px' }}>
                      <input type="number" style={{ ...s.input, flex: 1, ...(fieldErr('exRate') ? s.inputError : {}) }} value={exRate}
                        onChange={e => { setExRate(e.target.value); touch('exRate') }} onBlur={() => touch('exRate')}
                        placeholder={currency === 'USD' ? 'N/A' : 'Click Fetch'} />
                      {currency !== 'USD' && <button style={s.fetchBtn} onClick={fetchRate} disabled={fetchingRate}>{fetchingRate ? '...' : 'Fetch'}</button>}
                    </div>
                    {rateSource && <div style={{ fontSize: '11px', color: rateIsFallback ? '#FF5B5A' : DIALOG.blue, fontWeight: rateIsFallback ? 600 : 400, marginTop: '4px' }}>Source: {rateSource}</div>}
                    {fieldErr('exRate') && <span style={s.errorMsg}>{fieldErr('exRate')}</span>}
                  </div>
                </div>
                <div style={s.convRow}>
                  <div><div style={s.convLabel}>Original amount</div><div style={s.convVal}>{amount ? `${parseFloat(amount).toLocaleString()} ${currency}` : '—'}</div></div>
                  <div style={{ fontSize: '20px', color: DIALOG.faint, alignSelf: 'flex-end', paddingBottom: '4px' }}>→</div>
                  <div><div style={s.convLabel}>USD equivalent</div><div style={{ ...s.convVal, color: DIALOG.blue }}>${usdAmount > 0 ? usdAmount.toFixed(2) : '0.00'}</div></div>
                </div>

                {/* Balance re-check after amount entered */}
                {pairId && usdAmount > 0 && selectedPair && (
                  <div style={{ ...s.balanceBox, marginTop: '12px', ...(isBalanced ? s.balanceBoxOk : s.balanceBoxWarn) }}>
                    {isBalanced
                      ? <>✅ Amounts match — pair will be marked as <strong>balanced</strong>.</>
                      : <>⚠️ Difference of <strong>${balanceDiff?.toFixed(2)}</strong> with paired entry (${(selectedPair.amount_usd || 0).toFixed(2)}). Will be <strong>paired but not balanced</strong>.</>
                    }
                  </div>
                )}
              </div>

              {/* Review */}
              <div style={s.section}>
                <div style={s.sectionTitle}>Review</div>
                {isValid ? (
                  <div style={{ ...s.infoBox, marginBottom: '14px', background: DIALOG.blueFill, borderColor: DIALOG.blue, color: DIALOG.blue, display: 'flex', gap: '10px', alignItems: 'center' }}>
                    <span>✅</span>
                    <div>
                      <div style={{ fontWeight: '500', marginBottom: '2px' }}>All fields valid — ready to post</div>
                      <div style={{ fontSize: '11px', opacity: 0.85 }}>No P&L impact. Cash flow only.</div>
                    </div>
                  </div>
                ) : (
                  <div style={{ ...s.validationBanner, marginBottom: '14px', position: 'relative' }}>
                    <span>⚠️</span>
                    <div>
                      <div style={{ fontWeight: '500', fontSize: '12px' }}>{totalErrors} required field{totalErrors > 1 ? 's' : ''} missing</div>
                      <div style={{ fontSize: '11px', marginTop: '2px' }}>{Object.values(errors).join(' · ')}</div>
                    </div>
                  </div>
                )}

                {[
                  { title: 'Entry info', rows: [
                    ['Company', companies.find(c => c.id === companyId)?.name || '—'],
                    ['Bank', banks.find(b => b.id === bankId)?.name || '—'],
                    ['Partner', showNewPartner ? newPartnerName : (partners.find(p => p.id === partnerId)?.name || partnerSearch || '—')],
                    ['Date', txDate],
                    ['Period month', periodMonth],
                    ['Direction', direction === 'in' ? '📥 Pass-through IN' : '📤 Pass-through OUT'],
                  ]},
                  { title: 'Pairing & status', rows: [
                    ['Pair', pairId ? (selectedPair ? `${selectedPair.partners?.name || '—'} · ${selectedPair.transaction_date}` : 'Selected') : 'None — will be unpaired'],
                    ['Expected status', pairId ? (isBalanced ? 'Balanced ✅' : 'Paired (amounts differ) ⚠️') : 'Unpaired'],
                    ['P&L impact', 'None — cash flow only'],
                  ]},
                  { title: 'Amounts', rows: [
                    ['Original amount', amount ? `${parseFloat(amount).toLocaleString()} ${currency}` : '—'],
                    ['Exchange rate', exRate ? `${parseFloat(exRate).toFixed(4)} (${rateSource || 'Manual'})` : 'N/A'],
                    ['USD equivalent', `$${usdAmount.toFixed(2)}`],
                  ]},
                ].map(sec => (
                  <div key={sec.title} style={s.reviewSection}>
                    <div style={s.reviewTitle}>{sec.title}</div>
                    <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: '13px' }}>
                      {sec.rows.map(([k, v]) => (
                        <tr key={k}>
                          <td style={{ color: DIALOG.dim, padding: '5px 0', width: '45%', borderBottom: '0.5px solid ' + DIALOG.borderSoft }}>{k}</td>
                          <td style={{ fontWeight: '500', color: DIALOG.text, padding: '5px 0', borderBottom: '0.5px solid ' + DIALOG.borderSoft }}>{v}</td>
                        </tr>
                      ))}
                    </table>
                  </div>
                ))}
              </div>
            </>
          )}
        </div>

        {saveError && (
          <div style={{ margin: '0 1.5rem 1rem', background: DIALOG.redFill, border: '0.5px solid ' + DIALOG.redSoft, borderRadius: '8px', padding: '10px 14px', fontSize: '13px', color: DIALOG.red }}>
            ⚠️ {saveError}
          </div>
        )}

        <div style={s.footer}>
          <div style={{ display: 'flex', alignItems: 'center', gap: '8px' }}>
            <span style={{ fontSize: '12px', color: DIALOG.dim }}>Step {step} of 3</span>
            {totalErrors > 0 && Object.keys(touched).length > 0 && (
              <span style={{ fontSize: '11px', color: DIALOG.red, background: DIALOG.redFill, padding: '2px 8px', borderRadius: '20px' }}>
                {totalErrors} field{totalErrors > 1 ? 's' : ''} missing
              </span>
            )}
          </div>
          <div style={{ display: 'flex', gap: '8px' }}>
            {step > 1 && <button style={s.btnGhost} onClick={() => setStep(step - 1)}>Back</button>}
            {step < 3 && <button style={s.btnPrimary} onClick={() => { touchStep(step); setStep(step + 1) }}>Continue</button>}
            {step === 3 && <button style={{ ...s.btnPrimary, background: DIALOG.blue, opacity: saving ? 0.7 : 1 }} onClick={handlePost} disabled={saving}>{saving ? 'Saving...' : passthrough ? 'Update entry' : 'Post entry'}</button>}
          </div>
        </div>
      </div>
    </div>
  )
}

const s: Record<string, React.CSSProperties> = {
  overlay: { position: 'fixed', inset: 0, colorScheme: 'dark', background: DIALOG.overlay, backdropFilter: 'blur(4px)', display: 'flex', alignItems: 'center', justifyContent: 'center', zIndex: DIALOG.z },
  dialog: { background: DIALOG.panel, borderRadius: '16px', width: '800px', maxWidth: '95vw', maxHeight: '90vh', display: 'flex', flexDirection: 'column', overflow: 'hidden' },
  header: { background: DIALOG.panelDeep, padding: '1rem 1.5rem', display: 'flex', alignItems: 'center', justifyContent: 'space-between' },
  headerTitle: { color: DIALOG.text, fontSize: '15px', fontWeight: '500' },
  headerSub: { color: 'rgba(255,255,255,0.45)', fontSize: '12px', marginTop: '2px' },
  logoText: { color: DIALOG.accent, fontFamily: 'Georgia,serif', fontSize: '14px' },
  closeBtn: { background: 'none', border: 'none', color: 'rgba(255,255,255,0.5)', fontSize: '22px', cursor: 'pointer', padding: '0 4px', lineHeight: 1 },
  ptBadge: { fontSize: '10px', fontWeight: '500', padding: '3px 8px', borderRadius: '20px', background: 'rgba(12,68,124,0.2)', color: DIALOG.blue, border: '0.5px solid rgba(12,68,124,0.3)' },
  stepsBar: { display: 'flex', alignItems: 'center', padding: '0.75rem 1.5rem', borderBottom: '0.5px solid ' + DIALOG.border, gap: 0, overflowX: 'auto' },
  stepItem: { display: 'flex', alignItems: 'center', gap: '6px', cursor: 'pointer', padding: '4px 8px', borderRadius: '8px', whiteSpace: 'nowrap' },
  stepNum: { width: '22px', height: '22px', borderRadius: '50%', display: 'flex', alignItems: 'center', justifyContent: 'center', fontSize: '11px', fontWeight: '500', background: DIALOG.raised, color: DIALOG.dim, border: '0.5px solid ' + DIALOG.border, flexShrink: 0 },
  stepActive: { background: DIALOG.blue, color: DIALOG.onAccent, borderColor: DIALOG.blue },
  stepDone: { background: DIALOG.blueFill, color: DIALOG.blue, borderColor: DIALOG.blue },
  stepError: { background: DIALOG.redFill, color: DIALOG.red, borderColor: DIALOG.red },
  stepLabel: { fontSize: '12px', color: DIALOG.dim },
  stepDiv: { width: '20px', height: '0.5px', background: DIALOG.border, flexShrink: 0 },
  validationBanner: { display: 'flex', alignItems: 'flex-start', gap: '10px', background: DIALOG.redFill, borderBottom: '0.5px solid ' + DIALOG.redSoft, padding: '10px 1.5rem', color: DIALOG.red },
  bannerClose: { background: 'none', border: 'none', fontSize: '18px', cursor: 'pointer', color: DIALOG.red, padding: '0', lineHeight: 1 },
  body: { padding: '1.5rem', overflowY: 'auto', flex: 1 },
  footer: { padding: '1rem 1.5rem', borderTop: '0.5px solid ' + DIALOG.border, display: 'flex', alignItems: 'center', justifyContent: 'space-between', background: DIALOG.raised },
  section: { marginBottom: '1.5rem' },
  sectionTitle: { fontSize: '11px', fontWeight: '500', color: DIALOG.dim, textTransform: 'uppercase' as const, letterSpacing: '0.08em', marginBottom: '10px', paddingBottom: '6px', borderBottom: '0.5px solid ' + DIALOG.border },
  row2: { display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '12px', marginBottom: '12px' },
  field: { display: 'flex', flexDirection: 'column' as const, gap: '4px', position: 'relative' as const },
  lbl: { fontSize: '11px', fontWeight: '500', color: DIALOG.dim, textTransform: 'uppercase' as const, letterSpacing: '0.07em' },
  req: { color: DIALOG.red },
  select: { fontFamily: 'system-ui,sans-serif', fontSize: '13px', padding: '8px 10px', border: '0.5px solid ' + DIALOG.border, borderRadius: '8px', background: DIALOG.panel, color: DIALOG.text, outline: 'none' },
  input: { fontFamily: 'system-ui,sans-serif', fontSize: '13px', padding: '8px 10px', border: '0.5px solid ' + DIALOG.border, borderRadius: '8px', background: DIALOG.panel, color: DIALOG.text, outline: 'none' },
  inputError: { border: '1.5px solid ' + DIALOG.red, background: DIALOG.redFill },
  errorMsg: { fontSize: '11px', color: DIALOG.red, marginTop: '2px' },
  textarea: { fontFamily: 'system-ui,sans-serif', fontSize: '13px', padding: '8px 10px', border: '0.5px solid ' + DIALOG.border, borderRadius: '8px', background: DIALOG.panel, color: DIALOG.text, outline: 'none', resize: 'vertical' as const, minHeight: '70px', width: '100%', boxSizing: 'border-box' as const },
  dropdown: { position: 'absolute' as const, top: '100%', left: 0, right: 0, background: DIALOG.panel, border: '0.5px solid ' + DIALOG.border, borderRadius: '8px', zIndex: 100, boxShadow: '0 4px 12px rgba(0,0,0,0.08)', marginTop: '2px' },
  dropdownItem: { padding: '8px 12px', fontSize: '13px', color: DIALOG.text, cursor: 'pointer', borderBottom: '0.5px solid ' + DIALOG.borderSoft },
  linkBtn: { background: 'none', border: 'none', color: DIALOG.accent, fontSize: '12px', cursor: 'pointer', padding: '4px 0', fontFamily: 'system-ui,sans-serif' },
  infoBox: { background: DIALOG.blueFill, border: '0.5px solid ' + DIALOG.blue, borderRadius: '8px', padding: '8px 12px', fontSize: '12px', color: DIALOG.blue },
  dirGrid: { display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '12px' },
  dirCard: { border: '0.5px solid ' + DIALOG.border, borderRadius: '10px', padding: '18px 16px', background: DIALOG.raised, cursor: 'pointer', textAlign: 'center' as const },
  dirCardIn: { border: '2px solid ' + DIALOG.accent, background: DIALOG.accentFill },
  dirCardOut: { border: '2px solid ' + DIALOG.red, background: DIALOG.redFill },
  dirTitle: { fontSize: '13px', fontWeight: '600', color: DIALOG.text, marginBottom: '6px' },
  dirSub: { fontSize: '11px', color: DIALOG.dim, lineHeight: '1.5' },
  emptyState: { padding: '16px', textAlign: 'center' as const, color: DIALOG.faint, fontSize: '13px', background: DIALOG.raised, borderRadius: '8px' },
  pairList: { display: 'flex', flexDirection: 'column' as const, gap: '6px' },
  pairRow: { display: 'flex', alignItems: 'center', gap: '12px', padding: '10px 12px', border: '0.5px solid ' + DIALOG.border, borderRadius: '8px', background: DIALOG.panel, cursor: 'pointer' },
  pairRowSelected: { border: '1.5px solid ' + DIALOG.blue, background: DIALOG.blueFill },
  pairRadio: { width: '16px', height: '16px', borderRadius: '50%', border: '1.5px solid ' + DIALOG.border, display: 'flex', alignItems: 'center', justifyContent: 'center', flexShrink: 0 },
  pairRadioInner: { width: '8px', height: '8px', borderRadius: '50%', background: 'transparent' },
  pairRadioActive: { background: DIALOG.blue },
  dirBadge: { fontSize: '10px', fontWeight: '500', padding: '1px 7px', borderRadius: '20px', background: DIALOG.amberFill, color: DIALOG.amber },
  balanceBox: { padding: '10px 14px', borderRadius: '8px', fontSize: '12px' },
  balanceBoxOk: { background: DIALOG.accentFill, border: '0.5px solid ' + DIALOG.accent, color: DIALOG.accent },
  balanceBoxWarn: { background: DIALOG.amberFill, border: '0.5px solid ' + DIALOG.amber, color: DIALOG.amber },
  fetchBtn: { fontFamily: 'system-ui,sans-serif', fontSize: '12px', padding: '8px 10px', border: '0.5px solid ' + DIALOG.border, borderRadius: '8px', background: DIALOG.raised, color: DIALOG.dim, cursor: 'pointer' },
  convRow: { display: 'grid', gridTemplateColumns: '1fr auto 1fr', gap: '12px', alignItems: 'center', marginTop: '12px', padding: '12px', background: DIALOG.raised, borderRadius: '8px' },
  convLabel: { fontSize: '11px', color: DIALOG.dim, marginBottom: '4px' },
  convVal: { fontSize: '16px', fontWeight: '500', color: DIALOG.text },
  reviewSection: { background: DIALOG.raised, borderRadius: '8px', padding: '12px', marginBottom: '10px' },
  reviewTitle: { fontSize: '11px', fontWeight: '500', color: DIALOG.dim, textTransform: 'uppercase' as const, letterSpacing: '0.07em', marginBottom: '8px' },
  btnGhost: { fontFamily: 'system-ui,sans-serif', fontSize: '13px', padding: '8px 16px', borderRadius: '8px', border: '0.5px solid ' + DIALOG.border, background: 'transparent', color: DIALOG.dim, cursor: 'pointer' },
  btnPrimary: { fontFamily: 'system-ui,sans-serif', fontSize: '13px', padding: '8px 16px', borderRadius: '8px', border: 'none', background: DIALOG.blue, color: DIALOG.onAccent, cursor: 'pointer', fontWeight: '500' },
}