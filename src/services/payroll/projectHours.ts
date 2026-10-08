// ─── Payroll cost over projects, by the hours worked on them ────────────────
//
// THE RULE. An employee's cost for a month is shared out over the projects
// they worked on in proportion to the hours they worked on each, and whatever
// is not project work is company overhead ("Opšti troškovi", project null).
//
//   share(project) = hours on the project / PAID hours of the month
//   share(overhead) = 1 − Σ share(project)
//
// THE DENOMINATOR IS THE PAID HOURS, NOT THE WORKED ONES, and that is what
// sends absences to overhead. A salary is prorated on every paid hour — work
// and paid absence alike, each absence at its coefficient (`run.hours`, from
// `effectiveHours`). Annual leave, a public holiday or sick leave is paid for
// but is not work on any site, so its share of the cost belongs to nobody's
// project. Dividing by worked hours instead would quietly charge a site for a
// week its foreman spent on holiday.
//
// Worked hours not given to any project are overhead too: a timesheet with no
// project rows is a month that is wholly overhead, which is the honest default
// for a month nobody has broken down.
//
// MORE PROJECT HOURS THAN WORKED HOURS IS REFUSED, not scaled. It is a data
// error — somebody typed 180 hours on a site in a month of 168 worked — and
// scaling it down would post a figure nobody entered.
//
// THE AMOUNT IS SPLIT IN WHOLE PARAS, and the remainder goes on the LAST line
// (overhead when there is any, else the last project). Every line but the last
// is rounded down to the para, so no line can go negative and the lines always
// add back to exactly the amount split.

export interface ProjectHoursRow {
  id?: string
  company_id?: string
  employee_id: string
  /** First of the month. */
  month: string
  project_id: string
  hours: number
}

/** The two figures from a person's month that the shares are measured against. */
export interface HoursBasis {
  /** regular_hours — the most that can be on projects. */
  worked: number
  /** Every paid hour, each at its coefficient — what the salary is prorated on. */
  paid: number
}

export interface ProjectShare {
  /** null is overhead. */
  project_id: string | null
  /** Hours on the project; for overhead, the paid hours that are on none. */
  hours: number
  /** Of the person's cost, 0..1. The shares of one person add up to 1. */
  share: number
}

export interface SharesResult {
  shares: ProjectShare[]
  /** Why these hours cannot be used, or null. */
  error: string | null
}

const EPS = 0.005

function num(v: unknown): number {
  const n = typeof v === 'number' ? v : parseFloat(String(v ?? ''))
  return Number.isFinite(n) ? n : 0
}

const round2 = (n: number): number => Math.round(n * 100) / 100

/** The rows for one person, merged per project, zeros dropped, in a fixed order. */
export function mergeProjectHours(
  rows: readonly { project_id: string | null; hours: number }[],
): { project_id: string; hours: number }[] {
  const by = new Map<string, number>()
  for (const r of rows) {
    if (!r.project_id) continue
    by.set(r.project_id, (by.get(r.project_id) ?? 0) + num(r.hours))
  }
  return [...by]
    .map(([project_id, hours]) => ({ project_id, hours: round2(hours) }))
    .filter(r => r.hours !== 0)
    .sort((a, b) => a.project_id.localeCompare(b.project_id))
}

/** What the hours on projects add up to. */
export function assignedHours(rows: readonly { hours: number }[]): number {
  return round2(rows.reduce((s, r) => s + num(r.hours), 0))
}

/**
 * Why a person's project hours do not fit their month, or null.
 *
 * `worked` is regular_hours from the timesheet; `who` names them in the
 * message.
 */
export function checkProjectHours(
  rows: readonly { project_id: string | null; hours: number }[],
  worked: number,
  who = 'This employee',
): string | null {
  if (rows.some(r => num(r.hours) < 0)) {
    return `${who}: hours on a project cannot be negative.`
  }
  if (rows.some(r => !r.project_id && num(r.hours) > 0)) {
    return `${who}: hours are entered on a row with no project. Hours on no project are `
      + 'overhead already — choose a project or remove the row.'
  }
  const assigned = assignedHours(mergeProjectHours(rows))
  if (assigned > num(worked) + EPS) {
    return `${who}: ${fmt(assigned)} hours are put on projects but only ${fmt(num(worked))} `
      + `were worked this month — ${fmt(assigned - num(worked))} too many. Correct the hours `
      + 'on the timesheet or on the projects; nothing is scaled down to fit.'
  }
  return null
}

/**
 * How one person's cost falls over projects and overhead.
 *
 * `basis` null means there is no timesheet behind the month (an addition paid
 * to somebody with no salary line, say): the whole cost is overhead, unless
 * hours were put on projects, which then have nothing to be a share of.
 */
export function projectShares(
  rows: readonly { project_id: string | null; hours: number }[],
  basis: HoursBasis | null,
  who = 'This employee',
): SharesResult {
  const merged = mergeProjectHours(rows)
  const worked = basis ? num(basis.worked) : 0
  const why = checkProjectHours(rows, worked, who)
  if (why) return { shares: [], error: why }

  const paid = basis ? num(basis.paid) : 0
  if (!(paid > 0)) {
    if (merged.length > 0) {
      return {
        shares: [],
        error: `${who}: hours are put on projects but the month has no paid hours to `
          + 'share the cost over.',
      }
    }
    return { shares: [{ project_id: null, hours: 0, share: 1 }], error: null }
  }

  const assigned = assignedHours(merged)
  if (assigned > paid + EPS) {
    // Only reachable when absences are priced below 1 and work is not all
    // there is; still more hours on projects than the salary pays for.
    return {
      shares: [],
      error: `${who}: ${fmt(assigned)} hours on projects against ${fmt(paid)} paid hours. `
        + 'The project hours cannot be more than the month pays for.',
    }
  }

  const shares: ProjectShare[] = merged.map(r => ({
    project_id: r.project_id, hours: r.hours, share: r.hours / paid,
  }))
  const rest = paid - assigned
  if (rest > EPS) shares.push({ project_id: null, hours: round2(rest), share: rest / paid })
  return { shares, error: null }
}

export interface DistributedLine {
  project_id: string | null
  amount: number
}

/**
 * An amount split by weights, in whole paras, adding up exactly.
 *
 * Every line but the last is rounded DOWN to the para; the last takes what is
 * left. So no line is negative (for a positive amount) and the sum is the
 * amount to the para. A negative amount is split as its mirror. Lines that
 * come to nothing are dropped.
 */
export function distributeAmount(
  amount: number, weights: readonly { project_id: string | null; share: number }[],
): DistributedLine[] {
  const usable = weights.filter(w => w.share > 0)
  if (usable.length === 0) return []
  const sign = amount < 0 ? -1 : 1
  const totalCents = Math.round(Math.abs(amount) * 100)
  const weightSum = usable.reduce((s, w) => s + w.share, 0)
  const out: DistributedLine[] = []
  let used = 0
  usable.forEach((w, i) => {
    const cents = i === usable.length - 1
      ? totalCents - used
      : Math.floor((totalCents * w.share) / weightSum + 1e-9)
    used += cents
    out.push({ project_id: w.project_id, amount: (sign * cents) / 100 })
  })
  return out.filter(l => l.amount !== 0)
}

/** Per-project totals across many distributed amounts, overhead last. */
export function totalsByProject(
  lines: readonly DistributedLine[],
): DistributedLine[] {
  const by = new Map<string | null, number>()
  for (const l of lines) by.set(l.project_id, (by.get(l.project_id) ?? 0) + Math.round(l.amount * 100))
  return [...by]
    .map(([project_id, cents]) => ({ project_id, amount: cents / 100 }))
    .sort((a, b) => (a.project_id === null ? 1 : b.project_id === null ? -1
      : a.project_id.localeCompare(b.project_id)))
}

/**
 * What the person's month leaves for overhead, in hours, for a screen that
 * shows assigned against worked.
 */
export function unassignedWorkedHours(
  rows: readonly { project_id: string | null; hours: number }[], worked: number,
): number {
  return round2(num(worked) - assignedHours(mergeProjectHours(rows)))
}

const fmt = (n: number): string => (Math.round(n * 100) / 100).toString()

// ─── Reading and writing ────────────────────────────────────────────────────

/** Every project row for a month, all employees. */
export async function fetchProjectHours(client: any, month: string): Promise<ProjectHoursRow[]> {
  const first = firstOf(month)
  const { data, error } = await client
    .from('payroll_timesheet_projects')
    .select('id, company_id, employee_id, month, project_id, hours')
    .eq('month', first)
    .order('employee_id')
  if (error) throw new Error(`Sati po projektima nisu učitani: ${error.message}`)
  return (data || []).map((r: any) => ({ ...r, hours: num(r.hours) }))
}

/** The rows grouped by employee. */
export function projectHoursByEmployee(
  rows: readonly ProjectHoursRow[],
): Record<string, ProjectHoursRow[]> {
  const out: Record<string, ProjectHoursRow[]> = {}
  for (const r of rows) (out[r.employee_id] ??= []).push(r)
  return out
}

/**
 * Replace one person's project hours for a month with `rows`.
 *
 * Upserts on (employee_id, month, project_id) — the unique key — and deletes
 * the projects that are no longer listed. Rows with no project or no hours are
 * not stored: no row is the same as zero hours. Refuses rows that do not fit
 * `worked` before anything is written.
 */
export async function saveProjectHours(
  client: any,
  args: {
    companyId: string
    employeeId: string
    month: string
    worked: number
    rows: readonly { project_id: string | null; hours: number }[]
  },
): Promise<void> {
  const why = checkProjectHours(args.rows, args.worked)
  if (why) throw new Error(why)
  const first = firstOf(args.month)
  const keep = mergeProjectHours(args.rows).filter(r => r.hours > 0)

  if (keep.length > 0) {
    const payload = keep.map(r => ({
      company_id: args.companyId,
      employee_id: args.employeeId,
      month: first,
      project_id: r.project_id,
      hours: r.hours,
      updated_at: new Date().toISOString(),
    }))
    const { data, error } = await client
      .from('payroll_timesheet_projects')
      .upsert(payload, { onConflict: 'employee_id,month,project_id' })
      .select('id')
    if (error) throw new Error(`Sati po projektima nisu sačuvani: ${error.message}`)
    if (!data || data.length !== payload.length) {
      throw new Error('Sati po projektima nisu sačuvani, a baza nije javila grešku — '
        + 'upis je verovatno odbijen. Proverite da ste prijavljeni kao administrator ili vlasnik.')
    }
  }

  let del = client.from('payroll_timesheet_projects').delete()
    .eq('employee_id', args.employeeId).eq('month', first)
  if (keep.length > 0) {
    del = del.not('project_id', 'in', `(${keep.map(r => r.project_id).join(',')})`)
  }
  const { error: delErr } = await del.select('id')
  if (delErr) throw new Error(`Uklonjeni projekti nisu obrisani: ${delErr.message}`)
}

function firstOf(month: string): string {
  return /^\d{4}-\d{2}$/.test(month) ? `${month}-01` : `${month.slice(0, 7)}-01`
}
