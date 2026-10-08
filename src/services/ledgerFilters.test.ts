import {
  TABS, FIELDS_BY_TAB, appliesTo, emptyFilters, emptyFiltersByTab,
  dateColumn, directionColumn, searchColumns, searchOr, orValue,
  presetRange, buildPredicates, activeChips, hasActiveFilters,
  clearFields, clearTab, parseAmount, plCategoryColumn,
  lastPageIndex, pageRange, pageLabel, hasPrevPage, hasNextPage,
  type FilterState, type Predicate, type Tab, type FilterField,
} from './ledgerFilters'

const TODAY = '2026-09-19'

const f = (patch: Partial<FilterState> = {}): FilterState => ({ ...emptyFilters(), ...patch })

const build = (tab: Tab, patch: Partial<FilterState>, partnerIds: string[] = []) =>
  buildPredicates(tab, f(patch), { today: TODAY, partnerIds, currency: 'RSD' })

/** The predicate on a column, or undefined. Order is not part of the contract. */
const on = (preds: Predicate[], column: string, op?: string) =>
  preds.find(p => p.op !== 'or' && p.column === column && (!op || p.op === op))

const ors = (preds: Predicate[]) => preds.filter(p => p.op === 'or').map(p => (p as any).value as string)

describe('an empty filter state', () => {
  it('asks the database for nothing', () => {
    TABS.forEach(tab => {
      expect(buildPredicates(tab, emptyFilters(), { today: TODAY, currency: 'RSD' })).toEqual([])
    })
  })

  it('shows no chips and reports itself inactive', () => {
    TABS.forEach(tab => {
      expect(activeChips(tab, emptyFilters())).toEqual([])
      expect(hasActiveFilters(tab, emptyFilters())).toBe(false)
    })
  })

  it('gives each tab its own object, so one tab cannot mutate another', () => {
    const all = emptyFiltersByTab()
    all.invoices.search = 'figma'
    expect(all.transactions.search).toBe('')
    expect(all.passthrough.search).toBe('')
  })
})

describe('which filters a tab owns', () => {
  it('shares company, dates, amount, currency and text across all three tabs', () => {
    const shared: FilterField[] = [
      'companyId', 'dateFrom', 'dateTo', 'amountFrom', 'amountTo', 'currency', 'search',
    ]
    TABS.forEach(tab => shared.forEach(field => expect(appliesTo(tab, field)).toBe(true)))
  })

  it('keeps the transactions-only filters off the other tabs', () => {
    expect(appliesTo('transactions', 'txType')).toBe(true)
    expect(appliesTo('transactions', 'unclassified')).toBe(true)
    expect(appliesTo('invoices', 'txType')).toBe(false)
    expect(appliesTo('passthrough', 'unclassified')).toBe(false)
  })

  it('keeps the invoice-only filters off the other tabs', () => {
    expect(appliesTo('invoices', 'invoiceStatus')).toBe(true)
    expect(appliesTo('invoices', 'overdue')).toBe(true)
    expect(appliesTo('invoices', 'dueFrom')).toBe(true)
    expect(appliesTo('transactions', 'invoiceStatus')).toBe(false)
    expect(appliesTo('passthrough', 'dueTo')).toBe(false)
  })

  it('keeps the pass-through-only filters off the other tabs', () => {
    expect(appliesTo('passthrough', 'ptStatus')).toBe(true)
    expect(appliesTo('passthrough', 'periodFrom')).toBe(true)
    expect(appliesTo('passthrough', 'bankId')).toBe(true)
    expect(appliesTo('transactions', 'ptStatus')).toBe(false)
    expect(appliesTo('invoices', 'periodFrom')).toBe(false)
  })

  it('gives pass-through no classification pickers at all', () => {
    const classification: FilterField[] = [
      'expenseDescription', 'department', 'deptSubcategory', 'plCategory', 'plSubcategory',
    ]
    classification.forEach(field => {
      expect(appliesTo('invoices', field)).toBe(true)
      expect(appliesTo('transactions', field)).toBe(true)
      expect(appliesTo('passthrough', field)).toBe(false)
    })
  })

  it('does not put a bank or a cash-flow filter on the transactions tab', () => {
    expect(appliesTo('transactions', 'bankId')).toBe(false)
    expect(FIELDS_BY_TAB.transactions.some(x => String(x).startsWith('cf'))).toBe(false)
  })
})

// The fault the rebuild exists to fix: one set of variables meaning different
// things on different tabs. Per-tab state stops a value crossing over, and
// these tests stop a value that HAS crossed over from reaching the query.
describe('a value belonging to another tab', () => {
  it('cannot filter a tab that has no such filter', () => {
    const leaked = f({
      txType: 'credit_payment', unclassified: true,
      invoiceStatus: 'paid', overdue: true, dueFrom: '2026-01-01',
      ptStatus: 'unpaired', ptDirection: 'in', periodFrom: '2026-01', bankId: 'bank-1',
      department: 'Engineering', plCategory: 'Operating Expenses',
    })
    expect(buildPredicates('passthrough', leaked, { today: TODAY, currency: 'RSD' }).map(p => (p as any).column).sort())
      .toEqual(['bank_id', 'direction', 'period_month', 'status'])

    const txCols = buildPredicates('transactions', leaked, { today: TODAY, currency: 'RSD' }).map(p => (p as any).column)
    expect(txCols).toContain('type')
    expect(txCols).toContain('department')
    expect(txCols).not.toContain('calculated_status')
    expect(txCols).not.toContain('due_date')
    expect(txCols).not.toContain('period_month')
    expect(txCols).not.toContain('bank_id')
  })

  it('produces no chip either, so nothing invisible is applied', () => {
    const leaked = f({ ptStatus: 'unpaired', invoiceStatus: 'paid' })
    expect(activeChips('transactions', leaked)).toEqual([])
    expect(activeChips('invoices', leaked).map(c => c.id)).toEqual(['invoiceStatus'])
    expect(activeChips('passthrough', leaked).map(c => c.id)).toEqual(['ptStatus'])
  })
})

describe('the company filter', () => {
  it('matches on id, not on a name substring', () => {
    const preds = build('invoices', { companyId: 'c-1' })
    expect(preds).toEqual([{ op: 'eq', column: 'company_id', value: 'c-1' }])
  })

  it('uses company_id on every tab, including the invoice view', () => {
    TABS.forEach(tab => {
      expect(on(build(tab, { companyId: 'c-1' }), 'company_id')).toBeDefined()
    })
  })
})

describe('the shared date range', () => {
  it('reads invoice_date on invoices and transaction_date elsewhere', () => {
    expect(dateColumn('invoices')).toBe('invoice_date')
    expect(dateColumn('transactions')).toBe('transaction_date')
    expect(dateColumn('passthrough')).toBe('transaction_date')
  })

  it('bounds the tab date column from both ends', () => {
    const preds = build('transactions', { dateFrom: '2026-01-01', dateTo: '2026-12-31' })
    expect(on(preds, 'transaction_date', 'gte')).toEqual({ op: 'gte', column: 'transaction_date', value: '2026-01-01' })
    expect(on(preds, 'transaction_date', 'lte')).toEqual({ op: 'lte', column: 'transaction_date', value: '2026-12-31' })
  })

  it('accepts a one-sided range', () => {
    expect(build('invoices', { dateFrom: '2026-01-01' })).toHaveLength(1)
    expect(build('invoices', { dateTo: '2026-01-01' })).toHaveLength(1)
  })
})

describe('the date presets', () => {
  it('resolves this month to its own first and last day', () => {
    expect(presetRange('this_month', TODAY)).toEqual({ from: '2026-09-01', to: '2026-09-30' })
  })

  it('resolves last month, crossing the year boundary', () => {
    expect(presetRange('last_month', '2026-09-19')).toEqual({ from: '2026-08-01', to: '2026-08-31' })
    expect(presetRange('last_month', '2026-01-04')).toEqual({ from: '2025-12-01', to: '2025-12-31' })
  })

  it('resolves this quarter to its three whole months', () => {
    expect(presetRange('this_quarter', '2026-09-19')).toEqual({ from: '2026-07-01', to: '2026-09-30' })
    expect(presetRange('this_quarter', '2026-01-31')).toEqual({ from: '2026-01-01', to: '2026-03-31' })
    expect(presetRange('this_quarter', '2026-12-01')).toEqual({ from: '2026-10-01', to: '2026-12-31' })
  })

  it('stops year to date at today and not at the end of the year', () => {
    expect(presetRange('ytd', TODAY)).toEqual({ from: '2026-01-01', to: '2026-09-19' })
  })

  it('gets February right in a leap year', () => {
    expect(presetRange('this_month', '2028-02-10')).toEqual({ from: '2028-02-01', to: '2028-02-29' })
    expect(presetRange('this_month', '2026-02-10')).toEqual({ from: '2026-02-01', to: '2026-02-28' })
  })

  it('leaves custom empty so the typed dates stand', () => {
    expect(presetRange('custom', TODAY)).toEqual({ from: '', to: '' })
  })
})

describe('the amount range', () => {
  it('filters amount_rsd on every tab', () => {
    TABS.forEach(tab => {
      const preds = build(tab, { amountFrom: '100', amountTo: '500' })
      expect(on(preds, 'amount_rsd', 'gte')).toEqual({ op: 'gte', column: 'amount_rsd', value: 100 })
      expect(on(preds, 'amount_rsd', 'lte')).toEqual({ op: 'lte', column: 'amount_rsd', value: 500 })
    })
  })

  it('filters amount_eur when the viewer reads the books in EUR', () => {
    TABS.forEach(tab => {
      const preds = buildPredicates(tab, f({ amountFrom: '100', amountTo: '500' }), { today: TODAY, currency: 'EUR' })
      expect(on(preds, 'amount_eur', 'gte')).toEqual({ op: 'gte', column: 'amount_eur', value: 100 })
      expect(on(preds, 'amount_eur', 'lte')).toEqual({ op: 'lte', column: 'amount_eur', value: 500 })
      expect(on(preds, 'amount_rsd')).toBeUndefined()
    })
  })

  it('ignores a box that is empty or not a number', () => {
    expect(parseAmount('')).toBeNull()
    expect(parseAmount('   ')).toBeNull()
    expect(parseAmount('abc')).toBeNull()
    expect(build('transactions', { amountFrom: 'abc' })).toEqual([])
  })

  it('reads a thousands separator and a zero bound', () => {
    expect(parseAmount('1,250.50')).toBe(1250.5)
    expect(parseAmount('1.250,50')).toBe(1250.5)
    expect(parseAmount('1.250')).toBe(1250)
    expect(parseAmount('1250.5')).toBe(1250.5)
    // Zero is a bound, not an empty box — `>= 0` must survive.
    expect(on(build('transactions', { amountFrom: '0' }), 'amount_rsd', 'gte'))
      .toEqual({ op: 'gte', column: 'amount_rsd', value: 0 })
  })
})

describe('the direction filter', () => {
  it('means invoices.type on one tab and transactions.tx_subtype on the other', () => {
    expect(directionColumn('invoices')).toBe('type')
    expect(directionColumn('transactions')).toBe('tx_subtype')
    expect(directionColumn('passthrough')).toBeNull()

    expect(on(build('invoices', { direction: 'expense' }), 'type'))
      .toEqual({ op: 'eq', column: 'type', value: 'expense' })
    expect(on(build('transactions', { direction: 'expense' }), 'tx_subtype'))
      .toEqual({ op: 'eq', column: 'tx_subtype', value: 'expense' })
  })

  it('is a separate filter from the transaction type, which they used to share', () => {
    const preds = build('transactions', { direction: 'expense', txType: 'direct' })
    expect(on(preds, 'tx_subtype')).toEqual({ op: 'eq', column: 'tx_subtype', value: 'expense' })
    expect(on(preds, 'type')).toEqual({ op: 'eq', column: 'type', value: 'direct' })
  })

  it('does not reach the pass-through tab, which has its own in/out', () => {
    expect(build('passthrough', { direction: 'expense' })).toEqual([])
    expect(on(build('passthrough', { ptDirection: 'in' }), 'direction'))
      .toEqual({ op: 'eq', column: 'direction', value: 'in' })
  })
})

describe('the classification pickers', () => {
  it('filters the five classification columns by name', () => {
    const preds = build('transactions', {
      expenseDescription: 'Figma', department: 'Engineering', deptSubcategory: 'Tools',
      plCategory: 'Operating Expenses', plSubcategory: 'Software',
    })
    expect(on(preds, 'expense_description')).toEqual({ op: 'eq', column: 'expense_description', value: 'Figma' })
    expect(on(preds, 'department')).toEqual({ op: 'eq', column: 'department', value: 'Engineering' })
    expect(on(preds, 'dept_subcategory')).toEqual({ op: 'eq', column: 'dept_subcategory', value: 'Tools' })
    expect(on(preds, 'pl_category')).toEqual({ op: 'eq', column: 'pl_category', value: 'Operating Expenses' })
    expect(on(preds, 'pl_subcategory')).toEqual({ op: 'eq', column: 'pl_subcategory', value: 'Software' })
  })

  it('applies the same pickers on the invoices tab', () => {
    const preds = build('invoices', { expenseDescription: 'Figma', department: 'Engineering' })
    expect(on(preds, 'expense_description')).toBeDefined()
    expect(on(preds, 'department')).toBeDefined()
  })

  it('reads revenue_stream instead of pl_category once direction is revenue', () => {
    expect(plCategoryColumn('transactions', f({ direction: 'revenue' }))).toBe('revenue_stream')
    expect(plCategoryColumn('transactions', f({ direction: 'expense' }))).toBe('pl_category')
    const preds = build('transactions', { direction: 'revenue', plCategory: 'Aimfox' })
    expect(on(preds, 'revenue_stream')).toEqual({ op: 'eq', column: 'revenue_stream', value: 'Aimfox' })
    expect(on(preds, 'pl_category')).toBeUndefined()
  })

  it('drops a stale P&L sub-category rather than narrowing a revenue query with it', () => {
    const preds = build('transactions', { direction: 'revenue', plCategory: 'Aimfox', plSubcategory: 'Software' })
    expect(on(preds, 'pl_subcategory')).toBeUndefined()
    expect(activeChips('transactions', f({ direction: 'revenue', plSubcategory: 'Software' })).map(c => c.id))
      .not.toContain('plSubcategory')
  })
})

describe('the unclassified toggle', () => {
  it('asks for rows missing a department or an expense description', () => {
    const preds = build('transactions', { unclassified: true })
    expect(ors(preds)).toEqual(['department.is.null,expense_description.is.null'])
  })

  it('is off by default and adds nothing when off', () => {
    expect(emptyFilters().unclassified).toBe(false)
    expect(build('transactions', { unclassified: false })).toEqual([])
  })

  it('coexists with the free text as two separate or-clauses', () => {
    const preds = build('transactions', { unclassified: true, search: 'figma' }, ['p-1'])
    const clauses = ors(preds)
    expect(clauses).toHaveLength(2)
    expect(clauses[0]).toBe('department.is.null,expense_description.is.null')
    expect(clauses[1]).toContain('note.ilike')
  })
})

describe('the invoice status filters', () => {
  it('filters the calculated status', () => {
    expect(on(build('invoices', { invoiceStatus: 'unpaid' }), 'calculated_status'))
      .toEqual({ op: 'eq', column: 'calculated_status', value: 'unpaid' })
  })

  it('reads overdue as past due AND still owing, not merely past due', () => {
    const preds = build('invoices', { overdue: true })
    expect(on(preds, 'due_date', 'lt')).toEqual({ op: 'lt', column: 'due_date', value: TODAY })
    expect(on(preds, 'calculated_status', 'in'))
      .toEqual({ op: 'in', column: 'calculated_status', value: ['unpaid', 'partial'] })
  })

  it('keeps the due-date range apart from the invoice-date range', () => {
    const preds = build('invoices', {
      dateFrom: '2026-01-01', dateTo: '2026-03-31',
      dueFrom: '2026-04-01', dueTo: '2026-06-30',
    })
    expect(on(preds, 'invoice_date', 'gte')!.value).toBe('2026-01-01')
    expect(on(preds, 'invoice_date', 'lte')!.value).toBe('2026-03-31')
    expect(on(preds, 'due_date', 'gte')!.value).toBe('2026-04-01')
    expect(on(preds, 'due_date', 'lte')!.value).toBe('2026-06-30')
  })

  it('gives the two ranges two chips, each removable on its own', () => {
    const chips = activeChips('invoices', f({ dateFrom: '2026-01-01', dueFrom: '2026-04-01' }))
    expect(chips.map(c => c.id).sort()).toEqual(['date', 'due'])
    expect(chips.find(c => c.id === 'date')!.clears).toContain('dateFrom')
    expect(chips.find(c => c.id === 'due')!.clears).toEqual(['dueFrom', 'dueTo'])
  })
})

describe('the pass-through filters', () => {
  it('filters pairing status, direction, period and bank', () => {
    const preds = build('passthrough', {
      ptStatus: 'unpaired', ptDirection: 'out',
      periodFrom: '2026-01', periodTo: '2026-06', bankId: 'b-1',
    })
    expect(on(preds, 'status')).toEqual({ op: 'eq', column: 'status', value: 'unpaired' })
    expect(on(preds, 'direction')).toEqual({ op: 'eq', column: 'direction', value: 'out' })
    expect(on(preds, 'period_month', 'gte')!.value).toBe('2026-01')
    expect(on(preds, 'period_month', 'lte')!.value).toBe('2026-06')
    expect(on(preds, 'bank_id')).toEqual({ op: 'eq', column: 'bank_id', value: 'b-1' })
  })

  it('keeps the period apart from the transaction date', () => {
    const preds = build('passthrough', { dateFrom: '2026-05-01', periodFrom: '2026-04' })
    expect(on(preds, 'transaction_date', 'gte')!.value).toBe('2026-05-01')
    expect(on(preds, 'period_month', 'gte')!.value).toBe('2026-04')
  })
})

describe('the free text', () => {
  it('covers note, reference and account everywhere', () => {
    TABS.forEach(tab => {
      expect(searchColumns(tab)).toEqual(expect.arrayContaining(['note', 'reference_number', 'account_number']))
    })
  })

  it('adds the expense description where the table has one, and the invoice number on invoices', () => {
    expect(searchColumns('transactions')).toContain('expense_description')
    expect(searchColumns('invoices')).toContain('expense_description')
    expect(searchColumns('invoices')).toContain('invoice_number')
    expect(searchColumns('transactions')).not.toContain('invoice_number')
    // pass-through carries no P&L classification, so naming the column would
    // be a 42703 that fails the query rather than a clause that matches less
    expect(searchColumns('passthrough')).not.toContain('expense_description')
  })

  it('joins partner ids in rather than filtering an embedded name', () => {
    const clause = searchOr('transactions', 'figma', ['p-1', 'p-2'])!
    expect(clause).toContain('partner_id.in.(p-1,p-2)')
    expect(clause).not.toContain('partners.name')
  })

  it('still searches the text columns when no partner matched', () => {
    const clause = searchOr('transactions', 'figma', [])!
    expect(clause).toContain('note.ilike')
    expect(clause).not.toContain('partner_id.in')
  })

  it('quotes the term so a comma or a bracket cannot tear the clause apart', () => {
    expect(orValue('a,b')).toBe('"%a,b%"')
    expect(orValue('x)y')).toBe('"%x)y%"')
    expect(orValue('he"llo')).toBe('"%hello%"')
    expect(orValue('back\\slash')).toBe('"%backslash%"')
  })

  it('is nothing at all when the box holds only spaces', () => {
    expect(searchOr('transactions', '   ', ['p-1'])).toBeNull()
    expect(build('transactions', { search: '   ' })).toEqual([])
  })
})

describe('the chips', () => {
  const names = {
    company: (id: string) => ({ 'c-1': 'Beta d.o.o.' }[id] || ''),
    partner: (id: string) => ({ 'p-1': 'Figma Inc' }[id] || ''),
    bank: (id: string) => ({ 'b-1': 'Raiffeisen' }[id] || ''),
  }

  it('names a company, a partner and a bank rather than showing their ids', () => {
    expect(activeChips('invoices', f({ companyId: 'c-1', partnerId: 'p-1' }), names).map(c => c.label))
      .toEqual(['Company: Beta d.o.o.', 'Partner: Figma Inc'])
    expect(activeChips('passthrough', f({ bankId: 'b-1' }), names)[0].label).toBe('Bank: Raiffeisen')
  })

  it('falls back to the id when the lookup has not loaded', () => {
    expect(activeChips('invoices', f({ companyId: 'c-9' }), names)[0].label).toBe('Company: c-9')
    expect(activeChips('invoices', f({ companyId: 'c-9' }))[0].label).toBe('Company: c-9')
  })

  it('shows a preset by its name and a custom range by its dates', () => {
    expect(activeChips('transactions', f({ datePreset: 'ytd', dateFrom: '2026-01-01', dateTo: TODAY }))[0].label)
      .toBe('Date: Year to date')
    expect(activeChips('transactions', f({ dateFrom: '2026-01-01', dateTo: '2026-03-31' }))[0].label)
      .toBe('Date: 2026-01-01 → 2026-03-31')
    expect(activeChips('transactions', f({ dateFrom: '2026-01-01' }))[0].label)
      .toBe('Date: from 2026-01-01')
    expect(activeChips('transactions', f({ dateTo: '2026-03-31' }))[0].label)
      .toBe('Date: until 2026-03-31')
  })

  it('reads an amount range in both one-sided forms', () => {
    expect(activeChips('transactions', f({ amountFrom: '100', amountTo: '500' }))[0].label)
      .toBe('Amount: 100 RSD – 500 RSD')
    expect(activeChips('transactions', f({ amountFrom: '1250' }))[0].label).toBe('Amount: ≥ 1.250 RSD')
    expect(activeChips('transactions', f({ amountTo: '500' }), {}, 'EUR')[0].label).toBe('Amount: ≤ 500 EUR')
  })

  it('spells the enum values out instead of showing the database token', () => {
    expect(activeChips('transactions', f({ txType: 'invoice_payment' }))[0].label).toBe('Type: Invoice payment')
    expect(activeChips('passthrough', f({ ptDirection: 'in' }))[0].label).toBe('Direction: In')
    expect(activeChips('invoices', f({ invoiceStatus: 'unpaid' }))[0].label).toBe('Status: Unpaid')
  })

  it('labels the P&L chip as a revenue stream when that is what it filters', () => {
    expect(activeChips('transactions', f({ plCategory: 'Aimfox', direction: 'revenue' })).map(c => c.label))
      .toContain('Revenue stream: Aimfox')
    expect(activeChips('transactions', f({ plCategory: 'Payroll' })).map(c => c.label))
      .toContain('P&L: Payroll')
  })

  it('clears a child picker along with its parent, so no orphan narrows the query', () => {
    const state = f({ department: 'Engineering', deptSubcategory: 'Tools' })
    const dept = activeChips('transactions', state).find(c => c.id === 'department')!
    const cleared = clearFields(state, dept.clears)
    expect(cleared.department).toBe('')
    expect(cleared.deptSubcategory).toBe('')
    expect(buildPredicates('transactions', cleared, { today: TODAY, currency: 'RSD' })).toEqual([])
  })

  it('removes exactly one filter and leaves the rest standing', () => {
    const state = f({ companyId: 'c-1', currency: 'EUR', search: 'figma' })
    const chips = activeChips('transactions', state)
    expect(chips).toHaveLength(3)
    const next = clearFields(state, chips.find(c => c.id === 'currency')!.clears)
    expect(activeChips('transactions', next).map(c => c.id)).toEqual(['company', 'search'])
  })

  it('has one chip for every filter the query actually applies', () => {
    // A filter that narrows the result without a chip is the thing the rebuild
    // is meant to remove: something applied that nothing on screen admits to.
    const everything = f({
      companyId: 'c-1', datePreset: 'ytd', dateFrom: '2026-01-01', dateTo: TODAY,
      amountFrom: '10', amountTo: '99', currency: 'EUR', search: 'figma',
      expenseDescription: 'Figma', department: 'Engineering', deptSubcategory: 'Tools',
      plCategory: 'Operating Expenses', plSubcategory: 'Software',
      direction: 'expense', txType: 'direct', unclassified: true,
      invoiceStatus: 'unpaid', overdue: true, dueFrom: '2026-02-01', dueTo: '2026-03-01',
      partnerId: 'p-1', ptStatus: 'unpaired', ptDirection: 'in',
      periodFrom: '2026-01', periodTo: '2026-06', bankId: 'b-1',
    })
    TABS.forEach(tab => {
      const chipFields = new Set(activeChips(tab, everything).flatMap(c => c.clears))
      // every field this tab owns and has a value for is represented by a chip
      FIELDS_BY_TAB[tab].forEach(field => {
        if (field === 'datePreset') return
        const v = (everything as any)[field]
        if (v === '' || v === false) return
        expect(chipFields.has(field)).toBe(true)
      })
      expect(buildPredicates(tab, everything, { today: TODAY, currency: 'RSD' }).length).toBeGreaterThan(0)
    })
  })

  it('leaves nothing applied once every chip is removed', () => {
    const everything = f({
      companyId: 'c-1', dateFrom: '2026-01-01', dateTo: TODAY, amountFrom: '10',
      currency: 'EUR', search: 'figma', department: 'Engineering', txType: 'direct',
      direction: 'expense', unclassified: true, expenseDescription: 'Figma',
    })
    let state = everything
    activeChips('transactions', state).forEach(chip => { state = clearFields(state, chip.clears) })
    expect(activeChips('transactions', state)).toEqual([])
    expect(buildPredicates('transactions', state, { today: TODAY, currency: 'RSD' })).toEqual([])
  })
})

describe('clear all', () => {
  it('empties every filter the tab owns', () => {
    const state = f({ companyId: 'c-1', search: 'figma', txType: 'direct', unclassified: true })
    const cleared = clearTab('transactions', state)
    expect(activeChips('transactions', cleared)).toEqual([])
    expect(buildPredicates('transactions', cleared, { today: TODAY, currency: 'RSD' })).toEqual([])
  })

  it('does not disturb a field the tab does not own', () => {
    const state = f({ ptStatus: 'unpaired', search: 'figma' })
    const cleared = clearTab('transactions', state)
    expect(cleared.search).toBe('')
    expect(cleared.ptStatus).toBe('unpaired')
  })
})

describe('paging', () => {
  const PAGE_SIZE = 50

  it('has one (empty) page when there are no results', () => {
    expect(lastPageIndex(0, PAGE_SIZE)).toBe(0)
    expect(pageRange(0, PAGE_SIZE, 0)).toEqual({ from: 0, to: 0 })
    expect(pageLabel(0, PAGE_SIZE, 0)).toBe('0 of 0')
    expect(hasPrevPage(0)).toBe(false)
    expect(hasNextPage(0, PAGE_SIZE, 0)).toBe(false)
  })

  it('is a single page when the count exactly fills one page', () => {
    expect(lastPageIndex(PAGE_SIZE, PAGE_SIZE)).toBe(0)
    expect(pageRange(0, PAGE_SIZE, PAGE_SIZE)).toEqual({ from: 1, to: 50 })
    expect(pageLabel(0, PAGE_SIZE, PAGE_SIZE)).toBe('1–50 of 50')
    expect(hasPrevPage(0)).toBe(false)
    expect(hasNextPage(0, PAGE_SIZE, PAGE_SIZE)).toBe(false)
  })

  it('reports the middle page of a multi-page result', () => {
    // 142 rows over pages of 50: 50, 50, 42 — page index 1 is the second page.
    expect(lastPageIndex(142, PAGE_SIZE)).toBe(2)
    expect(pageRange(1, PAGE_SIZE, 142)).toEqual({ from: 51, to: 100 })
    expect(pageLabel(1, PAGE_SIZE, 142)).toBe('51–100 of 142')
    expect(hasPrevPage(1)).toBe(true)
    expect(hasNextPage(1, PAGE_SIZE, 142)).toBe(true)
  })

  it('puts a single leftover row alone on the last page', () => {
    // 151 rows: pages of 50, 50, 50, 1.
    expect(lastPageIndex(151, PAGE_SIZE)).toBe(3)
    expect(pageRange(3, PAGE_SIZE, 151)).toEqual({ from: 151, to: 151 })
    expect(pageLabel(3, PAGE_SIZE, 151)).toBe('151–151 of 151')
    expect(hasPrevPage(3)).toBe(true)
    expect(hasNextPage(3, PAGE_SIZE, 151)).toBe(false)
  })

  it('disables previous only on the first page', () => {
    expect(hasPrevPage(0)).toBe(false)
    expect(hasPrevPage(1)).toBe(true)
  })

  it('disables next only on the last page', () => {
    expect(hasNextPage(2, PAGE_SIZE, 142)).toBe(false)
    expect(hasNextPage(1, PAGE_SIZE, 142)).toBe(true)
  })
})
