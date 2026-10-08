// supabase/functions/exchange-rate/index.ts
//
// Proxy za exchangerate-api.com — fallback kurs kad NBS nije dostupan.
//
// Postoji da API kljuc NE bi bio u frontendu. Ranije je citan kao
// REACT_APP_EXCHANGE_API_KEY, a sve sa tim prefiksom webpack ugradi u
// javni JS bundle — kljuc je bio vidljiv svakome ko otvori aplikaciju.
// Ovdje kljuc zivi u Supabase secrets i nikad ne napusta server.
//
// Poziva se iz React-a:
//   /functions/v1/exchange-rate?currency=EUR
//
// Odgovor:
//   { currency: "EUR", rsdRate: 117.2345, source: "exchangerate-api.com" }
//
// rsdRate = koliko RSD vrijedi jedna jedinica trazene valute.

import { serve } from 'https://deno.land/std@0.168.0/http/server.ts'

const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
}

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), {
    status,
    headers: { ...corsHeaders, 'Content-Type': 'application/json' },
  })

// Samo valute koje aplikacija stvarno koristi. Bez ovoga bi proxy bio otvoren
// relej za proizvoljne pozive prema exchangerate-api, na racun naseg kljuca.
const ALLOWED = new Set(['RSD', 'EUR', 'USD', 'AED'])

// Mijenjati pri svakoj izmjeni. Vraca se uz greske da se iz odgovora vidi
// koja verzija je zaista deployovana — poruke same po sebi to ne otkrivaju.
const FN_VERSION = 'v5'

serve(async (req) => {
  if (req.method === 'OPTIONS') {
    return new Response('ok', { headers: corsHeaders })
  }

  try {
    const apiKey = Deno.env.get('EXCHANGE_API_KEY')
    if (!apiKey) {
      return json({ error: 'EXCHANGE_API_KEY nije podesen na serveru' }, 500)
    }

    const params = new URL(req.url).searchParams
    const currency = (params.get('currency') || '').toUpperCase()
    if (!currency) return json({ error: 'Nedostaje parametar currency' }, 400)
    if (!ALLOWED.has(currency)) {
      return json({ error: `Valuta ${currency} nije podrzana` }, 400)
    }

    // RSD prema samom sebi je uvijek 1 — nema potrebe trositi poziv.
    if (currency === 'RSD') {
      return json({ currency, rsdRate: 1, source: 'exchangerate-api.com (trivijalno)' })
    }

    const r = await fetch(
      `https://v6.exchangerate-api.com/v6/${apiKey}/pair/RSD/${currency}`,
    )

    // Tijelo se cita i kad odgovor nije OK: exchangerate-api salje razlog u
    // `error-type` (npr. invalid-key, inactive-account, quota-reached), a bez
    // toga se sve svodi na neupotrebljivo "HTTP 404".
    const data = await r.json().catch(() => null)

    if (!r.ok) {
      const kind = data?.['error-type']
      console.error('exchangerate-api HTTP', r.status, kind ?? '(bez error-type)')
      // `error-type` je kategorija greske, ne sadrzi kljuc — bezbjedno za klijenta.
      return json({
        fnVersion: FN_VERSION,
        error: `exchangerate-api: ${kind ?? 'HTTP ' + r.status}`,
        hint: kind === 'invalid-key' ? 'EXCHANGE_API_KEY na serveru nije ispravan ili je deaktiviran'
            : kind === 'inactive-account' ? 'Nalog na exchangerate-api nije aktivan'
            : kind === 'quota-reached' ? 'Potrosena mjesecna kvota'
            : undefined,
      }, 502)
    }

    if (data?.result !== 'success' || typeof data.conversion_rate !== 'number') {
      console.error('exchangerate-api neuspjesan odgovor:', data?.['error-type'] ?? data?.result)
      return json({ error: `exchangerate-api: ${data?.['error-type'] ?? 'neuspjesan odgovor'}` }, 502)
    }

    // API vraca RSD -> currency; nama treba koliko RSD vrijedi jedna jedinica.
    const rsdRate = 1 / data.conversion_rate
    if (!isFinite(rsdRate) || rsdRate <= 0) {
      return json({ error: 'exchangerate-api: neupotrebljiv kurs' }, 502)
    }

    return json({ currency, rsdRate, source: 'exchangerate-api.com' })
  } catch (err) {
    console.error('exchange-rate:', err)
    return json({ error: 'Greska pri dobavljanju kursa' }, 500)
  }
})
