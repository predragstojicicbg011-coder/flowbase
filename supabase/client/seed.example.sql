-- ============================================================================
-- Podaci jednog klijenta — PRIMER
--
-- FlowBase (sablon) sadrzi SAMO ovaj primer. Svaki klijentski repo pravi
-- svoju kopiju:
--
--     cp supabase/client/seed.example.sql supabase/client/seed.sql
--
-- popuni vrednosti ispod i commituje seed.sql u SVOJ repo. seed.sql postoji
-- samo u klijentskim repoima; u FlowBase-u ga nikad nema, pa ga `git merge`
-- iz FlowBase-a nikad ne dira.
--
-- Pokretanje (posle scripts/db-push.sh, kad sema postoji):
--
--     bash scripts/seed-client.sh
--
-- Skripta pusta psql sa ON_ERROR_STOP=1 i sve ide u jednoj transakciji.
-- Seed se sme pokrenuti vise puta: postojeca firma, banke i profil se ne
-- dupliraju.
--
-- Migracije (supabase/migrations) su zajednicka sema i NE nose podatke
-- klijenta. Sve sto je samo za ovog klijenta ide ovde.
-- ============================================================================

-- ── Vrednosti klijenta ──────────────────────────────────────────────────────
-- company_name   pravno ime, kako ga app prikazuje (companies.name)
-- company_country
-- admin_email    email naloga koji je VEC napravljen u Supabase Dashboard →
--                Authentication → Users (Add user → Create new user)
-- admin_name     ime i prezime administratora
--
-- Kratko ime firme i ime aplikacije NISU u bazi: to su promenljive okruzenja
-- REACT_APP_COMPANY_SHORT i REACT_APP_APP_NAME (.env i Vercel).

\set company_name    'Demo d.o.o.'
\set company_country 'Srbija'
\set admin_email     'admin@example.com'
\set admin_name      'Administrator'

begin;

-- ── Firma ───────────────────────────────────────────────────────────────────
-- Knjige u dinarima, evro pored njih.

insert into public.companies (name, country, currency, currencies)
select :'company_name', :'company_country', 'RSD', '{RSD,EUR}'
where not exists (select 1 from public.companies where name = :'company_name');


-- ── Banke (opciono) ─────────────────────────────────────────────────────────
-- Deset banaka sa kojima radi vecina klijenata u Srbiji. Obrisi one koje
-- klijent nema; ostale se dodaju u Podesavanja → Banke. Valute su racuni koje
-- firma tamo drzi: RSD i EUR za pocetak, suzavaju se u aplikaciji.

insert into public.banks (company_id, name, type, currencies, is_active)
select c.id, b.name, 'bank', array['RSD', 'EUR'], true
  from public.companies c
 cross join (values
   ('Alta banka'),
   ('NLB Komercijalna banka'),
   ('ProCredit Bank'),
   ('Addiko Bank'),
   ('AIK Banka'),
   ('UniCredit Bank'),
   ('Halkbank'),
   ('Banca Intesa'),
   ('Raiffeisen banka'),
   ('OTP banka')
 ) as b(name)
 where c.name = :'company_name'
   and not exists (
     select 1 from public.banks x
      where x.company_id = c.id and lower(x.name) = lower(b.name)
   );


-- ── Prvi administrator ──────────────────────────────────────────────────────
-- Nalog za prijavu pravi se u Dashboard-u (Authentication → Users), jer je
-- registracija u aplikaciji zatvorena. Bez reda u `profiles` nalog ne vidi
-- nista (politika members_only). Ovde dobija ulogu administrator i pristup
-- firmi. Ako nalog jos ne postoji, ovaj insert ne doda nista — napravi
-- nalog i pokreni seed ponovo.

insert into public.profiles (id, email, full_name, role, company_access)
select u.id, u.email, :'admin_name', 'administrator',
       array[(select c.id::text from public.companies c where c.name = :'company_name')]
  from auth.users u
 where lower(u.email) = lower(:'admin_email')
on conflict (id) do update
   set role = 'administrator',
       company_access = excluded.company_access;

commit;

-- Provera: firma, broj banaka i administrator.
select c.name as firma,
       (select count(*) from public.banks b where b.company_id = c.id) as banaka,
       (select string_agg(p.email, ', ') from public.profiles p
         where p.role = 'administrator') as administratori
  from public.companies c
 where c.name = :'company_name';
