alter table public.job_assignments
add column if not exists work_type text;

alter table public.job_assignments
drop constraint if exists job_assignments_work_type_check;

alter table public.job_assignments
add constraint job_assignments_work_type_check
check (
  work_type is null or work_type in (
    'office_admin',
    'shop_warehouse',
    'drive_material_run',
    'training',
    'completed_job_follow_up',
    'warranty_callback',
    'field_work_other'
  )
);
