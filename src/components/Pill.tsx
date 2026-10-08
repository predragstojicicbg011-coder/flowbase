import React from 'react'

type Color = 'green' | 'red' | 'amber' | 'blue' | 'purple' | 'pink' | 'neutral'

const palette: Record<Color, [string, string]> = {
  green:   ['#00D47E', 'rgba(0,212,126,0.12)'],
  red:     ['#FF5B5A', 'rgba(255,91,90,0.12)'],
  amber:   ['#F5A623', 'rgba(245,166,35,0.12)'],
  blue:    ['#4EA8FF', 'rgba(78,168,255,0.12)'],
  purple:  ['#A78BFA', 'rgba(167,139,250,0.12)'],
  pink:    ['#F472B6', 'rgba(244,114,182,0.12)'],
  neutral: ['rgba(255,255,255,0.45)', 'rgba(255,255,255,0.06)'],
}

export function Pill({ children, color = 'blue', size = 'sm' }: {
  children: React.ReactNode
  color?: Color
  size?: 'sm' | 'md'
}) {
  const [fg, bg] = palette[color] ?? palette.blue
  return (
    <span style={{
      display: 'inline-flex',
      alignItems: 'center',
      gap: 4,
      padding: size === 'sm' ? '2px 9px' : '4px 11px',
      borderRadius: 9999,
      background: bg,
      color: fg,
      fontSize: size === 'sm' ? '10.5px' : '11.5px',
      fontWeight: 600,
      letterSpacing: '0.02em',
      whiteSpace: 'nowrap',
    }}>
      {children}
    </span>
  )
}