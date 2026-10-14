import { proposeClassification, type PastInvoice } from './proposeClassification'

const past = (over: Partial<PastInvoice> = {}): PastInvoice => ({
  invoice_date: '2026-09-30',
  pl_category: 'Operating expenses', pl_subcategory: 'Utilities',
  department: 'Operations', dept_subcategory: 'Office',
  expense_description: 'Telephone', ...over,
})

describe('what to propose for an incoming bill', () => {
  it('proposes what this supplier’s bills were filed as', () => {
    const p = proposeClassification('Telekom', [past(), past(), past()], [])
    expect(p?.pl_category).toBe('Operating expenses')
    expect(p?.basis).toBe('history')
  })

  /** The reason is the point. A silently filled field is how a bill ends up
   *  classified by a machine and signed off by a person who did not look. */
  it('says why, naming the supplier and the count', () => {
    const p = proposeClassification('Telekom', [past(), past(), past()], [])
    expect(p?.reason).toMatch(/Telekom/)
    expect(p?.reason).toMatch(/3/)
  })

  it('takes the most recent when the history disagrees, and says it is mixed', () => {
    const p = proposeClassification('Telekom', [
      past({ invoice_date: '2026-08-31', expense_description: 'Internet' }),
      past({ invoice_date: '2026-09-30', expense_description: 'Telephone' }),
    ], [])
    expect(p?.expense_description).toBe('Telephone')
    expect(p?.basis).toBe('mixed')
    expect(p?.reason).toMatch(/mixed|differ/i)
  })

  it('falls back to a quick-fill template matching the supplier', () => {
    const p = proposeClassification('Telekom Srbija', [], [
      { id: 's1', name: 'Telekom', pl_category: 'Operating expenses',
        pl_subcategory: 'Utilities', department: 'Operations',
        dept_subcategory: 'Office', expense_description: 'Telephone' } as any,
    ])
    expect(p?.basis).toBe('script')
    expect(p?.pl_category).toBe('Operating expenses')
  })

  /** A1: `''.includes` is true of everything. A bill with no supplier name
   *  used to match the first template on the list and be told it matched on
   *  the name. */
  it('proposes nothing for a bill whose supplier has no name', () => {
    expect(proposeClassification('', [], [
      { id: 's1', name: 'Telekom', pl_category: 'Operating expenses' } as any,
    ])).toBeNull()
  })

  /** And a template name is matched as a word, not as a substring. */
  it('does not match a template whose name is merely a substring', () => {
    expect(proposeClassification('Vegas Doo', [], [
      { id: 's1', name: 'Gas', pl_category: 'Operating expenses' } as any,
    ])).toBeNull()
  })

  /** `doo` is on nearly every Serbian company name, so matching on it alone
   *  matches the whole country. */
  it('does not match two companies on their legal form', () => {
    expect(proposeClassification('MK Doo', [], [
      { id: 's1', name: 'Telekom Doo', pl_category: 'Operating expenses' } as any,
    ])).toBeNull()
  })

  /** And a legal form on both sides does not stop a real match. */
  it('still matches when both carry a legal form', () => {
    expect(proposeClassification('Telekom Srbija Doo', [], [
      { id: 's1', name: 'Telekom Doo', pl_category: 'Operating expenses',
        pl_subcategory: 'Utilities', department: 'Operations',
        dept_subcategory: 'Office', expense_description: 'Telephone' } as any,
    ])?.basis).toBe('script')
  })

  /** The stop-list is a set lookup, so a punctuated form walked past it. With
   *  `bareWord` reverted this matches on `d.o.o.`; with it, both sides lose
   *  the legal form and there is nothing left to match on. */
  it('is not fooled by a punctuated legal form', () => {
    expect(proposeClassification('Nova D.O.O.', [], [
      { id: 's1', name: 'MK D.O.O.', pl_category: 'Operating expenses' } as any,
    ])).toBeNull()
  })

  /** Companies are registered in Cyrillic too, and SEF carries their invoices. */
  it('is not fooled by a legal form in Cyrillic', () => {
    expect(proposeClassification('МК ДОО', [], [
      { id: 's1', name: 'Telekom ДОО', pl_category: 'Operating expenses' } as any,
    ])).toBeNull()
  })

  /** The Cyrillic ћ has no decomposition, so the stop-list has to carry the
   *  word as it is actually written. */
  it('is not fooled by preduzeće in Cyrillic', () => {
    expect(proposeClassification('Предузеће Ауто', [], [
      { id: 's1', name: 'Предузеће Доо', pl_category: 'Operating expenses' } as any,
    ])).toBeNull()
  })

  /** REVIEW FOCUS 1. Every first bill from a new supplier is this. Proposing
   *  something would be inventing it; the fields stay empty and he chooses. */
  it('proposes nothing for a supplier with no history and no template', () => {
    expect(proposeClassification('Brand New Doo', [], [])).toBeNull()
  })

  it('proposes nothing when the history carries no classification at all', () => {
    expect(proposeClassification('Telekom', [
      past({ pl_category: null, pl_subcategory: null, department: null,
             dept_subcategory: null, expense_description: null }),
    ], [])).toBeNull()
  })
})

/**
 * The booking draft reads `cf_type` off the proposal. A proposal that drops
 * it leaves the cash-flow type to be set by hand on every bill.
 */
describe('the cash-flow type a proposal carries', () => {
  it('takes it from the most recent usable bill', () => {
    const p = proposeClassification('Telekom', [
      past({ invoice_date: '2026-08-31', cf_type: '' }),
      past({ invoice_date: '2026-09-30', cf_type: 'investing' }),
    ], [])
    expect(p?.cf_type).toBe('investing')
  })

  it('takes it from the matched template', () => {
    const p = proposeClassification('Telekom Srbija', [], [
      { id: 's1', name: 'Telekom', pl_category: 'Operating expenses',
        cf_type: 'investing' } as any,
    ])
    expect(p?.basis).toBe('script')
    expect(p?.cf_type).toBe('investing')
  })

  /** An accrual or a capex needs its dates or its month count with it, and
   *  nothing downstream requires them: carried over, the invoice can be
   *  booked with no period at all. */
  it('refuses to carry a state that is incomplete on its own', () => {
    expect(proposeClassification('Telekom', [past({ cf_type: 'accrual' })], [])?.cf_type).toBeNull()
    expect(proposeClassification('Telekom', [past({ cf_type: 'capex' })], [])?.cf_type).toBeNull()
  })
})
