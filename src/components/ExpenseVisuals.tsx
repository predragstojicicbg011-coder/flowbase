import React, { useState, useMemo, useEffect } from 'react'
import {
  TreeNode, ComparedNode,
  Branch, isAllocated, SOCIAL_GROWTH, AIMFOX, OPEX, PERFORMANCE,
} from '../services/expenseTree'
import {
  C, deck, useWidth, colorFor, MUTED, Empty, TipHead, TipRow, type Tip,
} from './chartChrome'
import {
  monthlySeries, bridgeSteps, paretoSeries, branchRoots,
  axisTicks, niceMax, bridgeScale, shortMoney, monthLabel,
} from '../services/expenseCharts'
import { MoversChart, HeatChart, HeatLegend, FacingChart, SIDE_LEFT, SIDE_RIGHT } from './SpendPanels'
import ExpenseBranches, { type ExpenseBranchNode } from './ExpenseBranches'

// ── Expense visuals ─────────────────────────────────────────────────────────
//
// Four charts sharing one frame, because four questions share one screen:
//
//   Trend & mix    is the shape of spend changing, or only its size
//   Bridge         which lines caused the change, and by how much
//   Composition    where the money sits, two levels deep
//   Concentration  how few lines are worth arguing about
//
// One chart is shown at a time on purpose. Four small charts side by side are
// four charts nobody can read; one chart with real axes, gridlines and hover
// detail is a chart somebody can defend in a meeting. The strip of key figures
// above stays constant so the context never leaves the screen.
//
// All SVG by hand — no chart library. It is a few hundred lines, and it buys
// exact control over a dark palette, hit targets that drill into the tree, and
// no 300 kB dependency in a bundle that already ships React.

const money = (n: number, dp = 0) =>
  (n < 0 ? '-$' : '$') + Math.abs(n).toLocaleString('en-US', { minimumFractionDigits: dp, maximumFractionDigits: dp })

// ── Key figures ─────────────────────────────────────────────────────────────

interface KeyFigureProps {
  total: number
  priorTotal: number
  adjusted: number
  excluded: number
  unassigned: number
  reconciled: boolean
  months: string[]
  monthlyTotals: number[]
  paretoCutoff: number
  paretoShare: number
  leafCount: number
  periodLabel: string
  priorLabel: string
}

export function KeyFigures(p: KeyFigureProps) {
  const change = p.total - p.priorTotal
  const changePct = p.priorTotal > 0 ? (change / p.priorTotal) * 100 : null
  const active = p.monthlyTotals.filter(v => v > 0)
  const runRate = active.length > 0 ? active.reduce((s, v) => s + v, 0) / active.length : 0
  const unassignedPct = p.total > 0 ? (p.unassigned / p.total) * 100 : 0

  return (
    <div style={kf.grid}>
      {/* Headline. The number, its movement, and the shape of the months that
          produced it — a total alone says nothing about whether it is stable. */}
      <div style={{ ...kf.card, gridColumn: 'span 2' }}>
        <div style={kf.label}>Total expenses · {p.periodLabel}</div>
        <div style={kf.hero}>{money(p.total)}</div>
        <div style={{ display: 'flex', alignItems: 'center', gap: '8px', marginTop: '6px' }}>
          <span style={{ ...kf.chip, background: change > 0 ? 'rgba(255,91,90,0.13)' : 'rgba(0,212,126,0.13)', color: change > 0 ? C.up : C.down }}>
            {change > 0 ? '▲' : change < 0 ? '▼' : '■'} {money(Math.abs(change))}
            {changePct !== null && ` · ${Math.abs(changePct).toFixed(1)}%`}
          </span>
          <span style={{ fontSize: '11px', color: C.dim }}>vs {p.priorLabel}</span>
        </div>
        {p.excluded > 0 && (
          <div style={{ fontSize: '11px', color: '#F5A623', marginTop: '7px' }}>
            {money(p.excluded)} excluded · adjusted <strong style={{ color: C.text }}>{money(p.adjusted)}</strong>
          </div>
        )}
        <Sparkline values={p.monthlyTotals} months={p.months} />
      </div>

      <div style={kf.card}>
        <div style={kf.label}>Run rate</div>
        <div style={kf.value}>{money(runRate)}</div>
        <div style={kf.sub}>average of {active.length} active month{active.length === 1 ? '' : 's'}</div>
        {active.length > 1 && (
          <div style={kf.sub}>
            range {money(Math.min(...active))} – {money(Math.max(...active))}
          </div>
        )}
      </div>

      <div style={kf.card}>
        <div style={kf.label}>Concentration</div>
        <div style={kf.value}>{p.paretoCutoff}<span style={{ fontSize: '13px', color: C.dim, fontWeight: 400 }}> of {p.leafCount}</span></div>
        <div style={kf.sub}>lines make {p.paretoShare.toFixed(0)}% of spend</div>
        <div style={{ marginTop: '8px', height: '5px', background: 'rgba(255,255,255,0.06)', borderRadius: '3px', overflow: 'hidden' }}>
          <div style={{
            width: `${p.leafCount > 0 ? Math.max((p.paretoCutoff / p.leafCount) * 100, 1.5) : 0}%`,
            height: '100%', background: C.accent,
          }} />
        </div>
      </div>

      {/* Not decoration: this is the share of spend that cannot be put in front
          of an owner, which is the one number that blocks accountability. */}
      <div style={kf.card}>
        <div style={kf.label}>Unclassified</div>
        <div style={{ display: 'flex', alignItems: 'center', gap: '12px', marginTop: '2px' }}>
          <Ring pct={unassignedPct} />
          <div style={{ minWidth: 0 }}>
            <div style={{ ...kf.value, fontSize: '19px' }}>{money(p.unassigned)}</div>
            <div style={kf.sub}>no department</div>
          </div>
        </div>
        <div style={{ ...kf.sub, marginTop: '7px', color: p.reconciled ? C.down : C.up }}>
          {p.reconciled ? '✓ both branches reconcile' : '⚠ branches disagree — check'}
        </div>
      </div>
    </div>
  )
}

function Ring({ pct }: { pct: number }) {
  const r = 20, circ = 2 * Math.PI * r
  const on = Math.min(Math.max(pct, 0), 100) / 100 * circ
  return (
    <svg width="48" height="48" viewBox="0 0 48 48" style={{ flexShrink: 0 }}>
      <circle cx="24" cy="24" r={r} fill="none" stroke="rgba(255,255,255,0.08)" strokeWidth="5" />
      <circle cx="24" cy="24" r={r} fill="none" stroke={pct > 5 ? '#F5A623' : C.down} strokeWidth="5"
        strokeDasharray={`${on} ${circ}`} strokeLinecap="round" transform="rotate(-90 24 24)" />
      <text x="24" y="28" textAnchor="middle" fontSize="11.5" fontWeight="600" fill={C.text}>
        {pct.toFixed(0)}%
      </text>
    </svg>
  )
}

function Sparkline({ values, months }: { values: number[]; months: string[] }) {
  const [ref, w] = useWidth(320)
  const h = 34
  if (values.length < 2) return <div ref={ref} style={{ height: h, marginTop: '10px' }} />
  const max = Math.max(...values, 1)
  const x = (i: number) => (i / (values.length - 1)) * (w - 2) + 1
  const y = (v: number) => h - 3 - (v / max) * (h - 8)
  const line = values.map((v, i) => `${i === 0 ? 'M' : 'L'}${x(i).toFixed(1)},${y(v).toFixed(1)}`).join(' ')
  const area = `${line} L${x(values.length - 1).toFixed(1)},${h} L${x(0).toFixed(1)},${h} Z`
  const last = values.length - 1
  return (
    <div ref={ref} style={{ marginTop: '10px' }}>
      <svg width="100%" height={h} style={{ display: 'block', overflow: 'visible' }}>
        <defs>
          <linearGradient id="sparkFill" x1="0" y1="0" x2="0" y2="1">
            <stop offset="0%" stopColor={C.accent} stopOpacity="0.28" />
            <stop offset="100%" stopColor={C.accent} stopOpacity="0" />
          </linearGradient>
        </defs>
        <path d={area} fill="url(#sparkFill)" />
        <path d={line} fill="none" stroke={C.accent} strokeWidth="1.6" strokeLinejoin="round" />
        <circle cx={x(last)} cy={y(values[last])} r="2.8" fill={C.accent} />
      </svg>
      <div style={{ display: 'flex', justifyContent: 'space-between', fontSize: '9.5px', color: C.faint, marginTop: '2px' }}>
        <span>{months[0] ? monthLabel(months[0], true) : ''}</span>
        <span>{months[last] ? monthLabel(months[last], true) : ''}</span>
      </div>
    </div>
  )
}

// ── Chart deck ──────────────────────────────────────────────────────────────
//
// SEVEN panels, and which seven depends on the tab that is open. That is the
// point: a branch with two roots and a branch with forty leaves are not asking
// the same question, and offering both the same four charts was how the deck
// managed to be busy and uninformative at once.
//
//   trend          how the shape of the month moves
//   split          ONLY on an allocated tab — which costs lean which way
//   movers         which lines moved, ranked, direction kept
//   heatmap        every line, every month, at once
//   bridge         what turned the prior total into this one
//   composition    the period branching down to the lines themselves
//   concentration  how few lines carry most of it
//
// The hints are written per branch too. "Monthly composition" says nothing on
// a tab whose two bands are Social Growth and Aimfox; there the question is
// whether the split is drifting, and the label now says so.

export type ChartTab =
  'trend' | 'split' | 'movers' | 'heatmap' | 'bridge' | 'composition' | 'concentration'

/** The two roots of an allocated branch, left then right. */
export function sidesOf(branch: Branch): [string, string] {
  return branch === 'stream' ? [SOCIAL_GROWTH, AIMFOX] : [OPEX, PERFORMANCE]
}

function tabsFor(branch: Branch): { key: ChartTab; label: string; hint: string }[] {
  const allocated = isAllocated(branch)
  const [left, right] = sidesOf(branch)

  const out: { key: ChartTab; label: string; hint: string }[] = [{
    key: 'trend',
    label: 'Trend & mix',
    hint: allocated
      ? `Month by month — is the ${left} / ${right} split drifting, or only the size`
      : 'Monthly composition — is the shape changing, or only the size',
  }]

  if (allocated) {
    out.push({
      key: 'split', label: 'The split',
      hint: `Which costs lean ${left} and which lean ${right}`,
    })
  }

  out.push(
    { key: 'movers', label: 'What moved', hint: 'The lines behind the change, biggest movement first' },
    { key: 'heatmap', label: 'Every line', hint: 'All of them, month by month — spikes, seasons and lines that stopped' },
    { key: 'bridge', label: 'Bridge', hint: 'What turned the prior total into this one' },
    { key: 'composition', label: 'Composition', hint: 'The period branching into categories, into lines — each branch as thick as the money it carries' },
    { key: 'concentration', label: 'Concentration', hint: 'How few lines carry most of the spend' },
  )
  return out
}

/**
 * What each level of a branch is actually called.
 *
 * The depth picker used to offer "Detail" as a third option on every branch
 * that had one, which on the stream branch meant a sub-category wearing a
 * label that said nothing. A level picker whose buttons do not name the
 * levels is a level picker you have to click to understand.
 */
function levelNames(branch: Branch): string[] {
  switch (branch) {
    case 'pl': return ['Category', 'Sub-category']
    case 'department': return ['Department', 'Sub-category', 'Description']
    case 'stream': return ['Stream', 'Category', 'Sub-category']
    default: return ['Cost type', 'Category', 'Sub-category']
  }
}

interface DeckProps {
  branch: Branch
  tree: TreeNode[]
  compared: ComparedNode[]
  months: string[]
  hidden: Set<string>
  selected: string | null
  onSelect: (key: string | null) => void
  priorLabel: string
  periodLabel: string
  initialTab?: ChartTab
}

export function ChartDeck(p: DeckProps) {
  const [tab, setTab] = useState<ChartTab>(p.initialTab || 'trend')
  const [normalized, setNormalized] = useState(false)
  const [depth, setDepth] = useState(1)
  const [byRow, setByRow] = useState(false)
  const [muted, setMuted] = useState<string | null>(null)
  const [tip, setTip] = useState<Tip>(null)
  const [ref, w] = useWidth(900)

  const [leftLabel, rightLabel] = sidesOf(p.branch)
  const tabs = useMemo(() => tabsFor(p.branch), [p.branch])

  // A tab that does not exist on the branch just selected must not leave the
  // deck blank. Switching from the stream tab with The split open used to do
  // exactly that — an empty panel and no way to tell what had happened.
  const tab_ = tabs.some(t => t.key === tab) ? tab : 'trend'
  useEffect(() => { if (tab_ !== tab) setTab(tab_) }, [tab_, tab])

  const visible = useMemo(() => p.tree.filter(n => !p.hidden.has(n.key)), [p.tree, p.hidden])
  const comparedVisible = useMemo(
    () => p.compared.filter(n => !p.hidden.has(n.key)), [p.compared, p.hidden])
  const series = useMemo(() => monthlySeries(visible, p.months, 6), [visible, p.months])
  const bridge = useMemo(() => bridgeSteps(comparedVisible, 6), [comparedVisible])
  const pareto = useMemo(() => paretoSeries(visible, 12), [visible])

  // The nested treemap that was here compared AREAS, and area is a quantity
  // the eye reads badly below about a fiftieth of the canvas — which on a real
  // October is most of the lines. The branch tree reads the same nesting as
  // thickness, which the eye does follow, and carries one thing the treemap
  // could not: whether a cost moves month to month.
  const branches = useMemo(
    () => branchRoots(visible, p.months) as ExpenseBranchNode[],
    [visible, p.months])

  const H = 300
  const active = tabs.find(t => t.key === tab_)!
  const levels = levelNames(p.branch)

  // A branch the user just switched to may be shallower than the level that
  // was open. Clamping here rather than resetting keeps the choice where it
  // can be kept and does not silently draw an empty panel where it cannot.
  const depth_ = Math.min(depth, levels.length - 1)

  const depthPicker = (
    <span style={deck.seg}>
      {levels.map((label, d) => (
        <button key={label} onClick={() => setDepth(d)}
          style={{ ...deck.segBtn, ...(depth_ === d ? deck.segOn : {}) }}>
          {label}
        </button>
      ))}
    </span>
  )

  return (
    <div style={deck.wrap}>
      <div style={deck.head}>
        <div style={deck.tabs}>
          {tabs.map(t => (
            <button key={t.key} onClick={() => setTab(t.key)}
              style={{ ...deck.tab, ...(tab_ === t.key ? deck.tabOn : {}) }}>
              {t.label}
            </button>
          ))}
        </div>
        <div style={{ marginLeft: 'auto', display: 'flex', alignItems: 'center', gap: '12px', flexWrap: 'wrap' }}>
          {tab_ === 'trend' && (
            <label style={deck.switch}>
              <input type="checkbox" checked={normalized} onChange={ev => setNormalized(ev.target.checked)}
                style={{ accentColor: C.accent, cursor: 'pointer' }} />
              Show as % of month
            </label>
          )}
          {(tab_ === 'movers' || tab_ === 'heatmap') && depthPicker}
          {tab_ === 'heatmap' && (
            <label style={deck.switch}>
              <input type="checkbox" checked={byRow} onChange={ev => setByRow(ev.target.checked)}
                style={{ accentColor: C.accent, cursor: 'pointer' }} />
              Scale each line to itself
            </label>
          )}
          <span style={deck.hint}>{active.hint}</span>
        </div>
      </div>

      <div ref={ref} style={{ position: 'relative' }} onMouseLeave={() => setTip(null)}>
        {tab_ === 'trend' && <TrendChart series={series} w={w} h={H} normalized={normalized} onTip={setTip} onSelect={p.onSelect} tree={visible} muted={muted} />}
        {tab_ === 'split' && <FacingChart tree={visible} leftLabel={leftLabel} rightLabel={rightLabel} limit={12} w={w} onTip={setTip} onSelect={p.onSelect} />}
        {tab_ === 'movers' && <MoversChart compared={comparedVisible} depth={depth_} limit={12} w={w} onTip={setTip} onSelect={p.onSelect} priorLabel={p.priorLabel} periodLabel={p.periodLabel} />}
        {tab_ === 'heatmap' && <HeatChart tree={visible} months={p.months} depth={depth_} limit={14} byRow={byRow} w={w} onTip={setTip} onSelect={p.onSelect} selected={p.selected} />}
        {tab_ === 'bridge' && <BridgeChart steps={bridge} w={w} h={H} onTip={setTip} onSelect={p.onSelect} priorLabel={p.priorLabel} periodLabel={p.periodLabel} />}
        {tab_ === 'composition' && (
          <ExpenseBranches
            bare start="folded"
            monthLabel={p.periodLabel}
            amountLabel={p.periodLabel}
            emptyText="No spend in this period."
            roots={branches}
            onOpenLedger={key => p.onSelect(key)} />
        )}
        {tab_ === 'concentration' && <ParetoChart points={pareto} w={w} h={H} onTip={setTip} onSelect={p.onSelect} />}

        {tip && (
          <div style={{
            ...deck.tip,
            left: Math.min(Math.max(tip.x + 14, 8), Math.max(w - 236, 8)),
            top: Math.max(tip.y - 10, 6),
          }}>
            {tip.body}
          </div>
        )}
      </div>

      {/* The legend is a control, not a caption: hovering an entry dims the
          rest of the stack so one band can be followed across nine months,
          and clicking it opens that line's transactions. A legend you can
          only read is a legend doing a third of its job. */}
      {tab_ === 'trend' && (
        <div style={deck.legend}>
          {series.keys.map((k, i) => {
            const node = visible.find(t => t.label === k)
            return (
              <button key={k} style={{
                ...deck.legendItem, ...deck.legendBtn,
                opacity: muted && muted !== k ? 0.4 : 1,
              }}
                onMouseEnter={() => setMuted(k)}
                onMouseLeave={() => setMuted(null)}
                onClick={() => node && p.onSelect(node.key)}
                title={node ? `Open the transactions behind ${k}` : k}>
                <i style={{ ...deck.swatch, background: colorFor(k, i) }} />{k}
              </button>
            )
          })}
        </div>
      )}

      {tab_ === 'heatmap' && (
        <div style={deck.legend}>
          <HeatLegend tree={visible} months={p.months} depth={depth_} limit={14} byRow={byRow} />
        </div>
      )}

      {tab_ === 'split' && (
        <div style={deck.legend}>
          <span style={deck.legendItem}><i style={{ ...deck.swatch, background: SIDE_LEFT }} />{leftLabel}</span>
          <span style={deck.legendItem}><i style={{ ...deck.swatch, background: SIDE_RIGHT }} />{rightLabel}</span>
          <span style={{ fontSize: '10.5px', color: C.faint }}>
            A transaction split by value appears on both sides, at part of its worth each.
          </span>
        </div>
      )}
    </div>
  )
}

// ── Trend & mix ─────────────────────────────────────────────────────────────

function TrendChart({ series, w, h, normalized, onTip, onSelect, tree, muted }: {
  series: ReturnType<typeof monthlySeries>
  w: number; h: number; normalized: boolean
  onTip: (t: Tip) => void
  onSelect: (k: string | null) => void
  tree: TreeNode[]
  /** A legend entry under the cursor. Everything else recedes. */
  muted: string | null
}) {
  const PAD = { l: 58, r: 20, t: 16, b: 34 }
  const iw = Math.max(w - PAD.l - PAD.r, 10)
  const ih = Math.max(h - PAD.t - PAD.b, 10)
  const n = series.points.length
  if (n === 0 || series.max <= 0) return <Empty h={h} text="No spend in this period." />

  const top = normalized ? 100 : niceMax(series.max)
  const ticks = normalized ? [0, 25, 50, 75, 100] : axisTicks(series.max, 4)
  const band = iw / n
  const barW = Math.min(band * 0.64, 58)
  const y = (v: number) => PAD.t + ih - (v / top) * ih
  const cx = (i: number) => PAD.l + band * i + band / 2
  const crossesYear = new Set(series.points.map(pt => pt.month.slice(0, 4))).size > 1
  const keyOf = (label: string) => tree.find(t => t.label === label)?.key || null

  const totalLine = series.points
    .map((pt, i) => `${i === 0 ? 'M' : 'L'}${cx(i).toFixed(1)},${y(normalized ? 100 : pt.total).toFixed(1)}`)
    .join(' ')

  return (
    <svg width="100%" height={h} style={{ display: 'block' }}>
      {ticks.map(t => (
        <g key={t}>
          <line x1={PAD.l} x2={w - PAD.r} y1={y(t)} y2={y(t)} stroke={C.grid} strokeWidth="1" />
          <text x={PAD.l - 9} y={y(t) + 3.5} textAnchor="end" fontSize="10" fill={C.faint}>
            {normalized ? `${t}%` : shortMoney(t)}
          </text>
        </g>
      ))}

      {series.points.map((pt, i) => {
        const scale = normalized ? (pt.total > 0 ? 100 / pt.total : 0) : 1
        let acc = 0
        return (
          <g key={pt.month}>
            {series.keys.map((k, ki) => {
              const v = (pt.values[k] || 0) * scale
              if (v <= 0) return null
              const y0 = y(acc), y1 = y(acc + v)
              acc += v
              return (
                <rect key={k}
                  x={cx(i) - barW / 2} y={y1} width={barW} height={Math.max(y0 - y1, 0.6)}
                  fill={colorFor(k, ki)} opacity={muted && muted !== k ? 0.16 : 0.88}
                  style={{ cursor: 'pointer', transition: 'opacity 120ms ease' }}
                  onClick={() => onSelect(keyOf(k))}
                  onMouseMove={ev => onTip({
                    x: ev.nativeEvent.offsetX, y: ev.nativeEvent.offsetY,
                    body: (
                      <>
                        <TipHead>{k}</TipHead>
                        <TipRow label={monthLabel(pt.month, true)} value={money(pt.values[k] || 0)} />
                        <TipRow label="share of month" value={`${pt.total > 0 ? ((pt.values[k] || 0) / pt.total * 100).toFixed(1) : '0'}%`} dim />
                      </>
                    ),
                  })} />
              )
            })}
            <text x={cx(i)} y={h - 12} textAnchor="middle" fontSize="10.5" fill={C.dim}>
              {monthLabel(pt.month, crossesYear)}
            </text>
          </g>
        )
      })}

      {/* The total is what the room asks about; the stack alone makes you add
          eight bands in your head to find it. */}
      {!normalized && n > 1 && (
        <>
          <path d={totalLine} fill="none" stroke={C.text} strokeWidth="1.5" opacity="0.55"
            strokeDasharray="4 3" strokeLinejoin="round" />
          {series.points.map((pt, i) => (
            <circle key={pt.month} cx={cx(i)} cy={y(pt.total)} r="3" fill={C.bgDeep} stroke={C.text} strokeWidth="1.3" opacity="0.8" />
          ))}
        </>
      )}
    </svg>
  )
}

// ── Bridge ──────────────────────────────────────────────────────────────────

function BridgeChart({ steps, w, h, onTip, onSelect, priorLabel, periodLabel }: {
  steps: ReturnType<typeof bridgeSteps>
  w: number; h: number
  onTip: (t: Tip) => void
  onSelect: (k: string | null) => void
  priorLabel: string; periodLabel: string
}) {
  const PAD = { l: 58, r: 20, t: 30, b: 46 }
  const iw = Math.max(w - PAD.l - PAD.r, 10)
  const ih = Math.max(h - PAD.t - PAD.b, 10)
  const n = steps.length
  if (n < 2) return <Empty h={h} text="Nothing to bridge — no prior period to compare with." />

  // Anchors sit on the axis floor; only the walk itself has to be in range.
  const walk = steps.filter(st => st.kind !== 'start' && st.kind !== 'end')
  const lo = Math.min(steps[0].end, steps[n - 1].end, ...walk.map(st => st.start))
  const hi = Math.max(steps[0].end, steps[n - 1].end, ...walk.map(st => st.end))
  const scale = bridgeScale(lo, hi, 4)
  const band = iw / n
  const barW = Math.min(band * 0.56, 62)
  const y = (v: number) =>
    PAD.t + ih - ((Math.max(v, scale.floor) - scale.floor) / (scale.top - scale.floor)) * ih
  const cx = (i: number) => PAD.l + band * i + band / 2
  const maxLabel = Math.max(Math.floor(band / 6.6), 6)

  const fill = (kind: string) =>
    kind === 'start' || kind === 'end' ? '#4EA8FF'
      : kind === 'up' ? C.up
        : kind === 'down' ? C.down : MUTED

  return (
    <svg width="100%" height={h} style={{ display: 'block' }}>
      {scale.ticks.map(t => (
        <g key={t}>
          <line x1={PAD.l} x2={w - PAD.r} y1={y(t)} y2={y(t)} stroke={C.grid} strokeWidth="1" />
          <text x={PAD.l - 9} y={y(t) + 3.5} textAnchor="end" fontSize="10" fill={C.faint}>{shortMoney(t)}</text>
        </g>
      ))}
      {/* Say it out loud when the axis does not start at zero. */}
      {scale.zoomed && (
        <text x={PAD.l - 9} y={PAD.t + ih + 13} textAnchor="end" fontSize="9" fill="#F5A623" opacity="0.8">
          ⌁ axis starts at {shortMoney(scale.floor)}
        </text>
      )}

      {steps.map((st, i) => {
        const y0 = y(st.end), y1 = y(st.start)
        const anchor = st.kind === 'start' || st.kind === 'end'
        // Where the walk stands after this step — the connector starts here.
        const after = anchor ? st.end : (st.delta > 0 ? st.end : st.start)
        const label = clip(st.label, maxLabel * 6.6, 6.6)
        return (
          <g key={`${st.label}-${i}`}>
            {i < n - 1 && (
              <line x1={cx(i) + barW / 2} x2={cx(i + 1) - barW / 2} y1={y(after)} y2={y(after)}
                stroke={C.faint} strokeWidth="1" strokeDasharray="3 3" />
            )}
            <rect
              x={cx(i) - barW / 2} y={y0} width={barW} height={Math.max(y1 - y0, 2)}
              rx="2" fill={fill(st.kind)} opacity={anchor ? 0.9 : 0.8}
              style={{ cursor: st.key ? 'pointer' : 'default' }}
              onClick={() => st.key && onSelect(st.key)}
              onMouseMove={ev => onTip({
                x: ev.nativeEvent.offsetX, y: ev.nativeEvent.offsetY,
                body: anchor ? (
                  <>
                    <TipHead>{st.label === 'Prior' ? priorLabel : periodLabel}</TipHead>
                    <TipRow label="total" value={money(st.end)} />
                  </>
                ) : (
                  <>
                    <TipHead>{st.label}</TipHead>
                    <TipRow label={st.delta > 0 ? 'increase' : 'decrease'} value={money(st.delta)} />
                    <TipRow label="running total" value={money(after)} dim />
                    {st.key && <TipRow label="" value="click to drill in" dim />}
                  </>
                ),
              })} />
            {/* A truncated axis makes the two anchors look further apart than
                they are. The break glyph is the conventional way to say so on
                the bar itself, not only in a footnote. */}
            {anchor && scale.zoomed && (
              <path
                d={`M${cx(i) - barW / 2},${PAD.t + ih - 7} l${barW / 4},-5 l${barW / 4},10 l${barW / 4},-10 l${barW / 4},5`}
                fill="none" stroke={C.bgDeep} strokeWidth="4.5" strokeLinejoin="round" />
            )}
            <text x={cx(i)} y={y0 - 7} textAnchor="middle" fontSize="10" fontWeight="600"
              fill={anchor ? C.text : fill(st.kind)}>
              {anchor ? shortMoney(st.end) : `${st.delta > 0 ? '+' : ''}${shortMoney(st.delta)}`}
            </text>
            <text x={cx(i)} y={h - 26} textAnchor="middle" fontSize="10" fill={C.dim}>{label}</text>
            {anchor && (
              <text x={cx(i)} y={h - 13} textAnchor="middle" fontSize="9" fill={C.faint}>
                {st.label === 'Prior' ? priorLabel : periodLabel}
              </text>
            )}
          </g>
        )
      })}
    </svg>
  )
}

const clip = (s: string, px: number, perChar: number) => {
  const max = Math.floor(px / perChar)
  return s.length > max ? s.slice(0, Math.max(max - 1, 1)) + '…' : s
}

// ── Concentration (Pareto) ──────────────────────────────────────────────────

function ParetoChart({ points, w, h, onTip, onSelect }: {
  points: ReturnType<typeof paretoSeries>
  w: number; h: number
  onTip: (t: Tip) => void
  onSelect: (k: string | null) => void
}) {
  const PAD = { l: 58, r: 46, t: 18, b: 62 }
  const iw = Math.max(w - PAD.l - PAD.r, 10)
  const ih = Math.max(h - PAD.t - PAD.b, 10)
  const n = points.length
  if (n === 0) return <Empty h={h} text="No spend in this period." />

  const peak = points[0].amount
  const top = niceMax(peak)
  const band = iw / n
  const barW = Math.min(band * 0.62, 40)
  const y = (v: number) => PAD.t + ih - (v / top) * ih
  const yPct = (v: number) => PAD.t + ih - (v / 100) * ih
  const cx = (i: number) => PAD.l + band * i + band / 2

  const curve = points.map((p, i) => `${i === 0 ? 'M' : 'L'}${cx(i).toFixed(1)},${yPct(p.cumulativePct).toFixed(1)}`).join(' ')
  // If the curve has not reached 80% by the end of the shown window, every bar
  // on screen is still inside the shortlist — highlight them all rather than
  // none, which is what an index-of-not-found would otherwise do.
  const crossAt = points.findIndex(p => p.cumulativePct >= 80)
  const inShortlist = (i: number) => crossAt < 0 || i <= crossAt

  return (
    <svg width="100%" height={h} style={{ display: 'block' }}>
      {axisTicks(peak, 4).map(t => (
        <g key={t}>
          <line x1={PAD.l} x2={w - PAD.r} y1={y(t)} y2={y(t)} stroke={C.grid} strokeWidth="1" />
          <text x={PAD.l - 9} y={y(t) + 3.5} textAnchor="end" fontSize="10" fill={C.faint}>{shortMoney(t)}</text>
        </g>
      ))}
      {[0, 50, 100].map(t => (
        <text key={t} x={w - PAD.r + 9} y={yPct(t) + 3.5} fontSize="10" fill={C.faint}>{t}%</text>
      ))}

      {/* The 80% line is the whole point of a Pareto: everything left of where
          the curve crosses it is the shortlist worth a meeting. */}
      <line x1={PAD.l} x2={w - PAD.r} y1={yPct(80)} y2={yPct(80)}
        stroke="#F5A623" strokeWidth="1" strokeDasharray="5 4" opacity="0.6" />
      <text x={PAD.l + 4} y={yPct(80) - 5} fontSize="9.5" fill="#F5A623" opacity="0.85">80% of spend</text>

      {points.map((p, i) => (
        <g key={p.key} style={{ cursor: 'pointer' }}
          onClick={() => onSelect(p.key)}
          onMouseMove={ev => onTip({
            x: ev.nativeEvent.offsetX, y: ev.nativeEvent.offsetY,
            body: (
              <>
                <TipHead>{p.label}</TipHead>
                <TipRow label="amount" value={money(p.amount)} />
                <TipRow label="running share" value={`${p.cumulativePct.toFixed(1)}%`} dim />
                <TipRow label="rank" value={`#${i + 1}`} dim />
              </>
            ),
          })}>
          <rect x={cx(i) - barW / 2} y={y(p.amount)} width={barW}
            height={Math.max(PAD.t + ih - y(p.amount), 1)} rx="2"
            fill={inShortlist(i) ? C.accent : MUTED}
            opacity={inShortlist(i) ? 0.8 : 0.5} />
          <g transform={`translate(${cx(i)}, ${PAD.t + ih + 10}) rotate(-38)`}>
            <text textAnchor="end" fontSize="9.5" fill={C.dim}>{clip(p.label, 96, 5.2)}</text>
          </g>
        </g>
      ))}

      <path d={curve} fill="none" stroke="#F5A623" strokeWidth="1.8" strokeLinejoin="round" />
      {points.map((p, i) => (
        <circle key={p.key} cx={cx(i)} cy={yPct(p.cumulativePct)} r="2.6"
          fill={C.bgDeep} stroke="#F5A623" strokeWidth="1.3" />
      ))}
    </svg>
  )
}

const kf: Record<string, React.CSSProperties> = {
  grid: { display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(176px, 1fr))', gap: '12px', marginBottom: '12px' },
  card: { background: C.bg, border: `1px solid ${C.line}`, borderRadius: '10px', padding: '13px 16px', minWidth: 0 },
  label: { fontSize: '9.5px', color: C.faint, textTransform: 'uppercase', letterSpacing: '0.08em', marginBottom: '6px' },
  hero: { fontSize: '29px', fontWeight: 600, color: C.text, fontFamily: "'DM Mono', 'Fira Mono', monospace", lineHeight: 1.05 },
  value: { fontSize: '22px', fontWeight: 600, color: C.text, fontFamily: "'DM Mono', 'Fira Mono', monospace", lineHeight: 1.2 },
  sub: { fontSize: '11px', color: C.dim, marginTop: '3px' },
  chip: { fontSize: '11px', fontWeight: 600, padding: '2px 8px', borderRadius: '5px', fontFamily: "'DM Mono', monospace" },
}
