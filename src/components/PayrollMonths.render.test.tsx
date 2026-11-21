import React from 'react'
import { render, screen } from '@testing-library/react'
import PayrollMonths from './PayrollMonths'
import type { SavedRun } from '../services/payroll/savedRuns'

jest.mock('../supabase', () => ({ __esModule: true, supabase: {} }))
const runs: { current: SavedRun[] } = { current: [] }
jest.mock('../services/payroll/savedRuns', () => ({
  __esModule: true,
  ...jest.requireActual('../services/payroll/savedRuns'),
  fetchRuns: async () => runs.current,
}))

const run = (over: Partial<SavedRun>): SavedRun => ({
  id: 'x', company_id: 'c-1', period_month: '2026-11-01', run_key: 'regular',
  label: 'Zarade', status: 'draft', exchange_rate: null, eur_rate: null,
  month_hours: 168, gross: 0, net: 0, income_tax: 0,
  contributions_employee: 0, contributions_employer: 0,
  total_cost: 1000, deductions_third_party: 0, deductions_employer: 0,
  calculated_at: '', posted_at: null, note: null, ...over,
})

describe('the months list', () => {
  it('says posted and preliminary together, and preliminary alone', async () => {
    runs.current = [
      run({ id: 'a', status: 'posted', posted_at: '2026-11-05' }),
      run({ id: 'b', run_key: 'other', label: 'Ostala primanja', kind: 'preliminary' }),
      run({ id: 'c', period_month: '2026-10-01', kind: 'preliminary' }),
      run({ id: 'd', period_month: '2026-09-01', status: 'posted', posted_at: '2026-09-30' }),
    ]
    render(<PayrollMonths companyId="c-1" current="2026-11" onPick={() => {}} />)
    expect(await screen.findByText('Proknjiženo 1 od 2 · Preliminarno')).toBeInTheDocument()
    expect(screen.getByText('Preliminarno')).toBeInTheDocument()
    expect(screen.getByText('Proknjiženo')).toBeInTheDocument()
  })
})
