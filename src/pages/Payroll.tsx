import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { supabase } from '../supabase'
import { useCompanies } from '../contexts/CompaniesContext'
import { SkeletonRows } from '../components/motion'
import { getRatesForDate } from '../services/currencyService'
import { fetchSettings, monthStart, numberFor, ratesFor, type SettingRow } from '../services/payroll/settings'
import {
  fetchEmployees, fetchContracts, fetchDeductions,
  fetchAllocations, fetchAbsences, employeesForMonth, absenceLabel, rateDateFor,
  type EmployeeRow, type ContractRow, type DeductionRow,
  type CostAllocationRow, type AbsenceRow,
  soleCompanyOf,
} from '../services/payroll/employees'
import {
  fetchTimesheets, coefficientsFrom, type TimesheetRow,
} from '../services/payroll/timesheets'
import {
  fetchHolidays, fundFor, explainFund, fundIsProvenFor, type HolidayRow,
} from '../services/payroll/holidays'
import {
  runsFor, grandTotal, RUN_DESCRIPTIONS,
  type PayrollRun, type RunKey, type SalaryRunLine,
} from '../services/payroll/runs'
import { fetchAdditions, type AdditionRow } from '../services/payroll/additions'
import {
  saveRun, fetchRuns, type SavedRun, type SaveContext,
} from '../services/payroll/savedRuns'
import PayrollPostingPanel from '../components/PayrollPostingPanel'
import PayrollMonths from '../components/PayrollMonths'
import PayslipDialog from '../components/PayslipDialog'
import { fmtNum } from '../utils/formatters'

/**
 * The monthly calculations.
 *
 * WHAT THIS PAGE IS FOR decides how it behaves. MCFlow does not file
 * anything and does not pay anybody: this is a second opinion, produced
 * independently, to be held against what the accountant's software produced.
 * A figure that is arguably right and differs from MPP is a failed check, not
 * a disagreement — so every line shows what it was calculated FROM, and
 * nothing is presented as settled when it rests on something unproved.
 *
 * It refuses in two places and says so in both: a month whose rates are
 * unknown, and a person with no timesheet. The alternative in each case is a
 * complete and plausible payroll that is quietly wrong, which is the one
 * output a checking tool must never produce.
 */
export default function Payroll() {
  const { companies, defaultCompany, showPicker } = useCompanies()
  const [companyId, setCompanyId] = useState<string>('')
  const [month, setMonth] = useState(() => new Date().toISOString().slice(0, 7))
  /**
   * Which run is expanded, and NONE of them to begin with.
   *
   * This page opened on the first run already unfolded, which is fourteen
   * people's salaries on screen the instant anybody navigates to Payroll —
   * over a shoulder, on a shared screen, in a screenshot taken for something
   * else entirely. The month's totals answer the question the page is usually
   * opened for; the per-person lines are a deliberate act, and now they take
   * one.
   */
  const [open, setOpen] = useState<RunKey | null>(null)
  /**
   * Whether the company has been chosen for the user yet.
   *
   * Once only. Snapping the selector back every time the data reloads would
   * take "All companies" away from anybody who picked it on purpose.
   */
  const defaulted = useRef(false)

  const [employees, setEmployees] = useState<EmployeeRow[]>([])
  const [contracts, setContracts] = useState<ContractRow[]>([])
  const [deductions, setDeductions] = useState<DeductionRow[]>([])
  const [allocations, setAllocations] = useState<CostAllocationRow[]>([])
  const [absences, setAbsences] = useState<AbsenceRow[]>([])
  const [settings, setSettings] = useState<SettingRow[]>([])
  const [holidays, setHolidays] = useState<HolidayRow[]>([])
  const [timesheets, setTimesheets] = useState<Record<string, TimesheetRow>>({})
  const [additions, setAdditions] = useState<AdditionRow[]>([])
  const [saved, setSaved] = useState<SavedRun[]>([])
  const [recalculating, setRecalculating] = useState<string | null>(null)
  const [payslip, setPayslip] = useState<
    { line: SalaryRunLine; runLabel: string } | null>(null)

  const [rate, setRate] = useState<{ eur: number; usd: number; date: string } | null>(null)
  const [rateError, setRateError] = useState<string | null>(null)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)

  const date = monthStart(month)

  const load = useCallback(async () => {
    setLoading(true); setError(null)
    try {
      const [emp, con, ded, set, hol, alloc, abs, ts, add] = await Promise.all([
        fetchEmployees(supabase, companyId || undefined),
        fetchContracts(supabase),
        fetchDeductions(supabase),
        fetchSettings(supabase),
        fetchHolidays(supabase),
        fetchAllocations(supabase),
        fetchAbsences(supabase),
        fetchTimesheets(supabase, month),
        fetchAdditions(supabase, month),
      ])
      // ── The company payroll is actually run for, chosen once ──────────
      //
      // MEASURED, NOT NAMED. Only one company runs a payroll here, and
      // opening on "All companies" means the page a person navigates to is
      // never the page they wanted. Hardcoding a company's name would be
      // right today and wrong the morning a second company starts filing,
      // silently — so it asks the employees instead: if every one of them
      // belongs to one company, that is the company.
      //
      // Once, and only when nothing has been chosen. Snapping the selector
      // back on every reload would take "All companies" away from anybody
      // who picked it deliberately.
      if (!defaulted.current && !companyId) {
        defaulted.current = true
        const sole = soleCompanyOf(emp)
        if (sole) setCompanyId(sole)
      }

      setEmployees(emp); setContracts(con); setDeductions(ded)
      setSettings(set); setHolidays(hol)
      setAllocations(alloc); setAbsences(abs); setAdditions(add)
      setSaved(companyId ? await fetchRuns(supabase, companyId, month) : [])
      const byEmployee: Record<string, TimesheetRow> = {}
      for (const t of ts) byEmployee[t.employee_id] = t
      setTimesheets(byEmployee)
    } catch (e: any) {
      setError(e.message)
    }
    setLoading(false)
  }, [companyId, month])

  // With one company there is no selector and nothing to choose: a payroll
  // is run for a company, so the page is that company's from the start.
  useEffect(() => {
    if (!showPicker && defaultCompany) setCompanyId(defaultCompany.id)
  }, [showPicker, defaultCompany])

  useEffect(() => { load() }, [load])

  useEffect(() => {
    let cancelled = false
    setRate(null); setRateError(null)
    getRatesForDate(rateDateFor(month))
      .then(r => { if (!cancelled) setRate({ eur: r.eurRsdRate, usd: r.usdRsdRate, date: r.date }) })
      .catch(e => { if (!cancelled) setRateError(e.message || String(e)) })
    return () => { cancelled = true }
  }, [month])

  const seniorityCoefficient = numberFor(settings, 'seniority_coefficient', date)
  // Every absence is paid at the coefficient in force for THIS month, so a
  // recalculation of an old one uses what it was paid at then.
  const coefficients = useMemo(
    () => coefficientsFrom(key => numberFor(settings, key, date)),
    [settings, date])
  const fund = useMemo(() => fundFor(
    month, holidays,
    numberFor(settings, 'month_hours', date),
    numberFor(settings, 'holiday_hours', date),
  ), [month, holidays, settings, date])

  // The rates either cover this month or they do not, and a month they do not
  // cover produces nothing at all rather than a figure with a gap in it.
  const rates = useMemo(() => {
    try { return { value: ratesFor(settings, date), why: null as string | null } }
    catch (e: any) { return { value: null, why: e.message as string } }
  }, [settings, date])

  const roster = useMemo(() => employeesForMonth(
    employees, contracts, deductions,
    { date, seniorityCoefficient: seniorityCoefficient ?? 0, rates: rate ? { EUR: rate.eur } : {} },
    allocations, absences,
  ), [employees, contracts, deductions, date, seniorityCoefficient, rate,
      allocations, absences])

  const result = useMemo(() => {
    if (!rates.value) return null
    return runsFor({
      people: roster.people,
      timesheets,
      rates: rates.value,
      monthHours: fund.monthHours,
      currencyRates: rate ? { EUR: rate.eur } : {},
      coefficients,
      additions,
      month,
    })
  }, [roster, timesheets, rates, fund, rate, month, coefficients, additions])

  const money = (n: number) => fmtNum(n)

  const total = result ? grandTotal(result.runs) : null
  const blocking = (roster.problems.length + (result?.problems.length ?? 0)) > 0

  const savedFor = (key: string) => saved.find(r => r.run_key === key) || null

  /**
   * Whether the saved run still says what the calculation says.
   *
   * THE ONE CONDITION FOR POSTING. What lands in the ledger has to be the
   * thing that was kept, and the only way to be sure of that is to insist the
   * two agree at the moment of posting. If an input has moved since, they do
   * not, and Recalculate is the answer rather than a silent choice between
   * two versions of the month.
   */
  const inStep = (run: PayrollRun) => {
    const s = savedFor(run.key)
    if (!s) return false
    return Math.abs(Number(s.total_cost) - run.totals.totalCost) < 0.02
  }

  const peopleById = useMemo(() => {
    const byId: Record<string, typeof roster.people[number]> = {}
    for (const p of roster.people) byId[p.employee.id] = p
    return byId
  }, [roster])

  const recalculate = async (run: PayrollRun) => {
    if (!companyId) { setError('Choose a single company first.'); return }
    setRecalculating(run.key); setError(null)
    try {
      const context: SaveContext = {
        companyId, month, exchangeRate: rate?.eur ?? null, usdRate: rate?.usd ?? null,
        monthHours: fund.monthHours, people: peopleById,
      }
      await saveRun(supabase, run, context)
      setSaved(await fetchRuns(supabase, companyId, month))
    } catch (e: any) {
      setError(e.message)
    }
    setRecalculating(null)
  }

  const copyForComparison = (run: PayrollRun) => {
    const rows = [
      ['Code', 'Employee', 'Hours', 'Gross', 'Tax', 'Contrib. employee',
        'Contrib. employer', 'Net', 'Total cost'].join('\t'),
      ...run.salaries.map(s => [
        s.code || '', s.name, s.hours, s.line.gross, s.line.contributionBase, s.line.incomeTax,
        s.line.employeeContributions, s.line.employerContributions,
        s.line.net, s.line.totalCost,
      ].join('\t')),
      ...run.otherIncome.map(o => [
        o.code || '', o.name, '', o.line.gross, '', o.line.incomeTax, '', '',
        o.line.net, o.line.totalCost,
      ].join('\t')),
    ].join('\n')
    navigator.clipboard?.writeText(rows)
  }

  return (
    <div style={s.root} className="app-surface">
      <div style={s.body}>
        <div style={s.pageHeader}>
          <div>
            <div style={s.pageTitle}>Payroll</div>
            <div style={s.pageSub}>
              A second opinion on what the month costs, to be held against MPP —
              nothing here is filed and nothing is paid
            </div>
          </div>
        </div>

        <div style={s.filterBar}>
          <input type="month" style={s.filterSelect} value={month}
            onChange={e => setMonth(e.target.value)} />
          {showPicker && (
            <select style={s.filterSelect} value={companyId} onChange={e => setCompanyId(e.target.value)}>
              <option value="">All companies</option>
              {companies.map(c => <option key={c.id} value={c.id}>{c.name}</option>)}
            </select>
          )}
          <div style={s.totalBadge}>
            {rate ? `1 EUR = ${money(rate.eur)} RSD on ${rate.date}`
              : rateError ? 'No rate' : 'Loading the rate…'}
          </div>
          <div style={s.totalBadge}>{fund.monthHours} h fund</div>
        </div>

        <PayrollMonths companyId={companyId} current={month} onPick={setMonth} />

        {error && <div style={s.error}>{error}</div>}

        {rates.why && (
          <div style={s.error}>
            <b>This month cannot be calculated.</b> {rates.why}
          </div>
        )}

        {rateError && (
          <div style={s.error}>
            The exchange rate for {rateDateFor(month)} could not be read ({rateError}).
            Euro contracts and euro deductions cannot be turned into dinars until it is.
          </div>
        )}

        <div style={fundIsProvenFor(fund) ? s.note : s.warn}>{explainFund(month, fund)}</div>

        {roster.offPayroll.length > 0 && (
          <div style={s.offBox}>
            <div style={s.offTitle}>
              {roster.offPayroll.length} employed and deliberately not on this month
            </div>
            <div style={s.offHint}>
              Their salary is not this company&rsquo;s to work out. Listed rather than
              dropped: somebody quietly absent from a payroll is exactly the error this
              is meant to catch, and an excluded person who is invisible looks the same
              as a forgotten one.
            </div>
            {roster.offPayroll.map(o => (
              <div key={o.employee.id} style={s.offRow}>
                <span style={s.offName}>{o.employee.full_name}</span>
                <span style={s.offWhy}>
                  {absenceLabel(o.absence.reason)} · {o.absence.valid_from} →
                  {' '}{o.absence.valid_to || 'not back yet'}
                </span>
              </div>
            ))}
          </div>
        )}

        {blocking && (
          <div style={s.problems}>
            <div style={s.problemsTitle}>
              This is not a check of anything yet — {roster.problems.length + (result?.problems.length ?? 0)}
              {' '}of {employees.length} could not be calculated
            </div>
            <div style={s.problemsHint}>
              A total that is missing a person agrees with nothing. Fix these on the
              HR Administration page and the figures below become comparable.
            </div>
            {roster.problems.map(p => (
              <div key={p.employee.id} style={s.problemRow}>
                <span style={s.problemName}>{p.employee.full_name}</span>
                <span style={s.problemWhy}>{p.why}</span>
              </div>
            ))}
            {result?.problems.map(p => (
              <div key={p.employeeId} style={s.problemRow}>
                <span style={s.problemName}>{p.name}</span>
                <span style={s.problemWhy}>{p.why}</span>
              </div>
            ))}
          </div>
        )}

        {loading ? (
          <div style={{ padding: '18px 16px' }}>
            <SkeletonRows rows={9} height={15} gap={14}
              widths={[86, 60, 92, 52, 80, 46, 88, 64, 74]} />
          </div>
        ) : !result ? (
          <div style={s.emptyState}>Nothing can be calculated for this month.</div>
        ) : (
          <>
            {total && (
              <div style={s.summaryRow} className="mf-stagger">
                <Card label="Gross" value={money(total.gross)} />
                <Card label="Net" value={money(total.net)} />
                <Card label="Tax and contributions"
                  value={money(total.incomeTax + total.employeeContributions + total.employerContributions)} />
                <Card label="What the month costs" value={money(total.totalCost)} />
              </div>
            )}

            {result.runs.map(run => {
              const count = run.salaries.length + run.otherIncome.length
              const isOpen = open === run.key
              return (
                <div key={run.key} style={s.runCard}>
                  <button style={s.runHead} onClick={() => setOpen(isOpen ? null : run.key)}>
                    <div>
                      <div style={s.runTitle}>
                        {run.label}
                        <span style={s.runCount}>
                          {count} {count === 1 ? 'line' : 'lines'}
                        </span>
                      </div>
                      <div style={s.runDesc}>{RUN_DESCRIPTIONS[run.key]}</div>
                    </div>
                    <div style={{ textAlign: 'right' as const }}>
                      <div style={s.runTotal}>{money(run.totals.totalCost)}</div>
                    </div>
                  </button>

                  {count > 0 && (
                    <div style={s.runState}>
                      {(() => {
                        const sv = savedFor(run.key)
                        if (!sv) {
                          return (
                            <span style={s.stateMuted}>
                              Not calculated yet — nothing is kept for this run
                            </span>
                          )
                        }
                        if (sv.status === 'posted') {
                          return (
                            <span style={s.statePosted}>
                              Posted {sv.posted_at?.slice(0, 10)} and locked. Its figures are
                              what the invoices were written from; delete the posting below
                              to change them.
                            </span>
                          )
                        }
                        return inStep(run) ? (
                          <span style={s.stateOk}>
                            Calculated {sv.calculated_at?.slice(0, 10)} and in step with what
                            is shown
                          </span>
                        ) : (
                          <span style={s.stateStale}>
                            What is kept says {money(Number(sv.total_cost))} and this month
                            now comes to {money(run.totals.totalCost)}. Something behind it
                            has changed — recalculate before posting.
                          </span>
                        )
                      })()}
                      <button
                        style={savedFor(run.key)?.status === 'posted' ? s.disabledSmall : s.primarySmall}
                        disabled={savedFor(run.key)?.status === 'posted' || recalculating === run.key}
                        title={savedFor(run.key)?.status === 'posted'
                          ? 'This run is posted. Delete the posting to unlock it.' : undefined}
                        onClick={() => recalculate(run)}>
                        {recalculating === run.key ? 'Recalculating…' : 'Recalculate'}
                      </button>
                    </div>
                  )}

                  {isOpen && count === 0 && (
                    <div style={s.emptyRun}>Nobody falls into this run this month.</div>
                  )}

                  {isOpen && count > 0 && (
                    <>
                      <div style={s.runTools}>
                        <button style={s.ghostSmall} onClick={() => copyForComparison(run)}>
                          Copy as a table, to paste beside the MPP export
                        </button>
                      </div>
                      <div style={{ overflowX: 'auto' as const }}>
                        <table style={s.table}>
                          <thead>
                            <tr style={s.thead}>
                              <th style={s.th}>Employee</th>
                              <th style={s.thRight}>Hours</th>
                              <th style={s.thRight}>Gross / base</th>
                              <th style={s.thRight}>Tax</th>
                              <th style={s.thRight}>Contrib. employee</th>
                              <th style={s.thRight}>Contrib. employer</th>
                              <th style={s.thRight}>Net</th>
                              <th style={s.thRight}>Deducted</th>
                              <th style={s.thRight}>Total cost</th>
                            </tr>
                          </thead>
                          <tbody>
                            {run.salaries.map((line, i) => (
                              <tr key={line.employeeId}
                                style={{ ...s.tr, background: i % 2 === 0 ? '#0D1B2C' : '#111F30',
                                  cursor: 'pointer' }}
                                title="Open the payslip"
                                onClick={() => setPayslip({ line, runLabel: run.label })}>
                                <td style={s.td}>
                                  <div style={{ fontWeight: '600', fontSize: '13px', color: '#00D47E' }}>
                                    {line.name}
                                  </div>
                                  <div style={s.smallCell}>
                                    {line.code ? `#${line.code} · ` : ''}
                                    {money(line.contractedNet)} contracted
                                    {line.seniorityNet > 0 && `, of which ${money(line.seniorityNet)} seniority`}
                                  </div>
                                </td>
                                <td style={s.tdRight}>
                                  {line.hours}
                                  <div style={s.smallCell}>of {line.monthHours}</div>
                                </td>
                                <td style={s.tdRight}>
                                  {money(line.line.gross)}
                                  {Math.abs(line.line.contributionBase - line.line.gross) > 0.005 && (
                                    <div style={{ ...s.smallCell, color: '#C8A24A' }}
                                      title="Contributions are charged on this, not on the gross — it is above the ceiling">
                                      base {money(line.line.contributionBase)}
                                    </div>
                                  )}
                                </td>
                                <td style={s.tdRight}>{money(line.line.incomeTax)}</td>
                                <td style={s.tdRight}>{money(line.line.employeeContributions)}</td>
                                <td style={s.tdRight}>{money(line.line.employerContributions)}</td>
                                <td style={s.tdRight}><b style={{ color: '#DCE9F6' }}>{money(line.line.net)}</b></td>
                                <td style={s.tdRight}>
                                  {line.deductions.total === 0 ? '—' : (
                                    <>
                                      {money(line.deductions.total)}
                                      {line.deductions.thirdParty > 0 && (
                                        <div style={{ ...s.smallCell, color: '#FF5B5A' }}>
                                          {money(line.deductions.thirdParty)} out
                                        </div>
                                      )}
                                    </>
                                  )}
                                </td>
                                <td style={s.tdRight}><b style={{ color: '#DCE9F6' }}>{money(line.line.totalCost)}</b></td>
                              </tr>
                            ))}
                            {run.otherIncome.map((line, i) => (
                              <tr key={line.employeeId}
                                style={{ ...s.tr, background: i % 2 === 0 ? '#0D1B2C' : '#111F30' }}>
                                <td style={s.td}>
                                  <div style={{ fontWeight: '600', fontSize: '13px', color: '#00D47E' }}>
                                    {line.name}
                                  </div>
                                  <div style={s.smallCell}>{line.code ? `#${line.code}` : ''}</div>
                                </td>
                                <td style={s.tdRight}>—</td>
                                <td style={s.tdRight}>{money(line.line.gross)}</td>
                                <td style={s.tdRight}>{money(line.line.incomeTax)}</td>
                                <td style={s.tdRight}>—</td>
                                <td style={s.tdRight}>—</td>
                                <td style={s.tdRight}><b style={{ color: '#DCE9F6' }}>{money(line.line.net)}</b></td>
                                <td style={s.tdRight}>—</td>
                                <td style={s.tdRight}><b style={{ color: '#DCE9F6' }}>{money(line.line.totalCost)}</b></td>
                              </tr>
                            ))}
                            <tr style={s.totalRow}>
                              <td style={s.td}><b>Total</b></td>
                              <td style={s.tdRight}></td>
                              <td style={s.tdRight}><b>{money(run.totals.gross)}</b></td>
                              <td style={s.tdRight}><b>{money(run.totals.incomeTax)}</b></td>
                              <td style={s.tdRight}><b>{money(run.totals.employeeContributions)}</b></td>
                              <td style={s.tdRight}><b>{money(run.totals.employerContributions)}</b></td>
                              <td style={s.tdRight}><b>{money(run.totals.net)}</b></td>
                              <td style={s.tdRight}>
                                <b>{money(run.totals.deductionsThirdParty + run.totals.deductionsEmployer)}</b>
                              </td>
                              <td style={s.tdRight}><b>{money(run.totals.totalCost)}</b></td>
                            </tr>
                          </tbody>
                        </table>
                      </div>
                    </>
                  )}
                </div>
              )
            })}

            {!blocking && (
              <PayrollPostingPanel
                runs={result.runs}
                people={peopleById}
                month={month}
                companyId={companyId}
                usdRate={rate?.usd ?? null}
                exchangeRate={rate?.eur ?? null}
                savedRuns={saved}
                onPosted={load}
              />
            )}

            {blocking && (
              <div style={s.note}>
                Posting is not offered while anybody is missing from the month. Entries
                written now would have to be unpicked and redone once they are added,
                and an entry matched to a bank payment in the meantime is far harder to
                take back than one that was never made.
              </div>
            )}

          </>
        )}
      </div>
      {payslip && rates.value && (
        <PayslipDialog
          line={payslip.line}
          person={peopleById[payslip.line.employeeId]}
          rates={rates.value}
          seniorityCoefficient={seniorityCoefficient}
          currencyRates={rate ? { EUR: rate.eur } : {}}
          runLabel={payslip.runLabel}
          month={month}
          companyName={companies.find(c => c.id === companyId)?.name || 'All companies'}
          onClose={() => setPayslip(null)}
        />
      )}
    </div>
  )
}

function Card({ label, value }: { label: string; value: string }) {
  return (
    <div style={s.summaryCard}>
      <div style={s.summaryLabel}>{label}</div>
      <div style={s.summaryVal}>{value}</div>
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
  pageSub: { fontSize: '13px', color: '#7A9BB8', maxWidth: '620px', lineHeight: 1.5 },
  filterBar: { display: 'flex', alignItems: 'center', gap: '10px', marginBottom: '1rem', flexWrap: 'wrap' as const },
  filterSelect: { fontFamily: 'system-ui,sans-serif', fontSize: '13px', border: '1px solid rgba(255,255,255,0.075)', borderRadius: '8px', padding: '8px 12px', outline: 'none', background: '#0D1B2C', color: '#DCE9F6', cursor: 'pointer' },
  totalBadge: { fontSize: '13px', color: '#7A9BB8', background: '#0D1B2C', border: '1px solid rgba(255,255,255,0.075)', borderRadius: '8px', padding: '8px 12px', whiteSpace: 'nowrap' as const, fontWeight: '500' },
  summaryRow: { display: 'grid', gridTemplateColumns: 'repeat(5,1fr)', gap: '12px', marginBottom: '1.5rem' },
  summaryCard: { background: '#0D1B2C', border: '1px solid rgba(255,255,255,0.075)', borderRadius: '10px', padding: '14px 16px', boxShadow: '0 4px 20px rgba(0,0,0,0.4)' },
  summaryLabel: { fontSize: '10px', fontWeight: '600', color: 'rgba(255,255,255,0.30)', textTransform: 'uppercase' as const, letterSpacing: '0.08em', marginBottom: '6px' },
  summaryVal: { fontSize: '20px', fontWeight: '600', color: '#DCE9F6', fontVariantNumeric: 'tabular-nums' },
  runCard: { background: '#0D1B2C', border: '1px solid rgba(255,255,255,0.075)', borderRadius: '10px', marginBottom: '12px', overflow: 'hidden', boxShadow: '0 4px 20px rgba(0,0,0,0.4)' },
  runHead: { width: '100%', display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start', gap: '20px', background: 'none', border: 'none', padding: '14px 18px', cursor: 'pointer', textAlign: 'left' as const },
  runTitle: { fontSize: '15px', fontWeight: '600', color: '#DCE9F6', display: 'flex', alignItems: 'baseline', gap: '10px' },
  runCount: { fontSize: '11px', color: '#7A9BB8', fontWeight: '400' },
  runDesc: { fontSize: '11px', color: '#7A9BB8', marginTop: '4px', maxWidth: '560px', lineHeight: 1.5 },
  runTotal: { fontSize: '18px', fontWeight: '600', color: '#DCE9F6', fontVariantNumeric: 'tabular-nums' },
  runState: { display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: '14px', padding: '0 18px 12px' },
  stateMuted: { fontSize: '11px', color: '#5C7894' },
  stateOk: { fontSize: '11px', color: '#00D47E' },
  stateStale: { fontSize: '11px', color: '#D8B96A', lineHeight: 1.5, maxWidth: '620px' },
  statePosted: { fontSize: '11px', color: '#9BC4EC', lineHeight: 1.5, maxWidth: '620px' },
  primarySmall: { background: '#00D47E', color: '#060E1A', border: 'none', borderRadius: '7px', padding: '6px 14px', fontSize: '12px', fontWeight: '500', cursor: 'pointer', whiteSpace: 'nowrap' as const },
  disabledSmall: { background: 'rgba(255,255,255,0.06)', color: '#5C7894', border: 'none', borderRadius: '7px', padding: '6px 14px', fontSize: '12px', cursor: 'not-allowed', whiteSpace: 'nowrap' as const },
  runTools: { padding: '0 18px 10px' },
  emptyRun: { padding: '0 18px 16px', color: '#5C7894', fontSize: '12px' },
  table: { width: '100%', borderCollapse: 'collapse' as const, fontSize: '13px' },
  thead: { background: '#060E1A' },
  th: { padding: '10px 12px', textAlign: 'left' as const, fontSize: '10px', fontWeight: '600', color: 'rgba(255,255,255,0.30)', textTransform: 'uppercase' as const, letterSpacing: '0.08em', borderBottom: '1px solid rgba(255,255,255,0.075)', whiteSpace: 'nowrap' as const },
  thRight: { padding: '10px 12px', textAlign: 'right' as const, fontSize: '10px', fontWeight: '600', color: 'rgba(255,255,255,0.30)', textTransform: 'uppercase' as const, letterSpacing: '0.08em', borderBottom: '1px solid rgba(255,255,255,0.075)', whiteSpace: 'nowrap' as const },
  tr: { borderBottom: '0.5px solid rgba(255,255,255,0.05)' },
  totalRow: { background: '#060E1A', color: '#DCE9F6', borderTop: '1px solid rgba(255,255,255,0.10)' },
  td: { padding: '9px 12px', verticalAlign: 'middle' as const },
  tdRight: { padding: '9px 12px', verticalAlign: 'middle' as const, textAlign: 'right' as const, color: '#7A9BB8', fontVariantNumeric: 'tabular-nums', whiteSpace: 'nowrap' as const },
  smallCell: { fontSize: '11px', color: '#5C7894' },
  emptyState: { padding: '3rem', textAlign: 'center' as const, color: '#7A9BB8', fontSize: '14px' },
  ghostSmall: { background: 'none', color: '#7A9BB8', border: '1px solid rgba(255,255,255,0.10)', borderRadius: '6px', padding: '5px 12px', fontSize: '11px', cursor: 'pointer' },
  error: { background: 'rgba(255,91,90,0.10)', border: '1px solid rgba(255,91,90,0.30)', color: '#FF8E8D', borderRadius: '9px', padding: '11px 14px', fontSize: '12px', lineHeight: 1.55, marginBottom: '14px' },
  warn: { background: 'rgba(200,162,74,0.10)', border: '1px solid rgba(200,162,74,0.30)', color: '#D8B96A', borderRadius: '9px', padding: '11px 14px', fontSize: '12px', lineHeight: 1.55, marginBottom: '14px' },
  note: { background: 'rgba(78,168,255,0.07)', border: '1px solid rgba(78,168,255,0.20)', color: '#9BC4EC', borderRadius: '9px', padding: '11px 14px', fontSize: '12px', lineHeight: 1.55, marginBottom: '14px' },
  offBox: { background: 'rgba(200,162,74,0.07)', border: '1px solid rgba(200,162,74,0.26)', borderRadius: '9px', padding: '12px 14px', marginBottom: '16px' },
  offTitle: { fontSize: '13px', fontWeight: '600', color: '#D8B96A', marginBottom: '4px' },
  offHint: { fontSize: '11px', color: '#B79A57', lineHeight: 1.55, marginBottom: '8px' },
  offRow: { display: 'flex', gap: '8px', alignItems: 'baseline', padding: '3px 0' },
  offName: { color: '#D8B96A', fontWeight: '600', fontSize: '12px', whiteSpace: 'nowrap' as const, minWidth: '170px' },
  offWhy: { fontSize: '11px', color: '#B79A57' },
  problems: { background: 'rgba(255,91,90,0.07)', border: '1px solid rgba(255,91,90,0.28)', borderRadius: '9px', padding: '12px 14px', marginBottom: '16px' },
  problemsTitle: { fontSize: '13px', fontWeight: '600', color: '#FF8E8D', marginBottom: '4px' },
  problemsHint: { fontSize: '11px', color: '#C98C8B', lineHeight: 1.55, marginBottom: '8px' },
  problemRow: { display: 'flex', gap: '8px', alignItems: 'baseline', padding: '3px 0' },
  problemName: { color: '#FF8E8D', fontWeight: '600', fontSize: '12px', whiteSpace: 'nowrap' as const },
  problemWhy: { fontSize: '11px', color: '#C98C8B', lineHeight: 1.45 },
}
