# Povraćaj umanjuje trošak — dizajn

Vlasnik je odobrio pravilo 18.11.2026. za Mintflow i tražio isto za FlowBase i
MCFlow („Ovo isto treba da se uradi i na flowbase i na MCFlow“). Ovo je prenos
tog dizajna na FlowBase: isti zaključci, drugi kod (dinari i evri, srpski
interfejs, projekti umesto podele po tokovima). MCFlow ga dobija spajanjem iz
FlowBase-a (`docs/NADOGRADNJA.md`).

## Problem

Plati se dobavljaču, trošak se proknjiži i rasporedi. Posle nekoliko dana
dobavljač vrati novac. Povraćaj se proknjiži kao trošak sa istom
klasifikacijom, u očekivanju plusa i minusa — a aplikacija pokaže dva troška.
Primer: trošak 1.784,40 i povraćaj 1.199,22 daju 2.983,62 umesto 585,18.

## Šta danas ne valja

1. **Povraćaj se nikad ne upiše sa minusom.** Uvoz izvoda
   (`BulkImport.tsx`) i ručni unos izvoda (`BankStatementDialog.tsx`) čuvaju
   samo veličinu stavke, a smer živi u `tx_subtype`. Uplata kojoj se podtip
   promeni u „Trošak“ postaje pozitivan trošak. `TransactionDialog.tsx`
   odbija iznos koji nije veći od nule („Iznos mora biti veći od 0“).
2. **Gde minus postoji, deo ekrana ga sabira kao plus.** Negativne troškove
   danas upisuju zarade (storno zadržane obustave) i knjižna odobrenja.
   Kontrolna tabla, Izveštaji, Budžet i Glavna knjiga sabiraju sa znakom.
   P&L analiza (stablo, grupe po mesecima, grafikoni) i vremenska linija
   novčanog toka uzimaju `Math.abs`.

## Pravilo

**Trošak je plus. Povraćaj je isti trošak sa minusom, pod istom
klasifikacijom. Svaki ekran sabira troškove sa znakom.**

*Povraćaj* je red u `transactions` sa `type = 'direct'`,
`tx_subtype = 'expense'` i negativnim `amount`, `amount_rsd` i `amount_eur`.
`exchange_rate` i `eur_rate` ostaju pozitivni. **Baza se ne menja: nema
migracije.** `v_pl_entries` prenosi znak, `pl_splits_must_balance` je
simetričan, a na `transactions` nema ograničenja znaka.

## Odluke

Brojevi su isti kao u Mintflow dizajnu, da se dva dokumenta mogu porediti.

**D1. Unos.** Povraćaj se iskazuje tako što se za novac koji je *stigao*
izabere „Trošak“; ukucava se uvek veličina, a minus je posao aplikacije.
Uvoz izvoda i ručni unos izvoda: stavka u koloni uplate, tip `direct`,
podtip `expense`. Pojedinačna transakcija: prekidač „Ovo je povraćaj“ na
direktnom trošku.

**D2. Šta se čuva.** `amount`, `amount_rsd`, `amount_eur` negativni; kursevi
nepromenjeni; svaka stavka podele (`pl_splits`) negativna (roditelj podele
nosi sva tri negativna iznosa). `cf_type = 'one_time'`, a `cf_frequency`,
`cf_next_month_est`, `cf_accrual_from`, `cf_accrual_to`, `cf_capex_months`,
`cf_reimbursable_date` su `null`. `project_id` se čuva kao i kod troška.
Avans (`is_advance`) nikad nije povraćaj.

**D3. Ručni unos izvoda više ne pretpostavlja trošak za uplatu.** Na redu
kome podtip nije izabran rukom, iznos ukucan u uplatu daje „Prihod“, a u
isplatu „Trošak“. Kliknuta kartica je izbor i ne menja se sama. Red učitan
iz baze važi kao izabran.

**D4. Sačuvan povraćaj može da se otvori i ponovo sačuva.** `txToSeed`
stavlja negativan trošak u kolonu uplate kao veličinu, sa podtipom „Trošak“;
`TransactionDialog` prikazuje veličinu i uključen prekidač. Time postaju
izmenjiva i postojeća storna iz zarada, koja danas ne mogu da se sačuvaju.

**D5. Svaki zbir troškova je neto.** `expenseTree.contributionsFor`,
`entryGroups.groupByMonth` i `cfoMetrics.monthlyTrend` sabiraju sa znakom.
Pretraga po iznosu ostaje na veličini (`matchesAmount`, `amountSearch`).

**D6. Iznos na nuli ili ispod nje je u tabeli, a ne na slici.** Čvor, mesec
ili ćelija čiji je neto nula ili manje ostaje u svakoj tabeli i listi, sa
minusom. Grafikoni (grane, pareto, toplotna mapa, stubići, krofna na
Kontrolnoj tabli) za njega ne crtaju ništa i nikad ne daju negativnu
veličinu, NaN ili udeo preko 100%. Udeo je u zbiru pozitivnih iznosa.

**D7. Na ekranima novčanog toka povraćaj smanjuje odliv.** Ne prikazuje se
kao poseban priliv. Na kartici partnera nepovezan povraćaj je novac koji je
*stigao* od partnera.

**D8. Povraćaj je jednokratan.** Izbor tipa novčanog toka zamenjuje jedna
rečenica.

**D9. Kako povraćaj izgleda.** Negativan trošak-transakcija se ispisuje sa
minusom, zelenom umesto crvene, i nosi oznaku „Povraćaj“ da boja ne bude
jedini znak. Knjižno odobrenje zadržava svoju oznaku i ne dobija drugu.
Storna iz zarada su negativni troškovi i dobijaju istu oznaku. Ćelije
budžeta prikazuju neto na nuli ili ispod nje kao iznos sa znakom, ne kao
crtu. Reč „Refund.“ ostaje ono što je i bila — refundacija kao tip novčanog
toka — i ne koristi se za povraćaj.

**D10. Povraćaj se nikad ne nudi kao plaćanje fakture** (`InvoiceDialog`,
`multiLink`, `ReconcilePanel`).

**D11. Uvoz ne pogađa.** Prepoznavanje iz istorije se ne menja: uplata i
dalje stiže kao „Prihod“, a korisnik bira „Trošak“.

**D12. Već pogrešno proknjiženi redovi ispravljaju se ručno**: otvori se red
i uključi „Ovo je povraćaj“.

## Reči na ekranu (tačno ovako)

- Oznaka: `Povraćaj`
- Uvoz i ručni unos izvoda, na redu povraćaja:
  `Povraćaj: novac je vraćen, pa ova stavka umanjuje trošak umesto da ga uvećava.`
- Transakcija, prekidač: `Ovo je povraćaj`
- Ispod njega: `Dobavljač je vratio novac. Iznos se knjiži sa minusom i umanjuje trošak pod kojim je zaveden.`
- Umesto izbora tipa novčanog toka, na sva tri mesta:
  `Povraćaj se knjiži kao jednokratan — ne ulazi u procene narednih meseci.`
- Rečnik (`docs/recnik.md`) dobija stavku: `Refund (money back from a supplier) | Povraćaj`.

## Čega ovde nema

Ogledalo na strani prihoda (isplata proknjižena kao prihod); filter „iznos
od / do“ u Glavnoj knjizi koji poredi sa znakom; knjižna odobrenja na
fakturama van P&L-a; tekst „preostalo / višak“ u podeli knjižnog odobrenja.
Sve ostaje kako je bilo. Razlike prema Mintflow-u: FlowBase nema podelu po
vrednosti, karticu Simulacija ni AI predlog, pa tih delova nema ni ovde.
