import React from 'react'
import { fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import ExpenseAnalysis from './ExpenseAnalysis'
import { fmtMoney } from '../utils/formatters'

/**
 * ─── The tree table when a category nets below zero ─────────────────────────
 *
 * A refund is an expense with a minus. The table keeps the row, with its minus;
 * a share is a figure over the sum of the figures above zero, so a row that is
 * not above zero has none. Every firm and figure here is invented.
 */

jest.setTimeout(30000)

const FIXED_NOW = Date.UTC(2026, 10, 5, 12, 0, 0)
const RealDate = Date
class FixedDate extends RealDate {
  constructor(...args: any[]) {
    if (args.length === 0) super(FIXED_NOW)
    else super(...(args as [any]))
  }
  static now() { return FIXED_NOW }
}

beforeAll(() => {
  ;(global as any).Date = FixedDate
  ;(global as any).ResizeObserver = class { observe() {} unobserve() {} disconnect() {} }
  ;(window as any).matchMedia = (q: string) => ({
    matches: q.includes('reduce'), addEventListener: () => {}, removeEventListener: () => {},
  })
})
afterAll(() => { ;(global as any).Date = RealDate })

jest.mock('../contexts/CompaniesContext', () => {
  const state = {
    companies: [{ id: 'comp-1', name: 'Gradnja Primer doo', currency: 'RSD', currencies: ['RSD'] }],
    defaultCompany: { id: 'comp-1', name: 'Gradnja Primer doo', currency: 'RSD', currencies: ['RSD'] },
    showPicker: false, loading: false,
  }
  return { useCompanies: () => state }
})

jest.mock('../contexts/ProjectsContext', () => {
  const state = { projects: [], loading: false }
  return { useProjects: () => state }
})

jest.mock('../supabase', () => {
  const make = (table: string) => {
    const tests: ((r: any) => boolean)[] = []
    const rows = () => ((global as any).__db[table] || []).filter((r: any) => tests.every(t => t(r)))
    const chain: any = {
      select: () => chain,
      eq: (c: string, v: any) => { tests.push(r => r[c] === v); return chain },
      in: (c: string, v: any[]) => { tests.push(r => v.includes(r[c])); return chain },
      gte: (c: string, v: any) => { tests.push(r => r[c] >= v); return chain },
      lte: (c: string, v: any) => { tests.push(r => r[c] <= v); return chain },
      not: () => chain,
      order: () => chain,
      limit: () => chain,
      range: (lo: number) => Promise.resolve(lo === 0
        ? { data: rows(), count: rows().length, error: null }
        : { data: [], count: 0, error: null }),
      then: (res: any, rej: any) => Promise.resolve({ data: rows(), count: rows().length, error: null }).then(res, rej),
    }
    return chain
  }
  return { supabase: { from: (table: string) => make(table), rpc: () => Promise.resolve({ data: null, error: null }) } }
})

const rsd = (n: number) => fmtMoney(n, 'RSD', 0)

const row = (o: Record<string, any>) => ({
  id: Math.random().toString(36).slice(2), company_id: 'comp-1', tx_type: 'expense',
  pl_date: '2026-03-10', department: 'Uprava', source: 'transaction',
  project_id: null, project_name: null,
  ...o,
  amount: o.amount_rsd, amount_eur: o.amount_rsd / 117,
})

beforeEach(() => {
  ;(global as any).__db = {
    v_pl_entries: [
      row({ amount_rsd: 900, pl_category: 'Marketing', pl_subcategory: 'Reklame' }),
      // No department: it is unclassified, and the one figure the unclassified share reads.
      row({ amount_rsd: 300, pl_category: 'Marketing', pl_subcategory: 'Oglasi', department: null }),
      // A refund beside the charge, under the same category: it outweighs nothing,
      // but the category nets below its biggest line.
      row({ amount_rsd: -400, pl_category: 'Marketing', pl_subcategory: 'Povrat reklame' }),
      // Bought and returned in full: the category nets to exactly zero.
      row({ amount_rsd: 400, pl_category: 'Neto nula', pl_subcategory: 'Oprema' }),
      row({ amount_rsd: -400, pl_category: 'Neto nula', pl_subcategory: 'Oprema', pl_date: '2026-04-10' }),
      // Only ever returned: the category nets below zero.
      row({ amount_rsd: -200, pl_category: 'Povracaj', pl_subcategory: 'Vracen alat', department: 'Nabavka' }),
    ],
    transactions: [], invoices: [],
  }
})

const treeRow = (label: string) =>
  screen.getByText(label, { selector: 'span' }).closest('tr') as HTMLElement

/** The cell under a column head, found by the head and not by a count. */
const cellUnder = (tr: HTMLElement, head: string) => {
  const table = tr.closest('table') as HTMLElement
  const heads = Array.from(table.querySelectorAll('thead th')).map(h => h.textContent)
  return within(tr).getAllByRole('cell')[heads.indexOf(head)]
}

const show = async () => {
  render(<ExpenseAnalysis />)
  await waitFor(() => expect(screen.getByText('Marketing', { selector: 'span' })).toBeInTheDocument())
}

describe('the tree table with a category at or below zero', () => {
  it('keeps the row with its minus and gives it a dash for a share', async () => {
    await show()
    const tr = treeRow('Povracaj')
    expect(cellUnder(tr, 'Iznos')).toHaveTextContent(rsd(-200))
    expect(cellUnder(tr, '% ukupno').textContent).toBe('—')
  })

  it('gives a category that nets to exactly zero the dash too, not 0.0%', async () => {
    await show()
    expect(cellUnder(treeRow('Neto nula'), '% ukupno').textContent).toBe('—')
  })

  it('takes the share of the sum of what is above zero, so a positive row is 100%', async () => {
    await show()
    // Marketing nets 800; dividing by the net of everything (600) would read 133.3%.
    expect(cellUnder(treeRow('Marketing'), '% ukupno').textContent).toBe('100.0%')
  })

  it('takes a child over the positive figures of its own depth, never over 100', async () => {
    await show()
    fireEvent.click(screen.getAllByRole('button', { name: '▸' })[0])
    // 900 and 300 are above zero at that depth (the refunds are not): 75 and 25.
    // Over the root base (800) the bigger line would read 112.5%.
    await waitFor(() => expect(screen.getByText('Reklame', { selector: 'span' })).toBeInTheDocument())
    expect(cellUnder(treeRow('Reklame'), '% ukupno').textContent).toBe('75.0%')
    expect(cellUnder(treeRow('Oglasi'), '% ukupno').textContent).toBe('25.0%')
    expect(cellUnder(treeRow('Povrat reklame'), '% ukupno').textContent).toBe('—')
  })

  it('still prints the total as the signed net', async () => {
    await show()
    expect(screen.getAllByText(rsd(600)).length).toBeGreaterThan(0)
  })

  it('reads the unclassified share over the positive departments, not over the net', async () => {
    await show()
    // 300 unclassified of 800 drawn (Uprava 500, Nabavka -200 is not drawn): 37.5, shown as 38%.
    // Over the net of 600 it would read 50%.
    const card = screen.getByText('Neklasifikovano').parentElement as HTMLElement
    expect(card).toHaveTextContent('38%')
    expect(card).not.toHaveTextContent('50%')
  })

  it('counts, beside the concentration, only the lines above zero', async () => {
    await show()
    // Two leaves are above zero (900 and 300); the other three (a refund line, a
    // refund category and a category netting to exactly zero) are not.
    const card = screen.getByText('Koncentracija', { selector: 'div' }).parentElement as HTMLElement
    expect(card).toHaveTextContent('2 od 2')
  })

  it('leaves the percent of the range out of the drill header of a node at or below zero', async () => {
    await show()
    fireEvent.click(screen.getByText('Povracaj', { selector: 'span' }))
    await waitFor(() => expect(screen.getByText(`ukupno ${rsd(-200)}`)).toBeInTheDocument())
    expect(screen.queryByText(/% od:/)).not.toBeInTheDocument()
  })

  it('gives a positive node its percent of the range in the drill header', async () => {
    await show()
    fireEvent.click(screen.getByText('Marketing', { selector: 'span' }))
    await waitFor(() => expect(screen.getByText(`ukupno ${rsd(800)}`)).toBeInTheDocument())
    expect(screen.getByText(/^100,0% od:/)).toBeInTheDocument()
  })
})
