import React from 'react'
import { render, screen, fireEvent } from '@testing-library/react'
import { ChartDeck } from './ExpenseVisuals'
import { buildTree, withComparison, monthsIn, BRANCHES, type PlEntry, type Branch } from '../services/expenseTree'
import { OVERHEAD_LABEL } from '../services/projects'
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

const A = { project_id: 'p1', project_name: 'Zgrada A' }
const B = { project_id: 'p2', project_name: 'Hala B' }

const ROWS: PlEntry[] = [
  e({ amount_rsd: 12000, amount: 12000, pl_date: '2026-07-10', ...A }),
  e({ amount_rsd: 18000, amount: 18000, pl_date: '2026-08-10', ...B }),
  e({ amount_rsd: 7400, pl_category: 'Employee and Labour', pl_subcategory: 'Salaries', department: 'Admin', dept_subcategory: 'People', expense_description: 'Payroll', pl_date: '2026-07-28', ...A }),
  e({ amount_rsd: 7400, pl_category: 'Employee and Labour', pl_subcategory: 'Salaries', department: 'Admin', dept_subcategory: 'People', expense_description: 'Payroll', pl_date: '2026-08-28', ...A }),
  e({ amount_rsd: 980, pl_category: 'General Business', pl_subcategory: 'Software', department: 'Admin', dept_subcategory: 'Tools', expense_description: 'Figma', pl_date: '2026-08-03', project_id: null }),
]

const PRIOR: PlEntry[] = [
  e({ amount_rsd: 4000, amount: 4000, pl_date: '2026-06-10', ...B }),
  e({ amount_rsd: 7400, pl_category: 'Employee and Labour', pl_subcategory: 'Salaries', department: 'Admin', dept_subcategory: 'People', expense_description: 'Payroll', pl_date: '2026-06-28', ...A }),
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

const ALL: Branch[] = [...BRANCHES]

describe('the deck on every branch', () => {
  it.each(ALL)('renders every panel on the %s branch without throwing', branch => {
    render(deckFor(branch))
    for (const tab of screen.getAllByRole('button').filter(b => /Trend|moved|Every line|Bridge|Composition|Concentration/.test(b.textContent || ''))) {
      fireEvent.click(tab)
    }
  })

  it.each(ALL)('survives a period with nothing in it on the %s branch', branch => {
    render(deckFor(branch, [], []))
    expect(screen.getByText(/Trend i struktura/)).toBeInTheDocument()
  })
})

describe('which panels a branch offers', () => {
  it('offers the same six panels on every branch, and no two-sided split', () => {
    for (const b of ALL) {
      const { unmount } = render(deckFor(b))
      for (const t of ['Trend i struktura', 'Šta se promenilo', 'Sve stavke', 'Most', 'Sastav', 'Koncentracija']) {
        expect(screen.getByText(t)).toBeInTheDocument()
      }
      expect(screen.queryByText('The split')).not.toBeInTheDocument()
      unmount()
    }
  })

  it('says what the trend means on the project branch', () => {
    render(deckFor('project'))
    expect(screen.getByText(/koji projekti nose trošak/)).toBeInTheDocument()
  })

  it('bands the trend by project, overhead included, in the legend', () => {
    render(deckFor('project'))
    expect(screen.getByTitle(/Otvori transakcije za: Zgrada A/)).toBeInTheDocument()
    expect(screen.getByTitle(new RegExp(`Otvori transakcije za: ${OVERHEAD_LABEL}`))).toBeInTheDocument()
  })

  it('keeps a panel open across a branch change', () => {
    const { rerender } = render(deckFor('project'))
    fireEvent.click(screen.getByText('Most'))
    rerender(deckFor('department'))
    expect(screen.getByText(/Šta je prethodni ukupan iznos/)).toBeInTheDocument()
  })
})

describe('the panels that read a level', () => {
  it('names the depth buttons after the branch rather than "level 2"', () => {
    render(deckFor('department'))
    fireEvent.click(screen.getByText('Šta se promenilo'))
    for (const level of ['Sektor', 'Podsektor', 'Opis']) {
      expect(screen.getByText(level)).toBeInTheDocument()
    }
  })

  it('names the project branch its own levels, not a generic "Detail"', () => {
    render(deckFor('project'))
    fireEvent.click(screen.getByText('Šta se promenilo'))
    for (const level of ['Projekat', 'Kategorija', 'Potkategorija']) {
      expect(screen.getByText(level)).toBeInTheDocument()
    }
    expect(screen.queryByText('Detail')).not.toBeInTheDocument()
  })

  /** A two-level branch must not keep a third-level choice made on another. */
  it('clamps the open level when the new branch is shallower', () => {
    const { rerender } = render(deckFor('department'))
    fireEvent.click(screen.getByText('Šta se promenilo'))
    fireEvent.click(screen.getByText('Opis'))
    rerender(deckFor('pl'))
    expect(screen.queryByText('Opis')).not.toBeInTheDocument()
    expect(screen.getByText('Potkategorija')).toBeInTheDocument()
  })

  it('offers the heatmap a per-line scale', () => {
    render(deckFor('pl'))
    fireEvent.click(screen.getByText('Sve stavke'))
    expect(screen.getByText(/Svaka stavka u sopstvenoj razmeri/)).toBeInTheDocument()
  })

  it('prices the heatmap shades instead of leaving them as decoration', () => {
    render(deckFor('pl'))
    fireEvent.click(screen.getByText('Sve stavke'))
    expect(screen.getByText(/MESEČNI TROŠAK PO STAVCI/)).toBeInTheDocument()
    expect(screen.getByText('ništa')).toBeInTheDocument()
  })

  it('switches the heatmap legend to shares when scaled per line', () => {
    render(deckFor('pl'))
    fireEvent.click(screen.getByText('Sve stavke'))
    fireEvent.click(screen.getByLabelText(/Svaka stavka u sopstvenoj razmeri/, { selector: 'input' }))
    expect(screen.getByText(/NAJVEĆEM MESECU/)).toBeInTheDocument()
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
    fireEvent.click(screen.getByText('Sastav'))
    expect(screen.getByText(/Marketing/)).toBeInTheDocument()
    expect(screen.queryByText(/^▾/)).not.toBeInTheDocument()
  })

  it('offers both bulk controls where the tree is', () => {
    render(deckFor('pl'))
    fireEvent.click(screen.getByText('Sastav'))
    expect(screen.getByText('Sklopi sve')).toBeInTheDocument()
    expect(screen.getByText('Dva nivoa')).toBeInTheDocument()
  })

  it('opens a branch when its node is clicked', () => {
    render(deckFor('pl'))
    fireEvent.click(screen.getByText('Sastav'))
    fireEvent.click(screen.getByText(/Marketing/))
    expect(screen.getByText(/Ads/)).toBeInTheDocument()
  })

  it('names the period rather than calling a year to date "this month"', () => {
    render(deckFor('pl'))
    fireEvent.click(screen.getByText('Sastav'))
    expect(screen.getByText(/2026 YTD/)).toBeInTheDocument()
  })

  it('draws the tree of whichever branch is open', () => {
    render(deckFor('project'))
    fireEvent.click(screen.getByText('Sastav'))
    expect(screen.getByText(/Hala B/)).toBeInTheDocument()
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

    fireEvent.click(screen.getByTitle(/Otvori transakcije za: Marketing/))
    expect(picked).toEqual(['Marketing'])
  })
})
