import { findLikelyDuplicate, type LedgerInvoice } from './sefDuplicate'

const led = (over: Partial<LedgerInvoice> & { id: string }): LedgerInvoice => ({
  invoice_number: '2026-0412', invoice_date: '2026-09-14',
  amount: 12000, currency: 'RSD', partner_id: 'telekom', ...over,
})

describe('warning that a bill is already in the ledger', () => {
  it('matches the same supplier’s same invoice number', () => {
    const w = findLikelyDuplicate(
      { document_number: '2026-0412', amount: 12000, currency: 'RSD', partner_id: 'telekom' },
      [led({ id: 'a' })])
    expect(w?.invoice.id).toBe('a')
    expect(w?.text).toMatch(/2026-0412/)
    expect(w?.text).toMatch(/14\.09|2026-09-14/)
  })

  /**
   * REVIEW FOCUS 4. Invoice numbers are unique per supplier, not globally.
   * `1` and `2026-01` are numbers half the country uses. A check on the number
   * alone warns on unrelated bills until the warning is ignored by habit, and
   * then it is worth nothing on the day it is right.
   */
  it('does not match another supplier using the same number', () => {
    expect(findLikelyDuplicate(
      { document_number: '2026-0412', amount: 12000, currency: 'RSD', partner_id: 'eps' },
      [led({ id: 'a' })])).toBeNull()
  })

  it('says nothing when the supplier is not known yet', () => {
    expect(findLikelyDuplicate(
      { document_number: '2026-0412', amount: 12000, currency: 'RSD', partner_id: null },
      [led({ id: 'a' })])).toBeNull()
  })

  it('says nothing when the bill carries no number', () => {
    expect(findLikelyDuplicate(
      { document_number: null, amount: 12000, currency: 'RSD', partner_id: 'telekom' },
      [led({ id: 'a' })])).toBeNull()
  })

  /** Punctuation and case are typography. `2026/0412` and `2026-0412` from one
   *  supplier are one bill. */
  it('ignores punctuation and case in the number', () => {
    expect(findLikelyDuplicate(
      { document_number: '2026/0412 ', amount: 12000, currency: 'RSD', partner_id: 'telekom' },
      [led({ id: 'a' })])?.invoice.id).toBe('a')
  })

  /** A warning, not a refusal: it may be a genuine duplicate, and it may be a
   *  supplier reusing a number. The amount is reported so he can judge. */
  it('still warns when the amount differs, and says both', () => {
    const w = findLikelyDuplicate(
      { document_number: '2026-0412', amount: 9000, currency: 'RSD', partner_id: 'telekom' },
      [led({ id: 'a' })])
    expect(w).not.toBeNull()
    expect(w?.text).toMatch(/12,?000/)
  })

  /** C2: the `partner_id` guard, on the ledger side. The incoming row HAS a
   *  supplier and a number; it is the hand-typed ledger row that names no
   *  partner, and it must not be taken for that supplier's bill. */
  it('does not match a ledger row that names no partner', () => {
    expect(findLikelyDuplicate(
      { document_number: '2026-0412', amount: 12000, currency: 'RSD', partner_id: 'telekom' },
      [led({ id: 'a', partner_id: null })])).toBeNull()
  })

  /** C2: the number guard, on the ledger side. */
  it('does not match a ledger row that carries no number', () => {
    expect(findLikelyDuplicate(
      { document_number: '2026-0412', amount: 12000, currency: 'RSD', partner_id: 'telekom' },
      [led({ id: 'a', invoice_number: null })])).toBeNull()
  })

  /** 1,000 EUR and 1,000 RSD are not the same bill. The warning still fires,
   *  because supplier and number agree, but not in its strongest wording. */
  it('does not say "already have" when only the figure agrees, across currencies', () => {
    const w = findLikelyDuplicate(
      { document_number: '2026-0412', amount: 1000, currency: 'RSD', partner_id: 'telekom' },
      [led({ id: 'a', amount: 1000, currency: 'EUR' })])
    expect(w).not.toBeNull()
    expect(w?.text).not.toMatch(/Looks like you already have this/)
    expect(w?.text).toMatch(/1,000\.00 EUR/)
    expect(w?.text).toMatch(/1,000\.00 RSD/)
  })

  /** M1: the folding test had no letters in it, so case was never exercised. */
  it('folds case as well as punctuation', () => {
    expect(findLikelyDuplicate(
      { document_number: 'fa/2026-0412', amount: 12000, currency: 'RSD', partner_id: 'telekom' },
      [led({ id: 'a', invoice_number: 'FA-2026-0412' })])?.invoice.id).toBe('a')
  })
})
