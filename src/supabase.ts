import { createClient } from '@supabase/supabase-js'

const supabaseUrl = process.env.REACT_APP_SUPABASE_URL!
const supabaseKey = process.env.REACT_APP_SUPABASE_ANON_KEY!

// ─────────────────────────────────────────────────────────────────────────────
// Ukljucivanje tipova iz seme (dva koraka):
//
//   1) npx supabase login
//   2) npm run gen:types          -> pravi src/types/database.ts
//
//   3) zatim ovdje odkomentarisi import i zamijeni createClient sa varijantom
//      ispod:
//
//        import type { Database } from './types/database'
//        export const supabase = createClient<Database>(supabaseUrl, supabaseKey, { ... })
//
// Nakon toga TypeScript hvata pogresna imena kolona, pogresne tipove u
// insert/update i nepostojece tabele. Ocekuj seriju gresaka pri prvom
// kompajliranju — to su stvarna neslaganja koda i seme.
// ─────────────────────────────────────────────────────────────────────────────
export const supabase = createClient(supabaseUrl, supabaseKey, {
  auth: {
    autoRefreshToken: true,
    persistSession: true,
  }
})
