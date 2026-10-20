# Avansi dobavljačima — plan izrade

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Predračun (plaća se, bez P&L), avansni račun (vezan za plaćene predračune, bez P&L, ne plaća se) i konačni račun (pun iznos u P&L, zatvoren avansima delimično ili u celosti), sa automatskim prepoznavanjem sa SEF-a i jakom kontrolom da konačni račun sa SEF-a ne prođe bez avansa.

**Architecture:** Predračun i avansni račun su redovi u `invoices` sa novim vrstama `proforma` i `advance_invoice` (`pl_impact` uvek false). Plaćanje predračuna je postojeća veza `invoice_transaction_links`. Dve nove tabele sa iznosima: `advance_coverage` (avansni račun ← plaćeni predračun) i `advance_usage` (konačni račun ← avansni račun). Triggeri drže pravila; `v_invoice_status` računa ostatak konačnog računa sa iskorišćenim avansom, kao sa knjižnim odobrenjem. Čista logika u `src/services/advances.ts`; parser SEF-a čita pun iznos i reference; `InvoiceDialog`, izvodi, Neplaćene fakture i novi panel „Avansi dobavljačima“ ih koriste.

**Tech Stack:** React 18 + TypeScript (CRA, Jest + Testing Library; testovi `CI=true npx react-scripts test --watchAll=false <obrazac>`), Supabase Postgres (plpgsql, view), psql preko poolera.

**Spec:** `docs/superpowers/specs/2026-10-20-avansi-dobavljacima-design.md`

## Global Constraints

- Vrste dokumenta: `invoice`, `credit_note`, `debit_note`, `proforma`, `advance_invoice`. Natpisi (FlowBase/MCFlow): „Račun“, „Knjižno odobrenje“, „Knjižno zaduženje“, „Predračun“, „Avansni račun“. Mintflow: „Invoice“, „Credit note“, „Debit note“, „Proforma“, „Advance invoice“.
- Predračun i avansni račun: `pl_impact = false`, iznos > 0, tip `expense`. Konačni račun je `invoice` sa redovima u `advance_usage`.
- Ceo lanac: ista firma, isti partner, ista valuta.
- `advance_coverage`: zbir po predračunu ≤ plaćeno na predračunu (`sum(allocated_amount)`); zbir po avansnom računu = iznos avansnog računa kad ima ijednu vezu (manji avansni račun od plaćenog je dozvoljen jer pokriva samo deo predračuna; veći ne može da se pokrije). Avansni račun sa `prior_period = true` nema pokrića.
- `advance_usage`: zbir po avansnom računu ≤ njegov iznos; zbir po konačnom računu ≤ njegov iznos; `amount_rsd`/`amount_eur` po kursu konačnog računa.
- Avansni račun se ne plaća (status 'paid', ostatak 0). Predračun se plaća kao račun. Konačni račun: ostatak = iznos + knjižna odobrenja/zaduženja − iskorišćen avans − plaćeno.
- Transakcija koja plaća predračun ima `pl_impact = false`.
- Pun iznos SEF konačnog računa = `TaxExclusiveAmount` + `TaxTotal/TaxAmount` (dokumentska valuta / poreska kao danas); iskorišćeni avans = pun − `PayableAmount`. `total` običnog računa se ne menja.
- Migracije prvo na `flowbase-demo` (SQL test u transakciji koja se poništava), merge u MCFlow, pa Mintflow (USD, samoprovera kao 20261031090000).
- Ostatak avansa se ne zatvara ručno: upozorenje ostaje.

## Review Focus

1. Konačni račun sa SEF-a čiji avans pokriva sve (B.B. Link: pun 18.144, za plaćanje 0) mora da uđe u P&L sa 18.144 i u Neplaćene fakture sa 0 — test u Task 3 (parser) i Task 5 (forma šalje pun iznos).
2. Avansni račun ili iskorišćeni avans pojavi se u P&L-u ili Halcom-u — test u Task 1 (status 'paid', pl_impact false) i Task 6 (panel ga ne nudi).
3. Delimično iskorišćen avans (Bepro: 329.725,45, iskorišćeno 323.125,57) mora da ostane otvoren sa 6.599,88 i da se ponudi sledećem konačnom računu — testovi u Task 1 i Task 7.
4. Brisanje plaćenog predračuna, avansnog računa u upotrebi, ili smanjenje iznosa ispod veza — SQL test u Task 1.
5. Izmena postojećeg običnog računa ne sme da padne na novim proverama — SQL test u Task 1 (update note na računu bez veza).

---

### Task 1: Baza — vrste, veze, pravila, `v_invoice_status`, `v_supplier_advances`

**Files:**
- Create: `supabase/migrations/20261021090000_supplier_advances.sql`
- Create: `supabase/tests/supplier_advances_test.sql`

**Interfaces:**
- Produces, kolone: check `invoices_document_type_check` sa pet vrsta; `invoices.prior_period boolean not null default false` (samo za `advance_invoice`).
- Produces, tabele: `advance_coverage(id uuid pk, advance_invoice_id uuid not null → invoices on delete cascade, proforma_id uuid not null → invoices, amount numeric(18,2) > 0, created_at, created_by default auth.uid(), unique(advance_invoice_id, proforma_id))`; `advance_usage(id uuid pk, final_invoice_id uuid not null → invoices on delete cascade, advance_invoice_id uuid not null → invoices, amount numeric(18,2) > 0, amount_rsd numeric(18,2), amount_eur numeric(18,2), created_at, created_by, unique(final_invoice_id, advance_invoice_id))`. RLS kao `invoice_transaction_links` (čitanje članovima sa pristupom firmi, pisanje `can_write_books()`); grant authenticated/service_role, revoke anon.
- Produces, triggeri: `invoices_advance_shape` (before insert/update na invoices: proforma/advance_invoice → `pl_impact := false`, iznos > 0, tip expense; `prior_period` samo na advance_invoice); `advance_coverage_rules` (before insert/update: vrste, ista firma/partner/valuta, zbir po predračunu ≤ plaćeno); `advance_coverage_balance` (constraint trigger deferrable initially deferred: za avansni račun sa vezama zbir = iznos); `advance_usage_rules` (vrste, ista firma/partner/valuta, oba živa, zbirovi ≤ iznosi, upis `amount_rsd/eur` po kursu konačnog); `invoices_keep_advance_links` (ne briše/menja iznos dokumenta ispod njegovih veza; predračun sa plaćanjem ili pokrićem se ne briše).
- Produces, `v_invoice_status` (sve postojeće kolone, istim redom) dodaje na kraj: `prior_period`, `advance_used`, `advance_used_rsd`, `advance_used_eur` (na konačnom računu), `advance_open` (na avansnom: iznos − iskorišćeno), `covered` (na predračunu: zbir pokrića; na avansnom: zbir pokrića). Konačni račun: iskorišćeni avans se računa kao knjižno odobrenje (settled + used; ostatak − used). `advance_invoice`: 'paid', ostatak 0. `unlinked` je true i za avansni račun bez pokrića koji nije `prior_period`.
- Produces, view `v_supplier_advances` (security_invoker) po (company_id, partner_id): `paid_on_proformas`, `covered`, `used`, `paid_without_advance` (= paid − covered), `advance_open` (= zbir avansnih − used), `partner_name`.
- Produces, funkcija ostaje: kontrola duplikata već poredi `document_type`.

- [ ] **Step 1: SQL test** (fixtures: firma, dva dobavljača, RSD):
  1. Predračun 200000 bez plaćanja: `calculated_status='unpaid'`, `remaining_rsd=200000`, `pl_impact=false` čak i kad se upiše true.
  2. Plaćanje 200000 (link): predračun 'paid'. Avansni račun 150000 sa pokrićem 150000 iz predračuna: dozvoljeno; `v_supplier_advances.paid_without_advance=50000`, `advance_open=150000`; avansni 'paid' i ostatak 0.
  3. Avansni 250000 sa pokrićem 250000 iz istog predračuna: odbijeno (preko plaćenog). Avansni 100000 sa pokrićem 50000: odbijeno na commit (zbir ≠ iznos) — test proverava kroz `set constraints all immediate`.
  4. Konačni račun 120000 sa korišćenjem 120000: konačni 'paid', `advance_used=120000`, ostatak 0; `advance_open=30000`.
  5. Drugi konačni 50000 sa korišćenjem 30000: 'partial', ostatak 20000; treći korišćenje bilo kog iznosa: odbijeno (avans potrošen). Korišćenje > iznos konačnog: odbijeno.
  6. Drugi dobavljač ili druga valuta u vezi: odbijeno; korišćenje predračuna umesto avansnog: odbijeno.
  7. Brisanje avansnog u upotrebi: odbijeno; brisanje plaćenog predračuna: odbijeno; smanjenje avansnog na 100000 (ispod korišćenja 150000): odbijeno.
  8. Avansni `prior_period` 80000 bez pokrića: dozvoljen, `unlinked=false`; avansni ne-`prior_period` bez pokrića: `unlinked=true`.
  9. Izmena napomene na običnom računu bez veza prolazi; konačni račun sa knjižnim odobrenjem −10000 i avansom: ostatak = iznos − 10000 − avans.
  10. Bepro: avansni 329725.45, konačni 323125.57 sa korišćenjem 323125.57 → konačni 'paid', `advance_open=6599.88`.
- [ ] **Step 2:** test na demo bazi bez migracije → pada.
- [ ] **Step 3:** migracija (kolone, check, tabele, RLS, triggeri, `create or replace view v_invoice_status` iz 20261020100000 sa novim kolonama na kraju i `advance_used` u lateral podupitu, `v_supplier_advances`, blok provera).
- [ ] **Step 4:** test sa migracijom → `ALL TESTS PASSED`; i testovi `credit_and_debit_notes_test.sql`, `one_bill_per_supplier_number_test.sql` i dalje prolaze; `db push` na demo.
- [ ] **Step 5:** commit.

### Task 2: Servis `advances.ts` i proširenje `documentType.ts`

**Files:**
- Modify: `src/services/documentType.ts`, `src/services/documentType.test.ts`
- Create: `src/services/advances.ts`, `src/services/advances.test.ts`

**Interfaces:**
- Produces (documentType): `DocumentType` dobija `'proforma' | 'advance_invoice'`; `DOCUMENT_TYPE_LABEL` pet natpisa; `isPayable(t)` (true za invoice, proforma); `hasNoPl(t)` (true za proforma, advance_invoice); `signProblem` za proforma/advance_invoice: „Iznos mora biti veći od 0“ za ≤ 0.
- Produces (advances):
  ```ts
  export interface OpenAdvance { id: string; invoice_number: string | null; invoice_date: string | null; amount: number; open: number; currency: string | null }
  export interface PaidProforma { id: string; invoice_number: string | null; paid: number; covered: number; currency: string | null }
  export interface AdvanceRef { number: string; date: string | null }
  export function proposeUsage(refs: AdvanceRef[], advanceTotal: number, advances: OpenAdvance[]): { usage: { advanceId: string; amount: number }[]; missing: AdvanceRef[] }
  // refs po invoiceNumberKey; po redu navođenja, svaki do svog `open`, ukupno do advanceTotal; nepronađeni u `missing`
  export function proposeCoverage(amount: number, proformas: PaidProforma[], preferredNumbers: string[]): { proformaId: string; amount: number }[]
  // prvo predračuni čiji se broj pominje, pa najstariji; svaki do paid−covered; zbir = amount ili prazno ako ne može
  export function coverageProblem(amount: number, chosen: PaidProforma[]): string | null
  // „Avansni račun (X) je veći od plaćenog po izabranim predračunima (Y).“
  export function usageProblem(finalAmount: number, rows: { amount: number; open: number }[]): string | null
  export function proformaNumbersIn(text: string): string[]
  // iz „po predračunu br. 256173“, „predračunu 177/2026 od …“, „po predračunu br. 9917/017“
  export function openAdvancesNotice(advances: OpenAdvance[]): string
  // „Dobavljač ima otvorene avanse: 2 avansna računa, ukupno 335.000,00 RSD“ ('' kad nema)
  ```
- [ ] **Steps 1–5:** testovi sa vrednostima iz spec-a (B.B. Link puno pokriće, DST delimično 13.260 od 17.340, Bepro 323.125,57 iz 329.725,45 ostavlja 6.599,88, dva avansa redom, nepostojeća referenca u `missing`, tri teksta predračuna, coverageProblem 250.000 > 200.000) → padaju → implementacija → prolaze → commit.

### Task 3: SEF parser i nacrt

**Files:**
- Modify: `src/services/sef/ublInvoice.ts` (+ test), `src/services/sef/draftFromUbl.ts` (+ test)
- Create: `src/services/sef/fixtures/advance-invoice-sample.xml`, `src/services/sef/fixtures/final-invoice-sample.xml` (iz stvarnih dokumenata B.B. Link RA2027179 i 21404-01-26, PDF zamenjen markerom, PIB/MB i nazivi zamenjeni izmišljenim, iznosi zadržani)

**Interfaces:**
- Produces: `UblInvoice.isAdvanceInvoice` (tip 386), `billingReferences: { number: string; date: string | null }[]` (svi `BillingReference/InvoiceDocumentReference`), `grossTotal: number | null` (TaxExclusive + VAT), `advanceUsed: number` (gross − PayableAmount na 380 sa referencama, inače 0), `advanceText: string` (napomene + nazivi stavki). `billingReference` (prvi) ostaje.
- Produces (draft): za 386 `document_type: 'advance_invoice'`, `pl_impact: false`, `proforma_hints: proformaNumbersIn(advanceText)`; za 380 sa referencama i `advanceUsed > 0` `amount: grossTotal`, `advance_refs`, `advance_used`; napomena u `reviewNotesFor`: „Konačni račun: pun iznos X ide u troškove, avans Y je već plaćen, za plaćanje Z.“
- [ ] **Steps 1–5:** testovi na dva fiksture (386: isAdvanceInvoice, iznos 18144, tekst sa 256173; 380: grossTotal 18144, advanceUsed 18144, reference RA2027179 / 2026-10-08; DST vrednosti kroz izmenu fiksture: 17340/13260; obični račun bez referenci nepromenjen) → padaju → implementacija → prolaze → commit.

### Task 4: Forma — predračun i avansni račun

**Files:**
- Modify: `src/components/InvoiceDialog.tsx`
- Create: `src/components/InvoiceDialog.advances.render.test.tsx`

**Interfaces:**
- Consumes: Task 2 (`isPayable`, `hasNoPl`, `proposeCoverage`, `coverageProblem`), Task 1 tabele.
- Produces: izbor vrste nudi pet vrsta; za `proforma`/`advance_invoice` P&L korak prikazuje „Bez uticaja na P&L“ i šalje `pl_impact: false` bez provere kategorije. Za `advance_invoice` u koraku 1 `<fieldset aria-label="Plaćeni predračuni">` sa plaćenim predračunima partnera (iz `v_invoice_status`: document_type proforma, `paid_amount > covered`), predlog iz `proposeCoverage` (koristi `proforma_hints` iz nacrta), polje iznosa po predračunu; prekidač „Iz ranijeg perioda“ (`prior_period`) skriva predračune. Čuvanje upisuje `advance_coverage` posle računa (kao podela troškova). Bez predračuna i bez prekidača: čuva se kao nevezan sa upozorenjem „Nije vezano za predračun — veže se kasnije“.
- [ ] **Step 1:** render testovi: predračun šalje `document_type:'proforma', pl_impact:false` i ne traži P&L kategoriju; avansni sa SEF nacrtom predlaže predračun broj 256173 i upisuje pokriće 15120+3024=18144; avansni veći od plaćenog prikazuje grešku iz `coverageProblem`; „Iz ranijeg perioda“ šalje `prior_period:true` bez pokrića.
- [ ] **Steps 2–5:** padaju → implementacija → prolaze (i svi InvoiceDialog testovi) → commit.

### Task 5: Forma — konačni račun sa avansima (scenario 1 i 2)

**Files:**
- Modify: `src/components/InvoiceDialog.tsx`, `src/components/SefInboxDialog.tsx`
- Test: `src/components/InvoiceDialog.advances.render.test.tsx`

**Interfaces:**
- Consumes: Task 2 (`proposeUsage`, `usageProblem`, `openAdvancesNotice`), Task 3 nacrt (`advance_refs`, `advance_used`).
- Produces: za `invoice` (ulazni) kad partner ima otvorene avanse (iz `v_invoice_status`: advance_invoice, `advance_open > 0`): obaveštenje `openAdvancesNotice` i sekcija `<fieldset aria-label="Avansi">` sa poljem iznosa po avansu (opciono). Kad nacrt ima `advance_refs`: sekcija se popunjava iz `proposeUsage` i **knjiženje je blokirano** dok zbir korišćenja ≠ `advance_used` ili postoji `missing`; za svaki `missing` dugme „Dodaj avansni račun iz ranijeg perioda“ pravi (u istom čuvanju) `advance_invoice` sa `prior_period:true`, brojem i datumom iz reference, iznosom = njegov deo korišćenja, istim partnerom/firmom/valutom, i vezuje ga. Čuvanje: račun, pa avansni računi iz ranijeg perioda, pa `advance_usage`. SefInboxDialog: red tipa Prepayment ima oznaku „Avansni račun“; nacrt se prosleđuje kao do sada.
- [ ] **Step 1:** render testovi: B.B. Link nacrt (pun 18144, ref RA2027179 u bazi) šalje `amount:18144` i `advance_usage` 18144; DST (17340, avans 13260) šalje korišćenje 13260; nacrt sa referencom koje nema → dugme za knjiženje onemogućeno sa porukom „Konačni račun navodi avansni račun RA… koji nije u knjigama“, klik na „Dodaj avansni račun iz ranijeg perioda“ omogućava knjiženje i šalje oba reda; ručni račun dobavljača sa otvorenim avansom prikazuje obaveštenje i prolazi bez veze.
- [ ] **Steps 2–5:** padaju → implementacija → prolaze → commit.

### Task 6: Plaćanje predračuna i Neplaćene fakture

**Files:**
- Modify: `src/services/settleInvoice.ts` (+ test), `src/components/BankStatementDialog.tsx`, `src/components/TransactionDialog.tsx`, `src/components/BulkImport.tsx`, `src/components/ReconcilePanel.tsx`, `src/pages/Reports.tsx` (UnpaidInvoicesPanel)
- Test: `src/pages/UnpaidInvoicesPanel.render.test.tsx`, `src/components/BankStatementDialog.proforma.render.test.tsx` (ili postojeći test izvoda ako postoji harness)

**Interfaces:**
- Consumes: Task 1 (`advance_used` u view-u), Task 2 (`isPayable`).
- Produces: `owedAmount` = amount + adjustments − advance_used. Svi spiskovi otvorenih dokumenata za plaćanje filtriraju `isPayable(document_type ?? 'invoice')` (zamenjuje `=== 'invoice'` iz knjižnih odobrenja). Na izvodu, u „Plaćanje fakture“, dugme „Nov predračun iz ove uplate“ pravi `proforma` (partner, iznos, datum, račun iz reda izvoda) i vezuje plaćanje; transakcija koja plaća samo predračune ima `pl_impact:false`. Isto dugme u TransactionDialog. Neplaćene fakture: predračun sa oznakom „PREDRAČUN“; konačni račun sa „avans −X“ ispod iznosa i nudi samo ostatak.
- [ ] **Step 1:** testovi: owedAmount (120000, adjustments 0, advance_used 120000 → 0; 17340/13260 → 4080); panel: predračun se nudi sa oznakom, avansni se ne nudi, konačni nudi 4080,00 i piše „avans −13.260,00 RSD“; izvod: dugme pravi predračun sa iznosom reda i šalje vezu.
- [ ] **Steps 2–5:** padaju → implementacija → prolaze (ceo paket) → commit.

### Task 7: Panel „Avansi dobavljačima“ i Glavna knjiga

**Files:**
- Create: `src/components/SupplierAdvancesPanel.tsx`, `src/components/SupplierAdvancesPanel.render.test.tsx`
- Modify: `src/pages/Reports.tsx` (dugme za otvaranje panela, kao Neplaćene fakture), `src/components/DocumentTypeTag.tsx` (+ test), `src/services/documentType.ts` (`closureNote`: „zatvoreno avansom“, „delimično zatvoreno avansom“)

**Interfaces:**
- Consumes: `v_supplier_advances`, `v_invoice_status` (Task 1).
- Produces: panel sa redom po dobavljaču (plaćeno po predračunima / pokriveno avansnim / iskorišćeno konačnim / plaćeno bez avansnog / avans otvoren) i upozorenjima „Plaćeno bez avansnog računa: X“, „Avans čeka konačni račun: Y“; tag „Predračun“, „Avansni račun“, „iz ranijeg perioda“, „nije vezano“.
- [ ] **Steps 1–5:** render test sa Bepro podacima (otvoren 6.599,88) i predračunom plaćenim 200.000 a pokrivenim 150.000 (upozorenje 50.000,00) → pada → implementacija → prolazi → commit.

### Task 8: MCFlow, nalozi direktora, Mintflow

- [ ] Ceo FlowBase paket, `tsc`; završna recenzija grane (Opus) i jedan krug ispravki pre MCFlow-a.
- [ ] Merge u MCFlow. MCFlow migracija `20261021100000_payorders_advances.sql`: `payorder_remaining` oduzima `advance_usage` konačnog računa, `payorder_check` dozvoljava `proforma`, odbija `advance_invoice` (poruka „Avansni račun se ne plaća: plaća se predračun ili ostatak konačnog računa.“) + SQL test. SQL testovi na MCFlow bazi u transakciji koja se poništava, `db push`, provera da broj i zbir računa nisu promenjeni.
- [ ] Četiri čekajuća konačna računa i pet avansnih u MCFlow sandučetu ostaju korisniku da ih proknjiži novim tokom (Peri 10053016 odbiti na SEF-u).
- [ ] Mintflow: worktree iz origin/main, migracija `20261102090000_supplier_advances.sql` u USD sa samoproverom, testirana na lokalnom Postgres-u sa šemom; ručni prenos UI-ja na engleskom; testovi iz kopije u scratchpad-u; komande za korisnika.
