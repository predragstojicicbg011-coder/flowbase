// ─── A bank's interest invoice, linked to its credit instalment ─────────────
//
// Banks send SEF invoices for the interest on credit instalments, and that
// interest is already an expense the day the instalment is paid (the
// CREDIT_INTEREST leg of a credit payment). So such an invoice is not booked:
// it is LINKED to its instalment, which creates no invoice and changes nothing
// in P&L. See supabase/migrations/20261125110000_an_interest_invoice_is_linked_to_its_instalment.sql.
//
// This file ranks the instalments an invoice may be for, proposes one when the
// bank's PIB is remembered on a credit, says the difference between the two
// amounts, and calls the one function that links.
//
// ACROSS CURRENCIES (owner, 2026-11-25). A bank's interest invoice on a
// EUR-indexed loan is issued in dinars. The invoice amount is then converted
// into the credit's currency at the NBS middle rate of the invoice's date --
// FlowBase's own rate source, `getBookRates` -- for the ranking and for the
// stated difference. Without a rate the instalment is still listed, ranked on
// its date alone, and never called a match.

import { fetchAllPages } from '../../utils/fetchAllPages'
import { fmtMoney, fmtNum } from '../../utils/formatters'
import { srDate } from '../currencyService'
import { getBookRates } from '../bookAmounts'

/** Where an instalment stands, as the Krediti page reads it. */
export type PaidState = 'paid' | 'partial' | 'unpaid'

/** One instalment, with the credit it belongs to. */
export interface InstalmentCandidate {
  installmentId: string
  creditId: string
  companyId: string | null
  creditName: string
  bank: string | null
  creditStatus: string
  kind: string
  currency: string
  /** The bank's PIB, remembered on the credit by the first link. */
  lenderPib: string | null
  installmentNo: number
  dueDate: string
  interestAmount: number
  paidState: PaidState
}

/** What the inbox row says about the invoice. */
export interface InvoiceFacts {
  amount: number | null
  currency: string | null
  companyId: string | null
  /** Delivery, due and sent dates; the nearest one to an instalment counts. */
  dates: (string | null)[]
  supplierPib?: string | null
  /** The day whose NBS rate converts the amount into a credit's currency. */
  rateDate?: string | null
}

/** RSD per 1 unit of each currency on one day, as NBS publishes it. RSD is 1. */
export interface DayRates {
  date: string
  rsdPer: Record<string, number>
}

/** The invoice amount in the credit's currency. */
export interface Conversion {
  /** The invoice amount, converted, to the cent. */
  amount: number
  /** 1 unit of the credit's currency in the invoice's currency (1 EUR = 117,1953 RSD). */
  rate: number
  date: string
}

export interface RankedInstalment extends InstalmentCandidate {
  /** The invoice amount (in the credit's currency) minus the interest, to the cent; NaN when unknown. */
  difference: number
  /** Set when the currencies differ and the rate is known. */
  converted: Conversion | null
  /** The currencies differ and there is no rate to convert with. */
  rateMissing: boolean
  /** Days from the instalment's due date to the nearest invoice date; null when the invoice has none. */
  days: number | null
  /** The interest is the invoice amount, within `MATCH_TOLERANCE`. */
  matches: boolean
}

/**
 * How far an instalment's interest may be from the invoice amount and still be
 * called the same: one cent, in the credit's currency (after conversion when
 * the invoice is in another). Only a match is ever proposed or chosen for him;
 * anything further is linked by his own choice.
 */
export const MATCH_TOLERANCE = 0.01

const DAY_MS = 24 * 60 * 60 * 1000
const cents = (n: number) => Math.round(n * 100) / 100
export const ccyKey = (c: string | null | undefined) => (c || '').trim().toUpperCase()
const digits = (s: string | null | undefined) => (s || '').replace(/\D/g, '')
const dayOf = (d: string | null | undefined): number => {
  const m = /^(\d{4})-(\d{2})-(\d{2})/.exec(d || '')
  return m ? Date.UTC(Number(m[1]), Number(m[2]) - 1, Number(m[3])) : NaN
}

const rsdPerOf = (ccy: string, rates: DayRates | null | undefined): number | null => {
  if (ccy === 'RSD') return 1
  const r = rates?.rsdPer[ccy]
  return typeof r === 'number' && Number.isFinite(r) && r > 0 ? r : null
}

/** The invoice amount in another currency at the day's rates, or null without them. */
export function convert(amount: number, from: string | null, to: string | null, rates: DayRates | null | undefined): Conversion | null {
  const f = ccyKey(from)
  const t = ccyKey(to)
  const rf = rsdPerOf(f, rates)
  const rt = rsdPerOf(t, rates)
  if (!rates || rf === null || rt === null) return null
  return { amount: cents(amount * rf / rt), rate: rt / rf, date: rates.date }
}

/** Whether an instalment of this credit needs a rate to compare with the invoice. */
export const needsRate = (invoiceCcy: string | null, creditCcy: string | null): boolean =>
  ccyKey(invoiceCcy) !== ccyKey(creditCcy)

/**
 * The instalments this invoice may be for, best first: the invoice's own
 * company only, active credits unless closed ones are asked for, in any
 * currency.
 *
 * An interest that matches the amount comes first. The rest are ordered by the
 * amount missed, as a share of the invoice, plus the days missed over ninety --
 * so a 1% miss weighs about as much as nine days. Then the later due date,
 * then the id.
 */
export function rankInstalments(
  invoice: InvoiceFacts,
  candidates: InstalmentCandidate[],
  opts: { includeClosed?: boolean; rates?: DayRates | null } = {},
): RankedInstalment[] {
  const amount = invoice.amount === null || invoice.amount === undefined ? null : Number(invoice.amount)
  const dates = invoice.dates.map(dayOf).filter(t => !Number.isNaN(t))
  const ranked: (RankedInstalment & { score: number })[] = []
  for (const c of candidates) {
    if (invoice.companyId && c.companyId !== invoice.companyId) continue
    if (!opts.includeClosed && c.creditStatus !== 'active') continue
    const cross = needsRate(invoice.currency, c.currency)
    const converted = cross && amount !== null ? convert(amount, invoice.currency, c.currency, opts.rates) : null
    const rateMissing = cross && amount !== null && converted === null
    const inCredit = amount === null ? null : cross ? converted?.amount ?? null : amount
    const difference = inCredit === null ? NaN : cents(inCredit - c.interestAmount)
    const due = dayOf(c.dueDate)
    const days = dates.length === 0 || Number.isNaN(due)
      ? null
      : Math.min(...dates.map(t => Math.round(Math.abs(t - due) / DAY_MS)))
    const matches = inCredit !== null && Math.abs(difference) <= MATCH_TOLERANCE + 1e-9
    const miss = inCredit === null ? 1 : Math.abs(difference) / Math.max(Math.abs(inCredit), 0.01)
    ranked.push({ ...c, difference, converted, rateMissing, days, matches, score: miss + (days ?? 365) / 90 })
  }
  ranked.sort((a, b) =>
    Number(b.matches) - Number(a.matches)
    || a.score - b.score
    || b.dueDate.localeCompare(a.dueDate)
    || a.installmentId.localeCompare(b.installmentId))
  return ranked.map(({ score, ...r }) => r)
}

/**
 * The instalment to propose when the invoice's PIB is remembered on an active
 * credit: the best of that credit's (or those credits') instalments, and ONLY
 * when its interest matches the amount. The same bank sends fee invoices, and a
 * fee proposed as a link would leave P&L; without a match the classification
 * proposal stands.
 */
export function proposeInstalment(
  invoice: InvoiceFacts, candidates: InstalmentCandidate[], rates?: DayRates | null,
): RankedInstalment | null {
  const theirs = rememberedCredits(invoice, candidates)
  if (theirs.length === 0) return null
  const best = rankInstalments(invoice, theirs, { rates })[0]
  return best && best.matches ? best : null
}

/** The instalments of active credits that remember this invoice's PIB. */
export function rememberedCredits(invoice: InvoiceFacts, candidates: InstalmentCandidate[]): InstalmentCandidate[] {
  const pib = digits(invoice.supplierPib)
  if (!pib) return []
  return candidates.filter(c => c.creditStatus === 'active' && digits(c.lenderPib) === pib)
}

/**
 * "faktura 262,01 EUR, kamata rate 258,00 EUR, razlika 4,01 EUR", and across
 * currencies "faktura 30.705,92 RSD ≈ 262,01 EUR po srednjem kursu NBS za
 * 28.11.2026. (1 EUR = 117,1953 RSD), kamata rate 262,01 EUR, bez razlike".
 */
export function differenceSentence(
  invoice: { amount: number; currency: string | null },
  r: Pick<RankedInstalment, 'interestAmount' | 'currency' | 'converted'>,
  rateDate?: string | null,
): string {
  const ic = ccyKey(invoice.currency) || ccyKey(r.currency)
  const cc = ccyKey(r.currency)
  const interest = `kamata rate ${fmtMoney(r.interestAmount, cc)}`
  if (ic === cc) {
    const diff = cents(invoice.amount - r.interestAmount)
    const head = `faktura ${fmtMoney(invoice.amount, ic)}, ${interest}`
    return Math.abs(diff) < 0.005 ? `${head}, bez razlike` : `${head}, razlika ${fmtMoney(diff, cc)}`
  }
  if (!r.converted) {
    return `faktura ${fmtMoney(invoice.amount, ic)}, ${interest}; kurs NBS`
      + `${rateDate ? ` za ${srDate(rateDate)}` : ''} nije dostupan, pa razlika nije izračunata`
  }
  const diff = cents(r.converted.amount - r.interestAmount)
  const head = `faktura ${fmtMoney(invoice.amount, ic)} ≈ ${fmtMoney(r.converted.amount, cc)} po srednjem kursu NBS`
    + ` za ${srDate(r.converted.date)} (1 ${cc} = ${fmtNum(r.converted.rate, 4)} ${ic}), ${interest}`
  return Math.abs(diff) < 0.005 ? `${head}, bez razlike` : `${head}, razlika ${fmtMoney(diff, cc)}`
}

/** Whether the chosen instalment's interest is not the amount to the cent (or cannot be compared). */
export function differs(invoiceAmount: number | null, r: Pick<RankedInstalment, 'difference'>): boolean {
  return invoiceAmount === null || !Number.isFinite(r.difference) || Math.abs(r.difference) >= 0.005
}

// ─── Reading and writing ────────────────────────────────────────────────────

interface ReadClient {
  from(table: string): any
}

const paidStateOf = (status: string, paidAmount: number): PaidState =>
  status === 'paid' ? 'paid' : paidAmount > 0 ? 'partial' : 'unpaid'

/** Every instalment of every credit, joined to its credit. */
export async function loadInstalmentCandidates(client: ReadClient): Promise<InstalmentCandidate[]> {
  const [credits, installments] = await Promise.all([
    fetchAllPages<any>((from, to) => client.from('credits')
      .select('id, company_id, name, bank, currency, status, kind, lender_pib')
      .order('id').range(from, to)),
    fetchAllPages<any>((from, to) => client.from('credit_installments')
      .select('id, credit_id, installment_no, due_date, interest_amount, status, paid_amount')
      .order('credit_id').order('installment_no').order('id').range(from, to)),
  ])
  const byId = new Map<string, any>(credits.map(c => [c.id, c]))
  const out: InstalmentCandidate[] = []
  for (const i of installments) {
    const c = byId.get(i.credit_id)
    if (!c) continue
    out.push({
      installmentId: i.id,
      creditId: c.id,
      companyId: c.company_id ?? null,
      creditName: c.name,
      bank: c.bank ?? null,
      creditStatus: c.status,
      kind: c.kind || 'annuity',
      currency: c.currency || 'RSD',
      lenderPib: c.lender_pib ?? null,
      installmentNo: Number(i.installment_no),
      dueDate: i.due_date,
      interestAmount: Number(i.interest_amount) || 0,
      paidState: paidStateOf(i.status, Number(i.paid_amount) || 0),
    })
  }
  return out
}

/** The NBS rates of one day, as `rankInstalments` takes them. Throws "Kurs NBS nije dostupan za …". */
export async function loadDayRates(date: string): Promise<DayRates> {
  const r = await getBookRates(date)
  return { date, rsdPer: { RSD: 1, EUR: r.eurRate, USD: r.usdRate } }
}

/** Links the inbox row to the instalment. Throws the function's own sentence. */
export async function linkToInstalment(
  client: { rpc(fn: string, args: Record<string, unknown>): any },
  rowId: string,
  installmentId: string,
): Promise<void> {
  const { error } = await client.rpc('sef_inbox_link_installment', { p_id: rowId, p_installment_id: installmentId })
  if (error) throw new Error(error.message)
}
