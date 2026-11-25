import React, { useMemo, useState } from 'react'
import { DIALOG } from './dialogTheme'
import { fmtDate, fmtAmount } from './sefFormat'
import { srDate } from '../services/currencyService'
import {
  rankInstalments, differenceSentence, differs as differsFrom,
  type InstalmentCandidate, type InvoiceFacts, type DayRates, type PaidState,
} from '../services/sef/creditInterestLink'

// Which credit instalment a bank's interest invoice is for. Opened from a
// waiting row of the SEF inbox; linking creates no invoice and changes nothing
// in P&L, because the interest is booked when the instalment is paid.

/** Shown at first; the rest one click away. */
const FIRST = 8

const PAID_LABEL: Record<PaidState, string> = { paid: 'Plaćena', partial: 'Delimično', unpaid: 'Neplaćena' }

interface Props {
  rowId: string
  invoice: InvoiceFacts
  candidates: InstalmentCandidate[]
  /** The instalment the remembered PIB proposes, if any. */
  proposed: string | null
  /** The NBS rates of the invoice's day, when some instalment is in another currency. */
  rates: DayRates | null
  /** Why those rates are not there, when they could not be read. */
  rateProblem: string | null
  busy: boolean
  onCancel: () => void
  onLink: (installmentId: string) => void
}

export default function SefCreditLinkChooser({
  rowId, invoice, candidates, proposed, rates, rateProblem, busy, onCancel, onLink,
}: Props) {
  const [includeClosed, setIncludeClosed] = useState(false)
  const [showAll, setShowAll] = useState(false)
  const ranked = useMemo(
    () => rankInstalments(invoice, candidates, { includeClosed, rates }),
    [invoice, candidates, includeClosed, rates])
  // The proposal from the PIB, else an interest that matches the amount;
  // otherwise nothing is chosen for him, because a nearest guess is still a
  // guess. Only this one row is marked Predlog. Recomputed while he has not
  // chosen, because a rate that arrives later can make a match.
  const auto = useMemo(() => {
    const first = rankInstalments(invoice, candidates, { rates })
    return proposed ?? (first[0]?.matches ? first[0].installmentId : null)
  }, [invoice, candidates, rates, proposed])
  const [picked, setPicked] = useState<string | null>(null)
  const chosen = picked ?? auto
  // Linking an instalment whose interest is not the amount is asked twice,
  // the second time with the difference said.
  const [confirming, setConfirming] = useState(false)
  const choose = (id: string) => { setPicked(id); setConfirming(false) }

  const shown = showAll ? ranked : ranked.slice(0, FIRST)
  const chosenRow = ranked.find(r => r.installmentId === chosen) ?? null
  if (chosenRow && !shown.includes(chosenRow)) shown.push(chosenRow)
  const amount = invoice.amount === null || invoice.amount === undefined ? null : Number(invoice.amount)
  const sentence = chosenRow && amount !== null
    ? differenceSentence({ amount, currency: invoice.currency }, chosenRow, invoice.rateDate) : ''
  const differs = !!chosenRow && differsFrom(amount, chosenRow)
  const question = !chosenRow ? '' : amount === null
    ? 'Faktura ne navodi iznos koji bi se uporedio sa kamatom rate. Ipak povezati?'
    : chosenRow.rateMissing
      ? `Iznosi ne mogu da se uporede: ${sentence}. Ipak povezati?`
      : `Iznosi se razlikuju: ${sentence}. Ipak povezati?`
  const press = () => {
    if (!chosenRow) return
    if (differs && !confirming) { setConfirming(true); return }
    onLink(chosenRow.installmentId)
  }
  const missingRate = ranked.some(r => r.rateMissing)

  return (
    <div style={s.panel}>
      <div style={s.title}>Za koju ratu kredita je ova kamata?</div>
      <div style={s.hint}>
        Povezivanje ne pravi fakturu i ne menja P&amp;L: kamata se knjiži kada se rata plati. SEF se ne dira.
      </div>
      {missingRate && (
        <div role="status" style={s.rate}>
          {`Kurs NBS${invoice.rateDate ? ` za ${srDate(invoice.rateDate)}` : ''} nije dostupan, pa su rate u drugoj valuti poređane samo po datumu.`}
          {rateProblem ? ` ${rateProblem}` : ''}
        </div>
      )}

      {ranked.length === 0 && <div style={s.none}>Nema rate kredita ove firme za povezivanje.</div>}
      {shown.length > 0 && (
        <div role="radiogroup" aria-label="Rate kredita" style={s.list}>
          {shown.map(r => (
            <label key={r.installmentId} data-option={r.installmentId}
              style={{ ...s.option, borderColor: chosen === r.installmentId ? DIALOG.accent : DIALOG.border }}>
              <input type="radio" name={`instalment-${rowId}`} checked={chosen === r.installmentId}
                onChange={() => choose(r.installmentId)} />
              <span style={s.credit}>{r.creditName}</span>
              <span style={s.dim}>{r.bank || '—'}</span>
              <span style={s.dim}>#{r.installmentNo}</span>
              <span style={s.dim}>{fmtDate(r.dueDate)}</span>
              <span style={s.money}>{fmtAmount(r.interestAmount, r.currency)}</span>
              <span style={{ ...s.dim, color: r.paidState === 'paid' ? DIALOG.accent : DIALOG.dim }}>{PAID_LABEL[r.paidState]}</span>
              <span>
                {r.installmentId === auto && <span style={s.badge}>Predlog</span>}
                {r.installmentId !== auto && r.matches && <span style={s.mark}>poklapa se</span>}
              </span>
            </label>
          ))}
        </div>
      )}
      {!showAll && ranked.length > FIRST && (
        <button style={s.linkBtn} onClick={() => setShowAll(true)}>Prikaži sve ({ranked.length})</button>
      )}

      {chosenRow && amount !== null && !confirming && <div style={s.diff}>{sentence}</div>}
      {confirming && <div role="status" style={s.confirm}>{question}</div>}

      <div style={s.actions}>
        <label style={s.toggle}>
          <input type="checkbox" checked={includeClosed} onChange={e => setIncludeClosed(e.target.checked)} />
          Prikaži i zatvorene kredite
        </label>
        <button style={s.btnGhost} disabled={busy} onClick={onCancel}>Otkaži</button>
        <button style={{ ...(confirming ? s.btnWarn : s.btnPrimary), opacity: !chosenRow || busy ? 0.5 : 1 }}
          disabled={!chosenRow || busy}
          onClick={press}>{confirming ? 'Poveži uz razliku' : 'Poveži sa ovom ratom'}</button>
      </div>
    </div>
  )
}

const s: Record<string, React.CSSProperties> = {
  panel: { marginTop: '10px', paddingTop: '10px', borderTop: '0.5px solid ' + DIALOG.border },
  title: { fontSize: '13px', fontWeight: 500, color: DIALOG.text },
  hint: { fontSize: '11px', color: DIALOG.faint, marginTop: '4px' },
  rate: { fontSize: '12px', color: DIALOG.amber, background: DIALOG.amberFill, borderRadius: '6px', padding: '6px 10px', marginTop: '8px' },
  none: { fontSize: '12px', color: DIALOG.amber, marginTop: '10px' },
  list: { display: 'flex', flexDirection: 'column', gap: '6px', marginTop: '10px' },
  option: { display: 'grid', gridTemplateColumns: '16px minmax(0, 1.3fr) minmax(0, 1.3fr) 36px 96px 120px 80px 74px', alignItems: 'center', gap: '10px', fontSize: '12px', padding: '7px 10px', border: '1px solid', borderRadius: '8px', background: DIALOG.panel, cursor: 'pointer' },
  credit: { color: DIALOG.text, fontWeight: 500, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' },
  dim: { color: DIALOG.dim, whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' },
  money: { color: DIALOG.text, whiteSpace: 'nowrap', textAlign: 'right' },
  badge: { fontSize: '10px', fontWeight: 500, padding: '2px 8px', borderRadius: '20px', background: DIALOG.accentFill, color: DIALOG.accent },
  diff: { fontSize: '12px', color: DIALOG.dim, marginTop: '8px' },
  confirm: { fontSize: '12px', color: DIALOG.amber, background: DIALOG.amberFill, borderRadius: '6px', padding: '6px 10px', marginTop: '8px' },
  mark: { fontSize: '10px', color: DIALOG.faint },
  btnWarn: { background: DIALOG.amberFill, color: DIALOG.amber, border: '1px solid ' + DIALOG.amber, borderRadius: '8px', padding: '7px 14px', fontFamily: 'system-ui,sans-serif', fontSize: '12px', fontWeight: 600, cursor: 'pointer' },
  actions: { display: 'flex', gap: '8px', justifyContent: 'flex-end', alignItems: 'center', marginTop: '10px' },
  toggle: { fontSize: '12px', color: DIALOG.dim, display: 'flex', alignItems: 'center', gap: '6px', marginRight: 'auto' },
  linkBtn: { background: 'none', border: 'none', color: DIALOG.accent, fontFamily: 'system-ui,sans-serif', fontSize: '12px', cursor: 'pointer', padding: 0, textDecoration: 'underline', marginTop: '6px' },
  btnPrimary: { background: DIALOG.accent, color: DIALOG.onAccent, border: 'none', borderRadius: '8px', padding: '7px 14px', fontFamily: 'system-ui,sans-serif', fontSize: '12px', fontWeight: 600, cursor: 'pointer' },
  btnGhost: { background: 'transparent', color: DIALOG.dim, border: '1px solid ' + DIALOG.border, borderRadius: '8px', padding: '7px 14px', fontFamily: 'system-ui,sans-serif', fontSize: '12px', fontWeight: 500, cursor: 'pointer' },
}
