import React from 'react'

export function PageHeader({ title, subtitle, right }: {
  title: string
  subtitle?: string
  right?: React.ReactNode
}) {
  return (
    <div style={{
      display: 'flex',
      alignItems: 'flex-end',
      justifyContent: 'space-between',
      marginBottom: 24,
      gap: 24,
      flexWrap: 'wrap',
    }}>
      <div>
        <h1 style={{
          fontFamily: "'DM Serif Display', Georgia, serif",
          fontSize: '30px',
          fontWeight: 400,
          color: '#E8F1FB',
          margin: 0,
          letterSpacing: '-0.01em',
          lineHeight: 1.1,
        }}>{title}</h1>
        {subtitle && (
          <div style={{ fontSize: '13px', color: '#7A9BB8', marginTop: '6px', letterSpacing: '0.005em' }}>
            {subtitle}
          </div>
        )}
      </div>
      {right}
    </div>
  )
}