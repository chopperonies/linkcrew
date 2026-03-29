-- FieldSync Database Schema
-- Run this in Supabase SQL Editor

-- Jobs table
create table if not exists jobs (
  id uuid default gen_random_uuid() primary key,
  name text not null,
  address text,
  status text default 'active' check (status in ('active', 'completed', 'on_hold')),
  manager_email text,
  created_at timestamptz default now(),
  updated_at timestamptz default now()
);

-- Employees table
create table if not exists employees (
  id uuid default gen_random_uuid() primary key,
  name text not null,
  telegram_id bigint unique,
  role text default 'crew' check (role in ('crew', 'manager', 'owner')),
  created_at timestamptz default now()
);

-- Job assignments (which employees are on which job)
create table if not exists job_assignments (
  id uuid default gen_random_uuid() primary key,
  job_id uuid references jobs(id) on delete cascade,
  employee_id uuid references employees(id) on delete cascade,
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
  type text default 'update' check (type in ('checkin', 'update', 'bottleneck', 'supply_request', 'photo', 'checkout')),
  message text,
  photo_url text,
  created_at timestamptz default now()
);

-- Enable realtime on all tables
alter publication supabase_realtime add table jobs;
alter publication supabase_realtime add table supply_requests;
alter publication supabase_realtime add table job_updates;
alter publication supabase_realtime add table job_assignments;

-- Sample data to get started
insert into jobs (name, address, status) values
  ('Downtown Office Renovation', '123 Main St, Miami FL', 'active'),
  ('Sunset Villa Electrical', '456 Ocean Dr, Miami Beach FL', 'active'),
  ('Warehouse HVAC Install', '789 Industrial Blvd, Hialeah FL', 'active');
