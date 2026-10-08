import React, { useMemo, useState } from 'react'
import { C, deck, useWidth } from './chartChrome'
import { niceMax, shortMoney } from '../services/expenseCharts'
import type { CashMonth, CashTimeline, DatedOutflow } from '../services/cashTimeline'
import { useDisplayCurrency } from '../contexts/DisplayCurrencyContext'
import { fmtMoney } from '../utils/formatters'

// ── The cash line ───────────────────────────────────────────────────────────
//
// One series through the year: what moved, what is expected to move, and the
// balance carried straight through today.
//
// HISTORY AND FORECAST ON ONE AXIS, because the question a cash flow is opened
// for — when does the balance get low — crosses today. Two charts side by side
// make that a question answered by scrolling.
//
// ── What colour does ────────────────────────────────────────────────────────
//
// In above the line, out below it, balance as a line across. Green against red
// is the one pair a red-green reader cannot separate — ΔE 6.9 under
// deuteranopia, inside the 6–8 band the validator allows ONLY with secondary
// encoding. It has four: the side of the baseline a bar is on, the sign on its
// figure, the words in the tooltip, and the fact that the balance is a line
// and the flows are bars, which no colour confusion can merge.
//
// Everything is in one currency, so everything is on ONE scale. A balance of 600k over
// flows of ±330k sits high in the frame and that is the truth about it.
//
// A projected month is drawn at reduced opacity and the month in progress is
// hatched: three states that have to read differently at a glance, because
// acting on a projection as though it were a measurement is the one mistake
// this page can cause.

const IN = '#00D47E'
const OUT = '#FF5B5A'
const BALANCE = '#4EA8FF'

const PAD = { l: 62, r: 16, t: 16, b: 46 }

// The timeline arrives in the viewer's display currency (the loader read each
// row's own figure in it); these only name it. The axis uses the compact
// scale without the code.
const moneyIn = (currency: string, dp: number) => (n: number) => fmtMoney(n, currency, dp)

const MONTH_SHORT = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec']

function monthTick(m: string): string {
  const [y, mm] = m.split('-').map(Number)
  const name = MONTH_SHORT[mm - 1] || m
  return mm === 1 ? `${name} '${String(y).slice(2)}` : name
}

const BASIS_WORD: Record<CashMonth['basis'], string> = {
  actual: 'posted',
  partial: 'part posted, part expected',
  projected: 'expected',
}

export default function CashFlowTimeline({ timeline, dated, onPickMonth }: {
  timeline: CashTimeline
  /** month -> the outflows that carry a date of their own. */
  dated: Record<string, { total: number; items: DatedOutflow[] }>
  onPickMonth?: (month: string) => void
}) {
  const { currency } = useDisplayCurrency()
  const money = moneyIn(currency, 0)
  const money2 = moneyIn(currency, 2)
  const [ref, width] = useWidth(900)
  const [tip, setTip] = useState<{ x: number; y: number; body: React.ReactNode } | null>(null)

  const rows = timeline.months
  const w = Math.max(480, width)
  const H = 300

  // ONE SCALE, NOT A SYMMETRIC ONE. Everything is in one currency, so a unit of it is the
  // same number of pixels above the line as below it — that is what "one
  // scale" means, and it is what stops a chart inventing a crossing.
  //
  // It does NOT mean the axis has to reach as far down as it reaches up.
  // Rendering showed what that costs: the balance is 612k and the largest
  // outflow 402k, so a symmetric axis ran to ±1.0M and the bottom third of
  // the frame was empty while every bar was squeezed into the middle. The two
  // extents are measured separately and the zero line sits where they meet.
  const { up, down } = useMemo(() => {
    const balances = rows.map(r => r.closing).filter((b): b is number => b !== null)
    return {
      up: niceMax(Math.max(1, ...rows.map(r => r.inflow), ...balances)),
      down: niceMax(Math.max(1, ...rows.map(r => r.outflow), ...balances.map(b => -b))),
    }
  }, [rows])

  const iw = w - PAD.l - PAD.r
  const plot = H - PAD.t - PAD.b
  const step = iw / Math.max(1, rows.length)
  const bw = Math.max(5, Math.min(18, step / 2 - 4))
  const perDollar = plot / (up + down)
  const mid = PAD.t + up * perDollar
  const yOf = (v: number) => mid - v * perDollar
  const cxOf = (i: number) => PAD.l + step * i + step / 2

  const show = (e: React.MouseEvent, body: React.ReactNode) => {
    const box = (e.currentTarget as SVGElement).ownerSVGElement!.getBoundingClientRect()
    setTip({ x: e.clientX - box.left + 14, y: e.clientY - box.top - 8, body })
  }

  const balancePath = rows
    .map((r, i) => r.closing === null ? null : `${cxOf(i)},${yOf(r.closing)}`)
    .filter(Boolean)
    .join(' ')

  const firstProjected = rows.findIndex(r => r.basis === 'projected')

  return (
    <div style={deck.wrap} ref={ref}>
      <div style={deck.head}>
        <div style={{ display: 'flex', alignItems: 'baseline', gap: '12px', flexWrap: 'wrap' }}>
          <span style={st.title}>Cash, twelve months</span>
          {timeline.position && (
            <span style={deck.hint}>
              anchored on {money(timeline.position.amount)} read {timeline.position.asOf}
            </span>
          )}
        </div>
        {timeline.trough && (
          <span style={{
            ...deck.hint,
            color: timeline.trough.amount < 0 ? OUT
              : timeline.trough.amount < timeline.position!.amount * 0.3 ? '#F5A623' : C.dim,
          }}>
            lowest {money(timeline.trough.amount)} in {monthTick(timeline.trough.month)}
          </span>
        )}
      </div>

      {timeline.problems.length > 0 && (
        <div style={st.problems}>
          {timeline.problems.map((p, i) => <div key={i} style={st.problem}>{p}</div>)}
        </div>
      )}

      <div style={{ position: 'relative' }} onMouseLeave={() => setTip(null)}>
        <svg width="100%" viewBox={`0 0 ${w} ${H}`} role="img"
          aria-label="Cash in, cash out and the balance, twelve months">
          <defs>
            {/* The month in progress. Hatching rather than a third hue: it is
                not a third kind of thing, it is both of the other two. */}
            <pattern id="cf-part" width="6" height="6" patternUnits="userSpaceOnUse"
              patternTransform="rotate(45)">
              <rect width="6" height="6" fill="rgba(255,255,255,0.04)" />
              <line x1="0" y1="0" x2="0" y2="6" stroke="rgba(255,255,255,0.28)" strokeWidth="2" />
            </pattern>
          </defs>

          {[up, up / 2, 0, -down / 2, -down].map(v => (
            <g key={v}>
              <line x1={PAD.l} x2={w - PAD.r} y1={yOf(v)} y2={yOf(v)}
                stroke={v === 0 ? C.line : C.grid} strokeWidth={1} />
              <text x={PAD.l - 8} y={yOf(v) + 3.5} textAnchor="end" fontSize={10} fill={C.dim}
                fontFamily="'DM Mono', monospace">{shortMoney(Math.abs(v))}</text>
            </g>
          ))}

          {/* Where the measured stops and the expected begins. */}
          {firstProjected > 0 && (
            <line
              x1={PAD.l + step * firstProjected} x2={PAD.l + step * firstProjected}
              y1={PAD.t} y2={PAD.t + plot} stroke="rgba(255,255,255,0.16)" strokeWidth={1} />
          )}

          {rows.map((r, i) => {
            const cx = cxOf(i)
            const dated1 = dated[r.month]
            return (
              <g key={r.month}
                style={{ cursor: onPickMonth ? 'pointer' : 'default' }}
                onClick={() => onPickMonth?.(r.month)}
                onMouseMove={e => show(e, (
                  <>
                    <div style={st.tipHead}>{monthTick(r.month)} · {BASIS_WORD[r.basis]}</div>
                    <div style={st.tipRow}><span>In</span><b style={{ color: IN }}>+{money2(r.inflow)}</b></div>
                    <div style={st.tipRow}><span>Out</span><b style={{ color: OUT }}>−{money2(r.outflow)}</b></div>
                    <div style={st.tipRow}>
                      <span>{r.net >= 0 ? 'Kept' : 'Lost'}</span>
                      <b>{money2(Math.abs(r.net))}</b>
                    </div>
                    {r.closing !== null && (
                      <div style={st.tipRow}>
                        <span>Balance at month end</span>
                        <b style={{ color: r.closing < 0 ? OUT : BALANCE }}>{money2(r.closing)}</b>
                      </div>
                    )}
                    {dated1 && (
                      <div style={st.tipNote}>
                        {money(dated1.total)} of it is dated: {dated1.items.slice(0, 3)
                          .map(x => x.label).join(', ')}
                        {dated1.items.length > 3 && ` and ${dated1.items.length - 3} more`}.
                      </div>
                    )}
                  </>
                ))}
                onMouseLeave={() => setTip(null)}>
                {/* A wide invisible hit area, so the tooltip is reachable
                    without landing exactly on an 11px bar. */}
                <rect x={cx - step / 2} y={PAD.t} width={step} height={plot}
                  fill="transparent" />
                {/* The colour first, the hatch OVER it. Hatching instead of
                    the fill left the month in progress reading as an empty
                    outline beside eleven solid bars — the one month everybody
                    is looking at, and the faintest thing on the chart. */}
                <rect x={cx - bw - 1} y={yOf(r.inflow)} width={bw}
                  height={Math.max(1, mid - yOf(r.inflow))} rx={4}
                  fill={IN} opacity={r.basis === 'projected' ? 0.5 : 1} />
                <rect x={cx + 1} y={mid} width={bw}
                  height={Math.max(1, yOf(-r.outflow) - mid)} rx={4}
                  fill={OUT} opacity={r.basis === 'projected' ? 0.5 : 1} />
                {r.basis === 'partial' && (
                  <>
                    <rect x={cx - bw - 1} y={yOf(r.inflow)} width={bw}
                      height={Math.max(1, mid - yOf(r.inflow))} rx={4} fill="url(#cf-part)" />
                    <rect x={cx + 1} y={mid} width={bw}
                      height={Math.max(1, yOf(-r.outflow) - mid)} rx={4} fill="url(#cf-part)" />
                  </>
                )}
                <text x={cx} y={H - 26} textAnchor="middle" fontSize={10}
                  fill={r.basis === 'projected' ? C.faint : C.dim}>{monthTick(r.month)}</text>
              </g>
            )
          })}

          {/* The balance last, over the bars, as a LINE — a different mark
              entirely, which is what keeps it readable beside two colours a
              CVD reader may not separate. */}
          {balancePath && (
            <polyline points={balancePath} fill="none" stroke={BALANCE} strokeWidth={2}
              strokeLinejoin="round" strokeLinecap="round" pointerEvents="none" />
          )}
          {rows.map((r, i) => r.closing === null ? null : (
            <circle key={r.month} cx={cxOf(i)} cy={yOf(r.closing)} r={4}
              fill={r.closing < 0 ? OUT : BALANCE} stroke={C.bg} strokeWidth={2}
              pointerEvents="none" />
          ))}
        </svg>
        {tip && <div style={{ ...deck.tip, left: tip.x, top: tip.y }}>{tip.body}</div>}
      </div>

      <div style={deck.legend}>
        <span style={deck.legendItem}><span style={{ ...deck.swatch, background: IN }} />In — above the line</span>
        <span style={deck.legendItem}><span style={{ ...deck.swatch, background: OUT }} />Out — below it</span>
        <span style={deck.legendItem}>
          <span style={{ ...deck.swatch, background: BALANCE, borderRadius: '50%' }} />
          Balance at month end
        </span>
        <span style={deck.legendItem}>
          <span style={{ ...deck.swatch, background: 'rgba(255,255,255,0.22)' }} />
          Hatched — the month in progress · Pale — expected
        </span>
      </div>
      <div style={st.note}>
        Everything is on one scale because everything is in one currency; a balance given an axis
        of its own is how a chart invents a crossing that is not in the data. The balance
        is walked outward from the cash reading in both directions — it is the only
        measured figure on the line, so it anchors rather than terminates it.
      </div>
    </div>
  )
}

const st: Record<string, React.CSSProperties> = {
  title: { fontSize: '13px', fontWeight: 600, color: C.text },
  problems: {
    background: 'rgba(245,166,35,0.08)', border: '1px solid rgba(245,166,35,0.3)',
    borderRadius: '9px', padding: '9px 12px', marginBottom: '10px',
  },
  problem: { fontSize: '11.5px', color: '#F5A623', lineHeight: 1.55 },
  tipHead: { fontSize: '11.5px', color: C.text, fontWeight: 600, marginBottom: '5px' },
  tipRow: {
    display: 'flex', justifyContent: 'space-between', gap: '14px',
    fontSize: '11px', color: C.dim, lineHeight: 1.7,
  },
  tipNote: { fontSize: '10.5px', color: C.faint, marginTop: '5px', lineHeight: 1.45 },
  note: { fontSize: '11px', color: '#5C7894', lineHeight: 1.55, marginTop: '9px', maxWidth: '820px' },
}
