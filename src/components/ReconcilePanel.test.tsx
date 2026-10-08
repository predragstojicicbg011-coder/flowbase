import React from 'react'
import { fireEvent, render, screen, waitFor } from '@testing-library/react'
import ReconcilePanel from './ReconcilePanel'

// ─── Reconciling in the currency the bill was written in ────────────────────
//
// The input, the Max button and the figure stored are in the bill's own
// currency. The book columns (RSD, EUR) carry two different dates' rates — the
// invoice's and the payment's — so settling through them would leave a bill
// paid in its own currency short by the rate move between the two days. The
// book figures of a link are derived from the typed one at the INVOICE's
// stored rates.
//
// These tests pin the figures rather than the wording, because the figures are
// what settles a bill.

interface Call {
  table: string
  op: 'select' | 'upsert' | 'update'
  payload?: any
  filters: [string, any][]
}

/**
 * Enough of PostgREST's builder to drive this panel.
 *
 * Every method chains; the terminals (`single`, `maybeSingle`, and awaiting
 * the builder itself) answer out of `rows` after applying whatever `eq`
 * filters were recorded. Writes are pushed to `calls` so a test can read back
 * exactly what was sent, which for this panel is the entire point.
 */
function stubSupabase(rows: Record<string, any[]>, calls: Call[]) {
  const from = (table: string) => {
    const call: Call = { table, op: 'select', filters: [] }

    const settle = (one: boolean) => {
      calls.push(call)
      const all = (rows[table] || []).filter(r =>
        call.filters.every(([col, val]) =>
          Array.isArray(val) ? val.includes(r[col]) : r[col] === val))
      return Promise.resolve({ data: one ? (all[0] ?? null) : all, error: null })
    }

    const q: any = {
      select: () => q,
      update: (payload: any) => { call.op = 'update'; call.payload = payload; return q },
      upsert: (payload: any) => {
        call.op = 'upsert'; call.payload = payload; calls.push(call)
        return Promise.resolve({ data: null, error: null })
      },
      eq: (col: string, val: any) => { call.filters.push([col, val]); return q },
      in: (col: string, val: any) => { call.filters.push([col, val]); return q },
      order: () => q,
      single: () => settle(true),
      maybeSingle: () => settle(true),
      then: (onOk: any, onErr?: any) => settle(false).then(onOk, onErr),
    }
    return q
  }
  return { from }
}

let calls: Call[] = []
let rows: Record<string, any[]> = {}

jest.mock('../supabase', () => ({
  get supabase() { return (global as any).__reconcileClient },
}))

const install = () => {
  calls = []
  ;(global as any).__reconcileClient = stubSupabase(rows, calls)
}

// A real shape: 134,561.52 RSD on a day the NBS said 117.2 RSD per EUR
// (134561.52 / 117.2 = 1,148.14 EUR), paid by a bank line for exactly that
// many dinars on the same day.
const invoice = (over: Partial<any> = {}) => ({
  id: 'inv1', company_id: 'c1', invoice_number: 'H-1278/2026',
  invoice_date: '2026-08-05', currency: 'RSD',
  amount: 134561.52, exchange_rate: 1, eur_rate: 117.2,
  amount_rsd: 134561.52, amount_eur: 1148.14,
  paid_amount: 0, remaining_rsd: 134561.52,
  calculated_status: 'unpaid', partner_name: 'Generali', type: 'expense',
  ...over,
})

const payment = (over: Partial<any> = {}) => ({
  id: 'tx1', company_id: 'c1', type: 'direct', currency: 'RSD',
  amount: 134561.52, exchange_rate: 1, eur_rate: 117.2,
  amount_rsd: 134561.52, amount_eur: 1148.14, transaction_date: '2026-08-05',
  statement_number: '103',
  partners: { name: 'Generali' }, companies: { name: 'Test Company' },
  banks: { name: 'Intesa' },
  ...over,
})

const panel = (sourceType: 'transaction' | 'invoice' = 'transaction', sourceId = 'tx1') =>
  render(<ReconcilePanel sourceType={sourceType} sourceId={sourceId}
    onClose={() => {}} onReconciled={() => {}} />)

/** Tick the one candidate and hand back the allocation field. */
async function link(): Promise<HTMLInputElement> {
  const add = await screen.findByText('+ Poveži')
  fireEvent.click(add)
  return await screen.findByRole('spinbutton') as HTMLInputElement
}

const written = () => calls.find(c => c.table === 'invoice_transaction_links' && c.op === 'upsert')

describe('a payment in the same currency as the bill', () => {
  beforeEach(() => {
    rows = {
      transactions: [payment()],
      v_invoice_status: [invoice()],
      invoice_transaction_links: [],
      invoices: [invoice()],
    }
    install()
  })

  it('offers the bill in ITS OWN currency, not a round trip through the book', async () => {
    panel()
    const field = await link()
    // 134,561.52 exactly.
    expect(Number(field.value)).toBe(134561.52)
    expect(screen.getByText('RSD')).toBeInTheDocument()
  })

  it('says it settles the bill in full rather than leaving it to be worked out', async () => {
    panel()
    await link()
    expect(screen.getByText(/Zatvara ovu fakturu u celosti/)).toBeInTheDocument()
  })

  it('STORES WHAT WAS TYPED, and derives the dinars and euros from it', async () => {
    panel()
    await link()
    fireEvent.click(screen.getByText(/Sačuvaj i upari/))
    await waitFor(() => expect(written()).toBeDefined())
    expect(written()!.payload.allocated_amount).toBe(134561.52)
    // At the invoice's stored rates the whole bill is its own book figures.
    expect(written()!.payload.allocated_amount_rsd).toBe(134561.52)
    expect(written()!.payload.allocated_amount_eur).toBe(1148.14)
  })

  it('keeps a part payment to the para', async () => {
    panel()
    const field = await link()
    fireEvent.change(field, { target: { value: '100000' } })
    fireEvent.click(screen.getByText(/Sačuvaj i upari/))
    await waitFor(() => expect(written()).toBeDefined())
    expect(written()!.payload.allocated_amount).toBe(100000)
  })

  it('says what a part payment leaves owing, in the currency of the bill', async () => {
    panel()
    const field = await link()
    fireEvent.change(field, { target: { value: '100000' } })
    // 134.561,52 − 100.000,00, in the bill's own currency.
    expect(await screen.findByText(/Ostaje dug od 34\.561,52 RSD/)).toBeInTheDocument()
  })
})

describe('a bill that something has already settled part of', () => {
  beforeEach(() => {
    // 100,000 dinars already allocated; 34,561.52 left, read from what the
    // bill holds in its own currency.
    rows = {
      transactions: [payment({ amount: 34561.52, amount_rsd: 34561.52, amount_eur: 294.89 })],
      v_invoice_status: [invoice({ paid_amount: 100000, remaining_rsd: 34561.52, calculated_status: 'partial' })],
      invoice_transaction_links: [],
      invoices: [invoice({ paid_amount: 100000 })],
    }
    install()
  })

  it('reads the remainder from what the bill holds, not from a book column', async () => {
    panel()
    const field = await link()
    expect(Number(field.value)).toBe(34561.52)
    expect(screen.getByText(/Zatvara ovu fakturu u celosti/)).toBeInTheDocument()
  })
})

describe('when the source and the bill are in different currencies', () => {
  beforeEach(() => {
    rows = {
      // 1,150 EUR at the payment date's 117.3 = 134,895 RSD — more than owed.
      transactions: [payment({ currency: 'EUR', amount: 1150, exchange_rate: 117.3, eur_rate: 117.3, amount_rsd: 134895, amount_eur: 1150 })],
      v_invoice_status: [invoice()],
      invoice_transaction_links: [],
      invoices: [invoice()],
    }
    install()
  })

  it('still settles the bill exactly where the payment covers it', async () => {
    panel()
    const field = await link()
    expect(Number(field.value)).toBe(134561.52)
  })

  it('falls back to dinars (the book) for the totals AND SAYS SO', async () => {
    // A euro payment against a dinar bill has no single currency its totals
    // mean anything in. Converting one into the other would put a figure on
    // screen that is nobody's actual money.
    panel()
    await link()
    expect(screen.getByText(/nisu sve u istoj valuti/)).toBeInTheDocument()
    expect(screen.getByText(/Prikazano u RSD/)).toBeInTheDocument()
  })
})

describe('a euro bill paid in euros', () => {
  // 1,000 EUR at the invoice date's 117.2 = 117,200 RSD; paid at 117.3.
  const eurInvoice = invoice({
    currency: 'EUR', amount: 1000, exchange_rate: 117.2, eur_rate: 117.2,
    amount_rsd: 117200, amount_eur: 1000, remaining_rsd: 117200,
  })
  beforeEach(() => {
    rows = {
      transactions: [payment({ currency: 'EUR', amount: 1000, exchange_rate: 117.3, eur_rate: 117.3, amount_rsd: 117300, amount_eur: 1000 })],
      v_invoice_status: [eurInvoice],
      invoice_transaction_links: [],
      invoices: [eurInvoice],
    }
    install()
  })

  it('books the link at the INVOICE rate, so it adds up to the bill', async () => {
    panel()
    await link()
    fireEvent.click(screen.getByText(/Sačuvaj i upari/))
    await waitFor(() => expect(written()).toBeDefined())
    expect(written()!.payload).toMatchObject({
      allocated_amount: 1000, allocated_amount_rsd: 117200, allocated_amount_eur: 1000,
    })
  })
})

describe('a bill without stored rates', () => {
  beforeEach(() => {
    const bare = invoice({ currency: 'EUR', amount: 1000, exchange_rate: null, eur_rate: null, amount_rsd: null, amount_eur: null })
    rows = {
      transactions: [payment({ currency: 'EUR', amount: 1000 })],
      v_invoice_status: [bare],
      invoice_transaction_links: [],
      invoices: [bare],
    }
    install()
  })

  it('says why it cannot be allocated instead of guessing a rate', async () => {
    panel()
    fireEvent.click(await screen.findByText('+ Poveži'))
    expect(await screen.findByText(/nema exchange_rate/)).toBeInTheDocument()
    expect(written()).toBeUndefined()
  })
})

describe('opened from the invoice instead of the payment', () => {
  beforeEach(() => {
    rows = {
      invoices: [invoice()],
      v_invoice_status: [invoice()],
      transactions: [payment()],
      invoice_transaction_links: [],
    }
    install()
  })

  it('still types in the currency of the BILL, though the candidates are payments', async () => {
    // The direction decides which side is the invoice, and getting it round
    // the wrong way is how a figure once landed in another currency's column.
    panel('invoice', 'inv1')
    const field = await link()
    expect(Number(field.value)).toBe(134561.52)
    expect(screen.getByText('RSD')).toBeInTheDocument()
  })

  it('writes the link with the invoice as the invoice, not the transaction', async () => {
    panel('invoice', 'inv1')
    await link()
    fireEvent.click(screen.getByText(/Sačuvaj i upari/))
    await waitFor(() => expect(written()).toBeDefined())
    expect(written()!.payload.invoice_id).toBe('inv1')
    expect(written()!.payload.transaction_id).toBe('tx1')
    expect(written()!.payload.allocated_amount).toBe(134561.52)
  })
})
