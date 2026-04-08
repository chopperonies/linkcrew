-- Lock down Supabase-exposed public tables that should not be readable/writable
-- from anon/authenticated clients. LinkCrew uses server-side service-role access
-- for most application queries, so enabling RLS here should preserve backend flow
-- while reducing direct PostgREST exposure.

drop policy if exists "Allow login by phone" on public.employees;

do $$
declare
  rls_tables text[] := array[
    'public.employees',
    'public.supply_requests',
    'public.job_updates',
    'public.clients',
    'public.client_follow_ups',
    'public.job_requests',
    'public.job_request_photos',
    'public.service_agreements',
    'public.kdg_leads',
    'public.mc_notes',
    'public.beta_invites',
    'public.mc_events',
    'public.client_users',
    'public.mrr_snapshots',
    'public.services',
    'public.appointments',
    'public.job_assignments',
    'public.page_views',
    'public.suggestions',
    'public.tenants',
    'public.jobs',
    'public.tenant_users',
    'public.crew_invite_links',
    'public.voice_sessions',
    'public.impersonation_sessions',
    'public.kdg_chat_sessions',
    'public.kdg_voice_sessions'
  ];
  revoked_tables text[] := array[
    'public.crew_invite_links',
    'public.impersonation_sessions',
    'public.kdg_chat_sessions',
    'public.kdg_voice_sessions',
    'public.voice_sessions',
    'public.tenant_users',
    'public.client_users',
    'public.beta_invites',
    'public.mrr_snapshots',
    'public.mc_notes',
    'public.mc_events',
    'public.page_views'
  ];
  tbl text;
begin
  foreach tbl in array rls_tables loop
    if to_regclass(tbl) is not null then
      execute format('alter table %s enable row level security', tbl);
    end if;
  end loop;

  foreach tbl in array revoked_tables loop
    if to_regclass(tbl) is not null then
      execute format('revoke all on table %s from anon, authenticated', tbl);
    end if;
  end loop;
end $$;
