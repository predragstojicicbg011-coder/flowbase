// ─── Extension points of the unpaid-bills panel ─────────────────────────────
//
// A client app can take part in paying bills without changing the panel:
// it presets lines (bills someone else decided to pay), locks amounts, keeps
// lines out of the files with a reason, reserves amounts already set aside
// elsewhere, adds labels and controls, and hears about every line change and
// every file. FlowBase itself provides nothing: with no provider the context
// is null and the panel is exactly the plain one.
//
// Every member is optional; a provider fills in what it needs.

import React from 'react'
import type { PaymentLine, BankBatch } from './paymentLines'

export interface UnpaidPanelExtension {
  /** Lines ticked when the panel opens, for bills the panel lists. */
  presetLines: PaymentLine[]
  /** True when this line's amount may not be typed over. */
  amountLocked(invoiceId: string): boolean
  /** Why this line may not go into a file right now, or null. */
  exportBlock(invoiceId: string): string | null
  /** Already set aside elsewhere for this bill, in its own currency. */
  reserved(invoiceId: string): number
  /** A small label beside the invoice number. */
  badge(invoiceId: string): React.ReactNode
  /** Extra controls under the line's payment cell. */
  lineActions(line: PaymentLine): React.ReactNode
  /** Called when a line's bank or payment code changes. */
  onLineChange(line: PaymentLine): void
  /** Extra controls in the selection bar, given the current lines. */
  selectionActions(lines: PaymentLine[], clear: () => void): React.ReactNode
  /**
   * Called BEFORE a file is downloaded, with the name it will have. If it
   * throws, nothing is downloaded and its message is shown: a file that
   * could not be recorded must never reach the bank.
   */
  beforeExport(batch: BankBatch, fileName: string): Promise<void>
  /** Called after a file is downloaded; awaited, and its error is shown. */
  onExported(batch: BankBatch, fileName: string): Promise<void>
}

export const UnpaidPanelExtensionContext =
  React.createContext<Partial<UnpaidPanelExtension> | null>(null)
