import React from 'react'
import { render, screen } from '@testing-library/react'
import PayrollPostingPanel from './PayrollPostingPanel'
import { POSTED_DIFFERS, KEPT_DIFFERS, type SavedRun } from '../services/payroll/savedRuns'
import type { PayrollRun } from '../services/payroll/runs'
import { fmtNum } from '../utils/formatters'
import {
  POSTING_NOT_OFFERED, KEPT_KIND_DIFFERS, type RunKind,
} from '../services/payroll/preliminaryText'

// Plain functions, not jest.fn(impl): the CRA config resets mocks. Every
// table answers an empty list; a chain of any length can be awaited.
jest.mock('../supabase', () => {
  const chain: any = new Proxy({}, {
    get: (_t, prop) => (prop === 'then'
      ? (resolve: (v: any) => void) => resolve({ data: [], error: null })
      : () => chain),
  })
  return { __esModule: true, supabase: { from: () => chain } }
})
jest.mock('../services/allPartners', () => ({ __esModule: true, fetchAllPartners: async () => [] }))
jest.mock('../services/payroll/holidays', () => ({
  __esModule: true,
  ...jest.requireActual('../services/payroll/holidays'),
  fetchHolidays: async () => [],
}))
jest.mock('../services/payroll/projectHours', () => ({
  __esModule: true,
  ...jest.requireActual('../services/payroll/projectHours'),
  fetchProjectHours: async () => [],
}))
const postings: { current: any[] } = { current: [] }
jest.mock('../services/payroll/post', () => ({
  __esModule: true,
  fetchPostings: async () => postings.current,
  postPlan: async () => ({}),
  undoPosting: async () => {},
}))
jest.mock('../services/payroll/posting', () => ({
  __esModule: true,
  ...jest.requireActual('../services/payroll/posting'),
  planFor: () => ({ invoices: [], transactions: [] }),
  checkPlan: () => null,
  planTotal: () => 1000,
  stornoTotal: () => 0,
  unmappedUnits: () => [],
  planProjectTotals: () => [],
}))

const totals = (totalCost: number) => ({
  gross: 0, net: 0, incomeTax: 0, employeeContributions: 0, employerContributions: 0,
  totalCost, deductionsThirdParty: 0, deductionsEmployer: 0,
})
const run = (totalCost: number): PayrollRun => ({
  key: 'regular', label: 'Zarade', totals: totals(totalCost), otherIncome: [],
  salaries: [{ employeeId: 'e-1', name: 'Osoba A', code: 'E-001', hours: 168, categories: [], line: { totalCost } }],
} as unknown as PayrollRun)
const kept = (over: Partial<SavedRun> = {}): SavedRun => ({
  id: 'k-1', company_id: 'c-1', period_month: '2026-11-01', run_key: 'regular', label: 'Zarade',
  status: 'draft', exchange_rate: null, eur_rate: null, month_hours: 168, gross: 0, net: 0,
  income_tax: 0, contributions_employee: 0, contributions_employer: 0, total_cost: 1000,
  deductions_third_party: 0, deductions_employer: 0, calculated_at: '', posted_at: null, note: null,
  ...over,
})

const panel = (
  r: PayrollRun | null, savedRuns: SavedRun[], waitsForRate: string | null = null,
  kind: RunKind = 'regular',
) => render(
  <PayrollPostingPanel runs={r ? [r] : []} people={{}} month="2026-11" companyId="c-1"
    exchangeRate={null} savedRuns={savedRuns} onPosted={() => {}} waitsForRate={waitsForRate}
    kind={kind} />)

beforeEach(() => { postings.current = [] })

describe('a kept run that no longer agrees with the inputs', () => {
  it('a posted run says to undo the posting first, not to recalculate', async () => {
    postings.current = [{
      id: 'p-1', run_key: 'regular', run_id: 'k-1', posted_on: '2026-11-05',
      created_invoice_ids: [], created_transaction_ids: [],
    }]
    panel(run(1100), [kept({ status: 'posted', total_cost: 1000 })])
    expect(await screen.findByText(POSTED_DIFFERS(fmtNum(1000), fmtNum(1100)))).toBeInTheDocument()
    expect(screen.queryByText(/ponovo obračunajte pre knjiženja/)).toBeNull()
    expect(await screen.findByRole('button', { name: 'Poništi' })).toBeInTheDocument()
  })

  it('a draft still says to recalculate before posting', async () => {
    panel(run(1100), [kept({ total_cost: 1000 })])
    expect(await screen.findByText(KEPT_DIFFERS(fmtNum(1000), fmtNum(1100)))).toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'Proknjiži' })).toBeDisabled()
  })
})

describe("a month that waits for the 20th's rate", () => {
  const WAITS = 'Obračun koristi kurs od 02.11.2026., a ne kurs za 20.11.2026. '
    + 'Knjiženje je moguće kada NBS objavi taj kurs.'

  it('refuses Post and says why', async () => {
    panel(run(1000), [kept({ total_cost: 1000 })], WAITS)
    expect(await screen.findByText(WAITS)).toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'Proknjiži' })).toBeDisabled()
  })

  it('offers Post once nothing waits', async () => {
    panel(run(1000), [kept({ total_cost: 1000 })], null)
    expect(await screen.findByRole('button', { name: 'Proknjiži' })).toBeEnabled()
    expect(screen.queryByText(WAITS)).toBeNull()
  })

  it('says nothing of it beside a run already posted, which keeps its Undo', async () => {
    postings.current = [{
      id: 'p-1', run_key: 'regular', run_id: 'k-1', posted_on: '2026-11-05',
      created_invoice_ids: [], created_transaction_ids: [],
    }]
    panel(run(1000), [kept({ status: 'posted', total_cost: 1000 })], WAITS)
    expect(await screen.findByRole('button', { name: 'Poništi' })).toBeInTheDocument()
    expect(screen.queryByText(WAITS)).toBeNull()
  })
})

describe('a preliminary month', () => {
  const posted = () => {
    postings.current = [{
      id: 'p-1', run_key: 'regular', run_id: 'k-1', posted_on: '2026-11-05',
      created_invoice_ids: [], created_transaction_ids: [],
    }]
  }

  it('offers no Post, says why, and marks the run', async () => {
    panel(run(1000), [kept({ total_cost: 1000, kind: 'preliminary' })], null, 'preliminary')
    expect(await screen.findByText(POSTING_NOT_OFFERED)).toBeInTheDocument()
    expect(screen.queryByRole('button', { name: 'Proknjiži' })).toBeNull()
    expect(screen.getByText(/· Preliminarno/)).toBeInTheDocument()
    // The panel and its tools stay: the unit mapping and the rest are reachable.
    expect(screen.getByText('Knjiženje u glavnu knjigu')).toBeInTheDocument()
  })

  it('keeps Undo for a run posted earlier', async () => {
    posted()
    panel(run(1000), [kept({ status: 'posted', total_cost: 1000 })], null, 'preliminary')
    expect(await screen.findByRole('button', { name: 'Poništi' })).toBeInTheDocument()
    expect(screen.getByText(POSTING_NOT_OFFERED)).toBeInTheDocument()
  })

  it('a draft kept as preliminary in a month now regular is recalculated first', async () => {
    panel(run(1000), [kept({ total_cost: 1000, kind: 'preliminary' })], null, 'regular')
    expect(await screen.findByText(KEPT_KIND_DIFFERS('preliminary', 'regular'))).toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'Proknjiži' })).toBeDisabled()
    expect(screen.queryByText(POSTING_NOT_OFFERED)).toBeNull()
  })
})

describe('a posting whose run has nothing to post now', () => {
  it('is listed with its Undo', async () => {
    postings.current = [{
      id: 'p-1', run_key: 'regular', run_id: 'k-1', posted_on: '2026-11-05',
      created_invoice_ids: [], created_transaction_ids: [],
    }]
    panel(null, [kept({ status: 'posted', total_cost: 1000 })])
    expect(await screen.findByRole('button', { name: 'Poništi' })).toBeInTheDocument()
    expect(screen.getByText('Zarade')).toBeInTheDocument()
  })
})
