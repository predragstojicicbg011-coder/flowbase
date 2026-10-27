import {
  DOCUMENT_TYPE_LABEL,
  adjustmentSummary,
  billTotal,
  closureNote,
  creditProblem,
  defaultDocumentType,
  hasNoPl,
  isPayable,
  invoiceNumberKey,
  scaleSplits,
  signProblem,
  type AdjustableBill,
} from './documentType'

const bill = (over: Partial<AdjustableBill> = {}): AdjustableBill => ({
  id: 'b1', invoice_number: 'R-1/26', invoice_date: '2026-10-01',
  amount: 120000, adjustments: 0, paid_amount: 0, currency: 'RSD', ...over,
})

describe('documentType', () => {
  it('names the three types in Serbian', () => {
    expect(DOCUMENT_TYPE_LABEL).toEqual({
      invoice: 'Račun', credit_note: 'Knjižno odobrenje', debit_note: 'Knjižno zaduženje',
      proforma: 'Predračun', advance_invoice: 'Avansni račun',
    })
  })

  it('knows which documents are paid and which never reach the P&L', () => {
    expect(['invoice', 'credit_note', 'debit_note', 'proforma', 'advance_invoice'].filter(t => isPayable(t as any))).toEqual(['invoice', 'debit_note', 'proforma'])
    expect(['invoice', 'credit_note', 'debit_note', 'proforma', 'advance_invoice'].filter(t => hasNoPl(t as any))).toEqual(['proforma', 'advance_invoice'])
    expect(signProblem('proforma', 0)).toBe('Iznos mora biti veći od 0')
    expect(signProblem('advance_invoice', -5)).toBe('Iznos mora biti veći od 0')
    expect(signProblem('advance_invoice', 5)).toBeNull()
  })

  it('takes the default type from the sign', () => {
    expect(defaultDocumentType(-5)).toBe('credit_note')
    expect(defaultDocumentType(5)).toBe('invoice')
    expect(defaultDocumentType(0)).toBe('invoice')
    expect(defaultDocumentType(null)).toBe('invoice')
  })

  it('checks the sign against the type', () => {
    expect(signProblem('credit_note', -1)).toBeNull()
    expect(signProblem('credit_note', 1)).toBe('Knjižno odobrenje mora imati negativan iznos')
    expect(signProblem('credit_note', 0)).toBe('Knjižno odobrenje mora imati negativan iznos')
    expect(signProblem('debit_note', 1)).toBeNull()
    expect(signProblem('debit_note', -1)).toBe('Knjižno zaduženje mora imati pozitivan iznos')
    expect(signProblem('invoice', -1)).toBeNull()
    expect(signProblem('credit_note', null)).toBeNull()
  })

  it('refuses a credit note larger than what is left of the bill', () => {
    const b = bill({ adjustments: -20000 })
    expect(billTotal(b)).toBe(100000)
    expect(creditProblem(-100000, b)).toBeNull()
    expect(creditProblem(-100000.01, b)).toBe('Knjižno odobrenje (100.000,01) je veće od ostatka računa R-1/26 (100.000,00)')
    expect(creditProblem(5000, b)).toBeNull()
  })

  it('scales the base bill\'s split to the note, the last line taking the rounding', () => {
    const lines = [{ amount: 100, id: 'a' }, { amount: 100, id: 'b' }, { amount: 100, id: 'c' }]
    const out = scaleSplits(lines, 300, -100)
    expect(out.map(l => l.amount)).toEqual([-33.33, -33.33, -33.34])
    expect(out.map(l => l.id)).toEqual(['a', 'b', 'c'])
    expect(scaleSplits([{ amount: 80 }, { amount: 40 }], 120, 30).map(l => l.amount)).toEqual([20, 10])
    expect(scaleSplits([], 120, 30)).toEqual([])
    expect(scaleSplits([{ amount: 0 }, { amount: 0 }], 0, 30).map(l => l.amount)).toEqual([0, 30])
  })

  it('folds a bill number to its letters and digits', () => {
    expect(invoiceNumberKey('R-1/26')).toBe(invoiceNumberKey('r 1 26'))
    expect(invoiceNumberKey('Č-5/26')).toBe('č526')
    expect(invoiceNumberKey(null)).toBe('')
  })

  it('sums up a bill\'s notes in one phrase', () => {
    expect(adjustmentSummary(120000, -20000, 'RSD')).toBe('knjižno odobrenje −20.000,00 RSD')
    expect(adjustmentSummary(120000, 5000, 'RSD')).toBe('knjižno zaduženje +5.000,00 RSD')
    expect(adjustmentSummary(120000, 0, 'RSD')).toBe('')
  })
})

describe('what closed a bill', () => {
  const row = (over: Record<string, unknown> = {}) => ({
    document_type: 'invoice', type: 'expense', calculated_status: 'paid', currency: 'RSD',
    amount: 120000, adjustments: 0, paid_amount: 120000, amount_due: 120000, ...over,
  })

  it('says nothing on a bill paid with money', () => {
    expect(closureNote(row())).toBe('')
  })

  it('names a bill a credit note closed', () => {
    expect(closureNote(row({ adjustments: -120000, paid_amount: 0, amount_due: 0 }))).toBe('zatvoreno knjižnim odobrenjem')
  })

  it('names a bill a credit note reduced', () => {
    expect(closureNote(row({ calculated_status: 'partial', adjustments: -20000, paid_amount: 0, amount_due: 100000 }))).toBe('umanjeno knjižnim odobrenjem')
  })

  it('names the refund a supplier owes after a credit note on a paid bill', () => {
    expect(closureNote(row({ adjustments: -20000, amount_due: 100000 }))).toBe('dobavljač duguje povraćaj 20.000,00 RSD')
    expect(closureNote(row({ type: 'revenue', adjustments: -20000, amount_due: 100000 }))).toBe('kupcu dugujemo povraćaj 20.000,00 RSD')
  })

  it('says nothing on a note itself', () => {
    expect(closureNote(row({ document_type: 'credit_note', amount: -5 }))).toBe('')
  })
})

describe('a bill an advance closed', () => {
  const row = (over: Record<string, unknown> = {}) => ({
    document_type: 'invoice', type: 'expense', calculated_status: 'paid', currency: 'RSD',
    amount: 18144, adjustments: 0, advance_used: 18144, paid_amount: 0, amount_due: 0, ...over,
  })
  it('says the advance closed it, in full or in part', () => {
    expect(closureNote(row())).toBe('zatvoreno avansom')
    expect(closureNote(row({ calculated_status: 'partial', amount: 17340, advance_used: 13260, amount_due: 4080 }))).toBe('delimično zatvoreno avansom')
  })
})
