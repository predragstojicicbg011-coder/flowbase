import { buildPartnerCard, type CardDocument, type CardPayment } from './partnerCard'

// The Beton Plus example from the agreed layout (A): opening balance, a bill,
// a credit note, two payments, a second bill, an advance and a direct payment.

const doc = (over: Partial<CardDocument>): CardDocument => ({
  id: 'x', invoice_number: null, invoice_date: '2026-10-01', type: 'expense', document_type: 'invoice',
  currency: 'RSD', amount: 0, amount_rsd: 0, adjusts_invoice_id: null, prior_period: false,
  advance_open: null, advance_deducted_rsd: 0, ...over,
})
const pay = (over: Partial<CardPayment>): CardPayment => ({
  invoice_id: 'x', transaction_id: 't', date: '2026-10-01', amount_rsd: 0, bank: 'Banca Intesa', ...over,
})

const docs: CardDocument[] = [
  doc({ id: 'f398', invoice_number: 'F-398/26', invoice_date: '2026-09-15', amount: 250000, amount_rsd: 250000 }),
  doc({ id: 'f412', invoice_number: 'F-412/26', invoice_date: '2026-10-03', amount: 120000, amount_rsd: 120000 }),
  doc({ id: 'ko5', invoice_number: 'KO-5/26', invoice_date: '2026-10-08', document_type: 'credit_note', amount: -20000, amount_rsd: -20000, adjusts_invoice_id: 'f412' }),
  doc({ id: 'f455', invoice_number: 'F-455/26', invoice_date: '2026-10-20', amount: 60000, amount_rsd: 60000 }),
  doc({ id: 'av104', invoice_number: 'AV104/2026', invoice_date: '2026-10-10', document_type: 'advance_invoice', amount: 329725.45, amount_rsd: 329725.45, prior_period: true, advance_open: 6599.88 }),
  doc({ id: 'f745', invoice_number: '745/2026', invoice_date: '2026-10-14', amount: 323125.57, amount_rsd: 323125.57 }),
  doc({ id: 'pr1', invoice_number: 'PR-1', invoice_date: '2026-10-02', document_type: 'proforma', amount: 50000, amount_rsd: 50000 }),
]
const payments: CardPayment[] = [
  pay({ invoice_id: 'f398', transaction_id: 't1', date: '2026-10-12', amount_rsd: 250000 }),
  pay({ invoice_id: 'f412', transaction_id: 't2', date: '2026-10-27', amount_rsd: 100000, bank: 'OTP banka' }),
  pay({ invoice_id: 'pr1', transaction_id: 't3', date: '2026-10-02', amount_rsd: 50000 }),
]
const usage = [{ final_invoice_id: 'f745', advance_invoice_id: 'av104', amount_rsd: 323125.57 }]
const direct = [{ id: 'd1', date: '2026-10-15', amount_rsd: 8400, bank: 'Banca Intesa', note: 'prevoz robe', direction: 'out' as const }]

const card = (from: string | null, to: string | null) =>
  buildPartnerCard({ documents: docs, payments, usage, direct, coverage: [] }, { from, to })

describe('a supplier card', () => {
  it('opens with what was owed before the period', () => {
    expect(card('2026-10-01', '2026-10-31').opening).toBe(250000)
  })

  it('lists every change in date order with a running balance', () => {
    const c = card('2026-10-01', '2026-10-31')
    expect(c.rows.map(r => [r.date, r.label, r.debit, r.credit, r.balance])).toEqual([
      ['2026-10-03', 'Račun F-412/26', 0, 120000, 370000],
      ['2026-10-08', 'Knjižno odobrenje KO-5/26', 20000, 0, 350000],
      ['2026-10-12', 'Isplata — Banca Intesa', 250000, 0, 100000],
      ['2026-10-14', 'Račun 745/2026', 0, 323125.57, 423125.57],
      ['2026-10-14', 'Zatvoreno avansom AV104/2026', 323125.57, 0, 100000],
      ['2026-10-20', 'Račun F-455/26', 0, 60000, 160000],
      ['2026-10-27', 'Isplata — OTP banka', 100000, 0, 60000],
    ])
    expect(c.closing).toBe(60000)
  })

  it('names the bill a payment or a credit note closes, and which documents can show a PDF', () => {
    const c = card('2026-10-01', '2026-10-31')
    expect(c.rows.find(r => r.label === 'Isplata — OTP banka')?.refers).toBe('F-412/26')
    expect(c.rows.find(r => r.label === 'Knjižno odobrenje KO-5/26')?.refers).toBe('F-412/26')
    expect(c.rows.find(r => r.label === 'Račun F-412/26')?.documentId).toBe('f412')
    expect(c.rows.find(r => r.label === 'Isplata — OTP banka')?.documentId).toBe('f412')
  })

  it('keeps advances and direct payments out of the balance, and lists them below it', () => {
    const c = card('2026-10-01', '2026-10-31')
    expect(c.advances.invoices).toEqual([
      { id: 'av104', invoice_number: 'AV104/2026', date: '2026-10-10', amount: 329725.45, used: 323125.57, open: 6599.88, priorPeriod: true },
    ])
    expect(c.advances.proformaPayments).toEqual([
      { documentId: 'pr1', invoice_number: 'PR-1', date: '2026-10-02', amount: 50000, bank: 'Banca Intesa' },
    ])
    expect(c.advances.paidWithoutAdvance).toBe(50000)
    expect(c.direct).toEqual([{ id: 'd1', date: '2026-10-15', amount: 8400, bank: 'Banca Intesa', note: 'prevoz robe', direction: 'out' }])
  })

  it('with no period shows everything from the first document', () => {
    const c = card(null, null)
    expect(c.opening).toBe(0)
    expect(c.rows[0].label).toBe('Račun F-398/26')
    expect(c.closing).toBe(60000)
  })

  it('says who owes whom', () => {
    expect(card('2026-10-01', '2026-10-31').verdict).toBe('Dugujemo partneru')
    const over = buildPartnerCard({
      documents: [doc({ id: 'b', invoice_number: 'B-1', amount: 100, amount_rsd: 100 })],
      payments: [pay({ invoice_id: 'b', amount_rsd: 150 })], usage: [], direct: [], coverage: [],
    }, { from: null, to: null })
    expect(over.closing).toBe(-50)
    expect(over.verdict).toBe('Partner nam duguje')
  })
})

describe('a customer card', () => {
  it('runs the other way: our invoices are owed to us, receipts pay them, an advance deducted is settled', () => {
    const c = buildPartnerCard({
      documents: [doc({ id: 'r1', invoice_number: 'IF-1/26', type: 'revenue', amount: 500000, amount_rsd: 500000, advance_deducted_rsd: 100000 })],
      payments: [pay({ invoice_id: 'r1', date: '2026-10-20', amount_rsd: 300000, bank: 'Banca Intesa' })],
      usage: [], direct: [], coverage: [],
    }, { from: null, to: null })
    expect(c.rows.map(r => [r.label, r.debit, r.credit, r.balance])).toEqual([
      ['Izlazni račun IF-1/26', 500000, 0, -500000],
      ['Odbijen avans po IF-1/26', 0, 100000, -400000],
      ['Uplata — Banca Intesa', 0, 300000, -100000],
    ])
    expect(c.verdict).toBe('Partner nam duguje')
  })
})
