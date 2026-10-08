import React from 'react'

// ── Revenue ─────────────────────────────────────────────────────────────────
//
// A placeholder while the page is rebuilt.
//
// It read revenue_entries / revenue_collections / v_revenue_entry_status —
// Mintflow's Chargebee-shaped receivables — which
// 20261008180000_accrual_revenue.sql drops. Revenue is now revenue invoices
// (progress billings and rent), settled through invoice_transaction_links,
// with advances, a monthly plan per project and rental leases beside them.
// The pure logic the rebuilt page reads is in src/services/revenue.ts and
// src/services/revenuePlan.ts.
export default function Revenue() {
  return (
    <div style={s.root} className="app-surface">
      <div style={s.body}>
        <div style={s.pageTitle}>Prihodi</div>
        <div style={s.pageSub}>Prihodi — u izradi</div>
      </div>
    </div>
  )
}

const s: Record<string, React.CSSProperties> = {
  // The background lives in `.app-surface` rather than here: an inline
  // colour would paint straight over it.
  root: { minHeight:'100vh', fontFamily:"'Inter', system-ui, sans-serif" },
  body: { padding:'24px 28px' },
  pageTitle: { fontFamily:'Georgia,serif', fontSize:'26px', fontWeight:'400', color:'#DCE9F6', marginBottom:'4px' },
  pageSub: { fontSize:'13px', color:'#7A9BB8' },
}
