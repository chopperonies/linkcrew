-- FieldSync Database Schema
-- Run this in Supabase SQL Editor

-- Jobs table
create table if not exists jobs (
  id uuid default gen_random_uuid() primary key,
  name text not null,
  address text,
  status text default 'active' check (status in ('quoted', 'scheduled', 'in_progress', 'active', 'on_hold', 'completed', 'invoiced', 'saved_for_later', 'cancelled', 'archived')),
  manager_email text,
  primary_supervisor_employee_id uuid,
  plans_notes text,
  execution_plan text,
  checklist_items jsonb not null default '[]'::jsonb,
  missing_items_watchlist text,
  client_communication_plan text,
  expected_duration_hours numeric,
  required_before_photos integer not null default 2,
  required_mid_job_photos integer not null default 1,
  required_completion_photos integer not null default 2,
  required_cleanup_photos integer not null default 1,
  crew_plan_confirmed boolean not null default false,
  created_at timestamptz default now(),
  updated_at timestamptz default now()
);

-- Employees table
create table if not exists employees (
  id uuid default gen_random_uuid() primary key,
  name text not null,
  telegram_id bigint unique,
  role text default 'crew' check (role in ('crew', 'supervisor', 'manager', 'owner')),
  status text default 'active' check (status in ('active', 'vacation', 'suspended')),
  created_at timestamptz default now()
);

-- Job assignments (which employees are on which job)
create table if not exists job_assignments (
  id uuid default gen_random_uuid() primary key,
  job_id uuid references jobs(id) on delete cascade,
  employee_id uuid references employees(id) on delete cascade,
  work_type text check (work_type in ('office_admin', 'shop_warehouse', 'drive_material_run', 'training', 'completed_job_follow_up', 'warranty_callback', 'field_work_other')),
  checked_in_at timestamptz,
  checked_out_at timestamptz,
  unique(job_id, employee_id)
);

-- Supply requests
create table if not exists supply_requests (
  id uuid default gen_random_uuid() primary key,
  job_id uuid references jobs(id) on delete cascade,
  employee_id uuid references employees(id),
  items text not null,
  urgency text default 'next_day' check (urgency in ('same_day', 'next_day')),
  status text default 'pending' check (status in ('pending', 'preparing', 'delivered')),
  photo_url text,
  notes text,
  created_at timestamptz default now(),
  updated_at timestamptz default now()
);

-- Job updates (progress notes, photos, bottlenecks)
create table if not exists job_updates (
  id uuid default gen_random_uuid() primary key,
  job_id uuid references jobs(id) on delete cascade,
  employee_id uuid references employees(id),
  type text default 'update' check (type in ('checkin', 'update', 'note', 'bottleneck', 'supply_request', 'photo', 'checkout')),
  message text,
  photo_url text,
  created_at timestamptz default now()
);

-- Enable realtime on all tables
alter publication supabase_realtime add table jobs;
alter publication supabase_realtime add table supply_requests;
alter publication supabase_realtime add table job_updates;
alter publication supabase_realtime add table job_assignments;

-- Tenant access metadata used by the web dashboard role model.
-- These tables already exist in production; keep these supplemental definitions
-- in sync with the app-level permission model and migrations.

create table if not exists tenants (
  id uuid default gen_random_uuid() primary key,
  company_name text,
  owner_email text,
  manager_financials_enabled boolean not null default false
);

create table if not exists tenant_users (
  id uuid default gen_random_uuid() primary key,
  user_id uuid not null,
  tenant_id uuid not null references tenants(id) on delete cascade,
  employee_id uuid references employees(id) on delete set null,
  role text not null default 'owner' check (role in ('owner', 'manager', 'crew', 'client')),
  can_view_financials boolean not null default false,
  created_at timestamptz default now(),
  unique(user_id, tenant_id)
);

create index if not exists tenant_users_tenant_id_idx on tenant_users (tenant_id);
create index if not exists tenant_users_employee_id_idx on tenant_users (employee_id);
create index if not exists tenant_users_role_idx on tenant_users (role);

-- Sample data to get started
insert into jobs (name, address, status) values
  ('Downtown Office Renovation', '123 Main St, Miami FL', 'active'),
  ('Sunset Villa Electrical', '456 Ocean Dr, Miami Beach FL', 'active'),
  ('Warehouse HVAC Install', '789 Industrial Blvd, Hialeah FL', 'active');
