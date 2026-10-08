// "Plan prihoda": what each active project is expected to bill in each of the
// next twelve months. A cell is a revenue_plan row (typed, in the project's
// plan currency, booked at today's NBS rate — planBookFigures); on a rental
// building with no typed figure it shows the lease forecast (rentForecast),
// read-only, and a typed figure replaces it for that month. The totals row is
// plannedRevenueByMonth, which applies the precedence of revenuePlan.ts.

import React, { useEffect, useMemo, useState } from 'react'
import { supabase } from '../../supabase'
import { rs } from './styles'
import { projectLabel, type Project } from '../../services/projects'
import {
  planBookFigures, plannedRevenueByMonth, rentForecast,
  type LeaseCurrency, type PlanInvoice, type RentalLease, type RevenuePlanRow,
} from '../../services/revenuePlan'
import {
  amountToInput, defaultPlanCurrency, monthLabel, planCellAction, planGrid, planUpsertRow, srDateShort,
  type PlanCell,
} from '../../services/revenuePage'
import { fmtMoney } from '../../utils/formatters'
import type { BookRates } from '../../services/bookAmounts'
import type { DisplayCurrency } from '../../contexts/DisplayCurrencyContext'

type Fmt = (n: number | null | undefined, decimals?: number) => string

export default function RevenuePlanGrid({
  projects, months, plan, leases, invoices, currency, format, rates, rateError, companyId, today, onChanged,
}: {
  /** Active projects of the company. */
  projects: readonly Project[]
  /** `YYYY-MM`. */
  months: readonly string[]
  plan: readonly RevenuePlanRow[]
  leases: readonly RentalLease[]
  invoices: readonly PlanInvoice[]
  currency: DisplayCurrency
  format: Fmt
  rates: BookRates | null
  rateError: string
  companyId: string | null
  today: string
  onChanged: () => void
}) {
  const [currencyOf, setCurrencyOf] = useState<Record<string, LeaseCurrency>>({})
  const [error, setError] = useState('')
  const [busy, setBusy] = useState<string | null>(null)

  const ids = useMemo(() => projects.map(p => p.id), [projects])
  const rent = useMemo(() => rentForecast(leases, months, invoices), [leases, months, invoices])
  const grid = useMemo(() => planGrid(ids, months, plan, rent), [ids, months, plan, rent])
  const planned = useMemo(
    () => plannedRevenueByMonth(projects, plan, leases, months, { currency, eurRate: rates?.eurRate ?? null, invoices }),
    [projects, plan, leases, months, currency, rates, invoices])
  const yearTotal = Object.values(planned.byMonth).reduce((s, n) => s + n, 0)

  const planCurrency = (p: Project) => currencyOf[p.id] ?? defaultPlanCurrency(p, plan)

  const save = async (p: Project, month: string, cell: PlanCell, input: string): Promise<boolean> => {
    // An existing row keeps its own currency unless the row's currency was
    // switched on purpose; a new figure is in the project's plan currency.
    const cur = cell.plan && !currencyOf[p.id] ? cell.plan.currency : planCurrency(p)
    const action = planCellAction(cell.plan, input, cur)
    if (action.kind === 'none') return true
    if (action.kind === 'error') { setError(action.message); return false }
    if (!companyId) { setError('Firma nije učitana.'); return false }
    const key = `${p.id}|${month}`
    setBusy(key)
    setError('')
    try {
      if (action.kind === 'delete') {
        const { data, error: e } = await supabase.from('revenue_plan').delete().eq('id', action.id).select('id')
        if (e) throw new Error(`Brisanje plana nije uspelo: ${e.message}`)
        // RLS refuses a delete silently: no error, no row.
        if (!data || data.length === 0) throw new Error('Brisanje plana nije uspelo: vaša uloga nema pravo da briše plan (samo administrator ili vlasnik).')
      } else {
        const book = await planBookFigures(action.amount, action.currency, today)
        const row = planUpsertRow(companyId, p.id, month, action.amount, action.currency, book, new Date().toISOString())
        const { data, error: e } = await supabase.from('revenue_plan').upsert(row, { onConflict: 'project_id,month' }).select('id')
        if (e) throw new Error(`Čuvanje plana nije uspelo: ${e.message}`)
        if (!data || data.length === 0) throw new Error('Čuvanje plana nije uspelo: baza nije vratila red (proverite prava pristupa).')
      }
      onChanged()
      return true
    } catch (e: any) {
      setError(e?.message || String(e))
      return false
    } finally {
      setBusy(null)
    }
  }

  if (projects.length === 0) {
    return (
      <div style={rs.tableWrap}>
        <div style={rs.emptyState}>
          <div style={rs.emptyTitle}>Nema aktivnih projekata</div>
          <div>Plan prihoda se unosi po projektu. Dodajte projekat na strani Projekti.</div>
        </div>
      </div>
    )
  }

  return (
    <>
      <div style={rs.filterBar}>
        <div style={{ fontSize: '12.5px', color: '#7A9BB8' }}>
          {rates
            ? <>Kurs na dan unosa: 1 EUR = {rates.eurRate.toLocaleString('sr-RS', { minimumFractionDigits: 4, maximumFractionDigits: 4 })} RSD (NBS, {srDateShort(rates.date)}). Plan se ne preračunava kasnije.</>
            : <>Kurs na dan unosa: {rateError || 'učitava se…'}</>}
        </div>
        <div style={rs.totalBadge}>Plan za 12 meseci: {format(yearTotal, 0)}</div>
      </div>
      {error && <div style={rs.error} role="alert">{error}</div>}
      <div style={rs.tableWrap}>
        <table style={{ ...rs.table, fontSize: '12.5px' }} aria-label="Plan prihoda">
          <thead>
            <tr style={rs.thead}>
              <th style={{ ...rs.th, position: 'sticky', left: 0, background: '#060E1A', zIndex: 1 }}>Projekat</th>
              <th style={rs.th}>Valuta</th>
              {months.map(m => <th key={m} style={rs.thNum}>{monthLabel(m)}</th>)}
            </tr>
          </thead>
          <tbody>
            {projects.map((p, i) => (
              <tr key={p.id} style={{ ...rs.tr, ...(i % 2 ? rs.rowStripe1 : rs.rowStripe0) }}>
                <td style={{ ...rs.td, position: 'sticky', left: 0, background: i % 2 ? '#111F30' : '#0D1B2C', zIndex: 1, minWidth: '160px' }}>
                  <div style={{ fontWeight: 500 }}>{projectLabel(p)}</div>
                  {p.kind === 'rental' && <div style={rs.subCell}>objekat u zakupu</div>}
                </td>
                <td style={rs.td}>
                  <select style={{ ...rs.filterInput, padding: '4px 6px', fontSize: '12px' }} value={planCurrency(p)}
                    aria-label={`Valuta plana: ${p.name}`}
                    onChange={e => setCurrencyOf(c => ({ ...c, [p.id]: e.target.value as LeaseCurrency }))}>
                    <option value="RSD">RSD</option>
                    <option value="EUR">EUR</option>
                  </select>
                </td>
                {months.map(m => (
                  <td key={m} style={{ ...rs.td, padding: '6px 6px' }}>
                    <PlanCellInput cell={grid[p.id]?.[m] ?? { plan: null, rent: [] }} projectName={p.name} month={m}
                      busy={busy === `${p.id}|${m}`} onCommit={input => save(p, m, grid[p.id]?.[m] ?? { plan: null, rent: [] }, input)} />
                  </td>
                ))}
              </tr>
            ))}
            <tr style={{ ...rs.tr, ...rs.rowTotal }}>
              <td style={{ ...rs.td, fontWeight: 600, position: 'sticky', left: 0, background: '#060E1A' }}>Ukupno · {currency}</td>
              <td style={rs.td} />
              {months.map(m => (
                <td key={m} style={{ ...rs.td, ...rs.num, fontWeight: 600 }}>{format(planned.byMonth[m] ?? 0, 0)}</td>
              ))}
            </tr>
          </tbody>
        </table>
      </div>
      <div style={rs.note}>
        <span style={{ ...rs.badge, ...rs.badgeRent, marginRight: 6 }}>zakup</span>
        plavo polje je prognoza zakupa iz ugovora o zakupu — unos iznosa je zamenjuje za taj mesec.
        Prazno polje briše plan. Ukupno odbija ono što je u mesecu već fakturisano.
      </div>
      {planned.notes.length > 0 && (
        <div style={{ ...rs.note, color: '#F5A623' }}>
          Deo plana ili zakupa nije uračunat u „Ukupno": nema iznos u {currency}, a kurs NBS za preračun nije dostupan.
        </div>
      )}
    </>
  )
}

function PlanCellInput({ cell, projectName, month, busy, onCommit }: {
  cell: PlanCell
  projectName: string
  month: string
  busy: boolean
  onCommit: (input: string) => Promise<boolean>
}) {
  const stored = cell.plan ? amountToInput(cell.plan.amount) : ''
  const [text, setText] = useState(stored)
  useEffect(() => { setText(stored) }, [stored])

  const rentOnly = !cell.plan && cell.rent.length > 0
  const rentText = cell.rent.map(r => fmtMoney(r.amount, r.currency, 0)).join(' + ')
  const commit = async () => {
    if (text === stored) return
    const ok = await onCommit(text)
    if (!ok) setText(stored)
  }
  return (
    <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'flex-end', gap: '2px' }}>
      <input value={text} disabled={busy} inputMode="decimal"
        aria-label={`Plan ${projectName} ${monthLabel(month)}`}
        placeholder={rentOnly ? rentText : ''}
        title={cell.plan
          ? `Ručni plan u ${cell.plan.currency}${cell.plan.rate_date ? `, kurs od ${srDateShort(cell.plan.rate_date)}` : ''}`
          : rentOnly ? `Prognoza zakupa: ${rentText}. Unesite iznos da je zamenite.` : 'Unesite planirani iznos'}
        onChange={e => setText(e.target.value)}
        onBlur={commit}
        onKeyDown={e => { if (e.key === 'Enter') (e.target as HTMLInputElement).blur() }}
        style={{
          width: '92px', textAlign: 'right', fontSize: '12.5px', padding: '5px 7px', borderRadius: '6px', outline: 'none',
          fontVariantNumeric: 'tabular-nums', boxSizing: 'border-box',
          border: `1px solid ${cell.plan ? 'rgba(0,212,126,0.35)' : rentOnly ? 'rgba(78,168,255,0.35)' : 'rgba(255,255,255,0.08)'}`,
          background: rentOnly ? 'rgba(78,168,255,0.08)' : '#0A1525', color: '#DCE9F6',
        }} />
      <span style={{ fontSize: '10px', color: cell.plan ? '#00D47E' : '#4EA8FF', minHeight: '12px' }}>
        {cell.plan ? `plan · ${cell.plan.currency}` : rentOnly ? 'zakup' : ''}
      </span>
    </div>
  )
}
