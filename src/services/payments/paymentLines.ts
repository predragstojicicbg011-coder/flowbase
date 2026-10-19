// ─── What is to be paid: one line per bill ──────────────────────────────────
//
// A ticked bill becomes a line: how much of it is paid now, from which of the
// company's bank accounts, under which payment code. The rest of it stays
// owed. Nothing here is booked — a payment reaches the books from the bank
// statement; a line only decides what the payment order says.
//
// Kept as plain data so that a selection can later be saved and handed on
// (someone decides what is paid, someone else executes it).

import { DEFAULT_SIFRA, type TkdisOrder } from './halcomTkdis'

export interface PaymentLine {
  invoiceId: string
  /** As typed: "1.234,56", "1234.56" or "1234,56". */
  amountText: string
  bankAccountId: string
  paymentCode: string
}

/** What a line needs to know about its bill. */
export interface PayableBill {
  id: string
  type: string | null
  currency: string | null
  /** Still owed, in the bill's own currency. */
  outstanding: number
  invoice_number: string | null
  partner_name: string | null
  partner_address: string | null
  partner_city: string | null
  beneficiary_account: string | null
  model: string | null
  reference_number: string | null
}

export interface CompanyBankAccount {
  id: string
  bank_name: string | null
  account_number: string
  is_primary?: boolean | null
}

export const round2 = (n: number): number => Math.round(n * 100) / 100

/** The amount as text in the Serbian way, with a decimal comma. */
export const amountText = (n: number): string => round2(n).toFixed(2).replace('.', ',')

/**
 * Reads what was typed. A comma is the decimal mark; dots before it are
 * thousands. With no comma, one dot followed by up to two digits is a decimal
 * point ("1234.5"), and any other dot groups thousands ("1.234.567").
 * Returns null for anything that is not a number.
 */
export function parseAmount(text: string): number | null {
  let t = (text || '').trim().replace(/\s/g, '')
  if (!t) return null
  if (t.includes(',')) t = t.replace(/\./g, '').replace(',', '.')
  else if (!/^\d*\.\d{1,2}$/.test(t)) t = t.replace(/\./g, '')
  if (!/^\d+(\.\d+)?$/.test(t)) return null
  return round2(Number(t))
}

export function newLine(bill: PayableBill, bankAccountId: string): PaymentLine {
  return { invoiceId: bill.id, amountText: amountText(bill.outstanding), bankAccountId, paymentCode: DEFAULT_SIFRA }
}

/** The amount to pay, or null while the text is not a usable amount. */
export const lineAmount = (line: PaymentLine): number | null => parseAmount(line.amountText)

/** What stays owed after this payment. */
export function remainingAfter(line: PaymentLine, bill: PayableBill): number {
  const a = lineAmount(line)
  return round2(bill.outstanding - (a ?? 0))
}

/** Why this line cannot go into a payment order, or null. */
export function lineProblem(line: PaymentLine, bill: PayableBill): string | null {
  if (bill.type !== 'expense') return 'Izlazna faktura se ne plaća nalogom.'
  if ((bill.currency || 'RSD').toUpperCase() !== 'RSD') return 'Devizna faktura ne ide u dinarski nalog.'
  const a = lineAmount(line)
  if (a === null) return 'Iznos nije broj.'
  if (a <= 0) return 'Iznos mora biti veći od nule.'
  if (a > round2(bill.outstanding) + 0.001) return 'Iznos je veći od onoga što je ostalo da se plati.'
  if (!line.bankAccountId) return 'Izaberite banku sa koje se plaća.'
  if (!/^\d{3}$/.test(line.paymentCode)) return 'Izaberite šifru plaćanja.'
  if (!bill.beneficiary_account) return 'Nema računa primaoca.'
  return null
}

export function orderFor(line: PaymentLine, bill: PayableBill): TkdisOrder {
  return {
    beneficiaryAccount: bill.beneficiary_account || '',
    beneficiaryName: bill.partner_name || '',
    beneficiaryAddress: bill.partner_address || '',
    beneficiaryCity: bill.partner_city || '',
    purpose: `UPLATA PO FAKTURI ${bill.invoice_number || ''}`.trim(),
    paymentCode: line.paymentCode,
    amount: lineAmount(line) ?? 0,
    creditModel: bill.reference_number ? (bill.model || '97') : '',
    creditReference: bill.reference_number || bill.invoice_number || '',
  }
}

export interface BankBatch {
  bank: CompanyBankAccount
  lines: PaymentLine[]
  total: number
  /** Payment codes in this batch, in order, with how much each carries. */
  byCode: { code: string; count: number; total: number }[]
}

/**
 * Lines grouped by the bank they are paid from — one Halcom file each —
 * banks in the order given, lines sorted by payment code then bill.
 * Only lines without a problem are batched.
 */
export function batchesByBank(
  lines: PaymentLine[],
  bills: Map<string, PayableBill>,
  banks: CompanyBankAccount[],
): BankBatch[] {
  const out: BankBatch[] = []
  for (const bank of banks) {
    const mine = lines
      .filter(l => l.bankAccountId === bank.id)
      .filter(l => { const b = bills.get(l.invoiceId); return !!b && lineProblem(l, b) === null })
      .sort((a, b) => a.paymentCode.localeCompare(b.paymentCode) || a.invoiceId.localeCompare(b.invoiceId))
    if (mine.length === 0) continue
    const byCode: BankBatch['byCode'] = []
    for (const l of mine) {
      const amt = lineAmount(l) ?? 0
      const last = byCode[byCode.length - 1]
      if (last && last.code === l.paymentCode) { last.count++; last.total = round2(last.total + amt) }
      else byCode.push({ code: l.paymentCode, count: 1, total: amt })
    }
    out.push({ bank, lines: mine, total: round2(mine.reduce((s, l) => s + (lineAmount(l) ?? 0), 0)), byCode })
  }
  return out
}
