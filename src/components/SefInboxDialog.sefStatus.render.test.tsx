import React from 'react'
import { render, screen, within } from '@testing-library/react'
import SefInboxDialog from './SefInboxDialog'

// The SEF status of each inbox row, shown as a worded badge beside the
// supplier. The database is mocked; nothing here calls SEF.

const mockState = { rows: [] as any[] }

function mockQuery(table: string) {
  const result = () => {
    if (table === 'sef_inbox') return { data: mockState.rows, error: null }
    if (table === 'feature_flags') return { data: { enabled: true }, error: null }
    return { data: [], error: null }
  }
  const q: any = {}
  for (const m of ['select', 'eq', 'is', 'order', 'range', 'limit', 'update', 'in']) q[m] = () => q
  q.maybeSingle = async () => result()
  q.single = async () => result()
  q.then = (ok: any, bad: any) => Promise.resolve(result()).then(ok, bad)
  return q
}

jest.mock('../supabase', () => ({
  supabase: {
    from: (t: string) => mockQuery(t),
    rpc: () => Promise.resolve({ data: [{ date_from: '1900-01-01' }], error: null }),
    functions: { invoke: jest.fn() },
  },
}))
jest.mock('../contexts/AuthContext', () => ({ useAuth: () => ({ canEdit: true }) }))
jest.mock('./InvoiceDialog', () => () => null)
jest.mock('./PartnerDialog', () => () => null)

const row = (over: Record<string, unknown> = {}) => ({
  id: 'r1', sef_invoice_id: 101, document_number: 'F-1', document_type: 'Invoice',
  supplier_name: 'Dobavljač doo', supplier_vat_number: '100000001', supplier_registration_number: null,
  amount: 1200, currency: 'RSD', delivery_date: '2026-10-01', due_date: '2026-10-15',
  sent_date: '2026-10-02T10:00:00Z', sef_status: 'Seen', state: 'pending',
  dismiss_reason: null, dismissed_at: null, imported_at: null,
  ubl_fetched_at: '2026-10-03T08:00:00Z', pdf_path: null,
  sef_decision: null, sef_decision_comment: null, sef_decided_at: null, sef_decided_by_name: null,
  ...over,
})

const show = async () => {
  const { container } = render(<SefInboxDialog onClose={() => {}} onImported={() => {}} />)
  await screen.findByText('Dobavljač doo')
  return container
}
const badgeOf = (c: HTMLElement) => c.querySelector('[data-row="r1"] [data-sef-status]') as HTMLElement | null

describe('the SEF status badge on an inbox row', () => {
  it.each([
    ['New', 'Nova'], ['Seen', 'Pregledana'], ['ReNotified', 'Ponovo obaveštena'], ['Approved', 'Odobrena'],
    ['Rejected', 'Odbijena'], ['Cancelled', 'Otkazana'], ['Storno', 'Stornirana'],
  ])('shows %s as %s next to the supplier', async (raw, word) => {
    mockState.rows = [row({ sef_status: raw })]
    const c = await show()
    expect(badgeOf(c)).toHaveTextContent(word)
    // The badge sits on the supplier line, and the word is written once there.
    expect(within(c.querySelector('[data-row="r1"]') as HTMLElement).getAllByText(word)).toHaveLength(1)
  })

  it('no longer prints the raw status in the third line', async () => {
    mockState.rows = [row({ sef_status: 'Seen' })]
    const c = await show()
    expect(c.textContent).not.toMatch(/SEF status/)
    expect(screen.getByText(/Dospeva/)).toBeInTheDocument()
  })

  it('shows no badge, and no dash, when SEF has not given a status yet', async () => {
    mockState.rows = [row({ sef_status: null })]
    const c = await show()
    expect(badgeOf(c)).toBeNull()
    expect(c.textContent).not.toMatch(/SEF status/)
  })

  it('shows a status SEF adds later as received', async () => {
    mockState.rows = [row({ sef_status: 'Quarantined' })]
    const c = await show()
    expect(badgeOf(c)).toHaveTextContent('Quarantined')
  })

  it('reads spaces and case loosely', async () => {
    mockState.rows = [row({ sef_status: '  SEEN ' })]
    const c = await show()
    expect(badgeOf(c)).toHaveTextContent('Pregledana')
  })

  it('says the word, not the raw value, on a decided row', async () => {
    mockState.rows = [row({ sef_status: 'Approved', sef_decision: 'accepted' })]
    await show()
    expect(screen.getByText(/Prihvaćeno na SEF-u.*SEF status Odobrena/)).toBeInTheDocument()
    expect(screen.queryByText(/Approved/)).not.toBeInTheDocument()
  })
})
