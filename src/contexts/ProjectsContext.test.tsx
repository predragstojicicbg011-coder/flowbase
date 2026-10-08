import React from 'react'
import { render, screen, waitFor } from '@testing-library/react'
import { ProjectsProvider, useProjects } from './ProjectsContext'

// What the table holds, set per test. A read resolves `{ data, error }`
// the way PostgREST does, never a throw.
const mockTable: { rows: any[]; error: string | null; reads: number } = { rows: [], error: null, reads: 0 }
;(global as any).__projectsMock = mockTable

jest.mock('../supabase', () => {
  const state = () => (global as any).__projectsMock
  const builder: any = {
    select: () => builder,
    eq: () => builder,
    order: () => builder,
    range: () => {
      state().reads++
      const s = state()
      return Promise.resolve(s.error
        ? { data: null, error: { message: s.error } }
        : { data: s.rows, error: null })
    },
  }
  return { supabase: { from: () => builder } }
})

jest.mock('./AuthContext', () => ({ useAuth: () => ({ user: { id: 'u1' } }) }))

beforeEach(() => {
  mockTable.rows = []
  mockTable.error = null
  mockTable.reads = 0
})

function Probe() {
  const { projects, activeProjects, loading, error } = useProjects()
  if (loading) return <div>loading</div>
  return (
    <div>
      <span data-testid="all">{projects.map(p => p.name).join(',')}</span>
      <span data-testid="active">{activeProjects.map(p => p.name).join(',')}</span>
      <span data-testid="error">{error ?? ''}</span>
    </div>
  )
}

describe('useProjects', () => {
  it('lists every project and offers only the active ones', async () => {
    mockTable.rows = [
      { id: 'a', company_id: 'c', name: 'Alfa', kind: 'construction', active: true },
      { id: 'b', company_id: 'c', name: 'Beta', kind: 'rental', active: false },
    ]
    render(<Probe />)
    await waitFor(() => expect(screen.getByTestId('all').textContent).toBe('Alfa,Beta'))
    expect(screen.getByTestId('active').textContent).toBe('Alfa')
  })

  it('says why when the read fails, instead of looking like no projects', async () => {
    mockTable.error = 'permission denied'
    render(<Probe />)
    await waitFor(() => expect(screen.getByTestId('error').textContent).toBe('Projekti nisu učitani: permission denied'))
    expect(screen.getByTestId('all').textContent).toBe('')
  })

  it('reads the table once for every component under the provider', async () => {
    mockTable.rows = [{ id: 'a', company_id: 'c', name: 'Alfa', kind: 'construction', active: true }]
    const Name = () => <span>{useProjects().projects[0]?.name ?? '…'}</span>
    render(<ProjectsProvider><Name /><Name /><Name /></ProjectsProvider>)
    await waitFor(() => expect(screen.getAllByText('Alfa')).toHaveLength(3))
    expect(mockTable.reads).toBe(1)
  })
})
