// ─── "Vrati na neplaćeno": a paid instalment, back to unpaid ────────────────
//
// The Krediti page's action on a paid or partly paid instalment. It is what
// the statement delete's warning tells people to do for a credit payment
// posted before the statement remembered its principal and interest rows
// (statementDelete.ts, UNLINKED_WARNING), and the way out of an instalment
// marked paid by mistake.
//
// One call, `credit_installment_mark_unpaid` (20261125110000): invoker, so it
// writes through the policies an instalment is edited by today
// (`can_write_books()`), in one transaction. It never touches `transactions`.
// The principal and interest rows already posted for the instalment stay in
// P&L, and the question says so, without a number: those rows name the
// instalment only in their note, so they cannot be counted reliably.

import { fmtMoney } from '../utils/formatters'
import { srDate } from './currencyService'

export interface UnpaidCandidate {
  installment_no: number
  due_date: string
  status: string
  paid_amount: number | null
  total_amount: number
  /** The bank line that paid it, when one is stamped (statement or transaction dialog). */
  transaction_id?: string | null
}

/** A paid, or partly paid, instalment can go back to unpaid. */
export const canReturnToUnpaid = (i: Pick<UnpaidCandidate, 'status' | 'paid_amount'>): boolean =>
  i.status === 'paid' || (Number(i.paid_amount) || 0) > 0

/** What the person is asked, before anything is written. */
/**
 * What paid the instalment, when `transaction_id` is stamped: a statement line
 * (it carries an `import_batch_id`), a transaction entered by hand (none), or
 * not known (the read failed or found no live row).
 */
export type PayingLine = 'statement' | 'manual' | 'unknown'

/** Reads the paying line's batch. Never throws: a failed read is 'unknown'. */
export async function payingLineOf(
  client: { from(table: string): any },
  transactionId: string,
): Promise<PayingLine> {
  try {
    const { data, error } = await client.from('transactions')
      .select('import_batch_id').eq('id', transactionId).maybeSingle()
    if (error || !data) return 'unknown'
    return data.import_batch_id ? 'statement' : 'manual'
  } catch {
    return 'unknown'
  }
}

export function unpaidQuestion(
  i: UnpaidCandidate,
  credit: { name: string; status: string; currency: string },
  linkedSefInvoices: number,
  payingLine: PayingLine = 'unknown',
): string {
  const paid = Number(i.paid_amount) || 0
  const lines = [
    `Vratiti ratu #${i.installment_no} (dospeće ${srDate(i.due_date)}) kredita „${credit.name}“ na neplaćenu?`,
    '',
    `· rata postaje neplaćena: plaćeno 0, bez datuma plaćanja i bez veze sa stavkom izvoda`
      + (paid > 0 ? ` (sada plaćeno ${fmtMoney(paid, credit.currency)} od ${fmtMoney(i.total_amount, credit.currency)})` : ''),
  ]
  if (i.transaction_id) {
    lines.push(payingLine === 'statement' ? PAID_BY_A_LINE
      : payingLine === 'manual' ? PAID_BY_A_MANUAL_ENTRY : PAID_BY_A_TRANSACTION)
  }
  if (credit.status === 'closed') lines.push('· kredit je zatvoren, pa se ponovo otvara')
  if (linkedSefInvoices > 0) {
    lines.push(linkedSefInvoices === 1
      ? '· SEF faktura kamate vezana za ovu ratu ostaje vezana'
      : `· SEF fakture kamate vezane za ovu ratu (${linkedSefInvoices}) ostaju vezane`)
  }
  lines.push('')
  lines.push(UNPAID_LEAVES_LEGS)
  return lines.join('\n')
}

/**
 * When a bank line still in the books paid the instalment, the delete is the
 * better way out: "Obriši izvod" returns the instalment AND takes the rows it
 * posted (20261125090000). A line deleted alone on Transakcije returns the
 * instalment but leaves the rows (writeOrder.deleteConfirmText says so).
 */
export const PAID_BY_A_LINE =
  '· ratu je platila stavka izvoda koja je i dalje u knjigama. Ako je ta uplata pogrešna, obrišite izvod '
  + 'kojem pripada („Obriši izvod“): to u jednom koraku vraća ratu na neplaćenu i uklanja njene redove glavnice '
  + 'i kamate (kod izvoda proknjiženih pre nego što je izvod pamtio te redove, njih ručno). Brisanje same '
  + 'stavke na strani Transakcije vraća ratu, ali te redove ostavlja. Ovo dugme ne uklanja ni stavku ni te redove.'

/**
 * A transaction entered by hand (the transaction dialog) has no statement:
 * deleting it returns the instalment (delete_transaction_cascade) and leaves
 * the principal and interest rows, which go by hand.
 */
export const PAID_BY_A_MANUAL_ENTRY =
  '· ratu je platila ručno uneta transakcija, ne izvod. Brisanje te transakcije na strani Transakcije vraća '
  + 'ratu na neplaćenu, a redove glavnice i kamate obrišite ručno. Ovo dugme ne uklanja ni transakciju ni te redove.'

/** When what paid it could not be read: names neither way. */
export const PAID_BY_A_TRANSACTION =
  '· ratu je platila transakcija koja je i dalje u knjigama. Ovo dugme ne uklanja ni nju ni njene redove '
  + 'glavnice i kamate; proverite ih na strani Transakcije.'

/** The rows a payment already posted stay where they are. */
export const UNPAID_LEAVES_LEGS =
  'Redovi glavnice i kamate koji su za ovu ratu već proknjiženi OSTAJU u P&L-u: ovo ih ne briše. '
  + 'Ako su pogrešni, obrišite ih posebno na strani Transakcije — inače će otplata, kada se rata ponovo plati, '
  + 'biti proknjižena dvaput.'

export interface UnpaidResult {
  creditReopened: boolean
  sefLinks: number
}

/** Puts the instalment back to unpaid. Throws the function's own sentence. */
export async function markInstallmentUnpaid(
  client: { rpc(fn: string, args: Record<string, unknown>): any },
  installmentId: string,
): Promise<UnpaidResult> {
  const { data, error } = await client.rpc('credit_installment_mark_unpaid', { p_id: installmentId })
  if (error) throw new Error(error.message)
  return { creditReopened: !!data?.credit_reopened, sefLinks: Number(data?.sef_links) || 0 }
}

/** What was done, in the question's terms. */
export function unpaidDone(installmentNo: number, r: UnpaidResult): string {
  return `Rata #${installmentNo} je vraćena na neplaćenu.`
    + (r.creditReopened ? ' Kredit je ponovo otvoren.' : '')
    + (r.sefLinks > 0 ? ' SEF faktura kamate ostaje vezana za nju.' : '')
    + ' Redovi glavnice i kamate u P&L-u nisu dirani.'
}
