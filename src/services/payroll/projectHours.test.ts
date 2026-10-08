import {
  projectShares, distributeAmount, checkProjectHours, mergeProjectHours,
  totalsByProject, unassignedWorkedHours, saveProjectHours,
} from './projectHours'

const sum = (lines: { amount: number }[]) =>
  Math.round(lines.reduce((s, l) => s + l.amount, 0) * 100) / 100

describe('projectShares', () => {
  it('shares a fully worked month by project hours, the rest to overhead', () => {
    const r = projectShares(
      [{ project_id: 'a', hours: 100 }, { project_id: 'b', hours: 40 }],
      { worked: 168, paid: 168 })
    expect(r.error).toBeNull()
    expect(r.shares).toEqual([
      { project_id: 'a', hours: 100, share: 100 / 168 },
      { project_id: 'b', hours: 40, share: 40 / 168 },
      { project_id: null, hours: 28, share: 28 / 168 },
    ])
  })

  it('sends paid absences to overhead: the denominator is the paid hours', () => {
    // 136 worked, all on site A, plus 32 hours of annual leave. The leave is
    // paid but is not work on the site.
    const r = projectShares([{ project_id: 'a', hours: 136 }], { worked: 136, paid: 168 })
    expect(r.shares.find(s => s.project_id === 'a')!.share).toBeCloseTo(136 / 168, 10)
    expect(r.shares.find(s => s.project_id === null)!.hours).toBe(32)
  })

  it('has no overhead line when every paid hour is on a project', () => {
    const r = projectShares([{ project_id: 'a', hours: 168 }], { worked: 168, paid: 168 })
    expect(r.shares).toEqual([{ project_id: 'a', hours: 168, share: 1 }])
  })

  it('is all overhead with no project rows, or with no timesheet behind it', () => {
    expect(projectShares([], { worked: 168, paid: 168 }).shares)
      .toEqual([{ project_id: null, hours: 168, share: 1 }])
    expect(projectShares([], null).shares).toEqual([{ project_id: null, hours: 0, share: 1 }])
  })

  it('REFUSES more project hours than worked hours rather than scaling them', () => {
    const r = projectShares(
      [{ project_id: 'a', hours: 120 }, { project_id: 'b', hours: 60 }],
      { worked: 168, paid: 168 }, 'Petrović Marko')
    expect(r.shares).toEqual([])
    expect(r.error).toMatch(/Petrović Marko: 180 hours .* only 168 .* 12 too many/)
  })

  it('refuses project hours in a month with no paid hours', () => {
    expect(projectShares([{ project_id: 'a', hours: 8 }], null).error).toMatch(/168|worked|paid/)
  })

  it('merges two rows of the same project', () => {
    expect(mergeProjectHours([
      { project_id: 'b', hours: 5 }, { project_id: 'a', hours: 2 }, { project_id: 'b', hours: 3 },
      { project_id: 'c', hours: 0 },
    ])).toEqual([{ project_id: 'a', hours: 2 }, { project_id: 'b', hours: 8 }])
  })
})

describe('checkProjectHours', () => {
  it('refuses negative hours and hours on no project', () => {
    expect(checkProjectHours([{ project_id: 'a', hours: -1 }], 10)).toMatch(/negative/)
    expect(checkProjectHours([{ project_id: null, hours: 4 }], 10)).toMatch(/no project/)
    expect(checkProjectHours([{ project_id: 'a', hours: 10 }], 10)).toBeNull()
  })

  it('reports what is left for overhead', () => {
    expect(unassignedWorkedHours([{ project_id: 'a', hours: 100.5 }], 168)).toBe(67.5)
  })
})

describe('distributeAmount', () => {
  it('adds up to the amount exactly, the remainder on the last line', () => {
    const lines = distributeAmount(100, [
      { project_id: 'a', share: 1 / 3 }, { project_id: 'b', share: 1 / 3 }, { project_id: null, share: 1 / 3 },
    ])
    expect(lines).toEqual([
      { project_id: 'a', amount: 33.33 }, { project_id: 'b', amount: 33.33 }, { project_id: null, amount: 33.34 },
    ])
  })

  it('never makes a line negative and drops lines worth nothing', () => {
    const lines = distributeAmount(0.01, [
      { project_id: 'a', share: 0.4 }, { project_id: 'b', share: 0.3 }, { project_id: null, share: 0.3 },
    ])
    expect(lines).toEqual([{ project_id: null, amount: 0.01 }])
  })

  it('holds for awkward real figures', () => {
    for (const amount of [117358.6, 98765.43, 1.01, 250000]) {
      const lines = distributeAmount(amount, [
        { project_id: 'a', share: 97 / 171 }, { project_id: 'b', share: 41 / 171 }, { project_id: null, share: 33 / 171 },
      ])
      expect(sum(lines)).toBe(amount)
      expect(lines.every(l => l.amount > 0)).toBe(true)
    }
  })

  it('splits a negative amount as its mirror', () => {
    expect(distributeAmount(-10, [{ project_id: 'a', share: 0.5 }, { project_id: null, share: 0.5 }]))
      .toEqual([{ project_id: 'a', amount: -5 }, { project_id: null, amount: -5 }])
  })
})

describe('totalsByProject', () => {
  it('adds per project, overhead last', () => {
    expect(totalsByProject([
      { project_id: null, amount: 1.1 }, { project_id: 'b', amount: 2.2 },
      { project_id: 'a', amount: 0.1 }, { project_id: 'a', amount: 0.2 },
    ])).toEqual([
      { project_id: 'a', amount: 0.3 }, { project_id: 'b', amount: 2.2 }, { project_id: null, amount: 1.1 },
    ])
  })
})

describe('saveProjectHours', () => {
  function client() {
    const calls: any = { upserts: [], deletes: [] }
    return {
      calls,
      from(table: string) {
        expect(table).toBe('payroll_timesheet_projects')
        const del: any = {
          eq: (c: string, v: any) => { calls.deletes.push(['eq', c, v]); return del },
          not: (c: string, op: string, v: any) => { calls.deletes.push(['not', c, op, v]); return del },
          select: async () => ({ data: [], error: null }),
        }
        return {
          upsert(rows: any[], opts: any) {
            calls.upserts.push({ rows, opts })
            return { select: async () => ({ data: rows.map((_, i) => ({ id: String(i) })), error: null }) }
          },
          delete: () => del,
        }
      },
    }
  }

  it('upserts on the unique key and deletes the projects no longer listed', async () => {
    const c = client()
    await saveProjectHours(c, {
      companyId: 'c1', employeeId: 'e1', month: '2026-09', worked: 168,
      rows: [{ project_id: 'a', hours: 100 }, { project_id: 'b', hours: 0 }],
    })
    expect(c.calls.upserts[0].opts).toEqual({ onConflict: 'employee_id,month,project_id' })
    expect(c.calls.upserts[0].rows).toHaveLength(1)
    expect(c.calls.upserts[0].rows[0]).toMatchObject({
      company_id: 'c1', employee_id: 'e1', month: '2026-09-01', project_id: 'a', hours: 100,
    })
    expect(c.calls.deletes).toContainEqual(['not', 'project_id', 'in', '(a)'])
  })

  it('deletes every row when nothing is left', async () => {
    const c = client()
    await saveProjectHours(c, { companyId: 'c1', employeeId: 'e1', month: '2026-09', worked: 168, rows: [] })
    expect(c.calls.upserts).toHaveLength(0)
    expect(c.calls.deletes).toEqual([['eq', 'employee_id', 'e1'], ['eq', 'month', '2026-09-01']])
  })

  it('writes nothing when the hours do not fit the month', async () => {
    const c = client()
    await expect(saveProjectHours(c, {
      companyId: 'c1', employeeId: 'e1', month: '2026-09', worked: 100,
      rows: [{ project_id: 'a', hours: 120 }],
    })).rejects.toThrow(/too many/)
    expect(c.calls.upserts).toHaveLength(0)
    expect(c.calls.deletes).toHaveLength(0)
  })
})
