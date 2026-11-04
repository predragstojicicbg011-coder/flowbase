import {
  advancePaymentProblem, advanceProformaSide, advancesPayableBy, coverageProblem, paymentSide, proformaSidesOffered, openAdvancesNotice, proformaFromPayment, proformaNumbersIn, proposeCoverage, proposeUsage, usageProblem,
  type OpenAdvance, type PaidProforma,
} from './advances'

const adv = (over: Partial<OpenAdvance>): OpenAdvance => ({
  id: 'a1', invoice_number: 'RA2027179', invoice_date: '2026-10-08', amount: 18144, open: 18144, currency: 'RSD', ...over,
})
const pf = (over: Partial<PaidProforma>): PaidProforma => ({
  id: 'p1', invoice_number: '256173', paid: 18144, covered: 0, currency: 'RSD', ...over,
})

describe('which advances a final invoice uses', () => {
  it('B.B. Link: the whole bill from the one advance it names', () => {
    expect(proposeUsage([{ number: 'RA2027179', date: '2026-10-08' }], 18144, [adv({})]))
      .toEqual({ usage: [{ advanceId: 'a1', amount: 18144 }], missing: [], left: 0 })
  })

  it('DST: part of the bill', () => {
    const r = proposeUsage([{ number: '0033/26', date: null }], 13260, [adv({ id: 'd1', invoice_number: '0033/26', amount: 13260, open: 13260 })])
    expect(r.usage).toEqual([{ advanceId: 'd1', amount: 13260 }])
  })

  it('Bepro: part of the advance, the rest stays open', () => {
    const r = proposeUsage([{ number: 'AV104/2026', date: null }], 323125.57, [adv({ id: 'b1', invoice_number: 'AV104/2026', amount: 329725.45, open: 329725.45 })])
    expect(r.usage).toEqual([{ advanceId: 'b1', amount: 323125.57 }])
  })

  it('two advances in the order the bill names them, each up to what is left of it', () => {
    const r = proposeUsage(
      [{ number: 'A-2', date: null }, { number: 'A-1', date: null }], 150000,
      [adv({ id: 'x1', invoice_number: 'A-1', open: 100000 }), adv({ id: 'x2', invoice_number: 'A 2', open: 80000 })])
    expect(r.usage).toEqual([{ advanceId: 'x2', amount: 80000 }, { advanceId: 'x1', amount: 70000 }])
  })

  it('takes from each advance what the bill says it paid', () => {
    const r = proposeUsage(
      [{ number: 'A-1', date: null, amount: 30000 }, { number: 'A-2', date: null, amount: 70000 }], 100000,
      [adv({ id: 'x1', invoice_number: 'A-1', open: 100000 }), adv({ id: 'x2', invoice_number: 'A-2', open: 100000 })])
    expect(r.usage).toEqual([{ advanceId: 'x1', amount: 30000 }, { advanceId: 'x2', amount: 70000 }])
  })

  it('an advance not in the books is missing, and what it would cover is left', () => {
    const r = proposeUsage([{ number: 'RA-9', date: '2025-01-01' }], 5000, [adv({})])
    expect(r).toEqual({ usage: [], missing: [{ number: 'RA-9', date: '2025-01-01' }], left: 5000 })
  })
})

describe('which paid proformas an advance invoice covers', () => {
  it('prefers the proforma its text names', () => {
    expect(proposeCoverage(18144, [pf({ id: 'p0', invoice_number: '1' }), pf({})], ['256173']))
      .toEqual([{ proformaId: 'p1', amount: 18144 }])
  })

  it('takes several, each up to what is paid and not yet covered', () => {
    expect(proposeCoverage(150000, [pf({ id: 'p1', paid: 100000, covered: 20000 }), pf({ id: 'p2', paid: 100000 })], []))
      .toEqual([{ proformaId: 'p1', amount: 80000 }, { proformaId: 'p2', amount: 70000 }])
  })

  it('proposes nothing it cannot cover in full', () => {
    expect(proposeCoverage(250000, [pf({ paid: 200000 })], [])).toEqual([])
  })

  it('says why an advance invoice larger than what was paid cannot be linked', () => {
    expect(coverageProblem(250000, [pf({ paid: 200000 })])).toBe('Avansni račun (250.000,00) je veći od plaćenog po izabranim predračunima (200.000,00).')
    expect(coverageProblem(150000, [pf({ paid: 200000 })])).toBeNull()
  })
})

describe('using advances on a final invoice', () => {
  it('refuses more than is left of an advance, or more than the bill', () => {
    expect(usageProblem(100000, [{ amount: 60000, open: 50000 }])).toBe('Od avansnog računa je ostalo 50.000,00, a traži se 60.000,00.')
    expect(usageProblem(100000, [{ amount: 60000, open: 80000 }, { amount: 50000, open: 80000 }])).toBe('Iskorišćeni avans (110.000,00) je veći od računa (100.000,00).')
    expect(usageProblem(100000, [{ amount: 60000, open: 80000 }])).toBeNull()
  })
})

describe('reading an advance invoice', () => {
  it('finds the proforma number in the supplier\'s words', () => {
    expect(proformaNumbersIn('Avansna uplata po predračunu br. 256173')).toEqual(['256173'])
    expect(proformaNumbersIn('Avans po predračunu 177/2026 od 07.10.2026')).toEqual(['177/2026'])
    expect(proformaNumbersIn('Avansna uplata od 12.10.2026. po predračunu br. 9917/017 (stopa 20%)')).toEqual(['9917/017'])
    expect(proformaNumbersIn('Avans po ugovoru br.1371/26 od 25.03.2026')).toEqual([])
  })
})

describe('telling the person a supplier has open advances', () => {
  it('counts and sums them', () => {
    expect(openAdvancesNotice([adv({ open: 300000 }), adv({ id: 'a2', open: 35000 })]))
      .toBe('Dobavljač ima otvorene avanse: 2 avansna računa, ukupno 335.000,00 RSD')
    expect(openAdvancesNotice([adv({ open: 1 })])).toBe('Dobavljač ima otvorene avanse: 1 avansni račun, ukupno 1,00 RSD')
    expect(openAdvancesNotice([adv({ open: 0 })])).toBe('')
    expect(openAdvancesNotice([adv({ open: 120000 })], 'revenue')).toBe('Kupac ima otvorene avanse: 1 avansni račun, ukupno 120.000,00 RSD')
  })
})

describe('a proforma made from a payment', () => {
  const pay = { companyId: 'co1', partnerId: 'p1', date: '2026-10-12', amount: 190140, currency: 'RSD', accountNumber: '160-1-11', description: 'Uplata po predracunu 9917/017', eurRate: 117.2 }

  it('carries the supplier, amount, date and account of the payment, with no P&L', () => {
    expect(proformaFromPayment(pay)).toEqual({
      ok: true,
      row: {
        company_id: 'co1', partner_id: 'p1', invoice_number: null, invoice_date: '2026-10-12', due_date: '2026-10-12',
        type: 'expense', currency: 'RSD', amount: 190140, amount_rsd: 190140, exchange_rate: 1, eur_rate: 117.2, amount_eur: 1622.35,
        document_type: 'proforma', pl_impact: false, status: 'unpaid', account_number: '160-1-11',
        note: 'Predračun napravljen iz uplate od 12.10.2026: Uplata po predracunu 9917/017',
      },
    })
  })

  it('needs a supplier, an amount paid out, and dinars', () => {
    expect(proformaFromPayment({ ...pay, partnerId: null })).toEqual({ ok: false, why: 'Prvo izaberite dobavljača.' })
    expect(proformaFromPayment({ ...pay, amount: 0 })).toEqual({ ok: false, why: 'Predračun se pravi samo iz isplate.' })
    expect(proformaFromPayment({ ...pay, eurRate: null })).toEqual({ ok: false, why: 'Nema EUR kursa za dan uplate; unesite predračun ručno.' })
    expect(proformaFromPayment({ ...pay, currency: 'EUR' })).toEqual({ ok: false, why: 'Iz uplate se pravi samo dinarski predračun; devizni unesite kao predračun.' })
  })
})

describe('a customer proforma from a receipt', () => {
  const pay = { companyId: 'co1', partnerId: 'k1', date: '2026-10-12', amount: 120000, currency: 'RSD', accountNumber: '160-2-22', description: null, eurRate: 120, side: 'revenue' as const }

  it('makes a customer proforma from a receipt', () => {
    const made = proformaFromPayment(pay)
    expect(made.ok && made.row).toMatchObject({
      type: 'revenue', partner_id: 'k1', amount: 120000, amount_rsd: 120000, amount_eur: 1000,
      document_type: 'proforma', pl_impact: false, note: 'Predračun napravljen iz uplate kupca od 12.10.2026',
    })
  })

  it('needs the customer first', () => {
    expect(proformaFromPayment({ ...pay, partnerId: null })).toEqual({ ok: false, why: 'Prvo izaberite kupca.' })
  })
})

describe('paying an advance invoice from the bank statement', () => {
  const pay = { companyId: 'co1', partnerId: 'p1', date: '2026-10-12', amount: 18144, currency: 'RSD', accountNumber: '160-1-11', description: 'Uplata', eurRate: 117.2 }

  it('the proforma made for it names the advance invoice', () => {
    const made = proformaFromPayment({ ...pay, forAdvance: 'RA2027179' })
    expect(made.ok && made.row.note).toBe('Predračun napravljen iz uplate od 12.10.2026 za avansni račun RA2027179: Uplata')
  })

  it('a payment smaller than the advance invoice cannot cover it', () => {
    expect(advancePaymentProblem(10000, { invoice_number: 'RA2027179', amount: 18144, currency: 'RSD' }, 'RSD'))
      .toBe('Uplata (10.000,00) je manja od avansnog računa RA2027179 (18.144,00): avansni račun ne može biti veći od plaćenog.')
    expect(advancePaymentProblem(18144, { invoice_number: 'RA2027179', amount: 18144, currency: 'RSD' }, 'RSD')).toBeNull()
    expect(advancePaymentProblem(20000, { invoice_number: 'RA2027179', amount: 18144, currency: 'RSD' }, 'RSD')).toBeNull()
  })

  it('only in the same currency', () => {
    expect(advancePaymentProblem(200, { invoice_number: 'A-1', amount: 100, currency: 'EUR' }, 'RSD'))
      .toBe('Avansni račun A-1 je u EUR, a uplata u RSD.')
  })
})

describe('which way a payment went', () => {
  it('is the statement row side first, then the invoices it settles, then the side it was saved with', () => {
    expect(paymentSide({ bankSide: 'revenue', linkedTypes: ['expense'], storedSubtype: 'expense' })).toBe('revenue')
    expect(paymentSide({ linkedTypes: ['revenue', 'revenue'], storedSubtype: 'expense' })).toBe('revenue')
    expect(paymentSide({ linkedTypes: [], storedSubtype: 'expense' })).toBe('expense')
  })

  it('is unknown when nothing says it, or the invoices disagree', () => {
    expect(paymentSide({})).toBeNull()
    expect(paymentSide({ linkedTypes: ['expense', 'revenue'] })).toBeNull()
    expect(paymentSide({ storedSubtype: 'direct' })).toBeNull()
  })
})

describe('paying an advance invoice with a payment', () => {
  const supplierAdv = { id: 's', type: 'expense', partner_id: 'p1', invoice_number: 'AV-S' }
  const customerAdv = { id: 'c', type: 'revenue', partner_id: 'p2', invoice_number: 'AV-K' }

  it('lists a customer advance invoice for a receipt and a supplier one for a payment out', () => {
    expect(advancesPayableBy([supplierAdv, customerAdv], 'revenue', null).map(a => a.id)).toEqual(['c'])
    expect(advancesPayableBy([supplierAdv, customerAdv], 'expense', null).map(a => a.id)).toEqual(['s'])
    expect(advancesPayableBy([supplierAdv, customerAdv], null, null).map(a => a.id)).toEqual(['s', 'c'])
    expect(advancesPayableBy([supplierAdv, customerAdv], null, 'p2').map(a => a.id)).toEqual(['c'])
  })

  it('makes the proforma on the advance invoice side', () => {
    expect(advanceProformaSide(customerAdv, 'revenue')).toEqual({ ok: true, side: 'revenue' })
    expect(advanceProformaSide(supplierAdv, 'expense')).toEqual({ ok: true, side: 'expense' })
    expect(advanceProformaSide(customerAdv, null)).toEqual({ ok: true, side: 'revenue' })
  })

  it('refuses when the money went the other way', () => {
    expect(advanceProformaSide(customerAdv, 'expense')).toEqual({ ok: false, why: 'Avansni račun AV-K je izdat kupcu: plaća se uplatom kupca, ne isplatom.' })
    expect(advanceProformaSide(supplierAdv, 'revenue')).toEqual({ ok: false, why: 'Avansni račun AV-S je dobavljačev: plaća se isplatom, ne uplatom.' })
    expect(advanceProformaSide({ type: null, invoice_number: 'AV-X' }, 'expense')).toEqual({ ok: false, why: 'Avansni račun AV-X nema smer (ulazni ili izlazni); otvorite ga i proverite.' })
  })

  it('offers only the proforma of the payment side, both while it is unknown', () => {
    expect(proformaSidesOffered('revenue')).toEqual(['revenue'])
    expect(proformaSidesOffered('expense')).toEqual(['expense'])
    expect(proformaSidesOffered(null)).toEqual(['expense', 'revenue'])
  })
})
