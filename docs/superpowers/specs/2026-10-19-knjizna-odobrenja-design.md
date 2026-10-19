# Knjižno odobrenje i knjižno zaduženje

Datum: 19.10.2026. Važi za FlowBase, pa MCFlow, a zatim se ručno prenosi u
Mintflow (na engleskom: Invoice / Credit note / Debit note).

## Zašto

Dobavljač (ili firma investitoru) šalje knjižno odobrenje kad umanjuje
račun, a knjižno zaduženje kad ga naknadno povećava. Danas aplikacija zna
samo za „račun sa minusom“: knjižno odobrenje se unese kao negativan račun
koji ne zna na koji se račun odnosi. Zato u neplaćenim fakturama ostaju dve
nepovezane stavke, plus i minus. Ne vidi se koliko se stvarno duguje po
računu, ni zašto je obaveza manja ili veća. Knjiženje (P&L kategorija,
projekat, raspodela) mora se ručno ponoviti, pa lako ispadne drugačije
nego na osnovnom računu.

## Šta korisnik dobija

- U prozoru za unos fakture, **u zaglavlju**, polje **Vrsta dokumenta**:
  **Račun / Knjižno odobrenje / Knjižno zaduženje** (u Mintflow-u Invoice /
  Credit note / Debit note).
- **Podrazumevana vrsta prati znak iznosa:** pozitivan iznos znači Račun,
  negativan Knjižno odobrenje. Kad korisnik vrstu izabere ručno, više se ne
  menja sama.
- **Knjižno odobrenje i knjižno zaduženje se vezuju za jedan račun istog
  partnera.** Kad se izabere jedna od te dve vrste, otvara se polje
  „Odnosi se na račun“ sa računima tog partnera (broj, datum, iznos, ostalo).
- **Ako osnovnog računa nema u aplikaciji** (npr. stari račun pre početka
  knjiga), dokument se knjiži **bez veze**, sa upadljivom oznakom „nije vezano
  za račun“, i **vezuje se kasnije** (odluka korisnika). Dok nije vezan:
  - u bilansu uspeha ide na knjiženje koje mu korisnik unese;
  - ne nudi se za plaćanje i ne ulazi u Halcom fajl;
  - u Neplaćenim fakturama stoji upozorenje „N knjižnih odobrenja/zaduženja
    nije vezano za račun“, sa mogućnošću da se otvore i vežu;
  - kad se veže, umanjuje (ili povećava) obavezu po tom računu od tog trenutka.
- **Izborom računa dokument preuzima njegovo knjiženje**: tip, P&L kategoriju
  i podkategoriju, projekat, raspodelu (`pl_splits`), opis troška, tokove
  gotovine i P&L uticaj. Korisnik i dalje može da ih promeni.
- **Knjižno odobrenje umanjuje, a zaduženje povećava obavezu po tom
  računu.** U Neplaćenim fakturama i na računu se vidi:
  „Iznos 120.000 · knjižno odobrenje −20.000 (KO 5/26) · za plaćanje 100.000“.
  Račun umanjen odobrenjem je delimično zatvoren, sa jasnom oznakom da ga je
  zatvorilo knjižno odobrenje, a ne uplata.
- **Samo odobrenje ili zaduženje se ne plaća posebno** i ne pojavljuje se kao
  posebna stavka u Neplaćenim fakturama: plaća se (ili ne plaća) osnovni
  račun.
- **Bilans uspeha:** odobrenje je negativan, a zaduženje pozitivan trošak
  (ili prihod kod izlaznih faktura) u svom periodu, sa knjiženjem osnovnog
  računa. Odobrenje iz oktobra umanjuje oktobarske troškove na istim
  kategorijama i projektima kao račun.
- **SEF:** dokument sa SEF-a vrste „knjižno odobrenje“ (381) i „knjižno
  zaduženje“ (383) otvara se sa tom vrstom. Ako dokument navodi broj računa
  na koji se odnosi (`BillingReference`), taj račun se predlaže.

## Pravila

- Važi i za ulazne i za izlazne fakture, isto.
- Knjižno odobrenje ima negativan iznos, a zaduženje pozitivan. Odobrenje ne
  sme biti veće od ukupnog iznosa računa (iznos + zaduženja − ranija
  odobrenja). Ako je račun već plaćen, odobrenje je dozvoljeno, a račun
  postaje preplaćen (dobavljač nam duguje povraćaj). To se vidi, ali se ne
  odbija.
- Isti partner, ista firma i ista valuta kao osnovni račun. Osnovni račun
  mora biti vrste Račun: ne može se vezati na drugo odobrenje.
- Osnovni račun se ne može obrisati dok na njega upućuje živo odobrenje ili
  zaduženje.
- Kontrola duplikata (20261020090000) i dalje važi za broj odobrenja kod
  istog dobavljača.

## Odluke posle recenzije (moje, za proveru)

1. **Status računa umanjenog odobrenjem:** „delimično zatvoren“, a za plaćanje
   se nudi samo ostatak. Račun koji je odobrenjem pokriven u celosti je
   „zatvoren knjižnim odobrenjem“ (plaćen bez uplate). Oznaka uvek kaže da je
   zatvaranje od odobrenja, ne od uplate.
2. **Preplaćen račun** (odobrenje posle plaćanja) vidi se samo na samom računu
   („dobavljač duguje povraćaj X“). Ne ulazi u Neplaćene fakture ni u Halcom.
3. **Kurs:** vezano odobrenje ili zaduženje preračunava se po kursu osnovnog
   računa (RSD i EUR), da potpuno odobren račun ne ostane otvoren za par
   dinara. Nevezano koristi kurs svog datuma, kao svaki dokument.
4. **Kontrola duplikata** gleda i vrstu dokumenta: odobrenje „5/26“ i račun
   „5/26“ istog dobavljača su različiti dokumenti.
5. **Veza na osnovni račun** je nova kolona; `parent_invoice_id` već služi za
   obračun zarada i ne dira se.

## Postojeći podaci

- Postojeći računi su vrste Račun.
- Četiri odobrenja iz početnog stanja u MCFlow-u (Sanivod, Quadel, Steel and
  drill, D-Dragišić) se posle izrade unose kao knjižna odobrenja vezana za
  račune koje korisnik odredi, bez uticaja na bilans uspeha, kao i početno
  stanje.

## Šta ovo nije

- Nije raspodela jednog odobrenja na više računa (jedno odobrenje = jedan
  račun).
- Nije povraćaj novca od dobavljača kad je račun preplaćen; to je uplata kao
  i svaka druga.
- Nisu avansi (sledeći posao).

## Neuspeh i kad sve tehnički radi

- Račun umanjen odobrenjem i dalje se nudi za plaćanje u punom iznosu.
- Odobrenje se pojavi kao negativna stavka za plaćanje ili uđe u Halcom fajl.
- Odobrenje u bilansu uspeha ode na drugu kategoriju ili projekat nego račun.
- Vidi se da je obaveza manja, ali ne i zašto.

## Ostavljeno graditelju

- Naziv kolona (npr. `invoices.document_type`, `invoices.adjusts_invoice_id`)
  i kako `v_invoice_status` računa „ostalo za plaćanje“.
- Izgled prikaza odobrenja i zaduženja na računu.
- Testovi: SQL test na demo bazi i render testovi prozora za unos i Neplaćenih
  faktura.
