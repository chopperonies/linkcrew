-- Optional contractor license number — shown on invoices, estimates, work orders
alter table tenants
  add column if not exists license_number text;
