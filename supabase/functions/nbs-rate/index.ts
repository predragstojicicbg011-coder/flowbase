// supabase/functions/nbs-rate/index.ts
// Proxy za kurs.resenje.org — rešava CORS problem
// Poziva se iz React-a: /functions/v1/nbs-rate?currency=usd&date=2026-04-15

import { serve } from 'https://deno.land/std@0.168.0/http/server.ts'

const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
}

serve(async (req) => {
  // CORS preflight
  if (req.method === 'OPTIONS') {
    return new Response('ok', { headers: corsHeaders })
  }

  try {
    const url = new URL(req.url)
    const currency = url.searchParams.get('currency')?.toLowerCase() || 'usd'
    const date = url.searchParams.get('date') || new Date().toISOString().split('T')[0]

    const apiUrl = `https://kurs.resenje.org/api/v1/currencies/${currency}/rates/${date}`
    const response = await fetch(apiUrl)

    if (!response.ok) {
      // Ako nema kursa za taj datum (vikend/praznik), probaj prethodna 3 dana
      for (let i = 1; i <= 3; i++) {
        const d = new Date(date)
        d.setDate(d.getDate() - i)
        const fallbackDate = d.toISOString().split('T')[0]
        const r2 = await fetch(`https://kurs.resenje.org/api/v1/currencies/${currency}/rates/${fallbackDate}`)
        if (r2.ok) {
          const data = await r2.json()
          return new Response(JSON.stringify(data), {
            headers: { ...corsHeaders, 'Content-Type': 'application/json' }
          })
        }
      }
      throw new Error(`No rate found for ${currency} on ${date}`)
    }

    const data = await response.json()
    return new Response(JSON.stringify(data), {
      headers: { ...corsHeaders, 'Content-Type': 'application/json' }
    })

  } catch (err) {
    return new Response(JSON.stringify({ error: err.message }), {
      status: 500,
      headers: { ...corsHeaders, 'Content-Type': 'application/json' }
    })
  }
})