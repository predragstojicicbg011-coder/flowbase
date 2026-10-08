import React from 'react'
import { DISPLAY_CURRENCIES, useDisplayCurrency } from '../contexts/DisplayCurrencyContext'

/**
 * RSD | EUR — which book currency the pages show. Sits in the sidebar, for
 * the dark background there.
 */
export default function DisplayCurrencyToggle() {
  const { currency, setCurrency } = useDisplayCurrency()

  return (
    <div role="radiogroup" aria-label="Valuta prikaza" style={s.group}>
      {DISPLAY_CURRENCIES.map(c => {
        const on = c === currency
        return (
          <button
            key={c}
            type="button"
            role="radio"
            aria-checked={on}
            onClick={() => setCurrency(c)}
            style={{
              ...s.option,
              background: on ? 'rgba(0,212,126,0.14)' : 'transparent',
              color: on ? '#00D47E' : 'rgba(255,255,255,0.44)',
              fontWeight: on ? 600 : 400,
            }}
          >
            {c}
          </button>
        )
      })}
    </div>
  )
}

const s: Record<string, React.CSSProperties> = {
  group: {
    display: 'flex',
    gap: '2px',
    padding: '2px',
    borderRadius: '8px',
    border: '1px solid rgba(255,255,255,0.10)',
  },
  option: {
    flex: 1,
    border: 'none',
    borderRadius: '6px',
    padding: '5px 0',
    fontSize: '11px',
    letterSpacing: '0.04em',
    cursor: 'pointer',
    fontFamily: "'Inter', system-ui, sans-serif",
    transition: 'background 0.15s, color 0.15s',
  },
}
