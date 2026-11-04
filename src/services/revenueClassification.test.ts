import {
  classificationProblem, proposeLease, proposeProject, revenueKindOf, serviceMonthIn, REVENUE_KIND_LABEL,
} from './revenueClassification'
import type { PlanInvoice, RentalLease } from './revenuePlan'
import type { Project } from './projects'

const lease = (over: Partial<RentalLease> = {}): RentalLease => ({
  id: 'l1', project_id: 'zgrada', tenant_partner_id: 'k1', monthly_rent: 50000, currency: 'RSD',
  start_date: '2026-01-01', end_date: null, invoice_day: 1, payment_days: 15, active: true, ...over,
})

const project = (over: Partial<Project> = {}): Project => ({
  id: 'p1', company_id: 'co1', name: 'Novi Beograd A1', code: 'NB-01', kind: 'construction',
  investor_partner_id: null, contract_value: null, contract_currency: null, contract_date: null,
  contract_value_rsd: null, contract_value_eur: null, payment_days: 45, active: true, note: null, ...over,
})

const inv = (over: Record<string, unknown> = {}) => ({
  partnerId: 'k1', net: 50000, gross: null, currency: 'RSD', date: '2026-10-31', text: '', ...over,
}) as Parameters<typeof proposeLease>[0]

describe('revenueKindOf', () => {
  it('reads the kind from what the invoice is on', () => {
    expect(revenueKindOf({ lease_id: 'l1', project_id: 'zgrada' })).toBe('lease')
    expect(revenueKindOf({ project_id: 'p1' })).toBe('project')
    expect(revenueKindOf({})).toBe('services')
    expect(revenueKindOf({ lease_id: null, project_id: null })).toBe('services')
    expect(REVENUE_KIND_LABEL).toEqual({ project: 'Projekat', lease: 'Zakup', services: 'Prodaja usluga' })
  })
})

describe('serviceMonthIn', () => {
  it('reads the four forms of a month', () => {
    expect(serviceMonthIn('zakup za oktobar 2026')).toBe('2026-10-01')
    expect(serviceMonthIn('Zakupnina za mesec oktobra 2026. godine')).toBe('2026-10-01')
    expect(serviceMonthIn('zakup 10/2026')).toBe('2026-10-01')
    expect(serviceMonthIn('zakup 10.2026')).toBe('2026-10-01')
    expect(serviceMonthIn('zakup za mart 2026')).toBe('2026-03-01')
  })

  it('finds nothing where no month is named', () => {
    expect(serviceMonthIn('bez meseca')).toBeNull()
    expect(serviceMonthIn('')).toBeNull()
    expect(serviceMonthIn('faktura od 31.10.2026')).toBeNull()
    expect(serviceMonthIn('zakup 13/2026')).toBeNull()
  })
})

describe('proposeLease', () => {
  it('proposes the lease when the amount is the monthly rent', () => {
    const p = proposeLease(inv(), [lease()], [])
    expect(p).toMatchObject({ leaseId: 'l1', projectId: 'zgrada', serviceMonth: '2026-10-01', alreadyBilled: false })
    expect(p?.why).toMatch(/oktobar 2026/)
  })

  it('takes the month from the text before the date', () => {
    const p = proposeLease(inv({ text: 'zakup za septembar 2026' }), [lease()], [])
    expect(p?.serviceMonth).toBe('2026-09-01')
  })

  it('flags a month already billed', () => {
    const billed: PlanInvoice[] = [{
      project_id: 'zgrada', type: 'revenue', invoice_date: '2026-10-01', lease_id: 'l1', service_month: '2026-10-01',
    }]
    expect(proposeLease(inv(), [lease()], billed)?.alreadyBilled).toBe(true)
    const removed: PlanInvoice[] = [{ ...billed[0], deleted_at: '2026-10-05T10:00:00Z' }]
    expect(proposeLease(inv(), [lease()], removed)?.alreadyBilled).toBe(false)
  })

  it('matches the rent with VAT too', () => {
    expect(proposeLease(inv({ net: null, gross: 50000 }), [lease()], [])?.leaseId).toBe('l1')
    expect(proposeLease(inv({ net: 50000, gross: 60000 }), [lease({ monthly_rent: 60000 })], [])?.leaseId).toBe('l1')
  })

  it('does not guess between two leases without the amount', () => {
    const two = [lease(), lease({ id: 'l2', project_id: 'zgrada2' })]
    expect(proposeLease(inv({ net: 12345, text: 'zakup za oktobar 2026' }), two, [])).toBeNull()
    expect(proposeLease(inv(), two, [])).toBeNull()
  })

  it('picks the lease the amount fits among two', () => {
    const two = [lease(), lease({ id: 'l2', project_id: 'zgrada2', monthly_rent: 80000 })]
    expect(proposeLease(inv({ net: 80000 }), two, [])?.leaseId).toBe('l2')
  })

  it('proposes the only lease when the text names the month, without an amount', () => {
    const p = proposeLease(inv({ net: 12345, text: 'zakup za oktobar 2026' }), [lease()], [])
    expect(p?.leaseId).toBe('l1')
    expect(proposeLease(inv({ net: 12345 }), [lease()], [])).toBeNull()
  })

  it('ignores another tenant, a closed lease and another currency', () => {
    expect(proposeLease(inv({ partnerId: 'k2' }), [lease()], [])).toBeNull()
    expect(proposeLease(inv(), [lease({ active: false })], [])).toBeNull()
    expect(proposeLease(inv({ currency: 'EUR' }), [lease()], [])).toBeNull()
    expect(proposeLease(inv({ partnerId: null }), [lease()], [])).toBeNull()
  })
})

describe('proposeProject', () => {
  const none: { partner_id: string | null; project_id: string | null; invoice_date: string | null; lease_id?: string | null }[] = []

  it('1: the code or the name of an active site is in the number or the text', () => {
    const projects = [project(), project({ id: 'p2', code: 'ZM-02', name: 'Zemun Park' })]
    expect(proposeProject({ partnerId: 'k1', number: 'IF-1', text: 'privremena situacija NB-01' }, projects, none)?.projectId).toBe('p1')
    expect(proposeProject({ partnerId: 'k1', number: 'IF-1', text: 'radovi, Zemun Park, oktobar' }, projects, none)?.projectId).toBe('p2')
    expect(proposeProject({ partnerId: 'k1', number: 'NB-01/26', text: '' }, projects, none)?.projectId).toBe('p1')
  })

  it('1: a closed site or a rental building is not matched by name', () => {
    const projects = [project({ active: false }), project({ id: 'p2', kind: 'rental', code: 'ZG', name: 'Zgrada Zemun' })]
    expect(proposeProject({ partnerId: 'k1', number: null, text: 'NB-01 Zgrada Zemun' }, projects, none)).toBeNull()
  })

  it('2: the most frequent project of the last five invoices, newest on a tie, rent left out', () => {
    const projects = [project(), project({ id: 'p2', code: 'ZM-02', name: 'Zemun Park' })]
    const h = (project_id: string | null, invoice_date: string, extra: Record<string, unknown> = {}) =>
      ({ partner_id: 'k1', project_id, invoice_date, ...extra })
    const history = [
      h('p2', '2026-09-01'), h('p1', '2026-08-01'), h('p1', '2026-07-01'),
      h('p2', '2026-06-01', { lease_id: 'l1' }), h('p2', '2026-05-01', { lease_id: 'l1' }),
      h('p2', '2026-04-01'), h('p2', '2026-03-01'),
    ]
    // Last five without rent: p2, p1, p1, p2, p2 -> p2 three times.
    expect(proposeProject({ partnerId: 'k1', number: null, text: '' }, projects, history)?.projectId).toBe('p2')
    const tie = [h('p1', '2026-09-01'), h('p2', '2026-08-01')]
    expect(proposeProject({ partnerId: 'k1', number: null, text: '' }, projects, tie)?.projectId).toBe('p1')
    const other = [{ partner_id: 'k9', project_id: 'p1', invoice_date: '2026-09-01' }]
    expect(proposeProject({ partnerId: 'k1', number: null, text: '' }, projects, other)).toBeNull()
  })

  it('3: the only active site the customer is the investor of', () => {
    const projects = [project({ investor_partner_id: 'k1' }), project({ id: 'p2', code: 'ZM-02', name: 'Zemun Park', investor_partner_id: 'k2' })]
    expect(proposeProject({ partnerId: 'k1', number: null, text: '' }, projects, none)?.projectId).toBe('p1')
    const twoOwned = [project({ investor_partner_id: 'k1' }), project({ id: 'p2', code: 'ZM-02', name: 'Zemun Park', investor_partner_id: 'k1' })]
    expect(proposeProject({ partnerId: 'k1', number: null, text: '' }, twoOwned, none)).toBeNull()
  })

  it('finds nothing without a customer or a hint', () => {
    expect(proposeProject({ partnerId: null, number: null, text: '' }, [project()], none)).toBeNull()
  })
})

describe('classificationProblem', () => {
  const c = (over: Record<string, unknown> = {}) =>
    ({ kind: 'project', projectId: 'p1', leaseId: null, serviceMonth: null, ...over }) as Parameters<typeof classificationProblem>[0]

  it('asks for a choice, a project, or a lease and month', () => {
    expect(classificationProblem(c({ kind: null }), 'invoice')).toBe('Izaberite: projekat, zakup ili prodaja usluga.')
    expect(classificationProblem(c({ projectId: null }), 'invoice')).toBe('Izaberite projekat.')
    expect(classificationProblem(c({ kind: 'lease', projectId: null }), 'invoice')).toBe('Izaberite zakup i mesec usluge.')
    expect(classificationProblem(c({ kind: 'lease', leaseId: 'l1' }), 'invoice')).toBe('Izaberite zakup i mesec usluge.')
  })

  it('accepts a complete choice', () => {
    expect(classificationProblem(c(), 'invoice')).toBeNull()
    expect(classificationProblem(c({ kind: 'services', projectId: null }), 'invoice')).toBeNull()
    expect(classificationProblem(c({ kind: 'lease', leaseId: 'l1', serviceMonth: '2026-10-01' }), 'invoice')).toBeNull()
  })

  it('keeps rent to invoices', () => {
    const why = 'Zakup se bira samo na računu; ovaj dokument ide na projekat zgrade.'
    for (const t of ['credit_note', 'debit_note', 'proforma', 'advance_invoice'] as const) {
      expect(classificationProblem(c({ kind: 'lease', leaseId: 'l1', serviceMonth: '2026-10-01' }), t)).toBe(why)
    }
    expect(classificationProblem(c({ kind: 'project' }), 'credit_note')).toBeNull()
  })
})
