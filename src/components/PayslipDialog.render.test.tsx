import React from 'react'
import { render } from '@testing-library/react'
import PayslipDialog from './PayslipDialog'
import { runsFor } from '../services/payroll/runs'
import { splitContractedNet, RATES_2026 } from '../services/payroll/engine'
import { emptyTimesheet } from '../services/payroll/timesheets'
import type { EmployeeForMonth, DeductionRow } from '../services/payroll/employees'

// An invented person on an invented round contract, with one deduction
// forwarded to a third party so the third column of a charge row has text.
const DEDUCTION: DeductionRow = {
  id: 'd-1', employee_id: 'e-1', label: 'Obustava A', goes_to: 'third_party',
  payee: 'Primalac A', amount: 1000, currency: 'RSD', percent_of_net: null,
  valid_from: '2026-01-01', valid_to: null, is_active: true, note: null,
}

const PERSON: EmployeeForMonth = {
  employee: {
    id: 'e-1', company_id: 'c-1', code: 'E-001', full_name: 'Osoba A',
    organisational_unit: 'Jedinica A', hired_on: '2025-01-01', seniority_from: '2025-01-01',
    left_on: null, note: null, deleted_at: null,
  },
  contract: {
    id: 'k-1', employee_id: 'e-1', valid_from: '2025-01-01', valid_to: null,
    currency: 'RSD', net_amount: 100000, service_years: null, note: null,
  },
  net: splitContractedNet(100000, 1, 0.004),
  deductions: [DEDUCTION],
  allocation: null,
  serviceYears: 1,
  serviceYearsDerived: true,
}

const LINE = runsFor({
  people: [PERSON],
  timesheets: { 'e-1': { ...emptyTimesheet('e-1', '2026-11'), regular_hours: 168 } },
  rates: RATES_2026, monthHours: 168, month: '2026-11',
  coefficients: { godisnji_odmor: 1 },
}).runs.find(r => r.key === 'regular')!.salaries[0]

const dialog = () => render(
  <PayslipDialog line={LINE} person={PERSON} rates={RATES_2026} seniorityCoefficient={0.004}
    currencyRates={{}} runLabel="Zarade" month="2026-11" companyName="Firma A"
    onClose={() => {}} />)

describe('the payslip headings', () => {
  it('has one heading over every figure column, in every section that has headings', () => {
    const { container } = dialog()
    const sections = Array.from(container.querySelectorAll<HTMLElement>('[data-payslip-section]'))
    const withHeadings = sections.filter(s => s.querySelector('[data-payslip-heading]'))
    expect(withHeadings.map(s => s.dataset.payslipSection)).toEqual([
      'Cena rada po satu', 'Delovi zarade', 'Zarada, porez i doprinosi', 'Doprinosi na teret poslodavca',
    ])
    for (const section of withHeadings) {
      const headings = section.querySelectorAll('[data-payslip-heading]')
      const rows = Array.from(section.querySelectorAll('[data-payslip-row]'))
      expect(rows.length).toBeGreaterThan(0)
      for (const row of rows) {
        expect([section.dataset.payslipSection, row.querySelectorAll('[data-payslip-cell]').length])
          .toEqual([section.dataset.payslipSection, headings.length])
      }
    }
  })

  it('puts Stopa over the rate and Ukupno over the amount in both charge sections', () => {
    const { container } = dialog()
    for (const title of ['Zarada, porez i doprinosi', 'Doprinosi na teret poslodavca']) {
      const section = container.querySelector(`[data-payslip-section="${title}"]`)!
      expect(Array.from(section.querySelectorAll('[data-payslip-heading]')).map(h => h.textContent))
        .toEqual(['Stopa', 'Ukupno', ''])
    }
  })

  it('spaces the headings as the rows are spaced, each heading as wide as its cell', () => {
    const { container } = dialog()
    for (const section of Array.from(container.querySelectorAll<HTMLElement>('[data-payslip-section]'))) {
      const headings = Array.from(section.querySelectorAll<HTMLElement>('[data-payslip-heading]'))
      if (headings.length === 0) continue
      const row = section.querySelector<HTMLElement>('[data-payslip-row]')!
      expect(headings[0].parentElement!.style.gap).toBe(row.style.gap)
      const cells = Array.from(row.querySelectorAll<HTMLElement>('[data-payslip-cell]'))
      headings.forEach((h, i) => expect(h.style.width).toBe(cells[i].style.width))
    }
  })
})
