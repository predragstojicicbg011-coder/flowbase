import React, { useState, useRef, useEffect } from 'react'
import { UNASSIGNED } from '../services/expenseTree'
import { OTHER } from '../services/expenseCharts'

// ── The chart chrome ────────────────────────────────────────────────────────
//
// The palette, the card styles, the tooltip pieces and the width hook — what
// every panel on the analysis pages is built out of.
//
// They lived in `ExpenseVisuals` until that file needed to render the branch
// tree, which was already importing the palette back out of it. A CYCLE AT
// MODULE SCOPE DOES NOT FAIL LOUDLY: one side simply receives `undefined` for
// the other's exports, and the first symptom was four render suites dying on
// `Cannot read properties of undefined (reading 'text')` inside files nobody
// had touched. So the shared layer is its own module, and it imports nothing
// from the modules that use it — the cycle cannot come back by accident.

export const C = {
  bg: '#0D1B2C',
  bgDeep: '#060E1A',
  line: 'rgba(255,255,255,0.075)',
  grid: 'rgba(255,255,255,0.055)',
  text: '#DCE9F6',
  dim: '#7A9BB8',
  faint: 'rgba(255,255,255,0.30)',
  up: '#FF5B5A',      // cost rising — bad news is red
  down: '#00D47E',
  accent: '#00D47E',
}

/** Sequential, not a rainbow: it has to stay readable at eight bands. */
const RAMP = ['#00D47E', '#2FBDB4', '#4EA8FF', '#8B8BFF', '#C77DFF', '#F5A623', '#FF7A5C', '#D4537E']
export const MUTED = '#5A7691'   // Other, and anything deliberately de-emphasised

export function colorFor(key: string, index: number): string {
  if (key === OTHER) return MUTED
  if (key === UNASSIGNED) return '#F5A623'
  return RAMP[index % RAMP.length]
}


export type Tip = { x: number; y: number; body: React.ReactNode } | null

/** Tracks the rendered width of a box so the SVG can be laid out to fit it. */
export function useWidth(fallback = 900): [React.RefObject<HTMLDivElement | null>, number] {
  const ref = useRef<HTMLDivElement>(null)
  const [w, setW] = useState(fallback)
  useEffect(() => {
    const el = ref.current
    if (!el) return
    const ro = new ResizeObserver(() => setW(el.clientWidth || fallback))
    ro.observe(el)
    setW(el.clientWidth || fallback)
    return () => ro.disconnect()
  }, [fallback])
  return [ref, w]
}

// ── Small shared pieces ─────────────────────────────────────────────────────

export const Empty = ({ h, text }: { h: number; text: string }) => (
  <div style={{ height: h, display: 'flex', alignItems: 'center', justifyContent: 'center', color: C.dim, fontSize: '13px' }}>
    {text}
  </div>
)

export const TipHead = ({ children }: { children: React.ReactNode }) => (
  <div style={{ fontSize: '11.5px', fontWeight: 600, color: C.text, marginBottom: '5px' }}>{children}</div>
)

export const TipRow = ({ label, value, dim }: { label: string; value: string; dim?: boolean }) => (
  <div style={{ display: 'flex', justifyContent: 'space-between', gap: '14px', fontSize: '10.5px', lineHeight: 1.7 }}>
    <span style={{ color: C.faint }}>{label}</span>
    <span style={{ color: dim ? C.dim : C.text, fontFamily: "'DM Mono', monospace" }}>{value}</span>
  </div>
)

export const deck: Record<string, React.CSSProperties> = {
  wrap: { background: C.bg, border: `1px solid ${C.line}`, borderRadius: '10px', padding: '12px 14px 10px', marginBottom: '14px' },
  head: { display: 'flex', alignItems: 'center', gap: '12px', marginBottom: '10px', flexWrap: 'wrap' },
  tabs: { display: 'flex', gap: '2px', background: C.bgDeep, padding: '3px', borderRadius: '8px' },
  tab: { fontFamily: "'Inter', system-ui, sans-serif", fontSize: '12px', padding: '6px 13px', border: 'none', background: 'transparent', color: C.dim, cursor: 'pointer', borderRadius: '6px' },
  tabOn: { background: 'rgba(0,212,126,0.14)', color: C.accent, fontWeight: 600 },
  hint: { fontSize: '11px', color: C.faint },
  switch: { fontSize: '11px', color: C.dim, display: 'flex', alignItems: 'center', gap: '6px', cursor: 'pointer' },
  tip: { position: 'absolute', pointerEvents: 'none', background: 'rgba(6,14,26,0.97)', border: `1px solid ${C.line}`, borderRadius: '7px', padding: '8px 10px', minWidth: '150px', maxWidth: '230px', boxShadow: '0 10px 28px rgba(0,0,0,0.5)', zIndex: 20 },
  legend: { display: 'flex', flexWrap: 'wrap', gap: '12px', marginTop: '8px', paddingTop: '9px', borderTop: `1px solid ${C.line}` },
  legendItem: { display: 'flex', alignItems: 'center', gap: '6px', fontSize: '10.5px', color: C.dim },
  legendBtn: { background: 'transparent', border: 'none', padding: '2px 0', cursor: 'pointer', fontFamily: "'Inter', system-ui, sans-serif", transition: 'opacity 120ms ease' },
  seg: { display: 'flex', gap: '2px', background: C.bgDeep, padding: '2px', borderRadius: '7px' },
  segBtn: { fontFamily: "'Inter', system-ui, sans-serif", fontSize: '10.5px', padding: '4px 9px', border: 'none', background: 'transparent', color: C.dim, cursor: 'pointer', borderRadius: '5px' },
  segOn: { background: 'rgba(255,255,255,0.08)', color: C.text, fontWeight: 600 },
  swatch: { width: '9px', height: '9px', borderRadius: '2px', display: 'inline-block' },
}
