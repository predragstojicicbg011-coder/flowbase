import React from 'react'
import { payslipFor } from '../services/payroll/payslip'
import type { SalaryRunLine } from '../services/payroll/runs'
import type { EmployeeForMonth } from '../services/payroll/employees'
import type { PayrollRates } from '../services/payroll/engine'
import { fmtNum } from '../utils/formatters'

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
  runLabel, month, companyName, onClose,
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
}) {
  const p = payslipFor(line, person, rates, seniorityCoefficient, currencyRates)

  const money = (n: number) => fmtNum(n)
  const hours = (n: number | null) => (n === null ? '' : n.toLocaleString('sr-RS',
    { minimumFractionDigits: 2, maximumFractionDigits: 2 }))
  const percent = (n: number) => n.toLocaleString('sr-RS',
    { minimumFractionDigits: 2, maximumFractionDigits: 2 })

  const contract = person?.contract

  return (
    <div style={s.backdrop} onClick={onClose}>
      <div style={s.dialog} onClick={e => e.stopPropagation()}>
        <div style={s.header}>
          <div>
            <div style={s.title}>Payroll and allowance calculation</div>
            <div style={s.sub}>
              {companyName} · {runLabel} {month}
            </div>
          </div>
          <button style={s.close} onClick={onClose}>✕</button>
        </div>

        <div style={s.body}>
          <div style={s.who}>
            <div style={s.whoName}>
              {line.code ? `${line.code} — ` : ''}{line.name}
            </div>
            <div style={s.whoUnit}>
              {person?.employee.organisational_unit || '—'}
            </div>
          </div>

          {/* ── општи подаци ─────────────────────────────────────────── */}
          <Section title="General">
            <Row n={1} label="Contracted monthly net, total" value={money(p.contractedNet)} />
            {contract && (
              <Note>
                {money(contract.net_amount)} {contract.currency}
                {contract.currency !== 'RSD' && currencyRates[contract.currency]
                  ? `, at ${money(currencyRates[contract.currency])}`
                  : ''}
                {' '}from {contract.valid_from}
                {contract.valid_to ? ` to ${contract.valid_to}` : ' onwards'}
              </Note>
            )}
            <Row n={2} label="Seniority, monthly net, inside the contracted amount"
              value={money(p.seniorityNet)} />
            <Row n={3} label="Base net for working time" value={money(p.baseNet)} />
            <Row n={4} label="Seniority coefficient"
              value={p.seniorityPercent === null ? '—'
                : `${hours(p.serviceYears)}   ${percent(p.seniorityPercent)}`} />
            <Row n={5} label="Hours in this calculation" value={hours(p.hours)} />
            <Row n={6} label="Hours in the month" value={hours(p.monthHours)} />
          </Section>

          {/* ── цена сати ────────────────────────────────────────────── */}
          <Section title="Price per hour" columns={['Net', 'Gross']}>
            <TwoRow n={1} label="Work, per hour"
              a={money(p.workPerHourNet)} b={money(p.workPerHourGross)} />
            <TwoRow n={2} label="Allowance, per hour"
              a={money(p.allowancePerHourNet)} b={money(p.allowancePerHourGross)} />
          </Section>

          {/* ── делови зараде ────────────────────────────────────────── */}
          <Section title="Parts of the salary" columns={['Hours', 'Net', 'Gross']}>
            {p.parts.map((part, i) => (
              <ThreeRow key={part.label} n={i + 1} label={part.label}
                a={hours(part.hours)} b={money(part.net)} c={money(part.gross)} />
            ))}
          </Section>

          {/* ── зарада, порез и доприноси ────────────────────────────── */}
          <Section title="Salary, tax and contributions"
            columns={['Rate', 'Total']}>
            <ThreeRow n={1} label="Gross amount" a="" b={money(p.gross)} c="" bold />
            <ThreeRow n={2} label="Contribution base" a="" b={money(p.contributionBase)} c=""
              highlight={Math.abs(p.contributionBase - p.gross) > 0.005} />
            <ThreeRow n={3} label="Tax-free amount" a="" b={money(p.taxFree)} c="" />
            <ThreeRow n={4} label="Tax base" a="" b={money(p.taxBase)} c="" />
            <ThreeRow n={5} label="Tax and contributions, the employee" a=""
              b={money(p.employeeTotal)} c="" bold />
            {p.employeeCharges.map(c => (
              <ThreeRow key={c.label} label={c.label} indent
                a={percent(c.percent)} b={money(c.amount)} c="" />
            ))}
            <ThreeRow n={6} label="Net amount" a="" b={money(p.net)} c="" bold />
            {p.deductionsTotal > 0 && (
              <>
                <ThreeRow n={7} label="Deductions" a="" b={money(p.deductionsTotal)} c="" bold />
                {p.deductions.map(d => (
                  <ThreeRow key={d.label} label={d.label} indent a=""
                    b={money(d.amount)}
                    c={d.goesTo === 'third_party' ? 'to a third party' : ''} />
                ))}
                <ThreeRow n={8} label="Net paid" a="" b={money(p.netPaid)} c="" bold />
              </>
            )}
          </Section>

          {/* ── доприноси на терет послодавца ────────────────────────── */}
          <Section title="Contributions, the employer"
            columns={['Rate', 'Total']}>
            <ThreeRow n={1} label="Contributions on the employer" a=""
              b={money(p.employerTotal)} c="" bold />
            {p.employerCharges.map(c => (
              <ThreeRow key={c.label} label={c.label} indent
                a={percent(c.percent)} b={money(c.amount)} c="" />
            ))}
          </Section>

          <div style={s.costBox}>
            <span>What this person costs the company this month</span>
            <b>{money(p.totalCost)}</b>
          </div>

          <div style={s.footnote}>
            This is a calculation to be held against the accountant's, not a document to be
            issued. It deliberately shows neither a home address nor an identification
            number: neither helps anybody compare two totals.
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
    <div style={s.section}>
      <div style={s.sectionHead}>
        <span style={s.sectionTitle}>{title}</span>
        {columns && (
          <span style={s.sectionCols}>
            {columns.map(c => <span key={c} style={s.colHead}>{c}</span>)}
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
    <div style={s.row}>
      <span style={s.num}>{n ?? ''}</span>
      <span style={s.label}>{label}</span>
      <span style={s.cell}>{a}</span>
      <span style={s.cell}>{b}</span>
    </div>
  )
}

function ThreeRow({ n, label, a, b, c, bold, indent, highlight }: {
  n?: number; label: string; a: string; b: string; c: string
  bold?: boolean; indent?: boolean; highlight?: boolean
}) {
  return (
    <div style={{ ...s.row, ...(indent ? s.rowIndent : {}) }}>
      <span style={s.num}>{n ?? ''}</span>
      <span style={{ ...s.label, ...(bold ? s.strong : {}) }}>{label}</span>
      <span style={s.cellNarrow}>{a}</span>
      <span style={{
        ...s.cell,
        ...(bold ? s.strong : {}),
        ...(highlight ? { color: '#C8A24A' } : {}),
      }}>{b}</span>
      {c !== undefined && <span style={{ ...s.cell, color: '#9D97FF' }}>{c}</span>}
    </div>
  )
}

function Note({ children }: { children: React.ReactNode }) {
  return <div style={s.note}>{children}</div>
}

const s: Record<string, React.CSSProperties> = {
  backdrop: { position: 'fixed', inset: 0, background: 'rgba(0,0,0,0.65)', display: 'flex', alignItems: 'center', justifyContent: 'center', zIndex: 1100, padding: '24px' },
  dialog: { background: '#0D1B2C', border: '1px solid rgba(255,255,255,0.09)', borderRadius: '12px', width: '780px', maxWidth: '100%', maxHeight: '92vh', display: 'flex', flexDirection: 'column' as const, fontFamily: "'Inter', system-ui, sans-serif", boxShadow: '0 20px 60px rgba(0,0,0,0.6)' },
  header: { display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start', padding: '18px 22px 14px', borderBottom: '1px solid rgba(255,255,255,0.075)' },
  title: { fontFamily: "'DM Serif Display', Georgia, serif", fontSize: '19px', color: '#DCE9F6' },
  sub: { fontSize: '12px', color: '#7A9BB8', marginTop: '3px' },
  close: { background: 'none', border: 'none', color: '#7A9BB8', fontSize: '15px', cursor: 'pointer' },
  body: { padding: '16px 22px 20px', overflowY: 'auto' as const, flex: 1 },
  who: { paddingBottom: '12px', borderBottom: '1px solid rgba(255,255,255,0.06)', marginBottom: '4px' },
  whoName: { fontSize: '15px', fontWeight: '600', color: '#00D47E' },
  whoUnit: { fontSize: '11.5px', color: '#7A9BB8', marginTop: '2px' },
  section: { marginTop: '16px' },
  sectionHead: { display: 'flex', justifyContent: 'space-between', alignItems: 'baseline', borderBottom: '1px solid rgba(255,255,255,0.08)', paddingBottom: '5px', marginBottom: '4px' },
  sectionTitle: { fontSize: '10px', fontWeight: '700', color: 'rgba(255,255,255,0.40)', textTransform: 'uppercase' as const, letterSpacing: '0.09em' },
  sectionCols: { display: 'flex', gap: '0' },
  colHead: { fontSize: '9.5px', color: 'rgba(255,255,255,0.28)', textTransform: 'uppercase' as const, letterSpacing: '0.07em', width: '110px', textAlign: 'right' as const },
  row: { display: 'flex', alignItems: 'baseline', gap: '8px', padding: '3.5px 0', fontSize: '12.5px' },
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
