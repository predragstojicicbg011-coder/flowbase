import React, { useState } from 'react'
import { fmtMoney, fmtNum } from '../utils/formatters'
import { C, deck, useWidth, Empty, TipHead, TipRow, type Tip } from './chartChrome'
import { niceMax, axisTicks, monthLabel } from '../services/expenseCharts'
import type { DebtMonth } from '../services/homeDebt'

// ── Indebtedness on the home page ───────────────────────────────────────────
//
// Two panels on one month axis, never one chart with two scales:
//
//   above   what moved: what the bank lent (up) against what fell due (down),
//           principal and interest stacked. The part of a due bar that is
//           marked paid is solid; what is still unpaid is pale.
//   below   what is owed: the principal outstanding at each month end — for
//           the current month, today.
//
// The figures come from homeDebt and are already in one currency; this file
// draws them and adds nothing to them. Principal is blue and interest amber,
// the pair the Credits page uses for the same two things.

const DRAWN = '#2B9C74'
const PRINCIPAL = '#3585D0'
const INTEREST = '#C08020'
const BALANCE = '#4EA8FF'

const PAD = { l: 64, r: 16 }

export default function DebtFlowsChart({ months, currency }: {
  months: DebtMonth[]
  currency: string
}) {
  const [tip, setTip] = useState<Tip>(null)
  const [ref, w] = useWidth(800)
  const money = (n: number) => fmtMoney(n, currency, 0)

  const anything = months.some(m => m.drawn || m.principalDue || m.interestDue || m.balance)
  if (months.length === 0 || !anything) {
    return <Empty h={120} text="U ovom periodu nema ni povlačenja, ni rata, ni duga." />
  }

  const iw = Math.max(w - PAD.l - PAD.r, 10)
  const band = iw / months.length
  const barW = Math.min(band * 0.56, 38)
  const cx = (i: number) => PAD.l + band * i + band / 2
  const crossesYear = new Set(months.map(m => m.month.slice(0, 4))).size > 1
  const every = months.length > 30 ? 3 : months.length > 18 ? 2 : 1
  const axis = (n: number) => fmtNum(n, 0)

  // ── Flows: up and down from one zero line, on one scale ──
  const FH = 210
  const ft = 12
  const fb = 24
  const fih = FH - ft - fb
  const upMax = Math.max(...months.map(m => m.drawn), 0)
  const downMax = Math.max(...months.map(m => m.principalDue + m.interestDue), 0)
  const span = niceMax(Math.max(upMax, downMax))
  const upShare = upMax > 0 && downMax > 0 ? 0.5 : upMax > 0 ? 0.9 : 0.1
  const zero = ft + fih * upShare
  const per = (v: number) => (v / span) * (upMax > 0 && downMax > 0 ? fih / 2 : fih * 0.9)

  // ── Balance ──
  const BH = 150
  const bt = 12
  const bb = 26
  const bih = BH - bt - bb
  const balMax = Math.max(...months.map(m => m.balance), 0)
  const bTop = niceMax(balMax)
  const by = (v: number) => bt + bih - (v / bTop) * bih
  const bTicks = axisTicks(balMax, 3)
  const line = months.map((m, i) => `${i === 0 ? 'M' : 'L'}${cx(i).toFixed(1)},${by(m.balance).toFixed(1)}`).join(' ')
  const area = `${line} L${cx(months.length - 1).toFixed(1)},${bt + bih} L${cx(0).toFixed(1)},${bt + bih} Z`

  const tipFor = (m: DebtMonth) => (ev: React.MouseEvent) => setTip({
    x: ev.nativeEvent.offsetX, y: ev.nativeEvent.offsetY,
    body: (
      <>
        <TipHead>{monthLabel(m.month, true)}</TipHead>
        <TipRow label="Povučeno" value={money(m.drawn)} />
        <TipRow label="Glavnica dospela" value={money(m.principalDue)} />
        <TipRow label="od toga plaćeno" value={money(m.principalPaid)} dim />
        <TipRow label="Kamata dospela" value={money(m.interestDue)} />
        <TipRow label="od toga plaćeno" value={money(m.interestPaid)} dim />
        <TipRow label="Dug na kraju meseca" value={money(m.balance)} />
      </>
    ),
  })

  /** A due bar, its paid part solid and the rest pale, from `y0` downwards. */
  const dueBar = (x: number, y0: number, due: number, paid: number, colour: string) => {
    if (due <= 0) return null
    const h = Math.max(per(due), 1)
    const hp = Math.min(Math.max(per(Math.min(paid, due)), 0), h)
    return (
      <>
        <rect x={x} y={y0} width={barW} height={h} rx="2" fill={colour} opacity="0.32" />
        {hp > 0 && <rect x={x} y={y0} width={barW} height={hp} rx="2" fill={colour} opacity="0.92" />}
      </>
    )
  }

  return (
    <div>
      <div ref={ref} style={{ position: 'relative' }} onMouseLeave={() => setTip(null)}>
        <svg width="100%" height={FH} style={{ display: 'block' }} role="img"
          aria-label={`Povučeno i dospelo po mesecima, u ${currency}`}>
          <text x={PAD.l - 9} y={ft + 4} textAnchor="end" fontSize="10" fill={C.faint}>{upMax > 0 ? axis(span) : ''}</text>
          <text x={PAD.l - 9} y={zero + 3.5} textAnchor="end" fontSize="10" fill={C.faint}>0</text>
          {downMax > 0 && (
            <text x={PAD.l - 9} y={ft + fih} textAnchor="end" fontSize="10" fill={C.faint}>−{axis(span)}</text>
          )}
          <line x1={PAD.l} x2={w - PAD.r} y1={zero} y2={zero} stroke="rgba(255,255,255,0.18)" strokeWidth="1" />
          {months.map((m, i) => {
            const x = cx(i) - barW / 2
            const ph = m.principalDue > 0 ? Math.max(per(m.principalDue), 1) : 0
            return (
              <g key={m.month} onMouseMove={tipFor(m)}
                aria-label={`${monthLabel(m.month, true)}: povučeno ${money(m.drawn)}, glavnica ${money(m.principalDue)} (plaćeno ${money(m.principalPaid)}), kamata ${money(m.interestDue)} (plaćeno ${money(m.interestPaid)})`}>
                <rect x={PAD.l + band * i} y={0} width={band} height={FH} fill="transparent" />
                {m.drawn > 0 && (
                  <rect x={x} y={zero - Math.max(per(m.drawn), 1)} width={barW} height={Math.max(per(m.drawn), 1)}
                    rx="2" fill={DRAWN} opacity="0.92" />
                )}
                {dueBar(x, zero + 0.5, m.principalDue, m.principalPaid, PRINCIPAL)}
                {dueBar(x, zero + 0.5 + ph + (ph > 0 ? 1.5 : 0), m.interestDue, m.interestPaid, INTEREST)}
              </g>
            )
          })}
        </svg>

        <svg width="100%" height={BH} style={{ display: 'block', marginTop: '6px' }} role="img"
          aria-label={`Preostala glavnica na kraju meseca, u ${currency}`}>
          {bTicks.map(t => (
            <g key={t}>
              <line x1={PAD.l} x2={w - PAD.r} y1={by(t)} y2={by(t)} stroke={C.grid} strokeWidth="1" />
              <text x={PAD.l - 9} y={by(t) + 3.5} textAnchor="end" fontSize="10" fill={C.faint}>{axis(t)}</text>
            </g>
          ))}
          <path d={area} fill={BALANCE} opacity="0.14" />
          <path d={line} fill="none" stroke={BALANCE} strokeWidth="2" strokeLinejoin="round" />
          {months.map((m, i) => (
            <g key={m.month} onMouseMove={tipFor(m)}
              aria-label={`${monthLabel(m.month, true)}: dug na kraju meseca ${money(m.balance)}`}>
              <rect x={PAD.l + band * i} y={0} width={band} height={BH} fill="transparent" />
              <circle cx={cx(i)} cy={by(m.balance)} r="3" fill={BALANCE} stroke={C.bg} strokeWidth="1.5" />
              {i % every === 0 && (
                <text x={cx(i)} y={BH - 8} textAnchor="middle" fontSize="10" fill={C.dim}>
                  {monthLabel(m.month, crossesYear)}
                </text>
              )}
            </g>
          ))}
        </svg>

        {tip && (
          <div style={{
            ...deck.tip,
            left: Math.min(Math.max(tip.x + 14, 8), Math.max(w - 240, 8)),
            top: Math.max(tip.y - 10, 6),
          }}>{tip.body}</div>
        )}
      </div>

      <div style={deck.legend}>
        {([['Povučeno', DRAWN], ['Glavnica', PRINCIPAL], ['Kamata', INTEREST], ['Dug na kraju meseca', BALANCE]] as const)
          .map(([label, colour]) => (
            <span key={label} style={deck.legendItem}>
              <i style={{ ...deck.swatch, background: colour }} />{label}
            </span>
          ))}
        <span style={deck.legendItem}>bledo: dospelo, a nije plaćeno</span>
        <span style={deck.legendItem}>iznosi u {currency}</span>
      </div>
    </div>
  )
}
