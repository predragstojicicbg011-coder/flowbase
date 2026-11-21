# Preliminarni obračun tekućeg meseca i štampa zarada

Preneto iz Mintflow-a 21.11.2026. (Mintflow `6fb9eab..a418933` za preliminarni
obračun, `80c3964`, `d023a7a`, `88cfb78`, `5ca8304` za štampu). Vlasnik: „tamo je
sve isto, samo nema R&D-a“. Odluke u toku izrade su u
`.superpowers/sdd/2026-11-21-prelim-and-print/progress.md` (nije u repou).

## Šta radi

- **Pretpostavljeni sati.** Kadrovska evidencija → Evidencija radnog vremena,
  samo za tekući mesec (po beogradskom vremenu): šablon „ko je radio ceo mesec
  ima ove sate“, predlog iz kalendara (radni sati kao redovan rad, državni
  praznici kao praznik). Mora da se slaže sa fondom sati meseca. Čuva ga i
  uklanja samo administrator ili vlasnik. Nikad se ne upisuje kao evidencija.
- **Preliminarni obračun.** Zarade primenjuju šablon u memoriji na svakog bez
  evidencije, srazmerno radnim danima u obračunu (dolazak, odlazak, period van
  obračuna koji počinje u toku meseca). Mesec je *preliminaran* dok je iko na
  pretpostavljenim satima ili dok mesec koji preračunava evre čeka kurs za 20.
  Obaveštenje to kaže; kartice, obračuni, platni listić, kopirana tabela i
  spisak obračunatih meseci kažu „Preliminarno“.
- **Ne knjiži se.** Panel knjiženja umesto „Proknjiži“ kaže zašto; „Poništi“ i
  alati ostaju. Servis knjiženja odbija preliminaran obračun pre nego što
  zauzme mesec, a baza odbija knjiženje i promenu vrste posle knjiženja.
- **Poređenje** sa redovnim obračunom prošlog meseca (po obračunu i ukupno, i
  ko pravi razliku), samo kad niko ne nedostaje.
- **Štampa.** Platni listić (dugme u dijalogu), svi listići obračuna i
  rekapitulacija (dugmad na kartici obračuna), kao HTML koji se čuva kao PDF iz
  dijaloga za štampu. Na svakom listu: zaglavlje „Preliminarno“ kad jeste i
  podnožje sa imenom aplikacije iz `src/config/brand.ts`, kursom i vremenom.

## Kako je izgrađeno

- Čisto jezgro: `src/services/payroll/preliminaryHours.ts`, rečenice u
  `preliminaryText.ts`, čitanje i pisanje u `preliminaryHoursStore.ts`,
  poređenje u `comparison.ts`, štampa u `payrollPrint.ts`; redovi listića iz
  jednog modela, `payslipSections` u `payslip.ts` (dijalog daje isti HTML kao
  pre, dokazano snimkom).
- Ekrani: `TimesheetPreliminaryPanel.tsx`, `PayrollComparison.tsx`,
  `PayrollRunPrint.tsx`, `usePrintFrame.ts`; izmenjeni `Payroll.tsx`, `HR.tsx`,
  `TimesheetGrid.tsx`, `PayrollPostingPanel.tsx`, `PayrollMonths.tsx`,
  `PayslipDialog.tsx`, `savedRuns.ts`, `post.ts`.
- Migracija `supabase/migrations/20261121090000_preliminary_payroll.sql`:
  tabela `payroll_preliminary_hours` (RLS, `members_only`, administrator i
  vlasnik, kao evidencija radnog vremena; upis samo za tekući mesec, baza
  upisuje ko je sačuvao), `payroll_runs.kind`, tri brave na knjiženju i brava
  na brisanje obračuna koji ima knjiženje. Test:
  `supabase/tests/preliminary_payroll_test.sql`. Dokazana na privremenoj
  bazi od prazne; proba na `flowbase-demo` (pravilo 4) je vlasnikova.

## Redosled puštanja

Migracija ide **pre** koda: strana upisuje `payroll_runs.kind` i čita
`payroll_preliminary_hours`, a knjiženje čita vrstu. Kod klijenta posle
spajanja: `bash scripts/db-push.sh`, pa `git push` (vidi `NADOGRADNJA.md`).

## Razlike prema Mintflow-u

FlowBase nema R&D, subvenciju, prevoz ni angažovanje, pa: šablon ima svih 16
kategorija evidencije i nema podele na R&D sate; nema promene angažovanja u
toku meseca (C8), kolone ni reda „država snosi“ nigde; rekapitulacija ima
kolone FlowBase-ove kopirane tabele i dve kolone obustava. Nema ugrađenog
rezervnog kursa, pa nema ni pravila „bez iznosa na rezervnom kursu“. Mesec sav
u dinarima ne čeka kurs za 20., kao ni pre. Šablon ne čita pomoćnik (ne čita ni
evidenciju radnog vremena). Nema registra stranica, pa nema ni te kapije.

## Otvoreno

- Brisanje firme koja ima proknjižen obračun sada staje na bravi za brisanje
  obračuna (isto kao u Mintflow-u); FlowBase nema ekran koji to radi.
- Panel knjiženja se i dalje ne prikazuje dok neko nedostaje u obračunu, pa u
  tom mesecu nema ni „Poništi“ (kao i pre ove izmene).
