import fs from 'fs'
import path from 'path'
import React from 'react'
import { render, screen, fireEvent } from '@testing-library/react'
import SefInboxDialog from './SefInboxDialog'

// A booking raced by a link: the invoice is saved in the books, but meanwhile
// somebody linked the row to a credit instalment, so `sef_inbox_mark_imported`
// refuses it. The person is told the interest is now booked twice and what to
// delete. Invented supplier and figures.

const mockXml = fs.readFileSync(path.join(__dirname, '..', 'services', 'sef', 'fixtures', 'invoice-sample.xml'), 'utf8')

const mockState = {
  rows: [] as any[],
  // What the row reads when it is asked again, after the refusal.
  stateAfter: 'linked',
}

function mockQuery(table: string) {
  const result = () => {
    if (table === 'sef_inbox') return { data: mockState.rows, error: null }
    if (table === 'feature_flags') return { data: { enabled: true }, error: null }
    return { data: [], error: null }
  }
  const q: any = {}
  let asksState = false
  for (const m of ['eq', 'is', 'order', 'range', 'limit', 'update', 'in', 'neq', 'gt', 'not']) q[m] = () => q
  q.select = (cols: string) => { asksState = cols === 'state'; return q }
  q.maybeSingle = async () => (asksState
    ? { data: { state: mockState.stateAfter }, error: null }
    : { data: (result().data as any[])[0] ?? null, error: null })
  q.single = q.maybeSingle
  q.then = (ok: any, bad: any) => Promise.resolve(result()).then(ok, bad)
  return q
}

jest.mock('../supabase', () => ({
  supabase: {
    from: (t: string) => mockQuery(t),
    rpc: (fn: string) => Promise.resolve(fn === 'sef_inbox_mark_imported'
      ? { data: null, error: { message: 'That row is not waiting to be booked — it is already decided, or already linked to an invoice.' } }
      : { data: [{ date_from: '1900-01-01' }], error: null }),
    functions: {
      invoke: async () => {
        mockState.rows = mockState.rows.map(r => ({ ...r, ubl_fetched_at: '2026-10-21T08:00:00Z' }))
        return { data: { ubl_xml: mockXml }, error: null }
      },
    },
    storage: { from: () => ({ createSignedUrl: async () => ({ data: null, error: null }) }) },
  },
}))
jest.mock('../contexts/AuthContext', () => ({ useAuth: () => ({ canEdit: true }) }))
jest.mock('./PartnerDialog', () => () => null)
// The booking dialog saves at once and reports the new invoice.
jest.mock('./InvoiceDialog', () => (p: any) => <button onClick={() => p.onSaved('inv-new')}>Sačuvaj fakturu</button>)
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

beforeEach(() => {
  mockState.rows = [row]
  mockState.stateAfter = 'linked'
})

const bookAndSave = async () => {
  render(<SefInboxDialog onClose={() => {}} onImported={() => {}} />)
  fireEvent.click(await screen.findByText('Otvori i proknjiži'))
  fireEvent.click(await screen.findByText('Sačuvaj fakturu'))
  return screen.findByRole('alert')
}

describe('a booking raced by a link to a credit instalment', () => {
  it('says the row was linked meanwhile, and that the invoice just saved should be deleted', async () => {
    const alert = await bookAndSave()
    expect(alert.textContent).toBe(
      'Faktura je sačuvana u knjigama, ali je ovaj red SEF sandučeta u međuvremenu povezan sa ratom kredita, '
      + 'pa nije označen kao proknjižen. Kamata je već u knjigama sa otplatom rate: obrišite upravo sačuvanu '
      + 'fakturu, inače je kamata proknjižena dvaput.')
  })

  it('keeps the general sentence for any other refusal', async () => {
    mockState.stateAfter = 'imported'
    const alert = await bookAndSave()
    expect(alert.textContent).toMatch(/^The invoice was saved, but this row could not be marked as booked: /)
  })
})
