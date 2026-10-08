import React, { useCallback, useEffect, useMemo, useState } from 'react'
import * as XLSX from 'xlsx'
import { supabase } from '../supabase'
import {
  parseWorkbook, matchEmployees, toTimesheet, projectHoursAboveWorked,
  type ParsedEmployee,
} from '../services/payroll/timesheetImport'
import {
  fetchProjectHours, projectHoursByEmployee, type ProjectHoursRow,
} from '../services/payroll/projectHours'
import { saveTimesheet, checkTimesheet, totalHours, type TimesheetRow } from '../services/payroll/timesheets'
import type { EmployeeForMonth } from '../services/payroll/employees'
import { fundForEmployee, type MonthFund } from '../services/payroll/holidays'
import { countOf, plural } from '../utils/plural'
import { monthLongLabel } from '../utils/months'

/**
 * Reading a month of hours out of the department exports.
 *
 * NOTHING IS SAVED UNTIL THE WHOLE MONTH HAS BEEN SEEN. The files are parsed,
 * matched and checked first, and what lands is exactly what is on screen. An
 * import that writes as it goes leaves half a month in the database and no
 * record of which half.
 *
 * It refuses in three places, and each is a thing that would otherwise be
 * found months later:
 *
 *   a sheet whose own Difference is not zero — it has been edited
 *   a sheet it cannot pair with an employee — guessing puts one person's
 *     hours on another's salary, and both rows look plausible
 *   an employee on the payroll with no sheet at all — a payroll missing a
 *     person is the error this whole module exists to catch
 *
 * What it writes stays editable in the grid afterwards. It is a suggestion;
 * the timesheet is the record.
 */
export default function TimesheetImportDialog({
  month, people, fund, workingDays, onClose, onImported,
}: {
  month: string
  /** The roster for the month, so a missing person can be named. */
  people: EmployeeForMonth[]
  fund: MonthFund
  /** Working days of the month, and how many each person was employed for. */
  workingDays: { total: number; forEmployee: (e: any) => number }
  onClose: () => void
  onImported: () => void
}) {
  const [parsed, setParsed] = useState<{ fileName: string; employees: ParsedEmployee[] }[]>([])
  const [aliases, setAliases] = useState<Record<string, string>>({})
  const [reading, setReading] = useState(false)
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [done, setDone] = useState<string | null>(null)
  /** Hours already on projects this month. An import never touches them. */
  const [projectHours, setProjectHours] = useState<Record<string, ProjectHoursRow[]>>({})

  useEffect(() => {
    fetchProjectHours(supabase, month)
      .then(list => setProjectHours(projectHoursByEmployee(list)))
      .catch(e => setError(e.message))
  }, [month])

  const loadAliases = useCallback(async () => {
    const { data } = await supabase
      .from('payroll_timesheet_aliases').select('file_name, employee_id')
    const map: Record<string, string> = {}
    for (const a of data || []) map[a.file_name] = a.employee_id
    setAliases(map)
  }, [])

  const readFiles = async (files: FileList | null) => {
    if (!files || files.length === 0) return
    setReading(true); setError(null); setDone(null)
    await loadAliases()
    const out: { fileName: string; employees: ParsedEmployee[] }[] = []
    try {
      for (const file of Array.from(files)) {
        const buffer = await file.arrayBuffer()
        const book = XLSX.read(buffer, { type: 'array' })
        const sheets = book.SheetNames.map(name => ({
          name,
          // `raw: false` keeps the durations as the strings the export wrote —
          // "7 days, 0:00:00" and "8:00 (days: 1)" — rather than letting the
          // library turn one of them into a date and lose the day count.
          rows: XLSX.utils.sheet_to_json(book.Sheets[name], {
            header: 1, raw: false, defval: '',
          }) as unknown[][],
        }))
        out.push(parseWorkbook(file.name, sheets))
      }
      setParsed(out)
    } catch (e: any) {
      setError(`Fajl nije pročitan: ${e.message || e}. Proverite da je to izvoz u .xlsx formatu.`)
    }
    setReading(false)
  }

  const allParsed = useMemo(() => parsed.flatMap(f => f.employees), [parsed])

  const matches = useMemo(
    () => matchEmployees(allParsed, people.map(p => p.employee), aliases),
    [allParsed, people, aliases])

  /** What would be written, and what is wrong with it. */
  const rows = useMemo(() => matches.map(m => {
    const person = m.employeeId ? people.find(p => p.employee.id === m.employeeId) : undefined
    const sheet: TimesheetRow | null = m.employeeId
      ? toTimesheet(m.parsed, m.employeeId, month)
      : null
    // THE SHEET'S OWN NOMINAL IS WHAT IT IS HELD TO. Somebody who joined on
    // the 7th has a 144-hour month and a complete timesheet; measuring them
    // against the month's 176 reports 32 hours missing from a month that is
    // finished, which is the kind of complaint that teaches people to ignore
    // the check.
    const ownFund = m.parsed.nominalHours || fund.monthHours
    // And our own calendar has to agree with theirs. If it does not, one of
    // the two is wrong about the month and neither is obviously the one.
    const derived = person
      ? fundForEmployee(fund.monthHours, workingDays.forEmployee(person.employee), workingDays.total)
      : fund.monthHours
    const calendarsDisagree = person && Math.abs(derived - ownFund) > 0.005
      ? [`Po fajlu, fond sati za ovaj mesec je ${ownFund}, a po ovom kalendaru `
        + `${derived} — ${workingDays.forEmployee(person.employee)} od ${workingDays.total} `
        + 'radnih dana. Jedno od ta dva pogrešno vidi mesec.']
      : []

    const problems = [
      ...m.parsed.problems,
      ...(m.employeeId ? [] : ['Nije povezan ni sa jednim zaposlenim u obračunu.']),
      ...calendarsDisagree,
      ...(sheet ? checkTimesheet(sheet, ownFund)
        .filter(p => p.level === 'error').map(p => p.message) : []),
    ]
    return { match: m, person, sheet, problems }
  }), [matches, people, month, fund, workingDays])   // eslint-disable-line react-hooks/exhaustive-deps

  const missing = useMemo(() => {
    const seen = new Set(matches.map(m => m.employeeId).filter(Boolean))
    return people.filter(p => !seen.has(p.employee.id))
  }, [matches, people])

  const blocking = rows.filter(r => r.problems.length > 0)
  const ready = rows.filter(r => r.sheet && r.problems.length === 0)
  /** Worked hours that would fall below the hours already on projects. */
  const belowProjects = projectHoursAboveWorked(ready.map(r => r.sheet!), projectHours)
  const nameOf = (id: string) => people.find(p => p.employee.id === id)?.employee.full_name ?? id

  const link = async (fileName: string, employeeId: string) => {
    if (!employeeId) return
    const companyId = people[0]?.employee.company_id
    if (!companyId) return
    const { error: err } = await supabase.from('payroll_timesheet_aliases')
      .upsert({ company_id: companyId, file_name: fileName, employee_id: employeeId,
        note: 'Povezano pri uvozu meseca.' },
        { onConflict: 'company_id,file_name' })
      .select('id')
    if (err) { setError(`Veza nije sačuvana: ${err.message}`); return }
    // Remembered from now on, so next month pairs by itself.
    setAliases(a => ({ ...a, [fileName]: employeeId }))
  }

  const save = async () => {
    if (blocking.length > 0 || missing.length > 0) return
    setSaving(true); setError(null)
    let written = 0
    for (const r of ready) {
      try {
        await saveTimesheet(supabase, r.sheet!)
        written += 1
      } catch (e: any) {
        setSaving(false)
        setError(`${r.match.parsed.name}: ${e.message} — pre toga je sačuvano ${written}, `
          + 'a ponovni uvoz je bezbedan: svaki mesec ima jedan red po zaposlenom i drugi '
          + 'uvoz ga zamenjuje, a ne dodaje.')
        onImported()
        return
      }
    }
    setSaving(false)
    setDone(`Uvezeno: ${countOf(written, 'evidencija', 'evidencije', 'evidencija')} za ${monthLongLabel(month)}.`)
    onImported()
  }

  const hours = (n: number) => Math.round(n * 100) / 100

  return (
    <div style={s.backdrop} onClick={onClose}>
      <div style={s.dialog} onClick={e => e.stopPropagation()}>
        <div style={s.header}>
          <div>
            <div style={s.title}>Uvoz sati za {monthLongLabel(month)}</div>
            <div style={s.sub}>
              Pet izvoza po odeljenjima. Ništa se ne čuva dok se ceo mesec ne pročita
              bez greške — upisuje se tačno ono što je navedeno ispod.
            </div>
          </div>
          <button style={s.close} onClick={onClose} title="Zatvori" aria-label="Zatvori">✕</button>
        </div>

        <div style={s.body}>
          <input type="file" multiple accept=".xlsx,.xls" style={s.file}
            onChange={e => readFiles(e.target.files)} />

          {reading && <div style={s.muted}>Čitanje…</div>}
          {error && <div style={s.error}>{error}</div>}
          {done && <div style={s.ok}>{done}</div>}

          {parsed.length > 0 && (
            <div style={s.filesLine}>
              {parsed.map(f => (
                <span key={f.fileName} style={s.fileChip}>
                  {f.fileName} · {f.employees.length}
                </span>
              ))}
            </div>
          )}

          {missing.length > 0 && (
            <div style={s.error}>
              <b>{countOf(missing.length, 'zaposleni', 'zaposlena', 'zaposlenih')} iz obračuna{' '}
              {plural(missing.length, 'nema', 'nemaju', 'nema')} list u ovim fajlovima:</b>{' '}
              {missing.map(p => p.employee.full_name).join(', ')}.
              {' '}Obračun zarade bez nekog zaposlenog upravo je greška koju ovaj modul treba
              da uhvati, pa se ništa ne uvozi dok se ne dodaju ili ne uklone iz meseca.
            </div>
          )}

          {belowProjects.length > 0 && (
            <div style={s.error}>
              <b>Sati po projektima:</b> uvoz ne menja sate na projektima, ali je
              {belowProjects.length === 1 ? ' za ovog zaposlenog' : ' za ove zaposlene'} uvezeni
              rad sada manji od sati na projektima —{' '}
              {belowProjects.map(c => `${nameOf(c.employeeId)} (${hours(c.worked)} h rada, `
                + `${hours(c.onProjects)} h na projektima)`).join(', ')}.
              {' '}Knjiženje će odbiti mesec dok se sati po projektima ne isprave u
              evidenciji radnog vremena.
            </div>
          )}

          {rows.length > 0 && (
            <table style={s.table}>
              <thead>
                <tr style={s.thead}>
                  <th style={s.th}>U fajlu</th>
                  <th style={s.th}>Povezano sa</th>
                  <th style={s.thRight}>Rad</th>
                  <th style={s.thRight}>Godišnji odmor</th>
                  <th style={s.thRight}>Bolovanje</th>
                  <th style={s.thRight}>Ukupno</th>
                </tr>
              </thead>
              <tbody>
                {rows.map((r, i) => (
                  <tr key={r.match.parsed.name}
                    style={{ ...s.tr, background: i % 2 === 0 ? '#0D1B2C' : '#111F30' }}>
                    <td style={s.td}>
                      <div style={{ color: '#DCE9F6' }}>{r.match.parsed.name}</div>
                      <div style={s.small}>{r.match.parsed.department || '—'}</div>
                    </td>
                    <td style={s.td}>
                      {r.match.employeeId ? (
                        <>
                          <div style={{ color: '#00D47E' }}>{r.person?.employee.full_name}</div>
                          <div style={s.small}>
                            {r.match.how === 'remembered' ? 'povezano ranije' : 'po imenu'}
                          </div>
                        </>
                      ) : (
                        <select style={s.select} defaultValue=""
                          onChange={e => link(r.match.parsed.name, e.target.value)}>
                          <option value="">— poveži sa —</option>
                          {people.map(p => (
                            <option key={p.employee.id} value={p.employee.id}>
                              {p.employee.full_name}
                            </option>
                          ))}
                        </select>
                      )}
                    </td>
                    <td style={s.tdRight}>{r.sheet ? hours(Number(r.sheet.regular_hours)) : '—'}</td>
                    <td style={s.tdRight}>{hours(r.match.parsed.annualLeaveHours) || '—'}</td>
                    <td style={s.tdRight}>{hours(r.match.parsed.sickLeaveHours) || '—'}</td>
                    <td style={s.tdRight}>
                      <b style={{ color: r.problems.length ? '#FF8E8D' : '#DCE9F6' }}>
                        {r.sheet ? hours(totalHours(r.sheet)) : hours(r.match.parsed.totalHours)}
                      </b>
                      <div style={s.small}>od {r.match.parsed.nominalHours}</div>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}

          {blocking.length > 0 && (
            <div style={s.problems}>
              <div style={s.problemsTitle}>
                {countOf(blocking.length, 'list traži', 'lista traže', 'listova traži')} proveru
              </div>
              {blocking.map(r => (
                <div key={r.match.parsed.name} style={s.problemRow}>
                  <span style={s.problemName}>{r.match.parsed.name}</span>
                  <span style={s.problemWhy}>{r.problems.join(' ')}</span>
                </div>
              ))}
            </div>
          )}
        </div>

        <div style={s.footer}>
          <div style={s.muted}>
            {rows.length > 0 && `Spremno: ${ready.length} od ${rows.length}`}
          </div>
          <div style={{ display: 'flex', gap: '8px' }}>
            <button style={s.ghost} onClick={onClose}>Zatvori</button>
            <button
              style={blocking.length || missing.length || !rows.length ? s.disabled : s.primary}
              disabled={saving || !!blocking.length || !!missing.length || !rows.length}
              onClick={save}>
              {saving ? 'Uvoz…' : `Uvezi ${countOf(ready.length, 'evidenciju', 'evidencije', 'evidencija')}`}
            </button>
          </div>
        </div>
      </div>
    </div>
  )
}

const s: Record<string, React.CSSProperties> = {
  backdrop: { position: 'fixed', inset: 0, background: 'rgba(0,0,0,0.6)', display: 'flex', alignItems: 'center', justifyContent: 'center', zIndex: 1000, padding: '24px' },
  dialog: { background: '#0D1B2C', border: '1px solid rgba(255,255,255,0.09)', borderRadius: '12px', width: '960px', maxWidth: '100%', maxHeight: '90vh', display: 'flex', flexDirection: 'column' as const, fontFamily: "'Inter', system-ui, sans-serif", boxShadow: '0 20px 60px rgba(0,0,0,0.6)' },
  header: { display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start', padding: '18px 22px 12px', borderBottom: '1px solid rgba(255,255,255,0.075)' },
  title: { fontFamily: "'DM Serif Display', Georgia, serif", fontSize: '20px', color: '#DCE9F6' },
  sub: { fontSize: '12px', color: '#7A9BB8', marginTop: '3px', maxWidth: '640px', lineHeight: 1.5 },
  close: { background: 'none', border: 'none', color: '#7A9BB8', fontSize: '15px', cursor: 'pointer' },
  body: { padding: '16px 22px', overflowY: 'auto' as const, flex: 1 },
  footer: { display: 'flex', justifyContent: 'space-between', alignItems: 'center', gap: '8px', padding: '14px 22px', borderTop: '1px solid rgba(255,255,255,0.075)' },
  file: { fontSize: '13px', color: '#DCE9F6', marginBottom: '12px' },
  filesLine: { display: 'flex', gap: '6px', flexWrap: 'wrap' as const, marginBottom: '12px' },
  fileChip: { fontSize: '11px', color: '#7A9BB8', background: 'rgba(255,255,255,0.04)', border: '1px solid rgba(255,255,255,0.08)', borderRadius: '20px', padding: '3px 10px' },
  table: { width: '100%', borderCollapse: 'collapse' as const, fontSize: '13px', marginBottom: '14px' },
  thead: { background: '#060E1A' },
  th: { padding: '9px 10px', textAlign: 'left' as const, fontSize: '10px', fontWeight: '600', color: 'rgba(255,255,255,0.30)', textTransform: 'uppercase' as const, letterSpacing: '0.08em', borderBottom: '1px solid rgba(255,255,255,0.075)' },
  thRight: { padding: '9px 10px', textAlign: 'right' as const, fontSize: '10px', fontWeight: '600', color: 'rgba(255,255,255,0.30)', textTransform: 'uppercase' as const, letterSpacing: '0.08em', borderBottom: '1px solid rgba(255,255,255,0.075)' },
  tr: { borderBottom: '0.5px solid rgba(255,255,255,0.05)' },
  td: { padding: '7px 10px', verticalAlign: 'middle' as const },
  tdRight: { padding: '7px 10px', textAlign: 'right' as const, color: '#7A9BB8', fontVariantNumeric: 'tabular-nums' },
  small: { fontSize: '10.5px', color: '#5C7894', marginTop: '1px' },
  select: { fontFamily: 'system-ui,sans-serif', fontSize: '12px', border: '1px solid rgba(255,91,90,0.35)', borderRadius: '7px', padding: '5px 8px', background: '#060E1A', color: '#DCE9F6', outline: 'none' },
  muted: { fontSize: '12px', color: '#7A9BB8' },
  primary: { background: '#00D47E', color: '#060E1A', border: 'none', borderRadius: '8px', padding: '9px 18px', fontSize: '13px', fontWeight: '500', cursor: 'pointer' },
  disabled: { background: 'rgba(255,255,255,0.06)', color: '#5C7894', border: 'none', borderRadius: '8px', padding: '9px 18px', fontSize: '13px', cursor: 'not-allowed' },
  ghost: { background: 'none', color: '#7A9BB8', border: '1px solid rgba(255,255,255,0.10)', borderRadius: '8px', padding: '9px 16px', fontSize: '13px', cursor: 'pointer' },
  error: { background: 'rgba(255,91,90,0.10)', border: '1px solid rgba(255,91,90,0.30)', color: '#FF8E8D', borderRadius: '9px', padding: '11px 13px', fontSize: '12px', lineHeight: 1.55, marginBottom: '12px' },
  ok: { background: 'rgba(0,212,126,0.08)', border: '1px solid rgba(0,212,126,0.28)', color: '#00D47E', borderRadius: '9px', padding: '11px 13px', fontSize: '12px', marginBottom: '12px' },
  problems: { background: 'rgba(255,91,90,0.07)', border: '1px solid rgba(255,91,90,0.28)', borderRadius: '9px', padding: '11px 13px' },
  problemsTitle: { fontSize: '12px', fontWeight: '600', color: '#FF8E8D', marginBottom: '6px' },
  problemRow: { display: 'flex', gap: '8px', alignItems: 'baseline', padding: '3px 0' },
  problemName: { color: '#FF8E8D', fontWeight: '600', fontSize: '12px', whiteSpace: 'nowrap' as const, minWidth: '150px' },
  problemWhy: { fontSize: '11px', color: '#C98C8B', lineHeight: 1.45 },
}
