import React, { useCallback, useEffect, useMemo, useState } from 'react'
import { supabase } from '../supabase'
import { useCompanies } from '../contexts/CompaniesContext'
import { SkeletonRows } from '../components/motion'
import { getRatesForDate } from '../services/currencyService'
import { fetchSettings, monthStart, numberFor, type SettingRow } from '../services/payroll/settings'
import {
  fetchEmployees, fetchContracts, fetchDeductions,
  fetchAllocations, fetchAbsences, employeesForMonth, absenceLabel,
  splitDeductions, rateDateFor,
  type EmployeeRow, type ContractRow, type DeductionRow,
  type CostAllocationRow, type AbsenceRow,
  type EmployeeForMonth,
} from '../services/payroll/employees'
import {
  fetchHolidays, fundFor, workingDaysFor, type HolidayRow,
} from '../services/payroll/holidays'
import EmployeeDialog from '../components/EmployeeDialog'
import TimesheetGrid from '../components/TimesheetGrid'
import AdditionsTab from '../components/AdditionsTab'
import { fmtLocal, fmtNum } from '../utils/formatters'

/**
 * HR administration.
 *
 * WHAT IS ON SCREEN IS A MONTH, not a list of people. Everything — the salary,
 * the seniority, the deductions, the exchange rate — is shown as
 * it stood in the month picked at the top, because that is the only form in
 * which any of it can be checked against the accountant's figures. A page
 * showing "the current salary" would answer a question nobody here is asking
 * and would quietly disagree with every past payroll.
 *
 * The complaints panel is deliberately loud. Somebody with no contract for the
 * month, or a euro contract with no rate for it, is simply absent from a run
 * otherwise — and a payroll that is missing a person is exactly the error this
 * module exists to catch, so it must not be the thing the module hides.
 */
/**
 * A line in the employee list.
 *
 * EVERY EMPLOYEE IS A LINE, whatever state they are in. A record that exists
 * and that no screen can reach is worse than one that was never made: it comes
 * back as a duplicate-key error the next time somebody tries to create the
 * same person, and nothing tells them why.
 *
 * Three states, and only the first produces any money:
 *
 *   on payroll   a contract covers the month
 *   off payroll  employed, deliberately excluded — maternity leave and its kin
 *   unpayable    something is missing, and `why` says what
 */
type Row =
  | { employee: EmployeeRow; person: EmployeeForMonth; absence: null; why: null }
  | { employee: EmployeeRow; person: null; absence: AbsenceRow; why: null }
  | { employee: EmployeeRow; person: null; absence: null; why: string }

export default function HR() {
  const { companies, showPicker } = useCompanies()
  const [companyId, setCompanyId] = useState<string>('')
  const [month, setMonth] = useState(() => new Date().toISOString().slice(0, 7))

  const [employees, setEmployees] = useState<EmployeeRow[]>([])
  const [contracts, setContracts] = useState<ContractRow[]>([])
  const [deductions, setDeductions] = useState<DeductionRow[]>([])
  const [allocations, setAllocations] = useState<CostAllocationRow[]>([])
  const [absences, setAbsences] = useState<AbsenceRow[]>([])
  const [settings, setSettings] = useState<SettingRow[]>([])
  const [holidays, setHolidays] = useState<HolidayRow[]>([])

  const [rate, setRate] = useState<{ eur: number; date: string } | null>(null)
  const [rateError, setRateError] = useState<string | null>(null)

  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const [search, setSearch] = useState('')
  const [dialogFor, setDialogFor] = useState<EmployeeRow | null | undefined>(undefined)
  const [tab, setTab] = useState<'people' | 'hours' | 'additions'>('people')

  const date = monthStart(month)

  const load = useCallback(async () => {
    setLoading(true); setError(null)
    try {
      const [emp, con, ded, set, hol, alloc, abs] = await Promise.all([
        fetchEmployees(supabase, companyId || undefined),
        fetchContracts(supabase),
        fetchDeductions(supabase),
        fetchSettings(supabase),
        fetchHolidays(supabase),
        fetchAllocations(supabase),
        fetchAbsences(supabase),
      ])
      setEmployees(emp); setContracts(con); setDeductions(ded)
      setSettings(set); setHolidays(hol)
      setAllocations(alloc); setAbsences(abs)
    } catch (e: any) {
      setError(e.message)
    }
    setLoading(false)
  }, [companyId])

  useEffect(() => { load() }, [load])

  // The rate of the 20th, which is the one the payslips use.
  useEffect(() => {
    let cancelled = false
    setRate(null); setRateError(null)
    getRatesForDate(rateDateFor(month))
      .then(r => { if (!cancelled) setRate({ eur: r.eurRsdRate, date: r.date }) })
      .catch(e => { if (!cancelled) setRateError(e.message || String(e)) })
    return () => { cancelled = true }
  }, [month])

  const seniorityCoefficient = numberFor(settings, 'seniority_coefficient', date)
  // A setting for the month wins; otherwise it is the weekdays, with the
  // holidays counted inside the fund rather than taken off it.
  const fund = useMemo(() => fundFor(
    month, holidays,
    numberFor(settings, 'month_hours', date),
    numberFor(settings, 'holiday_hours', date),
  ), [month, holidays, settings, date])

  const roster = useMemo(() => employeesForMonth(
    employees, contracts, deductions,
    {
      date,
      seniorityCoefficient: seniorityCoefficient ?? 0,
      rates: rate ? { EUR: rate.eur } : {},
    },
    allocations, absences,
  ), [employees, contracts, deductions, date, seniorityCoefficient, rate,
      allocations, absences])

  /**
   * Everybody employed this month, on the payroll or not.
   *
   * SOMEBODY OFF THE PAYROLL IS STILL AN EMPLOYEE AND STILL HAS A RECORD. When
   * they only appeared as a line in a banner there was no way to open them at
   * all — their file existed and nothing on screen could reach it, which reads
   * as the person having been lost rather than excluded. They are rows here,
   * marked, with dashes where the money would be.
   */
  const everyone: Row[] = useMemo(() => ([
    ...roster.people.map(p => ({ employee: p.employee, person: p, absence: null, why: null })),
    ...roster.offPayroll.map(o => ({ employee: o.employee, person: null, absence: o.absence, why: null })),
    // The ones nothing can be calculated for. They used to appear only as a
    // line in the red panel, so a newly created employee — who has no contract
    // yet by definition — was saved and then vanished.
    ...roster.problems.map(p => ({ employee: p.employee, person: null, absence: null, why: p.why })),
  ] as Row[]).sort((a, b) => a.employee.full_name.localeCompare(b.employee.full_name)),
  [roster])

  /**
   * Employed by the company but outside this month entirely.
   *
   * Somebody hired in October is not in September's roster at all, so creating
   * them while looking at September would leave nothing on screen — the same
   * disappearance, by a different route.
   */
  const outsideMonth = useMemo(() => {
    const inMonth = new Set(everyone.map(r => r.employee.id))
    return employees.filter(e => !inMonth.has(e.id))
  }, [employees, everyone])

  const shown = everyone.filter(r => !search
    || r.employee.full_name.toLowerCase().includes(search.toLowerCase())
    || (r.employee.code || '').toLowerCase().includes(search.toLowerCase())
    || (r.employee.organisational_unit || '').toLowerCase().includes(search.toLowerCase()))

  const money = (n: number) => fmtNum(n)

  const totals = useMemo(() => {
    let net = 0, thirdParty = 0, employerHeld = 0
    for (const p of roster.people) {
      net += p.net.total
      const split = splitDeductions(p.deductions, p.net.total)
      thirdParty += split.thirdParty
      employerHeld += split.employer
    }
    return { net, thirdParty, employerHeld }
  }, [roster])

  return (
    <div style={s.root} className="app-surface">
      <div style={s.body}>
        <div style={s.pageHeader}>
          <div>
            <div style={s.pageTitle}>HR administration</div>
            <div style={s.pageSub}>
              Employees, their contracts and their deductions, as they stood in the month shown
            </div>
          </div>
          <button style={s.newBtn} onClick={() => setDialogFor(null)}>+ New employee</button>
        </div>

        <div style={s.tabs}>
          {([['people', 'Employees'], ['hours', 'Timesheets'],
             ['additions', 'Additions']] as const).map(([k, lbl]) => (
            <button key={k} style={{ ...s.tab, ...(tab === k ? s.tabOn : {}) }}
              onClick={() => setTab(k)}>{lbl}</button>
          ))}
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
          {tab === 'people' && (
            <input style={s.searchInput} placeholder="Search by name, code or unit"
              value={search} onChange={e => setSearch(e.target.value)} />
          )}
          <div style={s.totalBadge}>
            {rate
              ? `1 EUR = ${money(rate.eur)} RSD on ${rate.date}`
              : rateError ? 'No rate' : 'Loading the rate…'}
          </div>
        </div>

        {error && <div style={s.error}>{error}</div>}

        {rateError && (
          <div style={s.error}>
            The exchange rate for {rateDateFor(month)} could not be read ({rateError}).
            Euro contracts cannot be shown in dinars until it is — a salary converted at a
            guessed rate would look exactly like a checked one.
          </div>
        )}

        {seniorityCoefficient === null && tab === 'people' && (
          <div style={s.warn}>
            The payroll settings have no seniority coefficient for {date}, so the split
            between base pay and seniority is not shown. Set it on the Payroll tab in
            Settings; until then the contracted totals below are still correct, but the
            figures a run would compare against MPP are not available.
          </div>
        )}

        {roster.problems.length > 0 && (
          <div style={s.problems}>
            <div style={s.problemsTitle}>
              {roster.problems.length} {roster.problems.length === 1 ? 'person is' : 'people are'} missing
              from this month
            </div>
            <div style={s.problemsHint}>
              A payroll run must not be posted while this list has anything in it — somebody
              silently left out is exactly the error a check against the accountant is meant
              to catch, and the check would agree with itself.
            </div>
            {roster.problems.map(p => (
              <div key={p.employee.id} style={s.problemRow}>
                <button style={s.problemName} onClick={() => setDialogFor(p.employee)}>
                  {p.employee.full_name}
                </button>
                <span style={s.problemWhy}>{p.why}</span>
              </div>
            ))}
          </div>
        )}

        {outsideMonth.length > 0 && tab === 'people' && (
          <div style={s.offNote}>
            {outsideMonth.length} {outsideMonth.length === 1 ? 'employee is' : 'employees are'}
            {' '}outside {month} altogether — hired later, or already gone:{' '}
            {outsideMonth.map(e => (
              <button key={e.id} style={s.linkName} onClick={() => setDialogFor(e)}>
                {e.full_name}
              </button>
            ))}
            . Change the month above to see them in place.
          </div>
        )}

        {roster.offPayroll.length > 0 && tab === 'people' && (
          <div style={s.offNote}>
            {roster.offPayroll.length === 1
              ? `${roster.offPayroll[0].employee.full_name} is`
              : `${roster.offPayroll.length} people are`} employed this month and
            deliberately not on the payroll — their salary is not this company&rsquo;s to
            work out. They are in the list below, marked, and open like anybody else.
          </div>
        )}

        {tab === 'additions' ? (
          <AdditionsTab month={month} people={roster.people} eurRate={rate?.eur ?? null} />
        ) : tab === 'hours' ? (
          <TimesheetGrid people={roster.people} month={month} fund={fund}
            workingDays={workingDaysFor(month, holidays)} />
        ) : (
        <>
        <div style={s.summaryRow} className="mf-stagger">
          <Card label="On the payroll" value={String(roster.people.length)}
            note={roster.offPayroll.length > 0
              ? `+ ${roster.offPayroll.length} off payroll` : undefined} />
          <Card label="Contracted net, RSD" value={money(totals.net)} />
          <Card label="Deducted to third parties" value={money(totals.thirdParty)} />
          <Card label="Deducted, kept by employer" value={money(totals.employerHeld)} />
        </div>

        <div style={s.tableWrap}>
          {loading ? (
            <div style={{ padding: '18px 16px' }}>
              <SkeletonRows rows={8} height={15} gap={14}
                widths={[86, 62, 92, 54, 80, 48, 88, 64]} />
            </div>
          ) : shown.length === 0 ? (
            <div style={s.emptyState}>
              {employees.length === 0
                ? 'No employees yet. Add the first one with the button above.'
                : 'Nobody matches this month and these filters.'}
            </div>
          ) : (
            <table style={s.table}>
              <thead>
                <tr style={s.thead}>
                  <th style={s.th}>Employee</th>
                  <th style={s.th}>Unit</th>
                  <th style={s.th}>Contract</th>
                  <th style={s.thRight}>Contracted net, RSD</th>
                  <th style={s.thRight}>Base</th>
                  <th style={s.thRight}>Seniority</th>
                  <th style={s.thRight}>Deductions</th>
                  <th style={s.th}></th>
                </tr>
              </thead>
              <tbody>
                {shown.map((r, i) => {
                  const p = r.person
                  const ded = p ? splitDeductions(p.deductions, p.net.total) : null
                  return (
                    <tr key={r.employee.id}
                      style={{
                        ...s.tr,
                        background: i % 2 === 0 ? '#0D1B2C' : '#111F30',
                        cursor: 'pointer',
                        ...(r.absence || r.why ? { opacity: 0.72 } : {}),
                      }}
                      onClick={() => setDialogFor(r.employee)}>
                      <td style={s.td}>
                        <div style={{ fontWeight: '600', fontSize: '13px',
                          color: r.why ? '#FF8E8D' : r.absence ? '#D8B96A' : '#00D47E' }}>
                          {r.employee.full_name}
                        </div>
                        <div style={s.smallCell}>
                          {r.employee.code ? `#${r.employee.code}` : 'no code'}
                          {r.absence && (
                            <span style={s.offBadge} title={absenceLabel(r.absence.reason)}>
                              {absenceLabel(r.absence.reason).split(' —')[0]}
                            </span>
                          )}
                          {r.why && <span style={s.needsBadge}>Nothing to calculate</span>}
                        </div>
                      </td>
                      <td style={s.td}>
                        <span style={s.smallCell}>{r.employee.organisational_unit || '—'}</span>
                      </td>
                      <td style={s.td}>
                        {p ? (
                          <>
                            <div style={s.smallCell}>
                              {fmtLocal(p.contract.net_amount, p.contract.currency)}
                            </div>
                            <div style={{ ...s.smallCell, color: '#5C7894' }}>
                              from {p.contract.valid_from} · {p.serviceYears}
                              {p.serviceYears === 1 ? ' year' : ' years'}
                              {!p.serviceYearsDerived && <span title="Entered by hand on the contract"> ✎</span>}
                            </div>
                          </>
                        ) : r.absence ? (
                          <div style={{ ...s.smallCell, color: '#B79A57' }}>
                            {r.absence.valid_from} → {r.absence.valid_to || 'not back yet'}
                          </div>
                        ) : (
                          <div style={{ ...s.smallCell, color: '#C98C8B', maxWidth: '340px' }}>
                            {r.why}
                          </div>
                        )}
                      </td>
                      <td style={s.tdRight}>
                        {p ? <b style={{ color: '#DCE9F6' }}>{money(p.net.total)}</b> : '—'}
                      </td>
                      <td style={s.tdRight}>
                        {p && seniorityCoefficient !== null ? money(p.net.base) : '—'}
                      </td>
                      <td style={s.tdRight}>
                        {p && seniorityCoefficient !== null ? money(p.net.seniority) : '—'}
                      </td>
                      <td style={s.tdRight}>
                        {!ded || ded.total === 0 ? '—' : (
                          <>
                            <div>{money(ded.total)}</div>
                            {ded.thirdParty > 0 && (
                              <div style={{ ...s.smallCell, color: '#FF5B5A' }}>
                                {money(ded.thirdParty)} out
                              </div>
                            )}
                          </>
                        )}
                      </td>
                      <td style={s.td}></td>
                    </tr>
                  )
                })}
              </tbody>
            </table>
          )}
        </div>
        </>
        )}
      </div>

      {dialogFor !== undefined && (
        <EmployeeDialog
          employee={dialogFor}
          companies={companies}
          seniorityCoefficient={seniorityCoefficient}
          onClose={() => setDialogFor(undefined)}
          onSaved={() => { setDialogFor(undefined); load() }}
        />
      )}
    </div>
  )
}

function Card({ label, value, note }: { label: string; value: string; note?: string }) {
  return (
    <div style={s.summaryCard}>
      <div style={s.summaryLabel}>{label}</div>
      <div style={s.summaryVal}>{value}</div>
      {note && <div style={s.summaryNote}>{note}</div>}
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
  newBtn: { background: '#00D47E', color: '#060E1A', border: 'none', borderRadius: '8px', padding: '9px 18px', fontSize: '13px', fontWeight: '500', cursor: 'pointer', boxShadow: '0 2px 8px rgba(0,212,126,0.3)' },
  tabs: { display: 'flex', gap: '4px', borderBottom: '1px solid rgba(255,255,255,0.075)', marginBottom: '14px' },
  tab: { background: 'none', border: 'none', borderBottom: '2px solid transparent', color: '#7A9BB8', fontSize: '13px', padding: '8px 14px', cursor: 'pointer' },
  tabOn: { color: '#00D47E', borderBottom: '2px solid #00D47E' },
  filterBar: { display: 'flex', alignItems: 'center', gap: '10px', marginBottom: '1rem', flexWrap: 'wrap' as const },
  searchInput: { fontFamily: 'system-ui,sans-serif', fontSize: '13px', border: '1px solid rgba(255,255,255,0.075)', borderRadius: '8px', padding: '8px 12px', outline: 'none', background: '#0D1B2C', color: '#DCE9F6', flex: '1', minWidth: '200px' },
  filterSelect: { fontFamily: 'system-ui,sans-serif', fontSize: '13px', border: '1px solid rgba(255,255,255,0.075)', borderRadius: '8px', padding: '8px 12px', outline: 'none', background: '#0D1B2C', color: '#DCE9F6', cursor: 'pointer' },
  totalBadge: { fontSize: '13px', color: '#7A9BB8', background: '#0D1B2C', border: '1px solid rgba(255,255,255,0.075)', borderRadius: '8px', padding: '8px 12px', whiteSpace: 'nowrap' as const, fontWeight: '500' },
  summaryRow: { display: 'grid', gridTemplateColumns: 'repeat(4,1fr)', gap: '12px', marginBottom: '1.5rem' },
  summaryCard: { background: '#0D1B2C', border: '1px solid rgba(255,255,255,0.075)', borderRadius: '10px', padding: '14px 16px', boxShadow: '0 4px 20px rgba(0,0,0,0.4)' },
  summaryLabel: { fontSize: '10px', fontWeight: '600', color: 'rgba(255,255,255,0.30)', textTransform: 'uppercase' as const, letterSpacing: '0.08em', marginBottom: '6px' },
  summaryVal: { fontSize: '22px', fontWeight: '600', color: '#DCE9F6' },
  tableWrap: { background: '#0D1B2C', border: '1px solid rgba(255,255,255,0.075)', borderRadius: '10px', overflow: 'hidden', boxShadow: '0 4px 20px rgba(0,0,0,0.4)' },
  table: { width: '100%', borderCollapse: 'collapse' as const, fontSize: '13px' },
  thead: { background: '#060E1A' },
  th: { padding: '11px 12px', textAlign: 'left' as const, fontSize: '10px', fontWeight: '600', color: 'rgba(255,255,255,0.30)', textTransform: 'uppercase' as const, letterSpacing: '0.08em', borderBottom: '1px solid rgba(255,255,255,0.075)', whiteSpace: 'nowrap' as const },
  thRight: { padding: '11px 12px', textAlign: 'right' as const, fontSize: '10px', fontWeight: '600', color: 'rgba(255,255,255,0.30)', textTransform: 'uppercase' as const, letterSpacing: '0.08em', borderBottom: '1px solid rgba(255,255,255,0.075)', whiteSpace: 'nowrap' as const },
  tr: { borderBottom: '0.5px solid rgba(255,255,255,0.05)' },
  td: { padding: '10px 12px', verticalAlign: 'middle' as const },
  tdRight: { padding: '10px 12px', verticalAlign: 'middle' as const, textAlign: 'right' as const, color: '#7A9BB8', fontVariantNumeric: 'tabular-nums' },
  emptyState: { padding: '3rem', textAlign: 'center' as const, color: '#7A9BB8', fontSize: '14px' },
  smallCell: { fontSize: '11px', color: '#7A9BB8' },
  error: { background: 'rgba(255,91,90,0.10)', border: '1px solid rgba(255,91,90,0.30)', color: '#FF8E8D', borderRadius: '9px', padding: '11px 14px', fontSize: '12px', lineHeight: 1.55, marginBottom: '14px' },
  warn: { background: 'rgba(200,162,74,0.10)', border: '1px solid rgba(200,162,74,0.30)', color: '#D8B96A', borderRadius: '9px', padding: '11px 14px', fontSize: '12px', lineHeight: 1.55, marginBottom: '14px' },
  offNote: { background: 'rgba(200,162,74,0.07)', border: '1px solid rgba(200,162,74,0.26)', borderRadius: '9px', padding: '10px 13px', fontSize: '12px', color: '#D8B96A', lineHeight: 1.55, marginBottom: '14px' },
  needsBadge: { fontSize: '9px', fontWeight: '700', padding: '1px 7px', borderRadius: '20px', background: 'rgba(255,91,90,0.13)', color: '#FF8E8D', marginLeft: '6px' },
  linkName: { background: 'none', border: 'none', color: '#D8B96A', fontWeight: '600', fontSize: '12px', cursor: 'pointer', padding: '0 4px', textDecoration: 'underline' },
  offBadge: { fontSize: '9px', fontWeight: '700', padding: '1px 7px', borderRadius: '20px', background: 'rgba(200,162,74,0.15)', color: '#D8B96A', marginLeft: '6px' },
  summaryNote: { fontSize: '10.5px', color: '#B79A57', marginTop: '3px' },
  problems: { background: 'rgba(255,91,90,0.07)', border: '1px solid rgba(255,91,90,0.28)', borderRadius: '9px', padding: '12px 14px', marginBottom: '16px' },
  problemsTitle: { fontSize: '13px', fontWeight: '600', color: '#FF8E8D', marginBottom: '4px' },
  problemsHint: { fontSize: '11px', color: '#C98C8B', lineHeight: 1.55, marginBottom: '8px' },
  problemRow: { display: 'flex', gap: '8px', alignItems: 'baseline', padding: '3px 0' },
  problemName: { background: 'none', border: 'none', color: '#FF8E8D', fontWeight: '600', fontSize: '12px', cursor: 'pointer', padding: 0, textDecoration: 'underline' },
  problemWhy: { fontSize: '11px', color: '#C98C8B' },
}
