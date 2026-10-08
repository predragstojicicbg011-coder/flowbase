import React, { useEffect, useRef, useState } from 'react'

// ─── Motion that carries information ────────────────────────────────────────
//
// The rule everything here follows: NOTHING MOVES UNLESS A NUMBER CHANGED.
// A figure that counts up is saying "this just became something else". A
// skeleton is saying "still working". A chart drawing itself is saying
// "arrived". Movement that says nothing is decoration, and decoration behind
// a page of money makes the money harder to read and harder to trust.
//
// Every one of these is off entirely for somebody who has asked for reduced
// motion — not shortened, off. The setting exists for people movement makes
// ill, and a tasteful amount of it is still movement.

/** Whether the person has asked their system for less movement. */
export function useReducedMotion(): boolean {
  const [reduced, setReduced] = useState(() => {
    if (typeof window === 'undefined' || !window.matchMedia) return false
    return window.matchMedia('(prefers-reduced-motion: reduce)').matches
  })

  useEffect(() => {
    if (typeof window === 'undefined' || !window.matchMedia) return
    const query = window.matchMedia('(prefers-reduced-motion: reduce)')
    const onChange = () => setReduced(query.matches)
    // `addEventListener` on a MediaQueryList is the modern spelling and
    // `addListener` the one Safari understood for years; both are here
    // because a page that throws on an old browser shows nothing at all.
    if (query.addEventListener) query.addEventListener('change', onChange)
    else query.addListener(onChange)
    return () => {
      if (query.removeEventListener) query.removeEventListener('change', onChange)
      else query.removeListener(onChange)
    }
  }, [])

  return reduced
}

/**
 * A number on its way to another number.
 *
 * It animates only when the value CHANGES, and never on the first arrival —
 * counting up from zero to a figure that was always that figure is a small
 * lie about what just happened. The first render is the final value.
 *
 * Eased out, so it decelerates into the answer rather than snapping: the
 * point is that the eye follows it to the new figure and notices which card
 * moved.
 */
export function useCountUp(value: number, duration = 650): number {
  const reduced = useReducedMotion()
  const [shown, setShown] = useState(value)
  const from = useRef(value)
  const frame = useRef<number | null>(null)
  const first = useRef(true)

  useEffect(() => {
    if (first.current) {
      first.current = false
      from.current = value
      setShown(value)
      return
    }
    if (reduced || !Number.isFinite(value)) {
      from.current = value
      setShown(value)
      return
    }

    const start = performance.now()
    const begin = from.current
    const delta = value - begin
    if (delta === 0) return

    const step = (now: number) => {
      const t = Math.min(1, (now - start) / duration)
      // Cubic ease-out: fast at first, settling into the figure.
      const eased = 1 - Math.pow(1 - t, 3)
      setShown(begin + delta * eased)
      if (t < 1) frame.current = requestAnimationFrame(step)
      else {
        from.current = value
        setShown(value)
      }
    }
    frame.current = requestAnimationFrame(step)

    return () => {
      if (frame.current !== null) cancelAnimationFrame(frame.current)
      // Whatever it was mid-flight, the next change starts from there rather
      // than jumping back — otherwise a quick second change looks like a
      // glitch instead of a correction.
      from.current = value
    }
  }, [value, duration, reduced])

  return shown
}

/**
 * A figure that counts to its new value.
 *
 * `format` does the rest — currency, separators, a sign — so this knows
 * nothing about money and cannot disagree with how the rest of the page
 * writes a number.
 */
export function CountUp({ value, format, style }: {
  value: number
  format: (n: number) => string
  style?: React.CSSProperties
}) {
  const shown = useCountUp(value)
  return <span style={style}>{format(shown)}</span>
}

/**
 * A placeholder the shape of the thing that is coming.
 *
 * Instead of the word "Loading", which tells somebody the page is busy and
 * nothing about what it will look like when it is not. A block the size of
 * the table that is arriving means the layout does not jump when it does.
 */
export function Skeleton({ width, height = 12, radius = 6, style }: {
  width?: number | string
  height?: number | string
  radius?: number
  style?: React.CSSProperties
}) {
  return (
    <div className="mf-skeleton" aria-hidden="true"
      style={{ width: width ?? '100%', height, borderRadius: radius, ...style }} />
  )
}

/** Several of them, for a list or a table that is on its way. */
export function SkeletonRows({ rows = 4, height = 12, gap = 10, widths }: {
  rows?: number
  height?: number
  gap?: number
  /** Percentages, so the placeholder looks like text rather than a wall. */
  widths?: number[]
}) {
  const w = widths ?? [92, 78, 85, 64, 88, 72]
  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap, padding: '4px 0' }}
      role="status" aria-label="Učitavanje">
      {Array.from({ length: rows }, (_, i) => (
        <Skeleton key={i} height={height} width={`${w[i % w.length]}%`} />
      ))}
    </div>
  )
}

/**
 * Content that rises into place once, on arrival.
 *
 * `delay` staggers a group so they arrive in reading order rather than all at
 * once, which is the difference between a page assembling itself and a page
 * flickering.
 */
export function Rise({ delay = 0, children, style }: {
  delay?: number
  children: React.ReactNode
  style?: React.CSSProperties
}) {
  return (
    <div className="mf-rise" style={{ animationDelay: `${delay}ms`, ...style }}>
      {children}
    </div>
  )
}

/**
 * The length of an SVG path, so a line can draw itself.
 *
 * Measured from the element rather than guessed, because a dash pattern
 * shorter than the line leaves a gap that never closes and one much longer
 * makes the animation appear to do nothing for most of its duration.
 */
export function useDrawLength(ref: React.RefObject<SVGPathElement | SVGPolylineElement | null>): void {
  useEffect(() => {
    const el = ref.current
    if (!el || typeof (el as any).getTotalLength !== 'function') return
    try {
      const length = Math.ceil((el as any).getTotalLength())
      if (length > 0) el.style.setProperty('--mf-len', String(length))
    } catch {
      // jsdom has no geometry, and a chart that cannot measure itself should
      // simply appear rather than take the page down with it.
    }
  })
}
