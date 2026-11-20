import React from 'react'
import { render, screen, fireEvent, waitFor } from '@testing-library/react'
import HR from './HR'
import { RATE_BADGE, RATE_NOT_YET_THE_TWENTIETHS, RATE_WITHHELD } from '../services/payroll/payrollRate'
import { fmtNum } from '../utils/formatters'

// Invented: two people in November 2026, one on a euro contract and one on a
// dinar contract. Plain functions over module state: the CRA config resets mocks.
const state = {
  /** What the rate service answers: a day, or an outage. */
  rate: { quotedOn: '2026-11-20' } as { quotedOn?: string } | 'outage',
}

jest.mock('../supabase', () => ({ __esModule: true, supabase: {} }))
jest.mock('../utils/today', () => ({ __esModule: true, belgradeToday: () => '2026-11-20' }))
jest.mock('../contexts/CompaniesContext', () => ({
  __esModule: true,
  useCompanies: () => ({
    companies: [{ id: 'c-1', name: 'Firma A' }], defaultCompany: { id: 'c-1', name: 'Firma A' },
    showPicker: false, loading: false,
  }),
}))
jest.mock('../services/bookAmounts', () => ({
  __esModule: true,
  getBookRates: async (date: string) => {
    if (state.rate === 'outage') throw new Error('Kurs NBS nije dostupan za 20.11.2026.')
    return { eurRate: 117, usdRate: 100, date, quotedOn: state.rate.quotedOn, source: 'NBS' }
  },
}))
jest.mock('../services/payroll/settings', () => ({
  __esModule: true,
  ...jest.requireActual('../services/payroll/settings'),
  fetchSettings: async () => [],
}))
jest.mock('../services/payroll/holidays', () => ({
  __esModule: true,
  ...jest.requireActual('../services/payroll/holidays'),
  fetchHolidays: async () => [],
}))
jest.mock('../services/payroll/employees', () => {
  const person = (id: string, name: string, code: string) => ({
    id, company_id: 'c-1', code, full_name: name, organisational_unit: 'Jedinica A',
    hired_on: '2025-01-01', seniority_from: '2025-01-01', left_on: null, note: null, deleted_at: null,
  })
  return {
    __esModule: true,
    ...jest.requireActual('../services/payroll/employees'),
    fetchEmployees: async () => [person('e-1', 'Osoba A', 'E-001'), person('e-2', 'Osoba B', 'E-002')],
    fetchContracts: async () => [
      { id: 'k-1', employee_id: 'e-1', valid_from: '2025-01-01', valid_to: null, currency: 'EUR',
        net_amount: 1000, service_years: null, note: null },
      { id: 'k-2', employee_id: 'e-2', valid_from: '2025-01-01', valid_to: null, currency: 'RSD',
        net_amount: 100000, service_years: null, note: null },
    ],
    fetchDeductions: async () => [],
    fetchAllocations: async () => [],
    fetchAbsences: async () => [],
  }
})
// The tabs themselves are not under test: only who the page hands them.
jest.mock('../components/TimesheetGrid', () => ({
  __esModule: true,
  default: ({ people }: { people: { employee: { full_name: string } }[] }) =>
    <div data-testid="grid">{people.map(p => p.employee.full_name).join(', ')}</div>,
}))
jest.mock('../components/AdditionsTab', () => ({
  __esModule: true,
  default: ({ people }: { people: { employee: { full_name: string } }[] }) =>
    <div data-testid="additions">{people.map(p => p.employee.full_name).join(', ')}</div>,
}))

beforeEach(() => { state.rate = { quotedOn: '2026-11-20' } })

describe('HR without a rate', () => {
  it('the timesheet grid keeps everybody, and says why no euro amounts are shown', async () => {
    state.rate = 'outage'
    render(<HR />)
    fireEvent.click(screen.getByRole('button', { name: 'Evidencija radnog vremena' }))
    await waitFor(() => expect(screen.getByTestId('grid')).toHaveTextContent('Osoba A, Osoba B'))
    expect(screen.getByText(RATE_WITHHELD)).toBeInTheDocument()
  })

  it('Additions keeps everybody too', async () => {
    state.rate = 'outage'
    render(<HR />)
    fireEvent.click(screen.getByRole('button', { name: 'Dodaci' }))
    await waitFor(() => expect(screen.getByTestId('additions')).toHaveTextContent('Osoba A, Osoba B'))
    expect(screen.getByText(RATE_WITHHELD)).toBeInTheDocument()
  })

  it('with the rate, the grid has the same people and no such sentence', async () => {
    render(<HR />)
    fireEvent.click(screen.getByRole('button', { name: 'Evidencija radnog vremena' }))
    await waitFor(() => expect(screen.getByTestId('grid')).toHaveTextContent('Osoba A, Osoba B'))
    expect(screen.queryByText(RATE_WITHHELD)).toBeNull()
  })
})

describe('the rate on HR', () => {
  it('the 20th\'s: the badge names its day', async () => {
    render(<HR />)
    expect(await screen.findByText(RATE_BADGE(fmtNum(117), '20.11.2026.'))).toBeInTheDocument()
    expect(screen.queryByText(/još nije objavljen/)).toBeNull()
  })

  it('not the 20th\'s: the badge names the real day and the notice says so', async () => {
    state.rate = { quotedOn: '2026-11-02' }
    render(<HR />)
    expect(await screen.findByText(RATE_BADGE(fmtNum(117), '02.11.2026.'))).toBeInTheDocument()
    expect(screen.getByText(RATE_NOT_YET_THE_TWENTIETHS('20.11.2026.', '02.11.2026.'))).toBeInTheDocument()
  })
})
