import React from 'react'
import { fireEvent, render, screen } from '@testing-library/react'
import fs from 'fs'
import path from 'path'
import ExpenseBranches, { type ExpenseBranchNode } from './ExpenseBranches'
import { DisplayCurrencyProvider } from '../contexts/DisplayCurrencyContext'

// ─── Rendering the branches, and then looking at them ───────────────────────
//
// The layout is proved with numbers in services/branchTree.test.ts — a parent
// sits at the middle of its open children, no two rows share a slot, and a
// branch is as thick as what it carries. What that cannot say is whether a
// name overflows its box, whether the columns fit, or whether the thing reads.

beforeAll(() => {
  ;(global as any).ResizeObserver = class {
    observe() {}
    unobserve() {}
    disconnect() {}
  }
})

const OUT_DIR = process.env.CHART_RENDER_DIR

const leaf = (label: string, amount: number, behaviour: any = 'fixed'): ExpenseBranchNode =>
  ({ key: label, label, amount, behaviour })

const ROOTS: ExpenseBranchNode[] = [
  {
    key: 'emp', label: 'Employee and Labour', amount: 113187.93, behaviour: 'fixed',
    children: [
      leaf('Net salaries', 71420.4),
      {
        key: 'contrib', label: 'Contributions on behalf of the employee',
        amount: 28616.1, behaviour: 'fixed',
        children: [leaf('Pension', 18616.1), leaf('Health', 10000.0)],
      },
      leaf('Other labour related expenses', 13151.43),
    ],
  },
  {
    key: 'prof', label: 'Professional and Production Services', amount: 99737.0,
    behaviour: 'variable',
    children: [
      leaf('Contractors', 71000.0, 'variable'),
      leaf('Production', 28737.0, 'variable'),
    ],
  },
  {
    key: 'gen', label: 'General Business', amount: 26759.0, behaviour: 'fixed',
    children: [leaf('Rent', 16400.0), leaf('Utilities', 6359.0), leaf('Insurance', 4000.0)],
  },
  { key: 'capex', label: 'Capital expenditures', amount: 15000.0, behaviour: 'unknown' },
  { key: 'bank', label: 'Banking and Finance', amount: 329.05, behaviour: 'fixed' },
  { key: 'nil', label: 'Budgeted at nothing', amount: 0, behaviour: 'unknown' },
]

function capture(name: string, html: string) {
  if (!OUT_DIR) return
  fs.mkdirSync(OUT_DIR, { recursive: true })
  fs.writeFileSync(path.join(OUT_DIR, `${name}.html`), `<!doctype html>
<meta charset="utf-8">
<title>${name}</title>
<link href="https://fonts.googleapis.com/css2?family=Inter:wght@400;500;600&family=DM+Mono:wght@400;500&display=swap" rel="stylesheet">
<body style="margin:0;padding:24px;background:#060E1A;font-family:Inter,system-ui,sans-serif;color:#DCE9F6">
<div style="max-width:1100px">${html}</div>
</body>`, 'utf-8')
}

const branches = (onOpenLedger?: (k: string, l: string) => void) => (
  <ExpenseBranches monthLabel="October 2026" roots={ROOTS} onOpenLedger={onOpenLedger} />
)

describe('the branches draw', () => {
  it('prices each branch in the display currency, in the app notation', () => {
    const { unmount } = render(branches())
    expect(screen.getByLabelText(/^Employee and Labour, 113\.188 RSD,/)).toBeInTheDocument()
    unmount()
    render(<DisplayCurrencyProvider initial="EUR">{branches()}</DisplayCurrencyProvider>)
    expect(screen.getByLabelText(/^Employee and Labour, 113\.188 EUR,/)).toBeInTheDocument()
  })

  it('opens one level, so the month is categories and what is under them', () => {
    const { container } = render(branches())
    capture('branches-1-one-level', container.innerHTML)
    expect(screen.getByLabelText(/^Employee and Labour,/)).toBeInTheDocument()
    expect(screen.getByLabelText(/^Net salaries,/)).toBeInTheDocument()
    // Two deep is folded until asked for.
    expect(screen.queryByLabelText(/^Pension,/)).not.toBeInTheDocument()
  })

  it('folds and opens a node by clicking it', () => {
    render(branches())
    fireEvent.click(screen.getByLabelText(/^Employee and Labour,/))
    expect(screen.queryByLabelText(/^Net salaries,/)).not.toBeInTheDocument()
    fireEvent.click(screen.getByLabelText(/^Employee and Labour,/))
    expect(screen.getByLabelText(/^Net salaries,/)).toBeInTheDocument()
  })

  it('STOPS THE BULK OPEN AT TWO LEVELS', () => {
    // The third level is `expense_description` — one row per person on the
    // payroll lines — and on a real October that is hundreds of rows. Opened
    // all at once the canvas grows to several thousand pixels and answers
    // nothing.
    const { container } = render(branches())
    fireEvent.click(screen.getByRole('button', { name: 'Two levels' }))
    capture('branches-2-two-levels', container.innerHTML)

    expect(screen.getByLabelText(/^Contributions on behalf of the employee,/))
      .toBeInTheDocument()
    expect(screen.queryByLabelText(/^Pension,/)).not.toBeInTheDocument()
  })

  it('STILL OPENS ONE BRANCH AS DEEP AS IT GOES, by clicking it', () => {
    // The cap is on the bulk action, which is what makes a wall. A branch
    // opened deliberately is asked for one at a time.
    const { container } = render(branches())
    fireEvent.click(screen.getByLabelText(/^Contributions on behalf of the employee,/))
    capture('branches-3-one-branch-deep', container.innerHTML)
    expect(screen.getByLabelText(/^Pension,/)).toBeInTheDocument()
    // And its neighbours stay where they were.
    expect(screen.queryByLabelText(/^Production,/)).toBeInTheDocument()
  })

  it('folds back to the categories alone', () => {
    render(branches())
    fireEvent.click(screen.getByRole('button', { name: 'Fold all' }))
    expect(screen.queryByLabelText(/^Net salaries,/)).not.toBeInTheDocument()
    expect(screen.getByLabelText(/^Employee and Labour,/)).toBeInTheDocument()
  })

  it('SAYS HOW MANY LINES ARE FOLDED AWAY', () => {
    // Five categories with no word about the ten lines under them reads as
    // five lines, and a reader has no reason to look further. Ten and not
    // eight: folded away is folded away at every depth, so the two inside
    // Contributions count too.
    const { container } = render(branches())
    fireEvent.click(screen.getByRole('button', { name: 'Fold all' }))
    // Split across text nodes in one span, so read the span rather than
    // asking for a string React never renders as one.
    expect(container.textContent).toMatch(/10 lines folded away/)
  })

  it('opens the ledger for a line with nothing under it', () => {
    const opened: string[] = []
    render(branches((_k, label) => opened.push(label)))
    fireEvent.click(screen.getByLabelText(/^Capital expenditures,/))
    expect(opened).toEqual(['Capital expenditures'])
  })

  it('leaves out anything budgeted at nothing', () => {
    render(branches())
    expect(screen.queryByLabelText(/^Budgeted at nothing,/)).not.toBeInTheDocument()
  })

  it('carries a legend for only the behaviours on screen', () => {
    render(branches())
    expect(screen.getByText('Fixed')).toBeInTheDocument()
    expect(screen.getByText('Too little history')).toBeInTheDocument()
  })
})

describe('the geometry, which the layout tests cannot see', () => {
  const svgOf = (c: HTMLElement) => c.querySelector('svg')!

  it('DRAWS A BRANCH AS THICK AS WHAT IT CARRIES', () => {
    // The whole reason this is a picture rather than a list.
    const { container } = render(branches())
    const widths = Array.from(svgOf(container).querySelectorAll('path'))
      .map(p => Number(p.getAttribute('stroke-width')))
    expect(Math.max(...widths)).toBeGreaterThan(Math.min(...widths) * 3)
    for (const w of widths) expect(w).toBeGreaterThanOrEqual(1.5)
  })

  it('never lets a label overflow its own box', () => {
    // A name wider than the box it sits in runs into the column beside it,
    // where it reads as that column's.
    const { container } = render(branches())
    // Opened deliberately, branch by branch — which is the deepest the tree
    // ever gets, and therefore the narrowest the columns ever get.
    fireEvent.click(screen.getByLabelText(/^Contributions on behalf of the employee,/))
    for (const g of Array.from(svgOf(container).querySelectorAll('g'))) {
      // The first rect is the node's box; the second is the 3px behaviour rule.
      const box = g.querySelector('rect')
      if (!box || Number(box.getAttribute('width')) < 10) continue
      const right = Number(box.getAttribute('x')) + Number(box.getAttribute('width'))
      for (const t of Array.from(g.querySelectorAll('text'))) {
        const wide = (t.textContent || '').length * 5.6
        expect(Number(t.getAttribute('x')) + wide).toBeLessThanOrEqual(right + 0.5)
      }
    }
  })

  it('keeps every node inside the frame, at every depth', () => {
    const { container } = render(branches())
    fireEvent.click(screen.getByLabelText(/^Contributions on behalf of the employee,/))
    const svg = svgOf(container)
    const [, , vw, vh] = (svg.getAttribute('viewBox') || '0 0 900 300').split(' ').map(Number)
    for (const r of Array.from(svg.querySelectorAll('rect'))) {
      expect(Number(r.getAttribute('x')) + Number(r.getAttribute('width')))
        .toBeLessThanOrEqual(vw + 0.5)
      expect(Number(r.getAttribute('y')) + Number(r.getAttribute('height')))
        .toBeLessThanOrEqual(vh + 0.5)
    }
  })

  it('NEVER PUTS TWO NODES ON TOP OF EACH OTHER', () => {
    // Two boxes sharing a row is two figures where one is hidden, and the
    // hidden one is simply absent from the picture.
    const { container } = render(branches())
    fireEvent.click(screen.getByLabelText(/^Contributions on behalf of the employee,/))
    const boxes = Array.from(svgOf(container).querySelectorAll('rect'))
      .filter(r => Number(r.getAttribute('width')) > 10)
      .map(r => ({
        x: Number(r.getAttribute('x')), y: Number(r.getAttribute('y')),
        w: Number(r.getAttribute('width')), h: Number(r.getAttribute('height')),
      }))
    for (let i = 0; i < boxes.length; i++) {
      for (let j = i + 1; j < boxes.length; j++) {
        const a = boxes[i]
        const b = boxes[j]
        const apart = a.x + a.w <= b.x + 1e-6 || b.x + b.w <= a.x + 1e-6
          || a.y + a.h <= b.y + 1e-6 || b.y + b.h <= a.y + 1e-6
        expect(apart).toBe(true)
      }
    }
  })

  it('grows the canvas as branches open rather than squeezing them', () => {
    const { container } = render(branches())
    const shut = Number(svgOf(container).getAttribute('height'))
    fireEvent.click(screen.getByLabelText(/^Contributions on behalf of the employee,/))
    expect(Number(svgOf(container).getAttribute('height'))).toBeGreaterThan(shut)
  })
})
