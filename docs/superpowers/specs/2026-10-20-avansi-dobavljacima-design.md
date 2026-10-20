# Avansi dobavljačima: predračun, avansni račun, konačni račun

Datum: 20.10.2026. Važi za FlowBase, pa MCFlow, a zatim se ručno prenosi u
Mintflow (na engleskom: Proforma / Advance invoice / Final invoice; knjige u
USD). Nastavlja se na knjižna odobrenja i zaduženja
(`2026-10-19-knjizna-odobrenja-design.md`, migracija 20261020100000).

## Zašto

Dobavljaču se često plaća unapred, po predračunu. Dobavljač posle uplate izda
avansni račun, a kad isporuči robu ili uslugu, konačni račun koji avans
zatvara. Danas aplikacija ne zna ništa od ovoga:

- predračun ne može da se unese i plati kroz Neplaćene fakture i Halcom;
- uplata po predračunu nema gde da se proknjiži osim kao trošak;
- avansni račun nema svoju vrstu;
- **konačni račun sa SEF-a se knjiži pogrešno:** aplikacija uzima iznos
  „za plaćanje“, a on je već umanjen za avans. Konačni račun B.B. Link
  21404-01-26 (18.144,00) ušao bi u P&L sa 0, DST 427/26 (17.340,00) sa 4.080;
- lako se propusti da se avans zatvori konačnim računom, pa avans „visi“, a
  trošak se ne vidi ili se vidi dvaput.

Cilj je da aplikacija prepozna sve sama, uz minimalni napor korisnika, i da
nijedan avans ne ostane nezatvoren bez upozorenja.

## Šta je videno u stvarnim dokumentima (MCFlow SEF sanduče, 20.10.2026)

Otvoreno 5 avansnih i 5 konačnih računa:

- **Avansni račun** ima SEF vrstu `386` (`InvoiceTypeCode`), pun iznos sa PDV-om
  u `PayableAmount`, `PrepaidAmount` 0. Broj predračuna se pominje samo u
  tekstu stavke ili napomene („Avansna uplata po predračunu br. 256173“,
  „Avans po predračunu 177/2026 od 07.10.2026“, „po predračunu br. 9917/017“).
  Nije strukturiran podatak.
- **Konačni račun** ima vrstu `380` i za svaki avans
  `cac:BillingReference/cac:InvoiceDocumentReference` sa `cbc:ID` (broj
  avansnog računa) i `cbc:IssueDate`. `PayableAmount` je već umanjen za avans;
  `TaxInclusiveAmount` je kod nekih dobavljača takođe umanjen (0), pa se na
  njega ne može osloniti. Pun iznos računa = `TaxExclusiveAmount` + PDV iz
  `TaxTotal/TaxAmount`. Iskorišćen avans = pun iznos − `PayableAmount`.
  `PrepaidAmount` se u ovim dokumentima ne popunjava.
- Primeri: B.B. Link 21404-01-26 → RA2027179 (pun 18.144,00, avans 18.144,00,
  za plaćanje 0); DST 427/26 → 0033/26 (17.340,00 / 13.260,00 / 4.080,00);
  Bepro 745/2026 → AV104/2026 (323.125,57 / 323.125,57 iz avansa od
  329.725,45, na avansu ostaje 6.599,88: delimično iskorišćen avans).
- Peri je poslao 10053016 (bez reference, za plaćanje 190.140) i
  „10053016 - k“ (sa referencom na A-263/2026, za plaćanje 0). Prvi je
  dobavljačeva greška; kontrola duplikata ga ne hvata jer se brojevi razlikuju.

## Šta korisnik dobija

### 1. Predračun

- Nova vrsta dokumenta **Predračun** (u Vrsti dokumenta, uz Račun, Knjižno
  odobrenje i Knjižno zaduženje; uz Avansni račun ih je pet). Unosi se ručno,
  sa podacima potrebnim za plaćanje: dobavljač, broj, datum, rok, iznos,
  račun dobavljača, model i poziv na broj.
- **Nema uticaj na P&L.** Dok nije plaćen, vidi se u planu novčanih tokova kao
  očekivani odliv na datum roka.
- Neplaćen predračun stoji u **Neplaćenim fakturama** i ide u **Halcom** kao
  svaki račun (odluka korisnika), sa jasnom oznakom „predračun“. U MCFlow-u
  ga direktor može naložiti za plaćanje kao i račun.

### 2. Plaćanje po predračunu

- Na izvodu (i ručnoj transakciji, masovnom uvozu, uparivanju) nova opcija
  **Predračun**: transakcija zatvara postojeći uneti predračun (pun ili
  delimičan iznos, kao plaćanje računa), **ili ga pravi i zatvara** u istom
  koraku, kad je novac pušten bez predračuna. Tada se predračun pravi sa
  podacima iz transakcije (dobavljač, iznos, datum, račun) i svi se mogu
  izmeniti.
- Ni ovde nema P&L-a; novac je izašao, pa se vidi u novčanim tokovima.

### 3. Avansni račun

- Nova vrsta **Avansni račun**. Sa SEF-a (vrsta 386) otvara se sa tom vrstom i
  svim podacima sa dokumenta; ručno se unosi kao svaki dokument. Sva polja su
  izmenljiva.
- **Vezuje se samo za plaćene predračune** istog dobavljača (jedan ili više).
  Sa SEF-a se predlaže predračun čiji se broj pominje u tekstu, ako ga ima;
  inače se nude plaćeni predračuni tog dobavljača koji još nisu pokriveni.
- **Pravila iznosa (odluka korisnika na predlog):**
  - avansni račun **manji** od plaćenog: prihvata se; ostatak se vidi kao
    „plaćeno dobavljaču, bez avansnog računa“ i čeka sledeći avansni račun
    (koji ne može preći taj ostatak) ili povraćaj;
  - avansni račun **veći** od plaćenog po vezanim predračunima: ne može da se
    veže; poruka kaže koliko je plaćeno, a koliko fakturisano (rešenje je
    ispravka od dobavljača);
  - kod više predračuna gleda se zbir plaćenog; kod delimično plaćenog
    predračuna samo plaćeni deo.
- **Nema uticaj na P&L**, ni na novčane tokove (novac je već izašao uplatom).
  Ne plaća se: ne pojavljuje se u Neplaćenim fakturama ni u Halcom-u.
- Posle njega ostaje **avans kod dobavljača**: iznos avansnog računa minus ono
  što su konačni računi iskoristili.

### 4. Konačni račun

- Konačni račun je običan **Račun** koji je vezan za jedan ili više avansnih
  računa, sa iznosom iskorišćenim iz svakog.
- **Sa SEF-a:** kad dokument navodi avansne račune (`BillingReference`),
  aplikacija:
  - knjiži **pun iznos** računa (ne „za plaćanje“) u P&L, u mesecu datuma
    prometa konačnog računa, bez obzira na datum avansa;
  - sama nalazi navedene avansne račune istog dobavljača po broju
    (`invoice_number_key`) i predlaže iskorišćene iznose (zbirno: pun iznos −
    za plaćanje, raspoređeno po redu navođenja, svaki do svog neiskorišćenog
    ostatka);
  - **ne dozvoljava knjiženje dok veza nije postavljena** (jaka kontrola). Ako
    navedeni avansni račun nije u bazi, nudi se scenario 2 u istom prozoru.
- **Ručni unos (odluka korisnika):** odgovornost je na onome ko unosi. Čim se
  izabere dobavljač sa otvorenim avansom, prozor kaže „Dobavljač ima otvorene
  avanse: N avansnih računa, ukupno X“, i nudi vezu, ali ona nije obavezna.
- Avans zatvara račun **u celosti ili delimično**; razlika je ostatak za
  plaćanje i ide u Neplaćene fakture, Halcom, plan novčanih tokova.
- **Jedan konačni račun može da zatvori više avansnih računa**, a **jedan
  avansni račun može da bude iskorišćen delimično**, pa ostatak ostaje za
  sledeći konačni račun (Bepro).
- Iskorišćeni avans ne može preći ni neiskorišćeni ostatak avansnog računa ni
  pun iznos konačnog računa.

### 5. Scenario 2: avansni račun iz ranijeg perioda

- Kad konačni račun navodi avansni račun koji nije u bazi (plaćen pre početka
  knjiga), u prozoru konačnog računa postoji **„Dodaj avansni račun iz
  ranijeg perioda“**. Pravi se avansni račun sa podacima koje konačni račun
  daje (broj i datum iz `BillingReference`, dobavljač, iznos iskorišćen na
  ovom računu kao predlog iznosa), sve izmenljivo, i odmah se vezuje.
- Takav avansni račun **nema predračun ni transakciju** i pravilo „ne veći od
  plaćenog“ se na njega ne odnosi. Označen je „iz ranijeg perioda“. Nema P&L
  ni novčanih tokova.
- Ista mogućnost postoji i bez konačnog računa (ručni unos starog avansa), za
  avanse iz početnog stanja.

### 6. Pregled po dobavljaču

- Na jednom mestu (lista avansa, i u kartici dobavljača ako postoji) za svakog
  dobavljača tri broja: **plaćeno po predračunima**, **pokriveno avansnim
  računima**, **iskorišćeno konačnim računima**, i iz njih: plaćeno a bez
  avansnog računa; avans koji još čeka konačni račun.
- Upozorenja se vide bez traženja: plaćen predračun bez avansnog računa,
  avansni račun bez konačnog.
- **Ostatak se ne zatvara ručno (odluka korisnika):** upozorenje za
  neiskorišćen avans (npr. Bepro AV104/2026, 6.599,88) ili plaćeno bez
  avansnog računa ostaje dok se ne reši sledećim avansnim ili konačnim
  računom. Nema dugmeta „zatvori ostatak“; povraćaj od dobavljača je obična
  uplata i ne vezuje se za avans.

## Pravila

- Važi za ulazne fakture (dobavljači). Postojeći avansi investitora
  (`is_advance`, `advance_deducted` na izlaznim fakturama) se ne menjaju.
- Predračun i avansni račun nikad nemaju P&L uticaj. Konačni račun ima, punim
  iznosom.
- Predračun se plaća kao račun; avansni račun se nikad ne plaća.
- Avansni račun se ne briše dok ga koristi konačni račun; predračun se ne
  briše dok je vezan za avansni račun ili plaćen.
- Kontrola duplikata (po vrsti dokumenta) važi i za predračune i avansne
  račune.
- Ista firma, isti dobavljač, ista valuta kroz ceo lanac.

## Neuspeh, iako sve tehnički radi

- Konačni račun ode u P&L sa iznosom „za plaćanje“ umesto punog iznosa.
- Konačni račun sa SEF-a se proknjiži bez veze sa avansom, pa avans visi.
- Avans se pojavi u P&L-u, ili se trošak vidi dvaput (avans + konačni).
- Avansni račun se ponudi za plaćanje ili uđe u Halcom.
- Iskorišćeni avans pređe ono što je dobavljaču stvarno plaćeno ili fakturisano.
- Korisnik mora sam da prepisuje podatke koje dokument već ima.

## Šta ovo nije

- Nije PDV evidencija (PDV na avans, odbitak PDV-a): aplikacija ne vodi PDV.
- Nisu avansi investitora (već postoje).
- Nije povraćaj avansa od dobavljača: to je uplata kao i svaka druga.
- Nije automatsko odbijanje pogrešnih dokumenata na SEF-u (Peri 10053016);
  to korisnik radi u sandučetu, kao i danas.

## Ostavljeno graditelju (moje odluke, za proveru)

1. **Model:** predračun i avansni račun su redovi u `invoices` sa
   `document_type` `proforma` i `advance_invoice`, `pl_impact = false`
   (proširuje check iz 20261020100000). Plaćanje predračuna je obična veza
   transakcija ↔ račun (`invoice_transaction_links`). Veze predračun ↔ avansni
   račun i avansni račun ↔ konačni račun su posebne tabele sa iznosom
   (više-na-više), jer obe strane mogu biti delimične. `adjusts_invoice_id`
   ostaje za knjižna odobrenja.
2. **Status:** `v_invoice_status` računa konačni račun kao zatvoren
   iskorišćenim avansom kao što računa knjižno odobrenje (umanjuje ostatak,
   oznaka „zatvoreno avansom“); avansni račun je uvek „zatvoren“ za plaćanje;
   predračun se plaća kao račun.
3. **Pun iznos sa SEF-a:** parser vraća pun iznos (`TaxExclusiveAmount` +
   PDV) i iskorišćeni avans; postojeći `total` za obične račune ostaje isti.
4. **Pravila u bazi** (triggeri, kao kod odobrenja), a forma ih ponavlja da
   korisnik vidi razlog pre čuvanja.
5. **SQL testovi na demo bazi**, render testovi formi i panela; pre
   primene na MCFlow, recenzija cele grane.
6. **Mintflow:** isti tok na engleskom, u USD; migracija sa samoproverom kao
   20261031090000.
7. **`amount` konačnog računa je pun iznos** (on ide u P&L). Iskorišćeni avans
   umanjuje ostatak za plaćanje u `v_invoice_status` (kao knjižno odobrenje),
   pa svaki čitač ostatka (Neplaćene fakture, Halcom, novčani tokovi,
   izvodi, nalozi direktora) dobija tačan iznos bez sopstvene računice.
8. **Kurs:** iskorišćeni avans se vodi u valuti konačnog računa, a u dinarima i
   evrima po kursu **konačnog računa**, da potpuno pokriven račun ne ostane
   otvoren za par dinara. Lanac je u istoj valuti (pravilo gore); u MCFlow-u
   je to praktično uvek RSD.
9. **Transakcija sa opcijom Predračun** uvek ima `pl_impact = false`, bez P&L
   klasifikacije; korisnik to ne može da promeni dok je opcija uključena.
10. **Nalozi direktora (MCFlow):** predračun može da se naloži kao račun;
    konačni račun samo za ostatak posle avansa (`payorder_remaining` čita
    ostatak iz istog pravila); avansni račun nikad.
11. **Redosled stizanja:** avansni račun može da se sačuva i pre nego što je
    predračun plaćen ili unet, kao **nevezan** (upadljiva oznaka, kao nevezano
    knjižno odobrenje) i veže se kasnije. Konačni račun sa SEF-a čiji
    avansni račun još nije u bazi čeka (ne knjiži se) ili se avansni račun
    doda kroz scenario 2; ako kasnije stigne isti avansni račun sa SEF-a,
    kontrola duplikata (isti dobavljač, broj, vrsta) ga odbija i nudi da se
    otvori postojeći.

## Postojeći podaci (provereno 20.10.2026)

- U MCFlow-u nema transakcija ni računa knjiženih kao avans dobavljaču, ni
  konačnih računa uvezenih sa umanjenim iznosom (32 uvezena SEF reda iz
  početnog stanja nemaju dokument sa vezom na avans). Ispravka postojećih
  podataka nije potrebna.
- Avansi plaćeni pre 30.09.2026 unose se kroz scenario 2 (ručno ili iz
  konačnog računa).
