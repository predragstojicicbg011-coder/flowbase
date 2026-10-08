// ─── Dialog palette ─────────────────────────────────────────────────────────
//
// The dialogs were built on a light palette while the rest of the app is dark,
// so every edit form arrived as a white slab over a navy page. These are the
// tokens the rest of the app already uses, named once so a dialog cannot drift
// back out of step.
//
// The old light values map onto these as follows, which is how the existing
// style objects were converted:
//
//   #fff (fill) → panel     #f5f5f3 #f9f9f7 #fafaf9 #f0f0ee → raised
//   #e5e5e5     → border    #111 → text        #888 #666 #555 → dim
//   #aaa #bbb #ccc → faint  #0a1628 → panelDeep
//   #1D9E75 #0F6E56 #5DCAA5 #085041 → accent, on accentFill
//   #E24B4A #A32D2D → red, on redFill      #0C447C #185FA5 #7FB8EE → blue
//   #633806 #BA7517 #E5B96A → amber, on amberFill
//
// Text on an accent-coloured fill is `onAccent` — near-black. White on the
// app's green is the one combination that fails to read.

import type { CSSProperties } from 'react'

export const DIALOG = {
  overlay: 'rgba(0,0,0,0.65)',

  panel: '#0D1B2C',        // the dialog surface
  panelDeep: '#0A1525',    // header and footer bands
  raised: '#111F30',       // inputs, cards, subtle fills

  border: 'rgba(255,255,255,0.10)',
  borderSoft: 'rgba(255,255,255,0.06)',

  text: '#DCE9F6',
  dim: '#7A9BB8',
  faint: 'rgba(255,255,255,0.30)',

  accent: '#00D47E',
  accentFill: 'rgba(0,212,126,0.12)',
  accentSoft: 'rgba(0,212,126,0.35)',
  /**
   * The accent laid down a whole column of a table rather than behind one
   * control. `accentFill` at 0.12 is sized for a badge or a pressed button;
   * run down forty rows it stops being a hint and starts being a highlight
   * that outshouts the figures in it.
   *
   * The same green, nothing new — named here so a second place that needs a
   * wash of the accent uses this value rather than guessing another alpha.
   */
  accentTint: 'rgba(0,212,126,0.05)',
  onAccent: '#060E1A',

  blue: '#4EA8FF',
  blueFill: 'rgba(78,168,255,0.12)',

  red: '#FF5B5A',
  redFill: 'rgba(255,91,90,0.10)',
  redSoft: 'rgba(255,91,90,0.35)',

  amber: '#F5A623',
  amberFill: 'rgba(245,166,35,0.12)',

  shadow: '0 24px 60px rgba(0,0,0,0.6)',

  /**
   * Edit dialogs sit above every other overlay.
   *
   * They are opened *from* other overlays — a drill-down list, an import
   * review — so anything less puts the form behind the thing that launched it.
   */
  z: 1200,
} as const

// ── Shared dialog chrome ────────────────────────────────────────────────────
//
// The header cluster is identical in every wizard-style dialog and is exactly
// the part that drifts: someone adds an emoji here, drops the wordmark there.
// Declared once and spread into each dialog's own style object, so the three
// cannot diverge without it being a deliberate edit to this file.

export const chrome: Record<string, CSSProperties> = {
  overlay: {
    position: 'fixed', inset: 0, colorScheme: 'dark',
    background: DIALOG.overlay, backdropFilter: 'blur(4px)',
    display: 'flex', alignItems: 'center', justifyContent: 'center', zIndex: DIALOG.z,
  },
  header: {
    background: DIALOG.panelDeep, padding: '1rem 1.5rem',
    display: 'flex', alignItems: 'center', justifyContent: 'space-between',
  },
  headerTitle: { color: DIALOG.text, fontSize: '15px', fontWeight: '500' },
  headerSub: { color: DIALOG.dim, fontSize: '12px', marginTop: '2px' },
  logoText: { color: DIALOG.accent, fontFamily: "'DM Serif Display', Georgia, serif", fontSize: '14px' },
  closeBtn: {
    background: 'rgba(255,255,255,0.05)', border: `1px solid ${DIALOG.border}`,
    color: DIALOG.dim, fontSize: '20px', cursor: 'pointer', padding: 0,
    width: '28px', height: '28px', borderRadius: '8px', lineHeight: 1, flexShrink: 0,
    display: 'flex', alignItems: 'center', justifyContent: 'center',
  },
  plBadge: {
    fontSize: '10px', fontWeight: '500', padding: '3px 8px', borderRadius: '20px',
    background: DIALOG.accentFill, color: DIALOG.accent, border: `0.5px solid ${DIALOG.accentSoft}`,
  },
  cashBadge: {
    fontSize: '10px', fontWeight: '500', padding: '3px 8px', borderRadius: '20px',
    background: DIALOG.blueFill, color: DIALOG.blue, border: '0.5px solid rgba(78,168,255,0.3)',
  },
}
