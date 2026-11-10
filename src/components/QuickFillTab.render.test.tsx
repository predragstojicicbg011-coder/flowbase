import React from 'react'
import { render, screen, fireEvent, waitFor } from '@testing-library/react'
import QuickFillTab from './QuickFillTab'

// A classification template is picked from the chart of accounts, not typed:
// the category, its sub-categories only, and the sector.

const mockState = { inserted: [] as any[], scripts: [] as any[] }

function mockQuery(table: string) {
  const data: Record<string, any[]> = {
    quick_fill_scripts: mockState.scripts,
    pl_categories: [{ id: 'c1', name: 'Bankarske usluge', type: 'expense', sort_order: 1 }, { id: 'c2', name: 'Gorivo', type: 'expense', sort_order: 2 }],
    pl_subcategories: [{ id: 's1', name: 'Provizije', category_id: 'c1', sort_order: 1 }, { id: 's2', name: 'Dizel', category_id: 'c2', sort_order: 1 }],
    departments: [{ id: 'd1', name: 'Uprava', sort_order: 1 }],
  }
  const q: any = {}
  for (const m of ['select', 'eq', 'order', 'in']) q[m] = () => q
  q.insert = (row: any) => { mockState.inserted.push(row); const r: any = {}; r.select = () => Promise.resolve({ data: [{ id: 'n1' }], error: null }); return r }
  q.then = (ok: any, bad: any) => Promise.resolve({ data: data[table] || [], error: null }).then(ok, bad)
  return q
}

jest.mock('../supabase', () => ({ supabase: { from: (t: string) => mockQuery(t) } }))

beforeEach(() => { mockState.inserted = []; mockState.scripts = [] })

const open = async () => {
  render(<QuickFillTab canEdit />)
  fireEvent.click(await screen.findByText('+ Novi šablon'))
}

describe('a new classification template', () => {
  it('picks the category, its own sub-categories and the sector from the chart of accounts', async () => {
    await open()
    const cat = await screen.findByLabelText('P&L kategorija') as HTMLSelectElement
    await waitFor(() => expect([...cat.options].map(o => o.text)).toEqual(['— prazno —', 'Bankarske usluge', 'Gorivo']))
    fireEvent.change(cat, { target: { value: 'Bankarske usluge' } })
    const sub = screen.getByLabelText('Potkategorija') as HTMLSelectElement
    expect([...sub.options].map(o => o.text)).toEqual(['— prazno —', 'Provizije'])
    const dept = screen.getByLabelText('Sektor') as HTMLSelectElement
    expect([...dept.options].map(o => o.text)).toEqual(['— prazno —', 'Uprava'])
  })

  it('saves what was picked, and a new category clears a sub-category that is not its own', async () => {
    await open()
    fireEvent.change(screen.getByPlaceholderText('npr. Bankarska provizija — domaća'), { target: { value: 'Provizija banke' } })
    const cat = await screen.findByLabelText('P&L kategorija') as HTMLSelectElement
    await waitFor(() => expect(cat.options.length).toBe(3))
    fireEvent.change(cat, { target: { value: 'Bankarske usluge' } })
    fireEvent.change(screen.getByLabelText('Potkategorija'), { target: { value: 'Provizije' } })
    fireEvent.change(cat, { target: { value: 'Gorivo' } })
    expect((screen.getByLabelText('Potkategorija') as HTMLSelectElement).value).toBe('')
    fireEvent.change(cat, { target: { value: 'Bankarske usluge' } })
    fireEvent.change(screen.getByLabelText('Potkategorija'), { target: { value: 'Provizije' } })
    fireEvent.change(screen.getByLabelText('Sektor'), { target: { value: 'Uprava' } })
    fireEvent.click(screen.getByText('Sačuvaj'))
    await waitFor(() => expect(mockState.inserted).toHaveLength(1))
    expect(mockState.inserted[0]).toMatchObject({ name: 'Provizija banke', pl_category: 'Bankarske usluge', pl_subcategory: 'Provizije', department: 'Uprava' })
  })

  it('keeps a value a template already names even when it left the chart, marked as such', async () => {
    mockState.scripts = [{ id: 'q1', name: 'Stari', icon: '⚡', pl_category: 'Ukinuta', pl_subcategory: '', department: '', cf_type: '' }]
    render(<QuickFillTab canEdit />)
    await screen.findByText('Stari')
    fireEvent.click(screen.getByText('Izmeni'))
    const cat = await screen.findByLabelText('P&L kategorija') as HTMLSelectElement
    await waitFor(() => expect(cat.value).toBe('Ukinuta'))
    expect([...cat.options].map(o => o.text)).toContain('Ukinuta (nije u kontnom planu)')
  })
})

describe('the icon of a template', () => {
  it('is picked from the set and saved', async () => {
    await open()
    fireEvent.change(screen.getByPlaceholderText('npr. Bankarska provizija — domaća'), { target: { value: 'Gorivo za kamione' } })
    fireEvent.click(screen.getByRole('button', { name: 'Ikonica ⛽' }))
    fireEvent.click(screen.getByText('Sačuvaj'))
    await waitFor(() => expect(mockState.inserted).toHaveLength(1))
    expect(mockState.inserted[0]).toMatchObject({ name: 'Gorivo za kamione', icon: '⛽' })
  })
})
