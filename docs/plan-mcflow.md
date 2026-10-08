# MCFlow: plan prelaska sa Mintflow-a

Klijent: Milinković Company doo, građevinska firma, jedno pravno lice.
Odluke od 2026-10-08:
- Valuta: RSD je funkcionalna valuta, a na svakom zapisu se čuva i EUR po NBS srednjem kursu na dan transakcije.
- Raspodela troškova i prihoda ide po projektima: gradilišta i objekti u zakupu.
- Interfejs je na srpskom, latinicom.
- Plate se obračunavaju po srpskim propisima, bez R&D-a, subvencija i naknade za prevoz.
- Prihodi su građevinske situacije i zakup, a prognoza prihoda se radi ručno.

## Faze

Status (2026-10-08): faze 1–4 su završene i migracije su primenjene.

1. **Uklanjanje onoga što je samo za Aimfox**: Chargebee, Braintree i sinhronizacija procesora, Integrations tab, Simulation tab, Aftwrk uvoz, R&D i subvencija u platama, prevoz.
2. **Jedno pravno lice**: izbacuju se biranje firme, pretraga firme po imenu ("Constellation LLC"), "Constel Group" i oznake pravnih lica.
3. **Valuta RSD + EUR**: jedan pomoćni sloj `toBookAmounts()`. U šemi `amount_usd` postaje `amount_rsd` i dodaje se `amount_eur`. Menjaju se i view-ovi, formatiranje iznosa i sva mesta gde se kurs računa ručno.
4. **Projekti**: šifarnik `projects` (gradilište / zakup) i `project_id` na transakcijama, fakturama, `pl_splits` i budžetu. To zamenjuje `rev_alloc_*` (Aimfox/Social Growth).
5. **Prihodi**: situacije i zakup po projektu (`revenue_entries` + naplata) i ručna mesečna prognoza. Treba odlučiti i da li `v_pl_entries` uzima izlazne fakture (situacije) kao prihod. Do sada ih ne uzima, nego prihod računa iz uplata.
6. **Srpski interfejs.**
7. **Početni podaci i puštanje**: banke, profil firme, korisnici, hosting i prvi push na GitHub.

## Pre prvog commit-a

- Testovi za plate (`september.test.ts`, `engine.test.ts` i drugi) imaju podatke vezane za Constellation. Moraju se anonimizovati ili zameniti pre prvog commit-a.
- Kod poziva edge funkcije `ai-categorize` i `lookup-pib`, a one nisu u repou. `lookup-pib` (pretraga po PIB-u) bi bila korisna i za MCFlow.
