# Povraćaj umanjuje trošak — plan izrade

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Povraćaj dobavljača proknjižen kao trošak čuva se sa minusom i svaki ekran sabira troškove sa znakom, pa trošak 1.784,40 i povraćaj 1.199,22 daju 585,18.

**Architecture:** Bez izmene baze. Čitači koji uzimaju `Math.abs` reda troška prelaze na iznos sa znakom; kod grafikona koji je pretpostavljao nenegativne iznose ne crta ništa na nuli ili ispod nje. Tri mesta na kojima se knjiži stavka izvoda (uvoz, ručni unos, pojedinačna transakcija) uče jedno pravilo iz jednog novog čistog modula `src/services/refund.ts`: novac koji je stigao, proknjižen kao direktan trošak, čuva se negativan u `amount`, `amount_rsd` i `amount_eur`. Korisnik uvek kuca veličinu.

**Tech Stack:** CRA, React + TypeScript, Jest + Testing Library. Supabase klijent je u testovima lažan.

**Spec:** `docs/superpowers/specs/2026-11-18-povracaj-umanjuje-trosak-design.md` (odluke D1–D12).

## Global Constraints

- Ništa ne dira živu bazu, funkciju ni mrežu. Nema `supabase` CLI-ja. **Ništa pod `supabase/` se ne menja.** Nema migracije.
- Nikad `git push` (push radi Predrag sam). Nikad `git add -A`, nikad `git checkout --`: `git add -- <fajlovi>` tačno fajlova tog taska. Poruka commita se završava praznim redom i `Co-Authored-By: Claude Fable 5.2 <noreply@anthropic.com>`.
- Rečenice na ekranu su tačno ove i svaku drži test:
  - `Povraćaj`
  - `Povraćaj: novac je vraćen, pa ova stavka umanjuje trošak umesto da ga uvećava.`
  - `Ovo je povraćaj`
  - `Dobavljač je vratio novac. Iznos se knjiži sa minusom i umanjuje trošak pod kojim je zaveden.`
  - `Povraćaj se knjiži kao jednokratan — ne ulazi u procene narednih meseci.`
- Povraćaj je `type = 'direct'`, `tx_subtype = 'expense'`, `amount < 0`, `amount_rsd < 0`, `amount_eur < 0`. `exchange_rate` i `eur_rate` nikad nisu negativni. Avans (`is_advance`) nikad nije povraćaj.
- Korisnik kuca veličinu. Nijedno polje ne traži niti prikazuje ukucan minus za povraćaj.
- Pretraga i poređenje po iznosu ostaju na veličini (`entryGroups.matchesAmount`, `amountSearch.ts`): ne menjaju se.
- Već sa znakom i NE diraju se: `homeLedgerFigures.ts`, zbir u `Reports.tsx`, `budgetTree.ts`, `budgetForecast.ts`, zbir u `BudgetDrillModal.tsx`, zbir u `Transactions.tsx`, `partnerCard.ts`, `projects.ts`.
- Reč `Refund.` (refundacija, tip novčanog toka `reimbursable`) ostaje kakva jeste i ne koristi se za povraćaj.
- Interfejs: srpski, latinica, ekavica; oznake počinju velikim slovom; iznosi kroz `utils/formatters` (`fmtMoney`, `format` čuvaju minus). Komentari u kodu ostaju na engleskom.
- Nijedan fajl u `src/` i `public/` ne pominje klijenta; testovi koriste samo izmišljene firme i ljude.
- U naslovima Jest testova nema apostrofa.
- Ništa se ne saopštava samo bojom; svaka kontrola ima pristupačno ime.
- Komentar koji kaže da knjiga „knjiži troškove negde pozitivno a negde negativno“ nije tačan i ispravlja se tamo gde se kod pored njega menja.
- Na kraju svakog taska: ciljani testovi prolaze, `npx tsc --noEmit -p .` prolazi i ceo skup prolazi: `CI=true npx react-scripts test --watchAll=false --no-cache`. „Pao skup“ bez ijednog palog testa je greška keša; `--no-cache` daje pravi broj. Izlaz testova je čist (bez novih upozorenja).
- Bash heredoc sa apostrofom ili obrnutim navodnikom ovde ne radi: skripta se piše u fajl alatom Write, pa se pokreće fajl.
- Komande se pokreću iz `C:\Users\Predrag PC\flowbase`.
- Uzor je ista izmena u Mintflow-u (drugi repo, bez zajedničke istorije): prenosi se smisao, ne tekst. Tamošnji kod je u dolarima i na engleskom.

## Review Focus

1. **Tri iznosa idu zajedno.** Povraćaj sa pozitivnim `amount_rsd` ili `amount_eur` uz negativan `amount` (ili obrnuto) daje različit zbir u RSD i u EUR prikazu. Drže testovi u taskovima 6, 7 i 8, u obe valute prikaza gde ekran to dozvoljava.
2. **Povraćaj podeljen na više P&L stavki.** Stavke se kucaju pozitivne, čuvaju negativne; roditelj podele nosi negativan `amount`, `amount_rsd`, `amount_eur` (poslednja stavka je ostatak, pa bez toga zbir ne izlazi). Taskovi 6 i 8.
3. **Postojeći storno iz zarada otvoren i sačuvan bez izmene** vraća se u bazu isti (taskovi 7 i 8).
4. **Kategorija koja u mesecu padne ispod nule**: tabela pokazuje minus; nijedan grafikon ne dobija negativnu širinu, NaN ni udeo preko 100% (task 2), a vremenska linija novčanog toka ne ispisuje `−-…` (task 3).
5. **Ručni unos izvoda nad sačuvanim povraćajem**: ponovo otvoren izvod ne javlja „Stavke bez datuma ili iznosa“ i ne pretvara povraćaj u prihod (task 7).

---

### Task 1: Zbirovi troškova su neto

**Files:**
- Modify: `src/services/expenseTree.ts` (`contributionsFor` ~187-193, `contributesTo` ~198)
- Modify: `src/services/entryGroups.ts` (`groupByMonth` ~113-122 i komentar)
- Modify: `src/services/cfoMetrics.ts` (~91, `monthlyTrend`)
- Test: `src/services/expenseTree.test.ts`, `src/services/entryGroups.test.ts`, `src/services/cfoMetrics.test.ts`

**Interfaces:**
- Produces: `contributionsFor(e, branch, currency)` čiji `amount` nosi znak reda; `contributesTo` tačno za doprinos različit od nule; `groupByMonth(rows, currency)[i].total` sa znakom. Task 2 računa da `TreeNode.amount` i `monthly[m]` mogu biti nula ili negativni.

- [ ] **Step 1: Testovi po novom pravilu**
  - `expenseTree.test.ts` `ignores zero amounts and treats negatives as magnitude` (~163) postaje `ignores zero amounts and takes a negative off`: redovi 100 i −40 na istoj putanji daju `60`; red `0` ne dodaje ni čvor ni broj.
  - `shows an expense as a cost whichever sign it was stored with` (~357) postaje `a refund on a project reduces that project`: red −800 na projektu `Zgrada A` daje `{ 'Zgrada A': -800 }`.
  - `totals the same on all three branches` (~372): red `-120` ostaje; očekivani zbir postaje `2210` na sve tri grane (bio je `2450`).
  - Novi `a charge and its refund under one subcategory come to the difference`: 1784.40 i −1199.22 pod istom kategorijom i potkategorijom → čvor `toBeCloseTo(585.18, 2)`, `count` 2, `contributesTo` tačno za oba; isto u EUR prikazu sa `amount_eur`.
  - Novi: 100 i −100 pod istom potkategorijom daju čvor koji POSTOJI sa iznosom 0 i `count` 2.
  - `entryGroups.test.ts` `totals magnitudes, the same arithmetic the tree above it uses` (~97) postaje `totals with the sign, the same arithmetic the tree above it uses`: 300 i −100 → `200`. `compares on the absolute value, so a stored sign cannot hide a row` (~223) se ne menja.
  - `cfoMetrics.test.ts` `takes an expense at its size whichever sign it arrives with` (~24) postaje `takes a refund off the month it lands in`: 1000 i −900 u istom mesecu → `expenses` 100.
- [ ] **Step 2: Pokreni, vidi da padaju sa starim veličinama**
- [ ] **Step 3: Ukloni `Math.abs` iz `contributionsFor`; `contributesTo` proverava `c.amount !== 0`; `groupByMonth` sabira `amountOf(r, currency)`; `monthlyTrend` dodaje iznos sa znakom.** Komentari pored izmenjenog koda kažu šta je sada tačno. Sortiranje po veličini i `matchesAmount` se ne diraju.
- [ ] **Step 4: Ciljani testovi, `npx tsc --noEmit -p .`, ceo skup.** Svaki drugi test koji je držao veličinu navodi se u izveštaju sa starom i novom vrednošću pre izmene.
- [ ] **Step 5: Commit**

```bash
git add -- src/services/expenseTree.ts src/services/expenseTree.test.ts src/services/entryGroups.ts src/services/entryGroups.test.ts src/services/cfoMetrics.ts src/services/cfoMetrics.test.ts
git commit -m "fix(troskovi): zbir troskova je neto, pa ga povracaj umanjuje"
```

---

### Task 2: Iznos na nuli ili ispod nje je u tabeli, a ne na slici

**Files:**
- Modify: `src/services/branchTree.ts` (~90, 115-116, 121, 128, 148-149, 166, 185, 208)
- Modify: `src/components/ExpenseBranches.tsx` (~157, 212)
- Modify: `src/services/expenseCharts.ts` (~44, 61, 148-150, 421-442, 476-502, 555)
- Modify: `src/services/expenseTree.ts` (`paretoCut` ~361-384; `deltaPct` ~308 samo ako treba)
- Modify: `src/components/ExpenseVisuals.tsx` (~65-68, ~444)
- Modify: `src/pages/Dashboard.tsx` (krofna ~202-224, ulaz ~384)
- Test: `branchTree.test.ts`, `expenseCharts.test.ts`, `expenseTree.test.ts`, `ExpenseBranches.render.test.tsx`, `Dashboard.render.test.tsx`; novi test za `ExpenseVisuals` ako ga nema

**Interfaces:**
- Consumes: znak iz Taska 1.
- Pravilo (D6): čvor, mesec ili ćelija sa iznosom `<= 0` se ne crta; udeo je iznos kroz zbir pozitivnih iznosa; nijedna širina, visina, ugao ili procenat nije negativan, `NaN` ni preko 100.

- [ ] **Step 1: Testovi koji padaju** — po jedan za svaku funkciju, sa jednim pozitivnim čvorom (`900`), jednim neto negativnim (`-200`) i jednim na nuli:
  - `branchTree`: nema veze ni stuba za negativan i nulti čvor; svaka `width` je `> 0` i konačna; udeo pozitivnog je `100`.
  - `ExpenseBranches` (render): udeo pozitivnog čvora je `100%`; negativan se ne crta; nijedan SVG atribut (`width`, `height`, `d`) nije negativan ni `NaN`.
  - `paretoSeries` / `paretoCut`: negativan list se izostavlja; kumulativ završava na `100` i ne opada.
  - toplotna mapa: negativna ćelija je „ništa“ (`-1`), a maksimum skale je ne računa.
  - stubići (`ExpenseVisuals` ~444): negativna traka nema `rect`; maksimum ose je najveći pozitivan zbir.
  - `branchRoots` (~555): ostaje `n.amount > 0`, sada pod testom.
  - krofna na Kontrolnoj tabli: kategorija sa neto `<= 0` nema isečak, ostali isečci zajedno čine 360°, a legenda je i dalje navodi sa minusom.
  - tabela stabla na P&L analizi i dalje prikazuje negativan čvor, sa minusom.
- [ ] **Step 2: Pokreni, vidi da padaju**
- [ ] **Step 3: Primeni pravilo na svakom mestu.** `branchTree.amountOf` postaje `Math.max(0, Number(n.amount) || 0)` i širina veze koristi isti iznos; imenioci u `ExpenseBranches` sabiraju taj iznos; `paretoSeries` i `paretoCut` zadržavaju listove sa `amount > 0`; skale uzimaju maksimum pozitivnih; traka ili isečak se crta samo za iznos `> 0`. Pored navedenih mesta pretraži kod grafikona za deljenje zbirom, `Math.max` i filter `> 0` nad iznosima stabla i u izveštaju navedi svako provereno mesto.
- [ ] **Step 4: Ciljani testovi, `npx tsc --noEmit -p .`, ceo skup**
- [ ] **Step 5: Commit**

```bash
git add -- src/services/branchTree.ts src/components/ExpenseBranches.tsx src/services/expenseCharts.ts src/services/expenseTree.ts src/components/ExpenseVisuals.tsx src/pages/Dashboard.tsx
git commit -m "fix(troskovi): iznos na nuli ili ispod nje je u tabeli, a ne na slici"
```
(dodaj u pathspec svaki test fajl koji je menjan)

---

### Task 3: Na novčanom toku povraćaj smanjuje odliv, a na kartici partnera je novac koji je stigao

**Files:**
- Modify: `src/services/cashTimeline.ts` (`cashMovement` ~291-303 i komentar; `cashTimeline()` ~162-163)
- Modify: `src/components/CashFlowTimeline.tsx` (~95, 192, 239, 246)
- Modify: `src/services/loadPartnerCard.ts` (~94-97)
- Pročitaj, menjaj samo ako negativan odliv nešto kvari: `src/services/loadCashTimeline.ts` (~180, 336), `src/pages/CashFlow.tsx` (~399, 402)
- Test: `src/services/cashTimeline.test.ts`, `src/services/loadPartnerCard.test.ts`, render test `CashFlowTimeline` (napravi ako ga nema)

**Interfaces:**
- Produces: `cashMovement(tx, currency)` vraća `{ inflow: 0, outflow: -x }` za direktan trošak čiji je iznos u valuti prikaza `-x`; svi ostali slučajevi kao danas.

- [ ] **Step 1: Testovi**
  - `cashTimeline.test.ts` `takes an amount at its size whichever sign it arrives with` (~234) postaje `a refund makes the outflow smaller`: direktan trošak −500 → `{ inflow: 0, outflow: -500 }`; mesec sa troškom 1784.40 i povraćajem −1199.22 ima odliv `585.18` i priliv `0`. Plaćanje fakture od −500 je i dalje odliv `500` (nepromenjeno, pod testom).
  - mesec čiji stvarni odliv ispadne negativan: `cashTimeline()` ne daje negativan „preostali plan“, a `CashFlowTimeline` ne ispisuje `−-…` niti crta stub minimalne visine za njega — ispisuje iznos sa jednim znakom i ne crta ništa.
  - `loadPartnerCard.test.ts` `in euros, reads every amount from the euro columns` (~55-67): nepovezan direktan trošak `-2344 / -20` je i dalje `20`, ali sa `direction: 'in'`; pozitivan je `'out'`; direktan prihod `'in'`.
- [ ] **Step 2: Pokreni, vidi da padaju. Step 3: Izmeni.** U `cashMovement` veličina ostaje za sve osim direktnog troška, koji koristi iznos sa znakom. Ispravi netačan komentar (~291-293).
- [ ] **Step 4: Proveri svakog potrošača `cashMovement`** na pretpostavku da je odliv jednog kretanja `>= 0` i u izveštaju navedi šta je provereno.
- [ ] **Step 5: Ciljani testovi, `npx tsc --noEmit -p .`, ceo skup. Commit**

```bash
git add -- src/services/cashTimeline.ts src/services/cashTimeline.test.ts src/components/CashFlowTimeline.tsx src/services/loadPartnerCard.ts src/services/loadPartnerCard.test.ts
git commit -m "fix(novcani-tok): povracaj smanjuje odliv, a na kartici partnera je novac koji je stigao"
```
(dodaj u pathspec svaki drugi menjan fajl)

---

### Task 4: Pravilo povraćaja u jednom modulu, i povraćaj se vidi

**Files:**
- Create: `src/services/refund.ts`, `src/services/refund.test.ts`
- Modify: `src/components/EntriesModal.tsx` (upiti ~114-118, oznake ~140-150, `EntryRow` ~245-286)
- Modify: `src/pages/Transactions.tsx` (red transakcije ~874-882)
- Modify: `src/pages/Budgeting.tsx` (~1099, 1121, 1163, 1221-1222, 1232-1233, 1242)
- Modify: `docs/recnik.md` (nova stavka)
- Test: `src/components/EntriesModal.test.tsx`, `src/pages/Budgeting.test.tsx`, novi render test reda Glavne knjige ako ga je moguće napraviti na postojećim lažnjacima

**Interfaces:**
- Produces (`src/services/refund.ts`), koriste taskovi 5–8:

```ts
/** A statement line as the importers hold it: two magnitudes, at most one of them filled. */
export interface BankLine { debit: number | null; credit: number | null }

export const REFUND_TAG = 'Povraćaj'
export const REFUND_LINE_NOTE =
  'Povraćaj: novac je vraćen, pa ova stavka umanjuje trošak umesto da ga uvećava.'
export const REFUND_SWITCH = 'Ovo je povraćaj'
export const REFUND_SWITCH_NOTE =
  'Dobavljač je vratio novac. Iznos se knjiži sa minusom i umanjuje trošak pod kojim je zaveden.'
export const REFUND_ONE_TIME_NOTE =
  'Povraćaj se knjiži kao jednokratan — ne ulazi u procene narednih meseci.'

/** Money came IN and it is booked as a direct expense. */
export function isRefundLine(line: BankLine, txType: string | null | undefined, subtype: string | null | undefined): boolean
/** -1 for a refund line, 1 for everything else. */
export function bookedSign(line: BankLine, txType: string | null | undefined, subtype: string | null | undefined): 1 | -1
/** A typed magnitude as it is stored: null stays null, 0 stays 0, never -0. */
export function booked(value: number | null | undefined, sign: 1 | -1): number | null
/** The three book figures of a row, signed together; the two rates are left alone. */
export function bookedAmounts<T extends { amount_rsd: number | null; amount_eur: number | null }>(book: T, sign: 1 | -1): T
/** A stored row that is a refund: a direct expense transaction with a minus. */
export function isRefundRow(row: {
  type?: string | null; tx_subtype?: string | null
  amount?: number | null; amount_rsd?: number | null
}): boolean
/** What is written for the cash-flow fields of a refund (spec D2). */
export const REFUND_CASH_FLOW: {
  cf_type: 'one_time'; cf_frequency: null; cf_next_month_est: null
  cf_accrual_from: null; cf_accrual_to: null; cf_capex_months: null; cf_reimbursable_date: null
}
```

- [ ] **Step 1: `refund.test.ts`** — `isRefundLine({debit:null, credit:1199.22}, 'direct', 'expense')` je `true`; `false` za: isplatu; podtip `revenue`; tip `invoice_payment`, `credit_payment`, `passthrough`; `credit: 0`; negativan `credit`; obe kolone popunjene. `bookedSign` je `-1` tačno tamo. `booked(1199.22, -1) === -1199.22`; `booked(null, -1) === null`; `Object.is(booked(0, -1), 0)`. `bookedAmounts({ exchange_rate: 117.2, eur_rate: 117.2, amount_rsd: 1000, amount_eur: 8.53 }, -1)` daje `amount_rsd: -1000`, `amount_eur: -8.53` i iste kurseve; sa `1` vraća iste vrednosti. `isRefundRow`: direktan trošak sa minusom `true`; samo `amount_rsd` negativan `true`; pozitivan `false`; prihod `false`; `invoice_payment` `false`; bez `type` a `tx_subtype 'expense'` sa minusom `true`. Svaka konstanta je rečenica iz Global Constraints.
- [ ] **Step 2: Padaju, napiši `refund.ts`, prolaze**
- [ ] **Step 3: Prikaz, prvo testovi**
  - `EntryRow`: upit transakcija dobija `type, tx_subtype`; stavka-transakcija sa negativnim iznosom ispisuje minus (kao i danas), zelenom (`#00D47E`) umesto crvene (`#FF5B5A`) i nosi oznaku `Povraćaj`; pozitivna je nepromenjena; stavka-faktura sa negativnim iznosom (knjižno odobrenje) nema oznaku `Povraćaj`; postojeća oznaka `Refund.` za `reimbursable` je nepromenjena.
  - Glavna knjiga: red negativnog direktnog troška nosi oznaku `Povraćaj` pored tipa.
  - Budžet: ćelija čiji je `actual` `-200` prikazuje iznos sa znakom (kako ga `fmtFigure` ispisuje) i otvara pregled stavki kao svaka druga; `0` i dalje daje crtu.
  - `docs/recnik.md`: red `| Refund (money back from a supplier) | Povraćaj |` uz red `Reimbursable`.
- [ ] **Step 4: Ciljani testovi, `npx tsc --noEmit -p .`, ceo skup. Commit**

```bash
git add -- src/services/refund.ts src/services/refund.test.ts src/components/EntriesModal.tsx src/components/EntriesModal.test.tsx src/pages/Transactions.tsx src/pages/Budgeting.tsx docs/recnik.md
git commit -m "feat(povracaj): pravilo u jednom modulu, i povracaj se vidi sa minusom i oznakom"
```
(dodaj u pathspec svaki test fajl koji je menjan)

---

### Task 5: Povraćaj se nikad ne nudi kao plaćanje fakture

**Files:**
- Modify: `src/components/InvoiceDialog.tsx` (lista ~775-783, pretraga ~956-963, ~896, ~971)
- Modify: `src/services/multiLink.ts` (~48, 54)
- Modify: `src/components/ReconcilePanel.tsx` (~145-153)
- Test: `src/components/InvoiceDialog.multiLink.render.test.tsx`, `src/services/multiLink.test.ts`, test za `ReconcilePanel` (napravi ako ga nema)

**Interfaces:** Consumes `isRefundRow` iz `src/services/refund.ts`.

- [ ] **Step 1: Testovi** — u svakoj listi kandidata direktan trošak `-1199.22` pored `1199.22`: nudi se samo pozitivan. Fiksatura `InvoiceDialog.multiLink.render.test.tsx:61-64` pravi bankarske provizije kao negativne iznose: promeni ih u pozitivne (u knjizi nema negativnog plaćanja) i zadrži ono što taj test dokazuje.
- [ ] **Step 2: Padaju; filtriraj sa `isRefundRow` tamo gde se lista pravi; prolaze.** `autoMatch` i `AutoMatchPanel` rade samo nad prolaznim stavkama — proveri i navedi u izveštaju, bez izmene.
- [ ] **Step 3: Ciljani testovi, `npx tsc --noEmit -p .`, ceo skup. Commit**

```bash
git add -- src/components/InvoiceDialog.tsx src/services/multiLink.ts src/components/ReconcilePanel.tsx
git commit -m "fix(povracaj): povracaj se nikad ne nudi kao placanje fakture"
```
(dodaj u pathspec svaki test fajl koji je menjan)

---

### Task 6: Uvoz izvoda knjiži povraćaj sa minusom

**Files:**
- Modify: `src/components/BulkImport.tsx` — knjiženje (~1195-1272: `amount`, `bookFor` ~1132-1141, `receiptShape` ~1241-1248, insert ~1249-1257, podela ~1231-1233 i ~1270-1272), red u pregledu (~1940-1941, izbor podtipa ~2229, roditelj podele ~2452-2458, dugmad novčanog toka ~2616)
- Test: novi `src/components/BulkImport.refund.render.test.tsx` po uzoru na `BulkImport.recognition.render.test.tsx`, sa beleženjem upisa po uzoru na `InvoiceDialog.multiLink.render.test.tsx:8-46` (`mockState.writes`)

**Interfaces:** Consumes `isRefundLine`, `bookedSign`, `booked`, `bookedAmounts`, `REFUND_TAG`, `REFUND_LINE_NOTE`, `REFUND_ONE_TIME_NOTE`, `REFUND_CASH_FLOW`.

**Ponašanje (D1, D2, D8, D11):**
- Red je povraćaj kada `isRefundLine({debit: p.debit, credit: p.credit}, row.override_tx_type, row.override_tx_subtype)` i nije avans.
- U pregledu red povraćaja ima oznaku `Povraćaj`, iznos sa minusom u zelenoj kojom se pišu uplate, i — gde je otvoren deo za direktan trošak — rečenicu `REFUND_LINE_NOTE`. Dugmad tipa novčanog toka zamenjuje `REFUND_ONE_TIME_NOTE`.
- Deo za direktan trošak (kategorija, sektor, projekat, podela na stavke) nudi se za povraćaj isto kao za trošak; sve što se u njemu kuca je veličina.
- Pri knjiženju, sa `sign = bookedSign(...)`: `bookFor` se pita veličinom; `amount` ide kroz `booked`, `...rowBook` kroz `bookedAmounts`; `whySplitNotSavable` i `saveSplits` dobijaju roditelja sa znakom (`amount`, `amount_rsd`, `amount_eur`) i stavke čiji je `amount` `booked(line.amount, sign)`; polja novčanog toka su `REFUND_CASH_FLOW` za povraćaj, a inače kao danas. `tx_subtype` ostaje `'expense'`, `pl_impact` `true`. `import_hash`, `project_id`, kursevi i sve o `passthrough`, `invoice_payment`, `credit_payment` i avansima ostaje kao danas.
- Isplata proknjižena kao trošak, uplata kao prihod i uplata bilo kog tipa osim `direct` upisuju se tačno kao danas (pod testom).

- [ ] **Step 1: Render testovi koji padaju** (izmišljeni partneri)
  1. Uplata `1199.22` ostavljena kao „Prihod“ knjiži `tx_subtype: 'revenue'`, `amount: 1199.22` — nepromenjeno.
  2. Ista sa podtipom „Trošak“: red ima `Povraćaj`; vide se obe rečenice i nema dugmadi novčanog toka; insert ima `tx_subtype: 'expense'`, `amount: -1199.22`, negativne `amount_rsd` i `amount_eur`, pozitivne `exchange_rate` i `eur_rate`, `cf_type: 'one_time'`, `cf_frequency: null`, `cf_next_month_est: null`, `pl_impact: true`, sa izabranom kategorijom, sektorom i projektom.
  3. Review Focus 2: povraćaj sa dve stavke podele ukucane `1000` i `199.22` upisuje `pl_splits` sa `-1000` i `-199.22`.
  4. Isplata `1784.40` kao trošak knjiži `amount: 1784.40` i izabrani tip novčanog toka — nepromenjeno.
  5. Review Focus 1: uplata u EUR kao „Trošak“: `amount`, `amount_rsd`, `amount_eur` negativni, oba kursa pozitivna.
- [ ] **Step 2: Padaju. Step 3: Izmeni** — jedan `sign` po redu pri knjiženju i jedan `isRefund` po redu u pregledu; pravilo se ne prepisuje.
- [ ] **Step 4: Ciljani testovi, `BulkImport.recognition.render.test.tsx`, `npx tsc --noEmit -p .`, ceo skup**
- [ ] **Step 5: Commit**

```bash
git add -- src/components/BulkImport.tsx src/components/BulkImport.refund.render.test.tsx
git commit -m "feat(uvoz): novac koji je vracen, proknjizen kao trosak, je povracaj i cuva se sa minusom"
```

---

### Task 7: Ručni unos izvoda knjiži povraćaj, ponovo ga otvara i više ne pretpostavlja trošak za uplatu

**Files:**
- Modify: `src/services/statementEdit.ts` (`txToSeed` ~81-98; `rowAmount` ~237-241 ostaje)
- Modify: `src/components/BankStatementDialog.tsx` — podrazumevani red (~160), ispravnost (~719, ~1429-1430, ~1882), `shapeOf` (~941), knjiženje (~1026-1088), čuvanje izmene (~1500, ~1536-1553), polja isplate i uplate (~1971), kartice podtipa (~2304-2312), dugmad novčanog toka (~2429-2473)
- Test: `src/services/statementEdit.test.ts`, novi `src/components/BankStatementDialog.refund.render.test.tsx` (ekran nema nijedan test: napravi lažnjake po uzoru na `InvoiceDialog.*.render.test.tsx`, sa beleženjem upisa)

**Interfaces:** Consumes izvoz iz `refund.ts`. Produces: red mreže dobija `subtype_chosen: boolean` (netačno na novom redu, tačno na redu iz baze i posle klika na karticu).

**Ponašanje (D1–D4, D8):**
- D3: na redu sa `subtype_chosen === false` iznos ukucan u uplatu postavlja `tx_subtype: 'revenue'`, a u isplatu `'expense'`. Klik na karticu postavlja podtip i `subtype_chosen: true`; kucanje posle toga ga ne menja.
- Red je povraćaj kada `isRefundLine({debit, credit}, row.tx_type, row.tx_subtype)` i nije avans. Ima `Povraćaj` i `REFUND_LINE_NOTE`; izbor novčanog toka zamenjuje `REFUND_ONE_TIME_NOTE`.
- Knjiženje i čuvanje izmene upisuju povraćaj po pravilu iz Taska 6.
- D4: `txToSeed` sačuvanog troška sa negativnim `amount` daje `debit: ''`, `credit: '<veličina>'`, `tx_subtype: 'expense'`. Pozitivan trošak i prihod kao danas.
- Sačuvan povraćaj ponovo otvoren je ispravan red (Review Focus 5).

- [ ] **Step 1: Testovi koji padaju**
  - `statementEdit.test.ts`: `txToSeed({ tx_subtype:'expense', amount:-1199.22, … })` → `debit ''`, `credit '1199.22'`, `tx_subtype 'expense'`; pozitivan trošak i prihod nepromenjeni; testovi `rowAmount` nepromenjeni.
  - Render: nov red, `300` u uplatu, ništa kliknuto → knjiži `tx_subtype: 'revenue'`, `amount: 300`. Nov red, `300` u isplatu → `expense`, `300`.
  - Render: nov red, `1199.22` u uplatu, kliknuta kartica „Trošak“ → vide se `Povraćaj` i obe rečenice; insert ima `amount: -1199.22`, negativne `amount_rsd` i `amount_eur`, `cf_type: 'one_time'`. Kartica kliknuta PRE kucanja daje isto.
  - Render, Review Focus 5 i 3: izvod otvoren za izmenu sa sačuvanim povraćajem (`amount -1199.22`) i sačuvanim stornom iz zarada (`amount -50`, napomena `Storno: izmišljena obustava`) prikazuje oba u koloni uplate kao veličine, ne javlja „Stavke bez datuma ili iznosa“, a čuvanje bez izmene vraća svaki sa istim negativnim `amount`, `amount_rsd`, `amount_eur` i `tx_subtype: 'expense'`.
- [ ] **Step 2: Padaju. Step 3: Izmeni. Step 4: Ciljani testovi, `npx tsc --noEmit -p .`, ceo skup**
- [ ] **Step 5: Commit**

```bash
git add -- src/services/statementEdit.ts src/services/statementEdit.test.ts src/components/BankStatementDialog.tsx src/components/BankStatementDialog.refund.render.test.tsx
git commit -m "feat(izvod): rucni unos knjizi povracaj, ponovo ga otvara, a uplata vise nije trosak sama od sebe"
```

---

### Task 8: Transakcija ima „Ovo je povraćaj“

**Files:**
- Modify: `src/components/TransactionDialog.tsx` — `book` (~308-317) i `paymentRow` (~322-328), provera (~408-409, ~953-956), učitavanje (~542), upis (~998-1025) i podela (~1262-1266), izbor podtipa (~2172-2173), dugmad novčanog toka (~1517-1521), pregled (~2408)
- Test: novi `src/components/TransactionDialog.refund.render.test.tsx` (ekran nema nijedan test: lažnjaci po uzoru na `InvoiceDialog.*.render.test.tsx`, sa beleženjem upisa)

**Interfaces:** Consumes `REFUND_SWITCH`, `REFUND_SWITCH_NOTE`, `REFUND_ONE_TIME_NOTE`, `REFUND_CASH_FLOW`, `booked`, `bookedAmounts`, `isRefundRow`.

**Ponašanje (D1, D2, D4, D8):**
- Polje za potvrdu `Ovo je povraćaj`, sa `REFUND_SWITCH_NOTE` ispod, prikazuje se kada je tip `direct` a podtip `expense`, i samo tada. Izbor prihoda ili drugog tipa ga gasi. Ne nudi se dok je transakcija vezana za fakturu, ni za avans.
- Sa njim: polje iznosa i dalje prima pozitivan iznos i `Iznos mora biti veći od 0` važi za ukucano; `book` i dalje računa sa veličinom; izbor novčanog toka zamenjuje `REFUND_ONE_TIME_NOTE`; pregled imenuje tip kao `Direktna (trošak) · Povraćaj`.
- Upis sa njim: `amount` kroz `booked(value, -1)`, knjižni iznosi kroz `bookedAmounts(..., -1)`, svaka stavka podele negativna uz roditelja sa znakom; polja novčanog toka `REFUND_CASH_FLOW`. Bez njega upis je tačno kao danas.
- Učitavanje: red za koji je `isRefundRow` tačno otvara se sa uključenim prekidačem, veličinom u polju iznosa i stavkama podele kao veličinama.
- Review Focus 3: storno iz zarada (`direct`, `expense`, `amount -50`) otvara se sa uključenim prekidačem i, sačuvan bez izmene, upisuje `amount: -50` i iste `amount_rsd` i `amount_eur` sa kojima je pročitan.

- [ ] **Step 1: Render testovi koji padaju**
  1. Nov direktan trošak `1199.22` RSD, prekidač uključen, izabrani kategorija i sektor → insert ima `tx_subtype: 'expense'`, `amount: -1199.22`, `amount_rsd: -1199.22`, negativan `amount_eur`, pozitivne kurseve, `cf_type: 'one_time'`, `cf_frequency: null`, `cf_next_month_est: null`; obe rečenice su bile na ekranu, dugmad novčanog toka nisu.
  2. Prekidač isključen → `amount: 1199.22` i izabrani tip novčanog toka, kao danas.
  3. Iznos `0` ili prazan sa uključenim prekidačem → `Iznos mora biti veći od 0`, ništa nije upisano.
  4. Review Focus 2: dve stavke podele `1000` / `199.22` → `pl_splits` redovi `-1000` / `-199.22`.
  5. Izmena sačuvanog povraćaja: otvara se sa uključenim prekidačem i `1199.22` u polju; isključivanje i čuvanje upisuje `amount: 1199.22`; uključivanje na sačuvanom pozitivnom trošku upisuje minus (tako se ispravljaju već proknjiženi redovi — D12).
  6. Review Focus 3, kako je gore navedeno.
  7. Podtip promenjen u prihod dok je prekidač uključen → prekidača nema i upis je običan prihod sa pozitivnim iznosom.
  8. Review Focus 1: povraćaj u EUR → sva tri iznosa negativna, oba kursa pozitivna.
- [ ] **Step 2: Padaju. Step 3: Izmeni** — jedno stanje `isRefund`; veličina ostaje ono sa čim svaka postojeća provera i pregled računaju; znak se stavlja tamo gde se red upisuje i skida tamo gde se čita.
- [ ] **Step 4: Ciljani testovi, `npx tsc --noEmit -p .`, ceo skup i `CI=true npm run build`**
- [ ] **Step 5: Commit**

```bash
git add -- src/components/TransactionDialog.tsx src/components/TransactionDialog.refund.render.test.tsx
git commit -m "feat(transakcija): direktan trosak moze da se oznaci kao povracaj, a sacuvan da se otvori i sacuva"
```
