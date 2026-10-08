-- The banks Milinković Company works with. A row here is what a statement is
-- imported against; its currencies are the accounts the company holds there,
-- RSD and EUR to start with, to be narrowed in Podešavanja → Banke.
--
-- Idempotent: a bank already on the list (by name, in any case) is left alone.

insert into public.banks (company_id, name, type, currencies, is_active)
select c.id, b.name, 'bank', array['RSD', 'EUR'], true
  from public.companies c
 cross join (values
   ('Alta banka'),
   ('NLB Komercijalna banka'),
   ('ProCredit Bank'),
   ('Addiko Bank'),
   ('AIK Banka'),
   ('UniCredit Bank'),
   ('Halkbank'),
   ('Banca Intesa'),
   ('Raiffeisen banka'),
   ('OTP banka')
 ) as b(name)
 where c.name = 'Milinković Company doo'
   and not exists (
     select 1 from public.banks x
      where x.company_id = c.id and lower(x.name) = lower(b.name)
   );
