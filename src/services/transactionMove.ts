// ─── Changing a transaction's type ──────────────────────────────────────────
//
// Two tables hold what the transaction dialog calls a transaction.
// `transactions` carries everything with a P&L or an invoice side;
// `passthrough` carries money in transit, which is recorded rather than
// classified. The type picker in the dialog spans both tables, so choosing a
// different type can mean choosing a different table.
//
// That is what made the save silently do nothing. A row opened from
// `transactions` and switched to Pass-through was saved with
//
//     supabase.from('passthrough').update(payload).eq('id', transaction.id)
//
// where `transaction.id` is a `transactions` id. No pass-through row has it,
// so nothing matched. PostgREST answers a zero-row update with 200 and an
// empty list — not an error — so the dialog reported success, closed, and left
// the original row exactly as it was. The mirror case is the same defect with
// the tables swapped.
//
// A type change that crosses tables is a MOVE: insert into the destination,
// then soft-delete the source. A type change inside one table stays an update.
// Deciding which of the two it is needs one fact the dialog did not have —
// which table the row it is editing actually came from — and that now arrives
// as a prop rather than being guessed from the row's shape.
//
// Not every row is free to leave `transactions`. An allocated payment and a
// settled credit instalment both hold a reference to the transaction id, and
// this dialog cannot unwind either; moving the row would leave an invoice
// part-paid by something that no longer exists. Those are refused up front,
// before anything is written, with the reason named. A refusal the owner can
// act on beats a half-done move.
//
// The decisions are here, as plain input-output functions, so they can be
// tested without a database — the dialog only carries them out.

import { countOf, plural } from '../utils/plural'

export type TxTable = 'transactions' | 'passthrough'

export type TxType = 'direct' | 'invoice_payment' | 'passthrough' | 'credit_payment'

/** What each type is called where a refusal has to name it. */
export const TYPE_LABELS: Record<TxType, string> = {
  direct: 'Direktna transakcija',
  invoice_payment: 'Plaćanje fakture',
  passthrough: 'Prolazna stavka',
  credit_payment: 'Otplata kredita',
}

/**
 * Which table a transaction of this type lives in.
 *
 * Pass-through is the only type stored apart. Everything else — direct,
 * invoice payment, credit payment — is a row in `transactions`.
 */
export function tableForType(type: TxType): TxTable {
  return type === 'passthrough' ? 'passthrough' : 'transactions'
}

export interface SaveContext {
  /** The id of the row being edited, or null/undefined when posting a new one. */
  rowId?: string | null
  /** The table that row was read from. Null for a new row. */
  sourceTable?: TxTable | null
  /** The type the row had when it was opened. Null for a new row. */
  currentType?: TxType | null
  /** The type now chosen in the dialog. */
  nextType: TxType
  /** Rows in `invoice_transaction_links` pointing at this transaction. */
  invoiceLinkCount?: number
  /** Rows in `credit_installments` this transaction settled. */
  settledInstallmentCount?: number
}

/**
 * Whether saving this row means writing to a different table than it came from.
 *
 * A row being posted for the first time is never a move — it has no source
 * table to leave. It is an insert into whichever table its type belongs to.
 */
export function isCrossTableMove(ctx: SaveContext): boolean {
  if (!ctx.rowId || !ctx.sourceTable) return false
  return ctx.sourceTable !== tableForType(ctx.nextType)
}


/**
 * Why this row may not leave the table it is in, or null if it may.
 *
 * Both reasons are references held elsewhere that name this transaction's id.
 * Moving the row means inserting a new one under a new id and soft-deleting
 * this one, and neither the invoice allocation nor the instalment's
 * `paid_amount` and status would follow it.
 */
export function moveRefusal(ctx: SaveContext): string | null {
  const destination = TYPE_LABELS[ctx.nextType]

  if (ctx.currentType === 'credit_payment') {
    return `Ovo je otplata kredita i ne može se promeniti u tip „${destination}“. `
      + 'Zatvorila je rate u Kreditima i proknjižila posebne stavke glavnice i kamate, '
      + 'a ovaj dijalog to ne može da poništi. Stornirajte je u Kreditima i proknjižite ponovo.'
  }

  const links = ctx.invoiceLinkCount ?? 0
  if (links > 0) {
    return `Ova transakcija plaća ${countOf(links, 'fakturu', 'fakture', 'faktura')} i ne može se promeniti u tip „${destination}“. `
      + `Premeštanjem bi ${plural(links, 'faktura ostala delimično plaćena', 'fakture ostale delimično plaćene', 'fakture ostale delimično plaćene')} transakcijom koja više ne postoji. `
      + 'Prvo uklonite raspodelu na fakturu.'
  }

  const instalments = ctx.settledInstallmentCount ?? 0
  if (instalments > 0) {
    return `Ova transakcija je zatvorila ${countOf(instalments, 'ratu kredita', 'rate kredita', 'rata kredita')} i ne može se promeniti u tip „${destination}“. `
      + 'Plaćeni iznos i status rata ostali bi vezani za transakciju koja više ne postoji, '
      + 'a ovaj dijalog to ne poništava.'
  }

  return null
}

export type SavePlan =
  | { kind: 'insert'; table: TxTable }
  | { kind: 'update'; table: TxTable }
  | { kind: 'move'; from: TxTable; to: TxTable }
  | { kind: 'refuse'; reason: string }

/**
 * What the save has to do: insert one row, update one row, move a row between
 * the two tables, or refuse and say why.
 *
 * Credit payments are refused in both directions on a saved row. A credit
 * payment does far more than write itself — it settles instalments and posts
 * principal and interest as separate rows that carry no reference back — so
 * re-saving one would post the whole lot a second time, and turning some other
 * row into one would post the credit rows while leaving the original row
 * untouched under its old type. `statementEdit.allowedTypes` states the same
 * rule from the statement grid's side: a saved row may become `direct` or
 * `invoice_payment`, and a credit payment may become nothing at all.
 */
export function planSave(ctx: SaveContext): SavePlan {
  const to = tableForType(ctx.nextType)

  // A new row has no history to protect and no table to leave.
  if (!ctx.rowId || !ctx.sourceTable) return { kind: 'insert', table: to }

  if (ctx.currentType === 'credit_payment' && ctx.nextType !== 'credit_payment') {
    return { kind: 'refuse', reason: moveRefusal(ctx) as string }
  }

  if (ctx.nextType === 'credit_payment') {
    return {
      kind: 'refuse',
      reason: 'Otplata kredita ne može da se proknjiži iz postojeće stavke. Ona zatvara rate i '
        + 'upisuje posebne stavke glavnice i kamate, a ova stavka bi ostala pod starim tipom. '
        + 'Proknjižite otplatu kredita kao novu transakciju.',
    }
  }

  if (ctx.sourceTable === to) return { kind: 'update', table: to }

  const refusal = moveRefusal(ctx)
  if (refusal) return { kind: 'refuse', reason: refusal }

  return { kind: 'move', from: ctx.sourceTable, to }
}
