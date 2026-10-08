import React, { useState } from 'react'
import { render, screen, fireEvent } from '@testing-library/react'
import SplitEditor from './SplitEditor'
import { type SplitLine, type ScriptLike } from '../services/expenseSplit'
import type { Project } from '../services/projects'

jest.mock('../supabase', () => ({ supabase: {} }))
// The editor is given its projects; nothing here should read the table.
jest.mock('../contexts/ProjectsContext', () => ({
  useProjects: () => ({ projects: [], activeProjects: [], loading: false, error: null, refresh: async () => {} }),
}))

const SCRIPTS: ScriptLike[] = [
  {
    id: 's1', name: 'Figma', icon: '⚡',
    pl_category: 'General Business', pl_subcategory: 'Software subscriptions',
    department: 'Admin', dept_subcategory: 'Tools', expense_description: 'Figma',
    cf_type: 'recurring',
  },
  {
    id: 's2', name: 'Laptops', icon: '💻',
    pl_category: 'Capital expenditures', pl_subcategory: 'Hardware',
    department: 'Product', dept_subcategory: 'Equipment', expense_description: 'Laptop',
    cf_type: 'one_off',
  },
]

const project = (id: string, name: string, over: Partial<Project> = {}): Project => ({
  id, company_id: 'c1', name, code: null, kind: 'construction', investor_partner_id: null,
  contract_value: null, contract_currency: null, contract_date: null,
  contract_value_rsd: null, contract_value_eur: null, payment_days: 45, active: true, note: null, ...over,
})
const PROJECTS: Project[] = [project('p1', 'Zgrada Vračar'), project('p2', 'Hala Zemun')]

/** The editor hands lines back; a host has to keep them. */
function Host({ amount = 120000, seen }: { amount?: number; seen?: (l: SplitLine[]) => void }) {
  const [lines, setLines] = useState<SplitLine[]>([])
  return (
    <SplitEditor
      parent={{ amount, currency: 'RSD', exchange_rate: 1, eur_rate: 117.5, amount_rsd: amount }}
      lines={lines} onChange={l => { setLines(l); seen?.(l) }} scripts={SCRIPTS}
      projects={PROJECTS} />
  )
}

const amounts = () =>
  (screen.getAllByPlaceholderText('0.00') as HTMLInputElement[]).map(i => i.value)

describe('before anything is split', () => {
  it('offers one button and says what it is for', () => {
    render(<Host />)
    expect(screen.getByText(/Podeli na više troškova/)).toBeInTheDocument()
    expect(screen.getByText(/svaki sa svojom klasifikacijom/)).toBeInTheDocument()
  })

  /** Opening on two halves means the first thing a person does is classify,
   *  not divide — and the control starts balanced rather than complaining. */
  it('opens on two halves that already add up', () => {
    render(<Host />)
    fireEvent.click(screen.getByText(/Podeli na više troškova/))
    expect(amounts()).toEqual(['60000', '60000'])
    expect(screen.getByText('✓ usklađeno')).toBeInTheDocument()
  })

  it('gives the odd para to the second half', () => {
    render(<Host amount={1000.01} />)
    fireEvent.click(screen.getByText(/Podeli na više troškova/))
    expect(amounts()).toEqual(['500.01', '500'])
  })
})

describe('the sum control', () => {
  const open = () => {
    render(<Host />)
    fireEvent.click(screen.getByText(/Podeli na više troškova/))
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
    expect(screen.getByText('✓ usklađeno')).toBeInTheDocument()
  })

  it('rebalances across three lines too', () => {
    open()
    fireEvent.click(screen.getByText(/Dodaj stavku/))
    fireEvent.change(screen.getAllByPlaceholderText('0.00')[0], { target: { value: '20000' } })
    expect(amounts()).toEqual(['20000', '60000', '40000'])
    expect(screen.getByText('✓ usklađeno')).toBeInTheDocument()
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
    expect(screen.getByText(/preostalo 10\.000,00 RSD/)).toBeInTheDocument()
  })

  it('says when the lines have gone over', () => {
    open()
    fireEvent.change(screen.getAllByPlaceholderText('0.00')[1], { target: { value: '100000' } })
    expect(screen.getByText(/višak 40\.000,00 RSD/)).toBeInTheDocument()
  })

  it('puts the difference on the last line when asked', () => {
    open()
    fireEvent.change(screen.getAllByPlaceholderText('0.00')[1], { target: { value: '50000' } })
    fireEvent.click(screen.getByText(/Prebaci na stavku 2/))
    expect(amounts()).toEqual(['60000', '60000'])
    expect(screen.getByText('✓ usklađeno')).toBeInTheDocument()
  })

  it('offers nothing to absorb once it balances', () => {
    open()
    expect(screen.queryByText(/Prebaci na stavku/)).not.toBeInTheDocument()
  })

  it('names the line that takes the balance, rather than leaving it to be found', () => {
    open()
    expect(screen.getByText('preuzima ostatak')).toBeInTheDocument()
  })

  /** A sentence as well as a colour: a reader who has not noticed the amber
   *  figure has still been told what is wrong and where. */
  it('names a line with no category before it mentions the total', () => {
    open()
    expect(screen.getByText(/Stavka 1 nema P&L kategoriju/)).toBeInTheDocument()
  })
})

describe('adding and removing lines', () => {
  const open = () => {
    render(<Host />)
    fireEvent.click(screen.getByText(/Podeli na više troškova/))
  }

  it('adds a line holding whatever is unaccounted for', () => {
    open()
    fireEvent.change(screen.getAllByPlaceholderText('0.00')[1], { target: { value: '20000' } })
    fireEvent.click(screen.getByText(/Dodaj stavku/))
    expect(amounts()).toEqual(['60000', '20000', '40000'])
    expect(screen.getByText('✓ usklađeno')).toBeInTheDocument()
  })

  it('removes a line', () => {
    open()
    fireEvent.click(screen.getByText(/Dodaj stavku/))
    expect(amounts()).toHaveLength(3)
    fireEvent.click(screen.getAllByTitle('Ukloni ovu stavku')[0])
    expect(amounts()).toHaveLength(2)
  })

  /** A split of one is not a split. The way back is the explicit button. */
  it('will not let the last line be removed one at a time', () => {
    open()
    fireEvent.click(screen.getAllByTitle('Ukloni ovu stavku')[0])
    const last = screen.getByTitle(/Podela na jednu stavku nije podela/)
    expect(last).toBeDisabled()
  })

  it('goes back to an ordinary single expense', () => {
    open()
    fireEvent.click(screen.getByText(/Ukloni podelu/))
    expect(screen.getByText(/Podeli na više troškova/)).toBeInTheDocument()
  })
})

describe('a line is a template and a figure', () => {
  it('shows what the line will be filed as, not just the template name', () => {
    render(<Host />)
    fireEvent.click(screen.getByText(/Podeli na više troškova/))
    fireEvent.click(screen.getAllByText(/izaberite namenu ovog dela/)[0])
    fireEvent.click(screen.getByText(/💻 Laptops/))
    expect(screen.getByText(/Capital expenditures › Hardware › Product › Laptop/))
      .toBeInTheDocument()
  })

  it('keeps the amount when the template is picked', () => {
    render(<Host />)
    fireEvent.click(screen.getByText(/Podeli na više troškova/))
    fireEvent.click(screen.getAllByText(/izaberite namenu ovog dela/)[0])
    fireEvent.click(screen.getByText(/💻 Laptops/))
    expect(amounts()[0]).toBe('60000')
  })
})

describe('a line is on a project', () => {
  const open = () => {
    let latest: SplitLine[] = []
    render(<Host seen={l => { latest = l }} />)
    fireEvent.click(screen.getByText(/Podeli na više troškova/))
    return () => latest
  }

  it('opens every line on company overhead', () => {
    const lines = open()
    expect(lines().map(l => l.project_id)).toEqual([null, null])
    expect(screen.getAllByText('Opšti troškovi (bez projekta)')).toHaveLength(2)
  })

  /** One bill shared by two sites: each line is put on its own project. */
  it('puts a line on the project picked for it, and only that line', () => {
    const lines = open()
    fireEvent.click(screen.getAllByTitle('Projekat ovog dela')[1])
    fireEvent.click(screen.getByText('Hala Zemun'))
    expect(lines().map(l => l.project_id)).toEqual([null, 'p2'])
  })

  /** A template is a classification; it must not move a line off its site. */
  it('keeps the line’s project when a template is picked', () => {
    const lines = open()
    fireEvent.click(screen.getAllByTitle('Projekat ovog dela')[0])
    fireEvent.click(screen.getByText('Zgrada Vračar'))
    fireEvent.click(screen.getAllByText(/izaberite namenu ovog dela/)[0])
    fireEvent.click(screen.getByText(/💻 Laptops/))
    expect(lines()[0]).toMatchObject({ project_id: 'p1', pl_category: 'Capital expenditures' })
  })
})

describe('typing an amount', () => {
  const open = () => {
    render(<Host />)
    fireEvent.click(screen.getByText(/Podeli na više troškova/))
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
    fireEvent.click(screen.getByText(/Podeli na više troškova/))
    fireEvent.change(screen.getAllByPlaceholderText('0.00')[0], { target: { value: '653400.49' } })
    expect(amounts()).toEqual(['653400.49', '60450'])
    expect(screen.getByText('✓ usklađeno')).toBeInTheDocument()
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
    fireEvent.click(screen.getByText(/Podeli na više troškova/))
  }

  /**
   * Without this the only way on is to abandon the split, make a template in
   * Settings, and come back — three steps for something that should be one.
   */
  it('offers a plus on every line', () => {
    open()
    expect(screen.getAllByTitle('Napravi šablon za ovaj trošak')).toHaveLength(2)
  })

  it('opens the builder on the line that asked for it', () => {
    open()
    fireEvent.click(screen.getAllByTitle('Napravi šablon za ovaj trošak')[0])
    expect(screen.getByText('Novi šablon')).toBeInTheDocument()
    expect(screen.getByPlaceholderText(/Zakup — garažna mesta/)).toBeInTheDocument()
  })

  /** Two half-filled template forms on one screen is two chances to save the
   *  wrong one. */
  it('opens one at a time', () => {
    open()
    fireEvent.click(screen.getAllByTitle('Napravi šablon za ovaj trošak')[0])
    fireEvent.click(screen.getAllByTitle('Napravi šablon za ovaj trošak')[1])
    expect(screen.getAllByText('Novi šablon')).toHaveLength(1)
  })

  it('closes on cancel without changing the line', () => {
    open()
    fireEvent.click(screen.getAllByTitle('Napravi šablon za ovaj trošak')[0])
    fireEvent.click(screen.getByText('Otkaži'))
    expect(screen.queryByText('Novi šablon')).not.toBeInTheDocument()
    expect(amounts()).toEqual(['60000', '60000'])
  })

  /**
   * A template that classifies nothing files a line under Unassigned while
   * looking like it did something, so it cannot be saved without a category —
   * and the button says why rather than simply not working.
   */
  it('refuses a template with no name and says so', () => {
    open()
    fireEvent.click(screen.getAllByTitle('Napravi šablon za ovaj trošak')[0])
    const save = screen.getByText(/Sačuvaj i primeni/)
    expect(save).toBeDisabled()
    expect(save.getAttribute('title')).toMatch(/Dajte šablonu naziv/)
  })

  it('still asks for a category once it has a name', () => {
    open()
    fireEvent.click(screen.getAllByTitle('Napravi šablon za ovaj trošak')[0])
    fireEvent.change(screen.getByPlaceholderText(/Zakup — garažna mesta/), { target: { value: 'Garage' } })
    expect(screen.getByText(/Sačuvaj i primeni/).getAttribute('title'))
      .toMatch(/Izaberite P&L kategoriju/)
  })

  /** Where a dialog has not passed the lists, the line stays template-only —
   *  which is how this shipped and is still a working control. */
  it('shows no plus where the dialog gave it nothing to build from', () => {
    render(<Host />)
    fireEvent.click(screen.getByText(/Podeli na više troškova/))
    expect(screen.queryByTitle('Napravi šablon za ovaj trošak')).not.toBeInTheDocument()
  })
})
