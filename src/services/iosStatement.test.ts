import { openItemsAsOf, iosPrintHtml, iosNumber } from './iosStatement'
import { buildPartnerCard, type CardDocument, type CardPayment } from './partnerCard'

// IOS (izvod otvorenih stavki): the documents still open with a supplier on a
// day, and their total, which must be the card's balance on that day.

const doc = (over: Partial<CardDocument>): CardDocument => ({
  id: 'x', invoice_number: null, invoice_date: '2026-10-01', due_date: null, type: 'expense', document_type: 'invoice',
  currency: 'RSD', amount: 0, amount_rsd: 0, adjusts_invoice_id: null, prior_period: false,
  advance_open: null, advance_deducted_rsd: 0, ...over,
})
const pay = (over: Partial<CardPayment>): CardPayment => ({
  invoice_id: 'x', transaction_id: 't', date: '2026-10-01', amount_rsd: 0, bank: 'Banca Intesa', ...over,
})

const input = {
  documents: [
    doc({ id: 'f398', invoice_number: 'F-398/26', invoice_date: '2026-09-15', due_date: '2026-10-15', amount: 250000, amount_rsd: 250000 }),
    doc({ id: 'f412', invoice_number: 'F-412/26', invoice_date: '2026-10-03', due_date: '2026-11-02', amount: 120000, amount_rsd: 120000 }),
    doc({ id: 'ko5', invoice_number: 'KO-5/26', invoice_date: '2026-10-08', document_type: 'credit_note', amount: -20000, amount_rsd: -20000, adjusts_invoice_id: 'f412' }),
    doc({ id: 'f455', invoice_number: 'F-455/26', invoice_date: '2026-10-20', due_date: '2026-11-19', amount: 60000, amount_rsd: 60000 }),
    doc({ id: 'av104', invoice_number: 'AV104/2026', invoice_date: '2026-10-10', document_type: 'advance_invoice', amount: 329725.45, amount_rsd: 329725.45, prior_period: true }),
    doc({ id: 'f745', invoice_number: '745/2026', invoice_date: '2026-10-14', amount: 323125.57, amount_rsd: 323125.57 }),
    doc({ id: 'ko9', invoice_number: 'KO-9/26', invoice_date: '2026-10-21', document_type: 'credit_note', amount: -3000, amount_rsd: -3000 }),
  ],
  payments: [
    pay({ invoice_id: 'f398', transaction_id: 't1', date: '2026-10-12', amount_rsd: 250000 }),
    pay({ invoice_id: 'f412', transaction_id: 't2', date: '2026-10-27', amount_rsd: 70000, bank: 'OTP banka' }),
  ],
  usage: [{ final_invoice_id: 'f745', advance_invoice_id: 'av104', amount_rsd: 323125.57 }],
  coverage: [],
  direct: [{ id: 'd1', date: '2026-10-15', amount_rsd: 8400, bank: 'Banca Intesa', note: 'prevoz', direction: 'out' as const }],
}

describe('open items on a day', () => {
  it('lists what is still open, with its remainder', () => {
    const r = openItemsAsOf(input, '2026-10-31')
    expect(r.items.map(i => [i.number, i.date, i.due, i.amount, i.open])).toEqual([
      ['F-412/26', '2026-10-03', '2026-11-02', 100000, 30000],
      ['F-455/26', '2026-10-20', '2026-11-19', 60000, 60000],
      ['KO-9/26', '2026-10-21', null, -3000, -3000],
    ])
    expect(r.total).toBe(87000)
  })

  it('totals to the card balance on the same day', () => {
    for (const day of ['2026-10-10', '2026-10-14', '2026-10-31']) {
      expect(openItemsAsOf(input, day).total).toBe(buildPartnerCard(input, { from: null, to: day }).closing)
    }
  })

  it('takes nothing after the day: a bill paid later is still open', () => {
    const r = openItemsAsOf(input, '2026-10-11')
    expect(r.items.find(i => i.number === 'F-398/26')?.open).toBe(250000)
    expect(r.items.find(i => i.number === 'F-455/26')).toBeUndefined()
  })
})

describe('the printed IOS', () => {
  const html = iosPrintHtml({
    company: { full_legal_name: 'Primer firma doo', address: 'Ulica 1', city: 'Beograd', pib: '100000001', mb: '20000001' },
    partner: { name: 'Beton <Plus> doo', tax_id: '100000004', registration_number: '20000004', address: 'Put 2', city: 'Novi Sad' },
    asOf: '2026-10-31',
    statement: openItemsAsOf(input, '2026-10-31'),
    advancesOpen: 6599.88,
    number: iosNumber('100000004', '2026-10-31'),
    generatedOn: '2026-11-02',
  })

  it('is headed, numbered and addressed', () => {
    expect(iosNumber('100000004', '2026-10-31')).toBe('IOS-100000004-20261031')
    expect(html).toContain('IZVOD OTVORENIH STAVKI')
    expect(html).toContain('na dan 31.10.2026')
    expect(html).toContain('IOS-100000004-20261031')
    expect(html).toContain('Beograd, 02.11.2026')
    expect(html).toContain('PIB 100000001')
    expect(html).toContain('MB 20000004')
    expect(html).toContain('Beton &lt;Plus&gt; doo')
  })

  it('says what is asked of the supplier', () => {
    expect(html).toContain('u roku od 8 dana od prijema')
    expect(html).toContain('smatraćemo da je stanje usaglašeno')
    expect(html).toContain('Potvrđujemo da je stanje usaglašeno')
    expect(html).toContain('Osporavamo stanje u iznosu od')
    expect(html).toContain('M.P.')
  })

  it('carries the open items, the total and the advances apart', () => {
    expect(html).toContain('F-412/26')
    expect(html).toContain('30.000,00')
    expect(html).toContain('Stanje Vašeg potraživanja prema nama na dan 31.10.2026')
    expect(html).toContain('87.000,00 RSD')
    expect(html).toContain('Dati avansi (ne ulaze u stanje): 6.599,88 RSD')
  })
})
