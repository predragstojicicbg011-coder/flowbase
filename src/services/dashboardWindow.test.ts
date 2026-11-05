import {
  belgradeToday, HOME_SHORTCUTS, ledgerRange, monthsOf, withFrom, withTo, shortcutOf, windowLabel,
} from './dashboardWindow'

// `today` is always a 'YYYY-MM-DD' string; nothing here builds a Date, so no
// test can pass or fail by the machine's time zone.

const shortcut = (label: string) => {
  const s = HOME_SHORTCUTS.find(x => x.label === label)
  if (!s) throw new Error(`nema prečice ${label}`)
  return s
}

describe('the months a window holds', () => {
  it('a one-month window is one month', () => {
    expect(monthsOf({ from: '2026-11', to: '2026-11' })).toEqual(['2026-11'])
  })

  it('crosses a year boundary', () => {
    expect(monthsOf({ from: '2025-12', to: '2026-02' })).toEqual(['2025-12', '2026-01', '2026-02'])
  })

  it('counts every month of a window longer than a year', () => {
    const m = monthsOf({ from: '2025-03', to: '2026-06' })
    expect(m).toHaveLength(16)
    expect(m[15]).toBe('2026-06')
  })
})

describe('the ledger range', () => {
  it('runs from the first day of the first month to the last day of the last', () => {
    expect(ledgerRange({ from: '2026-01', to: '2026-04' }, '2026-11-05'))
      .toEqual({ dateFrom: '2026-01-01', dateTo: '2026-04-30' })
  })

  it('ends February on the 28th, and on the 29th in a leap year', () => {
    expect(ledgerRange({ from: '2026-02', to: '2026-02' }, '2026-11-05').dateTo).toBe('2026-02-28')
    expect(ledgerRange({ from: '2028-02', to: '2028-02' }, '2028-11-05').dateTo).toBe('2028-02-29')
  })

  it('ends December on the 31st', () => {
    expect(ledgerRange({ from: '2025-12', to: '2025-12' }, '2026-11-05').dateTo).toBe('2025-12-31')
  })

  it('cuts the current month at today', () => {
    expect(ledgerRange({ from: '2026-01', to: '2026-11' }, '2026-11-05').dateTo).toBe('2026-11-05')
  })
})

describe('the shortcuts', () => {
  const today = '2026-11-05'

  it('this month is the current month', () => {
    expect(shortcut('Ovaj mesec').of(today)).toEqual({ from: '2026-11', to: '2026-11' })
  })

  it('this quarter starts on the first month of the quarter', () => {
    expect(shortcut('Ovaj kvartal').of(today)).toEqual({ from: '2026-10', to: '2026-11' })
    expect(shortcut('Ovaj kvartal').of('2026-03-31')).toEqual({ from: '2026-01', to: '2026-03' })
  })

  it('year to date starts in January', () => {
    expect(shortcut('Od početka godine').of(today)).toEqual({ from: '2026-01', to: '2026-11' })
  })

  it('last month is the whole month before, across a year boundary too', () => {
    expect(shortcut('Prošli mesec').of(today)).toEqual({ from: '2026-10', to: '2026-10' })
    expect(shortcut('Prošli mesec').of('2026-01-15')).toEqual({ from: '2025-12', to: '2025-12' })
  })

  it('has the four labels in the order the page shows them', () => {
    expect(HOME_SHORTCUTS.map(s => s.label))
      .toEqual(['Ovaj mesec', 'Ovaj kvartal', 'Od početka godine', 'Prošli mesec'])
  })

  it('names the shortcut a window matches, or nothing', () => {
    expect(shortcutOf({ from: '2026-10', to: '2026-11' }, today)).toBe('Ovaj kvartal')
    expect(shortcutOf({ from: '2026-02', to: '2026-05' }, today)).toBe('')
  })
})

describe('picking a month', () => {
  const today = '2026-11-05'
  const ytd = { from: '2026-01', to: '2026-11' }

  it('moves the start and keeps the end', () => {
    expect(withFrom(ytd, '2026-04', today)).toEqual({ from: '2026-04', to: '2026-11' })
  })

  it('cannot set either end past the current month', () => {
    expect(withFrom(ytd, '2027-02', today)).toEqual({ from: '2026-11', to: '2026-11' })
    expect(withTo(ytd, '2026-12', today)).toEqual({ from: '2026-01', to: '2026-11' })
  })

  it('pulls the end along when the start passes it', () => {
    expect(withFrom({ from: '2026-01', to: '2026-03' }, '2026-06', today)).toEqual({ from: '2026-06', to: '2026-06' })
  })

  it('pulls the start back when the end goes before it', () => {
    expect(withTo({ from: '2026-05', to: '2026-08' }, '2026-02', today)).toEqual({ from: '2026-02', to: '2026-02' })
  })

  it('ignores a cleared or malformed month', () => {
    expect(withFrom(ytd, '', today)).toBe(ytd)
    expect(withTo(ytd, '2026-13', today)).toBe(ytd)
  })
})

describe('the label of a window', () => {
  it('names one month by itself', () => {
    expect(windowLabel({ from: '2026-10', to: '2026-10' })).toBe('okt 2026')
  })

  it('names the first and last month', () => {
    expect(windowLabel({ from: '2026-01', to: '2026-11' })).toBe('jan – nov 2026')
    expect(windowLabel({ from: '2025-11', to: '2026-02' })).toBe('nov 2025 – feb 2026')
  })
})

describe('today, in Belgrade', () => {
  it('is already the 1st after midnight in Belgrade, while it is still the 31st in UTC', () => {
    expect(belgradeToday(new Date(Date.UTC(2026, 9, 31, 23, 30)))).toBe('2026-11-01')
  })

  it('keeps summer time in mind: 22:30 UTC in July is past midnight in Belgrade', () => {
    expect(belgradeToday(new Date(Date.UTC(2026, 6, 14, 22, 30)))).toBe('2026-07-15')
  })

  it('is the same day at noon', () => {
    expect(belgradeToday(new Date(Date.UTC(2026, 10, 5, 12, 0)))).toBe('2026-11-05')
  })
})
