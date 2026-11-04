# Prihodi: izlazne fakture sa SEF-a, potraživanja i naplata — plan izrade

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Izlazne fakture se čitaju sa SEF-a u sopstveno sanduče, knjiže se iz njega sa svim poljima (i ručno), svaka je razvrstana na projekat / zakup / prodaju usluga, avansi kupaca rade po dokumentima kao kod dobavljača, a Prihodi počinju sa tri broja: ukupna potraživanja, dospeva u 7 dana, kasni.

**Architecture:** `sef_inbox` dobija smer (`direction`: `purchase` | `sales`) i kolone kupca; nova edge funkcija `sef-pull-sales` (čista logika u `salesInvoice.ts`, testirana iz Jest-a) traži id-jeve po statusu, odmah čuva status, UBL, PDF i priloge, i osvežava status poznatih redova. Novo sanduče `SefSalesInboxDialog` čita samo `sales` redove i otvara postojeći `InvoiceDialog` sa nacrtom iz `salesDraft.ts`. Razvrstavanje, potraživanja i brisanje su čisti servisi (`revenueClassification.ts`, `receivables.ts`) i jedna `security definer` funkcija (`delete_invoice_cascade`); avansi kupaca su postojeća pravila avansa (`advance_coverage`, `advance_usage`, okidači) otvorena za oba smera, uvek unutar istog smera.

**Tech Stack:** React 18 + TypeScript (CRA, Jest + Testing Library), Supabase Postgres (plpgsql, view, pg_cron), Deno edge funkcije, psql preko poolera.

**Spec:** `docs/superpowers/specs/2026-11-04-prihodi-izlazne-fakture-design.md`

## Global Constraints

- SEF izlazne (header `ApiKey`, baza `extra.base_url || 'https://efaktura.mfin.gov.rs/api/publicApi'`): `POST /sales-invoice/ids?status=&dateFrom=&dateTo=` → `{ SalesInvoiceIds: [...] }`; `GET /sales-invoice?invoiceId=` → `Status, InvoiceId, GlobUniqId, CirStatus, CirInvoiceId, LastModifiedUtc, CancelComment, StornoComment`; `GET /sales-invoice/xml?invoiceId=` (UBL); `GET /sales-invoice/pdf?invoiceId=` (PDF); `POST /sales-invoice/changes?date=` → `[{ SalesInvoiceId, NewInvoiceStatus, Date }]`. Nema overview-a.
- Povlače se samo statusi **Sent, Approved, Paid, OverDue, Archived**. Nikad Cancelled, Storno, Rejected (ni Draft, New, Sending, Mistake, Deleted, Unknown).
- Prozor i donja granica: `sef_pull_window(p_from, p_to)`, isti kao ulazno povlačenje.
- Ništa se ne knjiži bez korisnika; nema AI-ja ni plaćenog servisa.
- Ulazna strana radi tačno kao pre: nijedan postojeći upit ulazne strane ne vidi `sales` redove; svi postojeći testovi (Jest i `supabase/tests/*.sql`) ostaju zeleni.
- Ko sme: povlačenje i provera veze `is_member()`; knjiženje, odbijanje, povezivanje, brisanje `can_write_books()` (u aplikaciji `useAuth().canEdit`).
- Vrh Prihoda: „Ukupna potraživanja“, „Dospeva u narednih 7 dana“, „Kasni“; predračuni koji čekaju uplatu nisu u potraživanjima. Iznosi u valuti izabranoj gore levo, po knjigovodstvenom kursu fakture (`pickAmount(row, currency, 'remaining')`), pune cifre (`fmtMoney`: „1.000.000 RSD“, nikad „mil.“/„hilj.“).
- Brisanje: meko (`deleted_at`, `deleted_by`), u jednoj transakciji u bazi, funkcija radi za oba smera (dugme samo na izlaznoj).
- Stari projektni avans (oznaka `is_advance` na uplati, polje „Odbijeni avans“): sakriven za nove unose, postojeći zapisi se prikazuju i računaju.
- Lanac avansa kupca: ista firma, isti kupac, ista valuta, isti smer (`type`); mešanje ulaznog i izlaznog se odbija.
- Prvo FlowBase (migracije samo ovde), pa merge u MCFlow; Mintflow nije deo ovog plana. Testovi samo sa izmišljenim firmama.
- U naslovima Jest testova nema apostrofa (`it('...')`).
- Aplikacija (`src`) nikad ne uvozi iz `supabase/functions`; čistu logiku funkcija uvoze samo Jest testovi.
- Commit: `git add` tačno fajlove iz bloka **Files** tog taska; poruka kao u koraku + prazan red + `Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>`. Push radi Predrag sam.

**Komande** (bash, iz `C:\Users\Predrag PC\flowbase`):
- Jest: `CI=true npx react-scripts test --watchAll=false <obrazac>`; tipovi: `npx tsc --noEmit -p .`
- SQL test (MCFlow baza ima šemu FlowBase-a; sve se poništava):
  ```bash
  export PGPASSWORD="$(sed -n 's/^SUPABASE_DB_PASSWORD=//p' "/c/Users/Predrag PC/mcflow/.supabase-cli.env")"
  sqltest() { { echo 'begin;'; for f in "$@"; do sed '/^begin;$/d;/^commit;$/d' "$f"; done; echo 'rollback;'; } \
    | "$HOME/scoop/apps/postgresql/current/bin/psql" "$(cat "/c/Users/Predrag PC/mcflow/supabase/.temp/pooler-url")" -v ON_ERROR_STOP=1 -q; }
  ```
  Prolaz: poslednja linija `NOTICE:  ALL TESTS PASSED`. Test fajlovi imaju oblik `supabase/tests/supplier_advances_test.sql` (jedan `do $$` blok, `raise notice 'N ok'`, na kraju `ALL TESTS PASSED`).

## Review Focus

1. **Faktura stornirana na SEF-u posle povlačenja ili knjiženja** nestaje iz spiskova po statusu, pa se ne bi ni videla: funkcija mora sama da pita za poznate redove koji ovog puta nisu na spisku; red u sandučetu kaže „Stornirana na SEF-u“ i ne knjiži se, a proknjižena faktura ostaje u potraživanjima sa crvenim upozorenjem — testovi u Task 2 (`refreshTargets`), Task 4 (dugme nema) i Task 7 (upozorenje).
2. **Isti SEF id u oba smera** (ulazni i izlazni brojevi su odvojeni nizovi): dva reda moraju da postoje jedan pored drugog, a PDF izlazne ne sme da pregazi PDF ulazne iste numeracije — SQL test u Task 1 i test putanje u Task 2.
3. **Drugi dokument za već fakturisan mesec zakupa** (jedinstveni par zakup/mesec u bazi): upozorenje pre čuvanja i jasna poruka umesto sirovog `duplicate key` — test u Task 5.
4. **Faktura u evrima**: kurs na datum prometa, potraživanja u RSD i EUR po kursu fakture, ne današnjem — testovi u Task 3 (nacrt) i Task 6 (zbirovi u EUR).
5. **Brisanje koje padne na pola** (zaključan period, okidač) ne sme da ostavi uplatu odvezanu a fakturu živu; brisanje avansnog računa koji koristi druga faktura mora to da kaže u potvrdi — SQL test u Task 8.

---

### Task 1: Baza — smer u sandučetu, kupac, izlazni upis, jedan broj izlazne fakture; ulazna strana čita samo `purchase`

**Files:**
- Create: `supabase/migrations/20261104090000_sales_invoices_in_the_inbox.sql`, `supabase/tests/sales_inbox_test.sql`
- Modify: `src/components/SefInboxDialog.tsx:248` (upit sandučeta), `src/services/sef/invoiceDocuments.ts` (`SefDocRow`, `DOC_ROW_COLUMNS`, `rankLinkCandidates`, `loadLinkCandidates`)
- Test: `src/services/sef/invoiceDocuments.test.ts`, `src/components/SefInboxDialog.pdf.render.test.tsx`

**Interfaces:**
- Produces, kolone `sef_inbox`: `direction text not null default 'purchase' check (direction in ('purchase','sales'))`, `customer_name text`, `customer_vat_number text`, `customer_registration_number text`, `issue_date date`, `sef_comment text`. Za `purchase` redove nove kolone ostaju null. `authenticated` ne sme da ih menja (postojeći grant update samo na kolone odluke ostaje).
- Produces, indeks: `sef_inbox_one_row_per_invoice` ponovo kao `unique (company_id, direction, sef_invoice_id)`.
- Produces, `sef_inbox_upsert(uuid, jsonb)`: isto telo kao u 20261015100000, `direction` se upisuje kao `'purchase'`, `on conflict (company_id, direction, sef_invoice_id)`.
- Produces, `sef_sales_upsert(p_company_id uuid, p_rows jsonb) returns table (seen int, inserted int)` (samo `service_role`). Ključevi reda (camelCase, kao šalje funkcija iz Task 2): `sefInvoiceId, status, globUniqId, cirInvoiceId, comment, documentNumber, documentType, customerName, customerVatNumber, customerRegistrationNumber, amount, sumWithoutVat, vatAmount, currency, issueDate, deliveryDate, dueDate`. `sent_date := issueDate` (ponoć u Beogradu), `overview_json := red`. Na sukob: uvek `sef_status`, `sef_comment`, `last_seen_at`; zaglavlje samo dok je `state = 'pending'`.
- Produces, `sef_sales_status(p_company_id uuid, p_updates jsonb) returns int` (samo `service_role`): `[{ sefInvoiceId, status, comment }]` menja samo postojeće `sales` redove; nepoznat id se preskače; vraća broj promenjenih.
- Produces, `sef_inbox_mark_imported(uuid, uuid)` (telo iz 20261018150000) dodaje: `purchase` red samo uz `type = 'expense'`, `sales` samo uz `type = 'revenue'` — inače „Izlazna faktura sa SEF-a se vezuje samo za izlaznu fakturu u knjigama.“ / „Ulazna faktura sa SEF-a se vezuje samo za ulaznu fakturu u knjigama.“; `sales` red sa statusom Cancelled/Storno/Rejected: „Faktura je stornirana, otkazana ili odbijena na SEF-u i ne knjiži se.“
- Produces, okidač `invoices_one_per_own_number` (before insert/update of invoice_number, company_id, type, document_type, deleted_at): za `type = 'revenue'` i `document_type <> 'proforma'`, jedinstveno `invoice_number_key(invoice_number)` po (firma, `document_type`) među živim; poruka „Izlazna faktura broj % je već proknjižena (%, %). Isti broj se ne knjiži dva puta.“, `errcode = 'unique_violation'`. Po firmi a ne po kupcu, jer brojeve izlaznih daje firma. Blok na kraju prijavljuje (`raise notice`) postojeće duplikate, ne pada.
- Produces, raspored: ako postoji aktivan `sef-pull-quarter-hourly`, `cron.schedule('sef-pull-sales-quarter-hourly', '*/15 5-17 * * *', $job$ select public.run_processor_sync('sef-pull-sales', true) $job$)`.
- Produces (app): `SefDocRow` dobija `direction`, `customer_name`, `customer_vat_number` (i `DOC_ROW_COLUMNS`); `rankLinkCandidates` poredi PIB kupca za `sales` red, dobavljača za `purchase`; `loadLinkCandidates` dodaje `.eq('direction', invoice.type === 'revenue' ? 'sales' : 'purchase')`; ulazno sanduče dodaje `.eq('direction', 'purchase')`.

- [ ] **Step 1: SQL test** `supabase/tests/sales_inbox_test.sql` (firma „Test izlazne (TEST-IZ)“, kupac i dobavljač izmišljeni):
  1. `sef_inbox_upsert` sa `InvoiceId 555` → jedan red, `direction = 'purchase'`; `sef_sales_upsert` sa `sefInvoiceId 555` → drugi red, `direction = 'sales'`, `customer_vat_number = '100000002'`; ponovni `sef_inbox_upsert` 555 → i dalje jedan `purchase` red.
  2. `sef_sales_upsert` isti id sa `status 'Paid'` i drugim iznosom → `inserted = 0`, `sef_status = 'Paid'`, iznos osvežen (red je `pending`).
  3. `sef_sales_status` sa nepoznatim id-jem → 0 i nema novog reda; sa 555/`Storno`/„greška u ceni“ → 1, `sef_comment` upisan.
  4. `sef_inbox_mark_imported(sales red, ulazna faktura)` → izuzetak; `(sales red, izlazna)` posle vraćanja na `Sent` → prolazi; `(stornirani sales red, izlazna)` → izuzetak.
  5. Izlazna 380 broj „IF-1/2026“ dvaput u istoj firmi → `unique_violation`; isti broj u drugoj firmi → prolazi; isti broj kao `credit_note` → prolazi; ulazni račun istog broja → prolazi.
  6. `has_column_privilege('authenticated','public.sef_inbox','direction','UPDATE')` i za `customer_name` → false.
  7. Raspored `sef-pull-sales-quarter-hourly` postoji kad postoji ulazni.
- [ ] **Step 2: Pokreni bez migracije** — `sqltest supabase/tests/sales_inbox_test.sql` → `ERROR:  function public.sef_sales_upsert(uuid, jsonb) does not exist`.
- [ ] **Step 3: Migracija** sa svim gore navedenim i završnim `do $$` blokom provera (indeks na tri kolone, `members_only` i dalje postoji, anon bez prava, grant funkcija samo `service_role`).
- [ ] **Step 4:** `sqltest supabase/migrations/20261104090000_sales_invoices_in_the_inbox.sql supabase/tests/sales_inbox_test.sql` → `ALL TESTS PASSED`; i `sqltest <migracija> supabase/tests/supplier_advances_test.sql`, `... one_bill_per_supplier_number_test.sql`, `... invoice_documents_test.sql`, `... credit_and_debit_notes_test.sql` → svaki `ALL TESTS PASSED`.
- [ ] **Step 5: Jest testovi (padaju):** u `invoiceDocuments.test.ts` — `it('ranks a sales row by the customer PIB')`: invoice `{ type:'revenue', partner_tax_id:'100000002' }`, red `{ direction:'sales', customer_vat_number:'100000002', supplier_vat_number:'100000009' }` → `reasons` sadrži „isti PIB“; `it('asks for sales rows when pairing a revenue invoice')`: snimač poziva pokazuje `eq('direction','sales')`. U `SefInboxDialog.pdf.render.test.tsx` — `it('reads only purchase rows')`: snimač `eq` na `sef_inbox` sadrži `['direction','purchase']`.
- [ ] **Step 6:** `CI=true npx react-scripts test --watchAll=false invoiceDocuments SefInboxDialog` → FAIL na tri nova testa; implementacija; isto → PASS (svi SefInboxDialog testovi).
- [ ] **Step 7: Commit** — `git add supabase/migrations/20261104090000_sales_invoices_in_the_inbox.sql supabase/tests/sales_inbox_test.sql src/components/SefInboxDialog.tsx src/components/SefInboxDialog.pdf.render.test.tsx src/services/sef/invoiceDocuments.ts src/services/sef/invoiceDocuments.test.ts && git commit -m "feat(sef): the inbox keeps a direction; sales rows, their customer, one number per revenue invoice"`

### Task 2: Funkcija `sef-pull-sales`, provera veze za izlazne, ulazne funkcije odbijaju izlazni red

**Files:**
- Create: `supabase/functions/sef-pull-sales/salesInvoice.ts`, `supabase/functions/sef-pull-sales/index.ts`, `src/services/sefSales.function.test.ts`, `src/services/sef/fixtures/sales-invoice-sample.xml`
- Modify: `supabase/functions/sef-check/index.ts`, `supabase/functions/sef-fetch-invoice/index.ts`, `supabase/functions/sef-decide/index.ts`, `src/services/sef/sefKey.ts` (+ `sefKey.test.ts`)

**Interfaces:**
- Consumes: `sef_sales_upsert`, `sef_sales_status`, `sef_pull_window`, `claim_processor_sync` (Task 1 / postojeće).
- Produces (`salesInvoice.ts`, bez Deno API-ja, kao `lookup-pib/nbsRegister.ts`):
  ```ts
  export const PULLED_STATUSES = ['Sent', 'Approved', 'Paid', 'OverDue', 'Archived'] as const
  export const VOIDED_STATUSES = ['Cancelled', 'Storno', 'Rejected'] as const
  export const MAX_NEW_PER_PASS = 40
  export function isVoided(status: string | null | undefined): boolean          // bez obzira na velika slova
  export function idsUrl(base: string, status: string, from: string, to: string): string
  export function readIds(body: unknown): number[]                              // ključ bez obzira na velika slova, string cifre prihvaćene, bez duplikata
  export interface SalesStatus { invoiceId: number; status: string | null; globUniqId: string | null; cirInvoiceId: string | null; comment: string | null }
  export function readStatus(body: unknown): SalesStatus | null                 // comment = StornoComment ?? CancelComment
  export function readChanges(body: unknown): { invoiceId: number; status: string }[]
  export interface SalesHeader { documentNumber: string | null; documentType: 'Invoice' | 'Prepayment' | 'CreditNote' | 'DebitNote' | null
    customerName: string | null; customerVatNumber: string | null; customerRegistrationNumber: string | null
    amount: number | null; sumWithoutVat: number | null; vatAmount: number | null; currency: string | null
    issueDate: string | null; deliveryDate: string | null; dueDate: string | null }
  export function headerFromUbl(xml: string): SalesHeader                       // regex; 380/386/381/383; PIB bez „RS“; amount = TaxInclusiveAmount
  export function slimXml(xml: string): string                                  // prazni env:DocumentPdf i EmbeddedDocumentBinaryObject, kao sef-fetch-invoice
  export function ublPdfAttachments(xml: string): { n: number; filename: string | null; description: string | null; base64: string }[]
  export const salesPdfPath = (companyId: string, id: number | string) => `${companyId}/sales/${id}.pdf`
  export const salesAttachmentPath = (companyId: string, id: number | string, n: number) => `${companyId}/sales/${id}/prilog-${n}.pdf`
  export function refreshTargets(known: { sefInvoiceId: number; sefStatus: string | null }[], listed: ReadonlySet<number>): number[]
  // poznati redovi kojih nema na ovom spisku i nisu već poništeni
  export const SALES_FORBIDDEN = 'SEF ključ nema pravo na izlazne fakture — u SEF portalu dodelite ulogu „Korisnik za izlazne dokumente“ korisniku ovog API ključa.'
  export function salesRefusal(httpStatus: number): string | null               // 401 → odbijen ključ, 403 → SALES_FORBIDDEN
  ```
- Produces (`index.ts`): ulaz i provera pozivaoca kao `sef-pull` (cron sa service ključem ili `is_member()` sa tokenom pozivaoca); `claim_processor_sync(p_date, 'sef-sales', '')`; ključ i `company_id` kao u `sef-pull`; za svaki od `PULLED_STATUSES` jedan `POST ids`; novi id-jevi (najviše `MAX_NEW_PER_PASS`, ostatak sledeći prolaz, odgovor `more: true`): `GET sales-invoice`, `GET xml`, `GET pdf` → `sef_sales_upsert` sa `headerFromUbl`, pa update `ubl_xml = slimXml`, `ubl_fetched_at`, PDF u `sef-pdf` na `salesPdfPath` (`pdf_kind 'sef_rendering'`), prilozi na `salesAttachmentPath` u `sef_inbox_attachments`; za `refreshTargets` `GET sales-invoice` i za danas i juče (Beograd) `POST changes` → `sef_sales_status`. Odgovor `{ provider:'sef-sales', status, listed, inserted, refreshed, more, from, to }`; greške kroz `fail` kao u `sef-pull`, 403 sa `SALES_FORBIDDEN`.
- Produces (`sef-check`): posle ulazne provere jedan `POST sales-invoice/ids?status=Sent&dateFrom=<danas>&dateTo=<danas>`; odgovor dobija `sales_ok: boolean`, `sales_seen: number`, `sales_message: string`. Ulazni deo i kodovi grešaka se ne menjaju.
- Produces (`sefKey.ts`): `SefCheckResult` (ok grana) dobija `sales: { ok: boolean; message: string }`; `message` = dosadašnja rečenica + `' Izlazne fakture: dozvoljeno, danas izdatih: N.'` ili `' ' + sales_message`.
- Produces: `sef-fetch-invoice` i `sef-decide` čitaju `direction` i za `sales` red vraćaju 409 „To je izlazna faktura; otvara se iz sandučeta izlaznih faktura.“ pre bilo kog SEF poziva.

- [ ] **Step 1: Testovi** `src/services/sefSales.function.test.ts` (uvozi `../../supabase/functions/sef-pull-sales/salesInvoice`; fiktura: prodavac „Primer Gradnja d.o.o.“ PIB 100000009, kupac „Kupac Test d.o.o.“ PIB `RS100000002`, MB 12345678, broj „IF-12/2026“, 380, osnovica 100000.00, PDV 20000.00, TaxInclusive 120000.00, RSD, izdata 2026-10-31, promet 2026-10-30, dospeće 2026-11-15, jedan ugrađen PDF prilog):
  - `it('pulls exactly the five issued statuses')`: `PULLED_STATUSES` jednako `['Sent','Approved','Paid','OverDue','Archived']`; `isVoided('storno')`, `isVoided('Cancelled')`, `isVoided('Rejected')` true; `isVoided('Paid')` false.
  - `it('builds the ids url')`: `idsUrl('https://x/api/publicApi','Sent','2026-10-01','2026-11-04')` = `'https://x/api/publicApi/sales-invoice/ids?status=Sent&dateFrom=2026-10-01&dateTo=2026-11-04'`.
  - `it('reads ids in any case and drops repeats')`: `readIds({ salesInvoiceIds: [5, '7', 5] })` = `[5, 7]`; `readIds(null)` = `[]`.
  - `it('reads the status and the storno comment')`: `readStatus({ InvoiceId: 9, Status: 'Storno', StornoComment: 'greška' })` → `{ invoiceId: 9, status: 'Storno', comment: 'greška', ... }`.
  - `it('reads the header off the document')`: `headerFromUbl(fiktura)` → `documentNumber 'IF-12/2026'`, `documentType 'Invoice'`, `customerVatNumber '100000002'`, `customerRegistrationNumber '12345678'`, `amount 120000`, `sumWithoutVat 100000`, `vatAmount 20000`, `currency 'RSD'`, `deliveryDate '2026-10-30'`, `dueDate '2026-11-15'`; sa `InvoiceTypeCode 386` → `'Prepayment'`.
  - `it('keeps sales files apart from purchase files')`: `salesPdfPath('c', 555)` = `'c/sales/555.pdf'` (ulazni je `'c/555.pdf'`), `salesAttachmentPath('c', 555, 1)` = `'c/sales/555/prilog-1.pdf'`.
  - `it('asks again about a known row that left the list')`: `refreshTargets([{1,'Sent'},{2,'Sent'},{3,'Storno'}], new Set([1]))` = `[2]`.
  - `it('says plainly when the key may not read sales')`: `salesRefusal(403)` = `SALES_FORBIDDEN`; `salesRefusal(200)` = null.
  - `slimXml` ostavlja elemente prazne; `ublPdfAttachments` nalazi jedan prilog.
  - U `sefKey.test.ts`: `it('adds what the key may do with sales invoices')` — `mapSefCheckSuccess({ ok:true, invoices_seen:2, sales_ok:false, sales_message: SALES_FORBIDDEN })` → `sales.ok` false, `message` sadrži „nema pravo na izlazne fakture“; sa `sales_ok:true, sales_seen:3` → „Izlazne fakture: dozvoljeno, danas izdatih: 3.“
- [ ] **Step 2:** `CI=true npx react-scripts test --watchAll=false sefSales.function sefKey` → FAIL („Cannot find module“).
- [ ] **Step 3:** `salesInvoice.ts`, `index.ts`, izmene `sef-check`, `sef-fetch-invoice`, `sef-decide`, `sefKey.ts`.
- [ ] **Step 4:** isto → PASS; `npx tsc --noEmit -p .` → bez grešaka.
- [ ] **Step 5: Commit** — `git commit -m "feat(sef): sef-pull-sales reads issued invoices with their PDF; the key check says whether sales may be read"` (svi gore navedeni fajlovi).

### Task 3: Nacrt izlazne fakture iz UBL-a

**Files:**
- Create: `src/services/sef/salesDraft.ts`, `src/services/sef/salesDraft.test.ts`
- Test fixture: `src/services/sef/fixtures/sales-invoice-sample.xml` (iz Task 2), EUR varijanta pravi se u testu zamenom valute

**Interfaces:**
- Consumes: `parseUbl`, `bookedDateOf`, `isIndexed` (postojeće).
- Produces:
  ```ts
  export function salesDraftFromUbl(ubl: UblInvoice, row: { id: string; currency: string | null }, customerId: string | null,
    companyId: string | null, exchangeRate: number | null, eurRate: number | null): Record<string, unknown>
  // type 'revenue', partner_id = kupac, invoice_date = bookedDateOf, due_date, currency, amount = grossTotal ?? total,
  // document_type: 380 'invoice', 386 'advance_invoice', 381 'credit_note', 383 'debit_note'; billing_reference;
  // pl_impact = !isAdvanceInvoice; account_number null; note 'Izlazna faktura sa SEF-a' | 'Knjižno odobrenje sa SEF-a' | 'Knjižno zaduženje sa SEF-a' | 'Avansni račun sa SEF-a'
  export function salesBookingRefusal(ubl: UblInvoice, row: { sef_status: string | null }): string | null
  // poništena na SEF-u → 'Faktura je stornirana, otkazana ili odbijena na SEF-u i ne knjiži se.'
  // bez iznosa ili datuma → 'Dokument ne može da se pročita kao faktura.'
  // DO TASK 10: isAdvanceInvoice ili advanceUsed > 0 → 'Avansni račun i konačna faktura sa avansom knjiže se kad avansi kupaca budu uključeni.'
  export function isVoidedOnSef(status: string | null | undefined): boolean   // Cancelled | Storno | Rejected, bez obzira na velika slova
  export function voidedLabel(status: string | null | undefined): string | null  // 'Stornirana na SEF-u' | 'Otkazana na SEF-u' | 'Odbijena na SEF-u' | null
  export function salesReviewNotes(ubl: UblInvoice, ctx: { matchedBy: 'pib' | 'registration' | 'name' | null;
    company: { by: 'pib' | 'registration' | null; name: string | null } }): string[]
  // „Kupac prepoznat po PIB-u.“ / „… samo po nazivu — proverite.“ / „Kupac nije u partnerima — dodajte ga.“; firma prodavca; datum prometa = datum knjiženja i kursa
  ```
- [ ] **Step 1: Testovi** `salesDraft.test.ts`: `it('fills a revenue invoice from the document')` — `type 'revenue'`, `partner_id 'k1'`, `invoice_number 'IF-12/2026'`, `invoice_date '2026-10-30'`, `due_date '2026-11-15'`, `amount 120000`, `document_type 'invoice'`, `pl_impact true`; `it('books a euro invoice at the rate of the delivery date')` — EUR dokument, `exchangeRate 117.2`, `eurRate 117.2` → `currency 'EUR'`, `exchange_rate 117.2`; `it('maps the four document types')` (380/386/381/383); `it('refuses a voided or unreadable document')`; `voidedLabel('storno')` = 'Stornirana na SEF-u', `voidedLabel('Paid')` = null; `it('holds advance documents until customer advances exist')`; `it('says how the customer was found')`.
- [ ] **Step 2:** `CI=true npx react-scripts test --watchAll=false salesDraft` → FAIL.
- [ ] **Step 3:** implementacija.
- [ ] **Step 4:** isto → PASS.
- [ ] **Step 5: Commit** — `git commit -m "feat(sef): a revenue invoice drafted from a sales document"`.

### Task 4: Sanduče izlaznih faktura i dugmad na Prihodima

**Files:**
- Create: `src/components/SefSalesInboxDialog.tsx`, `src/components/SefSalesInboxDialog.render.test.tsx`
- Modify: `src/pages/Revenue.tsx` (dugmad „SEF izlazne“, „Preuzmi sa SEF-a“, „Nova izlazna faktura“ iznad liste), `src/pages/Revenue.render.test.tsx`

**Interfaces:**
- Consumes: Task 1 (kolone, `sef_inbox_mark_imported`), Task 2 (`sef-pull-sales`), Task 3 (`salesDraftFromUbl`, `salesBookingRefusal`, `salesReviewNotes`, `isVoidedOnSef`, `voidedLabel`), postojeće `matchSupplier` (za kupca: PIB/MB/naziv kupca), `matchCompany` (za prodavca), `findLikelyDuplicate`, `sefPdfUrl`/`sefObjectUrl`, `attachmentsByInbox`, `attachmentLabel`, `getBookRates`/`rateFor`, `PartnerDialog`, `InvoiceDialog` (`invoice`, `sourceDocuments`, `reviewNotes`, `onSaved`, `creditNote`).
- Produces: `export default function SefSalesInboxDialog({ onClose, onImported }: { onClose: () => void; onImported: () => void })`. Čita `sef_inbox` sa `.eq('direction','sales')` (bez `ubl_xml`), izlazne fakture iz knjiga (`invoices`, `type 'revenue'`, za duplikate), partnere, firme, priloge. Filteri čekaju / proknjižene / odbijene / sve; kolone kupac, broj, datum, iznos, SEF status; PDF i prilozi; „Odbij“ sa razlogom i „Vrati u red“ (isti upisi kao ulazno). Nema SEF odluka ni upozorenja o „New“.
  - „Proknjiži“: čita `ubl_xml` tog reda (bez SEF poziva), `parseUbl`; `salesBookingRefusal` ≠ null → poruka na redu; inače kurs na `bookedDateOf`, nacrt, `InvoiceDialog` sa `sourceDocuments` [„Faktura (SEF)“, prilozi], `onSaved` → `sef_inbox_mark_imported`.
  - Poništen red (`isVoidedOnSef`): oznaka `voidedLabel(sef_status)` i nema „Proknjiži“.
  - Duplikat (isti kupac, isti broj u knjigama): upozorenje i „Poveži sa postojećom“ → `sef_inbox_mark_imported(red, ta faktura)`.
  - Nepoznat kupac: „Dodaj kupca“ otvara `PartnerDialog` sa nazivom (NBS pretraga je u njemu).
  - SEF status „Paid“: prikazuje se kao „Plaćena (SEF)“, samo informacija.
- Produces (Revenue): `SefSalesInboxDialog` iz „SEF izlazne“; „Preuzmi sa SEF-a“ zove `functions.invoke('sef-pull-sales', { body: {} })` i prikazuje broj novih (ili grešku iz tela odgovora); „Nova izlazna faktura“ otvara `InvoiceDialog` sa `invoice={{ type: 'revenue', company_id }}`. Dugmad samo za `canEdit`, osim „Preuzmi sa SEF-a“ (članovi).

- [ ] **Step 1: Render testovi** `SefSalesInboxDialog.render.test.tsx` (mock kao `SefInboxDialog.pdf.render.test.tsx`, `InvoiceDialog` mock beleži props):
  - `it('reads only sales rows')` — `eq('direction','sales')` zabeležen; red prikazuje „Kupac Test d.o.o.“ i „IF-12/2026“.
  - `it('opens the invoice dialog with the drafted revenue invoice and its PDF')` — klik „Proknjiži“ → props `invoice.type 'revenue'`, `invoice.partner_id` kupca nađenog po PIB-u 100000002, `invoice.amount 120000`, `sourceDocuments[0].label 'Faktura (SEF)'`; `functions.invoke` nije pozvan.
  - `it('marks the row booked after saving')` — `onSaved('inv9')` → `rpc('sef_inbox_mark_imported', { p_id:'r1', p_invoice_id:'inv9' })`.
  - `it('does not offer booking for an invoice voided on SEF')` — `sef_status 'Storno'` → „Stornirana na SEF-u“ i nema „Proknjiži“.
  - `it('links an invoice already typed in by hand')` — knjige imaju izlaznu „IF-12/2026“ istog kupca → „Poveži sa postojećom“ → rpc sa njenim id-jem.
  - `it('offers to add an unknown customer')` — bez partnera → „Dodaj kupca“ otvara `PartnerDialog`.
  - `it('needs a reason to decline')` — „Odbij“ bez razloga ne upisuje; sa razlogom `update({ state:'dismissed', dismiss_reason })`.
  - `it('says why an advance document waits')` — 386 → poruka iz `salesBookingRefusal`, `InvoiceDialog` nije otvoren.
  - U `Revenue.render.test.tsx`: `it('pulls sales invoices from SEF on request')` — klik „Preuzmi sa SEF-a“ → `invoke('sef-pull-sales', { body: {} })`; `it('opens a new revenue invoice')` — „Nova izlazna faktura“ → `InvoiceDialog` mock sa `invoice.type 'revenue'`.
- [ ] **Step 2:** `CI=true npx react-scripts test --watchAll=false SefSalesInboxDialog Revenue.render` → FAIL.
- [ ] **Step 3:** implementacija.
- [ ] **Step 4:** isto → PASS; `CI=true npx react-scripts test --watchAll=false SefInboxDialog InvoiceDialog` → PASS (ulazna strana netaknuta).
- [ ] **Step 5: Commit** — `git commit -m "feat(revenue): a sales-invoice inbox; booking, linking and declining issued invoices"`.

### Task 5: Razvrstavanje — projekat, zakup, prodaja usluga

**Files:**
- Create: `src/services/revenueClassification.ts`, `src/services/revenueClassification.test.ts`, `src/components/InvoiceDialog.classification.render.test.tsx`
- Modify: `src/components/InvoiceDialog.tsx` (izlazna: fieldset „Razvrstavanje“, upis `lease_id`/`service_month`), `src/components/SefSalesInboxDialog.tsx` (predlog u nacrt), `src/components/revenue/RentInvoiceProposals.tsx` + `LeasesSection.tsx` (podsetnik)

**Interfaces:**
- Consumes: `RentalLease`, `PlanInvoice`, `leaseMonthRent`, `monthKey` (`revenuePlan.ts`); `Project` (`projects.ts`); `isDuplicateRentError` (`revenuePage.ts`); `DocumentType`.
- Produces:
  ```ts
  export type RevenueKind = 'project' | 'lease' | 'services'
  export const REVENUE_KIND_LABEL: Record<RevenueKind, string>   // 'Projekat' | 'Zakup' | 'Prodaja usluga'
  export function revenueKindOf(i: { lease_id?: string | null; project_id?: string | null }): RevenueKind
  export function serviceMonthIn(text: string): string | null     // 'zakup za oktobar 2026' / 'oktobra 2026' / '10/2026' / '10.2026' → '2026-10-01'
  export interface LeaseProposal { leaseId: string; projectId: string; serviceMonth: string; alreadyBilled: boolean; why: string }
  export function proposeLease(inv: { partnerId: string | null; net: number | null; gross: number | null; currency: string | null; date: string; text: string },
    leases: RentalLease[], invoices: PlanInvoice[]): LeaseProposal | null
  // aktivni zakupi tog zakupca; mesec = serviceMonthIn(text) ?? mesec datuma; iznos = leaseMonthRent(l, mesec) jednak net ili gross (±0,01, ista valuta);
  // jedan aktivan zakup + mesec u tekstu → predlog i bez iznosa; alreadyBilled = živ red sa istim (lease_id, mesec)
  export interface ProjectProposal { projectId: string; why: string }
  export function proposeProject(inv: { partnerId: string | null; number: string | null; text: string }, projects: Project[],
    history: { partner_id: string | null; project_id: string | null; invoice_date: string | null; lease_id?: string | null }[]): ProjectProposal | null
  // 1. šifra ili naziv aktivnog građevinskog projekta u broju/opisu; 2. najčešći projekat poslednjih 5 izlaznih faktura kupca (bez zakupa, izjednačeno → noviji); 3. jedini aktivni građevinski projekat čiji je investitor kupac
  export function classificationProblem(c: { kind: RevenueKind | null; projectId: string | null; leaseId: string | null; serviceMonth: string | null }, docType: DocumentType): string | null
  // 'Izaberite: projekat, zakup ili prodaja usluga.' | 'Izaberite projekat.' | 'Izaberite zakup i mesec usluge.'
  // zakup na credit_note/debit_note/proforma/advance_invoice → 'Zakup se bira samo na računu; ovaj dokument ide na projekat zgrade.'
  ```
- Produces (InvoiceDialog, samo `invType === 'revenue'`): `<fieldset aria-label="Razvrstavanje">` sa tri radija; Projekat → postojeći `projectPanel`; Zakup → `<select aria-label="Zakup">` (aktivni zakupi firme: zakupac · projekat) i `<input type="month" aria-label="Mesec usluge">`, upozorenje „Za ovaj zakup je mesec već fakturisan.“ kad postoji; Prodaja usluga → projekat prazan. Payload novog dokumenta: `lease_id`, `service_month` (prvi u mesecu), `project_id` = projekat zakupa / izabrani / null. Postojeća faktura za zakup ostaje zaključana (kao danas). Nacrt može doneti `revenue_kind`, `lease_id`, `service_month`, `project_id`, `classification_why` (ide u napomene za pregled). Odbijanje jedinstvenog para → „Za ovaj zakup i mesec faktura već postoji.“
- Produces (sanduče): pre otvaranja nacrta `proposeLease` pa `proposeProject` (istorija = izlazne fakture iz knjiga), zakup ima prednost.
- Produces (podsetnik): dugme u `LeasesSection` „Meseci bez fakture za zakup“; `RentInvoiceProposals` samo nabraja zakupe bez fakture za mesec, bez pravljenja faktura, sa rečenicom „Faktura za zakup se izdaje na SEF-u ili u Calculus-u; kad stigne, proknjižite je iz „SEF izlazne“.“

- [ ] **Step 1: Testovi** `revenueClassification.test.ts`: `revenueKindOf` (zakup → 'lease', samo projekat → 'project', ništa → 'services'); `serviceMonthIn` (četiri oblika, 'bez meseca' → null); `it('proposes the lease when the amount is the monthly rent')` (zakup 50000 RSD, net 50000 → predlog, mesec iz datuma 2026-10-31 → '2026-10-01'); `it('flags a month already billed')`; `it('matches the rent with VAT too')` (gross 60000); `it('does not guess between two leases without the amount')`; `proposeProject` sva tri pravila i null; `classificationProblem` sve poruke. Render `InvoiceDialog.classification.render.test.tsx` (mock kao `InvoiceDialog.documentType.render.test.tsx`): `it('requires a classification on a revenue invoice')`; `it('saves a rent invoice with its lease, month and building')` → insert sadrži `lease_id`, `service_month '2026-10-01'`, `project_id` zgrade; `it('saves services with no project')`; `it('explains a month already billed instead of the database error')` (insert vrati `{ code:'23505', message:'invoices_lease_month_key' }`).
- [ ] **Step 2:** `CI=true npx react-scripts test --watchAll=false revenueClassification InvoiceDialog.classification` → FAIL.
- [ ] **Step 3:** implementacija (i izmena postojećih testova `RentInvoiceProposals`/`LeasesSection` ako ih ima, na novi podsetnik).
- [ ] **Step 4:** `CI=true npx react-scripts test --watchAll=false revenueClassification InvoiceDialog SefSalesInboxDialog Revenue` → PASS.
- [ ] **Step 5: Commit** — `git commit -m "feat(revenue): every revenue invoice is a project, a lease or sales of services; rent recognised from the lease"`.

### Task 6: Brojke potraživanja

**Files:**
- Create: `src/services/receivables.ts`, `src/services/receivables.test.ts`

**Interfaces:**
- Consumes: `RevenueListRow` (`revenuePage.ts`), `pickAmount`, `DisplayCurrency`, `daysBetween` (`revenue.ts`), `isVoidedOnSef` (Task 3). Aplikacija nikad ne uvozi iz `supabase/functions` (CRA ne gradi van `src`); to rade samo Jest testovi.
- Produces:
  ```ts
  export const DUE_SOON_DAYS = 7
  export type ReceivableBucket = 'all' | 'dueSoon' | 'overdue'
  export interface ReceivableTotals { total: number; dueSoon: number; overdue: number
    counts: Record<ReceivableBucket, number>; unconverted: number; proformasAwaiting: { count: number; amount: number } }
  export function isReceivable(r: RevenueListRow): boolean   // type revenue, document_type nije proforma ni advance_invoice, ostatak > 0,005
  export function receivableTotals(rows: readonly RevenueListRow[], today: string, currency: DisplayCurrency): ReceivableTotals
  // dueSoon: today ≤ due_date ≤ today+7; overdue: due_date < today; bez dospeća: samo u total
  export function receivablesIn(rows: readonly RevenueListRow[], bucket: ReceivableBucket, today: string): RevenueListRow[]  // po dospeću
  export interface LatePayer { partnerId: string | null; partnerName: string; amount: number; oldestDue: string; daysLate: number; count: number; oldestInvoiceId: string }
  export function latePayers(rows: readonly RevenueListRow[], today: string, currency: DisplayCurrency): LatePayer[]   // po iznosu, opadajuće
  export type SefFlag = 'voided' | 'paid_on_sef'
  export function sefFlags(rows: readonly { id: string; calculated_status?: string | null }[],
    sefRows: readonly { imported_invoice_id: string | null; sef_status: string | null }[]): Map<string, SefFlag>
  // 'paid_on_sef' samo kad SEF kaže Paid a izvod ne (calculated_status ≠ 'paid')
  ```
  `RevenueListRow` dobija opciona polja `document_type`, `due_date` ako ih nema.
- [ ] **Step 1: Testovi** (danas '2026-11-04'): redovi A dospeće 2026-10-20 ostatak 100000, B 2026-11-04 50000, C 2026-11-11 30000, D 2026-11-12 20000, E predračun 40000, F plaćen 0, G bez dospeća 10000 → `it('adds up what customers owe, what falls due within seven days and what is late')`: `total 210000`, `dueSoon 80000`, `overdue 100000`, `counts { all:5, dueSoon:2, overdue:1 }`, `proformasAwaiting { count:1, amount:40000 }`; `it('counts in euros at the rate of each invoice')` (iste fakture sa `remaining_eur` → zbir `remaining_eur`); `it('lists late payers by amount')` (kupac X: 100000 dospeće 10-20 i 25000 dospeće 10-01 → `amount 125000`, `oldestDue '2026-10-01'`, `daysLate 34`, `count 2`; kupac Y 60000 drugi); `receivablesIn` za 'overdue' vraća samo A; `sefFlags`: Storno → 'voided', Paid a `partial` → 'paid_on_sef', Paid a `paid` → nema.
- [ ] **Step 2:** `CI=true npx react-scripts test --watchAll=false receivables` → FAIL.
- [ ] **Step 3:** implementacija.
- [ ] **Step 4:** isto → PASS.
- [ ] **Step 5: Commit** — `git commit -m "feat(revenue): receivables, due within seven days, late, and who is late"`.

### Task 7: Stranica Prihodi — novi redosled

**Files:**
- Create: `src/components/revenue/ReceivablesCards.tsx`, `src/components/revenue/LatePayersTable.tsx`
- Modify: `src/pages/Revenue.tsx`, `src/components/revenue/ProjectRevenueTable.tsx`, `src/components/revenue/RevenueInvoiceList.tsx`, `src/services/revenuePage.ts` (+ `revenuePage.test.ts`), `src/pages/Revenue.render.test.tsx`

**Interfaces:**
- Consumes: Task 6 sve; Task 5 `revenueKindOf`, `REVENUE_KIND_LABEL`; `PartnerCardDialog({ partner, onClose })`, `DocumentViewerDialog({ invoiceId, title, onClose })`.
- Produces: redosled od vrha — `ReceivablesCards` (tri kartice „Ukupna potraživanja“, „Dospeva u narednih 7 dana“, „Kasni“, svaka `<button>` koji otvara tabelu tih faktura; ispod linija „Predračuni koji čekaju uplatu: N · iznos“), „Ko kasni“ (`LatePayersTable`: kupac, iznos, najstarije dospeće, dana kašnjenja; dugmad „Kartica“ → `PartnerCardDialog` (IOS je u kartici) i „PDF“ → `DocumentViewerDialog` najstarije fakture), „Po projektima“, „Izlazne fakture“, pa „Starost potraživanja“, „Plan prihoda“, „Zakup“. Pet starih kartica se uklanjaju: fakturisano i naplaćeno u periodu ostaju u redu „Ukupno“ liste, preostali avans u tabeli projekata, plan do kraja godine u naslovu odeljka plana („Plan prihoda · do kraja godine X“).
- Produces (`revenuePage.ts`): `projectRevenueRows(..., opts?: { constructionOnly?: boolean })` — sa `true` preskače projekte `kind 'rental'` i fakture sa `lease_id`; `ProjectRevenueRow.remainingToBill: number | null` (= ugovor − fakturisano, null bez ugovora); `InvoiceFilter.kind: '' | RevenueKind`.
- Produces (lista): filter `<select aria-label="Razvrstavanje">` (svi / projekat / zakup / prodaja usluga), kolona razvrstavanja, dugme „PDF“ po redu (`DocumentViewerDialog`, `stopPropagation`), crvena oznaka „Stornirana na SEF-u“ za `sefFlags = 'voided'` i žuta „SEF: plaćena, izvod ne“ za `'paid_on_sef'`. Revenue čita `sef_inbox` (`direction 'sales'`, `imported_invoice_id, sef_status`) za oznake.
- [ ] **Step 1: Testovi** — `revenuePage.test.ts`: `it('leaves rental buildings out of the project table')`, `it('says what is left to bill on a contract')` (ugovor 1000000, fakturisano 300000 → `remainingToBill 700000`), `filterRevenueInvoices` sa `kind 'lease'`. `Revenue.render.test.tsx` (nov `describe('Prihodi — receivables first')`, datumi preko `daysAgo`): tri kartice sa punim ciframa („210.000 RSD“ itd.); klik „Kasni“ → tabela samo sa zakasnelim brojem; „Ko kasni“ red sa „125.000 RSD“; redosled naslova u DOM-u `['Ko kasni','Po projektima','Izlazne fakture','Starost potraživanja','Plan prihoda','Zakup']`; `it('warns in red about an invoice voided on SEF')`; `it('opens the customer card from the late list')`; tabela projekata ima „Preostalo za fakturisanje“ i „700.000 RSD“, a zgrada u zakupu nije u njoj. Postojeći testovi koji traže stare kartice („Fakturisano u periodu · RSD“) prepravljaju se na nove.
- [ ] **Step 2:** `CI=true npx react-scripts test --watchAll=false revenuePage Revenue.render` → FAIL.
- [ ] **Step 3:** implementacija.
- [ ] **Step 4:** isto → PASS; `npx tsc --noEmit -p .`.
- [ ] **Step 5: Commit** — `git commit -m "feat(revenue): the page opens with receivables, due soon and late, then who is late"`.

### Task 8: Brisanje izlazne fakture sa svim vezanim

**Files:**
- Create: `supabase/migrations/20261104100000_delete_invoice_cascade.sql`, `supabase/tests/delete_invoice_cascade_test.sql`, `src/services/invoiceDelete.ts`, `src/services/invoiceDelete.test.ts`, `src/components/InvoiceDialog.delete.render.test.tsx`
- Modify: `src/components/InvoiceDialog.tsx` (dugme i potvrda)

**Interfaces:**
- Produces, SQL: `delete_invoice_cascade(p_invoice uuid, p_dry_run boolean default false) returns jsonb`, `security definer`, `search_path public`; odbija bez `can_write_books()` i `has_company_access(company_id)`; zaključava fakturu `for update`. Vraća `{ invoice_number, type, payments_unlinked int, advance_links_removed int, finals_reopened text[], notes_deleted text[], uploads_removed int, sef_row text }` (`sef_row`: `'pending'` | `'dismissed'` | null). Bez `p_dry_run`, ovim redom: briše `advance_usage` (konačna ili avansni = ta faktura), `advance_coverage` (avansni ili predračun = ta), `invoice_transaction_links` fakture i njenih knjižnih odobrenja/zaduženja; meko briše odobrenja/zaduženja vezana za nju (`adjusts_invoice_id`), pa nju (`deleted_at = now()`, `deleted_by = auth.uid()`); `invoice_documents` tih faktura dobija `removed_at/removed_by`; njihovi `sef_inbox` redovi: `sales` sa poništenim statusom → `state 'dismissed'`, `dismiss_reason 'Stornirana, otkazana ili odbijena na SEF-u (<status>); proknjižena faktura obrisana.'`, ostali → `state 'pending'` (okidač čisti vezu jer je faktura obrisana). Sve ili ništa (zaključan period i ostali okidači prekidaju ceo poziv). `grant execute` za `authenticated`, revoke `public, anon`. Odluka: knjižna odobrenja/zaduženja se brišu zajedno sa fakturom; potvrda ih nabraja.
- Produces (`invoiceDelete.ts`):
  ```ts
  export interface DeletePreview { invoice_number: string | null; payments_unlinked: number; advance_links_removed: number
    finals_reopened: string[]; notes_deleted: string[]; uploads_removed: number; sef_row: 'pending' | 'dismissed' | null }
  export function deleteConsequences(p: DeletePreview): string[]
  // 'Veze sa 2 uplate se raskidaju; uplate ostaju na izvodu, nepovezane.' · 'Veze sa avansima se brišu (1).' ·
  // 'Konačna faktura IF-9/2026 ponovo potražuje deo koji je pokrivao ovaj avans.' · 'Briše se i knjižno odobrenje KO-1/2026.' ·
  // 'Ručno otpremljeni PDF-ovi se sklanjaju (1).' · 'SEF red se vraća u red „čeka“.' | 'SEF red ostaje odbijen (faktura je stornirana na SEF-u).'
  export async function previewDelete(client: { rpc: Function }, invoiceId: string): Promise<DeletePreview>
  export async function deleteInvoiceCascade(client: { rpc: Function }, invoiceId: string): Promise<DeletePreview>
  ```
- Produces (InvoiceDialog): za postojeću izlaznu fakturu i `canEdit` dugme „Obriši fakturu i sve vezano“ → `previewDelete` → panel sa `deleteConsequences` i „Obriši“ / „Odustani“ → `deleteInvoiceCascade` → `onClose()`; greška iz baze se prikazuje kao `saveError`.
- [ ] **Step 1: SQL test** `delete_invoice_cascade_test.sql` (firma „Test brisanje (TEST-BR)“): izlazna 120000 plaćena sa 50000 preko izvoda, knjižno odobrenje −10000 vezano, otpremljen dokument, `sales` SEF red `imported` → `p_dry_run` vraća `payments_unlinked 1`, `notes_deleted {'KO-1'}`, `uploads_removed 1`, `sef_row 'pending'` i ništa ne menja; pravi poziv → faktura i odobrenje obrisani, transakcija živa bez veze, dokument `removed_at` popunjen, SEF red `pending` bez `imported_invoice_id`; stornirani SEF red → `dismissed` sa razlogom; ulazna faktura sa ulaznim redom radi isto (oba smera); avansni račun korišćen konačnom → posle brisanja konačna nema `advance_usage`, `finals_reopened` sadrži njen broj; okidač napravljen u testu koji baca izuzetak na update `sef_inbox` → poziv pada, a faktura, veza sa uplatom i odobrenje su netaknuti (blok `begin … exception … end`); korisnik sa ulogom `manager` (profil u testu, `set local request.jwt.claims` + `set local role authenticated`, kao `invoice_documents_test.sql`) → odbijeno sa `insufficient_privilege`.
- [ ] **Step 2:** `sqltest supabase/tests/delete_invoice_cascade_test.sql` → `ERROR: function public.delete_invoice_cascade(uuid, boolean) does not exist`.
- [ ] **Step 3:** migracija; `sqltest supabase/migrations/20261104090000_sales_invoices_in_the_inbox.sql supabase/migrations/20261104100000_delete_invoice_cascade.sql supabase/tests/delete_invoice_cascade_test.sql` → `ALL TESTS PASSED`.
- [ ] **Step 4: Jest testovi** — `invoiceDelete.test.ts`: `deleteConsequences` za pun i prazan pregled (prazan → `['Faktura nema vezanih uplata, avansa ni dokumenata.']`); `previewDelete` zove `rpc('delete_invoice_cascade', { p_invoice, p_dry_run: true })`. `InvoiceDialog.delete.render.test.tsx`: `it('lists what deleting will do before it deletes')`, `it('deletes through one database call and closes')`, `it('does not offer deleting a supplier invoice or to someone who does not keep the books')`.
- [ ] **Step 5:** `CI=true npx react-scripts test --watchAll=false invoiceDelete InvoiceDialog` → FAIL, implementacija → PASS.
- [ ] **Step 6: Commit** — `git commit -m "feat(revenue): delete a revenue invoice and everything linked to it in one transaction"`.

### Task 9: Avansi kupaca — baza

**Files:**
- Create: `supabase/migrations/20261104110000_customer_advances.sql`, `supabase/tests/customer_advances_test.sql`

**Interfaces:**
- Consumes: `invoices_advance_shape` (20261021090000), `advance_coverage_rules` (20261021090000), `advance_usage_rules` i `invoices_keep_advance_links` (poslednje verzije u 20261027090000).
- Produces: `invoices_advance_shape` — proforma/advance_invoice dozvoljeni za `type in ('expense','revenue')` (i dalje `pl_impact := false`, iznos > 0); `advance_coverage_rules` dodaje „Predračun % nije istog smera kao avansni račun.“ kad se `type` razlikuje; `advance_usage_rules` — umesto `v_fin.type <> 'expense'` traži `v_fin.type = v_av.type`, poruka „Avans koristi samo živ račun istog smera, firme, partnera i valute.“, ostalo kao u 20261027090000. Ništa drugo se ne menja (ulazni testovi isti).
- Produces, view `v_customer_advances` (security_invoker, kao `v_supplier_advances` za `type = 'revenue'`), po (company_id, partner_id, project_id, currency): `partner_name`, `project_name`, `received_on_proformas`, `covered`, `advance_total`, `used`, `received_without_advance` (= received − covered), `advance_open` (= total − used). Grant select authenticated/service_role, revoke anon.
- [ ] **Step 1: SQL test** `customer_advances_test.sql` (firma „Test avansi kupaca (TEST-AK)“, dva kupca): predračun 120000 izlazni bez P&L i `unpaid`; uplata kupca (link) → `paid`; avansni 120000 pokriva ga; konačna 300000 koristi 120000 → `remaining_rsd 180000`, `partial`; **P&L izlaza firme (`v_pl_entries`) = 300000** (avansni i predračun nisu u njemu); izlazni avansni korišćen ulaznom fakturom → odbijeno; izlazni avansni pokriven ulaznim predračunom → odbijeno; avans 200000 korišćen 150000 pa 50000 na dve konačne → `advance_open 0`, treći pokušaj odbijen; `v_customer_advances` red: `received_on_proformas 120000`, `covered 120000`, `used 120000`, `advance_open 0`; `v_supplier_advances` nema redova za ovu firmu.
- [ ] **Step 2:** `sqltest supabase/tests/customer_advances_test.sql` → greška (izlazni predračun odbijen: „Predračun je dokument dobavljača (ulazni).“).
- [ ] **Step 3:** migracija.
- [ ] **Step 4:** `sqltest supabase/migrations/20261104090000_sales_invoices_in_the_inbox.sql supabase/migrations/20261104100000_delete_invoice_cascade.sql supabase/migrations/20261104110000_customer_advances.sql supabase/tests/customer_advances_test.sql` → `ALL TESTS PASSED`; isto sa `supplier_advances_test.sql` i `credit_and_debit_notes_test.sql` umesto poslednjeg → `ALL TESTS PASSED`.
- [ ] **Step 5: Commit** — `git commit -m "feat(advances): the advance chain works for customers too, never across directions"`.

### Task 10: Avansi kupaca — formular i sanduče

**Files:**
- Create: `src/components/InvoiceDialog.customerAdvances.render.test.tsx`, `src/services/sef/fixtures/sales-final-invoice-sample.xml` (konačna 300000 sa PDV-om, `BillingReference` „AV-7/2026“ 2026-09-15, `InvoicedPrepaymentAmmount` 120000, za plaćanje 180000; izmišljene firme)
- Modify: `src/components/InvoiceDialog.tsx`, `src/services/advances.ts` (+ test), `src/services/sef/salesDraft.ts` (+ test)

**Interfaces:**
- Consumes: Task 9; postojeće `proposeUsage`, `proposeCoverage`, `coverageProblem`, `usageProblem`, `proformaNumbersIn`, `replace_advance_links`.
- Produces (`advances.ts`): `openAdvancesNotice(advances, side: 'expense' | 'revenue' = 'expense')` — za `revenue` „Kupac ima otvorene avanse: …“.
- Produces (InvoiceDialog): `isSupplierBill` postaje `isFinalBill = docType === 'invoice'` (oba smera); upiti otvorenih avansa i plaćenih predračuna dodaju `.eq('type', invType)`; avansni iz ranijeg perioda pravi se sa `type: invType`; predračun i avansni račun nude se i za izlazne (razvrstavanje: projekat ili prodaja usluga); za `hasNoPl(docType)` vrsta prihoda nije obavezna; poruka za nepostojeći avans na izlaznoj: „Konačna faktura navodi avansni račun X koji nije u knjigama.“ Odeljak „Odbijeni avans“ se prikazuje samo kad postojeća faktura već ima `advance_deducted > 0` (nov unos ga nema).
- Produces (`salesDraft.ts`): za 386 `proforma_hints: proformaNumbersIn(ubl.advanceText)`; za konačnu (`advanceUsed > 0`) `amount: grossTotal`, `advance_refs: billingReferences`, `advance_used`; `salesBookingRefusal` više ne odbija avansne dokumente; `salesReviewNotes` dodaje „Konačna faktura: pun iznos X ide u prihod, avans Y je već primljen, za naplatu Z.“
- [ ] **Step 1: Testovi** — `salesDraft.test.ts`: `it('drafts a final invoice at its full amount with the advances it names')` (fiktura → `amount 300000`, `advance_used 120000`, `advance_refs[0].number 'AV-7/2026'`), prepravka testa „holds advance documents“ u „books advance documents“. `advances.test.ts`: `openAdvancesNotice` za kupca. Render: `it('posts a customer proforma with no P&L and no revenue stream')`; `it('covers the customer proforma named on a SEF advance invoice')` (`proforma_hints ['177/2026']` → `replace_advance_links` sa `p_coverage [{ proforma_id, amount:120000 }]`); `it('books the final invoice in full and uses the advance')` (→ insert `amount 300000`, `p_usage [{ advance_invoice_id, amount:120000 }]`); `it('will not post a final invoice whose advance is not in the books')` + dodavanje iz ranijeg perioda omogućava; `it('reads only customer advances for a revenue invoice')` (snimač `eq('type','revenue')`); `it('shows no advance deduction field on a new revenue invoice')` i `it('keeps the deduction of an invoice that already has one')`.
- [ ] **Step 2:** `CI=true npx react-scripts test --watchAll=false InvoiceDialog.customerAdvances salesDraft advances` → FAIL.
- [ ] **Step 3:** implementacija.
- [ ] **Step 4:** `CI=true npx react-scripts test --watchAll=false InvoiceDialog salesDraft advances SefSalesInboxDialog` → PASS (i `InvoiceDialog.advances.render.test.tsx` za dobavljače nepromenjen).
- [ ] **Step 5: Commit** — `git commit -m "feat(advances): customer proformas, advance invoices and final invoices in the invoice dialog and from SEF"`.

### Task 11: Avansi kupaca — izvod, stari mehanizam sakriven, panel, zbirovi bez dokumenata bez P&L

**Files:**
- Create: `src/components/revenue/CustomerAdvancesSection.tsx`, `src/components/revenue/CustomerAdvancesSection.render.test.tsx`
- Modify: `src/services/advances.ts` (+ test), `src/services/advanceReceipt.ts` (+ test), `src/components/BankStatementDialog.tsx` (dugme za uplatu kupca, oznaka avansa), `src/components/TransactionDialog.tsx`, `src/components/BulkImport.tsx` (+ `BulkImport.recognition.render.test.tsx`), `src/services/revenuePage.ts`, `src/services/revenue.ts` (+ testovi), `src/pages/Revenue.tsx`

**Interfaces:**
- Consumes: `v_customer_advances` (Task 9).
- Produces (`advances.ts`): `proformaFromPayment({ ..., side?: 'expense' | 'revenue' })` — `revenue`: iz uplate kupca (iznos > 0 sa priliva), `type 'revenue'`, napomena „Predračun napravljen iz uplate kupca od DD.MM.YYYY“, greška bez partnera „Prvo izaberite kupca.“; `expense` tačno kao danas.
- Produces (`advanceReceipt.ts`): `export function showsLegacyAdvance(stored: { is_advance?: boolean | null } | null | undefined): boolean` — true samo za već sačuvanu uplatu označenu kao avans.
- Produces (dijalozi): „Nov predračun iz ove uplate“ i za priliv (`parseFloat(row.credit) > 0`) u `BankStatementDialog` i za primljenu uplatu u `TransactionDialog`, sa `side: 'revenue'`; polje „Avans — primljen od investitora“ prikazuje se samo kad `showsLegacyAdvance(sačuvani red)` (u `BulkImport` nikad, jer su redovi uvek novi).
- Produces (zbirovi): `revenuePage.live`, `revenue.projectRevenueSummary` i `revenue.receivablesAging` preskaču `document_type` `proforma` i `advance_invoice` (fakturisano, naplaćeno, nenaplaćeno, starost).
- Produces (`CustomerAdvancesSection({ companyId, format })`): tabela iz `v_customer_advances` (kupac, projekat, primljeno po predračunima, pokriveno avansnim, iskorišćeno, otvoreno) sa upozorenjima „Primljeno bez avansnog računa: X“ i „Avans čeka konačnu fakturu: Y“; prazno → „Nema avansa kupaca.“; na Prihodima poslednji odeljak „Avansi kupaca“.
- [ ] **Step 1: Testovi** — `advances.test.ts`: `it('makes a customer proforma from a receipt')` (`type 'revenue'`, iznos 120000, napomena), `it('needs the customer first')`; `advanceReceipt.test.ts`: `showsLegacyAdvance` (null/novi → false, sačuvan sa `is_advance true` → true); `BulkImport.recognition.render.test.tsx`: `it('offers no advance flag on a new receipt')`; `revenuePage.test.ts`/`revenue.test.ts`: `it('does not count a proforma or an advance invoice as billed')`; `CustomerAdvancesSection.render.test.tsx`: red kupca sa „120.000 RSD“ i upozorenje „Avans čeka konačnu fakturu: 80.000 RSD“ (avansni 200000, iskorišćeno 120000); `Revenue.render.test.tsx`: naslov „Avansi kupaca“ je poslednji.
- [ ] **Step 2:** `CI=true npx react-scripts test --watchAll=false advances advanceReceipt BulkImport revenuePage revenue.test CustomerAdvancesSection Revenue.render` → FAIL.
- [ ] **Step 3:** implementacija (`BankStatementDialog` i `TransactionDialog` nemaju render harness: logika je u testiranim funkcijama, prikaz se proverava kroz `tsc` i ručno u Task 12).
- [ ] **Step 4:** isto → PASS; `npx tsc --noEmit -p .`.
- [ ] **Step 5: Commit** — `git commit -m "feat(advances): a customer proforma from a receipt, the old project advance hidden for new entries, customer advances on Prihodi"`.

### Task 12: Provera celine, merge u MCFlow, postavljanje

**Files:**
- Create (MCFlow repo): `C:\Users\Predrag PC\mcflow\supabase\migrations\20261104120000_odobri_ignores_sales.sql`, `C:\Users\Predrag PC\mcflow\supabase\tests\odobri_ignores_sales_test.sql`

**Interfaces:**
- Produces (samo MCFlow): okidač `odobri_cases_purchase_only` (before insert na `odobri_cases`): ako je `sef_inbox.direction = 'sales'` → „Izlazna faktura ne ide u MCOdobri.“
- [ ] **Step 1:** FlowBase: `CI=true npx react-scripts test --watchAll=false` → sve PASS; `npx tsc --noEmit -p .` → bez grešaka; svi `supabase/tests/*.sql` sa sve tri nove migracije ispred → `ALL TESTS PASSED`. Završna recenzija cele grane i jedan krug ispravki.
- [ ] **Step 2:** MCFlow: `git merge flowbase/main`; MCFlow migracija i test (sales red → odobri slučaj odbijen; purchase red i dalje prolazi `odobri_send`); `sqltest` nad MCFlow bazom za sve nove migracije i testove → `ALL TESTS PASSED`; ceo Jest paket u MCFlow-u → PASS.
- [ ] **Step 3:** MCFlow baza kroz CLI rutinu: `npx supabase db push` → migracije 20261104090000, 20261104100000, 20261104110000, 20261104120000 primenjene; provera: broj ulaznih redova u `sef_inbox` i broj faktura isti kao pre.
- [ ] **Step 4:** Uz potvrdu vlasnika: `npx supabase functions deploy sef-pull-sales sef-check sef-fetch-invoice sef-decide`. Pa „Proveri vezu“ u Podešavanjima — rečenica o izlaznim fakturama kaže da li ključ sme (ako ne sme, vlasniku prenosi tačnu poruku `SALES_FORBIDDEN`); pa „Preuzmi sa SEF-a“ na Prihodima i provera da su u sandučetu samo izdate, važeće fakture. Ručno: izvod sa prilivom kupca nudi „Nov predračun iz ove uplate“.
- [ ] **Step 5:** Commit u MCFlow-u (`feat(odobri): sales invoices never go to MCOdobri`), pa Predragu ispisane komande: `cd "C:\Users\Predrag PC\flowbase"; git push origin main` i `cd "C:\Users\Predrag PC\mcflow"; git push origin main` (prijava uređajnim kodom u Edge-u). Mintflow: ništa (van obima).
