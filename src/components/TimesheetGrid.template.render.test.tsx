import React from 'react'
import { render, screen } from '@testing-library/react'
import TimesheetGrid from './TimesheetGrid'
import { fundFor, workingDaysFor, type HolidayRow } from '../services/payroll/holidays'
import { proposeFromCalendar } from '../services/payroll/preliminaryHours'
import { onTemplateCount } from '../services/payroll/preliminaryText'
import { splitContractedNet } from '../services/payroll/engine'
import type { EmployeeForMonth, AbsenceRow } from '../services/payroll/employees'

// Invented: three people in November 2026 (the 1st a Sunday), none with a
// timesheet. Osoba C is off payroll from the 2nd, so has no working day on
// the payroll this month and is not on template hours.
jest.mock('../supabase', () => ({ __esModule: true, supabase: {} }))
jest.mock('../services/payroll/timesheets', () => ({
  __esModule: true,
  ...jest.requireActual('../services/payroll/timesheets'),
  fetchTimesheets: async () => [],
}))
jest.mock('../services/payroll/projectHours', () => ({
  __esModule: true,
  ...jest.requireActual('../services/payroll/projectHours'),
  fetchProjectHours: async () => [],
}))
jest.mock('./ProjectSelect', () => ({ __esModule: true, default: () => null }))
jest.mock('../services/payroll/preliminaryHoursStore', () => ({
  __esModule: true, savePreliminaryHours: async () => {}, removePreliminaryHours: async () => {},
}))

const HOLIDAYS: HolidayRow[] = [{ holiday_on: '2026-11-11', name: 'Praznik A', kind: 'state' }]
const FUND = fundFor('2026-11', HOLIDAYS, null, null)

const person = (n: number): EmployeeForMonth => ({
  employee: {
    id: `e-${n}`, company_id: 'c-1', code: `E-00${n}`, full_name: `Osoba ${String.fromCharCode(64 + n)}`,
    organisational_unit: null, hired_on: '2025-01-01', seniority_from: '2025-01-01', left_on: null, note: null,
  },
  contract: {
    id: `k-${n}`, employee_id: `e-${n}`, valid_from: '2025-01-01', valid_to: null, currency: 'RSD',
    net_amount: 100000, service_years: null, note: null,
  },
  net: splitContractedNet(100000, 1, 0.004),
  deductions: [], allocation: null, serviceYears: 1, serviceYearsDerived: true,
})
const AWAY: AbsenceRow = {
  id: 'a-3', employee_id: 'e-3', reason: 'unpaid_leave', valid_from: '2026-11-02', valid_to: null, note: null,
}

describe('the template panel counts who the template covers', () => {
  it('leaves out somebody with no working day on the payroll this month', async () => {
    render(<TimesheetGrid people={[person(1), person(2), person(3)]} month="2026-11" fund={FUND}
      workingDays={workingDaysFor('2026-11', HOLIDAYS)} running canSaveTemplate
      template={proposeFromCalendar('2026-11', FUND)} holidays={HOLIDAYS} absences={[AWAY]} />)
    expect(await screen.findByText(onTemplateCount(2))).toBeInTheDocument()
    expect(screen.queryByText(onTemplateCount(3))).toBeNull()
    // The grid itself still says all three have no hours.
    expect(screen.getByText(/3 bez sati/)).toBeInTheDocument()
  })
})
