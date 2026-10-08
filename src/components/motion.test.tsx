import React from 'react'
import { render, screen, act, waitFor } from '@testing-library/react'
import { CountUp, Skeleton, SkeletonRows, Rise, useReducedMotion } from './motion'

const plain = (n: number) => n.toFixed(0)

describe('a figure that counts', () => {
  it('shows its value exactly on arrival, without counting to it', async () => {
    // Counting up from zero to a figure that was always that figure is a
    // small lie about what just happened. The first render is the answer.
    render(<CountUp value={2742193} format={plain} />)
    expect(screen.getByText('2742193')).toBeInTheDocument()
  })

  it('counts when the figure CHANGES, and lands on the new one', async () => {
    const { rerender } = render(<CountUp value={100} format={plain} />)
    expect(screen.getByText('100')).toBeInTheDocument()

    await act(async () => { rerender(<CountUp value={200} format={plain} />) })
    // It gets there. What it shows in between is the point, and is not
    // something a test should pin down to a particular frame.
    await waitFor(() => expect(screen.getByText('200')).toBeInTheDocument(),
      { timeout: 3000 })
  })

  it('writes the figure with the format it was given and no other', async () => {
    // It knows nothing about money, so it cannot disagree with how the rest
    // of the page writes a number.
    render(<CountUp value={1234.5} format={n => `$${n.toFixed(2)}`} />)
    expect(screen.getByText('$1234.50')).toBeInTheDocument()
  })

  it('does not fall over on a figure that is not one', async () => {
    render(<CountUp value={NaN} format={n => (Number.isFinite(n) ? plain(n) : '—')} />)
    expect(screen.getByText('—')).toBeInTheDocument()
  })
})

describe('the skeletons', () => {
  it('is a block the shape of what is coming, not the word Loading', () => {
    // A block the size of the table that is arriving means the layout does
    // not jump when it does.
    const { container } = render(<Skeleton width={120} height={14} />)
    const el = container.querySelector('.mf-skeleton') as HTMLElement
    expect(el).toBeTruthy()
    expect(el.style.width).toBe('120px')
    expect(el.style.height).toBe('14px')
  })

  it('is hidden from anybody listening rather than reading', () => {
    const { container } = render(<Skeleton />)
    expect(container.querySelector('.mf-skeleton')).toHaveAttribute('aria-hidden', 'true')
  })

  it('announces that something is on its way, once, for a whole group', () => {
    render(<SkeletonRows rows={5} />)
    const status = screen.getByRole('status')
    expect(status).toHaveAttribute('aria-label', 'Učitavanje')
    expect(status.querySelectorAll('.mf-skeleton')).toHaveLength(5)
  })

  it('varies the widths, so it reads as text rather than a wall', () => {
    const { container } = render(<SkeletonRows rows={3} widths={[90, 60, 75]} />)
    const widths = [...container.querySelectorAll('.mf-skeleton')]
      .map(el => (el as HTMLElement).style.width)
    expect(widths).toEqual(['90%', '60%', '75%'])
  })
})

describe('content that rises into place', () => {
  it('staggers by the delay it is given', () => {
    // So a row assembles in reading order rather than flickering into place
    // all at once.
    const { container } = render(<Rise delay={110}>x</Rise>)
    const el = container.querySelector('.mf-rise') as HTMLElement
    expect(el.style.animationDelay).toBe('110ms')
  })

  it('carries the class the stylesheet turns off for reduced motion', () => {
    // The class is the whole contract: `prefers-reduced-motion` disables it
    // in CSS, which no component has to remember to check.
    const { container } = render(<Rise>x</Rise>)
    expect(container.querySelector('.mf-rise')).toBeTruthy()
  })
})

describe('useReducedMotion', () => {
  function Probe() {
    return <span>{useReducedMotion() ? 'reduced' : 'full'}</span>
  }

  it('does not throw where matchMedia does not exist', () => {
    // jsdom has none, and neither do some embedded browsers. A page that
    // throws here shows nothing at all, which is worse than moving.
    render(<Probe />)
    expect(screen.getByText('full')).toBeInTheDocument()
  })

  it('reports a request for less movement when the browser makes one', () => {
    const original = window.matchMedia
    ;(window as any).matchMedia = (q: string) => ({
      matches: q.includes('reduce'),
      media: q,
      addEventListener: () => {},
      removeEventListener: () => {},
    })
    try {
      render(<Probe />)
      expect(screen.getByText('reduced')).toBeInTheDocument()
    } finally {
      ;(window as any).matchMedia = original
    }
  })

  it('gives somebody who asked for less motion NONE of it', async () => {
    // Not a shorter version — none. The setting exists for people movement
    // makes ill, and a tasteful amount of it is still movement.
    const original = window.matchMedia
    ;(window as any).matchMedia = (q: string) => ({
      matches: q.includes('reduce'),
      media: q,
      addEventListener: () => {},
      removeEventListener: () => {},
    })
    try {
      const { rerender } = render(<CountUp value={100} format={plain} />)
      await act(async () => { rerender(<CountUp value={999} format={plain} />) })
      // Straight there, with nothing in between.
      expect(screen.getByText('999')).toBeInTheDocument()
    } finally {
      ;(window as any).matchMedia = original
    }
  })
})
