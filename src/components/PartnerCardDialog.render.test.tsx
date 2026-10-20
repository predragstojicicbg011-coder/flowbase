import React from 'react'
import { render, screen, fireEvent } from '@testing-library/react'
import PartnerCardDialog from './PartnerCardDialog'

// The partner's card on screen: the running balance, the verdict, the two
// lists below it that do not move the balance, and the 📎 that opens a bill.

const mockData: any = {}
jest.mock('../services/loadPartnerCard', () => ({ loadPartnerCard: async () => mockData }))
jest.mock('../contexts/CompaniesContext', () => ({
  useCompanies: () => ({ companies: [{ id: 'co', name: 'Firma doo' }], defaultCompany: { id: 'co', name: 'Firma doo' }, showPicker: false }),
}))
jest.mock('./InvoiceDocumentsDialog', () => ({ invoiceId }: any) => <div>Dokumenti {invoiceId}</div>)
jest.mock('../supabase', () => {
  const rows: Record<string, any> = {
    company_profiles: { full_legal_name: 'Firma doo', address: 'Ulica 1', city: 'Beograd', pib: '100000001' },
    partners: { id: 'p1', name: 'Beton Plus doo', tax_id: '100000004', address: 'Put 2', city: 'Novi Sad' },
  }
  const q = (t: string): any => {
    const b: any = { select: () => b, eq: () => b, maybeSingle: async () => ({ data: rows[t] ?? null, error: null }) }
    return b
  }
  return { supabase: { from: (t: string) => q(t) } }
})

const doc = (over: any) => ({
  id: 'x', invoice_number: null, invoice_date: '2026-10-01', type: 'expense', document_type: 'invoice', currency: 'RSD',
  amount: 0, amount_rsd: 0, adjusts_invoice_id: null, prior_period: false, advance_open: null, advance_deducted_rsd: 0, ...over,
})

beforeEach(() => {
  Object.assign(mockData, {
    documents: [
      doc({ id: 'f412', invoice_number: 'F-412/26', invoice_date: '2026-10-03', amount: 120000, amount_rsd: 120000 }),
      doc({ id: 'av1', invoice_number: 'AV104/2026', document_type: 'advance_invoice', amount: 329725.45, amount_rsd: 329725.45, advance_open: 6599.88, prior_period: true }),
      doc({ id: 'f745', invoice_number: '745/2026', invoice_date: '2026-10-14', amount: 323125.57, amount_rsd: 323125.57 }),
    ],
    payments: [{ invoice_id: 'f412', transaction_id: 't1', date: '2026-10-12', amount_rsd: 60000, bank: 'OTP banka' }],
    usage: [{ final_invoice_id: 'f745', advance_invoice_id: 'av1', amount_rsd: 323125.57 }], coverage: [],
    direct: [{ id: 'd1', date: '2026-10-15', amount_rsd: 8400, bank: 'Banca Intesa', note: 'prevoz robe', direction: 'out' }],
    withDocs: new Set(['f412']),
  })
})

const open = async () => {
  render(<PartnerCardDialog partner={{ id: 'p1', name: 'Beton Plus doo' }} onClose={() => {}} />)
  await screen.findByText('Račun F-412/26')
}

describe('the partner card', () => {
  it('shows each change with the running balance and who owes whom', async () => {
    await open()
    expect(screen.getByText(/^Isplata — OTP banka/)).toBeInTheDocument()
    expect(screen.getByText(/^Dugujemo partneru/)).toBeInTheDocument()
    expect(screen.getAllByText('60.000,00 RSD').length).toBeGreaterThan(0)
  })

  it('lists advances and direct payments below, out of the balance', async () => {
    await open()
    expect(screen.getByText('Avansi kod dobavljača (ne ulaze u saldo)')).toBeInTheDocument()
    expect(screen.getByText(/Avansni račun AV104\/2026/)).toBeInTheDocument()
    expect(screen.getByText(/^Zatvoreno avansom AV104\/2026/)).toBeInTheDocument()
    expect(screen.getByText(/otvoreno 6\.599,88/)).toBeInTheDocument()
    expect(screen.getByText('Direktna plaćanja bez računa (ne menjaju saldo)')).toBeInTheDocument()
    expect(screen.getByText(/prevoz robe/)).toBeInTheDocument()
  })

  it('opens a bill and its attachments from the 📎', async () => {
    await open()
    fireEvent.click(screen.getAllByLabelText('Račun i prilozi')[0])
    expect(screen.getByText('Dokumenti f412')).toBeInTheDocument()
  })

  it('counts what came before the period as the opening balance', async () => {
    await open()
    fireEvent.change(screen.getByLabelText('Od'), { target: { value: '2026-10-10' } })
    expect(screen.getByText('Početni saldo')).toBeInTheDocument()
    expect(screen.queryByText('Račun F-412/26')).not.toBeInTheDocument()
  })
})

describe('exporting the card', () => {
  it('prints the card with both parties into a frame', async () => {
    await open()
    fireEvent.click(screen.getByText('Izvezi PDF'))
    await screen.findByText('Izvezi PDF')
    await new Promise(r => setTimeout(r, 20))
    const frame = document.querySelector('iframe[title="Kartica za štampu"]') as HTMLIFrameElement
    expect(frame).not.toBeNull()
    expect(frame.srcdoc).toContain('Beton Plus doo')
    expect(frame.srcdoc).toContain('PIB 100000001')
    expect(frame.srcdoc).toContain('Račun F-412/26')
  })
})

describe('the IOS', () => {
  it('prints the open items on the end date of the card into a frame', async () => {
    await open()
    fireEvent.change(screen.getByLabelText('Do'), { target: { value: '2026-10-31' } })
    fireEvent.click(screen.getByText('IOS'))
    await new Promise(r => setTimeout(r, 20))
    const frame = document.querySelector('iframe[title="IOS za štampu"]') as HTMLIFrameElement
    expect(frame).not.toBeNull()
    expect(frame.srcdoc).toContain('IZVOD OTVORENIH STAVKI')
    expect(frame.srcdoc).toContain('na dan 31.10.2026')
    expect(frame.srcdoc).toContain('IOS-100000004-20261031')
    expect(frame.srcdoc).toContain('F-412/26')
    expect(frame.srcdoc).toContain('60.000,00 RSD')
  })
})
