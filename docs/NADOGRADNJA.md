# Nadogradnja: kako izmene iz FlowBase-a stižu do klijenata

FlowBase je šablon. Svaka aplikacija klijenta (MCFlow i sve sledeće) je
klon FlowBase-a sa zajedničkom istorijom, pa se izmene prenose običnim
`git merge`. Da bi spajanje prolazilo bez konflikata, FlowBase i repoi
klijenata drže se pravila ispod.

## Postupak (u repou klijenta)

Jednom, ako remote još ne postoji:

```bash
git remote add flowbase <url ili putanja FlowBase repoa>
git remote set-url --push flowbase no-push     # u FlowBase se odavde ne pushuje
```

Svaki put:

```bash
git status                       # mora biti čisto
git fetch flowbase
git log --oneline main..flowbase/main          # šta stiže
git merge flowbase/main
npx tsc --noEmit -p .
CI=true npx react-scripts test --watchAll=false
bash scripts/db-push.sh          # nove migracije; pokaže ref, traži „da“
git push                         # Vercel sam napravi novi deploy
```

Posle push-a otvori produkcioni domen i proveri prijavu i stranu koja je
menjana.

## Pravila

1. **Šema se menja samo u FlowBase-u.** Folder `supabase/migrations/` je
   zajednički i pripada FlowBase-u. Klijent nikad ne dodaje svoju migraciju:
   dve grane sa različitim migracijama znače dve različite baze, i sledeća
   nadogradnja više ne može da se primeni čisto.
2. **Migracije ne nose podatke klijenta.** Imena firmi, banke, korisnici i
   sve ostalo što važi za jednog klijenta ide u `supabase/client/seed.sql`
   tog klijenta (pravi se iz `seed.example.sql`, pokreće se sa
   `scripts/seed-client.sh`). FlowBase sadrži samo primer.
3. **Svaka nova tabela dobija RLS i politiku `members_only`.** Uzor je
   migracija `20261010090000_members_only_and_payroll_closed.sql`:
   `enable row level security`, RESTRICTIVE politika `members_only`
   (`public.is_member()`) i permisivne politike za čitanje i pisanje po
   ulogama. Bez toga nalog bez profila vidi tabelu:

   ```sql
   alter table public.nova_tabela enable row level security;
   create policy members_only on public.nova_tabela as restrictive
     for all to authenticated
     using (public.is_member()) with check (public.is_member());
   ```

   `anon` nema prava ni na jednu tabelu (podrazumevana prava je oduzela
   `20261008151000_close_anon_access.sql`); migracija mu ih ne sme vratiti.
4. **Svaka migracija FlowBase-a prvo se proba na bazi `flowbase-demo`, od
   PRAZNE baze**: sve migracije redom, pa seed iz `seed.example.sql`, pa
   prijava. Tek kad to prođe, migracija ide u `main` FlowBase-a. Migracija
   koja radi samo na bazi sa podacima jednog klijenta nije gotova.
5. **Već primenjena migracija se ne preimenuje.** Verzija u imenu fajla je
   ono što baza pamti; preimenovan fajl izgleda kao nova migracija. Sadržaj
   stare migracije se menja samo kad to ne menja bazu koja ju je već
   primenila (npr. uklanjanje podataka klijenta).
6. **Identitet klijenta je u promenljivim okruženja, ne u kodu.**
   `REACT_APP_APP_NAME`, `REACT_APP_COMPANY_NAME`, `REACT_APP_COMPANY_SHORT`,
   `REACT_APP_TAGLINE` čita samo `src/config/brand.ts`; vrednosti su u
   `.env` i na Vercelu. Nijedan fajl u `src/` i `public/` ne sme da
   pomene klijenta.
7. **Kod samo za jednog klijenta stoji odvojeno.** Ako klijentu zaista treba
   nešto što ostali nemaju, to ide u jasno odvojena mesta koja FlowBase ne
   dira: `docs/klijent/` za dokumentaciju klijenta, `supabase/client/` za
   njegove podatke, a za kod poseban fajl (npr. `src/client/…`) umesto
   izmena po zajedničkim fajlovima. Sve što ima smisla za više klijenata
   radi se u FlowBase-u i stiže nadogradnjom.

## Konflikti

- Konflikt znači da su isti redovi menjani i u FlowBase-u i kod klijenta.
  Najčešće je to znak da je izmena kod klijenta trebalo da ide u FlowBase.
- Rešavaj u korist FlowBase-a, pa izmenu klijenta ponovo dodaj na odvojeno
  mesto (pravilo 7). `git checkout --theirs <fajl>` uzima verziju
  FlowBase-a.
- Konflikt u `supabase/migrations/` se ne rešava ručnim spajanjem SQL-a:
  uzmi verziju FlowBase-a, a razliku kod klijenta pretvori u predlog za
  FlowBase.
- Fajl koji je FlowBase obrisao, a klijent ga i dalje treba (npr.
  dokumentacija klijenta): `git merge --no-commit flowbase/main`, pa
  `git checkout HEAD -- <fajl>` i premesti ga u `docs/klijent/`.
- Ako nešto krene po zlu pre commit-a: `git merge --abort` vraća stanje
  pre spajanja.

## Prva nadogradnja MCFlow-a

MCFlow je nastao pre FlowBase-a, pa prvo spajanje ima tri posebna koraka:

1. FlowBase je obrisao `docs/plan-mcflow.md` (to je dokumentacija samo
   MCFlow-a). Spajaj sa `git merge --no-ff --no-commit flowbase/main`, pa
   `git checkout HEAD -- docs/plan-mcflow.md` i
   `git mv docs/plan-mcflow.md docs/klijent/plan-mcflow.md`, pa commit.
2. U `.env` i na Vercelu upiši `REACT_APP_APP_NAME=MCFlow`,
   `REACT_APP_COMPANY_NAME=Milinković Company doo` (kratko ime se izvede
   samo). Bez njih aplikacija se predstavlja kao „FlowBase / Demo“.
3. Napravi `supabase/client/seed.sql` iz primera sa pravim vrednostima i
   commituj ga. Migracije `20261008140000` i `20261008190000` više ne
   ubacuju firmu i banke, ali baza MCFlow-a ih već ima, pa se seed ne mora
   pokretati (ako se pokrene, ništa ne duplira).
