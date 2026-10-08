import {
  CREDIT_PRINCIPAL, CREDIT_INTEREST, CREDIT_DEPARTMENT, CREDIT_DEPT_SUBCATEGORY,
  creditNote, allocatePayment,
} from './creditClassification'
import { buildTree, UNASSIGNED, PlEntry } from './expenseTree'

const leg = (c: typeof CREDIT_PRINCIPAL, amount: number): PlEntry => ({
  tx_type: 'expense', pl_date: '2026-08-31', amount_rsd: amount, amount_eur: null,
  pl_category: c.pl_category, pl_subcategory: c.pl_subcategory,
  department: c.department, dept_subcategory: c.dept_subcategory,
  expense_description: c.expense_description,
})

describe('credit classification', () => {
  it('sends principal down the branch the business asked for', () => {
    expect(CREDIT_PRINCIPAL).toEqual({
      pl_category: 'Loans/Credits/Dividend',
      pl_subcategory: 'Bank Credits',
      department: 'Loans/Credits/Dividend',
      dept_subcategory: 'Credit',
      expense_description: 'Credit',
    })
  })

  it('puts interest under the credit category, as its own line', () => {
    // Both legs on one category, so the cost of a credit is one number in the
    // P&L branch too — but still two lines, so interest stays readable.
    expect(CREDIT_INTEREST.pl_category).toBe('Loans/Credits/Dividend')
    expect(CREDIT_INTEREST.pl_subcategory).toBe('Paid Interest on credit')
  })

  it('shares the P&L category with principal but not the sub-category', () => {
    expect(CREDIT_INTEREST.pl_category).toBe(CREDIT_PRINCIPAL.pl_category)
    expect(CREDIT_INTEREST.pl_subcategory).not.toBe(CREDIT_PRINCIPAL.pl_subcategory)
  })

  it('leaves Financial Expenses / Interest free for other interest', () => {
    expect(CREDIT_INTEREST.pl_category).not.toBe('Financial Expenses')
  })

  it('puts both legs in the same department, so both leave Unassigned', () => {
    for (const c of [CREDIT_PRINCIPAL, CREDIT_INTEREST]) {
      expect(c.department).toBe(CREDIT_DEPARTMENT)
      expect(c.dept_subcategory).toBe(CREDIT_DEPT_SUBCATEGORY)
      expect(c.department).not.toBe(UNASSIGNED)
    }
  })

  it('tells the two legs apart by expense description', () => {
    expect(CREDIT_PRINCIPAL.expense_description)
      .not.toBe(CREDIT_INTEREST.expense_description)
  })

  it('leaves no credit row under Unassigned in either branch', () => {
    const rows = [leg(CREDIT_PRINCIPAL, 1840.22), leg(CREDIT_INTEREST, 126.75)]
    for (const branch of ['pl', 'department'] as const) {
      const tree = buildTree(rows, branch, 'RSD')
      const flat: string[] = []
      const walk = (ns: any[]) => ns.forEach(n => { flat.push(n.label); walk(n.children) })
      walk(tree)
      expect(flat).not.toContain(UNASSIGNED)
    }
  })

  it('groups every credit payment onto one line instead of one per installment', () => {
    // The old expense_description carried the installment number, so 200
    // payments produced 200 leaves and the report could not group them.
    const rows = Array.from({ length: 12 }, (_, i) =>
      ({ ...leg(CREDIT_PRINCIPAL, 1800 + i), pl_date: `2026-${String(i + 1).padStart(2, '0')}-28` }))
    const leaves = buildTree(rows, 'department', 'RSD').flatMap(n => n.children).flatMap(n => n.children)
    expect(leaves).toHaveLength(1)
    expect(leaves[0].count).toBe(12)
  })
})

describe('creditNote', () => {
  it('records which installment the leg paid', () => {
    expect(creditNote('principal', 'Investicioni kredit', 7, 1840.22))
      .toBe('Glavnica — Investicioni kredit #7 (1.840,22 EUR)')
  })

  it('labels the interest leg', () => {
    expect(creditNote('interest', 'Investicioni kredit', 7, 126.75))
      .toBe('Kamata — Investicioni kredit #7 (126,75 EUR)')
  })

  it('names the credit\'s own currency rather than assuming euros', () => {
    // A loan may be taken in dinars; its instalment is then a dinar figure.
    expect(creditNote('principal', 'Kredit za mehanizaciju', 4, 215640.5, null, 'RSD'))
      .toBe('Glavnica — Kredit za mehanizaciju #4 (215.640,50 RSD)')
  })

  it('leads with the leg, so a truncated note still says what the row is', () => {
    expect(creditNote('principal', 'Kredit', 3, 500, 'Paid early'))
      .toBe('Glavnica — Kredit #3 (500,00 EUR) | stavka izvoda: Paid early')
  })

  it('does not let the bank wording contradict the leg at a glance', () => {
    // A principal row funded by a line the bank calls interest is legitimate;
    // reading "Naplata redovne kamate" first is what makes it look wrong.
    expect(creditNote('principal', 'Intesa 100k', 14, 5513.61, 'Naplata redovne kamate'))
      .toMatch(/^Glavnica — /)
  })

  it('does not leave a separator when there is no typed note', () => {
    for (const n of [null, undefined, '', '   ']) {
      expect(creditNote('principal', 'Kredit', 1, 10, n)).not.toContain('|')
    }
  })
})

describe('allocatePayment', () => {
  // A statement that splits the installment into two lines is the case that
  // produced EUR 71,188.74 of double-booked expense.
  it('books an interest-sized line as interest, not principal', () => {
    expect(allocatePayment(309.29, 5513.61, 309.29))
      .toEqual({ principal: 0, interest: 309.29 })
  })

  it('books a principal-sized line as principal', () => {
    expect(allocatePayment(5513.61, 5513.61, 309.29))
      .toEqual({ principal: 5513.61, interest: 0 })
  })

  it('never books more than the line actually paid', () => {
    for (const paid of [100, 309.29, 1000, 5513.61, 5822.90]) {
      const s = allocatePayment(paid, 5513.61, 309.29)
      expect(s.principal + s.interest).toBeLessThanOrEqual(paid + 0.01)
    }
  })

  it('spreads a combined payment principal first', () => {
    expect(allocatePayment(5822.90, 5513.61, 309.29))
      .toEqual({ principal: 5513.61, interest: 309.29 })
  })

  it('stops at what is still due rather than overpaying', () => {
    const s = allocatePayment(9999, 5513.61, 309.29)
    expect(s).toEqual({ principal: 5513.61, interest: 309.29 })
  })

  it('puts a part payment on principal when it matches neither leg', () => {
    expect(allocatePayment(1000, 5513.61, 309.29))
      .toEqual({ principal: 1000, interest: 0 })
  })

  it('handles an installment with no interest, and one with no principal', () => {
    expect(allocatePayment(2777.78, 2777.78, 0)).toEqual({ principal: 2777.78, interest: 0 })
    expect(allocatePayment(556.81, 0, 556.81)).toEqual({ principal: 0, interest: 556.81 })
  })

  it('gives a payment equal to both legs to principal', () => {
    expect(allocatePayment(500, 500, 500)).toEqual({ principal: 500, interest: 0 })
  })

  it('books nothing for a zero or negative payment', () => {
    expect(allocatePayment(0, 100, 10)).toEqual({ principal: 0, interest: 0 })
    expect(allocatePayment(-5, 100, 10)).toEqual({ principal: 0, interest: 0 })
  })
})
