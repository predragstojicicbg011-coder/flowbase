import React, { useState } from 'react'
import { fireEvent, render, screen } from '@testing-library/react'
import SearchableSelect, {
  DEFAULT_SEARCH_THRESHOLD, filterOptions, highlightForQuery, listView,
  matchesQuery, moveHighlight, needsSearch, panelPlacement, selectedLabel,
  type AnchorRect, type SelectOption,
} from './SearchableSelect'

const opts = (...labels: string[]): SelectOption[] => labels.map(l => ({ value: l, label: l }))

// The real thing: hundreds of partners, in no order a person can scan.
const partners: SelectOption[] = [
  { value: 'p1', label: '" AMS OSIGURANJE "- AKCIONARSKO DRUSTVO ZA OSIGURANJE A.D.O. BEOGRAD ,' },
  { value: 'p2', label: 'Amazon Web Services EMEA SARL' },
  { value: 'p3', label: 'Slack Technologies' },
  { value: 'p4', label: 'NOTION LABS INC' },
  ...Array.from({ length: 20 }, (_, i) => ({ value: `x${i}`, label: `Filler Vendor ${i}` })),
]

describe('matching', () => {
  it('is a case-insensitive substring, not a prefix', () => {
    expect(matchesQuery('Amazon Web Services EMEA SARL', 'web')).toBe(true)
    expect(matchesQuery('NOTION LABS INC', 'notion')).toBe(true)
    expect(matchesQuery('Slack Technologies', 'ck tech')).toBe(true)
    expect(matchesQuery('Slack Technologies', 'zzz')).toBe(false)
  })

  it('treats an empty or blank query as matching everything', () => {
    expect(matchesQuery('anything', '')).toBe(true)
    expect(matchesQuery('anything', '   ')).toBe(true)
    expect(filterOptions(partners, '  ')).toHaveLength(partners.length)
  })

  it('ignores whitespace around the query', () => {
    expect(filterOptions(partners, '  slack  ').map(o => o.value)).toEqual(['p3'])
  })
})

describe('what the list shows for a query', () => {
  it('pins "All …" at the top and does not filter it away', () => {
    const view = listView(partners, 'slack', 'All partners')
    expect(view.items[0]).toEqual({ value: '', label: 'All partners' })
    expect(view.items.map(i => i.value)).toEqual(['', 'p3'])
  })

  it('reports nothing matched, and still offers the pin', () => {
    const view = listView(partners, 'qqqq', 'All partners')
    expect(view.empty).toBe(true)
    expect(view.matches).toHaveLength(0)
    expect(view.items).toEqual([{ value: '', label: 'All partners' }])
  })

  it('does not count the pin as a match when the query resembles its own text', () => {
    // "All partners" contains "all part" — but the pin is chrome, not an
    // option, so a query only it would match is still a query that matched
    // nothing. Counting it would claim a result the user cannot use.
    const view = listView(partners, 'all part', 'All partners')
    expect(view.empty).toBe(true)
    expect(view.items.filter(i => i.label === 'All partners')).toHaveLength(1)
  })

  it('lets a query match real options that also contain the pin\'s words', () => {
    const view = listView(opts('All Seasons Doo', 'Beta'), 'all', 'All partners')
    expect(view.matches.map(o => o.label)).toEqual(['All Seasons Doo'])
    expect(view.empty).toBe(false)
    expect(view.items).toHaveLength(2)
  })

  it('shows every option, pin first, when nothing is typed', () => {
    const view = listView(partners, '', 'All partners')
    expect(view.items).toHaveLength(partners.length + 1)
    expect(view.empty).toBe(false)
  })
})

describe('moving the highlight', () => {
  it('clamps at both ends instead of wrapping', () => {
    expect(moveHighlight(0, -1, 5)).toBe(0)
    expect(moveHighlight(4, 1, 5)).toBe(4)
    expect(moveHighlight(2, 1, 5)).toBe(3)
    expect(moveHighlight(2, -1, 5)).toBe(1)
  })

  it('has nowhere to go in an empty list', () => {
    expect(moveHighlight(-1, 1, 0)).toBe(-1)
    expect(moveHighlight(0, 1, 0)).toBe(-1)
  })

  it('enters the list from nothing highlighted', () => {
    expect(moveHighlight(-1, 1, 3)).toBe(0)
  })

  it('lands on the first match after typing, on the pin after clearing, nowhere when nothing matched', () => {
    expect(highlightForQuery(partners, 'slack', 'All partners')).toBe(1)
    expect(highlightForQuery(partners, '', 'All partners')).toBe(0)
    expect(highlightForQuery(partners, 'qqqq', 'All partners')).toBe(-1)
  })
})

describe('the search-box threshold', () => {
  it('defaults to around ten and counts the options, not the pin', () => {
    expect(DEFAULT_SEARCH_THRESHOLD).toBe(10)
    expect(needsSearch(9, DEFAULT_SEARCH_THRESHOLD)).toBe(false)
    expect(needsSearch(10, DEFAULT_SEARCH_THRESHOLD)).toBe(true)
    expect(needsSearch(400, DEFAULT_SEARCH_THRESHOLD)).toBe(true)
  })
})

describe('the label on the closed control', () => {
  it('is the "All …" text when nothing is selected', () => {
    expect(selectedLabel(partners, '', 'All partners')).toBe('All partners')
  })

  it('is the option label when the value is known', () => {
    expect(selectedLabel(partners, 'p3', 'All partners')).toBe('Slack Technologies')
  })

  it('is the value itself when it is not in the list', () => {
    // A filter outlives the row that justified it. Showing "All partners"
    // here would say the list is unfiltered while it is not.
    expect(selectedLabel(partners, 'p999', 'All partners')).toBe('p999')
    expect(selectedLabel([], 'Retired department', 'All departments')).toBe('Retired department')
  })
})

// ── The component ───────────────────────────────────────────────────────────

/** A controlled host, so a test can assert on what the value actually became. */
function Host({ initial = '', options = partners, threshold }: {
  initial?: string; options?: SelectOption[]; threshold?: number
}) {
  const [v, setV] = useState(initial)
  return (
    <>
      <SearchableSelect value={v} onChange={setV} options={options}
        allLabel="All partners" searchThreshold={threshold} />
      <span data-testid="value">{v || '(none)'}</span>
    </>
  )
}

const control = () => screen.getByRole('combobox')
const box = () => screen.getByRole('textbox')
const optionLabels = () => screen.getAllByRole('option').map(o => o.textContent)
const value = () => screen.getByTestId('value').textContent

describe('SearchableSelect', () => {
  it('shows the selection when closed and opens to a search box and a list', () => {
    render(<Host initial="p3" />)
    expect(control()).toHaveTextContent('Slack Technologies')
    expect(screen.queryByRole('listbox')).toBeNull()

    fireEvent.click(control())
    expect(screen.getByRole('listbox')).toBeInTheDocument()
    expect(box()).toHaveFocus()
    expect(optionLabels()).toHaveLength(partners.length + 1)
  })

  it('filters case-insensitively on a substring', () => {
    render(<Host />)
    fireEvent.click(control())
    fireEvent.change(box(), { target: { value: 'web serv' } })
    expect(optionLabels()).toEqual(['All partners', 'Amazon Web Services EMEA SARL'])
  })

  it('says so when nothing matches, rather than showing an empty box', () => {
    render(<Host />)
    fireEvent.click(control())
    fireEvent.change(box(), { target: { value: 'zzzz' } })
    expect(screen.getByText('No matches')).toBeInTheDocument()
    expect(optionLabels()).toEqual(['All partners'])
  })

  it('keeps "All partners" reachable under a query that matches no option', () => {
    render(<Host initial="p3" />)
    fireEvent.click(control())
    fireEvent.change(box(), { target: { value: 'all partners' } })
    expect(screen.getByText('No matches')).toBeInTheDocument()
    fireEvent.click(screen.getByRole('option', { name: 'All partners' }))
    expect(value()).toBe('(none)')
  })

  it('does nothing when Enter is pressed on an empty filtered list', () => {
    render(<Host initial="p3" />)
    fireEvent.click(control())
    fireEvent.change(box(), { target: { value: 'nothing here' } })
    fireEvent.keyDown(box(), { key: 'Enter' })

    expect(value()).toBe('p3')                              // unchanged
    expect(screen.getByRole('listbox')).toBeInTheDocument() // and still open
  })

  it('picks the first match on Enter after typing', () => {
    render(<Host />)
    fireEvent.click(control())
    fireEvent.change(box(), { target: { value: 'notion' } })
    fireEvent.keyDown(box(), { key: 'Enter' })
    expect(value()).toBe('p4')
    expect(screen.queryByRole('listbox')).toBeNull()
  })

  it('moves the highlight with the arrows and picks it with Enter', () => {
    render(<Host />)
    fireEvent.click(control())
    fireEvent.change(box(), { target: { value: 'vendor 1' } })
    // All partners, Filler Vendor 1, 10..19 — the highlight starts on the
    // first match, so one ArrowDown reaches the second.
    fireEvent.keyDown(box(), { key: 'ArrowDown' })
    fireEvent.keyDown(box(), { key: 'Enter' })
    expect(value()).toBe('x10')
  })

  it('does not run off either end of the list', () => {
    render(<Host initial="p4" />)
    fireEvent.click(control())
    fireEvent.change(box(), { target: { value: 'slack' } })
    fireEvent.keyDown(box(), { key: 'ArrowUp' })
    fireEvent.keyDown(box(), { key: 'ArrowUp' })   // already on the pin
    fireEvent.keyDown(box(), { key: 'Enter' })
    expect(value()).toBe('(none)')   // clamped onto the pin, not past it
  })

  it('leaves the previous value intact on Escape', () => {
    render(<Host initial="p3" />)
    fireEvent.click(control())
    fireEvent.change(box(), { target: { value: 'notion' } })
    fireEvent.keyDown(box(), { key: 'Escape' })

    expect(screen.queryByRole('listbox')).toBeNull()
    expect(value()).toBe('p3')
    expect(control()).toHaveTextContent('Slack Technologies')

    // And the abandoned query does not survive into the next open.
    fireEvent.click(control())
    expect(box()).toHaveValue('')
    expect(optionLabels()).toHaveLength(partners.length + 1)
  })

  it('closes on Tab without changing anything', () => {
    render(<Host initial="p3" />)
    fireEvent.click(control())
    fireEvent.change(box(), { target: { value: 'notion' } })
    fireEvent.keyDown(box(), { key: 'Tab' })
    expect(screen.queryByRole('listbox')).toBeNull()
    expect(value()).toBe('p3')
  })

  it('closes when the user clicks outside it', () => {
    render(<><Host /><button>elsewhere</button></>)
    fireEvent.click(control())
    expect(screen.getByRole('listbox')).toBeInTheDocument()
    fireEvent.mouseDown(screen.getByText('elsewhere'))
    expect(screen.queryByRole('listbox')).toBeNull()
  })

  it('picks an option from a real press — mousedown, then click', () => {
    // THE REGRESSION. A mouse fires mousedown before click. The panel lives in
    // a portal, so it is not a DOM descendant of the control, and the
    // outside-click check closed it on that mousedown — the option unmounted
    // and the click that would have picked it landed on nothing. Every
    // dropdown in the app stopped accepting a click and the suite did not
    // notice, because `fireEvent.click` fires no mousedown.
    render(<Host />)
    fireEvent.click(control())
    const option = screen.getByText('Amazon Web Services EMEA SARL')

    fireEvent.mouseDown(option)
    expect(screen.getByRole('listbox')).toBeInTheDocument()

    fireEvent.click(option)
    expect(value()).toBe('p2')
    expect(screen.queryByRole('listbox')).toBeNull()
  })

  it('stays open for a press on the search box, which is in the panel too', () => {
    render(<Host />)
    fireEvent.click(control())
    fireEvent.mouseDown(screen.getByPlaceholderText(/type to filter/i))
    expect(screen.getByRole('listbox')).toBeInTheDocument()
  })

  it('renders a selected value that is not in the options', () => {
    render(<Host initial="Retired department" options={opts('Sales', 'Ops')} />)
    expect(control()).toHaveTextContent('Retired department')
    expect(control()).not.toHaveTextContent('All partners')
  })

  it('offers no search box over a short list, and still works as a dropdown', () => {
    render(<Host options={opts('Expense', 'Revenue')} />)
    fireEvent.click(control())
    expect(screen.queryByRole('textbox')).toBeNull()
    expect(optionLabels()).toEqual(['All partners', 'Expense', 'Revenue'])

    fireEvent.keyDown(control(), { key: 'ArrowDown' })
    fireEvent.keyDown(control(), { key: 'Enter' })
    expect(value()).toBe('Expense')
  })

  it('takes the threshold from the caller', () => {
    render(<Host options={opts('a', 'b')} threshold={2} />)
    fireEvent.click(control())
    expect(screen.getByRole('textbox')).toBeInTheDocument()
  })

  it('opens from the keyboard when closed', () => {
    render(<Host />)
    fireEvent.keyDown(control(), { key: 'ArrowDown' })
    expect(screen.getByRole('listbox')).toBeInTheDocument()
  })

  it('hangs the panel off the left of the control by default', () => {
    render(<Host />)
    fireEvent.click(control())
    const panel = screen.getByRole('listbox').parentElement as HTMLElement
    // Viewport coordinates, not offsets from the control: the panel is fixed
    // and portalled to `document.body` so that no scrolling ancestor — an
    // entry dialog's body, above all — can clip it. jsdom measures every rect
    // as zero, so the left edge is the gutter.
    expect(panel.style.position).toBe('fixed')
    expect(panel.style.left).toBe('8px')
    expect(panel.style.right).toBe('')
  })

  it('renders the panel outside the control, where no overflow can clip it', () => {
    render(<Host />)
    fireEvent.click(control())
    const panel = screen.getByRole('listbox').parentElement as HTMLElement
    expect(control().contains(panel)).toBe(false)
    expect(panel.closest('body')).toBe(document.body)
  })

  it('flips the panel when the control sits near the right edge', () => {
    // The page's scroll container would clip a left-hung panel here, and the
    // user would have to scroll sideways to find a list they just opened.
    const rect = jest.spyOn(HTMLElement.prototype, 'getBoundingClientRect')
      .mockReturnValue({ left: 900, top: 0, right: 1000, bottom: 30, width: 100, height: 30, x: 900, y: 0, toJSON: () => ({}) } as DOMRect)
    try {
      render(<Host />)
      fireEvent.click(control())
      const panel = screen.getByRole('listbox').parentElement as HTMLElement
      // jsdom's window is 1024 wide, so the panel is pinned 24px from its
      // right edge — 1024 - 1000 — rather than hung off the control's left.
      expect(panel.style.right).toBe('24px')
      expect(panel.style.left).toBe('')
    } finally {
      rect.mockRestore()
    }
  })

  it('reports the option value, not its label', () => {
    render(<Host />)
    fireEvent.click(control())
    fireEvent.click(screen.getByRole('option', { name: 'Slack Technologies' }))
    expect(value()).toBe('p3')
  })
})

// ─── Where the open panel goes ──────────────────────────────────────────────
//
// The control now serves the entry dialogs, whose bodies scroll. The panel is
// fixed and portalled so nothing clips it, which makes its position this
// function's whole responsibility.

describe('panelPlacement', () => {
  const VIEW = { width: 1200, height: 800 }
  const at = (over: Partial<AnchorRect>): AnchorRect =>
    ({ left: 100, right: 300, top: 200, bottom: 230, width: 200, ...over })

  it('hangs off the left edge of the control and drops downwards', () => {
    const p = panelPlacement(at({}), VIEW)
    expect(p.left).toBe(100)
    expect(p.right).toBeUndefined()
    expect(p.top).toBe(234)
    expect(p.bottom).toBeUndefined()
  })

  it('matches the control width, so the panel never looks narrower than it', () => {
    expect(panelPlacement(at({ width: 240 }), VIEW).minWidth).toBe(240)
  })

  it('flips to the right edge when a left-hung panel would run off screen', () => {
    const p = panelPlacement(at({ left: 1100, right: 1180 }), VIEW)
    expect(p.left).toBeUndefined()
    expect(p.right).toBe(20)           // 1200 - 1180
  })

  it('drops upwards when there is no room below and more room above', () => {
    // A control near the bottom of the window: 40px below, 700 above.
    const p = panelPlacement(at({ top: 700, bottom: 760 }), VIEW)
    expect(p.top).toBeUndefined()
    expect(p.bottom).toBe(104)         // 800 - 700 + 4
    expect(p.maxHeight).toBe(320)      // capped by the maximum, not by the room
  })

  it('stays downwards when below is tight but above is tighter', () => {
    // A control near the TOP: only 60 above, 700 below is plenty anyway.
    const p = panelPlacement(at({ top: 60, bottom: 90 }), VIEW)
    expect(p.top).toBe(94)
  })

  it('does not flip up for a merely shortish gap below', () => {
    // 160px below clears the minimum, so downwards — where a dropdown belongs
    // — wins even though there is far more room above.
    const p = panelPlacement(at({ top: 600, bottom: 632 }), VIEW)
    expect(p.top).toBe(636)
  })

  it('shortens the panel rather than letting it run past the window', () => {
    // 150px of room below: over the minimum, so it drops there — but the list
    // must be capped to the room, not to its maximum.
    const p = panelPlacement(at({ top: 590, bottom: 642 }), VIEW)
    expect(p.top).toBe(646)
    expect(p.maxHeight).toBe(146)      // 800 - 642 - 4 offset - 8 gutter
    expect(p.maxHeight).toBeLessThan(320)
  })

  it('never reports a negative height for a control off the bottom', () => {
    const p = panelPlacement(at({ top: 900, bottom: 940 }), VIEW)
    expect(p.maxHeight).toBeGreaterThanOrEqual(0)
  })

  it('keeps a gutter rather than touching the window edge', () => {
    expect(panelPlacement(at({ left: 0, right: 200 }), VIEW).left).toBe(8)
  })

  it('places top-left when there is no layout to measure', () => {
    // jsdom, and any first paint: every edge reads zero.
    const p = panelPlacement({ left: 0, right: 0, top: 0, bottom: 0, width: 0 }, VIEW)
    expect(p.left).toBe(8)
    expect(p.top).toBe(4)
  })
})
