import React from 'react'
import { render, screen, fireEvent } from '@testing-library/react'
import { ChartDeck } from './ExpenseVisuals'
import { buildTree, withComparison, monthsIn, type PlEntry, type Branch } from '../services/expenseTree'
import { DisplayCurrencyProvider } from '../contexts/DisplayCurrencyContext'

// ── Rendering the deck, on every branch ─────────────────────────────────────
//
// The arithmetic behind these panels is tested in services/expenseCharts.
// What is tested here is the thing that arithmetic cannot catch: a panel that
// throws on an empty period, a tab that exists on one branch and not another,
// and a deck left blank because the open tab went away when the branch
// changed. All three are invisible to a service test and obvious to a user.

beforeAll(() => {
  // jsdom has no layout, so it has no ResizeObserver. The deck measures its
  // own width through one; without a stub every panel throws on mount.
  ;(global as any).ResizeObserver = class {
    observe() { /* nothing to observe without layout */ }
    unobserve() {}
    disconnect() {}
  }
})

const e = (o: Partial<PlEntry> & { amount_rsd: number }): PlEntry => ({
  tx_type: 'expense',
  pl_category: 'Marketing', pl_subcategory: 'Ads',
  department: 'Growth', dept_subcategory: 'Paid', expense_description: 'Meta',
  pl_date: '2026-07-10',
  ...o,
})

const ROWS: PlEntry[] = [
  e({ amount_rsd: 12000, amount: 12000, pl_date: '2026-07-10', rev_alloc_type: 'byval', rev_alloc_sg: 9000, rev_alloc_aimfox: 3000, opex_type: 'performance' }),
  e({ amount_rsd: 18000, amount: 18000, pl_date: '2026-08-10', rev_alloc_type: 'byval', rev_alloc_sg: 6000, rev_alloc_aimfox: 12000, opex_type: 'performance' }),
  e({ amount_rsd: 7400, pl_category: 'Employee and Labour', pl_subcategory: 'Salaries', department: 'Admin', dept_subcategory: 'People', expense_description: 'Payroll', pl_date: '2026-07-28', rev_alloc_type: 'sg100', opex_type: 'opex' }),
  e({ amount_rsd: 7400, pl_category: 'Employee and Labour', pl_subcategory: 'Salaries', department: 'Admin', dept_subcategory: 'People', expense_description: 'Payroll', pl_date: '2026-08-28', rev_alloc_type: 'sg100', opex_type: 'opex' }),
  e({ amount_rsd: 980, pl_category: 'General Business', pl_subcategory: 'Software', department: 'Admin', dept_subcategory: 'Tools', expense_description: 'Figma', pl_date: '2026-08-03', rev_alloc_type: 'af100', opex_type: 'opex' }),
]

const PRIOR: PlEntry[] = [
  e({ amount_rsd: 4000, amount: 4000, pl_date: '2026-06-10', rev_alloc_type: 'byval', rev_alloc_sg: 2000, rev_alloc_aimfox: 2000, opex_type: 'performance' }),
  e({ amount_rsd: 7400, pl_category: 'Employee and Labour', pl_subcategory: 'Salaries', department: 'Admin', dept_subcategory: 'People', expense_description: 'Payroll', pl_date: '2026-06-28', rev_alloc_type: 'sg100', opex_type: 'opex' }),
]

function deckFor(branch: Branch, rows = ROWS, prior = PRIOR) {
  const tree = buildTree(rows, branch, 'RSD')
  return (
    <ChartDeck
      branch={branch}
      tree={tree}
      compared={withComparison(tree, buildTree(prior, branch, 'RSD'))}
      months={monthsIn(rows)}
      hidden={new Set()}
      selected={null}
      onSelect={() => {}}
      periodLabel="2026 YTD"
      priorLabel="2025 YTD"
    />
  )
}

const ALL: Branch[] = ['pl', 'department', 'stream', 'type']

describe('the deck on every branch', () => {
  it.each(ALL)('renders every panel on the %s branch without throwing', branch => {
    render(deckFor(branch))
    for (const tab of screen.getAllByRole('button').filter(b => /Trend|split|moved|Every line|Bridge|Composition|Concentration/.test(b.textContent || ''))) {
      fireEvent.click(tab)
    }
  })

  it.each(ALL)('survives a period with nothing in it on the %s branch', branch => {
    render(deckFor(branch, [], []))
    expect(screen.getByText(/Trend & mix/)).toBeInTheDocument()
  })
})

describe('which panels a branch offers', () => {
  it('offers the split only where a row is actually divided', () => {
    const { unmount } = render(deckFor('stream'))
    expect(screen.getByText('The split')).toBeInTheDocument()
    unmount()

    render(deckFor('pl'))
    expect(screen.queryByText('The split')).not.toBeInTheDocument()
  })

  it('names the two sides of the branch in the hint, not a generic word', () => {
    render(deckFor('type'))
    fireEvent.click(screen.getByText('The split'))
    expect(screen.getByText(/lean OPEX/)).toBeInTheDocument()
  })

  it('prices the split in the display currency the tree was summed in', () => {
    const { unmount } = render(deckFor('stream'))
    fireEvent.click(screen.getByText('The split'))
    expect(screen.getByText(/Social Growth · 29\.800 RSD/)).toBeInTheDocument()
    unmount()

    // The same rows read in EUR: each row's own amount_eur, a hundredth here.
    const eur = ROWS.map(r => ({ ...r, amount_eur: (r.amount_rsd as number) / 100 }))
    const tree = buildTree(eur, 'stream', 'EUR')
    render(
      <DisplayCurrencyProvider initial="EUR">
        <ChartDeck
          branch="stream" tree={tree}
          compared={withComparison(tree, buildTree(PRIOR, 'stream', 'EUR'))}
          months={monthsIn(eur)} hidden={new Set()} selected={null}
          onSelect={() => {}} periodLabel="2026 YTD" priorLabel="2025 YTD" />
      </DisplayCurrencyProvider>)
    fireEvent.click(screen.getByText('The split'))
    expect(screen.getByText(/Social Growth · 298 EUR/)).toBeInTheDocument()
  })

  it('names the streams on the stream branch', () => {
    render(deckFor('stream'))
    fireEvent.click(screen.getByText('The split'))
    expect(screen.getByText(/lean Social Growth/)).toBeInTheDocument()
  })

  /**
   * The regression this exists for: The split is open, the user switches to
   * By department, that tab does not exist there — and the deck used to go
   * blank with no clue why.
   */
  it('falls back to a panel that exists when the branch loses the open one', () => {
    const { rerender } = render(deckFor('stream'))
    fireEvent.click(screen.getByText('The split'))
    rerender(deckFor('department'))
    expect(screen.queryByText('The split')).not.toBeInTheDocument()
    expect(screen.getByText(/Monthly composition/)).toBeInTheDocument()
  })
})

describe('the panels that read a level', () => {
  it('names the depth buttons after the branch rather than "level 2"', () => {
    render(deckFor('department'))
    fireEvent.click(screen.getByText('What moved'))
    for (const level of ['Department', 'Sub-category', 'Description']) {
      expect(screen.getByText(level)).toBeInTheDocument()
    }
  })

  it('names the stream branch its own levels, not a generic "Detail"', () => {
    render(deckFor('stream'))
    fireEvent.click(screen.getByText('What moved'))
    for (const level of ['Stream', 'Category', 'Sub-category']) {
      expect(screen.getByText(level)).toBeInTheDocument()
    }
    expect(screen.queryByText('Detail')).not.toBeInTheDocument()
  })

  /** A two-level branch must not keep a third-level choice made on another. */
  it('clamps the open level when the new branch is shallower', () => {
    const { rerender } = render(deckFor('department'))
    fireEvent.click(screen.getByText('What moved'))
    fireEvent.click(screen.getByText('Description'))
    rerender(deckFor('pl'))
    expect(screen.queryByText('Description')).not.toBeInTheDocument()
    expect(screen.getByText('Sub-category')).toBeInTheDocument()
  })

  it('offers the heatmap a per-line scale', () => {
    render(deckFor('pl'))
    fireEvent.click(screen.getByText('Every line'))
    expect(screen.getByText(/Scale each line to itself/)).toBeInTheDocument()
  })

  it('prices the heatmap shades instead of leaving them as decoration', () => {
    render(deckFor('pl'))
    fireEvent.click(screen.getByText('Every line'))
    expect(screen.getByText(/MONTHLY SPEND PER LINE/)).toBeInTheDocument()
    expect(screen.getByText('nothing')).toBeInTheDocument()
  })

  it('switches the heatmap legend to shares when scaled per line', () => {
    render(deckFor('pl'))
    fireEvent.click(screen.getByText('Every line'))
    fireEvent.click(screen.getByLabelText(/Scale each line to itself/, { selector: 'input' }))
    expect(screen.getByText(/BIGGEST MONTH/)).toBeInTheDocument()
  })
})

describe('composition is the branch tree, folded', () => {
  /**
   * The treemap it replaced opened everything at once, because a treemap has
   * no other state. A tree does, and on a page with a full table under it the
   * useful arrival is closed: eleven headings, and the reader opens the one
   * they came for.
   */
  it('arrives with nothing opened', () => {
    render(deckFor('pl'))
    fireEvent.click(screen.getByText('Composition'))
    expect(screen.getByText(/Marketing/)).toBeInTheDocument()
    expect(screen.queryByText(/^▾/)).not.toBeInTheDocument()
  })

  it('offers both bulk controls where the tree is', () => {
    render(deckFor('pl'))
    fireEvent.click(screen.getByText('Composition'))
    expect(screen.getByText('Fold all')).toBeInTheDocument()
    expect(screen.getByText('Two levels')).toBeInTheDocument()
  })

  it('opens a branch when its node is clicked', () => {
    render(deckFor('pl'))
    fireEvent.click(screen.getByText('Composition'))
    fireEvent.click(screen.getByText(/Marketing/))
    expect(screen.getByText(/Ads/)).toBeInTheDocument()
  })

  it('names the period rather than calling a year to date "this month"', () => {
    render(deckFor('pl'))
    fireEvent.click(screen.getByText('Composition'))
    expect(screen.getByText(/2026 YTD/)).toBeInTheDocument()
  })

  it('draws the tree of whichever branch is open', () => {
    render(deckFor('stream'))
    fireEvent.click(screen.getByText('Composition'))
    expect(screen.getByText(/Social Growth/)).toBeInTheDocument()
  })
})

describe('the legend is a control', () => {
  it('opens a line from the legend rather than only naming it', () => {
    const picked: (string | null)[] = []
    const tree = buildTree(ROWS, 'pl', 'RSD')
    render(
      <ChartDeck
        branch="pl" tree={tree}
        compared={withComparison(tree, buildTree(PRIOR, 'pl', 'RSD'))}
        months={monthsIn(ROWS)} hidden={new Set()} selected={null}
        onSelect={k => picked.push(k)}
        periodLabel="2026 YTD" priorLabel="2025 YTD" />)

    fireEvent.click(screen.getByTitle(/Open the transactions behind Marketing/))
    expect(picked).toEqual(['Marketing'])
  })
})
