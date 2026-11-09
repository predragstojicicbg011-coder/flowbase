import {
  SYSTEM_ROLES, CLASS_FIELDS, classificationFor, classificationOrNull, plPartFor, isRoleSet,
  missingRoles, missingMessage, rowsToMap, fetchSystemCategories, saveSystemCategory,
  SystemCategoryMissing, PAYROLL_ROLES, CREDIT_ROLES,
  type SystemCategoryMap,
} from './systemCategories'
import { TEST_SYSTEM_CATEGORIES } from './systemCategories.fixture'

describe('the roles', () => {
  it('has a stable snake_case key, a Serbian label and a description for every role', () => {
    const keys = SYSTEM_ROLES.map(r => r.role)
    expect(new Set(keys).size).toBe(keys.length)
    for (const r of SYSTEM_ROLES) {
      // The same rule as the table's CHECK constraint.
      expect(r.role).toMatch(/^[a-z][a-z0-9_]*$/)
      expect(r.label.trim()).not.toBe('')
      expect(r.description.trim()).not.toBe('')
      expect(r.fields.length).toBeGreaterThan(0)
      for (const f of r.fields) expect(CLASS_FIELDS).toContain(f)
    }
  })

  it('lists the roles payroll and credits always need among the roles', () => {
    for (const r of [...PAYROLL_ROLES, ...CREDIT_ROLES]) {
      expect(SYSTEM_ROLES.map(x => x.role)).toContain(r)
    }
  })

  it('the test fixture sets every role', () => {
    expect(missingRoles(SYSTEM_ROLES.map(r => r.role), TEST_SYSTEM_CATEGORIES)).toEqual([])
  })
})

describe('classificationFor', () => {
  it('returns the role\'s own fields, trimmed, and nulls the rest', () => {
    const map: SystemCategoryMap = {
      payroll_net_salary: {
        pl_category: ' Zarade ', pl_subcategory: 'Neto zarade',
        // Not a field this role owns — must not ride along onto a posting.
        department: 'Uprava',
      },
    }
    expect(classificationFor('payroll_net_salary', map)).toEqual({
      pl_category: 'Zarade', pl_subcategory: 'Neto zarade',
      department: null,
    })
  })

  it('THROWS with a Serbian message that says where to set it', () => {
    expect(() => classificationFor('payroll_net_salary', {})).toThrow(SystemCategoryMissing)
    expect(() => classificationFor('payroll_net_salary', {})).toThrow(
      'Sistemska kategorija „Neto zarade“ nije podešena. Podesite je u Podešavanja → Sistemske kategorije.')
    expect(missingMessage('credit_interest')).toContain('„Kamata na kredit“')
  })

  it('throws when a field the role needs is empty or blank', () => {
    const map: SystemCategoryMap = {
      credit_principal: { ...TEST_SYSTEM_CATEGORIES.credit_principal!, department: '   ' },
    }
    expect(isRoleSet('credit_principal', map)).toBe(false)
    expect(() => classificationFor('credit_principal', map)).toThrow(SystemCategoryMissing)
  })

  it('throws on a null or undefined map', () => {
    expect(() => classificationFor('cashflow_taxes', null)).toThrow(SystemCategoryMissing)
    expect(() => classificationFor('cashflow_taxes', undefined)).toThrow(SystemCategoryMissing)
  })

  it('needs only the fields the role fills', () => {
    // The cash-flow roles name a category and nothing else.
    expect(classificationFor('cashflow_taxes', TEST_SYSTEM_CATEGORIES).pl_category).toBe('Porezi')
  })

  it('carries the error\'s role, for a caller that wants it', () => {
    try {
      classificationFor('payroll_fitpass', {})
      throw new Error('should have thrown')
    } catch (e) {
      expect((e as SystemCategoryMissing).role).toBe('payroll_fitpass')
    }
  })
})

describe('without a sub-sector or a cost description', () => {
  it('no role asks for a sub-sector or a cost description', () => {
    expect(CLASS_FIELDS).toEqual(['pl_category', 'pl_subcategory', 'department'])
    expect(SYSTEM_ROLES.map(r => r.role)).not.toContain('payroll_salary_dept_subcategory')
    for (const r of SYSTEM_ROLES) {
      expect(r.label).not.toMatch(/podsektor/i)
      expect(r.description).not.toMatch(/podsektor/i)
    }
  })

  it('a credit role is set with a category, a subcategory and a sector alone', () => {
    const map: SystemCategoryMap = {
      credit_interest: { pl_category: 'Krediti', pl_subcategory: 'Kamata', department: 'Finansije' },
    }
    expect(isRoleSet('credit_interest', map)).toBe(true)
    expect(classificationFor('credit_interest', map))
      .toEqual({ pl_category: 'Krediti', pl_subcategory: 'Kamata', department: 'Finansije' })
  })

  it('an old row that still carries them keeps working and they are ignored', () => {
    const map = rowsToMap([{
      company_id: 'c1', role: 'credit_interest', pl_category: 'Krediti', pl_subcategory: 'Kamata',
      department: 'Finansije', dept_subcategory: 'Stari podsektor', expense_description: 'Stari opis',
    } as any])
    expect(map.credit_interest).toEqual({ pl_category: 'Krediti', pl_subcategory: 'Kamata', department: 'Finansije' })
    expect(classificationFor('credit_interest', map))
      .toEqual({ pl_category: 'Krediti', pl_subcategory: 'Kamata', department: 'Finansije' })
  })

  it('saving a role clears what an old row carried there', async () => {
    const calls: any[] = []
    const client = { from: () => ({ upsert: (payload: any) => { calls.push(payload); return Promise.resolve({ error: null }) } }) }
    await saveSystemCategory(client, 'c1', 'credit_interest', { pl_category: 'Krediti', pl_subcategory: 'Kamata', department: 'Finansije' })
    expect(calls[0]).toMatchObject({ dept_subcategory: null, expense_description: null, department: 'Finansije' })
  })
})

describe('the other readers', () => {
  it('plPartFor gives the two P&L fields', () => {
    expect(plPartFor('payroll_income_tax', TEST_SYSTEM_CATEGORIES))
      .toEqual({ pl_category: 'Zarade', pl_subcategory: 'Porez na zarade' })
    expect(() => plPartFor('payroll_income_tax', {})).toThrow(SystemCategoryMissing)
  })

  it('classificationOrNull never throws', () => {
    expect(classificationOrNull('cashflow_banking', {})).toBeNull()
    expect(classificationOrNull('cashflow_banking', TEST_SYSTEM_CATEGORIES)!.pl_category).toBe('Bankarski troškovi')
  })

  it('missingRoles keeps the order asked for', () => {
    const { payroll_income_tax: _a, payroll_net_salary: _b, ...rest } = TEST_SYSTEM_CATEGORIES
    expect(missingRoles(PAYROLL_ROLES, rest)).toEqual(['payroll_net_salary', 'payroll_income_tax'])
  })
})

describe('rows and the database', () => {
  const row = (role: string, company_id = 'c1') => ({
    company_id, role, pl_category: 'A', pl_subcategory: 'B',
    department: null,
  })

  it('ignores a role this code does not know', () => {
    expect(rowsToMap([row('payroll_net_salary'), row('something_old')])).toEqual({
      payroll_net_salary: {
        pl_category: 'A', pl_subcategory: 'B', department: null,
      },
    })
  })

  it('keeps to one company when asked', () => {
    const map = rowsToMap([row('payroll_net_salary', 'c2')], 'c1')
    expect(map).toEqual({})
  })

  it('fetches, and throws on a read error rather than reading it as "nothing set"', async () => {
    const ok = { from: () => ({ select: () => Promise.resolve({ data: [row('credit_interest')], error: null }) }) }
    expect(Object.keys(await fetchSystemCategories(ok))).toEqual(['credit_interest'])
    const bad = { from: () => ({ select: () => Promise.resolve({ data: null, error: { message: 'denied' } }) }) }
    await expect(fetchSystemCategories(bad)).rejects.toThrow('Sistemske kategorije nisu učitane: denied')
  })

  it('saves one row per company and role, only the role\'s own fields', async () => {
    const calls: any[] = []
    const client = {
      from: (table: string) => ({
        upsert: (payload: any, opts: any) => { calls.push({ table, payload, opts }); return Promise.resolve({ error: null }) },
      }),
    }
    await saveSystemCategory(client, 'c1', 'cashflow_taxes', {
      pl_category: ' Porezi ', pl_subcategory: 'leftover', department: 'x',
    })
    expect(calls).toHaveLength(1)
    expect(calls[0].table).toBe('system_categories')
    expect(calls[0].opts).toEqual({ onConflict: 'company_id,role' })
    expect(calls[0].payload).toMatchObject({
      company_id: 'c1', role: 'cashflow_taxes', pl_category: 'Porezi',
      pl_subcategory: null, department: null,
    })
  })

  it('says which role a refused save was', async () => {
    const client = { from: () => ({ upsert: () => Promise.resolve({ error: { message: 'permission denied' } }) }) }
    await expect(saveSystemCategory(client, 'c1', 'credit_principal', {}))
      .rejects.toThrow('„Otplata glavnice kredita“ nije sačuvana: permission denied')
  })
})
