-- Structured store for invoice worksheet rows so the mobile editor can
-- reconstruct line items on reopen instead of collapsing to a single seed
-- row built from invoice_amount.
alter table public.jobs
  add column if not exists invoice_line_items jsonb;
