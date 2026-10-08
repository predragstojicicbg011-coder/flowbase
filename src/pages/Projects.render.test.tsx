import React from 'react'
import { render, screen, waitFor, within } from '@testing-library/react'
import Projects from './Projects'
import { DisplayCurrencyProvider } from '../contexts/DisplayCurrencyContext'

// Rows per table, set per test. Every chain resolves to that table's rows,
// whatever filters and paging were applied on the way.
const mockDb: Record<string, any[]> = {}
;(global as any).__projectsPageDb = mockDb

jest.mock('../supabase', () => {
  const db = () => (global as any).__projectsPageDb
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

beforeEach(() => {
  mockDb.companies = [{ id: 'c1', name: 'Milinković Company doo' }]
  mockDb.partners = [{ id: 'inv1', name: 'Investitor d.o.o.' }]
  mockDb.projects = [
    { id: 'a', company_id: 'c1', name: 'Novi Beograd A1', code: 'NB-01', kind: 'construction',
      investor_partner_id: 'inv1', contract_value: '250000', contract_currency: 'EUR', active: true },
    { id: 'b', company_id: 'c1', name: 'Poslovna zgrada Zemun', kind: 'rental', active: true },
  ]
  mockDb.v_pl_entries = [
    { id: '1', tx_type: 'revenue', amount_rsd: 1000000, amount_eur: 8532.42, project_id: 'a', project_name: 'Novi Beograd A1' },
    { id: '2', tx_type: 'expense', amount_rsd: 400000, amount_eur: 3412.97, project_id: 'a', project_name: 'Novi Beograd A1' },
    { id: '3', tx_type: 'expense', amount_rsd: 100000, amount_eur: 853.24, project_id: null, project_name: null },
  ]
})

describe('Projects page', () => {
  it('lists the projects with kind, investor and contract value in its own currency', async () => {
    render(<DisplayCurrencyProvider initial="RSD"><Projects /></DisplayCurrencyProvider>)
    // The name is in both tables: the list and the profitability.
    expect((await screen.findAllByText('Poslovna zgrada Zemun')).length).toBe(2)
    const site = screen.getAllByText('Novi Beograd A1')[0].closest('tr')!
    expect(within(site).getByText('NB-01')).toBeInTheDocument()
    expect(within(site).getByText('Gradilište')).toBeInTheDocument()
    expect(screen.getByText('Objekat u zakupu')).toBeInTheDocument()
    await waitFor(() => expect(screen.getByText('Investitor d.o.o.')).toBeInTheDocument())
    expect(screen.getByText(/250\.000,00 EUR/)).toBeInTheDocument()
  })

  it('shows revenue, direct cost and margin per project, overhead on its own row', async () => {
    render(<DisplayCurrencyProvider initial="RSD"><Projects /></DisplayCurrencyProvider>)
    const overhead = await screen.findByText('Opšti troškovi')
    const overheadRow = overhead.closest('tr')!
    await waitFor(() => expect(within(overheadRow).getByText('100.000 RSD')).toBeInTheDocument())
    expect(within(overheadRow).getByText('-100.000 RSD')).toBeInTheDocument()

    const total = screen.getByText('Ukupno').closest('tr')!
    expect(within(total).getByText('1.000.000 RSD')).toBeInTheDocument()
    // Cost and margin are both 500.000 here.
    expect(within(total).getAllByText('500.000 RSD')).toHaveLength(2)

    const site = screen.getByText('NB-01 · Novi Beograd A1').closest('tr')!
    expect(within(site).getByText('400.000 RSD')).toBeInTheDocument()
    expect(within(site).getByText('600.000 RSD')).toBeInTheDocument()
    expect(within(site).getByText('60,0%')).toBeInTheDocument()
  })
})
