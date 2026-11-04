import React from 'react'
import { render, screen, fireEvent, waitFor, act } from '@testing-library/react'
import InvoiceDialog from './InvoiceDialog'

// Deleting an existing revenue invoice: the confirmation lists what will
// happen before anything is deleted, then one database call does it. The
// database is mocked.

const mockState = {
  canEdit: true,
  rpc: [] as { name: string; args: any }[],
  rpcError: null as null | { message: string },
}

const preview = {
  invoice_number: 'IF-12/2026', type: 'revenue', payments_unlinked: 2, advance_links_removed: 0,
  finals_reopened: [], notes_deleted: ['KO-1/2026'], uploads_removed: 1, sef_row: 'pending',
}

function mockQuery() {
  const q: any = {}
  for (const m of ['select', 'eq', 'neq', 'is', 'in', 'gt', 'order', 'range', 'limit']) q[m] = () => q
  q.maybeSingle = async () => ({ data: null, error: null })
  q.single = async () => ({ data: null, error: null })
  q.then = (ok: any, bad: any) => Promise.resolve({ data: [], error: null }).then(ok, bad)
  return q
}

jest.mock('../supabase', () => ({
  supabase: {
    from: () => mockQuery(),
    rpc: (name: string, args: any) => {
      mockState.rpc.push({ name, args })
      if (name !== 'delete_invoice_cascade') return Promise.resolve({ data: null, error: null })
      if (!args.p_dry_run && mockState.rpcError) return Promise.resolve({ data: null, error: mockState.rpcError })
      return Promise.resolve({ data: preview, error: null })
    },
  },
}))
jest.mock('../contexts/AuthContext', () => ({ useAuth: () => ({ user: null, canEdit: mockState.canEdit }) }))
jest.mock('../contexts/CompaniesContext', () => ({
  useCompanies: () => ({
    companies: [{ id: 'co1', name: 'Firma', currencies: ['RSD', 'EUR'] }],
    defaultCompany: { id: 'co1', name: 'Firma' },
    showPicker: false,
  }),
}))
jest.mock('../contexts/ProjectsContext', () => ({ useProjects: () => ({ projects: [] }) }))
jest.mock('../services/allPartners', () => ({
  fetchAllPartners: async () => [{ id: 'k1', name: 'Zakupac Market' }],
}))
jest.mock('../services/quickFillStore', () => ({
  fetchScripts: async () => [], saveScript: async () => ({}), whyNotSavable: () => null,
}))
jest.mock('../services/saveSplits', () => ({
  loadSplits: async () => [],
  saveSplits: async () => ({ ok: true, lines: 0, message: '' }),
}))
jest.mock('./SplitEditor', () => () => null)
jest.mock('./ProjectSelect', () => () => null)
jest.mock('./PartnerDialog', () => () => null)

const existing = (over: Record<string, unknown> = {}) => ({
  id: 'inv1', company_id: 'co1', partner_id: 'k1', partners: { name: 'Zakupac Market' }, type: 'revenue',
  invoice_number: 'IF-12/2026', invoice_date: '2026-10-31', currency: 'RSD', amount: 120000,
  exchange_rate: 1, eur_rate: 117.2, revenue_stream: 'Ostalo',
  ...over,
})

/** Renders and lets the dialog finish loading, so nothing updates after the test. */
const open = async (invoice: any, onClose: () => void = () => {}) => {
  let r: ReturnType<typeof render>
  await act(async () => { r = render(<InvoiceDialog onClose={onClose} invoice={invoice} />) })
  return r!
}

const deleteButton = () => screen.queryByText('Obriši fakturu i sve vezano')

beforeEach(() => {
  mockState.canEdit = true
  mockState.rpc = []
  mockState.rpcError = null
})

describe('deleting a revenue invoice', () => {
  it('lists what deleting will do before it deletes', async () => {
    await open(existing())
    fireEvent.click(deleteButton()!)
    expect(await screen.findByText('Veze sa 2 uplate se raskidaju; uplate ostaju na izvodu, nepovezane.')).toBeTruthy()
    expect(screen.getByText('Briše se i knjižno odobrenje KO-1/2026.')).toBeTruthy()
    expect(screen.getByText('Ručno otpremljeni PDF-ovi se sklanjaju (1).')).toBeTruthy()
    expect(screen.getByText('SEF red se vraća u red „čeka“.')).toBeTruthy()
    expect(mockState.rpc).toEqual([{ name: 'delete_invoice_cascade', args: { p_invoice: 'inv1', p_dry_run: true } }])
    // Cancelling changes nothing.
    fireEvent.click(screen.getByText('Odustani'))
    expect(screen.queryByTestId('delete-panel')).toBeNull()
    expect(mockState.rpc).toHaveLength(1)
  })

  it('deletes through one database call and closes', async () => {
    const onClose = jest.fn()
    await open(existing(), onClose)
    fireEvent.click(deleteButton()!)
    fireEvent.click(await screen.findByText('Obriši'))
    await waitFor(() => expect(onClose).toHaveBeenCalledTimes(1))
    expect(mockState.rpc.filter(c => !c.args.p_dry_run)).toEqual([
      { name: 'delete_invoice_cascade', args: { p_invoice: 'inv1', p_dry_run: false } },
    ])
  })

  it('shows the database refusal and stays open', async () => {
    mockState.rpcError = { message: 'Period je zaključan' }
    const onClose = jest.fn()
    await open(existing(), onClose)
    fireEvent.click(deleteButton()!)
    fireEvent.click(await screen.findByText('Obriši'))
    expect(await screen.findByText('Period je zaključan')).toBeTruthy()
    expect(onClose).not.toHaveBeenCalled()
  })

  it('does not offer deleting a supplier invoice or to someone who does not keep the books', async () => {
    const { unmount } = await open(existing({ type: 'expense' }))
    expect(deleteButton()).toBeNull()
    unmount()
    mockState.canEdit = false
    const second = await open(existing())
    expect(deleteButton()).toBeNull()
    second.unmount()
    mockState.canEdit = true
    await open({ ...existing(), id: undefined })
    expect(deleteButton()).toBeNull()
  })
})
