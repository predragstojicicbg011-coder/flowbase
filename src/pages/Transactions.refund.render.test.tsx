import React from 'react'
import { fireEvent, render, screen, within } from '@testing-library/react'
import Transactions from './Transactions'

/**
 * A refund is a direct expense with a minus. The General Ledger keeps the minus
 * on the amount and tags the row Povraćaj beside the type. A charge, a revenue
 * and a negative payment of an invoice are not tagged. Every firm is invented.
 */

jest.setTimeout(30000)

jest.mock('../contexts/AuthContext', () => ({
  ...jest.requireActual('../contexts/AuthContext'),
  useAuth: () => ({ user: { id: 'u1' }, canSeePage: () => true }),
}))
jest.mock('../contexts/CompaniesContext', () => ({
  useCompanies: () => ({ companies: [{ id: 'c1', name: 'Gradnja Primer doo', currency: 'RSD', currencies: ['RSD'] }], showPicker: false }),
}))
jest.mock('../contexts/ProjectsContext', () => ({ useProjects: () => ({ projects: [], loading: false }) }))
jest.mock('../contexts/DataRefreshContext', () => ({ useDataRefresh: () => ({ invalidate: () => {} }) }))

jest.mock('../components/TransactionDialog', () => ({ __esModule: true, default: () => null }))
jest.mock('../components/InvoiceDialog', () => ({ __esModule: true, default: () => null }))
jest.mock('../components/PassthroughDialog', () => ({ __esModule: true, default: () => null }))
jest.mock('../components/BulkImport', () => ({ __esModule: true, default: () => null }))
jest.mock('../components/SefInboxDialog', () => ({ __esModule: true, default: () => null }))
jest.mock('../components/BankStatementDialog', () => ({ __esModule: true, default: () => null }))
jest.mock('../components/PayrollImportDialog', () => ({ __esModule: true, default: () => null }))
jest.mock('../components/ReconcilePanel', () => ({ __esModule: true, default: () => null }))
jest.mock('../components/AutoMatchPanel', () => ({ __esModule: true, default: () => null }))
jest.mock('../components/InvoiceDocumentsDialog', () => ({ __esModule: true, default: () => null }))

jest.mock('../supabase', () => {
  const rowsOf = (table: string): any[] => (global as any).__ledgerDb[table] || []
  const chain = (table: string) => {
    const st = { head: false, from: 0 }
    const result = () => {
      const rows = rowsOf(table)
      if (st.head) return { count: rows.length, data: null, error: null }
      return { data: st.from > 0 ? [] : rows, error: null }
    }
    const c: any = {}
    c.select = (_cols: string, opts?: any) => { if (opts && opts.head) st.head = true; return c }
    c.range = (from: number) => { st.from = from; return c }
    ;['order', 'eq', 'neq', 'gt', 'gte', 'lt', 'lte', 'in', 'is', 'not', 'filter', 'limit', 'ilike', 'or']
      .forEach(m => { c[m] = () => c })
    c.single = () => Promise.resolve({ data: null, error: null })
    c.then = (ok: any, err: any) => Promise.resolve(result()).then(ok, err)
    return c
  }
  return { supabase: { from: (table: string) => chain(table) } }
})

const tx = (id: string, note: string, amount: number, over: Record<string, any> = {}) => ({
  id, note, partners: { name: 'Hosting Primer doo' }, partner_id: 'p1',
  transaction_date: '2026-08-31', type: 'direct', tx_subtype: 'expense',
  pl_impact: true, pl_category: 'Operating Expenses',
  companies: { name: 'Gradnja Primer doo' }, banks: { name: 'Banka Primer' },
  amount, currency: 'RSD', amount_rsd: amount, amount_eur: null,
  ...over,
})

const openTransactions = async (rows: any[]) => {
  ;(global as any).__ledgerDb = { transactions: rows, v_invoice_status: [] }
  render(<Transactions />)
  fireEvent.click(await screen.findByText(/Transakcije/, { selector: 'button, button *' }))
  await screen.findByText(rows[0].note)
}

// The page's own tab styles mix `borderBottom` with `borderBottomColor`, so React warns on
// every tab switch. That is the page, not this test: only that one message is swallowed.
const realError = console.error
beforeAll(() => {
  console.error = (...args: any[]) => {
    if (args.map(String).join(' ').includes('a style property during rerender')) return
    realError(...args)
  }
})
afterAll(() => { console.error = realError })

const rowOf = (note: string) => screen.getByText(note).closest('tr') as HTMLElement

describe('a refund in the General Ledger', () => {
  it('tags a negative direct expense Povraćaj and keeps its minus', async () => {
    await openTransactions([
      tx('t1', 'Hosting mart', 1784.4),
      tx('t2', 'Hosting povracaj', -1199.22),
    ])
    const refund = rowOf('Hosting povracaj')
    expect(within(refund).getByText('Povraćaj')).toBeInTheDocument()
    expect(within(refund).getAllByText(/^-1[.,]199,22/).length).toBeGreaterThan(0)

    const charge = rowOf('Hosting mart')
    expect(within(charge).queryByText('Povraćaj')).not.toBeInTheDocument()
  })

  it('does not tag a negative revenue or a negative invoice payment', async () => {
    await openTransactions([
      tx('t3', 'Storno prihoda', -50, { tx_subtype: 'revenue' }),
      tx('t4', 'Storno uplate fakture', -60, { type: 'invoice_payment' }),
    ])
    expect(within(rowOf('Storno prihoda')).queryByText('Povraćaj')).not.toBeInTheDocument()
    expect(within(rowOf('Storno uplate fakture')).queryByText('Povraćaj')).not.toBeInTheDocument()
  })
})
