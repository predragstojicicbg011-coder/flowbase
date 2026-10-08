import React from 'react'
import { render, screen, fireEvent, waitFor, within } from '@testing-library/react'
import SystemCategoriesTab, { optionsFor } from './SystemCategoriesTab'
import { SYSTEM_ROLES, roleDef, EMPTY_CLASSIFICATION } from '../services/systemCategories'

// ─── A Supabase with the owner's P&L structure and a system_categories table ──
//
// Reads are answered from `mockTables`; an upsert lands in `mockTables` too,
// so the refresh after a save reads back what was written — which is what
// turns the badge from „Nije podešeno“ to „Podešeno“.

const mockTables: Record<string, any[]> = {}
const mockUpserts: { table: string; payload: any; opts: any }[] = []

jest.mock('../supabase', () => {
  const builder = (table: string): any => {
    const filters: [string, any][] = []
    const run = () => Promise.resolve({
      data: (mockTables[table] || []).filter(r => filters.every(([c, v]) => r[c] === v)),
      error: null,
    })
    const b: any = {
      select: () => b,
      order: () => b,
      eq: (c: string, v: any) => { filters.push([c, v]); return b },
      upsert: (payload: any, opts: any) => {
        mockUpserts.push({ table, payload, opts })
        const rows = mockTables[table] || []
        const i = rows.findIndex(r => r.company_id === payload.company_id && r.role === payload.role)
        if (i >= 0) rows[i] = { ...rows[i], ...payload }
        else rows.push({ id: `sc-${rows.length + 1}`, ...payload })
        mockTables[table] = rows
        return Promise.resolve({ error: null })
      },
      then: (res: any, rej: any) => run().then(res, rej),
    }
    return b
  }
  return { supabase: { from: (t: string) => builder(t) } }
})

const COMPANY = 'co-1'

beforeEach(() => {
  mockUpserts.length = 0
  for (const k of Object.keys(mockTables)) delete mockTables[k]
  Object.assign(mockTables, {
    companies: [{ id: COMPANY, name: 'Milinković Company doo' }],
    pl_categories: [
      { id: 'c1', name: 'Zarade', sort_order: 1 },
      { id: 'c2', name: 'Krediti', sort_order: 2 },
      { id: 'c3', name: 'Porezi', sort_order: 3 },
    ],
    pl_subcategories: [
      { id: 's1', name: 'Neto zarade', category_id: 'c1', sort_order: 1 },
      { id: 's2', name: 'Porez na zarade', category_id: 'c1', sort_order: 2 },
      { id: 's3', name: 'Otplata glavnice', category_id: 'c2', sort_order: 1 },
      { id: 's4', name: 'Kamata', category_id: 'c2', sort_order: 2 },
    ],
    departments: [
      { id: 'd1', name: 'Uprava', sort_order: 1 },
      { id: 'd2', name: 'Finansije', sort_order: 2 },
    ],
    dept_subcategories: [
      { id: 'ds1', name: 'Zarade u zemlji', department_id: 'd1', sort_order: 1 },
      { id: 'ds2', name: 'Bankarski krediti', department_id: 'd2', sort_order: 1 },
    ],
    expense_descriptions: [
      { id: 'e1', name: 'Glavnica', dept_subcategory_id: 'ds2', sort_order: 1 },
      { id: 'e2', name: 'Kamata', dept_subcategory_id: 'ds2', sort_order: 2 },
    ],
    system_categories: [
      // Set and valid.
      { id: 'x1', company_id: COMPANY, role: 'payroll_net_salary', pl_category: 'Zarade',
        pl_subcategory: 'Neto zarade', department: null, dept_subcategory: null, expense_description: null },
      // Set, but to a name the owner has since renamed.
      { id: 'x2', company_id: COMPANY, role: 'cashflow_taxes', pl_category: 'Taxes',
        pl_subcategory: null, department: null, dept_subcategory: null, expense_description: null },
    ],
  })
})

const show = async (canEdit = true) => {
  render(<SystemCategoriesTab canEdit={canEdit} />)
  await waitFor(() => expect(screen.getByTestId('role-payroll_net_salary')).toBeInTheDocument())
}

const card = (role: string) => within(screen.getByTestId(`role-${role}`))

describe('Podešavanja → Sistemske kategorije', () => {
  it('lists every role with its Serbian label and what is booked there', async () => {
    await show()
    for (const r of SYSTEM_ROLES) {
      expect(card(r.role).getByText(r.label, { selector: 'div' })).toBeInTheDocument()
      expect(card(r.role).getByText(r.description)).toBeInTheDocument()
    }
    // The three group headers ('Zarade' and 'Krediti' are also category names here).
    expect(screen.getByText('Novčani tok')).toBeInTheDocument()
    expect(screen.getAllByText('Zarade').some(e => e.tagName !== 'OPTION')).toBe(true)
  })

  it('badges a set role, an unset one, and one whose name no longer exists', async () => {
    await show()
    expect(card('payroll_net_salary').getByText('Podešeno')).toBeInTheDocument()
    expect(card('credit_principal').getByText('⚠ Nije podešeno')).toBeInTheDocument()
    expect(card('cashflow_taxes').getByText('⚠ Naziv više ne postoji')).toBeInTheDocument()
    expect(card('cashflow_taxes').getByRole('option', { name: 'Taxes (ne postoji)' })).toBeInTheDocument()
    // Everything but the one valid role.
    expect(screen.getByText(`${SYSTEM_ROLES.length - 1} kategorija još nije podešeno.`)).toBeInTheDocument()
  })

  it('offers only the pickers the role fills', async () => {
    await show()
    expect(card('payroll_net_salary').getAllByRole('combobox')).toHaveLength(2)
    expect(card('credit_principal').getAllByRole('combobox')).toHaveLength(5)
    expect(card('cashflow_banking').getAllByRole('combobox')).toHaveLength(1)
    expect(card('payroll_salary_dept_subcategory').getAllByRole('combobox')).toHaveLength(1)
  })

  it('cascades, and saves the chosen names under the company and role', async () => {
    await show()
    const c = card('credit_principal')
    const pick = (field: string, value: string) =>
      fireEvent.change(c.getByLabelText(`Otplata glavnice kredita — ${field}`), { target: { value } })

    // Nothing to choose under a category until the category is chosen.
    expect(c.getByLabelText('Otplata glavnice kredita — P&L potkategorija').querySelectorAll('option')).toHaveLength(1)
    pick('P&L kategorija', 'Krediti')
    const subs = [...c.getByLabelText('Otplata glavnice kredita — P&L potkategorija').querySelectorAll('option')]
      .map(o => o.textContent)
    expect(subs).toEqual(['— izaberite —', 'Kamata', 'Otplata glavnice'])
    pick('P&L potkategorija', 'Otplata glavnice')
    pick('Sektor', 'Finansije')
    pick('Podsektor', 'Bankarski krediti')
    pick('Opis troška', 'Glavnica')

    fireEvent.click(c.getByText('Sačuvaj'))
    await waitFor(() => expect(mockUpserts).toHaveLength(1))
    expect(mockUpserts[0].table).toBe('system_categories')
    expect(mockUpserts[0].payload).toMatchObject({
      company_id: COMPANY, role: 'credit_principal',
      pl_category: 'Krediti', pl_subcategory: 'Otplata glavnice',
      department: 'Finansije', dept_subcategory: 'Bankarski krediti', expense_description: 'Glavnica',
    })
    await waitFor(() => expect(card('credit_principal').getByText('Podešeno')).toBeInTheDocument())
    expect(screen.getByText('„Otplata glavnice kredita“ je sačuvana.')).toBeInTheDocument()
  })

  it('clears what hangs below a field when the field changes', async () => {
    await show()
    const c = card('payroll_net_salary')
    expect((c.getByLabelText('Neto zarade — P&L potkategorija') as HTMLSelectElement).value).toBe('Neto zarade')
    fireEvent.change(c.getByLabelText('Neto zarade — P&L kategorija'), { target: { value: 'Krediti' } })
    expect((c.getByLabelText('Neto zarade — P&L potkategorija') as HTMLSelectElement).value).toBe('')
  })

  it('refuses to save a role with a field left empty, and writes nothing', async () => {
    await show()
    const c = card('credit_interest')
    fireEvent.change(c.getByLabelText('Kamata na kredit — P&L kategorija'), { target: { value: 'Krediti' } })
    fireEvent.click(c.getByText('Sačuvaj'))
    expect(await screen.findByText(/„Kamata na kredit“: izaberite p&l potkategorija, sektor, podsektor, opis troška\./)).toBeInTheDocument()
    expect(mockUpserts).toHaveLength(0)
  })

  it('is read-only for somebody who may not change settings', async () => {
    await show(false)
    expect(screen.queryByText('Sačuvaj')).not.toBeInTheDocument()
    expect(screen.getByText(/Samo pregled/)).toBeInTheDocument()
    expect((card('payroll_net_salary').getAllByRole('combobox')[0] as HTMLSelectElement).disabled).toBe(true)
  })
})

describe('optionsFor', () => {
  const st = {
    categories: [{ id: 'c1', name: 'Zarade' }],
    subcategories: [{ id: 's1', name: 'Neto', category_id: 'c1' }],
    departments: [{ id: 'd1', name: 'A' }, { id: 'd2', name: 'B' }],
    deptSubcategories: [
      { id: 'x1', name: 'Plate', department_id: 'd1' },
      { id: 'x2', name: 'Plate', department_id: 'd2' },
      { id: 'x3', name: 'Ostalo', department_id: 'd2' },
    ],
    descriptions: [],
  }

  it('offers every podsektor name, once, to a role that does not choose the sector', () => {
    const def = roleDef('payroll_salary_dept_subcategory')
    expect(optionsFor('dept_subcategory', EMPTY_CLASSIFICATION, st, def)).toEqual(['Ostalo', 'Plate'])
  })

  it('offers only the chosen sector\'s podsektori to a role that does', () => {
    const def = roleDef('credit_principal')
    expect(optionsFor('dept_subcategory', { ...EMPTY_CLASSIFICATION, department: 'A' }, st, def)).toEqual(['Plate'])
  })
})
