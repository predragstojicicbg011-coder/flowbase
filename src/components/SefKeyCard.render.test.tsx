import React from 'react'
import { render, screen, fireEvent, waitFor } from '@testing-library/react'
import SefSettingsTab from './SefSettingsTab'

// The SEF key card. The database and the edge function are mocked: these are
// about what each role is offered, and that the key never shows.

const KEY = '462d9282-22cf-4d0b-afbe-17411d375a18'

const mockState = {
  status: [] as any[],
  companies: [{ id: 'c1', name: 'Firma doo' }] as any[],
  rpc: jest.fn(),
  invoke: jest.fn(),
}

function mockQuery(table: string) {
  const result = () => {
    if (table === 'feature_flags') return { data: { enabled: false }, error: null }
    if (table === 'companies') return { data: mockState.companies, error: null }
    return { data: [], error: null }
  }
  const q: any = {}
  for (const m of ['select', 'eq', 'order', 'update']) q[m] = () => q
  q.maybeSingle = async () => result()
  q.then = (ok: any, bad: any) => Promise.resolve(result()).then(ok, bad)
  return q
}

jest.mock('../supabase', () => ({
  supabase: {
    from: (t: string) => mockQuery(t),
    rpc: (...args: any[]) => mockState.rpc(...args),
    functions: { invoke: (...args: any[]) => mockState.invoke(...args) },
  },
}))

const configured = [{
  configured: true, environment: 'production', last4: '5a18',
  set_at: '2026-10-18T18:15:00Z', set_by_name: 'Ana', company_id: 'c1', company_name: 'Firma doo',
}]

beforeEach(() => {
  mockState.status = [{ configured: false }]
  mockState.companies = [{ id: 'c1', name: 'Firma doo' }]
  mockState.rpc = jest.fn(async (fn: string) => {
    if (fn === 'sef_key_status') return { data: mockState.status, error: null }
    return { data: null, error: null }
  })
  mockState.invoke = jest.fn()
})

describe('the SEF key card', () => {
  it('shows a member the status only', async () => {
    mockState.status = configured
    render(<SefSettingsTab canEdit={false} canSetKey={false} />)
    expect(await screen.findByText(/Ključ je podešen \(…5a18\), produkcija — postavio Ana, 18\.10\.2026\. 20:15/)).toBeInTheDocument()
    expect(screen.queryByLabelText('SEF API ključ')).not.toBeInTheDocument()
    expect(screen.queryByText('Sačuvaj ključ')).not.toBeInTheDocument()
    expect(screen.queryByText('Proveri vezu')).not.toBeInTheDocument()
    expect(screen.getByText(/API upravljanje/)).toBeInTheDocument()
  })

  it('says when no key is set', async () => {
    render(<SefSettingsTab canEdit={false} canSetKey={false} />)
    expect(await screen.findByText('Ključ nije podešen')).toBeInTheDocument()
  })

  it('lets the administrator save a key, then empties the field and never shows it', async () => {
    render(<SefSettingsTab canEdit canSetKey />)
    await screen.findByText('Ključ nije podešen')
    const input = screen.getByLabelText('SEF API ključ') as HTMLInputElement
    expect(input.type).toBe('password')

    fireEvent.change(screen.getByLabelText('Okruženje'), { target: { value: 'demo' } })
    fireEvent.change(input, { target: { value: KEY } })
    mockState.status = [{ ...configured[0], environment: 'demo' }]
    fireEvent.click(screen.getByText('Sačuvaj ključ'))

    await screen.findByText(/Ključ je sačuvan/)
    expect(mockState.rpc).toHaveBeenCalledWith('sef_set_api_key', { p_api_key: KEY, p_environment: 'demo' })
    await waitFor(() => expect(input.value).toBe(''))
    expect(await screen.findByText(/Ključ je podešen \(…5a18\), demo/)).toBeInTheDocument()
    expect(document.body.textContent).not.toContain(KEY)
    expect(document.body.innerHTML).not.toContain(KEY)
  })

  it('refuses a key that is not a SEF key without calling the database', async () => {
    render(<SefSettingsTab canEdit canSetKey />)
    await screen.findByText('Ključ nije podešen')
    fireEvent.change(screen.getByLabelText('SEF API ključ'), { target: { value: 'nije-kljuc' } })
    fireEvent.click(screen.getByText('Sačuvaj ključ'))
    expect(await screen.findByText(/To ne liči na SEF API ključ/)).toBeInTheDocument()
    expect(mockState.rpc).not.toHaveBeenCalledWith('sef_set_api_key', expect.anything())
  })

  it('asks which company when there are several', async () => {
    mockState.companies = [{ id: 'c1', name: 'Prva doo' }, { id: 'c2', name: 'Druga doo' }]
    render(<SefSettingsTab canEdit canSetKey />)
    await screen.findByLabelText('Firma')
    fireEvent.change(screen.getByLabelText('Firma'), { target: { value: 'c2' } })
    fireEvent.change(screen.getByLabelText('SEF API ključ'), { target: { value: KEY } })
    fireEvent.click(screen.getByText('Sačuvaj ključ'))
    await screen.findByText(/Ključ je sačuvan/)
    expect(mockState.rpc).toHaveBeenCalledWith('sef_set_api_key',
      { p_api_key: KEY, p_environment: 'production', p_company_id: 'c2' })
  })

  it('checks the connection and says how many invoices arrived today', async () => {
    mockState.status = configured
    mockState.invoke = jest.fn(async () => ({ data: { ok: true, environment: 'production', invoices_seen: 4 }, error: null }))
    render(<SefSettingsTab canEdit canSetKey />)
    await screen.findByText(/Ključ je podešen/)
    fireEvent.click(screen.getByText('Proveri vezu'))
    expect(await screen.findByText('Veza sa SEF-om radi. Danas pristiglih faktura: 4.')).toBeInTheDocument()
    expect(mockState.invoke).toHaveBeenCalledWith('sef-check', { body: {} })
  })
})
