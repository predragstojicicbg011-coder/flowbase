import {
  doubleCountHint, effectiveAdvance, openRevenueInvoicesOf, paymentSubtypeFor, whyAdvanceNotSavable,
} from './advanceReceipt'

describe('effectiveAdvance', () => {
  it('holds only on a direct revenue receipt', () => {
    expect(effectiveAdvance('direct', 'revenue', true)).toBe(true)
    expect(effectiveAdvance('direct', 'expense', true)).toBe(false)
    expect(effectiveAdvance('invoice_payment', 'revenue', true)).toBe(false)
    expect(effectiveAdvance('passthrough', 'revenue', true)).toBe(false)
    expect(effectiveAdvance('direct', 'revenue', false)).toBe(false)
  })
})

describe('whyAdvanceNotSavable', () => {
  const base = { type: 'direct', subtype: 'revenue', isAdvance: true, projectId: 'p1' }
  it('accepts an advance on a project', () => {
    expect(whyAdvanceNotSavable(base)).toBeNull()
  })
  it('refuses one without a project', () => {
    expect(whyAdvanceNotSavable({ ...base, projectId: null })).toMatch(/projekt/)
  })
  it('refuses a split or a link', () => {
    expect(whyAdvanceNotSavable({ ...base, splitLines: 2 })).toMatch(/deli/)
    expect(whyAdvanceNotSavable({ ...base, linkedInvoices: 1 })).toMatch(/fakturom/)
  })
  it('says nothing about a row that is not an advance', () => {
    expect(whyAdvanceNotSavable({ ...base, subtype: 'expense', projectId: null })).toBeNull()
    expect(whyAdvanceNotSavable({ ...base, isAdvance: false, projectId: null })).toBeNull()
  })
})

describe('paymentSubtypeFor', () => {
  it('is the invoices\' type when they share one', () => {
    expect(paymentSubtypeFor(['revenue'])).toBe('revenue')
    expect(paymentSubtypeFor(['expense', 'expense'])).toBe('expense')
  })
  it('falls back when they disagree or are unknown', () => {
    expect(paymentSubtypeFor(['expense', 'revenue'], 'expense')).toBe('expense')
    expect(paymentSubtypeFor([null, undefined])).toBeNull()
    expect(paymentSubtypeFor([], 'revenue')).toBe('revenue')
  })
  it('an unknown type beside a known one is the known one', () => {
    expect(paymentSubtypeFor(['revenue', null])).toBe('revenue')
  })
})

describe('the double-count hint', () => {
  const invoices = [
    { id: 'a', type: 'revenue', partner_id: 'inv', invoice_number: 'IF-1', currency: 'RSD', amount: 1000, paid_amount: 0, advance_deducted: 0, calculated_status: 'unpaid' },
    { id: 'b', type: 'revenue', partner_id: 'inv', invoice_number: 'IF-2', currency: 'RSD', amount: 1000, paid_amount: 600, advance_deducted: 400, calculated_status: 'paid' },
    { id: 'c', type: 'expense', partner_id: 'inv', invoice_number: 'UF-1', currency: 'RSD', amount: 1000, paid_amount: 0, calculated_status: 'unpaid' },
    { id: 'd', type: 'revenue', partner_id: 'other', invoice_number: 'IF-3', currency: 'RSD', amount: 1000, paid_amount: 0, calculated_status: 'unpaid' },
  ]
  it('finds the partner\'s open revenue invoices only', () => {
    expect(openRevenueInvoicesOf('inv', invoices).map(i => i.id)).toEqual(['a'])
    expect(openRevenueInvoicesOf(null, invoices)).toEqual([])
  })
  it('speaks for a direct revenue receipt', () => {
    const h = doubleCountHint({ type: 'direct', subtype: 'revenue' }, 'inv', invoices)
    expect(h).toContain('IF-1')
    expect(h).toContain('plaćanje fakture')
  })
  it('is silent for an advance, an expense, or a partner with nothing open', () => {
    expect(doubleCountHint({ type: 'direct', subtype: 'revenue', isAdvance: true }, 'inv', invoices)).toBeNull()
    expect(doubleCountHint({ type: 'direct', subtype: 'expense' }, 'inv', invoices)).toBeNull()
    expect(doubleCountHint({ type: 'direct', subtype: 'revenue' }, 'nobody', invoices)).toBeNull()
  })
})

describe('receiptShape', () => {
  const { receiptShape } = require('./advanceReceipt')
  it('a direct revenue receipt is P&L revenue', () => {
    expect(receiptShape({ type: 'direct', subtype: 'revenue' })).toEqual({ tx_subtype: 'revenue', is_advance: false, pl_impact: true })
  })
  it('an advance is a direct revenue receipt with no P&L', () => {
    expect(receiptShape({ type: 'direct', subtype: 'revenue', isAdvance: true })).toEqual({ tx_subtype: 'revenue', is_advance: true, pl_impact: false })
  })
  it('the flag falls away on an expense or a payment', () => {
    expect(receiptShape({ type: 'direct', subtype: 'expense', isAdvance: true }).is_advance).toBe(false)
    expect(receiptShape({ type: 'invoice_payment', subtype: 'revenue', isAdvance: true, invoiceType: 'revenue' }))
      .toEqual({ tx_subtype: 'revenue', is_advance: false, pl_impact: false })
  })
  it('an invoice payment takes the invoice\'s side, else the bank\'s', () => {
    expect(receiptShape({ type: 'invoice_payment', subtype: 'expense', invoiceType: 'revenue', bankSide: 'expense' }).tx_subtype).toBe('revenue')
    expect(receiptShape({ type: 'invoice_payment', subtype: 'expense', bankSide: 'revenue' }).tx_subtype).toBe('revenue')
    expect(receiptShape({ type: 'invoice_payment', subtype: 'expense' }).tx_subtype).toBeNull()
  })
  it('a credit payment has no P&L of its own here', () => {
    expect(receiptShape({ type: 'credit_payment', subtype: 'expense' })).toEqual({ tx_subtype: 'expense', is_advance: false, pl_impact: false })
  })
})
