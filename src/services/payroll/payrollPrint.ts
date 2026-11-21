// ─── payrollPrint ───────────────────────────────────────────────────────────
//
// The Payroll page's three printed documents — one payslip, every payslip of
// a run, and a run's recap — each a whole HTML document carrying the same
// `window.print()` loader `partnerCardPrint.ts` carries. The page writes it
// into a hidden frame (`usePrintFrame`) and the browser's "Sačuvaj kao PDF"
// makes the file. No PDF library: the browser's fonts carry č ć š đ ž.
//
// INTERNAL DOCUMENTS. They print what the page shows — the LIVE calculation —
// and say so at the foot of every sheet; they are not the payslip the
// accountant issues, and nothing here is sent to anybody. The foot names the
// app from `src/config/brand.ts`, never a client (NADOGRADNJA rule 6).
//
// PURE. Nothing here reads a table or the clock: the time printed is the
// `now` it is handed, so the same input always gives the same string.
//
// EVERYTHING INTERPOLATED IS ESCAPED: a name is text, never markup.
//
// IT REFUSES rather than print a wrong document: a recap whose lines do not
// add up to the run's own totals, a payslip whose model cannot be built.
//
// EVERY SHEET CARRIES THE HEAD AND THE FOOT. The word Preliminarno (when it
// is) and the foot line are a running head and a running foot, fixed to the
// top and bottom of each printed sheet; the content sits in a table whose
// repeating header and footer are empty spacers of the same heights, so on a
// sheet the content runs onto it never runs under them.

import { fmtNum } from '../../utils/formatters'
import { monthLongLabel } from '../../utils/months'
import { countOf, plural } from '../../utils/plural'
import { belgradeToday } from '../../utils/today'
import { brand } from '../../config/brand'
import {
  payslipFor, payslipSections, payslipHours, baseDiffers, PAYSLIP_COST_LABEL,
  type PayslipSectionView,
} from './payslip'
import {
  keptState, keptWhy, kindOf, KEPT_TOLERANCE, KEPT_TOTAL_DIFFERS, type SavedRun,
} from './savedRuns'
import { RATE_BADGE, UNKNOWN_RATE_DAY } from './payrollRate'
import {
  PRELIMINARY, PAYSLIP_TITLE, PAYSLIP_TITLE_PRELIMINARY, KEPT_KIND_DIFFERS, KEPT_RUN_EMPTY,
  type RunKind,
} from './preliminaryText'
import type { PayrollRun, SalaryRunLine } from './runs'
import type { EmployeeForMonth } from './employees'
import type { PayrollRates } from './engine'

// ─── The words ──────────────────────────────────────────────────────────────

/** The foot of every printed sheet, naming the app this copy is. */
export const PRINT_FOOT = (appName: string): string =>
  `Interni dokument — obračun napravljen u aplikaciji ${appName}, a ne platni listić koji izdaje knjigovođa.`
export const STATE_NOT_KEPT = 'Nije sačuvano'
export const keptOn = (day: string): string => `Sačuvano ${day}`
export const postedOn = (day: string): string => `Proknjiženo ${day}`
export const RECAP_TITLE = 'Rekapitulacija obračuna zarade'
export const PEOPLE_LABEL = 'Broj zaposlenih'
export const TOTAL_LABEL = 'Ukupno'

export const PRINT = 'Štampaj'
export const PRINT_THIS_PAYSLIP = 'Štampaj ovaj platni listić'
export const PRINT_RECAP = 'Štampaj rekapitulaciju'
export const PRINT_ALL_PAYSLIPS = 'Štampaj sve platne listiće'
/** The accessible names of a run card's buttons: two cards, four different names. */
export const printRecapOf = (run: string): string => `${PRINT_RECAP} — ${run}`
export const printAllPayslipsOf = (run: string): string => `${PRINT_ALL_PAYSLIPS} — ${run}`
export const NOTHING_TO_PRINT = 'Nema šta da se štampa: u ovom obračunu nema nikoga.'
export const NO_PAYSLIPS_TO_PRINT = 'Nema platnih listića za štampu: ovaj obračun nema stavki zarade.'
export const PAYSLIP_NOT_PRINTABLE = 'Ovaj platni listić ne može da se štampa odavde.'

export const CONTRIBUTION_BASE_LEGEND = 'Osnovica za doprinose u kurzivu razlikuje se od bruto '
  + 'zarade zbog najniže ili najviše osnovice doprinosa.'

/** The line at the top of a document printed while people are missing. */
export const notInPrint = (n: number): string =>
  `${countOf(n, 'zaposleni', 'zaposlena', 'zaposlenih')} `
  + `${plural(n, 'nije obračunat i nije', 'nisu obračunata i nisu', 'nije obračunato i nije')} `
  + 'u ovom dokumentu.'

/** The line at the top of a document some of whose people the page warns about. */
export const figuresIncomplete = (n: number): string =>
  `Iznosi su nepotpuni za ${countOf(n, 'zaposlenog', 'zaposlena', 'zaposlenih')}: strana navodi zašto.`

export const recapDisagrees = (run: string, column: string, sum: string, total: string): string =>
  `Rekapitulacija obračuna „${run}“ nije štampana: zbir stavki u koloni „${column}“ je ${sum}, `
  + `a obračun kaže ${total}. Osvežite stranu i pokušajte ponovo.`

export const payslipRefused = (who: string, why: string): string =>
  `Platni listić za ${who} ne može da se štampa: ${why}`

export const NOT_ON_ROSTER = 'nije na spisku zaposlenih za ovaj mesec.'
export const NOT_A_NUMBER = 'jedan od iznosa nije broj.'

/** The columns of the copied table on the Payroll page; the recap prints the same ones. */
export const COPY_HEADER = ['Šifra', 'Zaposleni', 'Sati', 'Bruto', 'Osnovica za doprinose', 'Porez',
  'Doprinosi zaposlenog', 'Doprinosi poslodavca', 'Neto', 'Ukupan trošak']

/** The recap's two columns after those of the copied table: the two deductions, per person. */
export const RECAP_DEDUCTION_HEADER = ['Prosleđene obustave', 'Zadržane obustave']

/** The totals of a run, under the page's own labels. */
export const RECAP_TOTALS: { label: string; of: (t: PayrollRun['totals']) => number }[] = [
  { label: 'Bruto', of: t => t.gross },
  { label: 'Neto', of: t => t.net },
  { label: 'Porez', of: t => t.incomeTax },
  { label: 'Doprinosi zaposlenog', of: t => t.employeeContributions },
  { label: 'Doprinosi poslodavca', of: t => t.employerContributions },
  { label: 'Porez i doprinosi', of: t => round2(t.incomeTax + t.employeeContributions + t.employerContributions) },
  { label: 'Ukupan trošak', of: t => t.totalCost },
  { label: 'Prosleđene obustave', of: t => t.deductionsThirdParty },
  { label: 'Zadržane obustave', of: t => t.deductionsEmployer },
]

// ─── The sheet ─────────────────────────────────────────────────────────────

/**
 * The measures of a printed sheet, in millimetres; the CSS below is built
 * from them, and the test of a heavy payslip does its arithmetic with them.
 * A4 is 297mm high: less two margins of 8, a running head of 12 and a running
 * foot of 11 leaves 258mm for the content of each sheet. A row of a payslip
 * table is one line of 3.4mm with 0.25mm above and below — 3.9mm, so forty
 * rows take 156mm and leave about 100mm for the head, the notices, the who
 * and the boxes.
 */
export const PAYSLIP_SHEET = {
  marginMm: 8,
  headMm: 12,
  footMm: 11,
  lineMm: 3.4,
  rowPadMm: 0.25,
  /** A line of a block of text, counted generously (the title is the tallest). */
  blockLineMm: 4.4,
  /** Padding, border and margin of a block of text. */
  blockMm: 2.5,
  /** Characters on a line of a block at 8.5pt across 194mm, counted low. */
  charsPerLine: 110,
} as const

// ─── What every document is handed ─────────────────────────────────────────

/** Who is not in a document, and whose figures are in it with a warning. */
export interface PrintGaps {
  /** People absent from every run: the page could not calculate them. */
  missing: number
  /** People in the runs whose figures the page warns about. */
  incomplete: number
  /** The page's own problem sentences, by employee id, for those people. */
  whyFor: Record<string, string[]>
}

export const NO_GAPS: PrintGaps = { missing: 0, incomplete: 0, whyFor: {} }

/**
 * The gaps, from the page's own problem objects. A person counts once
 * however many problems they raise; one who is in a run is not missing, and
 * their problems are what makes their figures incomplete.
 */
export function printGaps(
  rosterProblems: { employee: { id: string } }[],
  month: { runs: PayrollRun[]; problems: { employeeId: string; why: string }[] },
): PrintGaps {
  const inRuns = new Set(month.runs.flatMap(r =>
    [...r.salaries.map(s => s.employeeId), ...r.otherIncome.map(o => o.employeeId)]))
  const absent = new Set<string>()
  for (const p of rosterProblems) if (!inRuns.has(p.employee.id)) absent.add(p.employee.id)
  const whyFor: Record<string, string[]> = {}
  for (const p of month.problems) {
    if (inRuns.has(p.employeeId)) (whyFor[p.employeeId] ??= []).push(p.why)
    else absent.add(p.employeeId)
  }
  return { missing: absent.size, incomplete: Object.keys(whyFor).length, whyFor }
}

export interface PrintSetting {
  companyName: string
  /** `YYYY-MM`. */
  month: string
  /** The month's kind, as the page decided it. */
  kind: RunKind
  /** The page's notice above a preliminary month, word for word. */
  notice: string | null
  gaps: PrintGaps
  /** The rate the euro amounts were converted at, and the day its list is from. */
  rate: { eur: number; quotedOn: string | null } | null
  /** When it was printed. Handed in, never read from the clock here. */
  now: Date
}

/** What a payslip is built from, as the dialog builds it. */
export interface PayslipSource {
  rates: PayrollRates
  seniorityCoefficient: number | null
  currencyRates: Record<string, number>
  people: Record<string, EmployeeForMonth>
}

export type PrintOutcome = { ok: true; html: string } | { ok: false; why: string }

// ─── The state line ────────────────────────────────────────────────────────

/** `YYYY-MM-DD` (or a timestamp, read in Belgrade) → `dd.mm.gggg.` */
const day = (at: string | null | undefined): string => {
  if (!at) return ''
  const iso = at.length > 10 ? belgradeToday(new Date(at)) : at
  return `${iso.slice(8, 10)}.${iso.slice(5, 7)}.${iso.slice(0, 4)}.`
}

/**
 * Where the run stands, as the run card says it, in one line; and, apart,
 * the sentence the page prints when a POSTED run no longer matches its inputs
 * — the document prints the live calculation and must not hide that the
 * ledger says something else.
 */
export function printStateLine(
  kept: SavedRun | null, run: PayrollRun, kind: RunKind, money: (n: number) => string,
): { state: string; differs: string | null } {
  const state = keptState(kept, run, kind)
  if (!kept || state === 'none') return { state: STATE_NOT_KEPT, differs: null }
  if (state === 'posted') {
    return { state: postedOn(day(kept.posted_at)), differs: keptWhy(kept, run, kind, money) }
  }
  const on = keptOn(day(kept.calculated_at))
  if (state === 'stale_total') {
    return { state: `${on} ${KEPT_TOTAL_DIFFERS(money(Number(kept.total_cost)), money(run.totals.totalCost))}`, differs: null }
  }
  if (state === 'stale_kind') return { state: `${on} ${KEPT_KIND_DIFFERS(kindOf(kept), kind)}`, differs: null }
  if (state === 'empty') return { state: `${on} ${KEPT_RUN_EMPTY}`, differs: null }
  return { state: on, differs: null }
}

// ─── The three documents ───────────────────────────────────────────────────

/** One person's payslip, on one A4 sheet. */
export function payslipPrint(
  setting: PrintSetting, run: PayrollRun, kept: SavedRun | null,
  line: SalaryRunLine, source: PayslipSource,
): PrintOutcome {
  const page = payslipPage(setting, run, kept, line, source, { last: true, gaps: false })
  if (!page.ok) return page
  return {
    ok: true,
    html: documentOf(setting, run.label, titleOf(setting, run.label, whoOf(line)), 'portrait', page.html),
  }
}

/** Every payslip of a run, one person per sheet, in the order the page lists them. */
export function allPayslipsPrint(
  setting: PrintSetting, run: PayrollRun, kept: SavedRun | null, source: PayslipSource,
): PrintOutcome {
  if (run.salaries.length === 0) return { ok: false, why: NO_PAYSLIPS_TO_PRINT }
  const pages: string[] = []
  for (let i = 0; i < run.salaries.length; i++) {
    const page = payslipPage(setting, run, kept, run.salaries[i], source,
      { last: i === run.salaries.length - 1, gaps: true })
    if (!page.ok) return page
    pages.push(page.html)
  }
  return {
    ok: true,
    html: documentOf(setting, run.label, titleOf(setting, run.label, 'platni listići'), 'portrait', pages.join('\n')),
  }
}

/** A run's totals, then one row per line; landscape, the header on every sheet. */
export function recapPrint(setting: PrintSetting, run: PayrollRun, kept: SavedRun | null): PrintOutcome {
  const lines = run.salaries.length + run.otherIncome.length
  if (lines === 0) return { ok: false, why: NOTHING_TO_PRINT }

  // The rows, summed column by column, against the run's own totals.
  const sums = {
    gross: 0, incomeTax: 0, employeeContributions: 0, employerContributions: 0,
    net: 0, totalCost: 0, deductionsThirdParty: 0, deductionsEmployer: 0,
  }
  for (const s of run.salaries) {
    sums.gross += s.line.gross; sums.incomeTax += s.line.incomeTax
    sums.employeeContributions += s.line.employeeContributions
    sums.employerContributions += s.line.employerContributions
    sums.net += s.line.net; sums.totalCost += s.line.totalCost
    sums.deductionsThirdParty += s.deductions.thirdParty; sums.deductionsEmployer += s.deductions.employer
  }
  for (const o of run.otherIncome) {
    sums.gross += o.line.gross; sums.incomeTax += o.line.incomeTax
    sums.net += o.line.net; sums.totalCost += o.line.totalCost
  }
  const checked: [keyof typeof sums, string][] = [
    ['gross', 'Bruto'], ['incomeTax', 'Porez'],
    ['employeeContributions', 'Doprinosi zaposlenog'],
    ['employerContributions', 'Doprinosi poslodavca'], ['net', 'Neto'],
    ['totalCost', 'Ukupan trošak'],
    ['deductionsThirdParty', 'Prosleđene obustave'],
    ['deductionsEmployer', 'Zadržane obustave'],
  ]
  for (const [key, label] of checked) {
    const sum = round2(sums[key])
    if (Math.abs(sum - run.totals[key]) > KEPT_TOLERANCE) {
      return { ok: false, why: recapDisagrees(run.label, label, fmtNum(sum), fmtNum(run.totals[key])) }
    }
  }

  const people = new Set([...run.salaries.map(s => s.employeeId), ...run.otherIncome.map(o => o.employeeId)]).size
  const t = run.totals
  const dash = (n: number) => (n > 0 ? money(n) : '—')
  // A cell is [text, italic?]; the base in italics where it is not the gross.
  const cells = (c: (string | [string, boolean])[], cls = '') => `<tr${cls ? ` class="${cls}"` : ''}>${c.map((v, i) => {
    const [value, hl] = Array.isArray(v) ? v : [v, false]
    const classes = [i >= 2 ? 'n' : '', hl ? 'hl' : ''].filter(Boolean).join(' ')
    return `<td${classes ? ` class="${classes}"` : ''}>${value}</td>`
  }).join('')}</tr>`
  const marked = run.salaries.some(s => baseDiffers(s.line.contributionBase, s.line.gross))
  const rows = [
    ...run.salaries.map(s => cells([
      esc(s.code || ''), esc(s.name), esc(payslipHours(s.hours)), money(s.line.gross),
      [money(s.line.contributionBase), baseDiffers(s.line.contributionBase, s.line.gross)],
      money(s.line.incomeTax), money(s.line.employeeContributions),
      money(s.line.employerContributions), money(s.line.net), money(s.line.totalCost),
      dash(s.deductions.thirdParty), dash(s.deductions.employer),
    ])),
    ...run.otherIncome.map(l => cells([
      esc(l.code || ''), esc(l.name), '—', money(l.line.gross), '—', money(l.line.incomeTax), '—', '—',
      money(l.line.net), money(l.line.totalCost), '—', '—',
    ])),
    cells(['', esc(TOTAL_LABEL), '', money(t.gross), '', money(t.incomeTax), money(t.employeeContributions),
      money(t.employerContributions), money(t.net), money(t.totalCost),
      money(t.deductionsThirdParty), money(t.deductionsEmployer)], 'total'),
  ].join('\n')

  const totals = [
    ...RECAP_TOTALS.map(r => `<tr><td>${esc(r.label)}</td><td class="n">${money(r.of(t))}</td></tr>`),
    `<tr><td>${esc(PEOPLE_LABEL)}</td><td class="n">${people}</td></tr>`,
  ].join('\n')

  const header = [...COPY_HEADER, ...RECAP_DEDUCTION_HEADER]
  const cols = header.length
  const body = `<div class="space-top"></div>
${topOf(setting, run, kept, true)}
<header>
<h1 class="block">${esc(RECAP_TITLE)}</h1>
<div class="meta block">${esc(metaOf(setting, run.label))}</div>
<div class="state block">${esc(printStateLine(kept, run, setting.kind, fmtNum).state)}</div>
</header>
<table class="totals">
${totals}
</table>
${marked ? `<p class="legend block">${esc(CONTRIBUTION_BASE_LEGEND)}</p>` : ''}
<table class="people">
<thead>
<tr class="spacer"><td colspan="${cols}"><div class="space-top"></div></td></tr>
<tr class="cols">${header.map((h, i) => `<th${i >= 2 ? ' class="n"' : ''}>${esc(h)}</th>`).join('')}</tr>
</thead>
<tfoot><tr class="spacer"><td colspan="${cols}"><div class="space-foot"></div></td></tr></tfoot>
<tbody>
${rows}
</tbody>
</table>`
  return { ok: true, html: documentOf(setting, run.label, titleOf(setting, run.label, 'rekapitulacija'), 'landscape', body) }
}

// ─── The parts ─────────────────────────────────────────────────────────────

function payslipPage(
  setting: PrintSetting, run: PayrollRun, kept: SavedRun | null, line: SalaryRunLine,
  source: PayslipSource, o: { last: boolean; gaps: boolean },
): PrintOutcome {
  const person = source.people[line.employeeId]
  if (!person) return { ok: false, why: payslipRefused(whoOf(line), NOT_ON_ROSTER) }
  let sections: PayslipSectionView[]
  let p: ReturnType<typeof payslipFor>
  try {
    p = payslipFor(line, person, source.rates, source.seniorityCoefficient, source.currencyRates)
    sections = payslipSections(p, person, source.currencyRates)
  } catch (e) {
    return { ok: false, why: payslipRefused(whoOf(line), e instanceof Error ? e.message : String(e)) }
  }
  if (![p.gross, p.net, p.totalCost].every(Number.isFinite)) {
    return { ok: false, why: payslipRefused(whoOf(line), NOT_A_NUMBER) }
  }

  const preliminary = setting.kind === 'preliminary'
  const width = { one: 1, two: 2, three: 3 } as const
  const tables = sections.map(sec => {
    const n = width[sec.layout]
    const columns = sec.columns ?? []
    const head = `<tr class="head"><th colspan="${2 + n - columns.length}">${esc(sec.title)}</th>`
      + columns.map(c => `<th class="n">${esc(c)}</th>`).join('') + '</tr>'
    const rows = sec.rows.map(r => r.kind === 'note'
      ? `<tr class="note"><td colspan="${2 + n}">${esc(r.text)}</td></tr>`
      : `<tr class="${[r.bold ? 'b' : '', r.indent ? 'indent' : '', r.highlight ? 'hl' : ''].filter(Boolean).join(' ')}">`
        + `<td class="no">${r.n ?? ''}</td><td class="label">${esc(r.label)}</td>`
        + r.cells.map(c => `<td class="n">${esc(c)}</td>`).join('') + '</tr>').join('\n')
    return `<table class="section">\n${head}\n${rows}\n</table>`
  }).join('\n')
  const marked = sections.some(sec => sec.rows.some(r => r.kind === 'row' && r.highlight))
  const own = setting.gaps.whyFor[line.employeeId] ?? []

  const content = `${topOf(setting, run, kept, o.gaps)}
${own.length ? `<p class="own-problems block">${esc(own.join(' '))}</p>` : ''}
<header>
<h1 class="block">${esc(preliminary ? PAYSLIP_TITLE_PRELIMINARY : PAYSLIP_TITLE)}</h1>
<div class="meta block">${esc(metaOf(setting, run.label))}</div>
<div class="state block">${esc(printStateLine(kept, run, setting.kind, fmtNum).state)}</div>
</header>
<div class="who"><div class="name block">${esc(`${line.code ? `${line.code} — ` : ''}${line.name}`)}</div>
<div class="unit block">${esc(person.employee.organisational_unit || '—')}</div></div>
${tables}
${marked ? `<p class="legend block">${esc(CONTRIBUTION_BASE_LEGEND)}</p>` : ''}
<div class="cost block"><span>${esc(PAYSLIP_COST_LABEL)}</span>
<b>${money(p.totalCost)}</b></div>`

  const html = `<section class="page${o.last ? ' final' : ''}">
<table class="sheet">
<thead><tr><td><div class="space-top"></div></td></tr></thead>
<tfoot><tr><td><div class="space-foot"></div></td></tr></tfoot>
<tbody><tr><td>
${content}
</td></tr></tbody>
</table>
</section>`
  return { ok: true, html }
}

/** What goes above the head: what makes it preliminary, a posted run that differs, people missing. */
function topOf(setting: PrintSetting, run: PayrollRun, kept: SavedRun | null, gaps: boolean): string {
  const preliminary = setting.kind === 'preliminary'
  const { differs } = printStateLine(kept, run, setting.kind, fmtNum)
  return [
    preliminary && setting.notice ? `<p class="notice block">${esc(setting.notice)}</p>` : '',
    differs ? `<p class="alert block">${esc(differs)}</p>` : '',
    gaps && setting.gaps.missing > 0 ? `<p class="missing block">${esc(notInPrint(setting.gaps.missing))}</p>` : '',
    gaps && setting.gaps.incomplete > 0
      ? `<p class="incomplete block">${esc(figuresIncomplete(setting.gaps.incomplete))}</p>` : '',
  ].filter(Boolean).join('\n')
}

/** The running head: Preliminarno when it is, and whose run this is. */
function runningHead(setting: PrintSetting, runLabel: string): string {
  return `<div class="running-head">${setting.kind === 'preliminary' ? `<div class="prelim">${esc(PRELIMINARY)}</div>\n` : ''}`
    + `<div class="running-meta">${esc(metaOf(setting, runLabel))}</div></div>`
}

/** The running foot: what this is, the rate, and when it was printed. */
function runningFoot(setting: PrintSetting): string {
  const rate = setting.rate
    ? RATE_BADGE(fmtNum(setting.rate.eur), setting.rate.quotedOn ? day(setting.rate.quotedOn) : UNKNOWN_RATE_DAY)
    : NO_RATE_IN_FOOT
  return `<div class="running-foot"><div>${esc(PRINT_FOOT(brand.appName))}</div>\n`
    + `<div>${esc(rate)} · ${esc(printedAt(setting.now))}</div></div>`
}

/** The foot's rate part when no rate could be had. */
export const NO_RATE_IN_FOOT = 'Kurs NBS nije dostupan'

const BELGRADE_TIME = new Intl.DateTimeFormat('en-GB', {
  timeZone: 'Europe/Belgrade', hour: '2-digit', minute: '2-digit', hourCycle: 'h23',
})

/** The day and time in Belgrade, where the books are kept. */
export const printedAt = (now: Date): string =>
  `Štampano ${day(belgradeToday(now))} u ${BELGRADE_TIME.format(now)}, po beogradskom vremenu`

const metaOf = (setting: PrintSetting, runLabel: string): string =>
  `${setting.companyName} · ${monthLongLabel(setting.month)} · ${runLabel}`

const whoOf = (line: SalaryRunLine): string => `${line.code ? `${line.code} ` : ''}${line.name}`

function titleOf(setting: PrintSetting, runLabel: string, tail: string): string {
  const base = `Zarade ${monthLongLabel(setting.month)} — ${runLabel} — ${tail}`
  return setting.kind === 'preliminary' ? `${PRELIMINARY} — ${base}` : base
}

/** The same loader the partner card carries. */
const PRINT_LOADER = "<script>window.addEventListener('load', function () { window.focus(); window.print(); });</script>"

function documentOf(
  setting: PrintSetting, runLabel: string, title: string, orientation: 'portrait' | 'landscape', body: string,
): string {
  const m = PAYSLIP_SHEET
  return `<!doctype html>
<html lang="sr"><head><meta charset="utf-8">
<title>${esc(title)}</title>
<style>
  @page { size: A4 ${orientation}; margin: ${m.marginMm}mm; }
  * { box-sizing: border-box; }
  html, body { background: #fff; }
  body { font-family: system-ui, -apple-system, "Segoe UI", Roboto, Arial, sans-serif; font-size: 8.5pt; line-height: ${m.lineMm}mm; color: #000; margin: 0; }
  h1 { font-size: 12pt; line-height: ${m.blockLineMm}mm; margin: 0; }
  p { margin: 0; }
  .block { margin-bottom: 1mm; }
  .running-head { height: ${m.headMm}mm; }
  .running-head .prelim { font-size: 15pt; line-height: 6mm; font-weight: 800; text-transform: uppercase; letter-spacing: .14em; text-align: center; border: 0.6mm solid #000; margin-bottom: 0.8mm; }
  .running-meta { font-size: 8pt; }
  .running-foot { height: ${m.footMm}mm; border-top: 0.3mm solid #000; padding-top: 1mm; font-size: 7.5pt; line-height: 3mm; }
  .space-top { height: ${m.headMm}mm; }
  .space-foot { height: ${m.footMm}mm; }
  @media print {
    .running-head { position: fixed; top: 0; left: 0; right: 0; height: ${m.headMm}mm; }
    .running-foot { position: fixed; bottom: 0; left: 0; right: 0; height: ${m.footMm}mm; }
  }
  .page { page-break-after: always; break-after: page; }
  .page.final { page-break-after: auto; break-after: auto; }
  table { width: 100%; border-collapse: collapse; }
  th, td { padding: .5mm 1.5mm; text-align: left; vertical-align: top; }
  .sheet > thead > tr > td, .sheet > tfoot > tr > td, .sheet > tbody > tr > td { padding: 0; }
  .notice { font-weight: 600; }
  .alert, .missing, .incomplete, .own-problems { font-weight: 700; border: 0.4mm solid #000; padding: 0.4mm 1.5mm; }
  .meta { font-size: 9pt; }
  .who { border-top: 0.4mm solid #000; border-bottom: 0.3mm solid #000; padding-top: 0.5mm; margin-bottom: 1mm; }
  .who .name { font-size: 10pt; font-weight: 700; }
  .section { margin-top: 1.2mm; }
  .section td, .section th { padding: ${m.rowPadMm}mm 1.5mm; line-height: ${m.lineMm}mm; }
  .section tr.head th { border-bottom: 0.3mm solid #000; font-size: 7.5pt; text-transform: uppercase; letter-spacing: .05em; }
  .section td.no { width: 6mm; }
  .section td.n, .section th.n { width: 30mm; }
  .section tr.b td { font-weight: 700; }
  .section tr.indent td.label { padding-left: 6mm; }
  .section tr.note td { padding-left: 8mm; font-size: 7.5pt; }
  .hl, .section tr.hl td.n { font-style: italic; }
  .legend { font-style: italic; margin-top: 1mm; }
  .n { text-align: right; white-space: nowrap; font-variant-numeric: tabular-nums; }
  .cost { display: flex; justify-content: space-between; margin-top: 1.5mm; padding: 0.4mm 1.5mm; border: 0.5mm solid #000; font-size: 9.5pt; }
  .totals { width: auto; min-width: 90mm; margin: 1mm 0 2mm; }
  .totals td { border-bottom: .3mm solid #888; }
  .people th { border-bottom: 0.5mm solid #000; font-size: 7.5pt; }
  .people td { border-bottom: .3mm solid #888; }
  .people tr.cols th:first-child, .people tbody td:first-child { white-space: nowrap; }
  .people tr.spacer td { border: 0; padding: 0; }
  .people tr.total td { border-top: 0.5mm solid #000; font-weight: 700; }
  thead { display: table-header-group; }
  tfoot { display: table-footer-group; }
  tr { page-break-inside: avoid; }
</style></head>
<body>
${runningHead(setting, runLabel)}
${body}
${runningFoot(setting)}
${PRINT_LOADER}
</body></html>`
}

const esc = (s: unknown) => String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c] as string))
const money = (n: number): string => esc(fmtNum(n))
const round2 = (n: number): number => Math.round(n * 100) / 100
