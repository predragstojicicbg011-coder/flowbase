import React from 'react'
import { act, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { MonthlyEntryList, type MonthlyEntryRow } from './MonthlyEntryList'
import { fmtMoney } from '../utils/formatters'
import { DisplayCurrencyProvider } from '../contexts/DisplayCurrencyContext'

// `EntriesModal` imports the real client for `useEntryEditor`, and the two
// dialogs it opens drag in half the app. None of it is needed here: this
// component takes its client as a prop for exactly that reason.
jest.mock('../supabase', () => ({ supabase: {} }))
jest.mock('./TransactionDialog', () => ({ __esModule: true, default: () => null }))
jest.mock('./InvoiceDialog', () => ({ __esModule: true, default: () => null }))

const money = (n: number) => fmtMoney(n, 'RSD', 0)

interface Call { table: string; ids: string[] }

/**
 * A client that answers `.in('id', …)` out of a lookup and records what was
 * asked for — which is the point of most of these tests. What the list must
 * never do is ask for every id at once: 1,137 UUIDs is ~44KB of query string
 * and PostgREST answers that with a 414.
 */
const stubClient = (byId: Record<string, any>, calls: Call[]) => ({
  from: (table: string) => ({
    select: () => ({
      in: (_col: string, ids: string[]) => {
        calls.push({ table, ids: [...ids] })
        return Promise.resolve({ data: ids.map(i => byId[i]).filter(Boolean), error: null })
      },
    }),
  }),
})

/** Three months, deliberately uneven, with a different vendor in each. */
function fixture() {
  const spec: [string, string, number, string, string][] = [
    ['s1', '2026-09-28', 1200, 'Hosting', 'Amazon Web Services'],
    ['s2', '2026-09-14', 250, 'Software', 'Slack Technologies'],
    ['s3', '2026-09-02', 50, 'Software', 'Slack Technologies'],
    ['a1', '2026-08-20', 1200, 'Hosting', 'Amazon Web Services'],
    ['a2', '2026-08-04', 100, 'Software', 'Notion Labs'],
    ['j1', '2026-07-11', 75, 'Video calls', 'Zoom Video'],
  ]
  const rows: MonthlyEntryRow[] = spec.map(([id, pl_date, amount_rsd, expense_description]) =>
    ({ id, pl_date, amount_rsd, expense_description, source: 'transaction' }))
  const byId: Record<string, any> = {}
  for (const [id, d, amt, desc, partner] of spec) {
    byId[id] = {
      id, transaction_date: d, amount: amt, amount_rsd: amt, currency: 'RSD',
      pl_category: 'Opex', department: 'Eng', expense_description: desc,
      cf_type: null, note: null, partners: { name: partner },
    }
  }
  return { rows, byId }
}

const renderList = (rows: MonthlyEntryRow[], byId: Record<string, any>) => {
  const calls: Call[] = []
  const view = render(
    <MonthlyEntryList
      rows={rows} client={stubClient(byId, calls)}
      onEdit={() => {}} busyId={null} money={money} />,
  )
  return { calls, view }
}

/** The header button for a month, which carries its label, count and total. */
const monthHeader = (label: string) =>
  screen.getByRole('button', { name: new RegExp(label) })

/** The month headers in the order they are rendered. */
const monthOrder = () =>
  screen.getAllByRole('button')
    .map(b => b.textContent || '')
    .filter(t => /(entry|entries)/.test(t))

/**
 * Lets the per-month reads that a render kicks off finish.
 *
 * The loads are deliberately not awaited by the component, so a test that
 * asserts and returns leaves React updating a tree nobody is watching.
 */
const settle = async () => { await act(async () => { await Promise.resolve() }) }

describe('a drill-down grouped by month', () => {
  it('heads each month with the complete count and total', async () => {
    const { rows, byId } = fixture()
    renderList(rows, byId)

    expect(monthHeader('September 2026')).toHaveTextContent('3 entries')
    expect(monthHeader('September 2026')).toHaveTextContent('1.500 RSD')
    expect(monthHeader('August 2026')).toHaveTextContent('2 entries')
    expect(monthHeader('August 2026')).toHaveTextContent('1.300 RSD')
    expect(monthHeader('July 2026')).toHaveTextContent('1 entry')
    expect(monthHeader('July 2026')).toHaveTextContent('75 RSD')

    await waitFor(() => expect(screen.getAllByText('Slack Technologies')).toHaveLength(2))
  })

  it('totals each month from amount_eur when the viewer reads EUR', async () => {
    const { rows, byId } = fixture()
    // Each row's own EUR figure, a hundredth of its dinars here; the one row
    // with no EUR figure counts as zero.
    const eurRows = rows.map(r => ({ ...r, amount_eur: r.id === 'j1' ? null : (r.amount_rsd as number) / 100 }))
    render(
      <DisplayCurrencyProvider initial="EUR">
        <MonthlyEntryList
          rows={eurRows} client={stubClient(byId, [])}
          onEdit={() => {}} busyId={null} money={n => fmtMoney(n, 'EUR', 0)} />
      </DisplayCurrencyProvider>)
    expect(monthHeader('September 2026')).toHaveTextContent('15 EUR')
    expect(monthHeader('August 2026')).toHaveTextContent('13 EUR')
    expect(monthHeader('July 2026')).toHaveTextContent('0 EUR')
    await settle()
  })

  it('heads every month before anything at all has been fetched', async () => {
    // The figures are computed from the rows the page already holds, so they
    // are on screen in the first paint — not after a round trip, and never
    // from a fetch that the 300-row cap could have truncated. Only the newest
    // month's own entries are even asked for, and not before this assertion.
    const { rows, byId } = fixture()
    const { calls } = renderList(rows, byId)
    expect(calls.flatMap(c => c.ids)).not.toContain('a1')
    expect(monthHeader('August 2026')).toHaveTextContent('2 entries')
    expect(monthHeader('August 2026')).toHaveTextContent('1.300 RSD')
    await settle()
  })

  it('lists the months newest first', async () => {
    const { rows, byId } = fixture()
    renderList(rows, byId)
    const labels = monthOrder()
    expect(labels[0]).toContain('September 2026')
    expect(labels[1]).toContain('August 2026')
    expect(labels[2]).toContain('July 2026')
    await settle()
  })

  it('opens the newest month and fetches only that month', async () => {
    const { rows, byId } = fixture()
    const { calls } = renderList(rows, byId)

    await waitFor(() => expect(screen.getByText('Amazon Web Services')).toBeInTheDocument())
    expect(calls).toHaveLength(1)
    expect(calls[0].ids.sort()).toEqual(['s1', 's2', 's3'])
    expect(screen.queryByText('Notion Labs')).not.toBeInTheDocument()
  })

  it('fetches a month only when that month is opened, one month per query', async () => {
    const { rows, byId } = fixture()
    const { calls } = renderList(rows, byId)
    await waitFor(() => expect(screen.getByText('Amazon Web Services')).toBeInTheDocument())

    fireEvent.click(monthHeader('August 2026'))
    await waitFor(() => expect(screen.getByText('Notion Labs')).toBeInTheDocument())

    expect(calls).toHaveLength(2)
    expect(calls[1].ids.sort()).toEqual(['a1', 'a2'])
    // The regression this guards: one `.in('id', …)` carrying every id of the
    // whole line. No request may ever hold more ids than its month has rows.
    expect(Math.max(...calls.map(c => c.ids.length))).toBeLessThan(rows.length)
    expect(calls.every(c => c.ids.length <= 3)).toBe(true)
  })

  it('does not re-fetch a month that is closed and opened again', async () => {
    const { rows, byId } = fixture()
    const { calls } = renderList(rows, byId)
    await waitFor(() => expect(screen.getAllByText('Slack Technologies')).toHaveLength(2))

    fireEvent.click(monthHeader('September 2026'))
    expect(screen.queryAllByText('Slack Technologies')).toHaveLength(0)
    fireEvent.click(monthHeader('September 2026'))
    await waitFor(() => expect(screen.getAllByText('Slack Technologies')).toHaveLength(2))
    expect(calls).toHaveLength(1)
  })
})

describe('filtering a drill-down', () => {
  const type = (value: string) =>
    fireEvent.change(screen.getByLabelText('Filter these transactions'), { target: { value } })

  it('narrows the month counts and totals by amount without fetching anything', async () => {
    const { rows, byId } = fixture()
    const { calls } = renderList(rows, byId)
    await waitFor(() => expect(screen.getAllByText('Slack Technologies')).toHaveLength(2))
    const before = calls.length

    type('1200')

    await waitFor(() => expect(monthHeader('September 2026')).toHaveTextContent('1 entry'))
    expect(monthHeader('September 2026')).toHaveTextContent('1.200 RSD')
    expect(monthHeader('August 2026')).toHaveTextContent('1 entry')
    expect(monthHeader('August 2026')).toHaveTextContent('1.200 RSD')
    expect(monthHeader('July 2026')).toHaveTextContent('0 entries')
    // An amount lives on the rows the page already holds, so the answer needs
    // no round trip: August's figures moved without August ever being read.
    expect(calls).toHaveLength(before)
    expect(screen.getByText(/2 of 6 transactions/)).toBeInTheDocument()
  })

  it('honours a comparison', async () => {
    const { rows, byId } = fixture()
    renderList(rows, byId)
    type('>=1000')
    await waitFor(() => expect(screen.getByText(/2 of 6 transactions/)).toBeInTheDocument())
    expect(monthHeader('July 2026')).toHaveTextContent('0 entries')
  })

  it('finds a vendor in a month that was never opened', async () => {
    // Zoom is in July, which is collapsed and unread, and the name exists
    // only in the detail. A search that covered the opened months only would
    // answer "nothing matches" for a row that is plainly there.
    const { rows, byId } = fixture()
    const { calls } = renderList(rows, byId)
    await waitFor(() => expect(screen.getAllByText('Slack Technologies')).toHaveLength(2))

    type('Zoom')

    await waitFor(() => expect(screen.getByText('Zoom Video')).toBeInTheDocument(), { timeout: 3000 })
    expect(screen.getByText(/1 of 6 transactions/)).toBeInTheDocument()
    expect(monthHeader('July 2026')).toHaveTextContent('1 entry')
    expect(monthHeader('September 2026')).toHaveTextContent('0 entries')
    // Every month was read, and still one query per month.
    expect(calls).toHaveLength(3)
    expect(calls.every(c => c.ids.length <= 3)).toBe(true)
  })

  it('searches the expense description as well as the vendor', async () => {
    const { rows, byId } = fixture()
    renderList(rows, byId)
    type('hosting')
    await waitFor(() => expect(screen.getByText(/2 of 6 transactions/)).toBeInTheDocument(),
      { timeout: 3000 })
  })

  it('says so when nothing matches', async () => {
    const { rows, byId } = fixture()
    renderList(rows, byId)
    type('Figma')
    await waitFor(() => expect(screen.getByText(/Nothing matches/)).toBeInTheDocument(),
      { timeout: 3000 })
  })

  it('collapses back to the newest month when the filter is cleared', async () => {
    const { rows, byId } = fixture()
    const { calls } = renderList(rows, byId)
    await waitFor(() => expect(screen.getAllByText('Slack Technologies')).toHaveLength(2))

    type('Zoom')
    await waitFor(() => expect(screen.getByText('Zoom Video')).toBeInTheDocument(), { timeout: 3000 })

    type('')
    await waitFor(() => expect(screen.queryByText('Zoom Video')).not.toBeInTheDocument(),
      { timeout: 3000 })
    expect(screen.getAllByText('Slack Technologies')).toHaveLength(2)
    expect(monthHeader('July 2026')).toHaveTextContent('1 entry')
  })
})

describe('a drill-down with a month bigger than the fetch cap', () => {
  /** 400 rows in one month — past DRILL_CAP, which is 300. */
  function bigMonth() {
    const rows: MonthlyEntryRow[] = []
    const byId: Record<string, any> = {}
    for (let i = 0; i < 400; i++) {
      const id = `b${String(i).padStart(3, '0')}`
      const d = `2026-09-${String((i % 28) + 1).padStart(2, '0')}`
      rows.push({ id, pl_date: d, amount_rsd: 10, expense_description: 'Ads', source: 'transaction' })
      byId[id] = {
        id, transaction_date: d, amount: 10, amount_rsd: 10, currency: 'RSD',
        pl_category: 'Opex', department: 'Growth', expense_description: 'Ads',
        cf_type: null, note: null, partners: { name: `Vendor ${i}` },
      }
    }
    return { rows, byId }
  }

  it('still heads the month with all 400, and says the list is short', async () => {
    const { rows, byId } = bigMonth()
    const { calls } = renderList(rows, byId)

    // The header is the whole month whatever the fetch managed to bring back.
    expect(monthHeader('September 2026')).toHaveTextContent('400 entries')
    expect(monthHeader('September 2026')).toHaveTextContent('4.000 RSD')

    await waitFor(() =>
      expect(screen.getByText(/only the 300 most recent could be/)).toBeInTheDocument())
    expect(screen.getByText(/the September 2026 total above counts/)).toBeInTheDocument()
    expect(calls).toHaveLength(1)
    expect(calls[0].ids).toHaveLength(300)
  })

  it('warns that a text search could not see every row', async () => {
    const { rows, byId } = bigMonth()
    renderList(rows, byId)
    fireEvent.change(screen.getByLabelText('Filter these transactions'), { target: { value: 'Vendor 7' } })
    await waitFor(() =>
      expect(screen.getByText(/could not all be\s+read back/)).toBeInTheDocument(), { timeout: 3000 })
  })
})

describe('a drill-down whose rows change', () => {
  it('throws away the previous line\'s entries', async () => {
    const { rows, byId } = fixture()
    const calls: Call[] = []
    const client = stubClient(byId, calls)
    const { rerender } = render(
      <MonthlyEntryList rows={rows} client={client} onEdit={() => {}} busyId={null} money={money} />)
    await waitFor(() => expect(screen.getAllByText('Slack Technologies')).toHaveLength(2))

    rerender(
      <MonthlyEntryList rows={rows.slice(3)} client={client} onEdit={() => {}} busyId={null} money={money} />)

    expect(screen.queryAllByText('Slack Technologies')).toHaveLength(0)
    expect(screen.queryByText('September 2026')).not.toBeInTheDocument()
    await waitFor(() => expect(screen.getByText('Notion Labs')).toBeInTheDocument())
  })

  it('renders nothing but a note when the line has no rows at all', () => {
    renderList([], {})
    expect(screen.getByText('No entries found for this line.')).toBeInTheDocument()
  })
})

describe('the edit path', () => {
  it('gives every listed row its own Edit button pointed at its own table', async () => {
    const { rows, byId } = fixture()
    const seen: { table: string; id: string }[] = []
    const calls: Call[] = []
    render(
      <MonthlyEntryList rows={rows} client={stubClient(byId, calls)}
        onEdit={t => seen.push(t)} busyId={null} money={money} />)

    await waitFor(() => expect(screen.getAllByText('Slack Technologies')).toHaveLength(2))
    const edits = screen.getAllByRole('button', { name: 'Edit' })
    expect(edits).toHaveLength(3)
    fireEvent.click(edits[0])
    expect(seen).toEqual([{ table: 'transactions', id: 's1' }])
  })

  it('marks only the busy row as busy', async () => {
    const { rows, byId } = fixture()
    const calls: Call[] = []
    render(
      <MonthlyEntryList rows={rows} client={stubClient(byId, calls)}
        onEdit={() => {}} busyId="s2" money={money} />)

    await waitFor(() => expect(screen.getAllByText('Slack Technologies')).toHaveLength(2))
    expect(screen.getAllByRole('button', { name: '…' })).toHaveLength(1)
    expect(screen.getAllByRole('button', { name: 'Edit' })).toHaveLength(2)
  })
})

describe('what a month row shows', () => {
  it('puts each month\'s own entries under its own header', async () => {
    const { rows, byId } = fixture()
    renderList(rows, byId)
    await waitFor(() => expect(screen.getAllByText('Slack Technologies')).toHaveLength(2))
    fireEvent.click(monthHeader('July 2026'))
    await waitFor(() => expect(screen.getByText('Zoom Video')).toBeInTheDocument())

    const july = monthHeader('July 2026').parentElement as HTMLElement
    expect(within(july).getByText('Zoom Video')).toBeInTheDocument()
    expect(within(july).queryAllByText('Slack Technologies')).toHaveLength(0)
  })
})
