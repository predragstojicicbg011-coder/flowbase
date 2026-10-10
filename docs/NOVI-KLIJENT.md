# Novi klijent: od FlowBase-a do aplikacije koja radi

Lista koraka za pokretanje aplikacije za novog klijenta. Radi se redom;
svaki korak koji nešto menja na nalogu klijenta proveri dvaput: **koji
folder, koji nalog, koji projekat**.

U primerima je klijent „Alfa Gradnja doo“, aplikacija „AlfaFlow“, repo
`alfaflow`. Zameni ih pravim imenima.

## 1. Odvojeni nalozi

Svaki klijent ima svoje naloge i ništa se ne deli sa drugim klijentima.

- [ ] Novi profil u pretraživaču (npr. Edge profil „AlfaFlow“). Sve prijave
      za ovog klijenta (GitHub, Supabase, Vercel) idu samo kroz taj profil.
- [ ] Email adresa za naloge klijenta.
- [ ] GitHub nalog (ili organizacija) na toj adresi.
- [ ] Supabase nalog na toj adresi, sa uključenim MFA
      (Account → Security).
- [ ] Vercel nalog prijavljen preko tog GitHub naloga.

## 2. Repo klijenta na GitHub-u

Repo se pravi **pushovanjem klona FlowBase-a, sa celom istorijom**:

```bash
cd "C:/Users/Predrag PC"
git clone "C:/Users/Predrag PC/flowbase" alfaflow
cd alfaflow
git remote rename origin flowbase        # FlowBase ostaje izvor nadogradnji
git remote set-url --push flowbase no-push
# na GitHub-u napravi PRAZAN privatni repo alfaflow (bez README-a i licence)
git remote add origin https://github.com/<nalog-klijenta>/alfaflow.git
git config user.email "<email klijenta>"
git push -u origin main
```

Zašto ne GitHub-ovo dugme „Use this template“: ono pravi repo sa **novom
istorijom**, bez zajedničkog commit-a sa FlowBase-om. Tada `git merge
flowbase/main` nema od čega da krene, svaka nadogradnja je jedan veliki
konflikt i nadogradnje praktično prestaju. Klon sa istorijom zadržava
zajedničke commit-e, pa se nadogradnje spajaju same (vidi
[NADOGRADNJA.md](NADOGRADNJA.md)).

## 3. Supabase projekat

- [ ] Novi projekat, region **Frankfurt (eu-central-1)**. Lozinku baze
      generiši i sačuvaj.
- [ ] Access token: Account → Access Tokens → Generate new token.
- [ ] U korenu repoa napravi `.supabase-cli.env` (gitignored, nikad u git):

      SUPABASE_ACCESS_TOKEN=sbp_...
      SUPABASE_DB_PASSWORD=...

- [ ] Linkuj projekat (bez `supabase login`; token se čita iz fajla):

  ```bash
  export SUPABASE_ACCESS_TOKEN="$(grep '^SUPABASE_ACCESS_TOKEN=' .supabase-cli.env | cut -d= -f2- | tr -d '\r')"
  npx supabase link --project-ref <ref>
  cat supabase/.temp/project-ref          # mora biti <ref> ovog klijenta
  ```

  Supabase CLI se uvek poziva kao `npx supabase …`. Golog `supabase` na
  ovoj mašini nema, a greška „command not found“ lako se pročita kao da je
  posao gotov.

- [ ] Šema: `bash scripts/db-push.sh` (pokaže ref projekta i traži „da“).
- [ ] Edge funkcija za NBS kurs:

  ```bash
  npx supabase functions deploy nbs-rate --project-ref <ref> --use-api
  ```

  Funkcija `exchange-rate` je rezervna i treba joj tajni ključ
  (`npx supabase secrets set EXCHANGE_API_KEY=… --project-ref <ref>`); bez
  nje aplikacija radi, samo nema rezervnog izvora kursa.

## 4. Podaci klijenta i prvi administrator

- [ ] Supabase Dashboard → Authentication → Users → Add user → Create new
      user: email i lozinka administratora („Auto Confirm User“ uključeno).
- [ ] Seed klijenta:

  ```bash
  cp supabase/client/seed.example.sql supabase/client/seed.sql
  # u seed.sql popuni company_name, admin_email, admin_name; obriši banke
  # koje klijent nema
  bash scripts/seed-client.sh
  git add supabase/client/seed.sql && git commit -m "chore(client): seed"
  ```

  Skripta traži psql (`$PSQL`, pa PATH, pa scoop instalacija) i ide preko
  session pooler-a; region se menja sa `SUPABASE_REGION=…` ako projekat nije
  u Frankfurtu. Na kraju ispiše firmu, broj banaka i administratore.
  `seed.sql` postoji samo u repou klijenta; u FlowBase-u ga nema.

## 5. Podešavanja autentikacije (Supabase Dashboard)

- [ ] Authentication → Sign In / Providers: **Allow new users to sign up
      isključeno**. Korisnike pravi administrator.
- [ ] Anonymous sign-ins: **isključeno**.
- [ ] Authentication → URL Configuration: **Site URL** = produkcioni domen
      (npr. `https://alfaflow.vercel.app`), **Redirect URLs** = isti domen
      (`https://alfaflow.vercel.app/**`) i `http://localhost:3000/**` za
      lokalni rad.

## 6. Vercel

- [ ] New Project → Import iz GitHub repoa klijenta (Create React App se
      prepozna sam).
- [ ] Environment Variables (Production, Preview i Development):

  | Promenljiva | Vrednost |
  |---|---|
  | `REACT_APP_SUPABASE_URL` | Project Settings → API → Project URL |
  | `REACT_APP_SUPABASE_ANON_KEY` | Project Settings → API → anon public |
  | `REACT_APP_APP_NAME` | `AlfaFlow` |
  | `REACT_APP_COMPANY_NAME` | `Alfa Gradnja doo` |
  | `REACT_APP_COMPANY_SHORT` | `Alfa Gradnja` (opciono) |
  | `REACT_APP_TAGLINE` | opciono |

  Sve `REACT_APP_*` vrednosti završe u javnom JS-u; tu ne sme ništa tajno.
  Promena promenljive važi tek posle novog deploy-a (Redeploy).
- [ ] Deploy. **Produkcioni domen** (`alfaflow.vercel.app`) je javan i njega
      klijent koristi. Adrese pojedinačnih deploy-eva (sa hešom u imenu)
      stoje iza Vercel prijave (Deployment Protection); klijentu se nikad ne
      šalju.
- [ ] Lokalno: `.env` iz `.env.example`, sa istim vrednostima.

## 7. Prva prijava — provera

- [ ] Produkcioni domen otvara stranicu za prijavu sa imenom aplikacije i
      firme klijenta (ne „FlowBase“ / „Demo“) i pravim naslovom taba.
- [ ] Administrator se prijavljuje; Podešavanja → Korisnici ga prikazuju kao
      administratora.
- [ ] Podešavanja → Banke prikazuje banke iz seed-a.
- [ ] Nalog bez profila ne vidi ništa (politika `members_only`).
- [ ] Unos transakcije u stranoj valuti povuče NBS kurs (funkcija
      `nbs-rate` radi).

## 8. Podešavanje u aplikaciji (ovim redom)

1. **Profil firme** (Podešavanja → Profili firmi): pravno ime, PIB, MB,
   adresa, računi.
2. **P&L struktura** (Podešavanja → P&L kategorije): kategorije i
   potkategorije klijenta, na srpskom.
3. **Sistemske kategorije** (Podešavanja → Sistemske kategorije): svakoj
   ulozi dodeli naslov iz P&L strukture. Dok uloga nije dodeljena,
   automatsko knjiženje (plate, krediti) odbija da knjiži.
4. **Projekti**: gradilišta i objekti u zakupu.
5. **Krediti**: unos ili uvoz liste kredita.

Posle toga ostali korisnici (Podešavanja → Korisnici), pa redovan rad.
