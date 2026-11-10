import React from 'react'
import { DIALOG } from './dialogTheme'

// ── A template's icon, picked from a set ────────────────────────────────────
//
// The quick-fill list is read by its icons first; with every template on ⚡ it
// was one column of the same mark. The set covers what a construction company
// books most: bank and money, fuel and vehicles, materials and machinery,
// utilities, office, people, taxes, revenue. An icon a template already has
// that is not in the set is kept and shown first.

export const TEMPLATE_ICONS = [
  '⚡', '🏦', '💳', '💰', '📈', '🧾', '📄', '🏛️',
  '⛽', '🚚', '🚗', '🔧', '🛠️', '🏗️', '🧱', '🪵',
  '💡', '💧', '🔥', '📞', '🖥️', '📦', '🏢', '🧹',
  '👷', '🧑‍💼', '🍽️', '✈️', '🛡️', '⚖️', '🎓', '🏠',
]

export default function IconPicker({ value, onChange }: { value: string; onChange: (icon: string) => void }) {
  const icons = value && !TEMPLATE_ICONS.includes(value) ? [value, ...TEMPLATE_ICONS] : TEMPLATE_ICONS
  return (
    <div role="group" aria-label="Izbor ikonice" style={{ display: 'flex', flexWrap: 'wrap', gap: '4px' }}>
      {icons.map(icon => {
        const chosen = icon === value
        return (
          <button key={icon} type="button" aria-label={`Ikonica ${icon}`} aria-pressed={chosen}
            onClick={() => onChange(icon)}
            style={{
              width: '30px', height: '30px', borderRadius: '7px', cursor: 'pointer', fontSize: '15px', lineHeight: 1,
              border: `1px solid ${chosen ? DIALOG.accent : DIALOG.border}`,
              background: chosen ? DIALOG.accentFill : 'transparent',
              display: 'flex', alignItems: 'center', justifyContent: 'center', padding: 0,
            }}>
            {icon}
          </button>
        )
      })}
    </div>
  )
}
