import React, { useState, useEffect, useCallback } from 'react'
import { supabase } from '../supabase'
import { useCompanies } from '../contexts/CompaniesContext'
import { SkeletonRows } from '../components/motion'
import { CASH_ONLY_FILTER } from '../services/cashBasis'
import { fmtMoney } from '../utils/formatters'
import { useDisplayCurrency } from '../contexts/DisplayCurrencyContext'
import CashFlowTimeline from '../components/CashFlowTimeline'
import CashPositionDialog from '../components/CashPositionDialog'
import { loadCashTimeline, type LoadedCashTimeline } from '../services/loadCashTimeline'
import { cashDirection, previousMonth } from '../services/cashTimeline'
import { monthLongLabel, capitalize } from '../utils/months'
import { countOf } from '../utils/plural'

export default function CashFlow() {

  const { companies, showPicker } = useCompanies()
  // Every total below sums each transaction's own figure in the display
  // currency (amount_rsd or amount_eur); a row with none counts as zero.
  const { currency, pick, format } = useDisplayCurrency()
  const amt = (t: any): number => pick(t) ?? 0
  const [banks, setBanks] = useState<any[]>([])
  const [companyId, setCompanyId] = useState('all')
  const [periodType, setPeriodType] = useState<'month' | 'quarter' | 'year'>('month')
  const [periodValue, setPeriodValue] = useState(new Date().toISOString().slice(0, 7))
  const [loading, setLoading] = useState(true)

  const [transactions, setTransactions] = useState<any[]>([])

  // ── The line ─────────────────────────────────────────────────────────────
  //
  // Loaded apart from the period view below and on its own schedule: it is
  // twelve months whatever period is selected, because the question it answers
  // — when does the balance get low — is not a question about one month.
  const [line, setLine] = useState<LoadedCashTimeline | null>(null)
  const [lineError, setLineError] = useState('')
  const [enteringCash, setEnteringCash] = useState(false)

  const currentYear = new Date().getFullYear()



  useEffect(() => {
    const load = async () => {
      const { data: bnk } = await supabase.from('banks').select('id,name,company_id,currencies,is_active').order('name')
      if (bnk) setBanks(bnk)
    }
    load()
  }, [])

  const getDateRange = useCallback(() => {
    if (periodType === 'month') {
      const [y, m] = periodValue.split('-')
      const lastDay = new Date(parseInt(y), parseInt(m), 0).getDate()
      return { start: `${y}-${m}-01`, end: `${y}-${m}-${lastDay}` }
    }
    if (periodType === 'quarter') {
      const [y, q] = periodValue.split('-Q')
      const qNum = parseInt(q)
      const startMonth = (qNum - 1) * 3 + 1
      const endMonth = qNum * 3
      const lastDay = new Date(parseInt(y), endMonth, 0).getDate()
      return {
        start: `${y}-${String(startMonth).padStart(2, '0')}-01`,
        end: `${y}-${String(endMonth).padStart(2, '0')}-${lastDay}`,
      }
    }
    return { start: `${periodValue}-01-01`, end: `${periodValue}-12-31` }
  }, [periodType, periodValue])

  const fetchData = useCallback(async () => {
    setLoading(true)
    const { start, end } = getDateRange()

    // A currency gain is in the P&L and never touched the bank, so it is not
    // cash flow. `or()` rather than `neq()`: see services/cashBasis.ts — a bare
    // neq is NULL for the 1,345 transactions with no cf_type and would drop
    // every one of them.
    let txQuery = supabase
      .from('transactions')
      .select('*, partners(name), banks(id,name,currencies)')
      .gte('transaction_date', start)
      .lte('transaction_date', end)
      .eq('status', 'posted')
      .or(CASH_ONLY_FILTER)
    if (companyId !== 'all') txQuery = txQuery.eq('company_id', companyId)

    // PASS-THROUGHS ARE NOT READ HERE AT ALL. They are transfers between our
    // own accounts — the same money changing seats — and they were inflating
    // both sides of every total by the amount moved. They are entered and
    // paired on the Transactions page, which is where they belong; nothing on
    // a cash flow is answered by them.
    const { data: txData } = await txQuery
    setTransactions(txData || [])
    setLoading(false)
  }, [companyId, getDateRange])

  useEffect(() => { fetchData() }, [fetchData])

  const today = new Date().toISOString().slice(0, 10)
  const loadLine = useCallback(async () => {
    setLineError('')
    try {
      const ids = companyId === 'all' ? companies.map(c => c.id) : [companyId]
      if (ids.length === 0) return
      setLine(await loadCashTimeline(supabase, {
        currentMonth: today.slice(0, 7),
        today,
        // The last closed month, which is what the budget is seeded from —
        // the same benchmark the Budgeting page uses, so the outflow this
        // line projects is the figure that page shows.
        benchmark: previousMonth(today.slice(0, 7)),
        companyIds: ids,
        currency,
      }))
    } catch (e: any) {
      setLineError(e?.message || String(e))
    }
  }, [companyId, companies, today, currency])

  useEffect(() => { loadLine() }, [loadLine])

  // ── Cash flow logic ───────────────────────────────────
  // Direction from services/cashTimeline.cashDirection: a direct revenue
  // receipt, an advance, and a receipt against a revenue invoice
  // (invoice_payment with tx_subtype 'revenue') are in; a direct expense and
  // a payment against a supplier's bill are out.
  const inflowTx = transactions.filter(t => cashDirection(t) === 'in')
  const outflowTx = transactions.filter(t => cashDirection(t) === 'out')
  const operatingIn = inflowTx.reduce((s, t) => s + amt(t), 0)

  // Outflows, excluding banking and taxes (separate line items). Those two
  // are read from OUTFLOWS only: interest received is classified under
  // banking too, and it is already in the inflow.
  const operatingOut = outflowTx
    .filter(t => !['Banking and Finance', 'Taxes'].includes(t.pl_category || ''))
    .reduce((s, t) => s + amt(t), 0)

  const bankingOut = outflowTx
    .filter(t => t.pl_category === 'Banking and Finance')
    .reduce((s, t) => s + amt(t), 0)

  const taxOut = outflowTx
    .filter(t => t.pl_category === 'Taxes')
    .reduce((s, t) => s + amt(t), 0)

  // ── A TRANSFER BETWEEN OUR OWN ACCOUNTS IS NOT CASH FLOW ────────────────
  //
  // Pass-throughs used to be added to both sides. Money leaving one account
  // and arriving in another is the same money: the net came out right, so
  // nothing looked wrong, and both totals were simply too big by the amount
  // moved. A month with one large transfer read as a much busier month than
  // it was.
  //
  // They are still shown below, because an UNPAIRED one is a real finding —
  // money that left an account and never arrived — but as a control, not as
  // a flow, and not inside any total.
  const totalInflows = operatingIn
  const totalOutflows = operatingOut + bankingOut + taxOut
  const netCashFlow = totalInflows - totalOutflows

  const filteredBanks = companyId === 'all' ? banks : banks.filter(b => b.company_id === companyId)

  const getBankFlow = (bankId: string) => {
    const bankTx = transactions.filter(t => t.bank_id === bankId)
    const income = bankTx
      .filter(t => cashDirection(t) === 'in')
      .reduce((s, t) => s + amt(t), 0)
    const expense = bankTx
      .filter(t => cashDirection(t) === 'out')
      .reduce((s, t) => s + amt(t), 0)
    return { income, expense, net: income - expense, txCount: bankTx.length }
  }

  const months = Array.from({ length: 12 }, (_, i) => {
    const m = String(i + 1).padStart(2, '0')
    return { value: `${currentYear}-${m}`, label: capitalize(monthLongLabel(`${currentYear}-${m}`)) }
  })
  const quarters = [1, 2, 3, 4].map(q => ({ value: `${currentYear}-Q${q}`, label: `${q}. kvartal ${currentYear}.` }))
  const years = [currentYear - 1, currentYear].map(y => ({ value: String(y), label: String(y) }))

  const cashFlowSections = [
    {
      section: 'Poslovne aktivnosti', color: '#00D47E', bg: 'rgba(0,212,126,0.12)',
      items: [
        { name: 'Naplaćeno od kupaca', amount: operatingIn },
        { name: 'Plaćeno dobavljačima (fakture i direktno)', amount: -operatingOut },
        { name: 'Bankarske provizije i troškovi finansiranja', amount: -bankingOut },
        { name: 'Plaćeni porezi', amount: -taxOut },
      ]
    },
  ]

  const sectionTotal = (items: { amount: number }[]) => items.reduce((s, i) => s + i.amount, 0)

  const currencyColor = (cur: string) => {
    if (cur === 'USD') return { bg: 'rgba(78,168,255,0.13)', color: '#4EA8FF' }
    if (cur === 'RSD') return { bg: 'rgba(245,166,35,0.13)', color: '#F5A623' }
    if (cur === 'EUR') return { bg: 'rgba(0,212,126,0.12)', color: '#00D47E' }
    return { bg: '#FBEAF0', color: '#72243E' }
  }

  const fmtAmt = (n: number) => {
    if (n === 0) return '—'
    return format(n, 0)
  }

  return (
    <div style={s.root} className="app-surface">
      <div style={s.body}>
        <div style={s.pageHeader}>
          <div>
            <div style={s.pageTitle}>Novčani tok</div>
            <div style={s.pageSub}>
              {loading ? 'Učitavanje…' : `${countOf(transactions.length, 'transakcija', 'transakcije', 'transakcija')} · ${currency}`}
            </div>
          </div>
          <div style={{ display: 'flex', gap: '8px', alignItems: 'center', flexWrap: 'wrap' as const }}>
            {showPicker && (
              <select style={s.filterSelect} value={companyId} onChange={e => setCompanyId(e.target.value)}>
                <option value="all">Sve firme</option>
                {companies.map(c => <option key={c.id} value={c.id}>{c.name}</option>)}
              </select>
            )}
            <select style={s.filterSelect} value={periodType}
              onChange={e => {
                const t = e.target.value as 'month' | 'quarter' | 'year'
                setPeriodType(t)
                setPeriodValue(t === 'month' ? new Date().toISOString().slice(0, 7) : t === 'quarter' ? `${currentYear}-Q1` : String(currentYear))
              }}>
              <option value="month">Mesečno</option>
              <option value="quarter">Kvartalno</option>
              <option value="year">Godišnje</option>
            </select>
            <select style={s.filterSelect} value={periodValue} onChange={e => setPeriodValue(e.target.value)}>
              {periodType === 'month' && months.map(m => <option key={m.value} value={m.value}>{m.label}</option>)}
              {periodType === 'quarter' && quarters.map(q => <option key={q.value} value={q.value}>{q.label}</option>)}
              {periodType === 'year' && years.map(y => <option key={y.value} value={y.value}>{y.label}</option>)}
            </select>
          </div>
        </div>

        {/* ── The line, before the period ──────────────────────────────
            Twelve months whatever period is selected below. The question it
            answers crosses today, and a period picker cannot ask it. */}
        {lineError && <div style={{ ...s.summaryCard, color: '#FF5B5A', marginBottom: '14px' }}>
          Linija novčanog toka nije učitana: {lineError}
        </div>}
        {line && (
          <CashFlowTimeline timeline={line.timeline} dated={line.dated} datedIn={line.datedIn} />
        )}
        {line && !line.timeline.position && (
          <div style={{ marginBottom: '14px' }}>
            <button style={s.enterCash} onClick={() => setEnteringCash(true)}>
              Unesi stanje novca
            </button>
          </div>
        )}
        {enteringCash && (
          <CashPositionDialog
            current={line?.timeline.position
              ? { amount: line.timeline.position.amount, asOf: line.timeline.position.asOf }
              : null}
            onClose={() => setEnteringCash(false)}
            onSaved={loadLine}
          />
        )}

        {/* Summary cards */}
        <div style={s.summaryGrid} className="mf-stagger">
          <div style={s.summaryCard}>
            <div style={s.summaryLabel}>Ukupni prilivi</div>
            <div style={{ ...s.summaryValue, color: '#00D47E' }}>{loading ? '...' : format(totalInflows, 0)}</div>
            <div style={s.summarySub}>Naplaćeni prihodi. Prenosi između sopstvenih računa se ne računaju.</div>
          </div>
          <div style={s.summaryCard}>
            <div style={s.summaryLabel}>Ukupni odlivi</div>
            <div style={{ ...s.summaryValue, color: '#FF5B5A' }}>{loading ? '...' : format(totalOutflows, 0)}</div>
            <div style={s.summarySub}>Troškovi, fakture, bankarske provizije i porezi. Bez prenosa.</div>
          </div>
          <div style={s.summaryCard}>
            <div style={s.summaryLabel}>Neto novčani tok</div>
            <div style={{ ...s.summaryValue, color: netCashFlow >= 0 ? '#0F6E56' : '#A32D2D' }}>
              {loading ? '...' : format(netCashFlow, 0)}
            </div>
            <div style={s.summarySub}>Za izabrani period</div>
          </div>
        </div>

        {!loading && transactions.length === 0 && (
          <div style={s.emptyState}>
            <div style={{ fontSize: '32px', marginBottom: '12px' }}>💸</div>
            <div style={{ fontSize: '15px', fontWeight: '500', color: '#DCE9F6', marginBottom: '6px' }}>Nema podataka o novčanom toku za ovaj period</div>
            <div style={{ fontSize: '13px', color: '#7A9BB8' }}>Proknjižite transakcije da biste ovde videli stvarni novčani tok.</div>
          </div>
        )}

        {(transactions.length > 0 || loading) && (
          <div style={s.contentGrid}>
            <div>
              <div style={s.sectionLabel}>Izveštaj o novčanim tokovima</div>
              <div style={s.tableWrap}>
                {loading ? (
                  <div style={{ padding: '18px 16px' }}>
                    <SkeletonRows rows={8} height={14} gap={13}
                      widths={[84, 60, 90, 54, 78, 46, 86, 66]} />
                  </div>
                ) : (
                  <table style={s.table}>
                    <thead>
                      <tr style={s.theadRow}>
                        <th style={{ ...s.th, width: '60%' }}>Stavka</th>
                        <th style={{ ...s.th, textAlign: 'right' as const }}>Iznos ({currency})</th>
                      </tr>
                    </thead>
                    <tbody>
                      {cashFlowSections.map(sec => (
                        <React.Fragment key={sec.section}>
                          <tr>
                            <td colSpan={2} style={{ ...s.catCell, borderLeft: `3px solid ${sec.color}`, background: sec.bg, color: sec.color }}>
                              {sec.section.toUpperCase()}
                            </td>
                          </tr>
                          {sec.items.map(item => (
                            <tr key={item.name} style={s.dataRow}>
                              <td style={s.td}>{item.name}</td>
                              <td style={{ ...s.td, textAlign: 'right' as const, fontWeight: '500', color: item.amount > 0 ? '#0F6E56' : item.amount < 0 ? '#A32D2D' : '#888' }}>
                                {fmtAmt(item.amount)}
                              </td>
                            </tr>
                          ))}
                          <tr style={s.subTotalRow}>
                            <td style={s.subTotalCell}>Net {sec.section}</td>
                            <td style={{ ...s.subTotalCell, textAlign: 'right' as const, color: sectionTotal(sec.items) >= 0 ? '#0F6E56' : '#A32D2D' }}>
                              {fmtAmt(sectionTotal(sec.items))}
                            </td>
                          </tr>
                        </React.Fragment>
                      ))}
                      <tr style={s.netRow}>
                        <td style={s.netCell}>NETO PROMENA NOVCA</td>
                        <td style={{ ...s.netCell, textAlign: 'right' as const, color: netCashFlow >= 0 ? '#5DCAA5' : '#F09595' }}>
                          {fmtAmt(netCashFlow)}
                        </td>
                      </tr>
                    </tbody>
                  </table>
                )}
              </div>

              {!loading && transactions.length > 0 && (
                <div style={{ marginTop: '16px' }}>
                  <div style={s.sectionLabel}>Poslednje transakcije</div>
                  <div style={s.tableWrap}>
                    <table style={s.table}>
                      <thead>
                        <tr style={s.theadRow}>
                          <th style={s.th}>Datum</th>
                          <th style={s.th}>Partner</th>
                          <th style={s.th}>Banka</th>
                          <th style={s.th}>Tip</th>
                          <th style={{ ...s.th, textAlign: 'right' as const }}>Iznos</th>
                          <th style={{ ...s.th, textAlign: 'right' as const }}>{currency}</th>
                        </tr>
                      </thead>
                      <tbody>
                        {transactions.slice(0, 15).map(tx => {
                          const isIn = cashDirection(tx) === 'in'
                          return (
                            <tr key={tx.id} style={s.dataRow}>
                              <td style={s.td}>{tx.transaction_date}</td>
                              <td style={s.td}>{tx.partners?.name || '—'}</td>
                              <td style={s.td}>{tx.banks?.name || '—'}</td>
                              <td style={s.td}>
                                <span style={{ fontSize: '11px', padding: '2px 8px', borderRadius: '20px', background: tx.type === 'direct' ? (tx.tx_subtype === 'revenue' ? 'rgba(0,212,126,0.12)' : 'rgba(255,91,90,0.13)') : 'rgba(78,168,255,0.13)', color: tx.type === 'direct' ? (tx.tx_subtype === 'revenue' ? '#085041' : '#A32D2D') : '#0C447C' }}>
                                  {tx.is_advance ? 'Avans' : tx.type === 'direct' ? (tx.tx_subtype === 'revenue' ? '📥 Direktna uplata' : '📤 Direktna isplata') : (isIn ? '💳 Naplata fakture' : '💳 Plaćanje fakture')}
                                </span>
                              </td>
                              <td style={{ ...s.td, textAlign: 'right' as const, color: isIn ? '#0F6E56' : '#A32D2D', fontWeight: '500' }}>
                                {isIn ? '+' : '-'}{fmtMoney(Math.abs(tx.amount || 0), tx.currency || 'RSD')}
                              </td>
                              <td style={{ ...s.td, textAlign: 'right' as const, color: '#7A9BB8' }}>
                                {pick(tx) === null ? '—' : format(Math.abs(pick(tx) as number))}
                              </td>
                            </tr>
                          )
                        })}
                        {transactions.length > 15 && (
                          <tr style={s.dataRow}>
                            <td colSpan={6} style={{ ...s.td, textAlign: 'center' as const, color: 'rgba(255,255,255,0.30)', fontStyle: 'italic' }}>
                              + još {transactions.length - 15} — sve su u Glavnoj knjizi
                            </td>
                          </tr>
                        )}
                      </tbody>
                    </table>
                  </div>
                </div>
              )}
            </div>

            {/* Bank accounts */}
            <div>
              <div style={s.sectionLabel}>Tekući računi</div>
              <div style={s.accountsWrap}>
                {filteredBanks.length === 0 ? (
                  <div style={{ padding: '20px', textAlign: 'center' as const, color: 'rgba(255,255,255,0.30)', fontSize: '13px', background: '#0D1B2C', borderRadius: '10px', border: '1px solid rgba(255,255,255,0.075)' }}>
                    Nema tekućih računa.
                  </div>
                ) : filteredBanks.map(bank => {
                  const flow = getBankFlow(bank.id)
                  const cc = currencyColor((bank.currencies || [])[0] || 'RSD')
                  const compName = companies.find(c => c.id === bank.company_id)?.name || '—'
                  return (
                    <div key={bank.id} style={s.accountCard}>
                      <div style={s.accountHeader}>
                        <div>
                          <div style={s.accountName}>{bank.name}</div>
                          <div style={s.accountCompany}>{compName}</div>
                        </div>
                        <span style={{ ...s.currBadge, background: cc.bg, color: cc.color }}>{(bank.currencies || [])[0] || 'RSD'}</span>
                      </div>
                      <div style={s.accountBalances}>
                        <div>
                          <div style={s.balLabel}>Prilivi</div>
                          <div style={{ ...s.balValue, color: '#00D47E' }}>{format(flow.income, 0)}</div>
                        </div>
                        <div style={{ fontSize: '14px', color: 'rgba(255,255,255,0.30)', alignSelf: 'flex-end', paddingBottom: '2px' }}>→</div>
                        <div>
                          <div style={s.balLabel}>Odlivi</div>
                          <div style={{ ...s.balValue, color: '#FF5B5A' }}>{format(flow.expense, 0)}</div>
                        </div>
                        <div style={{ ...s.diffBadge, background: flow.net >= 0 ? 'rgba(0,212,126,0.12)' : 'rgba(255,91,90,0.13)', color: flow.net >= 0 ? '#085041' : '#A32D2D' }}>
                          {format(flow.net, 0)}
                        </div>
                      </div>
                      <div style={{ fontSize: '11px', color: 'rgba(255,255,255,0.30)', marginTop: '6px' }}>
                        {countOf(flow.txCount, 'transakcija', 'transakcije', 'transakcija')} u periodu
                      </div>
                    </div>
                  )
                })}
              </div>

            </div>
          </div>
        )}
      </div>
    </div>
  )
}

const s: Record<string, React.CSSProperties> = {
  // The background lives in `.app-surface` rather than here: an inline
  // colour would paint straight over it.
  root: { minHeight: '100vh', fontFamily: "'Inter', system-ui, sans-serif" },
  body: { padding: '24px 28px' },
  pageHeader: { display: 'flex', alignItems: 'flex-start', justifyContent: 'space-between', marginBottom: '1.5rem' },
  pageTitle: { fontFamily: "'DM Serif Display', Georgia, serif", fontSize: '24px', fontWeight: '400', color: '#DCE9F6', marginBottom: '4px' },
  pageSub: { fontSize: '13px', color: '#7A9BB8' },
  filterSelect: { fontFamily: 'system-ui,sans-serif', fontSize: '13px', border: '1px solid rgba(255,255,255,0.075)', borderRadius: '8px', padding: '8px 12px', outline: 'none', background: '#0D1B2C', color: '#DCE9F6', cursor: 'pointer' },
  summaryGrid: { display: 'grid', gridTemplateColumns: 'repeat(4,1fr)', gap: '12px', marginBottom: '1.5rem' },
  enterCash: {
    fontFamily: "'Inter', system-ui, sans-serif", fontSize: '12px', padding: '8px 14px',
    border: 'none', borderRadius: '8px', background: '#F5A623', color: '#060E1A',
    cursor: 'pointer', fontWeight: 600,
  },
  summaryCard: { background: '#0D1B2C', border: '1px solid rgba(255,255,255,0.075)', borderRadius: '10px', padding: '1rem 1.25rem' },
  summaryLabel: { fontSize: '11px', color: 'rgba(255,255,255,0.30)', textTransform: 'uppercase' as const, letterSpacing: '0.08em', marginBottom: '8px' },
  summaryValue: { fontSize: '22px', fontWeight: '500' },
  summarySub: { fontSize: '11px', color: '#7A9BB8', marginTop: '4px' },
  emptyState: { background: '#0D1B2C', border: '1px solid rgba(255,255,255,0.075)', borderRadius: '10px', padding: '60px', textAlign: 'center' as const },
  contentGrid: { display: 'grid', gridTemplateColumns: '1fr 320px', gap: '16px' },
  sectionLabel: { fontSize: '11px', fontWeight: '500', color: 'rgba(255,255,255,0.30)', textTransform: 'uppercase' as const, letterSpacing: '0.1em', marginBottom: '10px' },
  tableWrap: { background: '#0D1B2C', border: '1px solid rgba(255,255,255,0.075)', borderRadius: '10px', overflow: 'hidden' },
  table: { width: '100%', borderCollapse: 'collapse' as const, fontSize: '13px' },
  theadRow: { background: '#060E1A' },
  th: { padding: '10px 16px', textAlign: 'left' as const, fontSize: '10px', fontWeight: '500', color: 'rgba(255,255,255,0.30)', textTransform: 'uppercase' as const, letterSpacing: '0.1em' },
  catCell: { padding: '8px 16px', fontSize: '11px', fontWeight: '500', letterSpacing: '0.1em' },
  dataRow: { borderBottom: '0.5px solid rgba(255,255,255,0.05)' },
  td: { padding: '9px 16px', color: '#DCE9F6', fontSize: '13px' },
  subTotalRow: { background: '#111F30', borderTop: '0.5px solid rgba(255,255,255,0.075)' },
  subTotalCell: { padding: '8px 16px', fontSize: '12px', fontWeight: '500', color: '#7A9BB8' },
  netRow: { background: '#060E1A' },
  netCell: { padding: '14px 16px', fontSize: '14px', fontWeight: '500', color: '#DCE9F6' },
  accountsWrap: { display: 'flex', flexDirection: 'column' as const, gap: '8px' },
  accountCard: { background: '#0D1B2C', border: '1px solid rgba(255,255,255,0.075)', borderRadius: '10px', padding: '12px 14px' },
  accountHeader: { display: 'flex', alignItems: 'flex-start', justifyContent: 'space-between', marginBottom: '10px' },
  accountName: { fontSize: '13px', fontWeight: '500', color: '#DCE9F6' },
  accountCompany: { fontSize: '11px', color: '#7A9BB8', marginTop: '2px' },
  currBadge: { fontSize: '10px', fontWeight: '500', padding: '2px 8px', borderRadius: '20px' },
  accountBalances: { display: 'flex', alignItems: 'center', gap: '10px' },
  balLabel: { fontSize: '10px', color: 'rgba(255,255,255,0.30)', textTransform: 'uppercase' as const, letterSpacing: '0.06em', marginBottom: '3px' },
  balValue: { fontSize: '13px', fontWeight: '500', color: '#DCE9F6' },
  diffBadge: { fontSize: '11px', fontWeight: '500', padding: '3px 8px', borderRadius: '20px', marginLeft: 'auto' },
}