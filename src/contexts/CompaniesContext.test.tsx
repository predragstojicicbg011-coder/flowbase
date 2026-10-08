import React from 'react'
import { render, screen, waitFor } from '@testing-library/react'
import { CompaniesProvider, useCompanies } from './CompaniesContext'

// What the table holds, set per test. `then` resolves it the way a PostgREST
// read does: `{ data, error }`, never a throw.
const mockTable: { rows: any[]; error: string | null; reads: number } = { rows: [], error: null, reads: 0 }
;(global as any).__companiesMock = mockTable

jest.mock('../supabase', () => {
  const state = () => (global as any).__companiesMock
  const builder: any = {
    select: () => builder,
    order: () => builder,
    then: (f: any) => {
      state().reads++
      const s = state()
      return Promise.resolve(s.error
        ? { data: null, error: { message: s.error } }
        : { data: s.rows, error: null }).then(f)
    },
  }
  return { supabase: { from: () => builder } }
})

// A signed-in user, which is what makes the provider load.
jest.mock('./AuthContext', () => ({ useAuth: () => ({ user: { id: 'u1' } }) }))

beforeEach(() => {
  mockTable.rows = []
  mockTable.error = null
  mockTable.reads = 0
})

/** Prints what the hook says, so the test reads the same thing a page would. */
function Probe() {
  const { companies, defaultCompany, showPicker, loading, error } = useCompanies()
  if (loading) return <div>loading</div>
  return (
    <div>
      <span data-testid="count">{companies.length}</span>
      <span data-testid="default">{defaultCompany?.name ?? 'none'}</span>
      <span data-testid="picker">{showPicker ? 'picker' : 'no picker'}</span>
      <span data-testid="error">{error ?? ''}</span>
    </div>
  )
}

describe('useCompanies outside the provider', () => {
  it('picks the one company and shows no picker', async () => {
    mockTable.rows = [{ id: 'm', name: 'Milinković Company doo' }]
    render(<Probe />)
    await waitFor(() => expect(screen.getByTestId('default').textContent).toBe('Milinković Company doo'))
    expect(screen.getByTestId('picker').textContent).toBe('no picker')
  })

  it('shows the picker once there are two', async () => {
    mockTable.rows = [{ id: 'a', name: 'Alpha d.o.o.' }, { id: 'b', name: 'Beta d.o.o.' }]
    render(<Probe />)
    await waitFor(() => expect(screen.getByTestId('picker').textContent).toBe('picker'))
    expect(screen.getByTestId('default').textContent).toBe('Alpha d.o.o.')
  })

  it('says why when the read fails, instead of looking like no companies', async () => {
    mockTable.error = 'permission denied'
    render(<Probe />)
    await waitFor(() => expect(screen.getByTestId('error').textContent).toBe('permission denied'))
    expect(screen.getByTestId('count').textContent).toBe('0')
    expect(screen.getByTestId('default').textContent).toBe('none')
  })
})

describe('useCompanies inside the provider', () => {
  it('reads the table once for every component under it', async () => {
    mockTable.rows = [{ id: 'm', name: 'Milinković Company doo' }]
    const Name = () => <span>{useCompanies().defaultCompany?.name ?? '…'}</span>
    render(<CompaniesProvider><Name /><Name /><Name /></CompaniesProvider>)
    await waitFor(() => expect(screen.getAllByText('Milinković Company doo')).toHaveLength(3))
    expect(mockTable.reads).toBe(1)
  })
})
