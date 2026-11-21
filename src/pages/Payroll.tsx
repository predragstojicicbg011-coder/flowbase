import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { supabase } from '../supabase'
import { useCompanies } from '../contexts/CompaniesContext'
import { SkeletonRows } from '../components/motion'
import { getBookRates, type BookRates } from '../services/bookAmounts'
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
  rateForMonth, rateBadge, rateNotice, postWaitsForTheTwentieth, convertsForeignAmount,
  UNKNOWN_RATE_DAY,
} from '../services/payroll/payrollRate'
import {
  saveRun, fetchRuns, keptState, kindOf, removeRun, KEPT_TOTAL_DIFFERS,
  type SavedRun, type SaveContext,
} from '../services/payroll/savedRuns'
import {
  monthKind, applyPreliminaryHours, templateProblem, type PreliminaryHoursRow,
} from '../services/payroll/preliminaryHours'
import {
  KEPT_KIND_DIFFERS, KEPT_RUN_EMPTY, PRELIMINARY, NO_DAY_ON_PAYROLL, noticeFor, copyHeading,
  type RunKind,
} from '../services/payroll/preliminaryText'
import { fetchPreliminaryHours } from '../services/payroll/preliminaryHoursStore'
import PayrollComparison from '../components/PayrollComparison'
import PayrollRunPrint from '../components/PayrollRunPrint'
import {
  recapPrint, allPayslipsPrint, payslipPrint, printGaps, NO_GAPS, PAYSLIP_NOT_PRINTABLE, COPY_HEADER,
  type PrintSetting, type PayslipSource,
} from '../services/payroll/payrollPrint'
import PayrollPostingPanel from '../components/PayrollPostingPanel'
import SystemCategoryNotice from '../components/SystemCategoryNotice'
import { useSystemCategories } from '../contexts/SystemCategoriesContext'
import { PAYROLL_ROLES } from '../services/systemCategories'
import PayrollMonths from '../components/PayrollMonths'
import PayslipDialog from '../components/PayslipDialog'
import { fmtNum } from '../utils/formatters'
import { countOf } from '../utils/plural'
import { srDate, monthLongLabel } from '../utils/months'
import { belgradeToday } from '../utils/today'

/**
 * The monthly calculations.
 *
 * WHAT THIS PAGE IS FOR decides how it behaves. FlowBase does not file
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
  const systemCategories = useSystemCategories()
  const [companyId, setCompanyId] = useState<string>('')
  const [month, setMonth] = useState(() => belgradeToday().slice(0, 7))
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
  /** The preliminary hours saved for the running month, as stored. */
  const [savedTemplate, setSavedTemplate] = useState<PreliminaryHoursRow | null>(null)
  const [recalculating, setRecalculating] = useState<string | null>(null)
  /** Bumped whenever a kept run changes, so the months list reads again. */
  const [monthsKey, setMonthsKey] = useState(0)
  const monthsChanged = () => setMonthsKey(k => k + 1)
  const [payslip, setPayslip] = useState<
    { line: SalaryRunLine; run: PayrollRun } | null>(null)

  /** The rate service's answer for the month's 20th, as it came. */
  const [quote, setQuote] = useState<BookRates | null>(null)
  const [rateError, setRateError] = useState<string | null>(null)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)

  const date = monthStart(month)

  const load = useCallback(async () => {
    setLoading(true); setError(null)
    try {
      const [emp, con, ded, set, hol, alloc, abs, ts, add, tpl] = await Promise.all([
        fetchEmployees(supabase, companyId || undefined),
        fetchContracts(supabase),
        fetchDeductions(supabase),
        fetchSettings(supabase),
        fetchHolidays(supabase),
        fetchAllocations(supabase),
        fetchAbsences(supabase),
        fetchTimesheets(supabase, month),
        fetchAdditions(supabase, month),
        // Only the running month has preliminary hours; any other is real.
        month === belgradeToday().slice(0, 7)
          ? fetchPreliminaryHours(supabase, month) : Promise.resolve(null),
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
      setSavedTemplate(tpl)
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
    setQuote(null); setRateError(null)
    getBookRates(rateDateFor(month))
      .then(r => { if (!cancelled) setQuote(r) })
      .catch(e => { if (!cancelled) setRateError(e.message || String(e)) })
    return () => { cancelled = true }
  }, [month])

  /** The rate, the day its list is from, and whether that is the 20th's. */
  const rate = useMemo(
    () => (quote ? rateForMonth(month, holidays, quote, belgradeToday().slice(0, 7)) : null),
    [quote, month, holidays])

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

  // The template is applied only for the running month, and only while it
  // still adds up to the month's fund; otherwise it is said and not used.
  const running = month === belgradeToday().slice(0, 7)
  const templateWhy = savedTemplate && running ? templateProblem(savedTemplate, fund) : null
  const template = savedTemplate && running && !templateWhy ? savedTemplate : null
  const merge = useMemo(() => applyPreliminaryHours({
    month, people: roster.people, timesheets, template, holidays, absences,
  }), [month, roster, timesheets, template, holidays, absences])

  const result = useMemo(() => {
    if (!rates.value) return null
    return runsFor({
      people: roster.people,
      timesheets: merge.timesheets,
      rates: rates.value,
      monthHours: fund.monthHours,
      currencyRates: rate ? { EUR: rate.eur } : {},
      coefficients,
      additions,
      month,
    })
  }, [roster, merge, rates, fund, rate, month, coefficients, additions])

  const money = (n: number) => fmtNum(n)

  /**
   * Why Post waits, or null. A month that converts nothing into dinars does
   * not depend on the rate and may be posted on any day's; one that does is
   * posted only on the 20th's, or its invoices would carry another day's
   * conversion for good.
   */
  const waitsForRate = useMemo(() => {
    if (!rate || rate.ofTheTwentieth) return null
    // This payroll's own: the additions are read for the month across every
    // company, and another company's euro bonus must not hold this one back.
    const onRoster = new Set(roster.people.map(p => p.employee.id))
    const own = additions.filter(a => onRoster.has(a.employee_id))
    return convertsForeignAmount(roster.people, own) ? postWaitsForTheTwentieth(rate) : null
  }, [rate, roster, additions])

  const total = result ? grandTotal(result.runs) : null
  const blocking = (roster.problems.length + (result?.problems.length ?? 0)) > 0

  const savedFor = (key: string) => saved.find(r => r.run_key === key) || null

  /**
   * Preliminary or regular, for the whole month at once.
   *
   * The running month is preliminary while anybody's hours are assumed (the
   * template, or an all-zero row for a person with no day on the payroll);
   * any month is preliminary while it waits for the 20th's rate (it converts
   * an amount that is not in dinars, and its rate is an earlier day's).
   */
  const kind: RunKind = monthKind({
    running,
    onTemplate: merge.onTemplate.length,
    noDays: merge.noDays.length,
    rateSettled: waitsForRate === null,
  })
  const preliminary = kind === 'preliminary'
  /** On the roster with no working day on the payroll: listed, not on hours. */
  const noDayPeople = roster.people.filter(p => merge.noDays.includes(p.employee.id))

  /** The notice above a preliminary month, word for word as the page shows it. */
  const rateHalf = rate && waitsForRate !== null
    ? { day: rate.quotedOn ? srDate(rate.quotedOn) : UNKNOWN_RATE_DAY, twentieth: srDate(rate.twentieth) }
    : null
  const notice = preliminary ? noticeFor({
    onTemplate: merge.onTemplate.length,
    people: roster.people.length,
    noDays: merge.noDays.length,
    rate: rateHalf,
  }) : null

  /**
   * Whether the saved run still says what the calculation says.
   *
   * THE ONE CONDITION FOR POSTING. What lands in the ledger has to be the
   * thing that was kept, and the only way to be sure of that is to insist the
   * two agree at the moment of posting — the same total and the same kind. If
   * an input has moved since, they do not, and Recalculate is the answer
   * rather than a silent choice between two versions of the month. One rule
   * with the posting panel (`keptState`).
   */
  const stateOf = (run: PayrollRun) => keptState(savedFor(run.key), run, kind)

  const peopleById = useMemo(() => {
    const byId: Record<string, typeof roster.people[number]> = {}
    for (const p of roster.people) byId[p.employee.id] = p
    return byId
  }, [roster])

  const recalculate = async (run: PayrollRun) => {
    if (!companyId) { setError('Prvo izaberite jednu firmu.'); return }
    setRecalculating(run.key); setError(null)
    try {
      const kept = savedFor(run.key)
      if (run.salaries.length + run.otherIncome.length === 0) {
        // Nobody is in this run any more. What is kept from an earlier
        // calculation is removed, or it would mark the month for ever.
        if (kept && kept.status === 'draft') await removeRun(supabase, kept)
      } else {
        const context: SaveContext = {
          companyId, month, exchangeRate: rate?.eur ?? null, eurRate: rate?.eur ?? null,
          monthHours: fund.monthHours, people: peopleById, kind,
        }
        await saveRun(supabase, run, context)
      }
      monthsChanged()
      setSaved(await fetchRuns(supabase, companyId, month))
    } catch (e: any) {
      setError(e.message)
    }
    setRecalculating(null)
  }

  const companyName = companies.find(c => c.id === companyId)?.name || 'Sve firme'

  /**
   * Who a printed document leaves out, and whose figures in it the page warns
   * about — by person, from the page's own problems: one person can raise
   * several, and some problems leave the person in the runs.
   */
  const gaps = useMemo(() => (result ? printGaps(roster.problems, result) : NO_GAPS), [roster, result])

  /** What every printed document is handed; the time is the moment of printing. */
  const printSetting = (): PrintSetting => ({
    companyName, month, kind, notice, gaps,
    rate: rate ? { eur: rate.eur, quotedOn: rate.quotedOn } : null,
    now: new Date(),
  })
  const payslipSource = (): PayslipSource | null => (rates.value ? {
    rates: rates.value, seniorityCoefficient,
    currencyRates: rate ? { EUR: rate.eur } : {}, people: peopleById,
  } : null)

  const copyForComparison = (run: PayrollRun) => {
    const rows = [
      // A preliminary month says so on the first line of whatever it is pasted into.
      ...(preliminary ? [copyHeading(monthLongLabel(month))] : []),
      COPY_HEADER.join('\t'),
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
            <div style={s.pageTitle}>Zarade</div>
            <div style={s.pageSub}>
              Kontrolni obračun troška meseca, za poređenje sa MPP-om — ovde se ništa
              ne prijavljuje i ništa ne isplaćuje
            </div>
          </div>
        </div>

        <div style={s.filterBar}>
          <input type="month" style={s.filterSelect} value={month}
            onChange={e => setMonth(e.target.value)} />
          {showPicker && (
            <select style={s.filterSelect} value={companyId} onChange={e => setCompanyId(e.target.value)}>
              <option value="">Sve firme</option>
              {companies.map(c => <option key={c.id} value={c.id}>{c.name}</option>)}
            </select>
          )}
          <div style={s.totalBadge}>
            {rate ? rateBadge(rate, money)
              : rateError ? 'Nema kursa' : 'Učitavanje kursa…'}
          </div>
          <div style={s.totalBadge}>Fond sati: {fund.monthHours} h</div>
        </div>

        <PayrollMonths companyId={companyId} current={month} onPick={setMonth}
          reloadKey={monthsKey} />

        <SystemCategoryNotice what="Zarade" roles={PAYROLL_ROLES}
          map={systemCategories.map} loading={systemCategories.loading} />

        {error && <div style={s.error}>{error}</div>}

        {rates.why && (
          <div style={s.error}>
            <b>Ovaj mesec ne može da se obračuna.</b> {rates.why}
          </div>
        )}

        {/* The preliminary notice carries the rate's day itself when the month
            waits for it, so the rate is not said twice. */}
        {rate && rateNotice(rate) && !(notice && rateHalf) && <div style={s.warn}>{rateNotice(rate)}</div>}

        {rateError && (
          <div style={s.error}>
            Kurs NBS za {srDate(rateDateFor(month))} nije dostupan ({rateError}). Ugovori i
            obustave u evrima ne mogu da se preračunaju u dinare dok se kurs ne učita.
            Pokušajte ponovo kasnije.
          </div>
        )}

        <div style={fundIsProvenFor(fund) ? s.note : s.warn}>{explainFund(month, fund)}</div>

        {templateWhy && <div style={s.warn}>{templateWhy}</div>}

        {roster.offPayroll.length + noDayPeople.length > 0 && (
          <div style={s.offBox}>
            <div style={s.offTitle}>
              Zaposleni koji namerno nisu u obračunu za ovaj mesec: {roster.offPayroll.length + noDayPeople.length}
            </div>
            <div style={s.offHint}>
              Njihovu zaradu ova firma ne obračunava. Navedeni su umesto da budu izostavljeni:
              neko ko tiho nedostaje u obračunu je upravo greška koju ovo treba da uhvati, a
              nevidljiva izuzeta osoba izgleda isto kao zaboravljena.
            </div>
            {roster.offPayroll.map(o => (
              <div key={o.employee.id} style={s.offRow}>
                <span style={s.offName}>{o.employee.full_name}</span>
                <span style={s.offWhy}>
                  {absenceLabel(o.absence.reason)} · {srDate(o.absence.valid_from)} →
                  {' '}{o.absence.valid_to ? srDate(o.absence.valid_to) : 'još nije vraćen'}
                </span>
              </div>
            ))}
            {noDayPeople.map(p => (
              <div key={p.employee.id} style={s.offRow}>
                <span style={s.offName}>{p.employee.full_name}</span>
                <span style={s.offWhy}>{NO_DAY_ON_PAYROLL}</span>
              </div>
            ))}
          </div>
        )}

        {blocking && (
          <div style={s.problems}>
            <div style={s.problemsTitle}>
              Ovo još nije provera — nije obračunato {roster.problems.length + (result?.problems.length ?? 0)}
              {' '}od {employees.length} zaposlenih
            </div>
            <div style={s.problemsHint}>
              Zbir kome nedostaje neko se ni sa čim ne slaže. Ispravite ovo na strani
              Kadrovska evidencija i iznosi ispod postaće uporedivi.
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
          <div style={s.emptyState}>Za ovaj mesec ništa ne može da se obračuna.</div>
        ) : (
          <>
            {notice && <div style={s.warn}>{notice}</div>}

            {/* Drawn only when nobody is missing: a total short of people
                against last month's is every run down and everybody gone.
                Missing means absent from every run, each person once — not
                the page's warnings about people who are in the runs. */}
            {preliminary && (
              <PayrollComparison companyId={companyId} month={month} live={result.runs}
                missing={gaps.missing} />
            )}

            {total && (
              <div style={s.summaryRow} className="mf-stagger">
                <Card label="Bruto" value={money(total.gross)} preliminary={preliminary} />
                <Card label="Neto" value={money(total.net)} preliminary={preliminary} />
                <Card label="Porez i doprinosi"
                  value={money(total.incomeTax + total.employeeContributions + total.employerContributions)}
                  preliminary={preliminary} />
                <Card label="Ukupan trošak meseca" value={money(total.totalCost)} preliminary={preliminary} />
              </div>
            )}

            {result.runs.map(run => {
              const count = run.salaries.length + run.otherIncome.length
              const isOpen = open === run.key
              return (
                <div key={run.key} style={s.runCard}>
                  <div style={s.runTop}>
                    <button style={{ ...s.runHead, flex: 1, minWidth: 0 }}
                      onClick={() => setOpen(isOpen ? null : run.key)}>
                      <div>
                        <div style={s.runTitle}>
                          {run.label}
                          <span style={s.runCount}>
                            {countOf(count, 'stavka', 'stavke', 'stavki')}
                          </span>
                          {preliminary && <span style={s.preliminaryTag}>{PRELIMINARY}</span>}
                        </div>
                        <div style={s.runDesc}>{RUN_DESCRIPTIONS[run.key]}</div>
                      </div>
                      <div style={{ textAlign: 'right' as const }}>
                        <div style={s.runTotal}>{money(run.totals.totalCost)}</div>
                      </div>
                    </button>
                    <PayrollRunPrint run={run}
                      recap={() => recapPrint(printSetting(), run, savedFor(run.key))}
                      payslips={() => {
                        const source = payslipSource()
                        return source
                          ? allPayslipsPrint(printSetting(), run, savedFor(run.key), source)
                          : { ok: false, why: PAYSLIP_NOT_PRINTABLE }
                      }} />
                  </div>

                  {(count > 0 || savedFor(run.key)) && (
                    <div style={s.runState}>
                      {(() => {
                        const sv = savedFor(run.key)
                        const state = stateOf(run)
                        if (!sv || state === 'none') {
                          return (
                            <span style={s.stateMuted}>
                              Još nije obračunato — za ovaj obračun ništa nije sačuvano
                            </span>
                          )
                        }
                        if (state === 'posted') {
                          return (
                            <span style={s.statePosted}>
                              Proknjiženo {sv.posted_at ? srDate(sv.posted_at) : ''} i zaključano.
                              Iz ovih iznosa su napisane fakture; da biste ih menjali, poništite
                              knjiženje ispod.
                            </span>
                          )
                        }
                        if (state === 'empty') {
                          return <span style={s.stateStale}>{KEPT_RUN_EMPTY}</span>
                        }
                        if (state === 'stale_kind') {
                          return <span style={s.stateStale}>{KEPT_KIND_DIFFERS(kindOf(sv), kind)}</span>
                        }
                        return state === 'in_step' ? (
                          <span style={s.stateOk}>
                            Obračunato {sv.calculated_at ? srDate(sv.calculated_at) : ''} i
                            slaže se sa prikazanim
                          </span>
                        ) : (
                          <span style={s.stateStale}>
                            {KEPT_TOTAL_DIFFERS(money(Number(sv.total_cost)), money(run.totals.totalCost))}
                          </span>
                        )
                      })()}
                      <button
                        style={savedFor(run.key)?.status === 'posted' ? s.disabledSmall : s.primarySmall}
                        disabled={savedFor(run.key)?.status === 'posted' || recalculating === run.key}
                        title={savedFor(run.key)?.status === 'posted'
                          ? 'Obračun je proknjižen. Poništite knjiženje da biste ga otključali.' : undefined}
                        onClick={() => recalculate(run)}>
                        {recalculating === run.key ? 'Obračunavanje…' : 'Ponovo obračunaj'}
                      </button>
                    </div>
                  )}

                  {isOpen && count === 0 && (
                    <div style={s.emptyRun}>U ovom mesecu niko ne ulazi u ovaj obračun.</div>
                  )}

                  {isOpen && count > 0 && (
                    <>
                      <div style={s.runTools}>
                        <button style={s.ghostSmall} onClick={() => copyForComparison(run)}>
                          Kopiraj kao tabelu, za poređenje sa izvozom iz MPP-a
                        </button>
                      </div>
                      <div style={{ overflowX: 'auto' as const }}>
                        <table style={s.table}>
                          <thead>
                            <tr style={s.thead}>
                              <th style={s.th}>Zaposleni</th>
                              <th style={s.thRight}>Sati</th>
                              <th style={s.thRight}>Bruto / osnovica</th>
                              <th style={s.thRight}>Porez</th>
                              <th style={s.thRight}>Dopr. zaposlenog</th>
                              <th style={s.thRight}>Dopr. poslodavca</th>
                              <th style={s.thRight}>Neto</th>
                              <th style={s.thRight}>Obustave</th>
                              <th style={s.thRight}>Ukupan trošak</th>
                            </tr>
                          </thead>
                          <tbody>
                            {run.salaries.map((line, i) => (
                              <tr key={line.employeeId}
                                style={{ ...s.tr, background: i % 2 === 0 ? '#0D1B2C' : '#111F30',
                                  cursor: 'pointer' }}
                                title="Otvori platni listić"
                                onClick={() => setPayslip({ line, run })}>
                                <td style={s.td}>
                                  <div style={{ fontWeight: '600', fontSize: '13px', color: '#00D47E' }}>
                                    {line.name}
                                  </div>
                                  <div style={s.smallCell}>
                                    {line.code ? `#${line.code} · ` : ''}
                                    ugovoreno {money(line.contractedNet)}
                                    {line.seniorityNet > 0 && `, od toga minuli rad ${money(line.seniorityNet)}`}
                                  </div>
                                </td>
                                <td style={s.tdRight}>
                                  {line.hours}
                                  <div style={s.smallCell}>od {line.monthHours}</div>
                                </td>
                                <td style={s.tdRight}>
                                  {money(line.line.gross)}
                                  {Math.abs(line.line.contributionBase - line.line.gross) > 0.005 && (
                                    <div style={{ ...s.smallCell, color: '#C8A24A' }}
                                      title="Doprinosi se obračunavaju na ovaj iznos, a ne na bruto — bruto je iznad najviše osnovice doprinosa">
                                      osnovica {money(line.line.contributionBase)}
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
                                          {money(line.deductions.thirdParty)} trećem licu
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
                              <td style={s.td}><b>Ukupno</b></td>
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
                exchangeRate={rate?.eur ?? null}
                waitsForRate={waitsForRate}
                kind={kind}
                savedRuns={saved}
                onPosted={() => { monthsChanged(); load() }}
              />
            )}

            {blocking && (
              <div style={s.note}>
                Knjiženje nije ponuđeno dok neko nedostaje u obračunu meseca. Stavke upisane
                sada morale bi da se ponište i ponovo upišu kada se dodaju, a stavku koja je
                u međuvremenu uparena sa plaćanjem mnogo je teže vratiti nego onu koja nikad
                nije upisana.
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
          runLabel={payslip.run.label}
          month={month}
          companyName={companyName}
          preliminary={preliminary}
          onClose={() => setPayslip(null)}
          onPrint={() => {
            const source = payslipSource()
            return source
              ? payslipPrint(printSetting(), payslip.run, savedFor(payslip.run.key), payslip.line, source)
              : { ok: false, why: PAYSLIP_NOT_PRINTABLE }
          }}
        />
      )}
    </div>
  )
}

function Card({ label, value, preliminary }: { label: string; value: string; preliminary?: boolean }) {
  return (
    <div style={s.summaryCard}>
      <div style={s.summaryLabel}>{label}</div>
      <div style={s.summaryVal}>{value}</div>
      {preliminary && <div style={s.preliminaryLine}>{PRELIMINARY}</div>}
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
  runTop: { display: 'flex', alignItems: 'flex-start' },
  runHead: { width: '100%', display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start', gap: '20px', background: 'none', border: 'none', padding: '14px 18px', cursor: 'pointer', textAlign: 'left' as const },
  runTitle: { fontSize: '15px', fontWeight: '600', color: '#DCE9F6', display: 'flex', alignItems: 'baseline', gap: '10px' },
  runCount: { fontSize: '11px', color: '#7A9BB8', fontWeight: '400' },
  preliminaryTag: { fontSize: '10px', fontWeight: '600', padding: '1px 8px', borderRadius: '20px', background: 'rgba(200,162,74,0.15)', color: '#D8B96A' },
  preliminaryLine: { fontSize: '11px', fontWeight: '600', color: '#D8B96A', marginTop: '4px' },
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
