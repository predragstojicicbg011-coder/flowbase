# FlowBase

FlowBase je šablon aplikacije za finansije jedne firme u Srbiji. Od njega
se pravi aplikacija svakog klijenta,
i svaki klijent posle dobija izmene FlowBase-a običnim `git merge`.

Kod šablona ne pominje nijednog klijenta: ime aplikacije i firme dolaze iz
promenljivih okruženja, podaci klijenta iz njegovog `supabase/client/seed.sql`.

## Šta aplikacija radi

- **Glavna knjiga i transakcije**: unos, uvoz bankovnih izvoda, povezivanje
  sa fakturama.
- **Fakture i partneri**: ulazne i izlazne fakture, ugovori, plaćeno kad je
  otvoreno najviše 1 RSD.
- **Prihodi**: građevinske situacije, zakup, avansi; prihod po fakturisanju
  (accrual).
- **Projekti**: gradilišta i objekti u zakupu; trošak bez projekta je opšti
  trošak.
- **P&L, novčani tok, budžet i prognoza, analiza troškova, izveštaji.**
- **Krediti**: rate, produženja, knjiženje kamate.
- **Zarade**: obračun po srpskim propisima, raspodela po satima na projekte.
- **Valute**: knjige u RSD, uz svaki zapis i EUR po srednjem kursu NBS na
  dan (Edge funkcija `nbs-rate`).
- **Korisnici i uloge**: administrator, vlasnik, menadžer, administrativni
  asistent; nalog bez profila ne vidi ništa.

Interfejs je na srpskom, latinicom ([docs/recnik.md](docs/recnik.md)).

## Tehnologije

- React 19 + TypeScript, Create React App (`react-scripts` 5), React Router
- Supabase: Postgres sa RLS, Auth, Edge Functions (Deno)
- Vercel za hosting, iz GitHub repoa klijenta
- Jest + Testing Library

## Struktura

| Putanja | Šta je |
|---|---|
| `src/config/brand.ts` | jedino mesto koje čita ime aplikacije i firme |
| `supabase/migrations/` | zajednička šema; menja se samo u FlowBase-u |
| `supabase/functions/` | Edge funkcije (`nbs-rate`, `exchange-rate`) |
| `supabase/client/seed.example.sql` | primer podataka klijenta; klijent pravi svoj `seed.sql` |
| `scripts/db-push.sh` | migracije na linkovani projekat (`npx supabase db push`) |
| `scripts/seed-client.sh` | `seed.sql` klijenta kroz psql |
| `docs/` | uputstva; dokumentacija jednog klijenta ide u `docs/klijent/` u njegovom repou |

## Lokalno pokretanje

```bash
npm ci
cp .env.example .env      # popuni Supabase URL i anon ključ, ime aplikacije i firme
npm start
```

`.env`:

```
REACT_APP_SUPABASE_URL=https://<ref>.supabase.co
REACT_APP_SUPABASE_ANON_KEY=<anon public ključ>
REACT_APP_APP_NAME=FlowBase
REACT_APP_COMPANY_NAME=Demo d.o.o.
REACT_APP_COMPANY_SHORT=
REACT_APP_TAGLINE=
```

Sve `REACT_APP_*` vrednosti završe u javnom JS-u. Tajne (lozinka baze,
access token) idu samo u gitignored `.supabase-cli.env`.

Provere pre svakog commit-a:

```bash
npx tsc --noEmit -p .
CI=true npx react-scripts test --watchAll=false
CI=true npm run build
```

Testovi ne traže `.env` i nikad ne zovu pravu bazu.

## Uputstva

- [docs/NOVI-KLIJENT.md](docs/NOVI-KLIJENT.md) — pokretanje aplikacije za
  novog klijenta, korak po korak.
- [docs/NADOGRADNJA.md](docs/NADOGRADNJA.md) — kako izmene FlowBase-a stižu
  do klijenata i pravila koja to omogućavaju.
