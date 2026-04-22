-- Unify supervisor role between employees (already supports it) and the
-- web-dashboard tenant_users role enum (didn't). Supervisors can approve
-- closures + manage jobs but cannot change tenant billing.

ALTER TABLE IF EXISTS public.tenant_users
  DROP CONSTRAINT IF EXISTS tenant_users_role_check;

ALTER TABLE IF EXISTS public.tenant_users
  ADD CONSTRAINT tenant_users_role_check
  CHECK (role IN ('owner', 'manager', 'supervisor', 'crew', 'client'));
