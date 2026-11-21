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
  /** The signed-in role. */
  role: 'administrator' as string | null,
  /** The months the preliminary hours were read for. */
  templateReads: [] as string[],
}

jest.mock('../supabase', () => ({ __esModule: true, supabase: {} }))
jest.mock('../contexts/AuthContext', () => ({ __esModule: true, useAuth: () => ({ role: state.role }) }))
jest.mock('../services/payroll/preliminaryHoursStore', () => ({
  __esModule: true,
  fetchPreliminaryHours: async (_c: unknown, month: string) => {
    state.templateReads.push(month)
    return { month: '2026-11-01', note: null, regular_hours: 160, holiday_hours: 8 }
  },
}))
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
  default: ({ people, running, canSaveTemplate, template }: {
    people: { employee: { full_name: string } }[]
    running?: boolean; canSaveTemplate?: boolean; template?: { regular_hours: number } | null
  }) => (
    <div>
      <div data-testid="grid">{people.map(p => p.employee.full_name).join(', ')}</div>
      <div data-testid="grid-template">
        {`running=${!!running} canSave=${!!canSaveTemplate} template=${template ? template.regular_hours : 'none'}`}
      </div>
    </div>),
}))
jest.mock('../components/AdditionsTab', () => ({
  __esModule: true,
  default: ({ people }: { people: { employee: { full_name: string } }[] }) =>
    <div data-testid="additions">{people.map(p => p.employee.full_name).join(', ')}</div>,
}))

beforeEach(() => { state.rate = { quotedOn: '2026-11-20' }; state.role = 'administrator'; state.templateReads = [] })

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

describe('the preliminary hours on HR', () => {
  it('the running month hands the grid the saved template, and an administrator may save it', async () => {
    render(<HR />)
    fireEvent.click(screen.getByRole('button', { name: 'Evidencija radnog vremena' }))
    await waitFor(() => expect(screen.getByTestId('grid-template'))
      .toHaveTextContent('running=true canSave=true template=160'))
    expect(state.templateReads).toEqual(['2026-11'])
  })

  it('the owner may save it; a manager or the assistant may not', async () => {
    state.role = 'owner'
    const owner = render(<HR />)
    fireEvent.click(screen.getByRole('button', { name: 'Evidencija radnog vremena' }))
    await waitFor(() => expect(screen.getByTestId('grid-template')).toHaveTextContent('canSave=true'))
    owner.unmount()
    for (const role of ['manager', 'administrative_assistant']) {
      state.role = role
      const r = render(<HR />)
      fireEvent.click(screen.getByRole('button', { name: 'Evidencija radnog vremena' }))
      await waitFor(() => expect(screen.getByTestId('grid-template')).toHaveTextContent('canSave=false'))
      r.unmount()
    }
  })

  it('another month has no preliminary hours and does not read them', async () => {
    render(<HR />)
    fireEvent.click(screen.getByRole('button', { name: 'Evidencija radnog vremena' }))
    await waitFor(() => expect(state.templateReads).toEqual(['2026-11']))
    fireEvent.change(screen.getByDisplayValue('2026-11'), { target: { value: '2026-10' } })
    await waitFor(() => expect(screen.getByTestId('grid-template'))
      .toHaveTextContent('running=false canSave=true template=none'))
    expect(state.templateReads).toEqual(['2026-11'])
  })
})
