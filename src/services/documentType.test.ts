import {
  DOCUMENT_TYPE_LABEL,
  adjustmentSummary,
  billTotal,
  creditProblem,
  defaultDocumentType,
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
    })
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

  it('sums up a bill\'s notes in one phrase', () => {
    expect(adjustmentSummary(120000, -20000, 'RSD')).toBe('knjižno odobrenje −20.000,00 RSD')
    expect(adjustmentSummary(120000, 5000, 'RSD')).toBe('knjižno zaduženje +5.000,00 RSD')
    expect(adjustmentSummary(120000, 0, 'RSD')).toBe('')
  })
})
