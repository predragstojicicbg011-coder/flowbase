import { partnerCardPrintHtml } from './partnerCardPrint'
import { buildPartnerCard } from './partnerCard'

// The card as a page to print or save as PDF: the header names both sides
// and the period, the table and the verdict are the screen's, the two lists
// below say they are out of the balance, and nothing the partner wrote can
// turn into markup.

const card = buildPartnerCard({
  documents: [
    { id: 'f1', invoice_number: 'F-412/26', invoice_date: '2026-10-03', type: 'expense', document_type: 'invoice', currency: 'RSD',
      amount: 120000, amount_rsd: 120000, adjusts_invoice_id: null, prior_period: false, advance_open: null, advance_deducted_rsd: 0 },
    { id: 'a1', invoice_number: 'AV104/2026', invoice_date: '2026-10-05', type: 'expense', document_type: 'advance_invoice', currency: 'RSD',
      amount: 50000, amount_rsd: 50000, adjusts_invoice_id: null, prior_period: true, advance_open: 50000, advance_deducted_rsd: 0 },
  ],
  payments: [{ invoice_id: 'f1', transaction_id: 't1', date: '2026-10-12', amount_rsd: 60000, bank: 'OTP banka' }],
  usage: [], coverage: [],
  direct: [{ id: 'd1', date: '2026-10-15', amount_rsd: 8400, bank: 'Banca Intesa', note: 'prevoz <robe>', direction: 'out' }],
}, { from: '2026-10-01', to: '2026-10-31' })

const html = partnerCardPrintHtml({
  company: { full_legal_name: 'Milinković Company doo', address: 'Ulica 1', city: 'Beograd', pib: '100000001' },
  partner: { name: 'Beton & Plus doo', tax_id: '100000004', address: 'Put 2', city: 'Novi Sad' },
  period: { from: '2026-10-01', to: '2026-10-31' },
  card,
  generatedOn: '2026-10-31',
})

describe('the printed partner card', () => {
  it('names both sides, the period and the day it was made', () => {
    expect(html).toContain('<title>Kartica partnera — Beton &amp; Plus doo</title>')
    expect(html).toContain('Milinković Company doo')
    expect(html).toContain('PIB 100000001')
    expect(html).toContain('Beton &amp; Plus doo')
    expect(html).toContain('PIB 100000004')
    expect(html).toContain('Period: 01.10.2026 – 31.10.2026')
    expect(html).toContain('Izrađeno 31.10.2026')
  })

  it('carries the table, the opening balance and the verdict', () => {
    expect(html).toContain('Početni saldo')
    expect(html).toContain('Račun F-412/26')
    expect(html).toContain('Isplata — OTP banka')
    expect(html).toContain('120.000,00')
    expect(html).toContain('Dugujemo partneru na 31.10.2026')
    expect(html).toContain('60.000,00 RSD')
  })

  it('lists advances and direct payments as out of the balance, escaped', () => {
    expect(html).toContain('Avansi kod dobavljača (ne ulaze u saldo)')
    expect(html).toContain('AV104/2026')
    expect(html).toContain('Direktna plaćanja bez računa (ne menjaju saldo)')
    expect(html).toContain('prevoz &lt;robe&gt;')
    expect(html).not.toContain('<robe>')
  })

  it('prints on A4 and opens the print dialog by itself', () => {
    expect(html).toContain('@page { size: A4')
    expect(html).toContain('window.print()')
  })
})
