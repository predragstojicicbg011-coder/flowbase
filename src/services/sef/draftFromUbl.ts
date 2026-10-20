import { proformaNumbersIn } from '../advances'
import type { UblInvoice } from './ublInvoice'
import type { Proposal } from './proposeClassification'
import { sameAccountNumber } from '../partnerAccountChoice'

// The shape `InvoiceDialog` reads on open — WITHOUT an `id`, so its prefill
// effect fills every field and `handleSave` takes the insert branch. The
// import then gets splits, quick-fill, inline category creation and the
// account picker without a line of new form code, and an invoice is created in
// exactly one place in this application.

export interface BillAccount {
  /** The account to put on the draft, or null where nobody should be chosen for. */
  account: string | null
  /** Shown to the owner when the bill offered several, so he picks. Empty
   *  where the bill named one or none, because there is then nothing to pick. */
  offered: string[]
}

/**
 * Which of the accounts on a bill the draft carries.
 *
 * A supplier can offer several in one field. Taking the first would be
 * choosing where money goes by position in a string, and the payment is then
 * made, on time, to an account that is the supplier's and nobody decided on.
 * So, in order:
 *
 *   one account on the bill      that one — the bill named it, nothing is
 *                                being chosen
 *   several, exactly ONE of      that one — the owner has already vouched for
 *   them saved on the partner    it, which is a choice somebody made
 *   anything else                none, and the list goes to the owner
 *
 * Saved accounts are compared on digits (`sameAccountNumber`), because the
 * dashes are typography and not everyone types them.
 */
export function billAccount(billAccounts: string[], savedNumbers: string[]): BillAccount {
  if (billAccounts.length === 0) return { account: null, offered: [] }
  if (billAccounts.length === 1) return { account: billAccounts[0], offered: [] }

  const known = billAccounts.filter(b => savedNumbers.some(s => sameAccountNumber(s, b)))
  return { account: known.length === 1 ? known[0] : null, offered: billAccounts }
}

/**
 * The date an invoice is BOOKED on.
 *
 * The date of supply, which is the date the tax point falls on and the date
 * the exchange rate is taken on. The issue date is when the supplier wrote
 * the bill and the queue's own date is when they sent it; neither is what the
 * books or the VAT return are about, and on most real bills all three differ.
 *
 * A bill with no supply date on it falls back to its issue date, because a
 * booking with no date at all is worse than one dated a few days late — and
 * the notes say when that happened.
 */
/**
 * The bill states its figures in a currency it is only INDEXED in, and states
 * them again in the one it is owed in.
 *
 * True of a loan statement written in euros with a dinar tax currency: the
 * euro is the index, the dinar is what is paid and declared.
 */
export function isIndexed(ubl: Pick<UblInvoice, 'currency' | 'documentCurrency'>): boolean {
  return !!ubl.documentCurrency && !!ubl.currency && ubl.documentCurrency !== ubl.currency
}

export function bookedDateOf(ubl: Pick<UblInvoice, 'deliveryDate' | 'issueDate'>): string | null {
  return ubl.deliveryDate || ubl.issueDate || null
}

export function draftFromUbl(
  ubl: UblInvoice,
  row: { id: string; currency: string | null },
  partnerId: string | null,
  proposal: Proposal | null,
  /** Account numbers already saved against `partnerId`; see `billAccount`. */
  savedAccounts: string[] = [],
  /** Which of the owner's companies the bill is addressed to; see
   *  `matchCompany`. Null where the bill names one we do not hold a PIB for,
   *  which the dialog shows as an empty required field rather than a guess. */
  companyId: string | null = null,
  /** The rate the bill converts at, read on its date of supply. Null where it
   *  could not be fetched, which leaves the dialog's Fetch button to it. */
  exchangeRate: number | null = null,
  /** The EUR rate of the same day. Every record here carries one beside the
   *  booking rate, so filling one and not the other leaves half a conversion
   *  behind. */
  eurRate: number | null = null,
): Record<string, unknown> {
  const { account, offered } = billAccount(ubl.bankAccounts, savedAccounts)
  return {
    // Whose book this is. Taken from the bill, never from whatever company
    // happens to be selected on the screen behind the dialog.
    company_id: companyId,
    partner_id: partnerId,
    invoice_number: ubl.invoiceNumber,
    // The date of supply. The queue's dates are SENDING dates, which is what
    // SEF can filter on, and the issue date is when the bill was written;
    // what it is booked on, and what its rate is taken on, is when the thing
    // was actually delivered. See `bookedDateOf`.
    invoice_date: bookedDateOf(ubl),
    // As the supplier wrote it, even when it falls before the issue date, as
    // it does in a real document. Correcting or swapping it would be this
    // program deciding what the supplier meant.
    due_date: ubl.dueDate,
    type: 'expense',
    currency: ubl.currency || row.currency,
    // Already negative for a credit note: the parser signs it. In the
    // currency the invoice is BOOKED in, which on an indexed bill is not the
    // one it is written in.
    amount: ubl.total,
    // The figures came from a bill written in another currency. The field
    // exists for exactly this, and an indexed bill left unmarked looks like
    // an ordinary one at a strange rate.
    is_indexed: isIndexed(ubl),
    // Both the currency and the date the rate is read on come off the
    // document, so there is nothing here for the owner to decide and no
    // reason to make him press Fetch for an answer already determined.
    exchange_rate: exchangeRate,
    eur_rate: eurRate,
    // Carried so `carriedAccountOf` keeps the account the bill names rather
    // than reaching for the partner's primary one.
    account_number: account,
    // The bill named several accounts and none could be settled on. That is
    // not the same as naming none: `chooseAccount` offers the partner's
    // primary wherever a record says NOTHING about the account, and here the
    // bill has been looked at and the choice declined. Without this the
    // dialog makes it anyway, one layer down and silently. Set only in that
    // case, so a bill with no account at all still gets the default.
    ...(account === null && offered.length > 0 ? { unresolved: true } : {}),
    model: ubl.paymentModel,
    reference_number: ubl.paymentReference,
    // An advance invoice is never in the P&L (20261021090000).
    pl_impact: !ubl.isAdvanceInvoice,
    pl_category: proposal?.pl_category ?? null,
    pl_subcategory: proposal?.pl_subcategory ?? null,
    department: proposal?.department ?? null,
    dept_subcategory: proposal?.dept_subcategory ?? null,
    expense_description: proposal?.expense_description ?? null,
    cf_type: proposal?.cf_type ?? null,
    note: ubl.isCreditNote ? 'Knjižno odobrenje sa SEF-a' : ubl.isDebitNote ? 'Knjižno zaduženje sa SEF-a' : null,
    // The dialog opens with this type and proposes the partner's bill whose
    // number is the reference (compared on letters and digits only).
    document_type: ubl.isCreditNote ? 'credit_note' : ubl.isDebitNote ? 'debit_note'
      : ubl.isAdvanceInvoice ? 'advance_invoice' : 'invoice',
    billing_reference: ubl.billingReference,
    // An advance invoice names its proforma only in words; the dialog
    // proposes the paid proforma with that number.
    ...(ubl.isAdvanceInvoice ? { proforma_hints: proformaNumbersIn(ubl.advanceText) } : {}),
    // A FINAL INVOICE: the cost is the full amount, not what is left to pay
    // after the advance; the dialog links the advances it names before it
    // can be posted.
    ...(ubl.advanceUsed > 0 && ubl.grossTotal !== null ? {
      amount: ubl.grossTotal,
      advance_refs: ubl.billingReferences,
      advance_used: ubl.advanceUsed,
    } : {}),
  }
}

const classificationOf = (p: Proposal): string =>
  [p.pl_category, p.pl_subcategory, p.department, p.dept_subcategory, p.expense_description]
    .filter(Boolean).join(' › ')

/**
 * What the owner should have read before pressing Post, in the order it
 * matters.
 *
 * Every field the import fills in without being asked is here with its
 * reason, because a filled field with no reason is one nobody checked. The
 * empty ones are here too: a blank classification or account reads as an
 * oversight unless the screen says it was left blank on purpose.
 */
export function reviewNotesFor(
  ubl: UblInvoice,
  ctx: {
    /** How the supplier was matched to a partner; null where it was not. */
    matchedBy: 'pib' | 'registration' | 'name' | null
    /** How the bill's addressee was matched to one of the owner's companies,
     *  and which. Absent on callers that do not match a company at all. */
    company?: { by: 'pib' | 'registration' | null; name: string | null }
    proposal: Proposal | null
    /** Account numbers saved against the matched partner. */
    saved: string[]
    /** What the queue row said — the figures the owner DECIDED on, which are
     *  not necessarily the ones in the document he is about to book. */
    header?: { amount: number | null; currency: string | null }
  },
): string[] {
  const notes: string[] = []

  if (ctx.proposal) {
    notes.push(`Predložena klasifikacija: ${classificationOf(ctx.proposal)}. ${ctx.proposal.reason}`)
  } else {
    notes.push('Klasifikacija nije predložena: ovaj dobavljač nema ranije klasifikovanih faktura, a nijedan šablon se ne poklapa. Klasifikujte je sami.')
  }

  // Which of the owner's books the cost lands in. Said out loud even when it
  // is right, because it is filled in without being asked and the screen
  // behind the dialog may be showing a different company entirely.
  if (ctx.company) {
    notes.push(ctx.company.by
      ? `Glasi na ${ctx.company.name}, prema ${ctx.company.by === 'pib' ? 'PIB-u' : 'matičnom broju'} sa fakture.`
      : 'Faktura glasi na firmu čiji PIB i matični broj ovde nisu upisani, pa firma nije popunjena. Izaberite je pre knjiženja.')
  }

  if (ctx.matchedBy === null) {
    notes.push('Nijedan partner ne odgovara ovom dobavljaču. Izaberite ga ili napravite pre knjiženja.')
  } else if (ctx.matchedBy === 'name') {
    notes.push('Dobavljač je prepoznat samo po imenu, što je najslabije poklapanje. Proverite da li je partner prava firma.')
  }

  const { account, offered } = billAccount(ubl.bankAccounts, ctx.saved)
  if (offered.length > 0) {
    notes.push(account
      ? `Faktura nudi više računa (${offered.join('; ')}). ${account} je onaj koji je već sačuvan za ovog dobavljača.`
      : `Faktura nudi više računa: ${offered.join('; ')}. Nijedan nije izabran umesto vas. Izaberite na koji se plaća, u polju za račun.`)
  }

  // The owner chose to open this invoice on the header's supplier, number and
  // amount, and books from the document. Where they disagree the figure he
  // decided on is not the figure being booked, and nothing else would tell him.
  // A note and not a refusal: the document is the bill, and the header is the
  // one that may be out of date. Compared without sign because the queue may
  // hold a credit note's amount either way round.
  const header = ctx.header
  if (header) {
    const money = (n: number, c: string | null) => `${n.toFixed(2)}${c ? ` ${c}` : ''}`
    // The queue reports a bill in the currency it was WRITTEN in, so on an
    // indexed one it is compared against the document's own figure. Compared
    // against the booked figure it would disagree on every such bill, by the
    // exchange rate, and a warning that is always wrong is one nobody reads.
    const shown = isIndexed(ubl) ? ubl.documentTotal : ubl.total
    const shownCurrency = isIndexed(ubl) ? ubl.documentCurrency : ubl.currency
    if (header.amount !== null && shown !== null
        && Math.abs(Math.abs(Number(header.amount)) - Math.abs(shown)) > 0.005) {
      notes.push(`U sandučetu je ova faktura stajala na ${money(Number(header.amount), header.currency)}, a dokument kaže ${money(shown, shownCurrency)}. Knjiži se iznos iz dokumenta.`)
    }
    if (header.currency && shownCurrency && header.currency !== shownCurrency) {
      notes.push(`U sandučetu je ova faktura stajala u ${header.currency}, a dokument je u ${shownCurrency}. Knjiži se valuta iz dokumenta.`)
    }
  }

  // Popunjeno bez pitanja, a broj na papiru nije broj na ekranu. Oba se
  // imenuju.
  if (isIndexed(ubl)) {
    notes.push(`Dobavljač je fakturu izdao u ${ubl.documentCurrency}`
      + (ubl.documentTotal !== null ? ` (${ubl.documentTotal.toFixed(2)})` : '')
      + `, što je valuta indeksacije. Knjiži se u ${ubl.currency}`
      + (ubl.total !== null ? ` (${ubl.total.toFixed(2)})` : '')
      + ', jer se to duguje i prijavljuje.')
  }

  if (ubl.isCreditNote) {
    notes.push('Ovo je knjižno odobrenje, pa je iznos unet kao negativan.')
  }

  if (ubl.advanceUsed > 0 && ubl.grossTotal !== null) {
    notes.push(`Konačni račun: pun iznos ${ubl.grossTotal.toFixed(2)} ide u troškove, avans ${ubl.advanceUsed.toFixed(2)} je već plaćen, za plaćanje ${(ubl.total ?? 0).toFixed(2)}.`)
  }
  if (ubl.isAdvanceInvoice) {
    notes.push('Ovo je avansni račun: ne ulazi u troškove i ne plaća se; vezuje se za plaćeni predračun.')
  }

  // WHICH DATE IT IS BOOKED ON. Said whenever it is not the one the bill is
  // headed with, because that is the date on the screen the owner will check
  // against the paper in front of him, and because the rate follows it.
  if (ubl.deliveryDate && ubl.issueDate && ubl.deliveryDate !== ubl.issueDate) {
    notes.push(`Knjiži se na datum prometa (${ubl.deliveryDate}), po kom se uzima i kurs. Dobavljač je fakturu izdao ${ubl.issueDate}.`)
  } else if (!ubl.deliveryDate && ubl.issueDate) {
    notes.push(`Faktura ne navodi datum prometa, pa se knjiži na datum izdavanja (${ubl.issueDate}). Uporedite sa papirom ako se razlikuju.`)
  }

  // Carried as the supplier sent it. Pointed out, not corrected: it may be a
  // mistake on their side or it may be what they meant.
  if (ubl.issueDate && ubl.dueDate && ubl.dueDate < ubl.issueDate) {
    notes.push(`Datum dospeća (${ubl.dueDate}) je pre datuma izdavanja (${ubl.issueDate}). Unet je onako kako ga je dobavljač poslao.`)
  }

  return notes
}
