# Rečnik (engleski → srpski, latinica)

Jedan izvor istine za prevod interfejsa. Ako termin nije ovde, prevedi ga
prirodno, kako bi ga rekao finansijski direktor u Srbiji, i dodaj ga u ovaj
fajl.

## Pravila

- Interfejs je na srpskom, latinicom, ekavski. Komentari u kodu ostaju na
  engleskom.
- Dugmad su u imperativu: Sačuvaj, Otkaži, Obriši, Izmeni, Dodaj, Zatvori,
  Proknjiži, Uvezi, Izvezi.
- Naslovi i oznake počinju velikim slovom, a ostatak je malim slovima:
  „Datum dospeća“, ne „Datum Dospeća“.
- Datumi: `toLocaleDateString('sr-Latn-RS', …)`, npr. „8. oktobar 2026.“ ili
  „08.10.2026.“. Nikad 'en-US' ni 'en-GB'.
- Iznosi idu preko postojećih formatera u `src/utils/formatters.ts`
  (1.234,56 RSD).
- Množina: 1 faktura, 2–4 fakture, 5+ faktura. Za to se koristi helper
  `plural(n, 'faktura', 'fakture', 'faktura')` iz
  `src/utils/plural.ts`.
- Poruke o greškama treba da budu kratke i da kažu šta da se uradi:
  „Kurs NBS nije dostupan za 07.10.2026. Pokušajte ponovo ili unesite kurs
  ručno.“
- Kodovi valuta (RSD, EUR, USD) i skraćenice PDV, PIB, MB, NBS se ne prevode.

## Navigacija i strane

| EN | SR |
|---|---|
| Dashboard | Kontrolna tabla |
| General Ledger | Glavna knjiga |
| P&L Analysis | P&L analiza |
| Revenue | Prihodi |
| Cash Flow | Novčani tok |
| Budgeting & Forecasting | Budžet i prognoza |
| Reports | Izveštaji |
| Partners | Partneri |
| Credits / Bank Credits | Krediti |
| HR / HR administration | Kadrovska evidencija |
| Payroll | Zarade |
| Projects | Projekti |
| Settings | Podešavanja |
| Sign in / Sign out | Prijava / Odjava |

## Dokumenti i knjiženje

| EN | SR |
|---|---|
| Transaction | Transakcija |
| Invoice | Faktura |
| Expense invoice / bill | Ulazna faktura |
| Revenue invoice | Izlazna faktura |
| Credit note | Knjižno odobrenje |
| Pass-through | Prolazna stavka |
| Bank statement | Izvod |
| Statement number | Broj izvoda |
| Bulk import | Grupni uvoz |
| Debit (money out) / Credit (money in), on a statement | Isplata / Uplata |
| Direct (transaction) | Direktna |
| Invoice payment | Plaćanje fakture |
| Advance | Avans |
| Advance deducted | Odbijeni avans |
| Amount due | Za naplatu |
| Reconcile / match | Upari / uparivanje |
| Auto-match | Automatsko uparivanje |
| Link (payment to invoice) | Poveži |
| Allocated | Raspoređeno |
| Split | Podela / podeli |
| Split line | Stavka podele |
| Quick fill / template | Brza popuna / šablon |
| Currency difference | Kursna razlika |
| Exchange rate | Kurs |
| Book amounts (RSD/EUR) | Knjiženi iznos |
| Post / posted | Proknjiži / proknjiženo |
| Draft | Nacrt |
| Period lock / closed period | Zaključan period |
| Reference number | Poziv na broj |
| Model | Model |
| Account number | Broj računa |
| Payee account | Račun primaoca |
| Source (invoice / transaction) | Izvor (faktura / transakcija) |
| Document no. | Broj dokumenta |
| Credit payment (transaction type) | Otplata kredita |
| Pass-through in / out | Prolazna stavka — uplata / isplata (oznaka: UPLATA / ISPLATA) |
| Currency gain / loss | Pozitivna / negativna kursna razlika |
| Unallocated / over-allocated | Neraspoređeno / previše raspoređeno |
| Outstanding (still owed on an invoice) | Preostali dug / preostalo |
| Detach (invoice from a payment) | Odvoji |
| Manual entry (statement) | Ručni unos |
| Statement # | Izvod br. (u nazivu: Izvod #…) |
| Accept / Reject / Pending (import row) | Prihvati / Odbij / Na čekanju |
| Already imported | Već uvezeno |
| Upload file | Otpremanje fajla |
| Principal / interest leg (credit note) | Glavnica / Kamata |


## Klasifikacija

| EN | SR |
|---|---|
| P&L category | P&L kategorija |
| Sub-category | Potkategorija |
| Department | Sektor |
| Department sub-category | Podsektor |
| Expense description | Opis troška |
| Revenue stream | Vrsta prihoda |
| Project | Projekat |
| Construction site | Gradilište |
| Rental building | Objekat u zakupu |
| Overhead | Opšti troškovi |
| Cash-flow type (recurring / one-off) | Tip novčanog toka (ponavljajući / jednokratni) |
| Frequency (monthly …) | Učestalost (mesečno …) |
| Unassigned (no value at a level) | Nedodeljeno |
| Unclassified | Neklasifikovano |
| Other (folded rest) | Ostalo |
| Branch (P&L / department / project view) | Grana / prikaz (po P&L kategoriji, po sektoru, po projektu) |
| Line (row in a tree) | Stavka |
| Description (level) | Opis |
| Accrual | Razgraničenje |
| CapEx | Kapitalni izdatak (kratko: Kap. izdatak) |
| Reimbursable | Refundacija |
| Seasonal | Sezonski |
| Subtype (expense / revenue) | Podtip (trošak / prihod) |
| Expense category | Kategorija troška |
| Budget line | Budžetska stavka |
| System category (where the app posts on its own) | Sistemska kategorija |
| Set / not set (a system category) | Podešeno / nije podešeno |


## Status i iznosi

| EN | SR |
|---|---|
| Paid / Partial / Unpaid | Plaćeno / Delimično / Neplaćeno |
| Overdue | U kašnjenju |
| Due date | Datum dospeća |
| Open | Otvoreno |
| Receivables | Potraživanja |
| Payables | Obaveze |
| Revenue / Expenses | Prihodi / Troškovi |
| Net profit / loss | Neto dobit / gubitak |
| Margin | Marža |
| Total | Ukupno |
| Amount | Iznos |
| Balance | Stanje |
| Cash position | Stanje novca |
| Inflow / Outflow | Priliv / Odliv |
| Forecast / Projected | Prognoza / Očekivano |
| Budget / Actual / Variance | Budžet / Ostvareno / Odstupanje |
| YTD | Od početka godine |
| Month / Quarter / Year | Mesec / Kvartal / Godina |
| Monthly / Quarterly / Annual | Mesečno / Kvartalno / Godišnje |
| Net cash flow | Neto novčani tok |
| Run rate | Mesečni prosek |
| Concentration | Koncentracija |
| Bridge (waterfall chart) | Most |
| Excluded / adjusted total | Isključeno / korigovano ukupno |
| Not yet due / 1–30 days / Over 90 days | Nije dospelo / 1–30 dana / Preko 90 dana |
| Expense ratio | Udeo troškova |
| Fixed / variable cost | Fiksni / promenljivi trošak |
| Prior / current (period) | Prethodno / tekuće |
| Overdue N days | kasni N dana |
| Benchmark (month) | Referentni mesec |
| Estimate | Procena |
| Variance (short header) | ODST. |
| This month | Ovaj mesec |
| Under / Over budget | Ispod / Iznad budžeta |


## Krediti

| EN | SR |
|---|---|
| Credit / loan | Kredit |
| Instalment | Rata |
| Principal / Interest | Glavnica / Kamata |
| Annuity | Anuitet |
| Revolving credit | Revolving kredit |
| Outstanding | Preostalo |
| Repayment schedule | Plan otplate |
| Rate reset | Promena kamatne stope |
| Extension | Produženje |
| Annuity (kind of credit) | Anuitetni |
| Tranche | Tranša |
| Benchmark / reference rate | Referentna stopa |
| All-in rate | Ukupna kamatna stopa |
| Bank margin | Marža |
| Disbursement date | Datum isplate kredita |
| Drawn on | Datum povlačenja |
| Total obligation | Ukupna obaveza |
| Generate the schedule | Napravi plan otplate |
| Debt balance | Stanje duga |
| Variable / Fixed (rate) | PROM / FIKS |

## Zarade

| EN | SR |
|---|---|
| Employee | Zaposleni |
| Contract | Ugovor |
| Gross / Net | Bruto / Neto |
| Employer cost / total cost | Trošak poslodavca / ukupan trošak |
| Tax / Contributions | Porez / Doprinosi |
| Deduction | Obustava |
| Addition | Dodatak |
| Absence | Odsustvo |
| Sick leave | Bolovanje |
| Annual leave | Godišnji odmor |
| Public holiday | Državni praznik |
| Seniority | Minuli rad |
| Timesheet | Evidencija radnog vremena |
| Hours by project | Sati po projektima |
| Payslip | Platni listić |
| Payroll run | Obračun zarade |
| Posting | Knjiženje |
| Payment date | Datum isplate |
| Other income | Ostala primanja |
| Work (regular hours) | Redovan rad |
| Maternity sick leave | Bolovanje zbog održavanja trudnoće |
| Parental leave | Odsustvo radi nege deteta |
| Off payroll | Van obračuna |
| Cost allocation | Raspodela troškova |
| Stimulation | Stimulacija |
| Compensation for damage | Naknada štete |
| Not taxed | Neoporezivo |
| Suspended (from work) | Udaljenje sa rada |
| Calculated months | Obračunati meseci |
| Recalculate | Ponovo obračunaj |
| Contribution base | Osnovica za doprinose |
| Tax base | Poreska osnovica |
| Net paid | Za isplatu |
| Organisational unit | Organizaciona jedinica |
| Unit→department mapping | Povezivanje (jedinice sa sektorom) |
| Tax incentives | Poreske olakšice |
| Forwarded deduction | Prosleđena obustava |
| Retained deduction (reversal) | Zadržana obustava (storno) |

## Opšte

| EN | SR |
|---|---|
| Save / Cancel / Delete / Edit / Close | Sačuvaj / Otkaži / Obriši / Izmeni / Zatvori |
| Add / New | Dodaj / Novi (Nova, Novo) |
| Search… | Pretraga… |
| Filter / Clear filters | Filter / Poništi filtere |
| Loading… | Učitavanje… |
| No data / Nothing yet | Nema podataka / Još ništa |
| Import / Export | Uvoz / Izvoz |
| Refresh | Osveži |
| Confirm | Potvrdi |
| Back / Next | Nazad / Dalje |
| Review | Pregled |
| Note | Napomena |
| Users | Korisnici |
| Company profile | Profil firme |
| Bank / bank account | Banka / tekući račun |
| Vendor / Customer | Dobavljač / Kupac |
| Investor / Tenant | Investitor / Zakupac |
| Error | Greška |
| Greeting: Good morning / afternoon / evening | Dobro jutro / Dobar dan / Dobro veče |
| Months, short | jan, feb, mar, apr, maj, jun, jul, avg, sep, okt, nov, dec (src/utils/months.ts) |
| Months, long | januar … decembar; na početku reda velikim slovom (src/utils/months.ts) |
| Quarter label (Q3 2026) | 3. kvartal 2026. |
| Email address / Password | Email adresa / Lozinka |
| Role / Owner / Manager / Administrative assistant | Uloga / Vlasnik / Menadžer / Administrativni asistent |
| Invite user | Pozovi korisnika |
| Read only | Samo pregled |
| Lock / unlock (period) | Zaključaj / otključaj |
| Active / inactive | Aktivan / neaktivan |
| Individual / company (partner) | Fizičko lice / pravno lice |
| Payment method | Način plaćanja |
| Primary (account) | Glavni |
| Expand all / Collapse / Fold all | Otvori sve / Sklopi / Sklopi sve |
| First / Previous / Next / Last page | Prva / Prethodna / Sledeća / Poslednja strana |
| Custom (date range) | Proizvoljno |
| This month / Last month / This quarter | Ovaj mesec / Prošli mesec / Ovaj kvartal |
| Direction (in / out) | Smer (uplata / isplata) |
| Quick actions | Brze akcije |
| Alerts | Upozorenja |
| Registration number (company) | Matični broj |
| Address / City / Country | Adresa / Grad / Država |
| Contact person / Phone | Kontakt osoba / Telefon |
| Fetch (exchange rate) | Preuzmi |
| Done | Gotovo |
| Discard changes | Odbaci izmene |
| Confidence: high / medium / low | Pouzdanost: visoka / srednja / niska |
| Step 2 of 4 | Korak 2 od 4 |
| Code (in MPP) | Šifra |
| Unit | Jedinica |
| Consolidated / All companies | Konsolidovano / Sve firme |
| Record change | Sačuvaj izmenu |
| Continue | Dalje |
| Undo (posting) | Poništi |
