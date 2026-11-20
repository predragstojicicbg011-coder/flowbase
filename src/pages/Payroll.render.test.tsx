import React from 'react'
import { render, screen, fireEvent, waitFor } from '@testing-library/react'
import Payroll from './Payroll'
import type { SavedRun } from '../services/payroll/savedRuns'

// ── The page's world, invented: one company, one person on a round dinar
//    contract, November 2026 with no holiday rows. Plain functions over
//    module state, not jest.fn(impl): the CRA config resets mocks.

const state = {
  /** What the months list reads: every kept run of the company. */
  months: [] as SavedRun[],
  /** How many times the months list has been read. */
  monthReads: 0,
  saves: 0,
}

const keptRun = (over: Partial<SavedRun> = {}): SavedRun => ({
  id: 'k-1', company_id: 'c-1', period_month: '2026-10-01', run_key: 'regular',
  label: 'Zarade', status: 'draft', exchange_rate: null, eur_rate: null, month_hours: 184,
  gross: 0, net: 0, income_tax: 0, contributions_employee: 0, contributions_employer: 0,
  total_cost: 1000, deductions_third_party: 0, deductions_employer: 0,
  calculated_at: '', posted_at: null, note: null, ...over,
})

jest.mock('../supabase', () => ({ __esModule: true, supabase: {} }))
jest.mock('../utils/today', () => ({ __esModule: true, belgradeToday: () => '2026-11-20' }))
jest.mock('../contexts/CompaniesContext', () => ({
  __esModule: true,
  useCompanies: () => ({
    companies: [{ id: 'c-1', name: 'Firma A' }], defaultCompany: { id: 'c-1', name: 'Firma A' },
    showPicker: false, loading: false,
  }),
}))
jest.mock('../contexts/SystemCategoriesContext', () => ({
  __esModule: true,
  useSystemCategories: () => ({ map: {}, loading: true, error: null, refresh: async () => {} }),
}))
jest.mock('../components/SystemCategoryNotice', () => ({ __esModule: true, default: () => null }))
jest.mock('../services/bookAmounts', () => ({
  __esModule: true,
  getBookRates: async (date: string) => ({ eurRate: 117, usdRate: 100, date, quotedOn: date }),
}))
jest.mock('../services/payroll/settings', () => {
  const actual = jest.requireActual('../services/payroll/settings')
  const { RATES_2026 } = jest.requireActual('../services/payroll/engine')
  return { __esModule: true, ...actual, fetchSettings: async () => [], ratesFor: () => RATES_2026 }
})
jest.mock('../services/payroll/employees', () => ({
  __esModule: true,
  ...jest.requireActual('../services/payroll/employees'),
  fetchEmployees: async () => [{
    id: 'e-1', company_id: 'c-1', code: 'E-001', full_name: 'Osoba A', organisational_unit: 'Jedinica A',
    hired_on: '2025-01-01', seniority_from: '2025-01-01', left_on: null, note: null, deleted_at: null,
  }],
  fetchContracts: async () => [{
    id: 'k-1', employee_id: 'e-1', valid_from: '2025-01-01', valid_to: null, currency: 'RSD',
    net_amount: 100000, service_years: null, note: null,
  }],
  fetchDeductions: async () => [],
  fetchAllocations: async () => [],
  fetchAbsences: async () => [],
}))
jest.mock('../services/payroll/timesheets', () => {
  const actual = jest.requireActual('../services/payroll/timesheets')
  return {
    __esModule: true, ...actual,
    fetchTimesheets: async (_c: unknown, month: string) =>
      [{ ...actual.emptyTimesheet('e-1', month), regular_hours: 168 }],
  }
})
jest.mock('../services/payroll/holidays', () => ({
  __esModule: true,
  ...jest.requireActual('../services/payroll/holidays'),
  fetchHolidays: async () => [],
}))
jest.mock('../services/payroll/additions', () => ({
  __esModule: true,
  ...jest.requireActual('../services/payroll/additions'),
  fetchAdditions: async () => [],
}))
jest.mock('../services/payroll/savedRuns', () => ({
  __esModule: true,
  ...jest.requireActual('../services/payroll/savedRuns'),
  fetchRuns: async (_c: unknown, _company: string, month?: string) => {
    if (month) return []
    state.monthReads += 1
    return state.months
  },
  saveRun: async () => { state.saves += 1; return {} },
}))
// The panel is not what is under test here: only that its onPosted (called
// after a posting and after an undo) makes the months list read again.
jest.mock('../components/PayrollPostingPanel', () => ({
  __esModule: true,
  default: ({ onPosted }: { onPosted: () => void }) =>
    <button onClick={onPosted}>panel-posted-or-undone</button>,
}))

beforeEach(() => {
  state.months = [keptRun()]
  state.monthReads = 0
  state.saves = 0
})

const readsSettled = async (n: number) => waitFor(() => expect(state.monthReads).toBe(n))

describe('the months list on the Payroll page', () => {
  it('reads again after Recalculate', async () => {
    render(<Payroll />)
    expect(await screen.findByText('Nacrt')).toBeInTheDocument()
    const before = state.monthReads

    state.months = [keptRun(), keptRun({ id: 'k-2', period_month: '2026-11-01' })]
    fireEvent.click(await screen.findByRole('button', { name: 'Ponovo obračunaj' }))
    await waitFor(() => expect(state.saves).toBe(1))
    await readsSettled(before + 1)
    expect(await screen.findByText(/Sačuvano: 2 meseca/)).toBeInTheDocument()
  })

  it('reads again after a posting or an undo', async () => {
    render(<Payroll />)
    expect(await screen.findByText('Nacrt')).toBeInTheDocument()
    const before = state.monthReads

    state.months = [keptRun({ status: 'posted' })]
    fireEvent.click(await screen.findByRole('button', { name: 'panel-posted-or-undone' }))
    await readsSettled(before + 1)
    expect(await screen.findByText('Proknjiženo')).toBeInTheDocument()

    state.months = [keptRun()]
    fireEvent.click(screen.getByRole('button', { name: 'panel-posted-or-undone' }))
    await readsSettled(before + 2)
    expect(await screen.findByText('Nacrt')).toBeInTheDocument()
  })
})
