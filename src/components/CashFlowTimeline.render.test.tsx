import React from 'react'
import { render, screen } from '@testing-library/react'
import fs from 'fs'
import path from 'path'
import CashFlowTimeline from './CashFlowTimeline'
import { cashTimeline, datedByMonth, monthsAround } from '../services/cashTimeline'

beforeAll(() => {
  ;(global as any).ResizeObserver = class {
    observe() {}
    unobserve() {}
    disconnect() {}
  }
})

const OUT_DIR = process.env.CHART_RENDER_DIR

const MONTHS = monthsAround('2026-09', 5, 6)
const IN = [318, 296, 341, 302, 355, 200, 0, 0, 0, 0, 0, 0]
const OUT = [305, 331, 318, 339, 311, 190, 0, 0, 0, 0, 0, 0]
const P_IN = [0, 0, 0, 0, 0, 340, 329, 344, 318, 351, 333, 347]
const P_OUT = [0, 0, 0, 0, 0, 320, 287, 281, 295, 402, 289, 284]

const actual: any = {}
const projected: any = {}
MONTHS.forEach((m, i) => {
  if (IN[i] || OUT[i]) actual[m] = { inflow: IN[i] * 1000, outflow: OUT[i] * 1000 }
  if (P_IN[i] || P_OUT[i]) projected[m] = { inflow: P_IN[i] * 1000, outflow: P_OUT[i] * 1000 }
})

const timeline = (position: { amount: number; asOf: string } | null = { amount: 612400, asOf: '2026-09-25' }) =>
  cashTimeline({
    months: MONTHS, currentMonth: '2026-09', actual, projected, position,
    postedAfterReading: { inflow: 0, outflow: 18400 },
  })

const DATED = datedByMonth([
  { date: '2026-10-05', label: 'Intesa 100k #18', amountUsd: 6654.25, kind: 'instalment' },
  { date: '2026-10-07', label: 'A1 Srbija', amountUsd: 1481.68, kind: 'invoice' },
  { date: '2026-10-24', label: 'Cognant AI', amountUsd: 4840, kind: 'invoice' },
  { date: '2026-11-05', label: 'Intesa 100k #19', amountUsd: 6654.25, kind: 'instalment' },
], MONTHS)

function capture(name: string, html: string) {
  if (!OUT_DIR) return
  fs.mkdirSync(OUT_DIR, { recursive: true })
  fs.writeFileSync(path.join(OUT_DIR, `${name}.html`), `<!doctype html>
<meta charset="utf-8">
<title>${name}</title>
<link href="https://fonts.googleapis.com/css2?family=Inter:wght@400;500;600&family=DM+Mono:wght@400;500&display=swap" rel="stylesheet">
<body style="margin:0;padding:24px;background:#060E1A;font-family:Inter,system-ui,sans-serif;color:#DCE9F6">
<div style="max-width:1040px">${html}</div>
</body>`, 'utf-8')
}

describe('the cash line draws', () => {
  it('shows the anchor and the lowest point in the header', () => {
    const { container } = render(<CashFlowTimeline timeline={timeline()} dated={DATED} />)
    capture('cash-1-timeline', container.innerHTML)
    expect(screen.getByText(/read 2026-09-25/)).toBeInTheDocument()
    expect(screen.getByText(/lowest/)).toBeInTheDocument()
  })

  it('DRAWS NO BALANCE without a cash position, and says why', () => {
    const { container } = render(<CashFlowTimeline timeline={timeline(null)} dated={DATED} />)
    capture('cash-2-no-position', container.innerHTML)
    expect(screen.getByText(/No cash position has been entered/i)).toBeInTheDocument()
    // No line, no dots — the flows are still there.
    expect(container.querySelectorAll('polyline')).toHaveLength(0)
    expect(container.querySelectorAll('circle')).toHaveLength(0)
    expect(container.querySelectorAll('rect').length).toBeGreaterThan(12)
  })

  it('carries a legend naming every mark, so none of them is colour alone', () => {
    render(<CashFlowTimeline timeline={timeline()} dated={DATED} />)
    expect(screen.getByText(/In — above the line/)).toBeInTheDocument()
    expect(screen.getByText(/Out — below it/)).toBeInTheDocument()
    expect(screen.getByText(/Balance at month end/)).toBeInTheDocument()
    expect(screen.getByText(/Hatched — the month in progress/)).toBeInTheDocument()
  })
})

describe('the geometry, which the palette validator says nothing about', () => {
  const svgOf = (c: HTMLElement) => c.querySelector('svg')!

  it('keeps every mark inside the frame', () => {
    const { container } = render(<CashFlowTimeline timeline={timeline()} dated={DATED} />)
    const svg = svgOf(container)
    const [, , vw, vh] = (svg.getAttribute('viewBox') || '0 0 900 300').split(' ').map(Number)
    for (const r of Array.from(svg.querySelectorAll('rect'))) {
      expect(Number(r.getAttribute('x')) + Number(r.getAttribute('width')))
        .toBeLessThanOrEqual(vw + 0.5)
    }
    for (const c of Array.from(svg.querySelectorAll('circle'))) {
      const cy = Number(c.getAttribute('cy'))
      expect(cy).toBeGreaterThanOrEqual(0)
      expect(cy).toBeLessThanOrEqual(vh)
    }
  })

  it('NEVER LETS TWO MONTH LABELS COLLIDE', () => {
    const { container } = render(<CashFlowTimeline timeline={timeline()} dated={DATED} />)
    const labels = [...svgOf(container).querySelectorAll('text')]
      .filter(t => t.getAttribute('text-anchor') === 'middle')
      .map(t => ({ x: Number(t.getAttribute('x')), text: t.textContent || '' }))
      .sort((a, b) => a.x - b.x)
    for (let i = 1; i < labels.length; i++) {
      const half = (s: string) => (s.length * 5.4) / 2
      expect((labels[i].x - half(labels[i].text))
        - (labels[i - 1].x + half(labels[i - 1].text))).toBeGreaterThan(0)
    }
  })

  it('draws the balance as one unbroken line across every month', () => {
    const { container } = render(<CashFlowTimeline timeline={timeline()} dated={DATED} />)
    const points = (svgOf(container).querySelector('polyline')!.getAttribute('points') || '')
      .trim().split(/\s+/)
    expect(points).toHaveLength(MONTHS.length)
  })

  it('never draws a bar of negative height', () => {
    const { container } = render(<CashFlowTimeline timeline={timeline()} dated={DATED} />)
    for (const r of Array.from(container.querySelectorAll('rect'))) {
      expect(Number(r.getAttribute('height') || 0)).toBeGreaterThanOrEqual(0)
    }
  })
})
