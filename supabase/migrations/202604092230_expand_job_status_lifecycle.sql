alter table if exists public.jobs
  drop constraint if exists jobs_status_check;

alter table if exists public.jobs
  add constraint jobs_status_check
  check (status in ('quoted', 'scheduled', 'in_progress', 'active', 'on_hold', 'completed', 'invoiced', 'saved_for_later', 'cancelled', 'archived'));

update public.jobs
set status = 'completed'
where status = 'complete';
