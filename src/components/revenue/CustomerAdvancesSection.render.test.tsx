import React from 'react'
import { render, screen, within } from '@testing-library/react'
import CustomerAdvancesSection from './CustomerAdvancesSection'
import { fmtMoney } from '../../utils/formatters'

const mockDb: Record<string, any[]> = {}
;(global as any).__advDb = mockDb

jest.mock('../../supabase', () => {
  const builder = (table: string): any => {
    const result = () => ({ data: ((global as any).__advDb[table]) || [], error: null })
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

const format = (n: number | null | undefined, d = 2) => fmtMoney(n, 'RSD', d)

beforeEach(() => { for (const k of Object.keys(mockDb)) delete mockDb[k] })

describe('Avansi kupaca', () => {
  it('shows a customer with what was used and what still waits for the final invoice', async () => {
    mockDb.v_customer_advances = [{
      company_id: 'c1', partner_id: 'k1', partner_name: 'Kupac Alfa', project_id: 'a', project_name: 'Novi Beograd A1', currency: 'RSD',
      received_on_proformas: 250000, covered: 200000, advance_total: 200000, used: 120000,
      received_without_advance: 50000, advance_open: 80000,
    }]
    render(<CustomerAdvancesSection companyId="c1" format={format} />)
    const table = await screen.findByRole('table', { name: 'Avansi kupaca' })
    const row = within(table).getByText('Kupac Alfa').closest('tr')!
    expect(within(row).getByText('120.000 RSD')).toBeInTheDocument()
    expect(within(row).getByText('Novi Beograd A1')).toBeInTheDocument()
    expect(within(row).getByText('Avans čeka konačnu fakturu: 80.000 RSD')).toBeInTheDocument()
    expect(within(row).getByText('Primljeno bez avansnog računa: 50.000 RSD')).toBeInTheDocument()
  })

  it('says so when there are none', async () => {
    render(<CustomerAdvancesSection companyId="c1" format={format} />)
    expect(await screen.findByText('Nema avansa kupaca.')).toBeInTheDocument()
  })
})
