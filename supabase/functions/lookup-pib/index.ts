import { createClient } from 'https://esm.sh/@supabase/supabase-js@2'
import { registerSearchUrl, parseRegisterPage, companyFromRows, type RegisterRow } from './nbsRegister.ts'

// ─── A company from the NBS account register ────────────────────────────────
//
// POST { mb }   (matični broj, 8 digits)
//
// Reads the public Jedinstveni registar računa of the National Bank of Serbia
// (nbsRegister.ts) and answers the partner form with the company's name, PIB,
// address and place, and its open dinar accounts with their banks:
//
//   { success: true, name, pib, mb, address, city, municipality, activity,
//     accounts: [{ account, bankName, opened }] }
//   { success: false, error }
//
// No AI and no paid service: one plain request per page of the register.
// Members only (is_member(), asked with the caller's own token), so the
// function is not an open relay to the register.

const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
}

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), {
    status, headers: { ...corsHeaders, 'Content-Type': 'application/json' },
  })

const fail = (status: number, error: string) => json({ success: false, error }, status)

const NBS_TIMEOUT_MS = 20_000
/** The register pages its answer; a company with this many pages of accounts does not exist. */
const MAX_PAGES = 10

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: corsHeaders })
  if (req.method !== 'POST') return fail(405, 'Samo POST.')

  // ── WHO IS CALLING ──────────────────────────────────────────────────────
  const url = Deno.env.get('SUPABASE_URL')!
  const supabase = createClient(url, Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!)
  const bearer = (req.headers.get('Authorization') || '').replace(/^Bearer\s+/i, '').trim()
  if (!bearer) return fail(401, 'Prijavite se ponovo.')
  const { data: who, error: whoErr } = await supabase.auth.getUser(bearer)
  if (whoErr || !who?.user) return fail(401, 'Prijavite se ponovo.')
  const anonKey = Deno.env.get('SUPABASE_ANON_KEY') || ''
  if (!anonKey) return fail(500, 'Funkciji nedostaje SUPABASE_ANON_KEY.')
  const asCaller = createClient(url, anonKey, {
    global: { headers: { Authorization: `Bearer ${bearer}` } },
    auth: { persistSession: false, autoRefreshToken: false },
  })
  const member = await asCaller.rpc('is_member')
  if (member.error) return fail(500, `Uloga nije mogla da se proveri: ${member.error.message}`)
  if (member.data !== true) return fail(403, 'Registar pretražuju samo članovi firme.')

  // ── WHAT IS ASKED ───────────────────────────────────────────────────────
  let body: any = {}
  try { body = await req.json() } catch { /* empty body */ }
  const mb = String(body?.mb ?? '').replace(/\D/g, '')
  if (mb.length !== 8) return fail(400, 'Matični broj ima 8 cifara.')

  // ── THE REGISTER, PAGE BY PAGE ──────────────────────────────────────────
  const rows: RegisterRow[] = []
  const seen = new Set<string>()
  let total = 0
  try {
    for (let page = 1; page <= MAX_PAGES; page++) {
      const res = await fetch(registerSearchUrl(mb, page), {
        headers: { 'Accept': 'text/html', 'Accept-Language': 'sr' },
        signal: AbortSignal.timeout(NBS_TIMEOUT_MS),
      })
      if (!res.ok) return fail(502, `Registar NBS je odgovorio ${res.status}.`)
      const parsed = parseRegisterPage(await res.text())
      total = parsed.total
      const fresh = parsed.rows.filter(r => !seen.has(r.account))
      fresh.forEach(r => { seen.add(r.account); rows.push(r) })
      if (fresh.length === 0 || rows.length >= total) break
    }
  } catch (e) {
    return fail(502, `Registar NBS nije dostupan: ${e instanceof Error ? e.message : String(e)}`)
  }

  const company = companyFromRows(rows)
  if (!company) return json({ success: false, error: 'U registru NBS nema firme sa tim matičnim brojem.' })
  return json({ success: true, ...company })
})
