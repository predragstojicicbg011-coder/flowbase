import React from 'react'
import { render, screen } from '@testing-library/react'
import { buildEntryItems, CF_BADGES, DRILL_CAP, EntryRow, type EntryItem } from './EntriesModal'
import { DisplayCurrencyProvider } from '../contexts/DisplayCurrencyContext'

// The module imports the real Supabase client for `useEntryEditor`, and the
// two dialogs it opens drag in half the app. None of that is needed to test
// `buildEntryItems`, which takes its client as an argument precisely so it can
// be driven by the stub below.
jest.mock('../supabase', () => ({ supabase: {} }))
jest.mock('./TransactionDialog', () => ({ __esModule: true, default: () => null }))
jest.mock('./InvoiceDialog', () => ({ __esModule: true, default: () => null }))

/**
 * A client that answers `.from(t).select(…).in('id', ids)` out of a lookup,
 * returning the rows in the order the ids were asked for — which is how a real
 * `.in()` behaves least helpfully: it promises no ordering at all.
 */
const stubClient = (byId: Record<string, any>) => ({
  from: (_table: string) => ({
    select: (_cols: string) => ({
      in: (_col: string, ids: string[]) =>
        Promise.resolve({ data: ids.map(id => byId[id]).filter(Boolean), error: null }),
    }),
  }),
})

const day = (n: number) => `2026-03-${String(n).padStart(2, '0')}`

/** 1,100 expense rows across March, ascending by date — as a paged read returns them. */
const ascendingMonth = () => {
  const rows: { id: string; source: string; pl_date: string }[] = []
  const tx: Record<string, any> = {}
  for (let i = 0; i < 1100; i++) {
    const id = `t${String(i).padStart(4, '0')}`
    const d = day(1 + Math.floor(i / 40))   // 40 rows a day, days 1–28
    rows.push({ id, source: 'transaction', pl_date: d })
    tx[id] = {
      id, transaction_date: d, amount: 100, amount_rsd: 100, currency: 'RSD',
      pl_category: 'Opex', department: 'Sales', expense_description: 'Ads',
      cf_type: null, note: null, partners: { name: `Vendor ${i}` },
    }
  }
  return { rows, tx }
}

describe('building the entries behind a drill-down', () => {
  it('keeps the newest rows when the input arrives oldest-first', async () => {
    const { rows, tx } = ascendingMonth()

    const { items, total, capped } = await buildEntryItems(rows, stubClient(tx))

    expect(total).toBe(1100)
    expect(capped).toBe(true)
    expect(items).toHaveLength(DRILL_CAP)

    // The regression: slicing before sorting kept rows 0–299, which are the
    // 1st to the 8th of the month, and then sorted those newest-first so the
    // list looked right while missing the last three weeks entirely.
    expect(items[0].date).toBe(day(28))
    expect(items[items.length - 1].date).toBe(day(21))
    expect(items.map(i => i.date)).not.toContain(day(1))
    expect(items.map(i => i.id)).toContain('t1099')
    expect(items.map(i => i.id)).not.toContain('t0000')
  })

  it('titles a row with no partner by its note rather than a dash', async () => {
    const tx = { n1: { id: 'n1', transaction_date: day(3), amount: 5, amount_rsd: 5, currency: 'RSD',
      pl_category: 'Opex', department: 'Sales', cf_type: null, note: 'Kafa za sastanak', partners: null } }
    const { items } = await buildEntryItems([{ id: 'n1', source: 'transaction', pl_date: day(3) }], stubClient(tx))
    expect(items[0].title).toBe('Kafa za sastanak')
  })

  it('returns the list newest-first', async () => {
    const { rows, tx } = ascendingMonth()
    const { items } = await buildEntryItems(rows, stubClient(tx))
    const dates = items.map(i => i.date)
    expect([...dates].sort().reverse()).toEqual(dates)
  })

  it('does not reorder the caller array', async () => {
    const { rows, tx } = ascendingMonth()
    const before = rows.map(r => r.id)
    await buildEntryItems(rows, stubClient(tx))
    expect(rows.map(r => r.id)).toEqual(before)
  })

  it('interleaves invoices and transactions by date', async () => {
    const rows = [
      { id: 'a', source: 'transaction', pl_date: day(1) },
      { id: 'b', source: 'invoice', pl_date: day(2) },
      { id: 'c', source: 'transaction', pl_date: day(3) },
    ]
    const client = stubClient({
      a: { id: 'a', transaction_date: day(1), amount: 1, amount_rsd: 1, currency: 'RSD', partners: null },
      b: { id: 'b', invoice_date: day(2), invoice_number: 'INV-1', amount: 2, amount_rsd: 2, currency: 'RSD', partners: null },
      c: { id: 'c', transaction_date: day(3), amount: 3, amount_rsd: 3, currency: 'RSD', partners: null },
    })

    const { items, capped } = await buildEntryItems(rows, client)

    expect(capped).toBe(false)
    expect(items.map(i => i.id)).toEqual(['c', 'b', 'a'])
    expect(items[1].edit).toEqual({ table: 'invoices', id: 'b' })
  })

  it('reports an uncapped list as the whole list', async () => {
    const rows = [{ id: 'a', source: 'transaction', pl_date: day(1) }]
    const client = stubClient({
      a: { id: 'a', transaction_date: day(1), amount: 1, amount_rsd: 1, currency: 'RSD', partners: null },
    })
    const { items, total, capped } = await buildEntryItems(rows, client)
    expect(total).toBe(1)
    expect(capped).toBe(false)
    expect(items).toHaveLength(1)
  })
})

describe('an entry row', () => {
  const item: EntryItem = {
    id: 'x', title: 'Telekom Srbija', date: '2026-03-04',
    amount: 100, currency: 'EUR', amount_rsd: 11720, amount_eur: 100,
    edit: { table: 'transactions', id: 'x' },
  }

  it('leads with the display-currency figure and keeps the original beneath it', () => {
    render(<EntryRow item={item} onEdit={() => {}} />)
    expect(screen.getByText('11.720,00 RSD')).toBeInTheDocument()
    expect(screen.getByText('100,00 EUR')).toBeInTheDocument()
  })

  it('prints the EUR figure once, not twice, when the viewer reads EUR', () => {
    render(<DisplayCurrencyProvider initial="EUR"><EntryRow item={item} onEdit={() => {}} /></DisplayCurrencyProvider>)
    expect(screen.getAllByText('100,00 EUR')).toHaveLength(1)
    expect(screen.queryByText(/RSD/)).not.toBeInTheDocument()
  })

  it('falls back to the original amount where the row has no figure in the display currency', () => {
    render(<DisplayCurrencyProvider initial="EUR">
      <EntryRow item={{ ...item, currency: 'RSD', amount: 5000, amount_rsd: 5000, amount_eur: null }} onEdit={() => {}} />
    </DisplayCurrencyProvider>)
    expect(screen.getByText('5.000,00 RSD')).toBeInTheDocument()
  })
})

describe('a refund row in the drill-down', () => {
  const base: EntryItem = {
    id: 'r1', title: 'Hosting Primer doo', date: '2026-03-04', path: 'Operating Expenses / Administration', note: null,
    amount: -1199.22, currency: 'RSD', amount_rsd: -1199.22, amount_eur: -10.23,
    txType: 'direct', txSubtype: 'expense',
    edit: { table: 'transactions', id: 'r1' },
  }
  const show = (item: EntryItem) => render(<EntryRow item={item} onEdit={() => {}} />)

  it('prints its minus in the in colour and carries the Povraćaj tag', () => {
    show(base)
    const figure = screen.getByText('-1.199,22 RSD')
    expect(figure.style.color).toBe('rgb(0, 212, 126)')
    expect(screen.getByText('Povraćaj')).toBeInTheDocument()
  })

  it('leaves a positive transaction in the cost red with no tag', () => {
    show({ ...base, amount: 80, amount_rsd: 80, amount_eur: 0.68 })
    expect(screen.getByText('80,00 RSD').style.color).toBe('rgb(255, 91, 90)')
    expect(screen.queryByText('Povraćaj')).not.toBeInTheDocument()
  })

  it('prints the minus of a credit note and gives it no tag', () => {
    show({ ...base, txType: undefined, txSubtype: undefined, edit: { table: 'invoices', id: 'r1' } })
    const figure = screen.getByText('-1.199,22 RSD')
    expect(figure.style.color).toBe('rgb(255, 91, 90)')
    expect(screen.queryByText('Povraćaj')).not.toBeInTheDocument()
  })

  it('does not tag a negative row whose subtype is missing', () => {
    show({ ...base, txSubtype: null })
    expect(screen.queryByText('Povraćaj')).not.toBeInTheDocument()
  })

  it('does not tag a negative revenue or a negative invoice payment', () => {
    const { unmount } = show({ ...base, txSubtype: 'revenue' })
    expect(screen.queryByText('Povraćaj')).not.toBeInTheDocument()
    unmount()
    show({ ...base, txType: 'invoice_payment' })
    expect(screen.queryByText('Povraćaj')).not.toBeInTheDocument()
  })

  it('keeps the Refund. badge of a reimbursable row next to the new tag', () => {
    show({ ...base, badges: [CF_BADGES.reimbursable] })
    expect(screen.getByText('Refund.')).toBeInTheDocument()
    expect(screen.getByText('Povraćaj')).toBeInTheDocument()
  })

  it('keeps the Refund. badge of a positive reimbursable row without the tag', () => {
    show({ ...base, amount: 80, amount_rsd: 80, badges: [CF_BADGES.reimbursable] })
    expect(screen.getByText('Refund.')).toBeInTheDocument()
    expect(screen.queryByText('Povraćaj')).not.toBeInTheDocument()
  })

  it('reads the kind of a transaction from the select and carries it on the item', async () => {
    const seen: string[] = []
    const row = {
      id: 'a', type: 'direct', tx_subtype: null, transaction_date: day(1), amount: -5, amount_rsd: -5,
      currency: 'RSD', partners: null,
    }
    const client = {
      from: () => ({
        select: (cols: string) => {
          seen.push(cols)
          return { in: () => Promise.resolve({ data: [row], error: null }) }
        },
      }),
    }
    const { items } = await buildEntryItems([{ id: 'a', source: 'transaction', pl_date: day(1) }], client)
    expect(seen[0]).toMatch(/\btype\b/)
    expect(seen[0]).toMatch(/tx_subtype/)
    // Passed straight through: a missing subtype is not turned into an expense.
    expect(items[0].txType).toBe('direct')
    expect(items[0].txSubtype).toBeNull()
  })
})
