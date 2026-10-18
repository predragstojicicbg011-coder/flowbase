// What SEF's own status already says about an invoice, before anyone decides.
//
// The app is not the only one who decides on SEF. The accounting firm works in
// the SEF portal directly, and the supplier may cancel or storno the invoice.
// `sef-pull` brings their status into `sef_inbox.sef_status` every 15 minutes,
// so a row can be Approved or Rejected while `sef_decision` (the app's own
// decision) is still empty.
//
// This file is the rule, shared by the inbox (which buttons it offers, which
// badge it shows) and by `supabase/functions/sef-decide`, which holds a copy
// (the edge functions share no code with `src/`). Change both together.
//
//   * Approved — final, whoever accepted it: no new decision.
//   * Rejected — may still be ACCEPTED (the law allows it); a second rejection
//     is refused.
//   * Cancelled / Storno — the supplier withdrew it: no decision at all.
//
// The app's own decisions (`sef_decision`) keep their own messages in
// `sef-decide`; this rule speaks only when the status came from outside, or
// when the supplier withdrew the invoice.

export type SefGuardCode = 'accepted_outside' | 'rejected_outside' | 'withdrawn'

export interface SefGuardRowLike {
  sef_status: string | null
  sef_decision: 'accepted' | 'rejected' | null
}

export interface SefGuardRefusal {
  code: SefGuardCode
  message: string
}

export const ACCEPTED_OUTSIDE_MESSAGE =
  'Faktura je već prihvaćena na SEF-u van aplikacije (status: Prihvaćena). Nova odluka nije poslata.'
export const REJECTED_OUTSIDE_MESSAGE =
  'Faktura je već odbijena na SEF-u van aplikacije (status: Odbijena). Nova odluka nije poslata.'
export const WITHDRAWN_MESSAGE =
  'Dobavljač je otkazao ili stornirao fakturu — odluka nije moguća.'

const norm = (s: string | null | undefined) => (s || '').trim().toLowerCase()

/**
 * Why a decision may not be sent to SEF, judged by SEF's status alone, or
 * null when nothing in it stands in the way.
 */
export function sefDecisionGuard(row: SefGuardRowLike, accepted: boolean): SefGuardRefusal | null {
  const status = norm(row.sef_status)
  if (status === 'cancelled' || status === 'storno') {
    return { code: 'withdrawn', message: WITHDRAWN_MESSAGE }
  }
  // The app's own acceptance has its own message in `sef-decide`.
  if (status === 'approved' && row.sef_decision !== 'accepted') {
    return { code: 'accepted_outside', message: ACCEPTED_OUTSIDE_MESSAGE }
  }
  if (status === 'rejected' && !accepted && row.sef_decision !== 'rejected') {
    return { code: 'rejected_outside', message: REJECTED_OUTSIDE_MESSAGE }
  }
  return null
}

export type SefBadgeTone = 'neutral' | 'red'

/** The badge a row wears for what happened on SEF outside the app. */
export function sefOutsideBadge(row: SefGuardRowLike): { label: string; tone: SefBadgeTone } | null {
  const status = norm(row.sef_status)
  if (status === 'storno') return { label: 'Storno', tone: 'red' }
  if (status === 'cancelled') return { label: 'Otkazana', tone: 'red' }
  if ((status === 'approved' || status === 'rejected') && row.sef_decision === null) {
    return { label: 'Odlučeno van aplikacije', tone: 'neutral' }
  }
  return null
}

/** New invoices first; everything else keeps its order. */
export function sefStatusRank(status: string | null): number {
  return norm(status) === 'new' ? 0 : 1
}

/**
 * SEF's own refusal of a decision that is already made (when the status had
 * not reached us yet), turned into the same words as the guard. `status` is
 * whatever SEF reported on the invoice, `message` its text. Null when the
 * refusal is about something else.
 */
export function sefAlreadyDecidedRefusal(
  status: string | null, message: string | null, accepted: boolean,
): SefGuardRefusal | null {
  const st = norm(status)
  const text = norm(message)
  if (st === 'cancelled' || st === 'storno' || /storn|cancel|otkazan/.test(text)) {
    return { code: 'withdrawn', message: WITHDRAWN_MESSAGE }
  }
  if (st === 'approved') return { code: 'accepted_outside', message: ACCEPTED_OUTSIDE_MESSAGE }
  if (st === 'rejected' && !accepted) return { code: 'rejected_outside', message: REJECTED_OUTSIDE_MESSAGE }
  const already = /already|već|vec /.test(text)
  if (!already) return null
  if (/approv|accept|prihva/.test(text)) return { code: 'accepted_outside', message: ACCEPTED_OUTSIDE_MESSAGE }
  if (/reject|odbij/.test(text)) {
    // SEF says rejected; an acceptance should not have been refused for it.
    return accepted ? null : { code: 'rejected_outside', message: REJECTED_OUTSIDE_MESSAGE }
  }
  return null
}
