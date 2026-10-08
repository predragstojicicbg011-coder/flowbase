import React, { useMemo, useState } from 'react'
import { C, deck, useWidth } from './chartChrome'
import {
  branchPath, keysToDepth, layoutBranches, type BranchNode,
} from '../services/branchTree'
import type { CostBehaviour } from '../services/cfoMetrics'

// ── The expense branches ────────────────────────────────────────────────────
//
// The month on the left, splitting into categories, into sub-categories, into
// the lines themselves.
//
// AN ORG CHART SAYS ONLY WHAT CONTAINS WHAT, and the P&L table already says
// that in a column of indents. What a branching picture can add is that the
// shape of the spending is visible on the way down: the branch into a node is
// drawn at a thickness proportional to its amount, so the eye follows the
// thick one without reading a figure. That is the whole reason this is worth
// drawing rather than listing.
//
// Scaled against the largest amount ANYWHERE, not against each parent.
// Per-level scaling makes the only child of a tiny category as thick as the
// biggest category in the month, which says the opposite of the truth.
//
// ── Colour does not repeat the thickness ────────────────────────────────────
//
// Thickness is the amount. Shading a branch darker-where-thicker encodes the
// same thing twice and burns the only free channel on what the picture already
// shows. So hue carries the other thing worth knowing and the one a table
// cannot — whether the cost moves, measured from its own month-to-month
// variation. Two hues and a de-emphasis grey, validated against this surface:
// CVD ΔE 27.4 (protan), normal-vision ΔE 30.7, every check passed.
//
// Every node carries its name and its figure, so identity never rests on the
// colour, and the folded ones say how many rows are underneath rather than
// letting eleven categories read as eleven lines.

const BEHAVIOUR: Record<CostBehaviour, { fill: string; label: string; says: string }> = {
  fixed: {
    fill: '#3987E5', label: 'Fixed',
    says: 'Barely moves month to month — owed whatever happens.',
  },
  variable: {
    fill: '#C98500', label: 'Moves with the month',
    says: 'Swings month to month, so it is the part that can be acted on.',
  },
  unknown: {
    fill: '#5A7691', label: 'Too little history',
    says: 'Fewer than three months on the ledger — nothing can be said about it yet.',
  },
}

export interface ExpenseBranchNode extends BranchNode {
  behaviour: CostBehaviour
  children?: ExpenseBranchNode[]
}

const money = (n: number) =>
  '$' + Math.abs(n).toLocaleString('en-US', { maximumFractionDigits: 0 })
const money2 = (n: number) =>
  '$' + Math.abs(n).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })
const pct = (n: number) => `${(n * 100).toFixed(1)}%`

const ROW = 34
/** The room a branch needs between one column's boxes and the next. */
const GAP = 56
/** Narrower than this and a node holds no name; the canvas scrolls instead. */
const MIN_NODE = 168
const MAX_NODE = 300
/** ~5.6px a character at the size a node's label is drawn, plus its padding. */
const CHAR = 5.6
const PAD = 24

/**
 * How deep a bulk open goes: the categories, and what is directly under them.
 *
 * ONE, not two, because `keysToDepth` counts the nodes it OPENS rather than
 * the levels that end up on screen — opening the depth-0 nodes puts two
 * levels there. The third would be `expense_description`.
 */
const TWO_LEVELS = 1

/**
 * How wide a node's box should be, given the room and how deep the tree goes.
 *
 * FIXED COLUMNS WASTE THE ROOM THEY DO NOT USE. Two levels in an 1,100px
 * panel left a third of the width empty while every label was cut —
 * `Contributions on behalf o…`, `Professional and Produc…` — which is the
 * worst of both: space unused and names unreadable. The columns now take what
 * is there and stop at a width no name needs exceeded.
 *
 * Below `MIN_NODE` it stops shrinking and the canvas scrolls. A node too
 * narrow to hold a name is not a smaller node, it is a box with an ellipsis
 * in it.
 */
export function columnWidths(available: number, depth: number): { node: number; column: number } {
  const columns = depth + 1
  const node = Math.max(MIN_NODE, Math.min(MAX_NODE, (available - 40) / columns - GAP))
  return { node, column: node + GAP }
}

/** Cut to the node's box, never past it. The full name is on hover. */
function fit(label: string, boxWidth: number): string {
  const max = Math.max(6, Math.floor((boxWidth - PAD) / CHAR))
  return label.length <= max ? label : label.slice(0, max - 1) + '…'
}

export default function ExpenseBranches({
  monthLabel, roots, onOpenLedger,
  start = 'twoLevels', bare = false, amountLabel = 'This month', emptyText,
}: {
  monthLabel: string
  roots: ExpenseBranchNode[]
  onOpenLedger?: (key: string, label: string) => void
  /**
   * How much is open on arrival.
   *
   * The simulation opens a level, because there the tree IS the page and a
   * folded one would be a row of eleven boxes. On the P&L report it is one
   * panel of seven with a full table beneath it, so it arrives folded and
   * the reader opens the branch they came for.
   */
  start?: 'folded' | 'twoLevels'
  /** Drop the card and the trailing note — for use inside another panel. */
  bare?: boolean
  /** What the tooltip calls the figure. A year to date is not "this month". */
  amountLabel?: string
  emptyText?: string
}) {
  const [ref, width] = useWidth(900)
  const [open, setOpen] = useState<Set<string>>(
    () => start === 'folded' ? new Set() : keysToDepth(roots, TWO_LEVELS))
  const [tip, setTip] = useState<{ x: number; y: number; body: React.ReactNode } | null>(null)

  // Laid out twice: once to learn how deep the open tree goes, then again at
  // the column width that depth affords. Cheaper than it sounds — it is
  // arithmetic over a few dozen nodes — and the alternative is a fixed column
  // that is too wide at three levels and too narrow at one.
  const probe = useMemo(() => layoutBranches(roots, open, { rowHeight: ROW }), [roots, open])
  const deepest = probe.nodes.reduce((d, n) => Math.max(d, n.depth), 0)
  const { node: NODE_W, column: COL } =
    columnWidths(Math.max(420, width), deepest)

  const layout = useMemo(
    () => layoutBranches(roots, open, {
      rowHeight: ROW, columnWidth: COL, nodeWidth: NODE_W,
      maxLinkWidth: 24, minLinkWidth: 1.5, top: 6,
    }),
    [roots, open, COL, NODE_W])

  const w = Math.max(Math.max(420, width), (deepest + 1) * COL + 40)
  const H = Math.max(120, layout.height + 14)
  const total = roots.reduce((s, n) => s + Math.abs(n.amount), 0)

  const toggle = (key: string) => setOpen(prev => {
    const next = new Set(prev)
    next.has(key) ? next.delete(key) : next.add(key)
    return next
  })

  const show = (e: React.MouseEvent, body: React.ReactNode) => {
    const box = (e.currentTarget as SVGElement).ownerSVGElement!.getBoundingClientRect()
    setTip({ x: e.clientX - box.left + 14, y: e.clientY - box.top - 8, body })
  }

  const present = Array.from(new Set(
    layout.nodes.map(n => (n.node as ExpenseBranchNode).behaviour)))

  return (
    <div style={bare ? bareWrap : deck.wrap} ref={ref}>
      <div style={deck.head}>
        {/* THE BULK OPEN STOPS AT TWO LEVELS. The third is
            `expense_description` — one row per person on the payroll lines —
            and on a real October that is hundreds of rows. Opened all at once
            the canvas grows to several thousand pixels and answers nothing:
            nobody reads a payroll one name at a time off a tree. A single
            branch still opens as deep as it goes by clicking it, because that
            is asked for one branch at a time and deliberately. */}
        <div style={deck.tabs}>
          <button style={deck.tab} onClick={() => setOpen(new Set())}>Fold all</button>
          <button style={deck.tab}
            onClick={() => setOpen(keysToDepth(roots, TWO_LEVELS))}>Two levels</button>
        </div>
        <span style={deck.hint}>
          {monthLabel} · {money(total)}
          {layout.hidden > 0 && ` · ${layout.hidden} line${layout.hidden === 1 ? '' : 's'} folded away`}
        </span>
      </div>

      {/* Scrolls sideways rather than squeezing the columns: four levels of
          P&L in 900px gives every node forty pixels, which holds no name. */}
      <div style={{ position: 'relative', overflowX: 'auto' }}
        onMouseLeave={() => setTip(null)}>
        <svg width={w} height={H} viewBox={`0 0 ${w} ${H}`} role="img"
          aria-label={`Expenses as a branching tree, ${monthLabel}`}>
          {/* The branches first, so a node's box sits over the line into it
              rather than under it. */}
          {layout.links.map(l => {
            const child = layout.nodes.find(n => n.key === l.to)!
            const tone = BEHAVIOUR[(child.node as ExpenseBranchNode).behaviour]
            return (
              <path key={`${l.from}-${l.to}`} d={branchPath(l)}
                fill="none" stroke={tone.fill} strokeWidth={l.width}
                strokeOpacity={0.4} strokeLinecap="round" />
            )
          })}

          {layout.nodes.map(n => {
            const tone = BEHAVIOUR[(n.node as ExpenseBranchNode).behaviour]
            const under = (n.node.children || []).filter(c => Math.abs(c.amount) > 0).length
            return (
              <g key={n.key}
                role="button" tabIndex={0}
                aria-label={`${n.label}, ${money(n.amount)}, ${pct(n.share)} — ${tone.label}${
                  n.hasChildren ? `, ${under} lines, ${n.open ? 'open' : 'folded'}` : ''}`}
                style={{ cursor: n.hasChildren || onOpenLedger ? 'pointer' : 'default' }}
                onClick={() => n.hasChildren ? toggle(n.key) : onOpenLedger?.(n.key, n.label)}
                onKeyDown={e => {
                  if (e.key !== 'Enter' && e.key !== ' ') return
                  e.preventDefault()
                  n.hasChildren ? toggle(n.key) : onOpenLedger?.(n.key, n.label)
                }}
                onMouseMove={e => show(e, (
                  <>
                    <div style={tipS.head}>{n.label}</div>
                    <div style={tipS.row}><span>{amountLabel}</span><b>{money2(n.amount)}</b></div>
                    <div style={tipS.row}><span>Of the total</span><b>{pct(n.share)}</b></div>
                    <div style={{ ...tipS.row, color: tone.fill }}>
                      <span>Behaviour</span><b>{tone.label}</b>
                    </div>
                    <div style={tipS.note}>{tone.says}</div>
                    <div style={tipS.note}>
                      {n.hasChildren
                        ? `${n.open ? 'Click to fold' : 'Click to open'} its ${under} lines.`
                        : onOpenLedger ? 'Click for the entries behind it.' : ''}
                    </div>
                  </>
                ))}
                onMouseLeave={() => setTip(null)}>
                {/* A thin left rule in the behaviour's hue, not a filled box:
                    a solid block per node at forty nodes is a wall of colour,
                    and the branch already carries the hue. */}
                <rect x={n.x} y={n.y - ROW / 2 + 4} width={NODE_W} height={ROW - 8} rx={5}
                  fill="rgba(255,255,255,0.035)" />
                <rect x={n.x} y={n.y - ROW / 2 + 4} width={3} height={ROW - 8}
                  rx={1.5} fill={tone.fill} />
                <text x={n.x + 12} y={n.y - 1} fontSize={11.5} fill={C.text}
                  pointerEvents="none">
                  {n.hasChildren ? (n.open ? '▾ ' : '▸ ') : ''}{fit(n.label, NODE_W - (n.hasChildren ? 12 : 0))}
                </text>
                <text x={n.x + 12} y={n.y + 12} fontSize={10.5} fill={C.dim}
                  fontFamily="'DM Mono', monospace" pointerEvents="none">
                  {money(n.amount)}
                  <tspan fill={C.faint}>{'  '}{pct(n.share)}</tspan>
                  {n.hasChildren && !n.open && (
                    <tspan fill={C.faint}>{'  '}+{under}</tspan>
                  )}
                </text>
              </g>
            )
          })}

          {layout.nodes.length === 0 && (
            <text x={w / 2} y={H / 2} textAnchor="middle" fontSize={12.5} fill={C.dim}>
              {emptyText || 'Nothing is budgeted this month.'}
            </text>
          )}
        </svg>
        {tip && <div style={{ ...deck.tip, left: tip.x, top: tip.y }}>{tip.body}</div>}
      </div>

      <div style={deck.legend}>
        {present.map(b => (
          <span key={b} style={deck.legendItem}>
            <span style={{ ...deck.swatch, background: BEHAVIOUR[b].fill }} />
            {BEHAVIOUR[b].label}
          </span>
        ))}
      </div>
      {!bare && (
        <div style={note}>
          A branch is drawn as thick as the money it carries, scaled against the largest
          line anywhere rather than against each parent — so thickness means dollars and
          not "share of whichever category this happens to sit under". Colour says the one
          thing the thickness cannot: whether the cost moves. Click a node to open or fold
          it — a branch opens as deep as it goes that way. The button above stops at two
          levels on purpose: the third is one row per line on the payroll, and all of them
          at once is a wall rather than an answer. A node with nothing under it opens the
          entries behind it.
        </div>
      )}
    </div>
  )
}

const tipS: Record<string, React.CSSProperties> = {
  head: { fontSize: '11.5px', color: C.text, fontWeight: 600, marginBottom: '5px' },
  row: {
    display: 'flex', justifyContent: 'space-between', gap: '14px',
    fontSize: '11px', color: C.dim, lineHeight: 1.7,
  },
  note: { fontSize: '10.5px', color: C.faint, marginTop: '5px', lineHeight: 1.45 },
}

/** Inside another panel the card chrome is already drawn once. */
const bareWrap: React.CSSProperties = { marginTop: '2px' }

const note: React.CSSProperties = {
  fontSize: '11px', color: '#5C7894', lineHeight: 1.55, marginTop: '9px', maxWidth: '820px',
}
