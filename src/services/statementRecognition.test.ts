import { matchOpenInvoice, classifyFromHistory, owedNow, hasOpenBill, type RecognitionRow, type OpenBill, type PastBooking } from './statementRecognition'

// A statement line recognised by rules alone: the open bill it pays, or the
// way the partner's earlier lines were booked. Measured on Mintflow's history
// (22.10.2026): a reference or bill number on one open bill was right 178 of
// 178 times, the one open bill of the same amount 364 of 364; several bills
// of the same amount only 6 of 12, so those are offered, not chosen.

const row = (over: Partial<RecognitionRow> = {}): RecognitionRow => ({
  partnerId: 'p1', isExpense: true, amount: 12000, currency: 'RSD', date: '2026-10-10',
  reference: '', description: 'Uplata po racunu', ...over,
})

const bill = (id: string, over: Partial<OpenBill> = {}): OpenBill => ({
  id, partner_id: 'p1', type: 'expense', invoice_number: `F-${id}`, reference_number: null,
  invoice_date: '2026-10-01', currency: 'RSD', amount: 12000, paid_amount: 0, adjustments: 0, advance_used: 0, ...over,
})

describe('the open bill a statement line pays', () => {
  it('is found by the reference number', () => {
    const m = matchOpenInvoice(row({ reference: '97 12-2026-555', amount: 999 }), [bill('a'), bill('b', { reference_number: '12-2026-555' })])
    expect(m).toEqual({ kind: 'invoice', invoiceId: 'b', reason: 'reference' })
  })

  it('is found by its number in the description', () => {
    const m = matchOpenInvoice(row({ description: 'Placanje po fakturi IF-7921/26', amount: 999 }), [bill('a', { invoice_number: 'IF-7921/26' }), bill('b')])
    expect(m).toEqual({ kind: 'invoice', invoiceId: 'a', reason: 'number' })
  })

  it('is the one open bill of the same amount', () => {
    const m = matchOpenInvoice(row(), [bill('a'), bill('b', { amount: 5000 })])
    expect(m).toEqual({ kind: 'invoice', invoiceId: 'a', reason: 'amount' })
  })

  it('counts what is still owed: a partly paid bill, a credit note, an advance', () => {
    expect(matchOpenInvoice(row({ amount: 7000 }), [bill('a', { amount: 10000, paid_amount: 3000 })])).toMatchObject({ invoiceId: 'a' })
    expect(owedNow(bill('a', { amount: 10000, adjustments: -2000, advance_used: 1000, paid_amount: 500 }))).toBe(6500)
    expect(owedNow(bill('a', { type: 'revenue', amount: 10000, advance_deducted: 4000 }))).toBe(6000)
  })

  it('offers several bills of the same amount instead of choosing one', () => {
    const m = matchOpenInvoice(row(), [bill('a'), bill('b')])
    expect(m).toEqual({ kind: 'ambiguous', candidates: ['a', 'b'], reason: 'amount' })
  })

  it('looks only at the partner, the direction, the currency and bills issued by then', () => {
    expect(matchOpenInvoice(row(), [bill('a', { partner_id: 'p2' })])).toBeNull()
    expect(matchOpenInvoice(row(), [bill('a', { type: 'revenue' })])).toBeNull()
    expect(matchOpenInvoice(row(), [bill('a', { currency: 'EUR', amount: 12000 })])).toBeNull()
    expect(matchOpenInvoice(row(), [bill('a', { invoice_date: '2026-11-01' })])).toBeNull()
    expect(matchOpenInvoice(row({ partnerId: null }), [bill('a')])).toBeNull()
  })

  it('a bill dated a few days after the payment still counts', () => {
    expect(matchOpenInvoice(row(), [bill('a', { invoice_date: '2026-10-14' })])).toMatchObject({ invoiceId: 'a' })
  })

  it('leaves out bills other lines of this import have already taken', () => {
    expect(matchOpenInvoice(row(), [bill('a'), bill('b')], new Set(['a']))).toMatchObject({ kind: 'invoice', invoiceId: 'b' })
  })

  it('does not take a short number or a bare digit for a bill number', () => {
    expect(matchOpenInvoice(row({ description: 'Racun 12', amount: 1 }), [bill('a', { invoice_number: '12' })])).toBeNull()
  })

  it('a revenue line looks at our own invoices', () => {
    expect(matchOpenInvoice(row({ isExpense: false }), [bill('a', { type: 'revenue' })])).toMatchObject({ invoiceId: 'a' })
  })
})

const past = (date: string, over: Partial<PastBooking> = {}): PastBooking => ({
  date, pl_category: 'Gorivo', pl_subcategory: null, department: 'Gradilište', dept_subcategory: null,
  expense_description: null, revenue_stream: null, project_id: null, split: false, ...over,
})

describe('a line booked the way the partner was booked before', () => {
  it('as the last ones, when they all agree', () => {
    const c = classifyFromHistory([past('2026-10-01'), past('2026-09-01'), past('2026-08-01')])
    expect(c).toMatchObject({ sure: true, count: 3, fields: { pl_category: 'Gorivo', department: 'Gradilište' } })
  })

  it('as the one before, when there is only one', () => {
    expect(classifyFromHistory([past('2026-10-01')])).toMatchObject({ sure: true, count: 1 })
  })

  it('as the latest, to be checked, when they differ', () => {
    const c = classifyFromHistory([past('2026-10-01', { department: 'Uprava' }), past('2026-09-01')])
    expect(c).toMatchObject({ sure: false, count: 2, fields: { department: 'Uprava' } })
  })

  it('looks at the last five only', () => {
    const h = [past('6'), past('5'), past('4'), past('3'), past('2'), past('1', { department: 'Uprava' })]
    expect(classifyFromHistory(h)).toMatchObject({ sure: true, count: 5 })
  })

  it('a latest one that was split is to be checked', () => {
    expect(classifyFromHistory([past('2026-10-01', { split: true })])).toMatchObject({ sure: false, split: true })
  })

  it('nothing to go on gives nothing', () => {
    expect(classifyFromHistory([])).toBeNull()
    expect(classifyFromHistory([past('2026-10-01', { pl_category: null })])).toBeNull()
  })
})

describe('after review', () => {
  it('a euro bill paid in dinars is found by its reference, not by the amount', () => {
    const eur = bill('e', { currency: 'EUR', amount: 1000, reference_number: '2026-77' })
    expect(matchOpenInvoice(row({ amount: 117200, reference: '2026-77' }), [eur])).toMatchObject({ kind: 'invoice', invoiceId: 'e' })
    expect(matchOpenInvoice(row({ amount: 1000 }), [eur])).toBeNull()
  })

  it('knows whether the partner still has a bill open in that direction', () => {
    expect(hasOpenBill('p1', true, [bill('a', { currency: 'EUR' })])).toBe(true)
    expect(hasOpenBill('p1', true, [bill('a', { paid_amount: 12000 })])).toBe(false)
    expect(hasOpenBill('p1', false, [bill('a')])).toBe(false)
    expect(hasOpenBill(null, true, [bill('a')])).toBe(false)
  })
})
