import React from 'react'
import { render, screen, fireEvent, waitFor } from '@testing-library/react'
import { UnpaidInvoicesPanel } from './Reports'
import { UnpaidPanelExtensionContext, type UnpaidPanelExtension } from '../services/payments/unpaidPanelExtension'

// The panel's extension points: a client app presets lines, locks amounts,
// blocks lines from export, reserves amounts and hears about exports. With no
// provider the panel is exactly the plain one (UnpaidInvoicesPanel.render.test).

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


const open = async (ext: Partial<UnpaidPanelExtension>) => {
  render(
    <UnpaidPanelExtensionContext.Provider value={ext}>
      <UnpaidInvoicesPanel onClose={() => {}} />
    </UnpaidPanelExtensionContext.Provider>,
  )
  await screen.findByText('Beton Plus')
  // The bills arrive outside React's act; the presets follow them in an
  // effect, so wait until every preset line is ticked.
  const n = ext.presetLines?.length ?? 0
  if (n > 0) await waitFor(() => expect(document.querySelectorAll('input[type=checkbox]:checked')).toHaveLength(n))
}
const preset = { invoiceId: 'i1', amountText: '30000,00', bankAccountId: 'b2', paymentCode: '254' }

describe('the unpaid-bills panel, extended', () => {
  it('ticks the preset lines with their amount, bank and code', async () => {
    await open({ presetLines: [preset] })
    expect((screen.getByLabelText('Plati F-1') as HTMLInputElement).checked).toBe(true)
    expect((screen.getByLabelText('Iznos za plaćanje F-1') as HTMLInputElement).value).toBe('30000,00')
    expect((screen.getByLabelText('Banka F-1') as HTMLSelectElement).value).toBe('b2')
    expect((screen.getByLabelText('Šifra plaćanja F-1') as HTMLSelectElement).value).toBe('254')
  })

  it('locks the amount of a line it says is locked', async () => {
    await open({ presetLines: [preset], amountLocked: id => id === 'i1' })
    expect(screen.getByLabelText('Iznos za plaćanje F-1')).toHaveAttribute('readonly')
  })

  it('keeps a blocked line out of the files and says why', async () => {
    await open({ presetLines: [preset], exportBlock: id => (id === 'i1' ? 'Čeka odobrenje iznosa' : null) })
    expect(screen.getByText('Čeka odobrenje iznosa')).toBeInTheDocument()
    expect(screen.queryByText('↓ Izvezi')).not.toBeInTheDocument()
  })

  it('starts a new line at what is owed less what is reserved elsewhere', async () => {
    await open({ reserved: id => (id === 'i2' ? 20000 : 0) })
    fireEvent.click(screen.getByLabelText('Plati F-2'))
    expect((screen.getByLabelText('Iznos za plaćanje F-2') as HTMLInputElement).value).toBe('30000,00')
  })

  it('reports a change of bank', async () => {
    const onLineChange = jest.fn()
    await open({ presetLines: [preset], onLineChange })
    fireEvent.change(screen.getByLabelText('Banka F-1'), { target: { value: 'b1' } })
    expect(onLineChange).toHaveBeenCalledWith(expect.objectContaining({ invoiceId: 'i1', bankAccountId: 'b1' }))
  })

  it('shows the badge, the line actions and the selection actions', async () => {
    await open({
      presetLines: [preset],
      badge: id => (id === 'i1' ? 'Direktor' : null),
      lineActions: l => <button>Akcija {l.invoiceId}</button>,
      selectionActions: lines => <span>Izabrano: {lines.length}</span>,
    })
    expect(screen.getByText('Direktor')).toBeInTheDocument()
    expect(screen.getByText('Akcija i1')).toBeInTheDocument()
    expect(screen.getByText('Izabrano: 1')).toBeInTheDocument()
  })

  it('tells the client about each file, and shows its failure', async () => {
    const onExported = jest.fn().mockRejectedValue(new Error('Nije zabeleženo'))
    await open({ presetLines: [preset], onExported })
    fireEvent.click(screen.getByText('↓ Izvezi'))
    expect(onExported).toHaveBeenCalledWith(expect.objectContaining({ total: 30000 }), expect.stringMatching(/^nalozi_OTP_BANKA_222222_\d{6}\.txt$/))
    expect(await screen.findByText(/Nije zabeleženo/)).toBeInTheDocument()
    expect(downloads).toHaveLength(1)
  })
})
