import React from 'react'
import { C, Empty, TipHead, TipRow, type Tip } from './chartChrome'
import { niceMax, shortMoney, monthLabel, OTHER } from '../services/expenseCharts'
import {
  moverBars, moverScale, heatGrid, binOf, rowBin, facingRows,
} from '../services/expenseCharts'

// ── Three panels the stack could not give ───────────────────────────────────
//
// The deck had four charts and all four asked a version of "how big". These
// ask the three questions that come next in a real conversation about costs:
//
//   Movers    which lines moved, ranked, with the direction kept
//   Heatmap   all forty lines at once, month by month — spikes and stoppages
//   Split     on an allocated tab, which costs lean which way
//
// ── Colour, by the job it does ──────────────────────────────────────────────
//
// Movers is polarity, so it is the green/red pair — which is also the one
// pair a red-green reader cannot separate. It is legal here only because it
// carries three other encodings: side of the centre line, a signed figure
// printed on the bar, and the word "more"/"less" in the tooltip.
//
// The heatmap is magnitude, so it is one hue, light to dark. Five steps,
// validated against this surface: monotone lightness, every adjacent gap
// visible, and the darkest step still clear of the background so an empty
// cell and a small one are not the same thing.
//
// Split is identity — two entities, not two poles — so it is a two-slot
// categorical pair: ΔE 24 under protanopia, 27 to normal vision, both inside
// the dark-mode lightness band. Deeper than the rest of the page on purpose:
// these are large fills, and a large fill at the saturation of a small mark
// shouts over everything beside it.

/** Sequential, one hue. Validated --ordinal against #0D1B2C. */
const HEAT = ['#39608C', '#4A82B8', '#5EA3DC', '#82C4F0', '#B4E0F9']
const HEAT_EMPTY = 'rgba(255,255,255,0.035)'

/** Two slots, categorical. Validated against #0D1B2C: all checks pass. */
export const SIDE_LEFT = '#3585D0'
export const SIDE_RIGHT = '#C08020'

const money = (n: number) =>
  (n < 0 ? '−$' : '$') + Math.abs(n).toLocaleString('en-US', { maximumFractionDigits: 0 })

const signed = (n: number) =>
  (n > 0 ? '+' : n < 0 ? '−' : '') + '$' + Math.abs(n).toLocaleString('en-US', { maximumFractionDigits: 0 })

/** Cuts a label to fit a gutter, because an SVG will not do it for you. */
function clip(text: string, chars: number): string {
  return text.length <= chars ? text : text.slice(0, Math.max(chars - 1, 1)) + '…'
}

// ═══ Movers ══════════════════════════════════════════════════════════════════

export function MoversChart({ compared, depth, limit, w, onTip, onSelect, priorLabel, periodLabel }: {
  compared: Parameters<typeof moverBars>[0]
  depth: number
  limit: number
  w: number
  onTip: (t: Tip) => void
  onSelect: (k: string | null) => void
  priorLabel: string
  periodLabel: string
}) {
  const bars = moverBars(compared, depth, limit)
  if (bars.length === 0) {
    return <Empty h={280} text={`Nothing moved between ${priorLabel} and ${periodLabel} at this level.`} />
  }

  const ROW = 30
  const BAR = 15
  const labelW = Math.min(Math.max(w * 0.26, 110), 230)
  const PAD = { l: 4, r: 96, t: 26, b: 26 }
  const plotW = Math.max(w - labelW - PAD.l - PAD.r, 60)
  const h = PAD.t + bars.length * ROW + PAD.b

  // One ruler for both sides; the zero line sits where the data puts it, so a
  // month in which everything rose uses the whole width instead of half of it.
  const axis = moverScale(bars, plotW)
  const mid = PAD.l + labelW + axis.zeroX
  const x = (v: number) => mid + v * axis.perDollar
  const chars = Math.floor(labelW / 6.6)

  /** Ticks outward from zero, only as far as that side actually reaches. */
  const sideTicks = (reach: number, sign: number): number[] => {
    if (reach <= 0) return []
    const step = niceMax(reach / 2)
    const out: number[] = []
    for (let v = step; v <= reach + step * 0.01; v += step) out.push(sign * v)
    return out
  }
  const ticks = [0, ...sideTicks(axis.down, -1), ...sideTicks(axis.up, 1)]

  return (
    <svg width="100%" height={h} style={{ display: 'block' }}>
      {ticks.map(t => (
        <g key={t}>
          <line x1={x(t)} x2={x(t)} y1={PAD.t - 8} y2={h - PAD.b + 2}
            stroke={t === 0 ? 'rgba(255,255,255,0.22)' : C.grid} strokeWidth="1" />
          <text x={x(t)} y={PAD.t - 13} textAnchor="middle" fontSize="9.5" fill={C.faint}>
            {t === 0 ? '0' : shortMoney(Math.abs(t))}
          </text>
        </g>
      ))}
      {/* A caption only where there is something to caption. "spent less" over
          an empty strip reads as a finding, and it is the absence of one. */}
      {axis.down > 0 && (
        <text x={x(-axis.down)} y={h - 8} textAnchor="start" fontSize="10" fill={C.down}>◀ spent less</text>
      )}
      {axis.up > 0 && (
        <text x={x(axis.up)} y={h - 8} textAnchor="end" fontSize="10" fill={C.up}>spent more ▶</text>
      )}

      {bars.map((b, i) => {
        const yTop = PAD.t + i * ROW + (ROW - BAR) / 2
        const rising = b.delta > 0
        const col = rising ? C.up : C.down
        const x0 = rising ? mid : x(b.delta)
        const bw = Math.max(Math.abs(x(b.delta) - mid), 2)

        const tip = (ev: React.MouseEvent) => onTip({
          x: ev.nativeEvent.offsetX, y: ev.nativeEvent.offsetY,
          body: (
            <>
              <TipHead>{b.label}</TipHead>
              {b.parent.length > 0 && <TipRow label="" value={b.parent.join(' › ')} dim />}
              <TipRow label={priorLabel} value={money(b.prior)} dim />
              <TipRow label={periodLabel} value={money(b.current)} />
              <TipRow label={rising ? 'more' : 'less'} value={money(Math.abs(b.delta))} />
              <TipRow label="change"
                value={b.deltaPct === null ? 'new line' : `${b.deltaPct > 0 ? '+' : ''}${b.deltaPct.toFixed(1)}%`} dim />
            </>
          ),
        })

        return (
          <g key={b.key} style={{ cursor: 'pointer' }}
            onMouseMove={tip} onClick={() => onSelect(b.key)}>
            {/* A hit target the width of the row, not the width of the bar:
                a $200 move is four pixels and nobody can click four pixels. */}
            <rect x={PAD.l} y={PAD.t + i * ROW} width={Math.max(w - PAD.l - 4, 10)} height={ROW}
              fill="transparent" />

            <text x={PAD.l + 2} y={PAD.t + i * ROW + ROW / 2 + 1} fontSize="11.5" fill={C.text}>
              {clip(b.label, chars)}
            </text>
            {b.parent.length > 0 && (
              <text x={PAD.l + 2} y={PAD.t + i * ROW + ROW / 2 + 12} fontSize="9" fill={C.faint}>
                {clip(b.parent.join(' › '), chars + 4)}
              </text>
            )}

            <rect x={x0} y={yTop} width={bw} height={BAR} rx="3.5" fill={col} opacity="0.9" />

            {/* The figure on the mark. This is the secondary encoding that
                makes the green/red pair legal, and it is also just useful. */}
            <text
              x={rising ? x(b.delta) + 7 : x(b.delta) - 7}
              y={yTop + BAR - 3.5}
              textAnchor={rising ? 'start' : 'end'}
              fontSize="10.5" fill={col} fontFamily="'DM Mono', monospace">
              {signed(b.delta)}
            </text>
          </g>
        )
      })}
    </svg>
  )
}

// ═══ Heatmap ═════════════════════════════════════════════════════════════════

export function HeatChart({ tree, months, depth, limit, byRow, w, onTip, onSelect, selected }: {
  tree: Parameters<typeof heatGrid>[0]
  months: string[]
  depth: number
  limit: number
  /** false: one scale over the whole grid. true: each line against itself. */
  byRow: boolean
  w: number
  onTip: (t: Tip) => void
  onSelect: (k: string | null) => void
  selected: string | null
}) {
  const grid = heatGrid(tree, months, depth, limit)
  if (grid.rows.length === 0 || months.length === 0) {
    return <Empty h={240} text="No spend in this period." />
  }

  const ROW = 26
  const GAP = 2
  const labelW = Math.min(Math.max(w * 0.24, 120), 250)
  const totalW = 86
  const PAD = { t: 26, b: 10 }
  const gridW = Math.max(w - labelW - totalW - 8, 80)
  const cellW = gridW / months.length
  const h = PAD.t + grid.rows.length * ROW + PAD.b
  const chars = Math.floor(labelW / 6.6)
  const crossesYear = new Set(months.map(m => m.slice(0, 4))).size > 1

  const grandTotal = grid.rows.reduce((s, r) => s + r.total, 0)
  const monthTotals = months.map((_, i) => grid.rows.reduce((s, r) => s + r.values[i], 0))

  return (
    <svg width="100%" height={h} style={{ display: 'block' }}>
      {months.map((m, i) => (
        <text key={m} x={labelW + cellW * i + cellW / 2} y={PAD.t - 10}
          textAnchor="middle" fontSize="10" fill={C.dim}>
          {monthLabel(m, crossesYear)}
        </text>
      ))}
      <text x={w - 4} y={PAD.t - 10} textAnchor="end" fontSize="9.5" fill={C.faint}>TOTAL</text>

      {grid.rows.map((r, ri) => {
        const y = PAD.t + ri * ROW
        const isOn = selected === r.key
        return (
          <g key={r.key}>
            {isOn && (
              <rect x={0} y={y} width={w} height={ROW - GAP} fill="rgba(0,212,126,0.07)" rx="4" />
            )}
            <text x={2} y={y + ROW / 2 + (r.parent.length > 0 ? -2 : 2)}
              fontSize="11.5" fill={r.label === OTHER ? C.dim : C.text}>
              {clip(r.label, chars)}
            </text>
            {r.parent.length > 0 && (
              <text x={2} y={y + ROW / 2 + 9} fontSize="9" fill={C.faint}>
                {clip(r.parent.join(' › '), chars + 4)}
              </text>
            )}

            {r.values.map((v, i) => {
              const bin = byRow ? rowBin(v, r.max, HEAT.length) : binOf(v, grid.bins)
              const fill = bin < 0 ? HEAT_EMPTY : HEAT[Math.min(bin, HEAT.length - 1)]
              return (
                <rect key={months[i]}
                  x={labelW + cellW * i} y={y}
                  width={Math.max(cellW - GAP, 1)} height={ROW - GAP}
                  rx="3" fill={fill}
                  style={{ cursor: r.node ? 'pointer' : 'default' }}
                  onClick={() => r.node && onSelect(r.key)}
                  onMouseMove={ev => onTip({
                    x: ev.nativeEvent.offsetX, y: ev.nativeEvent.offsetY,
                    body: (
                      <>
                        <TipHead>{r.label}</TipHead>
                        {r.parent.length > 0 && <TipRow label="" value={r.parent.join(' › ')} dim />}
                        <TipRow label={monthLabel(months[i], true)} value={money(v)} />
                        <TipRow label="share of month"
                          value={monthTotals[i] > 0 ? `${(v / monthTotals[i] * 100).toFixed(1)}%` : '—'} dim />
                        <TipRow label="of this line's year"
                          value={r.total > 0 ? `${(v / r.total * 100).toFixed(1)}%` : '—'} dim />
                        <TipRow label="its biggest month" value={money(r.max)} dim />
                      </>
                    ),
                  })} />
              )
            })}

            <text x={w - 4} y={y + ROW / 2 + 2} textAnchor="end" fontSize="10.5"
              fill={C.text} fontFamily="'DM Mono', monospace">
              {shortMoney(r.total)}
            </text>
            <text x={w - 4} y={y + ROW / 2 + 11} textAnchor="end" fontSize="8.5" fill={C.faint}>
              {grandTotal > 0 ? `${(r.total / grandTotal * 100).toFixed(1)}%` : ''}
            </text>
          </g>
        )
      })}
    </svg>
  )
}

/** The bin legend. Printed in dollars, because a shade nobody can price is decoration. */
export function HeatLegend({ tree, months, depth, limit, byRow }: {
  tree: Parameters<typeof heatGrid>[0]
  months: string[]
  depth: number
  limit: number
  byRow: boolean
}) {
  const grid = heatGrid(tree, months, depth, limit)
  const edges = grid.bins

  const label = (i: number): string => {
    if (byRow) {
      const lo = (i / HEAT.length) * 100
      const hi = ((i + 1) / HEAT.length) * 100
      return i === HEAT.length - 1 ? `top ${(100 - lo).toFixed(0)}%` : `${lo.toFixed(0)}–${hi.toFixed(0)}%`
    }
    if (edges.length === 0) return '—'
    if (i === 0) return `< ${shortMoney(edges[0])}`
    if (i >= edges.length) return `> ${shortMoney(edges[edges.length - 1])}`
    return `${shortMoney(edges[i - 1])}–${shortMoney(edges[i])}`
  }

  return (
    <div style={{ display: 'flex', alignItems: 'center', gap: '12px', flexWrap: 'wrap' }}>
      <span style={{ fontSize: '10px', color: C.faint }}>
        {byRow ? 'SHARE OF THE LINE’S BIGGEST MONTH' : 'MONTHLY SPEND PER LINE'}
      </span>
      <span style={{ display: 'flex', alignItems: 'center', gap: '2px' }}>
        <span style={{
          width: '13px', height: '13px', borderRadius: '3px', background: HEAT_EMPTY,
          display: 'inline-block', marginRight: '5px',
        }} />
        <span style={{ fontSize: '10px', color: C.dim, marginRight: '10px' }}>nothing</span>
        {HEAT.map((c, i) => (
          <span key={c} style={{ display: 'flex', alignItems: 'center', gap: '5px', marginRight: '10px' }}>
            <i style={{ width: '13px', height: '13px', borderRadius: '3px', background: c, display: 'inline-block' }} />
            <span style={{ fontSize: '10px', color: C.dim, fontFamily: "'DM Mono', monospace" }}>{label(i)}</span>
          </span>
        ))}
      </span>
      {!byRow && grid.folded > 0 && (
        <span style={{ fontSize: '10px', color: C.faint }}>
          {grid.folded} smaller line{grid.folded === 1 ? '' : 's'} folded into Other
        </span>
      )}
    </div>
  )
}

// ═══ Split ═══════════════════════════════════════════════════════════════════

export function FacingChart({ tree, leftLabel, rightLabel, limit, w, onTip, onSelect }: {
  tree: Parameters<typeof facingRows>[0]
  leftLabel: string
  rightLabel: string
  limit: number
  w: number
  onTip: (t: Tip) => void
  onSelect: (k: string | null) => void
}) {
  const chart = facingRows(tree, leftLabel, rightLabel, limit)
  if (chart.rows.length === 0) return <Empty h={240} text="No spend in this period." />

  const ROW = 28
  const BAR = 15
  const gutter = Math.min(Math.max(w * 0.2, 104), 210)
  const PAD = { t: 44, b: 24, x: 6 }
  const sideW = Math.max((w - gutter - PAD.x * 2) / 2, 40)
  const h = PAD.t + chart.rows.length * ROW + PAD.b
  const mid = PAD.x + sideW + gutter / 2
  const chars = Math.floor(gutter / 6.4)

  const max = Math.max(chart.max, 1)
  const total = chart.leftTotal + chart.rightTotal
  const leftShare = total > 0 ? chart.leftTotal / total : 0

  const ticks = [max / 2, max]

  return (
    <svg width="100%" height={h} style={{ display: 'block' }}>
      {/* The headline: what each side costs in total, and the one bar that
          says how the period divided. Without it the rows below are shapes
          with no sum. */}
      <text x={mid - gutter / 2 - 8} y="15" textAnchor="end" fontSize="11.5" fill={SIDE_LEFT} fontWeight="600">
        {leftLabel} · {money(chart.leftTotal)}
      </text>
      <text x={mid + gutter / 2 + 8} y="15" textAnchor="start" fontSize="11.5" fill={SIDE_RIGHT} fontWeight="600">
        {rightLabel} · {money(chart.rightTotal)}
      </text>
      <rect x={PAD.x} y="21" width={Math.max(w - PAD.x * 2, 10)} height="6" rx="3" fill={SIDE_RIGHT} opacity="0.85" />
      <rect x={PAD.x} y="21" width={Math.max((w - PAD.x * 2) * leftShare - 1, 0)} height="6" rx="3"
        fill={SIDE_LEFT} opacity="0.85" />
      <text x={mid} y="17" textAnchor="middle" fontSize="9.5" fill={C.faint}>
        {(leftShare * 100).toFixed(0)} / {((1 - leftShare) * 100).toFixed(0)}
      </text>

      {ticks.map(t => (
        <g key={t}>
          <line x1={mid - gutter / 2 - (t / max) * sideW} x2={mid - gutter / 2 - (t / max) * sideW}
            y1={PAD.t - 6} y2={h - PAD.b + 2} stroke={C.grid} strokeWidth="1" />
          <line x1={mid + gutter / 2 + (t / max) * sideW} x2={mid + gutter / 2 + (t / max) * sideW}
            y1={PAD.t - 6} y2={h - PAD.b + 2} stroke={C.grid} strokeWidth="1" />
          <text x={mid - gutter / 2 - (t / max) * sideW} y={h - 8} textAnchor="middle" fontSize="9" fill={C.faint}>
            {shortMoney(t)}
          </text>
          <text x={mid + gutter / 2 + (t / max) * sideW} y={h - 8} textAnchor="middle" fontSize="9" fill={C.faint}>
            {shortMoney(t)}
          </text>
        </g>
      ))}

      {chart.rows.map((r, i) => {
        const y = PAD.t + i * ROW + (ROW - BAR) / 2
        const lw = (r.left / max) * sideW
        const rw = (r.right / max) * sideW
        const lean = r.total > 0 ? r.left / r.total : 0

        const tipFor = (side: 'left' | 'right') => (ev: React.MouseEvent) => onTip({
          x: ev.nativeEvent.offsetX, y: ev.nativeEvent.offsetY,
          body: (
            <>
              <TipHead>{r.label}</TipHead>
              <TipRow label={leftLabel} value={money(r.left)} dim={side === 'right'} />
              <TipRow label={rightLabel} value={money(r.right)} dim={side === 'left'} />
              <TipRow label="together" value={money(r.total)} dim />
              <TipRow label="leans"
                value={lean >= 0.999 ? leftLabel : lean <= 0.001 ? rightLabel
                  : `${(lean * 100).toFixed(0)}% ${leftLabel}`} dim />
            </>
          ),
        })

        return (
          <g key={r.label}>
            <text x={mid} y={y + BAR / 2 + 4} textAnchor="middle" fontSize="11" fill={C.text}>
              {clip(r.label, chars)}
            </text>

            <g style={{ cursor: r.leftKey ? 'pointer' : 'default' }}
              onMouseMove={tipFor('left')} onClick={() => r.leftKey && onSelect(r.leftKey)}>
              <rect x={PAD.x} y={PAD.t + i * ROW} width={sideW} height={ROW} fill="transparent" />
              <rect x={mid - gutter / 2 - lw} y={y} width={Math.max(lw, r.left > 0 ? 2 : 0)} height={BAR}
                rx="3.5" fill={SIDE_LEFT} opacity="0.92" />
              {lw > 46 && (
                <text x={mid - gutter / 2 - lw + 6} y={y + BAR - 3.5} fontSize="10"
                  fill="#0A1626" fontFamily="'DM Mono', monospace">{shortMoney(r.left)}</text>
              )}
            </g>

            <g style={{ cursor: r.rightKey ? 'pointer' : 'default' }}
              onMouseMove={tipFor('right')} onClick={() => r.rightKey && onSelect(r.rightKey)}>
              <rect x={mid + gutter / 2} y={PAD.t + i * ROW} width={sideW} height={ROW} fill="transparent" />
              <rect x={mid + gutter / 2} y={y} width={Math.max(rw, r.right > 0 ? 2 : 0)} height={BAR}
                rx="3.5" fill={SIDE_RIGHT} opacity="0.92" />
              {rw > 46 && (
                <text x={mid + gutter / 2 + rw - 6} y={y + BAR - 3.5} textAnchor="end" fontSize="10"
                  fill="#1A1206" fontFamily="'DM Mono', monospace">{shortMoney(r.right)}</text>
              )}
            </g>
          </g>
        )
      })}
    </svg>
  )
}
