import {
  payslipPrint, allPayslipsPrint, recapPrint, printStateLine,
  PRINT_FOOT, STATE_NOT_KEPT, RECAP_TOTALS, recapDisagrees, notInPrint, printedAt,
  printGaps, figuresIncomplete, NO_GAPS, CONTRIBUTION_BASE_LEGEND, RECAP_DEDUCTION_HEADER,
  COPY_HEADER, PAYSLIP_SHEET, NO_RATE_IN_FOOT, payslipRefused, NOT_ON_ROSTER,
  type PrintSetting, type PayslipSource, type PrintGaps,
} from './payrollPrint'
import { payslipFor, payslipSections, payslipHours, PAYSLIP_COST_LABEL } from './payslip'
import {
  employeesForMonth, type EmployeeRow, type ContractRow, type DeductionRow,
} from './employees'
import { runsFor, type PayrollRun } from './runs'
import { RATES_2026 } from './engine'
import { emptyTimesheet, type TimesheetRow } from './timesheets'
import type { SavedRun } from './savedRuns'
import { KEPT_TOTAL_DIFFERS, POSTED_DIFFERS } from './savedRuns'
import type { AdditionRow } from './additions'
import { PRELIMINARY, PAYSLIP_TITLE, PAYSLIP_TITLE_PRELIMINARY } from './preliminaryText'
import { RATE_BADGE } from './payrollRate'
import { brand } from '../../config/brand'
import { fmtNum } from '../../utils/formatters'

// Invented people on invented round contracts, calculated for real.
const person = (n: number, name: string, over: Partial<EmployeeRow> = {}): EmployeeRow => ({
  id: `emp-${n}`, company_id: 'co-1', code: `E-00${n}`, full_name: name, organisational_unit: 'Jedinica A',
  hired_on: '2025-01-01', seniority_from: '2025-01-01', left_on: null, note: null, ...over,
})
const contract = (e: EmployeeRow, net: number): ContractRow => ({
  id: `con-${e.id}`, employee_id: e.id, valid_from: '2025-01-01', valid_to: null, currency: 'RSD',
  net_amount: net, service_years: 0, note: null,
})
const A = person(1, 'Osoba A')
const B = person(2, 'Osoba B')
const C = person(3, 'Osoba C')
const DEDUCTION: DeductionRow = {
  id: 'ded-1', employee_id: B.id, label: 'Obustava A', goes_to: 'third_party', payee: 'Primalac A',
  amount: 1000, currency: 'RSD', percent_of_net: null, valid_from: '2025-01-01', valid_to: null, note: null,
}
const OTHER: AdditionRow = {
  id: 'add-1', employee_id: A.id, month: '2026-11-01', kind: 'bonus', label: 'Naknada A',
  treatment: 'other_income', amount: 5000, currency: 'RSD', note: null,
}

function calculate(people: EmployeeRow[], contracts: ContractRow[], deductions: DeductionRow[] = [],
  additions: AdditionRow[] = []) {
  const roster = employeesForMonth(people, contracts, deductions,
    { date: '2026-11-01', seniorityCoefficient: 0, rates: {} })
  const timesheets = Object.fromEntries(people.map(p =>
    [p.id, { ...emptyTimesheet(p.id, '2026-11'), regular_hours: 168 }]))
  const result = runsFor({
    people: roster.people, timesheets, rates: RATES_2026, monthHours: 168, month: '2026-11',
    coefficients: {}, additions,
  })
  const byId = Object.fromEntries(roster.people.map(p => [p.employee.id, p]))
  return { roster, result, byId }
}

const { result, byId } = calculate([A, B, C],
  [contract(A, 100000), contract(B, 80000), contract(C, 60000)], [DEDUCTION], [OTHER])
const REGULAR = result.runs.find(r => r.key === 'regular')!
const OTHER_RUN = result.runs.find(r => r.key === 'other')!

const SOURCE: PayslipSource = { rates: RATES_2026, seniorityCoefficient: 0, currencyRates: {}, people: byId }
const NOW = new Date('2026-11-20T13:05:00Z')

const setting = (over: Partial<PrintSetting> = {}): PrintSetting => ({
  companyName: 'Firma A', month: '2026-11', kind: 'regular', notice: null, gaps: NO_GAPS,
  rate: { eur: 117, quotedOn: '2026-11-20' }, now: NOW, ...over,
})
const kept = (over: Partial<SavedRun> = {}): SavedRun => ({
  id: 'run-1', company_id: 'co-1', period_month: '2026-11-01', run_key: 'regular', label: 'Zarade',
  status: 'draft', exchange_rate: 117, eur_rate: 117, month_hours: 168,
  gross: REGULAR.totals.gross, net: REGULAR.totals.net, income_tax: REGULAR.totals.incomeTax,
  contributions_employee: REGULAR.totals.employeeContributions,
  contributions_employer: REGULAR.totals.employerContributions,
  total_cost: REGULAR.totals.totalCost, deductions_third_party: REGULAR.totals.deductionsThirdParty,
  deductions_employer: REGULAR.totals.deductionsEmployer,
  calculated_at: '2026-11-18T09:00:00Z', posted_at: null, note: null, kind: 'regular', ...over,
})

const html = (o: { ok: true; html: string } | { ok: false; why: string }): string => {
  if (!o.ok) throw new Error(`refused: ${o.why}`)
  return o.html
}
const parse = (s: string) => new DOMParser().parseFromString(s, 'text/html')
const text = (el: Element | null) => (el?.textContent ?? '').replace(/\s+/g, ' ').trim()
const gaps = (missing: number, incomplete = 0): PrintGaps => ({ missing, incomplete, whyFor: {} })
const FOOT_TEXT = `${PRINT_FOOT(brand.appName)} ${RATE_BADGE(fmtNum(117), '20.11.2026.')} · `
  + 'Štampano 20.11.2026. u 14:05, po beogradskom vremenu'

// ── A heavy month, calculated for real: leave, sick leave and a holiday,
// both kinds of deduction and a bonus on one person; a person above the
// contribution ceiling; and the people the page cannot calculate.
const R = person(5, 'Osoba R')
const H = person(6, 'Osoba H')
const R_DEDUCTIONS: DeductionRow[] = [
  { ...DEDUCTION, id: 'ded-r1', employee_id: R.id, label: 'Osiguranje A', goes_to: 'third_party' },
  { ...DEDUCTION, id: 'ded-r2', employee_id: R.id, label: 'Pozajmica A', goes_to: 'employer', payee: null, amount: 2000 },
]
const R_BONUS: AdditionRow = {
  id: 'add-r', employee_id: R.id, month: '2026-11-01', kind: 'bonus', label: 'Bonus A',
  treatment: 'salary', amount: 10000, currency: 'RSD', note: null,
}
const COEFFICIENTS = { godisnji_odmor: 1, bolovanje_na_teret_poslodavca: 0.65, drzavni_i_verski_praznik: 1 }
function heavy(extra: { people?: EmployeeRow[]; contracts?: ContractRow[]; timesheets?: Record<string, TimesheetRow> } = {}) {
  const people = [R, H, ...(extra.people ?? [])]
  const roster = employeesForMonth(people,
    [contract(R, 150000), contract(H, 2000000), ...(extra.contracts ?? [])], R_DEDUCTIONS,
    { date: '2026-11-01', seniorityCoefficient: 0.004, rates: {} })
  const result = runsFor({
    people: roster.people,
    timesheets: {
      [R.id]: { ...emptyTimesheet(R.id, '2026-11'), regular_hours: 120,
        vacation_hours: 24, sick_hours: 16, holiday_hours: 8 },
      [H.id]: { ...emptyTimesheet(H.id, '2026-11'), regular_hours: 168 },
      ...(extra.timesheets ?? {}),
    },
    rates: RATES_2026, monthHours: 168, month: '2026-11', coefficients: COEFFICIENTS,
    additions: [R_BONUS],
  })
  return { roster, result, byId: Object.fromEntries(roster.people.map(p => [p.employee.id, p])) }
}
const HEAVY = heavy()
const HEAVY_REGULAR = HEAVY.result.runs.find(r => r.key === 'regular')!
const HEAVY_SOURCE: PayslipSource = { ...SOURCE, seniorityCoefficient: 0.004, people: HEAVY.byId }

describe('who is not in a document, and whose figures are incomplete', () => {
  const D = person(7, 'Osoba D')
  const E = person(8, 'Osoba E')
  const G = person(9, 'Osoba G')
  const month = heavy({
    people: [D, E, G],
    contracts: [contract(D, 50000), contract(E, 50000)],
    timesheets: {
      // E: hours of a kind the settings do not price — still calculated.
      [E.id]: { ...emptyTimesheet(E.id, '2026-11'), regular_hours: 160, paid_leave_hours: 8 },
      // D has no timesheet — left out. G has no contract — not on the roster.
    },
  })
  const found = printGaps(month.roster.problems, month.result)

  it('counts the people absent from every run, once each, and the people in it with a warning', () => {
    expect(found.missing).toBe(2)
    expect(found.incomplete).toBe(1)
    expect(Object.keys(found.whyFor)).toEqual([E.id])
    expect(found.whyFor[E.id]).toEqual(month.result.problems.filter(p => p.employeeId === E.id).map(p => p.why))
  })

  it('the documents say both, and a payslip says its own person\'s problem', () => {
    const run = month.result.runs.find(r => r.key === 'regular')!
    const d = parse(html(recapPrint(setting({ gaps: found }), run, null)))
    expect(text(d.querySelector('.missing'))).toBe(notInPrint(2))
    expect(text(d.querySelector('.incomplete'))).toBe(figuresIncomplete(1))
    const lineE = run.salaries.find(l => l.employeeId === E.id)!
    const slip = parse(html(payslipPrint(setting({ gaps: found }), run, null, lineE,
      { ...HEAVY_SOURCE, people: month.byId })))
    expect(text(slip.querySelector('.own-problems'))).toBe(found.whyFor[E.id].join(' '))
    const other = run.salaries.find(l => l.employeeId === H.id)!
    const slipH = parse(html(payslipPrint(setting({ gaps: found }), run, null, other,
      { ...HEAVY_SOURCE, people: month.byId })))
    expect(slipH.querySelector('.own-problems')).toBeNull()
  })

  it('in words', () => {
    expect(figuresIncomplete(1)).toBe('Iznosi su nepotpuni za 1 zaposlenog: strana navodi zašto.')
    expect(figuresIncomplete(2)).toBe('Iznosi su nepotpuni za 2 zaposlena: strana navodi zašto.')
    expect(notInPrint(1)).toBe('1 zaposleni nije obračunat i nije u ovom dokumentu.')
    expect(notInPrint(3)).toBe('3 zaposlena nisu obračunata i nisu u ovom dokumentu.')
    expect(notInPrint(5)).toBe('5 zaposlenih nije obračunato i nije u ovom dokumentu.')
  })
})

describe('a heavy payslip on one sheet', () => {
  it('fits A4 portrait under the running head and foot', () => {
    const line = HEAVY_REGULAR.salaries.find(l => l.employeeId === R.id)!
    const s = html(payslipPrint(
      setting({
        kind: 'preliminary',
        notice: 'Preliminarno: na pretpostavljenim satima obračunato je 3 od 12 zaposlenih. 1 zaposleni bez ijednog radnog dana u obračunu ovog meseca nema evidenciju radnog vremena. Iznosi u evrima preračunati su po kursu od 14.11.2026., a ne po kursu za 20.11.2026.',
        gaps: { missing: 2, incomplete: 1, whyFor: { [line.employeeId]: ['Razlog koji strana daje, otprilike dug kao najduži koji daje, pa prelazi u drugi red lista i zauzima još jedan red teksta ispod.'] } },
      }),
      HEAVY_REGULAR, kept({ status: 'posted', posted_at: '2026-11-19T10:00:00Z', total_cost: 1 }), line, HEAVY_SOURCE))
    const doc = parse(s)
    const css = doc.querySelector('style')!.textContent!
    expect(css).toContain(`@page { size: A4 portrait; margin: ${PAYSLIP_SHEET.marginMm}mm; }`)
    expect(css).toContain(`.section td, .section th { padding: ${PAYSLIP_SHEET.rowPadMm}mm 1.5mm; line-height: ${PAYSLIP_SHEET.lineMm}mm; }`)
    expect(css).toContain(`.space-top { height: ${PAYSLIP_SHEET.headMm}mm; }`)
    expect(css).toContain(`.space-foot { height: ${PAYSLIP_SHEET.footMm}mm; }`)
    const usable = 297 - 2 * PAYSLIP_SHEET.marginMm - PAYSLIP_SHEET.headMm - PAYSLIP_SHEET.footMm
    const row = PAYSLIP_SHEET.lineMm + 2 * PAYSLIP_SHEET.rowPadMm
    const rows = doc.querySelectorAll('table.section tr').length
    const blocks = Array.from(doc.querySelectorAll('section.page .block'))
    const blockMm = blocks.reduce((mm, b) =>
      mm + Math.ceil(text(b).length / PAYSLIP_SHEET.charsPerLine) * PAYSLIP_SHEET.blockLineMm + PAYSLIP_SHEET.blockMm, 0)
    expect(rows).toBeGreaterThan(30)
    expect(blocks.length).toBeGreaterThanOrEqual(8)
    expect(rows * row + blockMm).toBeLessThanOrEqual(usable)
  })
})

describe('the contribution base in italics', () => {
  it('a payslip that uses it says why, and one that does not says nothing', () => {
    const lineH = HEAVY_REGULAR.salaries.find(l => l.employeeId === H.id)!
    expect(lineH.line.contributionBase).not.toBe(lineH.line.gross)
    const d = parse(html(payslipPrint(setting(), HEAVY_REGULAR, null, lineH, HEAVY_SOURCE)))
    expect(d.querySelectorAll('table.section tr.hl')).toHaveLength(1)
    expect(text(d.querySelector('.legend'))).toBe(CONTRIBUTION_BASE_LEGEND)
    const plain = parse(html(payslipPrint(setting(), REGULAR, null, REGULAR.salaries[0], SOURCE)))
    expect(plain.querySelector('.legend')).toBeNull()
  })

  it('the recap marks the same people the same way', () => {
    const d = parse(html(recapPrint(setting(), HEAVY_REGULAR, null)))
    const marked = Array.from(d.querySelectorAll('table.people tbody td.hl'))
      .map(td => text(td.parentElement!.children[1]))
    expect(marked).toEqual(['Osoba H'])
    expect(text(d.querySelector('.legend'))).toBe(CONTRIBUTION_BASE_LEGEND)
    expect(parse(html(recapPrint(setting(), REGULAR, null))).querySelector('.legend')).toBeNull()
  })
})

describe('one payslip', () => {
  const line = REGULAR.salaries.find(s => s.employeeId === B.id)!
  const doc = parse(html(payslipPrint(setting(), REGULAR, kept(), line, SOURCE)))

  it('prints every row and figure of the payslip model, in its order', () => {
    const model = payslipSections(payslipFor(line, byId[B.id], RATES_2026, 0, {}), byId[B.id], {})
    const expected = model.flatMap(sec => [
      [sec.title, ...(sec.columns ?? [])].join('|'),
      ...sec.rows.map(r => r.kind === 'note' ? r.text
        : [r.n ?? '', r.label, ...r.cells].join('|')),
    ]).map(r => r.replace(/\s+/g, ' ').trim())
    const printed = Array.from(doc.querySelectorAll('.section tr')).map(tr =>
      tr.classList.contains('note') ? text(tr)
        : Array.from(tr.children).map(td => text(td)).join('|'))
    expect(printed).toEqual(expected)
    expect(printed.some(r => r.startsWith('|Obustava A|'))).toBe(true)
  })

  it('prints the cost and the head the dialog shows', () => {
    const p = payslipFor(line, byId[B.id], RATES_2026, 0, {})
    expect(text(doc.querySelector('.cost'))).toBe(`${PAYSLIP_COST_LABEL} ${fmtNum(p.totalCost)}`)
    expect(text(doc.querySelector('h1'))).toBe(PAYSLIP_TITLE)
    expect(text(doc.querySelector('.meta'))).toBe('Firma A · novembar 2026 · Zarade')
    expect(text(doc.querySelector('.who .name'))).toBe('E-002 — Osoba B')
    expect(doc.title).toBe('Zarade novembar 2026 — Zarade — E-002 Osoba B')
    expect(doc.documentElement.lang).toBe('sr')
  })

  it('carries the foot line naming the app from brand.ts, the rate and the time it was printed', () => {
    expect(text(doc.querySelector('.running-foot'))).toBe(FOOT_TEXT)
    expect(PRINT_FOOT('FlowBase')).toBe(
      'Interni dokument — obračun napravljen u aplikaciji FlowBase, a ne platni listić koji izdaje knjigovođa.')
    // Just past midnight in Belgrade is the next day, on a 23-hour clock.
    expect(printedAt(new Date('2026-11-20T23:05:00Z'))).toBe('Štampano 21.11.2026. u 00:05, po beogradskom vremenu')
  })

  it('without a rate the foot says so; a rate with no day says that', () => {
    const none = parse(html(payslipPrint(setting({ rate: null }), REGULAR, kept(), line, SOURCE)))
    expect(text(none.querySelector('.running-foot'))).toContain(NO_RATE_IN_FOOT)
    const unknown = parse(html(payslipPrint(setting({ rate: { eur: 117, quotedOn: null } }), REGULAR, kept(), line, SOURCE)))
    expect(text(unknown.querySelector('.running-foot'))).toContain(RATE_BADGE(fmtNum(117), 'nepoznatog dana'))
  })

  it('is one A4 portrait page', () => {
    expect(doc.querySelectorAll('section.page')).toHaveLength(1)
    expect(doc.querySelector('style')!.textContent).toMatch(/size: A4 portrait/)
  })

  it('says nothing preliminary in a regular month', () => {
    const s = html(payslipPrint(setting(), REGULAR, kept(), line, SOURCE))
    expect(s).not.toMatch(/Preliminar/)
  })

  it('says preliminary in the head, the title and the notice in a preliminary month', () => {
    const d = parse(html(payslipPrint(
      setting({ kind: 'preliminary', notice: 'Preliminarno: na pretpostavljenim satima obračunato je 1 od 3 zaposlenih.' }),
      REGULAR, kept({ kind: 'preliminary' }), line, SOURCE)))
    expect(text(d.querySelector('.prelim'))).toBe(PRELIMINARY)
    expect(text(d.querySelector('h1'))).toBe(PAYSLIP_TITLE_PRELIMINARY)
    expect(text(d.querySelector('.notice'))).toBe('Preliminarno: na pretpostavljenim satima obračunato je 1 od 3 zaposlenih.')
    expect(d.title).toBe('Preliminarno — Zarade novembar 2026 — Zarade — E-002 Osoba B')
  })

  it('escapes a name as text', () => {
    const odd = person(4, `Osoba <b>&"'`)
    const calc = calculate([odd], [contract(odd, 50000)])
    const run = calc.result.runs.find(r => r.key === 'regular')!
    const s = html(payslipPrint(setting(), run, null, run.salaries[0],
      { ...SOURCE, people: calc.byId }))
    expect(s).toContain('Osoba &lt;b&gt;&amp;&quot;&#39;')
    expect(s).not.toContain('<b>&')
    const d = parse(s)
    expect(text(d.querySelector('.who .name'))).toBe(`E-004 — Osoba <b>&"'`)
    expect(d.querySelector('.who b')).toBeNull()
  })

  it('refuses a person who is not on the roster', () => {
    const o = payslipPrint(setting(), REGULAR, kept(), line, { ...SOURCE, people: {} })
    expect(o).toEqual({ ok: false, why: payslipRefused('E-002 Osoba B', NOT_ON_ROSTER) })
  })

  it('is the same string for the same input', () => {
    expect(html(payslipPrint(setting(), REGULAR, kept(), line, SOURCE)))
      .toBe(html(payslipPrint(setting(), REGULAR, kept(), line, SOURCE)))
  })
})

describe('the state line', () => {
  const money = fmtNum
  it('not kept', () => {
    expect(printStateLine(null, REGULAR, 'regular', money)).toEqual({ state: STATE_NOT_KEPT, differs: null })
  })
  it('kept and in step', () => {
    expect(printStateLine(kept(), REGULAR, 'regular', money)).toEqual({ state: 'Sačuvano 18.11.2026.', differs: null })
  })
  it('kept and out of step says so, in the page words', () => {
    const k = kept({ total_cost: REGULAR.totals.totalCost + 500 })
    expect(printStateLine(k, REGULAR, 'regular', money)).toEqual({
      state: `Sačuvano 18.11.2026. ${KEPT_TOTAL_DIFFERS(money(REGULAR.totals.totalCost + 500), money(REGULAR.totals.totalCost))}`,
      differs: null,
    })
  })
  it('kept as the other kind says so', () => {
    expect(printStateLine(kept({ kind: 'preliminary' }), REGULAR, 'regular', money).state)
      .toBe('Sačuvano 18.11.2026. Sačuvani obračun je preliminaran, a obračun ovog meseca je sada redovan. '
        + 'Ponovo obračunajte pre knjiženja.')
  })
  it('posted, on the day Belgrade had', () => {
    expect(printStateLine(kept({ status: 'posted', posted_at: '2026-11-19T23:30:00Z' }), REGULAR, 'regular', money))
      .toEqual({ state: 'Proknjiženo 20.11.2026.', differs: null })
  })
  it('posted and no longer matching its inputs', () => {
    const k = kept({ status: 'posted', posted_at: '2026-11-19T10:00:00Z', total_cost: REGULAR.totals.totalCost + 500 })
    expect(printStateLine(k, REGULAR, 'regular', money)).toEqual({
      state: 'Proknjiženo 19.11.2026.',
      differs: POSTED_DIFFERS(money(REGULAR.totals.totalCost + 500), money(REGULAR.totals.totalCost)),
    })
  })
  it('is printed on the document, the differing sentence at the top', () => {
    const k = kept({ status: 'posted', posted_at: '2026-11-19T10:00:00Z', total_cost: REGULAR.totals.totalCost + 500 })
    const d = parse(html(recapPrint(setting(), REGULAR, k)))
    expect(text(d.querySelector('.state'))).toBe('Proknjiženo 19.11.2026.')
    expect(text(d.querySelector('.alert'))).toBe(
      POSTED_DIFFERS(money(REGULAR.totals.totalCost + 500), money(REGULAR.totals.totalCost)))
    const s = d.body.innerHTML
    expect(s.indexOf('class="alert')).toBeLessThan(s.indexOf('<h1'))
  })
})

describe('all payslips of a run', () => {
  const s = html(allPayslipsPrint(setting(), REGULAR, kept(), SOURCE))
  const doc = parse(s)

  it('one page per person, in the order the page lists them, with no break after the last', () => {
    const pages = Array.from(doc.querySelectorAll('section.page'))
    expect(pages).toHaveLength(REGULAR.salaries.length)
    expect(pages.map(p => text(p.querySelector('.who .name'))))
      .toEqual(REGULAR.salaries.map(l => `${l.code} — ${l.name}`))
    expect(pages.slice(0, -1).every(p => !p.classList.contains('final'))).toBe(true)
    expect(pages[pages.length - 1].classList.contains('final')).toBe(true)
    expect(doc.querySelector('style')!.textContent).toMatch(/\.page \{[^}]*page-break-after: always/)
    expect(doc.querySelector('style')!.textContent).toMatch(/\.page\.final \{[^}]*page-break-after: auto/)
    expect(doc.title).toBe('Zarade novembar 2026 — Zarade — platni listići')
  })

  it('every sheet carries the foot line and, when preliminary, the word: running, with room kept for them', () => {
    expect(text(doc.querySelector('.running-foot'))).toBe(FOOT_TEXT)
    expect(doc.querySelectorAll('section.page table.sheet thead .space-top')).toHaveLength(REGULAR.salaries.length)
    expect(doc.querySelectorAll('section.page table.sheet tfoot .space-foot')).toHaveLength(REGULAR.salaries.length)
    const css = doc.querySelector('style')!.textContent!
    expect(css).toMatch(/@media print \{[^]*\.running-head \{ position: fixed; top: 0;/)
    expect(css).toMatch(/@media print \{[^]*\.running-foot \{ position: fixed; bottom: 0;/)
    expect(doc.querySelector('.running-head .prelim')).toBeNull()
    const d = parse(html(allPayslipsPrint(setting({ kind: 'preliminary', notice: 'Preliminarno: zašto.' }),
      REGULAR, null, SOURCE)))
    expect(text(d.querySelector('.running-head .prelim'))).toBe(PRELIMINARY)
    expect(d.querySelectorAll('.notice')).toHaveLength(REGULAR.salaries.length)
    expect(d.title).toBe('Preliminarno — Zarade novembar 2026 — Zarade — platni listići')
  })

  it('says on each page how many people are not in it when the month is blocked', () => {
    const d = parse(html(allPayslipsPrint(setting({ gaps: gaps(2) }), REGULAR, null, SOURCE)))
    expect(Array.from(d.querySelectorAll('section.page .missing')).map(text))
      .toEqual(REGULAR.salaries.map(() => notInPrint(2)))
    expect(doc.querySelector('.missing')).toBeNull()
  })

  it('refuses a run with no payslip in it', () => {
    expect(allPayslipsPrint(setting(), OTHER_RUN, null, SOURCE).ok).toBe(false)
  })

  it('is the same string for the same input', () => {
    expect(html(allPayslipsPrint(setting(), REGULAR, kept(), SOURCE))).toBe(s)
  })
})

describe('the recap of a run', () => {
  const s = html(recapPrint(setting(), REGULAR, kept()))
  const doc = parse(s)
  const money = fmtNum

  it('a code such as E-001 is never broken over two lines', () => {
    expect(s).toContain('.people tr.cols th:first-child, .people tbody td:first-child { white-space: nowrap; }')
  })

  it('the totals block is the run totals, under the page labels, with no subsidy line', () => {
    const rows = Array.from(doc.querySelectorAll('.totals tr')).map(tr =>
      Array.from(tr.children).map(td => text(td)))
    expect(rows).toEqual([
      ...RECAP_TOTALS.map(t => [t.label, money(t.of(REGULAR.totals))]),
      ['Broj zaposlenih', '3'],
    ])
    expect(RECAP_TOTALS.map(t => t.label)).toEqual([
      'Bruto', 'Neto', 'Porez', 'Doprinosi zaposlenog', 'Doprinosi poslodavca',
      'Porez i doprinosi', 'Ukupan trošak', 'Prosleđene obustave', 'Zadržane obustave',
    ])
  })

  it('one row per line under the columns of the copied table, and a totals row equal to the run', () => {
    const head = Array.from(doc.querySelectorAll('table.people thead tr.cols th')).map(text)
    expect(head).toEqual([...COPY_HEADER, ...RECAP_DEDUCTION_HEADER])
    expect(COPY_HEADER).toHaveLength(10)
    const body = Array.from(doc.querySelectorAll('table.people tbody tr:not(.total)'))
    expect(body).toHaveLength(REGULAR.salaries.length)
    const total = Array.from(doc.querySelectorAll('table.people tr.total td')).map(text)
    const t = REGULAR.totals
    expect(total).toEqual(['', 'Ukupno', '', money(t.gross), '', money(t.incomeTax),
      money(t.employeeContributions), money(t.employerContributions), money(t.net),
      money(t.totalCost), money(t.deductionsThirdParty), money(t.deductionsEmployer)])
    expect(t.deductionsThirdParty).toBeGreaterThan(0)
    const num = (v: string) => Number(v.replace(/\./g, '').replace(',', '.'))
    const col = (i: number) => body.reduce((sum, tr) => {
      const v = text(tr.children[i]); return v === '—' ? sum : sum + num(v)
    }, 0)
    expect(Math.round(col(3) * 100) / 100).toBe(t.gross)
    expect(Math.round(col(9) * 100) / 100).toBe(t.totalCost)
    expect(Math.round(col(10) * 100) / 100).toBe(t.deductionsThirdParty)
  })

  it('the first line of a person is theirs', () => {
    const first = Array.from(doc.querySelectorAll('table.people tbody tr:not(.total)'))[0]
    const l = REGULAR.salaries[0]
    expect(Array.from(first.children).map(td => text(td))).toEqual([
      l.code, l.name, payslipHours(l.hours), money(l.line.gross), money(l.line.contributionBase),
      money(l.line.incomeTax), money(l.line.employeeContributions), money(l.line.employerContributions),
      money(l.line.net), money(l.line.totalCost), '—', '—'])
    expect(payslipHours(l.hours)).toBe('168,00')
  })

  it('an other-income run prints its lines with the blanks the copied table leaves', () => {
    const d = parse(html(recapPrint(setting(), OTHER_RUN, null)))
    const l = OTHER_RUN.otherIncome[0]
    const row = Array.from(d.querySelectorAll('table.people tbody tr:not(.total)'))[0]
    expect(Array.from(row.children).map(td => text(td))).toEqual([
      l.code, l.name, '—', money(l.line.gross), '—', money(l.line.incomeTax), '—', '—',
      money(l.line.net), money(l.line.totalCost), '—', '—'])
  })

  it('landscape, the header repeating, the foot on every page', () => {
    const css = doc.querySelector('style')!.textContent!
    expect(css).toMatch(/size: A4 landscape/)
    expect(css).toMatch(/thead \{ display: table-header-group; \}/)
    expect(css).toMatch(/tfoot \{ display: table-footer-group; \}/)
    expect(text(doc.querySelector('.running-foot'))).toBe(FOOT_TEXT)
    expect(doc.querySelector('table.people thead .space-top')).not.toBeNull()
    expect(doc.querySelector('table.people tfoot .space-foot')).not.toBeNull()
    expect(doc.title).toBe('Zarade novembar 2026 — Zarade — rekapitulacija')
    expect(s).not.toMatch(/Preliminar/)
  })

  it('a preliminary recap says so in the head, in the repeating header and in the title', () => {
    const d = parse(html(recapPrint(setting({ kind: 'preliminary', notice: 'Preliminarno: zašto.' }), REGULAR, null)))
    expect(text(d.querySelector('.prelim'))).toBe(PRELIMINARY)
    expect(text(d.querySelector('.running-head'))).toBe(`${PRELIMINARY} Firma A · novembar 2026 · Zarade`)
    expect(text(d.querySelector('.notice'))).toBe('Preliminarno: zašto.')
    expect(d.title).toBe('Preliminarno — Zarade novembar 2026 — Zarade — rekapitulacija')
  })

  it('says how many people are not in it when the month is blocked', () => {
    const d = parse(html(recapPrint(setting({ gaps: gaps(1) }), REGULAR, null)))
    expect(text(d.querySelector('.missing'))).toBe(notInPrint(1))
  })

  it('refuses when its rows and the run totals disagree', () => {
    const wrong: PayrollRun = { ...REGULAR, totals: { ...REGULAR.totals, gross: REGULAR.totals.gross + 1 } }
    const o = recapPrint(setting(), wrong, null)
    expect(o).toEqual({ ok: false, why: recapDisagrees('Zarade', 'Bruto', money(REGULAR.totals.gross), money(REGULAR.totals.gross + 1)) })
    expect(recapDisagrees('Zarade', 'Bruto', '1,00', '2,00')).toBe(
      'Rekapitulacija obračuna „Zarade“ nije štampana: zbir stavki u koloni „Bruto“ je 1,00, '
      + 'a obračun kaže 2,00. Osvežite stranu i pokušajte ponovo.')
    // Within the page's tolerance it prints.
    const close: PayrollRun = { ...REGULAR, totals: { ...REGULAR.totals, gross: REGULAR.totals.gross + 0.01 } }
    expect(recapPrint(setting(), close, null).ok).toBe(true)
    const deductions: PayrollRun = { ...REGULAR, totals: { ...REGULAR.totals, deductionsEmployer: 5 } }
    expect(recapPrint(setting(), deductions, null)).toEqual({ ok: false,
      why: recapDisagrees('Zarade', 'Zadržane obustave', money(0), money(5)) })
  })

  it('refuses a run nobody is in', () => {
    const empty: PayrollRun = { ...OTHER_RUN, otherIncome: [] }
    expect(recapPrint(setting(), empty, null).ok).toBe(false)
  })

  it('escapes a name as text', () => {
    const odd = person(4, `Osoba <b>&"'`)
    const calc = calculate([odd], [contract(odd, 50000)])
    const run = calc.result.runs.find(r => r.key === 'regular')!
    const r = html(recapPrint(setting({ companyName: 'Firma <i>' }), run, null))
    expect(r).toContain('Osoba &lt;b&gt;&amp;&quot;&#39;')
    expect(r).toContain('Firma &lt;i&gt;')
    expect(r).not.toContain('<b>&')
  })

  it('is the same string for the same input', () => {
    expect(html(recapPrint(setting(), REGULAR, kept()))).toBe(s)
  })
})
