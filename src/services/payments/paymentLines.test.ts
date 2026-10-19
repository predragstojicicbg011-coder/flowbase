import {
  parseAmount, newLine, lineProblem, remainingAfter, batchesByBank, orderFor, amountText,
  type PayableBill, type PaymentLine, type CompanyBankAccount,
} from './paymentLines'

const bill = (over: Partial<PayableBill> & { id: string }): PayableBill => ({
  type: 'expense', currency: 'RSD', outstanding: 100000, invoice_number: 'F-1', partner_name: 'Dobavljač',
  partner_address: 'Ulica 1', partner_city: 'Beograd', beneficiary_account: '205-0000000654321-11',
  model: '97', reference_number: null, ...over,
})
const intesa: CompanyBankAccount = { id: 'b1', bank_name: 'Intesa', account_number: '160-1-11', is_primary: true }
const otp: CompanyBankAccount = { id: 'b2', bank_name: 'OTP', account_number: '325-2-22' }

describe('reading a typed amount', () => {
  it.each([
    ['1.234,56', 1234.56], ['1234,56', 1234.56], ['1234.56', 1234.56], ['1234.5', 1234.5],
    ['1.234.567', 1234567], ['50000', 50000], [' 12 000,00 ', 12000],
  ])('%s is %s', (text, n) => expect(parseAmount(text)).toBe(n))

  it.each(['', 'abc', '12,3,4', '-5'])('%s is not an amount', text => expect(parseAmount(text)).toBeNull())

  it('starts a line at the whole amount still owed', () => {
    expect(newLine(bill({ id: 'a', outstanding: 1234.5 }), 'b1').amountText).toBe('1234,50')
    expect(amountText(7)).toBe('7,00')
  })
})

describe('a partial payment', () => {
  it('pays part and says what stays owed', () => {
    const b = bill({ id: 'a' })
    const l: PaymentLine = { ...newLine(b, 'b1'), amountText: '40.000,00' }
    expect(lineProblem(l, b)).toBeNull()
    expect(remainingAfter(l, b)).toBe(60000)
  })

  it('refuses more than is owed, nothing, and text that is not a number', () => {
    const b = bill({ id: 'a' })
    expect(lineProblem({ ...newLine(b, 'b1'), amountText: '100000,01' }, b)).toMatch(/veći/)
    expect(lineProblem({ ...newLine(b, 'b1'), amountText: '0' }, b)).toMatch(/veći od nule/)
    expect(lineProblem({ ...newLine(b, 'b1'), amountText: 'x' }, b)).toMatch(/nije broj/)
  })

  it('refuses a bill that is not paid by a dinar payment order', () => {
    expect(lineProblem(newLine(bill({ id: 'a', type: 'revenue' }), 'b1'), bill({ id: 'a', type: 'revenue' }))).toMatch(/Izlazna/)
    expect(lineProblem(newLine(bill({ id: 'a', currency: 'EUR' }), 'b1'), bill({ id: 'a', currency: 'EUR' }))).toMatch(/Devizna/)
    expect(lineProblem(newLine(bill({ id: 'a', beneficiary_account: null }), 'b1'), bill({ id: 'a', beneficiary_account: null }))).toMatch(/računa primaoca/)
  })
})

describe('one file per bank', () => {
  it('batches lines by the bank they are paid from, codes together, only valid lines', () => {
    const bills = new Map([
      ['a', bill({ id: 'a' })], ['b', bill({ id: 'b', outstanding: 500 })],
      ['c', bill({ id: 'c' })], ['d', bill({ id: 'd' })],
    ])
    const lines: PaymentLine[] = [
      { invoiceId: 'a', amountText: '1000', bankAccountId: 'b1', paymentCode: '254' },
      { invoiceId: 'b', amountText: '500', bankAccountId: 'b1', paymentCode: '221' },
      { invoiceId: 'c', amountText: '2000', bankAccountId: 'b2', paymentCode: '221' },
      { invoiceId: 'd', amountText: '999999', bankAccountId: 'b2', paymentCode: '221' }, // too much: left out
    ]
    const batches = batchesByBank(lines, bills, [intesa, otp])
    expect(batches.map(b => b.bank.id)).toEqual(['b1', 'b2'])
    expect(batches[0].lines.map(l => l.invoiceId)).toEqual(['b', 'a'])
    expect(batches[0].total).toBe(1500)
    expect(batches[0].byCode).toEqual([{ code: '221', count: 1, total: 500 }, { code: '254', count: 1, total: 1000 }])
    expect(batches[1].lines.map(l => l.invoiceId)).toEqual(['c'])
  })

  it('writes the model only with a reference, and the partial amount into the order', () => {
    const withRef = bill({ id: 'a', reference_number: '12-34' })
    const o = orderFor({ ...newLine(withRef, 'b1'), amountText: '250,5' }, withRef)
    expect(o.amount).toBe(250.5)
    expect(o.creditModel).toBe('97')
    expect(o.creditReference).toBe('12-34')
    expect(orderFor(newLine(bill({ id: 'b' }), 'b1'), bill({ id: 'b' })).creditModel).toBe('')
  })
})
