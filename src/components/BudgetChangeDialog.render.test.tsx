import React from 'react'
import { render, screen, fireEvent, waitFor } from '@testing-library/react'
import BudgetChangeDialog from './BudgetChangeDialog'

// A client that records the row it is handed. What this dialog WRITES is the
// whole of its job — the figure on screen is gone the moment it closes, and
// the row is what the page reads back for ever after.
jest.mock('../supabase', () => {
  const rows: any[] = []
  return {
    supabase: {
      from: () => ({ insert: (r: any) => { rows.push(r); return Promise.resolve({ error: null }) } }),
    },
    __rows: rows,
  }
})

// The day's NBS list, for the EUR figure stored beside the RSD one.
jest.mock('../services/bookAmounts', () => {
  const actual = jest.requireActual('../services/bookAmounts')
  return { ...actual, getBookRates: jest.fn() }
})

const rows = () => (jest.requireMock('../supabase') as any).__rows as any[]
const getBookRates = () => (jest.requireMock('../services/bookAmounts') as any).getBookRates as jest.Mock

beforeEach(() => {
  rows().length = 0
  getBookRates().mockReset()
  getBookRates().mockResolvedValue({ date: '2026-10-08', eurRate: 117.2, usdRate: 100.1, source: 'nbs' })
})

const classification = {
  pl_category: 'Payroll', pl_subcategory: 'Salaries',
  department: 'Sales', dept_subcategory: null, expense_description: null,
}

const open = (over: { current?: number; seed?: number; seedEur?: number | null } = {}) => render(
  <BudgetChangeDialog
    month="2026-11" monthLabel="Novembar 2026"
    level="department" classification={classification}
    rowLabel="Sales" current={over.current ?? 11900} seed={over.seed ?? 11900}
    seedEur={over.seedEur === undefined ? 101.54 : over.seedEur}
    onClose={() => {}} onSaved={() => {}} />)

const typeFigure = (value: string) => {
  fireEvent.change(screen.getByLabelText('Novi iznos'), { target: { value } })
  fireEvent.change(screen.getByLabelText('Razlog'), { target: { value: 'Budget for November' } })
  fireEvent.click(screen.getByText('Sačuvaj izmenu'))
}

describe('what a budget change records', () => {
  /**
   * THE FAULT, stated as the row that must be written.
   *
   * The benchmark month is whatever month precedes today, so it changes by
   * itself on the 1st and every seed on the page changes with it. A delta
   * stored against a seed nobody wrote down therefore read one figure in
   * October and another in November, untouched by anybody: November's budget
   * moved by the difference between two months of actuals.
   *
   * The seed goes in the row. Without this line in the payload the page is
   * back to drifting and nothing on screen says so.
   */
  it('records the seed the figure was measured against', async () => {
    open({ current: 11900, seed: 11900 })
    typeFigure('12400')
    await waitFor(() => expect(rows()).toHaveLength(1))
    expect(rows()[0].seed_rsd).toBe(11900)
    expect(rows()[0].amount_rsd).toBe(500)
  })

  /**
   * The EUR reading of the same entry, beside it: the RSD change at the day's
   * NBS rate (500 / 117.2 = 4.266 → 4.27), against the row's own EUR seed.
   */
  it('records the EUR change and the EUR seed beside the RSD ones', async () => {
    open({ current: 11900, seed: 11900, seedEur: 101.54 })
    typeFigure('12400')
    await waitFor(() => expect(rows()).toHaveLength(1))
    expect(rows()[0].amount_eur).toBe(4.27)
    expect(rows()[0].seed_eur).toBe(101.54)
    expect('amount_usd' in rows()[0]).toBe(false)
    expect('seed_usd' in rows()[0]).toBe(false)
  })

  /** No rate is no guess: both EUR halves left empty, the RSD budget still recorded. */
  it('records the change in RSD alone when NBS cannot be read', async () => {
    getBookRates().mockRejectedValue(new Error('Kurs NBS nije dostupan'))
    open()
    typeFigure('12400')
    await waitFor(() => expect(rows()).toHaveLength(1))
    expect(rows()[0].amount_rsd).toBe(500)
    expect(rows()[0].amount_eur).toBeNull()
    expect(rows()[0].seed_eur).toBeNull()
  })

  /** A page with no EUR reading has no EUR seed to record: neither half is written. */
  it('writes no EUR figure when the page has no EUR seed for the row', async () => {
    open({ seedEur: null })
    typeFigure('12400')
    await waitFor(() => expect(rows()).toHaveLength(1))
    expect(rows()[0].amount_eur).toBeNull()
    expect(rows()[0].seed_eur).toBeNull()
  })

  /**
   * The row's OWN seed, not the figure on screen. A cell is its own line plus
   * everything rolled up under it, and the children go on rolling up live —
   * a new line appearing under a parent must not disappear into a total
   * pinned above it.
   */
  it("records the row's own seed, not the rolled-up figure", async () => {
    open({ current: 11900, seed: 2000 })
    typeFigure('12400')
    await waitFor(() => expect(rows()).toHaveLength(1))
    expect(rows()[0].seed_rsd).toBe(2000)
    // Still measured from what the cell read, which is what the owner saw.
    expect(rows()[0].amount_rsd).toBe(500)
  })

  /** A line with nothing seeded against it records a base of zero, which is
   *  a base — not an absence, and not a reason to fall back to the live seed. */
  it('records a zero base rather than nothing', async () => {
    open({ current: 0, seed: 0 })
    typeFigure('3000')
    await waitFor(() => expect(rows()).toHaveLength(1))
    expect(rows()[0].seed_rsd).toBe(0)
  })

  /** Still append-only, still a group line, still carrying the reason. */
  it('appends an adjust against the group, with the reason', async () => {
    open()
    typeFigure('12400')
    await waitFor(() => expect(rows()).toHaveLength(1))
    expect(rows()[0].kind).toBe('adjust')
    expect(rows()[0].company_id).toBeNull()
    expect(rows()[0].budget_month).toBe('2026-11-01')
    expect(rows()[0].reason).toBe('Budget for November')
  })

  /** And the contract is on screen where the figure is typed, since it is the
   *  thing the owner was burnt by. */
  it('says the figure will stay as typed', () => {
    open()
    expect(screen.getByText(/promena referentnog meseca ga neće pomeriti/i)).toBeTruthy()
  })
})

describe('which project a budget change is for', () => {
  const openFor = (props: Record<string, any>) => render(
    <BudgetChangeDialog
      month="2026-11" monthLabel="Novembar 2026"
      level="department" classification={classification}
      rowLabel="Sales" current={1400} seed={1400} seedEur={null}
      onClose={() => {}} onSaved={() => {}} {...props} />)

  it('records an overhead line with no project, as every change before projects', async () => {
    openFor({})
    typeFigure('2000')
    await waitFor(() => expect(rows()).toHaveLength(1))
    expect(rows()[0]).toMatchObject({ project_id: null, amount_rsd: 600, seed_rsd: 1400 })
  })

  it('records the project it was opened for, pinning that project\'s seed and not the row\'s', async () => {
    const seedForProject = jest.fn((p: string | null) => (p === 'p1'
      ? { seed: 400, seedEur: null } : { seed: 1000, seedEur: null }))
    openFor({ projectId: 'p1', projectLocked: true, seedForProject })
    typeFigure('2000')
    await waitFor(() => expect(rows()).toHaveLength(1))
    // The delta is still against the figure the cell shows, so it reads back
    // as typed; only the pinned base is the project's own.
    expect(rows()[0]).toMatchObject({ project_id: 'p1', amount_rsd: 600, seed_rsd: 400 })
    expect(seedForProject).toHaveBeenCalledWith('p1')
  })

  it('names a fixed project rather than offering to change it', () => {
    openFor({ projectId: null, projectLocked: true })
    expect(screen.getByTestId('budget-change-project').textContent).toBe('Opšti troškovi')
  })
})
