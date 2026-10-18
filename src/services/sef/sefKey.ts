// The SEF API key, as the app sees it: set by the administrator, never read
// back. The database keeps it (`sef_set_api_key`, `sef_key_status`, migration
// 20261018180000) and the edge function `sef-check` tries it with one
// harmless SEF call. Nothing here ever holds the key after it is sent.

export type SefEnvironment = 'production' | 'demo'

export interface SefKeyStatus {
  configured: boolean
  /** 'other' when the row points at a server that is neither of the two. */
  environment: SefEnvironment | 'other' | null
  last4: string | null
  setAt: string | null
  setByName: string | null
  companyId: string | null
  companyName: string | null
}

export type SefCheckResult =
  | { ok: true; environment: string | null; invoicesSeen: number; message: string }
  | { ok: false; code: string; message: string; httpStatus: number | null }

export interface RpcClientLike {
  rpc: (fn: string, args?: Record<string, any>) => PromiseLike<{ data: any; error: any }>
}

export interface FunctionsClientLike {
  functions: {
    invoke: (name: string, options: { body: Record<string, any> }) => Promise<{ data: any; error: any }>
  }
}

export const NOT_CONFIGURED: SefKeyStatus = {
  configured: false, environment: null, last4: null, setAt: null,
  setByName: null, companyId: null, companyName: null,
}

// ── Validation (mirrors sef_set_api_key) ───────────────────────────────────

const UUID = /^[0-9A-Fa-f]{8}-[0-9A-Fa-f]{4}-[0-9A-Fa-f]{4}-[0-9A-Fa-f]{4}-[0-9A-Fa-f]{12}$/

export const KEY_EMPTY_MESSAGE = 'Unesite SEF API ključ.'
export const KEY_SHAPE_MESSAGE =
  'To ne liči na SEF API ključ (očekuje se oblik 462d9282-22cf-4d0b-afbe-17411d375a18).'
export const ENVIRONMENT_MESSAGE = 'Okruženje mora biti produkcija ili demo.'
export const KEY_REJECTED_MESSAGE =
  'SEF je odbio ključ — proverite da je ključ aktivan u SEF portalu (Podešavanja → API upravljanje)'
export const SEF_UNAVAILABLE_MESSAGE = 'SEF nije dostupan'

/** The same refusals the database gives, said before the round trip. */
export function validateSefKey(key: string, environment: string): string | null {
  const k = (key || '').trim()
  if (!k) return KEY_EMPTY_MESSAGE
  if (!UUID.test(k)) return KEY_SHAPE_MESSAGE
  if (environment !== 'production' && environment !== 'demo') return ENVIRONMENT_MESSAGE
  return null
}

// ── Status ─────────────────────────────────────────────────────────────────

export function mapSefKeyStatus(data: unknown): SefKeyStatus {
  const r: any = Array.isArray(data) ? data[0] : data
  if (!r || r.configured !== true) return { ...NOT_CONFIGURED }
  const env = r.environment === 'production' || r.environment === 'demo' || r.environment === 'other'
    ? r.environment : null
  const last4 = typeof r.last4 === 'string' && r.last4 ? r.last4.slice(-4) : null
  return {
    configured: true,
    environment: env,
    last4,
    setAt: r.set_at ?? null,
    setByName: r.set_by_name ?? null,
    companyId: r.company_id ?? null,
    companyName: r.company_name ?? null,
  }
}

export async function readSefKeyStatus(client: RpcClientLike): Promise<{ status: SefKeyStatus; error: string | null }> {
  try {
    const { data, error } = await client.rpc('sef_key_status')
    if (error) return { status: { ...NOT_CONFIGURED }, error: `Stanje ključa nije moglo da se pročita: ${error.message}` }
    return { status: mapSefKeyStatus(data), error: null }
  } catch (e) {
    return { status: { ...NOT_CONFIGURED }, error: e instanceof Error ? e.message : String(e) }
  }
}

const ENV_LABEL: Record<string, string> = { production: 'produkcija', demo: 'demo', other: 'drugi server' }

/** `18.10.2026. 20:15`, in Belgrade time. */
export function formatSetAt(iso: string | null): string | null {
  if (!iso) return null
  const d = new Date(iso)
  if (isNaN(d.getTime())) return null
  const parts = new Intl.DateTimeFormat('sr-Latn-RS', {
    timeZone: 'Europe/Belgrade', day: '2-digit', month: '2-digit', year: 'numeric',
    hour: '2-digit', minute: '2-digit', hour12: false,
  }).formatToParts(d)
  const get = (t: string) => parts.find(p => p.type === t)?.value ?? ''
  return `${get('day')}.${get('month')}.${get('year')}. ${get('hour')}:${get('minute')}`
}

/** "Ključ je podešen (…1234), produkcija — postavio Ime, 18.10.2026. 20:15" */
export function describeSefKeyStatus(st: SefKeyStatus): string {
  if (!st.configured) return 'Ključ nije podešen'
  let line = `Ključ je podešen${st.last4 ? ` (…${st.last4})` : ''}`
  if (st.environment) line += `, ${ENV_LABEL[st.environment]}`
  const when = formatSetAt(st.setAt)
  const who = [st.setByName, when].filter(Boolean).join(', ')
  if (who) line += ` — postavio ${who}`
  return line
}

// ── Saving ─────────────────────────────────────────────────────────────────

export async function saveSefKey(
  client: RpcClientLike, key: string, environment: SefEnvironment, companyId?: string | null,
): Promise<{ ok: boolean; message: string | null }> {
  const invalid = validateSefKey(key, environment)
  if (invalid) return { ok: false, message: invalid }
  const args: Record<string, any> = { p_api_key: key.trim(), p_environment: environment }
  if (companyId) args.p_company_id = companyId
  try {
    const { error } = await client.rpc('sef_set_api_key', args)
    if (error) {
      // The database's own Serbian message, or the refusal of a non-administrator.
      if (error.code === '42501') return { ok: false, message: error.message || 'SEF API ključ podešava samo administrator.' }
      return { ok: false, message: error.message || 'Ključ nije sačuvan.' }
    }
    return { ok: true, message: null }
  } catch (e) {
    return { ok: false, message: e instanceof Error ? e.message : String(e) }
  }
}

// ── Checking the connection ────────────────────────────────────────────────

function messageForStatus(status: number | null): { code: string; message: string } | null {
  if (status === 401 || status === 403) return { code: 'key_rejected', message: KEY_REJECTED_MESSAGE }
  if (status !== null && status >= 500) return { code: 'sef_unavailable', message: SEF_UNAVAILABLE_MESSAGE }
  return null
}

export function mapSefCheckSuccess(data: any): SefCheckResult {
  if (!data?.ok) {
    return { ok: false, code: data?.code || 'failed', message: data?.error || 'Provera nije uspela.', httpStatus: null }
  }
  const n = Number(data.invoices_seen)
  const invoicesSeen = Number.isFinite(n) && n >= 0 ? n : 0
  return {
    ok: true,
    environment: data.environment ?? null,
    invoicesSeen,
    message: `Veza sa SEF-om radi. Danas pristiglih faktura: ${invoicesSeen}.`,
  }
}

/** A failed invoke carries the function's real answer in `error.context`. */
export async function mapSefCheckFailure(err: any): Promise<SefCheckResult> {
  const ctx = err?.context
  const httpStatus: number | null = typeof ctx?.status === 'number' ? ctx.status : null
  let body: any = null
  try { body = await ctx?.json?.() } catch { body = null }
  const byStatus = messageForStatus(httpStatus)
  const code = (typeof body?.code === 'string' && body.code) || byStatus?.code || 'failed'
  const message = (typeof body?.error === 'string' && body.error)
    || byStatus?.message
    || err?.message
    || 'Provera nije uspela.'
  return { ok: false, code, message, httpStatus }
}

export async function checkSefConnection(client: FunctionsClientLike): Promise<SefCheckResult> {
  let data: any, error: any
  try {
    ({ data, error } = await client.functions.invoke('sef-check', { body: {} }))
  } catch (e) {
    return { ok: false, code: 'sef_unavailable', message: SEF_UNAVAILABLE_MESSAGE, httpStatus: null }
  }
  if (error) return mapSefCheckFailure(error)
  return mapSefCheckSuccess(data)
}
