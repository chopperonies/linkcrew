alter table if exists public.jobs
  add column if not exists primary_supervisor_employee_id uuid references public.employees(id) on delete set null;

create index if not exists jobs_primary_supervisor_employee_id_idx
  on public.jobs (primary_supervisor_employee_id);
