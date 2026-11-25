import React from 'react'
import { fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import Transactions from './Transactions'

/**
 * Deleting a credit payment's BANK LINE alone.
 *
 * Since 20261125090000 a statement stamps the instalment it paid with the bank
 * line, so deleting that line from the General Ledger reopens the instalment --
 * and the principal and interest legs it posted stay in the P&L. The question
 * before the delete has to say so, in plain words, or paying the instalment
 * again books it twice. Every firm is invented.
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
    c.single = () => Promise.resolve({ data: rowsOf(table)[0] ?? null, error: null })
    c.then = (ok: any, err: any) => Promise.resolve(result()).then(ok, err)
    return c
  }
  return { supabase: { from: (table: string) => chain(table) } }
})

const tx = (id: string, note: string, over: Record<string, any>) => ({
  id, note, partners: { name: 'Banka Primer' }, partner_id: 'p1', bank_id: 'b1', import_batch_id: 'batch-1',
  transaction_date: '2026-10-13', tx_subtype: 'expense',
  companies: { name: 'Gradnja Primer doo' }, banks: { name: 'Banka Primer' },
  amount: 1200, currency: 'RSD', amount_rsd: 1200, amount_eur: null,
  ...over,
})

const openTransactions = async (rows: any[], instalments: any[]) => {
  ;(global as any).__ledgerDb = { transactions: rows, v_invoice_status: [], credit_installments: instalments }
  render(<Transactions />)
  fireEvent.click(await screen.findByText(/Transakcije/, { selector: 'button, button *' }))
  await screen.findByText(rows[0].note)
}

/** Press Obriši on a row and return what the confirm asked; nothing is deleted. */
const askedOnDelete = async (note: string): Promise<string> => {
  const confirm = jest.spyOn(window, 'confirm').mockImplementation(() => false)
  const tr = screen.getByText(note).closest('tr') as HTMLElement
  fireEvent.click(within(tr).getByText('···'))
  fireEvent.click(within(tr).getByText('🗑 Obriši'))
  await waitFor(() => expect(confirm).toHaveBeenCalled())
  const text = String(confirm.mock.calls[0][0])
  confirm.mockRestore()
  return text
}

const LEGS_STAY = 'Brisanje ponovo otvara ratu, ali redovi glavnice i kamate koje je proknjižila (2 reda) '
  + 'ostaju u P&L-u. Obrišite i te redove, ili umesto toga obrišite ceo izvod — inače će rata '
  + 'biti proknjižena dvaput kada se ponovo plati.'

describe('deleting a credit payment’s bank line alone', () => {
  it('says the principal and interest rows stay in the P&L when the line settled an instalment', async () => {
    await openTransactions([
      tx('t-line', 'KREDIT RATA 4', { type: 'credit_payment', pl_impact: false }),
      tx('t-p', 'GLAVNICA RATA 4', { type: 'credit_payment', pl_impact: true, amount: 1000 }),
      tx('t-i', 'KAMATA RATA 4', { type: 'credit_payment', pl_impact: true, amount: 200 }),
    ], [{ id: 'i1' }])
    const text = await askedOnDelete('KREDIT RATA 4')
    expect(text).toContain('To je stavka izvoda kojom je plaćen kredit; platila je 1 ratu kredita.')
    expect(text).toContain(LEGS_STAY)
  })

  it('says one row for an interest-only instalment', async () => {
    await openTransactions([
      tx('t-line', 'KREDIT RATA 1', { type: 'credit_payment', pl_impact: false }),
      tx('t-i', 'KAMATA RATA 1', { type: 'credit_payment', pl_impact: true, amount: 350 }),
    ], [{ id: 'i1' }])
    expect(await askedOnDelete('KREDIT RATA 1')).toContain(
      'ali red glavnice ili kamate koji je proknjižila ostaje u P&L-u. Obrišite i taj red,')
  })

  it('asks the plain question for a leg, which reopens nothing', async () => {
    await openTransactions([tx('t-leg', 'KAMATA RATA 4', { type: 'credit_payment', pl_impact: true })], [{ id: 'i1' }])
    expect(await askedOnDelete('KAMATA RATA 4')).toBe('Obrisati ovu transakciju?')
  })

  it('asks the plain question for an ordinary row', async () => {
    await openTransactions([tx('t-x', 'KANCELARIJSKI MATERIJAL', { type: 'direct', pl_impact: true, pl_category: 'Kancelarija' })], [])
    expect(await askedOnDelete('KANCELARIJSKI MATERIJAL')).toBe('Obrisati ovu transakciju?')
  })

  it('asks the plain question for a credit bank line that settled nothing', async () => {
    await openTransactions([tx('t-line', 'KREDIT RATA 5', { type: 'credit_payment', pl_impact: false })], [])
    expect(await askedOnDelete('KREDIT RATA 5')).toBe('Obrisati ovu transakciju?')
  })
})
