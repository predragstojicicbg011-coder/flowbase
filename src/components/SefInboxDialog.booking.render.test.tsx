import fs from 'fs'
import path from 'path'
import React from 'react'
import { render, screen, fireEvent, waitFor } from '@testing-library/react'
import SefInboxDialog from './SefInboxDialog'

// Opening an invoice from SEF to book it: the invoice's PDF and the
// supplier's attachments are saved by that very fetch, and the booking dialog
// offers them at once — not only after it is closed and the inbox reloads.

const mockXml = fs.readFileSync(path.join(__dirname, '..', 'services', 'sef', 'fixtures', 'invoice-sample.xml'), 'utf8')

const mockState = {
  rows: [] as any[],
  attachments: [] as any[],
  createSignedUrl: jest.fn(),
}

function mockQuery(table: string) {
  const result = () => {
    if (table === 'sef_inbox') return { data: mockState.rows, error: null }
    if (table === 'sef_inbox_attachments') return { data: mockState.attachments, error: null }
    if (table === 'feature_flags') return { data: { enabled: true }, error: null }
    return { data: [], error: null }
  }
  const q: any = {}
  for (const m of ['select', 'eq', 'is', 'order', 'range', 'limit', 'update', 'in', 'neq', 'gt', 'not']) q[m] = () => q
  q.maybeSingle = async () => ({ data: (result().data as any[])[0] ?? null, error: null })
  q.single = q.maybeSingle
  q.then = (ok: any, bad: any) => Promise.resolve(result()).then(ok, bad)
  return q
}

jest.mock('../supabase', () => ({
  supabase: {
    from: (t: string) => mockQuery(t),
    rpc: () => Promise.resolve({ data: [{ date_from: '1900-01-01' }], error: null }),
    functions: {
      invoke: async (name: string) => {
        if (name !== 'sef-fetch-invoice') return { data: null, error: { message: 'no' } }
        // The fetch saves the PDF and the attachments, as the edge function does.
        mockState.rows = mockState.rows.map(r => ({ ...r, ubl_fetched_at: '2026-10-21T08:00:00Z', ubl_xml: mockXml, pdf_path: 'c/101.pdf', pdf_kind: 'sef_rendering' }))
        mockState.attachments = [{ id: 'a1', inbox_id: 'r1', n: 1, path: 'c/101/prilog-1.pdf', filename: 'OTP-1', description: 'Otpremnica', bytes: 100 }]
        return { data: { ubl_xml: mockXml }, error: null }
      },
    },
    storage: { from: () => ({ createSignedUrl: (...args: any[]) => mockState.createSignedUrl(...args) }) },
  },
}))
jest.mock('../contexts/AuthContext', () => ({ useAuth: () => ({ canEdit: true }) }))
jest.mock('./PartnerDialog', () => () => null)
jest.mock('./InvoiceDialog', () => (p: any) => (
  <div data-testid="booking">
    {(p.sourceDocuments || []).map((d: any) => <button key={d.label} onClick={d.open}>{d.label}</button>)}
  </div>
))
jest.mock('../services/bookAmounts', () => ({
  ...jest.requireActual('../services/bookAmounts'),
  getBookRates: async () => { throw new Error('no rate in tests') },
}))

const row = {
  id: 'r1', sef_invoice_id: 473450675, document_number: 'F-1', document_type: 'Invoice',
  supplier_name: 'Dobavljač doo', supplier_vat_number: '100000004', supplier_registration_number: null,
  amount: 1200, currency: 'RSD', delivery_date: '2026-10-01', due_date: '2026-10-15',
  sent_date: '2026-10-02T10:00:00Z', sef_status: 'New', state: 'pending',
  dismiss_reason: null, dismissed_at: null, imported_at: null,
  ubl_fetched_at: null, pdf_path: null, pdf_kind: null, pdf_note: null,
  sef_decision: null, sef_decision_comment: null, sef_decided_at: null, sef_decided_by_name: null,
}

let openSpy: jest.SpyInstance
beforeEach(() => {
  mockState.rows = [row]
  mockState.attachments = []
  mockState.createSignedUrl = jest.fn(async () => ({ data: { signedUrl: 'https://x/signed' }, error: null }))
  openSpy = jest.spyOn(window, 'open').mockImplementation(() => ({ opener: {}, location: { href: '' }, close: jest.fn() }) as any)
})
afterEach(() => openSpy.mockRestore())

describe('booking from SEF', () => {
  it('offers the invoice PDF and the attachments in the booking dialog straight away', async () => {
    render(<SefInboxDialog onClose={() => {}} onImported={() => {}} />)
    fireEvent.click(await screen.findByText('Otvori i proknjiži'))
    const booking = await screen.findByTestId('booking')
    await waitFor(() => expect(booking.textContent).toContain('Račun (SEF)'))
    expect(booking.textContent).toContain('OTP-1')
    fireEvent.click(screen.getByText('Račun (SEF)'))
    await waitFor(() => expect(mockState.createSignedUrl).toHaveBeenCalledWith('c/101.pdf', 600))
  })
})
