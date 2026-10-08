import React from 'react'
import { render, screen, fireEvent } from '@testing-library/react'
import { ContractsTab } from './EmployeeDialog'
import type { EmployeeRow, ContractRow } from '../services/payroll/employees'

// The writes go through the real client, and nothing here saves — these are
// about what the form OFFERS and what it says before anybody presses a button.
jest.mock('../supabase', () => ({ supabase: {} }))

const employee = {
  id: 'e1', full_name: 'Gavrilov Dejan', seniority_from: '2020-10-05',
} as unknown as EmployeeRow

const contract = (over: Partial<ContractRow> & { id: string; valid_from: string; valid_to: string | null }): ContractRow => ({
  employee_id: 'e1', currency: 'EUR', net_amount: 1000,
  service_years: null, note: null,
  ...over,
})

const book = [
  contract({ id: 'a', valid_from: '2025-01-01', valid_to: '2026-08-01', net_amount: 900 }),
  contract({ id: 'b', valid_from: '2026-08-01', valid_to: null, net_amount: 1000 }),
]

const show = () => render(
  <ContractsTab employee={employee} contracts={book}
    seniorityCoefficient={0.004} onChanged={() => {}} />)

describe('correcting a contract', () => {
  /**
   * The whole point. A pay rise was always possible; a figure typed wrongly
   * was not correctable at all — a second contract from today leaves the old
   * month wrong for ever, and one dated the same day collides with the row it
   * was meant to replace.
   */
  it('offers a correction on every contract, not only the current one', () => {
    show()
    expect(screen.getAllByTitle(/Ispravi ovaj ugovor/)).toHaveLength(2)
  })

  /**
   * The first version of this shipped as an emoji at 35% opacity beside an
   * equally invisible delete button, and the owner reported seeing no change
   * at all. A control that has to be hunted for is a control that is not
   * there, so both now say what they do.
   */
  it('names both actions rather than hinting at them with a glyph', () => {
    show()
    expect(screen.getAllByText(/Ispravi/)[0]).toBeInTheDocument()
    expect(screen.getAllByText('Obriši')).toHaveLength(2)
  })

  it('opens the contract into a form with its own figures in it', () => {
    show()
    fireEvent.click(screen.getAllByTitle(/Ispravi ovaj ugovor/)[1])
    expect(screen.getByText(/Ispravka ugovora od 01\.08\.2026\./)).toBeInTheDocument()
    expect((screen.getByDisplayValue('1000') as HTMLInputElement)).toBeInTheDocument()
  })

  /** Two forms on screen is two places to type the same thing. */
  it('puts the add form away while a correction is open', () => {
    show()
    expect(screen.getByText(/Novi ugovor/)).toBeInTheDocument()
    fireEvent.click(screen.getAllByTitle(/Ispravi ovaj ugovor/)[1])
    expect(screen.queryByText(/Novi ugovor/)).not.toBeInTheDocument()
    expect(screen.queryByText('Dodaj ugovor')).not.toBeInTheDocument()
  })

  it('goes back to the add form on cancel', () => {
    show()
    fireEvent.click(screen.getAllByTitle(/Ispravi ovaj ugovor/)[1])
    fireEvent.click(screen.getByText('Otkaži'))
    expect(screen.getByText('Dodaj ugovor')).toBeInTheDocument()
  })

  /**
   * Said while it is being typed, not after it is saved — and a warning, not
   * a refusal: ending a contract is exactly what you do when somebody leaves.
   */
  it('warns, while typing, that ending the current contract drops the person from payroll', () => {
    show()
    fireEvent.click(screen.getAllByTitle(/Ispravi ovaj ugovor/)[1])
    expect(screen.queryByText(/ispada iz/)).not.toBeInTheDocument()

    const until = screen.getByLabelText(/Važi do/i) as HTMLInputElement
    fireEvent.change(until, { target: { value: '2026-09-01' } })
    expect(screen.getByText(/ispada iz/)).toBeInTheDocument()
  })

  it('names the days a moved start date would leave uncovered', () => {
    show()
    fireEvent.click(screen.getAllByTitle(/Ispravi ovaj ugovor/)[1])
    const from = screen.getByLabelText(/Važi od/i) as HTMLInputElement
    fireEvent.change(from, { target: { value: '2026-10-01' } })
    expect(screen.getByText(/od 01\.08\.2026\. do 01\.10\.2026\./)).toBeInTheDocument()
  })

  it('says how to do a pay rise instead, where the correction form is', () => {
    show()
    fireEvent.click(screen.getAllByTitle(/Ispravi ovaj ugovor/)[0])
    expect(screen.getByText(/Za povišicu otkažite i umesto toga dodajte novi ugovor/)).toBeInTheDocument()
  })
})
