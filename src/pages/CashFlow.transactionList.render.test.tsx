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

const thisMonth = new Date().toISOString().slice(0, 7)

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

  it('dresses the refund badge in the in colour and the expense badge in the out colour', async () => {
    await openPage()
    const refundBadge = within(rowOf('Povratnik Primer')).getByText('📥 Povraćaj')
    const expenseBadge = within(rowOf('Dobavljac Primer')).getByText('📤 Direktna isplata')
    expect(refundBadge.style.color).toBe('rgb(8, 80, 65)')
    expect(expenseBadge.style.color).toBe('rgb(163, 45, 45)')
  })

  it('totals the outflow as the expense less the refund', async () => {
    await openPage()
    expect(cardValue('Ukupni odlivi')).toHaveTextContent('2.000 RSD')
    expect(cardValue('Ukupni prilivi')).toHaveTextContent('5.000 RSD')
  })
})
