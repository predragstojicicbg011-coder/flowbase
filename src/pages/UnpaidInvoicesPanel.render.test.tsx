import React from 'react'
import { render, screen, fireEvent, within, waitFor } from '@testing-library/react'
import { UnpaidInvoicesPanel } from './Reports'

// Paying unpaid bills: part of a bill, from two banks, one Halcom file each.
// The database is mocked table by table; the files are caught at the download.

const mockTables: Record<string, any[]> = {}

jest.mock('../supabase', () => {
  const builder = (table: string): any => {
    let single = false
    const b: any = {
      select: () => b, eq: () => b, in: () => b, order: () => b, range: () => b,
      single: () => { single = true; return b },
      then: (ok: any, bad: any) => Promise.resolve(
        single ? { data: (mockTables[table] || [])[0] ?? null, error: null } : { data: mockTables[table] || [], error: null },
      ).then(ok, bad),
    }
    return b
  }
  return { supabase: { from: (t: string) => builder(t) } }
})
jest.mock('../utils/fetchAllPages', () => ({
  fetchAllPages: async (page: any) => (await page(0, 999)).data,
  fetchByIds: async (_ids: string[], q: any) => (await q(_ids)).data,
  countRows: async () => 0,
}))
// One object for the whole test, as the real context gives: the panel reloads
// whenever `defaultCompany` changes identity.
const mockCompanies = { defaultCompany: { id: 'co', name: 'Firma doo' }, loading: false, companies: [], showPicker: false }
jest.mock('../contexts/CompaniesContext', () => ({ useCompanies: () => mockCompanies }))
jest.mock('../contexts/DisplayCurrencyContext', () => ({
  useDisplayCurrency: () => ({ currency: 'RSD', pick: (r: any) => r.amount_rsd ?? r.amount, format: (n: number | null) => (n === null ? '—' : String(n)) }),
}))
jest.mock('../navigation', () => ({ useNav: () => ({ page: 'reports', setPage: () => {} }) }))

const inv = (id: string, number: string, amount: number, partner: string) => ({
  id, invoice_number: number, amount, amount_rsd: amount, currency: 'RSD', type: 'expense',
  due_date: '2026-10-30', invoice_date: '2026-10-01', partner_id: `p-${id}`, account_number: '205-0000000654321-11',
  model: '97', reference_number: null, status: 'unpaid', partners: { id: `p-${id}`, name: partner, address: 'Ulica 1', city: 'Beograd' },
})

let downloads: string[] = []
beforeEach(() => {
  downloads = []
  Object.assign(mockTables, {
    company_bank_accounts: [
      { id: 'b1', bank_name: 'Banca Intesa', account_number: '160-0000000111111-11', is_primary: true, currency: 'RSD' },
      { id: 'b2', bank_name: 'OTP banka', account_number: '325-0000000222222-22', is_primary: false, currency: 'RSD' },
    ],
    company_profiles: [{ full_legal_name: 'Firma doo', city: 'Beograd', address: 'Adresa' }],
    v_invoice_status: [
      { id: 'i1', calculated_status: 'unpaid', amount: 100000, paid_amount: 0 },
      { id: 'i2', calculated_status: 'unpaid', amount: 50000, paid_amount: 0 },
    ],
    invoices: [inv('i1', 'F-1', 100000, 'Beton Plus'), inv('i2', 'F-2', 50000, 'Armatura')],
    partner_accounts: [],
  })
  ;(global as any).URL.createObjectURL = jest.fn(() => 'blob:x')
  ;(global as any).URL.revokeObjectURL = jest.fn()
  jest.spyOn(HTMLAnchorElement.prototype, 'click').mockImplementation(function (this: HTMLAnchorElement) { downloads.push(this.download) })
})

const open = async () => {
  render(<UnpaidInvoicesPanel onClose={() => {}} />)
  await screen.findByText('Beton Plus')
}

describe('paying unpaid bills', () => {
  it('pays part of a bill, shows what stays, and sums only what is paid', async () => {
    await open()
    fireEvent.click(screen.getByLabelText('Plati F-1'))
    const amount = screen.getByLabelText('Iznos za plaćanje F-1') as HTMLInputElement
    expect(amount.value).toBe('100000,00')
    fireEvent.change(amount, { target: { value: '40.000,00' } })
    expect(screen.getByText(/60\.000,00|60000,00|60,000\.00/)).toBeInTheDocument()
    // The subtotal at the top, and the Intesa file's total.
    expect(screen.getAllByText('40.000,00 RSD')).toHaveLength(2)
  })

  it('refuses more than is owed, and leaves that line out of the files', async () => {
    await open()
    fireEvent.click(screen.getByLabelText('Plati F-1'))
    fireEvent.change(screen.getByLabelText('Iznos za plaćanje F-1'), { target: { value: '150000' } })
    expect(screen.getByRole('alert')).toHaveTextContent('veći od onoga što je ostalo')
    expect(screen.queryByText('↓ Izvezi')).not.toBeInTheDocument()
  })

  it('pays bills from two banks in one window, one file per bank', async () => {
    await open()
    fireEvent.click(screen.getByLabelText('Plati F-1'))
    fireEvent.click(screen.getByLabelText('Plati F-2'))
    fireEvent.change(screen.getByLabelText('Banka F-2'), { target: { value: 'b2' } })
    fireEvent.change(screen.getByLabelText('Šifra plaćanja F-2'), { target: { value: '254' } })
    const buttons = screen.getAllByText('↓ Izvezi')
    expect(buttons).toHaveLength(2)
    expect(screen.getByText(/Banca Intesa/, { selector: 'b' }).parentElement).toHaveTextContent('221 (1)')
    expect(screen.getByText(/OTP banka/, { selector: 'b' }).parentElement).toHaveTextContent('254 (1)')
    // One file at a time: the second button waits until the first is done.
    fireEvent.click(buttons[0])
    await waitFor(() => expect(downloads).toHaveLength(1))
    await waitFor(() => expect(screen.getAllByText('↓ Izvezi')[1]).toBeEnabled())
    fireEvent.click(screen.getAllByText('↓ Izvezi')[1])
    await waitFor(() => expect(downloads).toHaveLength(2))
    expect(downloads[0]).toMatch(/^nalozi_BANCA_INTESA_111111_\d{6}\.txt$/)
    expect(downloads[1]).toMatch(/^nalozi_OTP_BANKA_222222_\d{6}\.txt$/)
  })

  it('moves every ticked bill to one bank at once', async () => {
    await open()
    fireEvent.click(screen.getByLabelText('Plati F-1'))
    fireEvent.click(screen.getByLabelText('Plati F-2'))
    fireEvent.change(screen.getByLabelText('Banka za sve izabrane'), { target: { value: 'b2' } })
    expect((screen.getByLabelText('Banka F-1') as HTMLSelectElement).value).toBe('b2')
    expect((screen.getByLabelText('Banka F-2') as HTMLSelectElement).value).toBe('b2')
    expect(screen.getAllByText('↓ Izvezi')).toHaveLength(1)
    expect(within(screen.getByText(/OTP banka/, { selector: 'b' }).parentElement!).getByText(/2 naloga/)).toBeInTheDocument()
  })
})
