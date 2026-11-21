import { useCallback, useEffect, useRef } from 'react'

// ─── The hidden print frame ────────────────────────────────────────────────
//
// `PartnerCardDialog`'s frame, shared by the Payroll page's three documents:
// the document is written into a zero-sized frame, whose own loader opens the
// print dialog ("Sačuvaj kao PDF"). One frame at a time, by its title —
// printing again replaces the last one, so twice in a row works — and hidden
// from screen readers, so nothing it leaves behind is read aloud.
//
// FOCUS COMES BACK to the button that printed: the loader focuses the frame's
// window, and a keyboard user would otherwise be left inside an invisible
// frame. Given back on the frame's `afterprint`, on its load (which, where
// print() blocks, is only reached once the dialog is closed), and on unmount.

export const PRINT_FRAME_TITLE = 'Dokument zarada za štampu'

export function usePrintFrame(): (html: string, returnTo?: HTMLElement | null) => void {
  const mine = useRef<HTMLIFrameElement | null>(null)
  const back = useRef<HTMLElement | null>(null)
  const restore = useCallback(() => {
    const el = back.current
    back.current = null
    if (el && el.isConnected) el.focus()
  }, [])
  useEffect(() => () => {
    restore()
    mine.current?.remove()
    mine.current = null
  }, [restore])
  return useCallback((html: string, returnTo?: HTMLElement | null) => {
    document.querySelectorAll(`iframe[title="${PRINT_FRAME_TITLE}"]`).forEach(f => f.remove())
    back.current = returnTo ?? null
    const frame = document.createElement('iframe')
    frame.title = PRINT_FRAME_TITLE
    frame.setAttribute('aria-hidden', 'true')
    frame.tabIndex = -1
    Object.assign(frame.style, { position: 'fixed', width: '0', height: '0', border: '0', right: '0', bottom: '0' })
    frame.setAttribute('srcdoc', html)
    document.body.appendChild(frame)
    // The window of a same-origin frame is kept when its srcdoc loads.
    frame.contentWindow?.addEventListener('afterprint', restore)
    frame.addEventListener('load', () => {
      frame.contentWindow?.addEventListener('afterprint', restore)
      restore()
    })
    mine.current = frame
  }, [restore])
}
