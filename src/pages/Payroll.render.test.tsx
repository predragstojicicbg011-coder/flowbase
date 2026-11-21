import React from 'react'
import { render, screen, fireEvent, waitFor } from '@testing-library/react'
import Payroll from './Payroll'
import type { SavedRun } from '../services/payroll/savedRuns'
import { RATE_BADGE, RATE_NOT_YET_THE_TWENTIETHS, POST_WAITS_FOR_THE_TWENTIETH } from '../services/payroll/payrollRate'
import { fmtNum } from '../utils/formatters'
import type { AdditionRow } from '../services/payroll/additions'
import { KEPT_KIND_DIFFERS, KEPT_RUN_EMPTY } from '../services/payroll/preliminaryText'

// ── The page's world, invented: one company, one person on a round dinar
//    contract, November 2026 with no holiday rows. Plain functions over
//    module state, not jest.fn(impl): the CRA config resets mocks.

const state = {
  /** What the months list reads: every kept run of the company. */
  months: [] as SavedRun[],
  /** How many times the months list has been read. */
  monthReads: 0,
  saves: 0,
  /** The kind every Recalculate saved with, and the total. */
  savedKinds: [] as string[],
  savedTotals: [] as number[],
  /** The kept runs of the month on screen. */
  monthRuns: [] as SavedRun[],
  /** The ids removeRun was asked to remove. */
  removed: [] as string[],
  /** The day the rate service says its list applies from. */
  quotedOn: '2026-11-20' as string | undefined,
  /** The currency of the one contract. */
  contractCurrency: 'RSD',
  /** Every addition of the month, of every company: fetchAdditions does not filter. */
  additions: [] as AdditionRow[],
}

const addition = (employeeId: string, currency: string): AdditionRow => ({
  id: `a-${employeeId}`, employee_id: employeeId, month: '2026-11-01', kind: 'bonus',
  label: 'Bonus A', treatment: 'salary', amount: 100, currency, note: null,
})

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
  getBookRates: async (date: string) =>
    ({ eurRate: 117, usdRate: 100, date, quotedOn: state.quotedOn, source: 'NBS' }),
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
    id: 'k-1', employee_id: 'e-1', valid_from: '2025-01-01', valid_to: null,
    currency: state.contractCurrency, net_amount: state.contractCurrency === 'RSD' ? 100000 : 1000,
    service_years: null, note: null,
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
  fetchAdditions: async () => state.additions,
}))
jest.mock('../services/payroll/savedRuns', () => ({
  __esModule: true,
  ...jest.requireActual('../services/payroll/savedRuns'),
  fetchRuns: async (_c: unknown, _company: string, month?: string) => {
    if (month) return state.monthRuns
    state.monthReads += 1
    return state.months
  },
  saveRun: async (_c: unknown, run: { totals: { totalCost: number } }, context: { kind: string }) => {
    state.saves += 1; state.savedKinds.push(context.kind); state.savedTotals.push(run.totals.totalCost)
    return {}
  },
  removeRun: async (_c: unknown, run: { id: string }) => { state.removed.push(run.id) },
}))
// The panel is not what is under test here: only that its onPosted (called
// after a posting and after an undo) makes the months list read again.
jest.mock('../components/PayrollPostingPanel', () => ({
  __esModule: true,
  default: ({ onPosted, waitsForRate, kind }: {
    onPosted: () => void; waitsForRate: string | null; kind: string
  }) => (
    <div>
      <button onClick={onPosted}>panel-posted-or-undone</button>
      {waitsForRate && <div data-testid="panel-waits">{waitsForRate}</div>}
      <div data-testid="panel-kind">{kind}</div>
    </div>),
}))

beforeEach(() => {
  state.months = [keptRun()]
  state.monthReads = 0
  state.saves = 0
  state.savedKinds = []
  state.savedTotals = []
  state.monthRuns = []
  state.removed = []
  state.quotedOn = '2026-11-20'
  state.contractCurrency = 'RSD'
  state.additions = []
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

describe('the rate on the Payroll page', () => {
  it("the 20th's rate: the badge names its day and nothing more is said", async () => {
    render(<Payroll />)
    expect(await screen.findByText(RATE_BADGE(fmtNum(117), '20.11.2026.'))).toBeInTheDocument()
    expect(screen.queryByText(/još nije objavljen/)).toBeNull()
    await screen.findByRole('button', { name: 'panel-posted-or-undone' })
    expect(screen.queryByTestId('panel-waits')).toBeNull()
  })

  it("asked on the 3rd, the list is the 2nd's: the badge and the notice say so", async () => {
    state.quotedOn = '2026-11-02'
    render(<Payroll />)
    expect(await screen.findByText(RATE_BADGE(fmtNum(117), '02.11.2026.'))).toBeInTheDocument()
    expect(screen.getByText(RATE_NOT_YET_THE_TWENTIETHS('20.11.2026.', '02.11.2026.'))).toBeInTheDocument()
  })

  it("a month all in dinars may be posted on any day's rate", async () => {
    state.quotedOn = '2026-11-02'
    render(<Payroll />)
    // Only once the rate is on screen could a refusal exist at all.
    expect(await screen.findByText(RATE_BADGE(fmtNum(117), '02.11.2026.'))).toBeInTheDocument()
    await screen.findByRole('button', { name: 'panel-posted-or-undone' })
    expect(screen.queryByTestId('panel-waits')).toBeNull()
  })

  it("a month with a euro contract waits for the 20th's rate to be posted", async () => {
    state.quotedOn = '2026-11-02'
    state.contractCurrency = 'EUR'
    render(<Payroll />)
    expect(await screen.findByTestId('panel-waits'))
      .toHaveTextContent(POST_WAITS_FOR_THE_TWENTIETH('02.11.2026.', '20.11.2026.'))
  })
})

describe('a month already past', () => {
  it('April 2025, answered with the 17th\'s list (the 18th was Good Friday): a euro month may be posted', async () => {
    state.quotedOn = '2025-04-17'
    state.contractCurrency = 'EUR'
    render(<Payroll />)
    fireEvent.change(screen.getByDisplayValue('2026-11'), { target: { value: '2025-04' } })
    expect(await screen.findByText(RATE_BADGE(fmtNum(117), '17.04.2025.'))).toBeInTheDocument()
    await screen.findByRole('button', { name: 'panel-posted-or-undone' })
    expect(screen.queryByTestId('panel-waits')).toBeNull()
    expect(screen.queryByText(/još nije objavljen/)).toBeNull()
  })

  it('a past month whose answer has no date_from may be posted too', async () => {
    state.quotedOn = undefined
    state.contractCurrency = 'EUR'
    render(<Payroll />)
    fireEvent.change(screen.getByDisplayValue('2026-11'), { target: { value: '2026-10' } })
    expect(await screen.findByText(RATE_BADGE(fmtNum(117), 'nepoznatog dana'))).toBeInTheDocument()
    await screen.findByRole('button', { name: 'panel-posted-or-undone' })
    expect(screen.queryByTestId('panel-waits')).toBeNull()
  })
})

describe('the foreign-amount test looks only at this payroll', () => {
  it('a euro addition of another company\'s employee does not hold a dinar month back', async () => {
    state.quotedOn = '2026-11-02'
    state.additions = [addition('e-9', 'EUR')]   // e-9 is in company B, not on this roster
    render(<Payroll />)
    expect(await screen.findByText(RATE_BADGE(fmtNum(117), '02.11.2026.'))).toBeInTheDocument()
    await screen.findByRole('button', { name: 'panel-posted-or-undone' })
    expect(screen.queryByTestId('panel-waits')).toBeNull()
  })

  it('a euro addition of this payroll\'s own employee does', async () => {
    state.quotedOn = '2026-11-02'
    state.additions = [addition('e-1', 'EUR'), addition('e-9', 'RSD')]
    render(<Payroll />)
    expect(await screen.findByTestId('panel-waits'))
      .toHaveTextContent(POST_WAITS_FOR_THE_TWENTIETH('02.11.2026.', '20.11.2026.'))
  })
})

describe('a kept run carries its kind', () => {
  it('a month on the 20th\'s rate is kept as regular, and the panel is told so', async () => {
    render(<Payroll />)
    fireEvent.click(await screen.findByRole('button', { name: 'Ponovo obračunaj' }))
    await waitFor(() => expect(state.savedKinds).toEqual(['regular']))
    expect(screen.getByTestId('panel-kind')).toHaveTextContent('regular')
  })

  it('a euro month before the 20th\'s list is kept as preliminary', async () => {
    state.quotedOn = '2026-11-02'
    state.contractCurrency = 'EUR'
    render(<Payroll />)
    fireEvent.click(await screen.findByRole('button', { name: 'Ponovo obračunaj' }))
    await waitFor(() => expect(state.savedKinds).toEqual(['preliminary']))
    expect(screen.getByTestId('panel-kind')).toHaveTextContent('preliminary')
  })

  it('a draft whose total agrees but whose kind does not asks to be recalculated', async () => {
    const first = render(<Payroll />)
    fireEvent.click(await screen.findByRole('button', { name: 'Ponovo obračunaj' }))
    await waitFor(() => expect(state.savedTotals).toHaveLength(1))
    first.unmount()
    state.monthRuns = [keptRun({ period_month: '2026-11-01', kind: 'preliminary', total_cost: state.savedTotals[0] })]
    render(<Payroll />)
    expect(await screen.findByText(KEPT_KIND_DIFFERS('preliminary', 'regular'))).toBeInTheDocument()
  })
})

describe('a kept draft nobody is in any more', () => {
  it('says so, and Recalculate removes it', async () => {
    state.monthRuns = [keptRun({
      id: 'k-other', period_month: '2026-11-01', run_key: 'other', label: 'Ostala primanja', total_cost: 500,
    })]
    render(<Payroll />)
    expect(await screen.findByText(KEPT_RUN_EMPTY)).toBeInTheDocument()
    const buttons = await screen.findAllByRole('button', { name: 'Ponovo obračunaj' })
    expect(buttons).toHaveLength(2)
    fireEvent.click(buttons[1])
    await waitFor(() => expect(state.removed).toEqual(['k-other']))
    expect(state.saves).toBe(0)
  })
})
