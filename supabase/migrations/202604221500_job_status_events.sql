-- Audit log for every job status transition. Powers the Messages thread
-- system posts, the dashboard activity feed, and the override audit trail.

CREATE TABLE IF NOT EXISTS job_status_events (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  job_id UUID NOT NULL REFERENCES jobs(id) ON DELETE CASCADE,
  tenant_id UUID NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  from_status TEXT,
  to_status TEXT NOT NULL,
  actor_employee_id UUID REFERENCES employees(id) ON DELETE SET NULL,
  trigger TEXT NOT NULL CHECK (trigger IN (
    'manual', 'clock_in', 'clock_out', 'photo', 'checklist',
    'service_pro', 'override', 'cancel', 'approve', 'reject', 'system'
  )),
  note TEXT,
  lat DOUBLE PRECISION,
  lng DOUBLE PRECISION,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS job_status_events_job_idx
  ON job_status_events(job_id, created_at DESC);
CREATE INDEX IF NOT EXISTS job_status_events_tenant_idx
  ON job_status_events(tenant_id, created_at DESC);

ALTER TABLE job_status_events ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS job_status_events_service ON job_status_events;
CREATE POLICY job_status_events_service ON job_status_events
  FOR ALL TO service_role USING (true) WITH CHECK (true);

-- Realtime for live activity feeds on dashboard.
DO $$
BEGIN
  PERFORM 1 FROM pg_publication_tables
   WHERE pubname = 'supabase_realtime'
     AND schemaname = 'public'
     AND tablename = 'job_status_events';
  IF NOT FOUND THEN
    EXECUTE 'ALTER PUBLICATION supabase_realtime ADD TABLE job_status_events';
  END IF;
END $$;
