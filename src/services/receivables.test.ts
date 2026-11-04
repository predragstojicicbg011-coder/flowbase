import {
  isReceivable, receivableTotals, receivablesIn, latePayers, sefFlags, DUE_SOON_DAYS,
} from './receivables'
import type { RevenueListRow } from './revenuePage'

const TODAY = '2026-11-04'
const row = (id: string, over: Partial<RevenueListRow>): RevenueListRow => ({
  id, type: 'revenue', project_id: null, invoice_date: '2026-09-01',
  amount: 0, amount_rsd: 0, amount_eur: 0, partner_id: 'p-' + id, partner_name: 'Kupac ' + id,
  ...over,
})
const rows: RevenueListRow[] = [
  row('A', { due_date: '2026-10-20', remaining_rsd: 100000, remaining_eur: 850 }),
  row('B', { due_date: '2026-11-04', remaining_rsd: 50000, remaining_eur: 425 }),
  row('C', { due_date: '2026-11-11', remaining_rsd: 30000, remaining_eur: 255 }),
  row('D', { due_date: '2026-11-12', remaining_rsd: 20000, remaining_eur: 170 }),
  row('E', { due_date: '2026-11-01', document_type: 'proforma', remaining_rsd: 40000, remaining_eur: 340 }),
  row('F', { due_date: '2026-10-01', remaining_rsd: 0, remaining_eur: 0 }),
  row('G', { due_date: null, remaining_rsd: 10000, remaining_eur: 85 }),
]

describe('receivables', () => {
  it('adds up what customers owe, what falls due within seven days and what is late', () => {
    expect(DUE_SOON_DAYS).toBe(7)
    const t = receivableTotals(rows, TODAY, 'RSD')
    expect(t.total).toBe(210000)
    expect(t.dueSoon).toBe(80000)
    expect(t.overdue).toBe(100000)
    expect(t.counts).toEqual({ all: 5, dueSoon: 2, overdue: 1 })
    expect(t.proformasAwaiting).toEqual({ count: 1, amount: 40000 })
    expect(t.unconverted).toBe(0)
  })

  it('counts in euros at the rate of each invoice', () => {
    const t = receivableTotals(rows, TODAY, 'EUR')
    expect(t.total).toBe(1785)
    expect(t.overdue).toBe(850)
    expect(t.proformasAwaiting).toEqual({ count: 1, amount: 340 })
  })

  it('leaves out advance invoices and counts rows without a figure as unconverted', () => {
    const extra = [
      row('H', { document_type: 'advance_invoice', remaining_rsd: 5000 }),
      row('I', { due_date: '2026-10-01', remaining_rsd: 7000 }),
    ]
    expect(isReceivable(extra[0])).toBe(false)
    const t = receivableTotals(extra, TODAY, 'EUR')
    expect(t.total).toBe(0)
    expect(t.unconverted).toBe(1)
  })

  it('lists receivables in a bucket by due date', () => {
    expect(receivablesIn(rows, 'overdue', TODAY).map(r => r.id)).toEqual(['A'])
    expect(receivablesIn(rows, 'dueSoon', TODAY).map(r => r.id)).toEqual(['B', 'C'])
    expect(receivablesIn(rows, 'all', TODAY).map(r => r.id)).toEqual(['A', 'B', 'C', 'D', 'G'])
  })

  it('lists late payers by amount', () => {
    const late = [
      row('x1', { partner_id: 'X', partner_name: 'Kupac X', due_date: '2026-10-20', remaining_rsd: 100000 }),
      row('x2', { partner_id: 'X', partner_name: 'Kupac X', due_date: '2026-10-01', remaining_rsd: 25000 }),
      row('y1', { partner_id: 'Y', partner_name: 'Kupac Y', due_date: '2026-10-30', remaining_rsd: 60000 }),
      row('z1', { partner_id: 'Z', partner_name: 'Kupac Z', due_date: '2026-11-10', remaining_rsd: 999999 }),
    ]
    const p = latePayers(late, TODAY, 'RSD')
    expect(p.map(x => x.partnerName)).toEqual(['Kupac X', 'Kupac Y'])
    expect(p[0]).toEqual({
      partnerId: 'X', partnerName: 'Kupac X', amount: 125000, oldestDue: '2026-10-01',
      daysLate: 34, count: 2, oldestInvoiceId: 'x2',
    })
    expect(p[1].amount).toBe(60000)
  })

  it('flags invoices voided on SEF or paid on SEF but not in the bank statement', () => {
    const flags = sefFlags(
      [{ id: '1', calculated_status: 'unpaid' }, { id: '2', calculated_status: 'partial' },
        { id: '3', calculated_status: 'paid' }, { id: '4' }],
      [
        { imported_invoice_id: '1', sef_status: 'Storno' },
        { imported_invoice_id: '2', sef_status: 'Paid' },
        { imported_invoice_id: '3', sef_status: 'Paid' },
        { imported_invoice_id: null, sef_status: 'Storno' },
        { imported_invoice_id: '4', sef_status: 'Approved' },
      ],
    )
    expect(flags.get('1')).toBe('voided')
    expect(flags.get('2')).toBe('paid_on_sef')
    expect(flags.has('3')).toBe(false)
    expect(flags.has('4')).toBe(false)
    expect(flags.size).toBe(2)
  })
})
