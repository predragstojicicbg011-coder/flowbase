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
const mockUploads: { bucket: string; path: string }[] = []
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
      insert: (row: any) => { (mockTables[table] ||= []).push({ uploaded_at: '2026-10-19T10:00:00Z', removed_at: null, ...row }); return Promise.resolve({ error: null }) },
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
        if (fn === 'invoice_document_remove') {
          Object.assign(mockTables.invoice_documents.find(d => d.id === args.p_id), { removed_at: 'now' })
          return Promise.resolve({ error: null })
        }
        const row = mockTables.sef_inbox.find(r => r.id === args.p_id)
        Object.assign(row, { state: 'imported', imported_invoice_id: args.p_invoice_id })
        return Promise.resolve({ error: null })
      },
      functions: { invoke: jest.fn() },
      storage: {
        from: (bucket: string) => ({
          createSignedUrl: () => Promise.resolve({ data: { signedUrl: 'https://signed' }, error: null }),
          upload: (path: string) => { mockUploads.push({ bucket, path }); return Promise.resolve({ error: null }) },
        }),
      },
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
  mockUploads.length = 0
  mockRole = 'accountant'
  for (const k of Object.keys(mockTables)) delete mockTables[k]
  Object.assign(mockTables, {
    invoices: [{
      id: 'inv', company_id: 'co', type: 'expense', invoice_number: '2026/0412', invoice_date: '2026-10-14',
      amount: 12000, currency: 'RSD', partners: { tax_id: '100200300' },
    }],
    sef_inbox: [],
    sef_inbox_attachments: [],
    invoice_documents: [],
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

describe('PDFs uploaded by hand', () => {
  const pdfFile = (name: string, head = '%PDF-1.7 ...') => new File([head], name, { type: 'application/pdf' })

  it('uploads the file to the invoice’s folder and records it', async () => {
    render(<InvoiceDocumentsDialog invoiceId="inv" onClose={() => {}} />)
    await screen.findByText('⬆ Otpremi PDF')
    fireEvent.change(screen.getByLabelText('Opis dokumenta'), { target: { value: 'otpremnica' } })
    fireEvent.change(screen.getByLabelText('PDF za otpremanje'), { target: { files: [pdfFile('otpremnica.pdf')] } })
    expect(await screen.findByText(/📄 otpremnica\.pdf — otpremnica/)).toBeInTheDocument()
    expect(mockUploads).toHaveLength(1)
    expect(mockUploads[0].bucket).toBe('invoice-docs')
    expect(mockUploads[0].path).toBe(`co/inv/${mockTables.invoice_documents[0].id}.pdf`)
    expect(mockTables.invoice_documents[0].path).toBe(mockUploads[0].path)
  })

  it('refuses a file that is not a PDF, and uploads nothing', async () => {
    render(<InvoiceDocumentsDialog invoiceId="inv" onClose={() => {}} />)
    await screen.findByText('⬆ Otpremi PDF')
    fireEvent.change(screen.getByLabelText('PDF za otpremanje'), { target: { files: [pdfFile('slika.pdf', 'GIF89a')] } })
    expect(await screen.findByRole('alert')).toHaveTextContent('nije PDF')
    expect(mockUploads).toHaveLength(0)
  })

  it('removes through the database function, which keeps the record', async () => {
    mockTables.invoice_documents.push({ id: 'd1', invoice_id: 'inv', path: 'co/inv/d1.pdf', filename: 'ugovor.pdf', description: null, bytes: 2048, uploaded_at: '2026-10-19T10:00:00Z', removed_at: null })
    render(<InvoiceDocumentsDialog invoiceId="inv" onClose={() => {}} />)
    fireEvent.click(await screen.findByText('Ukloni'))
    await waitFor(() => expect(mockRpc).toEqual([{ fn: 'invoice_document_remove', args: { p_id: 'd1' } }]))
    expect(await screen.findByText('Nema otpremljenih dokumenata.')).toBeInTheDocument()
  })

  it('lets a manager open uploads but not add or remove them', async () => {
    mockRole = 'manager'
    mockTables.invoice_documents.push({ id: 'd1', invoice_id: 'inv', path: 'co/inv/d1.pdf', filename: 'ugovor.pdf', description: null, bytes: 2048, uploaded_at: '2026-10-19T10:00:00Z', removed_at: null })
    render(<InvoiceDocumentsDialog invoiceId="inv" onClose={() => {}} />)
    expect(await screen.findByText(/📄 ugovor\.pdf/)).toBeInTheDocument()
    expect(screen.queryByText('Ukloni')).not.toBeInTheDocument()
    expect(screen.queryByText('⬆ Otpremi PDF')).not.toBeInTheDocument()
  })
})
