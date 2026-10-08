import React from 'react'
import type { CreditOption, CreditInstallment } from './useCreditPayment'
import { DIALOG } from './dialogTheme'
import { fmtMoney, fmtNum } from '../utils/formatters'

// ── Credit installment selector ─────────────────────────────────────────────
//
// Shown inside the transaction, bank statement and bulk import dialogs when a
// payment is being matched to a credit. It used to carry a `theme` prop with a
// light and a dark variant; now that every dialog is dark there is one variant,
// and the styles come from the shared palette like the rest of the chrome.

const lbl: React.CSSProperties = {
  fontSize: '11px', fontWeight: '500', color: DIALOG.dim,
  textTransform: 'uppercase', letterSpacing: '0.08em',
}

const banner = (color: string, fill: string): React.CSSProperties => ({
  padding: '10px 14px', borderRadius: '8px', fontSize: '12px', marginBottom: '12px',
  background: fill, border: `0.5px solid ${color}`, color,
})

interface Props {
  credits: CreditOption[]
  selectedCreditId: string
  onCreditChange: (id: string) => void
  installments: CreditInstallment[]
  selectedInstallmentIds: string[]
  onToggle: (id: string) => void
  onToggleAll: () => void
  selectedTotal: number
  error?: string
}

export default function CreditInstallmentSelector({
  credits, selectedCreditId, onCreditChange,
  installments, selectedInstallmentIds, onToggle, onToggleAll,
  selectedTotal, error,
}: Props) {
  // Every figure in the selected credit's own currency — EUR for an indexed
  // loan, RSD for a dinar one. Never assumed.
  const currency = credits.find(c => c.id === selectedCreditId)?.currency || 'RSD'

  const select: React.CSSProperties = {
    fontFamily: "'Inter',sans-serif", fontSize: '13px', padding: '8px 10px', width: '100%',
    border: `0.5px solid ${DIALOG.border}`, borderRadius: '8px',
    background: DIALOG.raised, color: DIALOG.text, outline: 'none',
  }

  return (
    <div>
      <div style={banner(DIALOG.blue, DIALOG.blueFill)}>
        Select the credit and installments being paid. They will be marked as paid in Bank Credits.
      </div>

      {error && <div style={banner(DIALOG.red, DIALOG.redFill)}>⚠️ {error}</div>}

      <div style={{ marginBottom: '12px' }}>
        <label style={{ ...lbl, display: 'block', marginBottom: '6px' }}>Credit</label>
        <select style={select} value={selectedCreditId} onChange={e => onCreditChange(e.target.value)}>
          <option value="">Select credit...</option>
          {credits.map(c => (
            <option key={c.id} value={c.id}>{c.name} — {c.bank} ({c.rate_description}) · {c.currency}</option>
          ))}
        </select>
      </div>

      {selectedCreditId && installments.length === 0 && (
        <div style={{
          padding: '16px', textAlign: 'center', fontSize: '13px', borderRadius: '8px',
          color: DIALOG.dim, background: DIALOG.raised, border: `0.5px solid ${DIALOG.border}`,
        }}>
          ✓ All installments are already paid.
        </div>
      )}

      {installments.length > 0 && (
        <div>
          <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: '8px' }}>
            <label style={lbl}>Outstanding installments</label>
            <button onClick={onToggleAll} style={{
              background: 'none', border: 'none', cursor: 'pointer',
              fontFamily: "'Inter',sans-serif", fontSize: '12px', color: DIALOG.accent,
            }}>
              {selectedInstallmentIds.length === installments.length ? 'Deselect all' : 'Select all'}
            </button>
          </div>

          <div style={{ display: 'flex', flexDirection: 'column', gap: '6px' }}>
            {installments.map(inst => {
              const picked = selectedInstallmentIds.includes(inst.id)
              const overdue = new Date(inst.due_date) < new Date()
              return (
                <div key={inst.id} onClick={() => onToggle(inst.id)} style={{
                  display: 'flex', alignItems: 'center', gap: '12px',
                  padding: '10px 14px', cursor: 'pointer', borderRadius: '8px', transition: 'all 0.12s',
                  border: picked ? `1.5px solid ${DIALOG.accent}` : `0.5px solid ${DIALOG.border}`,
                  background: picked ? DIALOG.accentFill : DIALOG.raised,
                }}>
                  <input type="checkbox" checked={picked} onChange={() => {}}
                    style={{ cursor: 'pointer', accentColor: DIALOG.accent, flexShrink: 0 }} />
                  <div style={{ flex: 1, minWidth: 0 }}>
                    <div style={{ display: 'flex', alignItems: 'center', gap: '8px', marginBottom: '3px' }}>
                      <span style={{ fontSize: '13px', fontWeight: '500', color: DIALOG.text }}>
                        Installment #{inst.installment_no}
                      </span>
                      {overdue && (
                        <span style={{
                          fontSize: '10px', padding: '1px 7px', borderRadius: '20px', fontWeight: '600',
                          background: DIALOG.redFill, color: DIALOG.red,
                        }}>Overdue</span>
                      )}
                    </div>
                    <div style={{ fontSize: '11px', color: DIALOG.dim }}>
                      Due: <strong>{inst.due_date}</strong>
                      <span style={{ marginLeft: '10px', color: DIALOG.blue }}>
                        Principal: {fmtNum(inst.principal_amount)}
                      </span>
                      <span style={{ marginLeft: '10px', color: DIALOG.amber }}>
                        Interest: {fmtNum(inst.interest_amount)}
                      </span>
                    </div>
                  </div>
                  <div style={{
                    fontFamily: "'DM Mono',monospace", fontSize: '13px', fontWeight: '600',
                    color: DIALOG.text, flexShrink: 0, textAlign: 'right',
                  }}>
                    {fmtMoney(inst.total_amount, currency)}
                  </div>
                </div>
              )
            })}
          </div>

          {selectedInstallmentIds.length > 0 && (
            <div style={{
              marginTop: '10px', padding: '10px 14px', borderRadius: '8px',
              display: 'flex', justifyContent: 'space-between', alignItems: 'center', fontSize: '13px',
              background: DIALOG.accentFill, border: `0.5px solid ${DIALOG.accentSoft}`, color: DIALOG.accent,
            }}>
              <span>{selectedInstallmentIds.length} installment{selectedInstallmentIds.length > 1 ? 's' : ''} selected</span>
              <span style={{ fontFamily: "'DM Mono',monospace", fontWeight: '700' }}>
                {fmtMoney(selectedTotal, currency)}
              </span>
            </div>
          )}
        </div>
      )}
    </div>
  )
}
