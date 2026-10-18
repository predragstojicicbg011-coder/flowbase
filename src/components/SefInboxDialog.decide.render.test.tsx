import React from 'react'
import { render, screen, fireEvent, waitFor } from '@testing-library/react'
import SefInboxDialog from './SefInboxDialog'

// Accepting and rejecting ON SEF from the inbox. The database and the edge
// function are mocked: these are about what the row OFFERS, what it says
// before the click, and what it shows after.

const mockState = {
  rows: [] as any[],
  flagOn: true,
  canEdit: true,
  invoke: jest.fn(),
}

function mockQuery(table: string) {
  const result = () => {
    if (table === 'sef_inbox') return { data: mockState.rows, error: null }
    if (table === 'feature_flags') return { data: { enabled: mockState.flagOn }, error: null }
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
    functions: { invoke: (...args: any[]) => mockState.invoke(...args) },
  },
}))
jest.mock('../contexts/AuthContext', () => ({ useAuth: () => ({ canEdit: mockState.canEdit }) }))
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
  render(<SefInboxDialog onClose={() => {}} onImported={() => {}} />)
  await screen.findByText('Dobavljač doo')
}

beforeEach(() => {
  mockState.rows = [row()]
  mockState.flagOn = true
  mockState.canEdit = true
  mockState.invoke = jest.fn()
})

describe('deciding on SEF from the inbox', () => {
  it('offers both on an opened, undecided invoice', async () => {
    await show()
    expect(screen.getByText('Prihvati na SEF-u')).toBeEnabled()
    expect(screen.getByText('Odbij na SEF-u')).toBeEnabled()
  })

  it('offers neither on an invoice nobody has opened', async () => {
    mockState.rows = [row({ ubl_fetched_at: null })]
    await show()
    expect(screen.queryByText('Prihvati na SEF-u')).not.toBeInTheDocument()
    expect(screen.queryByText('Odbij na SEF-u')).not.toBeInTheDocument()
  })

  it('offers neither to someone who does not keep the books', async () => {
    mockState.canEdit = false
    await show()
    expect(screen.queryByText('Prihvati na SEF-u')).not.toBeInTheDocument()
  })

  it('says, before the click, that the decision goes to SEF and acceptance is final', async () => {
    await show()
    fireEvent.click(screen.getByText('Prihvati na SEF-u'))
    expect(screen.getByText(/upisuje na SEF-u/)).toBeInTheDocument()
    expect(screen.getByText(/Prihvatanje je konačno/)).toBeInTheDocument()
    expect(mockState.invoke).not.toHaveBeenCalled()
  })

  it('accepts, then shows SEF’s status and who decided', async () => {
    mockState.invoke.mockImplementation(async () => {
      mockState.rows = [row({
        sef_decision: 'accepted', sef_status: 'Approved',
        sef_decided_at: '2026-10-18T10:00:00Z', sef_decided_by_name: 'Ana Anić',
      })]
      return { data: { ok: true, decision: 'accepted', sef_status: 'Approved', decided_at: '2026-10-18T10:00:00Z', decided_by_name: 'Ana Anić' }, error: null }
    })
    await show()
    fireEvent.click(screen.getByText('Prihvati na SEF-u'))
    fireEvent.click(screen.getByText('Potvrdi prihvatanje na SEF-u'))
    await screen.findByRole('status')
    expect(mockState.invoke).toHaveBeenCalledTimes(1)
    expect(mockState.invoke).toHaveBeenCalledWith('sef-decide', { body: { inbox_id: 'r1', accepted: true, comment: '' } })
    expect(screen.getByRole('status')).toHaveTextContent(/SEF status: Approved/)
    expect(screen.getByText(/Prihvaćeno na SEF-u .*Ana Anić/)).toBeInTheDocument()
    // Final: nothing more is offered.
    expect(screen.queryByText('Odbij na SEF-u')).not.toBeInTheDocument()
    expect(screen.queryByText('Prihvati na SEF-u')).not.toBeInTheDocument()
  })

  it('will not reject without a reason', async () => {
    mockState.invoke.mockResolvedValue({ data: { ok: true, decision: 'rejected', sef_status: 'Rejected' }, error: null })
    await show()
    fireEvent.click(screen.getByText('Odbij na SEF-u'))
    const confirm = screen.getByText('Potvrdi odbijanje na SEF-u')
    expect(confirm).toBeDisabled()
    fireEvent.change(screen.getByLabelText('Razlog odbijanja na SEF-u'), { target: { value: 'Pogrešan iznos' } })
    expect(confirm).toBeEnabled()
    fireEvent.click(confirm)
    await waitFor(() => expect(mockState.invoke).toHaveBeenCalledWith('sef-decide',
      { body: { inbox_id: 'r1', accepted: false, comment: 'Pogrešan iznos' } }))
  })

  it('shows a rejected invoice as still acceptable, and offers only acceptance', async () => {
    mockState.rows = [row({ sef_decision: 'rejected', sef_decision_comment: 'Pogrešan iznos', sef_status: 'Rejected' })]
    await show()
    expect(screen.getByText(/Odbijeno na SEF-u — može se naknadno prihvatiti/)).toBeInTheDocument()
    expect(screen.getByText('Prihvati na SEF-u')).toBeEnabled()
    expect(screen.queryByText('Odbij na SEF-u')).not.toBeInTheDocument()
  })

  it('disables both and says why while the switch is off', async () => {
    mockState.flagOn = false
    await show()
    expect(screen.getByText('Prihvati na SEF-u')).toBeDisabled()
    expect(screen.getByText('Odbij na SEF-u')).toBeDisabled()
    expect(screen.getByText('Odlučivanje na SEF-u nije uključeno (Podešavanja)')).toBeInTheDocument()
  })

  it('shows a refusal on the row and does not retry', async () => {
    mockState.invoke.mockResolvedValue({
      data: null,
      error: { message: 'x', context: { status: 502, json: async () => ({ code: 'sef_unavailable', error: 'SEF nije dostupan, pokušajte ponovo.' }) } },
    })
    await show()
    fireEvent.click(screen.getByText('Prihvati na SEF-u'))
    fireEvent.click(screen.getByText('Potvrdi prihvatanje na SEF-u'))
    expect(await screen.findByRole('alert')).toHaveTextContent('SEF nije dostupan, pokušajte ponovo.')
    expect(mockState.invoke).toHaveBeenCalledTimes(1)
    // The panel stays open, so trying again is the person's choice.
    expect(screen.getByText('Potvrdi prihvatanje na SEF-u')).toBeInTheDocument()
  })
})
