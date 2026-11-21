import React from 'react'
import { render, screen, fireEvent } from '@testing-library/react'
import PayslipDialog from './PayslipDialog'
import { employeesForMonth, type EmployeeRow, type ContractRow } from '../services/payroll/employees'
import { runsFor } from '../services/payroll/runs'
import { RATES_2026 } from '../services/payroll/engine'
import { emptyTimesheet } from '../services/payroll/timesheets'
import { PAYSLIP_NOT_PRINTABLE } from '../services/payroll/payrollPrint'
import { PRINT_FRAME_TITLE } from './usePrintFrame'

// An invented person on an invented round contract, calculated for real.
const A: EmployeeRow = {
  id: 'emp-1', company_id: 'co-1', code: 'E-001', full_name: 'Osoba A', organisational_unit: null,
  hired_on: '2025-01-01', seniority_from: '2025-01-01', left_on: null, note: null,
}
const CONTRACT: ContractRow = {
  id: 'con-1', employee_id: A.id, valid_from: '2025-01-01', valid_to: null, currency: 'RSD',
  net_amount: 100000, service_years: 0, note: null,
}
const roster = employeesForMonth([A], [CONTRACT], [],
  { date: '2026-11-01', seniorityCoefficient: 0, rates: {} })
const result = runsFor({
  people: roster.people,
  timesheets: { [A.id]: { ...emptyTimesheet(A.id, '2026-11'), regular_hours: 168 } },
  rates: RATES_2026, monthHours: 168, month: '2026-11', coefficients: {},
})
const LINE = result.runs.find(r => r.key === 'regular')!.salaries[0]

const frames = () => Array.from(document.querySelectorAll(`iframe[title="${PRINT_FRAME_TITLE}"]`))

const dialog = (onPrint?: () => { ok: true; html: string } | { ok: false; why: string }) => render(
  <PayslipDialog line={LINE} person={roster.people[0]} rates={RATES_2026} seniorityCoefficient={0}
    currencyRates={{}} runLabel="Zarade" month="2026-11" companyName="Firma A"
    onClose={() => {}} onPrint={onPrint} />)

afterEach(() => frames().forEach(f => f.remove()))

describe('printing the payslip', () => {
  it('has a Print button that writes the document into the hidden frame, again on a second click', () => {
    window.print = () => {}
    let n = 0
    dialog(() => ({ ok: true, html: `<html><body><h1>Listić ${++n}</h1></body></html>` }))
    const button = screen.getByRole('button', { name: 'Štampaj ovaj platni listić' })
    expect(button).toHaveTextContent(/^Štampaj$/)
    expect(button).toBeEnabled()
    fireEvent.click(button)
    expect(frames()).toHaveLength(1)
    expect(frames()[0].getAttribute('srcdoc')).toContain('Listić 1')
    expect(frames()[0].getAttribute('aria-hidden')).toBe('true')
    fireEvent.click(button)
    expect(frames()).toHaveLength(1)
    expect(frames()[0].getAttribute('srcdoc')).toContain('Listić 2')
  })

  it('is disabled with a reason when there is nothing to print it with', () => {
    dialog()
    const button = screen.getByRole('button', { name: 'Štampaj ovaj platni listić' })
    expect(button).toBeDisabled()
    expect(button).toHaveAccessibleDescription(PAYSLIP_NOT_PRINTABLE)
  })

  it('says why when the document is refused, and writes nothing', () => {
    dialog(() => ({ ok: false, why: 'Odbijeno iz razloga A.' }))
    fireEvent.click(screen.getByRole('button', { name: 'Štampaj ovaj platni listić' }))
    expect(screen.getByRole('alert')).toHaveTextContent('Odbijeno iz razloga A.')
    expect(frames()).toHaveLength(0)
  })

  it('gives focus back to Print once printing is over', () => {
    window.print = () => {}
    dialog(() => ({ ok: true, html: '<h1>Listić</h1>' }))
    const button = screen.getByRole('button', { name: 'Štampaj ovaj platni listić' })
    button.focus()
    fireEvent.click(button)
    button.blur()
    ;(frames()[0] as HTMLIFrameElement).contentWindow!.dispatchEvent(new Event('afterprint'))
    expect(button).toHaveFocus()
  })

  it('the close button keeps its name', () => {
    dialog()
    expect(screen.getByRole('button', { name: 'Zatvori' })).toBeInTheDocument()
  })
})
