# Prihodi: izlazne fakture sa SEF-a, potraživanja i naplata

Datum: 04.11.2026. Važi za FlowBase, pa MCFlow. U Mintflow se prenosi
kasnije, zajedno sa ostalim, kad vlasnik odobri (tamo radi drugi agent).
Nastavlja se na ulaznu stranu: SEF sanduče, avanse dobavljačima
(`2026-10-20-avansi-dobavljacima-design.md`), knjižna odobrenja i zaduženja
(`2026-10-19-knjizna-odobrenja-design.md`, debit note od 27.10.2026).

## Zašto

Troškovna strana ima SEF sanduče, knjiženje sa svim poljima, avanse, karticu
partnera, IOS, neplaćene fakture i naloge. Prihodna strana je slabija: izlazne
fakture se unose ručno iz Glavne knjige, ne dolaze sa SEF-a, avansi kupaca se
vode samo kao zbir po projektu, a stranica Prihodi ne odgovara odmah na
pitanje koje vlasnik postavlja prvo.

**Šta vlasnik želi da vidi kad otvori Prihode:** ukupna potraživanja, šta je
dospelo i šta kasni. Zatim naplatu vrednosti projekata.

## Kako se izlazne fakture izdaju (od vlasnika)

- Izlazne fakture se prave **direktno u SEF portalu ili izvozom iz
  knjigovodstvenog programa Calculus**. MCFlow ih nikad ne izdaje i ne šalje;
  samo ih čita sa SEF-a. Ručni unos postoji za ono što nije na SEF-u.
- **Najčešći slučaj:** faktura (ili konačna situacija) naručiocu, bez
  predračuna i avansa, jer je posao obavljen po ugovoru.
- **Ređi slučaj, sa avansom:** predračun → uplata investitora → avansni
  račun posle uplate → konačna situacija koja avans zatvara, delimično ili
  potpuno.
- **Nema zadržanog (garantnog) iznosa.**
- **Zakup** se takođe izdaje na SEF-u; aplikacija ga samo prepoznaje.

## Ciljevi

1. Dugme **„Preuzmi sa SEF-a“** na Prihodima povlači izlazne fakture u
   sanduče izlaznih faktura, kao kod ulaznih.
2. **„Proknjiži“** iz sandučeta otvara formular izlazne fakture sa svim
   poljima koja treba za ispravno knjiženje, popunjen iz dokumenta; PDF i
   prilozi su u zaglavlju formulara od početka.
3. **„Nova izlazna faktura“** na Prihodima: isti formular, ručno.
4. Svaka izlazna faktura je razvrstana: **projekat**, **zakup** ili
   **prodaja usluga** (bez projekta i zakupa).
5. Avansi kupaca rade **po dokumentima**, kao kod dobavljača: predračun,
   uplata, avansni račun, konačna faktura koja avanse zatvara.
6. Vrh stranice Prihodi: **ukupna potraživanja, dospelo, kasni**; zatim ko
   kasni; zatim naplata po projektima; zatim lista izlaznih faktura.

## Ne-ciljevi

- Izdavanje, slanje, otkazivanje ili storniranje faktura na SEF-u.
- Zadržani (garantni) iznos na situacijama.
- Aplikacija ne pravi sama fakture za zakup (to radi SEF/Calculus).
- Nikakav AI i nikakav plaćeni servis (MCFlow je bez dodatnih troškova).

## Anti-ciljevi (neuspeh čak i ako radi)

- Prihod knjižen dvaput: avansni račun u P&L i konačna faktura u P&L u punom
  iznosu, ili uplata avansa kao prihod i faktura kao prihod.
- Konačna faktura sa SEF-a proknjižena kao potpuno nenaplaćena iako je
  avans pokriva — potraživanje bi bilo pogrešno.
- Bilo šta proknjiženo samo, bez korisnika.
- Ulazno sanduče izmešano sa izlaznim tako da se ulazna faktura proknjiži
  kao izlazna ili obrnuto.

## SEF API za izlazne fakture (proveren u zvaničnoj dokumentaciji)

Izvor: „API dokumentacija“ od 31.07.2026 (efaktura.gov.rs, tekst 368).

- `POST /api/publicApi/sales-invoice/ids?status=…&dateFrom=…&dateTo=…`
  vraća `{ SalesInvoiceIds: [...] }`. **Nema pregleda (overview) kao za
  ulazne**, pa se lista dobija po statusu i periodu.
- `GET /api/publicApi/sales-invoice?invoiceId=` vraća status i podatke
  (`Status`, `InvoiceId`, `GlobUniqId`, `CirStatus`, `CirInvoiceId`,
  `LastModifiedUtc`, `CancelComment`, `StornoComment` …).
- `GET /api/publicApi/sales-invoice/xml?invoiceId=` vraća UBL dokument.
- `GET /api/publicApi/sales-invoice/pdf?invoiceId=` vraća PDF.
- `POST /api/publicApi/sales-invoice/changes?date=` vraća promene statusa
  za dan (`SalesInvoiceId`, `NewInvoiceStatus`, `Date`).
- Statusi (`SalesInvoiceStatus`): New, Draft, Sent, Paid, Mistake, OverDue,
  Archived, Sending, Deleted, Approved, Rejected, Cancelled, Storno, Unknown.
- **Čitanje izlazne fakture ne menja ništa kod kupca** (nema „Seen“ kao kod
  ulaznih), pa nema opreza kao kod „New“ ulaznih faktura.
- SEF ima uloge korisnika („Korisnik za izlazne dokumente“, „Korisnik za
  ulazne dokumente“, „Administrator“…). **Nije provereno** da li postojeći API
  ključ MCFlow-a sme da čita izlazne fakture; provera veze to mora da kaže
  jasno (vidi Deo A).

## Deo A — Povlačenje izlaznih faktura sa SEF-a

- **Gde se čuvaju:** u istom `sef_inbox`, sa novom kolonom smera
  (`direction`: `purchase` za postojeće redove, `sales` za nove). Jedinstvenost
  SEF id-ja važi po smeru. Ulazno sanduče prikazuje samo `purchase`, izlazno
  samo `sales`; nijedan postojeći upit ulazne strane ne sme da vidi `sales`
  redove. Za izlazne redove polja „dobavljač“ nose **kupca** (naziv, PIB, MB)
  — builder bira da li kroz nove kolone `customer_*` ili kroz neutralna
  imena; ulazna strana ne sme da se promeni.
- **Funkcija** (nova, npr. `sef-pull-sales`): za period (isti prozor i
  donja granica kao ulazno povlačenje) traži id-jeve za statuse koji znače
  izdatu i važeću fakturu: **Sent, Approved, Paid, OverDue, Archived**.
  **Stornirana, otkazana i odbijena faktura se ne povlači** (vlasnik:
  „kada storniramo fakturu na SEF-u, ona se ne povlači“; odbijena se tretira
  isto — moja odluka). Draft, New, Sending, Mistake, Deleted, Unknown se
  takođe ne povlače. Za svaki novi id: status, UBL i PDF se odmah preuzimaju i čuvaju
  (PDF u postojeći privatni bucket, prilozi kao kod ulaznih). Postojećim
  redovima se osvežava status (`changes` ili ponovni `sales-invoice`).
  Poziva je dugme „Preuzmi sa SEF-a“ i, ako ulazno povlačenje već ide po
  rasporedu, isti raspored.
- **Ko sme:** članovi firme pokreću povlačenje; knjiženje samo oni koji vode
  knjige (kao kod ulaznih).
- **Provera veze** (`sef-check`) dobija i proveru izlaznih: jedan bezopasan
  `sales-invoice/ids` za danas. Ako ključ nema pravo, poruka kaže tačno to
  („SEF ključ nema pravo na izlazne fakture — u SEF portalu dodelite ulogu …“).
- **Već povučena ili proknjižena faktura koja kasnije postane stornirana,
  otkazana ili odbijena** (vidi se pri osvežavanju statusa): red u sandučetu
  to pokazuje i ne može se proknjižiti; proknjižena faktura ostaje u prihodu i
  potraživanjima sa crvenim upozorenjem dok korisnik ne unese knjižno
  odobrenje ili je ne obriše (Deo F). Ništa se ne briše samo.
- **Faktura već uneta ručno** koju povlačenje donese: sanduče je prepoznaje
  (isti kupac i broj) i nudi „Poveži sa postojećom“ — faktura dobija PDF,
  UBL i SEF status, bez novog knjiženja (kao uparivanje kod ulaznih). Moja
  odluka.
- **SEF status „Paid“** se prikazuje kao informacija; naplata se računa samo
  po izvodu banke. Ako se ne slažu, upozorenje. Moja odluka.

## Deo B — Sanduče izlaznih faktura i knjiženje

- Na Prihodima dugme **„SEF izlazne“** otvara sanduče izlaznih faktura (isti
  izgled kao ulazno: čekaju / proknjižene / odbijene / sve; PDF i prilozi;
  „Odbij“ sa razlogom; „Vrati u red“). Nema SEF odluka (prihvati/odbij) — to
  radi kupac.
- **„Proknjiži“** otvara formular izlazne fakture popunjen iz UBL-a:
  - kupac po PIB/MB (postojeće uparivanje partnera, sada za kupca); nepoznat
    kupac → ponuda da se doda (sa NBS pretragom);
  - broj, datum prometa (datum knjiženja i kursa, kao kod ulaznih), datum
    izdavanja, dospeće, valuta, iznos sa PDV-om (`TaxInclusiveAmount`),
    osnovica i PDV;
  - vrsta dokumenta: 380 račun, 386 avansni račun, 381 knjižno odobrenje,
    383 knjižno zaduženje; za odobrenje/zaduženje predlog osnovne fakture iz
    `BillingReference`;
  - konačna faktura: avansi iz `BillingReference` (+ iznosi iz
    `SrbDtExt/InvoicedPrepaymentAmmount` kad postoje), isto pravilo kao kod
    ulaznih: **sa SEF-a se ne može proknjižiti dok njeni avansi nisu
    povezani**; avansi iz ranijeg perioda se mogu dodati;
  - razvrstavanje: projekat / zakup / prodaja usluga (Deo D) — predlog iz
    istorije kupca i iz zakupa;
  - vrsta prihoda (postojeće polje) i, gde treba, podela.
- Posle knjiženja red je „proknjižen“ i vezan za fakturu; PDF i prilozi se
  vide sa fakture, kartice kupca i liste potraživanja (postojeći pregledač).
- Duplikat (isti broj, isti kupac) se pokazuje pre knjiženja, kao kod ulaznih.

## Deo C — Avansi kupaca po dokumentima

Isto kao avansi dobavljačima, u suprotnom smeru. Dokumenti na prihodnoj
strani: **predračun** (naš, ne ide na SEF; samo ručno), **avansni račun**
(386, sa SEF-a ili ručno), **konačna faktura**.

- Predračun: bez uticaja na P&L, potraživanje „čeka uplatu“ dok se ne plati.
- Uplata kupca na izvodu: veže se za predračun (kao kod dobavljača,
  uključujući „Nov predračun iz ove uplate“ kad predračuna nema) ili direktno
  za avansni račun proknjižen ranije.
- Avansni račun: bez uticaja na P&L, nikad se ne potražuje ponovo; pokriva
  uplatu/predračun.
- Konačna faktura: pun iznos u P&L; avansni računi koje navodi zatvaraju deo
  ili celu; ostatak je potraživanje sa dospećem. Avans koji pokriva više
  faktura ostaje delimično otvoren.
- Baza: postojeća pravila (`advance_coverage`, `advance_usage`,
  `invoices_advance_shape` i ostali okidači) sada važe za oba smera, uvek
  unutar istog smera i istog partnera; mešanje ulaznog i izlaznog se odbija.
- **Stari mehanizam** (uplata sa oznakom avansa na projektu + „Odbijeni
  avans“ na fakturi, zbir po projektu) ostaje samo za već postojeće zapise —
  u MCFlow-u ih nema. **Mesta za unos (oznaka avansa na uplati, polje
  „Odbijeni avans“) se sakrivaju za nove unose**, postojeći zapisi se i dalje
  prikazuju i računaju; tako se avans ne može odbiti dvaput. Moja odluka. Pre prenosa u
  Mintflow proveriti da li ga Mintflow koristi.
- Panel „Avansi kupaca“ (kao „Avansi dobavljačima“): primljeni avansi,
  iskorišćeno, otvoreno, po kupcu i projektu.

## Deo D — Razvrstavanje: projekat, zakup, prodaja usluga

- U formularu izlazne fakture obavezan izbor jedne od tri: **Projekat**
  (bira se projekat), **Zakup** (bira se zakup i mesec usluge), **Prodaja
  usluga** (ništa od toga).
- **Zakup se prepoznaje:** kupac je zakupac aktivnog zakupa, a iznos je
  mesečna zakupnina (ili mesec piše u opisu) → predlaže se taj zakup i
  mesec. Već postojeći jedinstveni par (zakup, mesec) se poštuje; ako je
  mesec već fakturisan, upozorenje.
- **Projekat se predlaže** iz istorije kupca (poslednji projekti tog
  investitora) i iz broja/opisa ako ga sadrže.
- „Predloži fakture za zakup“ ostaje samo kao podsetnik za mesec za koji
  faktura sa SEF-a nije stigla.
- Faktura za zakup **zadržava projekat zgrade** (baza to već traži).
  Razvrstavanje se čita ovako: ima zakup → Zakup; ima projekat bez zakupa →
  Projekat; ništa → Prodaja usluga. „Po projektima“ prikazuje građevinske
  projekte; zakupi imaju svoj odeljak. Moja odluka.

## Deo E — Stranica Prihodi

Redosled od vrha:

1. **Tri broja:** **ukupna potraživanja** (sve nenaplaćeno), **dospeva u
   narednih 7 dana** (nije još dospelo, dospeva u 7 dana; vlasnik je potvrdio
   predloženi rok — čitam „predloženi“ kao 7 dana), **kasni** (dospelo i
   nenaplaćeno). Klik otvara te fakture. Predračuni koji čekaju uplatu nisu u
   potraživanjima, vide se posebno. Iznosi u valuti izabranoj gore levo
   (RSD/EUR), po knjigovodstvenom kursu fakture.
2. **Ko kasni:** kupci sa iznosom, najstarijim dospećem i danima kašnjenja,
   po iznosu; odavde kartica kupca, IOS, PDF.
3. **Po projektima:** vrednost ugovora, fakturisano, naplaćeno, preostalo za
   fakturisanje (postojeća tabela, dopunjena).
4. **Lista izlaznih faktura** sa dugmadima „SEF izlazne“ / „Preuzmi sa
   SEF-a“ i „Nova izlazna faktura“; filteri projekat/zakup/prodaja usluga,
   status, period; PDF dugme.
5. Ispod: starost potraživanja, plan prihoda, zakupi, avansi kupaca.

Iznosi pune cifre, kao na stranici Krediti (bez „mil.“/„hilj.“).

## Deo F — Brisanje izlazne fakture sa svim vezanim

Vlasnik: „opcija da mogu da izbrišem fakturu i sve vezano za nju je jako
poželjna“.

- Na izlaznoj fakturi dugme **„Obriši fakturu i sve vezano“**, sa potvrdom
  koja nabraja šta će se desiti: veze sa uplatama se raskidaju (uplate ostaju
  na izvodu, nepovezane), veze sa avansima (pokriće/korišćenje) se brišu,
  knjižna odobrenja/zaduženja vezana za nju se brišu zajedno sa njom (ili se
  odvezuju — builder predlaže, potvrda to kaže), PDF-ovi otpremljeni ručno se
  sklanjaju, a SEF red se vraća u red „čeka“ (da se može ponovo proknjižiti)
  ili ostaje „odbijen“ ako je faktura stornirana na SEF-u.
- Brisanje je meko (`deleted_at`, kao svuda u aplikaciji), u jednoj
  transakciji u bazi; ništa ne ostaje napola obrisano.
- Samo oni koji vode knjige.
- Isto dugme ima smisla i za ulazne fakture; to nije deo ovog projekta, ali
  funkcija u bazi treba da radi za oba smera da bi se kasnije samo uključila.

## Ograničenja

- Prvo FlowBase (migracije samo u FlowBase-u), pa merge u MCFlow; MCFlow bazu
  primenjujem ja preko CLI rutine; funkcije postavljam uz potvrdu vlasnika.
- Ništa se ne knjiži bez korisnika; nema AI-ja.
- Ulazna strana mora da radi tačno kao pre (testovi ostaju zeleni).
- Podaci klijenta ne idu u repozitorijum (testovi sa izmišljenim firmama).

## Ostavljeno builderu

- Podela na korake i redosled (predlog: A+B bez avansa → D → E → F → C).
- Imena kolona/tabela/funkcija, oblik migracija, raspored povlačenja.
- Izgled sandučeta i formulara u okviru postojećeg stila.
- Koliko istorije kupca gleda predlog projekta.
