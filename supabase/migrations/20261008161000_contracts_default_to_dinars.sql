-- A new employment contract is in dinars unless it says otherwise. Mintflow's
-- contracts were mostly in euros; a Serbian construction company's are not.
alter table public.employee_contracts alter column currency set default 'RSD';
