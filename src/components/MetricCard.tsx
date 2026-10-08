import React, { useRef } from 'react'
import { useCountUp, useDrawLength } from './motion'

// ── Sparkline ─────────────────────────────────────────────
function Sparkline({ data, color, w = 95, h = 36 }: {
  data: number[]
  color: string
  w?: number
  h?: number
}) {
  const lineRef = useRef<SVGPolylineElement | null>(null)
  useDrawLength(lineRef)

  if (!data?.length) return <div style={{ width: w, height: h }} />
  const min = Math.min(...data), max = Math.max(...data)
  const range = max - min || 1
  const pad = 3
  const pts = data.map((v, i) => [
    pad + (i / (data.length - 1)) * (w - pad * 2),
    pad + (1 - (v - min) / range) * (h - pad * 2),
  ])
  const line = pts.map(([x, y]) => `${x},${y}`).join(' ')
  const area = `M${pts[0][0]},${pts[0][1]} ${pts.map(([x,y]) => `L${x},${y}`).join(' ')} L${pts[pts.length-1][0]},${h-pad} L${pts[0][0]},${h-pad}Z`
  const [lx, ly] = pts[pts.length - 1]
  const gId = `mf-sg-${color.replace(/[^a-z0-9]/gi, '')}`

  return (
    <svg width={w} height={h} viewBox={`0 0 ${w} ${h}`} style={{ flexShrink: 0 }}>
      <defs>
        <linearGradient id={gId} x1="0" y1="0" x2="0" y2="1">
          <stop offset="0%" stopColor={color} stopOpacity="0.25"/>
          <stop offset="100%" stopColor={color} stopOpacity="0.02"/>
        </linearGradient>
      </defs>
      <path d={area} fill={`url(#${gId})`} className="mf-fade"/>
      {/* The line draws itself once, on arrival. Its length is measured from
          the element rather than guessed: a dash shorter than the line leaves
          a gap that never closes. */}
      <polyline ref={lineRef} className="mf-draw" points={line} fill="none"
        stroke={color} strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round"/>
      <circle cx={lx} cy={ly} r="2.8" fill={color} className="mf-fade"
        style={{ animationDelay: '820ms' }}/>
    </svg>
  )
}

// ── MetricCard ────────────────────────────────────────────
interface MetricCardProps {
  label: string
  value: string            // formatted, e.g. "90.500 RSD"
  /**
   * The raw figure and how to write it, where the card should COUNT to a
   * new value rather than swap to it.
   *
   * Optional, because a card showing a dash while it loads has no number
   * to count and should not pretend to.
   */
  amount?: number
  format?: (n: number) => string
  sub: string              // e.g. "YTD All companies"
  color: string            // semantic color for number + top border
  darkColor: string        // darker shade for text contrast
  sparklineData: number[]  // raw numbers for sparkline
  trendPct?: number        // e.g. 12.4
  trendUp?: boolean        // true = up arrow (green-ish), false = down (red-ish)
}

export default function MetricCard({
  label, value, sub, color, darkColor, sparklineData, trendPct, trendUp, amount, format,
}: MetricCardProps) {
  const [hovered, setHovered] = React.useState(false)
  // Counts only when the figure CHANGES — never on arrival, where counting up
  // from zero would be a small lie about what just happened.
  const counted = useCountUp(amount ?? 0)

  return (
    <div
      onMouseEnter={() => setHovered(true)}
      onMouseLeave={() => setHovered(false)}
      style={{
        background: '#0D1B2C',
        borderRadius: '10px',
        padding: '1rem 1.1rem 0.9rem',
        border: '1px solid rgba(255,255,255,0.075)',
        borderTop: `2.5px solid ${color}`,
        boxShadow: hovered ? '0 8px 32px rgba(0,0,0,0.5), 0 0 0 1px rgba(255,255,255,0.10)' : '0 4px 20px rgba(0,0,0,0.4)',
        transform: hovered ? 'translateY(-2px)' : 'none',
        transition: 'transform 0.15s ease, box-shadow 0.15s ease',
        cursor: 'default',
      }}
    >
      {/* Label */}
      <div style={{ fontSize: '10px', fontWeight: '600', color: 'rgba(255,255,255,0.30)', textTransform: 'uppercase', letterSpacing: '0.1em', marginBottom: '6px' }}>
        {label}
      </div>

      {/* Number + Sparkline */}
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start' }}>
        <div>
          <div style={{ fontFamily: "'DM Mono', 'Fira Mono', monospace", fontSize: '27px', fontWeight: '400', lineHeight: 1, color: '#DCE9F6', marginBottom: '6px', letterSpacing: '-0.02em' }}>
            {amount !== undefined && format ? format(counted) : value}
          </div>
          <div style={{ display: 'flex', alignItems: 'center', gap: '6px' }}>
            {trendPct !== undefined && (
              <span style={{
                fontSize: '10px', fontWeight: '600', padding: '2px 7px', borderRadius: '20px',
                background: trendUp ? '#E1F5EE' : '#FCEBEB',
                color: trendUp ? '#0B5E49' : '#A32D2D',
              }}>
                {trendUp ? '↑' : '↓'} {Math.abs(trendPct)}%
              </span>
            )}
            <span style={{ fontSize: '10px', color: 'rgba(255,255,255,0.30)' }}>{sub}</span>
          </div>
        </div>
        <Sparkline data={sparklineData} color={color}/>
      </div>
    </div>
  )
}

// ── Named export for Sparkline (reusable elsewhere) ───────
export { Sparkline }
