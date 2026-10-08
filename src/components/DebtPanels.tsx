import React, { useState, useMemo, createContext, useContext } from 'react'
import { fmtMoney } from '../utils/formatters'
import { C, deck, useWidth, Empty, TipHead, TipRow, type Tip } from './chartChrome'
import { niceMax, axisTicks, shortMoney, monthLabel } from '../services/expenseCharts'
import {
  monthlyDue, balanceSeries, debtFigures, byCredit,
  type DueInstalment, type DueRow, type BalancePoint,
} from '../services/debtSchedule'

// ── The debt, drawn ─────────────────────────────────────────────────────────
//
// Three questions a schedule of instalments cannot answer by being read:
//
//   Due by month   what has to be paid, and how much of it is just the cost of
//                  carrying the debt rather than reducing it
//   Balance        how the debt itself moves — and where the cliff is
//   By credit      which line the money is actually owed on
//
// The balance panel is the one that earns the page. An amortising book slopes
// gently to zero; a revolving book sits flat and then falls off in a single
// month, and that month is when the whole principal has to be in the bank. No table of
// instalments shows that.
//
// ── Two colour pairs, each meaning one thing everywhere ─────────────────────
//
// Principal is blue and interest is amber, in every panel that splits them.
// Annuity is green and revolving is magenta, in every panel that splits by
// kind. Two stable mappings rather than one pair reused for two meanings,
// which is how a reader ends up asking whether blue is principal or annuity.
//
// Both pairs were run through the validator against this surface, not chosen
// by eye: blue/amber ΔE 24.3 to normal vision and 24.3 under protanopia;
// green/magenta 27.9 and 11.9. Blue and purple were the first idea and failed
// at ΔE 2.4 under deuteranopia — two bands a red-green reader would have seen
// as one colour.

/** Principal against the cost of carrying it. */
const PRINCIPAL = '#3585D0'
const INTEREST = '#C08020'
/** The two kinds of obligation. */
const ANNUITY = '#2B9C74'
const REVOLVING = '#B25DC0'

/**
 * The currency every figure here is in — the one the page converted the
 * credits into before handing them over. The panels add instalments of
 * several credits together, so they can only be handed figures that are
 * already in one currency; they print its code, never assume one.
 */
const DebtCurrency = createContext<string>('RSD')

/** The formatters, in the panels' currency. Magnitudes: the sign is the panel's. */
function useMoney() {
  const currency = useContext(DebtCurrency)
  return {
    money: (n: number) => fmtMoney(Math.abs(n), currency, 0),
    money2: (n: number) => fmtMoney(Math.abs(n), currency, 2),
    short: (n: number) => shortMoney(n, currency),
  }
}

type Tab = 'due' | 'balance' | 'credits'
type Horizon = 12 | 24 | 0

const TABS: { id: Tab; label: string; hint: string }[] = [
  { id: 'due', label: 'Due by month', hint: 'What has to be paid, and how much of it only carries the debt' },
  { id: 'balance', label: 'Debt balance', hint: 'What is still owed at each month end — and where it falls away' },
  { id: 'credits', label: 'By credit', hint: 'Which line the money is owed on' },
]

export interface DebtPanelsProps {
  /** Outstanding annuity instalments, as the bank scheduled them. */
  annuity: DueInstalment[]
  /** Derived from the revolving tranches — never read back from what was generated. */
  revolving: DueInstalment[]
  opening: { annuity: number; revolving: number }
  credits: {
    creditId: string; name: string
    kind: 'annuity' | 'revolving'
    principal: number
    /** null when the line has no benchmark yet, and shown as such. */
    interest: number | null
  }[]
  /** How many revolving lines carry no rate, so the charts can say so. */
  unpriced: number
  /** The currency every figure above is in. RSD when not said. */
  currency?: string
  /** Which panel opens. Defaults to what falls due, which is the near question. */
  initialTab?: Tab
}

export default function DebtPanels(p: DebtPanelsProps) {
  const [tab, setTab] = useState<Tab>(p.initialTab || 'due')
  const [horizon, setHorizon] = useState<Horizon>(12)
  const [tip, setTip] = useState<Tip>(null)
  const [ref, w] = useWidth(900)

  const from = new Date().toISOString().slice(0, 7)

  /** How far out anything is owed — the honest length of an "All" window. */
  const span = useMemo(() => {
    const dates = [...p.annuity, ...p.revolving].map(i => i.due_date).filter(Boolean)
    if (dates.length === 0) return 0
    const last = dates.sort()[dates.length - 1].slice(0, 7)
    const [ly, lm] = last.split('-').map(Number)
    const [fy, fm] = from.split('-').map(Number)
    return Math.max((ly * 12 + lm) - (fy * 12 + fm) + 1, 1)
  }, [p.annuity, p.revolving, from])

  const months = horizon === 0 ? Math.min(Math.max(span, 1), 120) : horizon

  const due = useMemo(
    () => monthlyDue({ annuity: p.annuity, revolving: p.revolving, from, months }),
    [p.annuity, p.revolving, from, months])
  const balance = useMemo(() => balanceSeries(due, p.opening), [due, p.opening])
  const figures = useMemo(() => debtFigures(due, balance), [due, balance])
  const ranked = useMemo(() => byCredit(p.credits), [p.credits])

  const hasAnything = due.some(d => d.total > 0) || p.opening.annuity + p.opening.revolving > 0
  const active = TABS.find(t => t.id === tab)!

  return (
    <DebtCurrency.Provider value={p.currency || 'RSD'}>
    <div style={{ marginTop: '26px' }}>
      <Figures f={figures} balance={balance} unpriced={p.unpriced} span={span} />

      <div style={deck.wrap}>
        <div style={deck.head}>
          <div style={deck.tabs}>
            {TABS.map(t => (
              <button key={t.id} onClick={() => setTab(t.id)}
                style={{ ...deck.tab, ...(tab === t.id ? deck.tabOn : {}) }}>
                {t.label}
              </button>
            ))}
          </div>
          <div style={{ marginLeft: 'auto', display: 'flex', alignItems: 'center', gap: '12px', flexWrap: 'wrap' }}>
            {tab !== 'credits' && (
              <span style={deck.seg}>
                {([12, 24, 0] as Horizon[]).map(h => (
                  <button key={h} onClick={() => setHorizon(h)}
                    style={{ ...deck.segBtn, ...(horizon === h ? deck.segOn : {}) }}>
                    {h === 0 ? `All ${span > 0 ? `(${span}m)` : ''}` : `${h}m`}
                  </button>
                ))}
              </span>
            )}
            <span style={deck.hint}>{active.hint}</span>
          </div>
        </div>

        <div ref={ref} style={{ position: 'relative' }} onMouseLeave={() => setTip(null)}>
          {!hasAnything ? (
            <Empty h={260} text="Nothing is owed — no outstanding instalments and no revolving principal." />
          ) : tab === 'due' ? (
            <DueChart rows={due} w={w} onTip={setTip} />
          ) : tab === 'balance' ? (
            <BalanceChart points={balance} w={w} onTip={setTip} />
          ) : (
            <CreditsChart rows={ranked} w={w} onTip={setTip} />
          )}

          {tip && (
            <div style={{
              ...deck.tip,
              left: Math.min(Math.max(tip.x + 14, 8), Math.max(w - 240, 8)),
              top: Math.max(tip.y - 10, 6),
            }}>{tip.body}</div>
          )}
        </div>

        <div style={deck.legend}>
          {(tab === 'due'
            ? [['Principal', PRINCIPAL], ['Interest', INTEREST]]
            : [['Annuity', ANNUITY], ['Revolving', REVOLVING]]
          ).map(([label, colour]) => (
            <span key={label} style={deck.legendItem}>
              <i style={{ ...deck.swatch, background: colour }} />{label}
            </span>
          ))}
          {p.unpriced > 0 && (
            <span style={{ fontSize: '10.5px', color: '#F5A623' }}>
              {p.unpriced} revolving line{p.unpriced === 1 ? '' : 's'} carry no rate yet, so their interest is missing from these charts
            </span>
          )}
        </div>
      </div>
    </div>
    </DebtCurrency.Provider>
  )
}

// ── The figures that stay on screen ─────────────────────────────────────────

function Figures({ f, balance, unpriced, span }: {
  f: ReturnType<typeof debtFigures>
  balance: BalancePoint[]
  unpriced: number
  span: number
}) {
  const { money } = useMoney()
  const now = balance.length > 0 ? f.openingBalance : 0
  const cards = [
    {
      label: 'Owed now', value: money(now), accent: '#4EA8FF',
      sub: 'principal outstanding',
    },
    {
      label: 'Falls due in the window', value: money(f.total), accent: '#F5A623',
      sub: `${money(f.principal)} principal · ${money(f.interest)} interest`,
    },
    {
      label: 'Next 12 months', value: money(f.next12), accent: '#4EA8FF',
      sub: 'principal and interest together',
    },
    {
      label: 'Heaviest month',
      value: f.peak ? money(f.peak.amount) : '—',
      accent: f.peak && f.peak.amount > f.next12 / 6 ? '#FF5B5A' : '#00D47E',
      sub: f.peak ? monthLabel(f.peak.month, true) : 'nothing scheduled',
    },
    {
      label: 'Debt clear in',
      value: f.clearsIn ? `${f.clearsIn} mo` : '—',
      accent: '#00D47E',
      sub: f.clearsIn
        ? monthLabel(balance[f.clearsIn - 1].month, true)
        : span > 0 ? `not inside this window` : 'nothing owed',
    },
  ]

  return (
    <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(168px, 1fr))', gap: '10px', marginBottom: '14px' }}>
      {cards.map(c => (
        <div key={c.label} style={{ background: C.bg, border: `1px solid ${C.line}`, borderTop: `2.5px solid ${c.accent}`, borderRadius: '12px', padding: '14px 16px' }}>
          <div style={{ fontSize: '9.5px', color: 'rgba(255,255,255,0.28)', textTransform: 'uppercase', letterSpacing: '0.11em', marginBottom: '8px' }}>{c.label}</div>
          <div style={{ fontFamily: "'DM Mono','Fira Mono',monospace", fontSize: '21px', color: c.accent, lineHeight: 1 }}>{c.value}</div>
          <div style={{ fontSize: '10.5px', color: 'rgba(255,255,255,0.28)', marginTop: '7px' }}>{c.sub}</div>
        </div>
      ))}
      {unpriced > 0 && (
        <div style={{ gridColumn: '1 / -1', fontSize: '11px', color: '#F5A623' }}>
          Interest on {unpriced} revolving line{unpriced === 1 ? '' : 's'} is not in these figures — record the
          benchmark rate on the tranche to price it.
        </div>
      )}
    </div>
  )
}

// ── Due by month ────────────────────────────────────────────────────────────

function DueChart({ rows, w, onTip }: {
  rows: DueRow[]; w: number; onTip: (t: Tip) => void
}) {
  const { money2, short } = useMoney()
  const H = 290
  const PAD = { l: 58, r: 18, t: 16, b: 38 }
  const iw = Math.max(w - PAD.l - PAD.r, 10)
  const ih = Math.max(H - PAD.t - PAD.b, 10)
  const max = Math.max(...rows.map(r => r.total), 0)
  if (rows.length === 0 || max <= 0) return <Empty h={H} text="Nothing falls due in this window." />

  const top = niceMax(max)
  const ticks = axisTicks(max, 4)
  const band = iw / rows.length
  const barW = Math.min(band * 0.62, 46)
  const y = (v: number) => PAD.t + ih - (v / top) * ih
  const cx = (i: number) => PAD.l + band * i + band / 2
  const crossesYear = new Set(rows.map(r => r.month.slice(0, 4))).size > 1
  // A label on every column is unreadable past about eighteen of them.
  const every = rows.length > 30 ? 3 : rows.length > 18 ? 2 : 1

  return (
    <svg width="100%" height={H} style={{ display: 'block' }}>
      {ticks.map(t => (
        <g key={t}>
          <line x1={PAD.l} x2={w - PAD.r} y1={y(t)} y2={y(t)} stroke={C.grid} strokeWidth="1" />
          <text x={PAD.l - 9} y={y(t) + 3.5} textAnchor="end" fontSize="10" fill={C.faint}>
            {short(t)}
          </text>
        </g>
      ))}

      {rows.map((r, i) => {
        const yPrincipal = y(r.principal)
        const yTop = y(r.total)
        const tip = (ev: React.MouseEvent) => onTip({
          x: ev.nativeEvent.offsetX, y: ev.nativeEvent.offsetY,
          body: (
            <>
              <TipHead>{monthLabel(r.month, true)}</TipHead>
              <TipRow label="Principal" value={money2(r.principal)} />
              <TipRow label="Interest" value={money2(r.interest)} />
              <TipRow label="Total" value={money2(r.total)} />
              {r.revolvingPrincipal > 0 && (
                <TipRow label="of which revolving" value={money2(r.revolvingPrincipal)} dim />
              )}
              {r.total === 0 && <TipRow label="" value="nothing due" dim />}
            </>
          ),
        })

        return (
          <g key={r.month} onMouseMove={tip}>
            {/* The hit target is the whole column slot, so an empty month is
                still hoverable — "nothing due" is an answer somebody wants. */}
            <rect x={PAD.l + band * i} y={PAD.t} width={band} height={ih} fill="transparent" />
            {r.principal > 0 && (
              <rect x={cx(i) - barW / 2} y={yPrincipal} width={barW}
                height={Math.max(PAD.t + ih - yPrincipal, 1)} rx="2.5" fill={PRINCIPAL} opacity="0.92" />
            )}
            {r.interest > 0 && (
              <rect x={cx(i) - barW / 2} y={yTop} width={barW}
                height={Math.max(yPrincipal - yTop - 1.5, 1)} rx="2.5" fill={INTEREST} opacity="0.92" />
            )}
            {i % every === 0 && (
              <text x={cx(i)} y={H - 14} textAnchor="middle" fontSize="10" fill={C.dim}>
                {monthLabel(r.month, crossesYear)}
              </text>
            )}
          </g>
        )
      })}
    </svg>
  )
}

// ── Debt balance ────────────────────────────────────────────────────────────

function BalanceChart({ points, w, onTip }: {
  points: BalancePoint[]; w: number; onTip: (t: Tip) => void
}) {
  const { money2, short } = useMoney()
  const H = 290
  const PAD = { l: 58, r: 18, t: 16, b: 38 }
  const iw = Math.max(w - PAD.l - PAD.r, 10)
  const ih = Math.max(H - PAD.t - PAD.b, 10)
  const max = Math.max(...points.map(p => p.total), 0)
  if (points.length === 0 || max <= 0) return <Empty h={H} text="No principal outstanding." />

  const top = niceMax(max)
  const ticks = axisTicks(max, 4)
  const n = points.length
  const x = (i: number) => n === 1 ? PAD.l + iw / 2 : PAD.l + (i / (n - 1)) * iw
  const y = (v: number) => PAD.t + ih - (v / top) * ih
  const crossesYear = new Set(points.map(p => p.month.slice(0, 4))).size > 1
  const every = n > 30 ? 3 : n > 18 ? 2 : 1

  /** A filled band between two running heights. */
  const band = (lower: (p: BalancePoint) => number, upper: (p: BalancePoint) => number) => {
    const up = points.map((p, i) => `${i === 0 ? 'M' : 'L'}${x(i).toFixed(1)},${y(upper(p)).toFixed(1)}`)
    const down = [...points].reverse().map((p, i) =>
      `L${x(n - 1 - i).toFixed(1)},${y(lower(p)).toFixed(1)}`)
    return `${up.join(' ')} ${down.join(' ')} Z`
  }

  const line = (of: (p: BalancePoint) => number) =>
    points.map((p, i) => `${i === 0 ? 'M' : 'L'}${x(i).toFixed(1)},${y(of(p)).toFixed(1)}`).join(' ')

  return (
    <svg width="100%" height={H} style={{ display: 'block' }}>
      {ticks.map(t => (
        <g key={t}>
          <line x1={PAD.l} x2={w - PAD.r} y1={y(t)} y2={y(t)} stroke={C.grid} strokeWidth="1" />
          <text x={PAD.l - 9} y={y(t) + 3.5} textAnchor="end" fontSize="10" fill={C.faint}>
            {short(t)}
          </text>
        </g>
      ))}

      {/* Annuity along the bottom, revolving stacked on it: the cliff reads as
          a cliff rather than as a band that happens to end. */}
      <path d={band(() => 0, p => p.annuity)} fill={ANNUITY} opacity="0.30" />
      <path d={band(p => p.annuity, p => p.total)} fill={REVOLVING} opacity="0.30" />
      <path d={line(p => p.annuity)} fill="none" stroke={ANNUITY} strokeWidth="2" strokeLinejoin="round" />
      <path d={line(p => p.total)} fill="none" stroke={REVOLVING} strokeWidth="2" strokeLinejoin="round" />

      {points.map((p, i) => (
        <g key={p.month}>
          <rect x={x(i) - iw / n / 2} y={PAD.t} width={Math.max(iw / n, 6)} height={ih} fill="transparent"
            onMouseMove={ev => onTip({
              x: ev.nativeEvent.offsetX, y: ev.nativeEvent.offsetY,
              body: (
                <>
                  <TipHead>{monthLabel(p.month, true)}</TipHead>
                  <TipRow label="Annuity" value={money2(p.annuity)} />
                  <TipRow label="Revolving" value={money2(p.revolving)} />
                  <TipRow label="Owed" value={money2(p.total)} />
                  {i > 0 && (
                    <TipRow label="repaid this month"
                      value={money2(points[i - 1].total - p.total)} dim />
                  )}
                </>
              ),
            })} />
          {i % every === 0 && (
            <text x={x(i)} y={H - 14} textAnchor="middle" fontSize="10" fill={C.dim}>
              {monthLabel(p.month, crossesYear)}
            </text>
          )}
        </g>
      ))}
    </svg>
  )
}

// ── By credit ───────────────────────────────────────────────────────────────

function CreditsChart({ rows, w, onTip }: {
  rows: ReturnType<typeof byCredit>; w: number; onTip: (t: Tip) => void
}) {
  const { money, money2 } = useMoney()
  if (rows.length === 0) return <Empty h={240} text="No credits to compare." />

  const ROW = 34
  const BAR = 16
  const labelW = Math.min(Math.max(w * 0.28, 130), 260)
  const PAD = { l: 4, r: 96, t: 10, b: 14 }
  const plotW = Math.max(w - labelW - PAD.l - PAD.r, 60)
  const H = PAD.t + rows.length * ROW + PAD.b
  const max = niceMax(Math.max(...rows.map(r => r.total), 1))
  const chars = Math.floor(labelW / 6.6)

  return (
    <svg width="100%" height={H} style={{ display: 'block' }}>
      {rows.map((r, i) => {
        const yTop = PAD.t + i * ROW + (ROW - BAR) / 2
        const pw = (r.principal / max) * plotW
        const iw2 = ((r.interest ?? 0) / max) * plotW
        const x0 = PAD.l + labelW
        const colour = r.kind === 'revolving' ? REVOLVING : ANNUITY

        return (
          <g key={r.creditId} style={{ cursor: 'default' }}
            onMouseMove={ev => onTip({
              x: ev.nativeEvent.offsetX, y: ev.nativeEvent.offsetY,
              body: (
                <>
                  <TipHead>{r.name}</TipHead>
                  <TipRow label="" value={r.kind === 'revolving' ? 'Revolving' : 'Annuity'} dim />
                  <TipRow label="Principal" value={money2(r.principal)} />
                  <TipRow label="Interest"
                    value={r.interest === null ? 'not priced yet' : money2(r.interest)}
                    dim={r.interest === null} />
                  <TipRow label="Still owed"
                    value={r.interest === null ? `${money2(r.total)} +` : money2(r.total)} />
                </>
              ),
            })}>
            <rect x={PAD.l} y={PAD.t + i * ROW} width={Math.max(w - PAD.l - 4, 10)} height={ROW} fill="transparent" />

            <text x={PAD.l + 2} y={PAD.t + i * ROW + ROW / 2 + 1} fontSize="11.5" fill={C.text}>
              {r.name.length <= chars ? r.name : r.name.slice(0, chars - 1) + '…'}
            </text>
            <text x={PAD.l + 2} y={PAD.t + i * ROW + ROW / 2 + 12} fontSize="9" fill={C.faint}>
              {r.kind === 'revolving' ? 'revolving' : 'annuity'}
            </text>

            <rect x={x0} y={yTop} width={Math.max(pw, 2)} height={BAR} rx="3" fill={colour} opacity="0.92" />
            {iw2 > 0 && (
              <rect x={x0 + pw + 1.5} y={yTop} width={Math.max(iw2, 1)} height={BAR} rx="3"
                fill={colour} opacity="0.38" />
            )}

            <text x={x0 + pw + iw2 + 8} y={yTop + BAR - 3.5} fontSize="10.5"
              fill={C.text} fontFamily="'DM Mono', monospace">
              {money(r.total)}{r.interest === null ? ' +' : ''}
            </text>
          </g>
        )
      })}
    </svg>
  )
}
