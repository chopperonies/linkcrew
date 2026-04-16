-- Stripe Connect Standard + custom payment methods
alter table tenants
  add column if not exists stripe_connect_account_id text,
  add column if not exists stripe_connect_status text,
  add column if not exists payment_methods jsonb not null default '[]'::jsonb;

-- payment_methods entry shape:
-- { "type": "zelle|venmo|paypal|cashapp|ach|check|other",
--   "label": "Zelle",
--   "detail": "eliott@example.com",
--   "qr_url": "https://...supabase.co/storage/v1/object/public/payment-qrs/<tenant>/<file>",
--   "enabled": true }

create index if not exists tenants_stripe_connect_account_id_idx
  on tenants (stripe_connect_account_id)
  where stripe_connect_account_id is not null;

-- Storage bucket for QR code uploads. Public read so QR images render on invoices.
insert into storage.buckets (id, name, public)
values ('payment-qrs', 'payment-qrs', true)
on conflict (id) do nothing;

-- RLS on storage.objects is managed by Supabase. Tenant-scoped writes enforced
-- at the API layer (service key uploads keyed by tenant_id folder prefix).
