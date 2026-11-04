import React from 'react'
import { render, screen, waitFor, within, fireEvent, act } from '@testing-library/react'
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
  return { supabase: { from: (t: string) => builder(t), functions: { invoke: (...a: any[]) => (global as any).__revenueInvoke(...a) } } }
})

;(global as any).__revenueInvoke = jest.fn()
jest.mock('../contexts/AuthContext', () => ({ useAuth: () => ({ user: null, canEdit: true }) }))
jest.mock('../components/InvoiceDialog', () => ({
  __esModule: true,
  default: (p: any) => <div data-testid="invoice-dialog" data-type={p.invoice?.type} />,
}))
jest.mock('../components/PartnerCardDialog', () => ({ __esModule: true, default: (p: any) => <div data-testid="partner-card">{p.partner.name}</div> }))
jest.mock('../components/DocumentViewerDialog', () => ({ __esModule: true, default: (p: any) => <div data-testid="document-viewer" data-invoice={p.invoiceId} /> }))
jest.mock('../components/SefSalesInboxDialog', () => ({ __esModule: true, default: () => <div data-testid="sales-inbox" /> }))
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
    expect(screen.getByRole('button', { name: /Ukupna potraživanja/ })).toBeInTheDocument()
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

  it('lists the leases without an invoice this month, as a reminder only', async () => {
    show()
    fireEvent.click(await screen.findByRole('button', { name: 'Meseci bez fakture za zakup' }))
    const dialog = screen.getByRole('dialog', { name: 'Meseci bez fakture za zakup' })
    expect(within(dialog).getByText('Zakupac Market')).toBeInTheDocument()
    expect(within(dialog).getByText('1.000,00 EUR')).toBeInTheDocument()
    expect(within(dialog).getByText(/Faktura za zakup se izdaje na SEF-u ili u Calculus-u/)).toBeInTheDocument()
    expect(within(dialog).queryByRole('button', { name: /Izdaj/ })).not.toBeInTheDocument()
    expect(within(dialog).queryByText(/ZAK-/)).not.toBeInTheDocument()
  })
})

describe('Prihodi page — SEF izlazne', () => {
  // Let the page's own follow-up updates (busy flags, reloads) land inside act.
  afterEach(async () => { await act(async () => { await new Promise(r => setTimeout(r, 0)) }) })
  beforeEach(() => {
    empty()
    ;(global as any).__revenueInvoke = jest.fn(async () => ({ data: { provider: 'sef-sales', status: 'complete', listed: 3, inserted: 2, refreshed: 1, more: false }, error: null }))
  })

  it('pulls sales invoices from SEF on request', async () => {
    show()
    await screen.findByText(/Još nema izlaznih faktura, avansa/)
    fireEvent.click(await screen.findByRole('button', { name: 'Preuzmi sa SEF-a' }))
    await waitFor(() => expect((global as any).__revenueInvoke).toHaveBeenCalledWith('sef-pull-sales', { body: {} }))
    expect(await screen.findByText(/Preuzeto 2 nove/)).toBeInTheDocument()
  })

  it('opens a new revenue invoice', async () => {
    show()
    await screen.findByText(/Još nema izlaznih faktura, avansa/)
    fireEvent.click(await screen.findByRole('button', { name: 'Nova izlazna faktura' }))
    expect(screen.getByTestId('invoice-dialog')).toHaveAttribute('data-type', 'revenue')
  })

  it('opens the sales inbox', async () => {
    show()
    await screen.findByText(/Još nema izlaznih faktura, avansa/)
    fireEvent.click(await screen.findByRole('button', { name: 'SEF izlazne' }))
    expect(screen.getByTestId('sales-inbox')).toBeInTheDocument()
  })
})

describe('Prihodi — receivables first', () => {
  // Let the page's own follow-up updates land inside act.
  afterEach(async () => { await act(async () => { await new Promise(r => setTimeout(r, 0)) }) })
  const inDays = (n: number) => iso(new Date(Date.now() + n * 86400000))
  const sale = (o: any) => ({
    type: 'revenue', company_id: 'c1', currency: 'RSD', invoice_date: daysAgo(60), calculated_status: 'unpaid',
    document_type: 'invoice', paid_amount_rsd: '0', paid_amount_eur: '0',
    amount_eur: '0', remaining_eur: '0', ...o,
  })
  beforeEach(() => {
    empty()
    mockDb.projects = [
      { id: 'a', company_id: 'c1', name: 'Novi Beograd A1', code: 'NB-01', kind: 'construction',
        contract_value: '1000000', contract_currency: 'RSD', contract_value_rsd: '1000000', contract_value_eur: '8532.42',
        payment_days: 45, active: true },
      { id: 'b', company_id: 'c1', name: 'Poslovna zgrada Zemun', kind: 'rental', payment_days: 15, active: true },
    ]
    mockDb.v_invoice_status = [
      sale({ id: 'late', invoice_number: 'ALFA-1', partner_id: 'p1', partner_name: 'Kupac Alfa', project_id: 'a',
        due_date: daysAgo(10), amount: '300000', amount_rsd: '300000', remaining_rsd: '125000' }),
      sale({ id: 'soon', invoice_number: 'BETA-1', partner_id: 'p2', partner_name: 'Kupac Beta', project_id: null,
        due_date: inDays(3), amount: '60000', amount_rsd: '60000', remaining_rsd: '60000' }),
      sale({ id: 'later', invoice_number: 'GAMA-1', partner_id: 'p3', partner_name: 'Kupac Gama', project_id: null,
        due_date: inDays(30), amount: '25000', amount_rsd: '25000', remaining_rsd: '25000' }),
      sale({ id: 'pro', invoice_number: 'PRED-1', partner_id: 'p4', partner_name: 'Kupac Delta', project_id: null,
        document_type: 'proforma', due_date: daysAgo(5), amount: '40000', amount_rsd: '40000', remaining_rsd: '40000' }),
      sale({ id: 'rent', invoice_number: 'ZAK-1', partner_id: 'p5', partner_name: 'Zakupac Market', project_id: 'b',
        lease_id: 'l1', invoice_date: daysAgo(3), due_date: inDays(20),
        amount: '0', amount_rsd: '0', remaining_rsd: '0', calculated_status: 'paid' }),
    ]
  })

  it('opens with three cards in full figures and the proformas waiting', async () => {
    show()
    const total = await screen.findByRole('button', { name: /Ukupna potraživanja/ })
    expect(within(total).getByText('210.000 RSD')).toBeInTheDocument()
    expect(within(screen.getByRole('button', { name: /Dospeva u narednih 7 dana/ })).getByText('60.000 RSD')).toBeInTheDocument()
    expect(within(screen.getByRole('button', { name: /^Kasni/ })).getByText('125.000 RSD')).toBeInTheDocument()
    expect(screen.getByText(/Predračuni koji čekaju uplatu: 1 · 40\.000 RSD/)).toBeInTheDocument()
  })

  it('opens only the late invoices from the Kasni card', async () => {
    show()
    fireEvent.click(await screen.findByRole('button', { name: /^Kasni/ }))
    const t = screen.getByRole('table', { name: /Potraživanja: Kasni/ })
    expect(within(t).getByText('ALFA-1')).toBeInTheDocument()
    expect(within(t).queryByText('BETA-1')).not.toBeInTheDocument()
  })

  it('lists who is late with the amount owed', async () => {
    show()
    const t = await screen.findByRole('table', { name: 'Ko kasni' })
    const row = within(t).getByText('Kupac Alfa').closest('tr')!
    expect(within(row).getByText('125.000 RSD')).toBeInTheDocument()
    expect(within(row).getByText('10')).toBeInTheDocument()
    expect(within(t).queryByText('Kupac Beta')).not.toBeInTheDocument()
  })

  it('opens the customer card and the oldest invoice PDF from the late list', async () => {
    show()
    fireEvent.click(await screen.findByRole('button', { name: 'Kartica Kupac Alfa' }))
    expect(screen.getByTestId('partner-card')).toHaveTextContent('Kupac Alfa')
    fireEvent.click(screen.getByRole('button', { name: 'PDF najstarije fakture Kupac Alfa' }))
    expect(screen.getByTestId('document-viewer')).toHaveAttribute('data-invoice', 'late')
  })

  it('keeps the sections in the new order', async () => {
    show()
    await screen.findByRole('table', { name: 'Ko kasni' })
    const order = ['Ko kasni', 'Po projektima', 'Izlazne fakture', 'Starost potraživanja', 'Plan prihoda', 'Zakup']
    const els = order.map(t => screen.getAllByText(t, { selector: 'div' })[0])
    for (let i = 1; i < els.length; i++) {
      expect(els[i - 1].compareDocumentPosition(els[i]) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy()
    }
    expect(screen.getByText(/do kraja godine/)).toBeInTheDocument()
    const last = await screen.findByText('Avansi kupaca', { selector: 'div' })
    const zakup = screen.getAllByText('Zakup', { selector: 'div' })[0]
    expect(zakup.compareDocumentPosition(last) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy()
  })

  it('shows what is left to bill and leaves the rented building out', async () => {
    show()
    const t = await screen.findByRole('table', { name: 'Prihodi po projektima' })
    expect(within(t).getByText('Preostalo za fakturisanje')).toBeInTheDocument()
    expect(within(t).getAllByText('700.000 RSD').length).toBeGreaterThan(0)
    expect(within(t).queryByText(/Zemun/)).not.toBeInTheDocument()
  })

  it('filters the list by kind and has a PDF button per row', async () => {
    show()
    const list = await screen.findByRole('table', { name: 'Izlazne fakture' })
    fireEvent.click(within(within(list).getByText('ALFA-1').closest('tr')!).getByRole('button', { name: /PDF fakture ALFA-1/ }))
    expect(screen.getByTestId('document-viewer')).toHaveAttribute('data-invoice', 'late')
    expect(screen.queryByTestId('invoice-dialog')).not.toBeInTheDocument()
    fireEvent.change(screen.getByLabelText('Razvrstavanje'), { target: { value: 'lease' } })
    const only = screen.getByRole('table', { name: 'Izlazne fakture' })
    expect(within(only).getByText('ZAK-1')).toBeInTheDocument()
    expect(within(only).queryByText('ALFA-1')).not.toBeInTheDocument()
  })

  it('warns in red about an invoice voided on SEF', async () => {
    mockDb.sef_inbox = [
      { imported_invoice_id: 'late', sef_status: 'Cancelled' },
      { imported_invoice_id: 'soon', sef_status: 'Paid' },
    ]
    show()
    const list = await screen.findByRole('table', { name: 'Izlazne fakture' })
    await waitFor(() => expect(within(within(list).getByText('ALFA-1').closest('tr')!).getByText('Stornirana na SEF-u')).toBeInTheDocument())
    expect(within(within(list).getByText('BETA-1').closest('tr')!).getByText('SEF: plaćena, izvod ne')).toBeInTheDocument()
    // Still counted in the receivables, and flagged wherever it is listed.
    expect(within(screen.getByRole('button', { name: /^Kasni/ })).getByText('125.000 RSD')).toBeInTheDocument()
    const late = screen.getByRole('table', { name: 'Ko kasni' })
    expect(within(late).getByText('Stornirana na SEF-u')).toBeInTheDocument()
    fireEvent.click(screen.getByRole('button', { name: /^Kasni/ }))
    const t = screen.getByRole('table', { name: /Potraživanja: Kasni/ })
    expect(within(t).getByText('Stornirana na SEF-u')).toBeInTheDocument()
  })
})
