# Knjižno odobrenje i knjižno zaduženje — plan izrade

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Vrsta dokumenta (Račun / Knjižno odobrenje / Knjižno zaduženje) na svakoj fakturi. Odobrenje i zaduženje se vezuju za račun istog partnera, preuzimaju njegovo knjiženje i menjaju obavezu po njemu. Nevezani dokumenti su jasno označeni i ne plaćaju se.

**Architecture:** U bazi `invoices.document_type` i `invoices.adjusts_invoice_id`. Trigger proverava vezu i upisuje kurs osnovnog računa, a `v_invoice_status` računa obavezu računa sa njegovim odobrenjima i zaduženjima. Čista logika je u `src/services/documentType.ts`. `InvoiceDialog` dobija izbor vrste i izbor osnovnog računa, Neplaćene fakture i Glavna knjiga prikazuju umanjenja, a SEF knjiženje predlaže vrstu i račun. Prvo FlowBase, pa merge u MCFlow, pa ručni prenos u Mintflow.

**Tech Stack:** React 18 + TypeScript (CRA, Jest + Testing Library), Supabase Postgres (plpgsql, view), psql preko poolera.

**Spec:** `docs/superpowers/specs/2026-10-19-knjizna-odobrenja-design.md`

## Global Constraints

- Vrste: `invoice` / `credit_note` / `debit_note`. Natpisi u FlowBase-u i MCFlow-u: „Račun“ / „Knjižno odobrenje“ / „Knjižno zaduženje“. U Mintflow-u: „Invoice“ / „Credit note“ / „Debit note“.
- Knjižno odobrenje ima iznos < 0, knjižno zaduženje iznos > 0. Za vrstu `invoice` se znak ne proverava (postojeći negativni računi postaju `credit_note` bez veze).
- Vezu ima samo `credit_note` ili `debit_note`. Osnovni račun je vrste `invoice`, nije obrisan, i ima istu firmu, partnera, valutu i tip (expense/revenue).
- Odobrenje po apsolutnoj vrednosti nije veće od ukupnog iznosa računa (iznos + zaduženja − druga odobrenja).
- Vezani dokument dobija kurs osnovnog računa (`exchange_rate`, `eur_rate`), a `amount_rsd` i `amount_eur` se računaju iz njega.
- Osnovni račun se ne može obrisati (`deleted_at`) dok na njega upućuje živ vezani dokument.
- Kontrola duplikata (20261020090000) poredi i `document_type`.
- `parent_invoice_id` se ne dira (koristi ga obračun zarada).
- Migracije prvo na `flowbase-demo`, sa SQL testom u transakciji koja se poništava.

## Review Focus

1. Račun umanjen odobrenjem nudi se za plaćanje u punom iznosu. Neplaćene fakture moraju koristiti umanjen iznos (test u Task 4).
2. Odobrenje ili zaduženje se samo pojavi u Neplaćenim fakturama ili u Halcom fajlu (Task 4).
3. Promena znaka iznosa posle ručnog izbora vrste vrati vrstu na podrazumevanu (Task 3).
4. Brisanje osnovnog računa ostavi odobrenje koje pokazuje na obrisan račun (SQL test, Task 1).
5. Izmena postojećeg računa (bez promene vrste) bude odbijena zbog novih provera (SQL test, Task 1).

---

### Task 1: Baza — vrsta, veza, pravila, `v_invoice_status`

**Files:**
- Create: `supabase/migrations/20261020100000_credit_and_debit_notes.sql`
- Create: `supabase/tests/credit_and_debit_notes_test.sql`

**Interfaces:**
- Produces, kolone: `invoices.document_type text not null default 'invoice'` (check u tri vrednosti), `invoices.adjusts_invoice_id uuid references invoices(id)`.
- Produces, `v_invoice_status` dodaje na kraj kolone `document_type`, `adjusts_invoice_id`, `adjustments` (zbir iznosa živih vezanih dokumenata, u valuti računa), `adjustments_rsd`, `adjustments_eur`, `unlinked boolean` (odobrenje/zaduženje bez veze). Za vrstu `invoice`: `calculated_status`, `remaining_*` i `amount_due*` računaju se sa iznosom + `adjustments`. Za vezani dokument `calculated_status = 'paid'`. Za nevezani dokument se status računa kao do sada.
- Produces, funkcija `invoice_number_key` se ne menja. Trigger duplikata poredi i `document_type`, a indeks dobija `document_type`.
- Produces, trigger `invoices_adjustment_rules` (before insert/update) i `invoices_keep_adjusted_base` (before update of deleted_at).

- [ ] **Step 1:** SQL test (fixtures: firma, dva partnera, RSD račun 120000 i EUR račun):
  1. Odobrenje −20000 vezano za račun: `v_invoice_status` računa: `calculated_status='partial'`, `remaining_rsd=100000`, `adjustments=-20000`; odobrenje: `calculated_status='paid'`.
  2. Zaduženje +5000 na isti račun: `remaining_rsd=105000`.
  3. Odobrenje −200000 (veće od računa): odbijeno.
  4. Odobrenje za račun drugog partnera ili druge valute: odbijeno. Odobrenje sa iznosom > 0: odbijeno. Zaduženje < 0: odbijeno.
  5. Odobrenje vezano za drugo odobrenje: odbijeno.
  6. Vezano odobrenje na EUR računu dobija `exchange_rate` i `eur_rate` računa, a `amount_rsd = round(amount*exchange_rate,2)`.
  7. Soft-delete osnovnog računa dok postoji živo odobrenje: odbijeno. Posle brisanja odobrenja: dozvoljeno.
  8. Odobrenje bez veze: dozvoljeno, `unlinked = true`, a status se računa kao do sada (ne „paid“).
  9. Odobrenje „5/26“ i račun „5/26“ istog dobavljača: oba dozvoljena. Dva odobrenja „5/26“: drugo odbijeno.
  10. Izmena napomene postojećeg računa ne pokreće nove provere (Review Focus 5). Račun sa 100% odobrenja: `calculated_status='paid'`.
  11. Backfill: račun vrste `invoice` sa negativnim iznosom pre migracije postaje `credit_note` bez veze (test ubacuje red pre `\i` migracije; na već migriranoj bazi deo se preskače).
- [ ] **Step 2:** test na demo bazi bez migracije → pada.
- [ ] **Step 3:** migracija: kolone, backfill (`amount < 0 → credit_note`), triggeri, novi trigger duplikata, `create or replace view v_invoice_status` (postojeća definicija iz `20261008180000_accrual_revenue.sql`, sa novim kolonama na kraju, `adjustments` kroz lateral podupit nad živim vezanim dokumentima), blok provera na kraju.
- [ ] **Step 4:** test sa migracijom → `ALL TESTS PASSED`. Zatim `db push` na demo bazu.
- [ ] **Step 5:** commit.

### Task 2: Servis `documentType.ts`

**Files:**
- Create: `src/services/documentType.ts`, `src/services/documentType.test.ts`

**Interfaces:**
- Produces:
  ```ts
  export type DocumentType = 'invoice' | 'credit_note' | 'debit_note'
  export const DOCUMENT_TYPE_LABEL: Record<DocumentType, string> // 'Račun' | 'Knjižno odobrenje' | 'Knjižno zaduženje'
  export function defaultDocumentType(amount: number | null): DocumentType // < 0 → credit_note, inače invoice
  export function signProblem(type: DocumentType, amount: number | null): string | null
  export interface AdjustableBill { id: string; invoice_number: string | null; invoice_date: string | null; amount: number; adjustments: number; paid_amount: number; currency: string | null }
  export function billTotal(b: AdjustableBill): number              // amount + adjustments
  export function creditProblem(amount: number, base: AdjustableBill): string | null // |credit| > billTotal → poruka
  export function scaleSplits<T extends { amount: number }>(lines: T[], baseAmount: number, newAmount: number): T[] // proporcionalno, zbir tačno = newAmount
  export function adjustmentSummary(amount: number, adjustments: number, currency: string): string // „knjižno odobrenje −20.000,00 RSD“ / „knjižno zaduženje +5.000,00 RSD“
  ```
- [ ] **Steps 1–5:** testovi (znak po vrsti, podrazumevana vrsta, odobrenje veće od računa, scaleSplits sa zaokruživanjem gde je poslednja linija razlika, sažetak) → padaju → implementacija → prolaze → commit.

### Task 3: Prozor za unos fakture

**Files:**
- Modify: `src/components/InvoiceDialog.tsx`
- Create: `src/components/InvoiceDialog.documentType.render.test.tsx`

**Interfaces:**
- Consumes: Task 2. Prop `creditNote` ostaje kao početna vrsta (`credit_note`).
- Produces: u zaglavlju `<select aria-label="Vrsta dokumenta">`. Za odobrenje ili zaduženje u koraku 1 se pojavljuje `<select aria-label="Odnosi se na račun">` sa računima istog partnera, tipa i valute (vrsta `invoice`, nisu obrisani), plus opcija „— nije vezano za račun —“. Čuvanje upisuje `document_type` i `adjusts_invoice_id`.
- [ ] **Step 1:** render testovi:
  - nova faktura je „Račun“; unos iznosa −100 prebacuje na „Knjižno odobrenje“; ručni izbor „Račun“ pa promena iznosa ne menja vrstu (Review Focus 3);
  - izbor osnovnog računa popunjava P&L kategoriju, sektor i projekat sa računa i učitava njegove `pl_splits` srazmerno iznosu;
  - „nije vezano“ prikazuje upozorenje „Nije vezano za račun — veže se kasnije“;
  - knjiženje šalje `document_type: 'credit_note'` i `adjusts_invoice_id`;
  - zaduženje sa negativnim iznosom daje grešku „Knjižno zaduženje mora imati pozitivan iznos“.
- [ ] **Steps 2–5:** padaju → implementacija → prolaze (i svi postojeći testovi InvoiceDialog-a) → commit.

### Task 4: Neplaćene fakture i Glavna knjiga

**Files:**
- Modify: `src/pages/Reports.tsx` (UnpaidInvoicesPanel), `src/pages/Transactions.tsx` (lista faktura)
- Test: `src/pages/UnpaidInvoicesPanel.render.test.tsx` (proširenje), `src/pages/Transactions.documentType.render.test.tsx`

**Interfaces:**
- Consumes: kolone view-a iz Task 1, `adjustmentSummary` i `billTotal` iz Task 2.
- [ ] **Step 1:** testovi:
  - panel ne prikazuje dokumente vrste `credit_note`/`debit_note`;
  - račun 120000 sa `adjustments −20000` nudi „Plaća se 100000,00“ i ispod iznosa piše „knjižno odobrenje −20.000,00 RSD“ (Review Focus 1);
  - upozorenje „1 knjižno odobrenje nije vezano za račun“ kad view vrati nevezan dokument (Review Focus 2);
  - u Glavnoj knjizi red odobrenja ima oznaku „Knjižno odobrenje“ i, bez veze, „nije vezano“.
- [ ] **Steps 2–5:** padaju → implementacija (panel čita `document_type`, `adjustments`, `unlinked` iz `v_invoice_status`; `outstanding_own` računa sa `amount + adjustments`) → prolaze → commit.

### Task 5: SEF

**Files:**
- Modify: `src/services/sef/ublInvoice.ts` (+ test), `src/services/sef/draftFromUbl.ts` (+ test), `src/components/SefInboxDialog.tsx`

**Interfaces:**
- Produces: `ParsedUbl.billingReference: string | null` (`cac:BillingReference/cac:InvoiceDocumentReference/cbc:ID`), `ParsedUbl.isDebitNote` (tip 383). `draftFromUbl` vraća `documentType` i `billingReference`. SEF knjiženje otvara `InvoiceDialog` sa tom vrstom i predlaže osnovni račun istog partnera čiji je `invoice_number_key` jednak ključu reference.
- [ ] **Steps 1–5:** testovi sa XML fragmentima (381 sa referencom, 383, bez reference) → padaju → implementacija → prolaze → commit.

### Task 6: MCFlow, podaci i Mintflow

- [ ] Ceo FlowBase paket, `tsc`, eslint; merge u MCFlow; SQL test na MCFlow bazi (rollback), pa `db push`.
- [ ] Četiri odobrenja iz početnog stanja: korisnik određuje osnovne račune, uvoz kao `credit_note` sa `pl_impact=false` i oznakom početnog stanja.
- [ ] Mintflow: ručni prenos na engleskom (migracija sa Mintflow pravilima pristupa, InvoiceDialog, panel, SEF), testovi iz kopije u scratchpad-u, komande za korisnika.
