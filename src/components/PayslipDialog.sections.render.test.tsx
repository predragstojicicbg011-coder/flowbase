import React from 'react'
import { render } from '@testing-library/react'
import PayslipDialog from './PayslipDialog'
import { runsFor } from '../services/payroll/runs'
import { splitContractedNet, RATES_2026 } from '../services/payroll/engine'
import { emptyTimesheet } from '../services/payroll/timesheets'
import type { EmployeeForMonth, DeductionRow } from '../services/payroll/employees'
import type { AdditionRow } from '../services/payroll/additions'

// THE DIALOG'S BODY, AS IT WAS BEFORE `payslipSections`. The snapshot beside
// this file was written from the dialog that laid every row out itself
// (FlowBase 143525e); the dialog now lays out the rows `payslipSections`
// returns, and must give the same markup to the character. Invented people,
// round figures, three shapes of payslip.

const deduction = (over: Partial<DeductionRow>): DeductionRow => ({
  id: 'd-1', employee_id: 'e-1', label: 'Obustava A', goes_to: 'third_party',
  payee: 'Primalac A', amount: 1000, currency: 'RSD', percent_of_net: null,
  valid_from: '2026-01-01', valid_to: null, is_active: true, note: null, ...over,
})

const person = (over: Partial<EmployeeForMonth> & { netRsd: number; years: number }): EmployeeForMonth => {
  const { netRsd, years, ...rest } = over
  return {
    employee: {
      id: 'e-1', company_id: 'c-1', code: 'E-001', full_name: 'Osoba A',
      organisational_unit: 'Jedinica A', hired_on: '2025-01-01', seniority_from: '2025-01-01',
      left_on: null, note: null, deleted_at: null,
    },
    contract: {
      id: 'k-1', employee_id: 'e-1', valid_from: '2025-01-01', valid_to: null,
      currency: 'RSD', net_amount: netRsd, service_years: null, note: null,
    },
    net: splitContractedNet(netRsd, years, 0.004),
    deductions: [],
    allocation: null,
    serviceYears: years,
    serviceYearsDerived: true,
    ...rest,
  }
}

const bonus: AdditionRow = {
  id: 'a-1', employee_id: 'e-1', month: '2026-11-01', kind: 'bonus',
  label: 'Bonus A', treatment: 'salary', amount: 10000, currency: 'RSD', note: null,
}

const CASES: {
  name: string; p: EmployeeForMonth; hours: Record<string, number>
  rates: Record<string, number>; coefficient: number | null; additions?: AdditionRow[]
}[] = [
  {
    name: 'dinars, a deduction to a third party',
    p: person({ netRsd: 100000, years: 1, deductions: [deduction({})] }),
    hours: { regular_hours: 168 }, rates: {}, coefficient: 0.004,
  },
  {
    name: 'euros, over the contribution ceiling, both kinds of deduction, a bonus, an end date',
    p: {
      ...person({
        netRsd: 1200000, years: 12,
        deductions: [deduction({}), deduction({ id: 'd-2', label: 'Obustava B', goes_to: 'employer', amount: 500 })],
      }),
      contract: {
        id: 'k-1', employee_id: 'e-1', valid_from: '2025-01-01', valid_to: '2026-12-31',
        currency: 'EUR', net_amount: 10000, service_years: null, note: null,
      },
    },
    hours: { regular_hours: 160, vacation_hours: 8 }, rates: { EUR: 120 }, coefficient: 0.004,
    additions: [bonus],
  },
  {
    name: 'part of the month, no seniority coefficient, nothing deducted',
    p: person({ netRsd: 80000, years: 0 }),
    hours: { regular_hours: 84 }, rates: {}, coefficient: null,
  },
]

describe('the payslip dialog lays out what payslipSections says, unchanged', () => {
  for (const c of CASES) {
    it(c.name, () => {
      const line = runsFor({
        people: [c.p],
        timesheets: { 'e-1': { ...emptyTimesheet('e-1', '2026-11'), ...c.hours } },
        rates: RATES_2026, monthHours: 168, month: '2026-11',
        currencyRates: c.rates, additions: c.additions ?? [],
        coefficients: { godisnji_odmor: 1 },
      }).runs.find(r => r.key === 'regular')!.salaries[0]
      const { container } = render(
        <PayslipDialog line={line} person={c.p} rates={RATES_2026} seniorityCoefficient={c.coefficient}
          currencyRates={c.rates} runLabel="Zarade" month="2026-11" companyName="Firma A"
          onClose={() => {}} />)
      const body = container.querySelector('[data-payslip-section]')!.parentElement!
      expect(body.innerHTML).toMatchSnapshot()
    })
  }
})
