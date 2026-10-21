import React from 'react'
import { render, screen, fireEvent, waitFor } from '@testing-library/react'
import SefInboxDialog from './SefInboxDialog'

// The invoice's PDF and the supplier's attachments in the inbox, and the
// repair for rows that kept an attachment as their PDF. The database, the
// storage and the edge function are mocked.

const mockState = {
  rows: [] as any[],
  attachments: [] as any[],
  canEdit: true,
  invoke: jest.fn(),
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
    storage: { from: () => ({ createSignedUrl: (...args: any[]) => mockState.createSignedUrl(...args) }) },
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
  ubl_fetched_at: '2026-10-03T08:00:00Z', pdf_path: 'c/101.pdf', pdf_kind: 'sef_rendering', pdf_note: null,
  sef_decision: null, sef_decision_comment: null, sef_decided_at: null, sef_decided_by_name: null,
  ...over,
})

const attachment = (n: number, over: Record<string, unknown> = {}) => ({
  id: `a${n}`, inbox_id: 'r1', n, path: `c/101/prilog-${n}.pdf`, filename: `OTP-${n}`,
  description: 'Otpremnica', bytes: 100, ...over,
})

const show = async () => {
  render(<SefInboxDialog onClose={() => {}} onImported={() => {}} />)
  await screen.findByText('Dobavljač doo')
}

let openSpy: jest.SpyInstance
beforeEach(() => {
  mockState.rows = [row()]
  mockState.attachments = []
  mockState.canEdit = true
  mockState.invoke = jest.fn()
  mockState.createSignedUrl = jest.fn(async () => ({ data: { signedUrl: 'https://x/signed' }, error: null }))
  openSpy = jest.spyOn(window, 'open').mockImplementation(() => ({ opener: {}, location: { href: '' }, close: jest.fn() }) as any)
})
afterEach(() => openSpy.mockRestore())

describe('the invoice first, the attachments beside it', () => {
  it('shows the invoice and opens it through a ten-minute link', async () => {
    await show()
    fireEvent.click(screen.getByText('Prikaži fakturu'))
    await waitFor(() => expect(mockState.createSignedUrl).toHaveBeenCalledWith('c/101.pdf', 600))
    expect(screen.queryByText(/^Prilozi/)).not.toBeInTheDocument()
    expect(screen.queryByText('Preuzmi račun sa SEF-a')).not.toBeInTheDocument()
  })

  it('lists the attachments and opens each by its own path', async () => {
    mockState.attachments = [attachment(2, { filename: null, description: null }), attachment(1)]
    await show()
    fireEvent.click(screen.getByText('Prilozi (2)'))
    const list = screen.getByRole('list', { name: 'Prilozi dobavljača' })
    const items = list.querySelectorAll('li')
    expect(items[0]).toHaveTextContent('OTP-1 — Otpremnica')
    expect(items[1]).toHaveTextContent('Prilog 2')
    fireEvent.click(screen.getByText('Prilog 2'))
    await waitFor(() => expect(mockState.createSignedUrl).toHaveBeenCalledWith('c/101/prilog-2.pdf', 600))
  })
})

describe('repairing a row that kept the supplier’s attachment', () => {
  it('offers the repair and says the SEF status does not change', async () => {
    mockState.rows = [row({ pdf_kind: 'supplier_attachment' })]
    await show()
    expect(screen.getByText('Preuzmi račun sa SEF-a')).toBeEnabled()
    expect(screen.getByText(/status na SEF-u se ne menja/)).toBeInTheDocument()
  })

  it('is not offered for an invoice still New on SEF', async () => {
    mockState.rows = [row({ pdf_kind: 'supplier_attachment', sef_status: 'New' })]
    await show()
    expect(screen.queryByText('Preuzmi račun sa SEF-a')).not.toBeInTheDocument()
  })

  it('is not offered to someone who does not keep the books', async () => {
    mockState.canEdit = false
    mockState.rows = [row({ pdf_kind: 'supplier_attachment' })]
    await show()
    expect(screen.queryByText('Preuzmi račun sa SEF-a')).not.toBeInTheDocument()
    expect(screen.getByText('Prikaži fakturu')).toBeInTheDocument()
  })

  it('asks the function once for the PDFs only, then shows the invoice', async () => {
    mockState.rows = [row({ pdf_kind: 'supplier_attachment' })]
    mockState.invoke.mockImplementation(async () => {
      mockState.rows = [row({ pdf_kind: 'sef_rendering', pdf_note: 'Ponovo preuzeto sa SEF-a radi računa (umesto priloga)' })]
      mockState.attachments = [attachment(1)]
      return { data: { refetched: true, pdf_path: 'c/101.pdf', pdf_kind: 'sef_rendering', attachments: 1 }, error: null }
    })
    await show()
    fireEvent.click(screen.getByText('Preuzmi račun sa SEF-a'))
    await screen.findByRole('status')
    expect(mockState.invoke).toHaveBeenCalledTimes(1)
    expect(mockState.invoke).toHaveBeenCalledWith('sef-fetch-invoice', { body: { inbox_id: 'r1', refetch_pdf: true } })
    expect(screen.getByRole('status')).toHaveTextContent(/Status na SEF-u se nije promenio/)
    expect(screen.getByText('Ponovo preuzeto sa SEF-a radi računa (umesto priloga)')).toBeInTheDocument()
    expect(screen.getByText('Prilozi (1)')).toBeInTheDocument()
    expect(screen.queryByText('Preuzmi račun sa SEF-a')).not.toBeInTheDocument()
  })

  it('shows the function’s refusal on the row', async () => {
    mockState.rows = [row({ pdf_kind: 'supplier_attachment' })]
    mockState.invoke.mockResolvedValue({
      data: null,
      error: { message: 'non-2xx', context: { json: async () => ({ error: 'SEF answered 500' }) } },
    })
    await show()
    fireEvent.click(screen.getByText('Preuzmi račun sa SEF-a'))
    expect(await screen.findByRole('alert')).toHaveTextContent('SEF answered 500')
  })
})

describe('the PDF and attachments of a waiting invoice, as soon as it is listed', () => {
  const unopened = (over: Record<string, unknown> = {}) => row({ ubl_fetched_at: null, pdf_path: null, pdf_kind: null, sef_status: 'Approved', ...over })

  it('fetches them by itself for an invoice SEF has already seen, and shows them on the row', async () => {
    mockState.rows = [unopened()]
    mockState.invoke.mockImplementation(async () => {
      mockState.rows = [row({ sef_status: 'Approved' })]
      mockState.attachments = [attachment(1)]
      return { data: { ubl_xml: '<x/>', pdf_path: 'c/101.pdf', attachments: 1 }, error: null }
    })
    await show()
    expect(await screen.findByText('Prikaži fakturu')).toBeInTheDocument()
    expect(screen.getByText('Prilozi (1)')).toBeInTheDocument()
    expect(mockState.invoke).toHaveBeenCalledTimes(1)
    expect(mockState.invoke).toHaveBeenCalledWith('sef-fetch-invoice', { body: { id: 'r1' } })
  })

  it('never fetches a New one by itself: it offers it, and asks first', async () => {
    mockState.rows = [unopened({ sef_status: 'New' })]
    const confirm = jest.spyOn(window, 'confirm').mockReturnValue(false)
    await show()
    fireEvent.click(screen.getByText('Preuzmi PDF i priloge'))
    expect(confirm).toHaveBeenCalled()
    expect(mockState.invoke).not.toHaveBeenCalled()
    await waitFor(() => expect(screen.getByText('Preuzmi PDF i priloge')).toBeEnabled())
    confirm.mockReturnValue(true)
    mockState.invoke.mockImplementation(async () => {
      mockState.rows = [row({ sef_status: 'Seen' })]
      return { data: { ubl_xml: '<x/>', pdf_path: 'c/101.pdf', attachments: 0 }, error: null }
    })
    fireEvent.click(screen.getByText('Preuzmi PDF i priloge'))
    expect(await screen.findByText('Prikaži fakturu')).toBeInTheDocument()
    expect(mockState.invoke).toHaveBeenCalledTimes(1)
    confirm.mockRestore()
  })

  it('fetches nothing for someone who does not keep the books', async () => {
    mockState.canEdit = false
    mockState.rows = [unopened()]
    await show()
    await new Promise(r => setTimeout(r, 20))
    expect(mockState.invoke).not.toHaveBeenCalled()
  })

  it('says on the row why a fetch failed', async () => {
    mockState.rows = [unopened()]
    mockState.invoke.mockResolvedValue({ data: { error: 'SEF could not be reached: timeout' }, error: null })
    await show()
    expect(await screen.findByText(/Za 1 fakturu PDF nije preuzet: SEF could not be reached: timeout/)).toBeInTheDocument()
  })
})
