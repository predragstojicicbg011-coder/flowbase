// Accepting or rejecting a supplier's invoice ON SEF.
//
// The decision is made by the `sef-decide` edge function, which holds the SEF
// key, checks the caller and the switch, and calls SEF exactly once. This file
// is the app's side: it asks, and turns whatever comes back into one typed
// answer the inbox can show.
//
// `readSefDecisionResponse` is copied into `supabase/functions/sef-decide`
// (the edge functions share no code with `src/`); it is tested here. Change
// both together.

export type SefDecision = 'accepted' | 'rejected'

export interface SefDecisionRequest {
  inboxId: string
  accepted: boolean
  comment?: string
}

export type SefDecideErrorCode =
  | 'comment_required' | 'switch_off' | 'unauthenticated' | 'forbidden'
  | 'not_opened' | 'already_accepted' | 'already_rejected' | 'not_found'
  | 'key_rejected' | 'key_forbidden' | 'sef_refused' | 'sef_unavailable'
  | 'saved_on_sef_only' | 'no_credentials' | 'bad_request' | 'failed'
  // Decided or withdrawn on SEF outside the app (`sefDecisionGuard.ts`).
  | 'accepted_outside' | 'rejected_outside' | 'withdrawn'

export type SefDecideResult =
  | {
      ok: true
      decision: SefDecision
      sefStatus: string
      invoiceNumber: string | null
      decidedAt: string | null
      decidedByName: string | null
      /** The decision is on SEF, but the attempt could not be added to the history. */
      warning: string | null
    }
  | { ok: false; code: SefDecideErrorCode; message: string; httpStatus: number | null }

/** The smallest slice of the Supabase client this needs. */
export interface FunctionsClientLike {
  functions: {
    invoke: (name: string, options: { body: Record<string, any> }) => Promise<{ data: any; error: any }>
  }
}

export interface FlagsClientLike {
  from: (table: string) => any
}

export const SEF_DECISIONS_FLAG = 'sef_decisions_enabled'
export const SWITCH_OFF_MESSAGE = 'Odlučivanje na SEF-u nije uključeno (Podešavanja)'
export const COMMENT_REQUIRED_MESSAGE = 'Za odbijanje na SEF-u potreban je komentar.'

// ── SEF's answer ───────────────────────────────────────────────────────────

/** A key read without regard to case: the live server answers PascalCase,
 *  the published schema says camelCase. */
export function ci(obj: unknown, key: string): unknown {
  if (!obj || typeof obj !== 'object') return undefined
  const want = key.toLowerCase()
  for (const [k, v] of Object.entries(obj as Record<string, unknown>)) {
    if (k.toLowerCase() === want) return v
  }
  return undefined
}

export interface SefDecisionAnswer {
  success: boolean | null
  status: string | null
  invoiceNumber: string | null
  message: string | null
}

/** `{"Message":null,"HttpStatus":null,"Invoice":{"InvoiceNumber":"…","Status":"Approved"},"Success":true}`,
 *  in either spelling. Anything unreadable comes back as nulls, never a throw. */
export function readSefDecisionResponse(body: unknown): SefDecisionAnswer {
  const invoice = ci(body, 'invoice')
  const success = ci(body, 'success')
  const status = ci(invoice, 'status')
  const number = ci(invoice, 'invoiceNumber')
  const message = ci(body, 'message')
  const text = (v: unknown) => (typeof v === 'string' && v.trim() ? v.trim() : null)
  return {
    success: typeof success === 'boolean' ? success : null,
    status: text(status),
    invoiceNumber: text(number),
    message: text(message),
  }
}

// ── Asking ─────────────────────────────────────────────────────────────────

const CODES: readonly SefDecideErrorCode[] = [
  'comment_required', 'switch_off', 'unauthenticated', 'forbidden',
  'not_opened', 'already_accepted', 'already_rejected', 'not_found',
  'key_rejected', 'key_forbidden', 'sef_refused', 'sef_unavailable',
  'saved_on_sef_only', 'no_credentials', 'bad_request', 'failed',
  'accepted_outside', 'rejected_outside', 'withdrawn',
]

/** What the function's status means when its body names no code. */
function codeForStatus(status: number | null): SefDecideErrorCode {
  if (status === 401) return 'key_rejected'
  if (status === 403) return 'forbidden'
  if (status === 409) return 'switch_off'
  if (status === 404) return 'not_found'
  if (status === 400) return 'bad_request'
  if (status === 422) return 'sef_refused'
  if (status !== null && (status === 502 || status === 503 || status === 504)) return 'sef_unavailable'
  return 'failed'
}

const DEFAULT_MESSAGE: Partial<Record<SefDecideErrorCode, string>> = {
  switch_off: SWITCH_OFF_MESSAGE,
  comment_required: COMMENT_REQUIRED_MESSAGE,
  key_rejected: 'SEF je odbio API ključ.',
  sef_unavailable: 'SEF nije dostupan, pokušajte ponovo.',
}

/** A failed invoke carries the function's real answer in `error.context`. */
async function failureFrom(err: any): Promise<SefDecideResult> {
  const ctx = err?.context
  const httpStatus: number | null = typeof ctx?.status === 'number' ? ctx.status : null
  let body: any = null
  try { body = await ctx?.json?.() } catch { body = null }
  const named = typeof body?.code === 'string' && (CODES as readonly string[]).includes(body.code)
    ? body.code as SefDecideErrorCode : null
  const code = named ?? codeForStatus(httpStatus)
  const message = (typeof body?.error === 'string' && body.error)
    || (typeof body?.message === 'string' && body.message)
    || DEFAULT_MESSAGE[code]
    || (httpStatus && httpStatus >= 500 ? 'Odluka nije upisana. Pokušajte ponovo kasnije.' : null)
    || err?.message
    || 'Poziv nije uspeo.'
  return { ok: false, code, message, httpStatus }
}

/**
 * Asks `sef-decide` to accept or reject one invoice on SEF.
 *
 * A rejection without a comment is refused here, before anything is sent: SEF
 * refuses it anyway, and the round trip would only cost time.
 *
 * Never retries. The call is not safe to repeat — the caller shows the answer
 * and the person decides.
 */
export async function decideOnSef(client: FunctionsClientLike, req: SefDecisionRequest): Promise<SefDecideResult> {
  const comment = (req.comment || '').trim()
  if (!req.accepted && !comment) {
    return { ok: false, code: 'comment_required', message: COMMENT_REQUIRED_MESSAGE, httpStatus: null }
  }

  let data: any, error: any
  try {
    ({ data, error } = await client.functions.invoke('sef-decide', {
      body: { inbox_id: req.inboxId, accepted: req.accepted, comment },
    }))
  } catch (e) {
    return { ok: false, code: 'failed', message: e instanceof Error ? e.message : String(e), httpStatus: null }
  }
  if (error) return failureFrom(error)

  if (!data?.ok) {
    const code = typeof data?.code === 'string' && (CODES as readonly string[]).includes(data.code)
      ? data.code as SefDecideErrorCode : 'failed'
    return { ok: false, code, message: data?.error || 'Odluka nije upisana.', httpStatus: null }
  }

  return {
    ok: true,
    decision: data.decision === 'rejected' ? 'rejected' : 'accepted',
    sefStatus: String(data.sef_status || (req.accepted ? 'Approved' : 'Rejected')),
    invoiceNumber: data.invoice_number ?? null,
    decidedAt: data.decided_at ?? null,
    decidedByName: data.decided_by_name ?? null,
    warning: data.record_error ?? null,
  }
}

/** The switch. Anything but a readable `true` is OFF: the feature is opted into. */
export async function readSefDecisionsEnabled(client: FlagsClientLike): Promise<boolean> {
  try {
    const { data, error } = await client.from('feature_flags')
      .select('enabled').eq('name', SEF_DECISIONS_FLAG).maybeSingle()
    if (error) return false
    return data?.enabled === true
  } catch {
    return false
  }
}

// ── What the row says ──────────────────────────────────────────────────────

export interface DecisionRowLike {
  ubl_fetched_at: string | null
  sef_decision: SefDecision | null
}

/** Which of the two SEF buttons a row offers. Accepted is final; rejected may
 *  still be accepted; a row nobody has opened offers neither. */
export function decisionActions(row: DecisionRowLike): { accept: boolean; reject: boolean } {
  if (!row.ubl_fetched_at) return { accept: false, reject: false }
  if (row.sef_decision === 'accepted') return { accept: false, reject: false }
  if (row.sef_decision === 'rejected') return { accept: true, reject: false }
  return { accept: true, reject: true }
}
