import React from 'react'

export function Sparkline({ data, color, width = 72, height = 30 }: {
  data: number[]
  color: string
  width?: number
  height?: number
}) {
  const min = Math.min(...data)
  const max = Math.max(...data)
  const range = max - min || 1
  const pts = data.map((v, i) => [
    (i / (data.length - 1)) * width,
    height - ((v - min) / range) * (height - 4) - 2,
  ])
  const line = pts.map(([x, y]) => `${x},${y}`).join(' ')
  const area = `M0,${height} L${line} L${width},${height}Z`
  const id = `sp-${color.replace(/[^a-z0-9]/gi, '')}-${Math.random().toString(36).slice(2, 9)}`
  return (
    <svg width={width} height={height} style={{ flexShrink: 0 }}>
      <defs>
        <linearGradient id={id} x1="0" y1="0" x2="0" y2="1">
          <stop offset="0%" stopColor={color} stopOpacity="0.3" />
          <stop offset="100%" stopColor={color} stopOpacity="0" />
        </linearGradient>
      </defs>
      <path d={area} fill={`url(#${id})`} />
      <polyline points={line} fill="none" stroke={color} strokeWidth="1.5"
        strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  )
}