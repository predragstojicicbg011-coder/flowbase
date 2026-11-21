import React from 'react'
import { render, screen, fireEvent } from '@testing-library/react'
import PayrollComparison from './PayrollComparison'
import type { PayrollRun } from '../services/payroll/runs'
import type { SavedRun, SavedRunLine } from '../services/payroll/savedRuns'
import {
  NO_LAST_REGULAR, NOT_COMPARED, ONE_COMPANY, PEOPLE_JOINED, SHOW_PEOPLE, HIDE_PEOPLE,
} from '../services/payroll/preliminaryText'
import { fmtNum } from '../utils/formatters'

jest.mock('../supabase', () => ({ __esModule: true, supabase: {} }))
const store: { runs: SavedRun[]; lines: SavedRunLine[]; asked: string[] } = { runs: [], lines: [], asked: [] }
jest.mock('../services/payroll/savedRuns', () => ({
  __esModule: true,
  ...jest.requireActual('../services/payroll/savedRuns'),
  fetchRuns: async (_c: unknown, _company: string, month: string) => { store.asked.push(month); return store.runs },
  fetchRunLines: async () => store.lines,
}))

const kept = (over: Partial<SavedRun> = {}): SavedRun => ({
  id: 'k-1', company_id: 'c-1', period_month: '2026-10-01', run_key: 'regular', label: 'Zarade',
  status: 'posted', exchange_rate: null, eur_rate: null, month_hours: 184, gross: 0, net: 800,
  income_tax: 0, contributions_employee: 0, contributions_employer: 0, total_cost: 1000,
  deductions_third_party: 0, deductions_employer: 0, calculated_at: '', posted_at: null, note: null,
  kind: 'regular', ...over,
})
const live: PayrollRun[] = [{
  key: 'regular', label: 'Zarade', otherIncome: [],
  salaries: [
    { employeeId: 'e-1', name: 'Osoba A', code: 'E-001', line: { totalCost: 700 } },
    { employeeId: 'e-2', name: 'Osoba B', code: 'E-002', line: { totalCost: 500 } },
  ],
  totals: { gross: 0, net: 900, incomeTax: 0, employeeContributions: 0, employerContributions: 0,
    totalCost: 1200, deductionsThirdParty: 0, deductionsEmployer: 0 },
} as unknown as PayrollRun]

beforeEach(() => {
  store.runs = [kept()]
  store.lines = [{ employee_id: 'e-1', employee_code: 'E-001', employee_name: 'Osoba A', total_cost: 1000, line_kind: 'salary' } as SavedRunLine]
  store.asked = []
})

describe('against last month\'s regular payroll', () => {
  it('per run and in total, the people closed until opened', async () => {
    render(<PayrollComparison companyId="c-1" month="2026-11" live={live} missing={0} />)
    expect(await screen.findAllByText(fmtNum(1200))).toHaveLength(2)
    expect(store.asked).toEqual(['2026-10'])
    expect(screen.getAllByText('+20,0%')).toHaveLength(2)
    expect(screen.queryByText(new RegExp(PEOPLE_JOINED))).toBeNull()
    fireEvent.click(screen.getByRole('button', { name: SHOW_PEOPLE }))
    expect(screen.getByRole('button', { name: HIDE_PEOPLE })).toHaveAttribute('aria-expanded', 'true')
    expect(screen.getByText(`${PEOPLE_JOINED} (1)`)).toBeInTheDocument()
    expect(screen.getByText('Osoba B · E-002')).toBeInTheDocument()
  })

  it('a last month with a preliminary run compares nothing', async () => {
    store.runs = [kept({ kind: 'preliminary' })]
    render(<PayrollComparison companyId="c-1" month="2026-11" live={live} missing={0} />)
    expect(await screen.findByText(NO_LAST_REGULAR)).toBeInTheDocument()
  })

  it('people missing from this month: one sentence, nothing read', async () => {
    render(<PayrollComparison companyId="c-1" month="2026-11" live={live} missing={2} />)
    expect(screen.getByText(NOT_COMPARED(2))).toBeInTheDocument()
    expect(NOT_COMPARED(2)).toBe('2 zaposlena nisu u obračunu ovog meseca, pa se ne poredi sa prošlim mesecom.')
    expect(store.asked).toEqual([])
  })

  it('all companies: asks for one', () => {
    render(<PayrollComparison companyId="" month="2026-11" live={live} missing={0} />)
    expect(screen.getByText(ONE_COMPANY)).toBeInTheDocument()
  })
})
