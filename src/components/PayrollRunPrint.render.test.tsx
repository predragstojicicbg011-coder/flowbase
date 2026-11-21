import React from 'react'
import { render, screen, fireEvent } from '@testing-library/react'
import PayrollRunPrint from './PayrollRunPrint'
import { PRINT_FRAME_TITLE } from './usePrintFrame'
import { NOTHING_TO_PRINT, NO_PAYSLIPS_TO_PRINT } from '../services/payroll/payrollPrint'
import type { PayrollRun } from '../services/payroll/runs'

// Shapes only: the figures are not read by the buttons.
const totals = {
  gross: 0, net: 0, incomeTax: 0, employeeContributions: 0, employerContributions: 0,
  totalCost: 0, deductionsThirdParty: 0, deductionsEmployer: 0,
}
const run = (salaries: number, other: number): PayrollRun => ({
  key: 'regular', label: 'Zarade', totals,
  salaries: Array.from({ length: salaries }, () => ({}) as any),
  otherIncome: Array.from({ length: other }, () => ({}) as any),
})

const frames = () => Array.from(document.querySelectorAll(`iframe[title="${PRINT_FRAME_TITLE}"]`)) as HTMLIFrameElement[]
afterEach(() => frames().forEach(f => f.remove()))

describe('printing a run', () => {
  it('two buttons named for their run, each writing its document into the frame', () => {
    window.print = () => {}
    render(<PayrollRunPrint run={run(2, 0)}
      recap={() => ({ ok: true, html: '<h1>Rekapitulacija A</h1>' })}
      payslips={() => ({ ok: true, html: '<h1>Listići A</h1>' })} />)
    const recap = screen.getByRole('button', { name: 'Štampaj rekapitulaciju — Zarade' })
    expect(recap).toHaveTextContent(/^Štampaj rekapitulaciju$/)
    fireEvent.click(recap)
    expect(frames()).toHaveLength(1)
    expect(frames()[0].getAttribute('srcdoc')).toContain('Rekapitulacija A')
    expect(frames()[0].getAttribute('aria-hidden')).toBe('true')
    const all = screen.getByRole('button', { name: 'Štampaj sve platne listiće — Zarade' })
    expect(all).toHaveTextContent(/^Štampaj sve platne listiće$/)
    fireEvent.click(all)
    expect(frames()).toHaveLength(1)
    expect(frames()[0].getAttribute('srcdoc')).toContain('Listići A')
  })

  it('both disabled when nobody is in the run, the reason their description and not shown', () => {
    render(<PayrollRunPrint run={run(0, 0)} recap={() => ({ ok: false, why: 'x' })}
      payslips={() => ({ ok: false, why: 'x' })} />)
    for (const name of ['Štampaj rekapitulaciju — Zarade', 'Štampaj sve platne listiće — Zarade']) {
      const b = screen.getByRole('button', { name })
      expect(b).toBeDisabled()
      expect(b).toHaveAccessibleDescription(NOTHING_TO_PRINT)
    }
    expect(screen.getByText(NOTHING_TO_PRINT)).not.toBeVisible()
  })

  it('a run of other income has a recap and no payslips, and says so beside the button', () => {
    render(<PayrollRunPrint run={run(0, 2)} recap={() => ({ ok: false, why: 'x' })}
      payslips={() => ({ ok: false, why: 'x' })} />)
    expect(screen.getByRole('button', { name: 'Štampaj rekapitulaciju — Zarade' })).toBeEnabled()
    const all = screen.getByRole('button', { name: 'Štampaj sve platne listiće — Zarade' })
    expect(all).toBeDisabled()
    expect(all).toHaveAccessibleDescription(NO_PAYSLIPS_TO_PRINT)
    expect(screen.getByText(NO_PAYSLIPS_TO_PRINT)).toBeVisible()
  })

  it('a refusal is said and nothing is written', () => {
    render(<PayrollRunPrint run={run(1, 0)}
      recap={() => ({ ok: false, why: 'Rekapitulacija se ne slaže.' })}
      payslips={() => ({ ok: false, why: 'x' })} />)
    fireEvent.click(screen.getByRole('button', { name: 'Štampaj rekapitulaciju — Zarade' }))
    expect(screen.getByRole('alert')).toHaveTextContent('Rekapitulacija se ne slaže.')
    expect(frames()).toHaveLength(0)
  })

  it('focus returns to the button once printing is over', () => {
    window.print = () => {}
    render(<PayrollRunPrint run={run(1, 0)}
      recap={() => ({ ok: true, html: '<h1>Rekapitulacija</h1>' })}
      payslips={() => ({ ok: false, why: 'x' })} />)
    const recap = screen.getByRole('button', { name: 'Štampaj rekapitulaciju — Zarade' })
    recap.focus()
    fireEvent.click(recap)
    recap.blur()
    expect(recap).not.toHaveFocus()
    frames()[0].contentWindow!.dispatchEvent(new Event('afterprint'))
    expect(recap).toHaveFocus()
  })
})
