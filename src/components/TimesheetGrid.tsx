import React, { useCallback, useEffect, useMemo, useState } from 'react'
import { supabase } from '../supabase'
import {
  fetchTimesheets, saveTimesheet, emptyTimesheet, prefill, checkTimesheet,
  totalHours, workedHours, label, ABSENCES, WORK_FIELDS,
  type TimesheetRow, type HourField,
} from '../services/payroll/timesheets'
import {
  explainFund, fundIsProvenFor, fundForEmployee, type MonthFund,
} from '../services/payroll/holidays'
import type { EmployeeForMonth } from '../services/payroll/employees'
import TimesheetImportDialog from './TimesheetImportDialog'
import ProjectSelect from './ProjectSelect'
import {
  fetchProjectHours, projectHoursByEmployee, saveProjectHours, checkProjectHours,
  assignedHours, mergeProjectHours, unassignedWorkedHours,
} from '../services/payroll/projectHours'
import { OVERHEAD_LABEL } from '../services/projects'

/** One editable row of "Sati po projektima"; hours kept as typed. */
interface ProjectHoursDraft { key: string; project_id: string | null; hours: string }

const toDrafts = (rows: { project_id: string; hours: number }[]): ProjectHoursDraft[] =>
  rows.map((r, i) => ({ key: `${r.project_id}-${i}`, project_id: r.project_id, hours: String(r.hours) }))

const NO_PROJECT_ROWS: ProjectHoursDraft[] = []

const fromDrafts = (rows: ProjectHoursDraft[]) =>
  rows.map(r => ({ project_id: r.project_id, hours: parseFloat(r.hours.replace(',', '.')) || 0 }))

/**
 * The hours of one month, for everybody on it.
 *
 * EDITED IN A GRID, SAVED A ROW AT A TIME. Twenty-five people times six
 * figures is a spreadsheet's worth of typing, and a single Save at the bottom
 * would mean one refused write loses the lot. Each row is saved when it is
 * left, and says so.
 *
 * An hour in the wrong column, or missing altogether, becomes a salary that
 * looks deliberate. So the arithmetic that CAN be checked — do the hours add
 * up to the month — is shown on every row, all the time, rather than at the
 * moment somebody tries to calculate.
 */
export default function TimesheetGrid({ people, month, fund, workingDays }: {
  people: EmployeeForMonth[]
  /** `YYYY-MM`. */
  month: string
  /** The month's hours — from the settings if entered, else from the calendar. */
  fund: MonthFund
  /** Working days of the month, and how many each person was employed for. */
  workingDays: { total: number; forEmployee: (e: any) => number }
}) {
  const monthHours = fund.monthHours

  /**
   * The fund to hold one person to.
   *
   * Not the month's, when they were not here for all of it. Somebody who
   * joined on the 7th has a smaller month and a complete timesheet, and
   * measuring them against the whole fund reports hours missing from a month
   * that is finished.
   */
  const fundFor = useCallback((p: EmployeeForMonth) =>
    fundForEmployee(monthHours, workingDays.forEmployee(p.employee), workingDays.total),
  [monthHours, workingDays])
  const [rows, setRows] = useState<Record<string, TimesheetRow>>({})
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const [savingId, setSavingId] = useState<string | null>(null)
  const [savedId, setSavedId] = useState<string | null>(null)
  const [dirty, setDirty] = useState<Record<string, boolean>>({})
  const [importing, setImporting] = useState(false)
  const [showRare, setShowRare] = useState(false)
  /** Sati po projektima, by employee, as stored. */
  const [projectRows, setProjectRows] = useState<Record<string, ProjectHoursDraft[]>>({})
  /** Whose project section is open. */
  const [openProjects, setOpenProjects] = useState<string | null>(null)

  const loadProjectHours = useCallback(async () => {
    const list = await fetchProjectHours(supabase, month)
    const by = projectHoursByEmployee(list)
    const out: Record<string, ProjectHoursDraft[]> = {}
    for (const [id, r] of Object.entries(by)) out[id] = toDrafts(mergeProjectHours(r))
    setProjectRows(out)
  }, [month])

  useEffect(() => {
    let cancelled = false
    setLoading(true); setError(null)
    Promise.all([fetchTimesheets(supabase, month), loadProjectHours()])
      .then(([list]) => {
        if (cancelled) return
        const byEmployee: Record<string, TimesheetRow> = {}
        for (const t of list) byEmployee[t.employee_id] = t
        setRows(byEmployee); setDirty({})
      })
      .catch(e => { if (!cancelled) setError(e.message) })
      .finally(() => { if (!cancelled) setLoading(false) })
    return () => { cancelled = true }
  }, [month, loadProjectHours])

  const rowFor = (employeeId: string): TimesheetRow =>
    rows[employeeId] || emptyTimesheet(employeeId, month)

  const set = (employeeId: string, field: HourField, value: string) => {
    // Kept as typed while the cell is being edited — parsing on every
    // keystroke turns "1" into 1 and makes "1.5" impossible to type.
    setRows(r => ({ ...r, [employeeId]: { ...rowFor(employeeId), [field]: value as any } }))
    setDirty(d => ({ ...d, [employeeId]: true }))
  }

  const save = async (employeeId: string) => {
    if (!dirty[employeeId]) return
    setSavingId(employeeId); setError(null)
    try {
      await saveTimesheet(supabase, rowFor(employeeId))
      // Saved either way — the hours are what they are — but a worked figure
      // now below the hours already on projects is said at once, not at posting.
      const who = people.find(p => p.employee.id === employeeId)?.employee.full_name
      const clash = checkProjectHours(
        fromDrafts(projectRows[employeeId] || NO_PROJECT_ROWS), workedHours(rowFor(employeeId)), who)
      if (clash) setError(clash)
      setDirty(d => ({ ...d, [employeeId]: false }))
      setSavedId(employeeId)
      window.setTimeout(() => setSavedId(cur => (cur === employeeId ? null : cur)), 1600)
    } catch (e: any) {
      setError(e.message)
    }
    setSavingId(null)
  }

  const fillTheMonth = async () => {
    const without = people.filter(p => !rows[p.employee.id])
    if (without.length === 0) return
    if (!window.confirm(
      `Give ${without.length} ${without.length === 1 ? 'person' : 'people'} a full month — `
      + `${fund.workableHours} ordinary hours`
      + (fund.holidayHours > 0 ? ` and ${fund.holidayHours} of public holiday` : '')
      + '? Anybody who already has hours is left alone.')) return

    setError(null)
    const added: Record<string, TimesheetRow> = {}
    for (const p of without) {
      const share = workingDays.total > 0
        ? workingDays.forEmployee(p.employee) / workingDays.total : 1
      const t = prefill(p.employee.id, month, round2(fund.workableHours * share))
      t.holiday_hours = round2(fund.holidayHours * share)
      try {
        await saveTimesheet(supabase, t)
        added[p.employee.id] = t
      } catch (e: any) {
        setError(`${p.employee.full_name}: ${e.message} — the ones before them were saved.`)
        break
      }
    }
    setRows(r => ({ ...r, ...added }))
  }

  const summary = useMemo(() => {
    let worked = 0, withHours = 0, failing = 0
    for (const p of people) {
      const t = rows[p.employee.id]
      if (!t) continue
      withHours += 1
      worked += workedHours(t)
      if (checkTimesheet(t, fundFor(p)).some(x => x.level === 'error')) failing += 1
    }
    return { worked, withHours, failing, missing: people.length - withHours }
  }, [people, rows, fundFor])

  /**
   * Which columns to draw.
   *
   * Fifteen categories is a spreadsheet, and most months use five of them. The
   * rare ones appear once anybody has hours in them, so a month that uses one
   * never hides it — hidden hours in a payroll are the thing this grid exists
   * to prevent.
   */
  const usedRare = new Set<string>()
  for (const p of people) {
    const t = rows[p.employee.id]
    if (!t) continue
    for (const a of ABSENCES) {
      if (!a.common && Number((t as any)[a.field]) > 0) usedRare.add(a.field)
    }
  }
  const columns = [
    ...WORK_FIELDS,
    ...ABSENCES.filter(a => a.common || showRare || usedRare.has(a.field)).map(a => a.field),
  ] as HourField[]

  if (loading) return <div style={s.empty}>Loading the hours…</div>

  return (
    <div>
      {error && <div style={s.error}>{error}</div>}

      <div style={fundIsProvenFor(fund) ? s.note : s.warn}>
        {explainFund(month, fund)}
        <div style={{ marginTop: '6px', opacity: 0.85 }}>
          Each kind of absence is paid at its own coefficient from the settings — sick
          leave at the employer&rsquo;s expense at 65%, the full-fund kind at 100%, a work
          stoppage at 60%. The source files cannot tell them apart, so which sick leave
          it was has to be entered here.
        </div>
        {fund.holidays.length > 0 && (
          <div style={{ marginTop: '6px', opacity: 0.85 }}>
            Put those {fund.holidayHours} hours in the <b>Public holiday</b> column, not in
            the worked ones — they are paid without being worked, and a run that could not
            tell them apart would have to guess.
          </div>
        )}
      </div>

      <div style={s.bar}>
        <div style={s.barStat}>
          <b>{summary.withHours}</b> of {people.length} have hours
          {summary.missing > 0 && <span style={{ color: '#FF8E8D' }}> · {summary.missing} missing</span>}
          {summary.failing > 0 && <span style={{ color: '#FF8E8D' }}> · {summary.failing} do not add up</span>}
        </div>
        <div style={s.barStat}>
          <b>{round(summary.worked)}</b> hours worked
        </div>
        <button style={s.ghost} onClick={() => setImporting(true)}>
          Import from the department exports
        </button>
        <button style={{ ...s.ghost, marginLeft: 0 }} onClick={() => setShowRare(v => !v)}>
          {showRare ? 'Hide the rare absences' : `Show all ${ABSENCES.length} absences`}
        </button>
        <button style={{ ...s.ghost, marginLeft: 0 }} onClick={fillTheMonth}
          disabled={summary.missing === 0}>
          Fill the {summary.missing} missing with a full month
        </button>
      </div>

      {importing && (
        <TimesheetImportDialog
          month={month} people={people} fund={fund} workingDays={workingDays}
          onClose={() => setImporting(false)}
          onImported={() => {
            // Re-read rather than patch: what is on screen after an import
            // should be what is stored, not what the import believed it wrote.
            // Project hours are not touched by an import; they are re-read
            // too, so a worked figure that fell below them shows at once.
            Promise.all([fetchTimesheets(supabase, month), loadProjectHours()]).then(([list]) => {
              const byEmployee: Record<string, TimesheetRow> = {}
              for (const t of list) byEmployee[t.employee_id] = t
              setRows(byEmployee); setDirty({})
            }).catch(e => setError(e.message))
          }}
        />
      )}

      <div style={s.tableWrap}>
        <table style={s.table}>
          <thead>
            <tr style={s.thead}>
              <th style={s.th}>Employee</th>
              {columns.map(f => (
                <th key={f} style={s.thRight}>
                  {label(f)}
                </th>
              ))}
              <th style={s.thRight}>Total</th>
              <th style={s.th}>Projekti</th>
              <th style={s.th}>Against the month</th>
            </tr>
          </thead>
          <tbody>
            {people.map((p, i) => {
              const t = rowFor(p.employee.id)
              const has = !!rows[p.employee.id]
              const rowFund = fundFor(p)
              const problems = has ? checkTimesheet(t, rowFund) : []
              const bad = problems.some(x => x.level === 'error')
              const pRows = projectRows[p.employee.id] || NO_PROJECT_ROWS
              const onProjects = assignedHours(fromDrafts(pRows))
              const projectProblem = checkProjectHours(fromDrafts(pRows), workedHours(t))
              const isOpen = openProjects === p.employee.id
              return (
                <React.Fragment key={p.employee.id}>
                <tr
                  style={{ ...s.tr, background: i % 2 === 0 ? '#0D1B2C' : '#111F30' }}>
                  <td style={s.td}>
                    <div style={{ fontWeight: '600', fontSize: '13px', color: '#00D47E' }}>
                      {p.employee.full_name}
                    </div>
                    <div style={s.smallCell}>
                      {p.employee.organisational_unit || '—'}
                    </div>
                  </td>
                  {columns.map(f => (
                    <td key={f} style={s.tdInput}>
                      <input
                        style={{
                          ...s.cell,
                          ...(bad ? s.cellBad : {}),
                        }}
                        inputMode="decimal"
                        value={String(t[f] ?? '')}
                        onChange={e => set(p.employee.id, f, e.target.value)}
                        onBlur={() => save(p.employee.id)}
                        onKeyDown={e => { if (e.key === 'Enter') (e.target as HTMLInputElement).blur() }}
                      />
                    </td>
                  ))}
                  <td style={s.tdRight}>
                    <b style={{ color: bad ? '#FF8E8D' : '#DCE9F6' }}>{round(totalHours(t))}</b>
                    {rowFund !== monthHours && (
                      <div style={s.smallCell} title="Part of the month — they joined or left in it">
                        of {round(rowFund)}
                      </div>
                    )}
                  </td>
                  <td style={s.td}>
                    <button
                      style={{ ...s.projBtn, ...(projectProblem ? s.projBtnBad : {}) }}
                      title={projectProblem || 'Sati po projektima'}
                      onClick={() => setOpenProjects(isOpen ? null : p.employee.id)}>
                      {round(onProjects)} / {round(workedHours(t))} h {isOpen ? '▴' : '▾'}
                    </button>
                  </td>
                  <td style={s.td}>
                    {savingId === p.employee.id ? <span style={s.smallCell}>Saving…</span>
                      : savedId === p.employee.id ? <span style={s.ok}>Saved</span>
                      : dirty[p.employee.id] ? <span style={s.smallCell}>Unsaved</span>
                      : !has ? <span style={s.missing}>No hours entered</span>
                      : problems.length === 0 ? <span style={s.ok}>Adds up</span>
                      : <span style={problems[0].level === 'error' ? s.badText : s.warnText}
                          title={problems.map(x => x.message).join('\n\n')}>
                          {problems[0].message}
                        </span>}
                  </td>
                </tr>
                {isOpen && (
                  <tr style={{ background: '#0A1626' }}>
                    <td colSpan={columns.length + 4} style={{ padding: '10px 14px 14px' }}>
                      <ProjectHoursEditor
                        companyId={p.employee.company_id}
                        employeeId={p.employee.id}
                        name={p.employee.full_name}
                        month={month}
                        worked={workedHours(t)}
                        absenceHours={round(totalHours(t) - workedHours(t))}
                        stored={pRows}
                        onSaved={next => setProjectRows(r => ({ ...r, [p.employee.id]: next }))}
                      />
                    </td>
                  </tr>
                )}
                </React.Fragment>
              )
            })}
          </tbody>
        </table>
      </div>
    </div>
  )
}

/**
 * "Sati po projektima" for one person and month: rows of (project, hours),
 * what they leave unassigned, and where that goes.
 */
function ProjectHoursEditor({
  companyId, employeeId, name, month, worked, absenceHours, stored, onSaved,
}: {
  companyId: string
  employeeId: string
  name: string
  month: string
  /** regular_hours: the most that can be on projects. */
  worked: number
  /** Every other hour on the timesheet — never project work. */
  absenceHours: number
  stored: ProjectHoursDraft[]
  onSaved: (rows: ProjectHoursDraft[]) => void
}) {
  const [draft, setDraft] = useState<ProjectHoursDraft[]>(stored)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [saved, setSaved] = useState(false)
  useEffect(() => { setDraft(stored) }, [stored])

  const parsed = fromDrafts(draft)
  const onProjects = assignedHours(parsed)
  const rest = unassignedWorkedHours(parsed, worked)
  const problem = checkProjectHours(parsed, worked, name)
  const duplicate = draft.some((r, i) => r.project_id
    && draft.findIndex(o => o.project_id === r.project_id) !== i)

  const update = (key: string, patch: Partial<ProjectHoursDraft>) => {
    setDraft(d => d.map(r => (r.key === key ? { ...r, ...patch } : r))); setSaved(false)
  }
  const add = () => {
    setDraft(d => [...d, { key: `new-${Date.now()}-${d.length}`, project_id: null, hours: '' }])
    setSaved(false)
  }
  const remove = (key: string) => { setDraft(d => d.filter(r => r.key !== key)); setSaved(false) }

  const save = async () => {
    setBusy(true); setError(null)
    try {
      // A row with neither a project nor hours is simply not stored.
      const rows = parsed.filter(r => r.project_id || r.hours > 0)
      await saveProjectHours(supabase, { companyId, employeeId, month, worked, rows })
      onSaved(toDrafts(mergeProjectHours(rows).filter(r => r.hours > 0)))
      setSaved(true)
    } catch (e: any) {
      setError(e.message)
    }
    setBusy(false)
  }

  return (
    <div>
      <div style={s.projTitle}>Sati po projektima — {name}</div>
      {draft.length === 0 && (
        <div style={s.smallCell}>
          Nijedan projekat: ceo trošak ovog meseca ide u {OVERHEAD_LABEL}.
        </div>
      )}
      {draft.map(r => (
        <div key={r.key} style={s.projRow}>
          <div style={{ width: '280px' }}>
            <ProjectSelect value={r.project_id} onChange={v => update(r.key, { project_id: v })} />
          </div>
          <input style={s.cell} inputMode="decimal" value={r.hours} placeholder="0"
            aria-label="Sati"
            onChange={e => update(r.key, { hours: e.target.value })} />
          <span style={s.smallCell}>h</span>
          <button style={s.projRemove} title="Ukloni" aria-label="Ukloni"
            onClick={() => remove(r.key)}>&times;</button>
        </div>
      ))}
      <div style={{ ...s.smallCell, margin: '8px 0', lineHeight: 1.6 }}>
        Na projektima <b style={{ color: problem ? '#FF8E8D' : '#DCE9F6' }}>{round(onProjects)} h</b>
        {' '}od {round(worked)} h rada.
        {rest > 0 && <> Ostatak od {round(rest)} h ide u {OVERHEAD_LABEL}.</>}
        {absenceHours > 0 && (
          <> Odsustva ({round(absenceHours)} h — praznik, godišnji odmor, bolovanje…) nisu rad
            na projektu: njihov deo troška takođe ide u {OVERHEAD_LABEL}.</>
        )}
      </div>
      {(problem || duplicate || error) && (
        <div style={s.error}>
          {error || problem || 'Isti projekat je naveden dva puta — sati će biti sabrani.'}
        </div>
      )}
      <div style={{ display: 'flex', gap: '8px', alignItems: 'center' }}>
        <button style={{ ...s.ghost, marginLeft: 0 }} onClick={add}>+ Dodaj projekat</button>
        <button style={{ ...s.ghost, marginLeft: 0, color: '#00D47E' }} onClick={save}
          disabled={busy || !!problem}>
          {busy ? 'Čuvanje…' : 'Sačuvaj sate po projektima'}
        </button>
        {saved && <span style={s.ok}>Sačuvano</span>}
      </div>
    </div>
  )
}

const round = (n: number) => Math.round(n * 100) / 100
const round2 = round

const s: Record<string, React.CSSProperties> = {
  empty: { padding: '3rem', textAlign: 'center' as const, color: '#7A9BB8', fontSize: '14px' },
  error: { background: 'rgba(255,91,90,0.10)', border: '1px solid rgba(255,91,90,0.30)', color: '#FF8E8D', borderRadius: '9px', padding: '11px 14px', fontSize: '12px', lineHeight: 1.55, marginBottom: '14px' },
  note: { background: 'rgba(78,168,255,0.07)', border: '1px solid rgba(78,168,255,0.20)', color: '#9BC4EC', borderRadius: '9px', padding: '11px 14px', fontSize: '12px', lineHeight: 1.55, marginBottom: '14px' },
  warn: { background: 'rgba(200,162,74,0.10)', border: '1px solid rgba(200,162,74,0.30)', color: '#D8B96A', borderRadius: '9px', padding: '11px 14px', fontSize: '12px', lineHeight: 1.55, marginBottom: '14px' },
  bar: { display: 'flex', alignItems: 'center', gap: '18px', marginBottom: '12px', flexWrap: 'wrap' as const },
  barStat: { fontSize: '12px', color: '#7A9BB8' },
  ghost: { background: 'none', color: '#7A9BB8', border: '1px solid rgba(255,255,255,0.10)', borderRadius: '8px', padding: '7px 14px', fontSize: '12px', cursor: 'pointer', marginLeft: 'auto' },
  tableWrap: { background: '#0D1B2C', border: '1px solid rgba(255,255,255,0.075)', borderRadius: '10px', overflowX: 'auto' as const, boxShadow: '0 4px 20px rgba(0,0,0,0.4)' },
  table: { width: '100%', borderCollapse: 'collapse' as const, fontSize: '13px' },
  thead: { background: '#060E1A' },
  th: { padding: '11px 12px', textAlign: 'left' as const, fontSize: '10px', fontWeight: '600', color: 'rgba(255,255,255,0.30)', textTransform: 'uppercase' as const, letterSpacing: '0.08em', borderBottom: '1px solid rgba(255,255,255,0.075)', whiteSpace: 'nowrap' as const },
  thRight: { padding: '11px 12px', textAlign: 'right' as const, fontSize: '10px', fontWeight: '600', color: 'rgba(255,255,255,0.30)', textTransform: 'uppercase' as const, letterSpacing: '0.08em', borderBottom: '1px solid rgba(255,255,255,0.075)', whiteSpace: 'nowrap' as const },
  tr: { borderBottom: '0.5px solid rgba(255,255,255,0.05)' },
  td: { padding: '8px 12px', verticalAlign: 'middle' as const },
  tdInput: { padding: '6px 6px', verticalAlign: 'middle' as const },
  tdRight: { padding: '8px 12px', verticalAlign: 'middle' as const, textAlign: 'right' as const, color: '#7A9BB8', fontVariantNumeric: 'tabular-nums' },
  cell: { width: '62px', boxSizing: 'border-box' as const, textAlign: 'right' as const, fontFamily: 'system-ui,sans-serif', fontSize: '13px', fontVariantNumeric: 'tabular-nums', border: '1px solid rgba(255,255,255,0.075)', borderRadius: '6px', padding: '6px 8px', background: '#060E1A', color: '#DCE9F6', outline: 'none' },
  cellBad: { borderColor: 'rgba(255,91,90,0.40)' },
  projBtn: { background: 'none', border: '1px solid rgba(255,255,255,0.10)', borderRadius: '6px', padding: '4px 8px', fontSize: '11px', color: '#9BC4EC', cursor: 'pointer', whiteSpace: 'nowrap' as const, fontVariantNumeric: 'tabular-nums' },
  projBtnBad: { borderColor: 'rgba(255,91,90,0.40)', color: '#FF8E8D' },
  projTitle: { fontSize: '12px', fontWeight: '600', color: '#DCE9F6', marginBottom: '8px' },
  projRow: { display: 'flex', alignItems: 'center', gap: '8px', marginBottom: '6px' },
  projRemove: { background: 'none', border: 'none', color: '#FF8E8D', fontSize: '16px', cursor: 'pointer' },
  smallCell: { fontSize: '11px', color: '#7A9BB8' },
  ok: { fontSize: '11px', color: '#00D47E' },
  missing: { fontSize: '11px', color: '#C8A24A' },
  badText: { fontSize: '11px', color: '#FF8E8D', display: 'block', maxWidth: '320px', lineHeight: 1.45, cursor: 'help' },
  warnText: { fontSize: '11px', color: '#D8B96A', display: 'block', maxWidth: '320px', lineHeight: 1.45, cursor: 'help' },
}
