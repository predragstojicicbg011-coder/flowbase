import { carriesInto, classificationKey, creditScheduleByMonth, seedFromEntries, type SourceEntry } from './budgetForecast'
import { creditLegsFrom } from './creditClassification'
import { TEST_SYSTEM_CATEGORIES } from './systemCategories.fixture'

/** The credit legs as the owner set them — see systemCategories.fixture. */
const LEGS = creditLegsFrom(TEST_SYSTEM_CATEGORIES)
const CREDIT_PRINCIPAL = LEGS.principal
const CREDIT_INTEREST = LEGS.interest

const entry = (over: Partial<SourceEntry> = {}): SourceEntry => ({
  pl_category: 'Operating Expenses',
  pl_subcategory: 'Telecom',
  department: 'Administration',
  dept_subcategory: 'Office',
  expense_description: 'Telekom',
  amount_rsd: 100,
  cf_type: 'recurring',
  cf_frequency: 'monthly',
  pl_date: '2026-08-14',
  ...over,
})

const MONTHS = ['2026-09', '2026-10', '2026-11', '2026-12']

describe('classificationKey', () => {
  it('joins the five levels so two rows of the same kind share a key', () => {
    expect(classificationKey(entry())).toBe('Operating Expenses|Telecom|Administration|Office|Telekom')
  })

  it('treats a missing level as empty rather than dropping it', () => {
    expect(classificationKey(entry({ dept_subcategory: null, expense_description: null })))
      .toBe('Operating Expenses|Telecom|Administration||')
  })
})

describe('seedFromEntries', () => {
  it('carries a monthly recurring amount into every month', () => {
    const { byKey } = seedFromEntries([entry()], MONTHS, '2026-08', 'RSD', LEGS)
    const k = classificationKey(entry())
    expect(MONTHS.map(m => byKey[k][m])).toEqual([100, 100, 100, 100])
  })

  it('lands a quarterly amount every third month, not smeared across them', () => {
    const { byKey } = seedFromEntries([entry({ cf_frequency: 'quarterly' })], MONTHS, '2026-08', 'RSD', LEGS)
    const k = classificationKey(entry())
    expect(MONTHS.map(m => byKey[k][m] || 0)).toEqual([0, 0, 100, 0])
  })

  it('lands a yearly amount in the same month next year', () => {
    const months = ['2026-09', '2027-07', '2027-08', '2027-09']
    const { byKey } = seedFromEntries([entry({ cf_frequency: 'yearly' })], months, '2026-08', 'RSD', LEGS)
    const k = classificationKey(entry())
    expect(months.map(m => byKey[k][m] || 0)).toEqual([0, 0, 100, 0])
  })

  it('does not carry a one-time cost forward', () => {
    const { byKey } = seedFromEntries([entry({ cf_type: 'one_time' })], MONTHS, '2026-08', 'RSD', LEGS)
    expect(Object.keys(byKey)).toEqual([])
  })

  it('does not carry capex forward', () => {
    const { byKey } = seedFromEntries([entry({ cf_type: 'capex' })], MONTHS, '2026-08', 'RSD', LEGS)
    expect(Object.keys(byKey)).toEqual([])
  })

  it('does not carry an unclassified cost forward', () => {
    const { byKey } = seedFromEntries([entry({ cf_type: null })], MONTHS, '2026-08', 'RSD', LEGS)
    expect(Object.keys(byKey)).toEqual([])
  })

  it('reports what it refused to carry, so the shortfall is visible', () => {
    const { notCarried } = seedFromEntries([
      entry({ cf_type: 'one_time', amount_rsd: 300 }),
      entry({ cf_type: null, amount_rsd: 40 }),
      entry({ amount_rsd: 100 }),
    ], MONTHS, '2026-08', 'RSD', LEGS)
    expect(notCarried).toBe(340)
  })

  it('ignores entries outside the benchmark month', () => {
    const { byKey, notCarried } = seedFromEntries([
      entry({ pl_date: '2026-07-14' }),
    ], MONTHS, '2026-08', 'RSD', LEGS)
    expect(Object.keys(byKey)).toEqual([])
    expect(notCarried).toBe(0)
  })

  it('adds up two entries of the same classification', () => {
    const { byKey } = seedFromEntries([entry({ amount_rsd: 60 }), entry({ amount_rsd: 40 })], MONTHS, '2026-08', 'RSD', LEGS)
    expect(byKey[classificationKey(entry())]['2026-09']).toBe(100)
  })

  it('treats a missing amount as zero rather than NaN', () => {
    const { byKey } = seedFromEntries([entry({ amount_rsd: null })], MONTHS, '2026-08', 'RSD', LEGS)
    expect(byKey[classificationKey(entry())]['2026-09']).toBe(0)
  })

  it('defaults a recurring entry with no frequency to monthly', () => {
    const { byKey } = seedFromEntries([entry({ cf_frequency: null })], MONTHS, '2026-08', 'RSD', LEGS)
    expect(byKey[classificationKey(entry())]['2026-09']).toBe(100)
  })
})

import { commitmentsByMonth, type Installment, type OpenInvoice } from './budgetForecast'

describe('commitmentsByMonth', () => {
  const inst = (over: Partial<Installment> = {}): Installment => ({
    id: 'i1', credit_name: 'Intesa 100k', installment_no: 14,
    due_date: '2026-10-05', principal_amount: 5343.9, interest_amount: 241.83,
    status: 'outstanding', currency: 'EUR', exchangeRate: 117.2, eurRate: 117.2, ...over,
  })

  // Dated before the benchmark month by default, so the ordinary cases below
  // are invoices no seed carries and the double-count guard stays out of their
  // way.
  const inv = (over: Partial<OpenInvoice> = {}): OpenInvoice => ({
    id: 'v1', partner_name: 'Telekom', invoice_date: '2026-07-10',
    due_date: '2026-09-20', remaining_rsd: 420, pl_impact: true,
    cf_type: 'recurring', cf_frequency: 'monthly', ...over,
  })

  const MONTHS = ['2026-09', '2026-10', '2026-11']
  const BENCHMARK = '2026-08'

  it('CARRIES NO CREDIT INSTALMENT AT ALL any more', () => {
    // It used to, and this row showed two banks' instalments
    // beside a small payment-card invoice. "Committed" sits under the table
    // with no category, so the largest outflow of the month was the only one
    // a reader could not look up — while the credit rows above it estimated
    // nothing. The schedule belongs on those rows; see `creditScheduleByMonth`.
    const r = commitmentsByMonth([inv()], MONTHS, BENCHMARK)
    expect(r.byMonth['2026-10']).toBeUndefined()
    expect(r.byMonth['2026-09'].items.every(i => i.kind === 'invoice')).toBe(true)
  })

  it('lists each commitment so the drill can show what it is made of', () => {
    const r = commitmentsByMonth([inv()], MONTHS, BENCHMARK)
    expect(r.byMonth['2026-09'].items[0].label).toBe('Telekom')
  })

  it('puts an unpaid invoice in its due month at what is left on it', () => {
    const r = commitmentsByMonth([inv()], MONTHS, BENCHMARK)
    expect(r.byMonth['2026-09'].total).toBe(420)
  })

  it('ignores anything due AFTER the horizon, which belongs to no month drawn', () => {
    // Only forward. A due date before the horizon is not outside it in the
    // same sense — that bill is owed now, and it is filed in the first month;
    // see the overdue tests below.
    const r = commitmentsByMonth([inv({ due_date: '2027-05-04' })], MONTHS, BENCHMARK)
    expect(Object.keys(r.byMonth)).toEqual([])
  })

  it('adds up several commitments in one month', () => {
    const r = commitmentsByMonth([inv(), inv({ id: 'v2', remaining_rsd: 80 })], MONTHS, BENCHMARK)
    expect(r.byMonth['2026-09'].total).toBe(500)
  })

  it('skips an invoice with no due date rather than guessing one', () => {
    const r = commitmentsByMonth([inv({ due_date: null })], MONTHS, BENCHMARK)
    expect(Object.keys(r.byMonth)).toEqual([])
  })

  // ── The two sources overlap, and the overlap is exactly one month ─────────
  //
  // v_pl_entries carries an invoice at its invoice_date whether it has been
  // paid or not, so an unpaid invoice dated in the benchmark month is part of
  // the seed for every month ahead. Counting it again as a commitment at its
  // due date reads one bill twice.
  it('does not count an invoice the benchmark month already seeded', () => {
    // Telekom, dated 2026-08-20, due 2026-09-20, 420 RSD, unpaid, recurring
    // monthly. September's seed already carries the 420 RSD.
    const r = commitmentsByMonth([inv({ invoice_date: '2026-08-20' })], MONTHS, BENCHMARK)
    expect(r.byMonth['2026-09']).toBeUndefined()
  })

  it('counts an invoice dated after the benchmark month, which nothing seeded', () => {
    const r = commitmentsByMonth([inv({ invoice_date: '2026-09-02' })], MONTHS, BENCHMARK)
    expect(r.byMonth['2026-09'].total).toBe(420)
  })

  // ── Could have been seeded is not the same as was ──────────────────────────
  //
  // The skip above asks whether the seed could SEE the invoice. It used to
  // stop there, and the seed only carries a benchmark entry forward when its
  // `cf_type` is `recurring` — so everything else dated in the benchmark month
  // was absent from the seed, absent from this row, and present only inside
  // the `notCarried` total under the table, which names no invoice and no
  // month. September's Committed row read 11 RSD with a year of bills behind it.

  it('COUNTS A ONE-TIME INVOICE dated in the benchmark month, which no seed carried', () => {
    const r = commitmentsByMonth(
      [inv({ invoice_date: '2026-08-20', cf_type: 'one-time' })], MONTHS, BENCHMARK)
    expect(r.byMonth['2026-09'].total).toBe(420)
  })

  it('counts one with no cash-flow type at all, for the same reason', () => {
    const r = commitmentsByMonth(
      [inv({ invoice_date: '2026-08-20', cf_type: null, cf_frequency: null })],
      MONTHS, BENCHMARK)
    expect(r.byMonth['2026-09'].total).toBe(420)
  })

  it('COUNTS A QUARTERLY ONE in the months the seed skips over', () => {
    // Dated in August, due in September. The seed carries it into November
    // and into no month before it, so September and October are this row's.
    const quarterly = inv({
      invoice_date: '2026-08-20', cf_frequency: 'quarterly', due_date: '2026-09-20',
    })
    expect(commitmentsByMonth([quarterly], MONTHS, BENCHMARK).byMonth['2026-09'].total)
      .toBe(420)
    // And in the month the seed DOES carry it into, it is still skipped.
    const onTheBoundary = inv({
      invoice_date: '2026-08-20', cf_frequency: 'quarterly', due_date: '2026-11-20',
    })
    expect(commitmentsByMonth([onTheBoundary], MONTHS, BENCHMARK).byMonth['2026-11'])
      .toBeUndefined()
  })

  // ── Overdue is owed now, not never ─────────────────────────────────────────

  it('FILES AN OVERDUE INVOICE IN THE FIRST MONTH rather than dropping it', () => {
    // Its due date has passed and it is still unpaid. That is not a forecast
    // at all — it is a debt standing today, and it was the one kind of
    // commitment the row could not show.
    const r = commitmentsByMonth(
      [inv({ invoice_date: '2026-05-02', due_date: '2026-06-15' })], MONTHS, BENCHMARK)
    expect(r.byMonth['2026-09'].total).toBe(420)
  })

  it('says an overdue item is overdue, and which month it was due', () => {
    const r = commitmentsByMonth(
      [inv({ invoice_date: '2026-05-02', due_date: '2026-06-15' })], MONTHS, BENCHMARK)
    expect(r.byMonth['2026-09'].items[0]).toMatchObject({
      overdue: true, dueMonth: '2026-06',
    })
  })

  it('leaves an item due inside the horizon unmarked', () => {
    const r = commitmentsByMonth([inv()], MONTHS, BENCHMARK)
    expect(r.byMonth['2026-09'].items[0].overdue).toBeUndefined()
  })

  it('still leaves out one due after the horizon, which belongs to no month drawn', () => {
    const r = commitmentsByMonth([inv({ due_date: '2027-03-01' })], MONTHS, BENCHMARK)
    expect(Object.keys(r.byMonth)).toEqual([])
  })

  it('counts an invoice dated before the benchmark month, which nothing seeded either', () => {
    const r = commitmentsByMonth([inv({ invoice_date: '2026-07-10' })], MONTHS, BENCHMARK)
    expect(r.byMonth['2026-09'].total).toBe(420)
  })

  it('counts an invoice carrying no date of its own, having no seed to collide with', () => {
    const r = commitmentsByMonth([inv({ invoice_date: null })], MONTHS, BENCHMARK)
    expect(r.byMonth['2026-09'].total).toBe(420)
  })

  // ── The overlap reaches exactly as far as the seed's own filter ──────────
  //
  // v_pl_entries reads `FROM invoices i WHERE i.type = 'expense' AND
  // i.pl_impact = true`. An invoice outside that filter is in no seed for any
  // month, so skipping it on the benchmark month does not prevent a double
  // count — it deletes the money.
  //
  // The case in production is a payroll filing: PayrollDialog books the parent
  // payable `pl_impact: false` and the per-employee P&L rows as children with
  // `pl_impact: true`.
  it('counts an unpaid invoice the seed never saw, dated in the benchmark month', () => {
    // A payroll filing dated 2026-08-31, due 2026-09-20, 420 RSD, unpaid. The
    // seed skips it for its pl_impact, so the Committed row is its only home.
    const r = commitmentsByMonth([inv({ invoice_date: '2026-08-31', pl_impact: false })], MONTHS, BENCHMARK)
    expect(r.byMonth['2026-09'].total).toBe(420)
  })

  it('still skips a seeded invoice dated in the benchmark month', () => {
    const r = commitmentsByMonth([inv({ invoice_date: '2026-08-20', pl_impact: true })], MONTHS, BENCHMARK)
    expect(r.byMonth['2026-09']).toBeUndefined()
  })

  it('counts either kind when dated outside the benchmark month', () => {
    const r = commitmentsByMonth([
      inv({ id: 'v1', invoice_date: '2026-07-10', pl_impact: true }),
      inv({ id: 'v2', invoice_date: '2026-07-10', pl_impact: false }),
    ], MONTHS, BENCHMARK)
    expect(r.byMonth['2026-09'].total).toBe(840)
    expect(r.byMonth['2026-09'].items).toHaveLength(2)
  })

})

describe('the credit schedule, on the rows it is classified to', () => {
  const inst2 = (over: Partial<Installment> = {}): Installment => ({
    id: 'i1', credit_name: 'Intesa 100k', installment_no: 14,
    due_date: '2026-10-05', principal_amount: 5343.9, interest_amount: 241.83,
    status: 'outstanding', currency: 'EUR', exchangeRate: 117.2, eurRate: 117.2, ...over,
  })
  const HZ = ['2026-09', '2026-10', '2026-11']
  const pKey = classificationKey(CREDIT_PRINCIPAL)
  const iKey = classificationKey(CREDIT_INTEREST)

  it('SPLITS THE INSTALMENT ONTO ITS TWO LEGS, not into one total', () => {
    // Which is the whole gain over the Committed row: principal and interest
    // are different costs, the P&L keeps them apart, and the schedule states
    // them apart. A single total throws that away on the way in.
    // A EUR credit, priced in dinars at the planning rate of 117.2:
    // 5,343.90 × 117.2 = 626,305.08 and 241.83 × 117.2 = 28,342.476 → 28,342.48.
    const { byKey } = creditScheduleByMonth([inst2()], HZ, 'RSD', LEGS)
    expect(byKey[pKey]['2026-10']).toBe(626305.08)
    expect(byKey[iKey]['2026-10']).toBe(28342.48)
  })

  it('keys both legs exactly as the dialogs that book a payment do', () => {
    // So the estimate and the actual beside it are the same two rows, in
    // both branches of the tree.
    const { byKey } = creditScheduleByMonth([inst2()], HZ, 'RSD', LEGS)
    expect(Object.keys(byKey).sort()).toEqual([pKey, iKey].sort())
  })

  it('COUNTS AN INSTALMENT ALREADY PAID, because the month still cost it', () => {
    // A schedule that counts only what is outstanding melts away as the month
    // is paid: the estimate falls to nothing while the actual rises, and the
    // variance reads as an overspend of the whole amount.
    // The cents, stated, because each leg is rounded to them on the way in
    // and the unrounded product is not what any column shows.
    // 626,305.08 + 28,342.48.
    const { total } = creditScheduleByMonth([inst2({ status: 'paid' })], HZ, 'RSD', LEGS)
    expect(total).toBe(654647.56)
  })

  it('files each instalment in the month it falls due', () => {
    const { byKey } = creditScheduleByMonth(
      [inst2(), inst2({ id: 'i2', due_date: '2026-11-05' })], HZ, 'RSD', LEGS)
    expect(byKey[pKey]['2026-10']).toBeGreaterThan(0)
    expect(byKey[pKey]['2026-11']).toBeGreaterThan(0)
  })

  it('adds two instalments falling in one month together', () => {
    const { byKey } = creditScheduleByMonth(
      [inst2(), inst2({ id: 'i2', principal_amount: 1000, interest_amount: 0 })], HZ, 'RSD', LEGS)
    // 626,305.08 + 1,000 × 117.2 = 743,505.08
    expect(byKey[pKey]['2026-10']).toBe(743505.08)
  })

  it('leaves out anything outside the horizon', () => {
    expect(creditScheduleByMonth([inst2({ due_date: '2027-05-05' })], HZ, 'RSD', LEGS).total).toBe(0)
  })

  it('leaves out an instalment with no due date rather than guessing one', () => {
    expect(creditScheduleByMonth([inst2({ due_date: '' })], HZ, 'RSD', LEGS).total).toBe(0)
  })

  it('writes no row for a leg worth nothing', () => {
    const { byKey } = creditScheduleByMonth([inst2({ interest_amount: 0 })], HZ, 'RSD', LEGS)
    expect(byKey[iKey]).toBeUndefined()
  })

  it('prices a EUR schedule in dinars, and reads it in euros as it stands', () => {
    const inRsd = creditScheduleByMonth([inst2()], HZ, 'RSD', LEGS).total
    const inEur = creditScheduleByMonth([inst2()], HZ, 'EUR', LEGS).total
    expect(inEur).toBe(5585.73)          // the euros, unconverted
    expect(inRsd).toBe(654647.56)        // at 117.2 RSD per EUR
    // A dearer euro is a dearer instalment in dinars, and the same in euros.
    const dear = { currency: 'EUR', exchangeRate: 118, eurRate: 118 }
    expect(creditScheduleByMonth([inst2(dear)], HZ, 'RSD', LEGS).total).toBe(659116.14) // 630,580.20 + 28,535.94
    expect(creditScheduleByMonth([inst2(dear)], HZ, 'EUR', LEGS).total).toBe(5585.73)
  })

  it('prices an RSD credit in dinars without any rate, and in euros at the EUR rate', () => {
    const rsd = { currency: 'RSD', exchangeRate: null, eurRate: null }
    expect(creditScheduleByMonth([inst2(rsd)], HZ, 'RSD', LEGS).total).toBe(5585.73)
    // 5,343.90 / 117.2 = 45.596 → 45.60; 241.83 / 117.2 = 2.063 → 2.06
    expect(creditScheduleByMonth([inst2({ currency: 'RSD', exchangeRate: 1, eurRate: 117.2 })], HZ, 'EUR', LEGS).total)
      .toBe(47.66)
  })

  it('LEAVES OUT AND NAMES an instalment it has no rate for, rather than guessing one', () => {
    const r = creditScheduleByMonth([inst2({ exchangeRate: null, eurRate: null })], HZ, 'RSD', LEGS)
    expect(r.total).toBe(0)
    expect(r.unpriced).toEqual(['i1'])
    // In its own currency it needs no rate at all.
    expect(creditScheduleByMonth([inst2({ exchangeRate: null, eurRate: null })], HZ, 'EUR', LEGS).total).toBe(5585.73)
  })
})

// ── The other overlap: a credit instalment, counted twice ────────────────────
//
// Every dialog that books a credit payment posts it `pl_impact: true,
// cf_type: 'recurring', cf_frequency: 'monthly'` — correctly, because that is
// what the payment is. So a payment made in the benchmark month used to seed
// into every month of the horizon, while `credit_installments` put the real
// dated schedule on top of it. In production that was every instalment
// counted twice across the horizon.
//
// Resolved the opposite way to the invoice overlap: the SEED goes, not the
// commitment, because the schedule is exact — dated, principal and interest
// apart, to the cent — and the seed is a worse approximation of the same thing.

import { isCreditPayment } from './budgetForecast'

describe('isCreditPayment', () => {
  it('recognises the principal leg this app writes', () => {
    expect(isCreditPayment(CREDIT_PRINCIPAL, LEGS)).toBe(true)
  })

  it('recognises the interest leg this app writes', () => {
    expect(isCreditPayment(CREDIT_INTEREST, LEGS)).toBe(true)
  })

  it('does not recognise ordinary spend', () => {
    expect(isCreditPayment(entry(), LEGS)).toBe(false)
  })

  // The reason it matches the whole classification rather than a name or a
  // substring of one: four levels out of five is a different cost.
  it.each([
    ['pl_category', { pl_category: 'Financial Expenses' }],
    ['pl_subcategory', { pl_subcategory: 'Bank Fees' }],
    ['department', { department: 'Administration' }],
    ['dept_subcategory', { dept_subcategory: 'Office' }],
    ['expense_description', { expense_description: 'Credit card' }],
  ])('is not fooled by a row differing only in %s', (_level, over) => {
    expect(isCreditPayment({ ...CREDIT_PRINCIPAL, ...over }, LEGS)).toBe(false)
  })

  it('does not take an empty classification for a credit payment', () => {
    expect(isCreditPayment({
      pl_category: null, pl_subcategory: null, department: null,
      dept_subcategory: null, expense_description: null,
    }, LEGS)).toBe(false)
  })
})

describe('seedFromEntries and a credit instalment', () => {
  const creditEntry = (leg: typeof CREDIT_PRINCIPAL, amount: number): SourceEntry =>
    entry({ ...leg, amount_rsd: amount })

  it('seeds a credit payment into no month at all', () => {
    const { byKey } = seedFromEntries(
      [creditEntry(CREDIT_PRINCIPAL, 20000), creditEntry(CREDIT_INTEREST, 6000)],
      MONTHS, '2026-08', 'RSD', LEGS)
    expect(Object.keys(byKey)).toEqual([])
  })

  it('keeps it out of the per-company seed as well, not only the merged one', () => {
    const { byCompany } = seedFromEntries(
      [creditEntry(CREDIT_PRINCIPAL, 20000)], MONTHS, '2026-08', 'RSD', LEGS)
    expect(Object.keys(byCompany[''] || {})).toEqual([])
  })

  // `notCarried` means "this spend is in NO month of the forecast". A credit
  // instalment is in every month it falls due; it just arrives from
  // `commitmentsByMonth` instead. Reporting it missing sends the reader hunting
  // for a shortfall that is not there.
  it('does not report it as a shortfall, because it is not missing', () => {
    const { notCarried } = seedFromEntries(
      [creditEntry(CREDIT_PRINCIPAL, 20000), creditEntry(CREDIT_INTEREST, 6000)],
      MONTHS, '2026-08', 'RSD', LEGS)
    expect(notCarried).toBe(0)
  })

  it('does not report it as a shortfall even when it was booked one-time', () => {
    const { notCarried } = seedFromEntries(
      [entry({ ...CREDIT_PRINCIPAL, amount_rsd: 20000, cf_type: 'one_time' })],
      MONTHS, '2026-08', 'RSD', LEGS)
    expect(notCarried).toBe(0)
  })

  it('still seeds an ordinary recurring cost carrying the same cf_type', () => {
    const { byKey, notCarried } = seedFromEntries([
      creditEntry(CREDIT_PRINCIPAL, 20000),
      entry({ amount_rsd: 100 }),
    ], MONTHS, '2026-08', 'RSD', LEGS)
    expect(byKey[classificationKey(entry())]['2026-09']).toBe(100)
    expect(Object.keys(byKey)).toHaveLength(1)
    expect(notCarried).toBe(0)
  })

  it('still seeds spend that matches only part of the credit classification', () => {
    const almost = entry({ ...CREDIT_PRINCIPAL, department: 'Administration', amount_rsd: 900 })
    const { byKey } = seedFromEntries([almost], MONTHS, '2026-08', 'RSD', LEGS)
    expect(byKey[classificationKey(almost)]['2026-09']).toBe(900)
  })
})

describe('a benchmark-month credit payment and its schedule, end to end', () => {
  const HORIZON = Array.from({ length: 12 }, (_, i) => {
    const m = 9 + i
    return m <= 12 ? `2026-${String(m).padStart(2, '0')}` : `2027-${String(m - 12).padStart(2, '0')}`
  })
  const BENCHMARK = '2026-08'

  /** August's payment: 20,000 RSD principal + 6,000 RSD interest, on an RSD credit. */
  const paid = [
    entry({ ...CREDIT_PRINCIPAL, amount_rsd: 20000, pl_date: '2026-08-31' }),
    entry({ ...CREDIT_INTEREST, amount_rsd: 6000, pl_date: '2026-08-31' }),
  ]

  /** The same credit's real schedule: one instalment in each month ahead. */
  const schedule: Installment[] = HORIZON.map((m, i) => ({
    id: `i${i}`, credit_name: 'Intesa 100k', installment_no: 18 + i,
    due_date: `${m}-05`, principal_amount: 20000, interest_amount: 6000,
    status: 'outstanding', currency: 'RSD', exchangeRate: 1, eurRate: 117.2,
  }))

  const seededOver = (months: string[], byKey: Record<string, Record<string, number>>) =>
    months.reduce((s, m) => s + Object.values(byKey).reduce((t, per) => t + (per[m] || 0), 0), 0)


  it('produces the schedule figure once across the horizon, not twice', () => {
    const { byKey } = seedFromEntries(paid, HORIZON, BENCHMARK, 'RSD', LEGS)
    const sched = creditScheduleByMonth(schedule, HORIZON, 'RSD', LEGS)

    const seeded = seededOver(HORIZON, byKey)

    // The schedule states 26,000 RSD a month for twelve months.
    expect(sched.total).toBe(312000)
    // And the seed states nothing, because the schedule already said it.
    expect(seeded).toBe(0)
    expect(seeded + sched.total).toBe(312000)
  })

  // What the same fixture used to produce, held here so the regression is a
  // number rather than a memory. An entry identical to the principal leg in
  // every way except its classification still seeds — which is exactly what the
  // credit legs did before this fix.
  it('used to produce it twice — 624,000 RSD for a 312,000 RSD schedule', () => {
    const asOrdinarySpend = paid.map((e, i) => ({
      ...e, department: 'Administration', dept_subcategory: 'Office',
      expense_description: `Leg ${i}`,
    }))
    const { byKey } = seedFromEntries(asOrdinarySpend, HORIZON, BENCHMARK, 'RSD', LEGS)
    const sched = creditScheduleByMonth(schedule, HORIZON, 'RSD', LEGS)

    expect(seededOver(HORIZON, byKey)).toBe(312000)
    expect(seededOver(HORIZON, byKey) + sched.total).toBe(624000)
  })

  it('leaves a single month reading 26,000 RSD rather than 52,000 RSD', () => {
    const { byKey } = seedFromEntries(paid, HORIZON, BENCHMARK, 'RSD', LEGS)
    const sched = creditScheduleByMonth(schedule, ['2026-09'], 'RSD', LEGS)
    expect(seededOver(['2026-09'], byKey) + sched.total).toBe(26000)
  })
})

import { applyLedger, deltaForTarget, type Adjustment } from './budgetForecast'

describe('applyLedger', () => {
  const adj = (over: Partial<Adjustment>): Adjustment => ({
    id: 'a1', kind: 'adjust', amount_rsd: 0, reason: 'r',
    created_at: '2026-09-01T10:00:00Z', ...over,
  })

  it('returns the seeded base when nothing has been changed', () => {
    expect(applyLedger(800, [])).toBe(800)
  })

  it('adds a positive adjustment', () => {
    expect(applyLedger(800, [adj({ amount_rsd: 200 })])).toBe(1000)
  })

  it('subtracts a negative one', () => {
    expect(applyLedger(800, [adj({ amount_rsd: -150 })])).toBe(650)
  })

  it('replaces the base with a set, ignoring the seed', () => {
    expect(applyLedger(800, [adj({ kind: 'set', amount_rsd: 500 })])).toBe(500)
  })

  it('applies adjustments recorded after a set, and none from before it', () => {
    expect(applyLedger(800, [
      adj({ id: 'a1', amount_rsd: 100, created_at: '2026-09-01T10:00:00Z' }),
      adj({ id: 'a2', kind: 'set', amount_rsd: 500, created_at: '2026-09-02T10:00:00Z' }),
      adj({ id: 'a3', amount_rsd: 50, created_at: '2026-09-03T10:00:00Z' }),
    ])).toBe(550)
  })

  it('honours the latest set when there are several', () => {
    expect(applyLedger(800, [
      adj({ id: 'a1', kind: 'set', amount_rsd: 500, created_at: '2026-09-01T10:00:00Z' }),
      adj({ id: 'a2', kind: 'set', amount_rsd: 300, created_at: '2026-09-05T10:00:00Z' }),
    ])).toBe(300)
  })

  it('reads in time order whatever order it is given them in', () => {
    expect(applyLedger(800, [
      adj({ id: 'a3', amount_rsd: 50, created_at: '2026-09-03T10:00:00Z' }),
      adj({ id: 'a2', kind: 'set', amount_rsd: 500, created_at: '2026-09-02T10:00:00Z' }),
    ])).toBe(550)
  })

  it('cancels a change with a counter-entry, since nothing is deleted', () => {
    expect(applyLedger(800, [
      adj({ id: 'a1', amount_rsd: 200 }),
      adj({ id: 'a2', amount_rsd: -200, created_at: '2026-09-04T10:00:00Z' }),
    ])).toBe(800)
  })

  // ── A FIGURE THAT WAS TYPED STOPS MOVING ─────────────────────────────────
  //
  // The fault this was written for. The benchmark month is whatever month
  // precedes today, so it changes by itself on the 1st. A figure stored as a
  // delta against the seed therefore read one number in October and another in
  // November, having been touched by nobody: budgeting November in October,
  // the seed was September's spend carried forward; come November it was
  // October's, and every figure moved by the difference between the two.
  //
  // So the entry records the seed it was measured against, and that recorded
  // seed — not the live one — is what the deltas are replayed on top of.

  it('reads back what was typed even after the seed has moved', () => {
    // Typed in October against a September-seeded 800, to read 1000.
    const typed = adj({ amount_rsd: 200, seed_rsd: 800 })
    // November arrives, the benchmark becomes October, the seed is now 1,350.
    expect(applyLedger(1350, [typed])).toBe(1000)
  })

  it('still reads the live seed where nothing has been typed', () => {
    expect(applyLedger(1350, [])).toBe(1350)
  })

  /**
   * Two edits, and the second is the one that counts. Its own delta was taken
   * against the figure the cell showed WHILE the first was already in it, so
   * replaying both on the second's recorded base is what gives the figure back.
   */
  it('pins to the most recent entry and replays every delta on it', () => {
    expect(applyLedger(9999, [
      adj({ id: 'a1', amount_rsd: 200, seed_rsd: 800, created_at: '2026-10-02T10:00:00Z' }),
      // The cell read 1000 when this was typed; the owner asked for 1,500.
      adj({ id: 'a2', amount_rsd: 500, seed_rsd: 800, created_at: '2026-10-09T10:00:00Z' }),
    ])).toBe(1500)
  })

  /**
   * Entries written before this existed carry no base. They keep the old
   * behaviour rather than being pinned to a number nobody recorded — a guess
   * at what the seed used to be is a figure the owner never typed.
   */
  it('falls back to the live seed for an entry that recorded no base', () => {
    expect(applyLedger(1350, [adj({ amount_rsd: 200 })])).toBe(1550)
  })

  /**
   * Postgres `numeric` reaches some clients as a string, and a string base
   * turns the first `+=` into a concatenation: 11900 and 500 would read
   * 11900500 rather than 12400. Read as a figure or not used at all.
   */
  it('reads a base that arrived as a string', () => {
    expect(applyLedger(1350, [adj({ amount_rsd: 200, seed_rsd: '800' as any })])).toBe(1000)
  })

  it('ignores a base that is not a figure at all', () => {
    expect(applyLedger(1350, [adj({ amount_rsd: 200, seed_rsd: 'n/a' as any })])).toBe(1550)
  })

  /**
   * And one re-typed figure anchors the line again: the newest base wins, so
   * re-recording a drifted figure is the whole of the repair.
   */
  it('lets a newer entry pin a line whose older entries never did', () => {
    expect(applyLedger(9999, [
      adj({ id: 'a1', amount_rsd: 200, created_at: '2026-09-02T10:00:00Z' }),
      adj({ id: 'a2', amount_rsd: 50, seed_rsd: 800, created_at: '2026-11-02T10:00:00Z' }),
    ])).toBe(1050)
  })
})

describe('deltaForTarget', () => {
  it('works out the change from the figure on screen to the one typed', () => {
    expect(deltaForTarget(800, 1000)).toBe(200)
    expect(deltaForTarget(800, 650)).toBe(-150)
  })

  it('rounds to the cent, so a float artefact is never written to the ledger', () => {
    expect(deltaForTarget(0.1 + 0.2, 1)).toBe(0.7)
  })

  it('is zero when nothing changed', () => {
    expect(deltaForTarget(800, 800)).toBe(0)
  })
})

import { rollUp, variance, type ForecastNode } from './budgetForecast'

describe('rollUp', () => {
  const node = (key: string, over: Partial<ForecastNode> = {}): ForecastNode => ({
    key, label: key, level: 'department', parent: null,
    seed: 0, ledger: 0, actual: 0, ...over,
  })

  it('makes a parent the sum of its children', () => {
    const out = rollUp([
      node('mkt'),
      node('mkt/ads', { parent: 'mkt', seed: 5100 }),
      node('mkt/tools', { parent: 'mkt', seed: 2300 }),
    ])
    expect(out.find(n => n.key === 'mkt')!.budget).toBe(7400)
  })

  it('adds an amount entered on the parent to its children, never replacing them', () => {
    const out = rollUp([
      node('mkt', { ledger: 600 }),
      node('mkt/ads', { parent: 'mkt', seed: 5100 }),
    ])
    expect(out.find(n => n.key === 'mkt')!.budget).toBe(5700)
  })

  it('rolls actuals the same way', () => {
    const out = rollUp([
      node('mkt'),
      node('mkt/ads', { parent: 'mkt', actual: 5240 }),
      node('mkt/tools', { parent: 'mkt', actual: 2665 }),
    ])
    expect(out.find(n => n.key === 'mkt')!.actualTotal).toBe(7905)
  })

  it('carries a figure up through more than one level', () => {
    const out = rollUp([
      node('pl'),
      node('pl/sub', { parent: 'pl' }),
      node('pl/sub/leaf', { parent: 'pl/sub', seed: 900 }),
    ])
    expect(out.find(n => n.key === 'pl')!.budget).toBe(900)
  })

  it('leaves a leaf as its own seed plus its own ledger', () => {
    const out = rollUp([node('solo', { seed: 400, ledger: -50 })])
    expect(out.find(n => n.key === 'solo')!.budget).toBe(350)
  })

  it('reports what a parent holds directly, so it can be shown as its own row', () => {
    const out = rollUp([
      node('mkt', { ledger: 600 }),
      node('mkt/ads', { parent: 'mkt', seed: 5100 }),
    ])
    expect(out.find(n => n.key === 'mkt')!.direct).toBe(600)
  })

  it('does not lose a node whose parent is missing', () => {
    const out = rollUp([node('orphan', { parent: 'gone', seed: 100 })])
    expect(out.find(n => n.key === 'orphan')!.budget).toBe(100)
  })

  it('totals the same whichever branch the same money is arranged into', () => {
    // The two branches are the same five levels in a different order, so the
    // roots must add up to the same figure. This is the check that catches a
    // branch quietly dropping a row that has no value at one of its levels.
    const dept = rollUp([
      node('d:Marketing'),
      node('d:Marketing|Office', { parent: 'd:Marketing' }),
      node('d:Marketing|Office|Ads', { parent: 'd:Marketing|Office', seed: 5100 }),
      node('d:Unassigned', { seed: 400 }),
    ])
    const pl = rollUp([
      node('p:Operating'),
      node('p:Operating|Advertising', { parent: 'p:Operating', seed: 5100 }),
      node('p:Unassigned', { seed: 400 }),
    ])
    const total = (ns: typeof dept) => ns.filter(n => !n.parent).reduce((s, n) => s + n.budget, 0)
    expect(total(dept)).toBe(total(pl))
  })
})

describe('variance', () => {
  it('is positive under budget and negative over it', () => {
    expect(variance(8000, 7905)).toBe(95)
    expect(variance(8000, 8400)).toBe(-400)
  })

  it('is zero on the nose', () => {
    expect(variance(8000, 8000)).toBe(0)
  })
})


describe('carriesInto', () => {
  // The drill under a budget cell lists the entries that seeded it, and it asks
  // this. It has to answer exactly what `seedFromEntries` seeded with, or the
  // list stops matching the number it was opened from.
  const asks = (over: Partial<SourceEntry>, month: string) =>
    carriesInto(entry(over), '2026-08', month)

  it('agrees with the seed, month for month, for every frequency', () => {
    for (const freq of ['monthly', 'quarterly', 'yearly']) {
      const { byKey } = seedFromEntries([entry({ cf_frequency: freq })], MONTHS, '2026-08', 'RSD', LEGS)
      const k = classificationKey(entry())
      for (const m of MONTHS) {
        expect(asks({ cf_frequency: freq }, m)).toBe((byKey[k]?.[m] || 0) > 0)
      }
    }
  })

  it('carries nothing that is not recurring', () => {
    expect(asks({ cf_type: 'one_time' }, '2026-09')).toBe(false)
    expect(asks({ cf_type: 'capex' }, '2026-09')).toBe(false)
    expect(asks({ cf_type: null }, '2026-09')).toBe(false)
  })

  it('carries nothing backwards, and nothing into the benchmark itself', () => {
    expect(asks({}, '2026-08')).toBe(false)
    expect(asks({}, '2026-07')).toBe(false)
  })
})

// ── The same arithmetic, read in EUR ────────────────────────────────────────
//
// Budgets are planned in RSD, and every input carries its EUR figure beside
// the RSD one. Reading the budget in EUR is reading the other column — never
// a conversion of the RSD result.

import { ledgerReadableIn, ledgerFigure, pinnedBase } from './budgetForecast'

describe('reading the budget in EUR', () => {
  const adjE = (over: Partial<Adjustment>): Adjustment => ({
    id: 'a1', kind: 'adjust', amount_rsd: 0, amount_eur: 0, reason: 'r',
    created_at: '2026-09-01T10:00:00Z', ...over,
  })

  it('seeds from the EUR actuals, not from the RSD ones', () => {
    const e = entry({ amount_rsd: 11720, amount_eur: 100 })
    expect(seedFromEntries([e], MONTHS, '2026-08', 'EUR', LEGS).byKey[classificationKey(e)]['2026-09']).toBe(100)
    expect(seedFromEntries([e], MONTHS, '2026-08', 'RSD', LEGS).byKey[classificationKey(e)]['2026-09']).toBe(11720)
    expect(seedFromEntries([e], MONTHS, '2026-08', 'RSD', LEGS).byKey[classificationKey(e)]['2026-09']).toBe(11720)
  })

  it('counts what is not carried in the currency asked for', () => {
    const e = entry({ cf_type: 'one_time', amount_rsd: 23440, amount_eur: 200 })
    expect(seedFromEntries([e], MONTHS, '2026-08', 'EUR', LEGS).notCarried).toBe(200)
    expect(seedFromEntries([e], MONTHS, '2026-08', 'RSD', LEGS).notCarried).toBe(23440)
  })

  it('replays the ledger on the EUR seed with the EUR amounts', () => {
    const typed = adjE({ amount_rsd: 23440, amount_eur: 200, seed_rsd: 93760, seed_eur: 800 })
    expect(applyLedger(1000, [typed], 'EUR')).toBe(1000)      // 800 + 200, pinned
    expect(applyLedger(117200, [typed], 'RSD')).toBe(117200)  // 93,760 + 23,440, pinned
  })

  it('pins on the EUR seed recorded with the entry, as it does on the RSD one', () => {
    expect(pinnedBase([adjE({ seed_rsd: 93760, seed_eur: 800 })], 5, 'EUR')).toBe(800)
    expect(pinnedBase([adjE({ seed_rsd: 93760, seed_eur: null })], 5, 'EUR')).toBe(5)
  })

  it('says a ledger with a dinar-only entry cannot be read in EUR, and refuses to read it as zero', () => {
    const dinarOnly = adjE({ id: 'old', amount_rsd: 5000, amount_eur: null })
    expect(ledgerReadableIn([dinarOnly], 'RSD')).toBe(true)
    expect(ledgerReadableIn([dinarOnly], 'EUR')).toBe(false)
    expect(() => ledgerFigure(dinarOnly, 'EUR')).toThrow(/nema iznos u EUR/)
    expect(() => applyLedger(0, [dinarOnly], 'EUR')).toThrow(/nema iznos u EUR/)
    expect(applyLedger(0, [dinarOnly], 'RSD')).toBe(5000)
  })

  it('files commitments at their EUR remainder when asked in EUR', () => {
    const v: OpenInvoice = {
      id: 'v1', partner_name: 'Telekom', invoice_date: '2026-07-10',
      due_date: '2026-09-20', remaining_rsd: 49224, remaining_eur: 420, pl_impact: true,
      cf_type: 'recurring', cf_frequency: 'monthly',
    }
    expect(commitmentsByMonth([v], ['2026-09'], '2026-08', 'EUR').byMonth['2026-09'].total).toBe(420)
    expect(commitmentsByMonth([v], ['2026-09'], '2026-08').byMonth['2026-09'].total).toBe(49224)
  })
})

import { budgetLineKey } from './budgetForecast'
import { makeClassKey } from './budgetKeys'

describe('the seed, per project', () => {
  it('keys an overhead row exactly as before projects existed', () => {
    expect(budgetLineKey(entry())).toBe(classificationKey(entry()))
    expect(budgetLineKey(entry({ project_id: null }))).toBe(classificationKey(entry()))
  })

  it('keeps two projects of one classification apart, and apart from overhead', () => {
    const { byKey } = seedFromEntries([
      entry({ amount_rsd: 100 }),
      entry({ amount_rsd: 60, project_id: 'p1' }),
      entry({ amount_rsd: 40, project_id: 'p2' }),
    ], MONTHS, '2026-08', 'RSD', LEGS)
    expect(byKey[classificationKey(entry())]['2026-09']).toBe(100)
    expect(byKey[budgetLineKey(entry({ project_id: 'p1' }))]['2026-09']).toBe(60)
    expect(byKey[budgetLineKey(entry({ project_id: 'p2' }))]['2026-09']).toBe(40)
  })

  it('keys a seed the way the tree and the drill key a row', () => {
    const e = entry({ project_id: 'p1' })
    expect(budgetLineKey(e)).toBe(makeClassKey(e))
  })

  it('still recognises a credit instalment on a project, and seeds none of it', () => {
    const { byKey, notCarried } = seedFromEntries(
      [{ ...entry(), ...CREDIT_PRINCIPAL, project_id: 'p1' } as SourceEntry], MONTHS, '2026-08', 'RSD', LEGS)
    expect(Object.keys(byKey)).toEqual([])
    expect(notCarried).toBe(0)
  })
})

describe('the credit legs not set', () => {
  it('takes nothing for a credit payment — nothing can have been posted as one', () => {
    expect(isCreditPayment(CREDIT_PRINCIPAL, null)).toBe(false)
  })

  it('schedules nothing and names the instalments left out', () => {
    const inst: Installment = {
      id: 'i1', credit_name: 'Intesa', installment_no: 1, due_date: '2026-09-05',
      principal_amount: 100, interest_amount: 10, status: 'outstanding',
      currency: 'RSD', exchangeRate: 1, eurRate: 117.2,
    }
    const r = creditScheduleByMonth([inst, { ...inst, id: 'i2', due_date: '2030-01-05' }], ['2026-09'], 'RSD', null)
    expect(r.total).toBe(0)
    expect(r.byKey).toEqual({})
    expect(r.unclassified).toEqual(['i1'])
  })
})
