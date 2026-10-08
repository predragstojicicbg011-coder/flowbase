// ─── SearchableSelect ───────────────────────────────────────────────────────
//
// A native `<select>` is fine over five options and useless over five hundred.
// The Ledger's partner picker listed every partner in the database, in an
// order nobody can scan — the first entries look like
// `" AMS OSIGURANJE "- AKCIONARSKO DRUSTVO ZA OSIGURANJE A.D.O. BEOGRAD ,` —
// so finding a name you half-remember meant dragging a scrollbar.
//
// This is the control, not the filter. It knows nothing about tabs, predicates
// or the Ledger: a value, a list of options, and a label for the empty value.
// The entry dialogs have the same problem and can take the same component.
//
// Everything decidable without a DOM is a pure function below and is tested
// directly. The component is the thin part: state, focus and paint.

import React, { useCallback, useEffect, useId, useMemo, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import { DIALOG } from './dialogTheme'

export interface SelectOption {
  /** What `onChange` reports. An id for partners, a name for classifications. */
  value: string
  /** What is shown and what the query is matched against. */
  label: string
}

/**
 * Below this many options the search box is noise, so it is not rendered and
 * the control behaves as a plain dropdown. It is a prop, so a call site with
 * an unusual list can say otherwise — but the default means the control adapts
 * as the data grows rather than needing a decision per call site.
 */
export const DEFAULT_SEARCH_THRESHOLD = 10

/** How wide the open panel is allowed to get, and how close to the window edge. */
const PANEL_MAX_WIDTH = 360
const EDGE_GUTTER = 8
/** The tallest the panel may be, search box included, when there is room. */
export const PANEL_MAX_HEIGHT = 320
/** Below this, a dropped panel shows too little to be worth reading. */
const PANEL_MIN_HEIGHT = 140
/** The gap between the control and the panel. */
const PANEL_OFFSET = 4

export interface AnchorRect { left: number; right: number; top: number; bottom: number; width: number }
export interface Viewport { width: number; height: number }

/**
 * Where the open panel goes, in viewport coordinates.
 *
 * The panel is rendered in a portal and positioned `fixed`, so it is clipped
 * by nothing. That is the point: this control started life in the Ledger's
 * filter bar, which sets no overflow of its own, and the old comment here
 * said as much. The entry dialogs are not like that — their bodies scroll —
 * and a panel that drops out of an `overflow: auto` box is simply cut off.
 *
 * Both axes flip on the same principle: prefer the natural side, take the
 * other when the natural one does not fit and the other is roomier. The
 * height is then capped to what the chosen side actually has, so a panel near
 * the bottom of a short window gets a shorter list rather than a clipped one.
 */
export function panelPlacement(
  rect: AnchorRect,
  viewport: Viewport,
  maxHeight: number = PANEL_MAX_HEIGHT,
): { left?: number; right?: number; top?: number; bottom?: number; minWidth: number; maxHeight: number } {
  const horizontal = rect.left + PANEL_MAX_WIDTH > viewport.width - EDGE_GUTTER
    ? { right: Math.max(EDGE_GUTTER, viewport.width - rect.right) }
    : { left: Math.max(EDGE_GUTTER, rect.left) }

  const below = viewport.height - rect.bottom - PANEL_OFFSET - EDGE_GUTTER
  const above = rect.top - PANEL_OFFSET - EDGE_GUTTER
  // Drop downwards unless that would be cramped AND upwards is roomier —
  // downwards is where a dropdown is expected to go, so it takes precedence
  // on anything close.
  const dropUp = below < Math.min(maxHeight, PANEL_MIN_HEIGHT) && above > below

  const vertical = dropUp
    ? { bottom: viewport.height - rect.top + PANEL_OFFSET, maxHeight: Math.min(maxHeight, Math.max(above, 0)) }
    : { top: rect.bottom + PANEL_OFFSET, maxHeight: Math.min(maxHeight, Math.max(below, 0)) }

  return { ...horizontal, ...vertical, minWidth: rect.width }
}

/** Case-insensitive substring. An empty query matches everything. */
export function matchesQuery(label: string, query: string): boolean {
  const q = query.trim().toLowerCase()
  if (!q) return true
  return (label || '').toLowerCase().includes(q)
}

export function filterOptions(options: SelectOption[], query: string): SelectOption[] {
  if (!query.trim()) return options
  return options.filter(o => matchesQuery(o.label, query))
}

export interface ListView {
  /** Exactly what is rendered, in order. The pinned "All …" is always items[0]. */
  items: SelectOption[]
  /** The options that matched. Never contains the pin. */
  matches: SelectOption[]
  /** A query was typed and nothing matched — say so rather than show a gap. */
  empty: boolean
}

/**
 * What the list shows for a given query.
 *
 * The "All …" row is pinned at the top and is NOT filtered: clearing the
 * filter stays one click away no matter what has been typed. It is also not
 * counted as a match, so a query that only resembles the word "All" still
 * reports that nothing matched.
 */
export function listView(options: SelectOption[], query: string, allLabel: string): ListView {
  const matches = filterOptions(options, query)
  return {
    items: [{ value: '', label: allLabel }, ...matches],
    matches,
    empty: query.trim() !== '' && matches.length === 0,
  }
}

/**
 * Clamped, not wrapping: ArrowDown at the bottom stays at the bottom, which is
 * what a picker over hundreds of rows wants — wrapping to the top from the end
 * of a long list reads as a jump to somewhere else.
 *
 * `-1` means nothing is highlighted, and a list of length 0 keeps it there.
 */
export function moveHighlight(current: number, delta: number, length: number): number {
  if (length <= 0) return -1
  const next = current + delta
  if (next < 0) return 0
  if (next > length - 1) return length - 1
  return next
}

/** Where the highlight lands after the query changes. */
export function highlightForQuery(options: SelectOption[], query: string, allLabel: string): number {
  const view = listView(options, query, allLabel)
  if (view.empty) return -1          // nothing to pick, so Enter must do nothing
  if (!query.trim()) return 0        // no query: the pin, so Enter clears
  return 1                           // the first match, so Enter picks it
}

export function needsSearch(optionCount: number, threshold: number): boolean {
  return optionCount >= threshold
}

/**
 * The closed state's text.
 *
 * A filter can outlive the row that justified it — the partner gets renamed,
 * the department is retired, the cascade above narrows the list — and the
 * value is still applied. Falling back to the "All …" label would be a lie
 * about what is on screen, so an unknown value is shown as itself.
 */
export function selectedLabel(options: SelectOption[], value: string, allLabel: string): string {
  if (!value) return allLabel
  const hit = options.find(o => o.value === value)
  return hit ? hit.label : value
}

export interface SearchableSelectProps {
  value: string
  onChange: (value: string) => void
  options: SelectOption[]
  /** The pinned, always-present empty choice, e.g. "All partners". */
  allLabel: string
  /** Placeholder inside the search box. Defaults to "Type to filter…". */
  searchPlaceholder?: string
  /** Shown when a query matches nothing. Defaults to "No matches". */
  emptyMessage?: string
  /** Merged over the closed control, so a call site can match its neighbours. */
  style?: React.CSSProperties
  title?: string
  disabled?: boolean
  searchThreshold?: number
}

export default function SearchableSelect({
  value, onChange, options, allLabel,
  searchPlaceholder = 'Type to filter…',
  emptyMessage = 'No matches',
  style, title, disabled = false,
  searchThreshold = DEFAULT_SEARCH_THRESHOLD,
}: SearchableSelectProps) {
  const [isOpen, setIsOpen] = useState(false)
  const [query, setQuery] = useState('')
  const [highlight, setHighlight] = useState(-1)
  const [place, setPlace] = useState<ReturnType<typeof panelPlacement> | null>(null)

  const rootRef = useRef<HTMLDivElement | null>(null)
  // The panel lives in a portal, so it is not a DOM descendant of `rootRef`.
  // The outside-click check has to know about it by name.
  const panelRef = useRef<HTMLDivElement | null>(null)
  const buttonRef = useRef<HTMLButtonElement | null>(null)
  const inputRef = useRef<HTMLInputElement | null>(null)
  const listId = useId()

  const view = useMemo(() => listView(options, query, allLabel), [options, query, allLabel])
  const showSearch = needsSearch(options.length, searchThreshold)
  const label = selectedLabel(options, value, allLabel)

  // Escape and an outside click are the same event: close, and forget the
  // query. Neither touches `value` — leaving a half-typed filter behind would
  // make the next open start somewhere the user did not leave it.
  const close = useCallback(() => { setIsOpen(false); setQuery('') }, [])

  const measure = useCallback(() => {
    const r = buttonRef.current?.getBoundingClientRect()
    const rect = r
      ? { left: r.left, right: r.right, top: r.top, bottom: r.bottom, width: r.width }
      : { left: 0, right: 0, top: 0, bottom: 0, width: 0 }
    return panelPlacement(rect, { width: window.innerWidth, height: window.innerHeight })
  }, [])

  const open = useCallback(() => {
    setQuery('')
    const idx = listView(options, '', allLabel).items.findIndex(i => i.value === value)
    setHighlight(idx >= 0 ? idx : 0)
    // One rect, read at open time, decides both anchors. Where there is no
    // layout to measure — jsdom — the rect is all zeros, which places the
    // panel top-left and hurts nothing.
    setPlace(measure())
    setIsOpen(true)
  }, [options, allLabel, value, measure])

  const pick = useCallback((next: string) => {
    // A native select fires no change when the same option is re-picked, and
    // the callers reset paging on every change. Match it.
    if (next !== value) onChange(next)
    close()
    buttonRef.current?.focus()
  }, [value, onChange, close])

  useEffect(() => {
    if (!isOpen) return
    const onDown = (e: MouseEvent) => {
      // Both, and this is the whole point. React routes EVENTS through its own
      // tree, so a portalled panel still reaches this component's handlers —
      // but `contains` walks the DOM, where the panel hangs off <body>. Check
      // `rootRef` alone and a mousedown on an option reads as a click outside:
      // the panel closes on mousedown and the option is gone before the click
      // that would have picked it ever lands. Every dropdown in the app
      // stopped accepting a click the day the panel was portalled.
      const target = e.target as Node
      const inControl = !!rootRef.current && rootRef.current.contains(target)
      const inPanel = !!panelRef.current && panelRef.current.contains(target)
      if (!inControl && !inPanel) close()
    }
    document.addEventListener('mousedown', onDown)
    return () => document.removeEventListener('mousedown', onDown)
  }, [isOpen, close])

  // A `fixed` panel does not move with the box that scrolled under it, so it
  // is re-measured on any scroll — `capture` catches the dialog body's own
  // scrolling, which does not bubble — and on resize.
  useEffect(() => {
    if (!isOpen) return
    const reposition = () => setPlace(measure())
    window.addEventListener('scroll', reposition, true)
    window.addEventListener('resize', reposition)
    return () => {
      window.removeEventListener('scroll', reposition, true)
      window.removeEventListener('resize', reposition)
    }
  }, [isOpen, measure])

  useEffect(() => { if (isOpen && showSearch) inputRef.current?.focus() }, [isOpen, showSearch])

  const onQueryChange = (v: string) => {
    setQuery(v)
    setHighlight(highlightForQuery(options, v, allLabel))
  }

  // One handler on the wrapper: the keys are the same whether focus is on the
  // closed button or in the search box, and only one of the two exists at a time.
  const onKeyDown = (e: React.KeyboardEvent) => {
    if (disabled) return
    if (!isOpen) {
      if (e.key === 'ArrowDown' || e.key === 'Enter' || e.key === ' ') { e.preventDefault(); open() }
      return
    }
    if (e.key === 'Escape') {
      // Stopped, not just prevented: this control is meant for the entry
      // dialogs too, and there Escape would otherwise close the whole form.
      e.preventDefault(); e.stopPropagation()
      close(); buttonRef.current?.focus(); return
    }
    if (e.key === 'Tab') { close(); return }   // no preventDefault — focus moves on
    if (e.key === 'ArrowDown') { e.preventDefault(); setHighlight(h => moveHighlight(h, 1, view.items.length)); return }
    if (e.key === 'ArrowUp') { e.preventDefault(); setHighlight(h => moveHighlight(h, -1, view.items.length)); return }
    if (e.key === 'Enter') {
      e.preventDefault()
      // `highlight` is -1 when the query matched nothing, so there is nothing
      // to pick and Enter is a no-op rather than a silent "All".
      const item = view.items[highlight]
      if (item) pick(item.value)
    }
  }

  return (
    <div ref={rootRef} style={s.root} onKeyDown={onKeyDown}>
      <button type="button" ref={buttonRef} title={title || label} disabled={disabled}
        role="combobox" aria-expanded={isOpen} aria-haspopup="listbox"
        aria-controls={isOpen ? listId : undefined}
        style={{
          ...s.control, ...style,
          ...(isOpen ? { borderColor: DIALOG.accentSoft } : {}),
          ...(value ? {} : { color: DIALOG.dim }),
        }}
        onClick={() => (isOpen ? close() : open())}>
        <span style={s.controlLabel}>{label}</span>
        <span style={s.caret} aria-hidden="true">▾</span>
      </button>

      {isOpen && createPortal(
        // In a portal, so no `overflow: auto` ancestor can clip it.
        //
        // No `onKeyDown` here on purpose. React routes events through its own
        // tree, not the DOM, so a keypress in this panel already reaches the
        // wrapper's handler above; a second handler here ran every arrow key
        // twice and the highlight jumped two rows at a time.
        <div ref={panelRef} style={{ ...s.panel, ...place }}>
          {showSearch && (
            <div style={s.searchWrap}>
              <input ref={inputRef} type="text" style={s.search}
                aria-label={searchPlaceholder} placeholder={searchPlaceholder}
                value={query} onChange={e => onQueryChange(e.target.value)} />
            </div>
          )}
          <div id={listId} role="listbox" style={s.list}>
            {view.items.map((item, i) => (
              <div key={item.value || '__all__'} role="option"
                aria-selected={item.value === value}
                style={{
                  ...s.item,
                  ...(i === 0 ? s.pinned : {}),
                  ...(i === highlight ? s.itemActive : {}),
                  ...(item.value === value ? s.itemSelected : {}),
                }}
                onMouseEnter={() => setHighlight(i)}
                onClick={() => pick(item.value)}>
                {item.label}
              </div>
            ))}
            {view.empty && <div style={s.empty}>{emptyMessage}</div>}
          </div>
        </div>,
        document.body,
      )}
    </div>
  )
}

const s: Record<string, React.CSSProperties> = {
  // The anchor for the panel. `inline-flex` so the control occupies exactly
  // what a `<select>` did in the same flex row — the filter bar's layout and
  // row height are unchanged.
  root: { position: 'relative', display: 'inline-flex', minWidth: 0 },

  control: {
    fontFamily: 'system-ui,sans-serif', fontSize: '13px',
    // Longhand, not the `border` shorthand: the open state repaints only the
    // colour, and React warns (rightly) about mixing the two on one element.
    borderWidth: '1px', borderStyle: 'solid', borderColor: DIALOG.border,
    borderRadius: '8px', padding: '8px 12px', outline: 'none',
    background: DIALOG.panel, color: DIALOG.text, cursor: 'pointer',
    display: 'inline-flex', alignItems: 'center', gap: '8px',
    textAlign: 'left', minWidth: 0, maxWidth: '100%',
  },
  controlLabel: { overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', minWidth: 0 },
  caret: { color: DIALOG.dim, fontSize: '10px', flexShrink: 0 },

  // Fixed, in a portal on `document.body`, with every edge coming from
  // `panelPlacement`. Nothing in the tree can clip it — which is what lets
  // the same control serve both the Ledger's filter bar and the entry
  // dialogs, whose bodies scroll.
  //
  // `zIndex` clears the dialogs, which sit around 1000.
  panel: {
    position: 'fixed', zIndex: 2000,
    width: 'max-content', maxWidth: `${PANEL_MAX_WIDTH}px`,
    background: DIALOG.panel, border: `1px solid ${DIALOG.border}`,
    borderRadius: '8px', boxShadow: '0 12px 32px rgba(0,0,0,0.45)', overflow: 'hidden',
    display: 'flex', flexDirection: 'column',
  },
  searchWrap: { padding: '8px', borderBottom: `1px solid ${DIALOG.borderSoft}` },
  search: {
    width: '100%', boxSizing: 'border-box',
    fontFamily: 'system-ui,sans-serif', fontSize: '12.5px',
    background: DIALOG.raised, border: `1px solid ${DIALOG.border}`,
    borderRadius: '6px', padding: '7px 9px', color: DIALOG.text, outline: 'none',
  },
  list: { overflowY: 'auto', flex: 1, minHeight: 0 },
  item: {
    padding: '7px 10px', fontSize: '12.5px', lineHeight: 1.35,
    color: DIALOG.text, cursor: 'pointer',
    borderBottom: `0.5px solid ${DIALOG.borderSoft}`,
    // Legal names run long; wrapping keeps the whole name readable where an
    // ellipsis would hide the part that distinguishes two similar entries.
    whiteSpace: 'normal', overflowWrap: 'anywhere',
  },
  pinned: { color: DIALOG.dim, borderBottom: `1px solid ${DIALOG.border}` },
  itemActive: { background: 'rgba(255,255,255,0.06)' },
  itemSelected: { color: DIALOG.accent },
  empty: { padding: '9px 10px', fontSize: '12px', color: DIALOG.faint },
}
