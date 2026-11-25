import fs from 'fs'
import path from 'path'
import { owedAmount, outstandingOwn, settlementFor } from '../services/settleInvoice'

/**
 * A bank statement or a bulk import paying a bill that an advance invoice or a
 * paid proforma already closed part of (20261125100000): what the bill still
 * owes is its amount with its credit notes, LESS what advances used, less what
 * payments hold. The payment is then not allocated beyond that, and the bill
 * is not paid twice (the database refuses it too: links_stay_within_their_payment).
 */
describe('what a bill an advance closed still owes', () => {
  // A bill of 2.400 a proforma closed 1.500 of, paid from the statement by 2.400.
  const bill = { amount: 2400, amount_rsd: 2400, amount_eur: 20.48, exchange_rate: 1, eur_rate: 117.2, currency: 'RSD', paid_amount: 0, adjustments: 0, advance_used: 1500 }

  it('the advance is taken off what it owes', () => {
    expect(owedAmount(bill)).toBe(900)
    expect(outstandingOwn(bill)).toBe(900)
    expect(outstandingOwn({ ...bill, adjustments: -400 })).toBe(500)
  })

  it('a payment of the whole amount settles only the rest, and the rest of the payment is left over', () => {
    const s = settlementFor({ invoice: bill, paymentCurrency: 'RSD', paymentOwn: 2400, paymentRsd: 2400 })
    expect(s.own).toBe(900)
    expect(s.leftOnPayment).toBe(1500)
  })

  it('without the advance it would have taken the whole payment -- the fault this closes', () => {
    expect(settlementFor({ invoice: { ...bill, advance_used: 0 }, paymentCurrency: 'RSD', paymentOwn: 2400, paymentRsd: 2400 }).own).toBe(2400)
  })
})

const read = (f: string) => fs.readFileSync(path.join(__dirname, f), 'utf8').replace(/\r\n/g, '\n')

describe('the two statement paths read the advance and hand it on', () => {
  it('BankStatementDialog', () => {
    const src = read('BankStatementDialog.tsx')
    expect(src).toContain(".select('paid_amount, adjustments, advance_used').eq('id', inv.id).maybeSingle()")
    expect(src).toContain('invoice: { ...inv, paid_amount: alreadyOwn, adjustments, advance_used: advanceUsed },')
    expect(src).toContain('amount: owedAmount({ amount: inv.amount, adjustments, advance_used: advanceUsed }),')
    // The stored status is set from the view, which carries both.
    expect(src).toContain(".select('amount, amount_rsd, advance_deducted, adjustments, advance_used').eq('id', invoiceId).maybeSingle()")
  })

  it('BulkImport', () => {
    const src = read('BulkImport.tsx')
    expect(src).toContain(".select('adjustments, advance_used').eq('id', invoiceId).maybeSingle()")
    expect(src).toContain('const owed = owedAmount({ amount: inv.amount, adjustments, advance_used: advanceUsed })')
    expect(src).toContain('const remainingInvOrig = Math.max(0, owed - advanceOwn - alreadyAllocOrig)')
    expect(src).toContain('invoice: { ...inv, paid_amount: alreadyAllocOrig, adjustments, advance_used: advanceUsed },')
  })
})
