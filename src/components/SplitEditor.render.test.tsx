import React, { useState } from 'react'
import { render, screen, fireEvent } from '@testing-library/react'
import SplitEditor from './SplitEditor'
import { type SplitLine, type ScriptLike } from '../services/expenseSplit'

jest.mock('../supabase', () => ({ supabase: {} }))

const SCRIPTS: ScriptLike[] = [
  {
    id: 's1', name: 'Figma', icon: '⚡',
    pl_category: 'General Business', pl_subcategory: 'Software subscriptions',
    department: 'Admin', dept_subcategory: 'Tools', expense_description: 'Figma',
    rev_alloc: 'sg100', opex_type: 'opex', cf_type: 'recurring',
  },
  {
    id: 's2', name: 'Laptops', icon: '💻',
    pl_category: 'Capital expenditures', pl_subcategory: 'Hardware',
    department: 'Product', dept_subcategory: 'Equipment', expense_description: 'Laptop',
    rev_alloc: 'shared', opex_type: 'opex', cf_type: 'one_off',
  },
]

/** The editor hands lines back; a host has to keep them. */
function Host({ amount = 120000 }: { amount?: number }) {
  const [lines, setLines] = useState<SplitLine[]>([])
  return (
    <SplitEditor
      parent={{ amount, currency: 'RSD', exchange_rate: 1, eur_rate: 117.5, amount_rsd: amount }}
      lines={lines} onChange={setLines} scripts={SCRIPTS} />
  )
}

const amounts = () =>
  (screen.getAllByPlaceholderText('0.00') as HTMLInputElement[]).map(i => i.value)

describe('before anything is split', () => {
  it('offers one button and says what it is for', () => {
    render(<Host />)
    expect(screen.getByText(/Split across several costs/)).toBeInTheDocument()
    expect(screen.getByText(/each with its own classification/)).toBeInTheDocument()
  })

  /** Opening on two halves means the first thing a person does is classify,
   *  not divide — and the control starts balanced rather than complaining. */
  it('opens on two halves that already add up', () => {
    render(<Host />)
    fireEvent.click(screen.getByText(/Split across several costs/))
    expect(amounts()).toEqual(['60000', '60000'])
    expect(screen.getByText('✓ balanced')).toBeInTheDocument()
  })

  it('gives the odd para to the second half', () => {
    render(<Host amount={1000.01} />)
    fireEvent.click(screen.getByText(/Split across several costs/))
    expect(amounts()).toEqual(['500.01', '500'])
  })
})

describe('the sum control', () => {
  const open = () => {
    render(<Host />)
    fireEvent.click(screen.getByText(/Split across several costs/))
  }

  /**
   * Changing one line moves the LAST one, so a split that started balanced
   * stays balanced. The owner's words: "when I change the amount in one cell,
   * recalculate the next" — and a split that balances itself is a split
   * nobody has to subtract in their head.
   */
  it('rebalances the last line when another one changes', () => {
    open()
    fireEvent.change(screen.getAllByPlaceholderText('0.00')[0], { target: { value: '40000' } })
    expect(amounts()).toEqual(['40000', '80000'])
    expect(screen.getByText('✓ balanced')).toBeInTheDocument()
  })

  it('rebalances across three lines too', () => {
    open()
    fireEvent.click(screen.getByText(/Add a line/))
    fireEvent.change(screen.getAllByPlaceholderText('0.00')[0], { target: { value: '20000' } })
    expect(amounts()).toEqual(['20000', '60000', '40000'])
    expect(screen.getByText('✓ balanced')).toBeInTheDocument()
  })

  /**
   * Editing the balancing line itself recalculates nothing. Somebody typing
   * into it means it, and the split reads as unbalanced until they change
   * another line — which is the honest answer rather than a fight over the
   * cursor.
   */
  it('leaves the last line alone when the last line is what changed', () => {
    open()
    fireEvent.change(screen.getAllByPlaceholderText('0.00')[1], { target: { value: '50000' } })
    expect(amounts()).toEqual(['60000', '50000'])
    expect(screen.getByText(/10\.000,00 RSD left/)).toBeInTheDocument()
  })

  it('says when the lines have gone over', () => {
    open()
    fireEvent.change(screen.getAllByPlaceholderText('0.00')[1], { target: { value: '100000' } })
    expect(screen.getByText(/40\.000,00 RSD over/)).toBeInTheDocument()
  })

  it('puts the difference on the last line when asked', () => {
    open()
    fireEvent.change(screen.getAllByPlaceholderText('0.00')[1], { target: { value: '50000' } })
    fireEvent.click(screen.getByText(/Put it on line 2/))
    expect(amounts()).toEqual(['60000', '60000'])
    expect(screen.getByText('✓ balanced')).toBeInTheDocument()
  })

  it('offers nothing to absorb once it balances', () => {
    open()
    expect(screen.queryByText(/Put it on line/)).not.toBeInTheDocument()
  })

  it('names the line that takes the balance, rather than leaving it to be found', () => {
    open()
    expect(screen.getByText('takes the balance')).toBeInTheDocument()
  })

  /** A sentence as well as a colour: a reader who has not noticed the amber
   *  figure has still been told what is wrong and where. */
  it('names a line with no category before it mentions the total', () => {
    open()
    expect(screen.getByText(/Line 1 has no P&L category/)).toBeInTheDocument()
  })
})

describe('adding and removing lines', () => {
  const open = () => {
    render(<Host />)
    fireEvent.click(screen.getByText(/Split across several costs/))
  }

  it('adds a line holding whatever is unaccounted for', () => {
    open()
    fireEvent.change(screen.getAllByPlaceholderText('0.00')[1], { target: { value: '20000' } })
    fireEvent.click(screen.getByText(/Add a line/))
    expect(amounts()).toEqual(['60000', '20000', '40000'])
    expect(screen.getByText('✓ balanced')).toBeInTheDocument()
  })

  it('removes a line', () => {
    open()
    fireEvent.click(screen.getByText(/Add a line/))
    expect(amounts()).toHaveLength(3)
    fireEvent.click(screen.getAllByTitle('Remove this line')[0])
    expect(amounts()).toHaveLength(2)
  })

  /** A split of one is not a split. The way back is the explicit button. */
  it('will not let the last line be removed one at a time', () => {
    open()
    fireEvent.click(screen.getAllByTitle('Remove this line')[0])
    const last = screen.getByTitle(/A split of one is not a split/)
    expect(last).toBeDisabled()
  })

  it('goes back to an ordinary single expense', () => {
    open()
    fireEvent.click(screen.getByText(/Remove the split/))
    expect(screen.getByText(/Split across several costs/)).toBeInTheDocument()
  })
})

describe('a line is a template and a figure', () => {
  it('shows what the line will be filed as, not just the template name', () => {
    render(<Host />)
    fireEvent.click(screen.getByText(/Split across several costs/))
    fireEvent.click(screen.getAllByText(/pick what this part is for/)[0])
    fireEvent.click(screen.getByText(/💻 Laptops/))
    expect(screen.getByText(/Capital expenditures › Hardware › Product › Laptop/))
      .toBeInTheDocument()
  })

  it('keeps the amount when the template is picked', () => {
    render(<Host />)
    fireEvent.click(screen.getByText(/Split across several costs/))
    fireEvent.click(screen.getAllByText(/pick what this part is for/)[0])
    fireEvent.click(screen.getByText(/💻 Laptops/))
    expect(amounts()[0]).toBe('60000')
  })
})


describe('typing an amount', () => {
  const open = () => {
    render(<Host />)
    fireEvent.click(screen.getByText(/Split across several costs/))
  }

  /**
   * The bug that made the control unusable on a real bill: a controlled input
   * rendering `String(Number(text))` cannot be typed into, because `653401.`
   * parses to `653401` and the full stop vanishes from under the cursor. Only
   * whole numbers could be entered, and no invoice in this ledger is a whole
   * number of dinars.
   */
  it('lets a decimal point be typed', () => {
    open()
    const box = screen.getAllByPlaceholderText('0.00')[0]
    fireEvent.change(box, { target: { value: '653401.' } })
    expect((box as HTMLInputElement).value).toBe('653401.')
    fireEvent.change(box, { target: { value: '653401.49' } })
    expect((box as HTMLInputElement).value).toBe('653401.49')
  })

  it('counts the decimal in the balance', () => {
    render(<Host amount={713850.49} />)
    fireEvent.click(screen.getByText(/Split across several costs/))
    fireEvent.change(screen.getAllByPlaceholderText('0.00')[0], { target: { value: '653400.49' } })
    expect(amounts()).toEqual(['653400.49', '60450'])
    expect(screen.getByText('✓ balanced')).toBeInTheDocument()
  })

  it('takes a comma as a decimal point, the way the keyboard gives it', () => {
    open()
    fireEvent.change(screen.getAllByPlaceholderText('0.00')[0], { target: { value: '40000,50' } })
    expect(amounts()[1]).toBe('79999.5')
  })

  /** A box being cleared is on its way to another number, not a zero. */
  it('does not rebalance off an empty box', () => {
    open()
    fireEvent.change(screen.getAllByPlaceholderText('0.00')[0], { target: { value: '' } })
    expect(amounts()[1]).toBe('60000')
  })
})

describe('making a template from inside the split', () => {
  const OPTIONS = {
    plCategories: [{ id: 'c1', name: 'General Business', type: 'expense' }],
    plSubcategories: [{ id: 'sc1', name: 'Rent and Mortgage', category_id: 'c1' }],
    departments: [{ id: 'd1', name: 'General Business Expenses' }],
    deptSubcategories: [{ id: 'ds1', name: 'Rent', department_id: 'd1' }],
    expenseDescriptions: [{ id: 'e1', name: 'Garage spaces', dept_subcategory_id: 'ds1' }],
  }

  function Full() {
    const [lines, setLines] = useState<SplitLine[]>([])
    return (
      <SplitEditor
        parent={{ amount: 120000, currency: 'RSD', exchange_rate: 1, eur_rate: 117.5, amount_rsd: 120000 }}
        lines={lines} onChange={setLines} scripts={SCRIPTS}
        classification={OPTIONS} client={{}} />
    )
  }

  const open = () => {
    render(<Full />)
    fireEvent.click(screen.getByText(/Split across several costs/))
  }

  /**
   * Without this the only way on is to abandon the split, make a template in
   * Settings, and come back — three steps for something that should be one.
   */
  it('offers a plus on every line', () => {
    open()
    expect(screen.getAllByTitle('Make a template for this cost')).toHaveLength(2)
  })

  it('opens the builder on the line that asked for it', () => {
    open()
    fireEvent.click(screen.getAllByTitle('Make a template for this cost')[0])
    expect(screen.getByText('New template')).toBeInTheDocument()
    expect(screen.getByPlaceholderText(/Lease — garage spaces/)).toBeInTheDocument()
  })

  /** Two half-filled template forms on one screen is two chances to save the
   *  wrong one. */
  it('opens one at a time', () => {
    open()
    fireEvent.click(screen.getAllByTitle('Make a template for this cost')[0])
    fireEvent.click(screen.getAllByTitle('Make a template for this cost')[1])
    expect(screen.getAllByText('New template')).toHaveLength(1)
  })

  it('closes on cancel without changing the line', () => {
    open()
    fireEvent.click(screen.getAllByTitle('Make a template for this cost')[0])
    fireEvent.click(screen.getByText('Cancel'))
    expect(screen.queryByText('New template')).not.toBeInTheDocument()
    expect(amounts()).toEqual(['60000', '60000'])
  })

  /**
   * A template that classifies nothing files a line under Unassigned while
   * looking like it did something, so it cannot be saved without a category —
   * and the button says why rather than simply not working.
   */
  it('refuses a template with no name and says so', () => {
    open()
    fireEvent.click(screen.getAllByTitle('Make a template for this cost')[0])
    const save = screen.getByText(/Save and use it/)
    expect(save).toBeDisabled()
    expect(save.getAttribute('title')).toMatch(/Give the template a name/)
  })

  it('still asks for a category once it has a name', () => {
    open()
    fireEvent.click(screen.getAllByTitle('Make a template for this cost')[0])
    fireEvent.change(screen.getByPlaceholderText(/Lease — garage spaces/), { target: { value: 'Garage' } })
    expect(screen.getByText(/Save and use it/).getAttribute('title'))
      .toMatch(/Pick a P&L category/)
  })

  /** Where a dialog has not passed the lists, the line stays template-only —
   *  which is how this shipped and is still a working control. */
  it('shows no plus where the dialog gave it nothing to build from', () => {
    render(<Host />)
    fireEvent.click(screen.getByText(/Split across several costs/))
    expect(screen.queryByTitle('Make a template for this cost')).not.toBeInTheDocument()
  })
})
