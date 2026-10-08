import {
  emptyTimesheet, firstOfMonth, totalHours, workedHours, paidHours,
  checkTimesheet, monthIsReady, prefill, saveTimesheet, label, HOUR_FIELDS,
  workingDaysIn, suggestedFund,
  type TimesheetRow,
} from './timesheets'

const FUND = 168

const sheet = (over: Partial<TimesheetRow> = {}): TimesheetRow => ({
  ...emptyTimesheet('e1', '2026-08'), ...over,
})

describe('firstOfMonth', () => {
  it('takes a month to its first day', () => {
    expect(firstOfMonth('2026-08')).toBe('2026-08-01')
  })

  it('pulls a mid-month date back to the first', () => {
    // A stray date would become a second row for the same month that the
    // unique index would happily allow.
    expect(firstOfMonth('2026-08-23')).toBe('2026-08-01')
  })
})

describe('the sums', () => {
  const t = sheet({
    regular_hours: 120, holiday_hours: 8,
    vacation_hours: 32, sick_hours: 4, unpaid_hours: 4,
  })

  it('adds everything up, unpaid leave included', () => {
    expect(totalHours(t)).toBe(168)
  })

  it('counts only worked hours as worked', () => {
    expect(workedHours(t)).toBe(120)
  })

  it('leaves unpaid leave out of the paid hours', () => {
    expect(paidHours(t)).toBe(164)
  })
})

describe('checkTimesheet', () => {
  it('is happy with a month that adds up', () => {
    expect(checkTimesheet(sheet({ regular_hours: 168 }), FUND)).toEqual([])
  })

  it('refuses hours over the fund, and says why the engine will not take them', () => {
    // Overtime is the one rule with no export behind it, so it is refused
    // rather than guessed at.
    const [p] = checkTimesheet(sheet({ regular_hours: 180 }), FUND)
    expect(p.level).toBe('error')
    expect(p.message).toContain('12 preko fonda')
    expect(p.message).toContain('prekovremeni rad')
  })

  it('refuses hours that do not reach the fund', () => {
    // Missing hours quietly become a smaller salary that looks deliberate.
    const [p] = checkTimesheet(sheet({ regular_hours: 160 }), FUND)
    expect(p.level).toBe('error')
    expect(p.message).toContain('8 nije raspoređeno')
  })

  it('accepts a month made up entirely of absence', () => {
    // A full month of sick leave is a real month, not a broken timesheet.
    expect(checkTimesheet(sheet({ sick_hours: 168 }), FUND)).toEqual([])
  })

  it('warns, rather than passing over, a month with no hour fund', () => {
    const [p] = checkTimesheet(sheet({ regular_hours: 168 }), null)
    expect(p.level).toBe('warning')
    expect(p.message).toContain('ne mogu da se usklade')
  })

  it('reports a negative entry as an error', () => {
    const problems = checkTimesheet(sheet({ regular_hours: 176, sick_hours: -8 }), FUND)
    expect(problems.some(p => p.message.includes('Bolovanje do 30 dana, 65%: sati ne mogu biti negativni'))).toBe(true)
  })
})

describe('monthIsReady', () => {
  const good = sheet({ regular_hours: 168 })

  it('is ready when everybody has hours that add up', () => {
    expect(monthIsReady([{ employee_id: 'e1', timesheet: good }], FUND).ready).toBe(true)
  })

  it('is not ready when somebody has no timesheet at all', () => {
    // The run would simply calculate them as zero hours, which is a full
    // month of nothing dressed up as a figure.
    const r = monthIsReady([{ employee_id: 'e2', timesheet: null }], FUND)
    expect(r.ready).toBe(false)
    expect(r.missing).toEqual(['e2'])
  })

  it('is not ready when somebody hours do not reconcile', () => {
    const r = monthIsReady([{ employee_id: 'e3', timesheet: sheet({ regular_hours: 100 }) }], FUND)
    expect(r.ready).toBe(false)
    expect(r.failing).toEqual(['e3'])
  })
})

describe('prefill', () => {
  it('fills a full month of ordinary work', () => {
    const t = prefill('e1', '2026-08', FUND)
    expect(t.regular_hours).toBe(168)
    expect(checkTimesheet(t, FUND)).toEqual([])
  })
})

describe('saveTimesheet', () => {
  const client = (result: any) => {
    const calls: any = {}
    return {
      calls,
      from: () => ({
        upsert: (row: any, opts: any) => {
          calls.row = row; calls.opts = opts
          return { select: () => Promise.resolve(result) }
        },
      }),
    }
  }

  it('upserts on the employee and the month', async () => {
    // Read-then-write would leave a window in which two saves both insert,
    // and the unique index is what actually guarantees one row.
    const c = client({ data: [{ id: 'x' }], error: null })
    await saveTimesheet(c, sheet({ regular_hours: 168 }))
    expect(c.calls.opts).toEqual({ onConflict: 'employee_id,month' })
    expect(c.calls.row.month).toBe('2026-08-01')
    expect(c.calls.row.regular_hours).toBe(168)
  })

  it('treats a zero-row upsert as a failure, not a success', async () => {
    // PostgREST calls a refused write a success with no rows, and the page
    // would go on showing hours that nothing has stored.
    await expect(saveTimesheet(client({ data: [], error: null }), sheet()))
      .rejects.toThrow(/upis odbijen/)
  })

  it('passes the database error through', async () => {
    await expect(saveTimesheet(client({ data: null, error: { message: 'nope' } }), sheet()))
      .rejects.toThrow(/nope/)
  })

  it('turns text typed into a field into a number', async () => {
    const c = client({ data: [{ id: 'x' }], error: null })
    await saveTimesheet(c, sheet({ regular_hours: '40' as any, sick_hours: '' as any }))
    expect(c.calls.row.regular_hours).toBe(40)
    expect(c.calls.row.sick_hours).toBe(0)
  })
})

describe('label', () => {
  it('names every hour field', () => {
    for (const f of HOUR_FIELDS) expect(label(f)).toBeTruthy()
  })
})

describe('the suggested fund', () => {
  it('counts the weekdays of a month', () => {
    // The two months this module has evidence for: August 2026 was calculated
    // on 168 hours and has 21 weekdays, September's settings say 176 and it
    // has 22. Which is how the September row was identified as September.
    expect(workingDaysIn('2026-08')).toBe(21)
    expect(workingDaysIn('2026-09')).toBe(22)
    expect(suggestedFund('2026-08')).toBe(168)
    expect(suggestedFund('2026-09')).toBe(176)
  })

  it('does not drift with the local timezone', () => {
    // Built from UTC parts throughout. A local-time Date would put the first
    // of a month into the previous one west of Greenwich and quietly drop a
    // working day.
    expect(workingDaysIn('2026-02')).toBe(20)
    expect(workingDaysIn('2026-01')).toBe(22)
  })

  it('is never used to reconcile — only checkTimesheet does that', () => {
    // A fund guessed from weekdays ignores public holidays, and reconciling
    // against it would report a correct timesheet as wrong.
    expect(checkTimesheet(sheet({ regular_hours: 160 }), null)
      .every(p => p.level === 'warning')).toBe(true)
  })
})
