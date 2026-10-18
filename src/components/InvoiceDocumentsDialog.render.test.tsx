import React from 'react'
import { render, screen, fireEvent, waitFor } from '@testing-library/react'
import InvoiceDocumentsDialog from './InvoiceDocumentsDialog'

// ─── A Supabase with one invoice, the inbox and its attachments ─────────────
//
// `sef_inbox_mark_imported` is answered by linking the row in `mockTables`, so
// the reload after „Poveži“ reads the invoice as linked — the way the real
// function leaves it.

const mockTables: Record<string, any[]> = {}
const mockRpc: { fn: string; args: any }[] = []
let mockRole = 'accountant'

jest.mock('../contexts/AuthContext', () => ({ useAuth: () => ({ canEdit: mockRole !== 'manager' }) }))

jest.mock('../supabase', () => {
  const builder = (table: string): any => {
    const filters: ((r: any) => boolean)[] = []
    let single = false
    const rows = () => (mockTables[table] || []).filter(r => filters.every(f => f(r)))
    const b: any = {
      select: () => b, order: () => b, limit: () => b,
      eq: (c: string, v: any) => { filters.push(r => r[c] === v); return b },
      is: (c: string, v: any) => { filters.push(r => (r[c] ?? null) === v); return b },
      in: (c: string, v: any[]) => { filters.push(r => v.includes(r[c])); return b },
      single: () => { single = true; return b },
      then: (res: any, rej: any) => Promise.resolve(
        single ? { data: rows()[0] ?? null, error: rows()[0] ? null : { message: 'none' } } : { data: rows(), error: null },
      ).then(res, rej),
    }
    return b
  }
  return {
    supabase: {
      from: (t: string) => builder(t),
      rpc: (fn: string, args: any) => {
        mockRpc.push({ fn, args })
        const row = mockTables.sef_inbox.find(r => r.id === args.p_id)
        Object.assign(row, { state: 'imported', imported_invoice_id: args.p_invoice_id })
        return Promise.resolve({ error: null })
      },
      functions: { invoke: jest.fn() },
      storage: { from: () => ({ createSignedUrl: () => Promise.resolve({ data: { signedUrl: 'https://signed' }, error: null }) }) },
    },
  }
})

const sefRow = (over: any) => ({
  id: 'r1', company_id: 'co', sef_invoice_id: 77, document_number: '2026-0412', supplier_name: 'Beton Plus d.o.o.',
  supplier_vat_number: '100200300', amount: 12000, currency: 'RSD', sent_date: '2026-10-14T08:00:00Z',
  sef_status: 'Seen', state: 'pending', imported_invoice_id: null, ubl_fetched_at: '2026-10-14T09:00:00Z',
  pdf_path: 'co/77.pdf', pdf_kind: 'sef_rendering', pdf_note: null, ...over,
})

beforeEach(() => {
  mockRpc.length = 0
  mockRole = 'accountant'
  for (const k of Object.keys(mockTables)) delete mockTables[k]
  Object.assign(mockTables, {
    invoices: [{
      id: 'inv', company_id: 'co', type: 'expense', invoice_number: '2026/0412', invoice_date: '2026-10-14',
      amount: 12000, currency: 'RSD', partners: { tax_id: '100200300' },
    }],
    sef_inbox: [],
    sef_inbox_attachments: [],
  })
  jest.spyOn(window, 'confirm').mockReturnValue(true)
})

describe('the documents of a booked invoice', () => {
  it('shows the invoice PDF and the supplier’s attachments of a linked invoice', async () => {
    mockTables.sef_inbox.push(sefRow({ state: 'imported', imported_invoice_id: 'inv' }))
    mockTables.sef_inbox_attachments.push({ id: 'a1', inbox_id: 'r1', n: 1, path: 'co/77/prilog-1.pdf', filename: 'otpremnica.pdf', description: null, bytes: 10 })
    render(<InvoiceDocumentsDialog invoiceId="inv" onClose={() => {}} />)
    expect(await screen.findByText('📄 Prikaži račun (PDF)')).toBeInTheDocument()
    expect(screen.getByText('📎 otpremnica.pdf')).toBeInTheDocument()
    expect(screen.getByText(/Status na SEF-u: Pregledana/)).toBeInTheDocument()
  })

  it('pairs a hand-typed invoice with the waiting SEF row, through the database function', async () => {
    mockTables.sef_inbox.push(sefRow({}))
    const onLinked = jest.fn()
    render(<InvoiceDocumentsDialog invoiceId="inv" onClose={() => {}} onLinked={onLinked} />)
    fireEvent.click(await screen.findByText('Poveži'))
    await waitFor(() => expect(mockRpc).toEqual([{ fn: 'sef_inbox_mark_imported', args: { p_id: 'r1', p_invoice_id: 'inv' } }]))
    expect(await screen.findByText('📄 Prikaži račun (PDF)')).toBeInTheDocument()
    expect(onLinked).toHaveBeenCalled()
  })

  it('lets a manager look but not pair', async () => {
    mockRole = 'manager'
    mockTables.sef_inbox.push(sefRow({}))
    render(<InvoiceDocumentsDialog invoiceId="inv" onClose={() => {}} />)
    expect(await screen.findByText(/isti PIB, isti broj, isti iznos/)).toBeInTheDocument()
    expect(screen.queryByText('Poveži')).not.toBeInTheDocument()
  })

  it('says so when nothing in the inbox could be this invoice', async () => {
    mockTables.sef_inbox.push(sefRow({ supplier_vat_number: '999', document_number: '1' }))
    render(<InvoiceDocumentsDialog invoiceId="inv" onClose={() => {}} />)
    expect(await screen.findByText(/nema SEF fakture na čekanju/)).toBeInTheDocument()
  })
})
