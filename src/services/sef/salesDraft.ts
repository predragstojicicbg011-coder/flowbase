import type { UblInvoice } from './ublInvoice'
import { bookedDateOf } from './draftFromUbl'
import { proformaNumbersIn } from '../advances'

// The sales-side counterpart of `draftFromUbl`: the shape `InvoiceDialog`
// reads on open for a REVENUE invoice, drafted from a document we ISSUED.
// Here the seller is us and the CUSTOMER is the partner.

const VOIDED: Record<string, string> = {
  cancelled: 'Otkazana na SEF-u',
  storno: 'Stornirana na SEF-u',
  rejected: 'Odbijena na SEF-u',
}

const voidedKey = (status: string | null | undefined): string =>
  (status ?? '').trim().toLowerCase()

/** SEF status that makes an invoice void: Cancelled, Storno or Rejected, in any case. */
export function isVoidedOnSef(status: string | null | undefined): boolean {
  return voidedKey(status) in VOIDED
}

export function voidedLabel(status: string | null | undefined): string | null {
  return VOIDED[voidedKey(status)] ?? null
}

const documentTypeOf = (ubl: UblInvoice): string =>
  ubl.isCreditNote ? 'credit_note' : ubl.isDebitNote ? 'debit_note'
    : ubl.isAdvanceInvoice ? 'advance_invoice' : 'invoice'

const noteOf = (ubl: UblInvoice): string =>
  ubl.isCreditNote ? 'Knjižno odobrenje sa SEF-a'
    : ubl.isDebitNote ? 'Knjižno zaduženje sa SEF-a'
      : ubl.isAdvanceInvoice ? 'Avansni račun sa SEF-a'
        : 'Izlazna faktura sa SEF-a'

export function salesDraftFromUbl(
  ubl: UblInvoice,
  row: { id: string; currency: string | null },
  customerId: string | null,
  companyId: string | null,
  exchangeRate: number | null,
  eurRate: number | null,
): Record<string, unknown> {
  return {
    company_id: companyId,
    partner_id: customerId,
    invoice_number: ubl.invoiceNumber,
    // The date of supply, as on the purchase side: the tax point and the date
    // the exchange rate is read on.
    invoice_date: bookedDateOf(ubl),
    due_date: ubl.dueDate,
    type: 'revenue',
    currency: ubl.currency || row.currency,
    // The full amount, not what is left to pay after an advance.
    amount: ubl.grossTotal ?? ubl.total,
    exchange_rate: exchangeRate,
    eur_rate: eurRate,
    // We are the seller: the account to pay into is ours, not the partner's.
    account_number: null,
    // An advance invoice is never in the P&L.
    pl_impact: !ubl.isAdvanceInvoice,
    note: noteOf(ubl),
    document_type: documentTypeOf(ubl),
    billing_reference: ubl.billingReference,
    // An advance invoice names its proforma only in words; the dialog
    // proposes the customer's paid proforma with that number.
    ...(ubl.isAdvanceInvoice ? { proforma_hints: proformaNumbersIn(ubl.advanceText) } : {}),
    // A FINAL INVOICE: the revenue is the full amount, not what is left to
    // collect after the advance; the dialog links the advances it names
    // before it can be posted.
    ...(ubl.advanceUsed > 0 && (ubl.grossTotal ?? ubl.total) !== null ? {
      amount: ubl.grossTotal ?? ubl.total,
      advance_refs: ubl.billingReferences,
      advance_used: ubl.advanceUsed,
    } : {}),
  }
}

/** Why a sales document is not booked, or null where it can be. */
export function salesBookingRefusal(
  ubl: UblInvoice,
  row: { sef_status: string | null },
): string | null {
  if (isVoidedOnSef(row.sef_status)) {
    return 'Faktura je stornirana, otkazana ili odbijena na SEF-u i ne knjiži se.'
  }
  if ((ubl.grossTotal ?? ubl.total) === null || !bookedDateOf(ubl)) {
    return 'Dokument ne može da se pročita kao faktura.'
  }
  return null
}

/** What the owner should read before posting: how the customer and the company were found, and the date. */
export function salesReviewNotes(
  ubl: UblInvoice,
  ctx: {
    matchedBy: 'pib' | 'registration' | 'name' | null
    company: { by: 'pib' | 'registration' | null; name: string | null }
  },
): string[] {
  const notes: string[] = []

  if (ctx.matchedBy === null) {
    notes.push('Kupac nije u partnerima — dodajte ga.')
  } else if (ctx.matchedBy === 'name') {
    notes.push('Kupac je prepoznat samo po nazivu — proverite da li je partner prava firma.')
  } else {
    notes.push(ctx.matchedBy === 'pib' ? 'Kupac prepoznat po PIB-u.' : 'Kupac prepoznat po matičnom broju.')
  }

  notes.push(ctx.company.by
    ? `Prodavac je ${ctx.company.name}, prema ${ctx.company.by === 'pib' ? 'PIB-u' : 'matičnom broju'} sa fakture.`
    : 'Prodavac sa fakture nije među vašim firmama, pa firma nije popunjena. Izaberite je pre knjiženja.')

  if (ubl.deliveryDate && ubl.issueDate && ubl.deliveryDate !== ubl.issueDate) {
    notes.push(`Knjiži se na datum prometa (${ubl.deliveryDate}), po kom se uzima i kurs. Faktura je izdata ${ubl.issueDate}.`)
  } else if (!ubl.deliveryDate && ubl.issueDate) {
    notes.push(`Faktura ne navodi datum prometa, pa se knjiži na datum izdavanja (${ubl.issueDate}).`)
  }

  if (ubl.advanceUsed > 0 && ubl.grossTotal !== null) {
    notes.push(`Konačna faktura: pun iznos ${ubl.grossTotal.toFixed(2)} ide u prihod, avans ${ubl.advanceUsed.toFixed(2)} je već primljen, za naplatu ${(ubl.total ?? 0).toFixed(2)}.`)
  }

  return notes
}
