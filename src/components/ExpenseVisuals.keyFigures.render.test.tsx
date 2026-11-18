import React from 'react'
import { render, screen } from '@testing-library/react'
import { KeyFigures } from './ExpenseVisuals'

// ── The key figures when a month or a category nets at or below zero ─────────
//
// The headline stays a signed net. The picture of it, and the share of spend
// nobody owns, are taken over what is above zero.

beforeAll(() => {
  ;(global as any).ResizeObserver = class { observe() {} unobserve() {} disconnect() {} }
})

const figures = (o: Partial<React.ComponentProps<typeof KeyFigures>> = {}) => (
  <KeyFigures
    total={500} priorTotal={400} adjusted={500} excluded={0}
    unassigned={0} unassignedBase={800} reconciled
    months={['2026-07', '2026-08', '2026-09']} monthlyTotals={[900, -150, 700]}
    paretoCutoff={1} paretoShare={80} leafCount={3}
    periodLabel="2026" priorLabel="2025" {...o} />
)

describe('the sparkline of the months', () => {
  const points = (container: HTMLElement) => {
    const path = container.querySelector('svg[aria-label="Ukupni troškovi po mesecima"] path[fill="none"]')!
    return (path.getAttribute('d') || '').match(/[ML]([\d.]+),([\d.-]+)/g)!.map(m => Number(m.split(',')[1]))
  }

  it('puts a month at or below zero on the floor of the line, not under it', () => {
    const { container } = render(figures())
    const ys = points(container)
    expect(ys).toHaveLength(3)
    for (const y of ys) {
      expect(Number.isFinite(y)).toBe(true)
      expect(y).toBeLessThanOrEqual(34 - 3 + 1e-9)
      expect(y).toBeGreaterThanOrEqual(0)
    }
    // July is the tallest, so it is the highest point; August sits on the floor.
    expect(ys[1]).toBeCloseTo(31, 1)
    expect(ys[0]).toBeLessThan(ys[1])
  })
})

describe('the share nobody owns', () => {
  it('is taken over what the department branch draws, so it never passes 100', () => {
    // Unclassified 800, another department netting -300: the net is 500, and
    // 800 over 500 would read 160%.
    render(figures({ unassigned: 800, unassignedBase: 800 }))
    expect(screen.getByText('100%')).toBeInTheDocument()
    expect(screen.queryByText('160%')).not.toBeInTheDocument()
  })

  it('is nothing for an unclassified figure at or below zero', () => {
    render(figures({ unassigned: -50, unassignedBase: 800 }))
    expect(screen.getByText('0%')).toBeInTheDocument()
    expect(screen.queryByText('-6%')).not.toBeInTheDocument()
  })

  it('still prints the unclassified figure with its minus', () => {
    render(figures({ unassigned: -50, unassignedBase: 800 }))
    expect(screen.getByText(/-50/)).toBeInTheDocument()
  })
})
