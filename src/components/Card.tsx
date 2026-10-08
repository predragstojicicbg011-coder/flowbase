import React, { useState } from 'react'

export function Card({ children, style = {}, hoverable = false, onClick }: {
  children: React.ReactNode
  style?: React.CSSProperties
  hoverable?: boolean
  onClick?: () => void
}) {
  const [h, setH] = useState(false)
  return (
    <div
      onMouseEnter={() => hoverable && setH(true)}
      onMouseLeave={() => setH(false)}
      onClick={onClick}
      style={{
        background: '#0D1B2C',
        borderRadius: 12,
        border: `1px solid ${h ? 'rgba(255,255,255,0.14)' : 'rgba(255,255,255,0.075)'}`,
        boxShadow: h ? '0 8px 28px rgba(0,0,0,0.45)' : '0 2px 12px rgba(0,0,0,0.25)',
        transition: 'all 0.18s',
        cursor: onClick ? 'pointer' : 'default',
        ...style,
      }}
    >
      {children}
    </div>
  )
}