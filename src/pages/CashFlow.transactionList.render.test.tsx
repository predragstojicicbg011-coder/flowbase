import React from 'react'
import { render, screen, within } from '@testing-library/react'
import CashFlow from './CashFlow'

/**
 * The list of recent transactions under the cash-flow period. A refund is a
 * direct expense booked with a minus: money that came back. It reads `+`, wears
 * the Povraćaj badge instead of Direktna isplata, and the outflow total is the
 * net of the expense and the refund. Every firm here is invented.
 */

jest.setTimeout(30000)

jest.mock('../contexts/CompaniesContext', () => ({
  useCompanies: () => ({ companies: [{ id: 'c1', name: 'Gradnja Primer doo', currency: 'RSD', currencies: ['RSD'] }], showPicker: false }),
}))
jest.mock('../contexts/SystemCategoriesContext', () => ({
  useSystemCategories: () => ({ map: {}, loading: false, error: null, refresh: () => Promise.resolve() }),
}))
// The twelve-month line has its own tests; here it simply has nothing to say.
jest.mock('../services/loadCashTimeline', () => ({ loadCashTimeline: () => Promise.resolve(null) }))

jest.mock('../supabase', () => {
  const chain = (table: string) => {
    const c: any = {}
    c.select = () => c
    ;['order', 'eq', 'gte', 'lte', 'or', 'neq', 'in'].forEach(m => { c[m] = () => c })
    c.then = (ok: any, err: any) => Promise.resolve({ data: (global as any).__cashDb[table] || [], error: null }).then(ok, err)
    return c
  }
  return { supabase: { from: (table: string) => chain(table) } }
})

// The page opens on the current month, so the clock is pinned: the test does not
// depend on the day it runs.
const FIXED_NOW = Date.UTC(2026, 10, 18, 12, 0, 0)
const RealDate = Date
class FixedDate extends RealDate {
  constructor(...args: any[]) {
    if (args.length === 0) super(FIXED_NOW)
    else super(...(args as [any]))
  }
  static now() { return FIXED_NOW }
}
beforeAll(() => { ;(global as any).Date = FixedDate })
afterAll(() => { ;(global as any).Date = RealDate })

const thisMonth = '2026-11'

const tx = (id: string, partner: string, type: string, subtype: string, amount: number) => ({
  id, type, tx_subtype: subtype, is_advance: false, status: 'posted',
  transaction_date: `${thisMonth}-10`, partners: { name: partner }, banks: { name: 'Banka Primer' },
  currency: 'RSD', amount, amount_rsd: amount, amount_eur: null, pl_category: null,
})

const rowOf = (partner: string) => screen.getByText(partner).closest('tr') as HTMLElement
const cardValue = (label: string) => screen.getByText(label).nextElementSibling as HTMLElement

const openPage = async () => {
  ;(global as any).__cashDb = {
    banks: [],
    transactions: [
      tx('t1', 'Kupac Primer', 'direct', 'revenue', 5000),
      tx('t2', 'Dobavljac Primer', 'direct', 'expense', 3000),
      tx('t3', 'Povratnik Primer', 'direct', 'expense', -1000),
      // Only the dinar figure carries the minus; the badge still reads it as a refund.
      { ...tx('t4', 'Samo Dinari Primer', 'direct', 'expense', 7), amount: 7, amount_rsd: -590 },
    ],
  }
  render(<CashFlow />)
  await screen.findByText('Poslednje transakcije')
}

describe('the list of recent transactions in the cash flow', () => {
  it('reads plus, minus, plus and badges the refund as Povraćaj', async () => {
    await openPage()

    const revenue = rowOf('Kupac Primer')
    expect(within(revenue).getByText(/^\+5\.000,00/)).toBeInTheDocument()
    expect(within(revenue).getByText('📥 Direktna uplata')).toBeInTheDocument()

    const expense = rowOf('Dobavljac Primer')
    expect(within(expense).getByText(/^-3\.000,00/)).toBeInTheDocument()
    expect(within(expense).getByText('📤 Direktna isplata')).toBeInTheDocument()

    const refund = rowOf('Povratnik Primer')
    expect(within(refund).getByText(/^\+1\.000,00/)).toBeInTheDocument()
    expect(within(refund).getByText('📥 Povraćaj')).toBeInTheDocument()
    expect(within(refund).queryByText(/Direktna isplata/)).not.toBeInTheDocument()
  })

  it('reads a row with only the dinar figure negative as in, with the refund badge', async () => {
    await openPage()
    const row = rowOf('Samo Dinari Primer')
    expect(within(row).getByText('📥 Povraćaj')).toBeInTheDocument()
    expect(within(row).getByText(/^\+7,00/)).toBeInTheDocument()
  })

  it('dresses the refund badge in the in colour and the expense badge in the out colour', async () => {
    await openPage()
    const refundBadge = within(rowOf('Povratnik Primer')).getByText('📥 Povraćaj')
    const expenseBadge = within(rowOf('Dobavljac Primer')).getByText('📤 Direktna isplata')
    expect(refundBadge.style.color).toBe('rgb(8, 80, 65)')
    expect(expenseBadge.style.color).toBe('rgb(163, 45, 45)')
  })

  it('totals the outflow as the expense less the refund', async () => {
    await openPage()
    expect(cardValue('Ukupni odlivi')).toHaveTextContent('1.410 RSD')
    expect(cardValue('Ukupni prilivi')).toHaveTextContent('5.000 RSD')
  })
})
