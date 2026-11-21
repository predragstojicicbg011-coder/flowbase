import React, { useId, useState } from 'react'
import { usePrintFrame } from './usePrintFrame'
import {
  PRINT_RECAP, PRINT_ALL_PAYSLIPS, NOTHING_TO_PRINT, NO_PAYSLIPS_TO_PRINT,
  printRecapOf, printAllPayslipsOf, type PrintOutcome,
} from '../services/payroll/payrollPrint'
import type { PayrollRun } from '../services/payroll/runs'

/**
 * A run card's two print buttons, top right: the recap, and every payslip.
 *
 * The documents are built when a button is pressed (so the time printed is
 * that moment) by the page, which holds everything they need; a refusal is
 * said here and nothing is printed. Each button's name carries its run, so
 * two cards are not four identical buttons; a disabled one is described by
 * its reason. A card nobody is in shows no sentence — the empty card says it
 * already — and keeps the reason as the buttons' description.
 */
export default function PayrollRunPrint({ run, recap, payslips }: {
  run: PayrollRun
  recap: () => PrintOutcome
  payslips: () => PrintOutcome
}) {
  const print = usePrintFrame()
  const reasonId = useId()
  const [refused, setRefused] = useState<string | null>(null)
  const nobody = run.salaries.length + run.otherIncome.length === 0
  const noPayslips = run.salaries.length === 0

  const go = (build: () => PrintOutcome, button: HTMLElement) => {
    const outcome = build()
    if (outcome.ok) { setRefused(null); print(outcome.html, button) } else setRefused(outcome.why)
  }

  return (
    <div style={s.box}>
      <div style={s.buttons}>
        <button type="button" aria-label={printRecapOf(run.label)}
          aria-describedby={nobody ? reasonId : undefined}
          style={nobody ? s.disabled : s.ghost} disabled={nobody}
          onClick={e => go(recap, e.currentTarget)}>{PRINT_RECAP}</button>
        <button type="button" aria-label={printAllPayslipsOf(run.label)}
          aria-describedby={noPayslips ? reasonId : undefined}
          style={noPayslips ? s.disabled : s.ghost} disabled={noPayslips}
          onClick={e => go(payslips, e.currentTarget)}>{PRINT_ALL_PAYSLIPS}</button>
      </div>
      {nobody
        ? <span id={reasonId} hidden>{NOTHING_TO_PRINT}</span>
        : noPayslips && <div id={reasonId} style={s.reason}>{NO_PAYSLIPS_TO_PRINT}</div>}
      {refused && <div role="alert" style={s.refused}>{refused}</div>}
    </div>
  )
}

const s: Record<string, React.CSSProperties> = {
  box: { display: 'flex', flexDirection: 'column' as const, alignItems: 'flex-end', gap: '4px', padding: '14px 18px 0 0', flexShrink: 0 },
  buttons: { display: 'flex', gap: '6px' },
  ghost: { background: 'none', color: '#7A9BB8', border: '1px solid rgba(255,255,255,0.10)', borderRadius: '6px', padding: '5px 12px', fontSize: '11px', cursor: 'pointer', whiteSpace: 'nowrap' as const },
  disabled: { background: 'none', color: '#3E5670', border: '1px solid rgba(255,255,255,0.06)', borderRadius: '6px', padding: '5px 12px', fontSize: '11px', cursor: 'not-allowed', whiteSpace: 'nowrap' as const },
  reason: { fontSize: '10.5px', color: '#5C7894', maxWidth: '240px', textAlign: 'right' as const },
  refused: { fontSize: '11px', color: '#FF8E8D', maxWidth: '320px', textAlign: 'right' as const, lineHeight: 1.45 },
}
