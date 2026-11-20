import fs from 'fs'
import path from 'path'
import { belgradeToday } from './today'
import { belgradeToday as fromDashboardWindow } from '../services/dashboardWindow'

describe('today, in Belgrade, at 00:30 on the 1st', () => {
  it('is already December in winter, while UTC is still on 30 November', () => {
    // 00:30 CET on 1 December 2026 is 23:30 UTC on 30 November.
    const now = new Date(Date.UTC(2026, 10, 30, 23, 30))
    expect(now.toISOString().slice(0, 7)).toBe('2026-11')
    expect(belgradeToday(now)).toBe('2026-12-01')
    expect(belgradeToday(now).slice(0, 7)).toBe('2026-12')
  })

  it('is already July in summer, while UTC is still on 30 June', () => {
    // 00:30 CEST on 1 July 2026 is 22:30 UTC on 30 June.
    const now = new Date(Date.UTC(2026, 5, 30, 22, 30))
    expect(now.toISOString().slice(0, 7)).toBe('2026-06')
    expect(belgradeToday(now)).toBe('2026-07-01')
    expect(belgradeToday(now).slice(0, 7)).toBe('2026-07')
  })

  it('is the one helper, also reached through the home page window', () => {
    expect(fromDashboardWindow).toBe(belgradeToday)
  })
})

describe('the payroll screens open on the month it is in Belgrade', () => {
  // HR, Payroll, the posting panel and the payroll settings each opened their
  // month (or the payment date) from the UTC date, so between midnight and
  // 01:00 (02:00 in summer) on the 1st they opened on the month before.
  const files = [
    'pages/HR.tsx', 'pages/Payroll.tsx',
    'components/PayrollPostingPanel.tsx', 'components/PayrollSettingsTab.tsx',
  ]
  it.each(files)('%s takes its month from belgradeToday, not from the UTC date', file => {
    const source = fs.readFileSync(path.join(__dirname, '..', file), 'utf8')
    expect(source).toContain('belgradeToday()')
    expect(source).not.toMatch(/new Date\(\)\.toISOString\(\)\.slice\(0, (7|10)\)/)
  })
})
