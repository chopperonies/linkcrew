begin;

alter table if exists public.employees
  drop constraint if exists employees_role_check;

alter table if exists public.employees
  add constraint employees_role_check
  check (role in ('crew', 'supervisor', 'manager', 'owner'));

alter table if exists public.tenant_users
  drop constraint if exists tenant_users_role_check;

alter table if exists public.tenant_users
  add constraint tenant_users_role_check
  check (role in ('owner', 'manager', 'supervisor', 'crew', 'client'));

comment on column public.tenant_users.role is
  'Application role for dashboard access. owner keeps full access, supervisor and manager are operational by default.';

commit;
