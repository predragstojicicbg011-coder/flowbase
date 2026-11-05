import React from 'react'
import { render, screen, waitFor } from '@testing-library/react'
import Dashboard from './Dashboard'
import { fmtMoney } from '../utils/formatters'

/**
 * ─── The home page, wired ───────────────────────────────────────────────────
 *
 * The arithmetic lives in pure services with their own tests. What is left to
 * test here is the WIRING: that the page asks the database for the columns the
 * services need, hands them the right rows, and prints what they return where
 * the owner reads it. Every company and figure here is invented.
 */

jest.setTimeout(30000)

// 5 November 2026, noon UTC. The page reads "today" off the clock.
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
  // The cards count to a new figure over animation frames, unless the reader
  // asked for reduced motion — then the figure is simply the figure, which is
  // what an assertion needs.
  ;(window as any).matchMedia = (q: string) => ({
    matches: q.includes('reduce'), addEventListener: () => {}, removeEventListener: () => {},
  })
})
afterAll(() => { ;(global as any).Date = RealDate })

jest.mock('../contexts/AuthContext', () => ({
  useAuth: () => ({ user: { email: 'vlasnik@primer.rs' } }),
}))

jest.mock('../navigation', () => ({
  ...jest.requireActual('../navigation'),
  useNav: () => ({ page: 'dashboard', setPage: () => {} }),
}))

// Stable objects: the page refetches when the company list changes identity.
jest.mock('../contexts/CompaniesContext', () => {
  const state: any = { companies: [], defaultCompany: null, showPicker: false, loading: false }
  return { useCompanies: () => (global as any).__companies || state }
})

jest.mock('../contexts/ProjectsContext', () => {
  const state = { projects: [], loading: false }
  return { useProjects: () => state }
})

// The select's column list is honoured: PostgREST returns what was asked for
// and nothing else, so a page that stops asking for `revenue_stream` sees it
// arrive undefined — and a loan drawdown becomes revenue again.
jest.mock('../supabase', () => {
  const columnsOf = (cols: string): string[] | null =>
    cols.includes('(') ? null : cols.split(',').map(c => c.trim()).filter(Boolean)
  const make = (table: string) => {
    const tests: ((r: any) => boolean)[] = []
    let project: string[] | null = null
    const rows = () => {
      const kept = ((global as any).__db[table] || []).filter((r: any) => tests.every(t => t(r)))
      if (!project) return kept
      const cols = project
      return kept.map((r: any) => Object.fromEntries(cols.map(c => [c, r[c]])))
    }
    const answer = () => {
      const failure = (global as any).__fail[table]
      if (failure) return { data: null, count: null, error: { message: failure } }
      return { data: rows(), count: rows().length, error: null }
    }
    const chain: any = {
      select: (cols?: string) => { project = cols ? columnsOf(cols) : null; return chain },
      eq: (c: string, v: any) => { tests.push(r => r[c] === v); return chain },
      in: (c: string, v: any[]) => { tests.push(r => v.includes(r[c])); return chain },
      gte: (c: string, v: any) => { tests.push(r => r[c] >= v); return chain },
      lte: (c: string, v: any) => { tests.push(r => r[c] <= v); return chain },
      not: () => chain,
      order: () => chain,
      limit: () => chain,
      range: (lo: number) => Promise.resolve(lo === 0 ? answer() : { data: [], count: 0, error: null }),
      then: (res: any, rej: any) => Promise.resolve(answer()).then(res, rej),
    }
    return chain
  }
  return { supabase: { from: (table: string) => make(table), rpc: () => Promise.resolve({ data: null, error: null }) } }
})

const rsd = (n: number) => fmtMoney(n, 'RSD', 0)

const COMPANY = { id: 'comp-1', name: 'Gradnja Primer doo', currency: 'RSD', currencies: ['RSD'] }

const pl = (o: Record<string, any>) => ({
  id: Math.random().toString(36).slice(2), company_id: 'comp-1', tx_type: 'revenue',
  amount_rsd: 0, amount_eur: 0, pl_date: '2026-03-10', pl_category: null, pl_subcategory: null,
  revenue_stream: null, partner_id: null, project_id: null, project_name: null,
  ...o,
})

const principalRole = (company: string, cat: string, sub: string) => ({
  id: `sc-${company}`, company_id: company, role: 'credit_principal', pl_category: cat,
  pl_subcategory: sub, department: 'Uprava', dept_subcategory: 'Krediti', expense_description: 'Rata kredita',
})

beforeEach(() => {
  ;(global as any).__companies = {
    companies: [COMPANY], defaultCompany: COMPANY, showPicker: false, loading: false,
  }
  ;(global as any).__fail = {}
  ;(global as any).__db = {
    v_pl_entries: [
      pl({ amount_rsd: 1000000, revenue_stream: 'Građevinske situacije' }),
      // Money borrowed, booked as revenue under the loans stream.
      pl({ amount_rsd: 2500000, pl_date: '2026-04-02', revenue_stream: 'Krediti' }),
      pl({ tx_type: 'expense', amount_rsd: 400000, pl_category: 'Materijal', pl_subcategory: 'Beton' }),
      // Principal and interest under ONE category, told apart by subcategory.
      pl({ tx_type: 'expense', amount_rsd: 150000, pl_date: '2026-04-15', pl_category: 'Finansiranje', pl_subcategory: 'Glavnica' }),
      pl({ tx_type: 'expense', amount_rsd: 20000, pl_date: '2026-04-15', pl_category: 'Finansiranje', pl_subcategory: 'Kamata' }),
    ],
    system_categories: [principalRole('comp-1', 'Finansiranje', 'Glavnica')],
    v_invoice_status: [],
    passthrough: [],
    transactions: [],
  }
})

const show = async () => {
  render(<Dashboard />)
  await waitFor(() => expect(screen.getByText('Ukupni prihodi')).toBeInTheDocument())
  await waitFor(() => expect(screen.queryAllByText('—').length).toBe(0))
}

const card = (label: string) => screen.getByText(label).parentElement as HTMLElement

/** A card's figures count to their value in an effect; wait for it to land. */
const cardSays = (label: string, text: string) =>
  waitFor(() => expect(card(label)).toHaveTextContent(text))

describe('loans are not revenue, principal is not cost', () => {
  it('counts revenue without the drawdown and says how much was left out', async () => {
    await show()
    await cardSays('Ukupni prihodi', rsd(1000000))
    await cardSays('Ukupni prihodi', `Bez povučenih kredita: ${rsd(2500000)}`)
  })

  it('counts expenses without the principal and keeps the interest', async () => {
    await show()
    await cardSays('Ukupni troškovi', rsd(420000))
    await cardSays('Ukupni troškovi', `Bez otplate glavnice: ${rsd(150000)}; kamata je u troškovima`)
  })

  it('takes net profit from the corrected figures', async () => {
    await show()
    await cardSays('Neto dobit / gubitak', rsd(580000))
  })

  it('names a company whose principal heading is not mapped, and does not guess', async () => {
    ;(global as any).__db.system_categories = []
    await show()
    await cardSays('Ukupni troškovi', rsd(570000))
    await cardSays('Ukupni troškovi', 'Glavnica nije izdvojena za Gradnja Primer doo')
  })

  it('leaves the expense structure without the principal', async () => {
    await show()
    const donut = () => screen.getByText('Struktura troškova').parentElement!.parentElement as HTMLElement
    await waitFor(() => expect(donut()).toHaveTextContent(rsd(20000)))
    const d = donut()
    expect(d).not.toHaveTextContent(rsd(170000))
  })
})

describe('profit after the bank', () => {
  it('puts the principal repaid and the profit left after it under net profit', async () => {
    await show()
    await cardSays('Neto dobit / gubitak', `Otplaćena glavnica ${rsd(150000)} · dobit posle otplate ${rsd(430000)}`)
  })

  it('says nothing about it when no principal was repaid in the period', async () => {
    ;(global as any).__db.v_pl_entries = (global as any).__db.v_pl_entries
      .filter((r: any) => r.pl_subcategory !== 'Glavnica')
    await show()
    await cardSays('Neto dobit / gubitak', rsd(580000))
    expect(card('Neto dobit / gubitak')).not.toHaveTextContent('Otplaćena glavnica')
  })
})
