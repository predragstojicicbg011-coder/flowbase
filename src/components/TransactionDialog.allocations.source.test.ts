import fs from 'fs'
import path from 'path'

/**
 * The transaction dialog writes the links of a payment one request at a time,
 * and the database judges each one by itself (links_stay_within_their_payment,
 * 20261125100000). So the whole set is asked BEFORE the first write, counted as
 * the database counts, and the links are written lowered-first.
 */
const src = fs.readFileSync(path.join(__dirname, 'TransactionDialog.tsx'), 'utf8').replace(/\r\n/g, '\n')
const handlePost = src.slice(src.indexOf('const handlePost = async () => {'))

describe('TransactionDialog: a payment is not allocated beyond what it paid', () => {
  it('asks allocationsExceedPayment of the whole set before anything is written, and stops on a refusal', () => {
    const check = handlePost.indexOf('const tooMuch = allocationsExceedPayment(')
    expect(check).toBeGreaterThan(0)
    const firstWrite = handlePost.search(/\.(insert|update|upsert|delete|rpc)\(/)
    expect(firstWrite).toBeGreaterThan(check)
    expect(handlePost).toContain('if (tooMuch) { setShowValidationSummary(false); setPostError(tooMuch); return }')
  })

  it('measures the raise against the links the payment opened with, in dinars as the payment sees them', () => {
    expect(handlePost).toContain("{ amount: parseFloat(amount) || 0, amount_rsd: book.amounts?.amount_rsd ?? null, currency: currency || null },")
    expect(handlePost).toContain('linkedInvoices.map(l => asSaved(l, toRsd(l.allocated_own || 0, l))), originalLinks.map(l => asSaved(l)))')
  })

  it('reads whether each linked invoice is a payroll child, and keeps that with the links it opened with', () => {
    expect(src).toContain('advance_deducted, parent_invoice_id, partners(name))')
    expect(src).toContain('child: !!l.invoices?.parent_invoice_id,')
    expect(src).toContain('currency: r.currency ?? null, child: r.child, unseen: r.unseen,')
  })

  it('writes lowered allocations first', () => {
    expect(handlePost).toContain('for (const link of shrinkingFirst(links.filter(l => l.allocated_own > 0), originalLinks)) {')
  })
})
