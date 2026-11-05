import React from 'react'
import { fireEvent, render, screen, waitFor } from '@testing-library/react'
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
  // jsdom has no layout and so no ResizeObserver; the charts measure with one.
  ;(global as any).ResizeObserver = class { observe() {} unobserve() {} disconnect() {} }
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

// Today's NBS rate, for converting a euro credit. A plain function rather
// than jest.fn: CRA resets mock implementations between tests.
jest.mock('../services/bookAmounts', () => ({
  ...jest.requireActual('../services/bookAmounts'),
  getBookRates: () => (global as any).__noRates
    ? Promise.reject(new Error('Nema kursa NBS'))
    : Promise.resolve({ date: '2026-11-05', eurRate: 117, usdRate: 110, source: 'test' }),
}))

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
  ;(global as any).__noRates = false
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
    credits: [],
    credit_installments: [],
    credit_rate_resets: [],
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
    // It has a credit, so its principal is something to tell apart.
    ;(global as any).__db.credits = [{ id: 'k9', company_id: 'comp-1', name: 'Kredit Primer', kind: 'annuity',
      currency: 'RSD', principal_amount: 1000000, disbursement_date: '2026-01-05', maturity_date: null, rate_margin: null, status: 'active' }]
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

describe('the period is whole months', () => {
  const october = () => (global as any).__db.v_pl_entries.push(
    pl({ amount_rsd: 70000, pl_date: '2026-10-20', revenue_stream: 'Zakup' }),
    pl({ amount_rsd: 5000, pl_date: '2026-11-03', revenue_stream: 'Zakup' }),
  )

  it('opens on the year to date, by month, and neither end can pass this month', async () => {
    await show()
    const from = screen.getByLabelText('Od meseca') as HTMLInputElement
    const to = screen.getByLabelText('Do meseca') as HTMLInputElement
    expect(from.type).toBe('month')
    expect(from.value).toBe('2026-01')
    expect(to.value).toBe('2026-11')
    expect(from.max).toBe('2026-11')
    expect(to.max).toBe('2026-11')
    await cardSays('Ukupni prihodi', 'jan – nov 2026 · Gradnja Primer doo')
  })

  it('last month is the whole of October and nothing of November', async () => {
    october()
    await show()
    fireEvent.click(screen.getByText('Prošli mesec'))
    await cardSays('Ukupni prihodi', rsd(70000))
    await cardSays('Ukupni prihodi', 'okt 2026')
    expect((screen.getByLabelText('Od meseca') as HTMLInputElement).value).toBe('2026-10')
    expect((screen.getByLabelText('Do meseca') as HTMLInputElement).value).toBe('2026-10')
  })

  it('this quarter runs from October to today', async () => {
    october()
    await show()
    fireEvent.click(screen.getByText('Ovaj kvartal'))
    await cardSays('Ukupni prihodi', rsd(75000))
  })

  it('pulls a month typed past the current one back to it', async () => {
    october()
    await show()
    fireEvent.change(screen.getByLabelText('Od meseca'), { target: { value: '2027-02' } })
    await waitFor(() => expect((screen.getByLabelText('Od meseca') as HTMLInputElement).value).toBe('2026-11'))
    await cardSays('Ukupni prihodi', rsd(5000))
  })
})

describe('the receivables card', () => {
  const inv = (o: Record<string, any>) => ({
    id: Math.random().toString(36).slice(2), company_id: 'comp-1', type: 'revenue', document_type: 'invoice',
    calculated_status: 'unpaid', remaining_rsd: 0, remaining_eur: 0, amount_rsd: 0, amount_eur: 0,
    due_date: '2026-12-31', partner_name: 'Kupac Primer doo', ...o,
  })

  it('says how much is late and how much falls due in the next seven days', async () => {
    ;(global as any).__db.v_invoice_status = [
      inv({ remaining_rsd: 300000, due_date: '2026-10-01' }),
      inv({ remaining_rsd: 120000, due_date: '2026-11-09' }),
      inv({ remaining_rsd: 50000, due_date: '2026-12-20' }),
      // What we owe a supplier is not a receivable.
      inv({ type: 'expense', remaining_rsd: 999000, due_date: '2026-10-01', partner_name: 'Dobavljac Primer doo' }),
    ]
    await show()
    await cardSays('Potraživanja', rsd(470000))
    await cardSays('Potraživanja', `kasni ${rsd(300000)} · dospeva u 7 dana ${rsd(120000)}`)
  })
})

// ─── The credit book ────────────────────────────────────────────────────────

const loan = (o: Record<string, any> = {}) => ({
  id: 'k1', company_id: 'comp-1', name: 'Kredit Banka Primer', bank: 'Banka Primer', kind: 'annuity',
  currency: 'EUR', principal_amount: 10000, disbursement_date: '2026-02-10', maturity_date: null,
  rate_margin: null, status: 'active', ...o,
})

/** Ten instalments of 1.000 EUR principal and 40 EUR interest, Mar – Dec 2026; paid through `paidThrough`. */
const instalments = (paidThrough: string) => Array.from({ length: 10 }, (_, i) => {
  const due = `2026-${String(i + 3).padStart(2, '0')}-10`
  const paid = due <= paidThrough
  return {
    id: `ki${i}`, credit_id: 'k1', installment_no: i + 1, due_date: due,
    principal_amount: 1000, interest_amount: 40, total_amount: 1040,
    status: paid ? 'paid' : 'outstanding', paid_date: paid ? due : null,
  }
})

describe('the credits card', () => {
  it('says what was drawn, what principal was repaid and what is owed at the end of the period', async () => {
    ;(global as any).__db.credits = [loan()]
    ;(global as any).__db.credit_installments = instalments('2026-10-10')
    await show()
    // Owed on 5 November: November and December, 2.000 EUR at 117.
    await cardSays('Krediti u periodu', rsd(234000))
    await cardSays('Krediti u periodu', `Povučeno: ${rsd(1170000)}`)
    // March to October paid: 8.000 EUR.
    await cardSays('Krediti u periodu', `Otplaćena glavnica (po planu otplate): ${rsd(936000)}`)
  })

  it('follows the period: last month ends with October', async () => {
    ;(global as any).__db.credits = [loan()]
    ;(global as any).__db.credit_installments = instalments('2026-10-10')
    await show()
    fireEvent.click(screen.getByText('Prošli mesec'))
    await cardSays('Krediti u periodu', `Otplaćena glavnica (po planu otplate): ${rsd(117000)}`)
    await cardSays('Krediti u periodu', `Povučeno: ${rsd(0)}`)
    await cardSays('Krediti u periodu', rsd(234000))
  })

  it('reads only the chosen company', async () => {
    const other = { id: 'comp-2', name: 'Druga Firma doo', currency: 'RSD', currencies: ['RSD'] }
    ;(global as any).__companies = {
      companies: [COMPANY, other], defaultCompany: COMPANY, showPicker: true, loading: false,
    }
    ;(global as any).__db.credits = [loan(), loan({ id: 'k2', company_id: 'comp-2', name: 'Kredit druge firme', currency: 'RSD', principal_amount: 5000000 })]
    await show()
    fireEvent.click(screen.getByText('Druga Firma doo'))
    await cardSays('Krediti u periodu', `Povučeno: ${rsd(5000000)}`)
  })

  it('says there are no credits rather than a debt of zero', async () => {
    await show()
    await cardSays('Krediti u periodu', 'nema kredita u evidenciji')
  })

  it('says the book could not be read instead of drawing zero', async () => {
    ;(global as any).__fail.credits = 'veza je prekinuta'
    await show()
    await cardSays('Krediti u periodu', 'Krediti nisu učitani: veza je prekinuta')
  })
})

describe('the indebtedness chart', () => {
  const section = () => screen.getByText('Zaduženost').parentElement!.parentElement!.parentElement as HTMLElement

  it('draws each month: drawn, principal and interest due and paid, and the balance', async () => {
    ;(global as any).__db.credits = [loan()]
    ;(global as any).__db.credit_installments = instalments('2026-10-10')
    // Interest is never a drawdown: no transaction is needed for any of this.
    ;(global as any).__db.v_pl_entries = []
    await show()
    await waitFor(() => expect(screen.getByLabelText(
      `feb ’26: povučeno ${rsd(1170000)}, glavnica ${rsd(0)} (plaćeno ${rsd(0)}), kamata ${rsd(0)} (plaćeno ${rsd(0)})`,
    )).toBeInTheDocument())
    expect(screen.getByLabelText(
      `nov ’26: povučeno ${rsd(0)}, glavnica ${rsd(117000)} (plaćeno ${rsd(0)}), kamata ${rsd(4680)} (plaćeno ${rsd(0)})`,
    )).toBeInTheDocument()
    expect(screen.getByLabelText(`jan ’26: dug na kraju meseca ${rsd(0)}`)).toBeInTheDocument()
    expect(screen.getByLabelText(`feb ’26: dug na kraju meseca ${rsd(1170000)}`)).toBeInTheDocument()
    expect(screen.getByLabelText(`okt ’26: dug na kraju meseca ${rsd(234000)}`)).toBeInTheDocument()
    expect(section()).toHaveTextContent('iznosi u RSD')
    expect(section()).toHaveTextContent('po današnjem kursu NBS')
  })

  it('names a revolving line with no rate and one with no maturity', async () => {
    ;(global as any).__db.credits = [
      loan({ id: 'r1', kind: 'revolving', name: 'Revolving bez stope', currency: 'RSD', principal_amount: 900000,
        disbursement_date: '2026-03-01', maturity_date: '2027-03-01', rate_margin: 2.5 }),
      loan({ id: 'r2', kind: 'revolving', name: 'Revolving bez roka', currency: 'RSD', principal_amount: 300000,
        disbursement_date: '2026-03-01', maturity_date: null, rate_margin: 2.5 }),
    ]
    await show()
    await waitFor(() => expect(section()).toHaveTextContent('Kamata za Revolving bez stope nije u grafikonu'))
    expect(section()).toHaveTextContent('Revolving bez roka nema datum dospeća')
    expect(screen.getByLabelText(`okt ’26: dug na kraju meseca ${rsd(1200000)}`)).toBeInTheDocument()
  })

  it('says there are no credits instead of drawing a flat line at zero', async () => {
    await show()
    await waitFor(() => expect(section()).toHaveTextContent('Nema kredita u evidenciji'))
    expect(screen.queryByLabelText(/dug na kraju meseca/)).toBeNull()
  })

  it('draws nothing and gives the reason when the book cannot be read', async () => {
    ;(global as any).__fail.credit_installments = 'istek vremena'
    ;(global as any).__db.credits = [loan()]
    await show()
    await waitFor(() => expect(section()).toHaveTextContent('Krediti nisu učitani: istek vremena'))
    expect(screen.queryByLabelText(/dug na kraju meseca/)).toBeNull()
  })
})

describe('review fixes: the credits card', () => {
  it('counts principal repaid by the day the money left: due in September, paid in October, is October', async () => {
    ;(global as any).__db.credits = [loan()]
    ;(global as any).__db.credit_installments = instalments('2026-08-10').map(i =>
      i.due_date === '2026-09-10' ? { ...i, status: 'paid', paid_date: '2026-10-03' } : i)
    await show()
    fireEvent.click(screen.getByText('Prošli mesec'))
    await cardSays('Krediti u periodu', `Otplaćena glavnica (po planu otplate): ${rsd(117000)}`)
  })

  it('says the book could not be converted instead of showing zero', async () => {
    ;(global as any).__noRates = true
    ;(global as any).__db.credits = [loan()]
    ;(global as any).__db.credit_installments = instalments('2026-10-10')
    await show()
    await cardSays('Krediti u periodu', 'Krediti nisu preračunati: nema kursa NBS za danas (EUR).')
    expect(card('Krediti u periodu')).not.toHaveTextContent(rsd(0))
    expect(card('Krediti u periodu')).not.toHaveTextContent('nema kredita u evidenciji')
    const section = screen.getByText('Zaduženost').parentElement!.parentElement!.parentElement as HTMLElement
    expect(section).toHaveTextContent('Krediti nisu preračunati: nema kursa NBS za danas (EUR).')
    expect(screen.queryByLabelText(/dug na kraju meseca/)).toBeNull()
  })
})

describe('review fixes: the principal heading', () => {
  const interestRole = (company: string, cat: string, sub: string | null) => ({
    id: `si-${company}`, company_id: company, role: 'credit_interest', pl_category: cat,
    pl_subcategory: sub, department: 'Uprava', dept_subcategory: 'Krediti', expense_description: 'Kamata',
  })

  it('does not ask a company with no credits to map its principal', async () => {
    ;(global as any).__db.system_categories = []
    await show()
    await cardSays('Ukupni troškovi', rsd(570000))
    expect(card('Ukupni troškovi')).not.toHaveTextContent('Glavnica nije izdvojena')
  })

  it('keeps the interest when principal is mapped to the whole category that holds it, and says why', async () => {
    ;(global as any).__db.system_categories = [
      { ...principalRole('comp-1', 'Finansiranje', 'Glavnica'), pl_subcategory: null },
      interestRole('comp-1', 'Finansiranje', 'Kamata'),
    ]
    await show()
    await cardSays('Ukupni troškovi', rsd(570000))
    await cardSays('Ukupni troškovi', 'Glavnica i kamata za Gradnja Primer doo su u istoj kategoriji — podesite potkategoriju za „Otplata glavnice kredita“')
  })

  it('takes out only the principal when interest has its own subcategory', async () => {
    ;(global as any).__db.system_categories = [
      principalRole('comp-1', 'Finansiranje', 'Glavnica'),
      interestRole('comp-1', 'Finansiranje', 'Kamata'),
    ]
    await show()
    await cardSays('Ukupni troškovi', rsd(420000))
  })
})
