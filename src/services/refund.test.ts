import {
  isRefundLine, bookedSign, booked, bookedAmounts, isRefundRow, REFUND_CASH_FLOW,
  REFUND_TAG, REFUND_LINE_NOTE, REFUND_SWITCH, REFUND_SWITCH_NOTE, REFUND_ONE_TIME_NOTE, refundSplitLines,
} from './refund'

const credit = { debit: null, credit: 1199.22 }

describe('isRefundLine', () => {
  it('is true for money in booked as a direct expense', () => {
    expect(isRefundLine(credit, 'direct', 'expense')).toBe(true)
  })

  it.each([
    ['a debit line', { debit: 5, credit: null }, 'direct', 'expense'],
    ['revenue', credit, 'direct', 'revenue'],
    ['invoice_payment', credit, 'invoice_payment', 'expense'],
    ['credit_payment', credit, 'credit_payment', 'expense'],
    ['passthrough', credit, 'passthrough', 'expense'],
    ['a zero credit', { debit: null, credit: 0 }, 'direct', 'expense'],
    ['a negative credit', { debit: null, credit: -3 }, 'direct', 'expense'],
    ['both columns filled', { debit: 5, credit: 5 }, 'direct', 'expense'],
  ])('is false for %s', (_name, line, type, subtype) => {
    expect(isRefundLine(line, type, subtype)).toBe(false)
  })

  it('bookedSign is -1 exactly where isRefundLine is true', () => {
    expect(bookedSign(credit, 'direct', 'expense')).toBe(-1)
    expect(bookedSign({ debit: 5, credit: null }, 'direct', 'expense')).toBe(1)
    expect(bookedSign(credit, 'direct', 'revenue')).toBe(1)
    expect(bookedSign(credit, 'invoice_payment', 'expense')).toBe(1)
    expect(bookedSign({ debit: 5, credit: 5 }, 'direct', 'expense')).toBe(1)
  })
})

describe('booked', () => {
  it('signs a magnitude and never makes minus zero', () => {
    expect(booked(1199.22, -1)).toBe(-1199.22)
    expect(booked(null, -1)).toBeNull()
    expect(booked(undefined, -1)).toBeNull()
    expect(Object.is(booked(0, -1), 0)).toBe(true)
    expect(booked(7, 1)).toBe(7)
  })
})

describe('bookedAmounts', () => {
  const book = { exchange_rate: 117.2, eur_rate: 117.2, amount_rsd: 1000, amount_eur: 8.53 }

  it('signs the two book figures together and leaves the rates alone', () => {
    expect(bookedAmounts(book, -1)).toEqual({ ...book, amount_rsd: -1000, amount_eur: -8.53 })
  })

  it('returns the same values for a sign of 1', () => {
    expect(bookedAmounts(book, 1)).toEqual(book)
  })

  it('keeps a missing figure missing', () => {
    expect(bookedAmounts({ ...book, amount_eur: null }, -1).amount_eur).toBeNull()
  })
})

describe('isRefundRow', () => {
  it('knows a stored refund', () => {
    expect(isRefundRow({ type: 'direct', tx_subtype: 'expense', amount: -5, amount_rsd: -590 })).toBe(true)
    expect(isRefundRow({ type: 'direct', tx_subtype: 'expense', amount: 5, amount_rsd: -590 })).toBe(true)
    expect(isRefundRow({ type: 'direct', tx_subtype: 'expense', amount: -5, amount_rsd: null })).toBe(true)
    expect(isRefundRow({ tx_subtype: 'expense', amount: -5, amount_rsd: -590 })).toBe(true)
  })

  it('rejects everything else', () => {
    expect(isRefundRow({ type: 'direct', tx_subtype: 'expense', amount: 5, amount_rsd: 590 })).toBe(false)
    expect(isRefundRow({ type: 'direct', tx_subtype: 'revenue', amount: -5, amount_rsd: -590 })).toBe(false)
    expect(isRefundRow({ type: 'invoice_payment', tx_subtype: 'expense', amount: -5, amount_rsd: -590 })).toBe(false)
    expect(isRefundRow({ type: 'direct', tx_subtype: null, amount: -5, amount_rsd: -590 })).toBe(false)
  })
})

describe('the words and the cash-flow fields', () => {
  it('are exactly the five sentences and the cash-flow block', () => {
    expect(REFUND_TAG).toBe('Povraćaj')
    expect(REFUND_LINE_NOTE).toBe('Povraćaj: novac je vraćen, pa ova stavka umanjuje trošak umesto da ga uvećava.')
    expect(REFUND_SWITCH).toBe('Ovo je povraćaj')
    expect(REFUND_SWITCH_NOTE).toBe('Dobavljač je vratio novac. Iznos se knjiži sa minusom i umanjuje trošak pod kojim je zaveden.')
    expect(REFUND_ONE_TIME_NOTE).toBe('Povraćaj se knjiži kao jednokratan — ne ulazi u procene narednih meseci.')
    expect(REFUND_CASH_FLOW).toEqual({
      cf_type: 'one_time', cf_frequency: null, cf_next_month_est: null,
      cf_accrual_from: null, cf_accrual_to: null, cf_capex_months: null, cf_reimbursable_date: null,
    })
  })
})

describe('refundSplitLines', () => {
  const lines = [
    { key: 'a', amount: 1000 as number | null, cf_type: 'recurring', note: 'prva', project_id: 'p1' },
    { key: 'b', amount: 199.22 as number | null, cf_type: '', note: 'druga', project_id: null },
  ]

  it('returns the same array for an ordinary cost', () => {
    expect(refundSplitLines(lines, 1)).toBe(lines)
  })

  it('negates every amount and makes every line one-time for a refund', () => {
    const out = refundSplitLines(lines, -1)
    expect(out).not.toBe(lines)
    expect(out.map(l => l.amount)).toEqual([-1000, -199.22])
    expect(out.map(l => l.cf_type)).toEqual(['one_time', 'one_time'])
    // The input is left as it was.
    expect(lines.map(l => [l.amount, l.cf_type])).toEqual([[1000, 'recurring'], [199.22, '']])
  })

  it('keeps a null amount null and every other field untouched', () => {
    const out = refundSplitLines([{ key: 'c', amount: null, cf_type: 'recurring', note: 'treca', project_id: 'p2' }], -1)
    expect(out).toEqual([{ key: 'c', amount: null, cf_type: 'one_time', note: 'treca', project_id: 'p2' }])
  })
})
