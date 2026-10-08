# MCFlow rečnik (engleski → srpski, latinica)

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
