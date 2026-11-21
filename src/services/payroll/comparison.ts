// ─── The running month against last month's regular payroll ───────────────
//
// This month's side is the live calculation, as the page shows it. Last
// month's side is what was KEPT for it, and only when every run kept for it
// is regular: a month half preliminary is not "last month's regular".
//
// People are matched by employee id across all runs, by code where a kept
// line has lost its id, and NEVER by name: two people can share one, and an
// other-income line is named "Name — label".

import { RUN_LABELS, type PayrollRun, type RunKey } from './runs'
import { kindOf, type SavedRun, type SavedRunLine } from './savedRuns'

const RUN_ORDER: RunKey[] = ['regular', 'other']

/** The month before, `YYYY-MM`. */
export function previousMonth(month: string): string {
  const [y, m] = month.slice(0, 7).split('-').map(Number)
  const d = new Date(Date.UTC(y, m - 2, 1))
  return d.toISOString().slice(0, 7)
}

/** Last month's kept runs, when they are all regular; otherwise null. */
export function lastRegular(kept: SavedRun[]): SavedRun[] | null {
  if (kept.length === 0) return null
  if (kept.some(r => kindOf(r) !== 'regular')) return null
  return kept
}

export interface Figures {
  totalCost: number
  net: number
  /** Income tax and both sides' contributions, as the page's card adds them. */
  taxAndContributions: number
}

export interface RunDifference {
  key: string
  label: string
  now: Figures
  then: Figures | null
}

const ZERO: Figures = { totalCost: 0, net: 0, taxAndContributions: 0 }

const liveFigures = (r: PayrollRun): Figures => ({
  totalCost: round2(r.totals.totalCost),
  net: round2(r.totals.net),
  taxAndContributions: round2(r.totals.incomeTax + r.totals.employeeContributions
    + r.totals.employerContributions),
})

const keptFigures = (r: SavedRun): Figures => ({
  totalCost: round2(Number(r.total_cost) || 0),
  net: round2(Number(r.net) || 0),
  taxAndContributions: round2((Number(r.income_tax) || 0) + (Number(r.contributions_employee) || 0)
    + (Number(r.contributions_employer) || 0)),
})

const add = (a: Figures, b: Figures): Figures => ({
  totalCost: round2(a.totalCost + b.totalCost),
  net: round2(a.net + b.net),
  taxAndContributions: round2(a.taxAndContributions + b.taxAndContributions),
})

/**
 * One row per run on either side, in the page's run order. A run nobody is
 * in this month and nothing was kept for last month is left out.
 */
export function compareRuns(
  live: PayrollRun[], kept: SavedRun[],
): { runs: RunDifference[]; total: { now: Figures; then: Figures } } {
  const keys = new Set<string>()
  for (const r of live) if (r.salaries.length + r.otherIncome.length > 0) keys.add(r.key)
  for (const r of kept) keys.add(r.run_key)
  const ordered = [
    ...RUN_ORDER.filter(k => keys.has(k)),
    ...[...keys].filter(k => !RUN_ORDER.includes(k as RunKey)).sort(),
  ]

  let nowTotal = ZERO, thenTotal = ZERO
  const runs = ordered.map(key => {
    const l = live.find(r => r.key === key)
    const k = kept.find(r => r.run_key === key)
    const now = l ? liveFigures(l) : ZERO
    const then = k ? keptFigures(k) : null
    nowTotal = add(nowTotal, now)
    if (then) thenTotal = add(thenTotal, then)
    return { key, label: l?.label ?? k?.label ?? RUN_LABELS[key as RunKey] ?? key, now, then }
  })
  return { runs, total: { now: nowTotal, then: thenTotal } }
}

/** The change in percent, or null when there was nothing to change from. */
export function percentChange(now: number, then: number): number | null {
  if (then === 0) return null
  return round2((now - then) / Math.abs(then) * 100)
}

export interface PersonDelta {
  key: string
  name: string
  code: string | null
  now: number
  then: number
  difference: number
}

/**
 * Who makes the difference: people new this month, people no longer on it,
 * and people whose total cost changed — each the sum of all their lines,
 * salary and other income alike, and each list largest difference first.
 */
export function peopleDifference(
  live: PayrollRun[], lines: SavedRunLine[],
): { joined: PersonDelta[]; left: PersonDelta[]; changed: PersonDelta[] } {
  type Side = { total: number; salaryName: string | null; anyName: string; code: string | null }
  const nowBy = new Map<string, Side>()
  const thenBy = new Map<string, Side>()
  const put = (map: Map<string, Side>, key: string, amount: number, name: string,
    salary: boolean, code: string | null) => {
    const cur = map.get(key) ?? { total: 0, salaryName: null, anyName: name, code: null }
    cur.total += amount
    if (salary && cur.salaryName === null) cur.salaryName = name
    if (cur.code === null && code) cur.code = code
    map.set(key, cur)
  }

  const liveByCode = new Map<string, string>()
  for (const r of live) {
    for (const s of r.salaries) {
      put(nowBy, s.employeeId, s.line.totalCost, s.name, true, s.code)
      if (s.code) liveByCode.set(s.code, s.employeeId)
    }
    for (const o of r.otherIncome) {
      put(nowBy, o.employeeId, o.line.totalCost, o.name, false, o.code)
      if (o.code && !liveByCode.has(o.code)) liveByCode.set(o.code, o.employeeId)
    }
  }

  lines.forEach((l, n) => {
    const key = l.employee_id
      ?? (l.employee_code ? (liveByCode.get(l.employee_code) ?? `code:${l.employee_code}`) : `line:${n}`)
    put(thenBy, key, Number(l.total_cost) || 0, l.employee_name, l.line_kind === 'salary', l.employee_code)
  })

  const delta = (key: string): PersonDelta => {
    const a = nowBy.get(key), b = thenBy.get(key)
    const now = round2(a?.total ?? 0), then = round2(b?.total ?? 0)
    return {
      key,
      name: a?.salaryName ?? b?.salaryName ?? a?.anyName ?? b?.anyName ?? '',
      code: a?.code ?? b?.code ?? null,
      now, then, difference: round2(now - then),
    }
  }
  const bySize = (x: PersonDelta, y: PersonDelta) => Math.abs(y.difference) - Math.abs(x.difference)

  const joined = [...nowBy.keys()].filter(k => !thenBy.has(k)).map(delta).sort(bySize)
  const left = [...thenBy.keys()].filter(k => !nowBy.has(k)).map(delta).sort(bySize)
  const changed = [...nowBy.keys()].filter(k => thenBy.has(k)).map(delta)
    .filter(d => Math.abs(d.difference) >= 0.01).sort(bySize)
  return { joined, left, changed }
}

const round2 = (n: number): number => Math.round(n * 100) / 100
