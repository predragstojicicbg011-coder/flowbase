import React from 'react'
import { render, screen, waitFor, within, fireEvent } from '@testing-library/react'
import Revenue from './Revenue'
import { DisplayCurrencyProvider } from '../contexts/DisplayCurrencyContext'

// Rows per table, set per test. Every chain resolves to that table's rows,
// whatever filters and paging were applied on the way.
const mockDb: Record<string, any[]> = {}
;(global as any).__revenuePageDb = mockDb

jest.mock('../supabase', () => {
  const db = () => (global as any).__revenuePageDb
  const builder = (table: string): any => {
    const result = () => ({ data: db()[table] || [], error: null })
    const b: any = new Proxy({}, {
      get(_t, prop) {
        if (prop === 'then') return (res: any) => Promise.resolve(result()).then(res)
        if (prop === 'range') return () => Promise.resolve(result())
        return () => b
      },
    })
    return b
  }
  return { supabase: { from: (t: string) => builder(t) } }
})

jest.mock('../contexts/AuthContext', () => ({ useAuth: () => ({ user: null }) }))
jest.mock('../components/InvoiceDialog', () => ({ __esModule: true, default: () => null }))
jest.mock('../services/currencyService', () => ({
  ...jest.requireActual('../services/currencyService'),
  getRatesForDate: (date: string) => Promise.resolve({ date, eurRsdRate: 117.2, usdRsdRate: 100, source: 'NBS', isFallback: false }),
}))

const iso = (d: Date) => d.toISOString().slice(0, 10)
const today = iso(new Date())
const daysAgo = (n: number) => iso(new Date(Date.now() - n * 86400000))

const empty = () => {
  for (const k of Object.keys(mockDb)) delete mockDb[k]
  mockDb.companies = [{ id: 'c1', name: 'Demo d.o.o.' }]
}

const show = () => render(<DisplayCurrencyProvider initial="RSD"><Revenue /></DisplayCurrencyProvider>)

describe('Prihodi page — empty', () => {
  beforeEach(empty)

  it('explains each empty section in Serbian', async () => {
    show()
    expect(await screen.findByText(/Još nema izlaznih faktura, avansa, plana ni zakupa/)).toBeInTheDocument()
    expect(screen.getByText('Nema otvorenih potraživanja')).toBeInTheDocument()
    expect(screen.getByText('Nema aktivnih projekata')).toBeInTheDocument()
    expect(screen.getByText('Nema objekata u zakupu')).toBeInTheDocument()
    expect(screen.getByText('Još nema izlaznih faktura ni projekata')).toBeInTheDocument()
    expect(screen.getByText('Fakturisano u periodu · RSD')).toBeInTheDocument()
  })
})

describe('Prihodi page — populated', () => {
  beforeEach(() => {
    empty()
    mockDb.partners = [{ id: 'inv1', name: 'Investitor d.o.o.' }, { id: 't1', name: 'Zakupac Market' }]
    mockDb.projects = [
      { id: 'a', company_id: 'c1', name: 'Novi Beograd A1', code: 'NB-01', kind: 'construction',
        investor_partner_id: 'inv1', contract_value: '1000000', contract_currency: 'RSD',
        contract_value_rsd: '1000000', contract_value_eur: '8532.42', payment_days: 45, active: true },
      { id: 'b', company_id: 'c1', name: 'Poslovna zgrada Zemun', kind: 'rental', payment_days: 15, active: true },
    ]
    mockDb.v_invoice_status = [
      { id: 'i1', type: 'revenue', company_id: 'c1', project_id: 'a', project_name: 'Novi Beograd A1',
        partner_id: 'inv1', partner_name: 'Investitor d.o.o.', invoice_number: 'SIT-01/2026',
        invoice_date: today, due_date: daysAgo(40), currency: 'RSD',
        amount: '300000', amount_rsd: '300000', amount_eur: '2559.73',
        advance_deducted: '50000', advance_deducted_rsd: '50000', advance_deducted_eur: '426.62',
        paid_amount: '100000', paid_amount_rsd: '100000', paid_amount_eur: '853.24',
        remaining_rsd: '150000', remaining_eur: '1279.87', calculated_status: 'partial',
        revenue_stream: 'Građevinske situacije' },
    ]
    mockDb.transactions = [
      { id: 'adv', project_id: 'a', currency: 'RSD', amount: '200000', amount_rsd: '200000', amount_eur: '1706.48', status: 'posted' },
    ]
    mockDb.revenue_plan = [
      { id: 'r1', company_id: 'c1', project_id: 'a', month: `${today.slice(0, 7)}-01`, amount: '400000', currency: 'RSD',
        amount_rsd: '400000', amount_eur: '3412.97', rate_date: today },
    ]
    mockDb.rental_leases = [
      { id: 'abcd1234-0000-0000-0000-000000000000', company_id: 'c1', project_id: 'b', tenant_partner_id: 't1',
        monthly_rent: '1000', currency: 'EUR', start_date: '2020-01-01', end_date: null,
        invoice_day: 5, payment_days: 10, active: true },
    ]
  })

  it('shows the project row with contract, billing, advance and collection', async () => {
    show()
    const table = await screen.findByRole('table', { name: 'Prihodi po projektima' })
    const row = within(table).getByText('NB-01 · Novi Beograd A1').closest('tr')!
    expect(within(row).getByText('1.000.000 RSD')).toBeInTheDocument()
    expect(within(row).getAllByText('300.000 RSD').length).toBeGreaterThan(0)
    expect(within(row).getByText('30,0%')).toBeInTheDocument()
    expect(within(row).getByText('200.000 RSD')).toBeInTheDocument()
    // Advance remaining and outstanding are both 150.000.
    expect(within(row).getAllByText('150.000 RSD')).toHaveLength(2)
    expect(within(table).getByText('Ukupno')).toBeInTheDocument()
  })

  it('lists the invoice with its Serbian status and opens aging buckets', async () => {
    show()
    const list = await screen.findByRole('table', { name: 'Izlazne fakture' })
    const row = within(list).getByText('SIT-01/2026').closest('tr')!
    expect(within(row).getByText('Delimično')).toBeInTheDocument()
    expect(within(row).getByText('Investitor d.o.o.')).toBeInTheDocument()

    const bucket = screen.getByRole('button', { name: /31–60 dana: 1 faktura/ })
    fireEvent.click(bucket)
    const aging = screen.getByRole('table', { name: /Potraživanja: 31–60 dana/ })
    expect(within(aging).getByText('SIT-01/2026')).toBeInTheDocument()
    expect(within(aging).getByText('40')).toBeInTheDocument()
  })

  it('shows the plan cell, the rent forecast and the lease', async () => {
    show()
    const grid = await screen.findByRole('table', { name: 'Plan prihoda' })
    const planInput = within(grid).getAllByLabelText(/Plan Novi Beograd A1/)[0] as HTMLInputElement
    expect(planInput.value).toBe('400000')
    const rentInput = within(grid).getAllByLabelText(/Plan Poslovna zgrada Zemun/)[0] as HTMLInputElement
    expect(rentInput.value).toBe('')
    expect(rentInput.placeholder).toBe('1.000 EUR')
    await waitFor(() => expect(screen.getByText(/Kurs na dan unosa: 1 EUR = 117,2000 RSD/)).toBeInTheDocument())

    const leases = screen.getByRole('table', { name: 'Zakupi: Poslovna zgrada Zemun' })
    await waitFor(() => expect(within(leases).getByText('Zakupac Market')).toBeInTheDocument())
    expect(within(leases).getByText('1.000,00 EUR')).toBeInTheDocument()
    expect(within(leases).getByText(/neograničeno/)).toBeInTheDocument()
  })

  it('proposes this month\'s rent invoice with a provisional number', async () => {
    show()
    fireEvent.click(await screen.findByRole('button', { name: 'Predloži fakture za zakup' }))
    const dialog = screen.getByRole('dialog', { name: 'Predlog faktura za zakup' })
    expect(within(dialog).getByText(`ZAK-ABCD1234-${today.slice(0, 7)}`)).toBeInTheDocument()
    expect(within(dialog).getByText('1.000,00 EUR')).toBeInTheDocument()
  })
})
