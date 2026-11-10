import React from 'react'
import { DIALOG } from './dialogTheme'

// ── A template's icon, picked from a set ────────────────────────────────────
//
// The quick-fill list is read by its icons first; with every template on ⚡ it
// was one column of the same mark. The set covers what a construction company
// books most: bank and money, fuel and vehicles, materials and machinery,
// utilities, office, people, taxes, revenue. Each icon has a short description,
// shown on hover and under the set for the chosen one. An icon a template
// already has that is not in the set is kept and shown first, with no name.

const ICONS: { icon: string; label: string }[] = [
  { icon: '⚡', label: 'Opšte' },
  { icon: '🏦', label: 'Banka i provizije' },
  { icon: '💳', label: 'Kartice i plaćanja' },
  { icon: '💰', label: 'Prihod i naplata' },
  { icon: '📈', label: 'Ulaganja i kamate' },
  { icon: '🧾', label: 'Računi i takse' },
  { icon: '📄', label: 'Ugovori i dokumenta' },
  { icon: '🏛️', label: 'Porezi i država' },
  { icon: '⛽', label: 'Gorivo' },
  { icon: '🚚', label: 'Prevoz i dostava' },
  { icon: '🚗', label: 'Vozila' },
  { icon: '🔧', label: 'Održavanje i popravke' },
  { icon: '🛠️', label: 'Alat i oprema' },
  { icon: '🏗️', label: 'Gradilište i mehanizacija' },
  { icon: '🧱', label: 'Građevinski materijal' },
  { icon: '🪵', label: 'Drvo i oplata' },
  { icon: '💡', label: 'Struja' },
  { icon: '💧', label: 'Voda' },
  { icon: '🔥', label: 'Grejanje i gas' },
  { icon: '📞', label: 'Telefon i internet' },
  { icon: '🖥️', label: 'Računari i softver' },
  { icon: '📦', label: 'Nabavka i roba' },
  { icon: '🏢', label: 'Kancelarija i zakup' },
  { icon: '🧹', label: 'Čišćenje i higijena' },
  { icon: '👷', label: 'Radnici i podizvođači' },
  { icon: '🧑‍💼', label: 'Uprava i konsultanti' },
  { icon: '🍽️', label: 'Reprezentacija i hrana' },
  { icon: '✈️', label: 'Službena putovanja' },
  { icon: '🛡️', label: 'Osiguranje' },
  { icon: '⚖️', label: 'Pravne usluge' },
  { icon: '🎓', label: 'Obuke i stručno usavršavanje' },
  { icon: '🏠', label: 'Stanovi i nekretnine' },
]

export const TEMPLATE_ICONS = ICONS.map(i => i.icon)

/** The description of an icon from the set, or null for one from outside it. */
export function iconLabel(icon: string): string | null {
  return ICONS.find(i => i.icon === icon)?.label ?? null
}

export default function IconPicker({ value, onChange }: { value: string; onChange: (icon: string) => void }) {
  const icons = value && !TEMPLATE_ICONS.includes(value) ? [value, ...TEMPLATE_ICONS] : TEMPLATE_ICONS
  const chosenLabel = iconLabel(value)
  return (
    <div>
      <div role="group" aria-label="Izbor ikonice" style={{ display: 'flex', flexWrap: 'wrap', gap: '4px' }}>
        {icons.map(icon => {
          const chosen = icon === value
          return (
            <button key={icon} type="button" aria-label={`Ikonica ${icon}`} aria-pressed={chosen}
              title={iconLabel(icon) ?? undefined}
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
      {value && (
        <div style={{ marginTop: '6px', fontSize: '12px', color: DIALOG.dim }}>
          {chosenLabel ? `Izabrano: ${value} ${chosenLabel}` : `Izabrano: ${value}`}
        </div>
      )}
    </div>
  )
}
