import React from 'react'
import { render, screen } from '@testing-library/react'
import SupplierAdvancesPanel from './SupplierAdvancesPanel'

// The chain per supplier: paid on proformas, covered by advance invoices, used
// by final invoices, and the warnings that stay until it is resolved.

const mockTables: Record<string, any[]> = {}

jest.mock('../supabase', () => {
  const builder = (table: string): any => {
    const b: any = {
      select: () => b, eq: () => b, in: () => b, order: () => b, gt: () => b, limit: () => b,
      then: (ok: any, bad: any) => Promise.resolve({ data: mockTables[table] || [], error: null }).then(ok, bad),
    }
    return b
  }
  return { supabase: { from: (t: string) => builder(t) } }
})
const mockCompanies = { defaultCompany: { id: 'co', name: 'Firma doo' }, loading: false, companies: [], showPicker: false }
jest.mock('../contexts/CompaniesContext', () => ({ useCompanies: () => mockCompanies }))

beforeEach(() => {
  mockTables.v_supplier_advances = [
    { company_id: 'co', partner_id: 'b', partner_name: 'Bepro Beton', currency: 'RSD', paid_on_proformas: 0, covered: 0,
      advance_total: 329725.45, used: 323125.57, paid_without_advance: 0, advance_open: 6599.88 },
    { company_id: 'co', partner_id: 'x', partner_name: 'Dobavljač X', currency: 'RSD', paid_on_proformas: 200000, covered: 150000,
      advance_total: 150000, used: 150000, paid_without_advance: 50000, advance_open: 0 },
  ]
  mockTables.v_invoice_status = [
    { id: 'l1', invoice_number: 'AV-LOOSE', partner_name: 'Dobavljač Y', document_type: 'advance_invoice', amount: 5000, currency: 'RSD', unlinked: true, advance_open: 5000 },
  ]
})

describe('supplier advances', () => {
  it('shows the chain per supplier and what is still open', async () => {
    render(<SupplierAdvancesPanel onClose={() => {}} />)
    expect(await screen.findByText('Bepro Beton')).toBeInTheDocument()
    expect(screen.getByText('Avans čeka konačni račun: 6.599,88 RSD')).toBeInTheDocument()
    expect(screen.getByText('Plaćeno bez avansnog računa: 50.000,00 RSD')).toBeInTheDocument()
    expect(screen.getByText('Avansni račun AV-LOOSE (Dobavljač Y) nije vezan za predračun')).toBeInTheDocument()
  })

  it('says so when there is nothing', async () => {
    mockTables.v_supplier_advances = []
    mockTables.v_invoice_status = []
    render(<SupplierAdvancesPanel onClose={() => {}} />)
    expect(await screen.findByText('Nema avansa dobavljačima.')).toBeInTheDocument()
  })
})
