// Deleting a posted statement, and everything it created.
//
// Shared by the two screens that list posted statements — the manual entry
// dialog and the bulk import — because the dangerous part of this is the
// SENTENCE, not the delete. It removes transactions, the invoice allocations
// they carried and the credit instalments they closed, which means invoices
// reading `paid` go back to owing money. Nobody should find that out
// afterwards. Two copies of that warning would drift, and the one that
// drifted would be the one somebody read.

export interface DeletionCounts {
  transactions: number
  passthroughs: number
  /** Distinct invoices this statement allocated against. */
  invoiceIds: string[]
  /** Those of them that currently read as paid, by invoice number. */
  closing: string[]
}

/**
 * What the owner is asked, before anything is touched.
 *
 * Every figure is named. The invoices that will stop reading as paid are
 * listed, up to eight of them, because "3 invoice allocations" does not tell
 * anybody which of their suppliers is about to be owed money again.
 */
export function deletionWarning(fileName: string | null | undefined, c: DeletionCounts): string {
  const lines = [
    `Delete "${fileName || 'this statement'}" and everything it posted?`,
    '',
    `· ${c.transactions} transaction${c.transactions === 1 ? '' : 's'}`,
  ]
  if (c.passthroughs > 0) {
    lines.push(`· ${c.passthroughs} pass-through row${c.passthroughs === 1 ? '' : 's'}`)
  }
  if (c.invoiceIds.length > 0) {
    lines.push(`· ${c.invoiceIds.length} invoice allocation${c.invoiceIds.length === 1 ? '' : 's'}`)
    if (c.closing.length > 0) {
      lines.push('')
      lines.push(`${c.closing.length} invoice${c.closing.length === 1 ? '' : 's'} currently read as paid and will owe money again:`)
      lines.push(c.closing.slice(0, 8).join(', ')
        + (c.closing.length > 8 ? `, and ${c.closing.length - 8} more` : ''))
    }
  }
  lines.push('')
  lines.push('This cannot be undone from here.')
  return lines.join('\n')
}

/** What was actually done, in the same terms the warning used. */
export function deletionSummary(r: any): string {
  const d = (r || {}) as any
  return `Deleted ${d.transactions_deleted ?? 0} transaction(s)`
    + ((d.passthroughs_deleted ?? 0) > 0 ? `, ${d.passthroughs_deleted} pass-through(s)` : '')
    + `, removed ${d.allocations_removed ?? 0} allocation(s)`
    + ((d.installments_reopened ?? 0) > 0 ? `, reopened ${d.installments_reopened} credit instalment(s)` : '')
    + ((d.invoices_restated ?? 0) > 0 ? `, and ${d.invoices_restated} invoice(s) no longer read as they did` : '')
    + '.'
}

/** Count what a batch holds, before asking. Soft-deleted rows are excluded. */
export async function gatherDeletion(supabase: any, batchId: string): Promise<DeletionCounts> {
  const [{ count: txCount }, { count: ptCount }, { data: links }] = await Promise.all([
    supabase.from('transactions').select('id', { count: 'exact', head: true })
      .eq('import_batch_id', batchId).is('deleted_at', null),
    supabase.from('passthrough').select('id', { count: 'exact', head: true })
      .eq('import_batch_id', batchId).is('deleted_at', null),
    supabase.from('invoice_transaction_links')
      .select('invoice_id, transactions!inner(import_batch_id)')
      .eq('transactions.import_batch_id', batchId),
  ])

  const invoiceIds = Array.from(new Set((links || []).map((l: any) => l.invoice_id))) as string[]
  const { data: affected } = invoiceIds.length > 0
    ? await supabase.from('v_invoice_status')
        .select('invoice_number, calculated_status').in('id', invoiceIds)
    : { data: [] as any[] }

  return {
    transactions: txCount ?? 0,
    passthroughs: ptCount ?? 0,
    invoiceIds,
    closing: (affected || [])
      .filter((i: any) => i.calculated_status === 'paid')
      .map((i: any) => i.invoice_number || '(no number)'),
  }
}

/**
 * One call, one database transaction: a closed period refuses the whole batch
 * rather than leaving half a statement behind.
 */
export async function deleteStatementBatch(supabase: any, batchId: string): Promise<any> {
  const { data, error } = await supabase.rpc('delete_statement_cascade', {
    p_batch_id: batchId,
    p_deleted_by: null,
  })
  if (error) throw error
  return data
}
