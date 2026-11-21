import React, { useId, useState } from 'react'
import {
  payslipFor, payslipSections, PAYSLIP_COST_LABEL,
} from '../services/payroll/payslip'
import type { SalaryRunLine } from '../services/payroll/runs'
import type { EmployeeForMonth } from '../services/payroll/employees'
import type { PayrollRates } from '../services/payroll/engine'
import { fmtNum } from '../utils/formatters'
import { monthLongLabel } from '../utils/months'
import { PAYSLIP_TITLE, PAYSLIP_TITLE_PRELIMINARY } from '../services/payroll/preliminaryText'
import {
  PRINT, PRINT_THIS_PAYSLIP, PAYSLIP_NOT_PRINTABLE, type PrintOutcome,
} from '../services/payroll/payrollPrint'
import { usePrintFrame } from './usePrintFrame'

/**
 * One person's payslip, in the order MPP prints it.
 *
 * Laid out against a real sheet so the two can be read side by side — which is
 * the only thing this is for. Somebody checking a month against the
 * accountant has both on screen, and a figure that is correct but three
 * sections away from where they expect it may as well be missing.
 *
 * IT SHOWS NEITHER THE HOME ADDRESS NOR THE JMBG. MPP prints both because MPP
 * produces the document a person is handed. This produces a comparison, and
 * neither figure helps anybody make one.
 */
export default function PayslipDialog({
  line, person, rates, seniorityCoefficient, currencyRates,
  runLabel, month, companyName, onClose, preliminary = false, onPrint,
}: {
  line: SalaryRunLine
  person: EmployeeForMonth | undefined
  rates: PayrollRates
  seniorityCoefficient: number | null
  currencyRates: Record<string, number>
  runLabel: string
  month: string
  companyName: string
  onClose: () => void
  /** A payslip of a preliminary month says so in its title. */
  preliminary?: boolean
  /** Builds this payslip's printed document; without it, Print is disabled. */
  onPrint?: () => PrintOutcome
}) {
  const p = payslipFor(line, person, rates, seniorityCoefficient, currencyRates)
  // The rows the printed payslip carries too, from the one model.
  const sections = payslipSections(p, person, currencyRates)

  const money = (n: number) => fmtNum(n)
  const print = usePrintFrame()
  const [refused, setRefused] = useState<string | null>(null)
  const reasonId = useId()
  const printThis = (button: HTMLElement) => {
    if (!onPrint) return
    const outcome = onPrint()
    if (outcome.ok) { setRefused(null); print(outcome.html, button) } else setRefused(outcome.why)
  }

  return (
    <div style={s.backdrop} onClick={onClose}>
      <div style={s.dialog} onClick={e => e.stopPropagation()}>
        <div style={s.header}>
          <div>
            <div style={s.title}>{preliminary ? PAYSLIP_TITLE_PRELIMINARY : PAYSLIP_TITLE}</div>
            <div style={s.sub}>
              {companyName} · {runLabel} · {monthLongLabel(month)}
            </div>
          </div>
          <div style={s.headerTools}>
            <button type="button" aria-label={PRINT_THIS_PAYSLIP} style={onPrint ? s.print : s.printDisabled}
              aria-describedby={onPrint ? undefined : reasonId}
              disabled={!onPrint} onClick={e => printThis(e.currentTarget)}>{PRINT}</button>
            <button style={s.close} onClick={onClose} aria-label="Zatvori" title="Zatvori">✕</button>
          </div>
        </div>
        {(!onPrint || refused) && (
          <div id={reasonId} role={refused ? 'alert' : undefined} style={refused ? s.refused : s.printNote}>
            {refused ?? PAYSLIP_NOT_PRINTABLE}
          </div>
        )}

        <div style={s.body}>
          <div style={s.who}>
            <div style={s.whoName}>
              {line.code ? `${line.code} — ` : ''}{line.name}
            </div>
            <div style={s.whoUnit}>
              {person?.employee.organisational_unit || '—'}
            </div>
          </div>

          {sections.map(sec => (
            <Section key={sec.title} title={sec.title} columns={sec.columns}>
              {sec.rows.map((r, i) => r.kind === 'note'
                ? <Note key={`note-${i}`}>{r.text}</Note>
                : sec.layout === 'one'
                  ? <Row key={r.label} n={r.n} label={r.label} value={r.cells[0]} />
                  : sec.layout === 'two'
                    ? <TwoRow key={r.label} n={r.n} label={r.label} a={r.cells[0]} b={r.cells[1]} />
                    : <ThreeRow key={r.label} n={r.n} label={r.label} a={r.cells[0]} b={r.cells[1]}
                        c={r.cells[2]} bold={r.bold} indent={r.indent} highlight={r.highlight} />)}
            </Section>
          ))}

          <div style={s.costBox}>
            <span>{PAYSLIP_COST_LABEL}</span>
            <b>{money(p.totalCost)}</b>
          </div>

          <div style={s.footnote}>
            Ovo je obračun za poređenje sa obračunom knjigovođe, a ne dokument koji se
            izdaje zaposlenom. Namerno ne prikazuje adresu ni JMBG: nijedno ne pomaže da se
            uporede dva zbira.
          </div>
        </div>
      </div>
    </div>
  )
}

function Section({ title, columns, children }: {
  title: string
  columns?: string[]
  children: React.ReactNode
}) {
  return (
    <div style={s.section} data-payslip-section={title}>
      <div style={s.sectionHead}>
        <span style={s.sectionTitle}>{title}</span>
        {columns && (
          <span style={s.sectionCols}>
            {columns.map((c, i) => <span key={i} style={s.colHead} data-payslip-heading="">{c}</span>)}
          </span>
        )}
      </div>
      {children}
    </div>
  )
}

function Row({ n, label, value }: { n?: number; label: string; value: string }) {
  return (
    <div style={s.row}>
      <span style={s.num}>{n ?? ''}</span>
      <span style={s.label}>{label}</span>
      <span style={s.value}>{value}</span>
    </div>
  )
}

function TwoRow({ n, label, a, b }: { n?: number; label: string; a: string; b: string }) {
  return (
    <div style={s.row} data-payslip-row="">
      <span style={s.num}>{n ?? ''}</span>
      <span style={s.label}>{label}</span>
      <span style={s.cell} data-payslip-cell="">{a}</span>
      <span style={s.cell} data-payslip-cell="">{b}</span>
    </div>
  )
}

function ThreeRow({ n, label, a, b, c, bold, indent, highlight }: {
  n?: number; label: string; a: string; b: string; c: string
  bold?: boolean; indent?: boolean; highlight?: boolean
}) {
  return (
    <div style={{ ...s.row, ...(indent ? s.rowIndent : {}) }} data-payslip-row="">
      <span style={s.num}>{n ?? ''}</span>
      <span style={{ ...s.label, ...(bold ? s.strong : {}) }}>{label}</span>
      <span style={s.cellNarrow} data-payslip-cell="">{a}</span>
      <span style={{
        ...s.cell,
        ...(bold ? s.strong : {}),
        ...(highlight ? { color: '#C8A24A' } : {}),
      }} data-payslip-cell="">{b}</span>
      <span style={{ ...s.cell, color: '#9D97FF' }} data-payslip-cell="">{c}</span>
    </div>
  )
}

function Note({ children }: { children: React.ReactNode }) {
  return <div style={s.note}>{children}</div>
}

/** One gap for the headings and the rows, or the headings drift off their cells. */
const ROW_GAP = '8px'

const s: Record<string, React.CSSProperties> = {
  backdrop: { position: 'fixed', inset: 0, background: 'rgba(0,0,0,0.65)', display: 'flex', alignItems: 'center', justifyContent: 'center', zIndex: 1100, padding: '24px' },
  dialog: { background: '#0D1B2C', border: '1px solid rgba(255,255,255,0.09)', borderRadius: '12px', width: '780px', maxWidth: '100%', maxHeight: '92vh', display: 'flex', flexDirection: 'column' as const, fontFamily: "'Inter', system-ui, sans-serif", boxShadow: '0 20px 60px rgba(0,0,0,0.6)' },
  header: { display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start', padding: '18px 22px 14px', borderBottom: '1px solid rgba(255,255,255,0.075)' },
  title: { fontFamily: "'DM Serif Display', Georgia, serif", fontSize: '19px', color: '#DCE9F6' },
  sub: { fontSize: '12px', color: '#7A9BB8', marginTop: '3px' },
  close: { background: 'none', border: 'none', color: '#7A9BB8', fontSize: '15px', cursor: 'pointer' },
  headerTools: { display: 'flex', alignItems: 'center', gap: '10px' },
  print: { background: 'none', color: '#7A9BB8', border: '1px solid rgba(255,255,255,0.10)', borderRadius: '6px', padding: '4px 12px', fontSize: '11px', cursor: 'pointer' },
  printDisabled: { background: 'none', color: '#3E5670', border: '1px solid rgba(255,255,255,0.06)', borderRadius: '6px', padding: '4px 12px', fontSize: '11px', cursor: 'not-allowed' },
  printNote: { padding: '6px 22px', fontSize: '11px', color: '#5C7894', borderBottom: '1px solid rgba(255,255,255,0.075)' },
  refused: { padding: '6px 22px', fontSize: '11.5px', color: '#FF8E8D', borderBottom: '1px solid rgba(255,255,255,0.075)', lineHeight: 1.45 },
  body: { padding: '16px 22px 20px', overflowY: 'auto' as const, flex: 1 },
  who: { paddingBottom: '12px', borderBottom: '1px solid rgba(255,255,255,0.06)', marginBottom: '4px' },
  whoName: { fontSize: '15px', fontWeight: '600', color: '#00D47E' },
  whoUnit: { fontSize: '11.5px', color: '#7A9BB8', marginTop: '2px' },
  section: { marginTop: '16px' },
  sectionHead: { display: 'flex', justifyContent: 'space-between', alignItems: 'baseline', borderBottom: '1px solid rgba(255,255,255,0.08)', paddingBottom: '5px', marginBottom: '4px' },
  sectionTitle: { fontSize: '10px', fontWeight: '700', color: 'rgba(255,255,255,0.40)', textTransform: 'uppercase' as const, letterSpacing: '0.09em' },
  sectionCols: { display: 'flex', gap: ROW_GAP },
  colHead: { fontSize: '9.5px', color: 'rgba(255,255,255,0.28)', textTransform: 'uppercase' as const, letterSpacing: '0.07em', width: '110px', textAlign: 'right' as const },
  row: { display: 'flex', alignItems: 'baseline', gap: ROW_GAP, padding: '3.5px 0', fontSize: '12.5px' },
  rowIndent: { paddingLeft: '18px', opacity: 0.85 },
  num: { width: '16px', fontSize: '10.5px', color: 'rgba(255,255,255,0.28)', flexShrink: 0 },
  label: { flex: 1, color: '#9FB6CC' },
  strong: { color: '#DCE9F6', fontWeight: '600' },
  value: { fontFamily: "'DM Mono', monospace", fontSize: '12.5px', color: '#DCE9F6', textAlign: 'right' as const, minWidth: '120px' },
  cell: { fontFamily: "'DM Mono', monospace", fontSize: '12.5px', color: '#DCE9F6', textAlign: 'right' as const, width: '110px', flexShrink: 0 },
  cellNarrow: { fontFamily: "'DM Mono', monospace", fontSize: '12px', color: '#7A9BB8', textAlign: 'right' as const, width: '110px', flexShrink: 0 },
  note: { fontSize: '11px', color: '#5C7894', paddingLeft: '24px', paddingBottom: '4px', lineHeight: 1.5 },
  costBox: { marginTop: '14px', display: 'flex', justifyContent: 'space-between', alignItems: 'baseline', background: '#060E1A', border: '1px solid rgba(255,255,255,0.08)', borderRadius: '9px', padding: '12px 14px', fontSize: '13px', color: '#9FB6CC' },
  footnote: { marginTop: '14px', fontSize: '10.5px', color: '#5C7894', lineHeight: 1.6, fontStyle: 'italic' as const },
}
