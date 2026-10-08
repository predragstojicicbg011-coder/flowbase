import React from 'react'
import { fireEvent, render, screen } from '@testing-library/react'
import ProjectSelect, { projectOptions } from './ProjectSelect'
import type { Project } from '../services/projects'

// The component reads the context outside a provider; with `projects` passed
// it never uses what that read returns, but the read must not reach a network.
jest.mock('../supabase', () => {
  const builder: any = {
    select: () => builder, eq: () => builder, order: () => builder,
    range: () => Promise.resolve({ data: [], error: null }),
  }
  return { supabase: { from: () => builder } }
})

const p = (id: string, name: string, over: Partial<Project> = {}): Project => ({
  id, company_id: 'c1', name, code: null, kind: 'construction', investor_partner_id: null,
  contract_value: null, contract_currency: null, contract_date: null,
  contract_value_rsd: null, contract_value_eur: null, payment_days: 45, active: true, note: null, ...over,
})

const projects = [
  p('a', 'Alfa'),
  p('b', 'Beta', { code: 'B1' }),
  p('z', 'Zatvoren', { active: false }),
  p('o', 'Druga firma', { company_id: 'c2' }),
]

describe('projectOptions', () => {
  it('offers the active projects, labelled with their code', () => {
    expect(projectOptions(projects, null)).toEqual([
      { value: 'a', label: 'Alfa' },
      { value: 'b', label: 'B1 · Beta' },
      { value: 'o', label: 'Druga firma' },
    ])
  })

  it('narrows to a company', () => {
    expect(projectOptions(projects, null, 'c1').map(o => o.value)).toEqual(['a', 'b'])
  })

  it('keeps a closed project that is already selected, marked as closed', () => {
    const opts = projectOptions(projects, 'z', 'c1')
    expect(opts[opts.length - 1]).toEqual({ value: 'z', label: 'Zatvoren (zatvoren)' })
  })

  it('does not include overhead — the select pins it as the empty value', () => {
    expect(projectOptions(projects, null).some(o => o.value === '')).toBe(false)
  })
})

describe('<ProjectSelect>', () => {
  it('shows overhead for null and reports the overhead choice as null', () => {
    const onChange = jest.fn()
    render(<ProjectSelect value="a" onChange={onChange} projects={projects} />)
    fireEvent.click(screen.getByRole('combobox'))
    fireEvent.click(screen.getByRole('option', { name: 'Opšti troškovi (bez projekta)' }))
    expect(onChange).toHaveBeenCalledWith(null)
  })

  it('reports a project by its id', () => {
    const onChange = jest.fn()
    render(<ProjectSelect value={null} onChange={onChange} projects={projects} />)
    expect(screen.getByRole('combobox').textContent).toContain('Opšti troškovi (bez projekta)')
    fireEvent.click(screen.getByRole('combobox'))
    fireEvent.click(screen.getByRole('option', { name: 'B1 · Beta' }))
    expect(onChange).toHaveBeenCalledWith('b')
  })

  it('names the selected project when closed', () => {
    render(<ProjectSelect value="b" onChange={() => {}} projects={projects} />)
    expect(screen.getByRole('combobox').textContent).toContain('B1 · Beta')
  })
})
