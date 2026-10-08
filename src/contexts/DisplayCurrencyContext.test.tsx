import React from 'react'
import { render, screen, fireEvent } from '@testing-library/react'
import {
  DisplayCurrencyProvider, useDisplayCurrency, pickAmount, amountField, DISPLAY_CURRENCY_KEY,
} from './DisplayCurrencyContext'
import DisplayCurrencyToggle from '../components/DisplayCurrencyToggle'

const row = {
  amount: 100, currency: 'EUR',
  amount_rsd: 11717.34, amount_eur: 100,
  allocated_amount_rsd: '5858.67', allocated_amount_eur: null,
}

describe('pickAmount', () => {
  it('reads the column for the currency', () => {
    expect(pickAmount(row, 'RSD')).toBe(11717.34)
    expect(pickAmount(row, 'EUR')).toBe(100)
  })

  it('takes any base column', () => {
    expect(pickAmount(row, 'RSD', 'allocated_amount')).toBe(5858.67)
    expect(amountField('EUR', 'paid_amount')).toBe('paid_amount_eur')
  })

  it('is null, not zero, where the row has no figure', () => {
    expect(pickAmount(row, 'EUR', 'allocated_amount')).toBeNull()
    expect(pickAmount(row, 'EUR', 'remaining')).toBeNull()
    expect(pickAmount(null, 'RSD')).toBeNull()
    expect(pickAmount({ amount_rsd: 'abc' }, 'RSD')).toBeNull()
  })
})

function Probe() {
  const { currency, pick, field, format } = useDisplayCurrency()
  return (
    <div>
      <span data-testid="cur">{currency}</span>
      <span data-testid="pick">{String(pick(row))}</span>
      <span data-testid="field">{field('remaining')}</span>
      <span data-testid="fmt">{format(pick(row))}</span>
    </div>
  )
}

describe('DisplayCurrencyProvider', () => {
  beforeEach(() => window.localStorage.clear())

  it('starts in RSD', () => {
    render(<DisplayCurrencyProvider><Probe /></DisplayCurrencyProvider>)
    expect(screen.getByTestId('cur').textContent).toBe('RSD')
    expect(screen.getByTestId('pick').textContent).toBe('11717.34')
    expect(screen.getByTestId('field').textContent).toBe('remaining_rsd')
    expect(screen.getByTestId('fmt').textContent).toBe('11.717,34 RSD')
  })

  it('switches to EUR from the toggle and remembers it', () => {
    render(<DisplayCurrencyProvider><DisplayCurrencyToggle /><Probe /></DisplayCurrencyProvider>)
    fireEvent.click(screen.getByRole('radio', { name: 'EUR' }))
    expect(screen.getByTestId('cur').textContent).toBe('EUR')
    expect(screen.getByTestId('pick').textContent).toBe('100')
    expect(screen.getByTestId('fmt').textContent).toBe('100,00 EUR')
    expect(screen.getByRole('radio', { name: 'EUR' }).getAttribute('aria-checked')).toBe('true')
    expect(window.localStorage.getItem(DISPLAY_CURRENCY_KEY)).toBe('EUR')
  })

  it('starts from what the viewer chose last time', () => {
    window.localStorage.setItem(DISPLAY_CURRENCY_KEY, 'EUR')
    render(<DisplayCurrencyProvider><Probe /></DisplayCurrencyProvider>)
    expect(screen.getByTestId('cur').textContent).toBe('EUR')
  })

  it('ignores a stored value it does not know', () => {
    window.localStorage.setItem(DISPLAY_CURRENCY_KEY, 'USD')
    render(<DisplayCurrencyProvider><Probe /></DisplayCurrencyProvider>)
    expect(screen.getByTestId('cur').textContent).toBe('RSD')
  })

  it('still works when storage throws', () => {
    const get = jest.spyOn(Storage.prototype, 'getItem').mockImplementation(() => { throw new Error('blocked') })
    const set = jest.spyOn(Storage.prototype, 'setItem').mockImplementation(() => { throw new Error('blocked') })
    try {
      render(<DisplayCurrencyProvider><DisplayCurrencyToggle /><Probe /></DisplayCurrencyProvider>)
      expect(screen.getByTestId('cur').textContent).toBe('RSD')
      fireEvent.click(screen.getByRole('radio', { name: 'EUR' }))
      expect(screen.getByTestId('cur').textContent).toBe('EUR')
    } finally {
      get.mockRestore()
      set.mockRestore()
    }
  })

  it('answers RSD outside a provider', () => {
    render(<Probe />)
    expect(screen.getByTestId('cur').textContent).toBe('RSD')
  })
})
